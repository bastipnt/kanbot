import Foundation
import Security

/// A signed-in account on a particular server.
public struct Session: Codable, Sendable, Equatable {
    public var serverURL: URL
    public var userId: UUID
    public var tokens: TokenPair

    public init(serverURL: URL, userId: UUID, tokens: TokenPair) {
        self.serverURL = serverURL
        self.userId = userId
        self.tokens = tokens
    }
}

/// Persists the session (server URL + tokens). Tokens are secrets, so the default store is the Keychain.
public protocol SessionStore: Sendable {
    func load() -> Session?
    func save(_ session: Session?)
}

public struct KeychainSessionStore: SessionStore {
    private let service: String
    private let account = "session"

    public init(service: String = "dev.kanbot.session") {
        self.service = service
    }

    private var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: account]
    }

    public func load() -> Session? {
        var q = query
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &item) == errSecSuccess, let data = item as? Data else { return nil }
        return try? JSONDecoder().decode(Session.self, from: data)
    }

    public func save(_ session: Session?) {
        SecItemDelete(query as CFDictionary)
        guard let session, let data = try? JSONEncoder().encode(session) else { return }
        var q = query
        q[kSecValueData as String] = data
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        SecItemAdd(q as CFDictionary, nil)
    }
}

/// In-memory store for tests and previews.
public final class MemorySessionStore: SessionStore, @unchecked Sendable {
    private let lock = NSLock()
    private var session: Session?

    public init(_ session: Session? = nil) { self.session = session }

    public func load() -> Session? { lock.withLock { session } }
    public func save(_ session: Session?) { lock.withLock { self.session = session } }
}

enum JWT {
    /// Expiry (`exp`) of a JWT, without verifying it. Used only to refresh proactively.
    static func expiry(of token: String) -> Date? {
        let parts = token.split(separator: ".")
        guard parts.count == 3 else { return nil }
        var b64 = parts[1].replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        b64 += String(repeating: "=", count: (4 - b64.count % 4) % 4)
        guard let data = Data(base64Encoded: b64),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let exp = obj["exp"] as? Double else { return nil }
        return Date(timeIntervalSince1970: exp)
    }
}
