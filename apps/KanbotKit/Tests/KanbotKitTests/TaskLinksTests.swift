import Foundation
import Testing
@testable import KanbotKit

@Suite struct TaskLinksTests {
    let a = UUID(uuidString: "01A1F513-B47F-7000-8000-000000000001")!
    let b = UUID(uuidString: "01A1F513-B47F-7000-8000-000000000002")!
    let other = "01a1f513-b47f-7000-8000-0000000000ff"

    func ref(_ id: UUID, broken: Bool = false, title: String? = "Fix [login]") -> TaskReference {
        let json = broken ? #"{"id":"\#(id.uuidString)","broken":true}"#
            : #"{"id":"\#(id.uuidString)","broken":false,"title":"\#(title!.replacingOccurrences(of: "\"", with: "'"))"}"#
        return try! KanbotJSON.decoder.decode(TaskReference.self, from: Data(json.utf8))
    }

    @Test func linksResolvedBareAndExplicitIds() {
        let text = "See \(a.uuidString.lowercased()) and #task:\(a.uuidString.lowercased()) end"
        let out = TaskLinks.link(text, references: [a: ref(a)])
        let link = "[Fix \\[login\\]](kanbot-task://\(a.uuidString.lowercased()))"
        #expect(out == "See \(link) and \(link) end")
    }

    @Test func brokenIsStruckAndUnknownIdsStay() {
        let out = TaskLinks.link("#task:\(b.uuidString.lowercased()) \(other)", references: [b: ref(b, broken: true)])
        #expect(out == "~~\(b.uuidString.lowercased())~~ (missing card) \(other)")
    }

    @Test func codeSpansAreUntouched() {
        let id = a.uuidString.lowercased()
        #expect(TaskLinks.link("`\(id)` \(id)", references: [a: ref(a)]) == "`\(id)` [Fix \\[login\\]](kanbot-task://\(id))")
    }

    @Test func parsesLinkUrl() {
        #expect(TaskLinks.taskId(from: URL(string: "kanbot-task://\(a.uuidString.lowercased())")!) == a)
        #expect(TaskLinks.taskId(from: URL(string: "https://example.com")!) == nil)
    }
}
