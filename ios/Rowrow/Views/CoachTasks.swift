import RowrowCore
import SwiftUI

/// Coach's scheduled tasks (D-050), as the web app lists them: each one's schedule, its current
/// or last run, and its next. Run now, Pause and Resume here; writing or changing a task stays in
/// the web app for now (or ask Coach to propose one in its chat).
struct CoachTasksList: View {
  let session: Session
  @State private var failure = Failure()

  var body: some View {
    let tasks = session.state?.coach?.tasks ?? []
    List {
      if tasks.isEmpty {
        Section {
          ContentUnavailableView {
            Label("No tasks yet", systemImage: "checklist")
          } description: {
            Text(
              "A task checks on your agents once or on a schedule. Create one in rowrow on your computer (Coach → Tasks), or ask Coach to propose one."
            )
          }
        }
      } else {
        Section {
          ForEach(tasks) { task in
            NavigationLink(value: Route.coachTask(task.id)) {
              CoachTaskRow(task: task)
            }
            .swipeActions(edge: .leading) {
              Button {
                act("Run it now") { try await $0.coachRunTask(task.id) }
              } label: {
                Label("Run Now", systemImage: "play")
              }
              .tint(.accentColor)
              .disabled(task.currentRun != nil || task.queuedAt != nil)
            }
            .swipeActions(edge: .trailing) {
              pauseButton(task)
            }
            .contextMenu {
              Button {
                act("Run it now") { try await $0.coachRunTask(task.id) }
              } label: {
                Label("Run Now", systemImage: "play")
              }
              .disabled(task.currentRun != nil || task.queuedAt != nil)
              pauseButton(task)
            }
          }
        } footer: {
          Text("Runs continue in the background. To create or edit a task, use rowrow on your computer (Coach → Tasks).")
        }
      }
    }
    .listStyle(.insetGrouped)
    .navigationTitle("Tasks")
    .navigationBarTitleDisplayMode(.inline)
    .refreshable { session.retryNow() }
    .failureAlert(failure)
  }

  private func pauseButton(_ task: CoachTask) -> some View {
    Button {
      act(task.status == .paused ? "Resume" : "Pause") { try await $0.coachPauseTask(task.id, paused: task.status == .active) }
    } label: {
      Label(
        task.status == .paused ? "Resume" : "Pause",
        systemImage: task.status == .paused ? "play.circle" : "pause.circle")
    }
    .tint(.indigo)
  }

  private func act(_ what: String, _ action: @escaping (APIClient) async throws -> Void) {
    let api = session.api
    Task { await failure.run(what) { try await action(api) } }
  }
}

/// A task in the list: its name and state, its schedule, its runs.
private struct CoachTaskRow: View {
  let task: CoachTask

  var body: some View {
    VStack(alignment: .leading, spacing: 3) {
      HStack(alignment: .firstTextBaseline) {
        Text(task.title).font(.body.weight(.semibold)).lineLimit(2)
        Spacer(minLength: 8)
        TaskStateChip(task: task)
      }
      Text(task.schedule.label()).font(.subheadline).foregroundStyle(.secondary)
      Text(CoachWords.runLine(task)).font(.caption).foregroundStyle(.secondary)
      Text(CoachWords.nextLine(task)).font(.caption).foregroundStyle(.secondary)
    }
    .padding(.vertical, 2)
  }
}

private struct TaskStateChip: View {
  let task: CoachTask

  var body: some View {
    Pill(text: task.status.rawValue, color: task.status == .active ? .accentColor : .secondary)
  }
}

/// A task (D-050): its schedule, prompt and permission, Run now, Pause or Resume, Stop run and
/// Delete, and its run history, each run opening its chat.
struct CoachTaskView: View {
  let taskId: String
  let session: Session
  @Environment(AppModel.self) private var model
  @State private var runs: [CoachTaskRun]?
  @State private var loadError: String?
  @State private var deleting = false
  @State private var failure = Failure()

  var body: some View {
    Group {
      if let task = session.state?.coach?.tasks.first(where: { $0.id == taskId }) {
        content(task)
      } else if session.state == nil {
        ProgressView()
      } else {
        ContentUnavailableView(
          "No such task", systemImage: "checklist", description: Text("This Coach task is no longer available."))
      }
    }
    .navigationBarTitleDisplayMode(.inline)
    .confirmationDialog("Delete this task?", isPresented: $deleting, titleVisibility: .visible) {
      Button("Delete Task", role: .destructive) { delete() }
    } message: {
      Text(
        "Permanently delete this task and all of its run history. A run going now is stopped; a run you carried on in Coach's chat stays there."
      )
    }
    .failureAlert(failure)
  }

  private func content(_ task: CoachTask) -> some View {
    let fullAccessNow = session.state?.settings.coach?.fullAccess ?? false
    let running = task.currentRun != nil
    return List {
      Section {
        VStack(alignment: .leading, spacing: 6) {
          HStack(alignment: .firstTextBaseline) {
            Text(task.title).font(.title3.weight(.semibold))
            Spacer(minLength: 8)
            TaskStateChip(task: task)
          }
          Text("\(task.schedule.label()) / \(CoachWords.nextLine(task))").font(.subheadline).foregroundStyle(.secondary)
          Text(CoachWords.permission(task, fullAccessNow: fullAccessNow)).font(.footnote).foregroundStyle(.secondary)
          Text(task.notify.label).font(.footnote).foregroundStyle(.secondary)
        }
        DisclosureGroup("Task prompt") {
          Text(task.prompt).font(.callout).textSelection(.enabled)
        }
      } footer: {
        Text("To edit this task, use rowrow on your computer (Coach → Tasks).")
      }

      Section {
        Button {
          act("Run it now") { try await $0.coachRunTask(task.id) }
        } label: {
          Label("Run Now", systemImage: "play")
        }
        .disabled(running || task.queuedAt != nil)
        Button {
          act(task.status == .paused ? "Resume" : "Pause") {
            try await $0.coachPauseTask(task.id, paused: task.status == .active)
          }
        } label: {
          Label(
            task.status == .paused ? "Resume" : "Pause",
            systemImage: task.status == .paused ? "play.circle" : "pause.circle")
        }
        if running {
          Button {
            act("Stop the run") { try await $0.coachStopTask(task.id) }
          } label: {
            Label("Stop Run", systemImage: "stop.circle")
          }
        }
        Button(role: .destructive) {
          deleting = true
        } label: {
          Label("Delete Task", systemImage: "trash")
        }
      }

      Section("Run history") {
        if let runs {
          if runs.isEmpty {
            Text("No runs yet.").foregroundStyle(.secondary)
          }
          ForEach(runs) { run in
            NavigationLink(value: Route.coachRun(taskId: task.id, runId: run.id)) {
              CoachRunRow(run: run)
            }
          }
        } else if let loadError {
          Label(loadError, systemImage: "exclamationmark.triangle").font(.footnote).foregroundStyle(.orange)
        } else {
          ProgressView("Loading run history").frame(maxWidth: .infinity)
        }
      }
    }
    .listStyle(.insetGrouped)
    .navigationTitle(task.title)
    // Read again whenever a run starts, moves on or ends.
    .task(id: task.runsSignature) { await loadRuns() }
  }

  private func loadRuns() async {
    do {
      runs = try await session.api.coachTaskRuns(taskId: taskId)
      loadError = nil
    } catch is CancellationError {
    } catch {
      loadError = (error as? RowrowError)?.errorDescription ?? error.localizedDescription
    }
  }

  private func act(_ what: String, _ action: @escaping (APIClient) async throws -> Void) {
    let api = session.api
    Task { await failure.run(what) { try await action(api) } }
  }

  /// Back to the list once it's gone (it leaves the app state as the call answers).
  private func delete() {
    let api = session.api
    let taskId = self.taskId
    Task {
      await failure.run("Delete the task") {
        try await api.coachDeleteTask(taskId)
        if model.router.coach.last == Route.coachTask(taskId) { model.router.coach.removeLast() }
      }
    }
  }
}

/// A run in a task's history: when, how it went, why it failed.
private struct CoachRunRow: View {
  let run: CoachTaskRun

  var body: some View {
    VStack(alignment: .leading, spacing: 3) {
      HStack(alignment: .firstTextBaseline) {
        Text(CoachWords.at(run.scheduledAt))
        if run.manual { Text("Run now").font(.caption).foregroundStyle(.secondary) }
        Spacer(minLength: 8)
        Pill(text: run.status.rawValue, color: runColor(run.status))
      }
      if let error = run.error {
        Text(error).font(.caption).foregroundStyle(.red).lineLimit(3)
      }
    }
  }
}

private func runColor(_ status: CoachTaskRun.Status) -> Color {
  switch status {
  case .running, .waiting: .accentColor
  case .succeeded: .green
  case .failed: .red
  case .stopped: .secondary
  }
}

/// One run of a task: how it went, and its chat (the task's prompt, Coach's answer), read here
/// with its proposals to confirm. Open in Chat carries it on in Coach's chat.
struct CoachRunView: View {
  let taskId: String
  let runId: String
  let session: Session
  @Environment(AppModel.self) private var model
  @State private var run: CoachTaskRun?
  @State private var loadError: String?
  @State private var failure = Failure()

  var body: some View {
    let task = session.state?.coach?.tasks.first { $0.id == taskId }
    Group {
      if let run {
        ScrollView {
          VStack(alignment: .leading, spacing: 14) {
            HStack {
              Pill(text: run.status.rawValue, color: runColor(run.status))
              Text("Started \(CoachWords.at(run.startedAt))\(run.manual ? " · Run now" : "")")
                .font(.caption)
                .foregroundStyle(.secondary)
            }
            if let error = run.error {
              Label(error, systemImage: "exclamationmark.octagon.fill")
                .font(.subheadline)
                .foregroundStyle(.red)
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(.red.opacity(0.1), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            }
            if let chatId = run.chatId,
              let store = model.transcript(id: chatId, runtime: session.state?.settings.coach?.runtime ?? "claude")
            {
              CoachTranscript(store: store, chatId: chatId, working: run.status == .running, session: session)
            }
          }
          .padding()
        }
      } else if let loadError {
        ContentUnavailableView("Couldn't show this run", systemImage: "exclamationmark.triangle", description: Text(loadError))
      } else {
        ProgressView()
      }
    }
    .navigationTitle(task?.title ?? "Task run")
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      if let chatId = run?.chatId {
        ToolbarItem(placement: .primaryAction) {
          Button("Open in Chat") { openInChat(chatId) }
        }
      }
    }
    // Read again whenever one of the task's runs starts, moves on or ends.
    .task(id: task?.runsSignature ?? "") { await load() }
    .failureAlert(failure)
  }

  private func load() async {
    do {
      let runs = try await session.api.coachTaskRuns(taskId: taskId)
      if let found = runs.first(where: { $0.id == runId }) {
        run = found
        loadError = nil
      } else {
        loadError = "This run is no longer kept: a task keeps its latest 20 runs."
      }
    } catch is CancellationError {
    } catch {
      if run == nil { loadError = (error as? RowrowError)?.errorDescription ?? error.localizedDescription }
    }
  }

  /// Make the run's chat Coach's current one, and go there.
  private func openInChat(_ chatId: String) {
    let api = session.api
    Task {
      await failure.run("Open it in Coach's chat") {
        try await api.coachOpen(chatId: chatId)
        model.router.openCoachChat()
      }
    }
  }
}
