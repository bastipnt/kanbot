import KanbotKit
import SwiftUI

/// Drag payload for a task card. Plain string so it works with any drop target on both platforms.
enum TaskDrag {
    static let prefix = "kanbot-task:"
    static func payload(_ id: UUID) -> String { prefix + id.uuidString }
    static func id(from payload: String) -> UUID? {
        payload.hasPrefix(prefix) ? UUID(uuidString: String(payload.dropFirst(prefix.count))) : nil
    }
}

struct BoardView: View {
    @Bindable var store: WorkspaceStore
    @State private var selectedTask: TaskItem?
    @State private var showActivity = false
    @State private var showNewColumn = false
    @State private var showRename = false
    @State private var confirmDelete = false

    var body: some View {
        ScrollView(.horizontal) {
            HStack(alignment: .top, spacing: 12) {
                ForEach(store.columns) { column in
                    ColumnView(store: store, column: column) { selectedTask = $0 }
                }
                Button { showNewColumn = true } label: {
                    Label("Add column", systemImage: "plus")
                        .frame(width: 200, height: 44)
                }
                .buttonStyle(.bordered)
            }
            .padding()
            .frame(maxHeight: .infinity, alignment: .top)
        }
        .background(Color.secondary.opacity(0.06))
        .navigationTitle(store.openBoard?.name ?? "")
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .toolbar {
            ToolbarItem {
                Button { showActivity.toggle() } label: { Label("Activity", systemImage: "clock.arrow.circlepath") }
                    .help("Recent changes by people and agents")
            }
            ToolbarItem {
                Menu {
                    Button("Rename board…") { showRename = true }
                    if store.myRole.canAdminister {
                        Button("Delete board…", role: .destructive) { confirmDelete = true }
                    }
                } label: { Label("Board", systemImage: "ellipsis.circle") }
            }
        }
        .inspector(isPresented: $showActivity) {
            ActivityView(store: store)
                .inspectorColumnWidth(min: 260, ideal: 300)
        }
        .sheet(item: $selectedTask) { task in
            TaskDetailView(store: store, taskId: task.id)
        }
        .namePrompt("New column", isPresented: $showNewColumn) { name in
            Task { await store.addColumn(name: name) }
        }
        .namePrompt("Rename board", isPresented: $showRename, initial: store.openBoard?.name ?? "") { name in
            if let id = store.openBoard?.id { Task { await store.renameBoard(id, name: name) } }
        }
        .confirmationDialog("Delete \(store.openBoard?.name ?? "board")?", isPresented: $confirmDelete) {
            Button("Delete board and all its tasks", role: .destructive) {
                if let id = store.openBoard?.id { Task { await store.deleteBoard(id) } }
            }
        } message: {
            Text("This can't be undone.")
        }
    }
}

struct ColumnView: View {
    @Bindable var store: WorkspaceStore
    let column: Column
    let onOpen: (TaskItem) -> Void

    @State private var newTitle = ""
    @State private var isTargeted = false
    @State private var showRename = false
    @State private var showWip = false
    @State private var confirmDelete = false
    @FocusState private var addFocused: Bool

    private var tasks: [TaskItem] { store.tasks(in: column.id) }
    private var overLimit: Bool { column.wipLimit.map { tasks.count > $0 } ?? false }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            header
            ScrollView(.vertical) {
                LazyVStack(spacing: 8) {
                    ForEach(tasks) { task in
                        TaskCardView(task: task, assignee: store.member(task.assigneeId))
                            .onTapGesture { onOpen(task) }
                            .draggable(TaskDrag.payload(task.id)) {
                                TaskCardView(task: task, assignee: nil).frame(width: 260)
                            }
                            .dropDestination(for: String.self) { items, _ in
                                drop(items, before: task.id)
                            }
                            .contextMenu { moveMenu(for: task) }
                    }
                    TextField("Add task", text: $newTitle)
                        .textFieldStyle(.plain)
                        .padding(8)
                        .background(.background.opacity(0.6), in: RoundedRectangle(cornerRadius: 8))
                        .focused($addFocused)
                        .onSubmit(addTask)
                }
                .padding(.bottom, 8)
            }
        }
        .padding(10)
        .frame(width: 280)
        .frame(maxHeight: .infinity, alignment: .top)
        .background(
            RoundedRectangle(cornerRadius: 12)
                .fill(isTargeted ? Color.accentColor.opacity(0.12) : Color.secondary.opacity(0.08))
        )
        // Dropping on empty column space appends to the end.
        .dropDestination(for: String.self) { items, _ in
            drop(items, before: nil)
        } isTargeted: { isTargeted = $0 }
        .namePrompt("Rename column", isPresented: $showRename, initial: column.name) { name in
            Task { await store.updateColumn(column.id, name: name) }
        }
        .namePrompt("WIP limit (empty = none)", isPresented: $showWip, initial: column.wipLimit.map(String.init) ?? "",
                    placeholder: "e.g. 3") { value in
            Task { await store.updateColumn(column.id, wipLimit: .some(Int(value))) }
        }
        .confirmationDialog("Delete column \(column.name)?", isPresented: $confirmDelete) {
            Button("Delete", role: .destructive) { Task { await store.deleteColumn(column.id) } }
        } message: {
            Text("Only empty columns can be deleted.")
        }
    }

    private var header: some View {
        HStack {
            Text(column.name).font(.headline)
            Text(column.wipLimit.map { "\(tasks.count)/\($0)" } ?? "\(tasks.count)")
                .font(.caption.monospacedDigit())
                .padding(.horizontal, 6)
                .padding(.vertical, 1)
                .background(overLimit ? Color.red.opacity(0.2) : Color.secondary.opacity(0.15), in: Capsule())
                .foregroundStyle(overLimit ? .red : .secondary)
            Spacer()
            Menu {
                Button("Add task") { addFocused = true }
                Button("Rename…") { showRename = true }
                Button("WIP limit…") { showWip = true }
                Divider()
                Button("Move left") { Task { await store.shiftColumn(column.id, by: -1) } }
                    .disabled(store.columns.first?.id == column.id)
                Button("Move right") { Task { await store.shiftColumn(column.id, by: 1) } }
                    .disabled(store.columns.last?.id == column.id)
                Divider()
                Button("Delete column…", role: .destructive) { confirmDelete = true }
            } label: {
                Image(systemName: "ellipsis")
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .fixedSize()
        }
    }

    @ViewBuilder
    private func moveMenu(for task: TaskItem) -> some View {
        Menu("Move to") {
            ForEach(store.columns.filter { $0.id != task.columnId }) { target in
                Button(target.name) { Task { await store.moveTask(task.id, to: target.id) } }
            }
        }
        Button("Open") { onOpen(task) }
    }

    private func drop(_ items: [String], before beforeId: UUID?) -> Bool {
        guard let id = items.first.flatMap(TaskDrag.id(from:)) else { return false }
        Task { await store.moveTask(id, to: column.id, before: beforeId) }
        return true
    }

    private func addTask() {
        let title = newTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty else { return }
        newTitle = ""
        Task {
            await store.createTask(title: title, in: column.id)
            addFocused = true
        }
    }
}

struct TaskCardView: View {
    let task: TaskItem
    let assignee: Member?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(task.title)
                .font(.body)
                .frame(maxWidth: .infinity, alignment: .leading)
                .multilineTextAlignment(.leading)
            if !task.labels.isEmpty {
                FlowLabels(labels: task.labels)
            }
            HStack(spacing: 8) {
                if task.createdBy.isAgent { ActorBadge(actor: task.createdBy, compact: true) }
                if let due = task.dueAt {
                    Label(due.formatted(.dateTime.month(.abbreviated).day()), systemImage: "calendar")
                        .font(.caption)
                        .foregroundStyle(due < .now ? .red : .secondary)
                }
                if !task.description.isEmpty {
                    Image(systemName: "text.alignleft").font(.caption).foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
                if let assignee { Initials(name: assignee.name) }
            }
        }
        .padding(10)
        .background(.background, in: RoundedRectangle(cornerRadius: 8))
        .shadow(color: .black.opacity(0.08), radius: 1, y: 1)
        .contentShape(RoundedRectangle(cornerRadius: 8))
    }
}

struct FlowLabels: View {
    let labels: [String]

    var body: some View {
        // Labels are short; a wrapping HStack via ViewThatFits keeps cards compact.
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 4) { ForEach(labels, id: \.self) { LabelChip(text: $0) } }
            VStack(alignment: .leading, spacing: 4) { ForEach(labels, id: \.self) { LabelChip(text: $0) } }
        }
    }
}
