import KanbotKit
import SwiftUI

/// Renders task descriptions and comments: headings, lists (incl. task checkboxes),
/// quotes, tables, highlighted code blocks, and inline bold/italic/code/links.
struct MarkdownView: View {
    let blocks: [MarkdownBlock]
    /// Called with the source line of a task checkbox the user tapped; `nil` makes them read-only.
    var onToggleTask: ((Int) -> Void)?

    init(_ source: String, onToggleTask: ((Int) -> Void)? = nil) {
        blocks = Markdown.parse(source)
        self.onToggleTask = onToggleTask
    }

    var body: some View {
        MarkdownBlocks(blocks: blocks, depth: 0, onToggleTask: onToggleTask)
            .frame(maxWidth: .infinity, alignment: .leading)
            .textSelection(.enabled)
    }
}

private struct MarkdownBlocks: View {
    let blocks: [MarkdownBlock]
    let depth: Int
    let onToggleTask: ((Int) -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(blocks.indices, id: \.self) { index in
                block(blocks[index])
            }
        }
    }

    @ViewBuilder
    private func block(_ block: MarkdownBlock) -> some View {
        switch block {
        case .heading(let level, let text):
            InlineText(text)
                .font(headingFont(level))
                .padding(.top, level <= 2 ? 4 : 2)
                .accessibilityAddTraits(.isHeader)
        case .paragraph(let text):
            InlineText(text)
        case .code(let language, let code):
            CodeBlockView(language: language, code: code)
        case .quote(let inner):
            HStack(alignment: .top, spacing: 8) {
                RoundedRectangle(cornerRadius: 1.5)
                    .fill(Color.secondary.opacity(0.4))
                    .frame(width: 3)
                MarkdownBlocks(blocks: inner, depth: depth, onToggleTask: onToggleTask)
                    .foregroundStyle(.secondary)
            }
            .fixedSize(horizontal: false, vertical: true)
        case .list(let ordered, let start, let items):
            VStack(alignment: .leading, spacing: 4) {
                ForEach(items.indices, id: \.self) { index in
                    let item = items[index]
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        marker(item, ordered: ordered, number: start + index)
                        MarkdownBlocks(blocks: item.blocks, depth: depth + 1, onToggleTask: onToggleTask)
                            .foregroundStyle(item.checked == true ? HierarchicalShapeStyle.secondary : .primary)
                    }
                }
            }
        case .table(let header, let alignments, let rows):
            TableBlockView(header: header, alignments: alignments, rows: rows)
        case .rule:
            Divider().padding(.vertical, 4)
        }
    }

    @ViewBuilder
    private func marker(_ item: MarkdownListItem, ordered: Bool, number: Int) -> some View {
        if let checked = item.checked {
            let image = Image(systemName: checked ? "checkmark.square.fill" : "square")
                .foregroundStyle(checked ? Color.accentColor : Color.secondary)
            if let onToggleTask {
                Button { onToggleTask(item.line) } label: { image }
                    .buttonStyle(.plain)
            } else {
                image
            }
        } else if ordered {
            Text("\(number).").monospacedDigit().foregroundStyle(.secondary)
        } else {
            Text(["•", "◦", "▪︎"][depth % 3]).foregroundStyle(.secondary)
        }
    }

    private func headingFont(_ level: Int) -> Font {
        switch level {
        case 1: .title2.bold()
        case 2: .title3.bold()
        case 3: .headline
        default: .subheadline.bold()
        }
    }
}

/// One run of inline Markdown. Bold, italics, strikethrough and code spans come from
/// `AttributedString`'s inline parser; code spans get a tinted background and bare
/// URLs become links.
struct InlineText: View {
    let text: AttributedString

    init(_ markdown: String) {
        text = Self.render(markdown)
    }

    var body: some View {
        Text(text).fixedSize(horizontal: false, vertical: true)
    }

    static func render(_ markdown: String) -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(
            interpretedSyntax: .inlineOnlyPreservingWhitespace,
            failurePolicy: .returnPartiallyParsedIfPossible
        )
        var result = (try? AttributedString(markdown: markdown, options: options)) ?? AttributedString(markdown)

        let codeRanges = result.runs
            .filter { $0.inlinePresentationIntent?.contains(.code) == true }
            .map(\.range)
        for range in codeRanges {
            result[range].backgroundColor = Color.secondary.opacity(0.15)
            result[range].foregroundColor = Color.pink
        }

        linkBareURLs(in: &result, skipping: codeRanges)
        return result
    }

    private static let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue)

    private static func linkBareURLs(in result: inout AttributedString, skipping code: [Range<AttributedString.Index>]) {
        guard let detector else { return }
        let plain = String(result.characters)
        let matches = detector.matches(in: plain, range: NSRange(plain.startIndex..., in: plain))
        for match in matches {
            guard let url = match.url,
                  let stringRange = Range(match.range, in: plain),
                  let range = Range<AttributedString.Index>(stringRange, in: result),
                  !code.contains(where: { $0.overlaps(range) }),
                  result[range].runs.allSatisfy({ $0.link == nil })
            else { continue }
            result[range].link = url
        }
    }
}

struct CodeBlockView: View {
    let language: String?
    let code: String
    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 6) {
                Text(language ?? "code").font(.caption2).foregroundStyle(.secondary)
                Spacer()
                Button {
                    Clipboard.copy(code)
                    copied = true
                    Task {
                        try? await Task.sleep(for: .seconds(1.5))
                        copied = false
                    }
                } label: {
                    Image(systemName: copied ? "checkmark" : "doc.on.doc").font(.caption2)
                }
                .buttonStyle(.borderless)
                .help("Copy code")
            }
            .padding(.horizontal, 10)
            .padding(.top, 6)

            ScrollView(.horizontal) {
                Text(highlighted)
                    .font(.system(.callout, design: .monospaced))
                    .fixedSize(horizontal: true, vertical: true)
                    .padding([.horizontal, .bottom], 10)
                    .padding(.top, 4)
            }
            .scrollIndicators(.never)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.secondary.opacity(0.1), in: RoundedRectangle(cornerRadius: 6))
    }

    private var highlighted: AttributedString {
        var result = AttributedString()
        for token in CodeHighlighter.tokenize(code, language: language) {
            var part = AttributedString(token.text)
            if let color = Self.color(token.kind) { part.foregroundColor = color }
            if token.kind == .inserted { part.backgroundColor = Color.green.opacity(0.12) }
            if token.kind == .deleted { part.backgroundColor = Color.red.opacity(0.12) }
            result += part
        }
        return result
    }

    private static func color(_ kind: CodeHighlighter.Kind) -> Color? {
        switch kind {
        case .plain: nil
        case .keyword: .pink
        case .string: .red
        case .comment: .secondary
        case .number: .blue
        case .type: .teal
        case .inserted: .green
        case .deleted: .red
        }
    }
}

private struct TableBlockView: View {
    let header: [String]
    let alignments: [MarkdownTableAlignment]
    let rows: [[String]]

    var body: some View {
        ScrollView(.horizontal) {
            Grid(alignment: .leading, horizontalSpacing: 14, verticalSpacing: 6) {
                GridRow {
                    ForEach(header.indices, id: \.self) { column in
                        InlineText(header[column])
                            .font(.callout.bold())
                            .gridColumnAlignment(alignment(column))
                    }
                }
                Divider()
                ForEach(rows.indices, id: \.self) { row in
                    GridRow {
                        ForEach(rows[row].indices, id: \.self) { column in
                            InlineText(rows[row][column]).font(.callout)
                        }
                    }
                    if row < rows.count - 1 { Divider().opacity(0.5) }
                }
            }
            .padding(10)
        }
        .scrollIndicators(.never)
        .background(Color.secondary.opacity(0.06), in: RoundedRectangle(cornerRadius: 6))
    }

    private func alignment(_ column: Int) -> HorizontalAlignment {
        switch alignments.indices.contains(column) ? alignments[column] : .leading {
        case .leading: .leading
        case .center: .center
        case .trailing: .trailing
        }
    }
}
