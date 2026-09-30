import KanbotKit
import SwiftUI
import UniformTypeIdentifiers
#if os(macOS)
import AppKit
#else
import UIKit
#endif

enum Clipboard {
    static func copy(_ string: String) {
        #if os(macOS)
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(string, forType: .string)
        #else
        UIPasteboard.general.string = string
        #endif
    }
}

/// Shows who did something; agents get a distinct sparkle badge so humans can tell AI changes apart.
struct ActorBadge: View {
    let actor: Actor
    var compact = false

    var body: some View {
        Label {
            if !compact { Text(actor.name) }
        } icon: {
            Image(systemName: actor.isAgent ? "sparkles" : "person.fill")
                .foregroundStyle(actor.isAgent ? Color.purple : Color.secondary)
        }
        .font(.caption)
        .help(actor.isAgent ? "AI agent: \(actor.name)" : actor.name)
    }
}

struct LabelChip: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.caption2.weight(.medium))
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(color.opacity(0.18), in: Capsule())
            .foregroundStyle(color)
    }

    /// Stable colour per label name.
    private var color: Color {
        let palette: [Color] = [.blue, .green, .orange, .pink, .teal, .indigo, .red, .brown]
        let hash = text.lowercased().unicodeScalars.reduce(0) { ($0 &* 31 &+ Int($1.value)) & 0xFFFF }
        return palette[hash % palette.count]
    }
}

struct Initials: View {
    let name: String

    var body: some View {
        Text(initials)
            .font(.caption2.bold())
            .frame(width: 22, height: 22)
            .background(Color.accentColor.opacity(0.2), in: Circle())
            .help(name)
    }

    private var initials: String {
        name.split(separator: " ").prefix(2).compactMap(\.first).map(String.init).joined().uppercased()
    }
}

struct ConnectionIndicator: View {
    let state: ConnectionState

    var body: some View {
        HStack(spacing: 5) {
            Circle().fill(color).frame(width: 7, height: 7)
            Text(text)
        }
        .font(.caption)
        .foregroundStyle(.secondary)
    }

    private var text: String {
        switch state {
        case .live: "Live"
        case .connecting: "Connecting…"
        case .offline: "Offline"
        }
    }

    private var color: Color {
        switch state {
        case .live: .green
        case .connecting: .orange
        case .offline: .red
        }
    }
}

/// Dismissable error banner bound to an optional message.
struct ErrorBanner: ViewModifier {
    @Binding var message: String?

    func body(content: Content) -> some View {
        content.safeAreaInset(edge: .bottom) {
            if let message {
                HStack {
                    Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                    Text(message).font(.callout).lineLimit(3)
                    Spacer()
                    Button("Dismiss") { self.message = nil }.buttonStyle(.borderless)
                }
                .padding(10)
                .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 10))
                .padding()
                .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .animation(.default, value: message)
    }
}

extension View {
    func errorBanner(_ message: Binding<String?>) -> some View {
        modifier(ErrorBanner(message: message))
    }
}

/// Simple one-field prompt used for "New board", "Rename", etc.
struct NamePrompt: ViewModifier {
    let title: String
    @Binding var isPresented: Bool
    var initial = ""
    var placeholder = "Name"
    let onSubmit: (String) -> Void
    @State private var text = ""

    func body(content: Content) -> some View {
        content.alert(title, isPresented: $isPresented) {
            TextField(placeholder, text: $text)
            Button("Cancel", role: .cancel) {}
            Button("OK") {
                let value = text.trimmingCharacters(in: .whitespacesAndNewlines)
                if !value.isEmpty { onSubmit(value) }
            }
        }
        .onChange(of: isPresented) { _, shown in if shown { text = initial } }
    }
}

extension View {
    func namePrompt(_ title: String, isPresented: Binding<Bool>, initial: String = "", placeholder: String = "Name",
                    onSubmit: @escaping (String) -> Void) -> some View {
        modifier(NamePrompt(title: title, isPresented: isPresented, initial: initial, placeholder: placeholder, onSubmit: onSubmit))
    }
}

/// A board export (`BoardExport` JSON) handed to `.fileExporter`.
struct BoardFile: FileDocument {
    static let readableContentTypes: [UTType] = [.json]
    var data: Data

    init(data: Data) { self.data = data }
    init(configuration: ReadConfiguration) throws { data = configuration.file.regularFileContents ?? Data() }

    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper {
        FileWrapper(regularFileWithContents: data)
    }
}

extension View {
    /// Picks a board export file and imports it as a new board in the store's workspace.
    func boardImporter(isPresented: Binding<Bool>, store: WorkspaceStore) -> some View {
        fileImporter(isPresented: isPresented, allowedContentTypes: [.json]) { result in
            do {
                let url = try result.get()
                let scoped = url.startAccessingSecurityScopedResource()
                defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                let data = try Data(contentsOf: url)
                Task { await store.importBoard(file: data) }
            } catch {
                store.lastError = error.localizedDescription
            }
        }
    }
}
