import RowrowCore
import SwiftUI

/// The Coach tab (D-044): rowrow's assistant, as the web app's Coach window has it on a phone.
/// Ask about your agents; Coach reads the workspaces it may read, answers, and proposes actions
/// as cards you confirm (D-045). History, New chat and Stop as in the web app; its scheduled tasks
/// (D-050) one tap away. Coach's settings, turning Full access on, and writing a task stay in the
/// web app for now; the header says when Full access is on, and turns it off.
struct CoachScreen: View {
  let session: Session
  @Environment(AppModel.self) private var model
  @State private var showingHistory = false
  @State private var confirmingNew = false
  @State private var failure = Failure()

  var body: some View {
    let state = session.state
    let chat = state?.coach?.chat
    let working = chat?.summary.status.isRunning ?? false
    let executing = chat?.summary.coachExecuting ?? false
    let idle = session.status.isOnline && !working && !executing
    let waitingRuns = state?.coach?.tasks.filter { $0.currentRun?.status == .waiting }.count ?? 0
    Group {
      if let chat, let store = model.transcript(for: chat) {
        CoachConversation(chat: chat, store: store, session: session)
          .id(chat.id)
      } else if state == nil {
        ProgressView()
      } else {
        ContentUnavailableView {
          Label("What would you like to work on?", systemImage: "megaphone")
        } description: {
          Text(
            "Ask about progress or changes in the workspaces you allow Coach to read. It proposes actions for you to confirm."
          )
        }
        .safeAreaInset(edge: .bottom) {
          CoachComposer(chat: nil, session: session)
            .padding(.horizontal, 12)
            .padding(.bottom, 6)
        }
      }
    }
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      ToolbarItem(placement: .principal) {
        VStack(spacing: 1) {
          HStack(spacing: 6) {
            Text(chat?.summary.title ?? "Coach").font(.headline).lineLimit(1)
            if state?.settings.coach?.fullAccess == true {
              FullAccessBadge(session: session, failure: failure)
            }
          }
          Text(CoachWords.status(online: session.status.isOnline, working: working, executing: executing))
            .font(.caption)
            .foregroundStyle(.secondary)
        }
      }
      ToolbarItem(placement: .topBarTrailing) {
        Button {
          showingHistory = true
        } label: {
          Label("History", systemImage: "clock.arrow.circlepath")
        }
        .disabled(!idle)
      }
      ToolbarItem(placement: .topBarTrailing) {
        Button {
          confirmingNew = true
        } label: {
          Label("New chat", systemImage: "square.and.pencil")
        }
        .disabled(!idle || chat == nil)
      }
      ToolbarItem(placement: .topBarTrailing) {
        Button {
          model.router.push(.coachTasks)
        } label: {
          Label("Tasks", systemImage: "checklist")
        }
        .badge(waitingRuns)
      }
    }
    .sheet(isPresented: $showingHistory) {
      CoachHistorySheet(session: session)
    }
    .confirmationDialog("Start a new Coach chat?", isPresented: $confirmingNew, titleVisibility: .visible) {
      Button("New Chat") {
        let api = session.api
        Task { await failure.run("Start a new chat") { try await api.coachNewChat() } }
      }
    } message: {
      Text("The current chat will be saved in History. Your runtime and workspace permissions stay saved.")
    }
    .failureAlert(failure)
    .onAppear { session.show(route: "/coach", agent: nil) }
  }
}

/// "Full access" in Coach's header while it's on (D-045): Coach reads and acts in every workspace
/// without asking. Turning it on takes the web app's dialog; off is one tap here.
private struct FullAccessBadge: View {
  let session: Session
  let failure: Failure

  var body: some View {
    Menu {
      Text("Coach may read and manage every workspace without asking.")
      Button(role: .destructive) {
        Task { await failure.run("Turn off Full access") { try await session.turnOffCoachFullAccess() } }
      } label: {
        Label("Turn Off Full Access", systemImage: "lock")
      }
    } label: {
      Text("Full access")
        .font(.caption2.weight(.semibold))
        .foregroundStyle(.orange)
        .padding(.horizontal, 6)
        .padding(.vertical, 2)
        .background(.orange.opacity(0.15), in: Capsule())
    }
    .accessibilityLabel("Full access: all workspaces")
  }
}

/// Coach's current chat: the conversation, following its end as Coach answers, and the composer.
private struct CoachConversation: View {
  let chat: AgentState
  let store: TranscriptStore
  let session: Session
  @State private var position = ScrollPosition(edge: .bottom)
  @State private var atBottom = true

  var body: some View {
    ScrollView {
      CoachTranscript(store: store, chatId: chat.id, working: chat.summary.status.isRunning, session: session)
        .padding(.horizontal)
        .padding(.vertical, 12)
    }
    .scrollPosition($position)
    .defaultScrollAnchor(.bottom)
    .scrollDismissesKeyboard(.interactively)
    .onScrollGeometryChange(for: Bool.self) { geometry in
      geometry.visibleRect.maxY - geometry.contentInsets.bottom >= geometry.contentSize.height - 80
    } action: { _, bottom in
      atBottom = bottom
    }
    .onChange(of: store.rows) {
      if atBottom { withAnimation(.easeOut(duration: 0.2)) { position.scrollTo(edge: .bottom) } }
    }
    .safeAreaInset(edge: .bottom) {
      CoachComposer(chat: chat, session: session)
        .padding(.horizontal, 12)
        .padding(.bottom, 6)
    }
  }
}

/// Writing to Coach (coach.send). Return is a newline (dictation needs it); the button sends,
/// and while Coach answers it stops the answer instead. A send that may not have arrived keeps
/// its id, so sending again can't deliver it twice.
private struct CoachComposer: View {
  let chat: AgentState?
  let session: Session
  @Environment(AppModel.self) private var model
  @FocusState private var focused: Bool
  @State private var pending: (text: String, inputId: String)?
  @State private var note: String?
  @State private var sending = false
  @State private var sent = 0

  private var key: String { "coach:\(chat?.id ?? "new")" }

  private var draft: Binding<String> {
    let key = self.key
    return Binding(get: { model.drafts[key] ?? "" }, set: { model.drafts[key] = $0 })
  }

  var body: some View {
    let working = chat?.summary.status.isRunning ?? false
    let executing = chat?.summary.coachExecuting ?? false
    let blocked = session.state?.coachNotice
    let empty = draft.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    VStack(alignment: .leading, spacing: 8) {
      if let blocked {
        Label(blocked, systemImage: "info.circle")
          .font(.footnote)
          .foregroundStyle(.secondary)
          .padding(.horizontal, 6)
      }
      if let note {
        Label(note, systemImage: "exclamationmark.circle")
          .font(.footnote)
          .foregroundStyle(.red)
          .padding(.horizontal, 6)
      }
      HStack(alignment: .bottom, spacing: 8) {
        TextField("Ask about your agents", text: draft, axis: .vertical)
          .lineLimit(1...8)
          .focused($focused)
          .padding(.vertical, 7)
        if working {
          Button {
            Task { await stop() }
          } label: {
            Image(systemName: "stop.circle.fill").font(.system(size: 30)).symbolRenderingMode(.hierarchical)
          }
          .tint(.red)
          .accessibilityLabel("Stop")
        } else {
          Button {
            Task { await send() }
          } label: {
            Image(systemName: "arrow.up.circle.fill").font(.system(size: 30))
          }
          .disabled(empty || sending || executing || blocked != nil || !session.status.isOnline)
          .accessibilityLabel("Send")
        }
      }
      .padding(.leading, 14)
      .padding(.trailing, 6)
      .padding(.vertical, 4)
      .glassEffect(.regular.interactive(), in: RoundedRectangle(cornerRadius: 24, style: .continuous))
    }
    .sensoryFeedback(.success, trigger: sent)
  }

  private func send() async {
    let text = draft.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty, !sending else { return }
    // The id of an attempt that may have reached the server: same text, not confirmed.
    let inputId =
      pending?.text == text ? pending?.inputId ?? UUID().uuidString.lowercased() : UUID().uuidString.lowercased()
    pending = (text, inputId)
    note = nil
    sending = true
    defer { sending = false }
    let key = self.key
    do {
      let result = try await session.api.coachSend(text: text, chatId: chat?.id, inputId: inputId)
      pending = nil
      if result.landed == .rejected || result.landed == .failed {
        note = "Not delivered: \(result.reason ?? result.code ?? result.landed.rawValue)"
      } else {
        model.drafts[key] = nil
        sent += 1
      }
    } catch {
      let message = (error as? RowrowError)?.errorDescription ?? error.localizedDescription
      note = "Not sent (\(message)). Send again: it won't arrive twice."
    }
  }

  private func stop() async {
    guard let chat else { return }
    do {
      let result = try await session.api.coachStop(chatId: chat.id)
      if !result.accepted { note = "Couldn't stop it: \(result.reason ?? "Coach isn't answering")" }
    } catch {
      note = "Couldn't stop it: \((error as? RowrowError)?.errorDescription ?? error.localizedDescription)"
    }
  }
}

/// Coach's earlier chats (coach.chats), a task's runs among them: open one to carry on with it.
private struct CoachHistorySheet: View {
  let session: Session
  @Environment(\.dismiss) private var dismiss
  @State private var chats: [CoachChat]?
  @State private var failure = Failure()

  var body: some View {
    NavigationStack {
      List {
        if let chats {
          if chats.isEmpty {
            Text("No saved chats yet. Your conversations are saved automatically.")
              .foregroundStyle(.secondary)
          }
          ForEach(chats) { chat in
            Button {
              open(chat)
            } label: {
              row(chat)
            }
            .disabled(chat.current)
          }
        } else {
          ProgressView().frame(maxWidth: .infinity)
        }
      }
      .navigationTitle("History")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } }
      }
      .task { await failure.run("Load Coach's chats") { chats = try await session.api.coachChats() } }
      .failureAlert(failure)
    }
  }

  private func row(_ chat: CoachChat) -> some View {
    VStack(alignment: .leading, spacing: 3) {
      HStack(spacing: 6) {
        if chat.taskId != nil { Pill(text: "Task") }
        Text(chat.title ?? "New chat").lineLimit(1)
      }
      Text(
        chat.current
          ? "Current"
          : "\(Date(millis: chat.updatedAt).formatted(date: .abbreviated, time: .shortened)) · \(chat.messages) \(chat.messages == 1 ? "message" : "messages")"
      )
      .font(.caption)
      .foregroundStyle(.secondary)
    }
    .foregroundStyle(.primary)
  }

  private func open(_ chat: CoachChat) {
    let api = session.api
    Task {
      await failure.run("Open the chat") {
        try await api.coachOpen(chatId: chat.id)
        dismiss()
      }
    }
  }
}
