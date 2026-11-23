import Foundation

/// Turns card ids in Markdown into links the app can open (`kanbot-task://<id>`).
public enum TaskLinks {
    public static let scheme = "kanbot-task"

    public static func taskId(from url: URL) -> UUID? {
        guard url.scheme == scheme, let host = url.host else { return nil }
        return UUID(uuidString: host)
    }

    private static let pattern = try! NSRegularExpression(
        pattern: "(#task:)?\\b([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\\b"
    )

    /// Replaces resolved ids with `[title](kanbot-task://id)` and broken ones with struck-through text.
    /// Code spans stay untouched; ids the server did not resolve are left as plain text.
    public static func link(_ markdown: String, references: [UUID: TaskReference]) -> String {
        guard !references.isEmpty else { return markdown }
        let parts = markdown.components(separatedBy: "`")
        return parts.enumerated().map { index, part in
            index % 2 == 1 ? part : rewrite(part, references)
        }.joined(separator: "`")
    }

    private static func rewrite(_ text: String, _ references: [UUID: TaskReference]) -> String {
        let ns = text as NSString
        var out = ""
        var last = 0
        for m in pattern.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
            guard let id = UUID(uuidString: ns.substring(with: m.range(at: 2))),
                  let ref = references[id] else { continue }
            out += ns.substring(with: NSRange(location: last, length: m.range.location - last))
            last = m.range.location + m.range.length
            if ref.broken {
                out += "~~\(id.uuidString.lowercased())~~ (missing card)"
            } else {
                let title = (ref.title ?? id.uuidString)
                    .replacingOccurrences(of: "\\", with: "\\\\")
                    .replacingOccurrences(of: "[", with: "\\[")
                    .replacingOccurrences(of: "]", with: "\\]")
                out += "[\(title)](\(scheme)://\(id.uuidString.lowercased()))"
            }
        }
        return out + ns.substring(from: last)
    }
}
