import Foundation
import Testing

@testable import RowrowCore

/// Coach in the app state, its actions' cards in a transcript, and the words the app says
/// about them, as the web app says them.
@Suite struct CoachInTheApp {
  static let state = #"""
    {"host":{"name":"mac","version":"0.3.66","profile":"default","dataDir":"/d","url":"http://127.0.0.1:1","exposed":false},
     "workspaces":{"ws_a":{"id":"ws_a","path":"/a","label":"a","customLabel":null,"parentId":null,"createdAt":1,"archived":false,"missing":false,"git":null},
                   "ws_gone":{"id":"ws_gone","path":"/g","label":"g","customLabel":null,"parentId":null,"createdAt":1,"archived":false,"missing":true,"git":null}},
     "agents":{},
     "runtimes":{"claude":{"id":"claude","name":"Claude Code","installed":true,"version":"2","reason":null,"test":false}},
     "settings":{"quickReplies":[],"coach":{"workspaces":["ws_gone"],"runtime":"claude","model":null,"effort":null,"fullAccess":false}},
     "coach":{"chat":null,"tasks":[
       {"id":"tk_1","title":"Watch the build","prompt":"Is main green?","schedule":{"type":"daily","time":"09:00","timeZone":"Europe/London"},
        "notify":"coach","status":"active","fullAccess":false,"createdAt":1,"updatedAt":1,"nextRunAt":1791565200000,"queuedAt":null,
        "currentRun":null,
        "lastRun":{"id":"tr_1","taskId":"tk_1","chatId":"ag_run","status":"succeeded","scheduledAt":1,"startedAt":1,"finishedAt":2,"error":null,"manual":true},
        "lastNotice":null},
       {"id":"tk_2","title":"From a newer rowrow","schedule":42}
     ]}}
    """#

  @Test func readsItsSettingsAndTasksFromTheAppState() throws {
    let state = try JSONDecoder().decode(AppState.self, from: Data(Self.state.utf8))
    #expect(state.settings.coach?.runtime == "claude")
    #expect(state.settings.coach?.fullAccess == false)
    #expect(state.coach?.chat == nil)
    // A task this app can't read is left out, not the state.
    let task = try #require(state.coach?.tasks.first)
    #expect(state.coach?.tasks.count == 1)
    #expect(task.schedule == .daily(time: "09:00", timeZone: "Europe/London"))
    #expect(task.notify == .coach)
    #expect(task.lastRun?.chatId == "ag_run")

    #expect(task.schedule.label() == "Daily at 09:00 (Europe/London)")
    #expect(CoachWords.runLine(task) == "Last: succeeded")
    #expect(CoachWords.nextLine(task, when: { String(Int($0)) }) == "Next: 1791565200000")
    #expect(CoachWords.permission(task, fullAccessNow: true) == "Manual permission: operations need confirmation")
    #expect(task.notify.label == "Coach decides when to notify")
    let lastRun = try #require(task.lastRun)
    #expect(CoachWords.runLabel(lastRun, when: { _ in "Oct 9" }) == "Oct 9 / succeeded (Run now)")

    // The only allowed workspace is missing: nothing to read, so nothing to send.
    #expect(state.coachWorkspaces.isEmpty)
    #expect(state.coachNotice == "Allow workspaces in Coach's settings (rowrow on your computer) to send messages.")
    #expect(state.coachWaiting == 0)
  }

  @Test func saysWhenItCantRun() throws {
    let json = Self.state.replacingOccurrences(of: #""runtime":"claude""#, with: #""runtime":"codex""#)
    let state = try JSONDecoder().decode(AppState.self, from: Data(json.utf8))
    #expect(state.coachRuntimeProblem == "This runtime can't turn off its built-in tools, so it can't be Coach.")
    #expect(state.coachNotice?.hasSuffix("Choose a runtime in Coach's settings in rowrow on your computer.") == true)
  }

  @Test func wordsSchedulesAsTheWebAppDoes() {
    #expect(TaskSchedule.interval(minutes: 1).label() == "Every 1 minute")
    #expect(TaskSchedule.interval(minutes: 5).label() == "Every 5 minutes")
    #expect(TaskSchedule.once(at: "2026-10-09T15:00:00.000Z").label(when: { String(Int($0)) }) == "Once: 1791558000000")
    #expect(CoachWords.instant("2026-10-09T15:00:00Z") == 1_791_558_000_000)
    #expect(CoachWords.status(online: true, working: true, executing: true) == "Executing action")
    #expect(CoachWords.status(online: false, working: true, executing: false) == "Reconnecting")
    #expect(CoachWords.status(online: true, working: false, executing: false) == "Idle")
  }

  @Test func namesItsToolsAndCountsWhatItSends() {
    #expect(CoachWords.toolLabel("mcp__rowrow__agents_status") == "Agent status")
    #expect(CoachWords.toolLabel("agent_background") == "Background output")
    #expect(CoachWords.toolLabel("mcp__rowrow__propose_agent_prompt") == "propose_agent_prompt")
    #expect(CoachWords.toolLabel("Bash") == "Bash")
    // As JavaScript counts a string: UTF-16 code units.
    #expect(CoachWords.characters("a") == "1 character")
    #expect(CoachWords.characters("h\u{E9}llo \u{1F44B}") == "8 characters")
  }

  @Test func showsAnActionsCardAfterTheTurnThatProposedIt() throws {
    let json = #"""
      {"reset":true,"head":9,"first":0,"hasMore":false,
       "order":["r:t1","r:t1:0:0","r:t1:outcome","action:p1","action:p2"],
       "items":[
        {"kind":"turn","id":"r:t1","open":false},
        {"kind":"text","id":"r:t1:0:0","turn":"r:t1","lane":[],"text":"I can send it.","streaming":false},
        {"kind":"outcome","id":"r:t1:outcome","turn":"r:t1","outcome":"completed","reason":null,"failure":null},
        {"kind":"action","id":"action:p1","actionId":"p1","action":"send_prompt","name":"Send prompt","status":"pending",
         "statusLabel":"Needs confirmation","detail":"Waiting for your confirmation. Nothing has been executed.",
         "summary":"Send the exact displayed prompt to this agent.","workspaceId":"ws_a","workspaceLabel":"a",
         "agentId":"ag_1","agentTitle":"helper","params":{"prompt":"run the tests"},"proposedAt":1791558000000},
        {"kind":"action","id":"action:p2","actionId":"p2","action":"create_task","name":"Create task","status":"succeeded",
         "statusLabel":"Enabled","detail":"Enabled.","summary":"Enable a task.","workspaceId":"","workspaceLabel":"",
         "agentId":null,"agentTitle":null,"params":{"title":"Nightly","prompt":"check","schedule":{"type":"interval","minutes":60},"notify":"every"},
         "proposedAt":1791558000000}
       ]}
      """#
    let delta = try JSONDecoder().decode(TranscriptDelta.self, from: Data(json.utf8))
    let rows = TranscriptStore.rows(
      order: delta.order ?? [], items: Dictionary(uniqueKeysWithValues: delta.items.map { ($0.id, $0) }))
    #expect(rows.map(\.id) == ["r:t1", "action:p1", "action:p2"])
    guard case .action(let card) = rows[1], case .action(let task) = rows[2] else {
      Issue.record("expected two cards, got \(rows)")
      return
    }
    #expect(card.status == .pending)
    #expect(card.agentTitle == "helper")
    #expect(card.params.prompt == "run the tests")
    #expect(card.isTask == false)
    #expect(task.isTask)
    #expect(task.params.schedule == .interval(minutes: 60))
    #expect(task.params.notify == .every)
  }
}
