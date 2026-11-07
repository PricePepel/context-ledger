# Evaluation log

## Cycle 1 — Transcript import and retrieval

Define the expected results before implementation. Run `npm test` against a fresh local SQLite file using synthetic transcripts only.

| Eval | Expected |
| --- | --- |
| Claude Code import | The browser displays user and assistant text with the original filename and JSONL line numbers. Tool output stays out of the imported conversation. |
| Codex import | A matching result is discoverable across providers. The provider filter narrows it and search matches case-insensitively. |
| Repeat and rejected imports | Importing the same data twice returns the same ID. Malformed JSONL and foreign origins add zero sessions. |
| Browser rendering | Imported text containing HTML is displayed literally. An unmatched query explains that there are no results. |

## Cycle 2 — Portable handoff

| Eval | Expected |
| --- | --- |
| CLI search | The same provider and query yield the same IDs in the CLI and browser. |
| CLI handoff | An exported Markdown packet includes provider, source, role and line for each turn. Retrieval of a missing session exits nonzero. |
| Regression | Cycle 1 passes against a fresh database. |

## Results — 2026-11-06

- Cycle 1 passed the browser import/search journey and the API integrity eval. Backend smoke checks also verified persistence after restart, Host rejection, and the streamed request limit. Review found that Codex synthetic user-role context could leak into the library. The parser now filters known context blocks while preserving neighboring user text. The browser also checks file size before reading and renders rows without a variadic call.
- Cycle 2 passed browser-to-CLI retrieval and handoff export, including missing IDs and literal rendering of transcript Markdown and terminal controls. Claude reviewed the CLI independently. The follow-up review verified the fixes in the backend, browser, and CLI.
- Final Windows Playwright run passed 3 of 3 tests. GitHub Actions runs the same suite on Linux.
- Live handoff smoke passed with Claude Haiku using a synthetic packet. Claude recovered the expected action, source filename, and original line 2 from the CLI output.

## Cycle 3 — Semantic graph handoff

- G1 accepts version 1 packets with typed nodes and valid source lines. It rejects duplicate IDs or edges, dangling references, invalid edge types, and cycles in dependencies or supersession. Pending actions with open blockers or incomplete prerequisites are excluded. A superseded decision is excluded from current decisions.
- G2 publishes a valid packet for one imported session, returns the same ID for an identical retry, and retrieves it after a restart. Invalid provenance and foreign origins are rejected before writing.
- G3 publishes a selected JSON file and reads the stored packet from the local CLI. It emits JSON that a second agent or a program can parse. Existing Markdown output keeps its behavior.
- G4 runs the new capabilities and the existing browser, API, and CLI regressions in Playwright using synthetic data.
- G5 verifies a clean reviewed diff and GitHub Actions on the review branch. G6 identifies the next capability and defines its decision gate.

## Results — Cycle 3, 2026-11-06

- G1–G4 were implemented by Codex on graph/* worktrees and integrated on feature/semantic-graph. Codex hit its usage limit during G5, so Claude Code took over integration (user-approved).
- Windows: Playwright 5 of 5, graph unit tests 9 of 9, graph CLI and restart tests 3 of 3.
- An independent Claude review of 48775b0..6bad64a found no critical or high defects. Two medium findings were fixed:
  - Graph and search JSON passed DEL, C1 controls, bidi/format characters and U+2028/9 to the terminal raw, because `JSON.stringify` only escapes below U+0020. The CLI now escapes them as `\uXXXX`. The output is still lossless JSON. A test that fails on the old CLI covers graph read and search.
  - The G2 "retrieves after a restart" criterion had no test. `tests/graph-restart.test.mjs` now publishes, stops the server, starts a new process on the same SQLite file, and reads the graph back.
- Low findings: derived-state unit tests now pin combined blocker and prerequisite waits, a resolved blocker alone, supersession chains, and shared supersession targets. The README now states that evidence must cite a stored user or assistant line, and that array order affects graph identity.
- The follow-up review verified these fixes and flagged the handoff Markdown path. It escaped only `\p{Cc}`, so bidi overrides (filename spoofing) and invisible tag characters (hidden text) reached readers raw. It now escapes `\p{Cf}` as well, keeping ZWJ and ZWNJ so emoji sequences render, and astral characters are escaped as correct surrogate pairs. `tests/handoff-cli.test.mjs` covers this.

## Core bug scan — 2026-11-06

An independent scan of the server, store, parsers and browser UI found no critical or high bugs. Host and Origin checks, body limits, atomic idempotent import, literal `instr` search, line numbering with BOM/CRLF/blank lines, and `textContent`-only rendering were probed and found sound. Fixed, with `tests/store.test.mjs`:

- Medium: older Codex rollouts without per-block metadata leaked `<user_instructions>` and `<turn_aborted>` envelopes as user turns, which polluted search and could become the session title. These are now filtered as complete envelopes, like `<environment_context>`.
- Low: a title was cut at 120 UTF-16 units, which could split an emoji and store a lone surrogate. It is now cut by code point.

Noted, not changed: Greek final sigma can make a lowercase query miss its match. Re-importing identical content under a new filename keeps the first name (intended idempotency). Claude `isSidechain` and `isCompactSummary` records import as ordinary turns, and this needs a format decision.

Totals after fixes (Windows): graph unit 9 of 9, CLI/restart/handoff/store 6 of 6, Playwright 5 of 5.

## Cycle 4 — M0 two-party negotiation (defined 2026-11-07, before implementation)

Source plan: M0 in the latent-ledger roadmap (Leo's items). Synthetic data only. Each feature closes with its capability evals passing, the full regression suite passing, a debug pass, an independent review, and a commit. Targets: capability pass@3 ≥ 0.90; regression pass^3 = 1.00.

### F1 — Schema v2

| Eval | Expected |
| --- | --- |
| v2 accepted | A `version: 2` packet with a packet-level `party`, `offer` and `question` nodes, and an `answers` edge (decision → question) validates. Version 1 packets behave exactly as before. |
| Question rules | A question requires `to` (a party) and `open` or `answered` status. Open questions not answered by a current decision are reported as `openQuestionIds`. |
| Cross-graph links | `links` reference a node in another stored v2 graph from a different party. Types: `matches`, `conflicts`, `answers` (local decision → remote question addressed to this party). Unknown graphs, unknown remote nodes, same-party targets, wrong kinds and duplicate links are rejected before writing. |
| Regression | v1 API, CLI and browser evals pass unchanged. |

### F2 — Canonical context and savings meter

| Eval | Expected |
| --- | --- |
| Semantic identity | Two v2 packets that differ only in node, edge, link or evidence order get the same graph ID and the same stored canonical packet. |
| Cache-stable context | `GET /api/graphs/:id/context` returns a compact text rendering whose stable sections (header, goals, constraints, decisions, offers) come before volatile ones (actions, blockers, questions, ready state). It is byte-identical for reordered packets. Control, bidi and format characters in labels are escaped. |
| Savings meter | The same response reports characters and estimated tokens (ceil(chars / 4), labelled as an estimate) for the Markdown transcript handoff and for the graph context, plus the saving. |
| Regression | The Markdown handoff from the CLI is unchanged after it moves to a shared module. |

### F3 — MCP adapter

| Eval | Expected |
| --- | --- |
| Handshake | `node src/mcp.mjs` speaks MCP over stdio: `initialize`, `tools/list`, `tools/call`, `ping`; notifications get no reply; unknown methods return JSON-RPC errors. |
| Tools | `graph_schema`, `graph_publish`, `graph_read`, `context_for`, `room_open`, `room_read` call the local API with the local origin. No tool can confirm or reject a proposal. |
| Failures | A ledger rejection or an unreachable ledger becomes a tool result with `isError: true`, not a crash. Tool output escapes invisible characters. |
| Live round-trip | Against a real server, an MCP client publishes a v2 packet, reads it back and gets its context. |

### F4 — Negotiation room and merged view

| Eval | Expected |
| --- | --- |
| Open room | `POST /api/rooms` with two stored v2 graph IDs from different parties returns a stable room ID (order-independent). Same-party, v1, missing or duplicate graphs are rejected. |
| Merged view | `GET /api/rooms/:id` shows both parties' nodes and every link between the two graphs as a proposal with both parties' choices and a state of `proposed`, `agreed` or `rejected`. |
| Human confirmation | `POST /api/rooms/:id/decisions` records one party's confirm or reject for one proposal. It requires the same origin and a browser same-origin fetch. A proposal is agreed only when both parties confirm, and rejected when either rejects. |
| Browser journey | In Playwright, two synthetic transcripts are imported, two party graphs are published with a match and a conflict, the room opens in the browser, both people confirm the match, and the joint action shows as agreed after reload. Label text renders literally. |
| Regression | All earlier browser, API, CLI and unit evals pass. |

## Results — Cycle 4, 2026-11-07

Claude Code integrated on feature/semantic-graph. A subagent built the MCP adapter in an isolated worktree, and it was cherry-picked. Each feature got a debug pass and an independent subagent review using the code-review skill, with every finding confirmed by a probe. All capability evals passed. The final runs on Windows were node 54 of 54 and Playwright 9 of 9, three times each, so pass^3 = 1.00.

- F1 schema v2 (996a212). The debug pass found a critical bug: the validator lookup on a plain object let `version: "constructor"` skip schema validation and be stored. The lookup now uses a Map. The review found three medium issues, all fixed in 36ed799: a node pair could carry both a match and a conflict, a link could start at a superseded decision, and one transcript could publish as both parties (links now require another session). Two low issues were also fixed: `links: []` hashed differently from an absent list, and invisible labels were accepted.
- F2 context and meter (36ed799). The review found two medium issues, fixed in 9126daf. U+2028/9 in labels could forge context lines, and the "stable" prefix moved with every transcript append and every linked revision. Session and linked graph IDs now come last, and links name the party. Low fixes: filler-only labels are rejected, edges use one order, and the meter names its unit. Test sources had picked up raw bidi characters from the editing tools, so they now use escapes.
- F3 MCP adapter (964f70d). The builder's debug pass fixed a nesting crash and a Windows test hang. The integration test drives context_for, room_open and room_read against the real server. The review found nothing above low. Fixed in 0cc4e1d: U+2028/9 in ledger errors, distinct timeout and redirect messages, malformed notifications dropped, and the npm script removed.
- F4 negotiation room (d5e5371). The debug pass found that a party named `constructor` lost its choice in the response; fixed with Maps in 83e3f2a, which also added a phone-width check. The review found one medium issue: the other party's labels could print a fake "State: agreed" with newlines and bidi controls. V2 labels now refuse control, separator and bidi characters, and the UI isolates labels in `<bdi>`. Low fixes in 1fbb3c5: focus returns after a decision, buttons are disabled while a decision is in flight, and a failed open clears the old room. Room journeys were sharing graphs across parallel and repeated runs, so each test now publishes its own.
- Not done here: Linux CI for this branch (now configured to run every node test file), a live two-model MCP smoke test, and Ali's M0 benchmark.

## Cycle 5 — M0 benchmark

Card B1. `npm run bench` (`node bench/m0.mjs`) measures the cycle 4 graph context against the Markdown transcript handoff, end to end through the real HTTP API. All inputs are synthetic and generated from a seed; the benchmark builds the graph packets itself, so it measures the ledger's storage and rendering, not the quality of LLM extraction.

Synthetic data: for each size (number of transcript lines per party, default 10, 50, 200 and 1000), a seeded PRNG (mulberry32, no `Math.random`) writes a two-party negotiation. Party A (`mara`) is a Claude Code JSONL transcript and party B (`teo`) is a Codex rollout. Most turns are filler work chatter, with a few non-message records that the importer skips. Planted facts (goals, constraints, offers, decisions, actions, questions addressed to the other party) sit at known line numbers, about sqrt(size) + 4 per party.

| Eval | Expected |
| --- | --- |
| Harness | The benchmark starts `src/server.mjs` as a child process on a free loopback port with a fresh temp database under the OS temp directory, sends the correct Origin, and stops the server and deletes the database at the end, also on failure. |
| Flow | Per size: import both transcripts, publish party A's v2 graph, publish party B's graph with `matches`, `conflicts` and `answers` links to A, open a room. Every request succeeds. |
| Size | Characters and estimated tokens (ceil(chars/4), labelled as estimates) for the Markdown handoff and the graph context, taken from the API meter. The primary figure is the character ratio. The saved share grows with transcript size. |
| Fact recall | Every planted fact's label and cited line appear in the graph context and in the handoff: recall 1.0 on both. This guards against compression dropping a planted fact; it is not a quality claim. |
| Cache-prefix stability | After K appended turns (re-imported as a new session, because session IDs hash the transcript) and a revised graph with one more action, report the longest common prefix of old and new output as a share of the new output, for the graph context and for the handoff. |
| Order invariance | A shuffled copy of each packet (nodes, edges, links, evidence) returns the same graph ID and byte-identical context. |
| Latency | p50 and p95 over `--reps` for publish, context and room open, with Node version and platform recorded. Timings are excluded from determinism checks. |
| Cost illustration | Estimated tokens times list input price for named models, with source and date, labelled as an illustration; unverified prices are marked. |
| Determinism | Two runs with the same seed produce identical JSON apart from timings, date, commit and machine fields. |
| Regression | `node --test tests/*.test.mjs` still passes; no file under `src/`, `public/`, `schemas/` or `tests/e2e/` changes; no new dependency. |
