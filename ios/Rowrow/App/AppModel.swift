import Foundation
import Observation
import RowrowCore
import SwiftUI
import UserNotifications

/// Where the app is: which tab, and what's pushed on each tab's stack.
enum Tab: Hashable {
  case agents, workspaces, settings
}

enum Route: Hashable {
  case agent(String)
  case workspace(String)
  case changes(workspaceId: String, agentId: String?, scope: DiffScope)
  case diff(DiffTarget)
  case history(workspaceId: String)
  case commit(workspaceId: String, sha: String)
  case search(workspaceId: String)
  case file(workspaceId: String, path: String)
  case devices
  case quickReplies
  case servers
}

/// One file's diff: in a scope of a workspace, or in a commit.
struct DiffTarget: Hashable {
  let workspaceId: String
  let path: String
  let scope: DiffScope?
  let agentId: String?
  let sha: String?
}

@MainActor
@Observable
final class Router {
  var tab: Tab = .agents
  var agents: [Route] = []
  var workspaces: [Route] = []
  var settings: [Route] = []

  /// Show an agent from anywhere (a notification, a link): the Agents tab, with it on top.
  func open(agent id: String) {
    tab = .agents
    agents = [.agent(id)]
  }

  /// From one agent straight to the next that needs you: back still leads to the list.
  func replace(agent id: String) {
    if tab == .agents, let last = agents.indices.last {
      agents[last] = .agent(id)
    } else if tab == .workspaces, let last = workspaces.indices.last {
      workspaces[last] = .agent(id)
    } else {
      open(agent: id)
    }
  }

  func push(_ route: Route) {
    switch tab {
    case .agents: agents.append(route)
    case .workspaces: workspaces.append(route)
    case .settings: settings.append(route)
    }
  }

  /// Back to what's under the top screen.
  func pop() {
    switch tab {
    case .agents: _ = agents.popLast()
    case .workspaces: _ = workspaces.popLast()
    case .settings: _ = settings.popLast()
    }
  }
}

/// What starts a new agent: the place it's started from, and what you already wrote.
struct NewAgentRequest: Identifiable {
  let id = UUID()
  let context: Kit.SetupContext
  var text = ""
}

/// The app: the servers it's paired with, the one it shows (live), and everything that isn't
/// a single screen's (navigation, drafts, review comments, notifications).
@MainActor
@Observable
final class AppModel {
  static let shared = AppModel()

  let accounts = Accounts()
  let router = Router()
  let push = PushManager()
  let reviews = ReviewStore()
  private(set) var session: Session?
  /// A sign-in link waiting for you to confirm it (from a link or a scan).
  var pairing: String?
  var newAgent: NewAgentRequest?
  /// What you're writing to each agent. In memory only: a draft may hold a secret (roamgate #70).
  var drafts: [String: String] = [:]
  /// Files waiting to go with each agent's next message (and a new agent's first), D-024.
  var attachments: [String: [PendingAttachment]] = [:]
  private(set) var foreground = false

  @ObservationIgnored private var transcripts: [String: TranscriptStore] = [:]
  @ObservationIgnored private var transcriptUse: [String] = []

  private init() {
    if let account = accounts.active { activate(account) }
  }

  static var cacheDirectory: URL {
    URL.applicationSupportDirectory.appending(path: "rowrow", directoryHint: .isDirectory)
  }

  // ─── Servers ───────────────────────────────────────────────────────────────

  /// Show this server: connect to it, and let go of the one before.
  func activate(_ account: Account) {
    guard session?.account.id != account.id, let token = accounts.token(for: account) else { return }
    if let old = session {
      Task { await old.stop() }
    }
    for store in transcripts.values { Task { await store.close() } }
    transcripts = [:]
    transcriptUse = []
    router.agents = []
    router.workspaces = []
    router.settings = []
    accounts.activeId = account.id
    let session = Session(account: account, token: token, cache: Self.cacheDirectory)
    session.onAttention = { [weak self] agent, before in self?.attentionChanged(agent, from: before) }
    self.session = session
    if foreground { session.start() }
    push.register(with: session)
  }

  /// Pair with a server from a sign-in link; show it.
  func pair(link: String) async throws {
    let pairing = try await APIClient.pair(link: link, deviceName: Self.deviceName)
    let info = try? await APIClient(baseURL: pairing.baseURL, token: pairing.token).info()
    let account = accounts.add(pairing, serverName: info?.name ?? pairing.baseURL.host() ?? "rowrow")
    activate(account)
  }

  static var deviceName: String {
    #if targetEnvironment(simulator)
      "rowrow on the iOS Simulator"
    #else
      UIDevice.current.userInterfaceIdiom == .pad ? "rowrow on iPad" : "rowrow on iPhone"
    #endif
  }

  /// Sign this device out of the server it shows (revoking its credential there).
  func signOut() async {
    guard let session else { return }
    let account = session.account
    if let me = try? await session.api.whoami() { try? await session.api.revoke(deviceId: me.id) }
    await session.stop()
    session.forget()
    ImageCache.shared.clear()
    self.session = nil
    accounts.remove(account.id)
    if let next = accounts.active { activate(next) }
  }

  /// The server said this device isn't signed in: forget the credential, keep nothing stale.
  func forgetSignedOut() {
    guard let session else { return }
    session.forget()
    ImageCache.shared.clear()
    let id = session.account.id
    self.session = nil
    accounts.remove(id)
    if let next = accounts.active { activate(next) }
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  func scenePhase(_ phase: ScenePhase) {
    switch phase {
    case .active:
      foreground = true
      session?.start()
      session?.setFocused(true)
      push.refresh()
    case .inactive:
      session?.setFocused(false)
    case .background:
      foreground = false
      if let session {
        let task = UIApplication.shared.beginBackgroundTask(withName: "rowrow.presence")
        Task {
          await session.stop()
          UIApplication.shared.endBackgroundTask(task)
        }
      }
    @unknown default:
      break
    }
  }

  /// `rowrow://pair?link=…` (a sign-in link, to confirm) or `rowrow://agent/<id>`.
  func open(_ url: URL) {
    guard url.scheme == "rowrow" else { return }
    let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
    switch url.host() {
    case "pair":
      pairing = components?.queryItems?.first { $0.name == "link" }?.value
    case "agent":
      let id = url.pathComponents.dropFirst().first
      if let id { router.open(agent: id) }
    default:
      break
    }
  }

  // ─── Transcripts ───────────────────────────────────────────────────────────

  /// An agent's transcript store, kept for the few agents you looked at last.
  func transcript(for agent: AgentState) -> TranscriptStore? {
    guard let session else { return nil }
    transcriptUse.removeAll { $0 == agent.id }
    transcriptUse.append(agent.id)
    if let store = transcripts[agent.id] { return store }
    let store = TranscriptStore(agentId: agent.id, runtime: agent.summary.runtime, session: session)
    transcripts[agent.id] = store
    while transcriptUse.count > 6, let oldest = transcriptUse.first {
      transcriptUse.removeFirst()
      if let old = transcripts.removeValue(forKey: oldest) { Task { await old.close() } }
    }
    return store
  }

  // ─── Attention ─────────────────────────────────────────────────────────────

  private func attentionChanged(_ agent: AgentState, from before: Attention) {
    push.updateBadge(session?.state?.needingYou.count ?? 0)
    if !agent.attention.needsYou {
      if before.needsYou { Task { await push.clearDelivered(agentIds: [agent.id]) } }
      return
    }
    // In the app, a banner of our own: the server doesn't push to a device you're using.
    guard foreground, let session, !session.looking(at: agent.id) else { return }
    push.banner(for: agent, in: session)
  }
}
