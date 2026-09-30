import Foundation

// Wire models mirroring docs/api.md. Keys are camelCase on the wire, so default Codable keys apply.

public enum Role: String, Codable, Sendable, CaseIterable {
    case owner, admin, member

    public var canAdminister: Bool { self != .member }
}

public struct User: Codable, Sendable, Hashable, Identifiable {
    public let id: UUID
    public var email: String
    public var name: String
    public let createdAt: Date
}

public struct Workspace: Codable, Sendable, Hashable, Identifiable {
    public let id: UUID
    public var name: String
    public var role: Role
    public let createdAt: Date
}

public struct Member: Codable, Sendable, Hashable, Identifiable {
    public let userId: UUID
    public var name: String
    public var email: String
    public var role: Role
    public let joinedAt: Date

    public var id: UUID { userId }
}

public struct Board: Codable, Sendable, Hashable, Identifiable {
    public let id: UUID
    public let workspaceId: UUID
    public var name: String
    public let createdAt: Date
    public var updatedAt: Date
}

public struct Column: Codable, Sendable, Hashable, Identifiable {
    public let id: UUID
    public let boardId: UUID
    public var name: String
    public var position: String
    public var wipLimit: Int?
}

public enum ActorType: String, Codable, Sendable {
    case user, agent
}

/// Who performed a change: a human user or an AI agent (API key).
public struct Actor: Codable, Sendable, Hashable {
    public let type: ActorType
    public let id: UUID
    public let name: String

    public var isAgent: Bool { type == .agent }
}

/// A kanban card. Named `TaskItem` to avoid clashing with Swift concurrency's `Task`.
public struct TaskItem: Codable, Sendable, Hashable, Identifiable {
    public let id: UUID
    public let boardId: UUID
    public var columnId: UUID
    public var title: String
    public var description: String
    public var position: String
    public var assigneeId: UUID?
    public var labels: [String]
    public var dueAt: Date?
    public let createdBy: Actor
    public let createdAt: Date
    public var updatedAt: Date
}

public struct Comment: Codable, Sendable, Hashable, Identifiable {
    public let id: UUID
    public let taskId: UUID
    public var body: String
    public let actor: Actor
    public let createdAt: Date
}

public struct ApiKey: Codable, Sendable, Hashable, Identifiable {
    public let id: UUID
    public let workspaceId: UUID
    public var name: String
    public let prefix: String
    public let createdAt: Date
    public var lastUsedAt: Date?
}

public struct Event: Codable, Sendable, Hashable, Identifiable {
    public let seq: Int
    public let workspaceId: UUID
    public let actor: Actor
    public let type: String
    public let entityId: UUID
    public let payload: JSONValue
    public let createdAt: Date

    public var id: Int { seq }

    public var kind: EventKind? { EventKind(rawValue: type) }

    /// Decode the payload as a concrete model (full entity after the change).
    public func decodePayload<T: Decodable>(_ type: T.Type) throws -> T {
        try payload.decode(type)
    }
}

public enum EventKind: String, Sendable {
    case boardCreated = "board.created", boardUpdated = "board.updated", boardDeleted = "board.deleted"
    case columnCreated = "column.created", columnUpdated = "column.updated", columnDeleted = "column.deleted"
    case taskCreated = "task.created", taskUpdated = "task.updated", taskMoved = "task.moved", taskDeleted = "task.deleted"
    case commentCreated = "comment.created"
    case memberAdded = "member.added", memberRemoved = "member.removed"
}

// MARK: - Responses

public struct AuthResponse: Codable, Sendable {
    public let user: User
    public let accessToken: String
    public let refreshToken: String
}

public struct TokenPair: Codable, Sendable, Equatable {
    public let accessToken: String
    public let refreshToken: String

    public init(accessToken: String, refreshToken: String) {
        self.accessToken = accessToken
        self.refreshToken = refreshToken
    }
}

public struct BoardSnapshot: Codable, Sendable {
    public let board: Board
    public let columns: [Column]
    public let tasks: [TaskItem]
}

public struct TaskDetail: Codable, Sendable {
    public let task: TaskItem
    public let comments: [Comment]
}

public struct EventPage: Codable, Sendable {
    public let events: [Event]
    public let latestSeq: Int
}

public struct Invite: Codable, Sendable {
    public let token: String
    public let url: String
}

public struct CreatedApiKey: Codable, Sendable {
    public let apiKey: ApiKey
    public let secret: String
}

// MARK: - Ordering

public extension Column {
    static func ordered(_ a: Column, _ b: Column) -> Bool {
        a.position != b.position ? a.position < b.position : a.id.uuidString < b.id.uuidString
    }
}

public extension TaskItem {
    static func ordered(_ a: TaskItem, _ b: TaskItem) -> Bool {
        a.position != b.position ? a.position < b.position : a.id.uuidString < b.id.uuidString
    }
}
