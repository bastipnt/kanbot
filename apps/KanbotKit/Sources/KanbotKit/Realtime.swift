import Foundation

public enum RealtimeMessage: Sendable, Equatable {
    case hello(latestSeq: Int)
    case event(Event)
    case pong
}

/// Why a realtime connection ended.
public struct RealtimeClosed: Error, Sendable {
    /// True when the server refused or closed us for lack of access (removed member, revoked key).
    public let accessRevoked: Bool
    public let reason: String
}

enum RealtimeDecoding {
    private struct Envelope: Decodable {
        let kind: String
        let latestSeq: Int?
        let event: Event?
    }

    static func decode(_ data: Data) -> RealtimeMessage? {
        guard let env = try? KanbotJSON.decoder.decode(Envelope.self, from: data) else { return nil }
        switch env.kind {
        case "hello": return env.latestSeq.map { .hello(latestSeq: $0) }
        case "event": return env.event.map { .event($0) }
        case "pong": return .pong
        default: return nil
        }
    }
}

/// One WebSocket connection to `/ws`, exposed as a message stream. Sends pings every 25 s.
/// The stream finishes by throwing `RealtimeClosed` when the socket closes.
public enum RealtimeSocket {
    public static func connect(url: URL, session: URLSession = .shared) -> AsyncThrowingStream<RealtimeMessage, Error> {
        AsyncThrowingStream { continuation in
            let task = session.webSocketTask(with: url)
            task.resume()

            let receiver = Task {
                do {
                    while true {
                        let message = try await task.receive()
                        let data: Data
                        switch message {
                        case .string(let s): data = Data(s.utf8)
                        case .data(let d): data = d
                        @unknown default: continue
                        }
                        if let m = RealtimeDecoding.decode(data) { continuation.yield(m) }
                    }
                } catch {
                    let status = (task.response as? HTTPURLResponse)?.statusCode
                    let reason = task.closeReason.flatMap { String(data: $0, encoding: .utf8) } ?? error.localizedDescription
                    // Custom close code 4403 isn't representable in URLSessionWebSocketTask.CloseCode,
                    // so also recognise the server's close reasons and a 403 on the upgrade.
                    let revoked = status == 403 || reason.contains("removed from workspace") || reason.contains("API key revoked")
                    continuation.finish(throwing: RealtimeClosed(accessRevoked: revoked, reason: reason))
                }
            }
            let pinger = Task {
                while !Task.isCancelled {
                    try await Task.sleep(for: .seconds(25))
                    try await task.send(.string(#"{"kind":"ping"}"#))
                }
            }
            continuation.onTermination = { _ in
                receiver.cancel()
                pinger.cancel()
                task.cancel(with: .goingAway, reason: nil)
            }
        }
    }
}
