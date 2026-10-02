import KanbotKit
import SwiftUI

struct RootView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model
        Group {
            if let store = model.store {
                WorkspaceView(store: store)
                    .id(store.workspace.id)
            } else if !model.workspacesLoaded || !model.workspaces.isEmpty {
                // Still loading, or offline at launch.
                VStack(spacing: 12) {
                    ProgressView()
                    Button("Retry") { Task { await model.loadWorkspaces() } }
                    Button("Sign out") { Task { await model.signOut() } }.buttonStyle(.borderless)
                }
            } else {
                OnboardingView()
            }
        }
        .errorBanner($model.lastError)
    }
}

/// First run: create a workspace or join one with an invite link.
struct OnboardingView: View {
    @Environment(AppModel.self) private var model
    @State private var workspaceName = ""
    @State private var invite = ""

    var body: some View {
        VStack(spacing: 28) {
            Text("Welcome\(model.user.map { ", \($0.name)" } ?? "")").font(.largeTitle.bold())
            GroupBox("Create a workspace") {
                HStack {
                    TextField("Workspace name", text: $workspaceName)
                        .textFieldStyle(.roundedBorder)
                        .onSubmit(create)
                    Button("Create", action: create).disabled(workspaceName.isEmpty)
                }
                .padding(4)
            }
            GroupBox("Join with an invite link") {
                HStack {
                    TextField("Invite link or token", text: $invite)
                        .textFieldStyle(.roundedBorder)
                        .autocorrectionDisabled()
                        .onSubmit(join)
                    Button("Join", action: join).disabled(invite.isEmpty)
                }
                .padding(4)
            }
            Button("Sign out") { Task { await model.signOut() } }.buttonStyle(.borderless)
        }
        .frame(maxWidth: 460)
        .padding()
    }

    private func create() {
        guard !workspaceName.isEmpty else { return }
        Task { await model.createWorkspace(name: workspaceName) }
    }

    private func join() {
        guard !invite.isEmpty else { return }
        Task { await model.acceptInvite(invite) }
    }
}

/// Signed-in shell for one workspace: boards sidebar + board detail.
struct WorkspaceView: View {
    @Environment(AppModel.self) private var model
    @Bindable var store: WorkspaceStore
    @State private var selectedBoardId: UUID?
    @State private var showNewBoard = false
    @State private var showImport = false
    @State private var showNewWorkspace = false
    @State private var showJoin = false
    @State private var showSettings = false

    var body: some View {
        NavigationSplitView {
            List(selection: $selectedBoardId) {
                Section("Boards") {
                    ForEach(store.boards) { board in
                        Label(board.name, systemImage: "rectangle.split.3x1").tag(board.id)
                    }
                    if store.boards.isEmpty {
                        Text("No boards yet").foregroundStyle(.secondary)
                    }
                }
            }
            .navigationTitle(store.workspace.name)
            #if os(macOS)
            .navigationSplitViewColumnWidth(min: 200, ideal: 230)
            #endif
            .safeAreaInset(edge: .bottom) {
                HStack {
                    ConnectionIndicator(state: store.connection)
                    Spacer()
                    Button { showImport = true } label: { Label("Import board", systemImage: "square.and.arrow.down") }
                        .labelStyle(.iconOnly)
                        .buttonStyle(.borderless)
                        .help("Import a board from an exported file")
                    Button { showNewBoard = true } label: { Label("New board", systemImage: "plus") }
                        .buttonStyle(.borderless)
                }
                .padding(10)
            }
            .toolbar {
                ToolbarItem {
                    workspaceMenu
                }
            }
        } detail: {
            if store.openBoard != nil {
                BoardView(store: store)
            } else {
                ContentUnavailableView {
                    Label("No board", systemImage: "rectangle.split.3x1")
                } description: {
                    Text("Create a board to start organizing tasks.")
                } actions: {
                    Button("New board") { showNewBoard = true }
                    Button("Import board…") { showImport = true }
                }
            }
        }
        .onChange(of: selectedBoardId) { _, id in
            guard let id, id != store.openBoard?.id else { return }
            Task { await store.selectBoard(id) }
        }
        .onChange(of: store.openBoard?.id) { _, id in selectedBoardId = id }
        .onAppear { selectedBoardId = store.openBoard?.id }
        .onChange(of: store.accessRevoked) { _, revoked in
            if revoked {
                model.lastError = "You no longer have access to \(store.workspace.name)."
                Task { await model.dropActiveWorkspace() }
            }
        }
        .boardImporter(isPresented: $showImport, store: store)
        .sheet(isPresented: $showSettings) {
            WorkspaceSettingsView(store: store)
        }
        .namePrompt("New board", isPresented: $showNewBoard) { name in
            Task { await store.createBoard(name: name) }
        }
        .namePrompt("New workspace", isPresented: $showNewWorkspace) { name in
            Task { await model.createWorkspace(name: name) }
        }
        .namePrompt("Join workspace", isPresented: $showJoin, placeholder: "Invite link") { link in
            Task { await model.acceptInvite(link) }
        }
        .errorBanner($store.lastError)
    }

    private var workspaceMenu: some View {
        Menu {
            Section("Workspaces") {
                ForEach(model.workspaces) { ws in
                    Button {
                        model.select(ws)
                    } label: {
                        if ws.id == store.workspace.id { Label(ws.name, systemImage: "checkmark") } else { Text(ws.name) }
                    }
                }
            }
            Button("New workspace…") { showNewWorkspace = true }
            Button("Join with invite…") { showJoin = true }
            Divider()
            Button("Members & agents…") { showSettings = true }
            Divider()
            if let user = model.user { Text("Signed in as \(user.email)") }
            Button("Sign out") { Task { await model.signOut() } }
        } label: {
            Label("Workspace", systemImage: "person.2.circle")
        }
    }
}
