import Foundation

/// Untyped JSON, used for event payloads (decoded on demand) and PATCH bodies (explicit `null`s).
public enum JSONValue: Codable, Sendable, Hashable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let v = try? c.decode(Bool.self) { self = .bool(v) }
        else if let v = try? c.decode(Double.self) { self = .number(v) }
        else if let v = try? c.decode(String.self) { self = .string(v) }
        else if let v = try? c.decode([JSONValue].self) { self = .array(v) }
        else { self = .object(try c.decode([String: JSONValue].self)) }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null: try c.encodeNil()
        case .bool(let v): try c.encode(v)
        case .number(let v): try c.encode(v)
        case .string(let v): try c.encode(v)
        case .array(let v): try c.encode(v)
        case .object(let v): try c.encode(v)
        }
    }

    public func decode<T: Decodable>(_ type: T.Type) throws -> T {
        try KanbotJSON.decoder.decode(T.self, from: KanbotJSON.encoder.encode(self))
    }

    public subscript(key: String) -> JSONValue? {
        if case .object(let o) = self { return o[key] } else { return nil }
    }

    public var stringValue: String? {
        if case .string(let s) = self { return s } else { return nil }
    }
}

extension JSONValue: ExpressibleByStringLiteral, ExpressibleByNilLiteral, ExpressibleByBooleanLiteral,
    ExpressibleByDictionaryLiteral, ExpressibleByArrayLiteral, ExpressibleByIntegerLiteral {
    public init(stringLiteral value: String) { self = .string(value) }
    public init(nilLiteral: ()) { self = .null }
    public init(booleanLiteral value: Bool) { self = .bool(value) }
    public init(integerLiteral value: Int) { self = .number(Double(value)) }
    public init(dictionaryLiteral elements: (String, JSONValue)...) {
        self = .object(Dictionary(elements, uniquingKeysWith: { $1 }))
    }
    public init(arrayLiteral elements: JSONValue...) { self = .array(elements) }
}

public extension JSONValue {
    init(_ string: String?) { self = string.map(JSONValue.string) ?? .null }
    init(_ uuid: UUID?) { self = uuid.map { .string($0.uuidString.lowercased()) } ?? .null }
    init(_ date: Date?) { self = date.map { .string(KanbotJSON.format($0)) } ?? .null }
    init(_ int: Int?) { self = int.map { .number(Double($0)) } ?? .null }
    init(_ strings: [String]) { self = .array(strings.map(JSONValue.string)) }
}

/// Shared coders: ISO-8601 dates with milliseconds (`2026-09-30T12:00:00.000Z`), as the server sends.
public enum KanbotJSON {
    private static let withFraction = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
    private static let plain = Date.ISO8601FormatStyle()

    public static func format(_ date: Date) -> String { withFraction.format(date) }

    public static func parse(_ string: String) -> Date? {
        (try? withFraction.parse(string)) ?? (try? plain.parse(string))
    }

    public static let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .custom { decoder in
            let c = try decoder.singleValueContainer()
            let s = try c.decode(String.self)
            guard let date = parse(s) else {
                throw DecodingError.dataCorruptedError(in: c, debugDescription: "Invalid ISO-8601 date: \(s)")
            }
            return date
        }
        return d
    }()

    public static let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.dateEncodingStrategy = .custom { date, encoder in
            var c = encoder.singleValueContainer()
            try c.encode(format(date))
        }
        return e
    }()
}
