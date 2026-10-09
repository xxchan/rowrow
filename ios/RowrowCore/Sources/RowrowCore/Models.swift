import Foundation

// The shapes the server sends (src/shared/schemas.ts and src/shared/summary.ts), decoded
// leniently: a value this app doesn't know (a new attention, a new runtime phase) decodes to
// a fallback instead of failing the whole app state.

/// A string enum that decodes values it doesn't know to `fallback`.
public protocol OpenEnum: RawRepresentable, Codable, Sendable, Hashable where RawValue == String {
  static var fallback: Self { get }
}

extension OpenEnum {
  public init(from decoder: any Decoder) throws {
    let raw = try decoder.singleValueContainer().decode(String.self)
    self = Self(rawValue: raw) ?? Self.fallback
  }
}

/// Unix epoch milliseconds, as the server counts time.
public typealias Millis = Double

extension Date {
  public init(millis: Millis) { self.init(timeIntervalSince1970: millis / 1000) }
  public var millis: Millis { timeIntervalSince1970 * 1000 }
}

// ─── Host ────────────────────────────────────────────────────────────────────

/// A newer rowrow is on npm (D-025): what to run on the computer to get it.
public struct UpdateInfo: Codable, Sendable, Equatable {
  public let version: String
  public let command: String
  /// What to do after the command, when it doesn't restart the server itself.
  public let after: String?
}

public struct HostInfo: Codable, Sendable, Equatable {
  public let name: String
  public let version: String
  public let profile: String
  public let dataDir: String
  public let url: String
  public let exposed: Bool
  public let pushKey: String?
  /// Push to the iOS app works: the server has an APNs key.
  public let apns: Bool
  /// A newer rowrow is out, when there is one.
  public let update: UpdateInfo?

  enum CodingKeys: String, CodingKey { case name, version, profile, dataDir, url, exposed, pushKey, apns, update }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    name = try c.decode(String.self, forKey: .name)
    version = try c.decode(String.self, forKey: .version)
    profile = try c.decode(String.self, forKey: .profile)
    dataDir = try c.decode(String.self, forKey: .dataDir)
    url = try c.decode(String.self, forKey: .url)
    exposed = try c.decode(Bool.self, forKey: .exposed)
    pushKey = try c.decodeIfPresent(String.self, forKey: .pushKey)
    apns = try c.decodeIfPresent(Bool.self, forKey: .apns) ?? false
    update = try? c.decodeIfPresent(UpdateInfo.self, forKey: .update)
  }
}

// ─── Workspaces ──────────────────────────────────────────────────────────────

public struct GitSummary: Codable, Sendable, Equatable {
  public let repoRoot: String
  public let repoKey: String
  /// nil when HEAD is detached.
  public let branch: String?
  public let head: String?
  public let upstream: String?
  public let ahead: Int
  public let behind: Int
  /// Files with staged, unstaged or untracked changes.
  public let changed: Int
  /// A linked worktree, not the repository's main checkout.
  public let linked: Bool
  public let error: String?
}

public struct Workspace: Codable, Sendable, Equatable, Identifiable {
  public let id: String
  public let path: String
  public let label: String
  public let customLabel: String?
  /// For a worktree: the workspace of the repository it belongs to.
  public let parentId: String?
  public let createdAt: Millis
  public let archived: Bool
  public let missing: Bool
  public let git: GitSummary?
}

// ─── Agents ──────────────────────────────────────────────────────────────────

/// Why an agent needs you, in priority order (docs/architecture.md, "Attention and notifications").
public enum Attention: String, OpenEnum {
  case blocked, done, working, idle
  public static let fallback = Attention.idle

  public var rank: Int {
    switch self {
    case .blocked: 4
    case .done: 3
    case .working: 2
    case .idle: 1
    }
  }

  public var needsYou: Bool { self == .blocked || self == .done }
}

public struct TurnOutcome: Codable, Sendable, Equatable {
  public enum Kind: String, OpenEnum {
    case completed, aborted, failed
    public static let fallback = Kind.completed
  }
  public let kind: Kind
  public let reason: String?
  public let failure: String?
}

/// What the agent is doing inside a running turn (oar's RunningPhase).
public enum RunningPhase: Sendable, Equatable, Decodable {
  case waitingModel, thinking, responding, compacting
  case tool(name: String, callId: String)
  case other(String)

  public init(from decoder: any Decoder) throws {
    let container = try decoder.singleValueContainer()
    if let phase = try? container.decode(String.self) {
      switch phase {
      case "waiting_model": self = .waitingModel
      case "thinking": self = .thinking
      case "responding": self = .responding
      case "compacting": self = .compacting
      default: self = .other(phase)
      }
    } else {
      struct Tool: Decodable {
        let tool: String
        let callId: String
      }
      let tool = try container.decode(Tool.self)
      self = .tool(name: tool.tool, callId: tool.callId)
    }
  }
}

/// The root agent's status in the live run (oar's AgentStatus).
public enum AgentStatus: Sendable, Equatable, Decodable {
  case idle(lastTurnOutcome: TurnOutcome?)
  case running(sinceSeq: Int, phase: RunningPhase, lastEventAt: Millis)

  enum CodingKeys: String, CodingKey { case kind, lastTurnOutcome, sinceSeq, phase, lastEventAt }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    if try c.decode(String.self, forKey: .kind) == "running" {
      self = .running(
        sinceSeq: try c.decode(Int.self, forKey: .sinceSeq),
        phase: (try? c.decode(RunningPhase.self, forKey: .phase)) ?? .other("?"),
        lastEventAt: try c.decode(Millis.self, forKey: .lastEventAt))
    } else {
      self = .idle(lastTurnOutcome: try c.decodeIfPresent(TurnOutcome.self, forKey: .lastTurnOutcome))
    }
  }

  public var isRunning: Bool {
    if case .running = self { return true }
    return false
  }
}

public struct TokenTotals: Codable, Sendable, Equatable {
  public let input: Double
  public let output: Double
}

public struct ContextUsage: Codable, Sendable, Equatable {
  public let tokens: Double?
  public let contextWindow: Double?
  public let percent: Double?
}

public struct AgentSummary: Decodable, Sendable, Equatable {
  public struct Run: Codable, Sendable, Equatable {
    public let runId: String
    public let sessionId: String
    public let since: Millis
  }
  public struct LastTurn: Codable, Sendable, Equatable {
    public let seq: Int
    public let at: Millis
    public let outcome: TurnOutcome
  }
  public struct Pending: Codable, Sendable, Equatable {
    public let requestId: String
    public let type: String
    public let seq: Int
  }

  public let workspaceId: String
  public let runtime: String
  public let title: String?
  /// The model you asked for; nil is the runtime's default.
  public let model: String?
  public let effort: String?
  public let archived: Bool
  public let createdAt: Millis
  /// The live run, while one is attached.
  public let run: Run?
  public let status: AgentStatus
  /// The model the runtime reported it uses.
  public let reportedModel: String?
  public let reportedEffort: String?
  public let pending: [Pending]
  public let lastTurn: LastTurn?
  public let lastCompletionSeq: Int
  public let lastActivityAt: Millis
  /// The tail of the agent's latest text.
  public let preview: String?
  public let lastError: String?
  public let usage: TokenTotals?
  public let context: ContextUsage?
  public let inputs: Int
  /// Held for later turns and sent one per turn, in order (D-035); nil from a server before 0.3.4.
  public let queued: [QueuedInput]?
  /// Why rowrow stopped sending `queued`: it waits for you.
  public let queuePaused: QueuePauseReason?
  /// Steered into the running turn, not read by the agent yet.
  public let steering: [QueuedInput]?
  /// Steered, but the turn ended before the agent read them.
  public let unread: [QueuedInput]?
  public let headSeq: Int
}

/// A message rowrow holds until the running turn ends, or one steered in and not read yet.
public struct QueuedInput: Codable, Sendable, Equatable, Identifiable {
  public let inputId: String
  public let text: String
  public let attachments: [Attachment]
  public let at: Millis
  public var id: String { inputId }
}

public enum QueuePauseReason: String, OpenEnum {
  /// You stopped the turn.
  case stopped
  case failed
  /// The agent's process exited.
  case exited
  /// rowrow restarted.
  case restarted
  public static let fallback = QueuePauseReason.stopped
}

public struct AgentState: Decodable, Sendable, Equatable, Identifiable {
  public let id: String
  public let summary: AgentSummary
  /// The log position you have seen (D-008).
  public let seenSeq: Int
  public let attention: Attention

  public var title: String { summary.title ?? "Untitled agent" }
}

// ─── Runtimes, settings, the whole state ─────────────────────────────────────

public struct RuntimeInfo: Codable, Sendable, Equatable, Identifiable {
  public let id: String
  public let name: String
  public let installed: Bool
  public let version: String?
  /// Why it is unavailable.
  public let reason: String?
  /// The scripted runtime: no model, no tokens.
  public let test: Bool
}

/// Preferences that follow you to every device.
public struct ServerSettings: Codable, Sendable, Equatable {
  public var quickReplies: [String]
  /// The server asks npm for a newer rowrow (D-025).
  public var checkForUpdates: Bool?
  public init(quickReplies: [String], checkForUpdates: Bool? = nil) {
    self.quickReplies = quickReplies
    self.checkForUpdates = checkForUpdates
  }
}

/// A value that decodes to nil (and says why in the log) when this app can't read it.
struct Lenient<Value: Decodable>: Decodable {
  let value: Value?

  init(from decoder: any Decoder) throws {
    do {
      value = try Value(from: decoder)
    } catch {
      logger.error("state.value_unreadable \(String(describing: error), privacy: .public)")
      value = nil
    }
  }
}

/// Everything every client renders (state.get, state.watch).
public struct AppState: Decodable, Sendable, Equatable {
  public let host: HostInfo
  public let workspaces: [String: Workspace]
  public let agents: [String: AgentState]
  public let runtimes: [String: RuntimeInfo]
  public let settings: ServerSettings

  private enum CodingKeys: String, CodingKey { case host, workspaces, agents, runtimes, settings }

  /// A workspace, agent or runtime this app can't read is left out, rather than the whole state
  /// failing (and with it every later change, since the patches keep coming).
  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    host = try c.decode(HostInfo.self, forKey: .host)
    workspaces = try c.decode([String: Lenient<Workspace>].self, forKey: .workspaces).compactMapValues(\.value)
    agents = try c.decode([String: Lenient<AgentState>].self, forKey: .agents).compactMapValues(\.value)
    runtimes = try c.decode([String: Lenient<RuntimeInfo>].self, forKey: .runtimes).compactMapValues(\.value)
    settings = try c.decode(ServerSettings.self, forKey: .settings)
  }

  /// Archived, or a linked worktree of an archived repository: hidden with its agents (D-047).
  public func workspaceArchived(_ id: String) -> Bool {
    guard let workspace = workspaces[id] else { return false }
    if workspace.archived { return true }
    guard let parentId = workspace.parentId else { return false }
    return workspaces[parentId]?.archived ?? false
  }

  /// Agents neither archived nor in an archived workspace, the ones that need you first, then the
  /// most recently active.
  public var sortedAgents: [AgentState] {
    agents.values.filter { !$0.summary.archived && !workspaceArchived($0.summary.workspaceId) }.sorted {
      $0.attention.rank != $1.attention.rank
        ? $0.attention.rank > $1.attention.rank
        : $0.summary.lastActivityAt > $1.summary.lastActivityAt
    }
  }

  /// Agents that need you (blocked or done), in the order to see them.
  public var needingYou: [AgentState] { sortedAgents.filter { $0.attention.needsYou } }

  public func runtimeName(_ id: String) -> String { runtimes[id]?.name ?? id }
}

// ─── Results of calls ────────────────────────────────────────────────────────

/// Where input goes while a turn runs (D-035); idle, every mode starts a turn.
public enum InputMode: String, Codable, Sendable {
  /// Same as queue.
  case auto
  /// rowrow holds it and sends it when the turn ends; until then it can be taken back.
  case queue
  /// Into the running turn; it can't be taken back. A runtime that can't steer holds it instead.
  case steer
  /// Stop the running turn, then prompt.
  case interrupt
}

/// Whether a runtime takes input mid-turn (src/shared/summary.ts `steerSupport`): `redoes`
/// takes it by starting the current step again.
public enum SteerSupport: Sendable {
  case yes, no, redoes

  public init(runtime: String) {
    switch runtime {
    case "kimi", "antigravity": self = .no
    case "grok": self = .redoes
    default: self = .yes
    }
  }
}

/// A held message, taken back (agents.withdraw).
public struct Withdrawn: Codable, Sendable, Equatable {
  public let text: String
  public let attachments: [Attachment]
}

public struct SendResult: Codable, Sendable, Equatable {
  public enum Landing: String, OpenEnum {
    case prompted, steered, queued, rejected, failed
    public static let fallback = Landing.failed
  }
  public let inputId: String
  public let landed: Landing
  public let code: String?
  public let reason: String?
  public let seq: Int
}

public struct Device: Codable, Sendable, Equatable, Identifiable {
  public enum Kind: String, OpenEnum {
    case browser, app, cli
    public static let fallback = Kind.browser
  }
  public let id: String
  public let name: String
  public let kind: Kind
  public let createdAt: Millis
  public let lastSeenAt: Millis?
  public let current: Bool
  public let push: Bool
}

public struct LoginLink: Codable, Sendable, Equatable {
  public let url: String
  public let expiresAt: Millis
}

public struct ModelInfo: Codable, Sendable, Equatable, Identifiable, Hashable {
  public let id: String
  public let name: String
  public let effortLevels: [String]
  public let defaultEffort: String?
}

public struct ModelList: Codable, Sendable {
  public let models: [ModelInfo]
  public let error: String?
}

public struct SkillInfo: Codable, Sendable, Equatable, Identifiable, Hashable {
  public let name: String
  public let description: String?
  public let source: String?
  public var id: String { name }
}

public struct SkillList: Codable, Sendable {
  public let skills: [SkillInfo]
  public let error: String?

  public init(skills: [SkillInfo], error: String?) {
    self.skills = skills
    self.error = error
  }
}

public struct AgentCreated: Decodable, Sendable {
  public let agent: AgentState
  public let sent: SendResult?
}

public struct AbortResult: Codable, Sendable {
  public let accepted: Bool
  public let reason: String?
}

/// A file sent with a message (D-024): uploaded with files.upload, which answers with this.
/// The agent gets its path; images also reach the model as images.
public struct Attachment: Codable, Sendable, Equatable, Hashable, Identifiable {
  /// Where the server keeps it (a week).
  public let path: String
  public let name: String
  /// Its MIME type, "" when unknown.
  public let type: String
  public let size: Double
  public var id: String { path }

  public var isImage: Bool { type.hasPrefix("image/") }
}

public struct DirectoryListing: Codable, Sendable {
  public struct Entry: Codable, Sendable, Identifiable, Hashable {
    public let name: String
    public let path: String
    /// A git repository.
    public let repo: Bool
    public var id: String { path }
  }
  public let path: String
  public let parent: String?
  public let entries: [Entry]
}

/// What workspaces.remove did: the workspaces rowrow forgot, and the agents it archived.
public struct WorkspaceRemoved: Decodable, Sendable {
  public let removed: [String]
  public let archived: [String]
}

public struct WorktreeCreated: Decodable, Sendable {
  public struct Hook: Codable, Sendable {
    public let ran: Bool
    public let ok: Bool
    public let output: String
  }
  public let workspace: Workspace
  public let hook: Hook?
}

// ─── Git ─────────────────────────────────────────────────────────────────────

public enum DiffScope: String, Codable, Sendable, CaseIterable, Identifiable {
  /// What an agent's latest turn changed.
  case turn
  /// Uncommitted changes against HEAD.
  case working
  /// Everything since the merge base with the default branch.
  case branch
  public var id: String { rawValue }
}

public struct ChangedFile: Codable, Sendable, Equatable, Identifiable, Hashable {
  public enum Status: String, OpenEnum {
    case added, modified, deleted, renamed, copied, untracked, conflicted, typechange
    public static let fallback = Status.modified
  }
  public let path: String
  public let oldPath: String?
  public let status: Status
  /// nil for binary files.
  public let additions: Int?
  public let deletions: Int?
  /// Working scope: the index has changes to it.
  public let staged: Bool?
  /// Working scope: the worktree has changes the index doesn't.
  public let unstaged: Bool?
  /// Working scope: its state when listed; file actions take it back.
  public let stamp: String?
  public var id: String { path }
}

public struct Changes: Codable, Sendable, Equatable {
  public let scope: DiffScope
  public let base: String?
  public let baseLabel: String?
  public let files: [ChangedFile]
  public let truncated: Bool
  /// Why the scope has nothing to show, when it can't.
  public let note: String?
}

public struct FileDiff: Codable, Sendable, Equatable {
  /// A unified diff.
  public let patch: String
  public let truncated: Bool
}

public enum FileAction: String, Codable, Sendable {
  case stage, unstage, discardUnstaged, deleteUntracked, markResolved
}

public enum BulkAction: String, Codable, Sendable {
  case stageAll, unstageAll, discardAllUnstaged, deleteAllUntracked
}

public struct SeenFile: Codable, Sendable {
  public let path: String
  public let oldPath: String?
  public let stamp: String
  public init(_ file: ChangedFile) {
    path = file.path
    oldPath = file.oldPath
    stamp = file.stamp ?? ""
  }
}

public struct FileActionResult: Decodable, Sendable {
  public let paths: [String]
  public let changes: Changes
}

public struct CommitSummary: Codable, Sendable, Equatable, Identifiable, Hashable {
  public let sha: String
  public let parents: [String]
  public let subject: String
  public let authorName: String
  public let authorEmail: String
  public let authorDate: Millis
  public var id: String { sha }
}

public struct CommitPage: Codable, Sendable {
  public let branch: String?
  public let head: String?
  public let commits: [CommitSummary]
  public let nextCursor: String?
  public let shallow: Bool
  public let note: String?
}

public struct CommitDetail: Codable, Sendable, Equatable {
  public let sha: String
  public let parents: [String]
  public let subject: String
  public let message: String
  public let authorName: String
  public let authorEmail: String
  public let authorDate: Millis
  public let committerName: String
  public let committerDate: Millis
}

public struct CommitChanges: Codable, Sendable {
  public let commit: CommitDetail
  public let base: String?
  public let baseLabel: String
  public let files: [ChangedFile]
  public let truncated: Bool
  public let note: String?
}

public struct PullRequestStatus: Codable, Sendable {
  public struct Checks: Codable, Sendable {
    public let state: String
    public let total: Int
    public let passed: Int
    public let failed: Int
    public let pending: Int
  }
  public struct PullRequest: Codable, Sendable {
    public let number: Int
    public let title: String
    public let url: String
    public let state: String
    public let author: String?
    public let head: String
    public let base: String
    public let checks: Checks
    public let review: String
  }
  public let state: String
  public let message: String?
  public let branch: String?
  public let pr: PullRequest?
}

public struct SearchResult: Codable, Sendable {
  public struct Name: Codable, Sendable, Hashable { public let path: String }
  public struct Line: Codable, Sendable, Hashable {
    public let path: String
    public let line: Int
    public let text: String
  }
  public let query: String
  public let names: [Name]
  public let namesTruncated: Bool
  public let lines: [Line]
  public let linesTruncated: Bool
  public let note: String?
}

public struct FileList: Codable, Sendable {
  public let paths: [String]
  public let truncated: Bool
}

public struct FileText: Codable, Sendable {
  public let path: String
  public let text: String
  public let size: Double
  public let truncated: Bool
}

public struct OK: Codable, Sendable {}
