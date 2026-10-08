import RowrowCore
import SwiftUI

/// Writing to an agent. Return is a newline (dictation and IME need it); the button sends.
/// While the agent works, the button queues (D-035): the message waits above the composer until
/// the turn ends, and until then you can edit, send now or delete it. Hold the button to steer
/// into the turn instead (it can't be taken back), or to stop the turn and send.
/// A send that may not have arrived keeps its id, so sending again can't deliver it twice.
struct Composer: View {
  let agent: AgentState
  let session: Session
  /// In the quick reply sheet: quick replies always show, and nothing to attach.
  var compact = false
  var onSent: (() -> Void)?

  @Environment(AppModel.self) private var model
  @FocusState private var focused: Bool
  @State private var pending: (text: String, inputId: String)?
  @State private var note: (text: String, error: Bool)?
  @State private var sending = false
  @State private var skills: SkillList?
  @State private var sent = 0
  /// A queued message you deleted, until you undo it or send something else.
  @State private var deleted: Withdrawn?

  private var draft: Binding<String> {
    Binding(get: { model.drafts[agent.id] ?? "" }, set: { model.drafts[agent.id] = $0 })
  }

  private var typedCommand: String? {
    let text = draft.wrappedValue
    guard text.hasPrefix("/"), !text.contains(where: \.isWhitespace) else { return nil }
    return String(text.dropFirst())
  }

  var body: some View {
    let working = agent.attention == .working
    let empty =
      draft.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      && (model.attachments[agent.id] ?? []).isEmpty
    VStack(alignment: .leading, spacing: 8) {
      if let typed = typedCommand {
        CommandList(typed: typed, skills: skills) { name in
          draft.wrappedValue = "/\(name) "
        }
        .task(id: agent.id) {
          guard skills == nil else { return }
          skills = (try? await session.api.skills(runtime: agent.summary.runtime, workspaceId: agent.summary.workspaceId))
            ?? SkillList(skills: [], error: "Couldn't load commands.")
        }
      }
      if let deleted {
        HStack {
          Label(deleted.text.isEmpty ? "Deleted" : "Deleted “\(firstLine(deleted.text))”", systemImage: "trash")
            .lineLimit(1)
          Spacer()
          Button("Undo") {
            putBack(deleted)
            self.deleted = nil
          }
        }
        .font(.footnote)
        .foregroundStyle(.secondary)
        .padding(.horizontal, 6)
      }
      QueueTray(agent: agent, session: session, putBack: putBack) { taken in
        deleted = taken
      } fail: { message in
        note = (message, true)
      }
      if let note {
        Label(note.text, systemImage: note.error ? "exclamationmark.circle" : "clock")
          .font(.footnote)
          .foregroundStyle(note.error ? Color.red : .secondary)
          .padding(.horizontal, 6)
      }
      if empty && (focused || compact), let replies = session.state?.settings.quickReplies, !replies.isEmpty {
        QuickReplyChips(replies: replies) { reply in
          draft.wrappedValue = reply
          focused = true
        }
      }
      PendingTiles(key: agent.id)
      HStack(alignment: .bottom, spacing: 8) {
        if !compact {
          AttachButton(key: agent.id, session: session) {
            Section {
              Button {
                draft.wrappedValue = "/"
                focused = true
              } label: {
                Label("Command", systemImage: "slash.circle")
              }
            }
          }
          .disabled(agent.summary.archived)
        }
        TextField(working ? "Queue a message for after this turn" : "Message", text: draft, axis: .vertical)
          .lineLimit(1...8)
          .focused($focused)
          .padding(.vertical, 7)
          .disabled(agent.summary.archived)
        if working && empty {
          Button {
            Task { await stopTurn() }
          } label: {
            Image(systemName: "stop.circle.fill").font(.system(size: 30)).symbolRenderingMode(.hierarchical)
          }
          .tint(.red)
          .accessibilityLabel("Stop the turn")
        } else {
          sendButton(working: working, empty: empty)
        }
      }
      .padding(.leading, compact ? 14 : 6)
      .padding(.trailing, 6)
      .padding(.vertical, 4)
      .glassEffect(.regular.interactive(), in: RoundedRectangle(cornerRadius: 24, style: .continuous))
    }
    .sensoryFeedback(.success, trigger: sent)
  }

  @ViewBuilder
  private func sendButton(working: Bool, empty: Bool) -> some View {
    let icon = Image(systemName: "arrow.up.circle.fill").font(.system(size: 30))
    if working {
      // Queue plus a visible arrow for the other two, like the web's split button (D-035):
      // a long-press-only menu hid steering from people who didn't know to hold.
      let steer = SteerSupport(runtime: agent.summary.runtime)
      HStack(spacing: 0) {
        Button {
          Task { await send(.queue) }
        } label: {
          Text("Queue")
            .font(.subheadline.weight(.semibold))
            .padding(.leading, 14)
            .padding(.trailing, 10)
            .frame(height: 32)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityHint("Sends after this turn")
        Rectangle().fill(.white.opacity(0.3)).frame(width: 1, height: 18)
        Menu {
          Button {
            Task { await send(.queue) }
          } label: {
            Label("Queue", systemImage: "text.line.last.and.arrowtriangle.forward")
            Text("After this turn · you can still edit it")
          }
          if steer != .no {
            Button {
              Task { await send(.steer) }
            } label: {
              Label("Steer Now", systemImage: "arrow.turn.down.right")
              Text(steer == .redoes ? "Into this turn · it redoes the current step" : "Into this turn · can't be taken back")
            }
          }
          Button(role: .destructive) {
            Task { await send(.interrupt) }
          } label: {
            Label("Stop and Send", systemImage: "stop.circle")
            Text("Ends this turn first")
          }
        } label: {
          Image(systemName: "chevron.up")
            .font(.footnote.weight(.bold))
            .padding(.leading, 9)
            .padding(.trailing, 12)
            .frame(height: 32)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("More ways to send")
      }
      .foregroundStyle(.white)
      .background(Capsule().fill(Color.accentColor))
      .disabled(empty || sending)
      .opacity(empty || sending ? 0.5 : 1)
    } else {
      Button {
        Task { await send(.auto) }
      } label: {
        icon
      }
      .disabled(empty || sending || agent.summary.archived)
      .accessibilityLabel("Send")
    }
  }

  private func send(_ mode: InputMode) async {
    let text = draft.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines)
    let files: [Attachment]
    switch model.readyAttachments(agent.id) {
    case .success(let ready): files = ready
    case .failure(let problem):
      note = (problem.message, true)
      return
    }
    guard !text.isEmpty || !files.isEmpty else { return }
    // The id of an attempt that may have reached the server: same text, not confirmed.
    let inputId = pending?.text == text ? pending?.inputId ?? UUID().uuidString.lowercased() : UUID().uuidString.lowercased()
    pending = (text, inputId)
    draft.wrappedValue = ""
    note = nil
    deleted = nil
    sending = true
    defer { sending = false }
    do {
      let result = try await session.api.send(
        agentId: agent.id, text: text, attachments: files, mode: mode, inputId: inputId)
      pending = nil
      if result.landed != .rejected && result.landed != .failed { model.attachments[agent.id] = [] }
      switch result.landed {
      case .rejected, .failed:
        draft.wrappedValue = text
        note = ("Not delivered: \(result.reason ?? result.code ?? result.landed.rawValue)", true)
      case .queued:
        // It shows in the tray; say why only when it was meant as a steer.
        if result.code == "steer_unsupported" { note = (result.reason ?? "Queued for after this turn.", false) }
        sent += 1
        onSent?()
      default:
        sent += 1
        onSent?()
      }
    } catch {
      draft.wrappedValue = text
      let message = (error as? RowrowError)?.errorDescription ?? error.localizedDescription
      note = ("Not sent (\(message)). Send again: it won't arrive twice.", true)
    }
  }

  /// Put a message back into the composer to edit: into an empty one, or after what you're
  /// writing, never over it. Its files are uploaded already.
  private func putBack(_ taken: Withdrawn) {
    var current = draft.wrappedValue
    if current.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
      current = taken.text
    } else if !taken.text.isEmpty {
      while current.last?.isWhitespace == true { current.removeLast() }
      current += "\n\n" + taken.text
    }
    draft.wrappedValue = current
    model.attachments[agent.id, default: []] += taken.attachments.map {
      PendingAttachment(name: $0.name, preview: nil, state: .ready($0))
    }
    focused = true
  }

  private func stopTurn() async {
    do {
      let result = try await session.api.abort(agentId: agent.id)
      if !result.accepted { note = ("Couldn't stop it: \(result.reason ?? "no running turn")", true) }
    } catch {
      note = ("Couldn't stop it: \((error as? RowrowError)?.errorDescription ?? error.localizedDescription)", true)
    }
  }
}

private func firstLine(_ text: String) -> String {
  String(text.split(separator: "\n", maxSplits: 1).first ?? "")
}

/// What waits above the composer (D-035): messages steered into the running turn until the agent
/// reads them, steers it never read, and the queue rowrow sends one per turn. A queued message's
/// ⋯ (or a long press) edits, sends now or deletes it; a steer can't be taken back.
private struct QueueTray: View {
  let agent: AgentState
  let session: Session
  let putBack: (Withdrawn) -> Void
  let onDelete: (Withdrawn) -> Void
  let fail: (String) -> Void
  @State private var expanded = false

  private enum Kind: Equatable {
    case steering, unread
    case queued(Int)
  }

  private struct Row: Identifiable {
    let item: QueuedInput
    let kind: Kind
    var id: String { item.inputId }
  }

  /// Rows shown before "+N more": the conversation stays in view.
  private static let shown = 3

  var body: some View {
    let summary = agent.summary
    let queued = summary.queued ?? []
    let rows =
      (summary.steering ?? []).map { Row(item: $0, kind: .steering) }
      + (summary.unread ?? []).map { Row(item: $0, kind: .unread) }
      + queued.enumerated().map { Row(item: $1, kind: .queued($0 + 1)) }
    if !rows.isEmpty {
      VStack(alignment: .leading, spacing: 0) {
        if !queued.isEmpty {
          HStack {
            Text(summary.queuePaused.map(Self.pausedTitle) ?? "Up next · \(queued.count) queued, sent one per turn")
              .lineLimit(1)
            Spacer()
            if let paused = summary.queuePaused {
              Button(paused == .stopped ? "Resume" : "Send Next") {
                attempt { try await session.api.resume(agentId: agent.id) }
              }
              .buttonStyle(.bordered)
              .controlSize(.small)
            }
          }
          .font(.caption)
          .foregroundStyle(.secondary)
          .padding(.horizontal, 14)
          .padding(.vertical, 8)
        }
        ForEach(expanded ? rows : Array(rows.prefix(Self.shown))) { row in
          if row.id != rows.first?.id || !queued.isEmpty { Divider() }
          rowView(row)
        }
        if rows.count > Self.shown {
          Divider()
          Button(expanded ? "Show Less" : "+\(rows.count - Self.shown) more") { expanded.toggle() }
            .font(.caption)
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
        }
      }
      .glassEffect(in: RoundedRectangle(cornerRadius: 18, style: .continuous))
    }
  }

  private static func pausedTitle(_ reason: QueuePauseReason) -> String {
    switch reason {
    case .stopped: "Queue paused · you stopped the turn"
    case .failed: "Queue paused · the last turn failed"
    case .exited: "Queue paused · the agent exited"
    case .restarted: "Queue paused · rowrow restarted"
    }
  }

  @ViewBuilder
  private func rowView(_ row: Row) -> some View {
    let content = HStack(alignment: .top, spacing: 10) {
      Group {
        switch row.kind {
        case .queued(let n): Text("\(n)").font(.caption2.monospacedDigit())
        case .steering: Image(systemName: "arrow.turn.down.right").font(.caption2).foregroundStyle(.tint)
        case .unread: Image(systemName: "exclamationmark.circle").font(.caption2)
        }
      }
      .frame(width: 20, height: 20)
      .background(.quaternary, in: Circle())
      VStack(alignment: .leading, spacing: 2) {
        if !row.item.text.isEmpty { Text(row.item.text).font(.subheadline).lineLimit(2) }
        if !row.item.attachments.isEmpty {
          Label(row.item.attachments.map(\.name).joined(separator: ", "), systemImage: "paperclip")
            .font(.caption)
            .foregroundStyle(.secondary)
            .lineLimit(1)
        }
        Text(note(row)).font(.caption).foregroundStyle(.secondary)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      if row.kind != .steering {
        Menu {
          actions(row)
        } label: {
          Image(systemName: "ellipsis").frame(width: 32, height: 28).contentShape(Rectangle())
        }
        .accessibilityLabel("Message actions")
        .foregroundStyle(.secondary)
      }
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 8)
    if row.kind == .steering {
      content
    } else {
      content.contextMenu { actions(row) }
    }
  }

  @ViewBuilder
  private func actions(_ row: Row) -> some View {
    let item = row.item
    Button {
      Task { if let taken = await withdraw(item) { putBack(taken) } }
    } label: {
      Label("Edit", systemImage: "pencil")
    }
    if case .queued = row.kind, let now = sendNowLabel {
      Button {
        attempt { _ = try await session.api.sendNow(agentId: agent.id, inputId: item.inputId) }
      } label: {
        Label(now, systemImage: "arrow.up")
      }
    }
    Button(role: .destructive) {
      Task { if let taken = await withdraw(item) { onDelete(taken) } }
    } label: {
      Label("Delete", systemImage: "trash")
    }
  }

  /// Idle there's no turn to steer into: it goes as the next turn, ahead of a paused queue.
  private var sendNowLabel: String? {
    guard agent.attention == .working else { return "Send Now" }
    return SteerSupport(runtime: agent.summary.runtime) == .no ? nil : "Steer Now"
  }

  private func note(_ row: Row) -> String {
    switch row.kind {
    case .steering:
      return agent.attention == .working
        ? "Steering into this turn · the agent reads it at its next step"
        : "Sent · waiting for the agent to read it"
    case .unread: return "Not read · the agent dropped it when its turn was stopped or its process ended"
    case .queued:
      if agent.summary.queuePaused != nil { return "Queued · waits until you send the queue on" }
      return agent.attention == .working ? "Queued · sends after this turn ends" : "Queued · sends next"
    }
  }

  private func withdraw(_ item: QueuedInput) async -> Withdrawn? {
    do {
      return try await session.api.withdraw(agentId: agent.id, inputId: item.inputId)
    } catch {
      fail((error as? RowrowError)?.errorDescription ?? error.localizedDescription)
      return nil
    }
  }

  private func attempt(_ call: @escaping @MainActor () async throws -> Void) {
    Task {
      do {
        try await call()
      } catch {
        fail((error as? RowrowError)?.errorDescription ?? error.localizedDescription)
      }
    }
  }
}

/// Replies you send often (Settings → Quick replies): a tap puts one in the composer, never sends it.
struct QuickReplyChips: View {
  let replies: [String]
  let pick: (String) -> Void

  var body: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      HStack(spacing: 8) {
        ForEach(replies, id: \.self) { reply in
          Button(reply) { pick(reply) }
            .buttonStyle(.bordered)
            .buttonBorderShape(.capsule)
            .font(.subheadline)
            .lineLimit(1)
        }
      }
      .padding(.horizontal, 2)
    }
    .scrollClipDisabled()
  }
}

/// What the runtime accepts as /name here: its skills and commands. Picking one fills the composer.
private struct CommandList: View {
  let typed: String
  let skills: SkillList?
  let pick: (String) -> Void

  var body: some View {
    let matches = (skills?.skills ?? [])
      .filter { typed.isEmpty || $0.name.localizedCaseInsensitiveContains(typed) }
      .sorted { ($0.name.lowercased().hasPrefix(typed.lowercased()) ? 0 : 1) < ($1.name.lowercased().hasPrefix(typed.lowercased()) ? 0 : 1) }
      .prefix(40)
    ScrollView {
      VStack(alignment: .leading, spacing: 0) {
        if skills == nil {
          ProgressView().padding()
        } else if matches.isEmpty {
          Text(skills?.error ?? "No command matches.").font(.footnote).foregroundStyle(.secondary).padding()
        }
        ForEach(Array(matches)) { skill in
          Button {
            pick(skill.name)
          } label: {
            VStack(alignment: .leading, spacing: 2) {
              Text("/\(skill.name)").font(.body.monospaced())
              if let description = skill.description {
                Text(description).font(.caption).foregroundStyle(.secondary).lineLimit(2)
              }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .contentShape(Rectangle())
          }
          .buttonStyle(.plain)
        }
      }
    }
    .frame(maxHeight: 240)
    .glassEffect(in: RoundedRectangle(cornerRadius: 18, style: .continuous))
  }
}

/// Answer an agent from the list: what it said last, and a composer. Open the conversation
/// only when you need all of it.
struct QuickReplySheet: View {
  let agentId: String
  let session: Session
  @Environment(\.dismiss) private var dismiss
  @Environment(AppModel.self) private var model

  var body: some View {
    NavigationStack {
      if let agent = session.state?.agents[agentId] {
        let words = session.words(for: agent)
        VStack(spacing: 0) {
          ScrollView {
            VStack(alignment: .leading, spacing: 10) {
              Text(words.label).font(.subheadline.weight(.medium)).foregroundStyle(Color.tone(words.tone))
              if let preview = agent.summary.preview, !preview.isEmpty {
                MarkdownView(text: "…" + preview, font: .subheadline)
              } else {
                Text("Nothing said yet.").foregroundStyle(.secondary)
              }
            }
            .padding()
            .frame(maxWidth: .infinity, alignment: .leading)
          }
          .defaultScrollAnchor(.bottom)
          Composer(agent: agent, session: session, compact: true) { dismiss() }
            .padding()
        }
        .navigationTitle(agent.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } }
          ToolbarItem(placement: .primaryAction) {
            Button("Open") {
              dismiss()
              model.router.open(agent: agentId)
            }
          }
        }
      }
    }
    .presentationDetents([.medium, .large])
    .presentationDragIndicator(.visible)
  }
}
