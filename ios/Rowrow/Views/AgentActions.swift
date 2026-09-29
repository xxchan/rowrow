import RowrowCore
import SwiftUI

/// What you can do to an agent, the same wherever it shows (a swipe, a long press, the ⋯ menu
/// of its conversation). Actions that need more (a name, a model) open their own sheet.
@MainActor
@Observable
final class AgentActions {
  var renaming: AgentState?
  var newTitle = ""
  var choosingModel: AgentState?
  let failure = Failure()
  @ObservationIgnored weak var session: Session?

  func markSeen(_ agent: AgentState) {
    run("Mark as seen") { try await $0.markSeen(agentId: agent.id, seq: agent.summary.headSeq) }
  }

  func stopTurn(_ agent: AgentState) {
    run("Stop") { api in
      let result = try await api.abort(agentId: agent.id)
      if !result.accepted, let reason = result.reason {
        throw RowrowError.server(status: 409, code: "CONFLICT", message: reason)
      }
    }
  }

  func stopProcess(_ agent: AgentState) {
    run("Stop the process") { try await $0.stop(agentId: agent.id) }
  }

  func archive(_ agent: AgentState, _ archived: Bool = true) {
    run(archived ? "Archive" : "Unarchive") { try await $0.updateAgent(agent.id, archived: archived) }
  }

  func rename(_ agent: AgentState) {
    newTitle = agent.summary.title ?? ""
    renaming = agent
  }

  func saveTitle() {
    guard let agent = renaming else { return }
    let title = newTitle.trimmingCharacters(in: .whitespacesAndNewlines)
    renaming = nil
    run("Rename") { try await $0.updateAgent(agent.id, title: .some(title.isEmpty ? nil : title)) }
  }

  private func run(_ what: String, _ action: @escaping (APIClient) async throws -> Void) {
    guard let api = session?.api else { return }
    Task { await failure.run(what) { try await action(api) } }
  }
}

extension View {
  /// The sheets and alerts agent actions open.
  func agentActions(_ actions: AgentActions, session: Session) -> some View {
    modifier(AgentActionsModifier(actions: actions, session: session))
  }
}

private struct AgentActionsModifier: ViewModifier {
  @Bindable var actions: AgentActions
  let session: Session

  func body(content: Content) -> some View {
    content
      .onAppear { actions.session = session }
      .alert(
        "Rename",
        isPresented: Binding(get: { actions.renaming != nil }, set: { if !$0 { actions.renaming = nil } })
      ) {
        TextField("Title", text: $actions.newTitle)
        Button("Save") { actions.saveTitle() }
        Button("Cancel", role: .cancel) {}
      } message: {
        Text("Leave it empty to name it after its first message.")
      }
      .sheet(item: $actions.choosingModel) { agent in
        ModelSheet(agent: agent, session: session)
      }
      .failureAlert(actions.failure)
  }
}

/// The agent's actions as menu items (a long press, the ⋯ menu).
struct AgentMenuItems: View {
  let agent: AgentState
  let actions: AgentActions
  let session: Session
  @Environment(AppModel.self) private var model

  var body: some View {
    let workspace = session.state?.workspaces[agent.summary.workspaceId]
    Section {
      if agent.attention.needsYou {
        Button {
          actions.markSeen(agent)
        } label: {
          Label("Mark as Seen", systemImage: "checkmark.circle")
        }
      }
      if agent.attention == .working {
        Button(role: .destructive) {
          actions.stopTurn(agent)
        } label: {
          Label("Stop the Turn", systemImage: "stop.circle")
        }
      }
    }
    Section {
      Button {
        actions.rename(agent)
      } label: {
        Label("Rename…", systemImage: "pencil")
      }
      if !agent.summary.archived {
        Button {
          actions.choosingModel = agent
        } label: {
          Label("Model and Effort…", systemImage: "cpu")
        }
      }
      if agent.summary.run != nil {
        Button {
          actions.stopProcess(agent)
        } label: {
          Label("Stop the Agent Process", systemImage: "power")
        }
      }
    }
    if let workspace {
      Section {
        Button {
          model.newAgent = NewAgentRequest(context: .agent(agent.id))
        } label: {
          Label("New Agent Like This", systemImage: "plus.square.on.square")
        }
        Button {
          model.router.push(.workspace(workspace.id))
        } label: {
          Label("Open \(workspace.label)", systemImage: "folder")
        }
      }
    }
    Section {
      Button {
        actions.archive(agent, !agent.summary.archived)
      } label: {
        Label(agent.summary.archived ? "Unarchive" : "Archive", systemImage: agent.summary.archived ? "tray.and.arrow.up" : "archivebox")
      }
    }
  }
}

/// Switch an agent's model and reasoning effort; the live run restarts with them, resuming the conversation.
struct ModelSheet: View {
  let agent: AgentState
  let session: Session
  @Environment(\.dismiss) private var dismiss
  @State private var models: [ModelInfo] = []
  @State private var loadError: String?
  @State private var loading = true
  @State private var model: String?
  @State private var effort: String?
  @State private var failure = Failure()

  var body: some View {
    let runtime = session.state?.runtimeName(agent.summary.runtime) ?? agent.summary.runtime
    let chosen = models.first { $0.id == model }
    NavigationStack {
      Form {
        Section {
          Picker("Model", selection: $model) {
            Text("Default").tag(String?.none)
            ForEach(models) { Text($0.name).tag(String?.some($0.id)) }
          }
          .pickerStyle(.inline)
          .labelsHidden()
        } header: {
          Text("Model")
        } footer: {
          if loading {
            ProgressView()
          } else if let loadError {
            Text(loadError)
          } else {
            Text("Default is \(runtime)'s own choice: its settings file, or its built-in default. Now: \(agent.summary.reportedModel ?? "not reported yet").")
          }
        }
        if let levels = chosen?.effortLevels, !levels.isEmpty {
          Section("Reasoning effort") {
            Picker("Effort", selection: $effort) {
              Text("Default").tag(String?.none)
              ForEach(levels, id: \.self) { Text($0.capitalized).tag(String?.some($0)) }
            }
            .pickerStyle(.segmented)
          }
        }
      }
      .navigationTitle("Model and Effort")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
        ToolbarItem(placement: .confirmationAction) {
          Button("Switch") {
            Task {
              await failure.run("Switch the model") {
                try await session.api.updateAgent(agent.id, model: .some(model), effort: .some(chosen?.effortLevels.isEmpty == false ? effort : nil))
                dismiss()
              }
            }
          }
          .disabled(model == agent.summary.model && effort == agent.summary.effort)
        }
      }
      .task {
        model = agent.summary.model
        effort = agent.summary.effort
        do {
          let list = try await session.api.models(runtime: agent.summary.runtime)
          models = list.models
          loadError = list.error
        } catch {
          loadError = (error as? RowrowError)?.errorDescription ?? error.localizedDescription
        }
        loading = false
      }
      .failureAlert(failure)
    }
    .presentationDetents([.medium, .large])
  }
}
