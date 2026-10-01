import Foundation

/// Block-level Markdown (CommonMark subset + GitHub tables and task lists) for task
/// descriptions and comments. Inline syntax — bold, italics, code spans, links — stays
/// in the block text; the app renders it with `AttributedString(markdown:)`.
public enum MarkdownBlock: Equatable, Sendable {
    case heading(level: Int, text: String)
    case paragraph(String)
    case code(language: String?, code: String)
    case quote([MarkdownBlock])
    case list(ordered: Bool, start: Int, items: [MarkdownListItem])
    case table(header: [String], alignments: [MarkdownTableAlignment], rows: [[String]])
    case rule
}

public struct MarkdownListItem: Equatable, Sendable {
    /// `nil` for a plain item; `true`/`false` for a `- [x]` / `- [ ]` task item.
    public var checked: Bool?
    /// Zero-based source line of the item marker, for `Markdown.toggleTask`.
    public var line: Int
    public var blocks: [MarkdownBlock]

    public init(checked: Bool?, line: Int, blocks: [MarkdownBlock]) {
        self.checked = checked
        self.line = line
        self.blocks = blocks
    }
}

public enum MarkdownTableAlignment: Equatable, Sendable {
    case leading, center, trailing
}

public enum Markdown {
    public static func parse(_ source: String) -> [MarkdownBlock] {
        let lines = source.replacingOccurrences(of: "\r\n", with: "\n")
            .split(separator: "\n", omittingEmptySubsequences: false)
            .enumerated()
            .map { Line(text: expandLeadingTabs(String($0.element)), number: $0.offset) }
        return parseBlocks(lines)
    }

    /// Flips the task checkbox on `line` (as reported by `MarkdownListItem.line`).
    public static func toggleTask(in source: String, line: Int) -> String {
        var lines = source.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        guard lines.indices.contains(line) else { return source }
        let text = lines[line]
        for (from, to) in [("[ ]", "[x]"), ("[x]", "[ ]"), ("[X]", "[ ]")] {
            if let range = text.range(of: from) {
                lines[line] = text.replacingCharacters(in: range, with: to)
                return lines.joined(separator: "\n")
            }
        }
        return source
    }

    // MARK: - Blocks

    struct Line {
        var text: String
        let number: Int
        var isBlank: Bool { text.allSatisfy(\.isWhitespace) }
        var indent: Int { text.prefix { $0 == " " }.count }
    }

    static func parseBlocks(_ lines: [Line]) -> [MarkdownBlock] {
        var blocks: [MarkdownBlock] = []
        var i = 0
        while i < lines.count {
            let line = lines[i]
            if line.isBlank { i += 1; continue }

            if let fence = fenceOpening(line.text) {
                var body: [String] = []
                i += 1
                while i < lines.count, !isFenceClosing(lines[i].text, fence) {
                    body.append(String(lines[i].text.dropLeadingSpaces(upTo: fence.indent)))
                    i += 1
                }
                i += 1 // closing fence (or end of input)
                blocks.append(.code(language: fence.language, code: body.joined(separator: "\n")))
            } else if let heading = atxHeading(line.text) {
                blocks.append(.heading(level: heading.level, text: heading.text))
                i += 1
            } else if isRule(line.text) {
                blocks.append(.rule)
                i += 1
            } else if quoteContent(line.text) != nil {
                var inner: [Line] = []
                while i < lines.count, let content = quoteContent(lines[i].text) {
                    inner.append(Line(text: content, number: lines[i].number))
                    i += 1
                }
                blocks.append(.quote(parseBlocks(inner)))
            } else if let marker = listMarker(line.text) {
                let (block, next) = parseList(lines, from: i, first: marker)
                blocks.append(block)
                i = next
            } else if i + 1 < lines.count, line.text.contains("|"),
                      let alignments = tableDelimiter(lines[i + 1].text) {
                let header = tableCells(line.text)
                var rows: [[String]] = []
                i += 2
                while i < lines.count, !lines[i].isBlank, lines[i].text.contains("|") {
                    var cells = tableCells(lines[i].text)
                    cells = Array(cells.prefix(header.count))
                    cells += Array(repeating: "", count: header.count - cells.count)
                    rows.append(cells)
                    i += 1
                }
                let aligns = Array(alignments.prefix(header.count))
                    + Array(repeating: .leading, count: max(0, header.count - alignments.count))
                blocks.append(.table(header: header, alignments: aligns, rows: rows))
            } else {
                var text: [String] = [line.text.trimmingCharacters(in: .whitespaces)]
                i += 1
                var setextLevel: Int?
                while i < lines.count, !lines[i].isBlank {
                    let next = lines[i].text
                    if let level = setextUnderline(next) { setextLevel = level; i += 1; break }
                    if interruptsParagraph(next) { break }
                    text.append(next.trimmingCharacters(in: .whitespaces))
                    i += 1
                }
                let joined = text.joined(separator: "\n")
                if let setextLevel {
                    blocks.append(.heading(level: setextLevel, text: joined))
                } else {
                    blocks.append(.paragraph(joined))
                }
            }
        }
        return blocks
    }

    static func interruptsParagraph(_ text: String) -> Bool {
        fenceOpening(text) != nil || atxHeading(text) != nil || isRule(text)
            || quoteContent(text) != nil || listMarkerInterrupting(text)
    }

    /// Like CommonMark: only bullets and lists starting at 1 may interrupt a paragraph.
    static func listMarkerInterrupting(_ text: String) -> Bool {
        guard let marker = listMarker(text), !marker.content.allSatisfy(\.isWhitespace) else { return false }
        return !marker.ordered || marker.number == 1
    }

    // MARK: Lists

    struct ListMarker {
        let ordered: Bool
        let number: Int
        let delimiter: Character // "-", "*", "+", "." or ")"
        let indent: Int          // spaces before the marker
        let contentIndent: Int   // column where item content starts
        let content: String
    }

    static func listMarker(_ text: String) -> ListMarker? {
        let indent = text.prefix { $0 == " " }.count
        guard indent < 4 else { return nil }
        let rest = text.dropFirst(indent)
        guard let first = rest.first else { return nil }
        if "-*+".contains(first) {
            let after = rest.dropFirst()
            guard after.isEmpty || after.first == " " else { return nil }
            let gap = min(max(after.prefix { $0 == " " }.count, 1), 4)
            return ListMarker(ordered: false, number: 1, delimiter: first, indent: indent,
                              contentIndent: indent + 1 + gap,
                              content: String(after.dropFirst(min(gap, after.count))))
        }
        let digits = rest.prefix { $0.isASCII && $0.isNumber }
        guard (1...9).contains(digits.count), let number = Int(digits) else { return nil }
        let afterDigits = rest.dropFirst(digits.count)
        guard let delimiter = afterDigits.first, delimiter == "." || delimiter == ")" else { return nil }
        let after = afterDigits.dropFirst()
        guard after.isEmpty || after.first == " " else { return nil }
        let gap = min(max(after.prefix { $0 == " " }.count, 1), 4)
        return ListMarker(ordered: true, number: number, delimiter: delimiter, indent: indent,
                          contentIndent: indent + digits.count + 1 + gap,
                          content: String(after.dropFirst(min(gap, after.count))))
    }

    static func parseList(_ lines: [Line], from start: Int, first: ListMarker) -> (MarkdownBlock, Int) {
        var items: [MarkdownListItem] = []
        var i = start
        var marker: ListMarker? = first

        while let current = marker {
            var body = [Line(text: current.content, number: lines[i].number)]
            let itemLine = lines[i].number
            i += 1
            marker = nil
            while i < lines.count {
                let line = lines[i]
                if line.isBlank {
                    // A blank line continues the item only if indented content follows.
                    var j = i
                    while j < lines.count, lines[j].isBlank { j += 1 }
                    guard j < lines.count else { i = j; break }
                    if lines[j].indent >= current.contentIndent {
                        body += lines[i..<j].map { Line(text: "", number: $0.number) }
                        i = j
                        continue
                    }
                    if let next = listMarker(lines[j].text), sameList(next, current) {
                        i = j
                        marker = next
                    } else {
                        i = j
                    }
                    break
                }
                if line.indent >= current.contentIndent {
                    body.append(Line(text: String(line.text.dropFirst(current.contentIndent)), number: line.number))
                    i += 1
                    continue
                }
                if let next = listMarker(line.text) {
                    if sameList(next, current) { marker = next }
                    else if next.indent > current.indent {
                        // Under-indented nested list: still treat it as a child of this item.
                        body.append(Line(text: String(line.text.dropFirst(next.indent)), number: line.number))
                        i += 1
                        continue
                    }
                    break
                }
                // Lazy continuation of a paragraph.
                if let last = body.last, !last.isBlank, !interruptsParagraph(line.text) {
                    body.append(Line(text: line.text.trimmingCharacters(in: .whitespaces), number: line.number))
                    i += 1
                    continue
                }
                break
            }

            var checked: Bool?
            if let firstLine = body.first {
                let text = firstLine.text
                for (box, value) in [("[ ]", false), ("[x]", true), ("[X]", true)]
                    where text == box || text.hasPrefix(box + " ") {
                    checked = value
                    body[0].text = String(text.dropFirst(box.count + (text.count > box.count ? 1 : 0)))
                    break
                }
            }
            items.append(MarkdownListItem(checked: checked, line: itemLine, blocks: parseBlocks(body)))
        }
        return (.list(ordered: first.ordered, start: first.number, items: items), i)
    }

    static func sameList(_ a: ListMarker, _ b: ListMarker) -> Bool {
        a.ordered == b.ordered && a.delimiter == b.delimiter && a.indent < b.contentIndent
    }

    // MARK: Leaf syntax

    struct Fence {
        let char: Character
        let length: Int
        let indent: Int
        let language: String?
    }

    static func fenceOpening(_ text: String) -> Fence? {
        let indent = text.prefix { $0 == " " }.count
        guard indent < 4 else { return nil }
        let rest = text.dropFirst(indent)
        guard let char = rest.first, char == "`" || char == "~" else { return nil }
        let length = rest.prefix { $0 == char }.count
        guard length >= 3 else { return nil }
        let info = rest.dropFirst(length).trimmingCharacters(in: .whitespaces)
        if char == "`" && info.contains("`") { return nil }
        let language = info.split(separator: " ").first.map { String($0).lowercased() }
        return Fence(char: char, length: length, indent: indent, language: language)
    }

    static func isFenceClosing(_ text: String, _ fence: Fence) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespaces)
        return text.prefix { $0 == " " }.count < 4
            && trimmed.count >= fence.length
            && trimmed.allSatisfy { $0 == fence.char }
    }

    static func atxHeading(_ text: String) -> (level: Int, text: String)? {
        let indent = text.prefix { $0 == " " }.count
        guard indent < 4 else { return nil }
        let rest = text.dropFirst(indent)
        let level = rest.prefix { $0 == "#" }.count
        guard (1...6).contains(level) else { return nil }
        let after = rest.dropFirst(level)
        guard after.isEmpty || after.first == " " else { return nil }
        var content = after.trimmingCharacters(in: .whitespaces)
        // Optional closing sequence: "## Title ##"
        let closing = content.reversed().prefix { $0 == "#" }.count
        if closing > 0 {
            let without = content.dropLast(closing)
            if without.isEmpty || without.last == " " {
                content = without.trimmingCharacters(in: .whitespaces)
            }
        }
        return (level, content)
    }

    static func isRule(_ text: String) -> Bool {
        guard text.prefix(while: { $0 == " " }).count < 4 else { return false }
        let chars = text.filter { !$0.isWhitespace }
        guard let first = chars.first, "-*_".contains(first), chars.count >= 3 else { return false }
        return chars.allSatisfy { $0 == first }
    }

    static func setextUnderline(_ text: String) -> Int? {
        guard text.prefix(while: { $0 == " " }).count < 4 else { return nil }
        let trimmed = text.trimmingCharacters(in: .whitespaces)
        guard let first = trimmed.first, first == "=" || first == "-",
              trimmed.allSatisfy({ $0 == first }) else { return nil }
        return first == "=" ? 1 : 2
    }

    static func quoteContent(_ text: String) -> String? {
        let indent = text.prefix { $0 == " " }.count
        guard indent < 4 else { return nil }
        let rest = text.dropFirst(indent)
        guard rest.first == ">" else { return nil }
        let after = rest.dropFirst()
        return String(after.first == " " ? after.dropFirst() : after)
    }

    static func tableDelimiter(_ text: String) -> [MarkdownTableAlignment]? {
        guard text.contains("-") else { return nil }
        let cells = tableCells(text)
        guard !cells.isEmpty else { return nil }
        var alignments: [MarkdownTableAlignment] = []
        for cell in cells {
            let leftColon = cell.hasPrefix(":"), rightColon = cell.hasSuffix(":")
            let dashes = cell.drop { $0 == ":" }.reversed().drop { $0 == ":" }
            guard !dashes.isEmpty, dashes.allSatisfy({ $0 == "-" }) else { return nil }
            alignments.append(leftColon && rightColon ? .center : rightColon ? .trailing : .leading)
        }
        // A single column needs explicit pipes, otherwise "---" is a rule.
        if cells.count == 1 && !text.contains("|") { return nil }
        return alignments
    }

    static func tableCells(_ text: String) -> [String] {
        var trimmed = text.trimmingCharacters(in: .whitespaces)
        if trimmed.hasPrefix("|") { trimmed.removeFirst() }
        if trimmed.hasSuffix("|") && !trimmed.hasSuffix("\\|") { trimmed.removeLast() }
        var cells: [String] = []
        var current = ""
        var escaped = false
        var inCode = false
        for char in trimmed {
            if escaped {
                if char != "|" { current.append("\\") }
                current.append(char)
                escaped = false
            } else if char == "\\" {
                escaped = true
            } else if char == "`" {
                inCode.toggle()
                current.append(char)
            } else if char == "|" && !inCode {
                cells.append(current.trimmingCharacters(in: .whitespaces))
                current = ""
            } else {
                current.append(char)
            }
        }
        if escaped { current.append("\\") }
        cells.append(current.trimmingCharacters(in: .whitespaces))
        return cells
    }

    static func expandLeadingTabs(_ text: String) -> String {
        guard text.first == "\t" || text.hasPrefix(" ") && text.contains("\t") else { return text }
        var column = 0
        var result = ""
        var index = text.startIndex
        while index < text.endIndex, text[index] == " " || text[index] == "\t" {
            let width = text[index] == "\t" ? 4 - column % 4 : 1
            result += String(repeating: " ", count: width)
            column += width
            index = text.index(after: index)
        }
        return result + text[index...]
    }
}

extension String {
    func dropLeadingSpaces(upTo count: Int) -> Substring {
        dropFirst(min(count, prefix { $0 == " " }.count))
    }
}
