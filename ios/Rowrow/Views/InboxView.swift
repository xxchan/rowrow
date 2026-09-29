import RowrowCore
import SwiftUI

/// The Agents tab: every agent, the ones that need you first (PRINCIPLES.md, product 1). On a
/// phone this is triage: read what each one said, reply or mark it seen with a swipe, and open
/// a conversation only when you need all of it.
struct InboxView: View {
  let session: Session
  @Environment(AppModel.self) private var model
  @State private var search = ""
  @State private var showAllIdle = false
  @State private var replying: AgentState?
  @State private var actions = AgentActions()
  @AppStorage("rowrow.dismissedUpdate") private var dismissedUpdate = ""

  var body: some View {
    List {
      if !session.status.isOnline {
        Section { ConnectionNote(session: session) }
      }
      if let update = session.state?.host.update, dismissedUpdate != update.version {
        Section {
          UpdateNote(update: update, host: session.state?.host.name ?? "your computer")
        } footer: {
          Button("Not now") { dismissedUpdate = update.version }.font(.footnote)
        }
      }
      if let state = session.state {
        content(state)
      } else if session.status == .connecting {
        Section { ProgressView().frame(maxWidth: .infinity) }
      }
    }
    .listStyle(.insetGrouped)
    .navigationTitle("Agents")
    .searchable(text: $search, prompt: "Agents, workspaces, what they said")
    .refreshable { session.retryNow() }
    .toolbar {
      if model.accounts.list.count > 1 {
        ToolbarItem(placement: .topBarLeading) { ServerMenu() }
      }
      ToolbarItem(placement: .primaryAction) {
        Button {
          model.newAgent = NewAgentRequest(context: .anywhere)
        } label: {
          Label("New agent", systemImage: "square.and.pencil")
        }
        .disabled(session.state == nil)
      }
    }
    .sheet(item: $replying) { agent in
      QuickReplySheet(agentId: agent.id, session: session)
    }
    .agentActions(actions, session: session)
    .onAppear { session.show(route: "/", agent: nil) }
  }

  @ViewBuilder
  private func content(_ state: AppState) -> some View {
    let agents = state.sortedAgents.filter { matches($0, in: state) }
    let hasWorkspace = state.workspaces.values.contains { !$0.archived }
    if !hasWorkspace {
      Section {
        ContentUnavailableView {
          Label("Add a workspace to start", systemImage: "folder.badge.plus")
        } description: {
          Text("An agent works in a folder on your computer. Add one from the Workspaces tab, then start agents in it.")
        } actions: {
          Button("Add a workspace") { model.router.tab = .workspaces }
            .buttonStyle(.borderedProminent)
        }
      }
    } else if state.sortedAgents.isEmpty {
      Section {
        ContentUnavailableView {
          Label("No agents yet", systemImage: "sparkles")
        } description: {
          Text("Say what you want done; rowrow starts Claude Code, Codex, Grok, Kimi or Pi on it and tells you when it needs you.")
        } actions: {
          Button("Start an agent") { model.newAgent = NewAgentRequest(context: .anywhere) }
            .buttonStyle(.borderedProminent)
        }
      }
    } else if agents.isEmpty {
      ContentUnavailableView.search(text: search)
    } else {
      let needs = agents.filter { $0.attention.needsYou }
      let working = agents.filter { $0.attention == .working }
      let idle = agents.filter { $0.attention == .idle }
      if !needs.isEmpty {
        Section {
          ForEach(needs) { agent in row(agent, state: state, prominent: true) }
        } header: {
          SectionHeader(title: "Needs you", count: needs.count, color: .red)
        }
      }
      if !working.isEmpty {
        Section {
          ForEach(working) { agent in row(agent, state: state, prominent: false) }
        } header: {
          SectionHeader(title: "Working", count: working.count, color: .accentColor)
        }
      }
      if !idle.isEmpty {
        Section {
          let shown = showAllIdle || !search.isEmpty ? idle : Array(idle.prefix(6))
          ForEach(shown) { agent in row(agent, state: state, prominent: false) }
          if shown.count < idle.count {
            Button("Show all \(idle.count)") { withAnimation { showAllIdle = true } }
          }
        } header: {
          SectionHeader(title: "Idle", count: idle.count, color: .secondary)
        }
      }
    }
  }

  private func row(_ agent: AgentState, state: AppState, prominent: Bool) -> some View {
    NavigationLink(value: Route.agent(agent.id)) {
      AgentRow(agent: agent, session: session, prominent: prominent)
    }
    .swipeActions(edge: .leading, allowsFullSwipe: true) {
      Button {
        replying = agent
      } label: {
        Label("Reply", systemImage: "arrowshape.turn.up.left.fill")
      }
      .tint(.accentColor)
      if agent.attention.needsYou {
        Button {
          actions.markSeen(agent)
        } label: {
          Label("Seen", systemImage: "checkmark")
        }
        .tint(.green)
      }
    }
    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
      Button {
        actions.archive(agent)
      } label: {
        Label("Archive", systemImage: "archivebox")
      }
      .tint(.gray)
      if agent.attention == .working {
        Button {
          actions.stopTurn(agent)
        } label: {
          Label("Stop", systemImage: "stop.fill")
        }
        .tint(.red)
      }
    }
    .contextMenu {
      Button {
        replying = agent
      } label: {
        Label("Reply…", systemImage: "arrowshape.turn.up.left")
      }
      AgentMenuItems(agent: agent, actions: actions, session: session)
    } preview: {
      AgentPeek(agent: agent, session: session)
    }
  }

  private func matches(_ agent: AgentState, in state: AppState) -> Bool {
    let query = search.trimmingCharacters(in: .whitespaces)
    guard !query.isEmpty else { return true }
    let workspace = state.workspaces[agent.summary.workspaceId]
    return [agent.title, workspace?.label, workspace?.git?.branch, agent.summary.preview, state.runtimeName(agent.summary.runtime)]
      .compactMap { $0 }
      .contains { $0.localizedCaseInsensitiveContains(query) }
  }
}

private struct SectionHeader: View {
  let title: String
  let count: Int
  let color: Color

  var body: some View {
    HStack(spacing: 6) {
      Text(title)
      Pill(text: "\(count)", color: color)
    }
  }
}

/// One agent in a list: who, what state, where, and the tail of what it said.
struct AgentRow: View {
  let agent: AgentState
  let session: Session
  /// Needs you: show more of what it said.
  var prominent = false
  /// Say where it works (not inside its own workspace's screen).
  var showWorkspace = true

  var body: some View {
    let words = session.words(for: agent)
    let workspace = session.state?.workspaces[agent.summary.workspaceId]
    let failed = agent.attention == .done && words.tone == "error"
    let detail = failed ? agent.summary.lastError ?? agent.summary.preview : agent.summary.preview
    HStack(alignment: .top, spacing: 12) {
      AgentAvatar(runtime: agent.summary.runtime, words: words, size: 40)
      VStack(alignment: .leading, spacing: 3) {
        HStack(alignment: .firstTextBaseline) {
          Text(agent.title)
            .font(.headline)
            .lineLimit(1)
          Spacer(minLength: 8)
          TimelineView(.periodic(from: .now, by: 30)) { context in
            Text(ago(agent.summary.lastActivityAt, now: context.date))
              .font(.caption)
              .foregroundStyle(.secondary)
              .monospacedDigit()
          }
        }
        HStack(spacing: 4) {
          Text(words.label)
            .foregroundStyle(words.tone == "neutral" ? Color.secondary : Color.tone(words.tone))
          if let workspace, showWorkspace {
            Text("·").foregroundStyle(.tertiary)
            Text(branchLabel(workspace)).foregroundStyle(.secondary).lineLimit(1)
          }
        }
        .font(.subheadline)
        if let detail, !detail.isEmpty {
          Text(inlineMarkdown(oneLine(detail)))
            .font(.subheadline)
            .foregroundStyle(failed ? Color.red.opacity(0.85) : .secondary)
            .lineLimit(prominent ? 3 : 1)
        }
      }
    }
    .padding(.vertical, prominent ? 4 : 1)
  }
}

func branchLabel(_ workspace: Workspace) -> String {
  guard let branch = workspace.git?.branch, branch != workspace.label else { return workspace.label }
  return "\(workspace.label) (\(branch))"
}

func oneLine(_ text: String) -> String {
  text.split(whereSeparator: \.isWhitespace).joined(separator: " ")
}

/// Bold, italic, code and links of a line of Markdown (what a row has room for).
func inlineMarkdown(_ text: String) -> AttributedString {
  (try? AttributedString(
    markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace, failurePolicy: .returnPartiallyParsedIfPossible)))
    ?? AttributedString(text)
}

/// A long press on an agent: what it said last, bigger.
struct AgentPeek: View {
  let agent: AgentState
  let session: Session

  var body: some View {
    let words = session.words(for: agent)
    VStack(alignment: .leading, spacing: 12) {
      HStack(spacing: 10) {
        AgentAvatar(runtime: agent.summary.runtime, words: words, size: 32)
        VStack(alignment: .leading) {
          Text(agent.title).font(.headline).lineLimit(2)
          Text(words.label).font(.subheadline).foregroundStyle(Color.tone(words.tone))
        }
      }
      if let preview = agent.summary.preview, !preview.isEmpty {
        MarkdownView(text: "…" + preview, font: .subheadline)
      } else {
        Text("Nothing said yet.").foregroundStyle(.secondary)
      }
    }
    .padding(18)
    .frame(width: 340, alignment: .leading)
  }
}

/// Switch between the rowrow servers this device is paired with.
struct ServerMenu: View {
  @Environment(AppModel.self) private var model

  var body: some View {
    Menu {
      ForEach(model.accounts.list) { account in
        Button {
          model.activate(account)
        } label: {
          if account.id == model.session?.account.id {
            Label(account.name, systemImage: "checkmark")
          } else {
            Text(account.name)
          }
        }
      }
    } label: {
      Label(model.session?.account.name ?? "Servers", systemImage: "desktopcomputer")
    }
  }
}

/// A newer rowrow is out (D-025): what to run on the computer to get it.
struct UpdateNote: View {
  let update: UpdateInfo
  let host: String
  @State private var copied = false

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Label("rowrow \(update.version) is out", systemImage: "arrow.down.circle.fill")
        .font(.subheadline.weight(.semibold))
      Text("To update it, run this on \(host):").font(.footnote).foregroundStyle(.secondary)
      Button {
        UIPasteboard.general.string = update.command
        copied = true
      } label: {
        HStack {
          Text(update.command).font(.footnote.monospaced()).multilineTextAlignment(.leading)
          Spacer(minLength: 4)
          Image(systemName: copied ? "checkmark" : "doc.on.doc").font(.caption)
        }
        .padding(10)
        .background(.fill.tertiary, in: RoundedRectangle(cornerRadius: 10))
      }
      .buttonStyle(.plain)
      .sensoryFeedback(.success, trigger: copied)
      if let after = update.after {
        Text(after).font(.footnote).foregroundStyle(.secondary)
      }
    }
  }
}
