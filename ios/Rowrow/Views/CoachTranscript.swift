import RowrowCore
import SwiftUI

/// A Coach chat's conversation, as the web app's Coach reads it (like roamgate's Ranger): each
/// message under "You" (or "Task prompt", for a task's run) or "Coach", its answer with the tools
/// it called folded under it, and the cards of the actions it proposed, confirmed here (D-045).
struct CoachTranscript: View {
  let store: TranscriptStore
  let chatId: String
  /// Coach is answering in this chat: its cards wait for it to finish.
  let working: Bool
  let session: Session
  @State private var inspecting: TranscriptItem.Tool?

  var body: some View {
    // One action at a time: while one runs, the others wait.
    let executing = store.rows.contains { if case .action(let action) = $0 { action.status == .executing } else { false } }
    LazyVStack(alignment: .leading, spacing: 18) {
      if store.hasMore {
        Button {
          Task { await store.loadOlder() }
        } label: {
          if store.loadingOlder { ProgressView() } else { Label("Earlier messages", systemImage: "arrow.up") }
        }
        .buttonStyle(.bordered)
        .frame(maxWidth: .infinity)
      }
      if store.rows.isEmpty && store.loading {
        ProgressView("Loading the conversation").frame(maxWidth: .infinity).padding(.top, 60)
      }
      ForEach(store.rows) { row in
        switch row {
        case .input(let input):
          CoachYou(input: input)
        case .note(let note):
          NoteLine(note: note)
        case .turn(let turn):
          CoachAnswer(turn: turn, onTool: { inspecting = $0 })
        case .action(let action):
          CoachActionCard(action: action, chatId: chatId, working: working, executing: executing, session: session)
        }
      }
      if let error = store.error {
        Label(error, systemImage: "exclamationmark.triangle").font(.footnote).foregroundStyle(.orange)
      }
    }
    .scrollTargetLayout()
    .onAppear { store.start() }
    .onDisappear { store.stop() }
    .sheet(item: $inspecting) { tool in
      ToolSheet(tool: tool, store: store)
    }
  }
}

/// "You" or "Coach", and when.
private struct CoachHead: View {
  let who: String
  var at: Millis?

  var body: some View {
    HStack {
      Text(who).font(.caption.weight(.semibold))
      Spacer()
      if let at {
        Text(Self.when(at)).font(.caption2).foregroundStyle(.secondary)
      }
    }
  }

  /// The time today, the day and time before.
  static func when(_ at: Millis) -> String {
    let date = Date(millis: at)
    return Calendar.current.isDateInToday(date)
      ? date.formatted(date: .omitted, time: .shortened) : CoachWords.at(at)
  }
}

/// What you asked Coach. A task's run asks with the task's prompt, which rowrow sends (D-050).
private struct CoachYou: View {
  let input: TranscriptItem.Input

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      // rowrow itself (the kit's word for the system) sends only a task's prompt to Coach.
      CoachHead(who: input.by == "rowrow" ? "Task prompt" : "You", at: input.at)
      Text(input.text)
        .textSelection(.enabled)
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.accentColor.opacity(0.12), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
      switch input.state {
      case .sending:
        Text("Sending…").font(.caption).foregroundStyle(.secondary)
      case .failed:
        Text("Not sent\(input.reason.map { ": \($0)" } ?? "")").font(.caption).foregroundStyle(.red)
      case .sent:
        EmptyView()
      }
    }
  }
}

/// Coach's answer: what it wrote, how the turn ended when not plainly, then "Work performed (N)":
/// the tools it called, each one open in full.
private struct CoachAnswer: View {
  let turn: TurnGroup
  let onTool: (TranscriptItem.Tool) -> Void

  var body: some View {
    let tools: [TranscriptItem.Tool] = turn.parts.compactMap { if case .tool(let tool) = $0 { tool } else { nil } }
    let said = turn.parts.contains { part in
      if case .text(let text) = part { !text.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty } else { false }
    }
    VStack(alignment: .leading, spacing: 8) {
      CoachHead(who: "Coach")
      ForEach(turn.parts) { part in
        switch part {
        case .text(let text):
          MarkdownView(text: text.text)
        case .notice(let notice):
          Text(notice.text).font(.caption).foregroundStyle(.secondary)
        default:
          EmptyView()
        }
      }
      if !said {
        if turn.open {
          Text("Working…").font(.footnote).foregroundStyle(.secondary)
        } else if turn.outcome?.outcome == .completed {
          Text("No response text was received.").font(.footnote).foregroundStyle(.secondary)
        }
      }
      if let outcome = turn.outcome {
        switch outcome.outcome {
        case .failed:
          Label("Failed: \(outcome.reason ?? "the runtime didn't say why")", systemImage: "exclamationmark.octagon.fill")
            .font(.subheadline)
            .foregroundStyle(.red)
        case .aborted:
          Text("You stopped it.").font(.footnote).foregroundStyle(.secondary)
        case .completed:
          EmptyView()
        }
      }
      if !tools.isEmpty {
        WorkPerformed(tools: tools, working: turn.open, onTool: onTool)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

/// The tools an answer called: open while Coach works, folded once it has answered.
private struct WorkPerformed: View {
  let tools: [TranscriptItem.Tool]
  let working: Bool
  let onTool: (TranscriptItem.Tool) -> Void
  @State private var open: Bool

  init(tools: [TranscriptItem.Tool], working: Bool, onTool: @escaping (TranscriptItem.Tool) -> Void) {
    self.tools = tools
    self.working = working
    self.onTool = onTool
    _open = State(initialValue: working)
  }

  var body: some View {
    let reading = working && tools.contains { $0.result == .running }
    DisclosureGroup(isExpanded: $open) {
      VStack(alignment: .leading, spacing: 0) {
        ForEach(tools) { tool in
          Button {
            onTool(tool)
          } label: {
            HStack(spacing: 8) {
              Text(CoachWords.toolLabel(tool.tool)).font(.footnote.weight(.medium))
              Spacer(minLength: 4)
              switch tool.result {
              case .running: ProgressView().controlSize(.mini)
              case .failed: Image(systemName: "xmark.circle.fill").foregroundStyle(.red).font(.caption)
              default: Image(systemName: "checkmark").foregroundStyle(.green).font(.caption2.weight(.bold))
              }
            }
            .padding(.vertical, 6)
            .contentShape(Rectangle())
          }
          .buttonStyle(.plain)
        }
      }
    } label: {
      Text("\(reading ? "Reading workspace context" : "Work performed") (\(tools.count))")
        .font(.caption)
        .foregroundStyle(.secondary)
    }
    .onChange(of: working) { _, now in open = now }
  }
}

/// One action Coach proposed (D-045), as the web app's card shows it: the operation and its
/// state, its target and every frozen parameter, the exact text it sends with its length, and
/// what rowrow says about it, "Waiting for your confirmation. Nothing has been executed." until
/// you Confirm or Cancel, then rowrow's receipt. Confirm waits until Coach has answered, one
/// action at a time. A task Coach proposed (D-050) has its own card, confirmable while it answers.
struct CoachActionCard: View {
  let action: TranscriptItem.Action
  let chatId: String
  let working: Bool
  let executing: Bool
  let session: Session
  @State private var deciding: Decision?
  @State private var problem: String?

  private enum Decision { case confirm, cancel }

  var body: some View {
    let pending = action.status == .pending
    VStack(alignment: .leading, spacing: 10) {
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        Text(action.isTask ? (action.params.title ?? action.name) : action.name)
          .font(.subheadline.weight(.semibold))
        Spacer(minLength: 8)
        Pill(text: action.statusLabel, color: tint)
      }
      if action.isTask {
        taskBody(pending: pending)
      } else if action.action == "create_worktree" {
        Text(action.summary).font(.footnote)
        details
      } else {
        agentBody(pending: pending)
      }
      if !(action.isTask && pending) {
        Text(action.detail)
          .font(.footnote)
          .foregroundStyle(action.status == .failed ? Color.red : action.status == .uncertain ? .orange : .secondary)
      }
      if pending {
        buttons
      }
      if let problem {
        Text(problem).font(.caption).foregroundStyle(.red)
      }
    }
    .padding(12)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(.fill.quinary, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    .overlay { RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(.quaternary) }
    .accessibilityElement(children: .contain)
    .accessibilityLabel(action.isTask ? "Task proposal" : "\(action.name) action")
  }

  private var tint: Color {
    switch action.status {
    case .pending, .executing: .accentColor
    case .succeeded: .green
    case .failed: .red
    case .uncertain: .orange
    case .cancelled: .secondary
    }
  }

  /// Who it goes to: the agent's name and id, or the runtime a new one starts on.
  private var target: [String] {
    var parts: [String] = []
    if let agentId = action.agentId {
      parts.append(action.agentTitle ?? "Untitled")
      parts.append(agentId)
    }
    if let runtime = action.params.runtimeName { parts.append(runtime) }
    return parts
  }

  /// Start an agent or send one a message: where, to whom, and the exact text.
  @ViewBuilder
  private func agentBody(pending: Bool) -> some View {
    VStack(alignment: .leading, spacing: 2) {
      Text(action.workspaceLabel).font(.subheadline.weight(.semibold))
      if !target.isEmpty {
        Text(target.joined(separator: " · ")).font(.caption).foregroundStyle(.secondary)
      }
    }
    if action.action == "start_agent", let title = action.params.title {
      Text("Name: \(title)").font(.footnote).foregroundStyle(.secondary)
    }
    if pending {
      Text(
        action.action == "send_prompt"
          ? "Review before sending. The agent may change files." : "Review before starting. The new agent may change files."
      )
      .font(.footnote)
      .foregroundStyle(.secondary)
    }
    ExactText(
      label: action.action == "send_prompt" ? "Prompt" : "First message", text: action.params.prompt ?? "",
      open: pending || action.status == .executing)
    DisclosureGroup {
      VStack(alignment: .leading, spacing: 8) {
        Text(action.summary).font(.footnote).foregroundStyle(.secondary)
        details
      }
      .padding(.top, 4)
    } label: {
      Text("Details \(CoachWords.at(action.proposedAt))").font(.caption).foregroundStyle(.secondary)
    }
  }

  /// A scheduled task: its schedule, its prompt, how it notifies.
  @ViewBuilder
  private func taskBody(pending: Bool) -> some View {
    if let schedule = action.params.schedule {
      Text(schedule.label()).font(.footnote)
    }
    Text("Each run reads the workspaces Coach may read then.").font(.caption).foregroundStyle(.secondary)
    ExactText(label: "Task prompt", text: action.params.prompt ?? "", open: false)
    Text((action.params.notify ?? .every).label).font(.caption).foregroundStyle(.secondary)
    if pending {
      Text("Confirm to enable this task. Workspace actions still need your confirmation.")
        .font(.footnote)
        .foregroundStyle(.secondary)
    }
  }

  /// Every frozen parameter, as the card lists them.
  private var details: some View {
    Grid(alignment: .leading, horizontalSpacing: 10, verticalSpacing: 4) {
      ForEach(rows, id: \.0) { term, value in
        GridRow {
          Text(term).foregroundStyle(.secondary)
          Text(value).textSelection(.enabled)
        }
      }
    }
    .font(.caption)
    .padding(8)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(.fill.quinary, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
  }

  private var rows: [(String, String)] {
    let p = action.params
    var rows = [("Workspace", "\(action.workspaceLabel) \(action.workspaceId)")]
    if let agentId = action.agentId { rows.append(("Agent", "\(action.agentTitle ?? "Untitled") \(agentId)")) }
    rows.append(("Proposed", CoachWords.at(action.proposedAt)))
    switch action.action {
    case "create_worktree":
      rows.append(("Branch", p.branch ?? ""))
      rows.append(("Base branch", p.base ?? ""))
      rows.append(("Setup hook", p.setupHook ?? "(none configured)"))
      rows.append(("Source repository", p.sourcePath ?? ""))
    case "start_agent":
      rows.append(("Runtime", "\(p.runtimeName ?? p.runtime ?? "") (\(p.runtime ?? ""))"))
      rows.append(("Name", p.title ?? "(from its first message)"))
    default:
      break
    }
    return rows
  }

  @ViewBuilder
  private var buttons: some View {
    // A task may be confirmed while Coach answers; an action waits for the answer and for one running.
    let waits = !action.isTask && working
    VStack(alignment: .leading, spacing: 6) {
      HStack(spacing: 8) {
        Button {
          Task { await decide(.confirm) }
        } label: {
          HStack(spacing: 6) {
            if deciding == .confirm { ProgressView().controlSize(.small) }
            Text(action.isTask ? "Confirm task" : "Confirm action")
          }
        }
        .buttonStyle(.borderedProminent)
        .disabled(deciding != nil || waits || (!action.isTask && executing))
        Button("Cancel") {
          Task { await decide(.cancel) }
        }
        .buttonStyle(.bordered)
        .disabled(deciding != nil || waits)
      }
      if waits {
        Text("Wait for Coach to finish before confirming or cancelling an action.")
          .font(.caption)
          .foregroundStyle(.secondary)
      }
    }
  }

  private func decide(_ decision: Decision) async {
    deciding = decision
    problem = nil
    defer { deciding = nil }
    do {
      switch decision {
      case .confirm: try await session.api.coachConfirm(chatId: chatId, actionId: action.actionId)
      case .cancel: try await session.api.coachCancel(chatId: chatId, actionId: action.actionId)
      }
    } catch is CancellationError {
    } catch {
      problem = (error as? RowrowError)?.errorDescription ?? error.localizedDescription
    }
  }
}

/// The exact text an action sends, with how long it is: open while it waits for you.
private struct ExactText: View {
  let label: String
  let text: String
  /// Open while it waits for you; yours to open or close in between.
  let wanted: Bool
  @State private var open: Bool

  init(label: String, text: String, open: Bool) {
    self.label = label
    self.text = text
    wanted = open
    _open = State(initialValue: open)
  }

  var body: some View {
    DisclosureGroup(isExpanded: $open) {
      Text(text)
        .font(.system(.footnote, design: .monospaced))
        .textSelection(.enabled)
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.fill.quinary, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .padding(.top, 4)
        .accessibilityLabel("Exact \(label.lowercased())")
    } label: {
      Text("\(label) — \(CoachWords.characters(text))").font(.caption).foregroundStyle(.secondary)
    }
    .onChange(of: wanted) { _, now in open = now }
  }
}
