import Foundation
import Testing

@testable import RowrowCore

/// A real rowrow server from this checkout: the scripted runtime (no tokens), a throwaway
/// home, a port of its own. Skipped when the checkout's Node tooling isn't there.
final class LocalServer: @unchecked Sendable {
  static let repo = URL(filePath: #filePath).deletingLastPathComponent().appending(path: "../../../..").standardized

  /// Vite's own script: pnpm's `node_modules/.bin/vite` is a shell shim that Node can't run.
  static let vite = "node_modules/vite/bin/vite.js"

  static var available: Bool {
    FileManager.default.fileExists(atPath: repo.appending(path: vite).path) && node != nil
  }

  /// Node 24 as pnpm installed it for the checkout (devEngines), else the one on PATH.
  static let node: String? = {
    let candidates = (ProcessInfo.processInfo.environment["PATH"] ?? "").split(separator: ":").map {
      "\($0)/node"
    } + ["/opt/homebrew/bin/node", "/usr/local/bin/node"]
    return candidates.first { FileManager.default.isExecutableFile(atPath: $0) }
  }()

  let home: URL
  let process: Process
  let url: URL
  let token: String

  private init(home: URL, process: Process, url: URL, token: String) {
    self.home = home
    self.process = process
    self.url = url
    self.token = token
  }

  static func run(_ arguments: [String], env: [String: String] = [:]) throws -> String {
    let process = Process()
    process.executableURL = URL(filePath: node ?? "/usr/bin/false")
    process.arguments = arguments
    process.currentDirectoryURL = repo
    process.environment = ProcessInfo.processInfo.environment.merging(env) { $1 }
    let out = Pipe()
    let err = Pipe()
    process.standardOutput = out
    process.standardError = err
    try process.run()
    let data = out.fileHandleForReading.readDataToEndOfFile()
    let message = err.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    // A failure here must fail the test: a kit that didn't build would leave an old one in dist/kit.
    guard process.terminationStatus == 0 else {
      throw JSONError(
        description: "\(arguments.joined(separator: " ")) exited with \(process.terminationStatus): \(String(decoding: message, as: UTF8.self))"
      )
    }
    return String(decoding: data, as: UTF8.self)
  }

  static func start() async throws -> LocalServer {
    // The kit the server serves: built from this checkout's src/shared.
    _ = try run([vite, "build", "--config", "vite.kit.config.ts", "--logLevel", "silent"])
    let home = FileManager.default.temporaryDirectory.appending(path: "rowrow-swift-\(UUID().uuidString)")
    let process = Process()
    process.executableURL = URL(filePath: node ?? "/usr/bin/false")
    process.arguments = ["src/cli/main.ts", "serve", "--profile", "swift", "--port", "0", "--test-runtime"]
    process.currentDirectoryURL = repo
    process.environment = ProcessInfo.processInfo.environment.merging(["ROWROW_HOME": home.path]) { $1 }
    process.standardOutput = FileHandle.nullDevice
    process.standardError = FileHandle.nullDevice
    try process.run()
    let file = home.appending(path: "swift/server.json")
    for _ in 0..<100 {
      if let data = try? Data(contentsOf: file),
        let info = try? JSONDecoder().decode([String: JSONValue].self, from: data),
        case .string(let url) = info["url"], case .string(let token) = info["token"]
      {
        return LocalServer(home: home, process: process, url: URL(string: url)!, token: token)
      }
      try await Task.sleep(for: .milliseconds(100))
    }
    process.terminate()
    throw JSONError(description: "the server didn't start")
  }

  /// A fresh sign-in link, as `rowrow pair` prints it.
  func link(name: String = "") throws -> String {
    let out = try Self.run(["src/cli/main.ts", "--profile", "swift", "pair"] + (name.isEmpty ? [] : [name]), env: ["ROWROW_HOME": home.path])
    return String(out.split(separator: "\n").first ?? "")
  }

  /// A small git repository to work in.
  func repository() throws -> String {
    let dir = FileManager.default.temporaryDirectory.appending(path: "rowrow-swift-repo-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    try "# test\n".write(to: dir.appending(path: "README.md"), atomically: true, encoding: .utf8)
    for args in [["init", "-q", "-b", "main"], ["add", "."], ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]] {
      let git = Process()
      git.executableURL = URL(filePath: "/usr/bin/git")
      git.arguments = args
      git.currentDirectoryURL = dir
      try git.run()
      git.waitUntilExit()
    }
    return dir.resolvingSymlinksInPath().path
  }

  func stop() {
    process.terminate()
    process.waitUntilExit()
    try? FileManager.default.removeItem(at: home)
  }
}

@Suite(.serialized, .enabled(if: LocalServer.available, "needs the checkout's node_modules and Node"))
struct AgainstARealServer {
  @Test func pairsReplicatesTheStateAndFoldsTranscripts() async throws {
    let server = try await LocalServer.start()
    defer { server.stop() }

    // Pairing: a sign-in link becomes this device's bearer token.
    let pairing = try await APIClient.pair(link: server.link(), deviceName: "Swift test iPhone")
    #expect(pairing.baseURL.absoluteString.hasPrefix(server.url.absoluteString))
    let api = APIClient(baseURL: pairing.baseURL, token: pairing.token)
    let me = try await api.whoami()
    #expect(me.kind == .app)
    #expect(me.name == "Swift test iPhone")
    await #expect(throws: RowrowError.self) { try await APIClient.pair(link: "https://example.com/nope", deviceName: "x") }

    // Work for an agent to do.
    let workspace = try await api.addWorkspace(path: server.repository())
    let created = try await api.createAgent(
      workspaceId: workspace.id, runtime: "scripted", model: nil, effort: nil, text: "/write notes.md\nhello\nworld")
    #expect(created.sent?.landed == .prompted)

    // The app state: a snapshot, then patches, applied to a tree that decodes into the models.
    var tree: JSONValue?
    var state: AppState?
    for try await message in api.stream("state.watch", ["connection": "swift-test-0001"]) {
      let json = try JSONValue.parse(Data(message.utf8))
      if json["kind"] == .string("snapshot") {
        tree = json["state"]
      } else if case .array(let patches) = json["patches"] {
        try tree?.apply(patches.map(Patch.init(json:)))
      }
      state = try tree?.decode(AppState.self)
      // Done, and the server has finished probing which runtimes are installed.
      if state?.agents[created.agent.id]?.attention == .done, state?.runtimes["scripted"]?.installed == true { break }
    }
    let agent = try #require(state?.agents[created.agent.id])
    #expect(agent.title == "/write notes.md")
    #expect(agent.summary.runtime == "scripted")
    #expect(state?.workspaces[workspace.id]?.git?.branch == "main")
    #expect(state?.runtimes["scripted"]?.test == true)
    #expect(state?.host.apns == false)

    // The kit: downloaded once, then answered with 304.
    guard case .changed(let source, let etag) = try await api.kit(etag: nil) else {
      Issue.record("no kit")
      return
    }
    guard case .unchanged = try await api.kit(etag: etag) else {
      Issue.record("the kit came again although it didn't change")
      return
    }
    let kit = try Kit(source: source)
    let handle = try await kit.open(runtime: "scripted")
    let page = try await api.raw("agents.entries", ["agentId": agent.id])
    let delta = try await kit.load(handle, page: page)
    #expect(delta.reset)
    #expect(delta.head == agent.summary.headSeq)
    let rows = TranscriptStore.rows(order: delta.order ?? [], items: Dictionary(uniqueKeysWithValues: delta.items.map { ($0.id, $0) }))
    guard case .input(let input) = rows.first, case .turn(let turn) = rows.last else {
      Issue.record("expected an input then a turn, got \(rows)")
      return
    }
    #expect(input.text == "/write notes.md\nhello\nworld")
    #expect(input.state == .sent)
    #expect(turn.outcome?.outcome == .completed)
    let tool = turn.parts.compactMap { part -> TranscriptItem.Tool? in
      if case .tool(let tool) = part { return tool }
      return nil
    }.first
    #expect(tool?.tool == "Write")
    #expect(tool?.detail == "notes.md")
    #expect(try await kit.text(handle).contains("notes.md"))

    // Words, as the web app says them.
    let words = try await kit.describe(agents: try #require(tree?["agents"]).data(), now: Date())
    #expect(words[agent.id] == StateWords(tone: "success", label: "Finished", pulsing: false))

    // What the turn changed, and the file's diff.
    let changes = try await api.changes(workspaceId: workspace.id, scope: .turn, agentId: agent.id)
    #expect(changes.files.map(\.path) == ["notes.md"])
    let diff = try await api.diff(workspaceId: workspace.id, scope: .turn, path: "notes.md", agentId: agent.id)
    #expect(diff.patch.contains("+hello"))

    // Talking to it: send, and the transcript follows over agents.watch.
    let sent = try await api.send(agentId: agent.id, text: "/echo second")
    #expect(sent.landed == .prompted)
    var echoed = false
    for try await batch in api.stream("agents.watch", ["agentId": JSONValue.string(agent.id), "after": .number(Double(delta.head))]) {
      let more = try await kit.append(handle, batch: batch)
      if more.items.contains(where: { if case .text(let text) = $0 { text.text == "second" } else { false } }) {
        echoed = true
        break
      }
    }
    #expect(echoed)

    // While it works, a message waits for the turn to end, and can be taken back until then (D-035).
    #expect(try await api.send(agentId: agent.id, text: "/sleep 30000").landed == .prompted)
    let held = try await api.send(agentId: agent.id, text: "/echo later", mode: .queue)
    #expect(held.landed == .queued)
    #expect(try await api.withdraw(agentId: agent.id, inputId: held.inputId).text == "/echo later")
    await #expect(throws: RowrowError.self) { try await api.withdraw(agentId: agent.id, inputId: held.inputId) }
    #expect(try await api.abort(agentId: agent.id).accepted)

    // An upload comes back as a path to mention.
    let upload = try await api.upload(Data("a log line\n".utf8), filename: "log.txt", type: "text/plain")
    #expect(upload.path.hasSuffix("log.txt"))

    // New-agent defaults and review feedback, from the kit.
    let setup = try await kit.resolveSetup(state: try #require(tree).data(), context: .agent(agent.id), prefs: nil)
    #expect(setup.workspaceId == workspace.id)
    #expect(setup.runtime == "scripted")
    let feedback = try await kit.feedback([
      ReviewComment(
        workspaceId: workspace.id, source: .diff(path: "notes.md", scope: .turn, side: "new", line: 1, text: "hello"),
        comment: "Capitalize this.")
    ])
    #expect(feedback == "Review feedback:\n\n1. `notes.md` line 1:\n   > hello\n   Capitalize this.\n")

    // Workspaces (D-047): rename and back, archive and back, then rowrow forgets it.
    let other = try await api.addWorkspace(path: server.repository())
    #expect(try await api.renameWorkspace(other.id, label: "Site").label == "Site")
    #expect(try await api.renameWorkspace(other.id, label: nil).label == other.label)
    #expect(try await api.archiveWorkspace(other.id, archived: true).archived)
    #expect(try await api.archiveWorkspace(other.id, archived: false).archived == false)
    let removed = try await api.removeWorkspace(other.id)
    #expect(removed.removed == [other.id])
    #expect(removed.archived.isEmpty)

    // Signed out: a revoked device is told so.
    try await api.revoke(deviceId: me.id)
    await #expect(throws: RowrowError.self) { try await api.whoami() }
  }

  @Test func talksToCoachAndRunsItsTasks() async throws {
    let server = try await LocalServer.start()
    defer { server.stop() }
    let pairing = try await APIClient.pair(link: server.link(), deviceName: "Swift test iPhone")
    let api = APIClient(baseURL: pairing.baseURL, token: pairing.token)
    struct Snapshot: Decodable { let state: AppState }
    func state() async throws -> AppState {
      let snapshot: Snapshot = try await api.call("state.get")
      return snapshot.state
    }
    func eventually<T>(_ what: String, _ check: () async throws -> T?) async throws -> T {
      for _ in 0..<200 {
        if let value = try await check() { return value }
        try await Task.sleep(for: .milliseconds(100))
      }
      throw JSONError(description: "timed out waiting for \(what)")
    }

    // Coach may read one workspace, and runs on the scripted runtime (its settings are the web app's).
    let workspace = try await api.addWorkspace(path: server.repository())
    _ = try await api.raw(
      "settings.update",
      JSONValue.object([
        "coach": .object([
          "workspaces": .array([.string(workspace.id)]), "runtime": .string("scripted"), "model": .null,
          "effort": .null, "fullAccess": .bool(false),
        ])
      ]))
    _ = try await eventually("the scripted runtime") { try await state().runtimes["scripted"]?.installed == true ? true : nil }
    #expect(try await state().coachNotice == nil)

    // A message starts a chat, kept apart from the agents; Coach answers in it.
    let sent = try await api.coachSend(text: "/echo hello from the phone", chatId: nil)
    #expect(sent.landed == .prompted)
    _ = try await api.raw(
      "agents.wait",
      JSONValue.object([
        "agentId": .string(sent.chatId), "afterSeq": .number(Double(sent.seq)), "timeoutMs": .number(15000),
      ]))
    let current = try await state()
    #expect(current.coach?.chat?.id == sent.chatId)
    #expect(current.agents[sent.chatId] == nil)
    #expect(current.settings.coach?.runtime == "scripted")

    // Its transcript, folded by the kit like any agent's.
    guard case .changed(let source, _) = try await api.kit(etag: nil) else {
      Issue.record("no kit")
      return
    }
    let kit = try Kit(source: source)
    func rows(_ chatId: String) async throws -> [TranscriptRow] {
      let handle = try await kit.open(runtime: "scripted")
      let delta = try await kit.load(handle, page: try await api.raw("agents.entries", ["agentId": chatId]))
      return TranscriptStore.rows(
        order: delta.order ?? [], items: Dictionary(uniqueKeysWithValues: delta.items.map { ($0.id, $0) }))
    }
    let chat = try await rows(sent.chatId)
    guard case .input(let asked) = chat.first, case .turn(let answer) = chat.last else {
      Issue.record("expected a message then Coach's answer, got \(chat)")
      return
    }
    #expect(asked.text == "/echo hello from the phone")
    let echoed = answer.parts.contains { part in
      if case .text(let text) = part { text.text == "hello from the phone" } else { false }
    }
    #expect(echoed)

    // History: a new chat leaves this one there, and opening it makes it current again.
    #expect(try await api.coachChats().map(\.id) == [sent.chatId])
    try await api.coachNewChat()
    #expect(try await state().coach?.chat == nil)
    try await api.coachOpen(chatId: sent.chatId)
    #expect(try await state().coach?.chat?.id == sent.chatId)

    // A task (written in the web app; here through the contract): paused, run now all the same.
    let task: CoachTask = try await api.call(
      "coach.createTask",
      JSONValue.object([
        "requestId": .string(UUID().uuidString.lowercased()), "title": .string("Check the build"),
        "prompt": .string("/echo all green"),
        "schedule": .object(["type": .string("interval"), "minutes": .number(60)]), "notify": .string("every"),
      ]))
    #expect(task.schedule == .interval(minutes: 60))
    try await api.coachPauseTask(task.id, paused: true)
    #expect(try await state().coach?.tasks.first?.status == .paused)
    try await api.coachRunTask(task.id)
    let run = try await eventually("the task's run") {
      try await api.coachTaskRuns(taskId: task.id).first(where: { $0.status == .succeeded })
    }
    #expect(run.manual)
    let runChat = try await rows(try #require(run.chatId))
    guard case .input(let prompt) = runChat.first else {
      Issue.record("expected the task's prompt first, got \(runChat)")
      return
    }
    // Sent by rowrow itself: the app shows it as the "Task prompt".
    #expect(prompt.text == "/echo all green")
    #expect(prompt.by == "rowrow")

    try await api.coachDeleteTask(task.id)
    #expect(try await state().coach?.tasks.isEmpty == true)
  }
}
