import KanbotKit
import SwiftUI

struct TaskDetailView: View {
    @Environment(\.dismiss) private var dismiss
    @Bindable var store: WorkspaceStore
    let taskId: UUID

    @State private var title = ""
    @State private var details = ""
    @State private var labelsText = ""
    @State private var hasDue = false
    @State private var due = Date.now
    @State private var newComment = ""
    @State private var loaded = false
    @State private var confirmDelete = false
    @State private var editingDescription = false

    private var task: TaskItem? { store.tasksById[taskId] }

    var body: some View {
        NavigationStack {
            Group {
                if let task {
                    form(task)
                } else {
                    ContentUnavailableView("Task was deleted", systemImage: "trash")
                }
            }
            .navigationTitle("Task")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        #if os(macOS)
        .frame(minWidth: 520, minHeight: 620)
        #endif
        // Saves on any dismissal (Done, swipe down, Esc).
        .onDisappear { Task { await save() } }
        .task {
            await store.loadTaskDetail(taskId)
            if let task { resetDraft(task) }
            loaded = true
        }
        // Show live edits (e.g. from an agent) unless the user is editing the description.
        .onChange(of: task?.description) { _, description in
            if let description, !editingDescription { details = description }
        }
    }

    @ViewBuilder
    private func form(_ task: TaskItem) -> some View {
        Form {
            Section {
                TextField("Title", text: $title, axis: .vertical).font(.title3)
                Picker("Status", selection: Binding(
                    get: { task.columnId },
                    set: { col in Task { await store.moveTask(taskId, to: col) } }
                )) {
                    ForEach(store.columns) { Text($0.name).tag($0.id) }
                }
                Picker("Assignee", selection: Binding(
                    get: { task.assigneeId },
                    set: { id in Task { await store.updateTask(taskId, ["assigneeId": JSONValue(id)]) } }
                )) {
                    Text("Unassigned").tag(UUID?.none)
                    ForEach(store.members) { Text($0.name).tag(Optional($0.userId)) }
                }
                TextField("Labels (comma separated)", text: $labelsText)
                Toggle("Due date", isOn: $hasDue)
                if hasDue {
                    DatePicker("Due", selection: $due, displayedComponents: [.date, .hourAndMinute])
                }
            }

            Section {
                if editingDescription {
                    TextEditor(text: $details)
                        .frame(minHeight: 160)
                        .font(.system(.body, design: .monospaced))
                } else if details.isEmpty {
                    Button("Add a description…") { editingDescription = true }
                        .buttonStyle(.borderless)
                        .foregroundStyle(.secondary)
                } else {
                    MarkdownView(details) { line in
                        details = Markdown.toggleTask(in: details, line: line)
                        Task { await save() }
                    }
                }
            } header: {
                HStack {
                    Text("Description")
                    Spacer()
                    if editingDescription || !details.isEmpty {
                        Button {
                            if editingDescription { Task { await save() } }
                            editingDescription.toggle()
                        } label: {
                            Label(editingDescription ? "Preview" : "Edit",
                                  systemImage: editingDescription ? "eye" : "pencil")
                                .font(.caption)
                        }
                        .buttonStyle(.borderless)
                    }
                }
            } footer: {
                if editingDescription {
                    Text(verbatim: "Supports Markdown: **bold**, *italic*, `code`, ```code blocks```, # headings, - lists, - [ ] tasks, > quotes, links.")
                        .font(.caption)
                }
            }

            Section("Comments") {
                let comments = store.commentsByTask[taskId] ?? []
                if comments.isEmpty && loaded {
                    Text("No comments yet").foregroundStyle(.secondary)
                }
                ForEach(comments) { comment in
                    VStack(alignment: .leading, spacing: 4) {
                        HStack {
                            ActorBadge(actor: comment.actor)
                            Spacer()
                            Text(comment.createdAt, format: .relative(presentation: .named))
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        MarkdownView(comment.body)
                    }
                    .padding(.vertical, 2)
                }
                HStack(alignment: .bottom) {
                    TextField("Add a comment", text: $newComment, axis: .vertical)
                        .lineLimit(1...5)
                    Button("Send") { sendComment() }
                        .disabled(newComment.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }

            Section {
                LabeledContent("Created by") { ActorBadge(actor: task.createdBy) }
                LabeledContent("Created", value: task.createdAt.formatted(date: .abbreviated, time: .shortened))
                LabeledContent("Updated", value: task.updatedAt.formatted(date: .abbreviated, time: .shortened))
                Button("Delete task", role: .destructive) { confirmDelete = true }
            }
        }
        .formStyle(.grouped)
        .confirmationDialog("Delete this task?", isPresented: $confirmDelete) {
            Button("Delete", role: .destructive) {
                Task { await store.deleteTask(taskId) }
                dismiss()
            }
        }
    }

    private func resetDraft(_ task: TaskItem) {
        title = task.title
        details = task.description
        labelsText = task.labels.joined(separator: ", ")
        hasDue = task.dueAt != nil
        due = task.dueAt ?? Calendar.current.date(byAdding: .day, value: 7, to: .now)!
    }

    private var parsedLabels: [String] {
        labelsText.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    }

    /// Sends only the fields that changed.
    private func save() async {
        guard loaded, let task else { return }
        var patch: [String: JSONValue] = [:]
        let trimmedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmedTitle.isEmpty && trimmedTitle != task.title { patch["title"] = .string(trimmedTitle) }
        if details != task.description { patch["description"] = .string(details) }
        if parsedLabels != task.labels { patch["labels"] = JSONValue(parsedLabels) }
        let newDue: Date? = hasDue ? due : nil
        if newDue != task.dueAt { patch["dueAt"] = JSONValue(newDue) }
        guard !patch.isEmpty else { return }
        await store.updateTask(taskId, patch)
    }

    private func sendComment() {
        let body = newComment.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !body.isEmpty else { return }
        newComment = ""
        Task { await store.addComment(to: taskId, body: body) }
    }
}
