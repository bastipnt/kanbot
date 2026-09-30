import Foundation

/// Local ordering keys for optimistic updates. The server computes the real fractional index;
/// this only needs a key that sorts strictly between two neighbours (bytewise) until the
/// server's response replaces it.
public enum Position {
    private static let below = 0x20 // stands in for "no digit" on the lower bound
    private static let above = 0x7F // stands in for "no upper bound"

    public static func between(_ lower: String?, _ upper: String?) -> String {
        let lo = Array((lower ?? "").utf8)
        let hi = upper.map { Array($0.utf8) }
        var out: [UInt8] = []
        var upperOpen = hi == nil
        var i = 0
        while true {
            let l = i < lo.count ? Int(lo[i]) : below
            let h = upperOpen ? above : (i < hi!.count ? Int(hi![i]) : below)
            if h - l > 1 {
                out.append(UInt8((l + h) / 2))
                return String(decoding: out, as: UTF8.self)
            }
            out.append(UInt8(l))
            // Once we're strictly below `upper` at this digit, later digits are unbounded above.
            if h > l { upperOpen = true }
            i += 1
        }
    }
}
