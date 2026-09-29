# Upstream issues and workarounds

When rowrow works around a gap in a dependency instead of fixing it there, the gap is
listed here with its upstream fix, so the workaround can be deleted when the fix lands
(PRINCIPLES.md, engineering 6).

| Where | Gap | Workaround in rowrow | Upstream |
| --- | --- | --- | --- |
| oar 0.8.0 `scriptedRuntime` | A tool that settles after its turn was aborted still emits `tool_call_ended`; oar's status fold then adopts a phantom running turn. | The demo script's `/sleep` is not a tool call (`src/server/agents/scripted.ts`). | fix in progress (botiverse/oar) |
