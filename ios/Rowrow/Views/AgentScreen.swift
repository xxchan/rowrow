import RowrowCore
import SwiftUI

/// One agent: the conversation, and the composer under it. It opens at the start of the latest
/// turn (on a phone you read an answer from its top), follows new text while you're at the
/// bottom, and marks what you've seen once it's on screen (D-008).
struct AgentScreen: View {
  let agentId: String
  let session: Session
  @Environment(AppModel.self) private var model
  @Environment(\.scenePhase) private var scenePhase

  var body: some View {
    if let agent = session.state?.agents[agentId], let store = model.transcript(for: agent) {
      Conversation(agent: agent, store: store, session: session)
        .onAppear { session.show(route: "/a/\(agentId)", agent: agentId) }
        .task(id: SeenKey(head: store.head, active: scenePhase == .active, loading: store.loading)) {
          guard scenePhase == .active, !store.loading, store.head > agent.seenSeq else { return }
          try? await Task.sleep(for: .milliseconds(400))
          try? await session.api.markSeen(agentId: agentId, seq: store.head)
        }
    } else if session.state == nil {
      ProgressView()
    } else {
      ContentUnavailableView("No such agent", systemImage: "questionmark.bubble", description: Text("There's no agent \(agentId) on \(session.account.name)."))
    }
  }

  private struct SeenKey: Equatable {
    let head: Int
    let active: Bool
    let loading: Bool
  }
}

private struct Conversation: View {
  let agent: AgentState
  let store: TranscriptStore
  let session: Session
  @Environment(AppModel.self) private var model
  @State private var position = ScrollPosition(edge: .bottom)
  @State private var atBottom = true
  @State private var placed = false
  @State private var inspecting: TranscriptItem.Tool?
  @State private var actions = AgentActions()
  @State private var sharing: String?

  var body: some View {
    let words = session.words(for: agent)
    let workspace = session.state?.workspaces[agent.summary.workspaceId]
    let latestTurn = store.rows.last { if case .turn = $0 { true } else { false } }?.id
    ScrollView {
      LazyVStack(alignment: .leading, spacing: 20) {
        if store.hasMore {
          Button {
            Task { await store.loadOlder() }
          } label: {
            if store.loadingOlder { ProgressView() } else { Label("Earlier turns", systemImage: "arrow.up") }
          }
          .buttonStyle(.bordered)
          .frame(maxWidth: .infinity)
        }
        if store.rows.isEmpty {
          if store.loading {
            ProgressView("Loading the conversation").frame(maxWidth: .infinity).padding(.top, 80)
          } else {
            ContentUnavailableView(
              "Nothing yet", systemImage: "text.bubble",
              description: Text("Write the first message below. The agent starts working in \(workspace?.label ?? "its workspace") when it arrives."))
          }
        }
        ForEach(store.rows) { row in
          switch row {
          case .input(let input):
            InputBubble(input: input, session: session)
          case .note(let note):
            NoteLine(note: note)
          case .turn(let turn):
            TurnView(turn: turn, runtime: agent.summary.runtime, onTool: { inspecting = $0 })
            // A turn that ran no tools changed no files.
            if turn.id == latestTurn, !turn.open, workspace?.git != nil,
              turn.parts.contains(where: { if case .tool = $0 { true } else { false } })
            {
              ChangesChip(workspaceId: agent.summary.workspaceId, agentId: agent.id)
            }
          case .action:
            // Only Coach's chats propose actions (CoachScreen shows their cards).
            EmptyView()
          }
        }
        if let error = store.error {
          Label(error, systemImage: "exclamationmark.triangle").font(.footnote).foregroundStyle(.orange)
        }
      }
      .scrollTargetLayout()
      .padding(.horizontal)
      .padding(.vertical, 12)
    }
    .scrollPosition($position)
    .defaultScrollAnchor(.bottom)
    .scrollDismissesKeyboard(.interactively)
    .onScrollGeometryChange(for: Bool.self) { geometry in
      // The visible rect runs under the composer (the bottom inset): its content ends above it.
      geometry.visibleRect.maxY - geometry.contentInsets.bottom >= geometry.contentSize.height - 80
    } action: { _, bottom in
      atBottom = bottom
    }
    .onChange(of: store.rows) { _, rows in follow(rows) }
    .onAppear {
      store.start()
      follow(store.rows)
    }
    .onDisappear { store.stop() }
    .overlay(alignment: .bottomTrailing) {
      if !atBottom && placed {
        Button {
          withAnimation { position.scrollTo(edge: .bottom) }
        } label: {
          Image(systemName: "arrow.down").font(.body.weight(.semibold)).padding(12)
        }
        .glassEffect(.regular.interactive(), in: Circle())
        .padding(.trailing, 16)
        .padding(.bottom, 8)
        .accessibilityLabel("Latest")
        .transition(.scale.combined(with: .opacity))
      }
    }
    .safeAreaInset(edge: .bottom) {
      Composer(agent: agent, session: session)
        .padding(.horizontal, 12)
        .padding(.bottom, 6)
    }
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      ToolbarItem(placement: .principal) {
        VStack(spacing: 1) {
          Text(agent.title).font(.headline).lineLimit(1)
          HStack(spacing: 4) {
            StatusDot(words: words, size: 7)
            Text(words.label).foregroundStyle(words.tone == "neutral" ? Color.secondary : Color.tone(words.tone))
            if let workspace { Text("· \(branchLabel(workspace))").foregroundStyle(.secondary) }
          }
          .font(.caption)
          .lineLimit(1)
        }
        .accessibilityElement(children: .combine)
      }
      if let next = session.state?.needingYou.first(where: { $0.id != agent.id }) {
        ToolbarItem(placement: .topBarTrailing) {
          Button {
            model.router.replace(agent: next.id)
          } label: {
            Label("Next: \(next.title)", systemImage: "chevron.forward.2")
          }
          .badge((session.state?.needingYou.filter { $0.id != agent.id }.count) ?? 0)
          .tint(.red)
        }
      }
      if workspace?.git != nil {
        ToolbarItem(placement: .topBarTrailing) {
          Button {
            model.router.push(.changes(workspaceId: agent.summary.workspaceId, agentId: agent.id, scope: .turn))
          } label: {
            Label("Changes", systemImage: "plus.forwardslash.minus")
          }
          .badge(workspace?.git?.changed ?? 0)
        }
      }
      ToolbarItem(placement: .topBarTrailing) {
        Menu {
          AgentMenuItems(agent: agent, actions: actions, session: session)
          Section {
            Button {
              Task { sharing = await store.plainText() }
            } label: {
              Label("Share the Transcript…", systemImage: "square.and.arrow.up")
            }
          }
        } label: {
          Label("More", systemImage: "ellipsis")
        }
      }
    }
    .sheet(item: $inspecting) { tool in
      ToolSheet(tool: tool, store: store)
    }
    .sheet(isPresented: Binding(get: { sharing != nil }, set: { if !$0 { sharing = nil } })) {
      ShareSheet(items: [sharing ?? ""])
    }
    .agentActions(actions, session: session)
  }

  /// First time: the start of the latest turn. After that: the bottom, if you were there.
  private func follow(_ rows: [TranscriptRow]) {
    guard !rows.isEmpty else { return }
    if !placed {
      placed = true
      let latest = rows.lastIndex { if case .input = $0 { true } else { false } }
      if let latest {
        DispatchQueue.main.async { position.scrollTo(id: rows[latest].id, anchor: .top) }
      }
      return
    }
    if atBottom {
      withAnimation(.easeOut(duration: 0.2)) { position.scrollTo(edge: .bottom) }
    }
  }
}

/// What you (or another device, or an agent) sent.
private struct InputBubble: View {
  let input: TranscriptItem.Input
  let session: Session

  var body: some View {
    VStack(alignment: .trailing, spacing: 4) {
      if !input.attachments.isEmpty {
        SentTiles(attachments: input.attachments, session: session)
      }
      if !input.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        Text(input.text)
          .textSelection(.enabled)
          .padding(.horizontal, 14)
          .padding(.vertical, 9)
          .background(Color.accentColor.opacity(0.14), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
      }
      HStack(spacing: 4) {
        switch input.state {
        case .sending: ProgressView().controlSize(.mini)
        case .failed: Image(systemName: "exclamationmark.circle.fill").foregroundStyle(.red)
        case .sent: EmptyView()
        }
        Text(facts).lineLimit(2)
      }
      .font(.caption2)
      .foregroundStyle(input.state == .failed ? Color.red : .secondary)
    }
    .frame(maxWidth: .infinity, alignment: .trailing)
    .padding(.leading, 40)
  }

  private var facts: String {
    var parts: [String] = []
    if input.state == .sending { parts.append("Sending") }
    if input.state == .failed {
      // The kit's words for an input the agent took and never read (describe.ts droppedWords)
      // say so themselves; it was delivered.
      if let reason = input.reason, reason.hasPrefix("Not read") {
        parts.append(reason)
      } else {
        parts.append("Not delivered\(input.reason.map { ": \($0)" } ?? "")")
      }
    }
    if let by = input.by { parts.append(by) }
    if let at = input.at { parts.append(Date(millis: at).formatted(date: .omitted, time: .shortened)) }
    if input.landed == "steered" { parts.append("steered into the running turn") }
    if input.landed == "queued" { parts.append("queued for the next turn") }
    return parts.joined(separator: " · ")
  }
}

/// rowrow's own note between turns: a resumed run, a model switch, a run that ended.
struct NoteLine: View {
  let note: TranscriptItem.Notice

  var body: some View {
    if note.divider {
      HStack(spacing: 10) {
        Rectangle().fill(.quaternary).frame(height: 1)
        Text(note.text).font(.caption2).foregroundStyle(.secondary).fixedSize()
        Rectangle().fill(.quaternary).frame(height: 1)
      }
    } else {
      Text(note.text)
        .font(.caption)
        .foregroundStyle(note.tone == "error" ? Color.red : .secondary)
        .multilineTextAlignment(.center)
        .frame(maxWidth: .infinity)
    }
  }
}

/// What the latest turn changed, one tap away.
private struct ChangesChip: View {
  let workspaceId: String
  let agentId: String
  @Environment(AppModel.self) private var model

  var body: some View {
    Button {
      model.router.push(.changes(workspaceId: workspaceId, agentId: agentId, scope: .turn))
    } label: {
      Label("What this turn changed", systemImage: "plus.forwardslash.minus")
        .font(.subheadline)
    }
    .buttonStyle(.bordered)
    .buttonBorderShape(.capsule)
  }
}

struct ShareSheet: UIViewControllerRepresentable {
  let items: [Any]
  func makeUIViewController(context: Context) -> UIActivityViewController {
    UIActivityViewController(activityItems: items, applicationActivities: nil)
  }
  func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}
