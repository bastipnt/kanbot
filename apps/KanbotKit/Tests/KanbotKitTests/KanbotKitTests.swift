import Foundation
import Testing
@testable import KanbotKit

@Suite struct PositionTests {
    @Test func betweenNeighbours() {
        let pairs: [(String?, String?)] = [(nil, nil), ("a0", nil), (nil, "a0"), ("a0", "a1"), ("a0", "a0V"), ("a", "a!"), ("Zz", "a0")]
        for (lo, hi) in pairs {
            let m = Position.between(lo, hi)
            if let lo { #expect(lo < m, "\(lo) < \(m)") }
            if let hi { #expect(m < hi, "\(m) < \(hi)") }
        }
    }

    @Test func repeatedInsertStaysOrdered() {
        var lo = "a0", hi = "a1"
        for _ in 0..<50 {
            let m = Position.between(lo, hi)
            #expect(lo < m && m < hi)
            hi = m
        }
        lo = "a0"
    }
}

@Suite struct DecodingTests {
    @Test func decodesEventWithTaskPayload() throws {
        let json = """
        {"kind":"event","event":{"seq":7,"workspaceId":"0192f0c2-0000-7000-8000-000000000001",
         "actor":{"type":"agent","id":"0192f0c2-0000-7000-8000-000000000002","name":"Triage bot"},
         "type":"task.moved","entityId":"0192f0c2-0000-7000-8000-000000000003",
         "payload":{"id":"0192f0c2-0000-7000-8000-000000000003","boardId":"0192f0c2-0000-7000-8000-000000000004",
           "columnId":"0192f0c2-0000-7000-8000-000000000005","title":"Fix login","description":"","position":"a1",
           "assigneeId":null,"labels":["bug"],"dueAt":null,
           "createdBy":{"type":"user","id":"0192f0c2-0000-7000-8000-000000000006","name":"Basti"},
           "createdAt":"2026-09-30T12:00:00.000Z","updatedAt":"2026-09-30T12:01:00.000Z"},
         "createdAt":"2026-09-30T12:01:00.000Z"}}
        """
        guard case .event(let event)? = RealtimeDecoding.decode(Data(json.utf8)) else {
            Issue.record("not decoded"); return
        }
        #expect(event.kind == .taskMoved)
        #expect(event.actor.isAgent)
        let task = try event.decodePayload(TaskItem.self)
        #expect(task.title == "Fix login" && task.labels == ["bug"] && task.dueAt == nil)
    }

    @Test func decodesHello() {
        #expect(RealtimeDecoding.decode(Data(#"{"kind":"hello","latestSeq":42}"#.utf8)) == .hello(latestSeq: 42))
    }

    @Test func encodesExplicitNull() throws {
        let body: JSONValue = ["assigneeId": JSONValue(nil as UUID?), "title": "x"]
        let s = String(decoding: try KanbotJSON.encoder.encode(body), as: UTF8.self)
        #expect(s.contains(#""assigneeId":null"#))
    }

    @Test func jwtExpiry() {
        // header.{"exp":2000000000}.sig
        let token = "eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjIwMDAwMDAwMDB9.sig"
        #expect(JWT.expiry(of: token) == Date(timeIntervalSince1970: 2_000_000_000))
    }
}

@MainActor @Suite struct StoreTests {
    let ws = UUID(), boardId = UUID(), colA = UUID(), colB = UUID(), me = UUID()

    func makeStore() -> WorkspaceStore {
        let api = APIClient(serverURL: URL(string: "http://localhost:1")!, store: MemorySessionStore())
        let workspace = Workspace(id: ws, name: "W", role: .owner, createdAt: .now)
        return WorkspaceStore(workspace: workspace, api: api, currentUserId: me)
    }

    func event(_ seq: Int, _ type: String, _ entity: UUID, _ payload: JSONValue) -> Event {
        Event(seq: seq, workspaceId: ws, actor: Actor(type: .agent, id: UUID(), name: "bot"),
              type: type, entityId: entity, payload: payload, createdAt: .now)
    }

    func taskJSON(_ id: UUID, column: UUID, position: String, board: UUID? = nil) -> JSONValue {
        ["id": JSONValue(id), "boardId": JSONValue(board ?? boardId), "columnId": JSONValue(column), "title": "T",
         "description": "", "position": .string(position), "assigneeId": nil, "labels": [], "dueAt": nil,
         "createdBy": ["type": "user", "id": JSONValue(me), "name": "me"],
         "createdAt": "2026-09-30T12:00:00.000Z", "updatedAt": "2026-09-30T12:00:00.000Z"]
    }

    @Test func boardEventsAndSeq() {
        let store = makeStore()
        let board: JSONValue = ["id": JSONValue(boardId), "workspaceId": JSONValue(ws), "name": "B",
                                "createdAt": "2026-09-30T12:00:00.000Z", "updatedAt": "2026-09-30T12:00:00.000Z"]
        store.apply(event(3, "board.created", boardId, board))
        #expect(store.boards.map(\.name) == ["B"])
        #expect(store.lastSeq == 3)
        #expect(store.activity.first?.seq == 3)
        store.apply(event(4, "board.deleted", boardId, ["id": JSONValue(boardId)]))
        #expect(store.boards.isEmpty)
    }

    @Test func tasksForOtherBoardsAreIgnored() {
        let store = makeStore()
        let t = UUID()
        store.apply(event(1, "task.created", t, taskJSON(t, column: colA, position: "a0", board: UUID())))
        #expect(store.tasksById.isEmpty)
    }

    @Test func memberRemovalOfSelfRevokesAccess() {
        let store = makeStore()
        store.apply(event(1, "member.removed", me, ["id": JSONValue(me)]))
        #expect(store.accessRevoked)
    }
}
