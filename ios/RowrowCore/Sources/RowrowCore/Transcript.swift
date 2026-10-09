import Foundation

// The transcript as the kit hands it over (src/shared/transcript-model.ts): a flat list of
// items with stable ids, and after every change only the items that changed.

public enum TranscriptItem: Sendable, Equatable, Identifiable, Decodable {
  case input(Input)
  case turn(Turn)
  case text(Text)
  case reasoning(Reasoning)
  case tool(Tool)
  case request(Request)
  case notice(Notice)
  case outcome(Outcome)
  /// A kind this app doesn't know (a newer kit): shown as nothing.
  case unknown(id: String)

  public struct Input: Codable, Sendable, Equatable, Identifiable {
    public enum State: String, OpenEnum {
      case sending, sent, failed
      public static let fallback = State.sent
    }
    public let id: String
    /// What was written (the runtime also got the attachments' paths).
    public let text: String
    public let attachments: [Attachment]
    /// Who sent it (a device's name, an agent, rowrow).
    public let by: String?
    public let at: Millis?
    public let state: State
    /// "steered" into the running turn, or "queued" for the next.
    public let landed: String?
    public let reason: String?

    enum CodingKeys: String, CodingKey { case id, text, attachments, by, at, state, landed, reason }

    public init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      id = try c.decode(String.self, forKey: .id)
      text = try c.decode(String.self, forKey: .text)
      attachments = try c.decodeIfPresent([Attachment].self, forKey: .attachments) ?? []
      by = try c.decodeIfPresent(String.self, forKey: .by)
      at = try c.decodeIfPresent(Millis.self, forKey: .at)
      state = try c.decode(State.self, forKey: .state)
      landed = try c.decodeIfPresent(String.self, forKey: .landed)
      reason = try c.decodeIfPresent(String.self, forKey: .reason)
    }
  }

  public struct Turn: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    /// The runtime is still working on it.
    public let open: Bool
  }

  public struct Text: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let turn: String
    /// The sub-agent it came from; empty for the agent itself.
    public let lane: [String]
    /// Markdown.
    public let text: String
    public let streaming: Bool
  }

  public struct Reasoning: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let turn: String
    public let lane: [String]
    /// nil when the runtime keeps it to itself.
    public let text: String?
    /// How many thoughts it stands for: hidden ones back to back are one item. Absent from
    /// servers before 0.3.61, which send each one.
    public let count: Int?
    public let streaming: Bool
  }

  public struct Tool: Codable, Sendable, Equatable, Identifiable {
    public enum Result: String, OpenEnum {
      case running, ok, failed, ended
      public static let fallback = Result.ended
    }
    public let id: String
    public let turn: String
    public let lane: [String]
    public let callId: String
    public let tool: String
    /// run_command, read_file, edit_file, search, web, mcp, other.
    public let action: String
    /// What it acts on: a command, a path, a pattern, a URL.
    public let detail: String?
    /// Cut at 2000 characters; `inputLength` and `outputLength` are the whole lengths.
    public let input: String?
    public let output: String?
    public let inputLength: Int
    public let outputLength: Int
    public let result: Result

    public var cut: Bool { (input?.count ?? 0) < inputLength || (output?.count ?? 0) < outputLength }
  }

  public struct Request: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let turn: String
    public let lane: [String]
    public let type: String
    public let answered: Bool
  }

  public struct Notice: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    /// Inside a turn, or nil between turns.
    public let turn: String?
    public let lane: [String]
    public let text: String
    /// "normal" or "error".
    public let tone: String
    /// A line across the conversation rather than a sentence.
    public let divider: Bool
  }

  public struct Outcome: Codable, Sendable, Equatable, Identifiable {
    public enum Kind: String, OpenEnum {
      case completed, aborted, failed
      public static let fallback = Kind.completed
    }
    public let id: String
    public let turn: String
    public let outcome: Kind
    public let reason: String?
    public let failure: String?
  }

  private enum CodingKeys: String, CodingKey { case kind, id }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    let kind = try c.decode(String.self, forKey: .kind)
    let id = try c.decode(String.self, forKey: .id)
    let one = try decoder.singleValueContainer()
    // One item this app can't read shows as nothing; failing here would lose the whole delta,
    // which the kit has already moved past.
    do {
      switch kind {
      case "input": self = .input(try one.decode(Input.self))
      case "turn": self = .turn(try one.decode(Turn.self))
      case "text": self = .text(try one.decode(Text.self))
      case "reasoning": self = .reasoning(try one.decode(Reasoning.self))
      case "tool": self = .tool(try one.decode(Tool.self))
      case "request": self = .request(try one.decode(Request.self))
      case "notice": self = .notice(try one.decode(Notice.self))
      case "outcome": self = .outcome(try one.decode(Outcome.self))
      default: self = .unknown(id: id)
      }
    } catch {
      logger.error("transcript.item_unreadable \(kind, privacy: .public): \(String(describing: error), privacy: .public)")
      self = .unknown(id: id)
    }
  }

  public var id: String {
    switch self {
    case .input(let item): item.id
    case .turn(let item): item.id
    case .text(let item): item.id
    case .reasoning(let item): item.id
    case .tool(let item): item.id
    case .request(let item): item.id
    case .notice(let item): item.id
    case .outcome(let item): item.id
    case .unknown(let id): id
    }
  }

  /// The turn an item belongs to; nil for inputs, turn headers and notes between turns.
  public var turn: String? {
    switch self {
    case .text(let item): item.turn
    case .reasoning(let item): item.turn
    case .tool(let item): item.turn
    case .request(let item): item.turn
    case .notice(let item): item.turn
    case .outcome(let item): item.turn
    case .input, .turn, .unknown: nil
    }
  }
}

/// What changed after the kit folded more of the log.
public struct TranscriptDelta: Sendable, Decodable {
  /// Drop every item first: this is the whole transcript.
  public let reset: Bool
  /// The last entry folded: where agents.watch resumes.
  public let head: Int
  public let first: Int
  /// Older turns exist before these.
  public let hasMore: Bool
  /// The item ids in order, when the order changed.
  public let order: [String]?
  public let items: [TranscriptItem]
}

/// An agent's words for its state, from the kit (src/shared/describe.ts).
public struct StateWords: Sendable, Equatable, Codable {
  /// error, success, accent, warning, neutral.
  public let tone: String
  public let label: String
  public let pulsing: Bool

  public init(tone: String, label: String, pulsing: Bool) {
    self.tone = tone
    self.label = label
    self.pulsing = pulsing
  }

  /// Plain words from attention alone, until the kit has been loaded.
  public static func basic(_ attention: Attention) -> StateWords {
    switch attention {
    case .blocked: StateWords(tone: "error", label: "Needs you", pulsing: true)
    case .done: StateWords(tone: "success", label: "Finished", pulsing: false)
    case .working: StateWords(tone: "accent", label: "Working", pulsing: true)
    case .idle: StateWords(tone: "neutral", label: "Idle", pulsing: false)
    }
  }
}

/// Where and how a new agent starts (D-023), from the kit's resolveSetup.
public struct AgentSetup: Codable, Sendable, Equatable {
  public var workspaceId: String?
  public var runtime: String?
  public var model: String?
  public var effort: String?
  /// Fast mode's tier, or "default" for off (D-049); nil leaves it to the runtime's settings.
  public var serviceTier: String?
  /// In a new worktree of the workspace.
  public var isolate: Bool

  public init(
    workspaceId: String?, runtime: String?, model: String?, effort: String?, serviceTier: String? = nil, isolate: Bool
  ) {
    self.workspaceId = workspaceId
    self.runtime = runtime
    self.model = model
    self.effort = effort
    self.serviceTier = serviceTier
    self.isolate = isolate
  }
}

/// A review comment, as the kit's feedback compiler reads them (src/shared/feedback.ts).
public struct ReviewComment: Codable, Sendable, Equatable, Identifiable {
  public struct Source: Codable, Sendable, Equatable {
    /// "diff" or "transcript".
    public let kind: String
    public let path: String?
    public let scope: String?
    public let side: String?
    public let line: Int?
    public let text: String?
    public let agentId: String?
    public let quote: String?

    public static func diff(path: String, scope: DiffScope, side: String, line: Int, text: String) -> Source {
      Source(kind: "diff", path: path, scope: scope.rawValue, side: side, line: line, text: text, agentId: nil, quote: nil)
    }

    public static func transcript(agentId: String, quote: String) -> Source {
      Source(kind: "transcript", path: nil, scope: nil, side: nil, line: nil, text: nil, agentId: agentId, quote: quote)
    }
  }
  public let id: String
  public let workspaceId: String
  public let source: Source
  public var comment: String
  public let createdAt: Millis

  public init(workspaceId: String, source: Source, comment: String) {
    id = UUID().uuidString
    self.workspaceId = workspaceId
    self.source = source
    self.comment = comment
    createdAt = Date().millis
  }
}
