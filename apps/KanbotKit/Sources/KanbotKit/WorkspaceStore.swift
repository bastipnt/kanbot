import Foundation
import Observation

public enum ConnectionState: Sendable, Equatable {
    case connecting, live, offline
}

/// Live, observable state of one workspace: boards, members, the open board and its tasks.
///
/// Sync model (docs/api.md "Sync"): the realtime socket is processed strictly in order. On the first
/// `hello` the store loads snapshots and records `latestSeq`; every later event with a higher seq is
/// applied. After a reconnect or a seq gap the store pages `/events?since=`. Events carry the full
/// entity, so re-applying one is harmless and applying in seq order always converges.
@MainActor
@Observable
public final class WorkspaceStore {
    public let workspace: Workspace
    public let api: APIClient
    public let currentUserId: UUID

    public private(set) var boards: [Board] = []
    public private(set) var members: [Member] = []
    public private(set) var openBoard: Board?
    public private(set) var columns: [Column] = []
    public private(set) var tasksById: [UUID: TaskItem] = [:]
    /// Comments for tasks whose detail has been loaded.
    public private(set) var commentsByTask: [UUID: [Comment]] = [:]
    /// Recent events, newest first — the activity feed.
    public private(set) var activity: [Event] = []
    public private(set) var connection: ConnectionState = .connecting
    public private(set) var lastSeq = 0
    public private(set) var accessRevoked = false
    public var lastError: String?

    /// While a board snapshot is loading, its column/task events are held and replayed afterwards.
    private var loadingBoardId: UUID?
    private var heldEvents: [Event] = []
    private var syncTask: Task<Void, Never>?
    private var initialLoadDone = false

    private static let activityLimit = 200

    public init(workspace: Workspace, api: APIClient, currentUserId: UUID) {
        self.workspace = workspace
        self.api = api
        self.currentUserId = currentUserId
    }

    // MARK: Derived

    public func tasks(in columnId: UUID) -> [TaskItem] {
        tasksById.values.filter { $0.columnId == columnId }.sorted(by: TaskItem.ordered)
    }

    public func member(_ id: UUID?) -> Member? {
        guard let id else { return nil }
        return members.first { $0.userId == id }
    }

    public var myRole: Role { member(currentUserId)?.role ?? workspace.role }

    // MARK: Lifecycle

    public func start() {
        guard syncTask == nil else { return }
        syncTask = Task { [weak self] in await self?.runSync() }
    }

    public func stop() {
        syncTask?.cancel()
        syncTask = nil
        connection = .offline
    }

    private func runSync() async {
        var attempt = 0
        while !Task.isCancelled && !accessRevoked {
            connection = .connecting
            do {
                let url = try await api.realtimeURL(workspaceId: workspace.id)
                for try await message in RealtimeSocket.connect(url: url) {
                    switch message {
                    case .hello(let latest):
                        attempt = 0
                        try await handleHello(latestSeq: latest)
                        connection = .live
                    case .event(let event):
                        try await receive(event)
                    case .pong:
                        break
                    }
                }
            } catch let closed as RealtimeClosed where closed.accessRevoked {
                accessRevoked = true
            } catch is CancellationError {
                break
            } catch let error as APIError where error.status == 401 {
                break // signed out; the app returns to login
            } catch {
                // Network drop or server restart: retry with backoff.
            }
            connection = .offline
            if accessRevoked || Task.isCancelled { break }
            attempt += 1
            try? await Task.sleep(for: .seconds(min(30, 1 << min(attempt, 5))))
        }
    }

    private func handleHello(latestSeq latest: Int) async throws {
        if initialLoadDone {
            try await catchUp()
        } else {
            try await reloadAll()
            lastSeq = latest
            initialLoadDone = true
        }
    }

    /// Full reload of workspace-level data and the open board.
    public func reloadAll() async throws {
        async let b = api.boards(workspaceId: workspace.id)
        async let m = api.members(workspaceId: workspace.id)
        boards = try await b
        members = try await m
        if let openBoard, boards.contains(where: { $0.id == openBoard.id }) {
            try await loadBoard(openBoard.id)
        } else if let first = boards.first {
            try await loadBoard(first.id)
        } else {
            clearBoard()
        }
    }

    /// Fetch events after `lastSeq` until caught up.
    private func catchUp() async throws {
        while true {
            let page = try await api.events(workspaceId: workspace.id, since: lastSeq)
            for event in page.events { apply(event) }
            if page.events.isEmpty || lastSeq >= page.latestSeq { break }
        }
    }

    private func receive(_ event: Event) async throws {
        if event.seq <= lastSeq { return }
        if event.seq > lastSeq + 1 { try await catchUp() }
        if event.seq > lastSeq { apply(event) }
    }

    // MARK: Boards

    public func selectBoard(_ id: UUID) async {
        do { try await loadBoard(id) } catch { report(error) }
    }

    private func loadBoard(_ id: UUID) async throws {
        loadingBoardId = id
        heldEvents = []
        defer { if loadingBoardId == id { loadingBoardId = nil; heldEvents = [] } }
        let snapshot = try await api.board(id: id)
        guard loadingBoardId == id else { return } // superseded by a newer selection
        openBoard = snapshot.board
        columns = snapshot.columns.sorted(by: Column.ordered)
        tasksById = Dictionary(uniqueKeysWithValues: snapshot.tasks.map { ($0.id, $0) })
        commentsByTask = [:]
        for event in heldEvents { applyContent(event) }
    }

    private func clearBoard() {
        openBoard = nil
        columns = []
        tasksById = [:]
        commentsByTask = [:]
    }

    // MARK: Event application

    /// Apply one event in seq order. Exposed for tests.
    public func apply(_ event: Event) {
        lastSeq = max(lastSeq, event.seq)
        activity.insert(event, at: 0)
        if activity.count > Self.activityLimit { activity.removeLast(activity.count - Self.activityLimit) }

        guard let kind = event.kind else { return }
        switch kind {
        case .boardCreated, .boardUpdated:
            guard let board = try? event.decodePayload(Board.self) else { return }
            upsert(&boards, board)
            if openBoard?.id == board.id { openBoard = board }
        case .boardDeleted:
            boards.removeAll { $0.id == event.entityId }
            if openBoard?.id == event.entityId { clearBoard() }
        case .memberAdded:
            guard let member = try? event.decodePayload(Member.self) else { return }
            upsert(&members, member)
        case .memberRemoved:
            members.removeAll { $0.userId == event.entityId }
            if event.entityId == currentUserId { accessRevoked = true }
        default:
            if loadingBoardId != nil { heldEvents.append(event) } else { applyContent(event) }
        }
    }

    /// Column, task and comment events: only relevant to the open board.
    private func applyContent(_ event: Event) {
        guard let kind = event.kind else { return }
        switch kind {
        case .columnCreated, .columnUpdated:
            guard let col = try? event.decodePayload(Column.self), col.boardId == openBoard?.id else { return }
            upsert(&columns, col)
            columns.sort(by: Column.ordered)
        case .columnDeleted:
            columns.removeAll { $0.id == event.entityId }
        case .taskCreated, .taskUpdated, .taskMoved:
            guard let task = try? event.decodePayload(TaskItem.self), task.boardId == openBoard?.id else { return }
            tasksById[task.id] = task
        case .taskDeleted:
            tasksById[event.entityId] = nil
            commentsByTask[event.entityId] = nil
        case .commentCreated:
            guard let comment = try? event.decodePayload(Comment.self), commentsByTask[comment.taskId] != nil else { return }
            if !commentsByTask[comment.taskId]!.contains(where: { $0.id == comment.id }) {
                commentsByTask[comment.taskId]!.append(comment)
            }
        default:
            break
        }
    }

    private func upsert<T: Identifiable>(_ list: inout [T], _ item: T) {
        if let i = list.firstIndex(where: { $0.id == item.id }) { list[i] = item } else { list.append(item) }
    }

    private func report(_ error: Error) {
        lastError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
    }

    // MARK: Mutations (server is the source of truth; responses are upserted immediately,
    // the matching realtime event later is idempotent)

    @discardableResult
    public func createBoard(name: String) async -> Board? {
        do {
            let board = try await api.createBoard(workspaceId: workspace.id, name: name)
            upsert(&boards, board)
            try await loadBoard(board.id)
            return board
        } catch { report(error); return nil }
    }

    public func renameBoard(_ id: UUID, name: String) async {
        do {
            let board = try await api.renameBoard(id: id, name: name)
            upsert(&boards, board)
            if openBoard?.id == id { openBoard = board }
        } catch { report(error) }
    }

    public func deleteBoard(_ id: UUID) async {
        do {
            try await api.deleteBoard(id: id)
            boards.removeAll { $0.id == id }
            if openBoard?.id == id {
                if let next = boards.first { try await loadBoard(next.id) } else { clearBoard() }
            }
        } catch { report(error) }
    }

    /// The board as a `BoardExport` JSON file, or nil (with `lastError` set) on failure.
    public func exportBoard(_ id: UUID) async -> Data? {
        do { return try await api.exportBoard(id: id) } catch { report(error); return nil }
    }

    /// Imports a `BoardExport` file as a new board and opens it.
    @discardableResult
    public func importBoard(file: Data) async -> Board? {
        do {
            let board = try await api.importBoard(workspaceId: workspace.id, file: file)
            upsert(&boards, board)
            try await loadBoard(board.id)
            return board
        } catch { report(error); return nil }
    }

    public func addColumn(name: String) async {
        guard let board = openBoard else { return }
        do {
            let col = try await api.createColumn(boardId: board.id, name: name, afterId: columns.last?.id)
            upsert(&columns, col)
            columns.sort(by: Column.ordered)
        } catch { report(error) }
    }

    public func updateColumn(_ id: UUID, name: String? = nil, wipLimit: Int?? = nil) async {
        var patch: [String: JSONValue] = [:]
        if let name { patch["name"] = .string(name) }
        if let wipLimit { patch["wipLimit"] = JSONValue(wipLimit) }
        do {
            let col = try await api.updateColumn(id: id, patch: patch)
            upsert(&columns, col)
        } catch { report(error) }
    }

    /// Move a column one step left (-1) or right (+1).
    public func shiftColumn(_ id: UUID, by offset: Int) async {
        guard let i = columns.firstIndex(where: { $0.id == id }) else { return }
        let target = i + offset
        guard columns.indices.contains(target) else { return }
        let patch: [String: JSONValue] = offset < 0
            ? ["beforeId": JSONValue(columns[target].id)]
            : ["afterId": JSONValue(columns[target].id)]
        do {
            let col = try await api.updateColumn(id: id, patch: patch)
            upsert(&columns, col)
            columns.sort(by: Column.ordered)
        } catch { report(error) }
    }

    public func deleteColumn(_ id: UUID) async {
        do {
            try await api.deleteColumn(id: id)
            columns.removeAll { $0.id == id }
        } catch { report(error) }
    }

    @discardableResult
    public func createTask(title: String, in columnId: UUID) async -> TaskItem? {
        guard let board = openBoard else { return nil }
        do {
            let task = try await api.createTask(boardId: board.id, columnId: columnId, title: title)
            tasksById[task.id] = task
            return task
        } catch { report(error); return nil }
    }

    /// Move a task optimistically: it jumps locally at once, then the server's placement replaces it.
    /// `beforeId` = drop above that task; nil = append to the column.
    public func moveTask(_ taskId: UUID, to columnId: UUID, before beforeId: UUID? = nil) async {
        guard var task = tasksById[taskId] else { return }
        if beforeId == taskId { return }
        let original = task
        let siblings = tasks(in: columnId).filter { $0.id != taskId }
        var lower: String?, upper: String?
        if let beforeId, let i = siblings.firstIndex(where: { $0.id == beforeId }) {
            upper = siblings[i].position
            lower = i > 0 ? siblings[i - 1].position : nil
        } else {
            lower = siblings.last?.position
        }
        task.columnId = columnId
        task.position = Position.between(lower, upper)
        tasksById[taskId] = task

        do {
            let validBefore = beforeId.flatMap { id in siblings.contains { $0.id == id } ? id : nil }
            let moved = try await api.moveTask(id: taskId, columnId: columnId, beforeId: validBefore)
            tasksById[taskId] = moved
        } catch {
            tasksById[taskId] = original
            report(error)
        }
    }

    /// Patch fields of a task. Keys as in the API: title, description, assigneeId, labels, dueAt.
    public func updateTask(_ id: UUID, _ patch: [String: JSONValue]) async {
        do {
            tasksById[id] = try await api.updateTask(id: id, patch: patch)
        } catch { report(error) }
    }

    public func deleteTask(_ id: UUID) async {
        do {
            try await api.deleteTask(id: id)
            tasksById[id] = nil
        } catch { report(error) }
    }

    public func loadTaskDetail(_ id: UUID) async {
        do {
            let detail = try await api.task(id: id)
            if detail.task.boardId == openBoard?.id { tasksById[id] = detail.task }
            commentsByTask[id] = detail.comments
        } catch { report(error) }
    }

    public func addComment(to taskId: UUID, body: String) async {
        do {
            let comment = try await api.addComment(taskId: taskId, body: body)
            var list = commentsByTask[taskId] ?? []
            if !list.contains(where: { $0.id == comment.id }) { list.append(comment) }
            commentsByTask[taskId] = list
        } catch { report(error) }
    }

    public func refreshMembers() async {
        do { members = try await api.members(workspaceId: workspace.id) } catch { report(error) }
    }
}
