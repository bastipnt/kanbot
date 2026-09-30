import SwiftUI

@main
struct KanbotApp: App {
    @State private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            Group {
                switch model.phase {
                case .launching:
                    ProgressView()
                        .task { await model.launch() }
                case .signedOut:
                    LoginView()
                case .signedIn:
                    RootView()
                }
            }
            .environment(model)
            #if os(macOS)
            .frame(minWidth: 900, minHeight: 560)
            #endif
        }
        #if os(macOS)
        .windowToolbarStyle(.unified)
        #endif
    }
}
