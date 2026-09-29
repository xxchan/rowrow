import RowrowCore
import SwiftUI

/// Start an agent (D-023): say what it should do first (type or dictate); where and how it
/// runs are already filled in from where you started it and what you used there last, one
/// tap away if you want others. This device remembers the setup per workspace.
struct NewAgentView: View {
  let request: NewAgentRequest
  let session: Session
  @Environment(AppModel.self) private var model
  @Environment(\.dismiss) private var dismiss
  @State private var text = ""
  @State private var workspaceId: String?
  @State private var runtime: String?
  @State private var modelId: String?
  @State private var effort: String?
  @State private var isolate = false
  @State private var branch = ""
  @State private var models: [ModelInfo] = []
  @State private var modelsError: String?
  @State private var starting = false
  @State private var resolved = false
  @State private var failure = Failure()
  @FocusState private var focused: Bool

  private var prefsKey: String { "rowrow.newAgent.\(session.account.id.uuidString)" }
  /// Where this form's attachments wait (D-024).
  private var filesKey: String { "new:\(request.id)" }

  var body: some View {
    let state = session.state
    let workspaces = orderedWorkspaces(state)
    let workspace = workspaceId.flatMap { state?.workspaces[$0] }
    let runtimes = (state?.runtimes.values.filter(\.installed) ?? []).sorted { $0.name < $1.name }
    let chosenModel = models.first { $0.id == modelId }
    NavigationStack {
      Form {
        Section {
          VStack(alignment: .leading, spacing: 8) {
            TextField("What should it do?", text: $text, axis: .vertical)
              .lineLimit(5...14)
              .focused($focused)
            PendingTiles(key: filesKey)
            AttachButton(key: filesKey, session: session)
              .buttonStyle(.borderless)
              .padding(.leading, -8)
          }
        } footer: {
          Text("Leave it empty to start the agent without a first message.")
        }

        Section {
          Picker(selection: $workspaceId) {
            ForEach(workspaces, id: \.workspace.id) { entry in
              Text(entry.depth > 0 ? "↳ \(entry.workspace.label)" : entry.workspace.label)
                .tag(String?.some(entry.workspace.id))
            }
          } label: {
            Label("Workspace", systemImage: "folder")
          }
          if workspace?.git != nil {
            Toggle(isOn: $isolate) {
              Label("In a new worktree", systemImage: "arrow.triangle.branch")
            }
            if isolate {
              TextField("Branch (a name is picked if empty)", text: $branch)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
            }
          }
        } footer: {
          if isolate {
            Text("A new branch and checkout from the default branch of origin, so it works apart from the others.")
          }
        }

        Section {
          Picker(selection: $runtime) {
            ForEach(runtimes) { runtime in
              Label {
                Text(runtime.name)
              } icon: {
                RuntimeMark(runtime: runtime.id, size: 18)
              }
              .tag(String?.some(runtime.id))
            }
          } label: {
            Label("Agent", systemImage: "cpu")
          }
          Picker(selection: $modelId) {
            Text("Default").tag(String?.none)
            ForEach(models) { Text($0.name).tag(String?.some($0.id)) }
          } label: {
            Label("Model", systemImage: "sparkles")
          }
          if let levels = chosenModel?.effortLevels, !levels.isEmpty {
            Picker(selection: $effort) {
              Text("Default").tag(String?.none)
              ForEach(levels, id: \.self) { Text($0.capitalized).tag(String?.some($0)) }
            } label: {
              Label("Effort", systemImage: "gauge.with.dots.needle.50percent")
            }
          }
        } footer: {
          if let modelsError { Text(modelsError) }
        }
      }
      .scrollDismissesKeyboard(.interactively)
      .navigationTitle("New Agent")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
        ToolbarItem(placement: .confirmationAction) {
          Button {
            Task { await start() }
          } label: {
            if starting { ProgressView() } else { Text("Start") }
          }
          .disabled(starting || workspaceId == nil || runtime == nil)
        }
      }
      .task { await resolve() }
      .task(id: runtime) { await loadModels() }
      .onChange(of: workspaceId) { _, id in
        if state?.workspaces[id ?? ""]?.git == nil { isolate = false }
      }
      .failureAlert(failure)
      .onAppear {
        text = request.text
        focused = true
      }
    }
    .presentationDetents([.large])
  }

  /// Repositories first, each followed by its worktrees.
  private func orderedWorkspaces(_ state: AppState?) -> [(workspace: Workspace, depth: Int)] {
    let all = (state?.workspaces.values.filter { !$0.archived } ?? []).sorted {
      $0.label.localizedCaseInsensitiveCompare($1.label) == .orderedAscending
    }
    var out: [(Workspace, Int)] = []
    for parent in all where parent.parentId == nil || state?.workspaces[parent.parentId ?? ""] == nil {
      out.append((parent, 0))
      for child in all where child.parentId == parent.id { out.append((child, 1)) }
    }
    return out
  }

  private func resolve() async {
    guard !resolved, let stateJSON = session.stateJSON() else { return }
    resolved = true
    let kit = await session.readyKit()
    let prefs = UserDefaults.standard.string(forKey: prefsKey)
    guard let setup = try? await kit.resolveSetup(state: stateJSON, context: request.context, prefs: prefs) else { return }
    workspaceId = setup.workspaceId
    runtime = setup.runtime
    modelId = setup.model
    effort = setup.effort
    isolate = setup.isolate
  }

  private func loadModels() async {
    guard let runtime else { return }
    models = []
    modelsError = nil
    do {
      let list = try await session.api.models(runtime: runtime)
      models = list.models
      modelsError = list.error
      if let modelId, !models.contains(where: { $0.id == modelId }) { self.modelId = nil }
    } catch {
      modelsError = (error as? RowrowError)?.errorDescription ?? error.localizedDescription
    }
  }

  private func start() async {
    guard let workspaceId, let runtime else { return }
    starting = true
    defer { starting = false }
    await failure.run("Start the agent") {
      let files: [Attachment]
      switch model.readyAttachments(filesKey) {
      case .success(let ready): files = ready
      case .failure(let problem): throw RowrowError.server(status: 400, code: "BAD_REQUEST", message: problem.message)
      }
      var target = workspaceId
      if isolate {
        let created = try await session.api.createWorktree(workspaceId: workspaceId, branch: branch)
        target = created.workspace.id
      }
      let effortToUse = models.first { $0.id == modelId }?.effortLevels.isEmpty == false ? effort : nil
      let created = try await session.api.createAgent(
        workspaceId: target, runtime: runtime, model: modelId, effort: effortToUse, text: text, attachments: files)
      model.attachments[filesKey] = nil
      if let sent = created.sent, sent.landed == .failed || sent.landed == .rejected {
        model.drafts[created.agent.id] = text
      }
      let kit = await session.readyKit()
      let setup = AgentSetup(workspaceId: nil, runtime: runtime, model: modelId, effort: effortToUse, isolate: isolate)
      if let prefs = try? await kit.remember(prefs: UserDefaults.standard.string(forKey: prefsKey), workspaceId: workspaceId, setup: setup) {
        UserDefaults.standard.set(prefs, forKey: prefsKey)
      }
      dismiss()
      model.router.open(agent: created.agent.id)
    }
  }
}
