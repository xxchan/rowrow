import RowrowCore
import SwiftUI

/// One turn of the agent, read on a phone: the answer in full, and the work that led to it
/// (commands, edits, reads, thinking, text along the way) folded into one line that says what
/// happened, or what is happening now. The work opens in place; a step opens its details.
struct TurnView: View {
  let turn: TurnGroup
  let runtime: String
  let onTool: (TranscriptItem.Tool) -> Void
  @State private var expanded = false

  var body: some View {
    let split = Split(turn)
    VStack(alignment: .leading, spacing: 12) {
      if !split.work.isEmpty || (turn.open && split.answer.isEmpty) {
        WorkSummary(work: split.work, open: turn.open, expanded: $expanded)
        if expanded {
          WorkSteps(parts: split.work, onTool: onTool)
            .transition(.opacity.combined(with: .move(edge: .top)))
        }
      }
      ForEach(split.answer) { part in
        if case .text(let text) = part {
          MarkdownView(text: text.text)
        }
      }
      if let outcome = turn.outcome {
        OutcomeLine(outcome: outcome)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  /// The answer: the agent's own text after its last step. Everything before it is the work.
  struct Split {
    let work: [TranscriptItem]
    let answer: [TranscriptItem]

    init(_ turn: TurnGroup) {
      let isAnswer: (TranscriptItem) -> Bool = { item in
        if case .text(let text) = item { return text.lane.isEmpty }
        return false
      }
      let lastStep = turn.parts.lastIndex { !isAnswer($0) }
      if let lastStep {
        work = Array(turn.parts[...lastStep])
        answer = Array(turn.parts[(lastStep + 1)...])
      } else {
        work = []
        answer = turn.parts
      }
    }
  }
}

/// "Ran 3 commands, edited 2 files · 11 steps", or while it works, what it's doing now.
private struct WorkSummary: View {
  let work: [TranscriptItem]
  let open: Bool
  @Binding var expanded: Bool

  var body: some View {
    Button {
      withAnimation(.snappy) { expanded.toggle() }
    } label: {
      HStack(spacing: 10) {
        if open {
          ProgressView().controlSize(.small)
        } else {
          Image(systemName: "checklist").foregroundStyle(.secondary)
        }
        VStack(alignment: .leading, spacing: 1) {
          Text(headline).font(.subheadline.weight(.medium)).lineLimit(1)
          if let detail {
            Text(detail).font(.caption).foregroundStyle(.secondary).lineLimit(1)
          }
        }
        Spacer(minLength: 0)
        Image(systemName: "chevron.right")
          .font(.caption.weight(.semibold))
          .foregroundStyle(.tertiary)
          .rotationEffect(.degrees(expanded ? 90 : 0))
      }
      .padding(.horizontal, 12)
      .padding(.vertical, 9)
      .background(.fill.quinary, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityHint(expanded ? "Hides the steps" : "Shows every step")
  }

  private var tools: [TranscriptItem.Tool] {
    work.compactMap { if case .tool(let tool) = $0 { tool } else { nil } }
  }

  /// While working: the step in progress. After: what the steps did, counted.
  private var headline: String {
    if open, let last = work.last {
      switch last {
      case .tool(let tool) where tool.result == .running: return running(tool)
      case .reasoning(let thought) where thought.streaming: return "Thinking…"
      case .text(let text) where text.streaming: return "Writing…"
      default: return "Working…"
      }
    }
    if open { return "Working…" }
    let counts = Dictionary(grouping: tools, by: \.action).mapValues(\.count)
    // Tools no runtime table knows: by name when there are few of them.
    let others = tools.filter { $0.action == "mcp" || $0.action == "other" }
    let otherNames = Array(Set(others.map(\.tool))).sorted()
    let phrases = [
      counts["run_command"].map { "ran \($0) command\($0 == 1 ? "" : "s")" },
      counts["edit_file"].map { "edited \($0) file\($0 == 1 ? "" : "s")" },
      counts["read_file"].map { "read \($0) file\($0 == 1 ? "" : "s")" },
      counts["search"].map { "searched \($0) time\($0 == 1 ? "" : "s")" },
      counts["web"].map { "\($0) web lookup\($0 == 1 ? "" : "s")" },
      others.isEmpty
        ? nil
        : otherNames.count <= 2 ? "used \(otherNames.joined(separator: " and "))" : "used \(others.count) tools",
    ].compactMap { $0 }
    if phrases.isEmpty {
      return work.contains { if case .reasoning = $0 { true } else { false } } ? "Thought it over" : "Worked on it"
    }
    let sentence = phrases.joined(separator: ", ")
    return sentence.prefix(1).uppercased() + sentence.dropFirst()
  }

  private var detail: String? {
    let failed = tools.filter { $0.result == .failed }.count
    var parts = ["\(work.count) step\(work.count == 1 ? "" : "s")"]
    if failed > 0 { parts.append("\(failed) failed") }
    if open, let last = tools.last(where: { $0.result != .running }), let detail = last.detail {
      parts.append("last: \(detail)")
    }
    return parts.joined(separator: " · ")
  }

  private func running(_ tool: TranscriptItem.Tool) -> String {
    let what = tool.detail.map { " \($0)" } ?? ""
    switch tool.action {
    case "run_command": return "Running\(what)"
    case "edit_file": return "Editing\(what)"
    case "read_file": return "Reading\(what)"
    case "search": return "Searching\(what)"
    case "web": return "On the web\(what)"
    default: return "Using \(tool.tool)"
    }
  }
}

/// Every step of the work, in order.
private struct WorkSteps: View {
  let parts: [TranscriptItem]
  let onTool: (TranscriptItem.Tool) -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 2) {
      ForEach(Array(parts.enumerated()), id: \.element.id) { index, part in
        let lane = lane(of: part)
        if let lane, lane != self.lane(of: index == 0 ? nil : parts[index - 1]) {
          Label("Sub-agent \(lane)", systemImage: "arrow.turn.down.right")
            .font(.caption.weight(.medium))
            .foregroundStyle(.secondary)
            .padding(.top, 6)
        }
        StepRow(part: part, onTool: onTool)
          .padding(.leading, lane == nil ? 0 : 14)
      }
    }
    .padding(.leading, 6)
    .overlay(alignment: .leading) { Rectangle().fill(.quaternary).frame(width: 1.5) }
  }

  private func lane(of part: TranscriptItem?) -> String? {
    let path: [String] =
      switch part {
      case .text(let item): item.lane
      case .reasoning(let item): item.lane
      case .tool(let item): item.lane
      case .request(let item): item.lane
      case .notice(let item): item.lane
      default: []
      }
    return path.isEmpty ? nil : path.joined(separator: " / ")
  }
}

private struct StepRow: View {
  let part: TranscriptItem
  let onTool: (TranscriptItem.Tool) -> Void
  @State private var open = false

  var body: some View {
    switch part {
    case .tool(let tool):
      Button {
        onTool(tool)
      } label: {
        HStack(spacing: 8) {
          Image(systemName: symbol(tool.action)).frame(width: 18).foregroundStyle(.secondary)
          Text(tool.tool).font(.footnote.monospaced().weight(.medium))
          if let detail = tool.detail {
            Text(detail).font(.footnote.monospaced()).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
          }
          Spacer(minLength: 4)
          switch tool.result {
          case .running: ProgressView().controlSize(.mini)
          case .failed: Image(systemName: "xmark.circle.fill").foregroundStyle(.red).font(.caption)
          default: Image(systemName: "checkmark").foregroundStyle(.green).font(.caption2.weight(.bold))
          }
        }
        .padding(.vertical, 6)
        .padding(.horizontal, 8)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
    case .reasoning(let thought):
      Button {
        withAnimation(.snappy) { open.toggle() }
      } label: {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
          Image(systemName: "brain").frame(width: 18).foregroundStyle(.secondary)
          Text(thought.text.map { open ? $0 : oneLine($0) } ?? (thought.streaming ? "Thinking…" : hidden(thought)))
            .font(.footnote)
            .italic()
            .foregroundStyle(.secondary)
            .lineLimit(open ? nil : 2)
            .multilineTextAlignment(.leading)
        }
        .padding(.vertical, 6)
        .padding(.horizontal, 8)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
    case .text(let text):
      MarkdownView(text: text.text, font: .footnote)
        .padding(.vertical, 6)
        .padding(.horizontal, 8)
        .foregroundStyle(.secondary)
    case .notice(let notice):
      Label(notice.text, systemImage: "info.circle")
        .font(.caption)
        .foregroundStyle(.secondary)
        .padding(.vertical, 4)
        .padding(.horizontal, 8)
    case .request(let request):
      Label(
        request.answered
          ? "It asked (\(request.type)); rowrow answered."
          : request.cancelled == true
            ? "It asked (\(request.type)), then took it back."
            : "It's asking for something rowrow can't answer yet (\(request.type)).",
        systemImage: "questionmark.bubble"
      )
      .font(.footnote)
      .padding(8)
      .background(.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 10))
    default:
      EmptyView()
    }
  }

  /// Hidden thoughts back to back are one row: "Thought (hidden) ×7".
  private func hidden(_ thought: TranscriptItem.Reasoning) -> String {
    let count = thought.count ?? 1
    return count > 1 ? "Thought (hidden) ×\(count)" : "Thought (hidden)"
  }

  private func symbol(_ action: String) -> String {
    switch action {
    case "run_command": "terminal"
    case "edit_file": "pencil"
    case "read_file": "doc.text"
    case "search": "magnifyingglass"
    case "web": "globe"
    case "mcp": "puzzlepiece.extension"
    default: "wrench.adjustable"
    }
  }
}

private struct OutcomeLine: View {
  let outcome: TranscriptItem.Outcome

  var body: some View {
    switch outcome.outcome {
    case .failed:
      Label("Failed: \(outcome.reason ?? "the runtime didn't say why")", systemImage: "exclamationmark.octagon.fill")
        .font(.subheadline)
        .foregroundStyle(.red)
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.red.opacity(0.1), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    case .aborted:
      Label("Stopped", systemImage: "stop.circle").font(.caption).foregroundStyle(.secondary)
    case .completed:
      EmptyView()
    }
  }
}

/// A tool call in full: what the agent asked for and what came back.
struct ToolSheet: View {
  let tool: TranscriptItem.Tool
  let store: TranscriptStore
  @Environment(\.dismiss) private var dismiss
  @State private var full: TranscriptItem.Tool?

  var body: some View {
    let shown = full ?? tool
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 18) {
          if let detail = shown.detail {
            Text(detail).font(.callout.monospaced()).textSelection(.enabled)
          }
          if let input = shown.input, !input.isEmpty {
            Section(title: shown.action == "run_command" ? "Command" : "Input", text: presentInput(shown, input))
          }
          if let output = shown.output, !output.isEmpty {
            Section(title: shown.result == .failed ? "Output (failed)" : "Output", text: output)
          } else if shown.result == .running {
            ProgressView("Running…")
          }
          if shown.cut && full == nil {
            ProgressView("Loading the rest…")
          }
        }
        .padding()
        .frame(maxWidth: .infinity, alignment: .leading)
      }
      .navigationTitle(tool.tool)
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
      }
      .task {
        if tool.cut, case .tool(let whole) = await store.full(tool.id) { full = whole }
      }
    }
    .presentationDetents([.medium, .large])
  }

  /// A command as `$ command`; a file edit as what it wrote; anything else as its input, pretty.
  private func presentInput(_ tool: TranscriptItem.Tool, _ input: String) -> String {
    guard let data = input.data(using: .utf8), let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else { return input }
    func field(_ names: String...) -> String? {
      for name in names {
        if let value = object[name] as? String { return value }
        if let list = object[name] as? [String] { return list.joined(separator: " ") }
      }
      return nil
    }
    if tool.action == "run_command", let command = field("command", "cmd") { return "$ \(command)" }
    if tool.action == "edit_file", let written = field("content", "new_string", "patch", "diff") { return written }
    guard let pretty = try? JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys]) else {
      return input
    }
    return String(decoding: pretty, as: UTF8.self)
  }

  private struct Section: View {
    let title: String
    let text: String

    var body: some View {
      VStack(alignment: .leading, spacing: 6) {
        HStack {
          Text(title).font(.caption.weight(.semibold)).foregroundStyle(.secondary).textCase(.uppercase)
          Spacer()
          Button {
            UIPasteboard.general.string = text
          } label: {
            Label("Copy", systemImage: "doc.on.doc").font(.caption)
          }
          .buttonStyle(.borderless)
        }
        ScrollView(.horizontal) {
          Text(text)
            .font(.system(.footnote, design: .monospaced))
            .textSelection(.enabled)
            .fixedSize(horizontal: true, vertical: false)
            .padding(10)
        }
        .background(.fill.quinary, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
      }
    }
  }
}
