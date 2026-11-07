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

## Cycle 4 — M0 two-party negotiation (2026-11-07)

Source: Leo's M0 items in the latent-ledger roadmap. Integration branch: feature/semantic-graph. Claude Code integrated. Subagents built the MCP adapter in an isolated worktree and gave an independent review for each feature. Each card closed with its evals, a debug pass, a review, fixes, and commits.

| Card | Scope | Acceptance | State |
| --- | --- | --- | --- |
| F1 Schema v2 | `party`, `offer` and `question` nodes, an `answers` edge, cross-graph `links` | v2 evals in docs/evals.md; v1 unchanged | Done (996a212, fixes in 36ed799) |
| F2 Context and meter | Canonical v2 identity, `GET /api/graphs/:id/context`, estimated savings meter | Reordered packets share an ID; stable prefix; escaping | Done (36ed799, fixes in 9126daf) |
| F3 MCP adapter | `src/mcp.mjs`: graph_schema, graph_publish, graph_read, context_for, room_open, room_read | Protocol, tools, failures, live round trip; no confirm tool | Done (964f70d, fixes in 0cc4e1d) |
| F4 Negotiation room | Rooms API, per-person decisions, browser merged view | Agreed only when both confirm; browser-only decisions; Playwright journey | Done (d5e5371, debug fix in 83e3f2a, review fixes in 1fbb3c5) |

Not covered in this cycle: Ali's benchmark and pitch, the event log (M1), exact token metering from transcripts (M1.5), and identity for parties. Party names are self-asserted, and the decisions route keeps honest agents out but does not prove who clicked.

## Cycle 5 — Ali's M0 benchmark and pitch (2026-11-07)

Owner: Ali (MuhammadaliNazarov), with Claude Code orchestrating. Branch: `claude/wizardly-pasteur-r1nhhw`, based on feature/semantic-graph at 1d7be89. Does not repeat Ruslan's open cycle 4 steps (Linux CI on PR #1, the live two-model MCP smoke test, the demo rehearsal) or his P0/P1 strategy and architecture work, and does not edit `src/`. Status goes to docs/handoff.md after each step.

| Card | Scope | Acceptance | State |
| --- | --- | --- | --- |
| B1 M0 benchmark | `npm run bench`: synthetic two-party negotiations at several transcript sizes, measured end to end through the real API | Cycle 5 evals in docs/evals.md; deterministic, offline, synthetic only; independent code review and debug pass on the benchmark itself | In progress |
| B2 Pitch | `docs/pitch.md`: problem, demo script, benchmark numbers, positioning | Every number traces to the benchmark output or a cited source; reuses the product/v1 strategy research instead of redoing it | Backlog (deferred until B1 numbers are final) |
| R1 Run skill | `.claude/skills/run-context-ledger/`: a driver that starts the server, seeds two parties and clicks through the room with screenshots | Every SKILL.md command ran in a clean Linux container | Done |
| B3 Demo-scale seed | Seed the live demo with ~200-turn synthetic sessions so the meter shows the real saving (about 90%) instead of a negative one on toy transcripts | Driver and fixtures only; meter above 85% in the demo output | Done (mara 91.6%, teo 89.8% saved, estimates) |
| B4 Agent answer-quality eval | The claim the benchmark cannot make yet: given only the graph context vs the full handoff, does a receiving model answer the other party's goals, offers, conflicts and open questions correctly? Synthetic negotiations, fixed question set, accuracy and tokens per answer | Eval written first; exact token counts from the provider; needs an API key via the secure credential form | Ready (needs key) |
| B5 Exact token counts | Replace chars/4 in the benchmark report with tokenizer counts for one Claude and one OpenAI model, keeping the estimate column | Counts from the providers' token-counting APIs; method stated | Backlog (with B4) |
| B6 Benchmark on Tenki runner | `bench.yml` on `tenki-standard-medium-4c-8g`: runs `npm run bench`, uploads the report as an artifact, so pitched numbers come from a fixed, named machine | Separate workflow; does not touch e2e.yml | Ready (needs the Tenki runner app on the repo) |
| B7 Dogfood numbers | Run the meter on Ali's own Claude Code and Codex sessions locally and commit only aggregates (counts, size buckets, median saving) | AGENTS.md section 5: no transcript text committed | Ready (runs on Ali's machine) |
| B8 Demo video and judge Q&A | 90-second recording of the room flow made from the driver, plus answers to the hardest judge questions | After B2 | Backlog |
| B9 Demo storyline (theme fit) | Hackathon brief, challenge 5 "Your Agent, My Agent": two attendees' agents network on their behalf (skills, offers, constraints, questions) at demo scale (about 200 turns). Every match, conflict and answer makes sense to a judge, and the two people confirm live | Fixture data only; meter above 85%; checked with `driver.mjs check` and a screenshot read | Done as an option (`--story networking`); default stays `sprint` until the team picks challenge 5 or wildcard |
| B10 Built-today slide | Commit timeline for cycles 4–6 plus the review scorecard (tests, findings fixed, Tenki on every PR) | Every number links to a commit, PR or eval entry | Ready |
