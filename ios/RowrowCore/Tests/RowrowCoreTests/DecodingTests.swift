import Foundation
import Testing

@testable import RowrowCore

// What a newer server sends that this app can't read costs that one item, not the update.
@Suite struct LenientDecoding {
  @Test func readsATranscriptItemItCantDecodeAsUnknown() throws {
    let json = #"""
      {"reset":false,"head":3,"first":0,"hasMore":false,
       "items":[{"kind":"turn","id":"t1","open":false},{"kind":"input","id":"i1","text":42,"state":"sent"}]}
      """#
    let delta = try JSONDecoder().decode(TranscriptDelta.self, from: Data(json.utf8))
    #expect(delta.items.map(\.id) == ["t1", "i1"])
    #expect(delta.items[1] == .unknown(id: "i1"))
  }

  @Test func leavesOutAnAgentItCantDecode() throws {
    let json = #"""
      {"host":{"name":"mac","version":"0.3.59","profile":"default","dataDir":"/d","url":"http://127.0.0.1:1","exposed":false},
       "workspaces":{},"runtimes":{},"settings":{"quickReplies":[]},
       "agents":{"ag_1":{"id":"ag_1","summary":42}}}
      """#
    let state = try JSONDecoder().decode(AppState.self, from: Data(json.utf8))
    #expect(state.host.name == "mac")
    #expect(state.agents.isEmpty)
  }
}
