import RowrowCore
import SwiftUI

/// rowrow for iPhone and iPad (docs/ios.md): the agents running on your computer, sorted by
/// who needs you, one tap from a notification to an answer.
@main
struct RowrowApp: App {
  @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate
  @Environment(\.scenePhase) private var scenePhase
  @State private var model = AppModel.shared

  var body: some Scene {
    WindowGroup {
      RootView()
        .environment(model)
        .environment(model.router)
        .onOpenURL { model.open($0) }
        .onChange(of: scenePhase, initial: true) { _, phase in model.scenePhase(phase) }
    }
  }
}
