import Foundation

/// A lightweight, language-aware tokenizer for code blocks. Not a real parser: it
/// recognises comments, strings, numbers, keywords and type-like names, which is
/// enough to make snippets in descriptions and comments readable.
public enum CodeHighlighter {
    public enum Kind: Equatable, Sendable {
        case plain, keyword, string, comment, number, type, inserted, deleted
    }

    public struct Token: Equatable, Sendable {
        public let kind: Kind
        public let text: String

        public init(_ kind: Kind, _ text: String) {
            self.kind = kind
            self.text = text
        }
    }

    public static func tokenize(_ code: String, language: String?) -> [Token] {
        let lang = language.map { aliases[$0.lowercased()] ?? $0.lowercased() }
        if lang == "diff" { return diffTokens(code) }
        let spec = lang.flatMap { specs[$0] } ?? .fallback
        var tokenizer = Tokenizer(chars: Array(code), spec: spec)
        return tokenizer.run()
    }

    // MARK: - Language specs

    struct Spec: Sendable {
        var lineComments: [String] = []
        var blockComment: (open: String, close: String)?
        var stringDelimiters: Set<Character> = ["\""]
        var keywords: Set<String> = []
        var capitalizedAreTypes = false
        var dashInIdentifiers = false

        static let fallback = Spec(lineComments: ["//"], stringDelimiters: ["\"", "'", "`"])
    }

    static let aliases: [String: String] = [
        "js": "javascript", "jsx": "javascript", "mjs": "javascript", "cjs": "javascript",
        "ts": "typescript", "tsx": "typescript",
        "py": "python", "rb": "ruby", "rs": "rust", "golang": "go", "kt": "kotlin",
        "sh": "shell", "bash": "shell", "zsh": "shell", "console": "shell", "shellscript": "shell",
        "yml": "yaml", "c++": "cpp", "cc": "cpp", "h": "c", "hpp": "cpp", "objc": "c",
        "cs": "csharp", "c#": "csharp", "psql": "sql", "postgres": "sql", "postgresql": "sql",
        "jsonc": "json", "patch": "diff", "dockerfile": "docker",
    ]

    static let cStyle: (open: String, close: String) = ("/*", "*/")

    static let jsKeywords: Set<String> = [
        "as", "async", "await", "break", "case", "catch", "class", "const", "continue", "default",
        "delete", "do", "else", "export", "extends", "false", "finally", "for", "from", "function",
        "if", "import", "in", "instanceof", "let", "new", "null", "of", "return", "static", "super",
        "switch", "this", "throw", "true", "try", "typeof", "undefined", "var", "void", "while", "yield",
    ]

    static let specs: [String: Spec] = [
        "swift": Spec(lineComments: ["//"], blockComment: CodeHighlighter.cStyle, keywords: [
            "actor", "any", "as", "associatedtype", "async", "await", "break", "case", "catch", "class",
            "continue", "default", "defer", "deinit", "do", "else", "enum", "extension", "fallthrough",
            "false", "fileprivate", "final", "for", "func", "guard", "if", "import", "in", "init",
            "inout", "internal", "is", "lazy", "let", "mutating", "nil", "nonisolated", "open",
            "operator", "override", "private", "protocol", "public", "repeat", "rethrows", "return",
            "self", "Self", "some", "static", "struct", "subscript", "super", "switch", "throw",
            "throws", "true", "try", "typealias", "var", "weak", "where", "while",
        ], capitalizedAreTypes: true),
        "javascript": Spec(lineComments: ["//"], blockComment: CodeHighlighter.cStyle, stringDelimiters: ["\"", "'", "`"],
                           keywords: CodeHighlighter.jsKeywords, capitalizedAreTypes: true),
        "typescript": Spec(lineComments: ["//"], blockComment: CodeHighlighter.cStyle, stringDelimiters: ["\"", "'", "`"],
                           keywords: CodeHighlighter.jsKeywords.union([
                               "abstract", "any", "boolean", "declare", "enum", "implements", "interface",
                               "keyof", "namespace", "never", "number", "private", "protected", "public",
                               "readonly", "satisfies", "string", "type", "unknown",
                           ]), capitalizedAreTypes: true),
        "python": Spec(lineComments: ["#"], stringDelimiters: ["\"", "'"], keywords: [
            "and", "as", "assert", "async", "await", "break", "class", "continue", "def", "del", "elif",
            "else", "except", "False", "finally", "for", "from", "global", "if", "import", "in", "is",
            "lambda", "None", "nonlocal", "not", "or", "pass", "raise", "return", "self", "True", "try",
            "while", "with", "yield",
        ], capitalizedAreTypes: true),
        "ruby": Spec(lineComments: ["#"], stringDelimiters: ["\"", "'"], keywords: [
            "begin", "break", "case", "class", "def", "do", "else", "elsif", "end", "ensure", "false",
            "for", "if", "in", "module", "next", "nil", "require", "rescue", "return", "self", "super",
            "then", "true", "unless", "until", "when", "while", "yield",
        ], capitalizedAreTypes: true),
        "go": Spec(lineComments: ["//"], blockComment: CodeHighlighter.cStyle, stringDelimiters: ["\"", "'", "`"], keywords: [
            "break", "case", "chan", "const", "continue", "default", "defer", "else", "false", "for",
            "func", "go", "goto", "if", "import", "interface", "map", "nil", "package", "range",
            "return", "select", "struct", "switch", "true", "type", "var",
        ], capitalizedAreTypes: true),
        "rust": Spec(lineComments: ["//"], blockComment: CodeHighlighter.cStyle, keywords: [
            "as", "async", "await", "break", "const", "continue", "crate", "dyn", "else", "enum", "extern",
            "false", "fn", "for", "if", "impl", "in", "let", "loop", "match", "mod", "move", "mut", "pub",
            "ref", "return", "self", "Self", "static", "struct", "super", "trait", "true", "type",
            "unsafe", "use", "where", "while",
        ], capitalizedAreTypes: true),
        "kotlin": Spec(lineComments: ["//"], blockComment: CodeHighlighter.cStyle, stringDelimiters: ["\"", "'"], keywords: [
            "as", "break", "class", "companion", "continue", "data", "do", "else", "enum", "false", "for",
            "fun", "if", "import", "in", "interface", "is", "null", "object", "override", "package",
            "private", "return", "sealed", "super", "suspend", "this", "throw", "true", "try", "val",
            "var", "when", "while",
        ], capitalizedAreTypes: true),
        "java": Spec(lineComments: ["//"], blockComment: CodeHighlighter.cStyle, stringDelimiters: ["\"", "'"], keywords: [
            "abstract", "break", "case", "catch", "class", "continue", "default", "do", "else", "enum",
            "extends", "false", "final", "finally", "for", "if", "implements", "import", "instanceof",
            "interface", "new", "null", "package", "private", "protected", "public", "return", "static",
            "super", "switch", "this", "throw", "throws", "true", "try", "var", "void", "while",
        ], capitalizedAreTypes: true),
        "csharp": Spec(lineComments: ["//"], blockComment: CodeHighlighter.cStyle, stringDelimiters: ["\"", "'"], keywords: [
            "async", "await", "break", "case", "catch", "class", "const", "continue", "default", "do",
            "else", "enum", "false", "finally", "for", "foreach", "if", "in", "interface", "namespace",
            "new", "null", "override", "private", "protected", "public", "readonly", "return", "static",
            "struct", "switch", "this", "throw", "true", "try", "using", "var", "virtual", "void", "while",
        ], capitalizedAreTypes: true),
        "c": Spec(lineComments: ["//"], blockComment: CodeHighlighter.cStyle, stringDelimiters: ["\"", "'"], keywords: [
            "break", "case", "char", "const", "continue", "default", "do", "double", "else", "enum",
            "extern", "float", "for", "goto", "if", "int", "long", "return", "short", "signed", "sizeof",
            "static", "struct", "switch", "typedef", "union", "unsigned", "void", "volatile", "while",
            "#include", "#define", "#if", "#ifdef", "#ifndef", "#endif", "#else", "NULL",
        ]),
        "cpp": Spec(lineComments: ["//"], blockComment: CodeHighlighter.cStyle, stringDelimiters: ["\"", "'"], keywords: [
            "auto", "bool", "break", "case", "catch", "char", "class", "const", "constexpr", "continue",
            "default", "delete", "do", "double", "else", "enum", "false", "float", "for", "if", "int",
            "long", "namespace", "new", "nullptr", "private", "protected", "public", "return", "static",
            "struct", "switch", "template", "this", "throw", "true", "try", "typename", "using",
            "virtual", "void", "while", "#include", "#define", "#if", "#ifdef", "#ifndef", "#endif",
        ], capitalizedAreTypes: true),
        "shell": Spec(lineComments: ["#"], stringDelimiters: ["\"", "'"], keywords: [
            "case", "do", "done", "elif", "else", "esac", "export", "fi", "for", "function", "if", "in",
            "local", "return", "then", "until", "while", "echo", "cd", "sudo",
        ]),
        "docker": Spec(lineComments: ["#"], stringDelimiters: ["\"", "'"], keywords: [
            "FROM", "RUN", "CMD", "COPY", "ADD", "WORKDIR", "ENV", "ARG", "EXPOSE", "ENTRYPOINT",
            "USER", "VOLUME", "LABEL", "AS", "HEALTHCHECK",
        ]),
        "sql": Spec(lineComments: ["--"], blockComment: CodeHighlighter.cStyle, stringDelimiters: ["'", "\""], keywords: Set([
            "select", "from", "where", "and", "or", "not", "insert", "into", "values", "update", "set",
            "delete", "create", "table", "alter", "drop", "index", "on", "join", "left", "right", "inner",
            "outer", "group", "by", "order", "having", "limit", "offset", "as", "distinct", "null", "is",
            "in", "primary", "key", "references", "default", "returning", "with", "case", "when", "then",
            "else", "end", "true", "false", "begin", "commit", "rollback", "union", "all", "exists",
        ].flatMap { [$0, $0.uppercased()] })),
        "json": Spec(stringDelimiters: ["\""], keywords: ["true", "false", "null"]),
        "yaml": Spec(lineComments: ["#"], stringDelimiters: ["\"", "'"], keywords: [
            "true", "false", "null", "yes", "no", "on", "off",
        ]),
        "toml": Spec(lineComments: ["#"], stringDelimiters: ["\"", "'"], keywords: ["true", "false"]),
        "css": Spec(blockComment: CodeHighlighter.cStyle, stringDelimiters: ["\"", "'"], keywords: [
            "!important", "@media", "@import", "@keyframes", "inherit", "initial", "none", "auto",
        ], dashInIdentifiers: true),
        "html": Spec(blockComment: ("<!--", "-->"), stringDelimiters: ["\"", "'"]),
        "xml": Spec(blockComment: ("<!--", "-->"), stringDelimiters: ["\"", "'"]),
    ]

    // MARK: - Tokenizer

    struct Tokenizer {
        let chars: [Character]
        let spec: Spec
        var tokens: [Token] = []
        var plain = ""
        var i = 0

        init(chars: [Character], spec: Spec) {
            self.chars = chars
            self.spec = spec
        }

        mutating func run() -> [Token] {
            while i < chars.count {
                let c = chars[i]
                if let block = spec.blockComment, matches(block.open) {
                    let end = find(block.close, from: i + block.open.count).map { $0 + block.close.count }
                    emit(.comment, upTo: end ?? chars.count)
                } else if let marker = spec.lineComments.first(where: { matches($0) }), commentAllowed(marker) {
                    emit(.comment, upTo: chars[i...].firstIndex(of: "\n") ?? chars.count)
                } else if spec.stringDelimiters.contains(c) {
                    emit(.string, upTo: stringEnd(delimiter: c))
                } else if c.isNumber, c.isASCII, !previousIsIdentifier {
                    var j = i + 1
                    while j < chars.count, chars[j].isHexDigit || "xXoObB_.".contains(chars[j]) {
                        if chars[j] == ".", !(j + 1 < chars.count && chars[j + 1].isNumber) { break }
                        j += 1
                    }
                    emit(.number, upTo: j)
                } else if isIdentifierStart(c) {
                    var j = i + 1
                    while j < chars.count, isIdentifierPart(chars[j]) { j += 1 }
                    let word = String(chars[i..<j])
                    if spec.keywords.contains(word) {
                        emit(.keyword, upTo: j)
                    } else if spec.capitalizedAreTypes, let first = word.first(where: { $0 != "@" && $0 != "#" }),
                              first.isUppercase, word.contains(where: \.isLowercase) {
                        emit(.type, upTo: j)
                    } else {
                        plain += word
                        i = j
                    }
                } else {
                    plain.append(c)
                    i += 1
                }
            }
            flush()
            return tokens
        }

        var previousIsIdentifier: Bool {
            i > 0 && isIdentifierPart(chars[i - 1])
        }

        func isIdentifierStart(_ c: Character) -> Bool {
            c.isLetter || c == "_" || ((c == "@" || c == "#" || c == "!") && i + 1 < chars.count && chars[i + 1].isLetter)
        }

        func isIdentifierPart(_ c: Character) -> Bool {
            c.isLetter || c.isNumber || c == "_" || (c == "-" && spec.dashInIdentifiers)
        }

        /// `#` starts a comment only at the start of a word (so `$#` or `a#b` stay plain).
        func commentAllowed(_ marker: String) -> Bool {
            marker != "#" || i == 0 || chars[i - 1].isWhitespace
        }

        func matches(_ s: String) -> Bool {
            var j = i
            for c in s {
                guard j < chars.count, chars[j] == c else { return false }
                j += 1
            }
            return true
        }

        func find(_ s: String, from start: Int) -> Int? {
            let needle = Array(s)
            guard needle.count <= chars.count else { return nil }
            var j = start
            while j + needle.count <= chars.count {
                if Array(chars[j..<j + needle.count]) == needle { return j }
                j += 1
            }
            return nil
        }

        /// Strings end at the matching delimiter; quotes other than backticks also end at a newline.
        func stringEnd(delimiter: Character) -> Int {
            var j = i + 1
            while j < chars.count {
                let c = chars[j]
                if c == "\\" { j += 2; continue }
                if c == delimiter { return j + 1 }
                if c == "\n" && delimiter != "`" { return j }
                j += 1
            }
            return chars.count
        }

        mutating func emit(_ kind: Kind, upTo end: Int) {
            let end = min(max(end, i + 1), chars.count)
            flush()
            tokens.append(Token(kind, String(chars[i..<end])))
            i = end
        }

        mutating func flush() {
            guard !plain.isEmpty else { return }
            tokens.append(Token(.plain, plain))
            plain = ""
        }
    }

    static func diffTokens(_ code: String) -> [Token] {
        let lines = code.split(separator: "\n", omittingEmptySubsequences: false)
        return lines.enumerated().map { index, line in
            let text = String(line) + (index < lines.count - 1 ? "\n" : "")
            if line.hasPrefix("+") && !line.hasPrefix("+++") { return Token(.inserted, text) }
            if line.hasPrefix("-") && !line.hasPrefix("---") { return Token(.deleted, text) }
            if line.hasPrefix("@@") { return Token(.keyword, text) }
            if line.hasPrefix("diff ") || line.hasPrefix("+++") || line.hasPrefix("---") || line.hasPrefix("index ") {
                return Token(.comment, text)
            }
            return Token(.plain, text)
        }
    }
}
