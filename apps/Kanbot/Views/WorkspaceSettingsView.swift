import KanbotKit
import SwiftUI

/// Members, invites and AI agent API keys for the active workspace.
struct WorkspaceSettingsView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(AppModel.self) private var model
    @Bindable var store: WorkspaceStore

    @State private var inviteRole: Role = .member
    @State private var inviteURL: String?
    @State private var apiKeys: [ApiKey] = []
    @State private var newKeyName = ""
    @State private var createdKey: CreatedApiKey?
    @State private var error: String?
    @State private var confirmLeave = false

    private var isAdmin: Bool { store.myRole.canAdminister }

    var body: some View {
        NavigationStack {
            Form {
                membersSection
                if isAdmin {
                    inviteSection
                    agentsSection
                }
                if store.myRole != .owner {
                    Section {
                        Button("Leave workspace", role: .destructive) { confirmLeave = true }
                    }
                }
            }
            .formStyle(.grouped)
            .navigationTitle(store.workspace.name)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
            .errorBanner($error)
        }
        #if os(macOS)
        .frame(minWidth: 560, minHeight: 600)
        #endif
        .task {
            await store.refreshMembers()
            if isAdmin { await loadKeys() }
        }
        .confirmationDialog("Leave \(store.workspace.name)?", isPresented: $confirmLeave) {
            Button("Leave", role: .destructive) {
                Task {
                    do {
                        try await store.api.removeMember(workspaceId: store.workspace.id, userId: store.currentUserId)
                        dismiss()
                        await model.dropActiveWorkspace()
                    } catch { self.error = error.localizedDescription }
                }
            }
        }
    }

    // MARK: Members

    private var membersSection: some View {
        Section("Members") {
            ForEach(store.members) { member in
                HStack {
                    Initials(name: member.name)
                    VStack(alignment: .leading) {
                        Text(member.name)
                        Text(member.email).font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Text(member.role.rawValue.capitalized).font(.caption).foregroundStyle(.secondary)
                    if canRemove(member) {
                        Button(role: .destructive) {
                            Task { await remove(member) }
                        } label: { Image(systemName: "person.badge.minus") }
                        .buttonStyle(.borderless)
                        .help("Remove from workspace")
                    }
                }
            }
        }
    }

    private func canRemove(_ member: Member) -> Bool {
        guard member.userId != store.currentUserId, member.role != .owner else { return false }
        return store.myRole == .owner || (store.myRole == .admin && member.role == .member)
    }

    private func remove(_ member: Member) async {
        do {
            try await store.api.removeMember(workspaceId: store.workspace.id, userId: member.userId)
            await store.refreshMembers()
        } catch { self.error = error.localizedDescription }
    }

    // MARK: Invites

    private var inviteSection: some View {
        Section {
            Picker("Role", selection: $inviteRole) {
                Text("Member").tag(Role.member)
                if store.myRole == .owner { Text("Admin").tag(Role.admin) }
            }
            Button("Create invite link") {
                Task {
                    do {
                        inviteURL = try await store.api.createInvite(workspaceId: store.workspace.id, role: inviteRole).url
                    } catch { self.error = error.localizedDescription }
                }
            }
            if let inviteURL {
                CopyableText(text: inviteURL)
            }
        } header: {
            Text("Invite people")
        } footer: {
            Text("Single use, valid for 7 days. They paste it under “Join with invite…”.")
        }
    }

    // MARK: Agents

    private var agentsSection: some View {
        Section {
            ForEach(apiKeys) { key in
                HStack {
                    Image(systemName: "sparkles").foregroundStyle(.purple)
                    VStack(alignment: .leading) {
                        Text(key.name)
                        Text("\(key.prefix)… · " + (key.lastUsedAt.map { "used \($0.formatted(.relative(presentation: .named)))" } ?? "never used"))
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Button("Revoke", role: .destructive) {
                        Task {
                            do {
                                try await store.api.deleteApiKey(id: key.id)
                                await loadKeys()
                            } catch { self.error = error.localizedDescription }
                        }
                    }
                    .buttonStyle(.borderless)
                }
            }
            HStack {
                TextField("Agent name, e.g. Claude triage", text: $newKeyName)
                    .onSubmit(createKey)
                Button("Create key", action: createKey)
                    .disabled(newKeyName.trimmingCharacters(in: .whitespaces).isEmpty)
            }
            if let createdKey {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Copy this now — the key is shown only once.").font(.callout.bold())
                    CopyableText(text: createdKey.secret)
                    Text("Connect Claude Code:").font(.callout)
                    CopyableText(text: mcpCommand(secret: createdKey.secret))
                }
                .padding(.vertical, 4)
            }
        } header: {
            Text("AI agents")
        } footer: {
            Text("Agents connect over MCP and can read the board, create, update and move tasks, assign and comment. They can't delete anything. Their changes are marked with ✦ in the activity feed.")
        }
    }

    private func mcpCommand(secret: String) -> String {
        let url = store.api.serverURL.appending(path: "mcp").absoluteString
        return "claude mcp add --transport http kanbot \(url) --header \"Authorization: Bearer \(secret)\""
    }

    private func loadKeys() async {
        do { apiKeys = try await store.api.apiKeys(workspaceId: store.workspace.id) }
        catch { self.error = error.localizedDescription }
    }

    private func createKey() {
        let name = newKeyName.trimmingCharacters(in: .whitespaces)
        guard !name.isEmpty else { return }
        Task {
            do {
                createdKey = try await store.api.createApiKey(workspaceId: store.workspace.id, name: name)
                newKeyName = ""
                await loadKeys()
            } catch { self.error = error.localizedDescription }
        }
    }
}

struct CopyableText: View {
    let text: String
    @State private var copied = false

    var body: some View {
        HStack(alignment: .top) {
            Text(text)
                .font(.caption.monospaced())
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
            Button(copied ? "Copied" : "Copy") {
                Clipboard.copy(text)
                copied = true
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
        }
    }
}
