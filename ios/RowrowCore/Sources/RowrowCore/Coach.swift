import Foundation

// Coach (docs/decisions.md, D-044): rowrow's assistant, whose chats are agents kept apart from
// the others (AppState's coach.chat), the actions it proposes for you to confirm (D-045), and its
// scheduled tasks (D-050). The shapes of src/shared/coach.ts and coach-tasks.ts, decoded
// leniently, and the words the web app's Coach window says about them.

// ─── Settings and state ──────────────────────────────────────────────────────

/// What Coach may read and what it runs on (settings.coach). The app only reads it: changing
/// it is the web app's, except turning Full access off (Session.turnOffCoachFullAccess).
public struct CoachSettings: Decodable, Sendable, Equatable {
  /// Workspaces whose agents Coach may read.
  public let workspaces: [String]
  /// The runtime a new chat runs on (claude or pi).
  public let runtime: String
  public let model: String?
  public let effort: String?
  /// Full access (D-045): every workspace, and its actions run without asking.
  public let fullAccess: Bool

  enum CodingKeys: String, CodingKey { case workspaces, runtime, model, effort, fullAccess }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    workspaces = (try? c.decodeIfPresent([String].self, forKey: .workspaces)) ?? []
    runtime = (try? c.decodeIfPresent(String.self, forKey: .runtime)) ?? "claude"
    model = try? c.decodeIfPresent(String.self, forKey: .model)
    effort = try? c.decodeIfPresent(String.self, forKey: .effort)
    fullAccess = (try? c.decodeIfPresent(Bool.self, forKey: .fullAccess)) ?? false
  }
}

/// Coach in the app state: its current chat (nil before the first message) and its tasks.
public struct CoachState: Decodable, Sendable, Equatable {
  public let chat: AgentState?
  public let tasks: [CoachTask]

  enum CodingKeys: String, CodingKey { case chat, tasks }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    chat = try? c.decodeIfPresent(AgentState.self, forKey: .chat)
    tasks = ((try? c.decodeIfPresent([Lenient<CoachTask>].self, forKey: .tasks)) ?? []).compactMap(\.value)
  }
}

/// Where an action Coach proposed stands (src/shared/coach-actions.ts).
public enum CoachActionStatus: String, OpenEnum {
  case pending, executing, succeeded, failed, uncertain, cancelled
  public static let fallback = CoachActionStatus.cancelled
}

/// An action of a chat that isn't decided yet (AgentSummary.coachActions): waiting for you, or running.
public struct CoachOpenAction: Decodable, Sendable, Equatable {
  public let status: CoachActionStatus
}

// ─── Tasks ───────────────────────────────────────────────────────────────────

/// When a task runs: once at an instant, daily at a wall-clock time in a time zone, or every N minutes.
public enum TaskSchedule: Sendable, Equatable, Decodable {
  /// A UTC ISO 8601 instant.
  case once(at: String)
  case daily(time: String, timeZone: String)
  case interval(minutes: Int)
  /// A kind this app doesn't know.
  case other(String)

  enum CodingKeys: String, CodingKey { case type, at, time, timeZone, minutes }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    let type = try c.decode(String.self, forKey: .type)
    switch type {
    case "once": self = .once(at: try c.decode(String.self, forKey: .at))
    case "daily":
      self = .daily(time: try c.decode(String.self, forKey: .time), timeZone: try c.decode(String.self, forKey: .timeZone))
    case "interval": self = .interval(minutes: try c.decode(Int.self, forKey: .minutes))
    default: self = .other(type)
    }
  }

  /// "Once: Oct 9, 3:00 PM", "Daily at 09:00 (Europe/London)", "Every 5 minutes" (scheduleLabel).
  public func label(when: (Millis) -> String = CoachWords.at) -> String {
    switch self {
    case .once(let at): "Once: \(CoachWords.instant(at).map(when) ?? at)"
    case .daily(let time, let timeZone): "Daily at \(time) (\(timeZone))"
    case .interval(let minutes): "Every \(minutes) minute\(minutes == 1 ? "" : "s")"
    case .other(let type): type
    }
  }
}

/// How a task's runs notify you.
public enum TaskNotify: String, OpenEnum {
  /// A notification when each run finishes.
  case every
  /// Coach decides; failures and confirmations still notify.
  case coach
  public static let fallback = TaskNotify.every

  /// NOTIFY_LABELS.
  public var label: String {
    switch self {
    case .every: "Notify when each run finishes"
    case .coach: "Coach decides when to notify"
    }
  }
}

/// A scheduled task (AppState's coach.tasks): your prompt, sent to a new Coach chat on its schedule.
public struct CoachTask: Decodable, Sendable, Equatable, Identifiable {
  public enum Status: String, OpenEnum {
    case active, paused
    public static let fallback = Status.active
  }

  public let id: String
  public let title: String
  /// The exact message each run sends Coach.
  public let prompt: String
  public let schedule: TaskSchedule
  public let notify: TaskNotify
  public let status: Status
  /// Saved while Full access was on: its runs act without asking while Full access stays on.
  public let fullAccess: Bool
  public let createdAt: Millis
  public let updatedAt: Millis
  /// The next scheduled occurrence; nil when none is coming.
  public let nextRunAt: Millis?
  /// An occurrence that came due and waits for its run.
  public let queuedAt: Millis?
  /// Its run that is working or holds proposals for you.
  public let currentRun: CoachTaskRun?
  /// Its latest run that is over.
  public let lastRun: CoachTaskRun?

  /// Changes whenever a run starts, moves on or ends: when to read its runs again.
  public var runsSignature: String {
    [currentRun?.id, currentRun?.status.rawValue, currentRun?.chatId, lastRun?.id, lastRun?.status.rawValue]
      .map { $0 ?? "" }.joined(separator: "|")
  }
}

/// One run of a task: a Coach chat the server started with the task's prompt.
public struct CoachTaskRun: Decodable, Sendable, Equatable, Identifiable {
  public enum Status: String, OpenEnum {
    /// Coach is answering.
    case running
    /// It holds proposals for you to confirm.
    case waiting
    case succeeded, failed, stopped
    public static let fallback = Status.stopped
  }

  public let id: String
  public let taskId: String
  /// Its chat; nil when it failed before one started.
  public let chatId: String?
  public let status: Status
  /// The occurrence it runs for; a Run now's tap.
  public let scheduledAt: Millis
  public let startedAt: Millis
  public let finishedAt: Millis?
  public let error: String?
  /// Run now, not the schedule.
  public let manual: Bool
}

/// A Coach chat in History (coach.chats).
public struct CoachChat: Decodable, Sendable, Equatable, Identifiable {
  public let id: String
  public let title: String?
  public let runtime: String
  public let createdAt: Millis
  public let updatedAt: Millis
  /// Messages you sent (a task's run: its prompt).
  public let messages: Int
  public let current: Bool
  /// A scheduled task's run: that task.
  public let taskId: String?
}

/// What coach.send answers: how the message landed, and in which chat.
public struct CoachSent: Decodable, Sendable {
  public let inputId: String
  public let landed: SendResult.Landing
  public let code: String?
  public let reason: String?
  public let seq: Int
  public let chatId: String
}

// ─── Readiness ───────────────────────────────────────────────────────────────

extension AppState {
  /// Runtimes that can be Coach (src/shared/coach.ts canCoach).
  static let coachRuntimes: Set<String> = ["claude", "pi", "scripted"]

  /// Why Coach can't run on what its settings say, or nil (the web's runtimeProblem).
  public var coachRuntimeProblem: String? {
    guard let coach = settings.coach else { return nil }
    let id = coach.runtime
    let info = runtimes[id]
    if !Self.coachRuntimes.contains(id) { return "This runtime can't turn off its built-in tools, so it can't be Coach." }
    if info?.installed != true { return "\(info?.name ?? id) isn't installed here." }
    return nil
  }

  /// The workspaces the next message may read: the allowed ones still there (with Full access, all).
  public var coachWorkspaces: [String] {
    guard let coach = settings.coach else { return [] }
    let ids = coach.fullAccess ? Array(workspaces.keys) : coach.workspaces
    return ids.filter { id in
      guard let workspace = workspaces[id] else { return false }
      return !workspaceArchived(id) && !workspace.missing
    }
  }

  /// What keeps you from writing to Coach, in words, or nil. Its settings are the web app's.
  public var coachNotice: String? {
    if coach == nil { return "This rowrow has no Coach yet: update it on your computer." }
    if let problem = coachRuntimeProblem {
      return "\(problem) Choose a runtime in Coach's settings in rowrow on your computer."
    }
    if coachWorkspaces.isEmpty {
      return settings.coach?.fullAccess == true
        ? "Add a workspace to rowrow first: Coach reads the agents in your workspaces."
        : "Allow workspaces in Coach's settings (rowrow on your computer) to send messages."
    }
    return nil
  }

  /// What waits for you in Coach: proposals of its chat, and task runs holding some.
  public var coachWaiting: Int {
    let proposals = coach?.chat?.summary.coachActions?.filter { $0.status == .pending }.count ?? 0
    let runs = coach?.tasks.filter { $0.currentRun?.status == .waiting }.count ?? 0
    return proposals + runs
  }
}

extension AgentSummary {
  /// One of Coach's actions is running: nothing else may start until it ends.
  public var coachExecuting: Bool { coachActions?.contains { $0.status == .executing } ?? false }
}

// ─── Words ───────────────────────────────────────────────────────────────────

/// What Coach's window says, as the web app says it (Coach.tsx, CoachTasks.tsx, CoachActionCard.tsx).
public enum CoachWords {
  /// A date and time as Coach's cards and tasks show them: "Oct 9, 3:00 PM".
  public static func at(_ millis: Millis) -> String {
    Date(millis: millis).formatted(.dateTime.month(.abbreviated).day().hour().minute())
  }

  /// A UTC ISO 8601 instant ("2026-10-09T15:00:00.000Z"), as epoch milliseconds.
  public static func instant(_ text: String) -> Millis? {
    let date =
      (try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(text))
      ?? (try? Date.ISO8601FormatStyle().parse(text))
    return date?.millis
  }

  /// What Coach is doing, under its name.
  public static func status(online: Bool, working: Bool, executing: Bool) -> String {
    !online ? "Reconnecting" : executing ? "Executing action" : working ? "Working" : "Idle"
  }

  /// "Current: running", "Last: succeeded", "No runs yet", as Ranger's rows say it.
  public static func runLine(_ task: CoachTask) -> String {
    if let run = task.currentRun { return "Current: \(run.status.rawValue)" }
    if let run = task.lastRun { return "Last: \(run.status.rawValue)" }
    return "No runs yet"
  }

  public static func nextLine(_ task: CoachTask, when: (Millis) -> String = CoachWords.at) -> String {
    if task.queuedAt != nil && task.currentRun == nil { return "Queued: runs once the run going now ends" }
    if task.status == .paused { return "Paused: no upcoming run" }
    guard let next = task.nextRunAt else { return "No upcoming run" }
    return "Next: \(when(next))"
  }

  /// Whether a task's runs act without asking.
  public static func permission(_ task: CoachTask, fullAccessNow: Bool) -> String {
    if !task.fullAccess { return "Manual permission: operations need confirmation" }
    return fullAccessNow
      ? "Full access: supported operations execute automatically"
      : "Full access saved; Coach's Full access is off, so operations need confirmation"
  }

  /// "Oct 9, 3:00 PM / succeeded (Run now)": a run in a task's history.
  public static func runLabel(_ run: CoachTaskRun, when: (Millis) -> String = CoachWords.at) -> String {
    "\(when(run.scheduledAt)) / \(run.status.rawValue)\(run.manual ? " (Run now)" : "")"
  }

  /// "1,234 characters": how long an exact text is, counted as the web app counts it (UTF-16).
  public static func characters(_ text: String) -> String {
    let count = text.utf16.count
    return "\(count.formatted()) character\(count == 1 ? "" : "s")"
  }

  /// What the UI calls a tool Coach called (coachToolLabel): proposals keep their own names.
  public static func toolLabel(_ tool: String) -> String {
    let prefix = "mcp__rowrow__"
    let name = tool.hasPrefix(prefix) ? String(tool.dropFirst(prefix.count)) : tool
    return toolLabels[name] ?? (name.hasPrefix("propose_") ? name : tool)
  }

  static let toolLabels: [String: String] = [
    "agents_status": "Agent status",
    "agent_history": "Agent history",
    "agent_changes": "Agent changes",
    "agent_background": "Background output",
    "list_coach_tasks": "Coach tasks",
    "send_user_notification": "Notify the user",
  ]
}
