// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "KanbotKit",
    platforms: [.macOS(.v15), .iOS(.v18)],
    products: [
        .library(name: "KanbotKit", targets: ["KanbotKit"]),
    ],
    targets: [
        .target(name: "KanbotKit"),
        .testTarget(name: "KanbotKitTests", dependencies: ["KanbotKit"]),
    ]
)
