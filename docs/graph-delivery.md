# Semantic graph delivery board

Baseline: 48775b0. Integration branch: feature/semantic-graph. Run one bounded implementation wave, one review and repair wave, and a release verification. Only the integrator lands changes.

| Card | Owner | Scope and branch | Acceptance and merge gate | State |
| --- | --- | --- | --- | --- |
| G1 Graph contract | Schema engineer | Schema, validator and graph rules on graph/schema | Reject bad references, invalid relationships and cycles. Derive ready actions and current decisions. | Done |
| G2 Local graph API | Storage engineer | Existing server and store on graph/storage | Persist immutable packets, confirm cited transcript lines, reject foreign origins and deduplicate retries. | Done |
| G3 Agent CLI | Handoff engineer | Existing CLI on graph/cli | Publish and read graph packets with clean JSON output and the existing local API. | Done |
| G4 Independent verification | Debug and test engineer | Graph Playwright integration tests | Cover valid round-trip, rejection paths, and old transcript workflows. | Done |
| G5 Release | Forward deployment engineer | CI and draft PR readiness | Syntax and diff checks, independent review, Linux Playwright, and a private review branch. | In review — Claude Code integrating while Codex is rate-limited |
| G6 Product strategy | Consultant | Read-only product and eval review | Recommend the next milestone and explain which eval would justify it. | Ready (handed to Codex) |

The graph is scoped to one previously imported transcript in this first cycle. Nodes refer to source lines in that transcript. The controller can decide whether an action is ready based on open blockers and incomplete prerequisites. It cannot establish that a source claim is true or grant authority to run an action.
