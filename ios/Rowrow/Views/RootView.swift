import RowrowCore
import SwiftUI

/// Paired: the tabs. Not yet: pairing. A sign-in link waiting to be confirmed shows over either.
struct RootView: View {
  @Environment(AppModel.self) private var model

  var body: some View {
    @Bindable var model = model
    Group {
      if let session = model.session {
        MainTabs(session: session)
          .id(session.account.id)
      } else {
        PairView()
      }
    }
    .sheet(item: $model.newAgent) { request in
      if let session = model.session {
        NewAgentView(request: request, session: session)
      }
    }
    .sheet(isPresented: Binding(get: { model.pairing != nil }, set: { if !$0 { model.pairing = nil } })) {
      ConfirmPairingView(link: model.pairing ?? "")
    }
  }
}

struct MainTabs: View {
  let session: Session
  @Environment(AppModel.self) private var model
  @Environment(Router.self) private var router

  var body: some View {
    @Bindable var router = router
    TabView(selection: $router.tab) {
      SwiftUI.Tab("Agents", systemImage: "tray.full", value: Tab.agents) {
        NavigationStack(path: $router.agents) {
          InboxView(session: session)
            .navigationDestination(for: Route.self) { RouteView(route: $0, session: session) }
        }
      }
      .badge(session.state?.needingYou.count ?? 0)

      SwiftUI.Tab("Workspaces", systemImage: "folder", value: Tab.workspaces) {
        NavigationStack(path: $router.workspaces) {
          WorkspacesView(session: session)
            .navigationDestination(for: Route.self) { RouteView(route: $0, session: session) }
        }
      }

      SwiftUI.Tab("Settings", systemImage: "gearshape", value: Tab.settings) {
        NavigationStack(path: $router.settings) {
          SettingsView(session: session)
            .navigationDestination(for: Route.self) { RouteView(route: $0, session: session) }
        }
      }
    }
    .tabViewStyle(.sidebarAdaptable)
    .tabBarMinimizeBehavior(.onScrollDown)
    .onChange(of: session.state) { _, state in
      if let state { model.push.updateBadge(state.needingYou.count) }
    }
    .onChange(of: session.snapshots) {
      // Just connected: take away notifications about agents that stopped needing you meanwhile.
      if let state = session.state { model.push.reconcile(with: state) }
    }
    .onChange(of: session.status) { _, status in
      if case .signedOut = status { model.forgetSignedOut() }
    }
  }
}

/// The screen for a route, on whichever tab pushed it.
struct RouteView: View {
  let route: Route
  let session: Session

  var body: some View {
    switch route {
    case .agent(let id): AgentScreen(agentId: id, session: session)
    case .workspace(let id): WorkspaceView(workspaceId: id, session: session)
    case .changes(let workspaceId, let agentId, let scope):
      ChangesView(workspaceId: workspaceId, agentId: agentId, initialScope: scope, session: session)
    case .diff(let target): DiffScreen(target: target, session: session)
    case .history(let workspaceId): HistoryView(workspaceId: workspaceId, session: session)
    case .commit(let workspaceId, let sha): CommitView(workspaceId: workspaceId, sha: sha, session: session)
    case .search(let workspaceId): SearchView(workspaceId: workspaceId, session: session)
    case .file(let workspaceId, let path): FileView(workspaceId: workspaceId, path: path, session: session)
    case .devices: DevicesView(session: session)
    case .quickReplies: QuickRepliesView(session: session)
    case .servers: ServersView()
    }
  }
}

/// Where the connection stands, when it isn't simply online.
struct ConnectionNote: View {
  let session: Session

  var body: some View {
    switch session.status {
    case .online:
      EmptyView()
    case .connecting:
      Label(session.stale ? "Connecting… showing what rowrow said last time" : "Connecting…", systemImage: "antenna.radiowaves.left.and.right")
        .font(.footnote)
        .foregroundStyle(.secondary)
    case .offline(let message, let retryAt):
      VStack(alignment: .leading, spacing: 6) {
        Label("Can't reach \(session.account.name)", systemImage: "wifi.exclamationmark")
          .font(.subheadline.weight(.semibold))
        Text(message).font(.footnote).foregroundStyle(.secondary)
        TimelineView(.periodic(from: .now, by: 1)) { context in
          let seconds = max(0, Int(retryAt.timeIntervalSince(context.date).rounded()))
          Button(seconds > 0 ? "Try again (\(seconds)s)" : "Trying…") { session.retryNow() }
            .font(.footnote)
            .buttonStyle(.bordered)
        }
      }
    case .signedOut(let message):
      Label(message, systemImage: "person.crop.circle.badge.xmark").font(.footnote)
    }
  }
}
