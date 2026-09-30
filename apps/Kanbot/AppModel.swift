import Foundation
import KanbotKit
import Observation

/// App-wide state: which server, who is signed in, the workspace list and the active workspace store.
@Observable
final class AppModel {
    enum Phase { case launching, signedOut, signedIn }

    var phase: Phase = .launching
    var serverURLString: String = UserDefaults.standard.string(forKey: "serverURL") ?? "http://localhost:8787"
    private(set) var api: APIClient?
    private(set) var user: User?
    private(set) var workspaces: [Workspace] = []
    private(set) var store: WorkspaceStore?
    var lastError: String?
    var isBusy = false

    private let sessionStore: SessionStore

    init(sessionStore: SessionStore = KeychainSessionStore()) {
        self.sessionStore = sessionStore
    }

    var serverURL: URL? {
        let trimmed = serverURLString.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: trimmed), let scheme = url.scheme, ["http", "https"].contains(scheme), url.host() != nil else {
            return nil
        }
        return url
    }

    // MARK: Session

    func launch() async {
        guard let saved = sessionStore.load() else { phase = .signedOut; return }
        serverURLString = saved.serverURL.absoluteString
        let api = makeClient(saved.serverURL)
        do {
            user = try await api.me()
            self.api = api
            phase = .signedIn
            await loadWorkspaces()
        } catch let error as APIError where error.status == 401 {
            phase = .signedOut
        } catch {
            // Offline at launch: keep the session and let the user retry.
            self.api = api
            lastError = error.localizedDescription
            phase = .signedIn
        }
    }

    func signIn(email: String, password: String, name: String?, inviteToken: String? = nil, register: Bool) async {
        guard let url = serverURL else { lastError = "Enter a valid server URL (http:// or https://)"; return }
        UserDefaults.standard.set(url.absoluteString, forKey: "serverURL")
        let api = makeClient(url)
        isBusy = true
        defer { isBusy = false }
        do {
            if register, let name {
                user = try await api.register(email: email, password: password, name: name, inviteToken: inviteToken)
            } else {
                user = try await api.login(email: email, password: password)
            }
            self.api = api
            lastError = nil
            phase = .signedIn
            await loadWorkspaces()
        } catch {
            lastError = error.localizedDescription
        }
    }

    func signOut() async {
        await api?.signOut()
    }

    private func handleSignedOut() {
        store?.stop()
        store = nil
        workspaces = []
        user = nil
        api = nil
        phase = .signedOut
    }

    private func makeClient(_ url: URL) -> APIClient {
        let client = APIClient(serverURL: url, store: sessionStore)
        Task {
            await client.setOnSignedOut { [weak self] in
                Task { @MainActor in self?.handleSignedOut() }
            }
        }
        return client
    }

    // MARK: Workspaces

    func loadWorkspaces() async {
        guard let api else { return }
        do {
            if user == nil { user = try await api.me() }
            workspaces = try await api.workspaces()
            lastError = nil
            let lastId = UserDefaults.standard.string(forKey: "workspaceId").flatMap(UUID.init(uuidString:))
            if let current = store?.workspace, workspaces.contains(where: { $0.id == current.id }) { return }
            if let ws = workspaces.first(where: { $0.id == lastId }) ?? workspaces.first {
                select(ws)
            } else {
                store?.stop()
                store = nil
            }
        } catch {
            lastError = error.localizedDescription
        }
    }

    func select(_ workspace: Workspace) {
        guard let api, let user, store?.workspace.id != workspace.id else { return }
        store?.stop()
        let newStore = WorkspaceStore(workspace: workspace, api: api, currentUserId: user.id)
        store = newStore
        UserDefaults.standard.set(workspace.id.uuidString, forKey: "workspaceId")
        newStore.start()
    }

    func createWorkspace(name: String) async {
        guard let api else { return }
        do {
            let ws = try await api.createWorkspace(name: name)
            workspaces.append(ws)
            select(ws)
        } catch { lastError = error.localizedDescription }
    }

    /// Accepts either the full invite URL or the bare token.
    func acceptInvite(_ input: String) async {
        guard let api else { return }
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        let token = URL(string: trimmed)?.pathComponents.last.flatMap { $0 == "/" ? nil : $0 } ?? trimmed
        do {
            let ws = try await api.acceptInvite(token: token)
            if !workspaces.contains(where: { $0.id == ws.id }) { workspaces.append(ws) }
            select(ws)
        } catch { lastError = error.localizedDescription }
    }

    /// Called after the current user lost access to the active workspace.
    func dropActiveWorkspace() async {
        store?.stop()
        store = nil
        UserDefaults.standard.removeObject(forKey: "workspaceId")
        await loadWorkspaces()
    }
}
