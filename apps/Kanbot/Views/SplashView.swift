import SwiftUI

/// Shown while the app restores its session. Matches the iOS launch screen
/// (same background and mark at the same size/position) so the hand-off is seamless.
struct SplashView: View {
    var body: some View {
        ZStack {
            Color("LaunchBackground").ignoresSafeArea()
            Image("BrandMark")
                .accessibilityHidden(true)
                .overlay(alignment: .bottom) {
                    VStack(spacing: 16) {
                        Text("Kanbot")
                            .font(.title.bold())
                            .foregroundStyle(.white)
                        ProgressView()
                            .controlSize(.small)
                            .tint(.white)
                    }
                    .fixedSize()
                    // Hang the title below the mark without moving the mark off-center.
                    .alignmentGuide(.bottom) { $0[.top] - 28 }
                }
        }
    }
}

#Preview {
    SplashView()
}
