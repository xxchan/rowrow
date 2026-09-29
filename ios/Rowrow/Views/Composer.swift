import RowrowCore
import SwiftUI

/// Writing to an agent. Return is a newline (dictation and IME need it); the button sends.
/// While the agent works, a message steers the running turn (or waits for the next when the
/// runtime can't steer); hold the button to queue it instead, or to stop the turn and send.
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
        TextField(working ? "Steer it, or queue the next thing" : "Message", text: draft, axis: .vertical)
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
      Menu {
        Button {
          Task { await send(.auto) }
        } label: {
          Label("Send Now (Steer)", systemImage: "arrow.turn.down.right")
        }
        Button {
          Task { await send(.queue) }
        } label: {
          Label("Queue for the Next Turn", systemImage: "text.line.last.and.arrowtriangle.forward")
        }
        Button(role: .destructive) {
          Task { await send(.interrupt) }
        } label: {
          Label("Stop the Turn and Send", systemImage: "stop.circle")
        }
      } label: {
        icon
      } primaryAction: {
        Task { await send(.auto) }
      }
      .disabled(empty || sending)
      .accessibilityLabel("Send")
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
        note = ("Queued: it goes when the current turn ends.", false)
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

  private func stopTurn() async {
    do {
      let result = try await session.api.abort(agentId: agent.id)
      if !result.accepted { note = ("Couldn't stop it: \(result.reason ?? "no running turn")", true) }
    } catch {
      note = ("Couldn't stop it: \((error as? RowrowError)?.errorDescription ?? error.localizedDescription)", true)
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
