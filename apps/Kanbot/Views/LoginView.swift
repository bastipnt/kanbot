import SwiftUI

struct LoginView: View {
    @Environment(AppModel.self) private var model
    @State private var isRegistering = false
    @State private var name = ""
    @State private var email = ""
    @State private var password = ""
    @State private var inviteCode = ""

    var body: some View {
        @Bindable var model = model
        VStack(spacing: 24) {
            VStack(spacing: 6) {
                Image(systemName: "rectangle.split.3x1.fill")
                    .font(.system(size: 44))
                    .foregroundStyle(.tint)
                Text("Kanbot").font(.largeTitle.bold())
                Text("Kanban boards for humans and AI agents").foregroundStyle(.secondary)
            }

            Form {
                Section {
                    TextField("Server", text: $model.serverURLString)
                        .textContentType(.URL)
                        #if os(iOS)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        #endif
                        .autocorrectionDisabled()
                } footer: {
                    Text("Your self-hosted Kanbot server.")
                }
                Section {
                    if isRegistering {
                        TextField("Name", text: $name).textContentType(.name)
                    }
                    TextField("Email", text: $email)
                        .textContentType(.emailAddress)
                        #if os(iOS)
                        .keyboardType(.emailAddress)
                        .textInputAutocapitalization(.never)
                        #endif
                        .autocorrectionDisabled()
                    SecureField("Password", text: $password)
                        .textContentType(isRegistering ? .newPassword : .password)
                        .onSubmit(submit)
                }
                if isRegistering {
                    Section {
                        TextField("Invite code (optional)", text: $inviteCode)
                            #if os(iOS)
                            .textInputAutocapitalization(.never)
                            #endif
                            .autocorrectionDisabled()
                    } footer: {
                        Text("Needed if the server only allows invited users.")
                    }
                }
            }
            .formStyle(.grouped)
            .frame(maxWidth: 420, maxHeight: isRegistering ? 430 : 280)
            .scrollDisabled(true)

            if let error = model.lastError {
                Text(error).foregroundStyle(.red).font(.callout).multilineTextAlignment(.center)
            }

            VStack(spacing: 12) {
                Button(action: submit) {
                    Group {
                        if model.isBusy { ProgressView().controlSize(.small) }
                        else { Text(isRegistering ? "Create account" : "Sign in") }
                    }
                    .frame(maxWidth: 260)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .keyboardShortcut(.defaultAction)
                .disabled(!canSubmit || model.isBusy)

                Button(isRegistering ? "I already have an account" : "Create an account") {
                    isRegistering.toggle()
                    model.lastError = nil
                }
                .buttonStyle(.borderless)
            }
        }
        .padding()
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var canSubmit: Bool {
        !email.isEmpty && password.count >= 8 && (!isRegistering || !name.trimmingCharacters(in: .whitespaces).isEmpty)
    }

    private func submit() {
        guard canSubmit else { return }
        let code = inviteCode.trimmingCharacters(in: .whitespacesAndNewlines)
        Task {
            await model.signIn(email: email, password: password, name: isRegistering ? name : nil,
                               inviteToken: isRegistering && !code.isEmpty ? code : nil, register: isRegistering)
        }
    }
}
