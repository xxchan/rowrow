import RowrowCore
import SwiftUI

/// What changed in a workspace: the agent's last turn, everything uncommitted, or the whole
/// branch. Uncommitted files can be staged, unstaged, discarded or deleted with a swipe; the
/// server refuses (and nothing happens) when a file changed since you looked (D-019).
struct ChangesView: View {
  let workspaceId: String
  let agentId: String?
  let session: Session
  @State private var scope: DiffScope
  @State private var changes: Changes?
  @State private var loading = true
  @State private var error: String?
  @State private var confirming: Confirmation?
  @State private var failure = Failure()
  @Environment(AppModel.self) private var model

  init(workspaceId: String, agentId: String?, initialScope: DiffScope, session: Session) {
    self.workspaceId = workspaceId
    self.agentId = agentId
    self.session = session
    _scope = State(initialValue: initialScope)
  }

  private struct Confirmation: Identifiable {
    let id = UUID()
    let title: String
    let message: String
    let button: String
    let action: () async throws -> Void
  }

  var body: some View {
    let workspace = session.state?.workspaces[workspaceId]
    List {
      Section {
        Picker("Scope", selection: $scope) {
          Text("Last turn").tag(DiffScope.turn)
          Text("Uncommitted").tag(DiffScope.working)
          Text("Branch").tag(DiffScope.branch)
        }
        .pickerStyle(.segmented)
        .listRowBackground(Color.clear)
        .listRowInsets(EdgeInsets())
      } footer: {
        if let changes {
          Text(caption(changes))
        }
      }
      if let error {
        Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(.orange)
      } else if let changes {
        if changes.files.isEmpty {
          ContentUnavailableView(
            "Nothing changed", systemImage: "checkmark.seal",
            description: Text(changes.note ?? emptyText))
        } else {
          Section {
            ForEach(changes.files) { file in
              NavigationLink(value: Route.diff(DiffTarget(workspaceId: workspaceId, path: file.path, scope: scope, agentId: agentId, sha: nil))) {
                FileRow(file: file, showStage: scope == .working)
              }
              .swipeActions(edge: .leading) { if scope == .working { stageButton(file) } }
              .swipeActions(edge: .trailing) { if scope == .working { destroyButtons(file) } }
            }
          } header: {
            let adds = changes.files.compactMap(\.additions).reduce(0, +)
            let dels = changes.files.compactMap(\.deletions).reduce(0, +)
            Text("\(changes.files.count) file\(changes.files.count == 1 ? "" : "s") · +\(adds) −\(dels)")
          } footer: {
            if changes.truncated { Text("There are more files than shown.") }
          }
        }
      } else if loading {
        ProgressView().frame(maxWidth: .infinity)
      }
    }
    .navigationTitle(workspace?.label ?? "Changes")
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      if scope == .working, let files = changes?.files, !files.isEmpty {
        ToolbarItem(placement: .topBarTrailing) { bulkMenu(files) }
      }
    }
    .safeAreaInset(edge: .bottom) {
      ReviewBar(workspaceId: workspaceId, agentId: agentId, session: session)
    }
    .task(id: scope) { await load() }
    .refreshable { await load() }
    .confirmationDialog(
      confirming?.title ?? "", isPresented: Binding(get: { confirming != nil }, set: { if !$0 { confirming = nil } }),
      titleVisibility: .visible, presenting: confirming
    ) { confirmation in
      Button(confirmation.button, role: .destructive) {
        Task { await act(confirmation.title, confirmation.action) }
      }
    } message: { confirmation in
      Text(confirmation.message)
    }
    .failureAlert(failure)
    .onAppear {
      if let agentId { session.show(route: "/a/\(agentId)", agent: agentId) }
    }
  }

  private var emptyText: String {
    switch scope {
    case .turn: "The last turn didn't change any files."
    case .working: "No uncommitted changes."
    case .branch: "This branch has no changes of its own."
    }
  }

  private func caption(_ changes: Changes) -> String {
    switch scope {
    case .turn: changes.baseLabel.map { "Since \($0)" } ?? "What the latest turn changed"
    case .working: "Against HEAD" + (changes.baseLabel.map { " (\($0))" } ?? "")
    case .branch: changes.baseLabel.map { "Since \($0)" } ?? "Since the default branch"
    }
  }

  private func load() async {
    loading = true
    defer { loading = false }
    do {
      changes = try await session.api.changes(workspaceId: workspaceId, scope: scope, agentId: agentId)
      error = nil
    } catch is CancellationError {
    } catch {
      self.error = (error as? RowrowError)?.errorDescription ?? error.localizedDescription
    }
  }

  private func act(_ what: String, _ action: () async throws -> Void) async {
    do {
      try await action()
    } catch let error as RowrowError where error.code == "CONFLICT" {
      failure.message = "\(what): it changed since you looked. The list is fresh now; look again."
    } catch {
      failure.message = "\(what): \((error as? RowrowError)?.errorDescription ?? error.localizedDescription)"
    }
    await load()
  }

  @ViewBuilder
  private func stageButton(_ file: ChangedFile) -> some View {
    if file.status == .conflicted {
      Button("Resolved") {
        Task { await act("Mark resolved") { _ = try await session.api.fileAction(workspaceId: workspaceId, action: .markResolved, file: file) } }
      }
      .tint(.green)
    } else if file.unstaged == true {
      Button("Stage") {
        Task { await act("Stage") { _ = try await session.api.fileAction(workspaceId: workspaceId, action: .stage, file: file) } }
      }
      .tint(.green)
    } else if file.staged == true {
      Button("Unstage") {
        Task { await act("Unstage") { _ = try await session.api.fileAction(workspaceId: workspaceId, action: .unstage, file: file) } }
      }
      .tint(.orange)
    }
  }

  @ViewBuilder
  private func destroyButtons(_ file: ChangedFile) -> some View {
    if file.status == .untracked {
      Button("Delete", role: .destructive) {
        confirming = Confirmation(
          title: "Delete \(file.path)?", message: "It isn't in git: it's gone for good.", button: "Delete") {
            _ = try await session.api.fileAction(workspaceId: workspaceId, action: .deleteUntracked, file: file)
          }
      }
    } else if file.unstaged == true, file.status != .conflicted {
      Button("Discard", role: .destructive) {
        confirming = Confirmation(
          title: "Discard the changes to \(file.path)?", message: "Edits that aren't staged are lost; the staged version stays.",
          button: "Discard") {
            _ = try await session.api.fileAction(workspaceId: workspaceId, action: .discardUnstaged, file: file)
          }
      }
    }
  }

  private func bulkMenu(_ files: [ChangedFile]) -> some View {
    Menu {
      Button {
        Task { await act("Stage all") { _ = try await session.api.bulkAction(workspaceId: workspaceId, action: .stageAll, files: files) } }
      } label: {
        Label("Stage All", systemImage: "plus.circle")
      }
      Button {
        Task { await act("Unstage all") { _ = try await session.api.bulkAction(workspaceId: workspaceId, action: .unstageAll, files: files) } }
      } label: {
        Label("Unstage All", systemImage: "minus.circle")
      }
      Button(role: .destructive) {
        confirming = Confirmation(
          title: "Discard every unstaged change?", message: "Staged versions stay; everything else goes back to them or to HEAD.",
          button: "Discard All") {
            _ = try await session.api.bulkAction(workspaceId: workspaceId, action: .discardAllUnstaged, files: files)
          }
      } label: {
        Label("Discard All Unstaged", systemImage: "arrow.uturn.backward")
      }
      Button(role: .destructive) {
        confirming = Confirmation(
          title: "Delete every untracked file?", message: "They aren't in git: they're gone for good.", button: "Delete All") {
            _ = try await session.api.bulkAction(workspaceId: workspaceId, action: .deleteAllUntracked, files: files)
          }
      } label: {
        Label("Delete All Untracked", systemImage: "trash")
      }
    } label: {
      Label("Actions", systemImage: "ellipsis")
    }
  }
}

/// A changed file: what happened to it, its name, and how much changed.
struct FileRow: View {
  let file: ChangedFile
  var showStage = false

  var body: some View {
    let name = (file.path as NSString).lastPathComponent
    let dir = (file.path as NSString).deletingLastPathComponent
    HStack(spacing: 10) {
      Text(letter)
        .font(.caption.monospaced().bold())
        .frame(width: 20, height: 20)
        .foregroundStyle(color)
        .background(color.opacity(0.14), in: RoundedRectangle(cornerRadius: 5))
      VStack(alignment: .leading, spacing: 1) {
        Text(name).font(.subheadline.weight(.medium)).lineLimit(1)
        if !dir.isEmpty || file.oldPath != nil {
          Text(file.oldPath.map { "from \($0)" } ?? dir)
            .font(.caption)
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .truncationMode(.head)
        }
      }
      Spacer(minLength: 4)
      if showStage, file.staged == true {
        Pill(text: file.unstaged == true ? "partly staged" : "staged", color: .green)
      }
      if let adds = file.additions, let dels = file.deletions {
        HStack(spacing: 4) {
          Text("+\(adds)").foregroundStyle(.green)
          Text("−\(dels)").foregroundStyle(.red)
        }
        .font(.caption.monospacedDigit())
      } else {
        Text("binary").font(.caption).foregroundStyle(.secondary)
      }
    }
    .accessibilityElement(children: .combine)
  }

  private var letter: String {
    switch file.status {
    case .added: "A"
    case .modified: "M"
    case .deleted: "D"
    case .renamed: "R"
    case .copied: "C"
    case .untracked: "?"
    case .conflicted: "!"
    case .typechange: "T"
    }
  }

  private var color: Color {
    switch file.status {
    case .added, .untracked: .green
    case .deleted, .conflicted: .red
    case .renamed, .copied: .purple
    default: .orange
    }
  }
}

/// Review comments waiting in this workspace: one tap puts them in an agent's composer, as one
/// "Review feedback" message you read over and send (you send it, never rowrow).
struct ReviewBar: View {
  let workspaceId: String
  let agentId: String?
  let session: Session
  @Environment(AppModel.self) private var model
  @State private var failure = Failure()

  var body: some View {
    let comments = model.reviews.comments(in: workspaceId)
    if !comments.isEmpty {
      let agents = session.state?.sortedAgents.filter { $0.summary.workspaceId == workspaceId } ?? []
      HStack {
        Label("\(comments.count) comment\(comments.count == 1 ? "" : "s")", systemImage: "text.bubble")
          .font(.subheadline.weight(.medium))
        Spacer()
        if let agentId {
          Button("Put in the Composer") { Task { await deliver(comments, to: agentId) } }
            .buttonStyle(.glassProminent)
        } else if !agents.isEmpty {
          Menu("Send to…") {
            ForEach(agents) { agent in
              Button(agent.title) { Task { await deliver(comments, to: agent.id) } }
            }
          }
          .buttonStyle(.glassProminent)
        }
        Menu {
          Button("Discard the Comments", role: .destructive) { model.reviews.remove(in: workspaceId) }
        } label: {
          Image(systemName: "ellipsis").padding(8)
        }
      }
      .padding(.horizontal, 16)
      .padding(.vertical, 10)
      .glassEffect(in: RoundedRectangle(cornerRadius: 22, style: .continuous))
      .padding(.horizontal, 12)
      .padding(.bottom, 6)
      .failureAlert(failure)
    }
  }

  private func deliver(_ comments: [ReviewComment], to agentId: String) async {
    await failure.run("Compile the review") {
      let kit = await session.readyKit()
      let message = try await kit.feedback(comments)
      let draft = model.drafts[agentId] ?? ""
      model.drafts[agentId] = draft.isEmpty ? message : draft + "\n\n" + message
      model.reviews.remove(in: workspaceId)
      model.router.open(agent: agentId)
    }
  }
}
