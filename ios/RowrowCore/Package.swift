// swift-tools-version: 6.2
// The app's core, apart from its views: the server's API over HTTP and server-sent events,
// the replicated app state, and the transcript fold (the server's own, run in
// JavaScriptCore). A package so `swift test` runs it on the Mac, no simulator needed.
import PackageDescription

let package = Package(
  name: "RowrowCore",
  platforms: [.iOS(.v26), .macOS(.v26)],
  products: [.library(name: "RowrowCore", targets: ["RowrowCore"])],
  targets: [
    .target(name: "RowrowCore"),
    .testTarget(name: "RowrowCoreTests", dependencies: ["RowrowCore"]),
  ]
)
