import Testing
@testable import KanbotKit

@Suite struct MarkdownTests {
    @Test func headingsParagraphsAndRules() {
        let blocks = Markdown.parse("# Title ##\n\nSome *text*\nnext line\n\n---\nSetext\n===")
        #expect(blocks == [
            .heading(level: 1, text: "Title"),
            .paragraph("Some *text*\nnext line"),
            .rule,
            .heading(level: 1, text: "Setext"),
        ])
    }

    @Test func fencedCodeKeepsContentVerbatim() {
        let blocks = Markdown.parse("```Swift\nlet x = 1\n\n# not a heading\n```\nafter")
        #expect(blocks == [.code(language: "swift", code: "let x = 1\n\n# not a heading"), .paragraph("after")])
    }

    @Test func unterminatedFenceRunsToEnd() {
        #expect(Markdown.parse("~~~\na\nb") == [.code(language: nil, code: "a\nb")])
    }

    @Test func nestedListsAndTasks() {
        let source = "- [ ] todo\n- [x] done\n  - child\n- plain"
        guard case .list(let ordered, _, let items)? = Markdown.parse(source).first else {
            Issue.record("not a list"); return
        }
        #expect(!ordered && items.count == 3)
        #expect(items[0].checked == false && items[0].line == 0 && items[0].blocks == [.paragraph("todo")])
        #expect(items[1].checked == true && items[1].line == 1)
        #expect(items[1].blocks.count == 2)
        if case .list(_, _, let children) = items[1].blocks[1] {
            #expect(children.first?.blocks == [.paragraph("child")])
            #expect(children.first?.line == 2)
        } else {
            Issue.record("missing nested list")
        }
        #expect(items[2].checked == nil)
    }

    @Test func orderedListKeepsStartNumber() {
        guard case .list(let ordered, let start, let items)? = Markdown.parse("3. c\n4. d\n\n5. e").first else {
            Issue.record("not a list"); return
        }
        #expect(ordered && start == 3 && items.count == 3)
    }

    @Test func numberDoesNotInterruptParagraph() {
        #expect(Markdown.parse("In\n2024. was a year") == [.paragraph("In\n2024. was a year")])
    }

    @Test func quotesNest() {
        #expect(Markdown.parse("> # Hi\n> there") == [.quote([.heading(level: 1, text: "Hi"), .paragraph("there")])])
    }

    @Test func tables() {
        let blocks = Markdown.parse("| a | b |\n|:--|--:|\n| 1 | `x|y` |\n| 2 |")
        #expect(blocks == [.table(header: ["a", "b"], alignments: [.leading, .trailing],
                                  rows: [["1", "`x|y`"], ["2", ""]])])
    }

    @Test func toggleTask() {
        let source = "- [ ] one\n- [x] two"
        #expect(Markdown.toggleTask(in: source, line: 0) == "- [x] one\n- [x] two")
        #expect(Markdown.toggleTask(in: source, line: 1) == "- [ ] one\n- [ ] two")
        #expect(Markdown.toggleTask(in: source, line: 5) == source)
    }
}

@Suite struct CodeHighlighterTests {
    @Test func swiftTokens() {
        let tokens = CodeHighlighter.tokenize("let s: String = \"hi\" // note\nreturn 42", language: "swift")
        #expect(tokens.contains(.init(.keyword, "let")))
        #expect(tokens.contains(.init(.type, "String")))
        #expect(tokens.contains(.init(.string, "\"hi\"")))
        #expect(tokens.contains(.init(.comment, "// note")))
        #expect(tokens.contains(.init(.keyword, "return")))
        #expect(tokens.contains(.init(.number, "42")))
        #expect(tokens.map(\.text).joined() == "let s: String = \"hi\" // note\nreturn 42")
    }

    @Test func shellHashComments() {
        let tokens = CodeHighlighter.tokenize("echo $# # done", language: "bash")
        #expect(tokens.last == CodeHighlighter.Token(.comment, "# done"))
    }

    @Test func diffLines() {
        let tokens = CodeHighlighter.tokenize("@@ -1 +1 @@\n-old\n+new", language: "diff")
        #expect(tokens.map(\.kind) == [.keyword, .deleted, .inserted])
    }

    @Test func identifiersWithDigitsAreNotNumbers() {
        let tokens = CodeHighlighter.tokenize("v2 = 3", language: "python")
        #expect(!tokens.contains(.init(.number, "2")))
        #expect(tokens.contains(.init(.number, "3")))
    }
}
