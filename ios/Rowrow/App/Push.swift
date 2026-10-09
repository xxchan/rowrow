import Foundation
import Observation
import RowrowCore
import UIKit
import UserNotifications

/// Notifications (docs/ios.md, "Notifications"): the server pushes through APNs with your own
/// key (D-028) when an agent finishes or needs you and you aren't looking; in the app, a banner
/// of our own does the same. Each notification can be answered where it shows (Reply, Mark as
/// Seen), without opening the app. Coach's tasks notify through the same pushes (D-050).
@MainActor
@Observable
final class PushManager: NSObject {
  static let category = "AGENT"
  static let replyAction = "reply"
  static let seenAction = "seen"

  private(set) var authorization: UNAuthorizationStatus = .notDetermined
  /// The APNs token iOS gave this install, hex.
  private(set) var deviceToken: String?
  /// Why registering didn't work, when it didn't.
  private(set) var problem: String?
  /// The server has this device's token.
  private(set) var registered = false

  @ObservationIgnored private weak var session: Session?
  @ObservationIgnored private let center = UNUserNotificationCenter.current()

  override init() {
    super.init()
    let reply = UNTextInputNotificationAction(
      identifier: Self.replyAction, title: "Reply", options: [], textInputButtonTitle: "Send",
      textInputPlaceholder: "Message the agent")
    let seen = UNNotificationAction(identifier: Self.seenAction, title: "Mark as Seen", options: [])
    center.setNotificationCategories([
      UNNotificationCategory(identifier: Self.category, actions: [reply, seen], intentIdentifiers: [], options: [])
    ])
  }

  /// Whether notifications are allowed; register with APNs when they are.
  func refresh() {
    Task {
      authorization = await center.notificationSettings().authorizationStatus
      if authorization == .authorized || authorization == .provisional || authorization == .ephemeral {
        UIApplication.shared.registerForRemoteNotifications()
      }
    }
  }

  /// Ask for permission (from Settings, or after pairing).
  func request() async {
    do {
      _ = try await center.requestAuthorization(options: [.alert, .badge, .sound])
    } catch {
      problem = error.localizedDescription
    }
    refresh()
  }

  /// The server the app shows: give it this device's token once there is one.
  func register(with session: Session) {
    self.session = session
    registered = false
    Task { await sendToken() }
  }

  func received(token: Data) {
    deviceToken = token.map { String(format: "%02x", $0) }.joined()
    problem = nil
    Task { await sendToken() }
  }

  func failed(_ error: any Error) {
    problem = error.localizedDescription
  }

  private func sendToken() async {
    guard let session, let deviceToken, !registered else { return }
    do {
      // What notifications say is sealed with this key, so Apple carries nothing it can read (D-028).
      let key = PushSeal.key(accessGroup: Bundle.main.object(forInfoDictionaryKey: "RowrowKeychainGroup") as? String)
      try await session.api.subscribeApns(
        token: deviceToken, topic: Bundle.main.bundleIdentifier ?? "", environment: Self.environment,
        key: PushSeal.base64(key))
      registered = true
    } catch {
      problem = (error as? RowrowError)?.errorDescription ?? error.localizedDescription
    }
  }

  /// Apple's environment for this build: what its provisioning profile says, else sandbox for
  /// debug builds (Xcode) and production otherwise.
  static let environment: APIClient.PushEnvironment = {
    if let url = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision"),
      let data = try? Data(contentsOf: url),
      let text = String(data: data, encoding: .isoLatin1)
    {
      if text.contains("<key>aps-environment</key>\n\t\t<string>production</string>")
        || text.range(of: #"aps-environment</key>\s*<string>production"#, options: .regularExpression) != nil
      {
        return .production
      }
      if text.contains("aps-environment") { return .sandbox }
    }
    #if DEBUG
      return .sandbox
    #else
      return .production
    #endif
  }()

  // ─── In the app ────────────────────────────────────────────────────────────

  /// A banner for an agent that needs you while you use the app (shown by willPresent).
  func banner(for agent: AgentState, in session: Session) {
    let content = UNMutableNotificationContent()
    let failed = session.words(for: agent).tone == "error" && agent.attention == .done
    content.title =
      agent.attention == .blocked ? "\(agent.title) needs you" : failed ? "\(agent.title) failed" : "\(agent.title) finished"
    content.subtitle = session.state?.workspaces[agent.summary.workspaceId]?.label ?? ""
    let detail = (failed ? agent.summary.lastError : agent.summary.preview) ?? ""
    content.body = detail.split(whereSeparator: \.isWhitespace).joined(separator: " ").prefix(180).description
    content.threadIdentifier = agent.id
    content.categoryIdentifier = Self.category
    content.sound = .default
    content.userInfo = ["agentId": agent.id, "deviceId": session.account.deviceId, "seq": agent.summary.headSeq]
    // The agent's id, as APNs names its pushes (apns-collapse-id): one notification per agent,
    // the newer replacing the older, whether it came from the server or from here.
    let request = UNNotificationRequest(identifier: agent.id, content: content, trigger: nil)
    center.add(request)
  }

  func updateBadge(_ count: Int) {
    center.setBadgeCount(count)
  }

  /// Take away notifications about agents that no longer need you.
  func clearDelivered(agentIds: Set<String>) async {
    let delivered = await center.deliveredNotifications()
    let stale = delivered.filter { notification in
      guard let id = notification.request.content.userInfo["agentId"] as? String else { return false }
      return agentIds.contains(id)
    }
    center.removeDeliveredNotifications(withIdentifiers: stale.map(\.request.identifier))
  }

  /// Bring notifications in line with the state: none for agents that don't need you anymore.
  func reconcile(with state: AppState) {
    updateBadge(state.needingYou.count)
    Task {
      let delivered = await center.deliveredNotifications()
      let stale = delivered.filter { notification in
        guard let id = notification.request.content.userInfo["agentId"] as? String else { return false }
        // What an agent told you itself (notify.send) isn't about needing you: it stays.
        if notification.request.content.userInfo["notice"] != nil { return false }
        return !(state.agents[id]?.attention.needsYou ?? false)
      }
      center.removeDeliveredNotifications(withIdentifiers: stale.map(\.request.identifier))
    }
  }
}

/// Receives what UIKit tells the app about pushes and notifications, and hands it on.
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
  func application(
    _ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    UNUserNotificationCenter.current().delegate = self
    return true
  }

  func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
    MainActor.assumeIsolated { AppModel.shared.push.received(token: deviceToken) }
  }

  func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: any Error) {
    MainActor.assumeIsolated { AppModel.shared.push.failed(error) }
  }

  /// A background push after agents were seen elsewhere: take their notifications away.
  func application(_ application: UIApplication, didReceiveRemoteNotification userInfo: [AnyHashable: Any]) async
    -> UIBackgroundFetchResult
  {
    guard let seen = userInfo["seen"] as? [String] else { return .noData }
    await AppModel.shared.push.clearDelivered(agentIds: Set(seen))
    return .newData
  }

  /// In the app: no banner for the agent you're looking at; a banner for anything else.
  func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async
    -> UNNotificationPresentationOptions
  {
    let agentId = notification.request.content.userInfo["agentId"] as? String
    let looking = await MainActor.run { agentId.map { AppModel.shared.session?.looking(at: $0) ?? false } ?? false }
    return looking ? [] : [.banner, .list, .sound]
  }

  /// A tap opens the agent; Reply sends what you typed; Mark as Seen clears it everywhere. A Coach
  /// task's notification (D-050) opens Coach on that task, with the run it's about.
  func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
    let info = response.notification.request.content.userInfo
    let deviceId = info["deviceId"] as? String
    if let taskId = info["coachTask"] as? String {
      guard response.actionIdentifier == UNNotificationDefaultActionIdentifier else { return }
      let runId = info["coachRun"] as? String
      await MainActor.run {
        let model = AppModel.shared
        if let deviceId, let account = model.accounts.account(deviceId: deviceId), model.session?.account.id != account.id {
          model.activate(account)
        }
        model.router.open(coachTask: taskId, run: runId)
      }
      return
    }
    guard let agentId = info["agentId"] as? String else { return }
    let seq = (info["seq"] as? NSNumber)?.intValue
    let reply = (response as? UNTextInputNotificationResponse)?.userText
    let action = response.actionIdentifier
    await MainActor.run {
      let model = AppModel.shared
      if let deviceId, let account = model.accounts.account(deviceId: deviceId), model.session?.account.id != account.id {
        model.activate(account)
      }
    }
    let api: APIClient? = await MainActor.run {
      let model = AppModel.shared
      let account = deviceId.flatMap { model.accounts.account(deviceId: $0) } ?? model.accounts.active
      return account.flatMap { account in
        model.accounts.token(for: account).map { APIClient(baseURL: account.baseURL, token: $0) }
      }
    }
    switch action {
    case PushManager.replyAction:
      guard let api, let text = reply?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else { return }
      _ = try? await api.send(agentId: agentId, text: text)
    case PushManager.seenAction:
      guard let api else { return }
      let head: Int? = await MainActor.run { AppModel.shared.session?.state?.agents[agentId]?.summary.headSeq }
      if let at = head ?? seq { try? await api.markSeen(agentId: agentId, seq: at) }
    case UNNotificationDefaultActionIdentifier:
      await MainActor.run { AppModel.shared.router.open(agent: agentId) }
    default:
      break
    }
  }
}
