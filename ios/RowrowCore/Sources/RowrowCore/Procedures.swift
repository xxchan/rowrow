import Foundation

// The contract's procedures the app uses, typed (src/shared/contract.ts has each one's summary).
// Where the server tells "leave it" (absent) from "reset it" (null) apart, the input is written
// as JSON by hand.

extension APIClient {
  // ─── Agents ────────────────────────────────────────────────────────────────

  /// Send input to an agent: text, attachments, or both. `inputId` is the idempotency key:
  /// retrying with the same one is safe.
  public func send(
    agentId: String, text: String, attachments: [Attachment] = [], mode: InputMode = .auto,
    inputId: String = UUID().uuidString.lowercased()
  ) async throws -> SendResult {
    struct Input: Encodable {
      let agentId: String
      let inputId: String
      let text: String
      let attachments: [Attachment]
      let mode: InputMode
    }
    return try await call(
      "agents.send", Input(agentId: agentId, inputId: inputId, text: text, attachments: attachments, mode: mode))
  }

  /// A file uploaded with files.upload, back from the server (to show an attachment).
  public func file(_ path: String) async throws -> Data {
    try await raw("files.get", ["path": path])
  }

  public func abort(agentId: String) async throws -> AbortResult {
    try await call("agents.abort", ["agentId": agentId])
  }

  /// Stop the agent's process; the conversation resumes with the next message.
  public func stop(agentId: String) async throws {
    let _: OK = try await call("agents.stop", ["agentId": agentId])
  }

  public func markSeen(agentId: String, seq: Int) async throws {
    let _: OK = try await call("agents.markSeen", MarkSeen(agentId: agentId, seq: seq))
  }

  private struct MarkSeen: Encodable {
    let agentId: String
    let seq: Int
  }

  /// Change what's given (a `.some(nil)` resets it to the default; nil leaves it).
  public func updateAgent(
    _ agentId: String, title: String?? = nil, model: String?? = nil, effort: String?? = nil, archived: Bool? = nil
  ) async throws {
    var fields: [String: JSONValue] = ["agentId": .string(agentId)]
    if let title { fields["title"] = title.map(JSONValue.string) ?? .null }
    if let model { fields["model"] = model.map(JSONValue.string) ?? .null }
    if let effort { fields["effort"] = effort.map(JSONValue.string) ?? .null }
    if let archived { fields["archived"] = .bool(archived) }
    _ = try await raw("agents.update", JSONValue.object(fields))
  }

  /// Start an agent, with a first message when there's text or an attachment.
  public func createAgent(
    workspaceId: String, runtime: String, model: String?, effort: String?, text: String, attachments: [Attachment] = []
  ) async throws -> AgentCreated {
    var fields: [String: JSONValue] = ["workspaceId": .string(workspaceId), "runtime": .string(runtime)]
    if let model { fields["model"] = .string(model) }
    if let effort { fields["effort"] = .string(effort) }
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    if !trimmed.isEmpty || !attachments.isEmpty {
      let files = try JSONValue.parse(JSONEncoder().encode(attachments))
      fields["input"] = .object([
        "inputId": .string(UUID().uuidString.lowercased()), "text": .string(trimmed), "attachments": files,
      ])
    }
    return try await call("agents.create", JSONValue.object(fields))
  }

  // ─── Workspaces ────────────────────────────────────────────────────────────

  public func addWorkspace(path: String) async throws -> Workspace {
    try await call("workspaces.add", ["path": path])
  }

  public func refreshWorkspace(_ id: String) async throws -> Workspace {
    try await call("workspaces.refresh", ["id": id])
  }

  public func browse(path: String?) async throws -> DirectoryListing {
    if let path { return try await call("workspaces.browse", ["path": path]) }
    return try await call("workspaces.browse")
  }

  public func createWorktree(workspaceId: String, branch: String?) async throws -> WorktreeCreated {
    var fields: [String: JSONValue] = ["id": .string(workspaceId)]
    if let branch, !branch.isEmpty { fields["branch"] = .string(branch) }
    return try await call("workspaces.createWorktree", JSONValue.object(fields))
  }

  public func removeWorktree(workspaceId: String, force: Bool) async throws {
    _ = try await raw("workspaces.removeWorktree", JSONValue.object(["id": .string(workspaceId), "force": .bool(force)]))
  }

  // ─── Runtimes ──────────────────────────────────────────────────────────────

  public func models(runtime: String) async throws -> ModelList {
    try await call("runtimes.models", ["runtime": runtime])
  }

  public func skills(runtime: String, workspaceId: String) async throws -> SkillList {
    try await call("runtimes.skills", ["runtime": runtime, "workspaceId": workspaceId])
  }

  // ─── Git and files ─────────────────────────────────────────────────────────

  public func changes(workspaceId: String, scope: DiffScope, agentId: String?) async throws -> Changes {
    var fields = ["workspaceId": workspaceId, "scope": scope.rawValue]
    if let agentId, scope == .turn { fields["agentId"] = agentId }
    return try await call("git.changes", fields)
  }

  public func diff(workspaceId: String, scope: DiffScope, path: String, agentId: String?) async throws -> FileDiff {
    var fields = ["workspaceId": workspaceId, "scope": scope.rawValue, "path": path]
    if let agentId, scope == .turn { fields["agentId"] = agentId }
    return try await call("git.diff", fields)
  }

  public func fileAction(workspaceId: String, action: FileAction, file: ChangedFile) async throws -> FileActionResult {
    var fields: [String: JSONValue] = [
      "workspaceId": .string(workspaceId), "action": .string(action.rawValue), "path": .string(file.path),
      "stamp": .string(file.stamp ?? ""),
    ]
    if let oldPath = file.oldPath { fields["oldPath"] = .string(oldPath) }
    return try await call("git.fileAction", JSONValue.object(fields))
  }

  public func bulkAction(workspaceId: String, action: BulkAction, files: [ChangedFile]) async throws -> FileActionResult {
    struct Input: Encodable {
      let workspaceId: String
      let action: BulkAction
      let files: [SeenFile]
    }
    return try await call(
      "git.bulkAction", Input(workspaceId: workspaceId, action: action, files: files.map(SeenFile.init)))
  }

  public func log(workspaceId: String, cursor: String?) async throws -> CommitPage {
    var fields = ["workspaceId": workspaceId]
    if let cursor { fields["cursor"] = cursor }
    return try await call("git.log", fields)
  }

  public func commit(workspaceId: String, sha: String) async throws -> CommitChanges {
    try await call("git.commit", ["workspaceId": workspaceId, "sha": sha])
  }

  public func commitDiff(workspaceId: String, sha: String, path: String) async throws -> FileDiff {
    try await call("git.commitDiff", ["workspaceId": workspaceId, "sha": sha, "path": path])
  }

  public func pullRequest(workspaceId: String, refresh: Bool = false) async throws -> PullRequestStatus {
    try await call("git.pullRequest", JSONValue.object(["workspaceId": .string(workspaceId), "refresh": .bool(refresh)]))
  }

  public func search(workspaceId: String, query: String) async throws -> SearchResult {
    try await call("files.search", ["workspaceId": workspaceId, "query": query, "kind": "all"])
  }

  public func read(workspaceId: String, path: String) async throws -> FileText {
    try await call("files.read", ["workspaceId": workspaceId, "path": path])
  }

  // ─── Devices, notifications, settings ──────────────────────────────────────

  public func whoami() async throws -> Device { try await call("devices.whoami") }

  public func devices() async throws -> [Device] { try await call("devices.list") }

  /// A one-time sign-in link for another device.
  public func pair(name: String?) async throws -> LoginLink {
    if let name { return try await call("devices.pair", ["name": name]) }
    return try await call("devices.pair")
  }

  public func revoke(deviceId: String) async throws {
    let _: OK = try await call("devices.revoke", ["id": deviceId])
  }

  public func renameDevice(_ id: String, name: String) async throws {
    let _: OK = try await call("devices.rename", ["id": id, "name": name])
  }

  public enum PushEnvironment: String, Sendable { case sandbox, production }

  /// Get this device's pushes through APNs; `key` (base64, PushSeal) seals what they say.
  public func subscribeApns(token: String, topic: String, environment: PushEnvironment, key: String) async throws {
    let _: OK = try await call(
      "notify.subscribeApns", ["token": token, "topic": topic, "environment": environment.rawValue, "key": key])
  }

  public func unsubscribePush() async throws {
    let _: OK = try await call("notify.unsubscribe")
  }

  /// Send a test notification to this device: how many went out.
  public func testPush() async throws -> Int {
    struct Sent: Decodable { let sent: Int }
    let result: Sent = try await call("notify.test")
    return result.sent
  }

  public func updateSettings(quickReplies: [String]) async throws -> ServerSettings {
    try await call("settings.update", ServerSettings(quickReplies: quickReplies))
  }

  public func info() async throws -> HostInfo { try await call("app.info") }

  /// Client-side problems for the server's log (they appear as client.* events).
  public func report(_ events: [ClientEvent]) async throws {
    struct Input: Encodable { let events: [ClientEvent] }
    let _: OK = try await call("telemetry.report", Input(events: events))
  }
}

/// A log event from the app, for `rowrow errors` on the computer.
public struct ClientEvent: Encodable, Sendable {
  public let level: String
  public let evt: String
  public let msg: String?
  public let at: Millis
  public let route: String?

  public init(level: String, evt: String, msg: String?, route: String?) {
    self.level = level
    self.evt = evt
    self.msg = msg.map { String($0.prefix(4000)) }
    at = Date().millis
    self.route = route
  }
}
