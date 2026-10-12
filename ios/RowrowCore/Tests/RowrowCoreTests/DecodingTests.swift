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

// pi through two providers: Default says what it runs, and a shared name carries its provider.
@Suite struct ModelNaming {
  let models = try! JSONDecoder().decode(
    [ModelInfo].self,
    from: Data(
      #"""
      [{"id":"anthropic/claude-sonnet-4-5","name":"Claude Sonnet 4.5","effortLevels":[],"defaultEffort":null,
        "serviceTiers":[],"default":false,"provider":{"id":"anthropic","name":"Anthropic"}},
       {"id":"openrouter/anthropic/claude-sonnet-4.5","name":"Claude Sonnet 4.5","effortLevels":[],"defaultEffort":null,
        "serviceTiers":[],"default":true,"provider":{"id":"openrouter","name":null}},
       {"id":"openrouter/z-ai/glm-4.6","name":"GLM 4.6","effortLevels":[],"defaultEffort":null,
        "serviceTiers":[],"default":false,"provider":{"id":"openrouter","name":null}}]
      """#.utf8))

  @Test func namesTheDefaultAndTheProviderOfASharedName() {
    #expect(ModelNames.defaultTitle(models) == "Default (Claude Sonnet 4.5 · openrouter)")
    #expect(ModelNames.label(models, id: "anthropic/claude-sonnet-4-5") == "Claude Sonnet 4.5 · Anthropic")
    #expect(ModelNames.label(models, id: "openrouter/z-ai/glm-4.6") == "GLM 4.6")
    #expect(ModelNames.label(models, id: "gone") == "gone")
  }

  @Test func readsAServerBeforeOar057() throws {
    let old = try JSONDecoder().decode(
      [ModelInfo].self,
      from: Data(#"[{"id":"gpt-5.5","name":"GPT-5.5","effortLevels":[],"defaultEffort":null,"serviceTiers":[]}]"#.utf8))
    #expect(ModelNames.defaultTitle(old) == "Default")
    #expect(old[0].provider == nil)
  }
}
