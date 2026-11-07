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
| B8 Demo video and judge Q&A | 90-second recording of the room flow made from the driver, plus answers to the hardest judge questions | Video: `docs/demo/networking-demo.mp4` (61 s, captioned, from the real app). Q&A after B2 | Video done; Q&A after B2 |
| B9 Demo storyline (theme fit) | Hackathon brief, challenge 5 "Your Agent, My Agent": two attendees' agents network on their behalf (skills, offers, constraints, questions) at demo scale (about 200 turns). Every match, conflict and answer makes sense to a judge, and the two people confirm live | Fixture data only; meter above 85%; checked with `driver.mjs check` and a screenshot read | Done as an option (`--story networking`); default stays `sprint` until the team picks challenge 5 or wildcard |
| B10 Built-today slide | Commit timeline for cycles 4–6 plus the review scorecard (tests, findings fixed, Tenki on every PR) | Every number links to a commit, PR or eval entry | Ready |

## Closing the gaps before judging (2026-11-07, 12:55 PT, event ends 20:00 PT)

Owner key: **Ali** (person), **Ali's agent** (this session), **Ruslan**, **both**. P0 blocks the demo or submission; P1 is a Q&A hole a judge will find; P2 is polish.

| ID | P | Gap | Close it by | Owner | State |
| --- | --- | --- | --- | --- | --- |
| L1 | P0 | Track and positioning not decided; it blocks the pitch | Pick the showcase: challenge 1+2 serendipity, challenge 5 trust layer, or wildcard. Thesis: a text layer for people plus a latent layer for machines | both | Open |
| L2 | P0 | Submission rules unknown: deadline, form or Devpost, demo slot length | Ask an organizer or check the event Discord/Luma; book the demo slot | Ali | Open |
| L3 | P0 | **The repo is private**, so judges can't open it | Make it public or add judges, after a secret scan; or submit a public mirror of the demo branch | Ruslan (owner) | Open |
| L4 | P0 | `main` is stale: the README and code predate cycles 4–6 | Merge PR #1, then #4 and #3 into `main` (or point judges at one branch). Drafts must be marked ready, and CI is already green | Ruslan, Ali approves | Open |
| L5 | P0 | The live demo has never been run on the stage laptop (the driver was only verified on Linux) | Rehearse on Ruslan's laptop: the ledger, both agents over MCP, the room, both people confirm. Pre-seed a room as fallback; keep the video ready offline | both | Open |
| L6 | P0 | Pitch not written | 3-minute pitch, one beat per judging criterion, plus a 1-page Q&A sheet | Ali's agent drafts, Ali owns | Open (after L1) |
| L7 | P1 | "vs a summary?" no baseline | Cite SwaT for summaries vs latent transfer; with an API key, add a graph-vs-summary benchmark (tokens and fact recall) | Ali's agent (needs key) | Open |
| L8 | P1 | All numbers are synthetic | B7 dogfood: run the meter on Ali's and Ruslan's real sessions locally and commit only aggregates (count, size buckets, median saving) | Ali (laptop), Ali's agent writes the script | Open |
| L9 | P1 | Tokens are chars/4 estimates | B5: exact counts with a provider token-counting API on the benchmark outputs | Ali's agent (needs key) | Open |
| L10 | P1 | Cost of building the graph is not counted (an agent has to extract it) | Measure the extraction tokens on one real session, or state it plainly as a cost that is paid once and reused on every handoff | Ali's agent | Open |
| L11 | P1 | SwaT attribution unclear | Confirm whether Abdulrahman (Ar-Kareem) is on the team; cite the arXiv paper on the slide either way; never present the paper's numbers as product numbers; M2b is "next" | Ali | Open |
| L12 | P1 | "Who clicked?" Decisions are browser-only, but party names are self-asserted | Prepared answer: local and loopback today; identity (signing, card P4) is next. Don't claim authentication | Ali's agent (Q&A sheet) | Open |
| L13 | P1 | The graph context isn't prompt-cache-friendly (prefix under 1,024 tokens) | Either Ruslan applies the two `src/` fixes, or the pitch makes no caching claim for the graph | Ruslan decides | Open |
| L14 | P1 | Ali's cycle 6 side: the `ali/latent-pool` runtime review and `q-latent-contract` approval | Ruslan pushes `ali/latent-pool`; Ali's agent reviews; Ali approves | Ruslan, then Ali | Blocked (not pushed) |
| L15 | P2 | Built-today proof (judging: progress on the day) | B10 slide: commit timeline for cycles 4–6, 75+ tests, 13 bugs fixed after review (10 by our own reviewers, 3 by Tenki), Tenki on every PR | Ali's agent | Ready |
| L16 | P2 | Judges need a 30-second way in | A top-of-README "What it is / watch the 61 s video / run it in one command / numbers with sources" | Ali's agent | Ready |
| L17 | P2 | Mystery Match visibility | Register the project at check-in matchmaking (it is the event's own serendipity experiment) | Ali | Open |
| L18 | P2 | Fixed-hardware numbers | B6: benchmark on a Tenki runner (needs the Runners page linked) | Ali's agent | Optional |
