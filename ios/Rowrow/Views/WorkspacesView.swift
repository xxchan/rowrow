import RowrowCore
import SwiftUI

/// The Workspaces tab: the folders agents work in, each repository with its worktrees.
struct WorkspacesView: View {
  let session: Session
  @State private var adding = false

  var body: some View {
    List {
      if let state = session.state {
        let workspaces = state.workspaces.values.filter { !$0.archived }
        let roots = workspaces.filter { $0.parentId == nil || state.workspaces[$0.parentId ?? ""] == nil }
          .sorted { $0.label.localizedCaseInsensitiveCompare($1.label) == .orderedAscending }
        if roots.isEmpty {
          ContentUnavailableView {
            Label("No workspaces", systemImage: "folder")
          } description: {
            Text("A workspace is a folder on your computer, usually a git repository, that agents work in.")
          } actions: {
            Button("Add a workspace") { adding = true }.buttonStyle(.borderedProminent)
          }
        }
        ForEach(roots) { root in
          Section {
            WorkspaceLink(workspace: root, state: state, session: session)
            ForEach(workspaces.filter { $0.parentId == root.id }.sorted { $0.label < $1.label }) { worktree in
              WorkspaceLink(workspace: worktree, state: state, session: session)
                .padding(.leading, 18)
            }
          }
        }
      } else {
        ProgressView().frame(maxWidth: .infinity)
      }
    }
    .navigationTitle("Workspaces")
    .toolbar {
      ToolbarItem(placement: .primaryAction) {
        Button {
          adding = true
        } label: {
          Label("Add a workspace", systemImage: "plus")
        }
      }
    }
    .refreshable { session.retryNow() }
    .sheet(isPresented: $adding) { AddWorkspaceView(session: session) }
    .onAppear { session.show(route: "/w", agent: nil) }
  }
}

private struct WorkspaceLink: View {
  let workspace: Workspace
  let state: AppState
  let session: Session

  var body: some View {
    let agents = state.sortedAgents.filter { $0.summary.workspaceId == workspace.id }
    NavigationLink(value: Route.workspace(workspace.id)) {
      HStack(spacing: 12) {
        Image(systemName: workspace.parentId == nil ? (workspace.git == nil ? "folder" : "shippingbox") : "arrow.triangle.branch")
          .foregroundStyle(.tint)
          .frame(width: 24)
        VStack(alignment: .leading, spacing: 2) {
          Text(workspace.label).font(.headline).lineLimit(1)
          HStack(spacing: 6) {
            if let git = workspace.git {
              Text(git.branch ?? "detached").lineLimit(1)
              if git.ahead > 0 { Text("↑\(git.ahead)") }
              if git.behind > 0 { Text("↓\(git.behind)") }
            } else if workspace.missing {
              Text("missing").foregroundStyle(.red)
            } else {
              Text("not a git repository")
            }
          }
          .font(.caption)
          .foregroundStyle(.secondary)
        }
        Spacer(minLength: 4)
        if let changed = workspace.git?.changed, changed > 0 {
          Pill(text: "\(changed)", color: .orange)
        }
        HStack(spacing: -4) {
          ForEach(agents.prefix(4)) { agent in
            StatusDot(words: session.words(for: agent), size: 11)
          }
        }
      }
    }
  }
}

/// One workspace: its agents, what changed, its history and pull request, and what you can do in it.
struct WorkspaceView: View {
  let workspaceId: String
  let session: Session
  @Environment(AppModel.self) private var model
  @Environment(Router.self) private var router
  @State private var pullRequest: PullRequestStatus?
  @State private var failure = Failure()
  @State private var creatingWorktree = false
  @State private var branch = ""
  @State private var confirmingRemoval = false

  var body: some View {
    if let state = session.state, let workspace = state.workspaces[workspaceId] {
      let agents = state.sortedAgents.filter { $0.summary.workspaceId == workspaceId }
      List {
        Section {
          LabeledContent("Path") {
            Text(workspace.path).font(.caption.monospaced()).lineLimit(1).truncationMode(.middle)
          }
          .contextMenu {
            Button {
              UIPasteboard.general.string = workspace.path
            } label: {
              Label("Copy Path", systemImage: "doc.on.doc")
            }
          }
          if let git = workspace.git {
            LabeledContent("Branch", value: git.branch ?? "detached HEAD")
            if let upstream = git.upstream {
              LabeledContent("Upstream", value: "\(upstream) ↑\(git.ahead) ↓\(git.behind)")
            }
          }
        }

        Section("Agents") {
          ForEach(agents) { agent in
            NavigationLink(value: Route.agent(agent.id)) {
              AgentRow(agent: agent, session: session, showWorkspace: false)
            }
          }
          Button {
            model.newAgent = NewAgentRequest(context: .workspace(workspaceId))
          } label: {
            Label("New agent here", systemImage: "square.and.pencil")
          }
        }

        if let git = workspace.git {
          Section {
            NavigationLink(value: Route.changes(workspaceId: workspaceId, agentId: nil, scope: .working)) {
              LabeledContent {
                if git.changed > 0 { Pill(text: "\(git.changed)", color: .orange) }
              } label: {
                Label("Changes", systemImage: "plus.forwardslash.minus")
              }
            }
            NavigationLink(value: Route.history(workspaceId: workspaceId)) {
              Label("History", systemImage: "clock.arrow.circlepath")
            }
            NavigationLink(value: Route.search(workspaceId: workspaceId)) {
              Label("Search files", systemImage: "magnifyingglass")
            }
          }

          Section("Pull request") {
            PullRequestRow(status: pullRequest)
          }

          Section {
            Button {
              creatingWorktree = true
            } label: {
              Label("New worktree", systemImage: "arrow.triangle.branch")
            }
            if git.linked {
              Button(role: .destructive) {
                confirmingRemoval = true
              } label: {
                Label("Remove this worktree", systemImage: "trash")
              }
            }
          } footer: {
            Text(git.linked ? "Removing keeps the branch; a checkout with uncommitted changes isn't removed." : "A worktree is a separate checkout on a new branch, so an agent can work apart from the others.")
          }
        }
      }
      .navigationTitle(workspace.label)
      .refreshable {
        await failure.run("Refresh") { _ = try await session.api.refreshWorkspace(workspaceId) }
        await loadPullRequest(refresh: true)
      }
      .task { await loadPullRequest(refresh: false) }
      .alert("New worktree", isPresented: $creatingWorktree) {
        TextField("Branch (a name is picked if empty)", text: $branch)
          .autocorrectionDisabled()
          .textInputAutocapitalization(.never)
        Button("Create") {
          Task {
            await failure.run("Create the worktree") {
              let created = try await session.api.createWorktree(workspaceId: workspaceId, branch: branch)
              branch = ""
              router.push(.workspace(created.workspace.id))
            }
          }
        }
        Button("Cancel", role: .cancel) {}
      } message: {
        Text("From the latest default branch of origin.")
      }
      .confirmationDialog("Remove \(workspace.label)?", isPresented: $confirmingRemoval, titleVisibility: .visible) {
        Button("Remove", role: .destructive) {
          Task {
            await failure.run("Remove the worktree") {
              try await session.api.removeWorktree(workspaceId: workspaceId, force: false)
              router.pop()
            }
          }
        }
      } message: {
        Text("Its agents stop. The branch stays.")
      }
      .failureAlert(failure)
      .onAppear { session.show(route: "/w/\(workspaceId)", agent: nil) }
    } else {
      ContentUnavailableView("No such workspace", systemImage: "folder.badge.questionmark")
    }
  }

  private func loadPullRequest(refresh: Bool) async {
    pullRequest = try? await session.api.pullRequest(workspaceId: workspaceId, refresh: refresh)
  }
}

private struct PullRequestRow: View {
  let status: PullRequestStatus?
  @Environment(\.openURL) private var openURL

  var body: some View {
    if let status {
      if let pr = status.pr {
        Button {
          if let url = URL(string: pr.url) { openURL(url) }
        } label: {
          VStack(alignment: .leading, spacing: 4) {
            HStack {
              Text("#\(pr.number)").foregroundStyle(.secondary)
              Text(pr.title).lineLimit(2)
            }
            .font(.subheadline.weight(.medium))
            HStack(spacing: 8) {
              Pill(text: pr.state, color: pr.state == "merged" ? .purple : pr.state == "open" ? .green : .secondary)
              Pill(text: checks(pr.checks), color: pr.checks.state == "passing" ? .green : pr.checks.state == "failing" ? .red : .orange)
              if pr.review != "none" && pr.review != "unknown" {
                Pill(text: pr.review.replacingOccurrences(of: "_", with: " "), color: pr.review == "approved" ? .green : .orange)
              }
            }
          }
        }
        .buttonStyle(.plain)
      } else {
        Text(status.message ?? "No pull request for this branch.").font(.subheadline).foregroundStyle(.secondary)
      }
    } else {
      ProgressView()
    }
  }

  private func checks(_ checks: PullRequestStatus.Checks) -> String {
    switch checks.state {
    case "passing": "checks pass"
    case "failing": "\(checks.failed) failing"
    case "pending": "\(checks.pending) pending"
    case "none": "no checks"
    default: checks.state
    }
  }
}

/// Add a folder of the computer as a workspace, by browsing the computer's disk.
struct AddWorkspaceView: View {
  let session: Session
  @Environment(\.dismiss) private var dismiss
  @State private var listing: DirectoryListing?
  @State private var error: String?
  @State private var failure = Failure()

  var body: some View {
    NavigationStack {
      List {
        if let listing {
          Section {
            Button {
              Task { await add(listing.path) }
            } label: {
              Label("Add \((listing.path as NSString).lastPathComponent)", systemImage: "plus.circle.fill")
            }
          } footer: {
            Text(listing.path).font(.caption.monospaced())
          }
          Section {
            if let parent = listing.parent {
              Button {
                Task { await browse(parent) }
              } label: {
                Label("..", systemImage: "arrow.turn.left.up")
              }
            }
            ForEach(listing.entries) { entry in
              Button {
                Task { await browse(entry.path) }
              } label: {
                HStack {
                  Image(systemName: entry.repo ? "shippingbox.fill" : "folder").foregroundStyle(entry.repo ? Color.orange : .accentColor)
                  Text(entry.name).foregroundStyle(.primary)
                  Spacer()
                  if entry.repo { Text("git").font(.caption).foregroundStyle(.secondary) }
                }
              }
              .swipeActions {
                Button("Add") { Task { await add(entry.path) } }.tint(.green)
              }
            }
          }
        } else if let error {
          Label(error, systemImage: "exclamationmark.triangle")
        } else {
          ProgressView().frame(maxWidth: .infinity)
        }
      }
      .navigationTitle("Add a Workspace")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
      }
      .task { await browse(nil) }
      .failureAlert(failure)
    }
  }

  private func browse(_ path: String?) async {
    do {
      listing = try await session.api.browse(path: path)
    } catch {
      self.error = (error as? RowrowError)?.errorDescription ?? error.localizedDescription
    }
  }

  private func add(_ path: String) async {
    await failure.run("Add the workspace") {
      _ = try await session.api.addWorkspace(path: path)
      dismiss()
    }
  }
}
