import Foundation
import Observation

/// One row of a conversation on screen: something you sent, a note between turns, or a turn.
public enum TranscriptRow: Sendable, Equatable, Identifiable {
  case input(TranscriptItem.Input)
  case note(TranscriptItem.Notice)
  case turn(TurnGroup)

  public var id: String {
    switch self {
    case .input(let input): input.id
    case .note(let note): note.id
    case .turn(let turn): turn.id
    }
  }
}

/// A turn and everything in it: text, thoughts, tool calls and notices in order, then how it ended.
public struct TurnGroup: Sendable, Equatable, Identifiable {
  public let id: String
  /// The runtime is still working on it.
  public let open: Bool
  public let parts: [TranscriptItem]
  public let outcome: TranscriptItem.Outcome?
}

/// An agent's conversation, live: the latest few turns from `agents.entries`, then every entry
/// after them from `agents.watch`, folded by the kit. It resumes from the last entry it folded
/// after every disconnect, so nothing is lost or shown twice (PRINCIPLES.md, engineering 2).
@MainActor
@Observable
public final class TranscriptStore {
  public let agentId: String
  public private(set) var rows: [TranscriptRow] = []
  public private(set) var loading = true
  public private(set) var hasMore = false
  public private(set) var loadingOlder = false
  public private(set) var error: String?
  /// The last entry folded.
  public private(set) var head = -1

  @ObservationIgnored private let session: Session
  @ObservationIgnored private let runtime: String
  @ObservationIgnored private var order: [String] = []
  @ObservationIgnored private var items: [String: TranscriptItem] = [:]
  @ObservationIgnored private var handle: Int?
  @ObservationIgnored private var task: Task<Void, Never>?
  @ObservationIgnored private var rebuildScheduled = false
  @ObservationIgnored private var first = -1

  /// How many turns to open with; older ones load on request.
  static let windowTurns = 4

  public init(agentId: String, runtime: String, session: Session) {
    self.agentId = agentId
    self.runtime = runtime
    self.session = session
  }

  /// Keep it live while it's on screen.
  public func start() {
    guard task == nil else { return }
    task = Task { [weak self] in await self?.run() }
  }

  public func stop() {
    task?.cancel()
    task = nil
  }

  /// Let go of the kit's copy (the store won't be used again).
  public func close() async {
    stop()
    if let handle { await session.kit?.close(handle) }
    handle = nil
  }

  private func run() async {
    var attempt = 0
    while !Task.isCancelled {
      do {
        let kit = await session.readyKit()
        if handle == nil {
          let opened = try await kit.open(runtime: runtime)
          handle = opened
          let page = try await session.api.raw(
            "agents.entries", EntriesInput(agentId: agentId, turns: Self.windowTurns))
          apply(try await kit.load(opened, page: page))
        }
        guard let handle else { continue }
        loading = false
        error = nil
        for try await batch in session.api.stream("agents.watch", WatchInput(agentId: agentId, after: head)) {
          attempt = 0
          apply(try await kit.append(handle, batch: batch))
        }
      } catch is CancellationError {
        return
      } catch {
        loading = false
        self.error = (error as? RowrowError)?.errorDescription ?? error.localizedDescription
        attempt += 1
        let delay = min(15.0, 0.5 * pow(2, Double(min(attempt, 5))))
        do { try await Task.sleep(for: .seconds(delay)) } catch { return }
      }
    }
  }

  /// Load the turns before the ones shown.
  public func loadOlder() async {
    guard hasMore, !loadingOlder, let handle, let kit = session.kit else { return }
    loadingOlder = true
    defer { loadingOlder = false }
    do {
      let page = try await session.api.raw(
        "agents.entries", EntriesInput(agentId: agentId, before: first, turns: Self.windowTurns))
      apply(try await kit.prepend(handle, page: page))
    } catch {
      self.error = (error as? RowrowError)?.errorDescription ?? error.localizedDescription
    }
  }

  /// An item whole (a tool call's input and output uncut).
  public func full(_ id: String) async -> TranscriptItem? {
    guard let handle, let kit = session.kit else { return items[id] }
    return (try? await kit.item(handle, id: id)) ?? items[id]
  }

  /// The conversation as plain text, to copy or share.
  public func plainText() async -> String? {
    guard let handle, let kit = session.kit else { return nil }
    return try? await kit.text(handle)
  }

  public func item(_ id: String) -> TranscriptItem? { items[id] }

  // ─── Deltas → rows ─────────────────────────────────────────────────────────

  private func apply(_ delta: TranscriptDelta) {
    if delta.reset {
      items = [:]
      order = []
    }
    for item in delta.items { items[item.id] = item }
    if let order = delta.order {
      self.order = order
      let keep = Set(order)
      items = items.filter { keep.contains($0.key) }
    }
    head = delta.head
    first = delta.first
    hasMore = delta.hasMore
    // A reset shows at once; streaming changes are drawn at most ten times a second.
    if delta.reset {
      rebuild()
    } else if !rebuildScheduled {
      rebuildScheduled = true
      Task {
        try? await Task.sleep(for: .milliseconds(100))
        rebuildScheduled = false
        rebuild()
      }
    }
  }

  private func rebuild() {
    rows = Self.rows(order: order, items: items)
  }

  /// Groups the kit's flat items into rows: a turn header and the items of that turn become one row.
  public nonisolated static func rows(order: [String], items: [String: TranscriptItem]) -> [TranscriptRow] {
    var rows: [TranscriptRow] = []
    var turn: (id: String, open: Bool, parts: [TranscriptItem], outcome: TranscriptItem.Outcome?)?
    func close() {
      if let turn { rows.append(.turn(TurnGroup(id: turn.id, open: turn.open, parts: turn.parts, outcome: turn.outcome))) }
      turn = nil
    }
    for id in order {
      guard let item = items[id] else { continue }
      switch item {
      case .turn(let header):
        close()
        turn = (header.id, header.open, [], nil)
      case .input(let input):
        close()
        rows.append(.input(input))
      case .notice(let notice) where notice.turn == nil:
        close()
        rows.append(.note(notice))
      case .outcome(let outcome) where outcome.turn == turn?.id:
        turn?.outcome = outcome
      case .unknown:
        break
      default:
        if let owner = item.turn, owner == turn?.id {
          turn?.parts.append(item)
        }
      }
    }
    close()
    return rows
  }
}

private struct EntriesInput: Encodable {
  let agentId: String
  var before: Int?
  let turns: Int

  init(agentId: String, before: Int? = nil, turns: Int) {
    self.agentId = agentId
    self.before = before
    self.turns = turns
  }
}

private struct WatchInput: Encodable {
  let agentId: String
  let after: Int
}
