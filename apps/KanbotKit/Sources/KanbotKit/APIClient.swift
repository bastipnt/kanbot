import Foundation

public struct APIError: Error, Sendable, LocalizedError, Equatable {
    public let status: Int
    public let code: String
    public let message: String

    public var errorDescription: String? { message }

    public static let notSignedIn = APIError(status: 401, code: "unauthorized", message: "Not signed in")
}

private struct ErrorEnvelope: Decodable {
    struct Body: Decodable { let code: String; let message: String }
    let error: Body
}

/// Async HTTP client for the Kanbot REST API (docs/api.md).
/// Refreshes the access token proactively before expiry and once more on a 401.
public actor APIClient {
    nonisolated public let serverURL: URL
    private let urlSession: URLSession
    private let store: SessionStore
    private var session: Session?
    private var refreshTask: Task<TokenPair, Error>?

    /// Called when the session ends (refresh failed or sign-out) so the UI can return to login.
    private var onSignedOut: (@Sendable () -> Void)?

    public init(serverURL: URL, store: SessionStore, urlSession: URLSession = .shared) {
        self.serverURL = serverURL
        self.store = store
        self.urlSession = urlSession
        let stored = store.load()
        self.session = stored?.serverURL == serverURL ? stored : nil
    }

    public func setOnSignedOut(_ handler: @escaping @Sendable () -> Void) {
        onSignedOut = handler
    }

    public var isSignedIn: Bool { session != nil }
    public var currentUserId: UUID? { session?.userId }

    // MARK: Auth

    /// `inviteToken` is required when the server has registration disabled (signup invite from `bun run invite:create`).
    public func register(email: String, password: String, name: String, inviteToken: String? = nil) async throws -> User {
        var body: [String: JSONValue] = ["email": .string(email), "password": .string(password), "name": .string(name)]
        if let inviteToken { body["inviteToken"] = .string(inviteToken) }
        let r: AuthResponse = try await send("POST", "/auth/register", body: .object(body), authenticated: false)
        adopt(r)
        return r.user
    }

    public func login(email: String, password: String) async throws -> User {
        let r: AuthResponse = try await send("POST", "/auth/login",
                                             body: ["email": .string(email), "password": .string(password)],
                                             authenticated: false)
        adopt(r)
        return r.user
    }

    public func signOut() {
        session = nil
        store.save(nil)
        onSignedOut?()
    }

    private func adopt(_ r: AuthResponse) {
        let s = Session(serverURL: serverURL, userId: r.user.id,
                        tokens: TokenPair(accessToken: r.accessToken, refreshToken: r.refreshToken))
        session = s
        store.save(s)
    }

    /// A non-expired access token, refreshing if it expires within a minute. Also used for WebSocket auth.
    public func validAccessToken() async throws -> String {
        guard let s = session else { throw APIError.notSignedIn }
        if let exp = JWT.expiry(of: s.tokens.accessToken), exp.timeIntervalSinceNow > 60 {
            return s.tokens.accessToken
        }
        return try await refreshTokens().accessToken
    }

    /// Single-flight refresh: refresh tokens are single use, so concurrent callers must share one request.
    private func refreshTokens() async throws -> TokenPair {
        if let refreshTask { return try await refreshTask.value }
        guard let refreshToken = session?.tokens.refreshToken else { throw APIError.notSignedIn }
        let task = Task { () throws -> TokenPair in
            try await self.send("POST", "/auth/refresh", body: ["refreshToken": .string(refreshToken)], authenticated: false)
        }
        refreshTask = task
        defer { refreshTask = nil }
        do {
            let pair = try await task.value
            if var s = session {
                s.tokens = pair
                session = s
                store.save(s)
            }
            return pair
        } catch let error as APIError where error.status == 401 {
            signOut()
            throw error
        }
    }

    // MARK: Workspaces & members

    public func me() async throws -> User { try await send("GET", "/me") }
    public func workspaces() async throws -> [Workspace] { try await send("GET", "/workspaces") }
    public func createWorkspace(name: String) async throws -> Workspace {
        try await send("POST", "/workspaces", body: ["name": .string(name)])
    }
    public func members(workspaceId: UUID) async throws -> [Member] {
        try await send("GET", "/workspaces/\(workspaceId.api)/members")
    }
    public func createInvite(workspaceId: UUID, role: Role) async throws -> Invite {
        try await send("POST", "/workspaces/\(workspaceId.api)/invites", body: ["role": .string(role.rawValue)])
    }
    public func acceptInvite(token: String) async throws -> Workspace {
        try await send("POST", "/invites/\(token)/accept")
    }
    public func removeMember(workspaceId: UUID, userId: UUID) async throws {
        try await sendEmpty("DELETE", "/workspaces/\(workspaceId.api)/members/\(userId.api)")
    }

    // MARK: Boards & columns

    public func boards(workspaceId: UUID) async throws -> [Board] {
        try await send("GET", "/workspaces/\(workspaceId.api)/boards")
    }
    public func createBoard(workspaceId: UUID, name: String) async throws -> Board {
        try await send("POST", "/workspaces/\(workspaceId.api)/boards", body: ["name": .string(name)])
    }
    public func board(id: UUID) async throws -> BoardSnapshot { try await send("GET", "/boards/\(id.api)") }
    public func renameBoard(id: UUID, name: String) async throws -> Board {
        try await send("PATCH", "/boards/\(id.api)", body: ["name": .string(name)])
    }
    public func deleteBoard(id: UUID) async throws { try await sendEmpty("DELETE", "/boards/\(id.api)") }
    /// The board as a portable `BoardExport` JSON file (docs/api.md), returned verbatim for saving to disk.
    public func exportBoard(id: UUID) async throws -> Data {
        try await raw("GET", "/boards/\(id.api)/export", query: [], body: nil, authenticated: true)
    }
    /// Creates a new board from a `BoardExport` file; the server validates its contents.
    public func importBoard(workspaceId: UUID, file: Data) async throws -> Board {
        try await send("POST", "/workspaces/\(workspaceId.api)/boards/import", rawBody: file)
    }

    public func createColumn(boardId: UUID, name: String, afterId: UUID? = nil, wipLimit: Int? = nil) async throws -> Column {
        var body: [String: JSONValue] = ["name": .string(name)]
        if let afterId { body["afterId"] = JSONValue(afterId) }
        if let wipLimit { body["wipLimit"] = JSONValue(wipLimit) }
        return try await send("POST", "/boards/\(boardId.api)/columns", body: .object(body))
    }
    /// `patch` may contain `name`, `wipLimit` (null clears), `beforeId`, `afterId`.
    public func updateColumn(id: UUID, patch: [String: JSONValue]) async throws -> Column {
        try await send("PATCH", "/columns/\(id.api)", body: .object(patch))
    }
    public func deleteColumn(id: UUID) async throws { try await sendEmpty("DELETE", "/columns/\(id.api)") }

    // MARK: Tasks & comments

    public func createTask(boardId: UUID, columnId: UUID, title: String) async throws -> TaskItem {
        try await send("POST", "/boards/\(boardId.api)/tasks",
                       body: ["title": .string(title), "columnId": JSONValue(columnId)])
    }
    public func task(id: UUID) async throws -> TaskDetail { try await send("GET", "/tasks/\(id.api)") }
    /// `patch` may contain `title`, `description`, `assigneeId`, `labels`, `dueAt` (nulls clear).
    public func updateTask(id: UUID, patch: [String: JSONValue]) async throws -> TaskItem {
        try await send("PATCH", "/tasks/\(id.api)", body: .object(patch))
    }
    public func moveTask(id: UUID, columnId: UUID, beforeId: UUID? = nil, afterId: UUID? = nil) async throws -> TaskItem {
        var body: [String: JSONValue] = ["columnId": JSONValue(columnId)]
        if let beforeId { body["beforeId"] = JSONValue(beforeId) }
        if let afterId { body["afterId"] = JSONValue(afterId) }
        return try await send("POST", "/tasks/\(id.api)/move", body: .object(body))
    }
    public func deleteTask(id: UUID) async throws { try await sendEmpty("DELETE", "/tasks/\(id.api)") }
    public func addComment(taskId: UUID, body: String) async throws -> Comment {
        try await send("POST", "/tasks/\(taskId.api)/comments", body: ["body": .string(body)])
    }
    public func searchTasks(workspaceId: UUID, query: String, boardId: UUID? = nil) async throws -> [TaskItem] {
        var items = [URLQueryItem(name: "q", value: query)]
        if let boardId { items.append(URLQueryItem(name: "boardId", value: boardId.api)) }
        return try await send("GET", "/workspaces/\(workspaceId.api)/tasks/search", query: items)
    }

    // MARK: API keys

    public func apiKeys(workspaceId: UUID) async throws -> [ApiKey] {
        try await send("GET", "/workspaces/\(workspaceId.api)/api-keys")
    }
    public func createApiKey(workspaceId: UUID, name: String) async throws -> CreatedApiKey {
        try await send("POST", "/workspaces/\(workspaceId.api)/api-keys", body: ["name": .string(name)])
    }
    public func deleteApiKey(id: UUID) async throws { try await sendEmpty("DELETE", "/api-keys/\(id.api)") }

    // MARK: Sync

    public func events(workspaceId: UUID, since: Int, limit: Int = 500) async throws -> EventPage {
        try await send("GET", "/workspaces/\(workspaceId.api)/events",
                       query: [URLQueryItem(name: "since", value: String(since)),
                               URLQueryItem(name: "limit", value: String(limit))])
    }

    /// WebSocket URL for realtime events (`ws(s)://host/ws?token=&workspaceId=`).
    public func realtimeURL(workspaceId: UUID) async throws -> URL {
        let token = try await validAccessToken()
        var c = URLComponents(url: serverURL.appending(path: "ws"), resolvingAgainstBaseURL: false)!
        c.scheme = serverURL.scheme == "https" ? "wss" : "ws"
        c.queryItems = [URLQueryItem(name: "token", value: token), URLQueryItem(name: "workspaceId", value: workspaceId.api)]
        return c.url!
    }

    // MARK: Transport

    private func sendEmpty(_ method: String, _ path: String) async throws {
        _ = try await raw(method, path, query: [], body: nil, authenticated: true)
    }

    private func send<T: Decodable>(_ method: String, _ path: String, query: [URLQueryItem] = [],
                                    body: JSONValue? = nil, authenticated: Bool = true) async throws -> T {
        try await send(method, path, query: query, rawBody: body.map { try KanbotJSON.encoder.encode($0) },
                       authenticated: authenticated)
    }

    private func send<T: Decodable>(_ method: String, _ path: String, query: [URLQueryItem] = [],
                                    rawBody: Data?, authenticated: Bool = true) async throws -> T {
        let data = try await raw(method, path, query: query, body: rawBody, authenticated: authenticated)
        do {
            return try KanbotJSON.decoder.decode(T.self, from: data)
        } catch {
            throw APIError(status: 0, code: "decoding", message: "Unexpected response from server: \(error)")
        }
    }

    private func raw(_ method: String, _ path: String, query: [URLQueryItem], body: Data?,
                     authenticated: Bool, isRetry: Bool = false) async throws -> Data {
        var components = URLComponents(url: serverURL.appending(path: path), resolvingAgainstBaseURL: false)!
        if !query.isEmpty { components.queryItems = query }
        var request = URLRequest(url: components.url!)
        request.httpMethod = method
        request.timeoutInterval = 20
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = body
        }
        if authenticated {
            request.setValue("Bearer \(try await validAccessToken())", forHTTPHeaderField: "Authorization")
        }

        let (data, response): (Data, URLResponse)
        do {
            (data, response) = try await urlSession.data(for: request)
        } catch {
            // The caller went away (e.g. its SwiftUI view disappeared); that's not a connectivity problem.
            if Task.isCancelled || (error as? URLError)?.code == .cancelled { throw CancellationError() }
            throw APIError(status: 0, code: "network", message: "Can't reach \(serverURL.host() ?? "server"): \(error.localizedDescription)")
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        if (200..<300).contains(status) { return data }

        if status == 401 && authenticated && !isRetry {
            _ = try await refreshTokens()
            return try await raw(method, path, query: query, body: body, authenticated: true, isRetry: true)
        }
        if let envelope = try? KanbotJSON.decoder.decode(ErrorEnvelope.self, from: data) {
            throw APIError(status: status, code: envelope.error.code, message: envelope.error.message)
        }
        throw APIError(status: status, code: "http_\(status)", message: HTTPURLResponse.localizedString(forStatusCode: status))
    }
}

extension UUID {
    /// Lowercase form used on the wire (the server compares ids as lowercase strings).
    public var api: String { uuidString.lowercased() }
}
