import Foundation
import Network
import Observation

public enum ConnectionStatus: Sendable, Equatable {
  case connecting
  case online
  /// Can't reach the server; trying again at `retryAt` (or as soon as the network comes back).
  case offline(message: String, retryAt: Date)
  /// The server doesn't know this device anymore: pair again.
  case signedOut(String)

  public var isOnline: Bool { self == .online }
}

/// One paired server, live: the app state replicated from `state.watch` (a snapshot, then
/// patches), the kit that reads its logs, and what this device is looking at (presence), kept
/// up across flaky networks and backgrounding (PRINCIPLES.md, engineering 2). The app holds
/// one for the server it shows.
@MainActor
@Observable
public final class Session {
  public let account: Account
  public let api: APIClient

  public private(set) var status: ConnectionStatus = .connecting
  /// The app state; nil until the first snapshot (or the one kept from last time).
  public private(set) var state: AppState?
  /// The state came from the last session, not from the server yet.
  public private(set) var stale = false
  /// Counts the snapshots shown: a new one means the whole state was just read again (a connect).
  public private(set) var snapshots = 0
  /// Each agent's state in words (the kit's `describe`), by agent id.
  public private(set) var words: [String: StateWords] = [:]
  public private(set) var kit: Kit?
  /// Why the kit isn't there, when it isn't.
  public private(set) var kitError: String?

  /// An agent's attention changed: the agent now, and what it was.
  @ObservationIgnored public var onAttention: ((AgentState, Attention) -> Void)?

  // Presence: what the app shows, and whether you can see it.
  @ObservationIgnored private var route = "/"
  @ObservationIgnored private var agentOnScreen: String?
  @ObservationIgnored private var visible = false
  @ObservationIgnored private var focused = false

  @ObservationIgnored private var tree: JSONValue?
  @ObservationIgnored private var loop: Task<Void, Never>?
  @ObservationIgnored private var connection: String?
  @ObservationIgnored private var publishScheduled = false
  @ObservationIgnored private var lastSaved = Date.distantPast
  @ObservationIgnored private var clock: Task<Void, Never>?
  @ObservationIgnored private let cache: URL
  @ObservationIgnored private let path = NWPathMonitor()
  @ObservationIgnored private var kitWaiters: [CheckedContinuation<Kit, Never>] = []
  @ObservationIgnored private var freshSnapshot = false

  public init(account: Account, token: String, cache: URL) {
    self.account = account
    api = APIClient(baseURL: account.baseURL, token: token)
    self.cache = cache
    try? FileManager.default.createDirectory(at: cache, withIntermediateDirectories: true)
    restore()
    path.pathUpdateHandler = { [weak self] update in
      guard update.status == .satisfied else { return }
      Task { @MainActor in self?.retryNow() }
    }
    path.start(queue: .main)
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  /// Connect and keep connected (the app came to the foreground).
  public func start() {
    visible = true
    focused = true
    guard loop == nil else {
      sendPresence()
      return
    }
    loop = Task { [weak self] in await self?.run() }
    clock = Task { [weak self] in
      while !Task.isCancelled {
        try? await Task.sleep(for: .seconds(20))
        await self?.describe()
      }
    }
  }

  /// Say you've stopped looking, then let go of the connection (the app went to the background).
  /// The connection is detached at once, so coming straight back starts a new one.
  public func stop() async {
    visible = false
    focused = false
    let (loop, clock, connection, wasOnline) = (self.loop, self.clock, self.connection, status.isOnline)
    self.loop = nil
    self.clock = nil
    self.connection = nil
    if case .online = status { status = .connecting }
    save(force: true)
    if wasOnline, let connection {
      try? await presence(on: connection, visible: false, focused: false)
    }
    loop?.cancel()
    clock?.cancel()
  }

  /// The app is on screen but not in front (a notification or Control Center over it).
  public func setFocused(_ focused: Bool) {
    guard self.focused != focused else { return }
    self.focused = focused
    sendPresence()
  }

  /// Reconnect now if waiting to (the network came back, or you pulled to refresh).
  public func retryNow() {
    guard case .offline = status, loop != nil else { return }
    loop?.cancel()
    loop = Task { [weak self] in await self?.run() }
  }

  private func run() async {
    var attempt = 0
    while !Task.isCancelled {
      status = .connecting
      if kit == nil { Task { await self.loadKit() } }
      let name = "ios-" + traceId()
      connection = name
      do {
        var first = true
        for try await message in api.stream("state.watch", ["connection": name]) {
          try receive(message)
          if first {
            first = false
            attempt = 0
            status = .online
            sendPresence()
          }
        }
        // The server ended the stream (it's stopping): come back shortly.
        try await Task.sleep(for: .milliseconds(500))
      } catch is CancellationError {
        return
      } catch RowrowError.signedOut(let message) {
        status = .signedOut(message)
        return
      } catch {
        attempt += 1
        let delay = min(15.0, 0.5 * pow(2, Double(min(attempt, 5)))) * Double.random(in: 0.8...1.2)
        let message = (error as? RowrowError)?.errorDescription ?? error.localizedDescription
        logger.warn("session.offline \(message) (attempt \(attempt))")
        status = .offline(message: message, retryAt: Date().addingTimeInterval(delay))
        do { try await Task.sleep(for: .seconds(delay)) } catch { return }
      }
    }
  }

  // ─── The app state ─────────────────────────────────────────────────────────

  private func receive(_ message: String) throws {
    let json = try JSONValue.parse(Data(message.utf8))
    guard case .string(let kind) = json["kind"] else { throw JSONError(description: "not a state message") }
    if kind == "snapshot" {
      tree = json["state"]
      stale = false
      freshSnapshot = true
    } else {
      guard var current = tree, case .array(let patches) = json["patches"] else {
        throw JSONError(description: "patches before a snapshot")
      }
      try current.apply(patches.map(Patch.init(json:)))
      tree = current
    }
    schedulePublish()
  }

  /// Decode and show the state at most every 150 ms: while agents stream, patches come much faster.
  private func schedulePublish() {
    guard !publishScheduled else { return }
    publishScheduled = true
    Task {
      try? await Task.sleep(for: .milliseconds(150))
      publishScheduled = false
      publish()
    }
  }

  private func publish() {
    guard let tree else { return }
    let next: AppState
    do {
      next = try tree.decode(AppState.self)
    } catch {
      logger.error("session.state_unreadable \(String(describing: error), privacy: .public)")
      kitError = "rowrow's app state didn't make sense to this app: update the app, or rowrow on your computer."
      return
    }
    let previous = state
    state = next
    if freshSnapshot {
      freshSnapshot = false
      snapshots += 1
    }
    if let previous, let onAttention {
      for agent in next.agents.values {
        if let before = previous.agents[agent.id], before.attention != agent.attention {
          onAttention(agent, before.attention)
        }
      }
    }
    save(force: false)
    Task { await describe() }
  }

  private func describe() async {
    guard let kit, let agents = tree?["agents"], let data = try? agents.data() else {
      if let state { words = state.agents.mapValues { StateWords.basic($0.attention) } }
      return
    }
    do {
      words = try await kit.describe(agents: data, now: Date())
    } catch {
      logger.warn("session.describe_failed \(error.localizedDescription)")
    }
  }

  public func words(for agent: AgentState) -> StateWords {
    words[agent.id] ?? .basic(agent.attention)
  }

  /// The app state as JSON text, for the kit (new-agent defaults).
  public func stateJSON() -> Data? { try? tree?.data() }

  // ─── The kit ───────────────────────────────────────────────────────────────

  private var kitFile: URL { cache.appending(path: "kit-\(account.id.uuidString).js") }
  private var kitTagFile: URL { cache.appending(path: "kit-\(account.id.uuidString).etag") }

  private func loadKit() async {
    let cachedSource = try? String(contentsOf: kitFile, encoding: .utf8)
    let cachedTag = cachedSource == nil ? nil : try? String(contentsOf: kitTagFile, encoding: .utf8)
    do {
      let source: String
      switch try await api.kit(etag: cachedTag) {
      case .unchanged:
        source = cachedSource ?? ""
      case .changed(let fresh, let etag):
        source = fresh
        try? fresh.write(to: kitFile, atomically: true, encoding: .utf8)
        try? (etag ?? "").write(to: kitTagFile, atomically: true, encoding: .utf8)
      }
      try install(Kit(source: source))
    } catch {
      // Offline: the copy from last time reads the log the same way, until the server says otherwise.
      if let cachedSource, let kit = try? Kit(source: cachedSource) {
        install(kit)
      } else {
        kitError = (error as? RowrowError)?.errorDescription ?? error.localizedDescription
      }
    }
  }

  private func install(_ kit: Kit) {
    self.kit = kit
    kitError = nil
    for waiter in kitWaiters { waiter.resume(returning: kit) }
    kitWaiters = []
    Task { await describe() }
  }

  /// The kit, once it's loaded.
  public func readyKit() async -> Kit {
    if let kit { return kit }
    return await withCheckedContinuation { kitWaiters.append($0) }
  }

  // ─── Presence ──────────────────────────────────────────────────────────────

  /// What the app shows now (`/`, `/a/<id>`, `/w/<id>`, `/settings`) and the agent on screen.
  public func show(route: String, agent: String?) {
    guard route != self.route || agent != agentOnScreen else { return }
    self.route = route
    agentOnScreen = agent
    sendPresence()
  }

  /// Whether this agent is the one on screen, in front of you.
  public func looking(at agentId: String) -> Bool {
    agentOnScreen == agentId && visible && focused
  }

  private func sendPresence() {
    guard status.isOnline, let connection else { return }
    let (visible, focused) = (visible, focused)
    Task {
      do {
        try await presence(on: connection, visible: visible, focused: focused)
      } catch {
        logger.warn("presence.failed \(error.localizedDescription)")
      }
    }
  }

  private func presence(on connection: String, visible: Bool, focused: Bool) async throws {
    let _: OK = try await api.call(
      "presence.update",
      PresenceInput(route: route, agentId: agentOnScreen, visible: visible, focused: focused, connection: connection))
  }

  private struct PresenceInput: Encodable {
    let route: String
    let agentId: String?
    let visible: Bool
    let focused: Bool
    let connection: String

    func encode(to encoder: any Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode(route, forKey: .route)
      try c.encode(agentId, forKey: .agentId)  // null, not absent: "no agent"
      try c.encode(visible, forKey: .visible)
      try c.encode(focused, forKey: .focused)
      try c.encode(connection, forKey: .connection)
    }

    enum CodingKeys: String, CodingKey { case route, agentId, visible, focused, connection }
  }

  // ─── Kept across launches ──────────────────────────────────────────────────

  private var stateFile: URL { cache.appending(path: "state-\(account.id.uuidString).json") }

  /// Show the state from last time while connecting: opening the app shows your agents at once.
  private func restore() {
    guard let data = try? Data(contentsOf: stateFile), let json = try? JSONValue.parse(data),
      let decoded = try? json.decode(AppState.self)
    else { return }
    tree = json
    state = decoded
    stale = true
    words = decoded.agents.mapValues { StateWords.basic($0.attention) }
  }

  private func save(force: Bool) {
    guard !stale, let tree, force || Date().timeIntervalSince(lastSaved) > 10 else { return }
    lastSaved = Date()
    guard let data = try? tree.data() else { return }
    try? data.write(to: stateFile, options: .atomic)
  }

  /// Forget what this device kept about the server (signing out).
  public func forget() {
    loop?.cancel()
    clock?.cancel()
    path.cancel()
    for file in [stateFile, kitFile, kitTagFile] { try? FileManager.default.removeItem(at: file) }
  }
}
