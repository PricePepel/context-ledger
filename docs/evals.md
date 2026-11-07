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

## Cycle 6 — M2a warm latent pool (defined 2026-11-07, before implementation)

Cycle 5 is Ali's M0 benchmark (PR #3), so this cycle is numbered 6.

Contract: [docs/latent-read.md](latent-read.md). Leo side on `leo/latent-read`, Ali side on `ali/latent-pool`. Data: the synthetic codebase in `evals/latent/fixture` and the eight questions in `evals/latent/questions.json`, graded by `evals/latent/grade.mjs`.

### Ali side — warm pool runtime

| Eval | Expected |
| --- | --- |
| Path safety | Absolute paths, `..`, backslashes, drive letters and symlinks that leave `LATENT_ROOT` are refused with 400 before any file is read. More than 32 paths or 512 KiB returns 413. |
| Shared prefix | The reader, planner, workers and synthesizer all send a byte-identical system message for one prefix. A test against a fake vLLM checks this. |
| Warm cache | Against real vLLM, every call after the reader reports `cachedTokens` of at least 90% of the prefix tokens, and a second `latent_read` on the same paths starts warm. |
| Slice shape | The synthesizer output always matches the slice shape (vLLM structured output). A malformed model reply gives 502 with a clear error, never a broken slice. |
| Mapper scaffold | `GET /latent/mappers` returns `{pairs: []}`. `POST /latent/transfer` returns 501. |

### Leo side — ledger and MCP

| Eval | Expected |
| --- | --- |
| Proxy | `POST /api/latent/read` requires the same origin and forwards to `LATENT_URL`. Agents call it through the `latent_read` MCP tool, which has no other powers. |
| Slice validation | Findings citing a path not requested, or lines beyond the file, are removed and counted. Labels are escaped for agents. |
| Fallback | With the runtime down, the response is `mode: "text"` with numbered file text, and the tool still answers. |

### Gate (M2a)

On the eight questions, live with Qwen2.5-7B-Instruct-AWQ on the RTX 4090 Laptop GPU:

- accuracy ≥ 7/8 and citation rate ≥ 7/8;
- the slice the closed model receives is at most 10% of the tokens it would read without it (the prefix);
- the cached share across all calls is at least 0.6.

The closed-model baseline is Claude answering the same questions with all files in context. That baseline is recorded when a Claude runner is available. Until then, the gate is reported as open-model numbers against the token budget.

## Results — Cycle 6 (M2a), 2026-11-07

Live on Qwen2.5-7B-Instruct-AWQ with vLLM 0.33.0 (prefix caching on), on an RTX 4090 Laptop GPU (16 GB) under WSL Ubuntu 24.04. The ledger (Leo side, `leo/latent-read`) ran in front of the warm pool runtime (Ali side, `ali/latent-pool`, built by Leo's agent for Ali's review). The questions were the eight synthetic codebase questions, graded by `evals/latent/grade.mjs`.

| Run | Accuracy | Citations | Slice ÷ prefix tokens | Cached share | Gate |
| --- | --- | --- | --- | --- | --- |
| 1 | 7/8 | 8/8 | 0.065 | 0.987 | pass |
| 2 | 6/8 | 8/8 | 0.064 | 0.989 | fail (accuracy) |
| 3 | 7/8 | 8/8 | 0.065 | 0.995 | pass |

- The gate held in 2 of 3 runs, so pass@3 passes and pass^3 does not. The misses were real model omissions. The model answered "there is a hard cap" without 7200 s, and once said "extended by the refresh window" without 900 s. Prompts were not tuned to these questions, because that would overfit the gate.
- Warm sharing works. A direct probe showed the second call reusing 1,760 of 1,786 prompt tokens, and latency fell from 1,972 ms to 426 ms. In the runs, 98–99% of all prompt tokens came from the warm prefix, and the agent received about 6.5% of the tokens it would otherwise read.
- The closed-model baseline (Claude reading all five files) has not been run yet, so the gate's "matches the closed model" half is still open.
- Live debug fixes:
  - vLLM needed a C compiler and Python headers in WSL (installed with approval) and vLLM's own sampler instead of FlashInfer's JIT; `serve-vllm.sh` now handles both.
  - A cut-off synthesizer reply was retried with the identical request, giving a 502. The findings list is now sized to the budget, and the retry asks for a compact reply.
  - Ali's benchmark had claimed cycle 5, so this cycle was renumbered to 6.
- Leo-side review: one high finding. The slice answer could print fake findings and a fake "dropped: 0" footer. Two medium: unbounded receipt pass-through, and the file size was checked only after reading. Several low: Windows `:` data streams, directories gave 500, duplicate findings, hidden label characters, runtime error text passed to agents. All were fixed with tests in 5adfbd9. Nothing could escape LATENT_ROOT: junctions, short names, reserved names and UNC paths were all refused.

### Cycle 6 after the runtime review (2026-11-07, later)

- **Runtime review (Ali side): one high finding.** A file with planted instructions steered the live model: it answered "999 minutes, set in src/util.js" with in-range citations.
  - First fix (b11994e): grounding. Every number and named identifier in a finding must appear in the lines it cites.
  - A live probe then showed the model citing the planted comment itself, which does contain 999. So 03c4985 adds an instruction tripwire: lines that address an AI reader are reported as `suspiciousLines`, findings citing them are dropped, and the agent is warned that the answer may be manipulated.
  - Live on `evals/latent/injection`, the hijacked finding is dropped in 3 of 3 runs. The model's prose answer still says 999, but it is marked `answerVerified: false` and shown under the warning.
- **Runtime review lows:** case aliases on /mnt/c (now deduplicated by inode), spans clamped quietly (now dropped), duplicate findings, slow clients (connection cap, 10 s receive timeout), and the cut-off retry (now a compact retry). All fixed in 390c294 and a8fdf81, with tests on Windows and WSL.
- **Gate re-run after a vLLM restart, three runs:**

  | Accuracy | Citations | Slice ÷ prefix tokens | Cached share | Gate |
  | --- | --- | --- | --- | --- |
  | 6/8 each run | 8/8 each run | 0.065 | 0.905–0.993 | fails on accuracy |

  - The grounding check and tripwire dropped no legitimate finding: `rejectedFindings` was 0 on the missed questions.
  - The two misses are the 7B model omitting concrete values (7200 s, 900 s) after the restart.
  - Across all six live runs today the gate held in 2 of 6. Citations, slice size and caching passed every time, and accuracy is the open item.
  - Next options: test a stronger open model, or add a general "state concrete values" synthesizer rule and validate it on held-out questions, not these eight. The closed-model baseline is still not run.
- **Tenki review of PR #4 (Leo side): 2 medium, both measurement bugs, both fixed.**
  - The grader matched numbers as substrings, so "3" passed on "30". Numbers now match whole, though a glued unit such as "250ms" still counts.
  - The slice-size gate counted missing token stats as zero. Missing stats now fail the gate. `tests/grade.test.mjs` pins both.
  - The low finding (a stale pending order in the synthetic `orders.js`) is fixture realism and was left as is.
  - Re-run live with the corrected grader, three runs: accuracy 6/8, citations 8/8, slice 0.065, cached 0.995, the same as before. The earlier passes were not inflated by substring matches.

## Cycle 6b — Better latent reads: verified quotes and concrete values (defined 2026-11-07, before implementation)

Plan: latent-ledger `docs/latent-plan.md` section 7, items 1 and 2. Held-out set: `evals/latent/heldout.json` (eight new questions, written before any prompt change and never used for tuning). Baseline before changes, three runs: M2a set 6/8 accuracy, held-out 8/8, citations 8/8 on both.

| Eval | Expected |
| --- | --- |
| Verified quotes (contract addition) | Evidence spans may carry `quote`, the exact code the finding relies on (at most 200 characters). The ledger keeps the finding only if every quote occurs in its cited lines, ignoring runs of whitespace. A quote that is not there drops the finding, counted as `badQuotes`. A kept finding reports `quoteVerified: true` when every span carries a matching quote. |
| Quote coverage, live | The runtime asks the model for a quote on every span. On both sets, at least 80% of kept findings are quote-verified, and citations stay at least 7/8. |
| Concrete-values rule | Workers and the synthesizer are told to state exact values (numbers, units, names, strings) from the code. Live, three runs each: M2a set accuracy at least 7/8 in every run, held-out stays at least 7/8, and slice share stays at most 0.10. |
| Regression | Node suite, runtime suite (Windows and WSL), Playwright. The injection probe still drops the hijacked finding. |

### Results — Cycle 6b, 2026-11-07

Live on Qwen2.5-7B-AWQ, three runs per set, after the debug fixes below:

| Set | Accuracy | Citations | Slice ÷ prefix | Cached | Quote-verified findings | Gate |
| --- | --- | --- | --- | --- | --- | --- |
| Original eight (before: 6/8, failing) | 7/8 each run | 7/8 | 0.089 | 0.996 | 100% | pass 3/3 |
| Held-out eight (before: 8/8) | 7/8 each run | 8/8 | 0.054 | 0.99 | 100% | pass 3/3 |

- Accuracy across both sets is unchanged at 14/16. The concrete-values rule fixed `session-lifetime` and the original set now passes. Held-out `mail-queue` regressed: the answer names `MAIL_QUEUE` instead of `'orbit-mail'`. `session-cap` still omits 7200 s.
- Evidence quality improved. Every kept finding carries a verbatim quote the ledger checked. Wrong line numbers are now corrected (relocated) instead of passing unnoticed, and fabricated quotes are caught (2 per run on the original set, 1 on the held-out set).
- The slice is larger, because quotes cost tokens: 0.065 became 0.089 on the original set, still within the 0.10 gate.
- The injection probe still drops the hijacked finding in every run.
- Debug passes found three problems:
  - Workers and the planner were cut off once quotes were required. Fixed with 3 findings per worker within 900 tokens, and compact retries for every role.
  - The model's quotes were right but its line numbers wrong (`move(id, 'paid')` quoted from line 25 but cited as 24, `MAIL_QUEUE` from line 27 cited as 17–18). Fixed by anchoring evidence on the quote.
  - The gate runner aborted a whole run on one 502. A failed read is now scored as a wrong, uncited answer.
