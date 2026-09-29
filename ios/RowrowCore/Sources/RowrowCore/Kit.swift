import Foundation
import JavaScriptCore

/// The server's own folds, run in JavaScriptCore (docs/decisions.md, D-027). The app never
/// interprets the agent log itself: it downloads the kit from the server it talks to
/// (/kit.js, the same code its web app runs) and asks it. An actor, so a long transcript
/// folds off the main thread; JavaScript values never leave it, only JSON text and the
/// Swift values decoded from it.
public actor Kit {
  /// The transcript item shape this app reads (TRANSCRIPT_MODEL_VERSION).
  public static let supportedVersion = 1

  private let context: JSContext
  private let kit: JSValue

  public init(source: String) throws {
    guard let context = JSContext() else { throw RowrowError.unreadable("JavaScriptCore is unavailable.") }
    context.name = "rowrow kit"
    self.context = context
    var failure: String?
    context.exceptionHandler = { _, exception in
      failure = exception?.toString() ?? "unknown JavaScript error"
    }
    context.evaluateScript(source)
    guard failure == nil, let kit = context.objectForKeyedSubscript("rowrowKit"), kit.isObject else {
      throw RowrowError.unreadable("rowrow's kit didn't load (\(failure ?? "no rowrowKit")): update rowrow on your computer.")
    }
    let version = Int(kit.objectForKeyedSubscript("version")?.toInt32() ?? 0)
    guard version == Kit.supportedVersion else {
      throw RowrowError.unreadable(
        version > Kit.supportedVersion
          ? "rowrow on your computer is newer than this app: update the app."
          : "rowrow on your computer is too old for this app: update it (npm install -g rowrow).")
    }
    self.kit = kit
    context.exceptionHandler = nil
  }

  /// Calls one of the kit's functions; a JavaScript exception becomes a Swift error.
  private func invoke(_ name: String, _ arguments: [Any]) throws -> JSValue {
    var failure: String?
    context.exceptionHandler = { _, exception in failure = exception?.toString() ?? "unknown JavaScript error" }
    defer { context.exceptionHandler = nil }
    let result = kit.invokeMethod(name, withArguments: arguments)
    if let failure {
      logger.error("kit.\(name, privacy: .public) failed: \(failure, privacy: .public)")
      throw RowrowError.unreadable("The transcript couldn't be read (\(failure)).")
    }
    guard let result else { throw RowrowError.unreadable("The kit's \(name) returned nothing.") }
    return result
  }

  private func string(_ name: String, _ arguments: [Any]) throws -> String {
    try invoke(name, arguments).toString() ?? ""
  }

  private func delta(_ json: String) throws -> TranscriptDelta {
    try JSONDecoder().decode(TranscriptDelta.self, from: Data(json.utf8))
  }

  // ─── Transcripts ───────────────────────────────────────────────────────────

  /// A transcript for one agent; `runtime` says how to read its tool calls.
  public func open(runtime: String) throws -> Int {
    Int(try invoke("open", [runtime]).toInt32())
  }

  /// Start from an agents.entries page (its JSON text).
  public func load(_ handle: Int, page: Data) throws -> TranscriptDelta {
    try delta(string("load", [handle, String(decoding: page, as: UTF8.self)]))
  }

  /// An agents.watch message (its JSON text: `{entries}`).
  public func append(_ handle: Int, batch: String) throws -> TranscriptDelta {
    try delta(string("append", [handle, batch]))
  }

  /// Older turns (agents.entries with `before`), in front of what it has.
  public func prepend(_ handle: Int, page: Data) throws -> TranscriptDelta {
    try delta(string("prepend", [handle, String(decoding: page, as: UTF8.self)]))
  }

  /// One item whole (a tool's input and output uncut).
  public func item(_ handle: Int, id: String) throws -> TranscriptItem? {
    let json = try string("item", [handle, id])
    return json == "null" ? nil : try JSONDecoder().decode(TranscriptItem.self, from: Data(json.utf8))
  }

  /// The transcript as plain text (what `rowrow agent view` prints).
  public func text(_ handle: Int) throws -> String {
    try string("text", [handle])
  }

  public func close(_ handle: Int) {
    _ = try? invoke("close", [handle])
  }

  // ─── Words, setups, feedback ───────────────────────────────────────────────

  /// Every agent's state in words (`agents` is AppState.agents as JSON text).
  public func describe(agents: Data, now: Date) throws -> [String: StateWords] {
    let json = try string("describe", [String(decoding: agents, as: UTF8.self), now.millis])
    return try JSONDecoder().decode([String: StateWords].self, from: Data(json.utf8))
  }

  public enum SetupContext: Sendable {
    case agent(String)
    case workspace(String)
    case anywhere

    var json: String {
      switch self {
      case .agent(let id): #"{"kind":"agent","agentId":"\#(id)"}"#
      case .workspace(let id): #"{"kind":"workspace","workspaceId":"\#(id)"}"#
      case .anywhere: #"{"kind":"anywhere"}"#
      }
    }
  }

  /// Where and how a new agent starts, from the app state, the place it's started from, and
  /// what this device remembers (`prefs`, kept by the app as the kit wrote it).
  public func resolveSetup(state: Data, context: SetupContext, prefs: String?) throws -> AgentSetup {
    let json = try string(
      "resolveSetup", [String(decoding: state, as: UTF8.self), context.json, prefs ?? NSNull()])
    return try JSONDecoder().decode(AgentSetup.self, from: Data(json.utf8))
  }

  /// What to remember after starting an agent in a workspace: the new preferences.
  public func remember(prefs: String?, workspaceId: String, setup: AgentSetup) throws -> String {
    let setupJSON = String(decoding: try JSONEncoder().encode(setup), as: UTF8.self)
    return try string("remember", [prefs ?? NSNull(), workspaceId, setupJSON])
  }

  /// The review message comments compile into.
  public func feedback(_ comments: [ReviewComment]) throws -> String {
    try string("feedback", [String(decoding: try JSONEncoder().encode(comments), as: UTF8.self)])
  }
}
