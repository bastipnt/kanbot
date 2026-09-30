import KanbotKit
import SwiftUI

/// Recent changes in the workspace, with agent actions clearly marked.
struct ActivityView: View {
    let store: WorkspaceStore

    var body: some View {
        List(store.activity) { event in
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    ActorBadge(actor: event.actor)
                    Spacer()
                    Text(event.createdAt, format: .relative(presentation: .named))
                        .font(.caption2).foregroundStyle(.secondary)
                }
                Text(describe(event)).font(.callout)
            }
            .padding(.vertical, 2)
            .listRowBackground(event.actor.isAgent ? Color.purple.opacity(0.06) : nil)
        }
        .overlay {
            if store.activity.isEmpty {
                ContentUnavailableView("No activity yet", systemImage: "clock",
                                       description: Text("Changes by people and agents appear here live."))
            }
        }
        .navigationTitle("Activity")
    }

    private func describe(_ event: Event) -> String {
        let title = event.payload["title"]?.stringValue.map { "“\($0)”" } ?? "a task"
        let name = event.payload["name"]?.stringValue.map { "“\($0)”" } ?? ""
        switch event.kind {
        case .taskCreated: return "created \(title)"
        case .taskUpdated: return "updated \(title)"
        case .taskMoved:
            let column = event.payload["columnId"]?.stringValue
                .flatMap { id in store.columns.first { $0.id.api == id.lowercased() }?.name }
            return column.map { "moved \(title) to \($0)" } ?? "moved \(title)"
        case .taskDeleted: return "deleted a task"
        case .commentCreated:
            let taskTitle = event.payload["taskId"]?.stringValue
                .flatMap(UUID.init(uuidString:))
                .flatMap { store.tasksById[$0]?.title }
            return taskTitle.map { "commented on “\($0)”" } ?? "commented on a task"
        case .boardCreated: return "created board \(name)"
        case .boardUpdated: return "renamed board to \(name)"
        case .boardDeleted: return "deleted a board"
        case .columnCreated: return "added column \(name)"
        case .columnUpdated: return "changed column \(name)"
        case .columnDeleted: return "deleted a column"
        case .memberAdded: return "\(name.isEmpty ? "someone" : name) joined"
        case .memberRemoved: return "removed a member"
        case nil: return event.type
        }
    }
}
