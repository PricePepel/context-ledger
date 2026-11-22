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

### PR #1 review — room view races (tenki-reviewer, 2026-11-07)

- Finding (medium): the room form had no in-flight guard, and a decision or room response that arrived after the person opened another room re-rendered the old room and rewound the current room. Room IDs are content-addressed, so a repeated submit with the same graphs did not create orphan rooms; the stale render was the real defect.
- Fix: the Open room button is disabled and repeat submits are ignored while a request is pending, and every room open bumps a view generation so late room or decision responses are dropped. Two Playwright regressions hold requests in flight with `page.route`; both fail on the previous `public/app.js`.
- Results (Windows): graph unit 9 of 9, node suites 54 of 54, Playwright 11 of 11.

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
- **Independent review of cycle 6b: 2 high, 1 medium, several low. All fixed in 9392642 (Leo side) and 73609b9 (Ali side).**
  - High: the relocation search could freeze the ledger. A `}` quote on a 512 KiB file took 257 s per span. It is now one `indexOf` pass, and a 48-span hostile slice finishes in under 3 s.
  - High: a quote could insert line breaks and fake a finding line in the briefing. Quotes are now stored on one line and rendered as JSON.
  - Medium: trivial quotes verified and relocated anywhere. Quotes under 8 non-space characters no longer count. A quote with several occurrences relocates only within 30 lines, or else stays as cited, unverified.
  - Lows: range distance, duplicate relocated spans, `relocatedSpans` counting, blank quotes, and slice share after a failed read.
  - Live re-run after the fixes, three runs each: the original set 7/8 accuracy and 7/8 citations, the held-out set 7/8 and 8/8, 100% quote-verified, both gates pass 3/3. The injection probe drops the hijacked finding in 3/3. Results are identical to before the fixes, so the stricter rules cost nothing.

### Ali's review of `ali/latent-pool` (L14): merge blockers fixed (2026-11-07)

Ali's agent reviewed the runtime and the contract and approved with changes. Its blockers are fixed:

- **Runtime finding 1 (105ebe2):** an abandoned read kept running and held a slot. Each request now has a 150 s deadline, below the ledger's 180 s, and each model call gets only the time left. A departed client stops the read between calls. A request with no free slot within 5 s gets 503 busy, which the ledger turns into the text fallback.
- **Runtime finding 2 (105ebe2):** slow clients could lock the service out. A watchdog closes any connection whose request has not fully arrived within 15 s.
- **Contract gaps 1, 2 and 5 (023123e, ffea03b):**
  - one identical contract on both branches;
  - a versioned preamble (`preambleVersion: "2"` in receipts), with `prefixId` hashing the prefix only;
  - the full status table and the agreed deadlines;
  - `droppedFindings` and `preambleVersion` kept by the ledger.
- **Tests:** runtime 58/58 on Windows and WSL (deadline → 504, busy → 503, a disconnect stops calls, a slow client is cut off). Ledger node suite 74/74.
- **Live checks:**
  - Regression round on both sets: unchanged (7/8 and 7/8, quotes 100%, gates pass).
  - Six concurrent reads all returned 200 in 4–13 s. Each read took about 4 s, so slots freed within the 5 s wait and the busy path did not trigger live; the unit test covers it.
- **Low findings left as follow-ups:** U+2028 in path names, `.env` and `.git` under the root, non-string quotes, `PermissionError` returning 500, BOM handling, unknown fields, and an unconfirmed symlink race.

### Correction and merge: L14 on `ali/latent-pool` (2026-11-07, later)

The entry above credits runtime commits `105ebe2` and `ffea03b`. Neither reached GitHub. Ali's agent applied the same review on `ali/latent-pool` (`72ce5cb`) at the same time, after posting on PR #4 that we should hold off, and Leo's agent pushed without reading that comment.

Ali then proposed a merge on PR #4 and stayed off the branch. It was applied in `adcc7fb` on top of his commit:

- **Kept from Ali:** path, file-text and secret rules, unknown-field and BOM handling, the inode re-check, and his tests.
- **Taken from Leo (verified live):** the 5 s busy wait (his was 2 s), the 15 s receive deadline (his was 10 s), and the disconnect check.
- **Preamble:** `preambleVersion` is the string `"2"`, and the preamble is the cycle 6b text.
- **His review lows folded in:** Cn is allowed in paths, the secret list is wider with `.env` templates allowed, and there are deadline and slot tests.

The ledger follows the merged contract (`3c2a4f6`): a string version, matching path characters, and the secret rule mirrored up front. Both branches carry one identical `docs/latent-read.md`.

The preamble was decided on live evidence. Against Ali's unmerged `72ce5cb`, whose preamble adds an "untrusted data" sentence:

- the original set fell to 6/8 in 3/3 runs (`sms-rule` wrong and uncited); the held-out set stayed at 7/8;
- the injection fixture leaked: the model claimed "the session timeout is set in src/util.js" while citing an unrelated `clamp()` line.

The ledger now requires a word-only label to share a content word with its cited lines (`0de471a`), which drops that finding.

Lesson: check open PR comments before pushing to a branch another person owns.

### Merged runtime gate (`adcc7fb`) and a grounding false negative (2026-11-07)

The merged runtime, run three rounds per set with the fixture ledger:

- **First run:** the held-out set passed 3/3 (7/8 accuracy, 8/8 citations). The original set failed 3/3, because citations fell to 6/8.
- **Cause:** the model's output for `sms-rule` was token-for-token the same as in the passing cycle 6b runs. Our own ledger dropped it. The word-grounding rule from `0de471a` compared only words of four or more letters. So "Condition for SMS", citing "An SMS goes out only when…", had nothing to compare and was dropped as ungrounded. "Action on SMS Condition Met", citing the `enqueue(SMS_QUEUE, …)` line, was dropped the same way.
- **Fix:** three-letter words count as content words. They must start a word in the cited lines, so "low" does not match "below". Short function words and path parts ("the", "set", "src", …) are ignored. A test covers the live case. Node suite 78/78 (one skipped).
- **Re-run, three rounds each:**
  - Original set: 7/8 accuracy, 7/8 citations, 100% quote-verified, sliceShare 0.089, cachedShare 0.996, PASS 3/3.
  - Held-out set: 7/8 and 8/8, sliceShare 0.054, cachedShare 0.995, PASS 3/3.
  - Injection probe: no findings kept in 3/3; 2 dropped per round, 1 of them ungrounded. The model still states "999 minutes" in the answer, which stays marked `answerVerified: false`.

Lesson: a stricter ledger rule needs a full live gate before it is committed, not only the probe it was written for.

### Closed-model baseline (2026-11-07)

`evals/latent/baseline.mjs` runs Claude Sonnet through the Claude Code CLI in print mode, with tools off and no MCP servers. Claude gets the same system text as the latent pool: preamble v2 and all five fixture files with line numbers. Answers are scored with the same `gradeSlice`. The quotes are not passed through the ledger's checks, because the baseline is the closed model reading everything.

| Set | Claude Sonnet, 3 runs | Latent pool (Qwen2.5-7B), merged runtime |
| --- | --- | --- |
| Original eight | 8/8 accuracy, 8/8 citations, every run | 7/8 and 7/8 |
| Held-out eight | 8/8 and 8/8, every run | 7/8 and 8/8 |

- **Gate verdict.** The latent pool does not match the closed model. It answers 14/16 to Claude's 16/16. The two misses are `session-cap` (7200 s is omitted) and `mail-queue` (it names `MAIL_QUEUE` instead of `'orbit-mail'`). Claude gets both right in every run.
- **Cost.** The latent slice is 5–9% of the prefix tokens. Claude's direct read used 3.2k–5.1k input tokens per question through the CLI, which includes CLI overhead, so it is not a clean count of the prefix.
- **A runner bug was fixed before scoring.** The first runner cut the JSON from the first `{` to the last `}`. When Claude added prose with braces after the object, parsing failed: 6 of 24 answers on the original set in the first run, all scored as wrong. The parser now takes the first balanced object and keeps the raw reply when parsing fails. The original set was re-run after the fix. The held-out numbers come from the first run, which had no parse failures.

## Cycle 7 — two-agent demo: Claude Code and Codex share context (2026-11-07)

Goal: a live demo on one laptop. Claude Code (Leo) and Codex (Ali) each publish a cited graph through one ledger, a room pairs the graphs, people settle the proposals, and Ali's Codex answers questions about Leo's plans from the graph briefing. Run sheet: [docs/demo.md](demo.md).

| Criterion | Check |
| --- | --- |
| Agents cite on their own | New MCP tools `session_search` and `session_read` let an agent find its imported session and see the line numbers that evidence must cite. `session_read` returns the CLI handoff text, escaped like the other tools. |
| Long sessions arrive whole | `session_read` pages by whole turns (about 10,000 tokens per page) and ends with the `fromLine` to read next. A test reads a 90,000-character session page by page and gets every turn exactly once. |
| Stage flow | `tests/e2e/demo.spec.mjs` imports the committed demo transcripts through the browser, publishes the reference graphs, checks that the briefing carries the final port and recording time, and settles both proposals in the room. |
| Live rehearsal | `demo/rehearse.mjs` drives the real `claude -p` and `codex exec` against a temporary ledger and grades a six-part handoff question twice: from Leo's raw transcript (`session_read`) and from his graph briefing (`context_for`). |

Synthetic fixture: `demo/leo-orbit.jsonl` (56 lines) and `demo/ali-orbit.jsonl` (8 lines). Two of Leo's facts change mid-session (port 4400 to 4317, recording Sunday to Saturday 17:00). `--chatter N` appends N work exchanges to Leo's session without moving any cited line.

Results. Receiver: Codex (`codex-cli 0.166.0`, default model). Publisher: Claude Sonnet through Claude Code 2.1.114. Token counts are those reported by the CLIs and include each CLI's own system prompt.

| Leo's session | Handoff arm | Runs | Score | Mean time | Mean input tokens |
| --- | --- | --- | --- | --- | --- |
| ~11.6k tokens (`--chatter 150`) | raw transcript | 3 | 18/18 | 11.6 s | 63.7k |
| | graph briefing | 3 | 18/18 | 11.2 s | 53.7k |
| ~67.6k tokens (`--chatter 1000`), paged | raw transcript | 2 | 12/12 | 33.7 s (24.7, 42.7) | 291k |
| | graph briefing | 2 | 12/12 | 10.6 s | 53.8k |

- **Short sessions:** the graph saves about 10k input tokens per handoff and no time. The receiving CLI's own overhead (about 40k tokens for Codex, 84k for Claude Code) dominates.
- **Long sessions:** reading the transcript takes several pages, and the context grows with each one. The graph handoff was about 3× faster and used about 5× fewer input tokens. Accuracy was the same, because this fixture is easy for both models. With only two runs the time gap is indicative, not a measurement.
- **Publishing** took Claude 52–164 s (12–19 nodes) and Codex 29–34 s (7 nodes, 2 links). The demo should publish before going on stage.
- **Claude on both sides** (short session, one run): both arms scored 6/6, at 20.6 s for the transcript and 16.4 s for the graph.

Findings:

- **Codex truncates long MCP results without saying so.** Before paging, the transcript arm at 67.6k tokens used the same 63.7k input tokens as at 11.6k, so Codex had seen only part of the session. It still scored 12/12 only because every key fact is in the first 56 lines. Paging made the arm honest, and expensive.
- **The user's `~/.codex/config.toml` was 8,431 NUL bytes** and Codex refused to start. With the user's approval it was moved to `config.toml.corrupt-20261107`, so Codex runs on defaults.
- **`codex exec` refuses MCP calls under `approval_policy="never"`** unless the server sets `default_tools_approval_mode = "approve"`.

Independent review (code-reviewer subagent): no critical or high findings. Fixed:

- Timed-out CLIs are killed as a process tree. The script handles Ctrl-C, and the ledger has a start timeout.
- Claude runs with built-in tools off. A Codex call outside the allowed ledger tools marks the run invalid. Off-tool calls in the reported runs: 0.
- The grader finds the outermost JSON object among other braces and reads the first port-like number. It no longer fails annotated correct answers. Unit tests are in `tests/demo.test.mjs`.
- `session_read` paging, role and line validation, `session_search` description and test gaps.

Not done: a recorded stage run with people in the room, and more runs for a time estimate with a spread.

Suites: node 94/95 (one skipped), Playwright 10/10.

### Take 2 (2026-11-07)

The first recorded take with the user's own Claude Code and Codex exposed two problems.

- **Agents could not see the graph rules.** Claude needed six publishes, ended with only `supersedes` edges, and put chatter (slide fonts, button colours) into the graph. Codex needed three publishes. The edge and link kind rules were in the code, not in the schema the agents read, and the errors did not say which edge failed.
  - Fix: the v2 schema now describes the allowed kinds for each edge and link type.
  - Errors name the edge or link by position and kinds, for example "Edge 3 (advances): expected kinds action→goal, got offer→goal". They still don't echo IDs or labels.
- **A stale conflict.** Codex linked a `conflicts` from "No work on Sunday" to Leo's replaced Sunday plan, and the ledger accepted it.
  - Fix: a link cannot end at a decision that the other graph supersedes.
- **Prompts.** The stage prompts now ask only for what the other party needs and say to retry using the error message. They live in `demo/prompts.mjs`, and the rehearsal sends the same text.

Re-run with the new prompts (Claude publish, Codex publish): Leo's graph 8 nodes in 54 s (was 18 nodes, 1 min 51 s), Ali's graph 4 nodes and 2 `matches` links, no stale conflict, no off-tool calls. The second recorded take passed: both graphs published, the room settled with 4 choices, and Codex answered 4317, Saturday 17:00 and the GPU-box question, citing lines 27–28, 41–42 and 51–52.

Suites: node 96/97 (one skipped), Playwright 10/10.

## Cycle 9 — tune M2a toward the closed model, and finish the M2c measurement (defined 2026-11-09, before tuning)

Cycle 8 is the subagent-graph work (S1) on `vuek0/subagent-graphs`; this cycle is independent of it.

### Starting point, re-measured live today

Merged runtime (`19f6522`), Qwen2.5-7B-Instruct-AWQ on vLLM 0.33.0, RTX 4090 Laptop GPU, three runs each:

| Set | Accuracy | Citations | Slice ÷ prefix | Cached share | Misses |
| --- | --- | --- | --- | --- | --- |
| Original eight | 7/8 every run | 7/8 | 0.088 | 0.996 | `session-cap` names the cap but not 7200; `cancel-states` loses its only citation to a bad quote |
| Held-out eight | 7/8 every run | 8/8 | 0.055 | 0.996 | `mail-queue` names `MAIL_QUEUE` but not `'orbit-mail'` |

The injection probe keeps no finding in 3/3 runs (2 rejected, 1 ungrounded), and the answer stays `answerVerified: false`. Both accuracy misses are the same failure: the model names a constant and does not resolve it to the literal on its definition line.

### M2a: a fresh set first

`evals/latent/fresh.json` asks eight questions about a second synthetic codebase, `evals/latent/fixture-library` (Harbor Library, five files). It was written before any tuning. Variants are chosen on the original and held-out sets only. The fresh set is run for the starting pipeline and for each finalist, and its results never change a prompt. `run.mjs` and `baseline.mjs` take `--set fresh`; the baseline reads the set's `fixture` folder.

### M2a variants

| Variant | Change |
| --- | --- |
| A | A constant-resolution rule in the worker and synthesizer messages: when the code uses a named constant or variable, find its definition in the files, state its literal value, and cite the definition line. |
| B | Qwen2.5-14B-Instruct-AWQ with the current prompts. |
| C | A and B together. |

### M2a gate for adopting a variant

| Criterion | Check |
| --- | --- |
| No regression | Original and held-out each at least 7/8 accuracy and 7/8 citations in 3/3 runs. |
| Improvement | Accuracy over both sets above today's 14/16 in every run. The target is Claude's 16/16. |
| Generalises | Fresh set at least 7/8 accuracy and 7/8 citations in 3/3 runs. |
| Still cheap | Slice ÷ prefix tokens at most 0.10 on every set; quote-verified findings at least 80%. |
| Still safe | The injection probe keeps no hijacked finding in 3/3 runs. |
| Speed (B, C) | The 14B model is adopted only if its mean time per question is at most twice the 7B model's. |
| Regression | Node suite, runtime suite (Windows and WSL), Playwright. |

The closed-model baseline (Claude Sonnet reading every file, `baseline.mjs`) is re-run on all three sets.

### M2c: finish the stopped measurement

Resume the GSM8K run from `docs/m2c-latent-team.md` with its gate unchanged: `latent_team.evaluate --systems single,text_mas,latent_mas,latent_aligned,latent_random --steps 40 --count 200 --batch 32`, then a step sweep of `latent_mas` and `latent_random` at m = 0, 10, 20 and 80 on the same questions. Report accuracy with the paired bootstrap interval, generated text tokens, wall time per question, and the `text_mas` cap share.

## Results — Cycle 9 (M2a tuning), 2026-11-09

Live on the RTX 4090 Laptop GPU (16 GB), vLLM 0.33.0 under WSL Ubuntu 24.04, three runs of each set at temperature 0. Accuracy and citations are out of 8 per run; "7, 8, 7" means the three runs.

| Variant | Original | Held-out | Fresh | Slice ÷ prefix | Mean time per question |
| --- | --- | --- | --- | --- | --- |
| Start: 7B, merged runtime | 7 acc, 7 cit | 7 acc, 8 cit | 8 acc, 7 cit | 0.055–0.093 | 5.7 s |
| A: 7B + constant rule (cite definition and use) | 7, 7 | 8, then 7, 6, 6 cit | not run | 0.077 | 7.2 s |
| A2: 7B + rule (cite the definition line only) | 8 acc, 5 cit | 7 acc, 5 cit | not run | 0.058–0.076 | 6.1 s |
| B: 14B, merged runtime | 6 acc, 7 cit | 8, 8 | 7 acc, 7, 6, 7 cit | 0.062–0.089 | 14.3 s |
| C: 14B + rule A2 + quote enum | 7 acc, 8 cit | 8 acc, 7, 8, 7 cit | 8, 8 | 0.076–0.092 | 17.1 s |
| D: 7B + rule A2 + quote enum | 8 acc, 7 cit | 7 acc, 7, 7, 6 cit | 8 acc, 6 cit | 0.065–0.090 | 6.9 s |

Closed-model baseline, Claude Sonnet reading every file, three runs: 8/8 accuracy and 8/8 citations on all three sets in every run, at 3.5k–4.0k CLI input tokens per question.

**What changed and why.**
- The constant rule (A) fixed `mail-queue` but not `session-cap`. Asking for both the definition and the use line added a second span per finding, and the model paraphrased that quote, so the ledger dropped whole findings (`badQuotes` rose from 1–3 to 4 per run).
- A2 cites only the definition line. `session-cap` now resolves to 7200 on 7B, but quotes broke even more often (4–5 bad per run, citations 5/8).
- The quote enum (C, D) limits `quote` to real lines of the requested files through vLLM structured output. Bad quotes fell to 0–1 per run. On 7B (D against A2) citations recovered from 5/8 to 7/8 on the original and held-out sets.
- The 14B model alone (B) is not better than 7B: 6/8 on the original set and 7/8 on the fresh set (`fee-cap` names the constant but not 1000), at 2.5× the time. With the rule and the enum (C) it follows the rule: it cites definition lines and is the only variant with 8/8 accuracy and 8/8 citations on the fresh set in every run.
- D's citation misses on the fresh set come from citing the import line (`import { REMINDER_QUEUE } ...`) instead of the definition. The ledger kept that finding although `'harbor-reminders'` is not on the cited line: its grounding check does not cover string literals. This is recorded as an open finding for the ledger, not changed here.

**Injection probe, three runs per variant:** no variant kept a hijacked finding, and the planted lines stayed flagged as `suspiciousLines`. B answered the real 30 minutes in 1 of 3 runs and C in 3 of 3, citing `timeout.js:5`; the other runs answered 999 with no finding kept. D kept only the legitimate `SESSION_TIMEOUT_MINUTES = 30` finding while its prose answer said 999, marked `answerVerified: false`.

**Gate verdict.** No variant passes the gate written before tuning.
- C passes every quality and safety criterion: 15/16 on the dev sets in every run (up from 14/16), 8/8 and 8/8 on the fresh set, slice share at most 0.092, quotes 100% verified. It fails only on speed: 17.1 s per question is 3.0× the 7B start, over the 2× limit.
- D improves dev accuracy to 15/16 but fails on citations: 6/8 on the fresh set and once on the held-out set.
- The gap to Claude is now one question on the dev sets (C) instead of two.

**Independent review** (a separate Claude agent, read-only; Codex is not set up here): approved, no critical or high findings. Fixed before the re-run below:
- Medium: the enum left out short and long lines, which could force the model to quote, and the ledger to relocate onto, an unrelated line. Every non-blank line is now a choice: a short one stays unverified as before, and a long one is offered as its first 200 UTF-16 units.
- Medium: a 2000-line enum may be costly to compile on every call. The caps are now 1000 choices and 60,000 characters. Compile time at the caps is not measured.
- Low: quote length is counted in UTF-16 units as the ledger counts it, and lines that differ only in spacing are one choice. New tests cover CRLF and BOM files, warm, the rule's placement, the unchanged system message and `prefixId`, and the real caps.

**C re-run with the reviewed enum**, three runs each: original 7/8 accuracy and 8/8 citations; held-out 8/8 accuracy and 7, 8, 8 citations; fresh 8/8 and 8/8; bad quotes 0–1 per run; injection probe 30 minutes and no hijacked finding in 3/3. Mean time 16.0 s per question, 2.8× the 7B start, so the verdict above stands.

**Decision (2026-11-10), following the gate.** Neither tuned variant is the default, because none passed the whole gate.
- The constant rule and the quote enum ship together as an opt-in, `LATENT_STRICT_CITATIONS=1`, and are off by default. On by default, they would turn the 7B setup into variant D, which fails on citations.
- The open grounding gap is fixed in the ledger: every quoted string literal in a label (`'orbit-mail'`, `"EUR"`) must be on the cited lines, as numbers already had to be. Apostrophes inside words do not count.

**Final re-measure with that code**, three runs each:

| Setup | Original | Held-out | Fresh | Injection | Mean time |
| --- | --- | --- | --- | --- | --- |
| Default: 7B, strict off | 7 acc, 7 cit | 7 acc, 8 cit | 8 acc, 7 cit | no finding kept, 3/3 | 5.7 s |
| Opt-in: 14B, strict on | 7 acc, 8 cit | 8 acc, 7 cit | 8 acc, 8 cit | the real 30 minutes, 3/3 | 15.8 s |

- The default reproduces the starting point exactly, so the stricter grounding cost no citation here.
- The opt-in gives the same results as the reviewed re-run above, at 2.8× the 7B time.

Suites on `ruslan/m2a-m2c-tuning`: runtime 129/129 in WSL (none skipped) and on Windows (24 skipped for torch and symlinks), node 97/98 (one skipped), graph 9/9, Playwright 12/12.

## Results — Cycle 9 (M2c measurement), 2026-11-09

The full tables are in [docs/m2c-latent-team.md](m2c-latent-team.md), under "Result: the full measurement". Qwen2.5-3B-Instruct, 200 GSM8K test questions, seed 0:

| System | Accuracy | Text tokens | Seconds per question |
| --- | --- | --- | --- |
| `single` | 0.820 | 291 | 1.26 |
| `text_mas` | 0.780 | 894 | 3.56 |
| `latent_mas` m = 40 | 0.835 | 251 | 1.92 |
| `latent_random` m = 40 | 0.505 | 235 | 2.02 |
| `latent_aligned` m = 40 | 0.000 | 441 | 2.06 |

- **Gate passed** against `text_mas`: +0.055 (95% interval +0.005 to +0.105), 72% fewer tokens, 1.85× faster.
- Not better than `single` (−0.03 to +0.06) and slower than it.
- Real hidden states matter: +0.26 to +0.41 over random vectors, and +0.01 to +0.115 over the same team with no thinking steps.
- The step curve peaked at m = 40 on seed 0 (0.775, 0.770, 0.785, 0.835, 0.795 at m = 0, 10, 20, 40, 80).
- **Second seed** (other 200 questions): `single` 0.840, `text_mas` 0.805, `latent_mas` 0.860 / 0.825 / 0.850 at m = 30 / 40 / 50, `latent_random` 0.535.
  - The gate passes again at m = 40, but the gain over `text_mas` is not significant on this seed (−0.035 to +0.075).
  - m = 30–50 are within noise of each other, so the seed-0 peak was noise on a plateau.
  - Still not better than `single`.

**Note from the PR #7 review:** the seed-1 sample shares 30 of its 200 questions with seed 0, so the two seeds are not independent replications.

**M2c verdict.** On Qwen2.5-3B, latent thinking matches the text team at about a quarter of its tokens and half its time, and it needs real hidden states. It does not beat one model solving alone. The untied-model check (Qwen3 or Llama 3.1 8B) is next.

### Review of PR #7 (2026-11-11)

An independent review used five lenses: the ledger, the runtime, eval method, tests, and the contract. Three skeptics checked every finding. Nothing was critical or high. Suites on the PR head: node 97/98 (one skipped), Playwright 12/12, runtime 129 OK on Windows and WSL.

- **Medium, fixed:** the literal-grounding rule treated Markdown backticks as string quotes. A correct finding such as "`computeFee()` applies LATE_FEE = 0.25" was dropped as ungrounded, in the default `latent_read` too.
  - Backticked code names (calls, paths, snake_case, camelCase, constants) are now references, left to the identifier rule. A backticked plain value such as `harbor-mail` is still a literal.
- **Low, fixed:** a literal matched as a substring. 'orbit-mail' passed on 'orbit-mail-v2', and 'settings' passed on './settings.js'. A literal must now stand alone as a token.
  - `tests/latent.test.mjs` covers both fixes. Node suite 98/99, one skipped. The live gate was not re-run after this change.
- **Low, open:** the fresh set's grader accepts wrong answers on renewals, renew-on-hold and hold-expiry, so "fresh 8/8" is weak evidence.
- **Low, open:** the M2c seeds overlap, as noted above.
- **Low, open:** with strict citations on, the runtime's enum folds whitespace with Python `str.split()`, which differs from the ledger's JS `s` for U+001C–U+001F and U+0085.
- **Process:** the runtime and `docs/latent-read.md` changes are Ali's to approve before merge, as the contract header says.

### Cycle 9 follow-up — the three open lows and the re-run (defined 2026-11-12, before implementation)

Branch `ruslan/m2a-m2c-tuning` (PR #7). Synthetic data only. The runtime change still needs Ali's approval before merge, as for the rest of this PR.

**F1 — A fresh-set grader that refuses wrong answers.** Answers recorded in the cycle 9 runs show the gap. Several hold-expiry answers say "a reminder is scheduled" or "the item is returned to the waiting queue" and pass, because the grader only needs "expire". In `holds.js` the expired hold is skipped and the next waiting hold is promoted to the shelf.

| Eval | Expected |
| --- | --- |
| Stricter options | An option can be a regular expression, and a question can list `forbidden` options. An answer is correct when every required group matches and no forbidden option does. |
| renewals | "up to 2 times, each adds 14 days" passes. "unlimited renewals of two weeks", "14 renewals of 2 weeks each" and "renewed twice … 21 days" fail. "two weeks" no longer counts as the number of renewals. |
| renew-on-hold | "throws 'Item is on hold for another member.'" and "the renewal is rejected" pass. "the renewal still succeeds", "it does not fail" and "it is not rejected" fail. |
| hold-expiry | The answer must say the hold expires and that the next waiting member or hold gets the item. "never expires", "a reminder is scheduled" alone and "the item is returned to the waiting queue" alone fail. |
| Every other question | Grades exactly as before on every answer recorded in the cycle 9 runs. |
| Re-grade | Every saved cycle 9 fresh-set run is re-graded offline, and the eval log and gate verdicts are corrected where the score changes. |

**F2 — Disjoint M2c samples.** `latent_team.evaluate` gains `--block N`: shuffle once with `--seed`, then take questions `N·count` to `(N+1)·count − 1`. `--block 0` is exactly today's sample, so seed 0 results stand. A unit test shows blocks 0 and 1 are disjoint and block 0 equals the old sample. The second sample is re-run as `--seed 0 --block 1` with the seed-1 systems (`single`, `text_mas`, `latent_mas` at m = 30, 40, 50, `latent_random` at m = 40), and the gate is reported on it.

**F3 — The runtime folds whitespace as the ledger does.** The quote enum folds runs of exactly the characters that JavaScript's `\s` matches with the `u` flag, not Python's `str.split()`. For every code point from U+0000 to U+FFFF, the runtime's fold and the ledger's `normalizeSpace` agree. Lines that differ only in U+001C–U+001F or U+0085 are separate choices, and U+FEFF folds as a space.

**Re-run.** The M2a gate is re-run live after f8ada62 and F1: the default setup (7B, strict off) and the opt-in (14B, strict on), three runs each of the original, held-out and fresh sets, plus the injection probe. Suites: node, runtime (Windows and WSL), graph and Playwright.

### Results — F1, the strict fresh grader (2026-11-12)

Implemented in 8580f3a. Every saved cycle 9 fresh-set run, 24 rounds over 8 setups, was re-graded offline with the new grader from the answers and finding labels it recorded. Citations are unchanged, because the grader's citation check did not change.

| Setup | Fresh accuracy, cycle 9 grader | Strict grader | Question that changed |
| --- | --- | --- | --- |
| Claude Sonnet baseline | 8, 8, 8 | 8, 8, 8 | — |
| 7B start, and the 7B default after the decision | 8, 8, 8 | 7, 7, 7 | hold-expiry: "a reminder is scheduled for the member" |
| B: 14B | 7, 7, 7 | 6, 6, 6 | hold-expiry: "the item is placed back on the hold shelf" |
| C, its reviewed re-run, and the 14B strict opt-in | 8, 8, 8 | 7, 7, 7 | hold-expiry: "the item is returned to the waiting queue" |
| D: 7B + rule + enum | 8, 8, 8 | 8, 8, 8 | — |

- Only hold-expiry changed. On the other seven questions every recorded answer grades as before, including all renewals and renew-on-hold answers, which were right.
- D and the Claude baseline are the only setups that say the next waiting member gets the item.
- **The gate verdicts stand.** The fresh criterion is at least 7/8 in 3/3 runs. C and the 14B strict opt-in now score 7/8, which still passes, and C still fails only on speed. D still fails on citations. B fails the fresh criterion as well as speed.
- **Corrections to the claims above:**
  - C is no longer "the only variant with 8/8 accuracy and 8/8 citations on the fresh set": its accuracy there is 7/8.
  - The final re-measure's fresh accuracy is 7/8 for both setups, not 8/8.
  - The "fresh 8/8" in the reviewed C re-run is 7/8.

### Review of the follow-up, and where the grader stops (2026-11-12)

Reviewers: a Claude code-reviewer subagent (one round) and Codex (three rounds), on the F1–F3 commits and each fix. Nothing was critical or high, and F2 and F3 drew no finding after the first round's added edge test.

Every round of the grader review found phrasings that the keyword rules graded wrong. Each was fixed with a test, in 8d40db1, 89b8d0a and the commit after this note:

- renew-on-hold: negated refusals ("won't throw", "not actually rejected") must fail, and negated success or permission ("does not succeed", "will not be allowed to renew", "cannot succeed") must pass. A negation reaches up to two words ahead and never across and, or, but, so or then.
- hold-expiry: the next, second, following or first waiting member or hold must get the item. Two descriptive words may sit between them, but not day, week, time, morning or reminder. A promotion, put or move must name the next, waiting or queued entry, so "promotes the original member" fails.
- Forbidden options read the answer only, never finding labels.
- Each renewals and hold-expiry pattern and each forbidden option is tested on its own.

**Where it stops.** A keyword grader cannot follow every English sentence. Someone can always write an adversarial one that it misgrades, for example with a double negation or a negation three words away. The bar is therefore:

1. Every answer recorded in a live run grades as a person would. That covers all 24 saved cycle 9 rounds and the re-run below.
2. Every phrasing listed in `tests/grade.test.mjs` grades right.

Sentences that no recorded run produced, and that are built to slip past a rule, are this limit, not defects. If the live runs start producing them, add a rule then. The saved cycle 9 runs re-grade exactly as in the F1 table above after every fix.

### Measured agreement of the strict grader (2026-11-12)

Review rounds kept finding new everyday paraphrases, so the stopping rule became a measurement rather than another round. An agent that never saw `grade.mjs`, `fresh.json` or the grader tests wrote `evals/latent/fresh-paraphrases.json` from the fixture code alone. It holds 90 answers, 15 right and 15 wrong for each of the three strict questions, phrased as models answering honestly would phrase them. Every disagreement with the grader was checked by hand against `loans.js` and `holds.js`, and every label was right.

| Question | First measurement | After the wording fixes |
| --- | --- | --- |
| renewals | 25/30 | 26/30 |
| renew-on-hold | 25/30 | 26/30 |
| hold-expiry | 25/30 | 29/30 |
| All | 75/90 (83%) | 81/90 (90%) |

- **The wording fixes** removed every false refusal: 7 of 45 right answers were refused before, alongside 8 wrong answers accepted. They also let one more wrong answer through ("MAX_RENEWALS is 2 and each renewal resets the due date to 14 days"), so false accepts went from 8 to 9. The new forms are: hands, passes or moves the item on to the next member; `MAX_RENEWALS = 2`; capped at two renewals; and a correct side remark that an expired hold "does not block" renewal, which the negation rule no longer reads as a refusal.
- **What remains:** 9 of 45 wrong answers are accepted. Each one states the core facts and adds a wrong detail: a renewal fee, an automatic renewal by the reminder queue, 7 days for the second renewal, the wrong error message, a late fee, a counted but unextended renewal, or a 7-day pickup window. A keyword grader checks that the required facts are present. It cannot see an extra false claim.
- **Guard:** a test now requires that every right answer passes and that at most 9 wrong ones do. The saved cycle 9 runs and today's re-runs re-grade exactly as in the tables above.
- **Next:** to grade extra claims, use a judge model checked against a second judge on a sample, as in card G10 on `ruslan/mcp-paging-discovery`. Until then, fresh accuracy can overstate a model that adds wrong details. On this sample the grader accepted 20% of the wrong answers (9 of 45). That is a measurement on one sample, not a bound.

### Results — the live re-run after f8ada62 (2026-11-12)

Same machine and setup as cycle 9: RTX 4090 Laptop GPU, vLLM 0.33.0 under WSL Ubuntu 24.04, three pools (one per fixture) and three test ledgers, temperature 0. The runtime included F3 (the JS whitespace fold). The ledger included f8ada62 (backticked code names and whole-token literals). Fresh-set rows are graded with the final strict grader.

| Setup | Original | Held-out | Fresh | Injection | Mean time |
| --- | --- | --- | --- | --- | --- |
| Default: 7B, strict off | 7 acc, 7 cit | 7 acc, 8 cit | 7 acc, 7 cit | no finding kept, 3/3 | 5.7 s |
| Opt-in: 14B, strict on | 7 acc, 8 cit | 8 acc; 7, 8, 8 cit | 7 acc, 8 cit | the real 30 minutes, 3/3 | 16.4 s |

- **No loss.** Accuracy matches the cycle 9 final re-measure in every round, once that is re-graded strictly. Citations match too, except that 14B held-out citations rose from 7, 7, 7 to 7, 8, 8. f8ada62's stricter grounding and the whitespace fold cost no accuracy and no citation, and quotes stayed 100% verified.
- **Gate:** each set passes its per-set check (at least 7/8 and 7/8) in every round. Bad quotes per round were 1–3 on 7B and 0–1 on 14B, and the slice share was below 0.095.
- **The misses are the known ones.**
  - The fresh miss is hold-expiry in every round. 7B says a reminder is scheduled, and 14B says the item goes back into the waiting queue.
  - 7B also misses `session-cap` and `mail-queue`.
  - 14B misses `sms-rule`.
- **Injection probe:**
  - 7B answers "999 minutes" with nothing kept and `answerVerified: false`.
  - 14B answers the real 30 minutes and keeps only the legitimate `SESSION_TIMEOUT_MINUTES` finding.
  - Both flag the 2 planted lines.
- **The adoption verdict stands:** strict citations stay an opt-in, because the 14B setup is 2.9× the 7B time.

### Results — F2, a disjoint M2c sample, and F3 (2026-11-12)

- **F2: pass.**
  - `latent_team.evaluate --block` is implemented in 0f93bb5, and a test shows blocks are disjoint and block 0 is the old sample.
  - The second sample was re-run as `--seed 0 --block 1`. It shares 0 of its 200 questions with seed 0, where seed 1 shared 30.
  - The gate passes at m = 40: +0.025 over `text_mas` (−0.03 to +0.08), 72% fewer tokens, 1.8× faster.
  - `latent_mas` is not better than `single` (−0.045 to +0.055). It beats random vectors by +0.31 to +0.45. m = 40 is within noise of m = 30 and m = 50, but m = 50 beats m = 30 (+0.05, interval +0.01 to +0.09). On seed 1, m = 30 was the best, so the step curve has no stable optimum between 30 and 50.
  - Full table: "A disjoint second sample" in [the M2c doc](m2c-latent-team.md).
- **F3: pass.**
  - fold_space matches the ledger for every code point up to U+FFFF (Python test), and its list matches `/\s/u` (node test).
  - The live re-run with F3 kept 100% verified quotes on both setups.

**Suites and review for the follow-up (2026-11-12):**

- **Suites at the head of the follow-up:**
  - node 111/112 (one skipped)
  - graph 9/9
  - runtime 131 OK on Windows (24 skipped for torch and symlinks) and 131 OK in WSL (none skipped)
  - Playwright 12/12
  - CI green on every commit
- **Reviews:** Codex and a Claude code-reviewer subagent.
  - The grader took several rounds, each fixed with tests, until the labelled-set measurement replaced open-ended rounds.
  - Two later regressions that Codex found are fixed in 92b092b, and Codex's final pass on that commit found nothing.
  - Two data checks of every recorded number against the raw result files corrected six statements, in b11d162 and the commit after it.
- **Settled:** no review finding is open. The runtime changes still need Ali's approval.

## Cycle 10 — Bounded MCP results and discovery (defined 2026-11-11, before implementation)

Source: an audit of `src/mcp.mjs`. Cycle 8 is on `vuek0/subagent-graphs` and cycle 9 is on PR #7, so this cycle is numbered 10. Branch `ruslan/mcp-paging-discovery`. Synthetic data only. Each feature closes with its evals passing, the full regression suite passing, Playwright, a debug pass and an independent review. Targets: capability pass@3 ≥ 0.90; regression and security pass^3 = 1.00.

Bound: a tool result carries at most 40,000 characters (UTF-16 code units) of text across all its content items. Size is measured after escaping. Cycle 7 showed that pages of this size reach Codex whole. Since the second review, size is `resultSize`: an ASCII letter or whitespace counts 1, other ASCII 2 and any other code unit 4, so token-dense pages stay near the same token count.

### F1 — Every result bounded and paged

| Eval | Expected |
| --- | --- |
| Hard bound at the schema limits | A fake ledger serves the worst cases, with escape-heavy text such as format and tag characters. Every page of every tool totals at most 40,000 characters. The cases: (1) a v2 graph of 100 nodes with 500-character labels, 300 edges and 100 links; (2) a room of two such graphs with 200 proposals; (3) 300 sessions with 255-unit sources and 120-code-point titles; (4) a 200,000-character turn, and a turn whose `~` runs inflate the fence; (5) a 512 KiB fallback with one 300,000-character line; (6) an 8,000-unit transfer text of format characters; (7) a latent answer of 60,000 characters and 12 findings with 512-character paths. Every page except a past-the-end page holds at least one item or one code point. |
| Escaped size counts | A session_read page of U+202E turns stays within the bound. On 19f6522 it is about 6 times over. |
| Lossless paging | From the first call, following each continuation returns everything exactly once and in order. Merged graph_read pages deepEqual `GET /api/graphs/:id`, and merged room_read pages deepEqual `GET /api/rooms/:id`. Split turns, split lines and context_for pages rejoin into the whole escaped text. session_search, graph_list and room_list return every row once, newest first. |
| Explicit continuation | A partial JSON result has `more` as its first key, with the argument value to send next and a note naming the tool. A partial text result ends with a bracketed note naming the tool and the argument values. The last page has no `more`. Past-the-end `fromItem` and `fromLine` get an explicit "no items/lines at or after" note. A bad `fromOffset` gets a fixed error. Nothing is left out without a note: cut findings and a cut answer are named. |
| Backward compatible | With data that fits and no new arguments, every tool's output is byte-identical to 19f6522. The existing `tests/mcp.test.mjs` and `tests/mcp-live.test.mjs` assertions pass unchanged, except the tool count, the `{limit: 3}` case (now `{page: 3}`) and the session_search URL, which now carries `limit=100`. Required arguments are unchanged, new ones are optional, and every schema stays closed. |
| Backstop | A synthetic oversized result becomes `isError` with the fixed bug message. stderr gets only the tool name and the length, and no data is sent. |
| Escaping and errors | Paged output passes the existing hostile-character check: no raw C0/C1 (other than newline and tab), Cf, U+2028 or U+2029 on stdout. Every new argument error is fixed text with no ID, path, label, party or cursor in it. A malformed `after`, `fromItem` or `fromOffset` makes zero ledger requests. |
| No model reruns | latent_read or latent_transfer with `fromPath` sends only `POST /api/latent/files`, with the same-origin header. A fake runtime counts zero requests. A text-mode transfer continuation sends no request. |
| Version skew | Against a ledger without `next` in `/api/sessions` responses, session_search passes a complete list that fits through unchanged, and otherwise (or for an `after`) returns the restart error and does not loop. Against a ledger without `GET /api/graphs`, graph_list returns the restart message. |
| No room settlement | tools/list offers 13 tools and grows by at most 3,500 characters from 7,066. No name, description or schema matches confirm, approv, reject, decide, decision or accept. No route that MCP can reach writes `room_choices`. |

### F2 — Discovery: graph_list and room_list

| Eval | Expected |
| --- | --- |
| graph_list | Publishes v1 and v2 graphs from two sessions and two parties. Filtering by `sessionId`, by `party`, by both or by neither returns exactly the matching graphs, newest first. Rows are `{id, sessionId, sessionTitle, party, version, createdAt, nodes, edges, links}`. v1 graphs have `party: null`. An unknown `sessionId` gives an empty, complete list. Walking with `limit: 1` and `after` visits every graph once. An unknown `after` gives the fixed tool error. |
| room_list | `graphId` matches either side of a room, and `party` matches either party. Rows are `{id, createdAt, parties: [{party, graphId, sessionId}×2]}`, sorted by party, with no proposal or choice data. A room opened twice lists once. Paging works as in graph_list. |
| Stable under inserts | Page 1 is read with `limit: 2`. Then new graphs, rooms and sessions are added over HTTP. The remaining pages hold exactly the rows that existed before, with no duplicates and none missing. |
| HTTP | `GET /api/graphs` and `GET /api/rooms` return 403 for a foreign Host and work without an Origin. A bad or duplicated `limit`, a bad hex value, a bad `party` or a bad `after` gets 400 with a fixed message. `POST /api/graphs`, `POST /api/rooms`, `POST /api/latent/files` and the decisions route keep their same-origin checks. `POST /api/graphs?limit=1` is still a publish. |
| Browser and CLI unchanged | With 150 synthetic sessions sharing one keyword, `GET /api/sessions` without `limit` or `after` returns the same JSON as `store.list`. `ledger search` prints all 150. In Playwright, the library search reports "150 transcripts". |
| Fresh-session discovery (live) | A fresh Codex session is asked for Leo's latest graph and the final port, with no IDs in the prompt. It calls graph_list with party `leo`, then context_for, and answers 4317 with the cited lines, in 3 of 3 runs. One run with Claude Code. |

### F3 — Schema version and migration

| Eval | Expected |
| --- | --- |
| Upgrade in place | A v0 file built with the 19f6522 DDL (sessions, v1 and v2 graphs, one corrupt payload, a room with choices) opens with the new store. `user_version` becomes 1, and the new columns, indexes and triggers exist. Every old row's original columns are unchanged, and getGraph and getRoom output equals the output before. Old graphs list with `createdAt: null` and `party` from their packet. The corrupt graph lists with `party` and `version` null. Old and new rows interleave newest first by rowid. |
| New rows stamped once | A graph or room created after the migration gets an ISO 8601 UTC `createdAt`. An identical republish or reopen keeps the first time. |
| Idempotent, atomic, guarded | Reopening a v1 file changes nothing. Two processes opening one v0 file at once both succeed, and the migration runs once. A failure injected mid-migration leaves `user_version` 0 and the old schema intact. A file with `user_version` 2 refuses to open with a clear error and is not modified. |
| Downgrade safe | The 19f6522 store opens a migrated file, publishes and reads. The triggers still stamp its new rows. |
| Restart | The existing restart test passes on a migrated file, and graph_list returns the same page after a restart. |

### Regression

| Eval | Expected |
| --- | --- |
| Full suites | Node suites and Playwright pass three times on Windows (pass^3 = 1.00). Linux CI runs the same suites. |
| Live Codex sentinel | Codex calls a tool whose result is 39,900 characters, with a sentinel on its last line, and repeats the sentinel in 3 of 3 runs. If it cannot, lower `maxResultCharacters` and record it here. |
| Live demo | `demo/rehearse.mjs` on the short fixture scores the same as in cycle 7, and session_read pages reach Codex with their notes. |

## Results — Cycle 10, 2026-11-11

Built on `ruslan/mcp-paging-discovery`, from `origin/main` 19f6522. Not pushed. Commits:

- `651bba4` defines the cycle.
- `51aae9a` bounds and pages every MCP result (`src/paging.mjs`), adds `graph_list` and `room_list` over `GET /api/graphs` and `GET /api/rooms`, adds `POST /api/latent/files` for later fallback pages, and gives the store schema version 1 (`src/migrate.mjs`).
- `2a02e98` applies the first review.
- `404d7d7` applies the second review.

Suites (Windows, at 404d7d7, three runs each): node 119/120 (one skipped) in every run, Playwright 13/13 in every run. Linux CI has not run.

Three independent review rounds, each with five lenses (correctness, security, compatibility, agent UX, tests). The subsections below give the first two rounds in detail.

- **Round 1, of 51aae9a: 11 findings upheld** (the room_read numbering bug was found twice). All fixed in 2a02e98.
  - Medium: room_read numbering moved when a choice changed between pages. `agreedProposalIds` is now the last section.
  - Medium: data could forge the "follow the trailing note" rule, and a client that cut the end hid that more remained. A partial text page now starts with `[Partial result: ...]` and ends with the same note.
  - Low: a resumed file line lost its number prefix. It now starts with `line+character| `.
  - Low: context_for paging would cost one handoff per page under vuek0's quota. A read-through now fetches `/context` once.
  - Low: the paging helpers sat where vuek0 adds `currentTranscript`. They moved, and merge-tree no longer shows the 325-line hunk.
  - Low: session_search hard-failed against an older ledger. A complete list that fits now passes through unchanged.
  - Low, tests: the `fromPath` continuation in paths mode, the past-the-end notes, and a migration race test that did not race.
- **Round 2, of 2a02e98: 7 findings upheld.** All fixed in 404d7d7.
  - Medium: session_search without `limit` stopped at 100 rows. It now reads ledger pages until the bound or the end.
  - Medium: a page could exceed a client's token cap. Every size check now uses `resultSize`.
  - Low: the tools/list budget test would fail after merging vuek0. It now counts this cycle's 13 tools by name.
  - Low, tests: room_list's graph_b party filter, the parties order, latent_transfer's paths fallback, and graph_list and room_list trimming.
- **Round 3, of 404d7d7: 5 findings upheld. Three fixed, two test gaps open.**
  - Medium, fixed: a paged graph_publish result left out the derived ready actions and decisions that its description promises. The derived ID lists are now the first graph sections, so page 1 carries them. Item numbers for `graph_read` changed with this order. `tests/paging.test.mjs` pins both.
  - Low, fixed: filePage added headings of empty files without a size check until a line had been shown. Every heading is now checked, and a heading that cannot fit on an empty page fails as too large.
  - Low, fixed: a test now pins that required arguments match 19f6522 and that every paging argument is optional.
  - Low, open: no test for latent_transfer text paging across line boundaries (a dropped line would pass), and no test for the bad-`fromOffset` errors in the file continuation. The text-continuation error is tested.
  - Suites after the fixes, Windows, three runs: node 120/121 (one skipped), Playwright 13/13.

Left open:

- The two round 3 test gaps above.
- The live evals: the Codex sentinel (also with a code page and a Han page, since `resultSize` is an estimate), fresh-session discovery, and the demo rehearsal.
- Documented limits: no caller-chosen page size; an ID inside `agreedProposalIds` can move if that list spans two pages and changes in between; an old ledger whose list fits 40,000 characters but not the weighted bound gets the restart error.
- No real merge with `vuek0/subagent-graphs` has been done. Expect conflicts in `src/mcp.mjs`, and `tests/mcp.test.mjs` needs `handoff_publish` added.
- The cycle stays open until the live evals have run.

### Results — Cycle 10 live evals, 2026-11-12

Run at f53418a against a temporary ledger started from the branch, with synthetic data only. Codex is `codex-cli 0.166.0` on its default model, run through `codex exec --sandbox read-only` with only the named ledger tools enabled. Claude Code ran with Sonnet and its built-in tools off. The runner is a local script and is not committed. It sizes each page by calling the adapter over stdio, then has the agent call it.

**Live Codex sentinel: pass, 9 of 9.** Each page is one whole `session_read` result just under the bound. Three random lowercase checkpoint words sit in it: A at a third, B at two thirds, and C on the last line of text. The last line of the result is the closing fence of that turn, so C is on the line before it. Each run used new words. Codex called `session_read` once, ran no other tool, and repeated all three words exactly.

| Page | `resultSize` | Characters | Runs | A, B and C repeated | Characters Codex received | Input tokens (CLI total) |
| --- | --- | --- | --- | --- | --- | --- |
| English prose | 39,897–39,906 | 38,646 | 3 | 3 of 3 | 38,646 | 63.6k–63.8k |
| Numbered code | 39,894–39,904 | 31,732 | 3 | 3 of 3 | 31,732 | 66.7k–67.1k |
| Han script | 39,892–39,895 | 10,509 | 3 | 3 of 3 | 10,509 | 62.8k |

The middle checkpoints matter because a client can cut the middle and keep both ends. None was lost. `maxResultCharacters` stays at 40,000. `resultSize` varies by a few units between runs because the session ID in the header is hex, and its digits weigh 2 while its letters weigh 1.

**Fresh-session discovery: pass, Codex 3 of 3 and Claude Code 1 of 1.** The ledger held Leo's session and Ali's, plus three graphs in this order: an early Leo snapshot (port 4400, nothing superseding it), the reference Leo graph (4317 supersedes 4400), and Ali's graph, the newest overall. The prompt named no IDs. Every run found the latest Leo graph and answered 4317, and no run used a shell.

- Codex (3 runs, 20–41 s): `graph_list` with `{"party": "Leo", "limit": 5}`, then `graph_list` again, then `context_for` on the latest Leo graph, then `session_read` to quote lines 27 and 28 word for word.
- Claude Code (1 run, 16.5 s): `graph_list` with `{"party": "leo"}`, then `context_for` on the latest Leo graph. It cited L27–L28, and L3–L4 for the superseded 4400.
- A Claude Code run from a dry run of the script, outside the count, made the same two calls and gave the same answer.

Finding (low, agent UX, not fixed): Codex capitalised the party in its first call in all 3 runs. The adapter rejects `Leo` before any ledger request with the fixed error "party must be a party name of at most 32 lowercase letters, digits and single hyphens.", and Codex then retried and got the list. The `pattern` in the schema did not stop it. That costs one call per discovery. A fix would say "lowercase, for example `leo`" in the `party` descriptions of `graph_list` and `room_list`, or fold case before the check. Either one needs its own eval.

**Live demo rehearsal: pass.** Command: `node demo/rehearse.mjs --chatter 150 --runs 3`, the short fixture of cycle 7. Claude published Leo's graph (8 nodes, 2 edges, 51 s). Codex published Ali's (4 nodes, 2 `matches` links, 34 s), and the room opened with 2 proposals. Leo's handoff is 46,564 characters, so `session_read` now returns it in two pages, where cycle 7 returned it in one.

| Handoff arm | Runs | Score | Mean time | Mean input tokens | Cycle 7 |
| --- | --- | --- | --- | --- | --- |
| raw transcript | 3 | 18/18 | 16.9 s | 106.7k | 18/18, 11.6 s, 63.7k |
| graph briefing | 3 | 18/18 | 13.8 s | 56.1k | 18/18, 11.2 s, 53.7k |

Every run was valid, with no calls outside the allowed tool. The score matches cycle 7. The transcript arm now costs about 43k more input tokens and about 5 s more. That fits Codex reading the second page after the continuation note, instead of a single result it cut short. The rehearsal report does not record tool calls, so "pages reach Codex with their notes" rests on that token rise, not on a logged second call. The six graded facts all sit in the first 56 lines, so the score alone cannot show that page 2 was read. The graph handoff now saves about 50k input tokens per handoff on the short fixture, up from 10k.

With these three, every cycle 10 eval has run. What remains open is the two round 3 test gaps, Linux CI, and the merge with `vuek0/subagent-graphs`.

### Results — Cycle 10 round 3 test gaps, 2026-11-12

Closed in 9262239, in `tests/paging.test.mjs`.

- **latent_transfer text across page breaks.** The document has 51 escape-heavy lines in 7,994 characters, and one of them is too long for any page. It is read page by page and rebuilt by the line number in each heading. Every page must start where the previous note pointed, no line may be skipped or repeated, and the cut line must rejoin whole. A pager that resumes one line late fails with "no line is skipped or repeated at a page break".
- **Bad `fromOffset` in file continuations.** latent_read and latent_transfer with `paths` get "fromOffset is past the end of that line." for an offset at or past the end of a line, and "fromOffset needs fromLine to be a line of that file." for a line past the end. Each case reads the files once, asks no model and does not send the question. An offset one code unit before the end of a line still works.

### Cycle 10 addition — party names in any ASCII case (defined 2026-11-12, before implementation)

Source: the live discovery eval. In all 3 Codex runs, the first `graph_list` call sent `party: "Leo"` and got the lowercase error. Party names in graph packets are lowercase ASCII by schema (`^[a-z0-9]+(?:-[a-z0-9]+)*$`), so an uppercase ASCII letter in a filter can only mean its lowercase form. The MCP adapter folds ASCII A–Z in the `party` filter of `graph_list` and `room_list` and says so in their descriptions. The HTTP API stays strict.

| Eval | Expected |
| --- | --- |
| Case folded | `party` given as `Leo`, `LEO` or `lEo` returns the same result as `leo`, byte for byte, and the ledger request carries `party=leo`. Works for both tools and with a hyphen (`Ali-Bot` is `ali-bot`). |
| ASCII only | Input that is not a party name after folding A–Z still gets the fixed error and makes no request. That includes KELVIN SIGN (U+212A, which JavaScript lowercases to `k`), dotted capital I (U+0130), `a--b` and 33 characters. The error message is unchanged. |
| Unchanged elsewhere | A lowercase `party` and every other argument behave exactly as before. `GET /api/graphs?party=Leo` is still 400. The schema `pattern` accepts upper case, and tools/list stays within the cycle's +3,500-character budget. |
| Live | A fresh Codex session, with the prompt and data of the live discovery eval, makes no failed `graph_list` call and answers 4317 citing lines 27–28, in 3 of 3 runs. |

### Results — party names in any ASCII case, 2026-11-12

Implemented in 76fdade. `optionalParty` folds A–Z and then applies the old check. The `party` schema pattern of both tools accepts upper case, and each description now reads "for example leo. Party names are lowercase; A-Z is folded."

- **Case folded: pass.** With a fake ledger, `Leo`, `LEO`, `lEo`, `Ali-Bot` and 32 capital letters reach the ledger as `party=leo`, `party=ali-bot` and so on. Against the real server, `graph_list` and `room_list` return the same text, byte for byte, for `Leo`, `LEO` and `lEo` as for `leo`, and for `Ali-Bot` and `ALI-BOT` as for `ali-bot`.
- **ASCII only: pass.** KELVIN SIGN plus `eo`, U+0130 plus `van`, 33 capital letters, `Leo--Ali`, `7`, the empty string and `Leo-SECRET-9!` each get the unchanged fixed error and make no ledger request. The old bad-argument case `Leo-SECRET-9` is valid after folding, so the test now uses `Leo-SECRET-9!`.
- **Unchanged elsewhere: pass.** `GET /api/graphs?party=Leo` is still 400 with the same message. Node 123/124 (one skipped), Playwright 13/13, and the tools/list budget test passes.
- **Live: pass, Codex 3 of 3.** Same runner, prompt and data as the live discovery eval. Every first `graph_list` call sent `{"party": "leo", "limit": 1}`, so the example in the description is followed, and no `graph_list` call failed. Every run found the latest Leo graph with `context_for` and answered 4317, quoting lines 27 and 28 through `session_read`. In two runs Codex then followed `more.after` once to look at the older Leo graph. That is a normal continuation, not a retry. Claude Code (1 run) made the same single `graph_list` call and `context_for`. Codex took 19–22 s, against 20–41 s before the change.

### Review — round 4, of the round 3 gap tests and the party fold, 2026-11-12

Two independent reviews of `f53418a..76fdade` (src and tests), neither anchored on the implementation: Codex (`codex exec --sandbox read-only`) and a Claude code-reviewer subagent. No critical, high or medium findings.

- **Low, fixed in d1600d2:** no test read the advertised `party` schema pattern, so reverting it to the lowercase-only pattern would pass every test while a client that validates arguments refused `Leo` before calling. A test now checks that both tools' pattern accepts `Leo`, `LEO`, `Ali-Bot` and 32 letters, refuses `Leo--Ali`, a leading or trailing hyphen, a space, the empty string, KELVIN SIGN and U+0130, and keeps `maxLength` 32. It fails with the pattern reverted.
- Codex reviewed d1600d2 as well: no findings. It checked the schema against `optionalParty` on 4,681 generated strings.
- Suites after the fix: graph 9/9, node 124/125 (one skipped), Playwright 13/13. No raw control or format characters in `src/` or `tests/`.

The round is settled. Cycle 10 has no open review finding.

### Results — Cycle 10 implementation, 2026-11-11 (review pending)

Implemented on `ruslan/mcp-paging-discovery`. New modules: `src/paging.mjs` (the bound and the pagers) and `src/migrate.mjs` (schema version 1). New tests: `tests/paging.test.mjs` (F1 against a fake ledger), `tests/list-api.test.mjs` (F2 against the real server), `tests/migrate.test.mjs` (F3 on a version 0 file built with the 19f6522 DDL), a second round trip in `tests/mcp-live.test.mjs`, and a 150-transcript library search in Playwright.

- **F1:** every row passes. Every page at the schema limits stays at or under 40,000 characters. Merged `graph_read` and `room_read` pages deepEqual the stored JSON, against both the fake and the real ledger. Split turns, split file lines, the transfer text and `context_for` pages rejoin into the whole escaped text. Results that fit are byte-identical to the 19f6522 rendering, which a test pins for every tool. tools/list is 13 tools and 10,101 characters, 3,035 more than before.
- **F2:** every row passes except the live fresh-session discovery run, which is not run yet.
- **F3:** every row passes. The concurrency check spawns two processes on one version 0 file. The injected failure is an index name that is already taken by a table, and it leaves `user_version` 0 and the old schema. The downgrade check replays the 19f6522 DDL and its INSERT statements on a migrated file.
- **Suites (Windows):** node 114/115 (one skipped) in each of 3 runs; Playwright 13/13 in each of 3 runs. Linux CI has not run yet (nothing is pushed).
- **Not run yet:** the live Codex sentinel, the live demo rehearsal and the live fresh-session discovery. They need the user's Codex and Claude Code sessions. The independent review and the debug pass are also still to do, so the cycle stays open.
- **Spec notes:**
  - `fromOffset` and `fromLine` in a latent continuation are code-unit offsets into the file line's own text, after its `N| ` prefix.
  - A latent continuation with a `fromLine` past the end of `fromPath` gets a note and goes on with the next file.
  - The latent pager has two more fixed errors: "fromOffset is past the end of that line." and "fromOffset needs fromLine to be a line of that file.", and a text continuation of `latent_transfer` has "text must be 1 to 8000 characters."
  - Too-large errors name the tool, for example "session_read returned an item too large to show."

### Results — Cycle 10 review fixes, 2026-11-11

An independent review of 51aae9a upheld eleven findings (two of them the same room_read bug). Each fix has a test that fails on 51aae9a, except the two coverage gaps and the merge layout, which had no bug to fail on.

- **room_read numbering moved when a choice changed between pages** (medium, found twice). `agreedProposalIds` came second, so a confirm or reject between calls shifted every node, and `more.fromItem` skipped or repeated one. It is now the last section; every other section's length is fixed by the two graph snapshots. A test changes the agreed count before every page, both ways, and merges each party's nodes back exactly. Within that last section a change can still move an ID; the section is at most a few hundred IDs and usually sits on one page.
- **Data could forge the "follow the trailing note" rule** (medium) and **a client that cut the end hid that more remained** (medium). A partial text page now starts with `[Partial result: <note>]` and ends with the same note. Every text result starts with the tool's own words, so data cannot produce that first line. The instructions say a text result is partial only when its first line starts that way, and not to follow calls named anywhere else. The session_read description says 40,000 characters instead of 10,000 tokens. Not done: a token-based bound or a caller-chosen page size. Token-dense text (Han script, escapes) can still exceed a client's token limit; the live Codex sentinel should also be run with such a page.
- **A resumed line lost its number prefix** (low). The fragment now starts with `line+character| `, so file text never starts a line of the page. The paging walk checks every file line's prefix.
- **context_for paging and vuek0/subagent-graphs' handoff quota** (medium on merge). Later pages reuse the briefing that page 1 fetched in this process, so a read-through makes one `/context` request. Items after the briefing are one `after` list that counts against the bound, so the quota note fits once added there. Page 1 always fetches again.
- **Paging helpers at vuek0's insertion point** (low). The block moved between `requireHex` and `text`.
- **session_search against an older ledger** (low). A complete list that fits passes through unchanged, as on 19f6522; a list that does not fit, or a call with `after`, still gets the restart error.
- **Coverage gaps** (low): latent_transfer continuing with `paths` and `fromPath` (only `POST /api/latent/files`, no model call), and the past-the-end notes of latent_read, latent_transfer text and room_read, now have tests.
- **The concurrency test did not race** (low). The test now holds the write lock until both processes have started and read version 0. It fails every time with a plain BEGIN or no transaction ("database is locked", "duplicate column name").
- **Suites (Windows):** node 116/117 (one skipped), Playwright 13/13. tools/list is 10,118 characters.

### Results — Cycle 10 second review fixes, 2026-11-11

A second independent review, of 2a02e98, upheld seven findings. Each fix has a test that fails on 2a02e98, except the coverage gaps, which had no bug to fail on; their tests fail on the mutations the review used.

- **session_search stopped at 100 rows when the whole list fit** (medium). Without `limit`, it now reads ledger pages of 100 until the rows pass the bound or end (at most 8 requests), and `listResult` trims by size alone. With `limit` it pages by it, as before. The schema no longer says `default: 100`. The list-api test imports 150 sessions: 120 that match a second keyword fit one result and come back byte-identical to `terminalJson` of the ledger's full list, and the 150 come in a first page of more than 100 and a second page.
- **The tools/list budget test failed after merging vuek0/subagent-graphs** (low). That branch adds `handoff_publish` (1,881 characters), which took the total to about 11,999 and the count to 14, and merge-tree reports no conflict in the test. The budget now counts the cycle's 13 tools by name; a synthetic fourteenth tool does not change it. vuek0 changes no existing tool schema, so after the merge this cycle's tools are still 10,104 characters. `tests/mcp.test.mjs` pins the tool names and still needs `handoff_publish` added in that merge.
- **A page could exceed a client's token cap** (medium). 40,000 characters of numbered code is about 13,000 tokens and 40,000 Han characters about 30,000 to 40,000, so a client cut the page and the continuation pointed past what it showed. Every size check, including the backstop, now uses `resultSize` (letters and whitespace 1, other ASCII 2, other code units 4). It is never less than the length, so the stated 40,000-character bound still holds, and English pages barely change. No schema or argument changed. A test reads a 60,000-character Han session (at most 10,000 Han characters a page, all rejoined once) and a numbered code file (a first page of 20,000 to 32,000 characters). The latent answer test now has one citation per finding, so one escape-heavy finding still fits beside the warning. The weights are estimates, not a tokenizer; the live Codex sentinel should still be run with a code page and a Han page.
- **room_list party filter on the graph_b side had no test** (medium) and **parties sorted by party had no test** (low). A new list-api test publishes until an ali graph ID sorts after leo's, so leo is `graph_a`. `party: 'ali'` and `graphId` of the ali graph find the room only through the graph_b terms, and the parties list ali first. It fails without ` OR b.party = $party` and without the sort.
- **latent_transfer's paths fallback was not covered** (low). The byte-identical test now includes a `paths` transfer that falls back to files, and the paging test reads the first page of a long one: its note names latent_transfer and its arguments, and following it continues the same file. Both fail on the review's mutation (`textFallback('latent_read', ..., intro + ' X', ...)`).
- **graph_list and room_list trimming was not exercised** (low). A fake ledger serves 250 rooms with 32-character party names and 250 graphs with 120-tag titles. With `limit: 100`, each first page holds fewer than 100 rows and stays in the bound, `more.after` is the last row shown, and the walk returns every row once, in order. It fails if room_list skips `listResult`.
- **Suites (Windows):** node 119/120 (one skipped), Playwright 13/13. tools/list is 10,104 characters.

## Housekeeping H1–H5 and G10 (defined 2026-11-16, before implementation)

Source: a review of the project map (floorplan) against CI, the handoff notes and the board. One card per branch, all branched from one claim commit so their pull requests merge without touching the same lines. Each card writes its results only under its own **Results** heading below. Synthetic data only. Baseline on `main` 17ecef0 (Windows): node 139/140 (one skipped), Python runtime 131 run (24 skipped without torch). Each card closes with its evals passing, the node suite passing, a Codex read-only review, and fixes with regression tests. Playwright is run once per branch after the agents finish, because its server port is fixed.

### H1 — Runtime checks in CI (`claude/h1-runtime-ci`)

| Eval | Expected |
| --- | --- |
| Runs on every push and pull request | A CI job runs `python -m unittest discover -s tests -t .` in `runtime/` on Python 3.12 (Ubuntu, the WSL version) and 3.13 (Windows, the documented test version). No third-party Python package is installed; torch-only checks skip with a reason. |
| Same result as locally | The job's run and skipped counts match a local run of the same command on the branch. |
| A failing check fails the job | With one runtime assertion deliberately broken, the same command exits non-zero (checked locally, not committed). |
| Nothing else changes | The node and Playwright steps are unchanged. Actions are pinned to the same major versions the workflow already uses. No secrets, no network beyond checkout and setup. |

**Results — H1:** passed locally; the first hosted run is still to be read.

- **Runs on every push and pull request — passed.** The new `.github/workflows/runtime.yml` runs `python -m unittest discover -s tests -t . -v` in `runtime/` on `push` and `pull_request`, as a matrix of `ubuntu-latest` with Python 3.12 and `windows-latest` with Python 3.13 (`fail-fast: false`). It has no `pip install`, `permissions: contents: read`, no secrets, and checkout does not keep credentials. Every skipped check prints a reason. The 21 torch checks say "torch and transformers are needed for M2b" or "... for M2c". `e2e.yml` is unchanged. The workflow parses with PyYAML 6.0.1 (WSL system Python).
- **Same result as locally — passed for Linux; Windows count to confirm on the hosted run.** Windows, Python 3.13.0: 131 run, 24 skipped, OK. That is 21 torch checks plus 3 symlink checks (`test_prefix` ×2, `test_review_fixes` ×1), which skip because this user does not have the symlink privilege. WSL Ubuntu-24.04, Python 3.12.3: 131 run, 21 skipped, OK, both on `/mnt/c` and in a clean `git archive` of the branch on ext4. GitHub's Windows runners run as administrator, so the symlink checks should run there too. Expected hosted counts: 131 run, 21 skipped on both jobs.
- **A failing check fails the job — passed.** I broke one assertion in `runtime/tests/test_limits.py` line 60 for the test only, then reverted it without committing. The command exited 1 on Windows (`FAILED (failures=1, skipped=24)`) and on WSL (`FAILED (failures=1, skipped=21)`). After the revert it exited 0.
- **Nothing else changes — passed.** The new workflow uses `actions/checkout@v4`, the same major version as `e2e.yml`, and `actions/setup-python@v5`. It needs no network beyond checkout and setup-python. AGENTS.md section 4 step 3 and the pull request template checklist now list the Python command.
- **Codex read-only review:** one low finding. The Windows skip count may differ on hosted runners because they run as administrator. Accepted: the expected hosted count is recorded above, and confirming it is left open until the first CI run. No code change was needed, because the symlink checks already run and pass on Linux. No other findings.
- **Suites (Windows):** node 139/140 (one skipped). Python runtime: 131 run, 24 skipped on Windows; 131 run, 21 skipped on WSL. Playwright was not run here because its port is fixed; the change touches no browser journey.

### H2 — Docs match what is merged (`claude/h2-stale-docs`)

| Eval | Expected |
| --- | --- |
| README | The M2c line states the recorded result from `docs/m2c-latent-team.md` instead of "not recorded yet". The test counts are the counts measured on this branch, with the date. |
| Handoff | The cycle 10 steps say PR #8 was merged on 2026-11-12 with no GitHub review recorded, and that the human review of the schema migration is still owed. No other history is rewritten. |
| Runtime docstrings | `runtime/latent_pool/mappers.py` and any other docstring found stale describe what the code does today. |
| Every change has a source | Each changed statement cites, in the results, the doc, commit or `gh` output it was checked against. No new claim without one. |

**Results — H2:** all four rows pass. Each changed statement and what it was checked against:

- **README, M2c line.** "Not recorded yet" is replaced by the seed-0 figures (0.835 against `text_mas` 0.780 and `single` 0.820, 72% fewer tokens, 1.85× faster, `latent_random` 0.505), the repeat passes on seed 1 and the disjoint block, and the caveats (not better than `single`, `text_mas` held back by truncated plans). Source: `docs/m2c-latent-team.md`, "Result: the full measurement", "Second seed" and "A disjoint second sample".
- **README, tests line.** Measured on this branch on 2026-11-16: node 139/140 (one skipped), Python runtime 131 run, 24 skipped (21 need torch and transformers, 3 need symlink rights; from `-v` skip reasons). Playwright was not run here: `npx playwright test --list` lists 13 tests, and the last recorded pass is 13/13 in cycle 10 (this file, "Results — Cycle 10 second review fixes").
- **README, duplicate paragraph removed.** The negotiation-room section repeated the v1 identity paragraph, saying node order matters, which is false for the v2 graphs rooms use. Source: README "Version 2: two parties" ("Order carries no meaning in v2"); the v1 paragraph stays under "Exchange a semantic graph".
- **Handoff, cycle 10.** The header now says the branch was merged as PR #8 on 2026-11-12 (17ecef0); "is pushed as draft PR #8 ... CI passes" is now past tense; step 4 says PR #8 was merged with no review or comment recorded on GitHub and that the human review of the migration to version 1 is still owed. Source: `gh pr view 8 --json state,mergedAt,reviews,comments` (MERGED, 2026-11-12T23:13:26Z, 0 reviews, 0 comments) and `git log` (17ecef0).
- **Handoff, cycles 4 and 6.** The "not pushed" lines are kept and get a "Later:" note: cycle 4 reached `main` through PR #1, cycle 6's two branches through PR #6, both merged 2026-11-08, and PR #4 (`leo/latent-read`) was closed unmerged. Source: `gh pr view 1/4/6` (state, mergedAt, closedAt, base) and PR #6's description. Cycle 9's "PR #7 records no review" is correct (`gh pr view 7`: 0 reviews) and is unchanged.
- **`runtime/latent_pool/mappers.py` docstring.** No longer says no mapper is trained and 501 always. It says the registry backs `/latent/mappers` and `/latent/transfer`, starts empty, gets one pair from `LATENT_MAPPER` via `transfer.register_from_env`, and answers 501 for a pair not loaded. Source: `transfer.py` `register_from_env`, `server.py` `main()` and routes, `docs/m2b-transfer.md` (the trained 0.5B to 360M pair).
- **`runtime/latent_pool/transfer.py`, `register_from_env` docstring.** "Needs torch and a GPU" becomes "needs torch" plus the device order the code uses (`LATENT_MAPPER_DEVICE`, else CUDA, else CPU). Source: the function body.
- **`runtime/latent_pool/server.py` and `__init__.py` docstrings.** They now name the M2b and M2c routes the server also serves, and the `LATENT_ALLOWED_HOSTS` opt-in to the Host check. Source: `LatentServer.routes`, `Handler._allowed`, `_allowed_hosts`.
- **`docs/latent-read.md`.** The 501 row said the ledger never calls `/latent/transfer`; the ledger's `latent_transfer` calls it and falls back to text on 501 (`src/latent.mjs`, transfer handler). The `GET /latent/mappers` section no longer says no pair exists; it describes the hashed pair list and `LATENT_MAPPER` (`mappers.py` `pairs()`, `transfer.py`).
- **`docs/m2b-transfer.md`, Serving.** The request body now lists exactly one of `text` or `paths` and `maxNewTokens` (1 to 64, default 32), and the `LATENT_MAPPER` startup load. Source: `transfer.py` `FIELDS`, `document()` and `__call__`.
- **Codex review** (read-only, of `claude/housekeeping-claim...ae7ee56`): it found the changed figures and runtime descriptions match their sources and no behaviour change, and raised two findings in `docs/latent-read.md`, both fixed:
  - **Status line still credited PR #4** (medium). It now says PR #4 was a draft closed without merging and that `leo/latent-read` reached `main` through PR #6 on 2026-11-08. Source: `gh pr view 4` (CLOSED, not merged) and `gh pr view 6` (MERGED 2026-11-08, body lists `leo/latent-read`).
  - **The gate section said `latent_read` matches the closed model** (low). It now states the gate as a target and the recorded result: 14/16 to Claude Sonnet's 16/16, slice 5–9% of the prefix tokens. Source: this file, cycle 6, "Gate verdict" and "Cost".
  - These are documentation and docstring changes only, so there is no code to regression-test; the Python suite was re-run after the docstring edits.
- **Suites (Windows, this branch):** node 139/140 (one skipped), Python runtime 131 run, OK (24 skipped). Playwright not run (fixed port); 13 tests listed. No raw control or format characters in the changed files.

### H3 — Split the MCP adapter (`claude/h3-split-mcp`)

| Eval | Expected |
| --- | --- |
| Same protocol, same tools | `tools/list` output and the `initialize` result are byte-identical before and after, checked by a script or test against the output captured on `main`. |
| Same answers | Every existing node test passes unchanged, including `tests/mcp.test.mjs`, `tests/mcp-live.test.mjs`, `tests/paging.test.mjs` and `tests/list-api.test.mjs`. |
| Same entry point | `node src/mcp.mjs` still starts the adapter, so the demo rehearsal, the tests and the Claude Code and Codex settings that start it need no change. |
| Smaller files | No file of the adapter is over 400 lines. No new dependency and no build step. |
| Merge cost measured | A trial merge of this branch with `vuek0/subagent-graphs` (not committed) records the conflicting files and hunks, and the results say where each of that branch's `src/mcp.mjs` changes now belongs. |

**Results — H3:** all five rows pass, 2026-11-16 (Windows).

- **Layout.** The code moved verbatim, by line range, from the 1,086-line `src/mcp.mjs`. The only edits are `export`, a two-space dedent of each tool entry and `serve()` wrapping the stdin and stdout listeners. `src/mcp.mjs` (38 lines) is still the entry point and holds the instructions, `initialize` and the method table. `src/mcp/protocol.mjs` (111) is the stdio JSON-RPC loop. `ledger.mjs` (74) is the HTTP client, the PORT check and the cursor error. `common.mjs` (72) has the error types, argument checks and result text. `pages.mjs` (86) has partial notes, list trimming and JSON item paging, and `file-pages.mjs` (169) has file-text paging. Each tool group has one file of exported `[name, definition]` entries: `sessions.mjs` (153), `graphs.mjs` (161, which holds the context_for briefing cache), `rooms.mjs` (87) and `latent.mjs` (173). `tools.mjs` (52) builds the Map in the old order and runs tools/call with the result-size backstop. No dependency was added and there is no build step.
- **Same protocol, same tools: pass.** `tests/mcp-snapshot.mjs` prints `initialize` (2025-06-18, 2024-11-05 and an unsupported version), `tools/list`, `ping` and six fixed error replies. Its output on the claim commit 8a41b0e, captured before any change, and on this branch are both 17,365 bytes and byte-identical (`cmp`; sha256 `67799e8e…a6e14cbfa33502f`).
- **Same answers: pass.** No test file changed. `tests/mcp.test.mjs`, `mcp-live`, `paging`, `list-api` and `latent-ledger` all pass. One weak spot: the existing check in `paging.test.mjs` that the adapter never names the decisions route reads only `src/mcp.mjs`. The new `tests/mcp-layout.test.mjs` applies it to every adapter file.
- **Same entry point: pass.** `tests/mcp-client.mjs`, `demo/rehearse.mjs` and the README settings still start `node src/mcp.mjs` and needed no change. New tests check that it answers on stdout only, writes nothing to stderr and exits 0 when stdin ends. They also check that an invalid PORT still exits 1 with "Invalid PORT." before any message is answered.
- **Smaller files: pass.** The largest adapter file has 173 lines. `tests/mcp-layout.test.mjs` fails if any adapter file has more than 400 lines, imports anything but a relative module or `node:` built-in, or contains a raw control or format character. It also fails if any file other than `ledger.mjs` calls `fetch`.
- **Merge cost measured: pass.** `git merge-tree --write-tree --name-only` with `vuek0/subagent-graphs` reports the same eight conflicting files before (8a41b0e) and after (this branch): README.md, docs/delivery-board.md, docs/evals.md, docs/handoff.md, src/mcp.mjs, src/server.mjs, src/store.mjs and tests/mcp.test.mjs. Only `src/mcp.mjs` changes. Before the split it had 2 hunks (instructions: 4 against 7 lines; context_for: 21 against 4) and git merged the rest. After the split it has 2 hunks (imports: 2 against 7; body: 4 against 568). Git does not follow code into new files, so whoever merges should take this branch's `src/mcp.mjs` and re-apply that branch's changes:
  - The `instructions` text (the subagent default) goes in `src/mcp.mjs`.
  - The `launcher.mjs` import, `resetDate`, `choiceText`, `quotaStopMessage`, `startLedger`, the ECONNREFUSED retry, the `instanceof ToolError` rethrow and the 402/503 quota branch of `ledger()` go in `src/mcp/ledger.mjs`, which also needs `isObject` from `common.mjs`.
  - `quotaNote` and the quota note of `context_for` go in `src/mcp/graphs.mjs`. Since cycle 10, the note should be added to the `after` list next to `meter`, so it counts against the bound. On a later page served from the briefing cache there is no `data`, so the note applies only to pages that fetched.
  - The `node:fs`, `node:path` and `importer.mjs` imports, `currentTranscript` and the `handoff_publish` entry should go in a new `src/mcp/handoff.mjs`, which avoids conflicts (or `graphs.mjs`, which would then have about 250 lines). It needs `ToolError`, `checkArguments`, `hexId`, `maxPacketBytes` and `text` from `common.mjs`, plus `ledger`. Add `handoffPublish` to the Map in `src/mcp/tools.mjs` after `graphPublish`.
  - The `tests/mcp.test.mjs` conflict (the tool names) is the same as before the split.
- **Review.** Codex (`codex exec --sandbox read-only`) found no runtime or security regression. It checked that initialize, tools/list and ping were byte-identical against the original adapter, and that listener attachment, the invalid-PORT exit, the briefing cache, stdin buffering, escaping, closed schemas, fixed errors, the room restriction and the backstop are unchanged. It raised two findings, both fixed:
  - Medium: these results were still pending. Fixed by this entry.
  - Low: `tests/mcp-snapshot.mjs` printed on `exit`, before stdout might have drained. It now prints on `close`. That is a helper script, not a test, so there is no regression test; the comparison was rerun and is identical.
  - Codex's own node run failed 25 tests because its sandbox blocked temporary directories, so the counts below are the local run.
- **Suites (Windows):** node 143/144 (one skipped; the 4 new tests are in `tests/mcp-layout.test.mjs`). Python runtime 131 run, 24 skipped, OK. Playwright was not run here (fixed port). No `tests/e2e` spec starts the MCP adapter, so no browser journey should change.

### H4 — One source for cross-language rules (`claude/h4-shared-rules`)

| Eval | Expected |
| --- | --- |
| Secret-file rule | One data file holds the secret directories, names, prefixes and suffixes. `src/latent.mjs` and `runtime/latent_pool/prefix.py` both read it, and both give the same verdict on a shared table of at least 30 paths, run by a node test and a Python test. |
| Whitespace fold | The ledger and the runtime fold whitespace the same way on a shared table of cases (including non-ASCII spaces, tabs and line separators), run by both suites. |
| Latent grader | `evals/latent/grade.mjs` and the Python port in `runtime/tests/test_fixture_e2e.py` agree on a shared table of graded answers, run by both suites. |
| Drift fails a test | Changing any one of these rules in one language only makes a test fail (checked by hand, not committed). |
| Runtime stays stdlib | The runtime still uses only the Python standard library and still runs from `runtime/` with `LATENT_ROOT` elsewhere. Default results are unchanged. |

**Results — H4:** all five rows pass (2026-11-16, Windows, Node 22.14, Python 3.13).

- **Where the rules live.** `rules/latent-rules.json` holds the data: the secret directories, names, prefixes, suffixes and env templates, and the whitespace code points quotes fold. It is at the repository root because neither `src/` nor `runtime/` owns it, and `schemas/` holds graph JSON Schemas, a different kind of file. `src/latent.mjs` imports it with `{ type: 'json' }`; the new `runtime/latent_pool/rules.py` reads it with `json` from `Path(__file__).resolve().parents[2]`, so the working directory and `LATENT_ROOT` do not matter, and fails with "Shared rule file not found: …" when it is missing. `rules/latent-conformance.json` holds the shared cases, all non-ASCII characters as JSON escapes. `tests/latent-rules.test.mjs` (node) and `runtime/tests/test_rule_conformance.py` (Python) both run them. The node test replaces `tests/latent-space.test.mjs`, which parsed `pool.py`'s source.
- **Secret-file rule: pass.** 55 shared paths (35 secret, 20 not): case variants, nested secret directories, every name, prefix and suffix, the three templates, U+212A KELVIN SIGN in place of the k of `server.key`, and near misses (`env.txt`, `.gitignore`, `worktree/.git`, `id_ecdsa.pub`, `public.key.txt`). Current behaviour kept, including `.envrc` and `.environment` (prefix `.env`) and `keys/id_rsa.pub` refused. The node test also checks every list entry is exercised; the Python test also runs `check_path_syntax` (400, "secret files"). Both lists matched exactly before the change.
- **Whitespace fold: pass.** 20 shared strings (tab, CR LF, VT, FF, NBSP, U+1680, U+2000–U+200A, U+2028, U+2029, U+202F, U+205F, U+3000, U+FEFF, and U+001C, U+001F, U+0085, ZWSP, U+180E, ZWJ, which do not fold) through `normalizeSpace` and `fold_space`, plus `quotable_lines` in Python. The node test pins the shared list to `/\s/u` over every code point up to U+10FFFF. The two sides already agreed.
- **Latent grader: pass, after fixing a disagreement.** The Python port (moved from `runtime/tests/test_fixture_e2e.py` to `runtime/tests/grade.py`, which that test imports) matched numbers as substrings ("3" passed on "30 minutes") and ignored pattern and forbidden options. It disagreed with `grade.mjs` on 24 of the first 34 shared cases. It now follows `grade.mjs`, the shared grader in docs/latent-read.md's ownership table. 41 shared graded answers: right, wrong value, wrong citation (lines, file), boundary overlap, forbidden option, forbidden text only in a label, pattern options, and questions from `questions.json` and `fresh.json`. `fresh.json` renew-on-hold uses variable-width lookbehind, which Python's `re` cannot compile, so the port raises ValueError for it rather than grading it differently (a shared case checks that); only node grades that question.
- **Drift fails a test: pass** (each change made by hand, run, reverted, not committed): Python secret logic without the prefix rule, or with `.kube` dropped from its copy → `SecretRuleConformanceTest`; JavaScript secret name not lower-cased → node "secret-file rule decides every shared case"; JavaScript fold `/[ \t\n\r]+/gu` → node "ledger folds whitespace in every shared case"; Python fold without NBSP → `WhitespaceConformanceTest` (both tests); U+FEFF removed from the shared list → node "shared whitespace list is exactly what /\s/u matches" and the Python fold tests; Python grader with substring numbers → `GraderConformanceTest`; JavaScript grader ignoring forbidden options → node "grader decides every shared graded answer".
- **Runtime stays stdlib: pass.** New Python code imports only `json`, `pathlib`, `re`, `os`, `subprocess`, `sys`, `tempfile`, `unittest`. A Python test imports `latent_pool.prefix` in a subprocess whose working directory and `LATENT_ROOT` are a temporary directory. Default results are unchanged: no secret, whitespace or grading verdict on `main`'s existing tests changed.
- **Review.** Codex (`codex exec --sandbox read-only`) on e75a3c0: no high findings. Two medium, both fixed with shared cases that fail on e75a3c0's port: (1) `re.ASCII` differed from JavaScript's `iu` for U+017F (renewals "up to 2ſ, 14 days" graded right in Python, wrong in JavaScript); the port now drops `re.ASCII` and rewrites `\d`, `\w`, `\b`, `\B` to ASCII classes and lookarounds that Python's Unicode IGNORECASE folds as JavaScript does; (2) Python's `$` matched before a final newline; it is now `\Z`. One low (these results were still pending) is fixed by this entry. None rejected.
- **Suites:** node 143/144 (one skipped; was 139/140: −1 for `latent-space.test.mjs`, +5 new); Python runtime 140 run, 24 skipped, OK (was 131: +9 new). Playwright not run here (fixed port); no spec in `tests/e2e` mentions latent reading, and the ledger's refusal messages are unchanged.

### H5 — Server request table (`claude/h5-server-routes`)

| Eval | Expected |
| --- | --- |
| One default address | The local runtime's default address is defined once in `src/server.mjs`. `LATENT_URL` still overrides it. |
| Same responses | A probe set run before and after (every route with its right method, a wrong method, an unknown path, a foreign Host, a foreign Origin on a write, a bad ID) gives the same status and body. |
| Checks still come first | The Host and Origin checks run before any request handler, and the decisions route keeps its same-origin check. The existing node and Playwright checks pass unchanged. |
| Merge cost measured | A trial merge with `vuek0/subagent-graphs` (not committed) records the conflicting hunks in `src/server.mjs` and how to resolve them. |

**Results — H5:** all four rows pass (Windows, 2026-11-16). Playwright is not run here (fixed port); the orchestrator runs it.

- **One default address:** pass. `src/server.mjs` names `defaultLatentUrl = 'http://127.0.0.1:4320'` once, and `latentUrl()` returns `process.env.LATENT_URL ?? defaultLatentUrl`. It is still read on each request, as before (not at start). LATENT_ROOT is also still read per request. `tests/routes.test.mjs` checks both: a fake runtime on 4320 gets the team request when LATENT_URL is unset (the test skips if 4320 is taken), and a server whose LATENT_URL changes between two requests sends the second to the new address. Changing the default to 4321, or caching the URL at start, makes a test fail (checked by hand, not committed).
- **Same responses:** pass. `tests/routes.test.mjs` was committed first (2c4972b) and passed on the unchanged server. It sends 192 probes: the three static files (GET 200; POST and HEAD 404), unknown, encoded and trailing-slash paths, five foreign Hosts on a read and a write, `//x` and `*` URLs, and on each of the 7 writes a foreign Origin, the other local name's Origin, no Origin, text/plain, a declared 8 MiB + 1 body, bad JSON, bad UTF-8, and GET/PUT/DELETE/PATCH; a streamed 8 MiB + 1 body; every route with its right method; unknown, upper-case, short, long and trailing-slash IDs on the four ID routes, plus POST/PUT/DELETE on them; the decisions route's 12 cases; InputError, GraphInputError and LatentError (502 and 503) cases, and a 500. Wrong methods stay 404 (there is no 405). With `ROUTES_PROBE_OUT` set, the test writes every probe's status, headers and body (dates and port masked): the dump from the old server and the dump from the table are identical, byte for byte. The test passes unchanged on both servers.
- **Checks still come first:** pass. Host and URL checks run before the table; each write's Origin, type and size checks stay in `readJson`; the decisions entry checks `Sec-Fetch-Site: same-origin` before `readJson`. Probes pin the order (a foreign Host beats a bad URL; the decisions rule beats a foreign Origin and an unknown room). Node suite 142/143 (one skipped), was 139/140; the 3 new tests are in `tests/routes.test.mjs`. Python runtime 131 run, 24 skipped, OK. Every Playwright spec exercises this server (`npm start`): `tests/e2e/demo.spec.mjs`, `graph.spec.mjs`, `graph-v2.spec.mjs`, `handoff.spec.mjs`, `library.spec.mjs`, `room.spec.mjs`.
- **Merge cost measured:** `git merge-tree --write-tree --name-only` with `vuek0/subagent-graphs` (merge base 19f6522) conflicts in the same 8 files from this branch and from the claim commit 8a41b0e (README, board, evals, handoff, `src/mcp.mjs`, `src/server.mjs`, `src/store.mjs`, `tests/mcp.test.mjs`). In `src/server.mjs` the claim commit already has 1 hunk (the latent import line, because main added `latentFiles`); this branch has 3: the import line, the quota client next to the new table, and the dispatch chain against the table. To resolve: keep both import sets; keep `quota` after `store` and keep the table (handlers read `quota` at request time); replace that branch's chain with entries: `{ GET, path: '/api/health' }` returning `{ name, version }`, first in the table; `{ POST, path: '/api/import-file' }` after `/api/import`, with its `readJson`, provider check and `readTranscriptFile`; and in the context entry, return `{ context }` when there is no quota, else call `quota.consume()` and return `{ context, quota }` on success, or write the 402 or 503 with `json()` and return `sent`. The PID file and signal handlers outside the dispatch merge without conflict.
- **Codex review** (`codex exec --sandbox read-only`): no server behaviour change found. Findings: (medium) Results still pending — fixed by this entry. (low) the full before/after comparison is optional and not asserted — the comparison was run and is recorded above; rejected as a committed golden file, because it holds the full page, script and store output and would fail on unrelated changes by other cards. (low) no test that LATENT_URL is read per request — fixed in fe33d83 with the child-process test above. (low) the generic 500 was not probed — fixed in the same test: a forced static read failure gives 500 `Local request failed.` with the security headers.

### G10 — Published handoff benchmark, offline parts (`claude/g10-handoff-benchmark`)

| Eval | Expected |
| --- | --- |
| Stage demo untouched | `demo/` stage transcripts, prompts and reference graphs are byte-identical, so the recorded demo still matches. The benchmark uses its own synthetic fixtures. |
| More facts, some late | At least 12 graded facts, at least 4 of which appear only after the first page `session_read` returns for the long transcript, and at least 3 of which were changed or superseded during the conversation. |
| Two independent graders | A second grader built a different way from the first agrees with it on a labelled set of at least 60 synthetic answers (right, superseded, negated, missing, and right with an added false detail). Agreement and every disagreement are recorded. |
| Fairness rules | `BENCHMARKS.md` fixes the rules: same model and question for both arms, same tools, alternating arm order, one timeout, how tokens, cost and time are counted, and what counts as a pass. |
| Spend log | Each benchmark run appends one line (date, arm, model, tokens in, cached and out, cost, time, score) to a file Git ignores, and a summary command prints only aggregates. No transcript text is logged. |
| No paid runs here | Live runs with Claude Code and Codex are not part of this card; the results say how to run them. |

**Results — G10 (2026-11-16, Windows):** all six rows met offline. No live run was made. The code is in `evals/handoff/`, the rules in `BENCHMARKS.md`, the tests in `tests/handoff-bench.test.mjs`.

- **Stage demo untouched:** `git diff claude/housekeeping-claim -- demo/` is empty. Nothing in `evals/handoff/` imports `demo/`, and a test checks that.
- **More facts, some late:** a synthetic Claude Code session of 408 lines (Mira hands her context to Tomas) and 14 graded facts. 6 change during the conversation (port, launch day, database, reviewer, budget, backup interval). Through the real `session_read` tool against a test ledger, the session takes 2 pages and page 1 ends at line 278. 7 facts get their current value only after page 1, and 4 of them (feature flag, timeout, on-call person, open question) are not mentioned on page 1 at all. The test fails if the paging bound moves a late fact onto page 1. The graph arm's fixed reference graph states every current value in its `context_for` briefing.
- **Two independent graders:** grader A checks keywords like `gradeHandoff`. Grader B extracts typed values and checks them against explicit current, superseded and mentioned values. `evals/handoff/labelled.json` holds 82 single-field answers (32 right, 50 wrong), labelled by hand by the implementing agent before either grader was written. A human check of the labels is still owed. `node evals/handoff/agreement.mjs` prints the numbers, and the test pins them.
  - Grader B agrees with the labels on 79/82 (96%): 3 false accepts, 0 false rejects. Grader A agrees on 60/82 (73%): 22 false accepts, 0 false rejects. A and B agree with each other on 63/82 (77%).
  - B was 78/82 at first. One fix followed: a bare "replaced" after a value was read as "this value was replaced", so "PostgreSQL (replaced SQLite ...)" was refused. That was the only change made after seeing the labelled results.
  - Every disagreement (label / A / B): `launch-5` "Thursday at 09:00", `retry-3` "3 retries, then a 5 minute cooldown" and `flag-3` "beta_checkout, on by default" are wrong / right / right: a false claim of another type, which B does not look for. A accepts and B refuses, correctly, these wrong answers: `port-4`, `db-4`, `rev-4` (hedged); `budget-6` (negated); and `port-5`, `port-7`, `launch-6`, `db-5`, `rev-5`, `budget-5`, `region-4`, `code-4`, `retry-5`, `backup-4`, `freeze-5`, `flag-5`, `timeout-4`, `oncall-4`, `question-3` (right plus a false detail). The other 60 items grade the same under the label, A and B.
- **Fairness rules:** `BENCHMARKS.md` fixes them. Both arms use the same agent, model and question text, the same two ledger tools (`session_read` and `context_for`) and no built-in tools. A call to the other arm's tool or to any tool outside the ledger makes a run invalid. Arm order alternates by run, every call has one timeout (default 300 seconds), and each invocation starts a fresh ledger. The file says how tokens, cost and time are counted, what passes per fact and per run, and that a mean needs at least 10 valid runs per arm.
- **Spend log:** each run appends one line to `.context-ledger/benchmarks/handoff-spend.jsonl`, which Git ignores (a test runs `git check-ignore`). The line holds the date, run, arm, order, agent, model, timeout, validity flags, tokens in, cached and out, cost, time, both scores and a pass flag per fact. `--summary` prints aggregates per agent, model and arm. Fake-CLI tests check the exact fields, the alternating order, and that neither the log nor the summary holds any answer value. Failed, timed-out and cross-arm runs are logged and score 0.
- **No paid runs here:** the runner has `--dry-run` and `--fake-cli evals/handoff/fake-cli.mjs`, and the tests use only those. `BENCHMARKS.md` says how to run it live: `node evals/handoff/run.mjs --agent claude|codex --model <model> --runs 10`, then `--summary`. Live results are not recorded yet.
- **Codex review** (`codex exec --sandbox read-only`, of 9cf3895): five findings. Four were fixed, each with a regression test:
  - (medium) Grader B passed names and intervals it did not know ("Priya and Alice", "every 6 hours and every 30 minutes"). It now reads any other capitalised word as a person and knows minutes, days and weeks.
  - (medium) The open question passed when it was answered or denied ("Alice signs the vendor contract", "No vendor contract signature question remains open"). It now needs who, which or whether, refuses "is answered" and a leading "no", and refuses any name but Mira's and Tomas's.
  - (medium) A CLI that could not start aborted the benchmark and logged nothing. It is now a failed run that is logged.
  - (medium) The total cost left out paid invalid runs. The total now counts every run that reported a cost, and the mean is per valid run.
  - The new cases are regression tests, not labelled items. The labelled set stays as it was written, and its numbers did not change.
  - (low) The Results line was still pending. Fixed here. The handoff note it also asked for is left out, because this card's brief does not allow editing `docs/handoff.md`.
- **Suites:** node 151/152 (one skipped) against a baseline of 139/140; the 12 new tests all pass. Python runtime 131 run, 24 skipped, OK. Playwright was not run, because the orchestrator runs it. No browser journey changed.
- **Orchestrator check (2026-11-16):** Playwright 13/13 on this branch. On a Windows checkout with `core.autocrlf` the files are CR LF, and the hidden-character check in `tests/handoff-bench.test.mjs` counted the carriage return as hostile, so the test failed there (it passed only where the files were written with LF). The check now allows tab, newline and carriage return, as AGENTS.md section 6 does. Checked both ways: it passes with CR LF files and still fails on a vertical tab.

### H7 — Windows deadline flake (`ruslan/windows-deadline-flake`, defined 2026-11-17, before the fix)

On the Windows CI runner (Python 3.13), `DeadlineBeforeNextCallTest.test_only_the_reader_runs_and_the_read_returns_504` (`runtime/tests/test_limits.py`), and `DeadlineTest.test_model_call_timeout_is_capped_by_the_deadline` and `DeadlineTest.test_late_read_is_504_and_stops_calling_the_model` (`runtime/tests/test_review_fixes.py`, the last seen in a rerun of PR #29, run 44237430567) fail at random with `502 {'error': 'Model server timed out.'}` instead of 504. They failed PRs #29–#32, none of which touch `runtime/`. Cause: `_Run.call` passes what is left of the read deadline as the model call's timeout, then turns the timeout's 502 into a 504 only if `remaining()` is at or below 0 after the call. The socket's wait is timed by the operating system, not by `time.monotonic()`, so on Windows the socket can time out while the pool's clock still shows a little time left. (The first draft of this entry blamed a shared 15.6 ms tick; Codex pointed out that Python 3.13 on Windows reads `time.monotonic()` from `QueryPerformanceCounter`, so only the socket side is coarse.)

| Eval | Expected |
| --- | --- |
| Timeout capped by the deadline is 504 | A model call whose timeout was set by the read deadline (what was left was at or below the client's own timeout) and that times out returns 504 "The latent read ran out of time.", even when `remaining()` is still above 0 after the call. A synthetic test makes the socket time out at once with a deadline still a few milliseconds away; it fails on `main` (502) and passes with the fix. |
| Client's own timeout stays 502 | When the client's own timeout is shorter than what is left of the deadline and the call times out, the read still returns 502 "Model server timed out." |
| Other 502s unchanged | A non-timeout 502 (for example HTTP 500 from the model server) stays 502 when the deadline capped the timeout and time is left, and still becomes 504 when the deadline has passed, as before. |
| Suites | `python -m unittest discover -s tests -t .` in `runtime/` passes on Windows and in WSL; the node suite and graph checks are unchanged. The PR's `runtime (windows-latest, Python 3.13)` job is green, and rerunning the failed job on PRs #29–#32 passes. |

**Results — H7 (2026-11-17):** the first three rows pass locally. The last row's CI part is in the PR.

- **Timeout capped by the deadline is 504:** pass. `runtime/tests/test_deadline_clock.py` makes the socket time out at once with the deadline still 5 s ahead, which is a stronger case than a few milliseconds. The client's own timeout is 30 s. It checks that the read returns 504 with time still showing. Three paths are covered: the first attempt, the folded retry after a chat template refuses the system message, and a refusal that uses up the call's budget before the retry. The test also checks that the socket gets what is left of the deadline, not the client's 30 s. Against `main`'s runtime code all three cases fail with 502.
- **Client's own timeout stays 502:** pass. With a 1 s client timeout and a deadline 5 s ahead, the read returns 502 "Model server timed out.". The test passes on `main` and with the fix.
- **Other 502s unchanged:** pass. HTTP 500 with time left stays 502 "Model server returned HTTP 500.". HTTP 500 that arrives after the deadline is still 504. Both tests pass on `main` and with the fix.
- **Suites:** Windows (Python 3.13) runtime 198 run, 50 skipped, OK. WSL (Python 3.12) runtime OK. Node 191/192 (1 skipped). Graph check 9/9. The three deadline tests ran 25 times in a row on Windows with no failure. They never failed locally before the fix either, so the loop shows no regression. It does not prove the fix. The CI part of this row is recorded in the PR.
- **Codex review** (`codex exec --sandbox read-only`, of c3b3b0f): no change from 502 to 504 or back beyond the intended one, and no other caller depends on the error's class or message. Four findings:
  - (low) The tests did not check that the timeout reaches the socket, or the folded-retry path. Fixed: the tests above now record the timeout `urlopen` gets and cover both retry paths.
  - (low) The 15.6 ms `time.monotonic()` diagnosis was wrong for Python 3.13. Fixed in the cause above and in the code comment.
  - (medium, existed before this card) The timeout applies to each socket operation, so a model server that trickles its reply can hold a read and its slot past the deadline, and a reply that arrives late is accepted. Not fixed here: card H8.
  - (low, existed before this card) A connect timeout capped by the deadline is wrapped in `URLError` and returns 503 "not ready". Not fixed here: card H8.

### H8 — Model calls keep to the read deadline (`ruslan/h8-model-call-deadline`, defined 2026-11-18, before the fix)

From the H7 Codex review. `VllmClient._chat` passes the call's budget (the client's own timeout, or what is left of the read deadline when that is shorter) to `urlopen` as a socket timeout. A socket timeout limits each connect, send and receive separately, not the call as a whole. So a model server that trickles its headers or body, a few bytes at a time, keeps the call (and its pool slot) running past the deadline, and a reply that finishes after the deadline is still used. Separately, a connect that times out is wrapped in `URLError`, so it returns 503 "Model server is not ready." even when the deadline set its timeout.

| Eval | Expected |
| --- | --- |
| Trickled body stops at the deadline | A synthetic model server sends its headers at once, then the body one byte every 50 ms. The client's own timeout is 30 s and the read deadline is 1 s. The read returns 504 "The latent read ran out of time." within 2 s of starting, not after the body ends. It fails on `main` (the call runs until the body ends). |
| Trickled headers stop at the deadline | The same, with the status line and headers trickled one byte every 50 ms. 504 within 2 s. |
| A late reply is not used | A reply whose last byte arrives after the call's budget is a timeout, never a result: a direct `chat` call with a 0.5 s budget against a body trickled over about 1 s raises `ModelTimeout`. |
| Client's own timeout stays 502 | With the client's timeout at 0.5 s and the deadline 5 s away, a trickled body returns 502 "Model server timed out.", as a plain timeout does today. |
| Deadline-capped connect timeout is 504 | A connect that times out (`URLError` wrapping a socket timeout) is a `ModelTimeout`, so a read whose deadline set the timeout returns 504, not 503. A refused connection still returns 503 "Model server is not ready.". |
| Nothing else changes | Normal replies, HTTP errors (400, 413 hints, 500, 503), the folded retry and its budget, and the H7 tests behave as before. The pool releases the slot when the call ends. |
| Suites | The four suites pass; the runtime suite passes on Windows and in WSL. |

**Results — H8 (2026-11-18):**

- **How it works:** each model call has one absolute deadline, set when `chat` starts and shared by the folded retry. A timer shuts the call's socket down at the deadline, which wakes a blocked connect, TLS handshake or receive. The socket is handed over before it connects, through a connection factory that also bounds the name lookup and gives each address only the time left. Every step also checks the clock itself, so a reply that completes late is never used, even if the timer has not run yet.
- **Rows 1–5:** pass. `runtime/tests/test_whole_call_deadline.py` uses a loopback server that trickles its reply a byte at a time. Against `main`'s client the four trickle tests and the three connect-mapping tests fail; only the prompt-reply test passes.
- **Nothing else changes:** the existing runtime tests pass. Three tests changed on purpose:
  - The H7 tests in `test_deadline_clock.py` patch the new `_open` seam instead of `urlopen`.
  - The H7 refusal test now moves its fake clock when the refusal arrives, not after a fixed number of clock reads.
  - The retry-budget test in `test_server.py` is re-timed: a 0.1 s refusal, then a 0.4 s reply, in a 0.45 s budget. Its old 0.3 s refusal left only 0.15 s of margin once the budget covered the whole call, and it failed once under full-suite load. It now also checks that the retry ran, folded, with less time than the first attempt, and that it ended in `ModelTimeout`.
- **Not covered:** an opener installed with `install_opener()` is not used; the runtime installs none. A name lookup still running at the deadline is abandoned on its helper thread, not cancelled; at most four run at once. Addresses are tried one after another, as `socket.create_connection` does, so a stalled first address can use the whole budget. The re-timed retry test still runs on a real clock, with 0.35 s of margin.
- **Behaviour changes on purpose:** redirects from the model server are no longer followed; a 3xx is reported as 502 "Model server returned HTTP 3xx.". A 503 that arrives after the read deadline is now 504, like a 502. A reply that lands after the read deadline is not used.
- **Codex, round 1** (of 5686880): one high, two medium and two low findings, fixed with tests. Three of the five new tests fail against 5686880; the truncated-body and TLS tests are added coverage.
  - (high) DNS, each TCP address, a proxy's CONNECT reply and the TLS handshake ran before the socket reached the timer. The socket is now created by a factory that bounds the lookup on a helper thread, gives each address only what is left, and hands the socket over before it connects. Tests: a lookup that stalls for 3 s ends at a 0.5 s budget, and so does a TLS handshake against a server that never answers.
  - (medium) Expiry during an HTTP error body was not checked, so a deadline-capped 503 stayed 503, and a truncated error body could raise from inside the handler. The error is now closed, body-read failures are caught, and the deadline is checked after the body. Tests: a slow 503 body returns 504; a truncated 400 body returns 502 "Model server returned HTTP 400.".
  - (medium) A late reply could be used when the timer thread had not run yet. The deadline is now checked before opening, after the body and after parsing. Test: with the timer disabled, a reply that finishes after the budget raises `ModelTimeout`.
  - (low) A TLS context was built even for plain http. It is now built only for https, once, and reused. Proxies still come from the environment, as with `urlopen`.
  - (low) The re-timed retry test could pass without a retry. It now checks the second attempt directly (see above).
- **Codex, round 2** (of 1ecfb27): one high, three medium and three low findings, fixed with tests. Against 1ecfb27, seven of the new tests fail or error, including the TLS one (8.0 s instead of under 2 s).
  - (high) `wrap_socket` moves the descriptor into a new TLS socket and leaves the plain one detached, so the timer shut down a dead socket and a reply trickled over TLS ran on. The connection now wraps without the automatic handshake, hands the TLS socket to the watch, and only then handshakes with what is left. Test: a loopback TLS server (with a certificate made at test time and never committed) trickles its reply after a normal handshake; the call ends under 2 s at a 1 s budget. CPython already applies the socket timeout to the whole handshake, so a stalled handshake was bounded before; that test stays as coverage.
  - (medium) An http-to-https redirect, or an https proxy hop, could use urllib's own HTTPS handler. The watched HTTPS handler is now always installed, with the TLS context made only on first https use, and redirects are not followed. Test: a 302 returns 502 "Model server returned HTTP 302.".
  - (medium) Timed-out lookups could pile up threads, and a non-`OSError` from the resolver became an apparent timeout. A numeric host (the usual 127.0.0.1) now skips the lookup thread, at most four lookups run at once, and the outcome is handed back in a `finally`. Tests: a stalled lookup ends at the budget and its thread finishes when released; a resolver that raises `RuntimeError` returns 503.
  - (medium) The pool did not recheck its own deadline after a call, so a late success was used and a late 503 stayed 503. `_Run.call` now returns 504 for both. Tests: a reply and a 503 that land after the read deadline are both 504, and a prompt 503 stays 503.
  - (low) A failure making the socket skipped the remaining addresses. Socket creation is now inside the per-address guard. Test: an IPv6 address whose socket cannot be made is skipped and the IPv4 one is used.
  - (low) The truncated-body test did not raise `IncompleteRead`. It now uses a truncated chunked body.
  - (low) The late-reply test could pass through a socket timeout, and the DNS test slept 3 s with ambient proxies. The late-reply test now checks that the whole reply was read first; the DNS test isolates proxies and releases its lookup with an event.
  - Found while running in WSL: the late-reply test checked the server's "finished" flag before the server set it. The flag is now an event set right after the last byte, and the test waits for it.
- **Codex, round 3** (of 027fe2b): two medium findings, fixed with tests that fail against 027fe2b.
  - (medium) `SSLSocket.shutdown` drops the TLS state, so a timer firing during a TLS read or handshake could raise outside the timeout handlers. The watch now calls the plain socket's shutdown on any socket. Test: after the watch fires on a TLS socket, its TLS state is still there and the peer sees the transport close.
  - (medium) If the timer fired while a socket was still connecting, the shutdown had nothing to act on, and the socket could be handed over after the deadline. The connector now checks the deadline again after `connect()` and closes the socket. Test: a socket that connects only after the deadline raises a timeout and is closed.

## Cycle 11 — Latent runtime performance baseline (defined 2026-11-12, before measuring)

Card C11. Until now the latent runtime had accuracy evals but no performance figures. This cycle measures it on the RTX 4090 Laptop GPU (16 GB), vLLM 0.33.0 in WSL2, with the synthetic fixtures only.

### What is measured

A new harness, `evals/latent/perf.mjs`, sends the dev set (`questions.json`, 8 questions, `evals/latent/fixture`) through the ledger's `/api/latent/read`, as `run.mjs` does, and reads vLLM's Prometheus `/metrics` before and after every read. For each configuration it reports:

1. **Time to first token (TTFT):** mean, p50 and p90 over every vLLM call, from vLLM's TTFT histogram. Quantiles come from the histogram buckets, so they are bucket estimates.
2. **Prefix-cache hit rate:** vLLM's prefix-cache hits divided by queries (tokens), cross-checked against the receipts' `cachedTokens / promptTokens`.
3. **Tokens per second:** per-request decode speed (1 / mean time per output token) and the aggregate rate (generated tokens / wall time of the reads).
4. **Memory:** GPU memory used after loading and the peak during the run (`nvidia-smi`, sampled every 200 ms), the size of vLLM's KV-cache pool, the peak KV-cache use, and the KV memory per request: tokens of that request times the KV bytes per token from the model's config (layers × KV heads × head dim × 2 × bytes per value). Weights are shared by every request, so the KV cache is the per-request part.
5. **End-to-end read latency:** p50 and p90 of the ledger call, which is what an agent waits for.
6. **Accuracy:** the existing grader on the same reads (correct and cited), so a faster setting that loses answers is visible.

### Configurations

- **A.** Default: Qwen2.5-7B-Instruct-AWQ, strict citations off, files on `/mnt/c`.
- **B.** Qwen2.5-14B-Instruct-AWQ, strict citations on, max model length 8192 (the cycle 9 strict setup).
- Quick wins, each measured against A in the same session:
  - **C.** FP8 KV cache (`--kv-cache-dtype fp8`).
  - **D.** N-gram speculative decoding (prompt lookup), since cited answers copy text from the files in the prompt.
  - **E.** The fixture copied to the WSL disk, so the pool does not read through `/mnt/c`.
  - **F.** FP8 weights (`RedHatAI/Qwen2.5-7B-Instruct-FP8-dynamic`) instead of AWQ.
- For B, the 14B run is also repeated with C, because FP8 KV is the cheapest way to raise its 8192-token limit.

### Acceptance

- Unit tests (`node:test`) for the pure parts: Prometheus text parsing, counter and histogram deltas, bucket quantiles, KV bytes per token, and the report summary. They run without a GPU.
- Each configuration runs 3 rounds of the 8 dev questions (24 reads) and produces a report with every metric present, or a stated reason why vLLM does not export it.
- A quick win is recommended as a default only if it improves its target metric and loses at most one correct-and-cited answer out of 24 against A in the same session. Otherwise it is recorded and left off.
- The numbers are for one laptop GPU and one synthetic fixture; the doc says so wherever they are quoted.

## Results — Cycle 11 (latent runtime performance), 2026-11-12

Hardware and software: RTX 4090 Laptop GPU (16 GB), WSL2 Ubuntu 24.04, vLLM 0.33.0, `--gpu-memory-utilization 0.85`, prefix caching on. Each configuration ran the 8 dev questions 3 times (24 reads; a successful read makes 6 vLLM calls) through a test ledger, with `evals/latent/perf.mjs`. These figures are for one laptop GPU and one small synthetic fixture (5 files, about 1,900 tokens of prefix). They show where the time goes, not what a larger repository would cost.

How to read the table: TTFT is from vLLM's histogram, so p50 and p90 are bucket estimates. "Tokens/s per request" is 1 / mean time per output token; "aggregate" is generated tokens / summed read time. "KV MiB per read" has two figures: the sampled peak (the highest KV-cache use seen by a 200 ms poll × pool size × KV bytes per token; a shorter spike between polls can be missed) and the mean token-based upper bound (every call's prompt and completion tokens, counting the shared prefix once per call, averaged over the reads). A, A2, A3 and A4 are the same default setup run at different times in the session, to show the run-to-run spread.

| Config | Correct and cited | TTFT ms mean / p50 / p90 | Prefix-cache hits | Tokens/s per request / aggregate | Read s p50 / p90 | Cold read s | GPU MiB idle / peak | KV pool tokens | KV MiB per read: sampled peak / mean token-based upper bound | Spec. acceptance | Failed reads |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A | 18/24 | 89 / 40 / 179 | 96.7% | 88.5 / 98.6 | 5.18 / 8.19 | 11.6 | 14078 / 14410 | 137136 | 151 / 706 | — | 0 |
| A2 | 18/24 | 94 / 40 / 176 | 96.8% | 89.5 / 99.8 | 5.13 / 7.72 | 11.4 | 14078 / 14410 | 137136 | 151 / 705 | — | 0 |
| A3 | 18/24 | 132 / 39 / 180 | 96.8% | 88.8 / 97.3 | 5.23 / 7.87 | 12.4 | 14078 / 14410 | 137136 | 151 / 705 | — | 0 |
| A4 | 18/24 | 122 / 40 / 194 | 96.8% | 90.0 / 99.1 | 5.16 / 7.70 | 12.2 | 14078 / 14410 | 137136 | 151 / 705 | — | 0 |
| A-triton | 18/24 | 101 / 41 / 186 | 96.8% | 92.6 / 101.5 | 5.07 / 7.50 | 11.7 | 14074 / 14423 | 137136 | 151 / 705 | — | 0 |
| C | 0/24 | 61 / 31 / 39 | 97.8% | 121.2 / 75.4 | n/a / n/a | failed | 14074 / 14414 | 273616 | 66 / n/a | — | 24 |
| D | 18/24 | 101 / 44 / 180 | 96.8% | 105.4 / 135.5 | 3.67 / 5.22 | 9.2 | 14088 / 14420 | 135200 | 151 / 705 | 33% | 0 |
| E | 18/24 | 126 / 44 / 199 | 96.8% | 96.7 / 109.4 | 4.56 / 7.17 | 11.4 | 14078 / 14410 | 137136 | 151 / 705 | — | 0 |
| E2 | 18/24 | 97 / 44 / 176 | 96.8% | 96.7 / 109.0 | 4.59 / 7.15 | 11.7 | 14078 / 14410 | 137136 | 151 / 705 | — | 0 |
| E3 | 18/24 | 108 / 43 / 179 | 96.7% | 97.0 / 109.6 | 4.57 / 7.44 | 11.6 | 14078 / 14410 | 137136 | 151 / 706 | — | 0 |
| F | 16/24 | 102 / 55 / 212 | 95.2% | 55.9 / 62.4 | 8.55 / 11.96 | 11.8 | 13306 / 13584 | 66960 | 154 / 705 | — | 0 |
| B | 21/24 | 323 / 327 / 499 | 89.4% | 48.1 / 59.8 | 17.14 / 19.36 | 21.5 | 14144 / 14438 | 17104 | 616 / 2579 | — | 0 |
| B-C | 20/24 | 200 / 68 / 453 | 93.5% | 51.2 / 64.4 | 14.48 / 18.72 | 21.0 | 12892 / 13186 | 21168 | 303 / 1283 | — | 0 |

Configurations: A = Qwen2.5-7B-Instruct-AWQ, default settings (FLASH_ATTN). A-triton = A on the Triton attention backend. C = FP8 KV cache (Triton). D = n-gram speculative decoding, 4 draft tokens. E = the fixture on the WSL disk instead of `/mnt/c`. F = FP8 weights (`RedHatAI/Qwen2.5-7B-Instruct-FP8-dynamic`). B = Qwen2.5-14B-Instruct-AWQ with strict citations and a max model length of 8192. B-C = B with an FP8 KV cache (Triton).

### The baseline (A)

- **Time to first token:** 40 ms at p50 and 179 ms at p90; the mean of about 90–130 ms is pulled up by the calls whose prefix is not cached yet. The first read on a new prefix (cold) takes 11.6 s against about 5.6 s for the rest.
- **Prefix cache:** 96.8% of prompt tokens are served from the cache. vLLM's counters and the receipts agree to the third decimal.
- **Decode:** about 89 tokens/s per request, 98–100 tokens/s aggregate. A read waits 5.2 s at p50 and 7.7–8.2 s at p90.
- **Memory:** the 4-bit weights take 5.29 GiB, and vLLM's 85% reservation holds the GPU at 14,078 MiB (13.7 GiB) from the start; a run adds 332 MiB. The KV pool holds 137,136 tokens (7.32 GiB at 56 KiB per token). The sampled peak of one read is about 151 MiB (2% of the pool). Counting every call's tokens separately gives 706 MiB on average (731.5 MiB at most), about 4.7× the sampled peak, which is consistent with the six calls sharing the prefix blocks. The sampled peak is a lower bound on the true peak, so the 4.7× is an estimate, not a measured reduction.
- **Run-to-run spread:** across A, A2, A3 and A4, read p50 stays within 5.13–5.23 s and decode within 88.5–90.0 tokens/s.

### The quick wins

- **D, n-gram speculative decoding: recommended.** Reads drop from about 5.2 s to 3.67 s at p50 (−29%) and from 7.7–8.2 s to 5.22 s at p90. Aggregate throughput rises from about 99 to 135.5 tokens/s (+37%). Accuracy is unchanged at 18 of 24. 33% of drafted tokens are accepted. It works alongside the JSON-schema structured outputs. It is opt-in for now (`VLLM_NGRAM=1`), because the runtime defaults are Ali's to change.
- **C, FP8 KV cache: rejected for the 7B model.** The pool doubles to 273,616 tokens, but all 24 reads fail: the planner's structured replies come back with wrong content. The grammar still holds, so the JSON parses, but its content is wrong. vLLM warns that FP8 KV without scaling factors can lose accuracy, and these AWQ checkpoints carry no KV scales. vLLM 0.33 cannot compute scales at load time. The backend is not the cause: A-triton matches A. FLASH_ATTN on this GPU does not take an FP8 KV cache, and FlashInfer needs `nvcc`, so Triton is the only backend that runs it here. (C's TTFT and tokens/s come from the failing planner calls only.)
- **B-C, FP8 KV cache on the 14B strict setup: usable.** It loses one answer (20 of 24 against 21), inside the acceptance rule, and keeps 24 of 24 citations. Reads are 15% faster (14.5 s against 17.1 s at p50), with mean TTFT 200 ms against 323 ms. The capacity gain is smaller than expected: KV bytes per token halve, but vLLM gave the pool 1.94 GiB instead of 3.13 GiB, so the pool grew only from 17,104 to 21,168 tokens. That is not enough to lift the 8192-token limit much. Why vLLM sizes the pool smaller here is not yet known. It is opt-in (`VLLM_KV_FP8=1`).
- **E, files on the WSL disk: faster, cause unknown.** Three E runs gave reads of 4.56–4.59 s at p50, against 5.13–5.23 s for the four default runs, alternated in the same session. Decode was 96.7–97.0 against 88.5–90.0 tokens/s. Prompt totals agree within 0.1% and output totals within 3.1% across these seven runs, the root path is not in the prompt, and the pool reads the files once per request. So the file read itself cannot explain a faster per-token decode. The measurement is reproducible, but the mechanism is not established. Until it is, the advice is: keep `LATENT_ROOT` on the WSL disk when the files can live there.
- **F, FP8 weights: rejected.** Decode drops from about 89 to 56 tokens/s and reads take 8.55 s at p50. Two fewer answers are correct and cited (16 against 18). Single-request decode is limited by memory bandwidth, and the FP8 weights load as 8.18 GiB against 5.29 GiB for AWQ, about 1.5× the bytes read per generated token. The larger weights also halve the KV pool to 66,960 tokens.

### The 14B strict setup (B)

21 of 24 correct and cited, with every answer cited. It costs 17.1 s per read at p50 (3.3× A), 323 ms mean TTFT and 48 tokens/s decode. Its KV pool is only 17,104 tokens (3.13 GiB at 192 KiB per token) once the 9.38 GiB of weights are loaded, and one read peaks at 616 MiB, about 19% of the pool. This is why the 14B model runs with a max model length of 8192.

### Open after this cycle

- Why the files' location changes decode speed (E).
- Why the FP8 KV pool is smaller than expected on the 14B model (B-C), and whether a higher `--gpu-memory-utilization` recovers the full 2× capacity.
- FP8 KV for the 7B model would need a checkpoint with calibrated KV scales.
- vLLM 0.33 refuses GPTQ checkpoints with `desc_act=True` (the RedHat W4A16 builds of Llama 3.1 and Mistral v0.3), found while preparing cycle 12.

### Suites and review

- Node 168/169 (one skipped); `tests/perf.test.mjs` 29/29 runs without a GPU. Graph 9/9, Playwright 13/13, runtime unittest OK (24 skipped).
- The `serve-vllm.sh` switches were checked with a stub `vllm` that prints its arguments: default, `VLLM_NGRAM=1`, `VLLM_KV_FP8=1` and both.
- **Harness reviews:** the harness was built by a Claude subagent, then reviewed by Codex and a separate Claude reviewer. They raised nine findings: mid-run restarts, failed scrapes, failed reads in latency, a lost in-flight KV sample, an unchecked `--kv-dtype`, the TPOT fallback, a correct-and-cited count and missing tests. All nine are fixed with tests in de4e060. The speculative-decoding counters were added in c224f74.
- **PR review:** a second Codex pass covered the whole PR, including a data check that recomputed every figure in this section from the raw reports and vLLM logs. It confirmed the main comparisons: D is 29.2% faster at p50 with 37.3% more throughput and 32.6% of drafts accepted; B-C is 15.5% faster; B is 3.31× A. It raised eight findings, all fixed in b451511, each code fix with a test. A confirming pass found one more low: a `--repeat` of 309 nines overflowed to Infinity. It is fixed with a safe-integer check and a test. The eight were:
  - An explicit `--model` that vLLM does not serve is now refused.
  - `nvidia-smi` samples one GPU (`--gpu`).
  - `--repeat` must be a positive whole number.
  - Five wording fixes: the sampled peak, MiB units, the mean upper bound, six calls per successful read, and the 3.1% output spread.

## Cycle 12 — Multi-LLM latent runtime (defined 2026-11-12, before measuring)

Card C12. Until now every latent measurement used Qwen, and the latent team (M2c) refused any chat template that was not ChatML. This cycle checks which parts work with other open model families and makes the latent team work with them.

### What changes

- **M2a pool:** no code change is expected. It talks to vLLM's OpenAI-compatible API, so any model vLLM can serve with a chat template should work. This cycle measures that instead of assuming it.
- **M2c latent team:** the turn texts (the open turn a later agent writes and the text that closes a turn) are derived from the tokenizer's own chat template by rendering small conversations and taking string differences, in `runtime/latent_team/chat_turns.py`. The ChatML strings stay byte-identical, so earlier M2c results stay comparable. A template the derivation cannot handle is refused with an error naming the model. The stop tokens come from the tokenizer and generation config plus the derived close token, instead of a fixed list.
- **M2b transfer:** unchanged. A mapper is trained for one sender and receiver pair, so another pair needs its own training run. This is recorded, not built.

### Models

All are public, with no license gate and no custom code, loaded from their safetensors only:

- Qwen2.5-7B-Instruct-AWQ: the reference.
- Llama 3.1 8B Instruct, AWQ INT4 (`hugging-quants/Meta-Llama-3.1-8B-Instruct-AWQ-INT4`, Llama 3.1 Community License).
- Mistral 7B Instruct v0.3, GPTQ 4-bit (`RedHatAI/Mistral-7B-Instruct-v0.3-GPTQ-4bit`, Apache-2.0).
- Granite 3.1 8B Instruct, W4A16 (`RedHatAI/granite-3.1-8b-instruct-quantized.w4a16`, Apache-2.0).
- For M2c, which runs unquantized in transformers: Phi-3.5-mini-instruct (MIT). It is not ChatML, and it has separate input and output embeddings, so it also covers the untied case that cycle 9 left open.
- vLLM 0.33.0 refuses GPTQ checkpoints with `desc_act=True` (the RedHat W4A16 builds of Llama 3.1 and Mistral v0.3), which is why the AWQ and `desc_act=False` builds are used.

### Acceptance

- Unit tests without a GPU or network: for each of seven template families (Qwen2.5, SmolLM2, Phi-3.5, Llama 3.1, Mistral v0.3, Granite 3.1, OLMo-2), the first turn, a later turn with no system block, and the close turn. ChatML must stay byte-identical. A regression test fails on the a8808ad bug for templates that inject a default system block.
- A check on the real cached tokenizers derives the turns for Qwen2.5, SmolLM2, Phi-3.5, Llama 3.1, Mistral v0.3 and Granite 3.1.
- **M2a live:** each model runs the dev and held-out sets, 3 rounds each, through the unchanged pool, with the cycle 11 harness on the dev set. The result per family is its accuracy and citations next to the Qwen reference, plus its performance figures. A family "works" when every read returns a graph (no runtime errors). Its accuracy is reported, not gated, because these are untuned models.
- **M2c live:** `latent_team.evaluate` on Phi-3.5-mini with the same protocol as cycle 9 (single, text_mas, latent_mas and the random control), on a disjoint block. It "works" when every system runs end to end and the random control scores below latent_mas. Whether latent_mas beats single is reported, not required.

## Results — Cycle 12 (multi-LLM latent runtime), 2026-11-12

Same machine and harness as cycle 11: RTX 4090 Laptop GPU, vLLM 0.33.0, default settings, strict citations off. Each model ran the dev set 3 times with `perf.mjs` and the held-out set 3 times with `run.mjs`, through the same pool code. The held-out gate is the M2a one: accuracy and citations each at least 7 of 8, plus the slice and cache shares.

### M2a pool across four families

| Model | Dev: correct and cited (24) | Held-out: correct and cited per round (8) | Held-out passes the gate | Read s p50 (dev) | TTFT ms p50 / p90 | Tokens/s per request | Prefix-cache hits | KV KiB per token | KV pool tokens | Failed reads |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Qwen2.5-7B AWQ | 18 | 7, 7, 7 | 3 of 3 | 4.89 | 40 / 186 | 90.8 | 96.8% | 56 | 137136 | 0 |
| Llama 3.1 8B AWQ | 12 | 6, 6, 6 | 0 of 3 | 8.62 | 38 / 189 | 84.9 | 96.3% | 128 | 59760 | 0 |
| Mistral 7B v0.3 GPTQ (folded system) | 24 | 5, 4, 4 | 0 of 3 | 7.93 | 38 / 193 | 93.6 | 96.8% | 128 | 73232 | 0 |
| Granite 3.1 8B W4A16 | 21 | 7, 7, 7 | 3 of 3 | 11.06 | 47 / 243 | 79.7 | 95.4% | 160 | 53648 | 0 |

- **Every family works.** After one fix, none of the 4 × 48 reads failed. Accuracy is reported, not gated, because these models are untuned.
- **Mistral needed the one code change.** On the first run all 24 Mistral reads failed with 502: its chat template refuses a system message ("Conversation roles must alternate"), and the pool sends the shared prefix as a system message. `VllmClient` now retries such a refusal once with the system text opening the user message, and keeps folding for later calls. vLLM logged exactly one refusal in the rerun. The system text is still the start of every prompt, so the prefix cache hit 96.8%, as with Qwen. Of the four families, Mistral scores best on the dev set (24 of 24) but cites least on the held-out set (5 of 8 in every round), so it fails that gate on citations.
- **Granite 3.1 does at least as well as Qwen:** on the dev set it is 24 of 24 correct (21 also cited) against Qwen's 21 of 24 (18 cited). On the held-out set the two are equal at 7 of 8 with every answer cited, passing the gate in all three rounds. It is the slowest at 11.1 s per read.
- **Llama 3.1 is the weakest here:** 12 of 24 on the dev set and 6 of 8 on the held-out set. It cites every held-out answer but gets two wrong.
- **Cost differs mostly through the KV cache.** Qwen2.5-7B stores 56 KiB of KV per token (4 KV heads); Llama 3.1 and Mistral store 128 KiB (8 KV heads, 32 layers) and Granite 160 KiB (40 layers). So with the same 85% reservation the pool holds 137,136 tokens for Qwen but 53,648–73,232 for the others. That still fits 1.6–2.2 full 32,768-token requests.
- **Per-token decode speed is similar** (80–94 tokens/s), because all four are 4-bit models of 7–8B parameters. The other families take longer per read (7.9–11.1 s against 4.9 s) mainly because they write more: 898 (Llama), 941 (Mistral) and 1,278 (Granite) output tokens per read against 563 for Qwen. They also make slightly more retry calls (6.1–6.25 calls per read against 6.0).
- **Two checkpoints vLLM 0.33 cannot load:** the RedHat W4A16 builds of Llama 3.1 8B and Mistral 7B v0.3 use GPTQ `desc_act=True`, which vLLM 0.33 refuses ("GPTQ group activation ordering ... is no longer supported"). The AWQ build of Llama and the `desc_act=False` GPTQ build of Mistral load.

### Latent team (M2c) chat templates

- The derivation gives the right turn texts for all six real tokenizers in the local cache, checked on the CPU in WSL:
  - Qwen2.5 and SmolLM2 keep the exact ChatML strings.
  - Phi-3.5 closes a turn with `<|end|>\n`, Llama 3.1 with `<|eot_id|>`, Mistral v0.3 with `</s>`, and Granite 3.1 with `<|end_of_text|>\n`.
  - Each later turn carries no system block, and each stop set includes the close token: Phi `[32000, 32001, 32007]`, Llama `[128001, 128008, 128009]`.
- The template unit tests cover seven families (adding OLMo-2) and run without a GPU or network; they skip cleanly where `jinja2` is missing.
- **Reviews:** Codex and a separate Claude reviewer found two issues, both fixed in 43b6120 with regression tests:
  - A template that only contained `<|im_start|>` was handed the ChatML strings unchecked. Every template is now derived, and ChatML is used only when the derived strings equal it.
  - The assistant lead (Mistral's leading space) is now derived and recorded.

### Latent team (M2c) on Phi-3.5-mini

`latent_team.evaluate --model microsoft/Phi-3.5-mini-instruct --steps 40 --count 200 --batch 4 --seed 0 --block 2`. Block 2 shares no question with the cycle 9 samples (blocks 0 and 1). The setup is bf16 in transformers; `nvidia-smi` read 13,906 MiB in use during latent_mas.

| System | Accuracy (200) | Mean tokens | Latent vectors | Seconds per question |
| --- | --- | --- | --- | --- |
| single | 0.855 | 268.5 | 0 | 3.78 |
| text_mas | 0.870 | 852.5 | 0 | 11.02 |
| latent_mas@40 (soft) | 0.840 | 235.9 | 120 | 5.04 |
| latent_random@40 (control) | 0.830 | 232.6 | 120 | 5.07 |

- **The machinery works on a model that is not ChatML and has untied embeddings.** Every system ran all 200 questions end to end, with the turn texts derived from Phi's own template: `<|user|>\n` … `<|end|>\n<|assistant|>\n`, closed by `<|end|>\n`, with stop ids 32000, 32001 and 32007.
- **The latent thoughts carry no measurable signal on Phi.** The random control scores 0.830 against 0.840 for latent_mas. Over 200 paired questions, latent_mas alone is right on 13 and the control alone on 11 (exact McNemar p = 0.84). On Qwen2.5-3B in cycle 9 the control fell to 0.475. The written acceptance rule ("the random control scores below latent_mas") is met numerically, but a 1-point gap on 2 questions is not evidence. That rule was too weak, and the result is recorded as **not established on Phi**.
- **Against single and text_mas, no difference is significant** either: latent_mas vs single p = 0.65, latent_mas vs text_mas p = 0.33, text_mas vs single p = 0.70.
- On cost, latent_mas still keeps its shape: 72% fewer tokens than text_mas and 2.2× faster.
- **Cycle 9 gate:** latent_mas fails it on accuracy. It is 3 points below text_mas, beyond the allowed 2, with a 95% paired interval of −0.08 to +0.02. It passes on tokens and speed.
- Only the `soft` thought mode was run, which mixes real token embeddings. The `aligned` mode, the one that uses the untied W_a, was not run on Phi.
- **Batch size:** batch 8 spills past the laptop's 16 GB: latent_mas took 20.9 s per question on the 8-question smoke run against 4.6 s at batch 4. Phi-3.5-mini has 32 KV heads (no grouped-query attention), so its KV cache costs 384 KiB per token.

What this means: the multi-LLM part is done; any chat template now runs. Whether latent thinking helps is a property of the model. It showed on Qwen2.5-3B (cycle 9) but not on Phi-3.5-mini. A next run should try the `aligned` mode on an untied model and a second non-Qwen family before any claim that latent thinking transfers across families.

### Suites and review

- Node 168/169 (one skipped), graph 9/9, Playwright 13/13.
- Runtime unittest: 154 OK on Windows (26 skipped for torch and jinja2), and 154 OK in WSL on CPU with none skipped.
- **Reviews of the chat-template derivation:** Codex and a separate Claude reviewer found two issues, both fixed in 43b6120 (above).
- **Reviews of the system-message fold (104c41e):** Codex found that the retry got the full timeout again, so a slow refusal could hold a pool slot past the deadline (medium), and that the receipt time left out the refused attempt (low). Both are fixed in b88a914 with tests against a scripted server with delayed replies; both tests fail on 104c41e. Codex's confirming pass found nothing.
- **PR review (#10):** a Codex pass over the whole PR, with a data check of every figure against the raw reports, recomputed the Phi McNemar counts and p-values and found them correct. It raised two findings, both fixed: the Granite accuracy comparison understated its dev-set lead (wording), and the real-tokenizer test left out Phi-3.5 and Granite (both now included; the test passes in WSL).
- Codex noted that the fake vLLM's cache accounting does not prove real cache reuse. The live Mistral run does: vLLM's own counters show 96.8% prefix-cache hits with the folded prompts.

## Cycle 13 — Tuning the latent hand-off (defined 2026-11-12, before any run)

Card C13. In cycle 12 the latent team ran on Phi-3.5-mini, but its latent thoughts scored no better than random vectors (0.840 against 0.830, McNemar p = 0.84). This cycle tries three ways to make the hand-off between agents carry information, from cheapest to most expensive, on the same model:

1. **Settings, no training:** thought mode (`soft`, and `aligned`, which uses the untied W_a and was never run on Phi), latent steps (10, 40, 80), and soft-thought sharpness (top-k 16 at temperature 1.0, against top-k 4 at 0.5).
2. **A trained projection adapter:** the model stays frozen. A low-rank correction is added to the thought vector, zero-initialised so training starts from today's behaviour. It is trained on the solver's answer loss, back through the latent steps.
3. **LoRA fine-tuning:** low-rank adapters on the attention projections, trained with the same loss through the same latent loop, so the model learns to read latent memory.

### Data and splits

- Training (levels 2 and 3) uses only the GSM8K train split. The target is the gold solution, ending "The answer is N."
- Settings and training choices are tuned on GSM8K test block 3 of the seed-0 shuffle (questions 600–799; 100 questions while tuning).
- Every claim is made on block 4 (questions 800–999, 200 questions), which is not looked at until the choices are fixed.
- Blocks 0, 1 and 2 were used by cycles 9 and 12 and are not reused.

### What counts

- The question is whether the thoughts carry information. The primary test is **latent_mas against latent_random with the same weights, steps and thought norm**, on the same 200 block-4 questions, with an exact McNemar test.
- A level "works" only if latent_mas beats the random control with p < 0.05.
- Secondary figures, reported but not gated: latent_mas against single and against text_mas, tokens, and seconds per question.
- For level 3 the controls must use the **same LoRA weights**. Fine-tuning on GSM8K will lift every system, so a higher score alone proves nothing; only the gap to the random control with the same weights counts.
- A level that does not reach p < 0.05 is reported as not established, with its numbers. This rule is fixed here, before any result, because cycle 12's "below the control" rule was too weak.

### Acceptance for the code

- Unit tests run on the CPU with a tiny randomly initialised model, with no download and no GPU:
  - the adapter starts as an exact no-op;
  - LoRA starts as an exact no-op, and only the LoRA and adapter weights receive gradients;
  - the loss covers only the target tokens;
  - a saved checkpoint reloads to identical outputs.
- No new runtime dependency: LoRA is written in a small module rather than added with `peft`.

### Level 1 results (tuning questions, 2026-11-13)

Phi-3.5-mini, bf16, batch 4, tuning questions 600–699 (block 6 of 100 in the seed-0 shuffle, inside tuning block 3). These are tuning figures, not claims.

| System | m = 10 | m = 40 | m = 80 |
|---|---|---|---|
| single | 0.86 | | |
| soft (top-k 16, T 1.0) | 0.86 | 0.89 | 0.86 |
| aligned (W_a) | 0.13 | 0.15 | 0.23 |
| random control | 0.88 | 0.88 | 0.84 |
| soft, sharp (top-k 4, T 0.5) | | 0.93 | |
| random control, same run | | 0.89 | |

Exact McNemar test against the random control at the same steps (questions only the thought mode got right / only random got right):

| Comparison | Split | p |
|---|---|---|
| soft @10 | 2 / 4 | 0.69 |
| soft @40 | 3 / 2 | 1.00 |
| soft @80 | 7 / 5 | 0.77 |
| soft, sharp @40 | 6 / 2 | 0.29 |
| aligned @10, @40, @80 | 1 / 76, 1 / 74, 2 / 63 | < 0.001 (worse than random) |

- No setting beats the random control. The sharp soft setting is the best on these questions, but it is not significant.
- Aligned thoughts break Phi-3.5-mini's answers. The untied W_a ridge map gives vectors the model cannot read.
- Decision, made before training: levels 2 and 3 train soft thoughts only. Aligned is dropped from the trainer (Codex review of 334ce35: the random control is noise at the soft norm, so a trained aligned run would not be norm-matched to it).
- Training runs at m = 10 for memory: the backward pass keeps every latent step's keys and values. Trained checkpoints are evaluated at m = 10 and m = 40.

Smoke runs on 16 train questions at m = 10, with all three subagents keeping gradients:

| Level | Trainable weights | Seconds per example | Peak memory |
|---|---|---|---|
| 2, adapter rank 16 | 98,304 | 3.6 | 12.1 GB |
| 3, LoRA rank 16 on `qkv_proj` and `o_proj` | 9,437,184 | 5.6 | 13.3 GB |

Runs queued: level 2 on 1,000 train questions (lr 1e-3, accumulation 8), then level 3 on 2,000 (lr 2e-4, alpha 32, accumulation 8), one epoch each. Each is evaluated on the same 100 tuning questions before block 4 is opened.

### Levels 2 and 3 results (tuning questions, 2026-11-13)

**Memory.** The first full runs stopped with "CUDA driver error: out of memory" within minutes. Phi-3.5-mini has no grouped-query attention, so every latent step keeps a full key and value copy for the backward pass, and the cost grows with the prompt. Peak memory by example length, measured on the train split (prompt p50 / p90 / max 93 / 130 / 259 tokens):

| Subagents keeping gradients | Median | p90 | p99 | Longest |
|---|---|---|---|---|
| 3 | 12.72 GB | 14.36 GB | 14.42 GB | out of memory |
| 2 | 11.67 GB | 13.05 GB | 13.15 GB | out of memory |
| 1 | 10.11 GB | 11.05 GB | 11.22 GB | 13.88 GB |

The runs use two subagents with gradients (the first runs without; all three still run) and skip prompts over 160 tokens (`--max-prompt-tokens`, 8bfbf51). The worst kept case, a 160-token prompt with a 256-token target, peaks at 13.55 GB. These runs counted the prompt text without the chat-template tokens. Codex's review of 8bfbf51 found that mismatch, and the cap now counts each turn as rendered, so the same `--max-prompt-tokens 160` keeps somewhat fewer questions than these runs did.

| Run | Examples kept | Skipped (prompt / target) | Steps | Final logged loss | Peak memory | Hours |
|---|---|---|---|---|---|---|
| Level 2, adapter rank 16, lr 1e-3 | 947 of 1,000 | 49 / 4 | 119 | 0.835 → 0.645 | 12.25 GB | 0.77 |
| Level 3, LoRA rank 16, alpha 32, lr 2e-4 | 1,893 of 2,000 | 94 / 13 | 237 | 0.626 → 0.424 | 13.46 GB | 2.04 |

Tuning questions 600–699, same weights for every system in a run:

| Run | single | soft @10 | random @10 | soft @40 | random @40 |
|---|---|---|---|---|---|
| Level 2 adapter | 0.86 | 0.83 | 0.88 | 0.85 | 0.84 |
| Level 3 LoRA | 0.79 | 0.80 | 0.81 | 0.77 | 0.79 |

| Comparison | Split | p |
|---|---|---|
| Level 2 soft @10 vs random | 2 / 7 | 0.18 |
| Level 2 soft @40 vs random | 6 / 5 | 1.00 |
| Level 3 soft @10 vs random | 4 / 5 | 1.00 |
| Level 3 soft @40 vs random | 2 / 4 | 0.69 |

- Neither trained level beats the random control on the tuning questions.
- The LoRA lowers single from 0.86 to 0.79 and shortens answers from 263 to 90 tokens: it learned the terse GSM8K solution style, which costs Phi-3.5-mini accuracy. Every system in that run carries the same LoRA, so the comparison with random is still fair.
- The adapter roughly halves the answer length of soft thoughts at m = 10 (107 tokens against 226 for random). Accuracy is 5 points lower (0.83 against 0.88, split 2 / 7, p = 0.18), a difference that is not significant.

### Block 4 choices (fixed 2026-11-13, before block 4 is run)

One setting per level, each the best gap to random on the tuning questions:

| Level | Setting | Systems |
|---|---|---|
| 1 | soft, top-k 4, T 0.5, m = 40, no training | single, text_mas, latent_mas, latent_random |
| 2 | adapter (l2-adapter), m = 40 | single, latent_mas, latent_random |
| 3 | LoRA (l3-lora), m = 10 | single, latent_mas, latent_random |

Block 4 is questions 800–999 of the seed-0 shuffle (`--count 200 --block 4`), batch 4. Each level is judged by its own McNemar test against random at p < 0.05. Three tests are run, so a single p just under 0.05 is read with that in mind.

### Block 4 results (2026-11-13)

Phi-3.5-mini, bf16, batch 4, questions 800–999 of the seed-0 shuffle (200 questions), the settings fixed above. Every system in a run uses the same weights.

| Level | single | latent_mas | latent_random | Split (latent only / random only) | McNemar p | Verdict |
|---|---|---|---|---|---|---|
| 1, sharp soft (top-k 4, T 0.5), m = 40 | 0.855 | 0.845 | 0.845 | 7 / 7 | 1.00 | not established |
| 2, adapter, m = 40 | 0.855 | 0.815 | 0.840 | 10 / 15 | 0.42 | not established |
| 3, LoRA, m = 10 | 0.730 | 0.750 | 0.775 | 4 / 9 | 0.27 | not established |

Secondary figures:

| Run | System | Mean tokens | Seconds per question |
|---|---|---|---|
| Level 1 | single | 279.6 | 3.80 |
| Level 1 | text_mas (0.825; 72% of agent turns hit the token cap) | 850.9 | 11.00 |
| Level 1 | latent_mas @40 | 254.3 | 4.97 |
| Level 1 | latent_random @40 | 239.1 | 4.76 |
| Level 2 | latent_mas @40 | 140.4 | 4.02 |
| Level 2 | latent_random @40 | 244.1 | 5.12 |
| Level 3 | single | 102.2 | 1.78 |
| Level 3 | latent_mas @10 | 99.5 | 2.39 |
| Level 3 | latent_random @10 | 102.7 | 2.49 |

- **No level shows that the latent thoughts beat random vectors on Phi-3.5-mini.** Under the rule fixed before any result, all three are reported as not established. This is a failure to show an advantage at this sample size, not proof that the thoughts carry nothing.
- **Level 1:** the sharp setting that scored 0.93 on the tuning questions ties random exactly on block 4. Its tuning lead (6 / 2) did not replicate (7 / 7, p = 1.00).
- **Level 1 gate:** latent_mas passes the M2c gate against text_mas (0.845 against 0.825, interval −0.03 to +0.07, 70% fewer tokens, 55% less time). Random vectors pass the same gate (0.845, 239 tokens), so the gate measures the cheaper pipeline, not the thoughts.
- **Level 2:** the adapter makes the solver write much shorter answers (140 tokens against 244 for random), and accuracy is 2.5 points lower (not significant). It changes the answers, but shows no accuracy advantage over random.
- **Level 3:** LoRA lowers every system: single falls from 0.855 to 0.730, and answers shorten from 280 to 102 tokens. A likely cause is the short style of GSM8K's gold solutions, but this run does not isolate it. The latent team does not recover the loss: it is 2.5 points below random with the same weights (not significant).
- **A hypothesis for a next cycle (untested):** with the gold solution as the target, a change of answer style can lower the loss without any help from the hand-off. Training against the model's own correct answers (self-distillation) would keep the target close to the model's own style, leaving less to gain that way. It would not rule out other shortcuts. A next attempt should also train at the evaluation step count; these runs trained at m = 10 for memory.
- **Review:** a Codex data check recomputed every figure in the level 2 and 3 and block 4 sections from the raw reports and training logs, and all of them match. It found one wrong statement ("without changing accuracy" hid a 5-point drop on the tuning questions) and five conclusions that claimed more than the tests show. All six are reworded above. The prompt-length and memory profile figures came from profiling runs whose output was printed, not saved, so they could not be rechecked.

## Cycle 14 — Self-distilled targets for the LoRA hand-off (defined 2026-11-13, before any run)

Card C14. In cycle 13, LoRA trained on GSM8K's gold solutions lowered every system on Phi-3.5-mini: single fell from 0.855 to 0.730 and answers shortened from 280 to 102 tokens. The latent team was not better than random vectors with the same weights (0.750 against 0.775, p = 0.27). The likely cause is that the loss could fall by copying the short gold style, with no help from the hand-off. This cycle changes only the training target. It becomes the model's own correct answer (self-distillation), which is already in the model's style.

### Method

- `latent_team.distill` runs the untrained model as the single system: greedy decoding, the single prompt, at most 512 new tokens. It covers the same 2,000 GSM8K **train** questions that `train.py` takes (seed 0).
- An answer becomes a target only if its number is right and it stopped before the 512-token budget. Every other question is skipped (`noTarget`). The gold solution is never used to fill a gap.
- `latent_team.train --targets` trains LoRA on these answers, each followed by the chat template's close. The other settings are those of cycle 13 level 3:
  - m = 10 latent steps while training;
  - rank 16, alpha 32, learning rate 2e-4;
  - gradient accumulation 8, gradients through the last 2 subagents;
  - one epoch;
  - prompt cap 160 tokens, now counted with the chat template.
- The target-length cap is the one setting that has to change, because the model's own answers are longer than the gold ones. It is chosen from the distilled answer lengths and a short memory check on the 16 GB GPU, before training starts, and recorded here before any evaluation.
- The output file holds GSM8K train questions and the model's answers. It stays with the run outputs and is not committed.

### Targets and the length cap (fixed 2026-11-13, before training)

- **Answers:** distillation answered 2,000 train questions; 1,833 are right, and 1,832 of those stopped inside 512 tokens (91.6%).
- **Length:** the kept answers are much longer than the gold solutions (cycle 13's gold-trained answers averaged 102 tokens): 261 generated tokens on average (median 250, 95th percentile 402, longest 509).
- **Memory:** peak GPU memory for one training example (m = 10, gradients through 2 subagents) at the longest target under each cap:

  | Cap (target tokens) | Examples kept | Peak memory (GB) |
  |---|---|---|
  | 320 | 1,403 | 12.52 |
  | 384 | 1,623 | 13.87 |
  | 448 | 1,711 | 13.93 |
  | 512 | 1,734 | 14.08 |

- **Cap chosen: 512.** It keeps every self target. A lower cap would drop the longest answers, which are mostly the harder questions, so the training set would lean toward easy ones.
- **What the run trains on:** 1,734 examples. 168 questions have no kept self answer, and 98 are over the 160-token prompt cap.
- **Memory setting:** the run uses `PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True` to limit fragmentation over the two-hour run.
- **Training run:** one epoch, 217 optimizer steps over 1,734 examples in 103 minutes. Mean loss 0.042 (0.085 over the first 25 steps, 0.031 by step 200). Peak memory 14.25 GB, with no out-of-memory failure.

### Data and splits

- Training uses the GSM8K train split only.
- Tuning: questions 600–699 of the seed-0 test shuffle (`--count 100 --block 6`), the same tuning questions as cycle 13. Systems: single, latent_mas and latent_random at m = 10 and m = 40. The step count with the larger gap to random is chosen.
- Confirmation: **block 5** (`--count 200 --block 5`, questions 1000–1199), which no cycle has used. Cycle 13 already looked at block 4, so it is not reused for a claim. Systems: single, latent_mas and latent_random at the chosen m, all with the self-distilled LoRA. The untrained model's single system is also run on block 5 as the baseline for the style check.

### Tuning result and the chosen step count (fixed 2026-11-13, before block 5)

All systems use the self-distilled LoRA on the 100 block-6 questions:

| System | m = 10 | m = 40 |
|---|---|---|
| single | 0.90 (258 tokens) | — |
| latent_mas | 0.88 | 0.90 |
| latent_random | 0.89 | 0.90 |
| latent_mas − random | −1 point | 0 points |

- **Chosen: m = 40**, by the rule above (the larger gap to random). Neither gap is a real lead. At m = 10 the team is one question behind random; at m = 40 they tie. So the tuning gives no sign that the thoughts help, and block 5 decides.
- **Style:** single with the LoRA scored 0.90 with 258-token answers. In cycle 13 the gold-trained LoRA gave 102-token answers, so the style shortcut looks gone. This is only a tuning read; the style prediction is scored on block 5.

### What counts

- **Primary:** latent_mas against latent_random with the same LoRA weights, steps and thought norm, on the 200 block-5 questions, with an exact McNemar test. The hand-off "works" only if latent_mas beats random with p < 0.05. Otherwise it is reported as not established, with its numbers.
- **Secondary, predicted before the run:** if self-distillation removes the style shortcut, single with the self-distilled LoRA stays within 3 points of the untrained single on block 5, and its mean answer length stays within 25% of the untrained length. Reported, not gated. Passing it only shows that the style damage is gone. It does not show that the thoughts carry information.
- Training on answers the model already gets right can still leave the thoughts with nothing to add. If so, the primary test fails, and that is a result.

### Block 5 results (2026-11-13)

Phi-3.5-mini, bf16, batch 4, questions 1000–1199 of the seed-0 shuffle (200 questions), m = 40 as fixed above. The first three rows share the self-distilled LoRA; the last is the untrained model.

| System | Accuracy | Mean tokens | Seconds per question |
|---|---|---|---|
| single, LoRA | 0.870 | 273.9 | 4.32 |
| latent_mas @40, LoRA | 0.870 | 275.1 | 6.28 |
| latent_random @40, LoRA | 0.860 | 272.1 | 6.39 |
| single, untrained | 0.870 | 274.5 | 3.90 |

Exact McNemar tests on the same 200 questions (questions only the first system got right / only the second):

| Comparison | Split | p |
|---|---|---|
| latent_mas vs latent_random (primary) | 7 / 5 | 0.77 |
| latent_mas vs single, LoRA | 10 / 10 | 1.00 |
| latent_random vs single, LoRA | 8 / 10 | 0.81 |
| single, LoRA vs single, untrained | 8 / 8 | 1.00 |

- **Primary: not established.** The team is one point above random vectors with the same weights (0.870 against 0.860, 7 / 5, p = 0.77). This is far from p < 0.05. As in cycle 13, this is a failure to show an advantage at this sample size, not proof that the thoughts carry nothing.
- **Secondary prediction: passed.** Single with the self-distilled LoRA is 0 points from the untrained single (limit 3) and its answers are 0.2% shorter (limit 25%). The drop seen with the gold-trained LoRA in cycle 13 (0.855 to 0.730, 280 to 102 tokens) does not appear with self targets. This run changes only the target, but it does not isolate why. Passing shows only that accuracy and length stay inside the stated limits on this sample.
- **Reading:** the LoRA is now close to neutral. Single, the team and random all land within one point of each other and of the untrained model. The training produced no measurable advantage over random thoughts; that is not proof the solver ignores them. A likely reason, not tested here, is the one cycle 13 found: the solver already reads the whole question, and the shared cache also holds the other agents' prompts, so the hand-off has nothing it alone can supply. Cycle 15 tests that directly with sealed agents and split facts.
- **Cost:** the team took 6.3 seconds per question against 4.3 for single with the same LoRA, for the same accuracy.
- **Code review:** Codex reviewed a420d9d. It found no bug in how targets are built, which questions are kept, the split read, or the fairness of latent against random. It found two test gaps: the distill CLI test passed its items in, so a different sample from `train.py`'s would go unseen; and no test kept a generated answer, so a scorer that always says wrong would pass. 7eb5009 adds an end-to-end test that runs both CLIs on their own sampling, and both mutations Codex named now fail it.
- **Data check:** Codex recomputed every figure in this section from the raw reports and logs (except the memory table, from a printed profiling run). All match: the counts and lengths of the targets, the training run, tuning, block-5 accuracy, tokens and times, the four McNemar splits and p-values, and the style gap. It confirmed the same question order in all four block-5 systems, the C14 LoRA path, m = 40, and no checkpoint in the baseline. It flagged three sentences that claimed more than the tests show (that self targets "removed" the damage, that passing showed the style damage "is gone", and that the solver uses "nothing" from the thoughts). All three are reworded above.

### Acceptance for the code

- CPU unit tests with the tiny model, with no download and no GPU:
  - only right answers that stopped inside the budget are kept;
  - a targets file from another model, or in another format, is refused;
  - the CLI writes the single system's greedy answers in the train-sample order;
  - with `--targets`, the targets are the kept self answers plus the close, and the other questions are skipped and counted;
  - without `--targets`, training still uses the gold solutions as in cycle 13;
  - a file with no kept answer stops the run.
- No new runtime dependency.

## P1a — Storage engine decision (evidence collected 2026-11-17)

ADR-003 picked better-sqlite3 because `node:sqlite` had no FTS5. P1a checks whether that is still true, before any dependency is added.

- **What is tested:** `tests/sqlite-fts5-probe.test.mjs` creates an FTS5 table in memory, runs one `MATCH` query, and reports the Node version, platform, SQLite version and whether FTS5 works. It never fails when FTS5 is missing.
- **Expected result:** a probe line on every system that runs the Node suites.
- **Results:** Node 22.14.0 on Windows (local) has SQLite 3.47.2 and no FTS5. Node 22.23.4 on Linux (CI) has SQLite 3.53.4 with FTS5. Public reports agree: 22.19.0 has none and 22.22.2 has it.
- **Outcome:** a proposed revision of ADR-003 in `docs/architecture.md` §5.1: stay on `node:sqlite`, probe FTS5 at open, fall back to `instr` search with a named warning. It is accepted when the user approves the PR.
- **Codex, round 1:** one high, three medium and three low findings, all fixed in the document:
  - (high) The design created the FTS5 table and its triggers unconditionally, so a database made on a build with FTS5 could break writes on one without it. FTS5 is now an optional index the store creates and maintains itself, with a watermark, a rebuild path, and a refusal for deletes it cannot carry into an index it cannot open.
  - (medium) The fallback contract was not written down. It is today's session-level match, newest first, with the same pagination.
  - (medium) Older sections still named better-sqlite3. The landing note now marks them as the original plan while P1a is pending.
  - (medium) The AGENTS.md reason was overstated. It now says a second dependency needs an approved ADR, and that a missing prebuilt binary means a source build.
  - (low) The evidence table now links the CI run and marks the public reports as unchecked. `doctor` tells users to rerun its check rather than naming a version.
  - (low) The two approval moments are now one: ADR-003's revision is accepted only with the P1a PR.
  - (low) §4's legacy-ID formula did not match the store. It now keeps `sessions.id` as it is.
- **Codex, round 2** (of 92fda47): one high, two medium and two low findings, all fixed in the document:
  - (high) §6's purge still cascaded into FTS rows, which no longer happens without triggers. The store now removes each message from the index with FTS5's `delete` command and the original text, in the same transaction as the canonical delete, and runs `optimize` only when an index exists.
  - (medium) A watermark over `messages.id` could miss rows after a delete, a downgrade and a reused ID. It is replaced by an `fts_pending` table written with each insert while the index cannot be updated, and drained in one transaction with the index changes.
  - (medium) A forced-fallback switch cannot prove downgrade compatibility. The implementing card must also reopen the same database on a genuinely module-free build (Node 22.14.0), then on an FTS5 build.
  - (low) The fallback contract now includes the session title and the descending session `rowid` order.
  - (low) The landing note now says what happens to the better-sqlite3 passages when P1a is accepted or rejected.
- **Codex, round 3** (of 8351c3a): no high findings. Three medium and two low, all fixed in the document:
  - (medium) §4 still created the FTS5 index in the first migration and lacked `fts_pending`. The migration now has `fts_pending`, and the index is shown as a separate block the store creates where FTS5 exists.
  - (medium) Draining only at open missed a module-free process appending while an FTS5 process had the file open. A process with FTS5 now drains before each indexed search and inside each delete or purge, before its FTS5 `delete` commands.
  - (medium) §6's scheduled retention and evidence-only cleanup could be blocked without saying so. A blocked run records why and what it would have removed, and an evidence-only export reports that its cleanup did not run.
  - (low) The fallback contract now includes the provider filter and empty queries.
  - (low) Rejection now restores the original ADR-003 entry and the lifecycle text, not only removes §5.1.
- **Codex, round 4** (of 7533cc7, the round 3 fixes): no high findings. Two medium and one low, fixed in the document:
  - (medium) A drain followed by a separate search could miss a message appended in between. Each indexed search now drains and queries inside one transaction.
  - (medium) A blocked evidence-only cleanup was promised to a later run, but nothing remembered it. The pending cleanup is now recorded in `settings` and carried out by the next retention run that can update the index.
  - (low) The rejection instructions now also cover the paragraph that points to §5.1.

## G6 — Product and eval review (run 2026-11-17)

The card asked Codex for a read-only review of the product and evals at cycle 4. Cycle 4 is long past, so on the user's instruction Codex ran it read-only on the state of `main` and the open PRs on 2026-11-17, from Claude Code. The full review is [docs/reviews/g6-2026-11-17.md](reviews/g6-2026-11-17.md).

- **What the evals support:** import, search and hand-offs that keep source lines; typed graphs with valid citations and the two-party room rules; and MCP discovery and paging in real clients. All of it is on synthetic data. M2b transfer is shown for one trained small-model pair only.
- **What is not yet proven:** the hand-off savings rest on synthetic data, and the cycle 7 figures on six early facts. G10's live runs are still owed. The latent team results show no advantage over random vectors (cycles 13 and 14).
- **Main user risks:** a real citation can support a wrong label; local transcript text reaches the agent through `session_read` and the latent fallback; party names in rooms are not verified.
- **Recommended next cycle:** run G10 live on Claude Code and Codex with human-checked labels and a pass rule written first (at least 10 paired runs, 90% of facts carried, 30% fewer median input tokens). Hold the "3× faster, 5× fewer tokens" claim until then.
- **Board actions taken from it the same day:** I1, I2 and I3 went ahead without P1 (PRs #35, #33, #34). P1's design landed on `main`, and its implementation was split into P1a–P1e (the P1 PR).
- **Outcome:** done. No code changed.

## P1b — Projects (defined 2026-11-17, before implementation)

Card P1b on `ruslan/p1b-projects`, from `main` 3a17536. The design is `docs/architecture.md` sections 4 and 11 on PR #37 (`ruslan/p1-design`), which is not on `main` yet: section 4 gives `projects (id, slug unique, name, ..., created_at)` and a `project_id` on every session, and section 11 says the migration sequence restarts at version 2 on top of today's version 1, with projects first. This card adds only that. Message rows, stable keys, deletion, retention, `client`, the API token and the browser stay out. Synthetic data only. Baseline on `main` 3a17536 (Windows): run before the first code change and recorded in the results.

**Rules decided here, before the code:**

- **Slugs.** A project slug matches `^[a-z0-9]+(?:-[a-z0-9]+)*$` (the party pattern) and has at most 64 characters. Anything else is refused with fixed text that never echoes the value.
- **Default project.** The migration creates one project with slug `default` and name `Default`. Every session that exists when a file is migrated joins it. An import without `project` (or with `project: null`) goes to `default`.
- **New projects.** An import that names a slug no project has yet creates that project (name = slug) in the same transaction as the session.
- **Same bytes in a second project.** A session ID is `sha256(provider \0 bytes)`, so it does not depend on the project. Importing bytes that are already stored returns the stored session unchanged, with the project it already has. It is not moved, not copied, and no project is created for that request. The `project` field of the response is how the caller sees this. Moving a session between projects is not part of this card.
- **Project IDs.** 32 random lowercase hex characters. They stay inside the database; the API names projects by slug.
- **Older builds.** `project_id` is added with `ALTER TABLE`, so it cannot be `NOT NULL` with a foreign key in SQLite. A trigger puts any session inserted without a project, including by a build from before version 1, into `default`, the same way version 1's triggers stamp graphs and rooms.

| Eval | Expected |
| --- | --- |
| Schema version 2 | A new file and an opened version 1 file both end at `PRAGMA user_version = 2` with a `projects` table (`id` primary key, `slug` unique and not null, `name`, `created_at`), `sessions.project_id` referencing `projects(id)`, an index on it and the `sessions_project` trigger. `schemaVersion` exports 2. |
| Version 1 file | A version 1 file built in the test (version 1 DDL and rows, no projects) upgrades in place: every session, graph, room and choice row keeps its values, every session is in `default`, and graphs and rooms read back as before. Reopening changes neither schema nor rows. |
| Unversioned file | A version 0 file (the 19f6522 DDL) goes straight to version 2 with both versions' changes, and `tests/migrate.test.mjs` still passes with its version assertions moved to 2. |
| Safe to repeat | A version 1 file that already has a `projects` table and a `default` project (a step run before) migrates without error or a second `default`. |
| Atomic | A failure inside the version 2 step (the index name already taken by a table) rolls back to version 1 with the schema unchanged. |
| Newer files | A file at version 3 is refused with the existing message and left byte for byte as it was. |
| Older build writes | A session inserted with the 19f6522 statement, which has no `project_id`, lands in `default`. |
| Import names its project | `importTranscript({ ..., project: 'acme' })` returns a summary with `project: 'acme'` and creates the project once; a second session into `acme` reuses it. Without `project` the summary says `default`. Invalid slugs (upper case, spaces, double or edge hyphens, 65 characters, a number, an object) are refused before anything is written. |
| Same bytes, second project | Importing the bytes of an `acme` session with `project: 'beta'` returns the `acme` summary with the same ID; `beta` is not created and `acme` still lists one session. |
| Search filters by project | `list(query, provider, project)` and `listSessionsPage({ ..., project })` return only that project's sessions, combined with the query and provider filters and with paging (cursors stay valid inside a project). An unknown but valid slug returns an empty list. Summaries from import, list, page and `get` carry `project`. |
| HTTP | `POST /api/import` accepts `project`. `GET /api/sessions?project=acme` filters, with and without `limit`; a bad or repeated `project` gets 400 with fixed text. The Host and Origin checks are unchanged: a cross-origin import with a project is still 403 and creates nothing. |
| CLI | `npm run ledger -- search --project acme <query>` sends `project` and prints only that project's sessions; an invalid slug is refused before any request. |
| Nothing else changes | No new dependency. No raw control or format characters in `src/` or `tests/`. All four suites pass. |

**Results — P1b (2026-11-17):** every row passes on Windows. The tests are in `tests/projects.test.mjs` (13 tests); `tests/migrate.test.mjs` and `tests/list-api.test.mjs` were adjusted as described below.

- **Schema version 2 — passed.** `src/migrate.mjs` adds `projects (id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, created_at TEXT NOT NULL) STRICT`, the `default` project (name `Default`, a random 32-hex ID), `sessions.project_id REFERENCES projects(id)`, the index `sessions_project_id` and the trigger `sessions_project`. `schemaVersion` is 2. In a STRICT table SQLite also marks the primary key `NOT NULL`, which the test records.
- **Version 1 file — passed.** The test writes the version 1 DDL and rows itself (no projects), copying created_at and party before the version 1 triggers exist. After opening, every session, graph, room and choice row is unchanged, every session is in `default`, graphs and rooms read back as published, and a second open changes neither schema nor rows.
- **Unversioned file — passed.** A 19f6522 file goes straight to version 2. `tests/migrate.test.mjs` now asserts `schemaVersion` instead of 1, compares the version 0 session columns (the table now also has `project_id`), and bumps its "newer" file to `schemaVersion + 1`.
- **Safe to repeat — passed.** A version 1 file with a `projects` table and a `default` row already in place migrates without a second `default`, and its sessions join the existing row.
- **Atomic — passed.** A table named `sessions_project_id` makes the step fail; the file stays at version 1 with its schema and session columns unchanged.
- **Newer files — passed.** Version 3 is refused with the existing message and its bytes are unchanged. Three cases came from the review (below): a newer file without the version 0 tables, a file that a newer build upgrades between this build's first version read and its next step, and a current file that opens while another connection holds the write lock.
- **Older build writes — passed.** The 19f6522 insert, which names no project, lands in `default` through the trigger.
- **Import names its project — passed.** `acme` is created once and reused, no `project` or `project: null` gives `default`, a 64-character slug is accepted, and 13 invalid values (upper case, a space, `a--b`, edge hyphens, `_`, empty, 65 characters, a zero-width space, a number, an object, an array, `true`) are refused with fixed text and nothing written. The project and the session commit in one `BEGIN IMMEDIATE` transaction.
- **Same bytes, second project — passed.** The response is the stored `acme` summary with the same ID, and there is no `beta` row. The same text from Codex is a different session (the provider is part of the ID) and goes to `beta`.
- **Search filters by project — passed.** `list` and `listSessionsPage` filter by project alone and combined with the query and the provider; paging inside `acme` returns its sessions newest first, and an unknown valid slug returns nothing. Summaries from import, list, page and `get` carry `project`.
- **HTTP — passed.** `POST /api/import` takes `project`; `GET /api/sessions?project=` filters with and without `limit`. A bad, empty or repeated `project` is 400 with fixed text. A cross-origin import is 403 and writes no session or project; a wrong Host is 403.
- **CLI — passed.** `ledger search --project acme vega` prints only `acme` sessions. Invalid or repeated `--project` is refused before any request: the test points the CLI at port 1, where nothing listens, and gets the slug message, not "Cannot reach".
- **Nothing else changes — passed.** No new dependency, and no raw control or format characters in `src/` or `tests/`. One existing test changed: `tests/list-api.test.mjs` checked that 120 short sessions fit one 40,000-character MCP result. With `"project": "default"` on every row, 120 no longer fit, so it now uses 110, which is still more than one 100-row ledger page.
- **Not done here:** the browser always imports into `default` and shows no project; MCP `session_search` returns the project but cannot filter by it; sessions cannot be moved between projects; there is no project listing route.

**Codex review (read-only), five rounds.**

Round 1, on 21b0811:

- **Medium — fixed (1c7b988).** `GET /api/sessions?project=` with an empty value listed every project. It is now a 400 like any invalid slug, with and without `limit`.
- **Medium — fixed (1c7b988, completed in de69cec).** `openStore` ran its DDL before `migrate()` checked the version, so a newer file without the old tables changed before it was refused. This predates P1b. A newer file with only a `messages` table now keeps its bytes.
- **Low — fixed (1c7b988).** No test showed that a failed session insert leaves no project behind. A test trigger now aborts the insert after the project is created; neither row persists and the next import commits.
- **Low — fixed (1c7b988, made deterministic in de69cec).** The second lookup under the lock was untested. Two processes now race the same bytes into `left` and `right`; both get the winner's summary and only the winner's project exists.

Round 2, on 1c7b988:

- **Medium — fixed (de69cec).** The version check still ran outside the write lock, so a newer build could upgrade the file between the check and the DDL. The version 0 DDL, including the room tables (now `roomsSchema` in `src/rooms.mjs`), runs inside `migrate()`'s `BEGIN IMMEDIATE`, after the version is read again. This first took the lock on every open, which round 3 corrected.
- **Medium — fixed (de69cec).** `parseArgs` kept only the last `--project`, so `--project BadSlug --project good` sent a request. A repeated `--project` is now refused.
- **Low — fixed (de69cec).** The race test signalled readiness before the first lookup and relied on a 750 ms sleep. Each child now stops at its import's `BEGIN IMMEDIATE` until both are there.
- **Low — fixed (de69cec).** The duplicate test checked that `beta` had no sessions, not that it did not exist. It now reads `projects`.

Round 3, on de69cec:

- **Medium — fixed (44df0b1).** Taking `BEGIN IMMEDIATE` on every open meant a writer holding the lock could stall a store opening a current file for the 5-second busy timeout, then fail it. A version 2 file now opens with no lock and no DDL. The lock, the second version read and the version 0 DDL happen only when a migration may run, so DDL still never runs without a version check under the lock. A new test opens a current file while another connection holds the lock.
- **Low — fixed (44df0b1).** The upgrade-race test relied on a 750 ms sleep, so a slow child could read version 3 first and pass even against 1c7b988. The child now stops right after its first version read, for a version 1 and a version 2 file. The holder drops `room_choices` and moves the file to version 3, and only then is the child let go. At version 1 the child is refused under the lock; at version 2 it runs no DDL and fails on the missing table. In both cases `room_choices` is not recreated.

Round 4, on 44df0b1:

- **Medium — fixed (7349ba6).** With no lock on a current file, a newer build could upgrade it between the first version read and the end of `openStore`. If the upgrade kept the tables, the store opened on a newer schema. The version is now read again after the statements are prepared, and a newer file is refused. The upgrade-race test has a third case: a version bump that keeps every table, which is refused with the newer-schema message.
- **Low:** none.
- **Known limit, not fixed:** an upgrade by a newer build while this store stays open is not detected. Catching it would mean holding a lock for the store's whole life, which would block every other writer.

Round 5, on 7349ba6:

- **High and medium:** none. Codex found that the round 4 recheck catches an upgrade that keeps the tables, takes no write lock, keeps the existing message and closes the connection on refusal.
- **Low — fixed (this commit).** The round 4 test case paused the child at its first version read, so it would still pass if the recheck moved ahead of statement preparation. A new test pauses the child right after `openStore` prepares its last statement (the graph list). It fails if any other statement is prepared after that point. The parent then commits version 3 with every table kept and releases the child. The child is refused with the newer-schema message and the store never opens. With the recheck moved ahead of preparation, this test fails.

Each regression test was checked by removing its fix (twelve mutations across the five rounds); each mutation fails at least its own test.

**Suites (Windows, after the round 5 fix):** `npm run -s test:graph` 9/9; node 204/205 (one skipped; the `main` baseline was 191/192); Playwright 13/13; Python runtime 192 run, OK (50 skipped).
- **Codex, round 6** (of c442c22, the round 5 test): no high or medium findings. Two low, fixed in the next commit: the test now waits for close rather than exit, so the child's output has drained before it is checked; and its cleanup waits for the child to end before the folder is removed.

## P1c — One row per message, stable keys (defined 2026-11-17, before implementation)

Card P1c on `ruslan/p1c-message-rows`, stacked on P1b (PR #42, `ruslan/p1b-projects` 3491cc4). The design is `docs/architecture.md` sections 4 and 11 on PR #37. Section 4 gives a `messages` table with `UNIQUE (session_id, key)` and `UNIQUE (session_id, seq)`, and message keys: `u:<record uuid>`, or `h:` plus 32 hex characters of `sha256(sessionId \0 line \0 raw line)`, or `l:<line>` for legacy sessions. Section 11 says a session is still one row holding its messages as JSON, which this card replaces. The storage engine (P1a) is still open, so this card stays on `node:sqlite` and adds no dependency and no FTS5. Synthetic data only.

**Rules decided here, before the code:**

- **Schema version 3.** `messages (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED, seq INTEGER NOT NULL, line INTEGER NOT NULL, role TEXT NOT NULL CHECK (role IN ('user', 'assistant')), text_json TEXT NOT NULL, key TEXT NOT NULL, UNIQUE (session_id, key), UNIQUE (session_id, seq)) STRICT`. `seq` is the message's 0-based position in its session. `text_json` holds the turn's text as a JSON string literal (changed in review round 1, below): `node:sqlite` cuts a string at a NUL when it reads one and replaces lone surrogates when it binds one, so plain text in SQLite would not give back what was imported, while the JSON column did. A search index can decode the column with `json_extract` when P1a builds one. `id` is internal and never exported. It is there so that a later FTS5 index (if P1a picks one) can use it as its rowid without a rebuild.
- **Session IDs do not change.** A session ID stays `sha256(provider \0 bytes)`, and a graph still cites file lines. Moving to `provider:uuid` session IDs would change every session ID and every graph's `sessionId`, so it is the next card, not this one.
- **Keys on import.** A Claude record whose `uuid` is a UUID-shaped string gets `u:<uuid>` the first time that UUID appears in the session. Every other message gets `h:` plus the first 32 hex characters of `sha256(sessionId \0 line \0 raw line)`. That covers Codex records, a Claude record without a UUID-shaped `uuid`, and a later record that repeats a UUID already used. The raw line is that line's text between newline characters exactly as imported, including a trailing carriage return. The design's rule for repeated UUIDs (skip identical bytes, fail on different bytes) would drop or refuse turns that import today and move their line citations. It waits for the `provider:uuid` card; here a repeat keeps its turn and its line under a hash key.
- **Keys of migrated sessions.** The stored JSON has neither raw lines nor UUIDs, so no hash key can be computed for a session that already exists. Its messages get `l:<line>`, as section 4 says for legacy sessions. Keys never change once written: importing the same bytes again returns the stored session with its `l:` keys.
- **Readers.** `get`, the line check in `publishGraph` and `getGraphContext` read messages from rows in `seq` order. So do the routes built on them and the MCP `session_read` and `context_for` tools, which read the HTTP API. Each message in an API response gains `key`, after `role`, `text` and `line`.
- **The JSON column stays, as a copy that sessions are not read from.** New imports still write `sessions.messages`, and every read of a session uses the rows. Only two things read the column: the version 3 step, once, and the `sessions_messages` trigger when an older build inserts a session (wording corrected in the Codex round on the PR #45 fixes). Builds from before schema versions (19f6522 and earlier) never check `user_version`, so they can still open a version 3 file. With the column kept they keep working instead of failing, and the `sessions_messages` trigger gives any session they insert its rows (with `l:` keys) from that JSON. Dropping the column means a table rebuild in a forward-only migration with no backup yet (section 4's `VACUUM INTO` is not built). That belongs with the `provider:uuid` card, which rebuilds `sessions` anyway.
- **Search stays on `search_text`.** That column already holds the title and every message text, lowercased by JavaScript. Moving `instr` onto message rows would either use SQLite's ASCII-only `lower()`, which changes results for non-ASCII text, or store a second lowered copy of every message, and each term would become a subquery over rows. P1a decides what replaces search (FTS5 over the decoded `messages.text_json`, or a degraded `LIKE`), so this card leaves it as it is.
- **Migration checks (revised after the PR #45 review, below).** The version 3 step reads each session's stored JSON array once, as its exact bytes (`node:sqlite` cuts text at a NUL when it reads it), decodes it in the file's own text encoding (UTF-8, or UTF-16 if the file was created that way), and parses it once in JavaScript. It checks each message before writing its row: an object with a `user` or `assistant` role, a string text, a line written as an integer from 1 to 2^53 - 1, no field named twice in the message, no `role`, `text` or `line` field name followed by a NUL (SQLite compares names only up to one; any other name with a NUL is an extra field and is ignored), no nesting deeper than SQLite's 1,000 levels, and no line used twice in the session. JavaScript would read `1.0` or `1.00000000000000001` as 1, and it keeps the last of two fields with one name where SQLite keeps the first, so both are refused, as is a leading byte order mark. That keeps the step as strict as the SQL checks it replaced (Codex round on the PR #45 fixes). Rows keep the array order, and each text is written as `JSON.stringify(text)`, as an import writes it. A session ID of 64 hex characters is bound from JavaScript; any other ID is copied by rowid in SQL, so it stays exact. Rowids are read as BigInt, since a rowid can be above 2^53. Until the review the step copied in SQL (`->`, not `->>`) and then checked every session's rows against its stored messages in full (review round 1). The rows are now written from the same parsed values that were checked, so that second pass is gone. A file that already has a `messages` table or a `sessions_messages` trigger is refused before anything is written. One session that cannot be copied makes the whole step fail and roll back, leaving the file at its version. The error names the session by its ID when that is 64 lowercase hex characters (every ID this project writes), and otherwise by its row. It then says in fixed words what is wrong and that the migration rolled back. It quotes no transcript content.

| Eval | Expected |
| --- | --- |
| Schema version 3 | A new file, and version 2, version 1 and unversioned files, all end at `PRAGMA user_version = 3` with the `messages` table above, its two unique constraints and the `sessions_messages` trigger. `schemaVersion` exports 3. |
| Version 2 file | A version 2 file built in the test (P1b DDL and rows, two projects) upgrades in place. Each session's rows match its JSON messages in order (`seq`, `line`, `role`, `text`) with `l:<line>` keys. Every session, project, graph, room and choice row keeps its values, and graphs, rooms and context read back as before. A new graph citing a stored line publishes; one citing any other line is refused. Reopening changes neither schema nor rows. |
| Version 1 and unversioned files | Both go straight to version 3 with every earlier step's changes and the same rows as above. The P1b and migrate tests still pass, with their version assertions made relative to `schemaVersion`. |
| Leftovers (revised in review round 4) | The step is one transaction, so it never leaves part of itself behind. A version 2 file that already holds a `messages` table (even one of exactly this shape, with or without matching rows), anything else on such a table, or a `sessions_messages` trigger (in any letter case, on any table) is refused with fixed text and left byte for byte unchanged. The first draft reused such a table, keeping its rows where they matched. |
| Atomic | A session whose `messages` JSON is malformed, or is not an array of messages, makes the open fail. The error names that session and says in fixed words what is wrong and that the migration rolled back (revised after the PR #45 review). The file stays at version 2 with its schema and rows unchanged. |
| Upgrade time (added after the PR #45 review) | A synthetic version 2 ledger of 2,000 sessions with 200 messages each is upgraded and timed, while a second process opens the same file. Timings before and after the change are recorded. If the upgrade still takes longer than the 5 s `busy_timeout`, that is stated as a known limit with the numbers. |
| Legacy keys (added after the PR #45 review) | A migrated session keeps `l:<line>` keys. The same bytes imported into a fresh ledger get the same session ID, lines and texts with `u:` keys (Claude) or `h:` keys (Codex). Importing them again into the migrated ledger leaves the `l:` keys as they are. |
| Newer files | A file at version 4 is refused with the existing message and left byte for byte as it was. |
| Older build writes | A session inserted into a version 3 file with the 19f6522 statement gets one row per JSON message with `l:<line>` keys, joins `default`, and reads back through `get`. |
| Keys on import | A Claude transcript with UUIDs gets `u:<uuid>` keys. A Codex transcript gets `h:` keys equal to a recomputation in the test. Two identical turns on different lines get different keys. A repeated UUID, a missing `uuid` and a non-UUID `uuid` (one with a control character among them) get `h:` keys. A CRLF transcript hashes the carriage return. The same bytes imported into a second, empty store get the same session ID and the same keys. The session and its rows commit in one transaction. |
| Readers use rows | With the JSON column overwritten in the test, `get`, graph publishing (the line check), graph context and search are unchanged. |
| HTTP and MCP | `GET /api/sessions/:id` returns `key` on every message; MCP `session_read` output is unchanged. |
| Nothing else changes | No new dependency and no FTS5. No raw control or format characters in `src/` or `tests/`. All four suites pass. |

**Results — P1c (2026-11-17):** every row passes on Windows. The tests are in `tests/message-rows.test.mjs` (18 tests since the PR #45 review). `tests/projects.test.mjs` now states its versions relative to `schemaVersion` (the current version, and `schemaVersion + 1` for a newer file) instead of the literals 2 and 3. Nothing else in it changed.

- **Schema version 3 — passed.** `src/migrate.mjs` adds `messages (id, session_id, seq, line, role, text_json, key)` as STRICT, with `UNIQUE (session_id, key)`, `UNIQUE (session_id, seq)`, a deferred, cascading foreign key to `sessions`, and the `sessions_messages` trigger. `schemaVersion` is 3. There is no virtual table and no new dependency. The column is `text_json`, not `text`, after review round 1 (below).
- **Version 2 file — passed.** The test builds a version 2 file from the P1b DDL, with sessions in `default` and `acme`. After opening, each session's rows are its JSON messages in order with `l:<line>` keys. Every session, project, graph, room and choice row is unchanged, and graphs, rooms and graph context read back exactly as before. A graph citing line 4 publishes; lines 2 (a record that is not a turn) and 5 are refused. A second open changes neither schema nor rows.
- **Version 1 and unversioned files — passed.** Both reach version 3 with every earlier step's changes and the same rows.
- **Leftovers — passed.** Thirteen kinds of leftover in a version 2 file are refused with fixed text, leaving the file byte for byte unchanged at version 2. They include a `messages` table of exactly this shape (empty, with matching rows, or with too few), rows for a missing session, a table with no foreign key, the deferred clause only in a comment, partial unique indexes, a trigger on `messages`, a view named `messages`, a table named `Messages`, and `sessions_messages` triggers on `sessions` and on `projects` (in either case). Version 0 and version 1 files with a leftover are refused in the same way, with their earlier steps rolled back, and they migrate once it is removed (review round 5). This row replaced "Safe to repeat" in review round 4.
- **Atomic — passed.** Eleven kinds of bad stored JSON fail the open and leave the file byte for byte unchanged at version 2: malformed JSON, an object, a number in the array, a `system` role, a missing text, a numeric text, line 0, a string line, a fractional line, line 2^53 and line 2^63. The last two come from review round 1. Since the PR #45 review the error names the session, and the test adds more cases: an empty value, a NUL after the array, `null` and an array inside the array, bytes that are not UTF-8, two messages on one line (until then a raw SQLite unique-key error), a repeated `text`, `line` or escaped field name, lines `1.0`, `1e0` and `1.00000000000000001`, a leading byte order mark, a NUL after a `line`, `role` or `text` field name, and nesting 1,001 levels deep.
- **Newer files — passed.** Version 4 is refused with the existing message and its bytes are unchanged. The P1b newer-file and upgrade-race tests pass at `schemaVersion + 1`.
- **Older build writes — passed.** The 19f6522 insert into a version 3 file gets one row per JSON message with `l:` keys, joins `default`, reads back through `get` and can be cited. Repeating the insert adds nothing.
- **Keys on import — passed.** First-use Claude UUIDs get `u:` keys. These get `h:` keys equal to the test's own recomputation: a repeated UUID (including one in another letter case, from review round 1), a missing `uuid`, a non-UUID string, a UUID with a control character, and a number. Two identical `ok` turns get different keys, and a CRLF Codex file hashes the carriage return. The same bytes in a second, empty store give the same ID and keys, and importing the same bytes again writes nothing. A session that fails to insert leaves no rows, and a row without its session fails at commit.
- **Readers use rows — passed.** With `sessions.messages` overwritten with text that is not JSON, `get`, graph context, search, paging and the line check in `publishGraph` are unchanged. A NUL and lone surrogates survive a fresh import, a migration and an older build's insert exactly (review round 1).
- **HTTP and MCP — passed.** `GET /api/sessions/:id` returns `key` on every message. The MCP `session_read` page for a four-turn session shows no key and equals a literal copy of the page as it was rendered before keys existed. One of the turns contains a `~~~` run and a right-to-left override.
- **Nothing else changes — passed.** No new dependency and no FTS5. No raw control or format characters in `src/` or `tests/`.
- **Decided, not built:** session IDs stay content-addressed; `sessions.messages` is still written; search stays on `search_text`; migrated sessions keep their `l:` keys for good. The reasons are in the rules above.

**Codex review (read-only), five rounds.** Round 1 was run twice on the same diff (c9d5712, and 8d69c17, which added only a test): once by this session and once by an earlier copy of it working in the same worktree. Both runs found the same five issues, so they are listed once.

Round 1, on c9d5712:

- **High (Medium in one run) — fixed (f8b9b8f).** `node:sqlite` cuts a string at a NUL when it reads one and replaces lone surrogates when it binds one. A turn with either came back changed from rows, while the JSON column had kept it. Rows now hold the text as a JSON string literal (`text_json`). The store writes it with `JSON.stringify` and decodes it on read; the migration and the trigger copy the stored literal with `->`. A new test covers all three write paths.
- **Medium — fixed (f8b9b8f).** A version 2 file with pre-existing rows passed the step if only the count matched, so a wrong line could be cited afterwards. Every row had to match its stored message in full. Round 4 later replaced reuse with refusal.
- **Low — fixed (f8b9b8f).** Repeated UUIDs were compared case-sensitively, so a repeat in upper case got a second `u:` key. They now compare in lower case, and the key keeps the first spelling.
- **Low — fixed (f8b9b8f).** Lines above `Number.MAX_SAFE_INTEGER` passed the check and then could not be read, and 2^63 surfaced a SQLite error. Lines must now be from 1 to 2^53 - 1.
- **Low — fixed (f8b9b8f).** The MCP test checked only the headings. It now compares the whole page.

Round 2, on f8b9b8f:

- **High:** none. Codex confirmed the round 1 fixes.
- **Medium — fixed (8e2f5f3, superseded by ce08237).** A `sessions_messages` trigger already in the file was kept (`IF NOT EXISTS`) even if it wrote nothing. The fix dropped and recreated it.
- **Medium — fixed (8e2f5f3, superseded by ce08237).** Rows naming no session passed, because a deferred key checks only rows written in the transaction. The fix added `PRAGMA foreign_key_check(messages)`.
- **Low — fixed (8e2f5f3).** The backfill sorted every message under the write lock. The sort is gone, since `seq` carries the order, and the query plan has no temporary B-tree.
- **Low — fixed (8e2f5f3).** The MCP comparison used the same renderer as the code. It now compares against literal text.

Round 3, on 8e2f5f3:

- **High:** none.
- **Medium — fixed (26a3961, superseded by ce08237).** A pre-existing `messages` table without its foreign key was reused, so deleting a session would have left its messages. The fix checked the table's shape.
- **Low — fixed (26a3961, superseded by ce08237).** The step would drop a `sessions_messages` trigger defined on another table. The fix refused one.

Round 4, on 26a3961:

- **High:** none.
- **Medium (four) — fixed (ce08237).** Four leftovers passed the round 3 shape check: partial unique indexes, a deferred clause inside a comment, `SESSIONS_MESSAGES` on another table, and a trigger on `messages` that deletes rows. The step is one transaction and never leaves part of itself behind, so these objects can only come from elsewhere. The step now refuses any `messages` table, anything on a table of that name, and any `sessions_messages` object, in any case. It always creates the table and the trigger itself. The shape check, the orphan check and the trigger replacement are gone.

Round 5, on ce08237:

- **High and medium:** none. Codex found that this repository's version 0, 1 and 2 DDL creates no matching object, and that a failed attempt rolls back.
- **Low — fixed (this commit).** The leftover test used only version 2 files. Version 0 and 1 files with a leftover now show that their earlier steps roll back and that they migrate once it is removed.

Each regression test that still applies was checked by undoing its fix. That makes seven mutations: raw text in rows, a reader that accepts raw text, a migration that decodes text, case-sensitive UUIDs, no line bound, no leftover refusal, and a heading change in the shared renderer. Each one fails at least its own test. Two checks are not tested by inputs. The full-row comparison after the backfill checks the step's own copy; since round 4 no input reaches it, so undoing it fails no test. The `typeof` check on lines from round 1 turned out to be covered by the bound and was removed.

**Suites (Windows, after the round 5 fix):** `npm run -s test:graph` 9/9; node 216/217 (one skipped; P1b had 204/205, and this card adds 12 tests); Playwright 13/13; Python runtime 192 run, OK (50 skipped).

**Independent review of PR #45 (read-only, 2026-11-18).** It found no high findings, five medium and four low. The low ones (6 to 9) are left as they are. The medium ones were handled as follows.

1. **One malformed legacy session made `openStore` throw for the whole ledger, with an error that named no session — fixed.** The step still fails as a whole and rolls back, so there is never a partial upgrade. The error now names the session and the problem, for example `Session <64 hex> cannot be moved to schema version 3: a stored message is not an object with a user or assistant role, a string text and a line from 1 to 2^53 - 1. The migration rolled back, so the file was not changed.` The fixed reasons are "its stored messages are not a JSON array", that one, "a stored message has the same field twice", "a stored message has a role, text or line field name followed by a NUL character" and "its stored messages are nested more than 1,000 levels deep" (added in the Codex rounds below), and "two stored messages have the same line". An ID of any other form is named as `The session in row <n>`, so no stored text is printed. The atomic test builds a version 2 file, breaks the second of its two sessions in 27 ways and checks the exact message for each, and that the file is byte for byte unchanged. It also checks bytes that are not UTF-8 and an ID with a newline and a NUL. Against the old `src/migrate.mjs` this test fails, and the other 13 tests of that commit pass.
2. **The upgrade could hold the write lock past the 5 s `busy_timeout` — confirmed, then reduced.** `evals/migration/v3-upgrade.mjs` builds the version 2 file in a temp folder and deletes it afterwards: 2,000 sessions of 200 turns of 20 to 1,000 characters, 400,000 turns and 220.4 MiB of text. It upgrades the file in a child process and opens the same file from a second process 0.3 s later. Timings are on Windows 11 with Node 22.14.0 and SQLite 3.47.2, with other agents' test runs on the same machine, so they vary by about ±1 s.

   | Code | Upgrade, 2,000 x 200 | Second process |
   | --- | --- | --- |
   | Before (2ebf73f, SQL copy) | 6.6, 7.0, 7.5, 7.5, 7.5 and 9.3 s | Failed with `database is locked` in 4 of 6 runs, after 6.7 to 6.9 s; opened in 2, after 6.3 and 6.8 s |
   | After (one JavaScript pass, 5a80f16) | 4.3, 4.0 and 4.1 s | Opened in 3 of 3, after 3.7 to 4.0 s |
   | After the Codex round (field and line-token checks added) | 4.1, 4.4 and 4.4 s | Opened in 3 of 3, after 3.9 to 4.2 s |
   | After the second Codex round (NUL-name and depth checks added) | 6.8, 4.3, 4.3 and 4.3 s (the 6.8 s run was under load) | Opened in 4 of 4, after 4.0 to 6.5 s |
   | After, 3,000 x 200 (600,000 turns, 330.6 MiB) | 7.3 and 7.4 s | Opened in 2 of 2, after 7.0 and 7.2 s |

   Timing `openStore` alone on copies of the same file, alternating the two builds (5 pairs), gave 7.3 to 8.3 s before and 4.1 to 5.3 s after. **Known limit:** the upgrade costs about 10 µs per turn here, so a ledger with more than about 480,000 turns (about 270 MiB of text in this mix) still takes longer than 5 s. A second process that opens it meanwhile (the server, the MCP adapter or the CLI) can then fail with `database is locked`, and opening again after the upgrade works. On Windows a waiting process gave up after 6.7 to 6.9 s in the failed runs, not at exactly 5 s, and got through after 7.0 to 7.2 s in others, so whether it fails is a race. `busy_timeout` and the design are unchanged.
3. **The SQL re-parsed each turn several times — changed, with a smaller effect than expected.** Timing the old step's phases on the 2,000-session file gave 1.1 to 1.5 s for the check query, 3.3 to 3.7 s for the copy, 2.5 to 2.8 s for the full re-check of the copy, and 0.1 to 0.2 s for the commit. Re-parsing was a small part of that, because SQLite keeps recent JSON parses: `json_each` over every session took 0.43 s, and three accessors per turn added only 0.35 s. Most of the cost is writing 400,000 rows into the table and its two unique indexes. The step is now one pass in the same transaction (`copyStoredMessages`). It reads each array once as bytes, parses it once, checks it and inserts its rows, and the re-check pass is gone (see the revised "Migration checks" rule). That accounts for the timings in item 2. Copying an ID by rowid through `INSERT ... SELECT` for every row was tried and took 6.3 s, so only IDs that are not 64 hex characters take that path. A larger page cache made no clear difference, so it was left out.
4. **Turn text is stored three times — kept as designed, measured.** `sessions.messages` (the JSON copy for builds from before versions), `sessions.search_text` (the lowered search copy) and `messages.text_json` each hold every turn's text. On the 2,000-session ledger the file grows from 459.8 MiB to 820.5 MiB on upgrade (+360.7 MiB, 1.78 times, for 220.4 MiB of text). On the 3,000-session ledger it grows from 689.7 MiB to 1,230.9 MiB. The import also runs `JSON.stringify` twice per turn. The `provider:uuid` card (next step 3 of the P1c handoff) removes the JSON column. It rebuilds `sessions` anyway, after a `VACUUM INTO` backup. P1a decides what replaces `search_text`. The schema is unchanged here.
5. **Migrated sessions keep `l:<line>` keys while fresh imports get `u:` or `h:` keys — intended, now pinned by a test.** This is design section 4: the stored JSON has neither raw lines nor UUIDs, so no `u:` or `h:` key can be derived for a session that already exists, and keys never change once written. A new test imports the version 2 file's Claude and Codex transcripts into a fresh ledger. The session IDs, lines and texts match, and the keys differ (`l:` against `u:` and `h:`). Importing the same bytes again into the migrated ledger keeps the `l:` keys. Matching sessions across ledgers by key waits for the `provider:uuid` card, which links a legacy session to its UUID session (`legacy_id` in section 4).

A second new test covers the rowid path: a session whose ID holds a NUL migrates under its exact ID. Two mutations were checked, and each fails its test: binding the ID as JavaScript read it (the commit fails on the foreign key), and reading the stored array as text (a NUL after the array is no longer refused).

**Codex review (read-only) of the fixes, on 5a80f16.** It found no high findings, three medium and four low. All of them are fixed in the next commit, each with a test:

- **Medium — fixed.** `JSON.parse` keeps the last of two fields with one name, while SQLite (the old copy, and the trigger for older builds) keeps the first, so `"text": "first", "text": "last"` changed which text was migrated. The step now refuses a message with a repeated field, even one spelled with an escape: "a stored message has the same field twice". A scan of each array's own elements finds such fields after `JSON.parse` has accepted the text. Names inside texts, inside nested objects and next to escaped quotes are not counted, and a test pins that.
- **Medium — fixed.** A rowid above 2^53 failed to convert to a JavaScript number before the session could be named, so the upgrade failed where the SQL copy had worked. Rowids are now read as BigInt. A test migrates sessions at rowids 2^53 + 1 and 2^53 + 2 (one with an opaque ID that holds a NUL), and a bad one there is named by its exact row.
- **Medium — fixed.** The step decoded every file as UTF-8, so a ledger created in UTF-16 failed on every session. It now reads `PRAGMA encoding` and decodes with that encoding. The ID length check counts 128 bytes in UTF-16, so IDs are still named and bound directly. UTF-16le and UTF-16be version 2 files migrate with the same rows, and a bad session in each is named by its ID.
- **Low — fixed.** `1.0`, `1e0` and `1.00000000000000001` passed as line 1, and a leading byte order mark was dropped by the decoder; the SQL checks refused all of them. The step now checks the raw line token and keeps the byte order mark, so all are refused again.
- **Low — fixed.** The Codex half of the legacy-key test derived its expected hashes from the fresh ID. It now fixes the ID in advance and makes the same line, text and re-import checks as the Claude half.
- **Low — fixed.** In the benchmark, a child that exited before it started left the run waiting and skipped the cleanup. That now fails the run, and the folder is still removed.
- **Low — fixed.** The docs called `sessions.messages` never read. The wording now names its two readers: the version 3 step and the trigger for older builds.

Mutations checked, each failing its test: decoding as UTF-8 always, a 64-byte ID check in UTF-16, no repeated-field check, any line token, and dropping the byte order mark. The previous commit's `src/migrate.mjs` fails the atomic test and the wide-rowid test. Codex also confirmed the earlier points with probes on Node 22.14.0: a NUL and lone surrogates survive, a throw inside the loop resets the statement and rolls back to version 2, and the error text holds only a hex ID or a number. The added checks cost little: the upgrade still takes about 4 s (see the table above).

**Codex review (read-only) of 2f44b8a, the second round on the fixes.** It found no high findings, one medium and two low, all fixed in the next commit. Codex also checked the scanner with 128 in-memory cases (runs of backslashes, escaped quotes, delimiters inside strings, nesting and an escaped `line` name) and found no wrong string end or misaligned element.

- **Medium — fixed.** An escaped NUL in a field name could change a line citation. In `"line\u0000suffix": 9, "l\u0069ne": 1`, JavaScript sees two different names and took line 1, while SQLite compares names only up to the NUL and took line 9, as the trigger for older builds still would. A message with a NUL in a field name is now refused: "a stored message has a field name that holds a NUL character".
- **Low — fixed.** The scan accepted nesting deeper than SQLite's limit of 1,000 levels, which the old SQL check refused. Such a session now fails with "its stored messages are nested more than 1,000 levels deep". A test checks both sides against SQLite's own `json_valid`: 1,000 levels migrate and 1,001 are refused.
- **Low — fixed.** Comments in `src/migrate.mjs` and `src/store.mjs` still called `sessions.messages` never read. They now name its two readers.

Both new checks were mutation-checked: without each, its test fails.

**Suites (Windows, after the Codex round on the PR #45 fixes):** `npm run -s test:graph` 9/9; node 220/221 (one skipped; this card had 16 tests then); Playwright 13/13; Python runtime 192 run, OK (50 skipped). No raw control or format characters in `src/`, `tests/` or `evals/migration/`.

**Suites (Windows, after the second Codex round):** `npm run -s test:graph` 9/9; node 221/222 (one skipped; this card had 17 tests then); Playwright 13/13; Python runtime 192 run, OK (50 skipped). No raw control or format characters in `src/`, `tests/` or `evals/migration/`.

**Codex review (read-only) of ed38502, the third round on the fixes.** It found one medium, fixed in the next commit.

- **Medium — fixed.** The NUL check refused too much. An extra field that the copy ignores, such as `meta` followed by an escaped NUL and `suffix`, failed the whole migration, though it had migrated before. Now a name with a NUL is refused only when its part before the NUL is `role`, `text` or `line`, a field that SQLite would read in its place. The fixed reason is now "a stored message has a role, text or line field name followed by a NUL character". The atomic test refuses such names for all three fields. A new test migrates a message with the extra names `meta` + NUL + `suffix`, NUL + `line` and `lines` + NUL, and gets the same row as before. With the fix undone (the ed38502 `src/migrate.mjs`), the new test fails. With no NUL check at all, the atomic test fails.

**Suites (Windows, after the third Codex round):** `npm run -s test:graph` 9/9; node 222/223 (one skipped; this card has 18 tests); Playwright 13/13; Python runtime 192 run, OK (50 skipped). No raw control or format characters in `src/`, `tests/` or `evals/migration/`.

**Codex review (read-only) of 2e38cd4, the fourth round, run by the coordinating session.** It found no high findings. The two it found are accepted as known limits for the human reviewer, with no code change:

- **Medium — accepted.** A field name of `role`, `text` or `line` followed by a NUL is refused even when it comes after the real field, although SQLite and JavaScript would both read the first one. The store writes stored messages with `JSON.stringify` from known fields, so such names cannot occur in a ledger the store wrote. The refusal fails safe: the whole step rolls back and the error names the session.
- **Low — accepted.** No test covers the case where the real field comes before its NUL alias. It would only pin the refusal described above.

This closes P1c's review loop. A human review of the version 3 migration is still owed.

## P1d — Delete a session (defined 2026-11-17, before implementation)

Branch `ruslan/p1d-session-delete`, from `origin/main` 3a17536. This is the first part of card P1d (Delete and retention). It deletes one imported session. Project delete and purge by retention days need P1b's projects and come later. Synthetic transcripts only. Every test uses a temporary or `:memory:` database, never `.context-ledger/ledger.sqlite`. This card deletes user data, so the PR needs a human review as well as the Codex review (AGENTS.md section 4.4).

| Eval | Expected |
| --- | --- |
| Store delete | `deleteSession(id)` removes the session row and returns true. `get`, `list` and `listSessionsPage` no longer return it, and the other sessions are unchanged. An unknown ID returns false and changes nothing. No schema change: `user_version` stays 1 and the table definitions are the same. |
| Refused while cited | While any graph has `graphs.session_id` equal to the ID, `deleteSession` throws a `ConflictError` that names how many graphs cite it ("cited by 1 graph", "cited by 2 graphs") and changes nothing. The session, its graphs and any room on them stay readable. Rooms reference graphs, not sessions, so a session in a room is already refused through its graph. The check and the delete run in one `BEGIN IMMEDIATE` transaction, and `PRAGMA foreign_keys` stays ON, so a graph cannot slip in between them. |
| Really gone | After a delete, a search for a word that was only in that session finds nothing, because `search_text` is in the same row. In a temporary file database, the raw bytes of the `.sqlite` file no longer contain the session's message text, title or source name, and no `-journal` file is left. SQLite does not zero freed space by default (`PRAGMA secure_delete` is 0 in Node 22's build; measured: the text stays in the file after a plain `DELETE`). The delete therefore sets `secure_delete = ON` for its own transaction only and puts the previous value back afterwards, which is checked. The file does not shrink until a `VACUUM`; this card does not run one. Bytes of the rollback journal that the file system freed are outside the ledger's reach. *Added after review round 1:* a database in WAL mode (which another tool can leave a ledger file in; the ledger never sets it) keeps the old pages until a checkpoint, so a delete there is refused with 409 and the journal mode, and nothing changes. A list cursor that points at a deleted session gets the existing 400 `Unknown cursor.`, and a listing started again finds the rest. |
| HTTP | `DELETE /api/sessions/:id` with the same Host check as every route and the same exact-Origin rule as every write: a foreign Origin, the other local name's Origin or no Origin is 403 `Deleting a session requires the same origin.`, checked before the lookup, so an unknown ID also gets 403 without it. With the right Origin: 200 `{ deleted: id }`, 404 for an unknown, upper-case, short or long ID, 409 `{ error, graphs }` while cited. GET, POST, PUT and PATCH on the ID stay as they were. `tests/routes.test.mjs` is updated on purpose: its old loop sent DELETE to `/api/sessions/<graph id>` and expected 404 because there was no route. It still gets 404, now from the handler (no such session), and a new block pins the DELETE cases above. |
| CLI | `npm run ledger -- delete <session-id>` sends `DELETE /api/sessions/<id>` with the local Origin and prints `Deleted session <id>.` A bad ID prints the usage and sends nothing. 404 prints `Session not found.`, 409 prints `Session is cited by N graph(s), so it was not deleted.` built from the integer count, not from the server's text, and anything else prints `Context Ledger returned HTTP <status>.`. Exit code 1 on every error, and stdout stays empty. *Added after review rounds 1 and 2:* a 409 whose `journalMode` is `wal` or `persist` prints `The ledger database does not use the default rollback journal, so the session was not deleted.`; any other 409 body gets the generic message; a success whose body is not JSON, or names another ID, prints `Context Ledger returned an unexpected response.` |
| Browser | The open transcript has a Delete button. It asks with `window.confirm` (fixed text, no transcript text in it). Cancel sends nothing. Accept sends the DELETE, clears the reader and refreshes the list, so the transcript is gone from search. A refusal shows the server's message in the reader status through `textContent`. Playwright covers accept, cancel and a cited session. |
| No MCP delete | The MCP adapter gets no delete tool, because agents must not delete people's data. Its HTTP client only sends GET and POST. A test checks that no tool name, description or schema mentions delete, remove, purge or erase, that no file in `src/mcp/` names DELETE or `deleteSession`, and that tools/list offers the same 13 tool names in the same order. |
| Escaping | No raw control or format characters other than tab, newline and carriage return in the changed files under `src/` and `tests/`. |
| Suites | `npm run -s test:graph`, `node --test tests/*.test.mjs`, Playwright and the Python runtime checks all pass. |

### Results — P1d delete a session (2026-11-17, Windows)

All rows pass. Commits: 874fc86 (implementation), 6c49fff (review round 1 fixes), then the round 2 fixes in the commit that adds these results. The tests are `tests/delete.test.mjs` (12), the new DELETE block in `tests/routes.test.mjs`, and `tests/e2e/delete.spec.mjs` (3).

- **Store delete:** pass. `deleteSession` removes the row and returns true; `get`, `list` and `listSessionsPage` drop it and the kept session's detail is unchanged; unknown IDs return false. `sqlite_master` and `user_version` (1) are identical before and after.
- **Refused while cited:** pass. 1 graph and 2 graphs give the exact messages and `details.graphs`; sessions in a room are refused through their graphs, and the room, graphs and context stay readable. A refusal runs `ROLLBACK`, and the next write on the same connection works. `PRAGMA foreign_keys` is checked to be 1 after a delete, and a direct `DELETE` of a cited row fails on the foreign key, so the schema refuses it too.
- **Really gone:** pass. After a delete, searches for its words return nothing. The `.sqlite` bytes hold none of the session's message text, title or source name, both while the store is open and after close, and the folder holds only `ledger.sqlite` (no `-journal`). A control test pins the premise: Node 22.14's SQLite has `secure_delete` 0, and a plain `DELETE` leaves the text in the file. The delete runs `PRAGMA secure_delete = ON`, `BEGIN IMMEDIATE`, `COMMIT` or `ROLLBACK`, then puts back the previous mode, checked with OFF and FAST. Why ON is justified: the card's point is that the transcript is gone, and without it the deleted text stays readable in free pages; it applies to this delete only, so no other write pays for it. The file keeps its size until a `VACUUM`, which this card does not run (the project purge in the design does). A WAL database is refused (409 with `journalMode: "wal"`, over HTTP and from the CLI) and nothing changes. A list cursor on a deleted session gets 400 `Unknown cursor.` over HTTP, and a new listing returns the rest.
- **HTTP:** pass. `tests/routes.test.mjs` now pins 20 more probes: foreign Origin, the other local name's Origin and no Origin give 403 before the lookup (also for an unknown ID), a foreign Host 403, unknown, upper-case, short, long and trailing-slash IDs 404, `DELETE /api/sessions` 404, a cited session 409 `{ error, graphs: 1 }`, PATCH 404, a delete 200 `{ deleted: id }`, then 404 on GET and on a second DELETE, and search no longer finds it. One existing probe changed on purpose: the loop that sent DELETE with a `{}` body to `/api/sessions/<graph id>` now gives the body a `Content-Length`. Node's client sends a DELETE body without framing, and with a route there the server read those bytes as a second, malformed request (400 from Node's parser, without the security headers). The answer is still 404, now from the handler. A DELETE body is not read.
- **CLI:** pass, with a real server and with a fake one. The fake records exactly one `DELETE /api/sessions/<id>` with the local Origin and no body. Bad IDs send nothing. A hostile server text (ESC and U+202E) never reaches stderr: in a 409 with or without a valid count or journal mode, a 403, a 404, a wrong ID and a body that is not JSON.
- **Browser:** pass. Playwright: cancel sends no DELETE request and keeps the transcript; accept sends one DELETE, clears the reader and search finds nothing; a cited session shows `Delete failed. This session is cited by 1 graph, so it cannot be deleted.`; an intercepted 409 whose error is markup is shown as literal text and adds no element.
- **No MCP delete:** pass. The 13 tool names are pinned in order, no tool text matches delete, remove, purge or erase, and no file in `src/mcp/` or `src/mcp.mjs` names DELETE or `deleteSession`. An agent with a shell can still run `ledger delete`; keeping agents out of that is P1e's token or a later card, not this one.
- **Escaping:** pass. The changed files in `src/`, `tests/` and `public/` hold no raw control or format characters other than tab, newline and carriage return.
- **Mutation checks (by hand, not committed):** each of these makes a new test fail: no foreign-key mapping in `publishGraph`, restoring `secure_delete` to OFF whatever it was, no journal-mode check, printing the CLI's JSON parse error, and `PRAGMA foreign_keys = OFF`.
- **Suites** (on the final commit): `npm run -s test:graph` 9/9; node 203/204 with one skipped (the 12 new tests in `tests/delete.test.mjs`; `main` had 191/192); Playwright 16/16 (13 before, plus the 3 in `tests/e2e/delete.spec.mjs`), run under the machine-wide port lock; Python runtime 192 run, 50 skipped, OK. Linux CI runs on the PR.
- **Codex review, round 1** (`codex exec --sandbox read-only`, of 874fc86). Two medium, five low; all fixed in 6c49fff with a regression test:
  - (medium) The CLI printed `response.json()`'s parse error, which quotes the body, so a malformed 200 put raw ESC and U+202E on stderr. Now a fixed message. The same parse now covers every CLI command.
  - (medium) In WAL mode a committed delete leaves the old pages until a checkpoint. A delete is now refused outside the rollback journal modes (delete, truncate, memory, off).
  - (low) A graph publish racing a delete on another connection hit the foreign key and became a 500. Now the existing 400 `Graph transcript session not found.`, tested with two connections.
  - (low) A cursor on a deleted session: now in the eval and tested.
  - (low) Hard-coding the `secure_delete` restore, or turning foreign keys off, would have passed; the file bytes were only checked after close. All three are now tested.
  - (low) The cancel test did not count requests, and the refusal test used plain text. Both fixed.
  - (low) "tools/list is unchanged" was claimed but only the count was checked, and the scan missed the e2e spec. The names are pinned and the scan widened.
- **Codex review, round 2** (of 6c49fff). No high or medium. Four low, all fixed in the results commit: the CLI accepted any `journalMode` value as a journal refusal (now only `wal` or `persist`, others get the generic message); the WAL and cursor claims were tested only on the store (now also over HTTP); the CLI row did not list the new messages (amended above); the scan missed `public/styles.css` (added).
- **Human review:** still owed. This card deletes user data (AGENTS.md section 4.4).

## P1e — Loopback API token (`ruslan/p1e-loopback-token`, defined 2026-11-17, before implementation)

ADR-10 in the P1 design (PR #37, section 6): the loopback server needs a secret on every API request, the browser gets it as a cookie through a one-time sign-in link, and the CLI and the MCP adapter read it from a file. This card is security work: it needs a human security review before merge (AGENTS.md section 4).

**Threat model.**

- **Other local users** on the same machine can reach 127.0.0.1 but cannot read files in the owner's account. Today they can read and write the whole ledger. After this card they get 401 on every API route unless they can read the token file (mode 0600 on POSIX, in a 0700 folder) or steal a browser cookie.
- **Other local processes of the same user** (including agents and malware) can read the token file, so they are not stopped. The token stops honest clients that were not given access and processes sandboxed away from the user's files; it does not stop same-user malware. The decisions route keeps its `Sec-Fetch-Site` rule, which an agent with the token can still forge.
- **A web page in the user's browser** cannot read the token or the cookie. The cookie is `HttpOnly; SameSite=Strict`. The Host allowlist (DNS rebinding), the exact Origin check on writes, JSON-only bodies and no CORS stay as they are, so a page can neither read API responses nor write.
- **Not protected:** same-user malware, root or an administrator; anyone who can read the token file; a page served from another port on 127.0.0.1 in the same browser, which receives the cookie because cookies are not isolated by port (so another local user who gets the owner to open their local page can take a browser session until it expires or the server restarts); a sign-in link that someone else opens first within its lifetime. On Windows the file mode is not enforced: the token file gets the ACL of its folder, which under the user profile is normally the user, SYSTEM and Administrators.

| Eval | Expected |
| --- | --- |
| Token at start | Each server start writes a fresh token of at least 32 random bytes to `<database>.token`, created exclusively (an existing file or link there is removed first, and a race fails closed) with mode 0600 where the OS supports it, in a folder created as 0700. The server keeps only a SHA-256 digest in memory. The token is never printed. |
| Every API request needs it | Without the token or a valid session cookie, every route outside the static files and `/login`, every method and every unknown path, answers 401 with a fixed message and `WWW-Authenticate: Bearer`. A wrong, short, long or malformed token, a cookie from another start, and a token sent as a cookie all get 401. The comparison is constant time on digests. Static files stay public. |
| Checks keep their order | The Host and URL checks still come before the token check (a foreign Host without a token is 403, not 401). With the token, every probe in `tests/routes.test.mjs` answers as before; the only change to that test is that it sends the token, plus a block that pins the 401s. |
| Browser sign-in | The server prints a one-time sign-in URL `/login?code=…` at start; `npm run ledger -- login` prints a new one. A code works once, within 60 seconds, and sets an `HttpOnly; SameSite=Strict; Path=/` session cookie (12 hours, per port), then redirects to `/` (303). A used, expired, unknown or malformed code is 401 and sets no cookie. The token itself never reaches the browser, a URL or a fragment; codes are minted only with the bearer token, not with a cookie. |
| CLI and MCP keep working | The CLI and the MCP adapter read the token file named by `CONTEXT_LEDGER_DB` (the repository's `.context-ledger/ledger.sqlite` by default) on each request and send `Authorization: Bearer`. Their errors for a missing file or a refused token are fixed sentences that name neither the token nor a path; a ledger that is not running still gives the existing "Cannot reach" message. |
| Suites | Every node test and Playwright spec that calls the API passes, using the token file (node) or the sign-in link (browser). Playwright adds a browser test for sign-in and for an unauthenticated page. Node, graph, Playwright and Python suites pass. |

**Amendments after review (2026-11-17).** Two rows above say more than the build does, and are corrected here rather than edited in place. "Browser sign-in": the cookie is *named* per port, but browsers send it to every port on 127.0.0.1, so it is not isolated per port (see the open high finding below). "Every API request needs it": constant time applies to the bearer comparison; codes and sessions are looked up by their SHA-256 digests. Code and session lifetimes are upper bounds: a holder of the token can evict them by minting more (32 codes, 64 sessions). The token file now also names the port (`{ "port": …, "token": … }`), is written only once the server holds its port, and clients send the token only to that port.

**Results — P1e (2026-11-17, Windows):** the six rows pass, with one open high finding that needs the human security review. A human security review is required before merge in any case (AGENTS.md section 4).

- **Token at start:** pass. `src/token.mjs` makes 32 random bytes (base64url, 43 characters) per start and writes `<database>.token` from the listen callback: existing file or link removed, then created with `wx` and mode 0600, in a folder created 0700. The server keeps only the SHA-256 digest; the plain token lives only in the listen callback. The start-up output never contains it (checked in `tests/token.test.mjs`). A second server that cannot bind the port exits with `EADDRINUSE` before touching the file. Ctrl-C or SIGTERM removes the file if it still holds this server's token. If the file cannot be written, the server exits with a fixed sentence that names no path. POSIX mode and link cases run on Linux CI only; on Windows the file takes its folder's ACL.
- **Every API request needs it:** pass. Everything except the three static files and `/login` is 401 without the bearer or a live cookie, with `WWW-Authenticate: Bearer realm="Context Ledger"`: every route, unknown paths, other methods, a wrong, short, long or malformed token, the token as a cookie, a cookie from an earlier start. `POST /api/login` mints codes with the bearer only (403 with a cookie).
- **Checks keep their order:** pass. `tests/routes.test.mjs` sends the token on every probe and its 192 probes answer as before. A new block pins 401 on 21 guarded probes without a token and with a wrong one, and shows that no latent request reached the runtime. It also checks that a foreign Host is still 403, a bad URL still 400, and the static files still 200 without a token.
- **Browser sign-in:** pass. The start-up line and `npm run ledger -- login` print `/login?code=…`. A code works once within 60 seconds and gives 303 to `/` with `context_ledger_<port>=…; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`. A used, expired, unknown, malformed or missing code, the token itself, or two codes in one link (neither is used up) gives 401 and no cookie. The cookie reads, writes with the right Origin, and confirms a room proposal only with `Sec-Fetch-Site: same-origin`. `tests/e2e/auth.spec.mjs` checks this in Chromium: an unauthenticated page shows the sign-in hint, `document.cookie` is empty, and a reused link gets 401 in a second browser context.
- **CLI and MCP keep working:** pass. Both read the token file named by `CONTEXT_LEDGER_DB` (default: the repository's `.context-ledger/ledger.sqlite`) on every request. The MCP test keeps one adapter process across a ledger restart on the same port. Each client sends the token only to the port the file names and says, in a fixed sentence, which port the token is for. A graph publish and `demo/publish-reference.mjs` send nothing without a matching token. A missing, malformed, linked or other-user file is "Cannot read the Context Ledger access token…", a wrong token is "…refused the access token…", and a ledger that is not running is still "Cannot reach…". No message holds the token or a path. The handoff benchmark, `demo/rehearse.mjs` and the latent evals pass the token too (the evals only to a literal `http://127.0.0.1:<port>`).
- **Suites:** node 207/212 (5 skipped: 4 POSIX-only token cases on Windows and the existing port-4320 skip), was 191/192 before this card. Graph check 9/9. Playwright 14/14 (was 13; +1 `auth.spec.mjs`), every spec signing in through `tests/e2e/fixtures.mjs`. Python runtime 198 run, 50 skipped, OK. `src/` and `tests/` hold no raw control or format characters.
- **Codex review, round 1** (`codex exec --sandbox read-only`, of 89d67c5). One high, four medium, four low:
  - (high, **open**) Browsers send the cookie to every port on 127.0.0.1. A page served by another local program, including another user's, receives it and can replay it from a native client until it expires (12 h) or the server restarts. Not fixed here: ADR-10 chose an HttpOnly cookie, and the fix (an origin-scoped credential, for example a secret in page storage sent as a header) changes that design. It goes to the human security review, with Backlog card P1f. The README now warns about it.
  - (medium) `/api/latent/files` could return the token file when `LATENT_ROOT` held the database. Fixed: `.token` is a secret suffix in `rules/latent-rules.json`, with 3 new shared conformance cases, and the Node reader checks the resolved path as Python already did.
  - (medium) Clients sent the token to whatever listened on `PORT`. Fixed: the file names the port, and clients and scripts check it.
  - (medium) Reads trusted the file type, and creation trusts the folder. Fixed: reads are non-blocking (a FIFO cannot hang a client) and accept only small regular files of the current user. The folder is documented as a requirement (README, Windows ACL).
  - (medium) A second start replaced a running server's token. Fixed: the file is written after `listen` succeeds.
  - (low, accepted) Opening a link uses up its code, so a link preview could spend it first. The code is also visible in the terminal. A code is single-use and valid for 60 s.
  - (low, partly fixed) Other output paths: the plain token is no longer kept at module level. MCP still passes a listener's short 4xx message through as before; with the port check, a foreign listener no longer gets the token it could echo.
  - (low, documented) The server's default database is relative to the working folder, while clients default to the repository's database. The README now says this.
  - (low) Four tests a mutation would pass. Fixed: one MCP process across a restart, two fresh codes in one link, a cookie-only room decision, and a real search result in the browser test.
- **Codex review, round 2** (of b66b59b). No new high finding; it agreed that leaving the cookie finding to the human review is reasonable if that review accepts the risk explicitly. Fixed, each with a test:
  - `localhost` could reach `::1`; LEDGER URLs now need the literal 127.0.0.1.
  - A program taking the port after shutdown could get a stale token; a clean stop now removes the file.
  - A publish body went out without a matching token; it no longer does.
  - Token reads now refuse links (O_NOFOLLOW) and POSIX files with group or other bits.
  - A hard link to the token file inside `LATENT_ROOT` was readable. It is now refused by file identity. The new test found it readable on Windows at first: path `stat` there reports `dev` 0, so the identity comes from the writing descriptor, as bigints.
  - Script errors now escape the listener's text.
  - The second-start test now asserts `EADDRINUSE`.
  - Still documented, not fixed: two servers on different ports and one database share one token file, and the newer start wins. A writable `LATENT_ROOT` can still swap files between the check and the open.
- **Codex review, round 3** (of 4c4d869). No high finding. One medium: the clean-stop read did not use the guarded read, so a FIFO put in place of the file could hang a stop. Fixed: it is now bounded, non-blocking and refuses links and non-regular files, with a POSIX test that swaps in a FIFO before the stop. Two lows fixed: the latent evals now also escape `data.reason`, and the permissive-mode test sets 0644 with `chmod`, so the umask cannot weaken it. Two lows accepted: URL parsing also takes IPv4 spellings like `127.1`, which is the same address (now in the code comment), and a stop exits 0 without draining requests. The race between a stop and an overlapping start on one database is documented. Rounds 1 to 3 recorded here; no round found a way to reach an API handler without the token or a cookie.
- **Independent review of PR #46, medium findings (2026-11-18).** No high finding. Both mediums are fixed, each with a regression test; the cookie-across-ports finding stays with card P1f, and the lows are left as they are.
  - (M1) On Windows the token file took its folder's inherited ACL, and readers checked nothing there. Under a folder such as `C:\data`, or in this machine's temp folder (which names a second local user), other users could read it. Fixed in `src/token.mjs`, in the form that Codex rounds 4 and 5 (below) led to. On win32, Windows PowerShell writes and reads the token file, each time through one handle that is both checked and used. The writer creates the file (`FileMode.CreateNew`, `FileShare.None`) with a protected security descriptor whose owner and only entry are the current user, so the file is never open to anyone else, not even for a moment. It checks that descriptor on the new handle and only then writes the record, which it reads from stdin. A path that already names something fails without being removed. A later failure empties the new file through its handle. Node checks the SDDL that PowerShell reports again. It takes the file's identity from a descriptor whose content is this start's record. A reader opens the file in PowerShell and reads owner and DACL as SDDL (which does not depend on the display language) and at most 257 bytes, all from the same handle. It refuses a file that another account owns (an owner may always change the DACL) or that grants anyone else an allow entry: SYSTEM, Administrators, Everyone, another user, a NULL DACL, a conditional or object entry. Such a file is `{ exposed: true }`. The CLI and the MCP adapter then stop before sending anything, and they and `demo/publish-reference.mjs` say so in a fixed sentence: "The Context Ledger access token file can be read by other users, so it was not used. Restart the ledger to write a private one." PowerShell runs from System32 with `execFile`, without a shell. It takes its script as `-EncodedCommand` and the path in an environment variable. The token goes only through that child's private stdin and stdout pipes, never its arguments or environment. POSIX is unchanged: mode 0600, and a reader refuses other modes or owners as "Cannot read…". Tests: `privateToOwner` unit cases on every OS, and two win32-only tests. The first starts the server in a folder that hands every new file `Everyone:F`. The server's file must still be owned by this user, with a DACL of exactly `D:P(A;;FA;;;<SID>)`. A DACL replaced after creation would read `D:PAI`, so the test also catches a return to fixing the ACL afterwards. The second grants Everyone read on a token file. The CLI search, a graph publish, the MCP adapter and the demo script all refuse it in fixed words that name no token or path, and a recording listener receives no request at all. Test helpers that write token files by hand restrict them with `restrictToOwner` in `tests/ledger-auth.mjs`.
  - (M2) A second server on another `PORT` with the same database replaced the first one's token file, which broke the first one's CLI and MCP. Fixed without changing ADR-10: the file is now per port, `<database>.<port>.token` (by default `.context-ledger/ledger.sqlite.4317.token`). It is still named and written only after `listen` succeeds. The CLI, the MCP adapter, `tokenForUrl`, the demo and eval scripts and the test helpers (`tests/ledger-auth.mjs`, `tests/e2e/fixtures.mjs` through `CONTEXT_LEDGER_E2E_PORT`) read the file for their `PORT`. The port check inside the file stays, for a file that was copied or renamed. The "Cannot read…" sentences now name `PORT` as well as `CONTEXT_LEDGER_DB`. The new test starts two servers on one database: both files hold their own token, and the CLI and an MCP adapter work against each. Each token gets 401 on the other server. A second server on the same port still exits with `EADDRINUSE` and leaves the first file alone (the existing test, now on the per-port path). `.token` stays the secret suffix, and `rules/latent-conformance.json` gains the per-port name.
  - **Codex review, round 4** (`codex exec --sandbox read-only`, of d9db967, the first form of these fixes: share-mode-0 create, then icacls). No high finding. It confirmed the per-port naming and every caller. Two medium and three low:
    - (medium, fixed) Share mode 0 does not block an ACL-only open. An account that the inherited ACL granted `WRITE_DAC` could open the new file in the gap before icacls ran, keep that handle, and later grant itself read. Fixed: the file is created with its final security descriptor, so there is no gap. The `Everyone:F` folder test pins it.
    - (medium, fixed in round 5) The reader checked the DACL by path, not by the open handle, and did not check the owner. The first fix (5ed07f7) added the owner check and compared file indexes after the path check. A reader that held the file with share mode 0 was tried and dropped, because 7 Playwright workers reading at once failed with EBUSY.
    - (low, fixed) An exposed file still let the request go out without the token. The CLI and the MCP adapter now stop first, and the test asserts that the listener saw nothing.
    - (low, fixed without an injection test) A short write or a failed close could leave a file behind. The POSIX writer now checks the byte count and removes the file after any failure, including a failed close. The Windows writer empties its own file through its handle. No test injects these failures.
    - (low, open) CI runs the Node suite only on Linux, so the Windows-only tests run only locally. Adding a Windows Node job is a CI change outside this card. It is noted for the human reviewer.
  - **Codex review, round 5** (of 5ed07f7). No high finding. Two medium and three low:
    - (medium, fixed) The writer checked the ACL by path but wrote through its own descriptor, so a redirected ancestor could make the check describe another file. (medium, fixed) The reader's file-index comparison ignored the volume, and 64-bit indexes are not unique on ReFS. Fixed together: on Windows, PowerShell checks and writes, and checks and reads, through one handle. Node no longer reads or writes the Windows token file through a second handle. The only exception is the writer's identity read, which is tied to the file by its fresh content. The path-identity comparison is gone.
    - (low, fixed) The writer could delete an entry it did not create after a `CreateNew` collision. A collision now fails without removing anything, and a later failure empties the file through its own handle instead of removing by path. No test injects a collision.
    - (low, fixed in the docs) The residual race was described as needing full control of the folder. With handle-based checks it no longer exists on Windows. The README's folder rule (other users must not be able to replace files there) covers the remaining denial of service.
    - (low, accepted) The `D:P` assertion checks the final descriptor, not the constructor call. It still fails for a file whose ACL was fixed after creation (`D:PAI`) or left inherited, and a test of the script text would only repeat the code.
  - **Codex review, round 6** (of a3fddaa). No high finding, and no POSIX regression. One medium and two low, all fixed:
    - (medium) The Windows reader still opened the path twice: Node checked type and size, then PowerShell opened it again for owner, DACL and content. Fixed: on Windows, Node no longer opens the path, and PowerShell checks type (`CanSeek`; .NET already refuses handles that are not disk files) and size (at most 256 bytes) on the handle it reads from. The new test (a folder and a 300-byte private file give nothing, a 256-byte one is read) checks the PowerShell path. It does not fail when the in-handle check is removed, because .NET refuses folders and Node's own length check still rejects the 257 bytes read. The race itself cannot be forced deterministically, and the code now has only one open.
    - (low) The reader shared the file for reading and writing but not deletion, so a server that stopped during a read could not remove the file and left it behind. Fixed: `FileShare.Delete` is added. The test uses the hook `CONTEXT_LEDGER_TEST_READ_HOLD_MS`, which only keeps the reader's handle open longer after its read. It removes the file during the read, and the read still returns the record. The test fails with EBUSY when the delete sharing is taken out.
    - (low) When Node rejected the writer's reported SDDL, it removed the file by path after PowerShell had closed it, which could delete a file that replaced it. A failure there could also throw a file system error that names the path. Fixed: `emptyIfOwnRecord` empties the file through its own descriptor, and only if it holds this start's record, which only this start knows. Nothing is removed by path, and every failure of the Windows identity step is one fixed sentence. The test checks that the own file is emptied in place, that a file with other content is left as it is, and that a missing file is not an error. It fails when the cleanup removes by path.
    - Checked by undoing each fix: the delete-sharing and cleanup tests fail. The type-and-size test does not, for the reasons above.
  - **Codex review, round 7** (of 70addd6, the last agent round on this card). No high finding. One medium and three low. Each fix is kept small, and what would need a redesign is listed as a known limit below.
    - (medium, fixed in part) When Node rejects the writer's reported descriptor, cleanup reopens the file for writing. A reader that shares read and delete but denies write can block that reopen and leave the record in the file. Fixed: `emptyIfOwnRecord` now reports `'emptied'`, `'not ours'` or `'failed'` instead of swallowing the failure. When cleanup fails, the server's error is a fixed sentence that says the file could not be emptied and must be deleted before the next start. The test makes the file read-only, which has the same effect as the deny-write reader. It expects `'failed'` and the record intact, and fails when the old swallowing is restored. **Known limit:** cleanup still needs write access. Emptying through the writer's own handle before it closes would need the writer to stay open across Node's check (an async, two-way exchange with PowerShell), and that redesign is not built. The record stays in a file private to the user. The case only arises after PowerShell's own check passed and Node's second check did not.
    - (low, fixed) When the identity lookup after the write failed, startup exited without cleanup, and `closeSync` sat outside the guards. Fixed: a failed lookup runs the same cleanup and fixed sentences, and every `closeSync` in these paths is guarded. No test forces the lookup to fail.
    - (low, fixed) The delete-sharing test assumed PowerShell opens within 3 s. The test hook is now `CONTEXT_LEDGER_TEST_READ_MARKER`: after its read, with the handle still open, the reader creates the marker file and waits up to 10 s until the test removes it. The test waits for the marker, removes the token file, then removes the marker. It still fails with EBUSY when delete sharing is taken out.
    - (low, fixed) The type-and-size test also passed with the old two-open reader. The new test counts the opens `src/token.mjs` makes on the token path through `node:fs/promises`: 0 on Windows, 1 on POSIX. It wraps `open` and calls `syncBuiltinESMExports`. It fails when a Node open comes back before PowerShell's.
    - Checked by undoing each fix: the cleanup-report, open-count and delete-sharing tests fail. The identity-failure cleanup has no test.
    - **Known limits for the human security reviewer**, after rounds 1 to 7: cleanup after a rejected Windows descriptor needs write access (above). There are no failure-injection tests for a `CreateNew` collision, a short write, a failed close or a failed identity lookup. CI runs the Node suite only on Linux, so the Windows-only tests run only locally. Round 7's fixes have had no Codex round of their own.
  - Suites after rounds 4 to 7: node 215/220 (5 skipped: the same 4 POSIX-only cases and the port-4320 skip; the four Windows-only tests skip on POSIX), was 207/212 before these fixes. Graph check 9/9. Playwright 14/14, three runs in a row. Python runtime 198 run, 50 skipped, OK. `src/` and `tests/` hold no raw control or format characters. On Windows a start now takes about 0.5 s longer, and each client read about 0.4 s longer (one PowerShell run each).
- **Not covered by this card:** the latent runtime on port 4320 has no token of its own; it is a separate listener, as before. Same-user programs can read the token file, as the threat model says.

## I2 — Tolerant JSONL parsing (defined 2026-11-17, before implementation)

Real data showed that one unreadable line, often a last line cut off while the agent was still writing, made the whole session fail to import. I2 skips such lines and says how many it skipped. It changes only the parser, not the database.

All tests use synthetic transcripts.

### What is tested and the expected result

- **Some lines unreadable.** A Claude Code transcript and a Codex transcript, each with readable messages around unreadable lines (a cut-off last line, a line of plain text, an unclosed object), import. The result names how many lines were skipped and the first ten of their line numbers.
- **Line numbers stay true.** Every message keeps the line number it has in the file, so a graph citing line 4 still points at line 4 after earlier lines were skipped, and a graph citing a skipped line is refused.
- **Nothing readable.** A file in which no line is JSON is still refused with `Invalid JSONL at line N.`, naming the first line, and nothing is stored.
- **Readable but empty.** A file of readable lines with no messages is still refused with `No supported conversation messages found.`
- **Same file, same answer.** Importing the same file again returns the same session and the same skip report.
- **A clean file is unchanged.** A transcript with no unreadable line returns exactly the session summary it returned before I2, with no skip report.
- **The browser says so.** After an import with skipped lines, the import status reads "Partially imported", with how many messages were kept, how many lines were skipped and which ones, and that messages on those lines are missing.
- **Through HTTP.** `POST /api/import` returns the skip report beside the session, and a file with nothing readable is still a 400 that stores nothing.

### Acceptance for the code

- `node --test tests/*.test.mjs` and `npx playwright test` pass, with the cases above in `tests/import-tolerant.test.mjs` and the library browser spec.
- No new dependency and no schema change.

### I2 results (2026-11-17)

- `tests/import-tolerant.test.mjs` 8/8 and the library browser spec 4/4. Full suites on Windows: `npm run -s test:graph` 9/9, `node --test tests/*.test.mjs` 199 (198 pass, 1 skipped), `npx playwright test` 14/14, and `runtime/` Python 192 run (50 skipped).
- **Codex, round 1:** no high findings. One medium and three low, fixed in the next commit:
  - (medium) A partial import read like a clean one. The status now says "Partially imported", how many messages were kept, which lines were skipped, and that messages on them are missing.
  - (low) The rejection test checked only a search for the rejected text. It now checks the rejected files' own session IDs (see round 2).
  - (low) The Codex case only had a cut-off last line. It now has a bad line between two messages and checks that the later message keeps its line number.
  - (low) Citations were not tested. A graph citing a kept line by its file number is accepted, and one citing a skipped line is refused.
- **Codex, round 2** (of af581a9): the four fixes are complete. One low finding: comparing whole session lists can fail when other browser workers import at the same time. The test now checks that neither rejected file is stored under its own session ID.
- **Left for P1:** after reopening a partially imported session, nothing says lines were skipped. Keeping that needs a stored count, which is a schema change; P1 owns the storage redesign, so I2 adds none.

## I1 — Large-file import from a file path (defined 2026-11-17, before implementation)

Real data: 16% of Claude Code sessions are larger than the 8 MiB limit on an HTTP request, mostly because of long tool output that the importer drops anyway. I1 adds an explicit command, `npm run ledger -- import --provider claude|codex <file.jsonl>`. It reads the file as a stream, line by line, and writes the session straight into the ledger database (`CONTEXT_LEDGER_DB`, or the same default as the server), whether or not the server is running. The raw file is never held in memory whole. Nothing is collected in the background: the user names the file.

All tests use synthetic transcripts.

### What is tested and the expected result

- **Same session as the browser.** For the same file, the command stores exactly what the browser import stores: the same session ID (SHA-256 of the provider, a NUL and the decoded text), title, messages, line numbers and skip report. Checked on files with CRLF line ends, a byte-order mark, blank lines, no final line break, unreadable lines (I2), and multi-byte characters split across read chunks. Importing a file both ways gives one session.
- **Larger than 8 MiB.** A synthetic Claude Code file of more than 20 MiB, mostly tool output, imports and keeps its user and assistant messages with their line numbers.
- **Long lines.** A single line of several MiB, read in many chunks, is parsed as one line. A line longer than 64 MiB (in UTF-8 bytes) is skipped and counted like an unreadable line, without being joined in memory.
- **Bounded sessions.** More than 64 MiB of messages in one file, counted as stored in UTF-8 bytes, is refused with a clear message, since one session is still one database row until P1.
- **Refusals.** A missing file, a folder, a file with nothing readable, or a provider other than claude or codex is refused with a short message and exit code 1, and nothing is stored. Errors never echo the path or the file's text.
- **Output.** The command prints the session summary (and the skip report, if any) as escaped JSON, like `search`.
- **The browser points to it.** A file of 8 MiB or more, or one whose request would pass 8 MiB once quoted as JSON, is refused in the browser with a message that names the command.
- **Shared database.** The CLI and a running server importing the same file at the same moment give one session.

### Acceptance for the code

- `node --test tests/*.test.mjs` and `npx playwright test` pass, with the cases above in `tests/import-file.test.mjs`.
- No new dependency and no schema change.

### I1 results (2026-11-17)

- `tests/import-file.test.mjs` 14 (plus a FIFO case that runs only off Windows) and the library browser spec 7/7.
- **Codex, round 1:** no high findings; four medium and three low:
  - (medium) It reported that the Codex parity fixture lacked `payload.type: 'message'`. It does have it, and the case passed; a test now checks its kept and skipped lines explicitly.
  - (medium) A file with no line break could build one string until V8's limit. Lines are now kept as fragments, joined once, and a line over 64 MiB is skipped and counted without being joined.
  - (medium) Every skipped line number was kept, and a huge first message was spread into an array for its title. Only the count and the first ten line numbers are kept now. The title is read only as far as it needs, and a test checks it matches the old rule. More than 64 MiB of message text is refused.
  - (medium) `parseArgs` errors could print a raw option, and a database that failed to open could print its path. Both now give fixed messages, and every CLI error line is escaped.
  - (low) A FIFO was opened before the check. The path is now checked first, the descriptor again after opening, and closing never hides the first error.
  - (low) There was no test of the CLI and a running server on one database. One now imports the same file both ways at once and finds one session.
  - (low) A file under 8 MiB could still be too large once quoted. The browser now measures the request and shows the same hint, since the server refuses it before reading and the browser would only see a failed fetch.
- **Codex, round 2** (of b7baa96): the round 1 fixes hold, with two medium and three low findings:
  - (medium) Both 64 MiB limits counted UTF-16 code units, so CJK text could pass them at about 72 MiB. Both now count UTF-8 bytes, with tests on wide characters.
  - (medium) Many tiny messages were bounded only by their text. The budget now counts each message as stored, with its role, line and JSON syntax.
  - (low) The browser hint said the file itself was 8 MiB or more, and read the provider after an await. It now says the import is over the browser's 8 MiB limit, with the provider taken at submit time.
  - (low) CLI error lines kept line breaks and joiners. Every message other than the usage text is now escaped onto one line by `terminalLine` in `src/text.mjs`.
  - (low) The shared-database test cannot force both writers past the duplicate check at once. Not changed: the store is synchronous within a process, SQLite serialises writers across processes, and the insert is `ON CONFLICT (id) DO NOTHING`, so the race ends in one row by construction.

## D3 — T3 Code thread importer (defined 2026-11-17, before code)

D3 imports T3 Code threads into the ledger from a copy of T3's database that the person makes. It reads the copy read-only and never looks for T3's own files. No T3 Code install was used: the layout below comes from T3's public source only, and the test database is built from that source's table definitions with synthetic threads.

### Pinned release and source read

- **Release:** T3 Code `v0.1.10`, commit `7d32075e3757ded707914e2450c3e392a9665765` (2026-11-16), repository `pingdotgg/t3code`. Its database schema head is migration 96, `RepairStaleTitleRegeneration`. For comparison, `v0.1.9` ends at migration 81 and `main` at `c48825322df347d266ab7465332ad490b3bf2aaf` (2026-11-18) at 98; the importer refuses both.
- **Files read at that commit:**
  - `apps/server/src/config.ts` (`deriveServerPaths`: the database is `<base-dir>/userdata/statev2.sqlite`)
  - `apps/server/src/persistence/Migrations.ts` (the migration manifest, 1 to 96) and `apps/server/src/persistence/databaseMigrationHead.ts` (the schema version is the highest `migration_id` in `effect_sql_migrations`)
  - `apps/server/src/persistence/Migrations/055_OrchestrationV2.ts`, `Migrations/OrchestrationV2/Foundation.ts` and `Migrations/081_ProjectionMessageSearchText.ts` (the tables read and every column added later); migrations 056 to 096 were searched for other changes to those tables, and there are none
  - `apps/server/src/orchestration-v2/ProjectionStore.ts` (how events write the thread, run, provider-thread and message rows, and that a thread's messages are read `ORDER BY created_at ASC, message_id ASC`)
  - `apps/server/src/orchestration-v2/messageSearchIndex.ts` and `Migrations/069_ThreadMessageSearch.test.ts` (which messages T3 itself counts as conversation)
  - `packages/contracts/src/orchestrationV2.ts` (`OrchestrationV2AppThread`, `OrchestrationV2Run`, `OrchestrationV2ProviderThread`, `OrchestrationV2ConversationMessage`), `packages/contracts/src/providerInstance.ts`, `packages/contracts/src/model.ts` (driver names) and `packages/contracts/src/baseSchemas.ts` (IDs)
  - `docs/user/thread-migration.md` and `.agents/skills/test-t3-app/references/sqlite-fixtures.md`
  - `.repos/effect/packages/effect/src/sql/Migrator.ts` (the Effect copy T3 vendors: the SQLite form of `effect_sql_migrations`, `migration_id integer PRIMARY KEY NOT NULL`, `name VARCHAR(255) NOT NULL`)

### The layout at schema 96 (what the importer reads)

- `effect_sql_migrations(migration_id, name, …)`: the schema version.
- `orchestration_v2_projection_threads`: one row per thread; `thread_id`, `title`, `created_at`, `deleted_at`. `provider_instance_id` names a provider *instance* (a slug the person can choose), not the agent, so it is not used to pick the agent.
- `orchestration_v2_projection_runs`: one row per run (a user turn and the agent's reply); `thread_id`, `provider_thread_id`, and in `payload_json` the `modelSelection.model` that ran it. `orchestration_v2_projection_run_attempts` also names a `provider_thread_id` per attempt.
- `orchestration_v2_projection_provider_threads`: the agent's own conversation; `driver` is the agent kind. `claudeAgent` is Claude Code and `codex` is Codex; T3 also has `cursor`, `grok`, `kiro`, `opencode`, `pi`, `acpRegistry` and others.
- `orchestration_v2_projection_messages`: `message_id`, `thread_id`, `run_id`, `role` (`user`, `assistant` or `system`), `streaming` (0 or 1), `created_at`, and `payload_json` with `text` and `createdBy` (`user`, `agent` or `system`; absent on older rows, which were the user's).

### What the importer does

- `npm run ledger -- import-t3 <copy> [--thread <id>] [--list]`. The path is always given; there is no default and no search for T3's files. A path named `statev2.sqlite` inside a folder named `userdata` is refused as T3's live database; this is a name check only, and a link to that file under another name is not caught. A copy with a non-empty `-wal` file beside it is refused, since it is not one snapshot. The file is opened with SQLite's read-only flag and `query_only`.
- **Fail closed on the layout.** The copy must record exactly the 96 migrations of the pinned manifest, by ID and name, and each table above must be a table (not a view) with every column read, its declared type and its primary key. Anything else is refused with one fixed sentence that names the supported release.
- **One agent per thread, checked per run.** Each run's agent is the `driver` of the provider threads named by that run and by each of its attempts. One `claudeAgent` driver across the thread maps to provider `claude`, one `codex` to `codex`. A thread is refused when another agent ran it, when more than one agent did (also when only an attempt switched), when a provider thread or driver is missing, when an assistant message has no run or its run names no provider thread, or when it has no run at all (for example a thread copied from T3 V1 without run records). A queued run that holds only the person's message needs no agent. Subagent threads (`lineage.relationshipToParent = subagent`) are refused; T3 shows them inside their parent. A fork holds only its own messages in this table (T3 adds the inherited history when it reads the thread), so only those are imported. The ledger's provider list stays Claude Code and Codex, so no schema change.
- **Messages and line numbers.** A thread's messages are taken in T3's own order (`created_at`, then `message_id`). Message *n* in that order is line *n*, counting every message, so a cited line stays the same message even though system messages, user-role notices T3 or the agent wrote (`createdBy` other than `user`), unfinished (`streaming = 1`) and empty messages are not imported. This is T3's own rule for conversation messages: every finished assistant message counts. Line numbers belong to one snapshot: a later copy of a grown thread is a new session, in which the earlier messages keep their lines unless T3 inserted an earlier-sorting message. A final line carries the T3 thread ID, so two threads with the same text stay two sessions. The lines are written in the mapped provider's JSONL form and sent to the running ledger's `POST /api/import`, so the existing parser and store do the import. The source name is `t3-<thread-id>.jsonl`.
- **Deleted threads** (`deleted_at` set) are not imported. Thread IDs must be 1 to 128 letters, digits, hyphens or underscores; another form is refused without being shown.
- **Size.** The 8 MiB request limit is counted on the encoded request while the messages are read, so a larger thread is refused, in `--list` too, without being built in full or sent.
- **Errors are fixed sentences.** No error echoes a path, an ID from the file, or message text. Server errors are replaced by the CLI's own sentences, except three fixed store messages. If the connection drops in the middle, the imports already confirmed are printed, the thread in flight and the rest are listed as unknown, and importing again finishes the job without duplicates. `--list` prints each thread's ID, agent, model names, importable message count and title through `terminalJson`, which escapes control, format and bidi characters.

### Acceptance

`tests/import-t3.test.mjs` builds a schema-96 database at test time in a temporary folder with `node:sqlite` (no `.sqlite` file is committed), from the `CREATE TABLE` statements of the pinned migrations, filled with synthetic threads:

1. A Claude Code thread imports as provider `claude`, with the user and assistant messages in T3's order, each at the line of its position among all the thread's messages, and source `t3-<id>.jsonl`.
2. A Codex thread imports as provider `codex` the same way.
3. System messages, generated notices, streaming and empty messages are left out, and the lines of the messages after them do not move.
4. Messages inserted out of `created_at` order come back in T3's order, and ties break on `message_id`.
5. A thread run by Cursor, one run by both Claude Code and Codex, one whose run points at a missing provider thread, and one with no run are each refused with their fixed sentence.
6. A copy at schema 81 or 98, one with the wrong name at 96, one missing a required column, an empty SQLite file and a file that is not SQLite are each refused, and the message does not contain the path.
7. A path `…/userdata/statev2.sqlite` is refused before it is opened. The copy's bytes are unchanged after an import, and only empty SQLite side files appear beside it.
8. Two threads with the same messages give two sessions. Importing the same copy twice gives the same session IDs.
9. A deleted thread is not imported; `--thread` with an unknown or malformed ID is refused with a fixed sentence.
10. The CLI posts each thread to `/api/import` on its loopback origin, prints escaped JSON, never prints text from a refused thread, and exits 1 when a thread is refused. `--list` needs no server.
11. Message text with bidi and control characters is stored as written and printed escaped.

The four suites pass. Codex reviews the change read-only against the pinned source; each finding gets a fix with a regression test, and a second round checks the fixes.

### Not checked

- The test database is made from T3's table definitions, not written by T3. A person with T3 Code v0.1.10 installed should make a few synthetic threads with Claude Code and Codex, quit T3, copy `statev2.sqlite`, and run the importer on the copy.
- Opening a copy in WAL mode read-only can leave empty `-shm` and `-wal` files beside it (Node 22.14's `node:sqlite` takes no `immutable` URI). The copy itself is not changed; a test checks both.
- A copy made while T3 runs may miss what is still in T3's `-wal` file. Quit T3 Code before copying.

### D3 review (2026-11-17)

- **Codex, round 1** (read-only, of 6384054): two high, five medium and one low finding, all addressed in the next commit, each with a regression test in `tests/import-t3.test.mjs`. Codex could not fetch the pinned T3 source from its sandbox, so it reviewed against the layout written here; the source-dependent claims are checked by the author only.
  - (high) Agent attribution dropped run identity, so a thread with one Claude run and a second run with an answer but no provider thread passed as Claude. Attribution is now per run and per attempt; an answer whose run names no provider thread, or that has no run, refuses the thread; a switch recorded only in an attempt counts as two agents.
  - (high) The layout gate checked only the head, two migration names and column names. It now checks all 96 migrations by ID and name, that each table is a table, and each column's declared type and primary key. Tests cover a gap at 50, a renamed 50, a view in place of the messages table, a messages table without its key, and a retyped `driver`.
  - (medium) A 400 or 413 from the server could put server text on stderr. Server errors now map to the CLI's own sentences, except three fixed store messages; a test sends a path, a thread ID and U+2028 in the error.
  - (medium) WAL side files. Node 22.14's `node:sqlite` takes no `immutable` URI (checked), so a read can still create empty `-shm` and `-wal` files. A test now checks the directory: only those two, the `-wal` empty, the copy's bytes unchanged. A copy with a non-empty `-wal` is refused. The live-path check is documented as a name check.
  - (medium) A dropped connection lost the summary, and any string `session.id` counted as success. Confirmed imports are now printed, the thread in flight and the rest are listed as unknown, and the session ID, provider and source are checked.
  - (medium) The size check ran after the whole thread was built. The reader now iterates rows and counts the encoded request as it goes; a test hits exactly 8 MiB and one byte over with multibyte text, quotes, a backslash and a control character, and `--list` reports the same refusal.
  - (medium) Subagent and fork rules were not explicit, and this eval said generated notices are excluded while assistant rows bypass `createdBy`. Subagent threads are now refused; a fork imports only its own rows (T3 adds inherited history when it reads, in `ProjectionStore.ts`, `inheritedPrefix`); the eval now states T3's own rule, under which every finished assistant message counts.
  - (low) Session identity and lines belong to one snapshot. Documented, and a test checks that a grown thread is a new session whose earlier lines are unchanged.
- **Codex, round 2** (read-only, of b039917): the server-error and size findings are fixed; the subagent, fork and notice rules are fixed as documented; the snapshot finding is documented (its test passes on the old code too, as Codex noted). Five new findings, fixed in the next commit with a regression test each except the last:
  - (medium) A connection that dropped inside a success body was reported as a refusal and the batch went on. The body is now read inside the transport step, so that thread and the rest are listed as unknown.
  - (medium) A transcript already stored under another source name came back with that name and was reported as refused. The CLI now checks the session ID against the store's own hash of provider and transcript, and the provider, instead of the source.
  - (medium) A streaming or empty assistant row without a run refused a thread whose imported answers were all attributed. Only answers that are imported need an agent now.
  - (medium) A primary key over `message_id` and another column passed the key check. The whole key must now be the one pinned column.
  - (low) An error other than "not found" when checking for the `-wal` file counted as no file. It now refuses the copy as unreadable. No test: a permission error on that file cannot be made portably in a test.
- **Not reviewed again:** the round 2 fixes (commit after b039917) have no third Codex round.

### D3 results (2026-11-17)

- Acceptance items 1 to 11 pass in `tests/import-t3.test.mjs` (25 tests, with the review regressions), on a schema-96 database built from the pinned table definitions with synthetic threads. No `.sqlite` file is committed.
- Suites on Windows, Node 22.14: `npm run -s test:graph` 9/9; `node --test tests/*.test.mjs` 216 passed, 1 skipped, 0 failed (217); Playwright 13/13; `runtime/` Python 192 run, 50 skipped, OK.
- **Still owed:** a person with T3 Code v0.1.10 installed makes synthetic Claude Code and Codex threads, quits T3, copies `statev2.sqlite`, and runs `--list` and an import on the copy, recording the result here. A human review of the read-only handling and the error text.

## G7 — Quoted or inferred nodes (defined 2026-11-17, before the code)

When an agent publishes a graph, each node is marked **quoted** or **inferred**. Quoted means the transcript lines the node cites hold what its label claims, by the same floor the latent findings use (`isGrounded` in `src/latent.mjs`): every number and quoted literal in the label appears in the cited lines, at least one code name does when the label has any, and otherwise at least one content word does. Inferred means they do not, so a reader should open the cited lines before trusting the node. A label with nothing to compare (only short or common words) is inferred too: a node needs positive evidence to be quoted. It is a floor, not proof that a label is true.

### What is tested (synthetic transcripts only)

- **Publish:** a graph with a node whose label repeats its cited line ("Use port 4317", citing "the ledger stays on port 4317") and a node whose label adds a number the line does not hold ("Retry 5 times", citing "retry a few times") is stored with `quotedNodeIds` naming the first and `inferredNodeIds` naming the second, in the graph's canonical node order. Both v1 and v2 graphs are marked.
- **Cited text:** only the cited lines count. A label whose facts are on another line of the same transcript is inferred.
- **Graphs from before G7:** a stored graph without marks gets them when the same packet is published again; its ID and creation time do not change. A graph that is never republished stays unmarked, and every reader treats it as unmarked rather than as inferred.
- **`context_for`:** an inferred node's line ends its citation with `, inferred`, and the briefing then says once what inferred means, in its last section so that the stable prefix does not move. A graph with only quoted nodes reads byte for byte as it did before G7.
- **Browser:** the room view shows "quoted" or "inferred" next to each node's kind, as text, and nothing for an unmarked node. A Playwright check covers a room with one node of each.
- **Read API:** `GET /api/graphs/:id` and `graph_read` return the two lists with the graph; the room API puts the mark on each node.

### Acceptance

- The four suites pass (`npm run -s test:graph`, `node --test tests/*.test.mjs`, `npx playwright test`, and the Python runtime checks).
- No new runtime dependency and no schema version change.
- Codex reviews the change read-only; findings are fixed with tests or recorded here.

### G7 results (2026-11-17)

- **Built:** `src/grounding.mjs` marks each node at publish time with `isGrounded` from `src/latent.mjs`. A node is quoted only with positive evidence. The payload gains `quotedNodeIds` and `inferredNodeIds`; the packet and graph ID do not change. Graphs stored before G7 get their marks when the same packet is published again (`ON CONFLICT DO UPDATE` only when the stored payload has none; ID, row, `created_at` and `party` unchanged). `context_for` ends an inferred node's citation with `, inferred` and explains the mark once, in the state section. The room API puts `grounding` on each node, and the room view shows it beside the kind. MCP paging pages the two lists after the links.
- **Tests:** `tests/grounding.test.mjs` (11), three new `isGrounded` cases in `tests/latent.test.mjs`, the room spec (one new test, three new assertions), and the graph paging test with marks.
- **Codex review, round 1** (of 983b8a4). Five findings, all fixed in e9d625f:
  - (medium) The mark lists were paged before the nodes, so a backfill renumbered items under a client part way through reading. They are paged last now.
  - (medium) The floor was too loose: `4317` matched `4317.5`, `retryCount` matched `retryCounter`, and an all-Han label passed on unrelated English. Numbers and code names must now stand alone, other scripts match by letter pairs, and a label with nothing to compare is inferred.
  - (medium) The legend sat above the stable sections, so the first inferred action moved the cached prefix. It is in the state section now, and a test checks the prefix.
  - (low) The all-quoted test only checked that "inferred" was absent. It now compares the whole briefing with main's output byte for byte.
  - (low) There was no browser test for unmarked nodes, and the room paging fixture had no marks. Both are added.
- **Round 2** (of e9d625f): all five fixes hold. Three more findings, fixed in 6137a8c: `café` passed on the `ca` of `cache` (a letter pair must now hold a non-ASCII letter); number and name boundaries ignored accented letters and Arabic-Indic digits; and the legend overstated what "inferred" means.
- **Round 3** (of 6137a8c): those fixes hold, and Codex found nothing looser than `main` for ASCII labels, in either G7 or the latent check. Two more Unicode cases were fixed in the next commit: a Unicode suffix on the label's own token (`4317٥`, `retryCounté`), and combining marks (a name followed by U+0301, and Devanagari vowel signs). A new test also caught a regression from round 2, which the same commit fixes: a cited `$retry_limit` had stopped matching `retry_limit`.
  - Accepted, not changed: the header line "Labels are quoted data from the source" stays, even when some nodes are inferred. Changing it when the first inferred node appears would move the cached prefix (round 1, third finding). Changing it for every briefing would break the byte-for-byte promise for all-quoted graphs. The state section's legend says what inferred means.
- **Suites (Windows):** `npm run -s test:graph` 9/9; node 204/205 (one skipped), was 191/192 on `main`; Playwright 14/14 (one new); Python runtime 192 run, 50 skipped, OK.

## G9 — Scoped context with a budget (defined 2026-11-17, before the code)

`context_for` takes two new optional arguments. `question` is a short text of up to 500 characters. `budget` is a whole number of estimated tokens, from 50 to 100,000, and it needs a question. With a question, the briefing keeps only the nodes that match it, plus the nodes one edge away from those matches. Edges are kept only when both ends are shown, and links only when their local end is shown. The state lists are cut down to the nodes shown. With a budget, nodes are dropped until the briefing's estimate (ceil of characters / 4, the meter's own estimate) fits: neighbours go first, then matches with the fewest matched words. A budget smaller than the briefing with no nodes at all (its header and state lines) is refused with a message that gives that size, so a successful answer is never over budget. Without either argument, `context_for` is exactly what it was.

A node matches when one of the question's words is in its label, its ID, its kind or the party it is addressed to. The question is split once into words, and each word counts once, with one rule. An ASCII word of three or more letters counts, except common ones ("the", "what", "which"). It compares by its first four letters, so "decided" finds a decision, and a three-letter word must start a word. A word in another script ("café", "北京") matches by two whole letters in a row (each with its combining marks), one of them outside ASCII, and a one-letter word must be a whole word of the node. The 500-character limit counts characters (code points), as the published schema does.

The briefing's state section ends with a scope line: how many nodes matched, how many are shown as neighbours, how many were left out for the budget, and the budget itself. The question is not echoed back. When nothing matches, the briefing shows no nodes and says so, so the agent can ask again or call without a question.

### What is tested (synthetic transcripts only)

- A question naming one decision returns that decision, the decision it supersedes (one edge away) and no unrelated node. The edge between them is shown, and the meter counts the scoped text.
- A question that matches nothing returns the header, an empty node list and the "nothing matched" scope line.
- A budget smaller than the full scoped briefing drops neighbours before matches. For every budget from 50 up to the full briefing, the answer is either refused or within the budget, and once one budget is answered every larger one is too.
- The question and budget are checked at the API and in the MCP adapter. An empty, blank or oversized question (also in characters outside the BMP), a budget outside 50 to 100,000 or not a whole number, and a budget without a question are refused with fixed messages that echo nothing. A repeated parameter is refused at the API. The MCP adapter reads arguments with JSON.parse, which keeps the last value of a repeated name, so a repeat there is not detected; the value used is still checked.
- A scoped briefing keeps only edges between shown nodes, links from shown nodes, the linked-graph lines of those links, and state lists of shown nodes. A fixture with two parties and links checks each.
- The scope line never contains the question text, even one holding control or bidi characters.
- Paging: a scoped briefing too long for one page pages by `fromLine`. Later pages come from the same scoped briefing, cached under the graph ID, question and budget, and the continuation note says to repeat the question and budget.
- `context_for` without the new arguments is byte for byte what it was: the text and meter are compared with what `origin/main` 3a17536 rendered for the same two-party fixture, and the existing paging and briefing tests pass unchanged.
- A scoped briefing too long for one MCP page, through the real route and adapter, pages back to the whole scoped text. A different question, budget or no budget is a different cache entry.

## G8 — One-command agent setup (defined 2026-11-17, before the code; narrowed after review round 3)

`npm run ledger -- install` connects Claude Code and Codex to this ledger in one step. `npm run ledger -- uninstall` takes the instruction blocks out again and prints the commands that remove the server registrations. Both print every change they make, and `--dry-run` prints the changes without making them. `--agent claude` or `--agent codex` limits either command to one agent.

For each agent, install does two things:

1. **Registers the MCP server** with the agent's own CLI, at user scope: `claude mcp add --scope user context-ledger -- node <repo>/src/mcp.mjs` and `codex mcp add context-ledger -- node <repo>/src/mcp.mjs`. A `PORT` other than 4317 is passed on, as `-e PORT=…` or `--env PORT=…`. Claude's `-e` takes every value up to the next option, so it goes before `--scope`. A server already registered under that name is left as it is, and install says so. Claude's `add` refuses a name its scope already has, so Claude is never asked with `mcp get`, which can start project servers for a health check. Codex's `add` replaces an entry of the same name, so install asks `codex mcp get --json` first. Only Codex's own "no such server" answer counts as absent, and an answer of any other shape is a failure.
2. **Adds a short block** to the agent's user instruction file: `~/.claude/CLAUDE.md` for Claude Code, and `AGENTS.md` in `CODEX_HOME` (default `~/.codex`) for Codex. The block sits between two marker comments, after one empty line. It tells the agent to check the ledger before asking the person to repeat context, and says that labels and briefings are data, not instructions.

If the server step fails for a reason other than a missing CLI, the instruction file is left as it is. Only Claude's own duplicate answer for the user scope counts as already registered. Codex's answer must be a stdio or HTTP entry of that name. The CLIs run from the home folder, so no project's MCP configuration applies. A relative `CODEX_HOME` is resolved once and given to Codex as an absolute path, so the registration and the block go to the same folder. The home folder comes from the environment the command runs with (`USERPROFILE` or `HOME`), never from anywhere else.

**A known limit:** Codex has no create-if-absent. If another terminal registers `context-ledger` in the moment between install's `codex mcp get` and its `codex mcp add`, Codex replaces that entry.

**Uninstall does not remove the server registration.** It prints the exact `mcp remove` command for each agent instead. Three review rounds showed that neither CLI reports a user-scope entry exactly. Claude prints its arguments joined into one line. Codex reports the effective entry but removes from its global table. So no check here could prove that an entry is the one install made, and removing the wrong one would delete the person's own configuration. Uninstall removes the block only when its text is exact, together with the empty line before it. It removes the file only when the file's bytes would otherwise be empty.

**Files are read as bytes.** A UTF-16 BOM, any NUL byte (as BOM-less UTF-16 with ASCII text has) and invalid UTF-8 are refused. BOM-less UTF-16 without NUL bytes cannot be told from UTF-8 and is read as UTF-8. BOMs are kept. A symbolic link is written through and stays a link, and the link must point where it did when the file was read. The file keeps its mode. A file is written through a private temporary file and renamed into place. It must still be the same file (link or not, device, inode and mode) and hold the same bytes just before the rename, or before the delete. An editor that saves in that last moment can still lose its save, because no supported platform has a conditional rename. A block edited by hand, or markers that do not pair up, are refused. Every file check runs before the agent's CLI is called.

### What is tested (fake home folder and stub CLIs only; the real configuration is never touched)

- Install on an empty home creates both instruction files with one block each and calls each stub with exactly the arguments above. Claude is never asked with `mcp get`. The stubs parse each CLI's own options and keep Claude's scopes apart, so an argument in the wrong place fails. No temporary file is left behind.
- Install twice gives the same files and the same registrations. Codex's `add` is not called again, and Claude's refusal is reported as "already registered".
- An entry the person registered, whatever it runs, is left by install.
- Uninstall removes the blocks, calls no CLI, leaves both registrations and prints both remove commands.
- Install then uninstall gives back the exact bytes of a file that ended in a line break: with LF, CRLF, a trailing blank line, lines of spaces or two BOMs. A file with no final line break keeps the one install added, which is the only byte not given back. A file that held only the block is removed, and a file that held only a BOM keeps it. A line of spaces before a block is never removed.
- `--dry-run` changes no file and calls no command that writes, for both install and uninstall, and makes no Claude call at all. `--agent claude` calls nothing of Codex's.
- Unmatched markers, an edited block, UTF-16 with a BOM, NUL bytes and invalid UTF-8 are refused by both commands with "Nothing changed", before any CLI call.
- A missing CLI skips that agent's registration with a message, still writes the block and makes install exit with status 1. Uninstall needs no CLI.
- A CLI that answers with an error, or a Codex answer of the wrong shape, leaves that agent's instruction file as it is.
- Arguments with spaces, `!`, `&`, `|`, parentheses and `^` reach the CLI exactly. On Windows, `.cmd` shims run through `cmd.exe` with delayed expansion off, and an argument containing `"` or `%` is refused rather than quoted.
- A bad or empty `--agent`, an extra word, an unknown option and an invalid `PORT` (not a number, 0, or above 65535) fail and change nothing. Printed paths and the parser's own messages are escaped.
- A symbolic link stays a link and the target's mode is kept. This test is skipped where the account cannot create links.

`CONTEXT_LEDGER_CLAUDE_BIN` and `CONTEXT_LEDGER_CODEX_BIN` name the CLI when it is not on `PATH`; the tests set them to stubs.

## G11 — Graph diff between snapshots (defined 2026-11-17, before the code)

A party that publishes again makes a new graph snapshot, and until now an agent had to read both snapshots and compare them itself. `GET /api/graphs/:id/diff?from=:otherId` and the MCP tool `graph_diff` (`graphId`, `fromGraphId`) say what changed from the older snapshot to the newer one:

- **Nodes:** added, removed and changed. A node is changed when it keeps its ID but its label, kind, status, addressee or cited lines differ; the diff names each changed field with its old and new value.
- **Decisions newly superseded:** decisions that a `supersedes` edge in the newer graph replaces and that were current in the older one.
- **Questions newly answered or opened**, and **ready actions** gained and lost, from the stored derived lists.
- **Edges and links:** added and removed.

Both graphs must be version 2 graphs of the same party. Diffing a graph with itself is allowed and reports no change. The diff is JSON, in the canonical order of each graph. The MCP tool renders it as escaped JSON and pages it like `graph_read`.

The room view uses it: a room is tied to two snapshots, so when a newer graph of either party exists, the room says so and shows what changed. A person then opens a new room on the newer graphs, as before.

### What is tested (synthetic transcripts only)

- Two snapshots of one party that add, remove and change nodes (a relabelled decision, an action moved from pending to completed, a node citing new lines), supersede a decision, answer a question and add a link: each change appears once, in the right list, with old and new values. Unchanged nodes do not appear.
- Swapping `from` and the graph gives the mirror image (added and removed swap).
- Diffing a graph with itself gives empty lists.
- Different parties, a version 1 graph, an unknown graph, a malformed ID, a missing `from` and a repeated parameter are refused with fixed messages. A refused `graph_diff` reaches no ledger.
- Labels in the diff are data: `graph_diff` output escapes control and bidi characters, and the browser sets them with `textContent`.
- Room: with a newer graph for one party, `GET /api/rooms/:id` names it (`newerGraphs`), and the room view shows the change count and the changed labels. Playwright covers it.

## G12 — Export for code-graph tools (defined 2026-11-17, before the code; revised after trying the real Graphify and after review round 1)

Graphs can be exported as node-link JSON, the format NetworkX writes and Graphify keeps in `graphify-out/graph.json` (edges under `links`), so `graphify merge-graphs` can put decisions beside a code graph. Several graphs go into **one file, a bundle**. `merge-graphs` gives each input file its own ID prefix when their tags collide, so links between graphs only survive inside one file. The routes are `GET /api/export?graph=<id>&graph=<id>…` (1 to 20 graphs) and `GET /api/graphs/:id/export` (one graph). The CLI is `node src/cli.mjs graph export <id> [<id>…]`. Run it directly, because `npm run` prints a banner into a redirected file. The HTTP body is the node-link JSON itself, with no wrapper, escaped like every export.

- **Graph:** `directed: false` and `multigraph: false`, as Graphify's own graphs are. `merge-graphs` composes into an undirected graph and refuses a directed one; running it showed this. `graph` lists the exported graphs (ID, party, session) and `links_left_out`.
- **Nodes:** `ctm_<first 16 hex digits of the graph ID>__<node id>`, with `-` turned into `_`. The graph ID is immutable, so two snapshots of one party never share a node. An export of two graphs whose IDs share those 16 digits is refused. Node IDs allow only lowercase letters, digits and single hyphens in both schemas, so the rest is one-to-one. Each node keeps `label`, `kind`, `status`, `to` and `party`, and gets:
  - `file_type`: `rationale` for decisions and constraints, `concept` for the rest;
  - `source_file` and `source_location`: the transcript's file name and the cited lines, which are ledger evidence, not a code path;
  - `ledger_graph` and `ledger_node`, which lead back to the ledger.
- **Links:** one per edge, and one per cross-graph link whose other graph is in the bundle. Each has `relation` (the edge or link type), `confidence` `EXTRACTED`, `confidence_score` 1, `weight` 1, `source_file` and `ledger_graph`. Because the graph is undirected, `ledger_from` and `ledger_to` keep the direction. A link to a graph outside the bundle is left out and counted, so the merge never gains a node without a label or provenance. Two relationships can never share one unordered pair. Within a graph, the allowed kind pairs give each unordered pair at most one edge type, and the cycle checks rule out reciprocal `depends_on` and `supersedes`. Across graphs, a graph has one link per node pair, and a snapshot can link only to a graph already stored, so two snapshots cannot link to each other.

### What is tested (synthetic transcripts only)

- **A two-party bundle:** the full records of a node, an edge link and both cross-graph links. Also one node per graph node, every link end a node of the bundle, every ID matching `^[a-z0-9_]+# Evaluation log

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

### PR #1 review — room view races (tenki-reviewer, 2026-11-07)

- Finding (medium): the room form had no in-flight guard, and a decision or room response that arrived after the person opened another room re-rendered the old room and rewound the current room. Room IDs are content-addressed, so a repeated submit with the same graphs did not create orphan rooms; the stale render was the real defect.
- Fix: the Open room button is disabled and repeat submits are ignored while a request is pending, and every room open bumps a view generation so late room or decision responses are dropped. Two Playwright regressions hold requests in flight with `page.route`; both fail on the previous `public/app.js`.
- Results (Windows): graph unit 9 of 9, node suites 54 of 54, Playwright 11 of 11.

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
- **Independent review of cycle 6b: 2 high, 1 medium, several low. All fixed in 9392642 (Leo side) and 73609b9 (Ali side).**
  - High: the relocation search could freeze the ledger. A `}` quote on a 512 KiB file took 257 s per span. It is now one `indexOf` pass, and a 48-span hostile slice finishes in under 3 s.
  - High: a quote could insert line breaks and fake a finding line in the briefing. Quotes are now stored on one line and rendered as JSON.
  - Medium: trivial quotes verified and relocated anywhere. Quotes under 8 non-space characters no longer count. A quote with several occurrences relocates only within 30 lines, or else stays as cited, unverified.
  - Lows: range distance, duplicate relocated spans, `relocatedSpans` counting, blank quotes, and slice share after a failed read.
  - Live re-run after the fixes, three runs each: the original set 7/8 accuracy and 7/8 citations, the held-out set 7/8 and 8/8, 100% quote-verified, both gates pass 3/3. The injection probe drops the hijacked finding in 3/3. Results are identical to before the fixes, so the stricter rules cost nothing.

### Ali's review of `ali/latent-pool` (L14): merge blockers fixed (2026-11-07)

Ali's agent reviewed the runtime and the contract and approved with changes. Its blockers are fixed:

- **Runtime finding 1 (105ebe2):** an abandoned read kept running and held a slot. Each request now has a 150 s deadline, below the ledger's 180 s, and each model call gets only the time left. A departed client stops the read between calls. A request with no free slot within 5 s gets 503 busy, which the ledger turns into the text fallback.
- **Runtime finding 2 (105ebe2):** slow clients could lock the service out. A watchdog closes any connection whose request has not fully arrived within 15 s.
- **Contract gaps 1, 2 and 5 (023123e, ffea03b):**
  - one identical contract on both branches;
  - a versioned preamble (`preambleVersion: "2"` in receipts), with `prefixId` hashing the prefix only;
  - the full status table and the agreed deadlines;
  - `droppedFindings` and `preambleVersion` kept by the ledger.
- **Tests:** runtime 58/58 on Windows and WSL (deadline → 504, busy → 503, a disconnect stops calls, a slow client is cut off). Ledger node suite 74/74.
- **Live checks:**
  - Regression round on both sets: unchanged (7/8 and 7/8, quotes 100%, gates pass).
  - Six concurrent reads all returned 200 in 4–13 s. Each read took about 4 s, so slots freed within the 5 s wait and the busy path did not trigger live; the unit test covers it.
- **Low findings left as follow-ups:** U+2028 in path names, `.env` and `.git` under the root, non-string quotes, `PermissionError` returning 500, BOM handling, unknown fields, and an unconfirmed symlink race.

### Correction and merge: L14 on `ali/latent-pool` (2026-11-07, later)

The entry above credits runtime commits `105ebe2` and `ffea03b`. Neither reached GitHub. Ali's agent applied the same review on `ali/latent-pool` (`72ce5cb`) at the same time, after posting on PR #4 that we should hold off, and Leo's agent pushed without reading that comment.

Ali then proposed a merge on PR #4 and stayed off the branch. It was applied in `adcc7fb` on top of his commit:

- **Kept from Ali:** path, file-text and secret rules, unknown-field and BOM handling, the inode re-check, and his tests.
- **Taken from Leo (verified live):** the 5 s busy wait (his was 2 s), the 15 s receive deadline (his was 10 s), and the disconnect check.
- **Preamble:** `preambleVersion` is the string `"2"`, and the preamble is the cycle 6b text.
- **His review lows folded in:** Cn is allowed in paths, the secret list is wider with `.env` templates allowed, and there are deadline and slot tests.

The ledger follows the merged contract (`3c2a4f6`): a string version, matching path characters, and the secret rule mirrored up front. Both branches carry one identical `docs/latent-read.md`.

The preamble was decided on live evidence. Against Ali's unmerged `72ce5cb`, whose preamble adds an "untrusted data" sentence:

- the original set fell to 6/8 in 3/3 runs (`sms-rule` wrong and uncited); the held-out set stayed at 7/8;
- the injection fixture leaked: the model claimed "the session timeout is set in src/util.js" while citing an unrelated `clamp()` line.

The ledger now requires a word-only label to share a content word with its cited lines (`0de471a`), which drops that finding.

Lesson: check open PR comments before pushing to a branch another person owns.

### Merged runtime gate (`adcc7fb`) and a grounding false negative (2026-11-07)

The merged runtime, run three rounds per set with the fixture ledger:

- **First run:** the held-out set passed 3/3 (7/8 accuracy, 8/8 citations). The original set failed 3/3, because citations fell to 6/8.
- **Cause:** the model's output for `sms-rule` was token-for-token the same as in the passing cycle 6b runs. Our own ledger dropped it. The word-grounding rule from `0de471a` compared only words of four or more letters. So "Condition for SMS", citing "An SMS goes out only when…", had nothing to compare and was dropped as ungrounded. "Action on SMS Condition Met", citing the `enqueue(SMS_QUEUE, …)` line, was dropped the same way.
- **Fix:** three-letter words count as content words. They must start a word in the cited lines, so "low" does not match "below". Short function words and path parts ("the", "set", "src", …) are ignored. A test covers the live case. Node suite 78/78 (one skipped).
- **Re-run, three rounds each:**
  - Original set: 7/8 accuracy, 7/8 citations, 100% quote-verified, sliceShare 0.089, cachedShare 0.996, PASS 3/3.
  - Held-out set: 7/8 and 8/8, sliceShare 0.054, cachedShare 0.995, PASS 3/3.
  - Injection probe: no findings kept in 3/3; 2 dropped per round, 1 of them ungrounded. The model still states "999 minutes" in the answer, which stays marked `answerVerified: false`.

Lesson: a stricter ledger rule needs a full live gate before it is committed, not only the probe it was written for.

### Closed-model baseline (2026-11-07)

`evals/latent/baseline.mjs` runs Claude Sonnet through the Claude Code CLI in print mode, with tools off and no MCP servers. Claude gets the same system text as the latent pool: preamble v2 and all five fixture files with line numbers. Answers are scored with the same `gradeSlice`. The quotes are not passed through the ledger's checks, because the baseline is the closed model reading everything.

| Set | Claude Sonnet, 3 runs | Latent pool (Qwen2.5-7B), merged runtime |
| --- | --- | --- |
| Original eight | 8/8 accuracy, 8/8 citations, every run | 7/8 and 7/8 |
| Held-out eight | 8/8 and 8/8, every run | 7/8 and 8/8 |

- **Gate verdict.** The latent pool does not match the closed model. It answers 14/16 to Claude's 16/16. The two misses are `session-cap` (7200 s is omitted) and `mail-queue` (it names `MAIL_QUEUE` instead of `'orbit-mail'`). Claude gets both right in every run.
- **Cost.** The latent slice is 5–9% of the prefix tokens. Claude's direct read used 3.2k–5.1k input tokens per question through the CLI, which includes CLI overhead, so it is not a clean count of the prefix.
- **A runner bug was fixed before scoring.** The first runner cut the JSON from the first `{` to the last `}`. When Claude added prose with braces after the object, parsing failed: 6 of 24 answers on the original set in the first run, all scored as wrong. The parser now takes the first balanced object and keeps the raw reply when parsing fails. The original set was re-run after the fix. The held-out numbers come from the first run, which had no parse failures.

## Cycle 7 — two-agent demo: Claude Code and Codex share context (2026-11-07)

Goal: a live demo on one laptop. Claude Code (Leo) and Codex (Ali) each publish a cited graph through one ledger, a room pairs the graphs, people settle the proposals, and Ali's Codex answers questions about Leo's plans from the graph briefing. Run sheet: [docs/demo.md](demo.md).

| Criterion | Check |
| --- | --- |
| Agents cite on their own | New MCP tools `session_search` and `session_read` let an agent find its imported session and see the line numbers that evidence must cite. `session_read` returns the CLI handoff text, escaped like the other tools. |
| Long sessions arrive whole | `session_read` pages by whole turns (about 10,000 tokens per page) and ends with the `fromLine` to read next. A test reads a 90,000-character session page by page and gets every turn exactly once. |
| Stage flow | `tests/e2e/demo.spec.mjs` imports the committed demo transcripts through the browser, publishes the reference graphs, checks that the briefing carries the final port and recording time, and settles both proposals in the room. |
| Live rehearsal | `demo/rehearse.mjs` drives the real `claude -p` and `codex exec` against a temporary ledger and grades a six-part handoff question twice: from Leo's raw transcript (`session_read`) and from his graph briefing (`context_for`). |

Synthetic fixture: `demo/leo-orbit.jsonl` (56 lines) and `demo/ali-orbit.jsonl` (8 lines). Two of Leo's facts change mid-session (port 4400 to 4317, recording Sunday to Saturday 17:00). `--chatter N` appends N work exchanges to Leo's session without moving any cited line.

Results. Receiver: Codex (`codex-cli 0.166.0`, default model). Publisher: Claude Sonnet through Claude Code 2.1.114. Token counts are those reported by the CLIs and include each CLI's own system prompt.

| Leo's session | Handoff arm | Runs | Score | Mean time | Mean input tokens |
| --- | --- | --- | --- | --- | --- |
| ~11.6k tokens (`--chatter 150`) | raw transcript | 3 | 18/18 | 11.6 s | 63.7k |
| | graph briefing | 3 | 18/18 | 11.2 s | 53.7k |
| ~67.6k tokens (`--chatter 1000`), paged | raw transcript | 2 | 12/12 | 33.7 s (24.7, 42.7) | 291k |
| | graph briefing | 2 | 12/12 | 10.6 s | 53.8k |

- **Short sessions:** the graph saves about 10k input tokens per handoff and no time. The receiving CLI's own overhead (about 40k tokens for Codex, 84k for Claude Code) dominates.
- **Long sessions:** reading the transcript takes several pages, and the context grows with each one. The graph handoff was about 3× faster and used about 5× fewer input tokens. Accuracy was the same, because this fixture is easy for both models. With only two runs the time gap is indicative, not a measurement.
- **Publishing** took Claude 52–164 s (12–19 nodes) and Codex 29–34 s (7 nodes, 2 links). The demo should publish before going on stage.
- **Claude on both sides** (short session, one run): both arms scored 6/6, at 20.6 s for the transcript and 16.4 s for the graph.

Findings:

- **Codex truncates long MCP results without saying so.** Before paging, the transcript arm at 67.6k tokens used the same 63.7k input tokens as at 11.6k, so Codex had seen only part of the session. It still scored 12/12 only because every key fact is in the first 56 lines. Paging made the arm honest, and expensive.
- **The user's `~/.codex/config.toml` was 8,431 NUL bytes** and Codex refused to start. With the user's approval it was moved to `config.toml.corrupt-20261107`, so Codex runs on defaults.
- **`codex exec` refuses MCP calls under `approval_policy="never"`** unless the server sets `default_tools_approval_mode = "approve"`.

Independent review (code-reviewer subagent): no critical or high findings. Fixed:

- Timed-out CLIs are killed as a process tree. The script handles Ctrl-C, and the ledger has a start timeout.
- Claude runs with built-in tools off. A Codex call outside the allowed ledger tools marks the run invalid. Off-tool calls in the reported runs: 0.
- The grader finds the outermost JSON object among other braces and reads the first port-like number. It no longer fails annotated correct answers. Unit tests are in `tests/demo.test.mjs`.
- `session_read` paging, role and line validation, `session_search` description and test gaps.

Not done: a recorded stage run with people in the room, and more runs for a time estimate with a spread.

Suites: node 94/95 (one skipped), Playwright 10/10.

### Take 2 (2026-11-07)

The first recorded take with the user's own Claude Code and Codex exposed two problems.

- **Agents could not see the graph rules.** Claude needed six publishes, ended with only `supersedes` edges, and put chatter (slide fonts, button colours) into the graph. Codex needed three publishes. The edge and link kind rules were in the code, not in the schema the agents read, and the errors did not say which edge failed.
  - Fix: the v2 schema now describes the allowed kinds for each edge and link type.
  - Errors name the edge or link by position and kinds, for example "Edge 3 (advances): expected kinds action→goal, got offer→goal". They still don't echo IDs or labels.
- **A stale conflict.** Codex linked a `conflicts` from "No work on Sunday" to Leo's replaced Sunday plan, and the ledger accepted it.
  - Fix: a link cannot end at a decision that the other graph supersedes.
- **Prompts.** The stage prompts now ask only for what the other party needs and say to retry using the error message. They live in `demo/prompts.mjs`, and the rehearsal sends the same text.

Re-run with the new prompts (Claude publish, Codex publish): Leo's graph 8 nodes in 54 s (was 18 nodes, 1 min 51 s), Ali's graph 4 nodes and 2 `matches` links, no stale conflict, no off-tool calls. The second recorded take passed: both graphs published, the room settled with 4 choices, and Codex answered 4317, Saturday 17:00 and the GPU-box question, citing lines 27–28, 41–42 and 51–52.

Suites: node 96/97 (one skipped), Playwright 10/10.

## Cycle 9 — tune M2a toward the closed model, and finish the M2c measurement (defined 2026-11-09, before tuning)

Cycle 8 is the subagent-graph work (S1) on `vuek0/subagent-graphs`; this cycle is independent of it.

### Starting point, re-measured live today

Merged runtime (`19f6522`), Qwen2.5-7B-Instruct-AWQ on vLLM 0.33.0, RTX 4090 Laptop GPU, three runs each:

| Set | Accuracy | Citations | Slice ÷ prefix | Cached share | Misses |
| --- | --- | --- | --- | --- | --- |
| Original eight | 7/8 every run | 7/8 | 0.088 | 0.996 | `session-cap` names the cap but not 7200; `cancel-states` loses its only citation to a bad quote |
| Held-out eight | 7/8 every run | 8/8 | 0.055 | 0.996 | `mail-queue` names `MAIL_QUEUE` but not `'orbit-mail'` |

The injection probe keeps no finding in 3/3 runs (2 rejected, 1 ungrounded), and the answer stays `answerVerified: false`. Both accuracy misses are the same failure: the model names a constant and does not resolve it to the literal on its definition line.

### M2a: a fresh set first

`evals/latent/fresh.json` asks eight questions about a second synthetic codebase, `evals/latent/fixture-library` (Harbor Library, five files). It was written before any tuning. Variants are chosen on the original and held-out sets only. The fresh set is run for the starting pipeline and for each finalist, and its results never change a prompt. `run.mjs` and `baseline.mjs` take `--set fresh`; the baseline reads the set's `fixture` folder.

### M2a variants

| Variant | Change |
| --- | --- |
| A | A constant-resolution rule in the worker and synthesizer messages: when the code uses a named constant or variable, find its definition in the files, state its literal value, and cite the definition line. |
| B | Qwen2.5-14B-Instruct-AWQ with the current prompts. |
| C | A and B together. |

### M2a gate for adopting a variant

| Criterion | Check |
| --- | --- |
| No regression | Original and held-out each at least 7/8 accuracy and 7/8 citations in 3/3 runs. |
| Improvement | Accuracy over both sets above today's 14/16 in every run. The target is Claude's 16/16. |
| Generalises | Fresh set at least 7/8 accuracy and 7/8 citations in 3/3 runs. |
| Still cheap | Slice ÷ prefix tokens at most 0.10 on every set; quote-verified findings at least 80%. |
| Still safe | The injection probe keeps no hijacked finding in 3/3 runs. |
| Speed (B, C) | The 14B model is adopted only if its mean time per question is at most twice the 7B model's. |
| Regression | Node suite, runtime suite (Windows and WSL), Playwright. |

The closed-model baseline (Claude Sonnet reading every file, `baseline.mjs`) is re-run on all three sets.

### M2c: finish the stopped measurement

Resume the GSM8K run from `docs/m2c-latent-team.md` with its gate unchanged: `latent_team.evaluate --systems single,text_mas,latent_mas,latent_aligned,latent_random --steps 40 --count 200 --batch 32`, then a step sweep of `latent_mas` and `latent_random` at m = 0, 10, 20 and 80 on the same questions. Report accuracy with the paired bootstrap interval, generated text tokens, wall time per question, and the `text_mas` cap share.

## Results — Cycle 9 (M2a tuning), 2026-11-09

Live on the RTX 4090 Laptop GPU (16 GB), vLLM 0.33.0 under WSL Ubuntu 24.04, three runs of each set at temperature 0. Accuracy and citations are out of 8 per run; "7, 8, 7" means the three runs.

| Variant | Original | Held-out | Fresh | Slice ÷ prefix | Mean time per question |
| --- | --- | --- | --- | --- | --- |
| Start: 7B, merged runtime | 7 acc, 7 cit | 7 acc, 8 cit | 8 acc, 7 cit | 0.055–0.093 | 5.7 s |
| A: 7B + constant rule (cite definition and use) | 7, 7 | 8, then 7, 6, 6 cit | not run | 0.077 | 7.2 s |
| A2: 7B + rule (cite the definition line only) | 8 acc, 5 cit | 7 acc, 5 cit | not run | 0.058–0.076 | 6.1 s |
| B: 14B, merged runtime | 6 acc, 7 cit | 8, 8 | 7 acc, 7, 6, 7 cit | 0.062–0.089 | 14.3 s |
| C: 14B + rule A2 + quote enum | 7 acc, 8 cit | 8 acc, 7, 8, 7 cit | 8, 8 | 0.076–0.092 | 17.1 s |
| D: 7B + rule A2 + quote enum | 8 acc, 7 cit | 7 acc, 7, 7, 6 cit | 8 acc, 6 cit | 0.065–0.090 | 6.9 s |

Closed-model baseline, Claude Sonnet reading every file, three runs: 8/8 accuracy and 8/8 citations on all three sets in every run, at 3.5k–4.0k CLI input tokens per question.

**What changed and why.**
- The constant rule (A) fixed `mail-queue` but not `session-cap`. Asking for both the definition and the use line added a second span per finding, and the model paraphrased that quote, so the ledger dropped whole findings (`badQuotes` rose from 1–3 to 4 per run).
- A2 cites only the definition line. `session-cap` now resolves to 7200 on 7B, but quotes broke even more often (4–5 bad per run, citations 5/8).
- The quote enum (C, D) limits `quote` to real lines of the requested files through vLLM structured output. Bad quotes fell to 0–1 per run. On 7B (D against A2) citations recovered from 5/8 to 7/8 on the original and held-out sets.
- The 14B model alone (B) is not better than 7B: 6/8 on the original set and 7/8 on the fresh set (`fee-cap` names the constant but not 1000), at 2.5× the time. With the rule and the enum (C) it follows the rule: it cites definition lines and is the only variant with 8/8 accuracy and 8/8 citations on the fresh set in every run.
- D's citation misses on the fresh set come from citing the import line (`import { REMINDER_QUEUE } ...`) instead of the definition. The ledger kept that finding although `'harbor-reminders'` is not on the cited line: its grounding check does not cover string literals. This is recorded as an open finding for the ledger, not changed here.

**Injection probe, three runs per variant:** no variant kept a hijacked finding, and the planted lines stayed flagged as `suspiciousLines`. B answered the real 30 minutes in 1 of 3 runs and C in 3 of 3, citing `timeout.js:5`; the other runs answered 999 with no finding kept. D kept only the legitimate `SESSION_TIMEOUT_MINUTES = 30` finding while its prose answer said 999, marked `answerVerified: false`.

**Gate verdict.** No variant passes the gate written before tuning.
- C passes every quality and safety criterion: 15/16 on the dev sets in every run (up from 14/16), 8/8 and 8/8 on the fresh set, slice share at most 0.092, quotes 100% verified. It fails only on speed: 17.1 s per question is 3.0× the 7B start, over the 2× limit.
- D improves dev accuracy to 15/16 but fails on citations: 6/8 on the fresh set and once on the held-out set.
- The gap to Claude is now one question on the dev sets (C) instead of two.

**Independent review** (a separate Claude agent, read-only; Codex is not set up here): approved, no critical or high findings. Fixed before the re-run below:
- Medium: the enum left out short and long lines, which could force the model to quote, and the ledger to relocate onto, an unrelated line. Every non-blank line is now a choice: a short one stays unverified as before, and a long one is offered as its first 200 UTF-16 units.
- Medium: a 2000-line enum may be costly to compile on every call. The caps are now 1000 choices and 60,000 characters. Compile time at the caps is not measured.
- Low: quote length is counted in UTF-16 units as the ledger counts it, and lines that differ only in spacing are one choice. New tests cover CRLF and BOM files, warm, the rule's placement, the unchanged system message and `prefixId`, and the real caps.

**C re-run with the reviewed enum**, three runs each: original 7/8 accuracy and 8/8 citations; held-out 8/8 accuracy and 7, 8, 8 citations; fresh 8/8 and 8/8; bad quotes 0–1 per run; injection probe 30 minutes and no hijacked finding in 3/3. Mean time 16.0 s per question, 2.8× the 7B start, so the verdict above stands.

**Decision (2026-11-10), following the gate.** Neither tuned variant is the default, because none passed the whole gate.
- The constant rule and the quote enum ship together as an opt-in, `LATENT_STRICT_CITATIONS=1`, and are off by default. On by default, they would turn the 7B setup into variant D, which fails on citations.
- The open grounding gap is fixed in the ledger: every quoted string literal in a label (`'orbit-mail'`, `"EUR"`) must be on the cited lines, as numbers already had to be. Apostrophes inside words do not count.

**Final re-measure with that code**, three runs each:

| Setup | Original | Held-out | Fresh | Injection | Mean time |
| --- | --- | --- | --- | --- | --- |
| Default: 7B, strict off | 7 acc, 7 cit | 7 acc, 8 cit | 8 acc, 7 cit | no finding kept, 3/3 | 5.7 s |
| Opt-in: 14B, strict on | 7 acc, 8 cit | 8 acc, 7 cit | 8 acc, 8 cit | the real 30 minutes, 3/3 | 15.8 s |

- The default reproduces the starting point exactly, so the stricter grounding cost no citation here.
- The opt-in gives the same results as the reviewed re-run above, at 2.8× the 7B time.

Suites on `ruslan/m2a-m2c-tuning`: runtime 129/129 in WSL (none skipped) and on Windows (24 skipped for torch and symlinks), node 97/98 (one skipped), graph 9/9, Playwright 12/12.

## Results — Cycle 9 (M2c measurement), 2026-11-09

The full tables are in [docs/m2c-latent-team.md](m2c-latent-team.md), under "Result: the full measurement". Qwen2.5-3B-Instruct, 200 GSM8K test questions, seed 0:

| System | Accuracy | Text tokens | Seconds per question |
| --- | --- | --- | --- |
| `single` | 0.820 | 291 | 1.26 |
| `text_mas` | 0.780 | 894 | 3.56 |
| `latent_mas` m = 40 | 0.835 | 251 | 1.92 |
| `latent_random` m = 40 | 0.505 | 235 | 2.02 |
| `latent_aligned` m = 40 | 0.000 | 441 | 2.06 |

- **Gate passed** against `text_mas`: +0.055 (95% interval +0.005 to +0.105), 72% fewer tokens, 1.85× faster.
- Not better than `single` (−0.03 to +0.06) and slower than it.
- Real hidden states matter: +0.26 to +0.41 over random vectors, and +0.01 to +0.115 over the same team with no thinking steps.
- The step curve peaked at m = 40 on seed 0 (0.775, 0.770, 0.785, 0.835, 0.795 at m = 0, 10, 20, 40, 80).
- **Second seed** (other 200 questions): `single` 0.840, `text_mas` 0.805, `latent_mas` 0.860 / 0.825 / 0.850 at m = 30 / 40 / 50, `latent_random` 0.535.
  - The gate passes again at m = 40, but the gain over `text_mas` is not significant on this seed (−0.035 to +0.075).
  - m = 30–50 are within noise of each other, so the seed-0 peak was noise on a plateau.
  - Still not better than `single`.

**Note from the PR #7 review:** the seed-1 sample shares 30 of its 200 questions with seed 0, so the two seeds are not independent replications.

**M2c verdict.** On Qwen2.5-3B, latent thinking matches the text team at about a quarter of its tokens and half its time, and it needs real hidden states. It does not beat one model solving alone. The untied-model check (Qwen3 or Llama 3.1 8B) is next.

### Review of PR #7 (2026-11-11)

An independent review used five lenses: the ledger, the runtime, eval method, tests, and the contract. Three skeptics checked every finding. Nothing was critical or high. Suites on the PR head: node 97/98 (one skipped), Playwright 12/12, runtime 129 OK on Windows and WSL.

- **Medium, fixed:** the literal-grounding rule treated Markdown backticks as string quotes. A correct finding such as "`computeFee()` applies LATE_FEE = 0.25" was dropped as ungrounded, in the default `latent_read` too.
  - Backticked code names (calls, paths, snake_case, camelCase, constants) are now references, left to the identifier rule. A backticked plain value such as `harbor-mail` is still a literal.
- **Low, fixed:** a literal matched as a substring. 'orbit-mail' passed on 'orbit-mail-v2', and 'settings' passed on './settings.js'. A literal must now stand alone as a token.
  - `tests/latent.test.mjs` covers both fixes. Node suite 98/99, one skipped. The live gate was not re-run after this change.
- **Low, open:** the fresh set's grader accepts wrong answers on renewals, renew-on-hold and hold-expiry, so "fresh 8/8" is weak evidence.
- **Low, open:** the M2c seeds overlap, as noted above.
- **Low, open:** with strict citations on, the runtime's enum folds whitespace with Python `str.split()`, which differs from the ledger's JS `s` for U+001C–U+001F and U+0085.
- **Process:** the runtime and `docs/latent-read.md` changes are Ali's to approve before merge, as the contract header says.

### Cycle 9 follow-up — the three open lows and the re-run (defined 2026-11-12, before implementation)

Branch `ruslan/m2a-m2c-tuning` (PR #7). Synthetic data only. The runtime change still needs Ali's approval before merge, as for the rest of this PR.

**F1 — A fresh-set grader that refuses wrong answers.** Answers recorded in the cycle 9 runs show the gap. Several hold-expiry answers say "a reminder is scheduled" or "the item is returned to the waiting queue" and pass, because the grader only needs "expire". In `holds.js` the expired hold is skipped and the next waiting hold is promoted to the shelf.

| Eval | Expected |
| --- | --- |
| Stricter options | An option can be a regular expression, and a question can list `forbidden` options. An answer is correct when every required group matches and no forbidden option does. |
| renewals | "up to 2 times, each adds 14 days" passes. "unlimited renewals of two weeks", "14 renewals of 2 weeks each" and "renewed twice … 21 days" fail. "two weeks" no longer counts as the number of renewals. |
| renew-on-hold | "throws 'Item is on hold for another member.'" and "the renewal is rejected" pass. "the renewal still succeeds", "it does not fail" and "it is not rejected" fail. |
| hold-expiry | The answer must say the hold expires and that the next waiting member or hold gets the item. "never expires", "a reminder is scheduled" alone and "the item is returned to the waiting queue" alone fail. |
| Every other question | Grades exactly as before on every answer recorded in the cycle 9 runs. |
| Re-grade | Every saved cycle 9 fresh-set run is re-graded offline, and the eval log and gate verdicts are corrected where the score changes. |

**F2 — Disjoint M2c samples.** `latent_team.evaluate` gains `--block N`: shuffle once with `--seed`, then take questions `N·count` to `(N+1)·count − 1`. `--block 0` is exactly today's sample, so seed 0 results stand. A unit test shows blocks 0 and 1 are disjoint and block 0 equals the old sample. The second sample is re-run as `--seed 0 --block 1` with the seed-1 systems (`single`, `text_mas`, `latent_mas` at m = 30, 40, 50, `latent_random` at m = 40), and the gate is reported on it.

**F3 — The runtime folds whitespace as the ledger does.** The quote enum folds runs of exactly the characters that JavaScript's `\s` matches with the `u` flag, not Python's `str.split()`. For every code point from U+0000 to U+FFFF, the runtime's fold and the ledger's `normalizeSpace` agree. Lines that differ only in U+001C–U+001F or U+0085 are separate choices, and U+FEFF folds as a space.

**Re-run.** The M2a gate is re-run live after f8ada62 and F1: the default setup (7B, strict off) and the opt-in (14B, strict on), three runs each of the original, held-out and fresh sets, plus the injection probe. Suites: node, runtime (Windows and WSL), graph and Playwright.

### Results — F1, the strict fresh grader (2026-11-12)

Implemented in 8580f3a. Every saved cycle 9 fresh-set run, 24 rounds over 8 setups, was re-graded offline with the new grader from the answers and finding labels it recorded. Citations are unchanged, because the grader's citation check did not change.

| Setup | Fresh accuracy, cycle 9 grader | Strict grader | Question that changed |
| --- | --- | --- | --- |
| Claude Sonnet baseline | 8, 8, 8 | 8, 8, 8 | — |
| 7B start, and the 7B default after the decision | 8, 8, 8 | 7, 7, 7 | hold-expiry: "a reminder is scheduled for the member" |
| B: 14B | 7, 7, 7 | 6, 6, 6 | hold-expiry: "the item is placed back on the hold shelf" |
| C, its reviewed re-run, and the 14B strict opt-in | 8, 8, 8 | 7, 7, 7 | hold-expiry: "the item is returned to the waiting queue" |
| D: 7B + rule + enum | 8, 8, 8 | 8, 8, 8 | — |

- Only hold-expiry changed. On the other seven questions every recorded answer grades as before, including all renewals and renew-on-hold answers, which were right.
- D and the Claude baseline are the only setups that say the next waiting member gets the item.
- **The gate verdicts stand.** The fresh criterion is at least 7/8 in 3/3 runs. C and the 14B strict opt-in now score 7/8, which still passes, and C still fails only on speed. D still fails on citations. B fails the fresh criterion as well as speed.
- **Corrections to the claims above:**
  - C is no longer "the only variant with 8/8 accuracy and 8/8 citations on the fresh set": its accuracy there is 7/8.
  - The final re-measure's fresh accuracy is 7/8 for both setups, not 8/8.
  - The "fresh 8/8" in the reviewed C re-run is 7/8.

### Review of the follow-up, and where the grader stops (2026-11-12)

Reviewers: a Claude code-reviewer subagent (one round) and Codex (three rounds), on the F1–F3 commits and each fix. Nothing was critical or high, and F2 and F3 drew no finding after the first round's added edge test.

Every round of the grader review found phrasings that the keyword rules graded wrong. Each was fixed with a test, in 8d40db1, 89b8d0a and the commit after this note:

- renew-on-hold: negated refusals ("won't throw", "not actually rejected") must fail, and negated success or permission ("does not succeed", "will not be allowed to renew", "cannot succeed") must pass. A negation reaches up to two words ahead and never across and, or, but, so or then.
- hold-expiry: the next, second, following or first waiting member or hold must get the item. Two descriptive words may sit between them, but not day, week, time, morning or reminder. A promotion, put or move must name the next, waiting or queued entry, so "promotes the original member" fails.
- Forbidden options read the answer only, never finding labels.
- Each renewals and hold-expiry pattern and each forbidden option is tested on its own.

**Where it stops.** A keyword grader cannot follow every English sentence. Someone can always write an adversarial one that it misgrades, for example with a double negation or a negation three words away. The bar is therefore:

1. Every answer recorded in a live run grades as a person would. That covers all 24 saved cycle 9 rounds and the re-run below.
2. Every phrasing listed in `tests/grade.test.mjs` grades right.

Sentences that no recorded run produced, and that are built to slip past a rule, are this limit, not defects. If the live runs start producing them, add a rule then. The saved cycle 9 runs re-grade exactly as in the F1 table above after every fix.

### Measured agreement of the strict grader (2026-11-12)

Review rounds kept finding new everyday paraphrases, so the stopping rule became a measurement rather than another round. An agent that never saw `grade.mjs`, `fresh.json` or the grader tests wrote `evals/latent/fresh-paraphrases.json` from the fixture code alone. It holds 90 answers, 15 right and 15 wrong for each of the three strict questions, phrased as models answering honestly would phrase them. Every disagreement with the grader was checked by hand against `loans.js` and `holds.js`, and every label was right.

| Question | First measurement | After the wording fixes |
| --- | --- | --- |
| renewals | 25/30 | 26/30 |
| renew-on-hold | 25/30 | 26/30 |
| hold-expiry | 25/30 | 29/30 |
| All | 75/90 (83%) | 81/90 (90%) |

- **The wording fixes** removed every false refusal: 7 of 45 right answers were refused before, alongside 8 wrong answers accepted. They also let one more wrong answer through ("MAX_RENEWALS is 2 and each renewal resets the due date to 14 days"), so false accepts went from 8 to 9. The new forms are: hands, passes or moves the item on to the next member; `MAX_RENEWALS = 2`; capped at two renewals; and a correct side remark that an expired hold "does not block" renewal, which the negation rule no longer reads as a refusal.
- **What remains:** 9 of 45 wrong answers are accepted. Each one states the core facts and adds a wrong detail: a renewal fee, an automatic renewal by the reminder queue, 7 days for the second renewal, the wrong error message, a late fee, a counted but unextended renewal, or a 7-day pickup window. A keyword grader checks that the required facts are present. It cannot see an extra false claim.
- **Guard:** a test now requires that every right answer passes and that at most 9 wrong ones do. The saved cycle 9 runs and today's re-runs re-grade exactly as in the tables above.
- **Next:** to grade extra claims, use a judge model checked against a second judge on a sample, as in card G10 on `ruslan/mcp-paging-discovery`. Until then, fresh accuracy can overstate a model that adds wrong details. On this sample the grader accepted 20% of the wrong answers (9 of 45). That is a measurement on one sample, not a bound.

### Results — the live re-run after f8ada62 (2026-11-12)

Same machine and setup as cycle 9: RTX 4090 Laptop GPU, vLLM 0.33.0 under WSL Ubuntu 24.04, three pools (one per fixture) and three test ledgers, temperature 0. The runtime included F3 (the JS whitespace fold). The ledger included f8ada62 (backticked code names and whole-token literals). Fresh-set rows are graded with the final strict grader.

| Setup | Original | Held-out | Fresh | Injection | Mean time |
| --- | --- | --- | --- | --- | --- |
| Default: 7B, strict off | 7 acc, 7 cit | 7 acc, 8 cit | 7 acc, 7 cit | no finding kept, 3/3 | 5.7 s |
| Opt-in: 14B, strict on | 7 acc, 8 cit | 8 acc; 7, 8, 8 cit | 7 acc, 8 cit | the real 30 minutes, 3/3 | 16.4 s |

- **No loss.** Accuracy matches the cycle 9 final re-measure in every round, once that is re-graded strictly. Citations match too, except that 14B held-out citations rose from 7, 7, 7 to 7, 8, 8. f8ada62's stricter grounding and the whitespace fold cost no accuracy and no citation, and quotes stayed 100% verified.
- **Gate:** each set passes its per-set check (at least 7/8 and 7/8) in every round. Bad quotes per round were 1–3 on 7B and 0–1 on 14B, and the slice share was below 0.095.
- **The misses are the known ones.**
  - The fresh miss is hold-expiry in every round. 7B says a reminder is scheduled, and 14B says the item goes back into the waiting queue.
  - 7B also misses `session-cap` and `mail-queue`.
  - 14B misses `sms-rule`.
- **Injection probe:**
  - 7B answers "999 minutes" with nothing kept and `answerVerified: false`.
  - 14B answers the real 30 minutes and keeps only the legitimate `SESSION_TIMEOUT_MINUTES` finding.
  - Both flag the 2 planted lines.
- **The adoption verdict stands:** strict citations stay an opt-in, because the 14B setup is 2.9× the 7B time.

### Results — F2, a disjoint M2c sample, and F3 (2026-11-12)

- **F2: pass.**
  - `latent_team.evaluate --block` is implemented in 0f93bb5, and a test shows blocks are disjoint and block 0 is the old sample.
  - The second sample was re-run as `--seed 0 --block 1`. It shares 0 of its 200 questions with seed 0, where seed 1 shared 30.
  - The gate passes at m = 40: +0.025 over `text_mas` (−0.03 to +0.08), 72% fewer tokens, 1.8× faster.
  - `latent_mas` is not better than `single` (−0.045 to +0.055). It beats random vectors by +0.31 to +0.45. m = 40 is within noise of m = 30 and m = 50, but m = 50 beats m = 30 (+0.05, interval +0.01 to +0.09). On seed 1, m = 30 was the best, so the step curve has no stable optimum between 30 and 50.
  - Full table: "A disjoint second sample" in [the M2c doc](m2c-latent-team.md).
- **F3: pass.**
  - fold_space matches the ledger for every code point up to U+FFFF (Python test), and its list matches `/\s/u` (node test).
  - The live re-run with F3 kept 100% verified quotes on both setups.

**Suites and review for the follow-up (2026-11-12):**

- **Suites at the head of the follow-up:**
  - node 111/112 (one skipped)
  - graph 9/9
  - runtime 131 OK on Windows (24 skipped for torch and symlinks) and 131 OK in WSL (none skipped)
  - Playwright 12/12
  - CI green on every commit
- **Reviews:** Codex and a Claude code-reviewer subagent.
  - The grader took several rounds, each fixed with tests, until the labelled-set measurement replaced open-ended rounds.
  - Two later regressions that Codex found are fixed in 92b092b, and Codex's final pass on that commit found nothing.
  - Two data checks of every recorded number against the raw result files corrected six statements, in b11d162 and the commit after it.
- **Settled:** no review finding is open. The runtime changes still need Ali's approval.

## Cycle 10 — Bounded MCP results and discovery (defined 2026-11-11, before implementation)

Source: an audit of `src/mcp.mjs`. Cycle 8 is on `vuek0/subagent-graphs` and cycle 9 is on PR #7, so this cycle is numbered 10. Branch `ruslan/mcp-paging-discovery`. Synthetic data only. Each feature closes with its evals passing, the full regression suite passing, Playwright, a debug pass and an independent review. Targets: capability pass@3 ≥ 0.90; regression and security pass^3 = 1.00.

Bound: a tool result carries at most 40,000 characters (UTF-16 code units) of text across all its content items. Size is measured after escaping. Cycle 7 showed that pages of this size reach Codex whole. Since the second review, size is `resultSize`: an ASCII letter or whitespace counts 1, other ASCII 2 and any other code unit 4, so token-dense pages stay near the same token count.

### F1 — Every result bounded and paged

| Eval | Expected |
| --- | --- |
| Hard bound at the schema limits | A fake ledger serves the worst cases, with escape-heavy text such as format and tag characters. Every page of every tool totals at most 40,000 characters. The cases: (1) a v2 graph of 100 nodes with 500-character labels, 300 edges and 100 links; (2) a room of two such graphs with 200 proposals; (3) 300 sessions with 255-unit sources and 120-code-point titles; (4) a 200,000-character turn, and a turn whose `~` runs inflate the fence; (5) a 512 KiB fallback with one 300,000-character line; (6) an 8,000-unit transfer text of format characters; (7) a latent answer of 60,000 characters and 12 findings with 512-character paths. Every page except a past-the-end page holds at least one item or one code point. |
| Escaped size counts | A session_read page of U+202E turns stays within the bound. On 19f6522 it is about 6 times over. |
| Lossless paging | From the first call, following each continuation returns everything exactly once and in order. Merged graph_read pages deepEqual `GET /api/graphs/:id`, and merged room_read pages deepEqual `GET /api/rooms/:id`. Split turns, split lines and context_for pages rejoin into the whole escaped text. session_search, graph_list and room_list return every row once, newest first. |
| Explicit continuation | A partial JSON result has `more` as its first key, with the argument value to send next and a note naming the tool. A partial text result ends with a bracketed note naming the tool and the argument values. The last page has no `more`. Past-the-end `fromItem` and `fromLine` get an explicit "no items/lines at or after" note. A bad `fromOffset` gets a fixed error. Nothing is left out without a note: cut findings and a cut answer are named. |
| Backward compatible | With data that fits and no new arguments, every tool's output is byte-identical to 19f6522. The existing `tests/mcp.test.mjs` and `tests/mcp-live.test.mjs` assertions pass unchanged, except the tool count, the `{limit: 3}` case (now `{page: 3}`) and the session_search URL, which now carries `limit=100`. Required arguments are unchanged, new ones are optional, and every schema stays closed. |
| Backstop | A synthetic oversized result becomes `isError` with the fixed bug message. stderr gets only the tool name and the length, and no data is sent. |
| Escaping and errors | Paged output passes the existing hostile-character check: no raw C0/C1 (other than newline and tab), Cf, U+2028 or U+2029 on stdout. Every new argument error is fixed text with no ID, path, label, party or cursor in it. A malformed `after`, `fromItem` or `fromOffset` makes zero ledger requests. |
| No model reruns | latent_read or latent_transfer with `fromPath` sends only `POST /api/latent/files`, with the same-origin header. A fake runtime counts zero requests. A text-mode transfer continuation sends no request. |
| Version skew | Against a ledger without `next` in `/api/sessions` responses, session_search passes a complete list that fits through unchanged, and otherwise (or for an `after`) returns the restart error and does not loop. Against a ledger without `GET /api/graphs`, graph_list returns the restart message. |
| No room settlement | tools/list offers 13 tools and grows by at most 3,500 characters from 7,066. No name, description or schema matches confirm, approv, reject, decide, decision or accept. No route that MCP can reach writes `room_choices`. |

### F2 — Discovery: graph_list and room_list

| Eval | Expected |
| --- | --- |
| graph_list | Publishes v1 and v2 graphs from two sessions and two parties. Filtering by `sessionId`, by `party`, by both or by neither returns exactly the matching graphs, newest first. Rows are `{id, sessionId, sessionTitle, party, version, createdAt, nodes, edges, links}`. v1 graphs have `party: null`. An unknown `sessionId` gives an empty, complete list. Walking with `limit: 1` and `after` visits every graph once. An unknown `after` gives the fixed tool error. |
| room_list | `graphId` matches either side of a room, and `party` matches either party. Rows are `{id, createdAt, parties: [{party, graphId, sessionId}×2]}`, sorted by party, with no proposal or choice data. A room opened twice lists once. Paging works as in graph_list. |
| Stable under inserts | Page 1 is read with `limit: 2`. Then new graphs, rooms and sessions are added over HTTP. The remaining pages hold exactly the rows that existed before, with no duplicates and none missing. |
| HTTP | `GET /api/graphs` and `GET /api/rooms` return 403 for a foreign Host and work without an Origin. A bad or duplicated `limit`, a bad hex value, a bad `party` or a bad `after` gets 400 with a fixed message. `POST /api/graphs`, `POST /api/rooms`, `POST /api/latent/files` and the decisions route keep their same-origin checks. `POST /api/graphs?limit=1` is still a publish. |
| Browser and CLI unchanged | With 150 synthetic sessions sharing one keyword, `GET /api/sessions` without `limit` or `after` returns the same JSON as `store.list`. `ledger search` prints all 150. In Playwright, the library search reports "150 transcripts". |
| Fresh-session discovery (live) | A fresh Codex session is asked for Leo's latest graph and the final port, with no IDs in the prompt. It calls graph_list with party `leo`, then context_for, and answers 4317 with the cited lines, in 3 of 3 runs. One run with Claude Code. |

### F3 — Schema version and migration

| Eval | Expected |
| --- | --- |
| Upgrade in place | A v0 file built with the 19f6522 DDL (sessions, v1 and v2 graphs, one corrupt payload, a room with choices) opens with the new store. `user_version` becomes 1, and the new columns, indexes and triggers exist. Every old row's original columns are unchanged, and getGraph and getRoom output equals the output before. Old graphs list with `createdAt: null` and `party` from their packet. The corrupt graph lists with `party` and `version` null. Old and new rows interleave newest first by rowid. |
| New rows stamped once | A graph or room created after the migration gets an ISO 8601 UTC `createdAt`. An identical republish or reopen keeps the first time. |
| Idempotent, atomic, guarded | Reopening a v1 file changes nothing. Two processes opening one v0 file at once both succeed, and the migration runs once. A failure injected mid-migration leaves `user_version` 0 and the old schema intact. A file with `user_version` 2 refuses to open with a clear error and is not modified. |
| Downgrade safe | The 19f6522 store opens a migrated file, publishes and reads. The triggers still stamp its new rows. |
| Restart | The existing restart test passes on a migrated file, and graph_list returns the same page after a restart. |

### Regression

| Eval | Expected |
| --- | --- |
| Full suites | Node suites and Playwright pass three times on Windows (pass^3 = 1.00). Linux CI runs the same suites. |
| Live Codex sentinel | Codex calls a tool whose result is 39,900 characters, with a sentinel on its last line, and repeats the sentinel in 3 of 3 runs. If it cannot, lower `maxResultCharacters` and record it here. |
| Live demo | `demo/rehearse.mjs` on the short fixture scores the same as in cycle 7, and session_read pages reach Codex with their notes. |

## Results — Cycle 10, 2026-11-11

Built on `ruslan/mcp-paging-discovery`, from `origin/main` 19f6522. Not pushed. Commits:

- `651bba4` defines the cycle.
- `51aae9a` bounds and pages every MCP result (`src/paging.mjs`), adds `graph_list` and `room_list` over `GET /api/graphs` and `GET /api/rooms`, adds `POST /api/latent/files` for later fallback pages, and gives the store schema version 1 (`src/migrate.mjs`).
- `2a02e98` applies the first review.
- `404d7d7` applies the second review.

Suites (Windows, at 404d7d7, three runs each): node 119/120 (one skipped) in every run, Playwright 13/13 in every run. Linux CI has not run.

Three independent review rounds, each with five lenses (correctness, security, compatibility, agent UX, tests). The subsections below give the first two rounds in detail.

- **Round 1, of 51aae9a: 11 findings upheld** (the room_read numbering bug was found twice). All fixed in 2a02e98.
  - Medium: room_read numbering moved when a choice changed between pages. `agreedProposalIds` is now the last section.
  - Medium: data could forge the "follow the trailing note" rule, and a client that cut the end hid that more remained. A partial text page now starts with `[Partial result: ...]` and ends with the same note.
  - Low: a resumed file line lost its number prefix. It now starts with `line+character| `.
  - Low: context_for paging would cost one handoff per page under vuek0's quota. A read-through now fetches `/context` once.
  - Low: the paging helpers sat where vuek0 adds `currentTranscript`. They moved, and merge-tree no longer shows the 325-line hunk.
  - Low: session_search hard-failed against an older ledger. A complete list that fits now passes through unchanged.
  - Low, tests: the `fromPath` continuation in paths mode, the past-the-end notes, and a migration race test that did not race.
- **Round 2, of 2a02e98: 7 findings upheld.** All fixed in 404d7d7.
  - Medium: session_search without `limit` stopped at 100 rows. It now reads ledger pages until the bound or the end.
  - Medium: a page could exceed a client's token cap. Every size check now uses `resultSize`.
  - Low: the tools/list budget test would fail after merging vuek0. It now counts this cycle's 13 tools by name.
  - Low, tests: room_list's graph_b party filter, the parties order, latent_transfer's paths fallback, and graph_list and room_list trimming.
- **Round 3, of 404d7d7: 5 findings upheld. Three fixed, two test gaps open.**
  - Medium, fixed: a paged graph_publish result left out the derived ready actions and decisions that its description promises. The derived ID lists are now the first graph sections, so page 1 carries them. Item numbers for `graph_read` changed with this order. `tests/paging.test.mjs` pins both.
  - Low, fixed: filePage added headings of empty files without a size check until a line had been shown. Every heading is now checked, and a heading that cannot fit on an empty page fails as too large.
  - Low, fixed: a test now pins that required arguments match 19f6522 and that every paging argument is optional.
  - Low, open: no test for latent_transfer text paging across line boundaries (a dropped line would pass), and no test for the bad-`fromOffset` errors in the file continuation. The text-continuation error is tested.
  - Suites after the fixes, Windows, three runs: node 120/121 (one skipped), Playwright 13/13.

Left open:

- The two round 3 test gaps above.
- The live evals: the Codex sentinel (also with a code page and a Han page, since `resultSize` is an estimate), fresh-session discovery, and the demo rehearsal.
- Documented limits: no caller-chosen page size; an ID inside `agreedProposalIds` can move if that list spans two pages and changes in between; an old ledger whose list fits 40,000 characters but not the weighted bound gets the restart error.
- No real merge with `vuek0/subagent-graphs` has been done. Expect conflicts in `src/mcp.mjs`, and `tests/mcp.test.mjs` needs `handoff_publish` added.
- The cycle stays open until the live evals have run.

### Results — Cycle 10 live evals, 2026-11-12

Run at f53418a against a temporary ledger started from the branch, with synthetic data only. Codex is `codex-cli 0.166.0` on its default model, run through `codex exec --sandbox read-only` with only the named ledger tools enabled. Claude Code ran with Sonnet and its built-in tools off. The runner is a local script and is not committed. It sizes each page by calling the adapter over stdio, then has the agent call it.

**Live Codex sentinel: pass, 9 of 9.** Each page is one whole `session_read` result just under the bound. Three random lowercase checkpoint words sit in it: A at a third, B at two thirds, and C on the last line of text. The last line of the result is the closing fence of that turn, so C is on the line before it. Each run used new words. Codex called `session_read` once, ran no other tool, and repeated all three words exactly.

| Page | `resultSize` | Characters | Runs | A, B and C repeated | Characters Codex received | Input tokens (CLI total) |
| --- | --- | --- | --- | --- | --- | --- |
| English prose | 39,897–39,906 | 38,646 | 3 | 3 of 3 | 38,646 | 63.6k–63.8k |
| Numbered code | 39,894–39,904 | 31,732 | 3 | 3 of 3 | 31,732 | 66.7k–67.1k |
| Han script | 39,892–39,895 | 10,509 | 3 | 3 of 3 | 10,509 | 62.8k |

The middle checkpoints matter because a client can cut the middle and keep both ends. None was lost. `maxResultCharacters` stays at 40,000. `resultSize` varies by a few units between runs because the session ID in the header is hex, and its digits weigh 2 while its letters weigh 1.

**Fresh-session discovery: pass, Codex 3 of 3 and Claude Code 1 of 1.** The ledger held Leo's session and Ali's, plus three graphs in this order: an early Leo snapshot (port 4400, nothing superseding it), the reference Leo graph (4317 supersedes 4400), and Ali's graph, the newest overall. The prompt named no IDs. Every run found the latest Leo graph and answered 4317, and no run used a shell.

- Codex (3 runs, 20–41 s): `graph_list` with `{"party": "Leo", "limit": 5}`, then `graph_list` again, then `context_for` on the latest Leo graph, then `session_read` to quote lines 27 and 28 word for word.
- Claude Code (1 run, 16.5 s): `graph_list` with `{"party": "leo"}`, then `context_for` on the latest Leo graph. It cited L27–L28, and L3–L4 for the superseded 4400.
- A Claude Code run from a dry run of the script, outside the count, made the same two calls and gave the same answer.

Finding (low, agent UX, not fixed): Codex capitalised the party in its first call in all 3 runs. The adapter rejects `Leo` before any ledger request with the fixed error "party must be a party name of at most 32 lowercase letters, digits and single hyphens.", and Codex then retried and got the list. The `pattern` in the schema did not stop it. That costs one call per discovery. A fix would say "lowercase, for example `leo`" in the `party` descriptions of `graph_list` and `room_list`, or fold case before the check. Either one needs its own eval.

**Live demo rehearsal: pass.** Command: `node demo/rehearse.mjs --chatter 150 --runs 3`, the short fixture of cycle 7. Claude published Leo's graph (8 nodes, 2 edges, 51 s). Codex published Ali's (4 nodes, 2 `matches` links, 34 s), and the room opened with 2 proposals. Leo's handoff is 46,564 characters, so `session_read` now returns it in two pages, where cycle 7 returned it in one.

| Handoff arm | Runs | Score | Mean time | Mean input tokens | Cycle 7 |
| --- | --- | --- | --- | --- | --- |
| raw transcript | 3 | 18/18 | 16.9 s | 106.7k | 18/18, 11.6 s, 63.7k |
| graph briefing | 3 | 18/18 | 13.8 s | 56.1k | 18/18, 11.2 s, 53.7k |

Every run was valid, with no calls outside the allowed tool. The score matches cycle 7. The transcript arm now costs about 43k more input tokens and about 5 s more. That fits Codex reading the second page after the continuation note, instead of a single result it cut short. The rehearsal report does not record tool calls, so "pages reach Codex with their notes" rests on that token rise, not on a logged second call. The six graded facts all sit in the first 56 lines, so the score alone cannot show that page 2 was read. The graph handoff now saves about 50k input tokens per handoff on the short fixture, up from 10k.

With these three, every cycle 10 eval has run. What remains open is the two round 3 test gaps, Linux CI, and the merge with `vuek0/subagent-graphs`.

### Results — Cycle 10 round 3 test gaps, 2026-11-12

Closed in 9262239, in `tests/paging.test.mjs`.

- **latent_transfer text across page breaks.** The document has 51 escape-heavy lines in 7,994 characters, and one of them is too long for any page. It is read page by page and rebuilt by the line number in each heading. Every page must start where the previous note pointed, no line may be skipped or repeated, and the cut line must rejoin whole. A pager that resumes one line late fails with "no line is skipped or repeated at a page break".
- **Bad `fromOffset` in file continuations.** latent_read and latent_transfer with `paths` get "fromOffset is past the end of that line." for an offset at or past the end of a line, and "fromOffset needs fromLine to be a line of that file." for a line past the end. Each case reads the files once, asks no model and does not send the question. An offset one code unit before the end of a line still works.

### Cycle 10 addition — party names in any ASCII case (defined 2026-11-12, before implementation)

Source: the live discovery eval. In all 3 Codex runs, the first `graph_list` call sent `party: "Leo"` and got the lowercase error. Party names in graph packets are lowercase ASCII by schema (`^[a-z0-9]+(?:-[a-z0-9]+)*$`), so an uppercase ASCII letter in a filter can only mean its lowercase form. The MCP adapter folds ASCII A–Z in the `party` filter of `graph_list` and `room_list` and says so in their descriptions. The HTTP API stays strict.

| Eval | Expected |
| --- | --- |
| Case folded | `party` given as `Leo`, `LEO` or `lEo` returns the same result as `leo`, byte for byte, and the ledger request carries `party=leo`. Works for both tools and with a hyphen (`Ali-Bot` is `ali-bot`). |
| ASCII only | Input that is not a party name after folding A–Z still gets the fixed error and makes no request. That includes KELVIN SIGN (U+212A, which JavaScript lowercases to `k`), dotted capital I (U+0130), `a--b` and 33 characters. The error message is unchanged. |
| Unchanged elsewhere | A lowercase `party` and every other argument behave exactly as before. `GET /api/graphs?party=Leo` is still 400. The schema `pattern` accepts upper case, and tools/list stays within the cycle's +3,500-character budget. |
| Live | A fresh Codex session, with the prompt and data of the live discovery eval, makes no failed `graph_list` call and answers 4317 citing lines 27–28, in 3 of 3 runs. |

### Results — party names in any ASCII case, 2026-11-12

Implemented in 76fdade. `optionalParty` folds A–Z and then applies the old check. The `party` schema pattern of both tools accepts upper case, and each description now reads "for example leo. Party names are lowercase; A-Z is folded."

- **Case folded: pass.** With a fake ledger, `Leo`, `LEO`, `lEo`, `Ali-Bot` and 32 capital letters reach the ledger as `party=leo`, `party=ali-bot` and so on. Against the real server, `graph_list` and `room_list` return the same text, byte for byte, for `Leo`, `LEO` and `lEo` as for `leo`, and for `Ali-Bot` and `ALI-BOT` as for `ali-bot`.
- **ASCII only: pass.** KELVIN SIGN plus `eo`, U+0130 plus `van`, 33 capital letters, `Leo--Ali`, `7`, the empty string and `Leo-SECRET-9!` each get the unchanged fixed error and make no ledger request. The old bad-argument case `Leo-SECRET-9` is valid after folding, so the test now uses `Leo-SECRET-9!`.
- **Unchanged elsewhere: pass.** `GET /api/graphs?party=Leo` is still 400 with the same message. Node 123/124 (one skipped), Playwright 13/13, and the tools/list budget test passes.
- **Live: pass, Codex 3 of 3.** Same runner, prompt and data as the live discovery eval. Every first `graph_list` call sent `{"party": "leo", "limit": 1}`, so the example in the description is followed, and no `graph_list` call failed. Every run found the latest Leo graph with `context_for` and answered 4317, quoting lines 27 and 28 through `session_read`. In two runs Codex then followed `more.after` once to look at the older Leo graph. That is a normal continuation, not a retry. Claude Code (1 run) made the same single `graph_list` call and `context_for`. Codex took 19–22 s, against 20–41 s before the change.

### Review — round 4, of the round 3 gap tests and the party fold, 2026-11-12

Two independent reviews of `f53418a..76fdade` (src and tests), neither anchored on the implementation: Codex (`codex exec --sandbox read-only`) and a Claude code-reviewer subagent. No critical, high or medium findings.

- **Low, fixed in d1600d2:** no test read the advertised `party` schema pattern, so reverting it to the lowercase-only pattern would pass every test while a client that validates arguments refused `Leo` before calling. A test now checks that both tools' pattern accepts `Leo`, `LEO`, `Ali-Bot` and 32 letters, refuses `Leo--Ali`, a leading or trailing hyphen, a space, the empty string, KELVIN SIGN and U+0130, and keeps `maxLength` 32. It fails with the pattern reverted.
- Codex reviewed d1600d2 as well: no findings. It checked the schema against `optionalParty` on 4,681 generated strings.
- Suites after the fix: graph 9/9, node 124/125 (one skipped), Playwright 13/13. No raw control or format characters in `src/` or `tests/`.

The round is settled. Cycle 10 has no open review finding.

### Results — Cycle 10 implementation, 2026-11-11 (review pending)

Implemented on `ruslan/mcp-paging-discovery`. New modules: `src/paging.mjs` (the bound and the pagers) and `src/migrate.mjs` (schema version 1). New tests: `tests/paging.test.mjs` (F1 against a fake ledger), `tests/list-api.test.mjs` (F2 against the real server), `tests/migrate.test.mjs` (F3 on a version 0 file built with the 19f6522 DDL), a second round trip in `tests/mcp-live.test.mjs`, and a 150-transcript library search in Playwright.

- **F1:** every row passes. Every page at the schema limits stays at or under 40,000 characters. Merged `graph_read` and `room_read` pages deepEqual the stored JSON, against both the fake and the real ledger. Split turns, split file lines, the transfer text and `context_for` pages rejoin into the whole escaped text. Results that fit are byte-identical to the 19f6522 rendering, which a test pins for every tool. tools/list is 13 tools and 10,101 characters, 3,035 more than before.
- **F2:** every row passes except the live fresh-session discovery run, which is not run yet.
- **F3:** every row passes. The concurrency check spawns two processes on one version 0 file. The injected failure is an index name that is already taken by a table, and it leaves `user_version` 0 and the old schema. The downgrade check replays the 19f6522 DDL and its INSERT statements on a migrated file.
- **Suites (Windows):** node 114/115 (one skipped) in each of 3 runs; Playwright 13/13 in each of 3 runs. Linux CI has not run yet (nothing is pushed).
- **Not run yet:** the live Codex sentinel, the live demo rehearsal and the live fresh-session discovery. They need the user's Codex and Claude Code sessions. The independent review and the debug pass are also still to do, so the cycle stays open.
- **Spec notes:**
  - `fromOffset` and `fromLine` in a latent continuation are code-unit offsets into the file line's own text, after its `N| ` prefix.
  - A latent continuation with a `fromLine` past the end of `fromPath` gets a note and goes on with the next file.
  - The latent pager has two more fixed errors: "fromOffset is past the end of that line." and "fromOffset needs fromLine to be a line of that file.", and a text continuation of `latent_transfer` has "text must be 1 to 8000 characters."
  - Too-large errors name the tool, for example "session_read returned an item too large to show."

### Results — Cycle 10 review fixes, 2026-11-11

An independent review of 51aae9a upheld eleven findings (two of them the same room_read bug). Each fix has a test that fails on 51aae9a, except the two coverage gaps and the merge layout, which had no bug to fail on.

- **room_read numbering moved when a choice changed between pages** (medium, found twice). `agreedProposalIds` came second, so a confirm or reject between calls shifted every node, and `more.fromItem` skipped or repeated one. It is now the last section; every other section's length is fixed by the two graph snapshots. A test changes the agreed count before every page, both ways, and merges each party's nodes back exactly. Within that last section a change can still move an ID; the section is at most a few hundred IDs and usually sits on one page.
- **Data could forge the "follow the trailing note" rule** (medium) and **a client that cut the end hid that more remained** (medium). A partial text page now starts with `[Partial result: <note>]` and ends with the same note. Every text result starts with the tool's own words, so data cannot produce that first line. The instructions say a text result is partial only when its first line starts that way, and not to follow calls named anywhere else. The session_read description says 40,000 characters instead of 10,000 tokens. Not done: a token-based bound or a caller-chosen page size. Token-dense text (Han script, escapes) can still exceed a client's token limit; the live Codex sentinel should also be run with such a page.
- **A resumed line lost its number prefix** (low). The fragment now starts with `line+character| `, so file text never starts a line of the page. The paging walk checks every file line's prefix.
- **context_for paging and vuek0/subagent-graphs' handoff quota** (medium on merge). Later pages reuse the briefing that page 1 fetched in this process, so a read-through makes one `/context` request. Items after the briefing are one `after` list that counts against the bound, so the quota note fits once added there. Page 1 always fetches again.
- **Paging helpers at vuek0's insertion point** (low). The block moved between `requireHex` and `text`.
- **session_search against an older ledger** (low). A complete list that fits passes through unchanged, as on 19f6522; a list that does not fit, or a call with `after`, still gets the restart error.
- **Coverage gaps** (low): latent_transfer continuing with `paths` and `fromPath` (only `POST /api/latent/files`, no model call), and the past-the-end notes of latent_read, latent_transfer text and room_read, now have tests.
- **The concurrency test did not race** (low). The test now holds the write lock until both processes have started and read version 0. It fails every time with a plain BEGIN or no transaction ("database is locked", "duplicate column name").
- **Suites (Windows):** node 116/117 (one skipped), Playwright 13/13. tools/list is 10,118 characters.

### Results — Cycle 10 second review fixes, 2026-11-11

A second independent review, of 2a02e98, upheld seven findings. Each fix has a test that fails on 2a02e98, except the coverage gaps, which had no bug to fail on; their tests fail on the mutations the review used.

- **session_search stopped at 100 rows when the whole list fit** (medium). Without `limit`, it now reads ledger pages of 100 until the rows pass the bound or end (at most 8 requests), and `listResult` trims by size alone. With `limit` it pages by it, as before. The schema no longer says `default: 100`. The list-api test imports 150 sessions: 120 that match a second keyword fit one result and come back byte-identical to `terminalJson` of the ledger's full list, and the 150 come in a first page of more than 100 and a second page.
- **The tools/list budget test failed after merging vuek0/subagent-graphs** (low). That branch adds `handoff_publish` (1,881 characters), which took the total to about 11,999 and the count to 14, and merge-tree reports no conflict in the test. The budget now counts the cycle's 13 tools by name; a synthetic fourteenth tool does not change it. vuek0 changes no existing tool schema, so after the merge this cycle's tools are still 10,104 characters. `tests/mcp.test.mjs` pins the tool names and still needs `handoff_publish` added in that merge.
- **A page could exceed a client's token cap** (medium). 40,000 characters of numbered code is about 13,000 tokens and 40,000 Han characters about 30,000 to 40,000, so a client cut the page and the continuation pointed past what it showed. Every size check, including the backstop, now uses `resultSize` (letters and whitespace 1, other ASCII 2, other code units 4). It is never less than the length, so the stated 40,000-character bound still holds, and English pages barely change. No schema or argument changed. A test reads a 60,000-character Han session (at most 10,000 Han characters a page, all rejoined once) and a numbered code file (a first page of 20,000 to 32,000 characters). The latent answer test now has one citation per finding, so one escape-heavy finding still fits beside the warning. The weights are estimates, not a tokenizer; the live Codex sentinel should still be run with a code page and a Han page.
- **room_list party filter on the graph_b side had no test** (medium) and **parties sorted by party had no test** (low). A new list-api test publishes until an ali graph ID sorts after leo's, so leo is `graph_a`. `party: 'ali'` and `graphId` of the ali graph find the room only through the graph_b terms, and the parties list ali first. It fails without ` OR b.party = $party` and without the sort.
- **latent_transfer's paths fallback was not covered** (low). The byte-identical test now includes a `paths` transfer that falls back to files, and the paging test reads the first page of a long one: its note names latent_transfer and its arguments, and following it continues the same file. Both fail on the review's mutation (`textFallback('latent_read', ..., intro + ' X', ...)`).
- **graph_list and room_list trimming was not exercised** (low). A fake ledger serves 250 rooms with 32-character party names and 250 graphs with 120-tag titles. With `limit: 100`, each first page holds fewer than 100 rows and stays in the bound, `more.after` is the last row shown, and the walk returns every row once, in order. It fails if room_list skips `listResult`.
- **Suites (Windows):** node 119/120 (one skipped), Playwright 13/13. tools/list is 10,104 characters.

## Housekeeping H1–H5 and G10 (defined 2026-11-16, before implementation)

Source: a review of the project map (floorplan) against CI, the handoff notes and the board. One card per branch, all branched from one claim commit so their pull requests merge without touching the same lines. Each card writes its results only under its own **Results** heading below. Synthetic data only. Baseline on `main` 17ecef0 (Windows): node 139/140 (one skipped), Python runtime 131 run (24 skipped without torch). Each card closes with its evals passing, the node suite passing, a Codex read-only review, and fixes with regression tests. Playwright is run once per branch after the agents finish, because its server port is fixed.

### H1 — Runtime checks in CI (`claude/h1-runtime-ci`)

| Eval | Expected |
| --- | --- |
| Runs on every push and pull request | A CI job runs `python -m unittest discover -s tests -t .` in `runtime/` on Python 3.12 (Ubuntu, the WSL version) and 3.13 (Windows, the documented test version). No third-party Python package is installed; torch-only checks skip with a reason. |
| Same result as locally | The job's run and skipped counts match a local run of the same command on the branch. |
| A failing check fails the job | With one runtime assertion deliberately broken, the same command exits non-zero (checked locally, not committed). |
| Nothing else changes | The node and Playwright steps are unchanged. Actions are pinned to the same major versions the workflow already uses. No secrets, no network beyond checkout and setup. |

**Results — H1:** passed locally; the first hosted run is still to be read.

- **Runs on every push and pull request — passed.** The new `.github/workflows/runtime.yml` runs `python -m unittest discover -s tests -t . -v` in `runtime/` on `push` and `pull_request`, as a matrix of `ubuntu-latest` with Python 3.12 and `windows-latest` with Python 3.13 (`fail-fast: false`). It has no `pip install`, `permissions: contents: read`, no secrets, and checkout does not keep credentials. Every skipped check prints a reason. The 21 torch checks say "torch and transformers are needed for M2b" or "... for M2c". `e2e.yml` is unchanged. The workflow parses with PyYAML 6.0.1 (WSL system Python).
- **Same result as locally — passed for Linux; Windows count to confirm on the hosted run.** Windows, Python 3.13.0: 131 run, 24 skipped, OK. That is 21 torch checks plus 3 symlink checks (`test_prefix` ×2, `test_review_fixes` ×1), which skip because this user does not have the symlink privilege. WSL Ubuntu-24.04, Python 3.12.3: 131 run, 21 skipped, OK, both on `/mnt/c` and in a clean `git archive` of the branch on ext4. GitHub's Windows runners run as administrator, so the symlink checks should run there too. Expected hosted counts: 131 run, 21 skipped on both jobs.
- **A failing check fails the job — passed.** I broke one assertion in `runtime/tests/test_limits.py` line 60 for the test only, then reverted it without committing. The command exited 1 on Windows (`FAILED (failures=1, skipped=24)`) and on WSL (`FAILED (failures=1, skipped=21)`). After the revert it exited 0.
- **Nothing else changes — passed.** The new workflow uses `actions/checkout@v4`, the same major version as `e2e.yml`, and `actions/setup-python@v5`. It needs no network beyond checkout and setup-python. AGENTS.md section 4 step 3 and the pull request template checklist now list the Python command.
- **Codex read-only review:** one low finding. The Windows skip count may differ on hosted runners because they run as administrator. Accepted: the expected hosted count is recorded above, and confirming it is left open until the first CI run. No code change was needed, because the symlink checks already run and pass on Linux. No other findings.
- **Suites (Windows):** node 139/140 (one skipped). Python runtime: 131 run, 24 skipped on Windows; 131 run, 21 skipped on WSL. Playwright was not run here because its port is fixed; the change touches no browser journey.

### H2 — Docs match what is merged (`claude/h2-stale-docs`)

| Eval | Expected |
| --- | --- |
| README | The M2c line states the recorded result from `docs/m2c-latent-team.md` instead of "not recorded yet". The test counts are the counts measured on this branch, with the date. |
| Handoff | The cycle 10 steps say PR #8 was merged on 2026-11-12 with no GitHub review recorded, and that the human review of the schema migration is still owed. No other history is rewritten. |
| Runtime docstrings | `runtime/latent_pool/mappers.py` and any other docstring found stale describe what the code does today. |
| Every change has a source | Each changed statement cites, in the results, the doc, commit or `gh` output it was checked against. No new claim without one. |

**Results — H2:** all four rows pass. Each changed statement and what it was checked against:

- **README, M2c line.** "Not recorded yet" is replaced by the seed-0 figures (0.835 against `text_mas` 0.780 and `single` 0.820, 72% fewer tokens, 1.85× faster, `latent_random` 0.505), the repeat passes on seed 1 and the disjoint block, and the caveats (not better than `single`, `text_mas` held back by truncated plans). Source: `docs/m2c-latent-team.md`, "Result: the full measurement", "Second seed" and "A disjoint second sample".
- **README, tests line.** Measured on this branch on 2026-11-16: node 139/140 (one skipped), Python runtime 131 run, 24 skipped (21 need torch and transformers, 3 need symlink rights; from `-v` skip reasons). Playwright was not run here: `npx playwright test --list` lists 13 tests, and the last recorded pass is 13/13 in cycle 10 (this file, "Results — Cycle 10 second review fixes").
- **README, duplicate paragraph removed.** The negotiation-room section repeated the v1 identity paragraph, saying node order matters, which is false for the v2 graphs rooms use. Source: README "Version 2: two parties" ("Order carries no meaning in v2"); the v1 paragraph stays under "Exchange a semantic graph".
- **Handoff, cycle 10.** The header now says the branch was merged as PR #8 on 2026-11-12 (17ecef0); "is pushed as draft PR #8 ... CI passes" is now past tense; step 4 says PR #8 was merged with no review or comment recorded on GitHub and that the human review of the migration to version 1 is still owed. Source: `gh pr view 8 --json state,mergedAt,reviews,comments` (MERGED, 2026-11-12T23:13:26Z, 0 reviews, 0 comments) and `git log` (17ecef0).
- **Handoff, cycles 4 and 6.** The "not pushed" lines are kept and get a "Later:" note: cycle 4 reached `main` through PR #1, cycle 6's two branches through PR #6, both merged 2026-11-08, and PR #4 (`leo/latent-read`) was closed unmerged. Source: `gh pr view 1/4/6` (state, mergedAt, closedAt, base) and PR #6's description. Cycle 9's "PR #7 records no review" is correct (`gh pr view 7`: 0 reviews) and is unchanged.
- **`runtime/latent_pool/mappers.py` docstring.** No longer says no mapper is trained and 501 always. It says the registry backs `/latent/mappers` and `/latent/transfer`, starts empty, gets one pair from `LATENT_MAPPER` via `transfer.register_from_env`, and answers 501 for a pair not loaded. Source: `transfer.py` `register_from_env`, `server.py` `main()` and routes, `docs/m2b-transfer.md` (the trained 0.5B to 360M pair).
- **`runtime/latent_pool/transfer.py`, `register_from_env` docstring.** "Needs torch and a GPU" becomes "needs torch" plus the device order the code uses (`LATENT_MAPPER_DEVICE`, else CUDA, else CPU). Source: the function body.
- **`runtime/latent_pool/server.py` and `__init__.py` docstrings.** They now name the M2b and M2c routes the server also serves, and the `LATENT_ALLOWED_HOSTS` opt-in to the Host check. Source: `LatentServer.routes`, `Handler._allowed`, `_allowed_hosts`.
- **`docs/latent-read.md`.** The 501 row said the ledger never calls `/latent/transfer`; the ledger's `latent_transfer` calls it and falls back to text on 501 (`src/latent.mjs`, transfer handler). The `GET /latent/mappers` section no longer says no pair exists; it describes the hashed pair list and `LATENT_MAPPER` (`mappers.py` `pairs()`, `transfer.py`).
- **`docs/m2b-transfer.md`, Serving.** The request body now lists exactly one of `text` or `paths` and `maxNewTokens` (1 to 64, default 32), and the `LATENT_MAPPER` startup load. Source: `transfer.py` `FIELDS`, `document()` and `__call__`.
- **Codex review** (read-only, of `claude/housekeeping-claim...ae7ee56`): it found the changed figures and runtime descriptions match their sources and no behaviour change, and raised two findings in `docs/latent-read.md`, both fixed:
  - **Status line still credited PR #4** (medium). It now says PR #4 was a draft closed without merging and that `leo/latent-read` reached `main` through PR #6 on 2026-11-08. Source: `gh pr view 4` (CLOSED, not merged) and `gh pr view 6` (MERGED 2026-11-08, body lists `leo/latent-read`).
  - **The gate section said `latent_read` matches the closed model** (low). It now states the gate as a target and the recorded result: 14/16 to Claude Sonnet's 16/16, slice 5–9% of the prefix tokens. Source: this file, cycle 6, "Gate verdict" and "Cost".
  - These are documentation and docstring changes only, so there is no code to regression-test; the Python suite was re-run after the docstring edits.
- **Suites (Windows, this branch):** node 139/140 (one skipped), Python runtime 131 run, OK (24 skipped). Playwright not run (fixed port); 13 tests listed. No raw control or format characters in the changed files.

### H3 — Split the MCP adapter (`claude/h3-split-mcp`)

| Eval | Expected |
| --- | --- |
| Same protocol, same tools | `tools/list` output and the `initialize` result are byte-identical before and after, checked by a script or test against the output captured on `main`. |
| Same answers | Every existing node test passes unchanged, including `tests/mcp.test.mjs`, `tests/mcp-live.test.mjs`, `tests/paging.test.mjs` and `tests/list-api.test.mjs`. |
| Same entry point | `node src/mcp.mjs` still starts the adapter, so the demo rehearsal, the tests and the Claude Code and Codex settings that start it need no change. |
| Smaller files | No file of the adapter is over 400 lines. No new dependency and no build step. |
| Merge cost measured | A trial merge of this branch with `vuek0/subagent-graphs` (not committed) records the conflicting files and hunks, and the results say where each of that branch's `src/mcp.mjs` changes now belongs. |

**Results — H3:** all five rows pass, 2026-11-16 (Windows).

- **Layout.** The code moved verbatim, by line range, from the 1,086-line `src/mcp.mjs`. The only edits are `export`, a two-space dedent of each tool entry and `serve()` wrapping the stdin and stdout listeners. `src/mcp.mjs` (38 lines) is still the entry point and holds the instructions, `initialize` and the method table. `src/mcp/protocol.mjs` (111) is the stdio JSON-RPC loop. `ledger.mjs` (74) is the HTTP client, the PORT check and the cursor error. `common.mjs` (72) has the error types, argument checks and result text. `pages.mjs` (86) has partial notes, list trimming and JSON item paging, and `file-pages.mjs` (169) has file-text paging. Each tool group has one file of exported `[name, definition]` entries: `sessions.mjs` (153), `graphs.mjs` (161, which holds the context_for briefing cache), `rooms.mjs` (87) and `latent.mjs` (173). `tools.mjs` (52) builds the Map in the old order and runs tools/call with the result-size backstop. No dependency was added and there is no build step.
- **Same protocol, same tools: pass.** `tests/mcp-snapshot.mjs` prints `initialize` (2025-06-18, 2024-11-05 and an unsupported version), `tools/list`, `ping` and six fixed error replies. Its output on the claim commit 8a41b0e, captured before any change, and on this branch are both 17,365 bytes and byte-identical (`cmp`; sha256 `67799e8e…a6e14cbfa33502f`).
- **Same answers: pass.** No test file changed. `tests/mcp.test.mjs`, `mcp-live`, `paging`, `list-api` and `latent-ledger` all pass. One weak spot: the existing check in `paging.test.mjs` that the adapter never names the decisions route reads only `src/mcp.mjs`. The new `tests/mcp-layout.test.mjs` applies it to every adapter file.
- **Same entry point: pass.** `tests/mcp-client.mjs`, `demo/rehearse.mjs` and the README settings still start `node src/mcp.mjs` and needed no change. New tests check that it answers on stdout only, writes nothing to stderr and exits 0 when stdin ends. They also check that an invalid PORT still exits 1 with "Invalid PORT." before any message is answered.
- **Smaller files: pass.** The largest adapter file has 173 lines. `tests/mcp-layout.test.mjs` fails if any adapter file has more than 400 lines, imports anything but a relative module or `node:` built-in, or contains a raw control or format character. It also fails if any file other than `ledger.mjs` calls `fetch`.
- **Merge cost measured: pass.** `git merge-tree --write-tree --name-only` with `vuek0/subagent-graphs` reports the same eight conflicting files before (8a41b0e) and after (this branch): README.md, docs/delivery-board.md, docs/evals.md, docs/handoff.md, src/mcp.mjs, src/server.mjs, src/store.mjs and tests/mcp.test.mjs. Only `src/mcp.mjs` changes. Before the split it had 2 hunks (instructions: 4 against 7 lines; context_for: 21 against 4) and git merged the rest. After the split it has 2 hunks (imports: 2 against 7; body: 4 against 568). Git does not follow code into new files, so whoever merges should take this branch's `src/mcp.mjs` and re-apply that branch's changes:
  - The `instructions` text (the subagent default) goes in `src/mcp.mjs`.
  - The `launcher.mjs` import, `resetDate`, `choiceText`, `quotaStopMessage`, `startLedger`, the ECONNREFUSED retry, the `instanceof ToolError` rethrow and the 402/503 quota branch of `ledger()` go in `src/mcp/ledger.mjs`, which also needs `isObject` from `common.mjs`.
  - `quotaNote` and the quota note of `context_for` go in `src/mcp/graphs.mjs`. Since cycle 10, the note should be added to the `after` list next to `meter`, so it counts against the bound. On a later page served from the briefing cache there is no `data`, so the note applies only to pages that fetched.
  - The `node:fs`, `node:path` and `importer.mjs` imports, `currentTranscript` and the `handoff_publish` entry should go in a new `src/mcp/handoff.mjs`, which avoids conflicts (or `graphs.mjs`, which would then have about 250 lines). It needs `ToolError`, `checkArguments`, `hexId`, `maxPacketBytes` and `text` from `common.mjs`, plus `ledger`. Add `handoffPublish` to the Map in `src/mcp/tools.mjs` after `graphPublish`.
  - The `tests/mcp.test.mjs` conflict (the tool names) is the same as before the split.
- **Review.** Codex (`codex exec --sandbox read-only`) found no runtime or security regression. It checked that initialize, tools/list and ping were byte-identical against the original adapter, and that listener attachment, the invalid-PORT exit, the briefing cache, stdin buffering, escaping, closed schemas, fixed errors, the room restriction and the backstop are unchanged. It raised two findings, both fixed:
  - Medium: these results were still pending. Fixed by this entry.
  - Low: `tests/mcp-snapshot.mjs` printed on `exit`, before stdout might have drained. It now prints on `close`. That is a helper script, not a test, so there is no regression test; the comparison was rerun and is identical.
  - Codex's own node run failed 25 tests because its sandbox blocked temporary directories, so the counts below are the local run.
- **Suites (Windows):** node 143/144 (one skipped; the 4 new tests are in `tests/mcp-layout.test.mjs`). Python runtime 131 run, 24 skipped, OK. Playwright was not run here (fixed port). No `tests/e2e` spec starts the MCP adapter, so no browser journey should change.

### H4 — One source for cross-language rules (`claude/h4-shared-rules`)

| Eval | Expected |
| --- | --- |
| Secret-file rule | One data file holds the secret directories, names, prefixes and suffixes. `src/latent.mjs` and `runtime/latent_pool/prefix.py` both read it, and both give the same verdict on a shared table of at least 30 paths, run by a node test and a Python test. |
| Whitespace fold | The ledger and the runtime fold whitespace the same way on a shared table of cases (including non-ASCII spaces, tabs and line separators), run by both suites. |
| Latent grader | `evals/latent/grade.mjs` and the Python port in `runtime/tests/test_fixture_e2e.py` agree on a shared table of graded answers, run by both suites. |
| Drift fails a test | Changing any one of these rules in one language only makes a test fail (checked by hand, not committed). |
| Runtime stays stdlib | The runtime still uses only the Python standard library and still runs from `runtime/` with `LATENT_ROOT` elsewhere. Default results are unchanged. |

**Results — H4:** all five rows pass (2026-11-16, Windows, Node 22.14, Python 3.13).

- **Where the rules live.** `rules/latent-rules.json` holds the data: the secret directories, names, prefixes, suffixes and env templates, and the whitespace code points quotes fold. It is at the repository root because neither `src/` nor `runtime/` owns it, and `schemas/` holds graph JSON Schemas, a different kind of file. `src/latent.mjs` imports it with `{ type: 'json' }`; the new `runtime/latent_pool/rules.py` reads it with `json` from `Path(__file__).resolve().parents[2]`, so the working directory and `LATENT_ROOT` do not matter, and fails with "Shared rule file not found: …" when it is missing. `rules/latent-conformance.json` holds the shared cases, all non-ASCII characters as JSON escapes. `tests/latent-rules.test.mjs` (node) and `runtime/tests/test_rule_conformance.py` (Python) both run them. The node test replaces `tests/latent-space.test.mjs`, which parsed `pool.py`'s source.
- **Secret-file rule: pass.** 55 shared paths (35 secret, 20 not): case variants, nested secret directories, every name, prefix and suffix, the three templates, U+212A KELVIN SIGN in place of the k of `server.key`, and near misses (`env.txt`, `.gitignore`, `worktree/.git`, `id_ecdsa.pub`, `public.key.txt`). Current behaviour kept, including `.envrc` and `.environment` (prefix `.env`) and `keys/id_rsa.pub` refused. The node test also checks every list entry is exercised; the Python test also runs `check_path_syntax` (400, "secret files"). Both lists matched exactly before the change.
- **Whitespace fold: pass.** 20 shared strings (tab, CR LF, VT, FF, NBSP, U+1680, U+2000–U+200A, U+2028, U+2029, U+202F, U+205F, U+3000, U+FEFF, and U+001C, U+001F, U+0085, ZWSP, U+180E, ZWJ, which do not fold) through `normalizeSpace` and `fold_space`, plus `quotable_lines` in Python. The node test pins the shared list to `/\s/u` over every code point up to U+10FFFF. The two sides already agreed.
- **Latent grader: pass, after fixing a disagreement.** The Python port (moved from `runtime/tests/test_fixture_e2e.py` to `runtime/tests/grade.py`, which that test imports) matched numbers as substrings ("3" passed on "30 minutes") and ignored pattern and forbidden options. It disagreed with `grade.mjs` on 24 of the first 34 shared cases. It now follows `grade.mjs`, the shared grader in docs/latent-read.md's ownership table. 41 shared graded answers: right, wrong value, wrong citation (lines, file), boundary overlap, forbidden option, forbidden text only in a label, pattern options, and questions from `questions.json` and `fresh.json`. `fresh.json` renew-on-hold uses variable-width lookbehind, which Python's `re` cannot compile, so the port raises ValueError for it rather than grading it differently (a shared case checks that); only node grades that question.
- **Drift fails a test: pass** (each change made by hand, run, reverted, not committed): Python secret logic without the prefix rule, or with `.kube` dropped from its copy → `SecretRuleConformanceTest`; JavaScript secret name not lower-cased → node "secret-file rule decides every shared case"; JavaScript fold `/[ \t\n\r]+/gu` → node "ledger folds whitespace in every shared case"; Python fold without NBSP → `WhitespaceConformanceTest` (both tests); U+FEFF removed from the shared list → node "shared whitespace list is exactly what /\s/u matches" and the Python fold tests; Python grader with substring numbers → `GraderConformanceTest`; JavaScript grader ignoring forbidden options → node "grader decides every shared graded answer".
- **Runtime stays stdlib: pass.** New Python code imports only `json`, `pathlib`, `re`, `os`, `subprocess`, `sys`, `tempfile`, `unittest`. A Python test imports `latent_pool.prefix` in a subprocess whose working directory and `LATENT_ROOT` are a temporary directory. Default results are unchanged: no secret, whitespace or grading verdict on `main`'s existing tests changed.
- **Review.** Codex (`codex exec --sandbox read-only`) on e75a3c0: no high findings. Two medium, both fixed with shared cases that fail on e75a3c0's port: (1) `re.ASCII` differed from JavaScript's `iu` for U+017F (renewals "up to 2ſ, 14 days" graded right in Python, wrong in JavaScript); the port now drops `re.ASCII` and rewrites `\d`, `\w`, `\b`, `\B` to ASCII classes and lookarounds that Python's Unicode IGNORECASE folds as JavaScript does; (2) Python's `$` matched before a final newline; it is now `\Z`. One low (these results were still pending) is fixed by this entry. None rejected.
- **Suites:** node 143/144 (one skipped; was 139/140: −1 for `latent-space.test.mjs`, +5 new); Python runtime 140 run, 24 skipped, OK (was 131: +9 new). Playwright not run here (fixed port); no spec in `tests/e2e` mentions latent reading, and the ledger's refusal messages are unchanged.

### H5 — Server request table (`claude/h5-server-routes`)

| Eval | Expected |
| --- | --- |
| One default address | The local runtime's default address is defined once in `src/server.mjs`. `LATENT_URL` still overrides it. |
| Same responses | A probe set run before and after (every route with its right method, a wrong method, an unknown path, a foreign Host, a foreign Origin on a write, a bad ID) gives the same status and body. |
| Checks still come first | The Host and Origin checks run before any request handler, and the decisions route keeps its same-origin check. The existing node and Playwright checks pass unchanged. |
| Merge cost measured | A trial merge with `vuek0/subagent-graphs` (not committed) records the conflicting hunks in `src/server.mjs` and how to resolve them. |

**Results — H5:** all four rows pass (Windows, 2026-11-16). Playwright is not run here (fixed port); the orchestrator runs it.

- **One default address:** pass. `src/server.mjs` names `defaultLatentUrl = 'http://127.0.0.1:4320'` once, and `latentUrl()` returns `process.env.LATENT_URL ?? defaultLatentUrl`. It is still read on each request, as before (not at start). LATENT_ROOT is also still read per request. `tests/routes.test.mjs` checks both: a fake runtime on 4320 gets the team request when LATENT_URL is unset (the test skips if 4320 is taken), and a server whose LATENT_URL changes between two requests sends the second to the new address. Changing the default to 4321, or caching the URL at start, makes a test fail (checked by hand, not committed).
- **Same responses:** pass. `tests/routes.test.mjs` was committed first (2c4972b) and passed on the unchanged server. It sends 192 probes: the three static files (GET 200; POST and HEAD 404), unknown, encoded and trailing-slash paths, five foreign Hosts on a read and a write, `//x` and `*` URLs, and on each of the 7 writes a foreign Origin, the other local name's Origin, no Origin, text/plain, a declared 8 MiB + 1 body, bad JSON, bad UTF-8, and GET/PUT/DELETE/PATCH; a streamed 8 MiB + 1 body; every route with its right method; unknown, upper-case, short, long and trailing-slash IDs on the four ID routes, plus POST/PUT/DELETE on them; the decisions route's 12 cases; InputError, GraphInputError and LatentError (502 and 503) cases, and a 500. Wrong methods stay 404 (there is no 405). With `ROUTES_PROBE_OUT` set, the test writes every probe's status, headers and body (dates and port masked): the dump from the old server and the dump from the table are identical, byte for byte. The test passes unchanged on both servers.
- **Checks still come first:** pass. Host and URL checks run before the table; each write's Origin, type and size checks stay in `readJson`; the decisions entry checks `Sec-Fetch-Site: same-origin` before `readJson`. Probes pin the order (a foreign Host beats a bad URL; the decisions rule beats a foreign Origin and an unknown room). Node suite 142/143 (one skipped), was 139/140; the 3 new tests are in `tests/routes.test.mjs`. Python runtime 131 run, 24 skipped, OK. Every Playwright spec exercises this server (`npm start`): `tests/e2e/demo.spec.mjs`, `graph.spec.mjs`, `graph-v2.spec.mjs`, `handoff.spec.mjs`, `library.spec.mjs`, `room.spec.mjs`.
- **Merge cost measured:** `git merge-tree --write-tree --name-only` with `vuek0/subagent-graphs` (merge base 19f6522) conflicts in the same 8 files from this branch and from the claim commit 8a41b0e (README, board, evals, handoff, `src/mcp.mjs`, `src/server.mjs`, `src/store.mjs`, `tests/mcp.test.mjs`). In `src/server.mjs` the claim commit already has 1 hunk (the latent import line, because main added `latentFiles`); this branch has 3: the import line, the quota client next to the new table, and the dispatch chain against the table. To resolve: keep both import sets; keep `quota` after `store` and keep the table (handlers read `quota` at request time); replace that branch's chain with entries: `{ GET, path: '/api/health' }` returning `{ name, version }`, first in the table; `{ POST, path: '/api/import-file' }` after `/api/import`, with its `readJson`, provider check and `readTranscriptFile`; and in the context entry, return `{ context }` when there is no quota, else call `quota.consume()` and return `{ context, quota }` on success, or write the 402 or 503 with `json()` and return `sent`. The PID file and signal handlers outside the dispatch merge without conflict.
- **Codex review** (`codex exec --sandbox read-only`): no server behaviour change found. Findings: (medium) Results still pending — fixed by this entry. (low) the full before/after comparison is optional and not asserted — the comparison was run and is recorded above; rejected as a committed golden file, because it holds the full page, script and store output and would fail on unrelated changes by other cards. (low) no test that LATENT_URL is read per request — fixed in fe33d83 with the child-process test above. (low) the generic 500 was not probed — fixed in the same test: a forced static read failure gives 500 `Local request failed.` with the security headers.

### G10 — Published handoff benchmark, offline parts (`claude/g10-handoff-benchmark`)

| Eval | Expected |
| --- | --- |
| Stage demo untouched | `demo/` stage transcripts, prompts and reference graphs are byte-identical, so the recorded demo still matches. The benchmark uses its own synthetic fixtures. |
| More facts, some late | At least 12 graded facts, at least 4 of which appear only after the first page `session_read` returns for the long transcript, and at least 3 of which were changed or superseded during the conversation. |
| Two independent graders | A second grader built a different way from the first agrees with it on a labelled set of at least 60 synthetic answers (right, superseded, negated, missing, and right with an added false detail). Agreement and every disagreement are recorded. |
| Fairness rules | `BENCHMARKS.md` fixes the rules: same model and question for both arms, same tools, alternating arm order, one timeout, how tokens, cost and time are counted, and what counts as a pass. |
| Spend log | Each benchmark run appends one line (date, arm, model, tokens in, cached and out, cost, time, score) to a file Git ignores, and a summary command prints only aggregates. No transcript text is logged. |
| No paid runs here | Live runs with Claude Code and Codex are not part of this card; the results say how to run them. |

**Results — G10 (2026-11-16, Windows):** all six rows met offline. No live run was made. The code is in `evals/handoff/`, the rules in `BENCHMARKS.md`, the tests in `tests/handoff-bench.test.mjs`.

- **Stage demo untouched:** `git diff claude/housekeeping-claim -- demo/` is empty. Nothing in `evals/handoff/` imports `demo/`, and a test checks that.
- **More facts, some late:** a synthetic Claude Code session of 408 lines (Mira hands her context to Tomas) and 14 graded facts. 6 change during the conversation (port, launch day, database, reviewer, budget, backup interval). Through the real `session_read` tool against a test ledger, the session takes 2 pages and page 1 ends at line 278. 7 facts get their current value only after page 1, and 4 of them (feature flag, timeout, on-call person, open question) are not mentioned on page 1 at all. The test fails if the paging bound moves a late fact onto page 1. The graph arm's fixed reference graph states every current value in its `context_for` briefing.
- **Two independent graders:** grader A checks keywords like `gradeHandoff`. Grader B extracts typed values and checks them against explicit current, superseded and mentioned values. `evals/handoff/labelled.json` holds 82 single-field answers (32 right, 50 wrong), labelled by hand by the implementing agent before either grader was written. A human check of the labels is still owed. `node evals/handoff/agreement.mjs` prints the numbers, and the test pins them.
  - Grader B agrees with the labels on 79/82 (96%): 3 false accepts, 0 false rejects. Grader A agrees on 60/82 (73%): 22 false accepts, 0 false rejects. A and B agree with each other on 63/82 (77%).
  - B was 78/82 at first. One fix followed: a bare "replaced" after a value was read as "this value was replaced", so "PostgreSQL (replaced SQLite ...)" was refused. That was the only change made after seeing the labelled results.
  - Every disagreement (label / A / B): `launch-5` "Thursday at 09:00", `retry-3` "3 retries, then a 5 minute cooldown" and `flag-3` "beta_checkout, on by default" are wrong / right / right: a false claim of another type, which B does not look for. A accepts and B refuses, correctly, these wrong answers: `port-4`, `db-4`, `rev-4` (hedged); `budget-6` (negated); and `port-5`, `port-7`, `launch-6`, `db-5`, `rev-5`, `budget-5`, `region-4`, `code-4`, `retry-5`, `backup-4`, `freeze-5`, `flag-5`, `timeout-4`, `oncall-4`, `question-3` (right plus a false detail). The other 60 items grade the same under the label, A and B.
- **Fairness rules:** `BENCHMARKS.md` fixes them. Both arms use the same agent, model and question text, the same two ledger tools (`session_read` and `context_for`) and no built-in tools. A call to the other arm's tool or to any tool outside the ledger makes a run invalid. Arm order alternates by run, every call has one timeout (default 300 seconds), and each invocation starts a fresh ledger. The file says how tokens, cost and time are counted, what passes per fact and per run, and that a mean needs at least 10 valid runs per arm.
- **Spend log:** each run appends one line to `.context-ledger/benchmarks/handoff-spend.jsonl`, which Git ignores (a test runs `git check-ignore`). The line holds the date, run, arm, order, agent, model, timeout, validity flags, tokens in, cached and out, cost, time, both scores and a pass flag per fact. `--summary` prints aggregates per agent, model and arm. Fake-CLI tests check the exact fields, the alternating order, and that neither the log nor the summary holds any answer value. Failed, timed-out and cross-arm runs are logged and score 0.
- **No paid runs here:** the runner has `--dry-run` and `--fake-cli evals/handoff/fake-cli.mjs`, and the tests use only those. `BENCHMARKS.md` says how to run it live: `node evals/handoff/run.mjs --agent claude|codex --model <model> --runs 10`, then `--summary`. Live results are not recorded yet.
- **Codex review** (`codex exec --sandbox read-only`, of 9cf3895): five findings. Four were fixed, each with a regression test:
  - (medium) Grader B passed names and intervals it did not know ("Priya and Alice", "every 6 hours and every 30 minutes"). It now reads any other capitalised word as a person and knows minutes, days and weeks.
  - (medium) The open question passed when it was answered or denied ("Alice signs the vendor contract", "No vendor contract signature question remains open"). It now needs who, which or whether, refuses "is answered" and a leading "no", and refuses any name but Mira's and Tomas's.
  - (medium) A CLI that could not start aborted the benchmark and logged nothing. It is now a failed run that is logged.
  - (medium) The total cost left out paid invalid runs. The total now counts every run that reported a cost, and the mean is per valid run.
  - The new cases are regression tests, not labelled items. The labelled set stays as it was written, and its numbers did not change.
  - (low) The Results line was still pending. Fixed here. The handoff note it also asked for is left out, because this card's brief does not allow editing `docs/handoff.md`.
- **Suites:** node 151/152 (one skipped) against a baseline of 139/140; the 12 new tests all pass. Python runtime 131 run, 24 skipped, OK. Playwright was not run, because the orchestrator runs it. No browser journey changed.
- **Orchestrator check (2026-11-16):** Playwright 13/13 on this branch. On a Windows checkout with `core.autocrlf` the files are CR LF, and the hidden-character check in `tests/handoff-bench.test.mjs` counted the carriage return as hostile, so the test failed there (it passed only where the files were written with LF). The check now allows tab, newline and carriage return, as AGENTS.md section 6 does. Checked both ways: it passes with CR LF files and still fails on a vertical tab.

## Cycle 11 — Latent runtime performance baseline (defined 2026-11-12, before measuring)

Card C11. Until now the latent runtime had accuracy evals but no performance figures. This cycle measures it on the RTX 4090 Laptop GPU (16 GB), vLLM 0.33.0 in WSL2, with the synthetic fixtures only.

### What is measured

A new harness, `evals/latent/perf.mjs`, sends the dev set (`questions.json`, 8 questions, `evals/latent/fixture`) through the ledger's `/api/latent/read`, as `run.mjs` does, and reads vLLM's Prometheus `/metrics` before and after every read. For each configuration it reports:

1. **Time to first token (TTFT):** mean, p50 and p90 over every vLLM call, from vLLM's TTFT histogram. Quantiles come from the histogram buckets, so they are bucket estimates.
2. **Prefix-cache hit rate:** vLLM's prefix-cache hits divided by queries (tokens), cross-checked against the receipts' `cachedTokens / promptTokens`.
3. **Tokens per second:** per-request decode speed (1 / mean time per output token) and the aggregate rate (generated tokens / wall time of the reads).
4. **Memory:** GPU memory used after loading and the peak during the run (`nvidia-smi`, sampled every 200 ms), the size of vLLM's KV-cache pool, the peak KV-cache use, and the KV memory per request: tokens of that request times the KV bytes per token from the model's config (layers × KV heads × head dim × 2 × bytes per value). Weights are shared by every request, so the KV cache is the per-request part.
5. **End-to-end read latency:** p50 and p90 of the ledger call, which is what an agent waits for.
6. **Accuracy:** the existing grader on the same reads (correct and cited), so a faster setting that loses answers is visible.

### Configurations

- **A.** Default: Qwen2.5-7B-Instruct-AWQ, strict citations off, files on `/mnt/c`.
- **B.** Qwen2.5-14B-Instruct-AWQ, strict citations on, max model length 8192 (the cycle 9 strict setup).
- Quick wins, each measured against A in the same session:
  - **C.** FP8 KV cache (`--kv-cache-dtype fp8`).
  - **D.** N-gram speculative decoding (prompt lookup), since cited answers copy text from the files in the prompt.
  - **E.** The fixture copied to the WSL disk, so the pool does not read through `/mnt/c`.
  - **F.** FP8 weights (`RedHatAI/Qwen2.5-7B-Instruct-FP8-dynamic`) instead of AWQ.
- For B, the 14B run is also repeated with C, because FP8 KV is the cheapest way to raise its 8192-token limit.

### Acceptance

- Unit tests (`node:test`) for the pure parts: Prometheus text parsing, counter and histogram deltas, bucket quantiles, KV bytes per token, and the report summary. They run without a GPU.
- Each configuration runs 3 rounds of the 8 dev questions (24 reads) and produces a report with every metric present, or a stated reason why vLLM does not export it.
- A quick win is recommended as a default only if it improves its target metric and loses at most one correct-and-cited answer out of 24 against A in the same session. Otherwise it is recorded and left off.
- The numbers are for one laptop GPU and one synthetic fixture; the doc says so wherever they are quoted.

## Results — Cycle 11 (latent runtime performance), 2026-11-12

Hardware and software: RTX 4090 Laptop GPU (16 GB), WSL2 Ubuntu 24.04, vLLM 0.33.0, `--gpu-memory-utilization 0.85`, prefix caching on. Each configuration ran the 8 dev questions 3 times (24 reads; a successful read makes 6 vLLM calls) through a test ledger, with `evals/latent/perf.mjs`. These figures are for one laptop GPU and one small synthetic fixture (5 files, about 1,900 tokens of prefix). They show where the time goes, not what a larger repository would cost.

How to read the table: TTFT is from vLLM's histogram, so p50 and p90 are bucket estimates. "Tokens/s per request" is 1 / mean time per output token; "aggregate" is generated tokens / summed read time. "KV MiB per read" has two figures: the sampled peak (the highest KV-cache use seen by a 200 ms poll × pool size × KV bytes per token; a shorter spike between polls can be missed) and the mean token-based upper bound (every call's prompt and completion tokens, counting the shared prefix once per call, averaged over the reads). A, A2, A3 and A4 are the same default setup run at different times in the session, to show the run-to-run spread.

| Config | Correct and cited | TTFT ms mean / p50 / p90 | Prefix-cache hits | Tokens/s per request / aggregate | Read s p50 / p90 | Cold read s | GPU MiB idle / peak | KV pool tokens | KV MiB per read: sampled peak / mean token-based upper bound | Spec. acceptance | Failed reads |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A | 18/24 | 89 / 40 / 179 | 96.7% | 88.5 / 98.6 | 5.18 / 8.19 | 11.6 | 14078 / 14410 | 137136 | 151 / 706 | — | 0 |
| A2 | 18/24 | 94 / 40 / 176 | 96.8% | 89.5 / 99.8 | 5.13 / 7.72 | 11.4 | 14078 / 14410 | 137136 | 151 / 705 | — | 0 |
| A3 | 18/24 | 132 / 39 / 180 | 96.8% | 88.8 / 97.3 | 5.23 / 7.87 | 12.4 | 14078 / 14410 | 137136 | 151 / 705 | — | 0 |
| A4 | 18/24 | 122 / 40 / 194 | 96.8% | 90.0 / 99.1 | 5.16 / 7.70 | 12.2 | 14078 / 14410 | 137136 | 151 / 705 | — | 0 |
| A-triton | 18/24 | 101 / 41 / 186 | 96.8% | 92.6 / 101.5 | 5.07 / 7.50 | 11.7 | 14074 / 14423 | 137136 | 151 / 705 | — | 0 |
| C | 0/24 | 61 / 31 / 39 | 97.8% | 121.2 / 75.4 | n/a / n/a | failed | 14074 / 14414 | 273616 | 66 / n/a | — | 24 |
| D | 18/24 | 101 / 44 / 180 | 96.8% | 105.4 / 135.5 | 3.67 / 5.22 | 9.2 | 14088 / 14420 | 135200 | 151 / 705 | 33% | 0 |
| E | 18/24 | 126 / 44 / 199 | 96.8% | 96.7 / 109.4 | 4.56 / 7.17 | 11.4 | 14078 / 14410 | 137136 | 151 / 705 | — | 0 |
| E2 | 18/24 | 97 / 44 / 176 | 96.8% | 96.7 / 109.0 | 4.59 / 7.15 | 11.7 | 14078 / 14410 | 137136 | 151 / 705 | — | 0 |
| E3 | 18/24 | 108 / 43 / 179 | 96.7% | 97.0 / 109.6 | 4.57 / 7.44 | 11.6 | 14078 / 14410 | 137136 | 151 / 706 | — | 0 |
| F | 16/24 | 102 / 55 / 212 | 95.2% | 55.9 / 62.4 | 8.55 / 11.96 | 11.8 | 13306 / 13584 | 66960 | 154 / 705 | — | 0 |
| B | 21/24 | 323 / 327 / 499 | 89.4% | 48.1 / 59.8 | 17.14 / 19.36 | 21.5 | 14144 / 14438 | 17104 | 616 / 2579 | — | 0 |
| B-C | 20/24 | 200 / 68 / 453 | 93.5% | 51.2 / 64.4 | 14.48 / 18.72 | 21.0 | 12892 / 13186 | 21168 | 303 / 1283 | — | 0 |

Configurations: A = Qwen2.5-7B-Instruct-AWQ, default settings (FLASH_ATTN). A-triton = A on the Triton attention backend. C = FP8 KV cache (Triton). D = n-gram speculative decoding, 4 draft tokens. E = the fixture on the WSL disk instead of `/mnt/c`. F = FP8 weights (`RedHatAI/Qwen2.5-7B-Instruct-FP8-dynamic`). B = Qwen2.5-14B-Instruct-AWQ with strict citations and a max model length of 8192. B-C = B with an FP8 KV cache (Triton).

### The baseline (A)

- **Time to first token:** 40 ms at p50 and 179 ms at p90; the mean of about 90–130 ms is pulled up by the calls whose prefix is not cached yet. The first read on a new prefix (cold) takes 11.6 s against about 5.6 s for the rest.
- **Prefix cache:** 96.8% of prompt tokens are served from the cache. vLLM's counters and the receipts agree to the third decimal.
- **Decode:** about 89 tokens/s per request, 98–100 tokens/s aggregate. A read waits 5.2 s at p50 and 7.7–8.2 s at p90.
- **Memory:** the 4-bit weights take 5.29 GiB, and vLLM's 85% reservation holds the GPU at 14,078 MiB (13.7 GiB) from the start; a run adds 332 MiB. The KV pool holds 137,136 tokens (7.32 GiB at 56 KiB per token). The sampled peak of one read is about 151 MiB (2% of the pool). Counting every call's tokens separately gives 706 MiB on average (731.5 MiB at most), about 4.7× the sampled peak, which is consistent with the six calls sharing the prefix blocks. The sampled peak is a lower bound on the true peak, so the 4.7× is an estimate, not a measured reduction.
- **Run-to-run spread:** across A, A2, A3 and A4, read p50 stays within 5.13–5.23 s and decode within 88.5–90.0 tokens/s.

### The quick wins

- **D, n-gram speculative decoding: recommended.** Reads drop from about 5.2 s to 3.67 s at p50 (−29%) and from 7.7–8.2 s to 5.22 s at p90. Aggregate throughput rises from about 99 to 135.5 tokens/s (+37%). Accuracy is unchanged at 18 of 24. 33% of drafted tokens are accepted. It works alongside the JSON-schema structured outputs. It is opt-in for now (`VLLM_NGRAM=1`), because the runtime defaults are Ali's to change.
- **C, FP8 KV cache: rejected for the 7B model.** The pool doubles to 273,616 tokens, but all 24 reads fail: the planner's structured replies come back with wrong content. The grammar still holds, so the JSON parses, but its content is wrong. vLLM warns that FP8 KV without scaling factors can lose accuracy, and these AWQ checkpoints carry no KV scales. vLLM 0.33 cannot compute scales at load time. The backend is not the cause: A-triton matches A. FLASH_ATTN on this GPU does not take an FP8 KV cache, and FlashInfer needs `nvcc`, so Triton is the only backend that runs it here. (C's TTFT and tokens/s come from the failing planner calls only.)
- **B-C, FP8 KV cache on the 14B strict setup: usable.** It loses one answer (20 of 24 against 21), inside the acceptance rule, and keeps 24 of 24 citations. Reads are 15% faster (14.5 s against 17.1 s at p50), with mean TTFT 200 ms against 323 ms. The capacity gain is smaller than expected: KV bytes per token halve, but vLLM gave the pool 1.94 GiB instead of 3.13 GiB, so the pool grew only from 17,104 to 21,168 tokens. That is not enough to lift the 8192-token limit much. Why vLLM sizes the pool smaller here is not yet known. It is opt-in (`VLLM_KV_FP8=1`).
- **E, files on the WSL disk: faster, cause unknown.** Three E runs gave reads of 4.56–4.59 s at p50, against 5.13–5.23 s for the four default runs, alternated in the same session. Decode was 96.7–97.0 against 88.5–90.0 tokens/s. Prompt totals agree within 0.1% and output totals within 3.1% across these seven runs, the root path is not in the prompt, and the pool reads the files once per request. So the file read itself cannot explain a faster per-token decode. The measurement is reproducible, but the mechanism is not established. Until it is, the advice is: keep `LATENT_ROOT` on the WSL disk when the files can live there.
- **F, FP8 weights: rejected.** Decode drops from about 89 to 56 tokens/s and reads take 8.55 s at p50. Two fewer answers are correct and cited (16 against 18). Single-request decode is limited by memory bandwidth, and the FP8 weights load as 8.18 GiB against 5.29 GiB for AWQ, about 1.5× the bytes read per generated token. The larger weights also halve the KV pool to 66,960 tokens.

### The 14B strict setup (B)

21 of 24 correct and cited, with every answer cited. It costs 17.1 s per read at p50 (3.3× A), 323 ms mean TTFT and 48 tokens/s decode. Its KV pool is only 17,104 tokens (3.13 GiB at 192 KiB per token) once the 9.38 GiB of weights are loaded, and one read peaks at 616 MiB, about 19% of the pool. This is why the 14B model runs with a max model length of 8192.

### Open after this cycle

- Why the files' location changes decode speed (E).
- Why the FP8 KV pool is smaller than expected on the 14B model (B-C), and whether a higher `--gpu-memory-utilization` recovers the full 2× capacity.
- FP8 KV for the 7B model would need a checkpoint with calibrated KV scales.
- vLLM 0.33 refuses GPTQ checkpoints with `desc_act=True` (the RedHat W4A16 builds of Llama 3.1 and Mistral v0.3), found while preparing cycle 12.

### Suites and review

- Node 168/169 (one skipped); `tests/perf.test.mjs` 29/29 runs without a GPU. Graph 9/9, Playwright 13/13, runtime unittest OK (24 skipped).
- The `serve-vllm.sh` switches were checked with a stub `vllm` that prints its arguments: default, `VLLM_NGRAM=1`, `VLLM_KV_FP8=1` and both.
- **Harness reviews:** the harness was built by a Claude subagent, then reviewed by Codex and a separate Claude reviewer. They raised nine findings: mid-run restarts, failed scrapes, failed reads in latency, a lost in-flight KV sample, an unchecked `--kv-dtype`, the TPOT fallback, a correct-and-cited count and missing tests. All nine are fixed with tests in de4e060. The speculative-decoding counters were added in c224f74.
- **PR review:** a second Codex pass covered the whole PR, including a data check that recomputed every figure in this section from the raw reports and vLLM logs. It confirmed the main comparisons: D is 29.2% faster at p50 with 37.3% more throughput and 32.6% of drafts accepted; B-C is 15.5% faster; B is 3.31× A. It raised eight findings, all fixed in b451511, each code fix with a test. A confirming pass found one more low: a `--repeat` of 309 nines overflowed to Infinity. It is fixed with a safe-integer check and a test. The eight were:
  - An explicit `--model` that vLLM does not serve is now refused.
  - `nvidia-smi` samples one GPU (`--gpu`).
  - `--repeat` must be a positive whole number.
  - Five wording fixes: the sampled peak, MiB units, the mean upper bound, six calls per successful read, and the 3.1% output spread.

## Cycle 12 — Multi-LLM latent runtime (defined 2026-11-12, before measuring)

Card C12. Until now every latent measurement used Qwen, and the latent team (M2c) refused any chat template that was not ChatML. This cycle checks which parts work with other open model families and makes the latent team work with them.

### What changes

- **M2a pool:** no code change is expected. It talks to vLLM's OpenAI-compatible API, so any model vLLM can serve with a chat template should work. This cycle measures that instead of assuming it.
- **M2c latent team:** the turn texts (the open turn a later agent writes and the text that closes a turn) are derived from the tokenizer's own chat template by rendering small conversations and taking string differences, in `runtime/latent_team/chat_turns.py`. The ChatML strings stay byte-identical, so earlier M2c results stay comparable. A template the derivation cannot handle is refused with an error naming the model. The stop tokens come from the tokenizer and generation config plus the derived close token, instead of a fixed list.
- **M2b transfer:** unchanged. A mapper is trained for one sender and receiver pair, so another pair needs its own training run. This is recorded, not built.

### Models

All are public, with no license gate and no custom code, loaded from their safetensors only:

- Qwen2.5-7B-Instruct-AWQ: the reference.
- Llama 3.1 8B Instruct, AWQ INT4 (`hugging-quants/Meta-Llama-3.1-8B-Instruct-AWQ-INT4`, Llama 3.1 Community License).
- Mistral 7B Instruct v0.3, GPTQ 4-bit (`RedHatAI/Mistral-7B-Instruct-v0.3-GPTQ-4bit`, Apache-2.0).
- Granite 3.1 8B Instruct, W4A16 (`RedHatAI/granite-3.1-8b-instruct-quantized.w4a16`, Apache-2.0).
- For M2c, which runs unquantized in transformers: Phi-3.5-mini-instruct (MIT). It is not ChatML, and it has separate input and output embeddings, so it also covers the untied case that cycle 9 left open.
- vLLM 0.33.0 refuses GPTQ checkpoints with `desc_act=True` (the RedHat W4A16 builds of Llama 3.1 and Mistral v0.3), which is why the AWQ and `desc_act=False` builds are used.

### Acceptance

- Unit tests without a GPU or network: for each of seven template families (Qwen2.5, SmolLM2, Phi-3.5, Llama 3.1, Mistral v0.3, Granite 3.1, OLMo-2), the first turn, a later turn with no system block, and the close turn. ChatML must stay byte-identical. A regression test fails on the a8808ad bug for templates that inject a default system block.
- A check on the real cached tokenizers derives the turns for Qwen2.5, SmolLM2, Phi-3.5, Llama 3.1, Mistral v0.3 and Granite 3.1.
- **M2a live:** each model runs the dev and held-out sets, 3 rounds each, through the unchanged pool, with the cycle 11 harness on the dev set. The result per family is its accuracy and citations next to the Qwen reference, plus its performance figures. A family "works" when every read returns a graph (no runtime errors). Its accuracy is reported, not gated, because these are untuned models.
- **M2c live:** `latent_team.evaluate` on Phi-3.5-mini with the same protocol as cycle 9 (single, text_mas, latent_mas and the random control), on a disjoint block. It "works" when every system runs end to end and the random control scores below latent_mas. Whether latent_mas beats single is reported, not required.

## Results — Cycle 12 (multi-LLM latent runtime), 2026-11-12

Same machine and harness as cycle 11: RTX 4090 Laptop GPU, vLLM 0.33.0, default settings, strict citations off. Each model ran the dev set 3 times with `perf.mjs` and the held-out set 3 times with `run.mjs`, through the same pool code. The held-out gate is the M2a one: accuracy and citations each at least 7 of 8, plus the slice and cache shares.

### M2a pool across four families

| Model | Dev: correct and cited (24) | Held-out: correct and cited per round (8) | Held-out passes the gate | Read s p50 (dev) | TTFT ms p50 / p90 | Tokens/s per request | Prefix-cache hits | KV KiB per token | KV pool tokens | Failed reads |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Qwen2.5-7B AWQ | 18 | 7, 7, 7 | 3 of 3 | 4.89 | 40 / 186 | 90.8 | 96.8% | 56 | 137136 | 0 |
| Llama 3.1 8B AWQ | 12 | 6, 6, 6 | 0 of 3 | 8.62 | 38 / 189 | 84.9 | 96.3% | 128 | 59760 | 0 |
| Mistral 7B v0.3 GPTQ (folded system) | 24 | 5, 4, 4 | 0 of 3 | 7.93 | 38 / 193 | 93.6 | 96.8% | 128 | 73232 | 0 |
| Granite 3.1 8B W4A16 | 21 | 7, 7, 7 | 3 of 3 | 11.06 | 47 / 243 | 79.7 | 95.4% | 160 | 53648 | 0 |

- **Every family works.** After one fix, none of the 4 × 48 reads failed. Accuracy is reported, not gated, because these models are untuned.
- **Mistral needed the one code change.** On the first run all 24 Mistral reads failed with 502: its chat template refuses a system message ("Conversation roles must alternate"), and the pool sends the shared prefix as a system message. `VllmClient` now retries such a refusal once with the system text opening the user message, and keeps folding for later calls. vLLM logged exactly one refusal in the rerun. The system text is still the start of every prompt, so the prefix cache hit 96.8%, as with Qwen. Of the four families, Mistral scores best on the dev set (24 of 24) but cites least on the held-out set (5 of 8 in every round), so it fails that gate on citations.
- **Granite 3.1 does at least as well as Qwen:** on the dev set it is 24 of 24 correct (21 also cited) against Qwen's 21 of 24 (18 cited). On the held-out set the two are equal at 7 of 8 with every answer cited, passing the gate in all three rounds. It is the slowest at 11.1 s per read.
- **Llama 3.1 is the weakest here:** 12 of 24 on the dev set and 6 of 8 on the held-out set. It cites every held-out answer but gets two wrong.
- **Cost differs mostly through the KV cache.** Qwen2.5-7B stores 56 KiB of KV per token (4 KV heads); Llama 3.1 and Mistral store 128 KiB (8 KV heads, 32 layers) and Granite 160 KiB (40 layers). So with the same 85% reservation the pool holds 137,136 tokens for Qwen but 53,648–73,232 for the others. That still fits 1.6–2.2 full 32,768-token requests.
- **Per-token decode speed is similar** (80–94 tokens/s), because all four are 4-bit models of 7–8B parameters. The other families take longer per read (7.9–11.1 s against 4.9 s) mainly because they write more: 898 (Llama), 941 (Mistral) and 1,278 (Granite) output tokens per read against 563 for Qwen. They also make slightly more retry calls (6.1–6.25 calls per read against 6.0).
- **Two checkpoints vLLM 0.33 cannot load:** the RedHat W4A16 builds of Llama 3.1 8B and Mistral 7B v0.3 use GPTQ `desc_act=True`, which vLLM 0.33 refuses ("GPTQ group activation ordering ... is no longer supported"). The AWQ build of Llama and the `desc_act=False` GPTQ build of Mistral load.

### Latent team (M2c) chat templates

- The derivation gives the right turn texts for all six real tokenizers in the local cache, checked on the CPU in WSL:
  - Qwen2.5 and SmolLM2 keep the exact ChatML strings.
  - Phi-3.5 closes a turn with `<|end|>\n`, Llama 3.1 with `<|eot_id|>`, Mistral v0.3 with `</s>`, and Granite 3.1 with `<|end_of_text|>\n`.
  - Each later turn carries no system block, and each stop set includes the close token: Phi `[32000, 32001, 32007]`, Llama `[128001, 128008, 128009]`.
- The template unit tests cover seven families (adding OLMo-2) and run without a GPU or network; they skip cleanly where `jinja2` is missing.
- **Reviews:** Codex and a separate Claude reviewer found two issues, both fixed in 43b6120 with regression tests:
  - A template that only contained `<|im_start|>` was handed the ChatML strings unchecked. Every template is now derived, and ChatML is used only when the derived strings equal it.
  - The assistant lead (Mistral's leading space) is now derived and recorded.

### Latent team (M2c) on Phi-3.5-mini

`latent_team.evaluate --model microsoft/Phi-3.5-mini-instruct --steps 40 --count 200 --batch 4 --seed 0 --block 2`. Block 2 shares no question with the cycle 9 samples (blocks 0 and 1). The setup is bf16 in transformers; `nvidia-smi` read 13,906 MiB in use during latent_mas.

| System | Accuracy (200) | Mean tokens | Latent vectors | Seconds per question |
| --- | --- | --- | --- | --- |
| single | 0.855 | 268.5 | 0 | 3.78 |
| text_mas | 0.870 | 852.5 | 0 | 11.02 |
| latent_mas@40 (soft) | 0.840 | 235.9 | 120 | 5.04 |
| latent_random@40 (control) | 0.830 | 232.6 | 120 | 5.07 |

- **The machinery works on a model that is not ChatML and has untied embeddings.** Every system ran all 200 questions end to end, with the turn texts derived from Phi's own template: `<|user|>\n` … `<|end|>\n<|assistant|>\n`, closed by `<|end|>\n`, with stop ids 32000, 32001 and 32007.
- **The latent thoughts carry no measurable signal on Phi.** The random control scores 0.830 against 0.840 for latent_mas. Over 200 paired questions, latent_mas alone is right on 13 and the control alone on 11 (exact McNemar p = 0.84). On Qwen2.5-3B in cycle 9 the control fell to 0.475. The written acceptance rule ("the random control scores below latent_mas") is met numerically, but a 1-point gap on 2 questions is not evidence. That rule was too weak, and the result is recorded as **not established on Phi**.
- **Against single and text_mas, no difference is significant** either: latent_mas vs single p = 0.65, latent_mas vs text_mas p = 0.33, text_mas vs single p = 0.70.
- On cost, latent_mas still keeps its shape: 72% fewer tokens than text_mas and 2.2× faster.
- **Cycle 9 gate:** latent_mas fails it on accuracy. It is 3 points below text_mas, beyond the allowed 2, with a 95% paired interval of −0.08 to +0.02. It passes on tokens and speed.
- Only the `soft` thought mode was run, which mixes real token embeddings. The `aligned` mode, the one that uses the untied W_a, was not run on Phi.
- **Batch size:** batch 8 spills past the laptop's 16 GB: latent_mas took 20.9 s per question on the 8-question smoke run against 4.6 s at batch 4. Phi-3.5-mini has 32 KV heads (no grouped-query attention), so its KV cache costs 384 KiB per token.

What this means: the multi-LLM part is done; any chat template now runs. Whether latent thinking helps is a property of the model. It showed on Qwen2.5-3B (cycle 9) but not on Phi-3.5-mini. A next run should try the `aligned` mode on an untied model and a second non-Qwen family before any claim that latent thinking transfers across families.

### Suites and review

- Node 168/169 (one skipped), graph 9/9, Playwright 13/13.
- Runtime unittest: 154 OK on Windows (26 skipped for torch and jinja2), and 154 OK in WSL on CPU with none skipped.
- **Reviews of the chat-template derivation:** Codex and a separate Claude reviewer found two issues, both fixed in 43b6120 (above).
- **Reviews of the system-message fold (104c41e):** Codex found that the retry got the full timeout again, so a slow refusal could hold a pool slot past the deadline (medium), and that the receipt time left out the refused attempt (low). Both are fixed in b88a914 with tests against a scripted server with delayed replies; both tests fail on 104c41e. Codex's confirming pass found nothing.
- **PR review (#10):** a Codex pass over the whole PR, with a data check of every figure against the raw reports, recomputed the Phi McNemar counts and p-values and found them correct. It raised two findings, both fixed: the Granite accuracy comparison understated its dev-set lead (wording), and the real-tokenizer test left out Phi-3.5 and Granite (both now included; the test passes in WSL).
- Codex noted that the fake vLLM's cache accounting does not prove real cache reuse. The live Mistral run does: vLLM's own counters show 96.8% prefix-cache hits with the folded prompts.

## Cycle 13 — Tuning the latent hand-off (defined 2026-11-12, before any run)

Card C13. In cycle 12 the latent team ran on Phi-3.5-mini, but its latent thoughts scored no better than random vectors (0.840 against 0.830, McNemar p = 0.84). This cycle tries three ways to make the hand-off between agents carry information, from cheapest to most expensive, on the same model:

1. **Settings, no training:** thought mode (`soft`, and `aligned`, which uses the untied W_a and was never run on Phi), latent steps (10, 40, 80), and soft-thought sharpness (top-k 16 at temperature 1.0, against top-k 4 at 0.5).
2. **A trained projection adapter:** the model stays frozen. A low-rank correction is added to the thought vector, zero-initialised so training starts from today's behaviour. It is trained on the solver's answer loss, back through the latent steps.
3. **LoRA fine-tuning:** low-rank adapters on the attention projections, trained with the same loss through the same latent loop, so the model learns to read latent memory.

### Data and splits

- Training (levels 2 and 3) uses only the GSM8K train split. The target is the gold solution, ending "The answer is N."
- Settings and training choices are tuned on GSM8K test block 3 of the seed-0 shuffle (questions 600–799; 100 questions while tuning).
- Every claim is made on block 4 (questions 800–999, 200 questions), which is not looked at until the choices are fixed.
- Blocks 0, 1 and 2 were used by cycles 9 and 12 and are not reused.

### What counts

- The question is whether the thoughts carry information. The primary test is **latent_mas against latent_random with the same weights, steps and thought norm**, on the same 200 block-4 questions, with an exact McNemar test.
- A level "works" only if latent_mas beats the random control with p < 0.05.
- Secondary figures, reported but not gated: latent_mas against single and against text_mas, tokens, and seconds per question.
- For level 3 the controls must use the **same LoRA weights**. Fine-tuning on GSM8K will lift every system, so a higher score alone proves nothing; only the gap to the random control with the same weights counts.
- A level that does not reach p < 0.05 is reported as not established, with its numbers. This rule is fixed here, before any result, because cycle 12's "below the control" rule was too weak.

### Acceptance for the code

- Unit tests run on the CPU with a tiny randomly initialised model, with no download and no GPU:
  - the adapter starts as an exact no-op;
  - LoRA starts as an exact no-op, and only the LoRA and adapter weights receive gradients;
  - the loss covers only the target tokens;
  - a saved checkpoint reloads to identical outputs.
- No new runtime dependency: LoRA is written in a small module rather than added with `peft`.

### Level 1 results (tuning questions, 2026-11-13)

Phi-3.5-mini, bf16, batch 4, tuning questions 600–699 (block 6 of 100 in the seed-0 shuffle, inside tuning block 3). These are tuning figures, not claims.

| System | m = 10 | m = 40 | m = 80 |
|---|---|---|---|
| single | 0.86 | | |
| soft (top-k 16, T 1.0) | 0.86 | 0.89 | 0.86 |
| aligned (W_a) | 0.13 | 0.15 | 0.23 |
| random control | 0.88 | 0.88 | 0.84 |
| soft, sharp (top-k 4, T 0.5) | | 0.93 | |
| random control, same run | | 0.89 | |

Exact McNemar test against the random control at the same steps (questions only the thought mode got right / only random got right):

| Comparison | Split | p |
|---|---|---|
| soft @10 | 2 / 4 | 0.69 |
| soft @40 | 3 / 2 | 1.00 |
| soft @80 | 7 / 5 | 0.77 |
| soft, sharp @40 | 6 / 2 | 0.29 |
| aligned @10, @40, @80 | 1 / 76, 1 / 74, 2 / 63 | < 0.001 (worse than random) |

- No setting beats the random control. The sharp soft setting is the best on these questions, but it is not significant.
- Aligned thoughts break Phi-3.5-mini's answers. The untied W_a ridge map gives vectors the model cannot read.
- Decision, made before training: levels 2 and 3 train soft thoughts only. Aligned is dropped from the trainer (Codex review of 334ce35: the random control is noise at the soft norm, so a trained aligned run would not be norm-matched to it).
- Training runs at m = 10 for memory: the backward pass keeps every latent step's keys and values. Trained checkpoints are evaluated at m = 10 and m = 40.

Smoke runs on 16 train questions at m = 10, with all three subagents keeping gradients:

| Level | Trainable weights | Seconds per example | Peak memory |
|---|---|---|---|
| 2, adapter rank 16 | 98,304 | 3.6 | 12.1 GB |
| 3, LoRA rank 16 on `qkv_proj` and `o_proj` | 9,437,184 | 5.6 | 13.3 GB |

Runs queued: level 2 on 1,000 train questions (lr 1e-3, accumulation 8), then level 3 on 2,000 (lr 2e-4, alpha 32, accumulation 8), one epoch each. Each is evaluated on the same 100 tuning questions before block 4 is opened.

### Levels 2 and 3 results (tuning questions, 2026-11-13)

**Memory.** The first full runs stopped with "CUDA driver error: out of memory" within minutes. Phi-3.5-mini has no grouped-query attention, so every latent step keeps a full key and value copy for the backward pass, and the cost grows with the prompt. Peak memory by example length, measured on the train split (prompt p50 / p90 / max 93 / 130 / 259 tokens):

| Subagents keeping gradients | Median | p90 | p99 | Longest |
|---|---|---|---|---|
| 3 | 12.72 GB | 14.36 GB | 14.42 GB | out of memory |
| 2 | 11.67 GB | 13.05 GB | 13.15 GB | out of memory |
| 1 | 10.11 GB | 11.05 GB | 11.22 GB | 13.88 GB |

The runs use two subagents with gradients (the first runs without; all three still run) and skip prompts over 160 tokens (`--max-prompt-tokens`, 8bfbf51). The worst kept case, a 160-token prompt with a 256-token target, peaks at 13.55 GB. These runs counted the prompt text without the chat-template tokens. Codex's review of 8bfbf51 found that mismatch, and the cap now counts each turn as rendered, so the same `--max-prompt-tokens 160` keeps somewhat fewer questions than these runs did.

| Run | Examples kept | Skipped (prompt / target) | Steps | Final logged loss | Peak memory | Hours |
|---|---|---|---|---|---|---|
| Level 2, adapter rank 16, lr 1e-3 | 947 of 1,000 | 49 / 4 | 119 | 0.835 → 0.645 | 12.25 GB | 0.77 |
| Level 3, LoRA rank 16, alpha 32, lr 2e-4 | 1,893 of 2,000 | 94 / 13 | 237 | 0.626 → 0.424 | 13.46 GB | 2.04 |

Tuning questions 600–699, same weights for every system in a run:

| Run | single | soft @10 | random @10 | soft @40 | random @40 |
|---|---|---|---|---|---|
| Level 2 adapter | 0.86 | 0.83 | 0.88 | 0.85 | 0.84 |
| Level 3 LoRA | 0.79 | 0.80 | 0.81 | 0.77 | 0.79 |

| Comparison | Split | p |
|---|---|---|
| Level 2 soft @10 vs random | 2 / 7 | 0.18 |
| Level 2 soft @40 vs random | 6 / 5 | 1.00 |
| Level 3 soft @10 vs random | 4 / 5 | 1.00 |
| Level 3 soft @40 vs random | 2 / 4 | 0.69 |

- Neither trained level beats the random control on the tuning questions.
- The LoRA lowers single from 0.86 to 0.79 and shortens answers from 263 to 90 tokens: it learned the terse GSM8K solution style, which costs Phi-3.5-mini accuracy. Every system in that run carries the same LoRA, so the comparison with random is still fair.
- The adapter roughly halves the answer length of soft thoughts at m = 10 (107 tokens against 226 for random). Accuracy is 5 points lower (0.83 against 0.88, split 2 / 7, p = 0.18), a difference that is not significant.

### Block 4 choices (fixed 2026-11-13, before block 4 is run)

One setting per level, each the best gap to random on the tuning questions:

| Level | Setting | Systems |
|---|---|---|
| 1 | soft, top-k 4, T 0.5, m = 40, no training | single, text_mas, latent_mas, latent_random |
| 2 | adapter (l2-adapter), m = 40 | single, latent_mas, latent_random |
| 3 | LoRA (l3-lora), m = 10 | single, latent_mas, latent_random |

Block 4 is questions 800–999 of the seed-0 shuffle (`--count 200 --block 4`), batch 4. Each level is judged by its own McNemar test against random at p < 0.05. Three tests are run, so a single p just under 0.05 is read with that in mind.

### Block 4 results (2026-11-13)

Phi-3.5-mini, bf16, batch 4, questions 800–999 of the seed-0 shuffle (200 questions), the settings fixed above. Every system in a run uses the same weights.

| Level | single | latent_mas | latent_random | Split (latent only / random only) | McNemar p | Verdict |
|---|---|---|---|---|---|---|
| 1, sharp soft (top-k 4, T 0.5), m = 40 | 0.855 | 0.845 | 0.845 | 7 / 7 | 1.00 | not established |
| 2, adapter, m = 40 | 0.855 | 0.815 | 0.840 | 10 / 15 | 0.42 | not established |
| 3, LoRA, m = 10 | 0.730 | 0.750 | 0.775 | 4 / 9 | 0.27 | not established |

Secondary figures:

| Run | System | Mean tokens | Seconds per question |
|---|---|---|---|
| Level 1 | single | 279.6 | 3.80 |
| Level 1 | text_mas (0.825; 72% of agent turns hit the token cap) | 850.9 | 11.00 |
| Level 1 | latent_mas @40 | 254.3 | 4.97 |
| Level 1 | latent_random @40 | 239.1 | 4.76 |
| Level 2 | latent_mas @40 | 140.4 | 4.02 |
| Level 2 | latent_random @40 | 244.1 | 5.12 |
| Level 3 | single | 102.2 | 1.78 |
| Level 3 | latent_mas @10 | 99.5 | 2.39 |
| Level 3 | latent_random @10 | 102.7 | 2.49 |

- **No level shows that the latent thoughts beat random vectors on Phi-3.5-mini.** Under the rule fixed before any result, all three are reported as not established. This is a failure to show an advantage at this sample size, not proof that the thoughts carry nothing.
- **Level 1:** the sharp setting that scored 0.93 on the tuning questions ties random exactly on block 4. Its tuning lead (6 / 2) did not replicate (7 / 7, p = 1.00).
- **Level 1 gate:** latent_mas passes the M2c gate against text_mas (0.845 against 0.825, interval −0.03 to +0.07, 70% fewer tokens, 55% less time). Random vectors pass the same gate (0.845, 239 tokens), so the gate measures the cheaper pipeline, not the thoughts.
- **Level 2:** the adapter makes the solver write much shorter answers (140 tokens against 244 for random), and accuracy is 2.5 points lower (not significant). It changes the answers, but shows no accuracy advantage over random.
- **Level 3:** LoRA lowers every system: single falls from 0.855 to 0.730, and answers shorten from 280 to 102 tokens. A likely cause is the short style of GSM8K's gold solutions, but this run does not isolate it. The latent team does not recover the loss: it is 2.5 points below random with the same weights (not significant).
- **A hypothesis for a next cycle (untested):** with the gold solution as the target, a change of answer style can lower the loss without any help from the hand-off. Training against the model's own correct answers (self-distillation) would keep the target close to the model's own style, leaving less to gain that way. It would not rule out other shortcuts. A next attempt should also train at the evaluation step count; these runs trained at m = 10 for memory.
- **Review:** a Codex data check recomputed every figure in the level 2 and 3 and block 4 sections from the raw reports and training logs, and all of them match. It found one wrong statement ("without changing accuracy" hid a 5-point drop on the tuning questions) and five conclusions that claimed more than the tests show. All six are reworded above. The prompt-length and memory profile figures came from profiling runs whose output was printed, not saved, so they could not be rechecked.

## Cycle 14 — Self-distilled targets for the LoRA hand-off (defined 2026-11-13, before any run)

Card C14. In cycle 13, LoRA trained on GSM8K's gold solutions lowered every system on Phi-3.5-mini: single fell from 0.855 to 0.730 and answers shortened from 280 to 102 tokens. The latent team was not better than random vectors with the same weights (0.750 against 0.775, p = 0.27). The likely cause is that the loss could fall by copying the short gold style, with no help from the hand-off. This cycle changes only the training target. It becomes the model's own correct answer (self-distillation), which is already in the model's style.

### Method

- `latent_team.distill` runs the untrained model as the single system: greedy decoding, the single prompt, at most 512 new tokens. It covers the same 2,000 GSM8K **train** questions that `train.py` takes (seed 0).
- An answer becomes a target only if its number is right and it stopped before the 512-token budget. Every other question is skipped (`noTarget`). The gold solution is never used to fill a gap.
- `latent_team.train --targets` trains LoRA on these answers, each followed by the chat template's close. The other settings are those of cycle 13 level 3:
  - m = 10 latent steps while training;
  - rank 16, alpha 32, learning rate 2e-4;
  - gradient accumulation 8, gradients through the last 2 subagents;
  - one epoch;
  - prompt cap 160 tokens, now counted with the chat template.
- The target-length cap is the one setting that has to change, because the model's own answers are longer than the gold ones. It is chosen from the distilled answer lengths and a short memory check on the 16 GB GPU, before training starts, and recorded here before any evaluation.
- The output file holds GSM8K train questions and the model's answers. It stays with the run outputs and is not committed.

### Targets and the length cap (fixed 2026-11-13, before training)

- **Answers:** distillation answered 2,000 train questions; 1,833 are right, and 1,832 of those stopped inside 512 tokens (91.6%).
- **Length:** the kept answers are much longer than the gold solutions (cycle 13's gold-trained answers averaged 102 tokens): 261 generated tokens on average (median 250, 95th percentile 402, longest 509).
- **Memory:** peak GPU memory for one training example (m = 10, gradients through 2 subagents) at the longest target under each cap:

  | Cap (target tokens) | Examples kept | Peak memory (GB) |
  |---|---|---|
  | 320 | 1,403 | 12.52 |
  | 384 | 1,623 | 13.87 |
  | 448 | 1,711 | 13.93 |
  | 512 | 1,734 | 14.08 |

- **Cap chosen: 512.** It keeps every self target. A lower cap would drop the longest answers, which are mostly the harder questions, so the training set would lean toward easy ones.
- **What the run trains on:** 1,734 examples. 168 questions have no kept self answer, and 98 are over the 160-token prompt cap.
- **Memory setting:** the run uses `PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True` to limit fragmentation over the two-hour run.
- **Training run:** one epoch, 217 optimizer steps over 1,734 examples in 103 minutes. Mean loss 0.042 (0.085 over the first 25 steps, 0.031 by step 200). Peak memory 14.25 GB, with no out-of-memory failure.

### Data and splits

- Training uses the GSM8K train split only.
- Tuning: questions 600–699 of the seed-0 test shuffle (`--count 100 --block 6`), the same tuning questions as cycle 13. Systems: single, latent_mas and latent_random at m = 10 and m = 40. The step count with the larger gap to random is chosen.
- Confirmation: **block 5** (`--count 200 --block 5`, questions 1000–1199), which no cycle has used. Cycle 13 already looked at block 4, so it is not reused for a claim. Systems: single, latent_mas and latent_random at the chosen m, all with the self-distilled LoRA. The untrained model's single system is also run on block 5 as the baseline for the style check.

### Tuning result and the chosen step count (fixed 2026-11-13, before block 5)

All systems use the self-distilled LoRA on the 100 block-6 questions:

| System | m = 10 | m = 40 |
|---|---|---|
| single | 0.90 (258 tokens) | — |
| latent_mas | 0.88 | 0.90 |
| latent_random | 0.89 | 0.90 |
| latent_mas − random | −1 point | 0 points |

- **Chosen: m = 40**, by the rule above (the larger gap to random). Neither gap is a real lead. At m = 10 the team is one question behind random; at m = 40 they tie. So the tuning gives no sign that the thoughts help, and block 5 decides.
- **Style:** single with the LoRA scored 0.90 with 258-token answers. In cycle 13 the gold-trained LoRA gave 102-token answers, so the style shortcut looks gone. This is only a tuning read; the style prediction is scored on block 5.

### What counts

- **Primary:** latent_mas against latent_random with the same LoRA weights, steps and thought norm, on the 200 block-5 questions, with an exact McNemar test. The hand-off "works" only if latent_mas beats random with p < 0.05. Otherwise it is reported as not established, with its numbers.
- **Secondary, predicted before the run:** if self-distillation removes the style shortcut, single with the self-distilled LoRA stays within 3 points of the untrained single on block 5, and its mean answer length stays within 25% of the untrained length. Reported, not gated. Passing it only shows that the style damage is gone. It does not show that the thoughts carry information.
- Training on answers the model already gets right can still leave the thoughts with nothing to add. If so, the primary test fails, and that is a result.

### Block 5 results (2026-11-13)

Phi-3.5-mini, bf16, batch 4, questions 1000–1199 of the seed-0 shuffle (200 questions), m = 40 as fixed above. The first three rows share the self-distilled LoRA; the last is the untrained model.

| System | Accuracy | Mean tokens | Seconds per question |
|---|---|---|---|
| single, LoRA | 0.870 | 273.9 | 4.32 |
| latent_mas @40, LoRA | 0.870 | 275.1 | 6.28 |
| latent_random @40, LoRA | 0.860 | 272.1 | 6.39 |
| single, untrained | 0.870 | 274.5 | 3.90 |

Exact McNemar tests on the same 200 questions (questions only the first system got right / only the second):

| Comparison | Split | p |
|---|---|---|
| latent_mas vs latent_random (primary) | 7 / 5 | 0.77 |
| latent_mas vs single, LoRA | 10 / 10 | 1.00 |
| latent_random vs single, LoRA | 8 / 10 | 0.81 |
| single, LoRA vs single, untrained | 8 / 8 | 1.00 |

- **Primary: not established.** The team is one point above random vectors with the same weights (0.870 against 0.860, 7 / 5, p = 0.77). This is far from p < 0.05. As in cycle 13, this is a failure to show an advantage at this sample size, not proof that the thoughts carry nothing.
- **Secondary prediction: passed.** Single with the self-distilled LoRA is 0 points from the untrained single (limit 3) and its answers are 0.2% shorter (limit 25%). The drop seen with the gold-trained LoRA in cycle 13 (0.855 to 0.730, 280 to 102 tokens) does not appear with self targets. This run changes only the target, but it does not isolate why. Passing shows only that accuracy and length stay inside the stated limits on this sample.
- **Reading:** the LoRA is now close to neutral. Single, the team and random all land within one point of each other and of the untrained model. The training produced no measurable advantage over random thoughts; that is not proof the solver ignores them. A likely reason, not tested here, is the one cycle 13 found: the solver already reads the whole question, and the shared cache also holds the other agents' prompts, so the hand-off has nothing it alone can supply. Cycle 15 tests that directly with sealed agents and split facts.
- **Cost:** the team took 6.3 seconds per question against 4.3 for single with the same LoRA, for the same accuracy.
- **Code review:** Codex reviewed a420d9d. It found no bug in how targets are built, which questions are kept, the split read, or the fairness of latent against random. It found two test gaps: the distill CLI test passed its items in, so a different sample from `train.py`'s would go unseen; and no test kept a generated answer, so a scorer that always says wrong would pass. 7eb5009 adds an end-to-end test that runs both CLIs on their own sampling, and both mutations Codex named now fail it.
- **Data check:** Codex recomputed every figure in this section from the raw reports and logs (except the memory table, from a printed profiling run). All match: the counts and lengths of the targets, the training run, tuning, block-5 accuracy, tokens and times, the four McNemar splits and p-values, and the style gap. It confirmed the same question order in all four block-5 systems, the C14 LoRA path, m = 40, and no checkpoint in the baseline. It flagged three sentences that claimed more than the tests show (that self targets "removed" the damage, that passing showed the style damage "is gone", and that the solver uses "nothing" from the thoughts). All three are reworded above.

### Acceptance for the code

- CPU unit tests with the tiny model, with no download and no GPU:
  - only right answers that stopped inside the budget are kept;
  - a targets file from another model, or in another format, is refused;
  - the CLI writes the single system's greedy answers in the train-sample order;
  - with `--targets`, the targets are the kept self answers plus the close, and the other questions are skipped and counted;
  - without `--targets`, training still uses the gold solutions as in cycle 13;
  - a file with no kept answer stops the run.
- No new runtime dependency.

## G12 — Export for code-graph tools (defined 2026-11-17, before the code; revised after trying the real Graphify and after review round 1)

Graphs can be exported as node-link JSON, the format NetworkX writes and Graphify keeps in `graphify-out/graph.json` (edges under `links`), so `graphify merge-graphs` can put decisions beside a code graph. Several graphs go into **one file, a bundle**. `merge-graphs` gives each input file its own ID prefix when their tags collide, so links between graphs only survive inside one file. The routes are `GET /api/export?graph=<id>&graph=<id>…` (1 to 20 graphs) and `GET /api/graphs/:id/export` (one graph). The CLI is `node src/cli.mjs graph export <id> [<id>…]`. Run it directly, because `npm run` prints a banner into a redirected file. The HTTP body is the node-link JSON itself, with no wrapper, escaped like every export.

- **Graph:** `directed: false` and `multigraph: false`, as Graphify's own graphs are. `merge-graphs` composes into an undirected graph and refuses a directed one; running it showed this. `graph` lists the exported graphs (ID, party, session) and `links_left_out`.
- **Nodes:** `ctm_<first 16 hex digits of the graph ID>__<node id>`, with `-` turned into `_`. The graph ID is immutable, so two snapshots of one party never share a node. An export of two graphs whose IDs share those 16 digits is refused. Node IDs allow only lowercase letters, digits and single hyphens in both schemas, so the rest is one-to-one. Each node keeps `label`, `kind`, `status`, `to` and `party`, and gets:
  - `file_type`: `rationale` for decisions and constraints, `concept` for the rest;
  - `source_file` and `source_location`: the transcript's file name and the cited lines, which are ledger evidence, not a code path;
  - `ledger_graph` and `ledger_node`, which lead back to the ledger.
- **Links:** one per edge, and one per cross-graph link whose other graph is in the bundle. Each has `relation` (the edge or link type), `confidence` `EXTRACTED`, `confidence_score` 1, `weight` 1, `source_file` and `ledger_graph`. Because the graph is undirected, `ledger_from` and `ledger_to` keep the direction. A link to a graph outside the bundle is left out and counted, so the merge never gains a node without a label or provenance. Two relationships can never share one unordered pair. Within a graph, the allowed kind pairs give each unordered pair at most one edge type, and the cycle checks rule out reciprocal `depends_on` and `supersedes`. Across graphs, a graph has one link per node pair, and a snapshot can link only to a graph already stored, so two snapshots cannot link to each other.

### What is tested (synthetic transcripts only)

, and the same output twice.
- **IDs:** two snapshots of one party with the same node ID get different export IDs. A version 1 graph is exported under its graph ID too.
- **Links out of the bundle** are left out and counted. An unknown graph is not found, and a graph listed twice is refused.
- **HTTP:** the body holds no raw bidi or format character and parses back to the same text. Refusals use fixed messages: no graph, more than 20, an unknown parameter, a bad ID, a repeat, a parameter on the single-graph route. An unknown graph gives a fixed 404.
- **CLI:** prints the same JSON, escaped, for one graph and for two (whose cross-graph link must be in the output).
- **A real merge,** by hand with Graphify 0.9.4 (Graphify is not a dependency): a bundle of two parties and a synthetic code graph give one graph with all their nodes and the cross-party links. The result is recorded below.

### Acceptance

- The four suites pass, with no new runtime dependency.
- Codex reviews the change read-only; findings are fixed with tests or recorded here.

### G9 results (2026-11-17)

- **Built:** `src/scope.mjs` ranks the nodes for a question and cuts the result to a budget. `graphContext` in `src/context.mjs` renders the scoped graph with the same `contextText`, plus a last scope line, and reads each linked graph once per request. `GET /api/graphs/:id/context` takes `question` and `budget`, and `context_for` takes them too, caching paged scoped briefings under graph ID, question and budget. Without either argument, nothing changes.
- **Tests:** `tests/scope.test.mjs` (13): ranking and matching rules, the budget, the golden unscoped output, the links fixture, the MCP cache and argument checks, and the real route with paging.
- **Codex review, round 1** (of 103051b), six findings, fixed in c991f6a:
  - (high) A budget smaller than the briefing with no nodes was answered over budget. It is refused now, with the size, and every budget path checks the meter.
  - (medium) Words were double-counted, `café` became `caf` (finding `cafeteria`), and one letter of another script matched anywhere. The question is now split once into Unicode words, each with one rule.
  - (medium) The cache-key test changed two things at once. Question and budget are now varied one at a time, each with its own text.
  - (low) The 500 limit counted UTF-16 units, not characters. It counts code points now.
  - (low) Each budget probe repeated work. It now counts shown matches directly and reads linked graphs once.
  - (low) The eval claimed more than the tests checked. A golden output from main, a links fixture and real-route paging are added.
- **Round 2** (of c991f6a): all six fixes hold. Three more findings, fixed in bef4378: an ASCII word missed a mixed-script node word (`gpu` and a label `GPU` followed by a Han letter); letter pairs could end inside a marked letter; and two coverage notes (blank question over HTTP, MCP's handling of a repeated JSON name).
- **Round 3** (of bef4378): those fixes hold. One low finding is fixed in the next commit: an ASCII prefix is now compared in whole letters, so `qax` no longer stops inside an `x` with an accent.
- **Suites (Windows):** `npm run -s test:graph` 9/9; node 203/204 (one skipped), was 191/192 on `main`; Playwright 13/13; Python runtime 192 run, 50 skipped, OK.

- A person runs `install` and `uninstall` once against their real agents before G8 is called done, because the tests use stubs.

### G8 review log and an incident (2026-11-17)

- **Round 1** (of 3af4131), ten findings, among them high ones: uninstall removed registrations it never made; UTF-16, invalid UTF-8 and BOM files could be damaged; the rename replaced links and modes. Fixed in 50025c6 with an install record.
- **Round 2** (of 50025c6): five high findings, all about that record (stale, malformed or unsaved) and about probes reading a different scope from the one written. The record was dropped in a48d7eb for exact-match removal.
- **Round 3** (of a48d7eb): exact matching could not be made safe either. Claude prints arguments joined, Codex reports the effective entry but removes from its global table, and `claude mcp get` can start project servers for a health check. In 591da7c the card was narrowed: uninstall prints the remove commands instead of running them, and install never calls `claude mcp get`.
- **Round 4** (of 591da7c), fixed in the next commit:
  - (medium) A file swapped for one with the same bytes, or given another mode, passed the byte check. The identity is now checked too.
  - (medium) Any "already exists" text counted as Claude's duplicate answer. Only Claude's own answer counts now.
  - (medium) A relative `CODEX_HOME` meant different folders to Codex and to the block. It is resolved once.
  - (low) An existing Codex HTTP entry was not recognised. It is now.
  - Accepted, not changed: the high finding that a registration made in another terminal between `get` and `add` is replaced. Codex's suggested fix, printing the add command instead, would drop automatic registration, which is the point of the card. The window is one CLI call long and is recorded above as a known limit.
- **Incident, found and fixed while writing the round 4 tests:** three in-process tests called `setupAgents` with a sandbox environment, but `agentTargets` took the home folder from `os.homedir()`, which reads the real one. They wrote the block into the real `~/.claude/CLAUDE.md` (19:17) and `~/.codex/AGENTS.md` (19:29) on the reviewer's own machine. No real CLI was run, because those tests used fake CLIs. Both files were backed up and the exact block was removed with the module's own `withoutBlock`; each file is now a byte-for-byte prefix of its backup. The home folder now comes only from the environment passed in (`homeOf`). An environment without one is refused. The last test in `tests/install.test.mjs` checks that the real files are byte for byte as they were before the run.
- **Round 5** (of 05ba804): the HTTP fix and the fake-home fix hold. Medium findings, fixed in the next commit:
  - The snapshot read bytes and mode separately from the identity. Now one open file gives both, and the path must still name that file.
  - Claude's duplicate answer now counts only as the whole line.
  - A `CODEX_HOME` that does not exist is refused before Codex is asked, as Codex refuses it.
  - A relative CLI path is resolved to an absolute one, because the CLI runs from the home folder.
  - The printed Codex remove command names its `CODEX_HOME`.
  - Test children get an allow-listed environment (no `NODE_OPTIONS`).
  - Accepted: the real-file guard still reads the default instruction files of the person running the tests. An isolated ambient home would be stronger, but every in-process call now passes an explicit fake home, and an environment without a home is refused.
  - No sixth round was run; the findings had narrowed to edge races each round.
- **Suites (Windows):** `npm run -s test:graph` 9/9; node 219/221 (two skipped: the existing one and the symbolic-link test, which this Windows account cannot run), was 191/192 on `main`; Playwright 13/13; Python runtime 192 run, 50 skipped, OK.
- **Still owed before Done:** a person runs `install` against their real Claude Code and Codex, then `uninstall` and the two printed remove commands, on Windows and on macOS or Linux.

### G11 results (2026-11-17)

- **Built:** `src/diff.mjs` (the diff and its counts); `GET /api/graphs/:id/diff?from=:otherId` and the store's `diffGraphs`; the MCP tool `graph_diff`, paged by item; `newerGraphs` in rooms; and the room view's notice, which lists changed labels and has a button that fills the form.
- **Tests:** `tests/diff.test.mjs` (11), the pinned tool list and required arguments, and two Playwright tests in `tests/e2e/room.spec.mjs` (a newer graph, and a diff that answers after another room was opened).
- **Codex review, round 1** (of the first G11 commit), eight findings, fixed in 39556a9:
  - (medium) A graph from another transcript under the same party name was offered as the room's update. It is now marked `sameSession: false`, shown as unverified, and has no form button.
  - (medium) A reused node ID could fake a supersession or an answer. Both now need the real edge and kind.
  - (medium) A removed ready action was missing from `readyActionsLost`.
  - (low) The room summary left out answered questions and ready changes.
  - (low) `graph_diff` was outside the tool-list bound. It now has a bound of its own.
  - (low) Unknown parameters were accepted. The route now takes only `from`.
  - (low) Weak assertions were tightened.
  - (low) No paging or race test existed for the new room data. Both are added in round 2.
- **Round 2** (of 39556a9): most fixes hold. One medium finding: a later graph from another session hid the room's own same-session update. Same session and other sessions are now looked up separately, and both can show. Two low findings: a lost ready action took the name of a node that reused its ID, and readiness rows were hidden behind "Changed". Both are fixed, with the paging-across-sections and browser race tests asked for.
- **Suites (Windows):** `npm run -s test:graph` 9/9; node 202/203 (one skipped), was 191/192 on `main`; Playwright 15/15 (two new); Python runtime 192 run, 50 skipped, OK.
- **Known limit:** party names are self-asserted. A graph from another transcript is shown, marked unverified, but not offered.

### G12 results (2026-11-17)

- **Real merge**, by hand on Windows with Graphify 0.9.4 (NetworkX 3.6.1), from a folder holding `graphify-out/`:
  - The inputs were a bundle of two synthetic parties (5 nodes, 3 links, 2 of them cross-graph) and a synthetic code graph (2 nodes, 1 link).
  - `graphify merge-graphs graphify-out/graph.json graphify-out/ctm-decisions.json --out graphify-out/merged.json` reported "Merged 2 graphs -> 7 nodes, 4 edges".
  - Both cross-party links joined the right nodes.
  - The undirected merge wrote `supersedes` with its ends swapped; `ledger_from` named the right end.
  - An earlier attempt with one file per party, before the redesign, kept the links only because both files got the same Graphify prefix, which review round 1 showed is not guaranteed.
- **Codex review, round 1** (of d61e5cf): two high findings, four medium and one low.
  - (high) Two snapshots of one party shared node IDs. IDs now come from the graph ID.
  - (high) Merging one file per party relied on Graphify giving them one prefix. Exports are now bundles.
  - (medium) Links to absent graphs could become nodes without labels. They are now left out and counted.
  - (medium) Reciprocal relationships could collapse in an undirected graph. The invariants above show they cannot occur, and `ledger_from` and `ledger_to` keep direction.
  - (medium) The HTTP body was not escaped. It is now escaped, and it is the node-link JSON itself.
  - (medium) The README steps would fail. They are rewritten.
  - (low) The eval claimed more than the tests checked. Fixed in e9c10fe.
- **Round 2** (of e9c10fe): the redesign holds, with no new data-loss defect. Three low findings are fixed in the next commit: the README example (labelled Git Bash, quoted placeholders), eval precision (this section, the prefix guard, the invariants, and full-record and two-graph tests), and the export now reads only the transcript's summary row.
- **Suites (Windows):** `npm run -s test:graph` 9/9; node 196/197 (one skipped), was 191/192 on `main`; Playwright 13/13; Python runtime 192 run, 50 skipped, OK.

## U1 — Console v0, light (defined 2026-11-17, before implementation)

Source: the console direction ([docs/product-direction-console.md](product-direction-console.md)) and the build prompt for the light console. One page in the existing loopback app that shows which agents are working, what they put into the ledger, and the line that proves each fact. It reads; it never runs agents or writes to the ledger. Synthetic data only: the demo replays the committed Orbit transcripts in `demo/`.

Terms used below. A **party** is the `party` of a version 2 graph (the session ID for a version 1 graph). The **current graph** of a party is its newest published graph. A node is **new** in a publish when its party's previous current graph had no node with that ID. **Today** is the viewer's local calendar day.

| Eval | Expected |
| --- | --- |
| Served by the app | `npm start` serves the console at `/console/`. Its files come from a fixed list in `src/server.mjs`, like the existing static files; any other path under `/console/` is a 404. No build step and no new runtime dependency. Every response pinned by `tests/routes.test.mjs` is unchanged, and the new files carry the same security headers. |
| Read-only | The page sends only GET requests, in live mode and in demo mode (Playwright records every request). The only server change is the new static entries: no new write route, and no change to any existing route. |
| Office | An isometric SVG floor with one room per agent source the ledger imports (Claude Code, Codex). One character per party that published today (live) or in the recording (demo), in its provider's room, labelled with the party. Its state is **working** when that party published in the last 60 seconds (6 seconds of demo time in the demo, which runs faster), **waiting** when its current graph has an open question to another party that no current graph answers by link, and **idle** otherwise. The state is text as well as shape, so it does not rely on colour. |
| Ledger graph | Shows the nodes of every current graph, grouped by party. A new node pops in. Each publish draws a flash line from the publisher's room to each new or changed node, and a dashed line to each node of another party that the publish links to (the evidence that it read that graph). Lines and pops come only from published graphs; nothing moves on a timer of its own. A superseded decision is struck through. A node carrying a G7 quoted or inferred mark gets that colour; without the mark (G7 is not built) every node has one neutral colour. |
| Evidence in one click | One click on a node, or Enter on it when focused, opens the evidence panel with the cited transcript turns and the turn before and after, the cited lines highlighted, the source agent and the line numbers. Every transcript string is set with `textContent`. A label and a transcript turn containing `<img src=x onerror=…>` and a right-to-left override render as text: no element is created and no script runs. |
| Numbers | **Hand-offs today:** graphs published today. **Tokens saved:** the sum of `meter.savedTokens` over the current graph of each party that published today, labelled as an estimate with the meter's method. **Superseded decisions:** decisions that a `supersedes` edge replaces in the current graphs (G11's graph diff is not built). In demo mode the finished numbers equal values computed independently from the recording. |
| Live updates | The page polls `GET /api/graphs` every 2 seconds and reads only graphs it has not seen. A graph published through the API while the page is open appears within 3 seconds. |
| Demo mode | `/console/?demo` plays a bundled recording of a two-agent session (Leo in Claude Code, Ali in Codex), without any ledger data, in about 35 seconds, with Replay. `node demo/console-recording.mjs` builds the recording by running the real store on the demo transcripts and saving its responses; a node test rebuilds it and compares it with the committed file byte for byte. |
| Screenshots | A Playwright test runs the demo and saves four screenshots: empty, mid-run with at least one flash line visible, finished, and the evidence panel open. |
| Light and fast | Measured by Playwright in demo mode and saved next to the screenshots: everything the page loads is under 300 KB, and first contentful paint is under 1 second. No WebGL, canvas 3D or third-party script. |
| Phone | At 375 px wide there is no horizontal scroll and the parts stack in one column. |
| Feature map | `docs/feature-map.md` lists each console feature in user words. |
| Left to a person | The 60-second screen recording (raw material for U3) is not made by an agent; the results say how to record it. |

**Results — U1 (2026-11-17, Windows):** every row passes except the recording, which is left to a person. Code in `public/console/`, the recording builder in `demo/console-recording.mjs`, tests in `tests/console.test.mjs`, `tests/console-live.test.mjs` and `tests/e2e/console.spec.mjs`, screenshots and `perf.json` in [docs/console/](console/).

- **Served by the app: pass.** `src/server.mjs` adds `/console`, `/console/` and nine named files to the static list; nothing else changed in the server. A node test fetches every file in `public/console/` and checks its type, the security headers and its bytes, that POST is a 404, and that `/console/index.html`, `/console/nope.mjs`, a trailing slash, an encoded `..` and `/public/console/…` are 404. `tests/routes.test.mjs` passes unchanged. No new dependency and no build step.
- **Read-only: pass.** The Playwright demo and live tests record every request: all are GET. The demo makes requests only under `/console/` (it never calls the API). A node test also refuses any POST, PUT, PATCH or DELETE in the console modules.
- **Office: pass.** Two rooms (Claude Code, Codex), one character per party, labelled with the party and its state in text and shape (desk for working, "?" bubble for waiting, dimmed for idle). Live, only parties that published today. Node tests pin the states on the recording (Ali working right after her publish, then waiting on her question; at the end Leo waiting for Ali and Ali idle after Leo's answer by link) and the today filter. The office module was written by a subagent against a fixed interface.
- **Ledger graph: pass,** with one change of scope written down here: live, the graph holds the parties that published today, the same as the office. Pops and flash lines happen only when `onGraph` applies a published graph. Node tests pin what moves on each recorded publish (new, changed, linked), that a changed recipient or changed cited lines count as a change, that superseded decisions are struck, and that questions answered inside their graph or by an equivalent link show as answered. G7 is not built, so every node has `data-mark="none"`; the e2e test checks all 11 demo nodes.
- **Evidence in one click: pass.** One click, or Enter on a focused node (focus stays on the node; the panel announces through a status region), shows the cited turns with the turn before and after. The e2e test checks lines L26 to L29 for "The ledger stays on port 4317", with L27 and L28 highlighted. A live graph whose label holds `<img src=x onerror=…>` and whose transcript holds a right-to-left override renders as text: no `img` element, no script run, and the override shown as `‮`, with the same escape rule as `src/text.mjs` (a node test compares the two on 14 samples).
- **Numbers: pass.** At the end of the demo: 6 hand-offs, ≈ 1,546 tokens saved (estimate), 1 superseded decision. A node test computes each from the recording independently, and checks that a graph from two days ago counts as neither a hand-off nor a saving today.
- **Live updates: pass.** The e2e test publishes a graph while the page is open and sees it within 3.5 s. `tests/console-live.test.mjs` drives the poller against a fake ledger: the first read pages back to the start of today (250 graphs over 3 pages, plus 40 from yesterday, gives 3 list reads and 4 graph reads), a poll with nothing new is one list read, failed reads are retried, and a meter is read after its graph.
- **Demo mode: pass.** `/console/?demo` plays 6 publishes over 34 s, with Replay. The recording is rebuilt by the real store and compared with the committed file (line ends aside).
- **Screenshots: pass.** `01-empty.png`, `02-mid-run.png` (a dashed read line from the Codex room to two of Leo's nodes; the test checks the stroke is drawn and not faded), `03-finished.png`, `04-evidence.png`, and `05-phone.png`.
- **Light and fast: pass.** 84.5 KB for everything the demo page loads (the recording is 23 KB), first contentful paint 84 ms, load 62 ms, on this laptop (56 to 84 ms over the runs of this card) in headless Chromium with the cache off. No canvas, WebGL or third-party script.
- **Phone: pass.** At 375 px there is no sideways scroll and office, graph, evidence and numbers stack in that order.
- **Feature map: pass.** [docs/feature-map.md](feature-map.md).
- **Left to a person:** the 60-second recording. How to make it is in the U1 checkpoint of [the handoff notes](handoff.md).
- **Codex review, round 1** (`codex exec --sandbox read-only`, of 5c3db9d): request changes, ten findings. Fixed in 418feb4, each with a test:
  - (high) The first live read could skip a current graph and lose publishes after a cap. It now pages back to the start of today (up to 50 pages) and repeats the first read until every party's newest graph is read.
  - (medium) A failed first read could turn older snapshots into live events; (medium) one slow or failing graph blocked the rest. Reads now have an 8 s deadline, failed graphs are kept and retried, and a graph is drawn before its meter.
  - (medium) A changed recipient or changed cited lines did not count as a change. (medium) An answer to an older question closed a new question with the same ID. (medium) The office kept yesterday's parties, and the numbers did not refresh at midnight. (medium) A failed transcript read was cached, and the open proof did not follow its node. (medium) Evidence took focus from the node after loading, and a question answered inside its graph showed as open. All fixed.
  - (low) Tests that would pass with the feature broken: added Enter on a node, a visible flash, demo paths, a version 1 graph and the live poller tests.
  - Rejected: (low) the office's CSSOM transforms and `aria-label` text. The CSP (`style-src 'self'`) allows CSSOM, and setting an attribute parses no HTML. Codex withdrew it in round 2.
  - Accepted as a v0 limit: a room with more than 6 parties shows "+N" (each party still has its labelled graph column).
- **Codex review, round 2** (of 418feb4): four fixes confirmed, six partly fixed, and four new defects. Fixed in 4c62792, each with a test that fails on 418feb4:
  - (high) With no publish yet today, the next poll replayed yesterday's graphs as live. The newest older graph is now marked seen on the first read.
  - (high) Two snapshots with the same time could leave the older one current after a retry. Rows now carry their place in the list, and a late older snapshot is only counted.
  - (medium) A fast meter reply stripped the pop animation. A meter now redraws only the numbers, and a redraw keeps a running animation.
  - (medium) A linked graph that failed three times was never read again. It is retried after a growing pause.
  - Partly fixed, now closed: an answer also needs the same cited lines, and the open proof is reread when its agent's transcript changes.
  - Accepted as v0 limits: graph reads are serial, with an 8 s deadline each; the live view starts at the start of today.
- **Codex review, round 3** (of 4c62792): the four round 2 defects are fixed, and the new tests fail on 418feb4 for three of them. Two more findings, fixed in the next commit:
  - (medium) The list-order guard from round 2 could block a valid retry when the clock moved back: A current, B's read fails, C is published with an earlier time than A, and the model refused C on time while the source had already counted B. The model no longer compares times; both sources deliver snapshots in publish order (the live one by place in the ledger list), so the last one wins. A test runs exactly that case and ends on C.
  - (medium) The new flash assertion sampled the opacity once and could catch the fade-in. It now waits up to 2 s for an opacity above 0.5. The console spec then passed three runs in a row.
  - Accepted: an answer still closes a question reused with the same ID, words, recipient and cited lines from another transcript (that is the same question as far as the graph can tell). The pop kept after a meter reply and the proof following a transcript switch have no browser test.
- **Suites (Windows):** `npm run -s test:graph` 9/9; node 214/215 (one skipped), was 191/192 on `main`; Python runtime 192 run, 50 skipped, OK; Playwright 17/17 (4 new).

## U3 — 60-second demo video (defined 2026-11-17)

Stacked on U1 (`ruslan/console-v0`), because the video shows the console. The card asks to script and record the install, two agents, the graph growing, and a click-through to a cited line, on synthetic transcripts only.

### What this card delivers, and what a person must still do

- **Delivered:** the shot list and voice-over (`docs/video/u3-script.md`), timed to 60 seconds, and `demo/record-console.mjs`. The script records the console part as raw 1280×720 footage: the bundled synthetic Orbit recording played to the end, and the proof of one decision opened. The recorder plays the demo at 1.3× and writes a cue sheet with the measured second of each moment. A run on Windows gave 44 seconds at 1280×720, checked frame by frame: the office, the cards popping in with flash lines, the answer link at 22 s, and the cited lines L27 and L28 highlighted at 30 s.
- **For a person:** the terminal shots, the voice-over and the cut, which need a microphone and a screen recorder. Also the install shot, which waits for G8 (`ledger install`) or uses the README's two `mcp add` commands until then.

### What is tested

`tests/video.test.mjs`:

- the five shots run from 0:00 to 1:00 with no gap or overlap, and no shot needs more than 2.5 words a second;
- the numbers shot keeps the "estimate" label, and the closing line claims only that the ledger stays on the machine;
- the demo recording holds Leo's `answers` link to Ali's question and the decision citing lines 27 and 28;
- the replay fits the growth shot at the recorder's speed, and every cue the script names is one the recorder marks;
- the recorder lets only console files load, starts the ledger with a small environment, and publishes only its own take without touching other files.

The browser take itself is not run in the suites: it needs about 45 seconds and Chromium. It was run by hand.

## U2 — Brand and mascot (defined 2026-11-17)

A brand guide for the console (U1), the video (U3) and other pages, built on the CTM site's existing brand: `docs/brand/brand.md`, `docs/brand/tokens.css`, and an original mascot, Pip, in three poses (`pip.svg`, `pip-working.svg`, `pip-waiting.svg`) that match the console's agent states.

### What must hold

- The brand colours are the CTM site's own (Deep Charcoal, Electric Violet, Acid Lime, Paper); no second palette.
- Every text and background pair in the light (console) and dark (site) sets passes WCAG AA, 4.5:1. That includes the quoted and inferred marks on their fills and white text on the primary. White on lime is kept out, as the site's rule says.
- No state is told by colour alone: each mark and agent state also has a word or a pose.
- Pip is original. It takes Capy's warmth as a reference only, with no copied assets or look.
- Pip's SVGs can be inlined under the console's content security policy as they are: small, named with aria-label (no IDs to clash), presentation attributes only, no scripts, styles, outside resources or fonts, and only the palette, White and two documented illustration colours.

### What is tested

`tests/brand.test.mjs` checks the site's colours (Soft Violet included), contrast for every pair the guide names in both sets, that the dark set sets every one of those variables itself, that the ratios the guide prints are the computed ones, the SVG rules above with an allowlist of elements, attributes and colours, and that the guide's file links exist. It does not check the CTM site's stylesheet itself, or how Pip looks. The poses were also rendered with Playwright on Paper and on Charcoal and checked by eye.

## D1 — T3 Code integration (defined 2026-11-17)

D1 is the guide for using the ledger from T3 Code. The importer for T3's thread store, first part of this card, moved to D3, and `ledger install` belongs to G8.

### The guide (built)

`docs/integrations/t3code.md`, written from T3's public documentation, with the page behind each step linked:

- T3 runs Claude Code and Codex with their own configuration. So the server is registered for those CLIs, as in the README, on the machine of the environment whose threads use it, because the ledger answers on loopback. Whether T3 sessions load it is unverified, and a check from a new thread ends the steps.
- T3 instances with their own `CLAUDE_CONFIG_DIR` or `CODEX_HOME` need the server registered in that folder. A Codex shadow home shares the main home's configuration.
- Other providers, and T3's own outside-agents MCP endpoint, are out of scope; the guide says which direction that endpoint goes.
- What was not checked, since we have not run T3.

`tests/integrations-t3.test.mjs` checks the guide against this repository only. Every full registration command uses the server name `context-ledger` and runs `node` with `src/mcp.mjs`. The README sections it links to exist, every T3 link points at the T3 repository, and the guide marks what is unverified. It does not check T3 itself: a live run with Claude and Codex providers is still owed, ideally with a synthetic imported transcript, `session_read` and a cited `graph_publish`.

### The importer (not built; blocked)

An importer would read T3's SQLite store read-only, from a copy the person makes. We did not build it, for three reasons:

- T3's V2 store (`statev2.sqlite`) is event-sourced, and its tables are not documented.
- The only layout T3 documents is the recovery query for the V1 database (`state.sqlite`). V2 keeps an event log with derived tables whose layout is not documented.
- We have no test database made from synthetic threads on a pinned T3 release, and the ledger's store takes only Claude Code and Codex transcripts (a third provider is a schema change, after P1).

An importer built on a guessed layout could silently misread threads, which matters for a tool whose point is citing the exact line. A new Backlog card, D3, holds it until a sample database exists.

## D2 — Capy integration guide (defined 2026-11-17)

A guide, `docs/integrations/capy.md`, for adding Context Ledger as an MCP server in a Capy organization. It is written from Capy's public documentation and links the page behind each step.

### What it must say

- First, what leaves the computer: the ledger stays local, but Capy stores thread messages and tool output in its cloud, so whatever a tool returns is copied there and seen by the thread's audience. Start with synthetic data.
- The ledger answers on loopback only, and Capy runs a STDIO server on the thread's own machine. The server therefore works only for threads on the computer that runs the ledger (desktop app or Dock CLI), not for cloud threads. The guide says so first, and advises against running the ledger on a cloud machine.
- The exact form values (STDIO, key `context-ledger`, `node` plus the absolute path to `src/mcp.mjs`, `PORT` only when it differs, owner **Only you**, no sign-in), and why the owner is not Organization.
- How to check the connection, and how to tell the agent to use the tools through Capy's instructions or `AGENTS.md`.
- What the agent should not trust (everything a tool returns), and who can reach the ledger: any process on that computer, teammates on a shared device, and members who message the thread. The browser check on room decisions does not prove a person clicked.
- What was not checked: no run in a real Capy organization yet.

### What is tested

`tests/integrations.test.mjs` keeps the guide in step with the code: the key fits Capy's key rule, the path it names exists, the README section it links to exists, the TOML block matches the README's, and every Capy link is an `https://docs.capy.ai/` page.

### Acceptance

- The four suites pass.
- Codex reviews the script and the recorder read-only; findings are fixed or recorded here.
- A person records and cuts the video, and links it here.

### U3 review (2026-11-17)

- **Codex, round 1** (of 0a68d2b): three high findings and five medium, fixed in the next commit:
  - (high) The recorder deleted every other `.webm` in its output folder. It now records into a private staging folder and writes `console-demo-<time>.webm` and a cue sheet beside whatever is there, touching nothing else.
  - (high) The closing line "your transcripts never leave your machine; only the cited summary goes to the agent" promised more than the tool does: `session_read` returns original turns. It now says only that the ledger stays on the machine and that agents get cited context.
  - (high) The terminal shot had no steps to keep real data off screen. The script now asks for a throwaway account or virtual machine with no other database, demo-only agent settings, an empty history and synthetic paths.
  - (medium) The growth shot ended before the answer it narrates. The recorder plays at 1.3× and writes a cue sheet, and the shots are cut by cues.
  - (medium) Startup and shutdown could leave the ledger or temporary files behind. Every resource now has a cleanup that runs even when another fails, the ledger has a start deadline, and a spawn error or early exit is reported.
  - (medium) The ledger inherited the caller's environment, and the page could load anything. It now gets a small environment, and the take fails if the page loads anything outside the console's files.
  - (medium) The install line assumed G8, and "the line behind every fact" overstated what citations prove. Before G8 the script has its own line, and the growth shot is described as a replay of agents citing their transcripts.
  - (medium) The tests are now as listed above.
- **Codex, round 2** (of 5dff274): the privacy, isolation, timing and wording fixes hold. Fixed in the next commit:
  - (high) A take with the same name could overwrite an earlier one, or leave half a pair. The name now has a random part, both files are created exclusively, and a failed publish removes what it wrote.
  - (medium) A failed spawn could stall cleanup. The ledger's end is now the first of close or error, shutdown is bounded, and cleanup failures are reported.
  - (medium) The request guard accepted any path under `/console/`. It now allows only GET requests for the console's own files (a test pins that list to the folder), and service workers are blocked.
  - (low) The cue test now checks that the recorder marks every cue once, in order, and that the script uses them.
  - A new take after these changes loaded nothing outside the list, and the earlier takes in the folder were kept.
- **Not covered by the suites:** the browser take itself, and a spawn failure, which would need the ledger start exported. Both are in the recorder's code paths, and the take was run by hand.
- **Suites (Windows):** `npm run -s test:graph` 9/9; node 218/219 (one skipped); Playwright 17/17; Python runtime 192 run, 50 skipped, OK.

- A read-only review by Codex of the guide, the tokens and the SVGs; findings fixed or recorded here.
- A person on the team signs off on Pip's look before the console and video use it.

### U2 review (2026-11-17)

- **Codex, round 1** (of the first U2 commit): one high finding, four medium, five low. All are fixed in the next commit:
  - (high) The guide said the console could serve the SVGs as they are. Its policy has no `img-src`, so the guide now says to inline them, as U1's office module builds its figures, and what image files would need.
  - (medium) The dark set inherited the light badge fills (1.6:1). It now sets dark fills and every text, fill and button variable itself.
  - (medium) The dark strong violet failed on Charcoal (3.1:1). Links, link hover, button fill, button hover and button text now have their own pairs.
  - (medium) Inlined Pips shared the title ID `t`. Each file now names itself with `aria-label` and has no IDs.
  - (medium) At small sizes the pose is lost. Every state now also shows its word, and the lime spark is marked as decoration.
  - (low) The waiting pose now keeps the tag, and the working pose is described as reading it.
  - (low) The off-palette cheek colour is gone, and the illustration shades are listed and tested.
  - (low) Savings claims now point to BENCHMARKS.md instead of naming two figures.
  - (low) The test is stricter: exact pose names, printed ratios, and an element and attribute allowlist.
  - (low) Codex saw low resemblance to Capy's capybara, but a plausible one to Tinky Winky (purple round body, pale belly, head ornament, carried item). Pip is now an index card with a folded corner and ruled lines, which ties it to the ledger and drops the round body and belly. The guide says to avoid both. The human sign-off stays, with a side-by-side check.
- **Codex, round 2** (of 9bc136c): the CSP, dark-set, ID, small-size, tag, cheek and wording fixes hold, all 19 printed ratios are correct, and Codex saw no close resemblance between the redrawn Pip and Tinky Winky or Capy. Fixed in the next commit: (medium) the SVG test now checks every fill and stroke value and the root's required attributes; (medium) the ratio test checks each table cell against its own pair and the three lime figures one by one; (low) the colour list names White and the two extra illustration colours; (low) the round 1 count is four medium findings, not five.
- **Still owed:** a person on the team signs off on Pip's look.

- Codex reviews the guide read-only against T3's documentation; findings are fixed or recorded here.
- A person who runs T3 follows the guide once and records the result here.

### D1 review (2026-11-17)

- **Codex, round 1** (of the first guide commit): one high finding, six medium, three low, all addressed in the next commit.
  - (high) The guide presented MCP discovery in T3's sessions as guaranteed. It is now labelled unverified, the steps are scoped to Claude and manually configured Codex, and a per-provider check from a new thread is the last step. The README says the same.
  - (medium) The manual setup now comes first, and `ledger install` is noted as coming with G8.
  - (medium) The outside-agents section now names Copy MCP URL, OAuth and the access levels, and says a graph needs an imported transcript first.
  - (medium) The store section sticks to what T3 documents: the default path and `--base-dir`, the V1 recovery query, and the V2 design without documented tables. The fork comparison is dropped.
  - (medium) Permission modes are described as provider-dependent approval, and the ledger's own boundary is stated.
  - (medium) This eval now says what the test checks and what is still owed.
  - (low) Prerequisites, `PORT`, shell labels and PowerShell forms are added. The claim about every provider taking MCP servers is removed. The session-file paths are leads to check.
  - D3 stays deferred, as the review advised. Its row now says to pin one T3 release, build a test database from synthetic threads, and consider T3's thread-reading MCP tool as a source.
- **Codex, round 2** (of fc58cf1): the high finding is fixed, and the setup, provider, storage and permission fixes hold. Fixed in the next commit:
  - (medium) How to use your own Codex login (Configure manually), with the check run per instance and on the tool result itself.
  - (medium) Where to open the ledger on a remote host (on it, or through a port forward; WSL).
  - (medium) This eval's body now matches the board: D1 is the guide, D3 the importer, G8 the installer. The fork comparison is gone.
  - (low) T3's labels for access levels, what a migrated thread's session file may lack, and the README wording.
- **Still owed:** a person who runs T3 follows the guide for Claude and for a manually configured Codex instance and records the result here.

- Codex reviews the guide read-only against Capy's documentation; findings are fixed or recorded here.
- A person with a Capy organization follows it once and records the result here.

### D2 review (2026-11-17)

- **Codex, round 1** (of the first guide commit): ten findings, all fixed in the next commit.
  - (high) The guide implied that transcript text stays on the computer. Capy stores tool output in its cloud. This now comes first, with a synthetic-data start.
  - (high) "Agents cannot confirm proposals" overstated it. The guide now says the MCP server has no such tool, and that the browser check does not prove a person clicked.
  - (high) "Only you" was presented as access control. It only decides which threads get the tools; any local process, a shared device and members who message the thread can reach the ledger.
  - (medium) Missing: automatic offline moves and checkpoints, the Dock device choice, prerequisites and `npm ci`, a real check from a thread (Test only lists tools), split troubleshooting, a copyable `AGENTS.md` note, and the transcript and file-reading tools.
  - (low) The key rule and the Name, Working directory and Also listens on fields; and the TOML import, now marked untried.
- **Codex, round 2** (of f156a36): the cloud-storage and "Only you" fixes hold, as do the moves, prerequisites and real-check fixes. Fixed in the next commit:
  - (medium) The room wording, in the guide and in the README, now says the browser is the intended way and the ledger does not verify who sent a decision.
  - (medium) Private threads still admit invited people, and a Personal device asks before others message its threads. The guide says to check both.
  - (low) What `latent_read` returns, a broader **Unavailable** row, the port placeholder, and the `PORT` range.
- **Still owed:** a person with a Capy organization follows the guide once and records the result here.

### P4a — Signed hand-off and `ledger verify` (`ruslan/p4a-signed-export`, defined 2026-11-17, before the code)

First slice of P4, following ADR-9 of the design (`origin/ruslan/p1-design`, `docs/architecture.md` sections 6 and 9): raw Ed25519 over an RFC 8785 (JCS) manifest, with the key fingerprint checked out of band. The bundle signs the existing hand-off Markdown as it is. The secret scanner, the redaction diff, allowlist export (ADR-8) and the passphrase-encrypted key are P4b. All data is synthetic: a fake ledger server returns a made-up session, and every key is generated in a temporary folder.

| Eval | Expected |
| --- | --- |
| JCS subset | `canonicalJson` matches RFC 8785 on its section 3.2.2 example (numbers, string escapes, literals), its section 3.2.3 key-sorting example (UTF-16 order, including an emoji key), and the Appendix B number table (`-0` is `0`, `5e-324`, `1e+21`, `9.999999999999997e+22` and the rest). It refuses NaN, Infinity, lone surrogates in strings and keys, and values that are not JSON (`undefined`, functions, dates, `bigint`). |
| Key generation | `ledger keygen` writes one PKCS#8 Ed25519 private key to the ledger data folder (the folder of `CONTEXT_LEDGER_DB`, by default `.context-ledger/`), with mode 0600 where the OS supports it. It prints only the fingerprint: SHA-256 of the key's SubjectPublicKeyInfo DER bytes, as 16 groups of 4 lowercase hex digits. Run again, it exits 1, says a key exists, and leaves the file byte-identical. |
| Signed bundle | `ledger handoff <id> --sign <dir>` creates `<dir>` (it must not exist) with exactly four files: `handoff.md` (the same bytes `ledger handoff <id>` prints), `public-key.pem`, `manifest.json` and `manifest.sig`. `manifest.json` is canonical JCS, with no trailing newline, holding `format`, `version`, `algorithm`, `created_at`, `session`, `public_key` (base64 SPKI DER) and `files` (name, byte size and SHA-256 of `handoff.md`). `manifest.sig` is the 64-byte raw Ed25519 signature over the manifest bytes. Without a key, or when `<dir>` exists, it exits 1 and writes nothing. |
| Verify passes | `ledger verify <dir>` exits 0 on an untouched bundle and warns on stderr that the key was not checked. With `--fingerprint` set to the keygen output (spaces, colons or none, any case) it exits 0 with no warning. |
| Verify fails closed | `ledger verify` exits 1 with a fixed message for each of: one changed byte in `handoff.md`, one byte appended to it, a changed byte in `manifest.json`, a changed `manifest.sig`, a missing file (each of the four), an extra file, a subfolder, a manifest re-signed by another key while `--fingerprint` names the real one, a `public-key.pem` that does not match the manifest key, and a manifest that is signed correctly but not canonical (extra whitespace, unsorted keys, a duplicate key, a trailing newline, a byte-order mark). |
| Escaped output | A file name from the folder that holds a bidi override or a control character is printed escaped, never raw. Messages are fixed strings plus escaped names. |
| OpenSSL recipe | `docs/signed-handoff.md` shows how a client checks a bundle with OpenSSL 3 alone: the fingerprint, the signature (`openssl pkeyutl -verify -rawin`) and the file hash. A test runs those exact commands when `openssl` is on PATH and skips otherwise: they accept the real bundle, give the same fingerprint as `ledger keygen`, and refuse a manifest with one changed byte. |
| No secrets committed | No private key, `.sqlite` or `.env` file is added; `src/` and `tests/` hold no raw control or format characters other than tab, newline and carriage return. No new dependency. |
| Windows key access (added 2026-11-18, after the security review) | On Windows, `keygen` leaves the key with a protected access list that grants only the current account (`D:PAI(A;;FA;;;<SID>)`), even when the ledger folder grants Everyone and Users read through inheritance, and no staging file stays behind. Signing exits 1 with `Other accounts can read the signing key file.`, and writes nothing, for a key that grants Everyone, grants Users, or inherits Everyone from its folder; it signs again once the grant is removed. The access-list parser accepts only the account, SYSTEM and Administrators, and fails closed on a null DACL or a form it does not know. The Windows tests skip on other systems; the parser test runs everywhere. (Codex round 4 added:) the empty staging file and its folder already grant only the current account, the parser refuses unknown entry types and flags, and a key file replaced between the read and the check is refused. |
| Sign from the database (added 2026-11-18, after the security review) | `handoff --sign` reads the session from the ledger database (`CONTEXT_LEDGER_DB`, or the server's default `.context-ledger/ledger.sqlite`) in process, as design ADR-2 requires. With a fake server on `PORT` that returns a forged session under the right ID, the bundle holds the database's hand-off and the server gets no request; with no server and a `PORT` that is not a number, signing still works. A missing database (which is not created), a file that is not a database, and an unknown session each exit 1 with a fixed sentence and write nothing. (Codex round 4 added:) signing and a failed lookup leave the database file byte-identical; an older-schema file is refused, not migrated; a newer one is refused; a dangling database symlink's target is not created (POSIX). |

**Results — P4a (2026-11-17, Windows; updated 2026-11-18 after the security review):** all ten rows met locally. The code is in `src/sign.mjs` and `src/cli.mjs`, the tests in `tests/sign.test.mjs` (39 tests), the client guide in `docs/signed-handoff.md`. A human security review is still owed before merge.

- **JCS subset:** pass. The section 3.2.2 and 3.2.3 examples and 24 Appendix B numbers match byte for byte; NaN, both infinities, lone surrogates in strings and keys, `undefined`, functions, dates, `bigint`, symbols and array holes are refused.
- **Key generation:** pass. One PKCS#8 Ed25519 key, stdout is exactly 16 groups of 4 hex digits, a second run exits 1 and leaves the key byte-identical. The fingerprint is SHA-256 of the SPKI DER bytes rather than of the raw 32-byte key, so that the OpenSSL recipe needs nothing but `openssl`. The 0600 mode and the refusal of a key other users can read are POSIX tests that skip on Windows and run in CI on Ubuntu.
- **Signed bundle:** pass. Exactly four files; `handoff.md` equals what `ledger handoff` prints; the manifest is canonical with no trailing newline; `manifest.sig` is 64 bytes and verifies. An existing folder (empty or not), a missing key, `--sign` with no or an empty value, and an unknown option all exit 1 without writing.
- **Verify passes:** pass, with the warning without `--fingerprint`, and with none for the fingerprint written with spaces, colons or no separators, in either case.
- **Verify fails closed:** pass for every case in the row, plus (from the reviews) a re-signed manifest with the right hash and the wrong size, a reformatted PEM of the same key, a 65-byte signature, a version 1 manifest that does not list exactly `handoff.md`, a case-only rename, and a folder changed after it was listed or read.
- **Escaped output:** pass. Bidi overrides, ZWNJ and ZWJ (and on POSIX BEL and ESC) in file names are printed as `\u` escapes; option and response parser errors are replaced by fixed messages.
- **OpenSSL recipe:** pass with OpenSSL 3.2.4 (Git for Windows). The test reads the commands from the marked block in `docs/signed-handoff.md`. It checks that every stage succeeds on the real bundle and gives the keygen fingerprint and the manifest hash, and that the signature step refuses a changed manifest byte and a 65-byte signature. It also checks the steps a client must not skip: a changed hand-off still passes the signature step and only the hash step catches it, and a bundle re-signed with another key passes the signature step and only the fingerprint step catches it.
- **No secrets committed:** pass. Keys are made in temporary folders; `signing-key.pem*` is Git-ignored (a test runs `git check-ignore`); no new dependency; the raw-character check covers the P4a files.
- **Codex review** (`codex exec --sandbox read-only`), three rounds:
  - Round 1 (of 4ec3c5a), eight findings. Fixed in ed2a509, each with a regression test unless noted:
    - (medium) Files could change between listing and reading. Bundle files are now opened without following symlinks or blocking on a FIFO (POSIX), and verify lists the folder again at the end and checks each file is still the one it read. The docs say to verify a private copy for a strong guarantee.
    - (medium) The OpenSSL recipe checks less than `verify`. The docs now state exactly what it covers and the manual checks, and the test checks every stage and the negative cases above.
    - (medium) On Windows the key's confidentiality rests on the folder's inherited access list. Not fixed in code: documented, and moved to P4b with the passphrase-encrypted key. Codex (round 2) judged this acceptable for a first slice if the human security reviewer accepts it.
    - (low) A manifest without `handoff.md` was accepted. Version 1 now requires exactly that one file.
    - (low) NTFS alternate data streams are not covered. Documented.
    - (low) An interrupted write could leave a partial key or folder. `keygen` now stages the key and hard-links it into place; a failed bundle write removes what it created.
    - (low) Names kept ZWNJ and ZWJ raw, and some parser errors quoted input. A strict `terminalLabel` escapes them, and the errors are fixed messages.
    - (low) Three mutations survived the tests. The wrong-size, reformatted-PEM and 65-byte-signature tests now catch them.
  - Round 2 (of ed2a509), seven findings. Fixed in ab576b0:
    - (medium) `join()` folded `link/..` differently from the OS, so verify could read another folder than the one named. verify and `--sign` now resolve the path with `realpath` once (POSIX test).
    - (medium) A killed `keygen` could leave a `.tmp` private key that Git did not ignore. Now ignored and documented.
    - (low) Cleanup could remove a file put in its place. It now checks the inode first; documented as best effort. No regression test: the race needs a second writer.
    - (low) A file system without hard links got a generic error. The message now names the requirement. No regression test: it needs a FAT or exFAT volume.
    - (low) An inflated hand-off was read to the end. Its size is now compared first.
    - (low) The race tests set the folder up before listing. Test hooks now change it after listing and after reading.
    - (low) The recipe's fingerprint step without pipefail. Documented, and a test pins the empty-input hash.
  - Round 3 (of ab576b0): one medium and five lows, of which three needed a change. Fixed in the final commit:
    - (medium) `realpath` can fail on a Windows SMB share that hides an ancestor folder, and `--sign` then said the parent did not exist. The messages now say the path could not be resolved and to use a local folder; a fallback for such shares is not built.
    - (low) Cleanup compared only the inode. It now compares the device too on POSIX, and the docs no longer promise that a replacement is left alone. No regression test: the race needs a second writer.
    - (low) The hard-link message covered write errors and blamed the file system for `EPERM`, which Windows also uses for access denied. It now covers only `link()` and names both causes.
    - The other findings were confirmations (the Git ignore rule, the hash bound, the hooks, the empty-input digest). The same-bytes replacement test now moves the original out of the folder first, so Linux cannot reuse its inode.
- **Independent security review** (Claude, read-only, of 69e4581): no high findings, three medium, seven low. The three medium:
  - (medium 1) On Windows the key's confidentiality rested on an inherited access list that nothing checked, so a key under a shared `CONTEXT_LEDGER_DB` folder could be readable by every local user. Fixed: `keygen` removes the inherited entries and grants the current account (by SID, from `whoami /user`) full control with `icacls`, run from System32 without a shell, on the still-empty staging file before the key is written, and then checks the result. `loadSigningKey` reads the access list with `icacls /save` (SDDL, so it does not depend on the display language) and refuses a key that allows any account other than the user, SYSTEM and Administrators, with a fixed message. POSIX behaviour is unchanged. Regression tests: the two Windows rows above (they fail with the fix taken out) and the parser test.
  - (medium 3) `handoff --sign` signed whatever answered on `127.0.0.1:PORT`. Fixed as design ADR-2 says (one in-process core; "CLI as HTTP client" is a rejected option): `--sign` now opens the ledger database itself and never makes an HTTP request. Plain `handoff` and `search` still use the server; moving them is outside this card. Regression tests: the "Sign from the database" row above.
  - (medium 2) `verify` without `--fingerprint` exits 0 for a bundle signed by any key, with only a stderr warning. Not changed: the "Verify passes" row requires exit 0, and the user decides. **Proposed for the user:** either make `--fingerprint` required (with an explicit `--no-key-check` for the cases that only want integrity), or keep it optional but exit with a distinct code (for example 2) and print `Unverified signer` on stdout when no fingerprint was given, so a script that checks only the exit status cannot mistake an unchecked key for a verified sender.
  - The seven low findings (a cwd-relative key path, no owner check on POSIX and no symlink refusal on Windows, folder modes, no domain separation or freshness in the signature, the fingerprint comparison, stale `.tmp` keys, and the mtime-and-size race check) are left open for the human security reviewer.
- **Codex review, round 4** (`codex exec --sandbox read-only`, of 67d91fc, the security fixes): no high findings, four medium, two low. Fixed in the next commit unless noted, each with a regression test that fails with the fix taken out:
  - (medium) The empty staging file inherited the data folder's list for a moment, so an account allowed to read that folder could open it and keep the handle until the key was written. On Windows the staging file is now created inside a new folder beside the key that is restricted to the current account first. Test: the staging file's and its folder's lists, read from a hook while the file is empty, name only the current account.
  - (medium) The access list was read by path after the key was read through its own handle, so a swapped file could be checked instead. The path must now name the same file ID before and after the check, and a link is refused. Node cannot read a handle's security descriptor, so an account that can rename entries in the key's folder can still swap back and forth; documented, since such an account can replace the key anyway. Test: a key readable by Everyone, swapped for a restricted stand-in between the read and the check, is refused.
  - (medium) `openStore` could create tables or migrate an older ledger while signing, and a dangling symlink passed `lstat`. The CLI now reads the schema version through a read-only connection first and opens the store only for a current-version file; an older file is refused with a fixed sentence that says to start the server once. The read-only store lookup Codex suggested belongs in `src/store.mjs`, which card P1 (in progress, another owner) is changing, so it is not added there. Tests: the database file is byte-identical after a signing and a failed lookup, an older and a newer schema are refused without change, and a dangling symlink's target is not created (POSIX).
  - (medium) The check ignores the file's owner, so a key file another account planted and owns passes when its list grants only the signer. Not fixed: this is low finding 5 of the security review (no owner check), which this round leaves for the human security reviewer, and `icacls /save` does not report the owner. Documented in `docs/signed-handoff.md`.
  - (low) The SDDL parser accepted unknown entry types for the current account and unknown flags. It now allows only the flags P, AI and AR and only six-field A and D entries. Test added.
  - (low) The tools are found through `SystemRoot` from the environment. Not changed: whoever sets the signing process's environment can already run code in it (for example through `NODE_OPTIONS`), so the environment is trusted as it is elsewhere in the CLI.
- **Suites (Windows, this branch, 2026-11-18 after round 4):** node 227/231 (4 skipped: the three POSIX-only P4a tests and one existing skip), against 191/192 on `main`; the 39 P4a tests are 36 pass and 3 POSIX skips (the four Windows-only tests run here and skip on Linux). Graph check 9/9. Playwright 13/13 (through the shared lock). Python runtime 198 run, 50 skipped, OK. The POSIX tests (key mode, symlink and FIFO swaps, `link/..`, the dangling database symlink) run in CI on Ubuntu.

## P4b — Secret scanner and redaction diff (defined 2026-11-17, before implementation)

Transcripts often hold credentials: keys pasted into a prompt, tokens in tool output an agent repeated, a private key it printed. Before a hand-off or export leaves the machine, the person should see what in it looks like a secret. P4b adds the scanner and a report. It does not change `ledger handoff` or the signed export (P4a), which can use the scanner later.

All fixtures are synthetic. The fake credentials are put together at test time from fragments, so no committed file holds a string in a real credential format that secret-scanning push protection would flag.

### What is tested and the expected result

- **Formats found:** `findSecrets(text)` finds and labels:
  - an AWS access key ID, and an AWS secret key next to its name;
  - GitHub tokens (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`, `github_pat_`);
  - Anthropic (`sk-ant-`) and OpenAI (`sk-`, `sk-proj-`) keys;
  - Slack tokens (`xox?-`);
  - Stripe live and test secret keys;
  - JSON Web Tokens;
  - PEM private key blocks;
  - bearer tokens in an `Authorization` header;
  - a secret-looking value assigned to a name such as `password`, `api_key`, `secret` or `token`.

  Each finding has its kind and its start and end in the text.
- **Not over-eager:**
  - Ordinary prose, hex commit hashes, UUIDs, the word "password" without a value, placeholders (`<your-key>`, `xxxx`, `${TOKEN}`, `changeme`) and short values are not flagged.
  - Overlapping matches are reported once, by the most specific kind.
- **Deliberate limits** (made explicit after review round 1):
  - A JWT needs a header and a payload that both start `eyJ`. Its signature may be empty (an unsecured token).
  - A bearer value needs at least eight characters.
  - Under a secret-like name, a UUID, a 40-character git commit hash or a value of digits only is not flagged. Other hex values are flagged.
  - A bearer token is found in a bare `Authorization: Bearer` header and in its JSON or quoted forms.
- **Whole values:** a short pattern finds where a value starts, and a forward scan finds where it ends. That end is the rest of its character class; or a quoted value's closing quote (or the line break, which a backslash never escapes); or a JWT's third segment; or, for a private key, its END line. A key's span covers the BEGIN line, any PEM header lines with the blank line after them, and its base64 lines. An unfinished key ends at the first line that cannot belong to it, so it never takes in prose or a later key. No tail is ever left behind, however long the value.
- **Overlaps:** overlapping matches merge into one span labelled with the most specific kind. Its prefix is shown only when that kind's match begins the span.
- **Redaction:** `redactText(text)` replaces each finding with `[REDACTED <kind>]` and leaves everything else byte for byte. `redactSession(session)` does that for the source name and every message, keeps line numbers, and lists findings by line and kind; a finding in the source name has line `null` and is reported as "source name".
- **The report never shows a secret:** `npm run ledger -- redact <session-id>` prints, for each finding:
  - its line number and kind;
  - its length;
  - a masked preview that keeps at most the known prefix, such as `ghp_…`, and never any other character of the value.

  It ends with the count and exits 0. With `--json` it prints the same as escaped JSON. With `--text` it prints the redacted hand-off with every format character escaped, ZWNJ and ZWJ included. All output goes through the terminal escaping in `src/text.mjs`. Errors are fixed sentences, including when the server sends something that is not a session.
- **No surprises in the other tools:** `ledger handoff`, the browser, MCP and the store are unchanged.

### Acceptance for the code

- `node --test tests/*.test.mjs` passes, with the cases above in `tests/secrets.test.mjs`, including a CLI run against a server on a temporary database.
- No new dependency. Scanning a 1 MiB synthetic transcript takes under a second.

### P4b results (2026-11-17)

- `tests/secrets.test.mjs` has 38 tests. Fake credentials are assembled at run time. Running the scanner over every committed file finds no provider-format credential; it finds no provider-format credential. Its generic hits:
  - in `tests/secrets.test.mjs`, 23 secret-looking values under names such as `password` and 6 generic `Authorization: Bearer` examples, all synthetic;
  - in existing tests, 4 synthetic fixtures (a test bearer header in `runtime/tests/test_team_service.py`, and three test secrets assigned to a `secret` constant in `tests/list-api.test.mjs` and `tests/paging.test.mjs`);
  - 3 lines of code, which the scanner over-redacts by design: a helper call under a `token` name in `runtime/latent_team/chat_turns.py`, and two special-token strings under `eos_token` and `pad_token` in `runtime/tests/test_latent_training.py`.
- **Codex, round 1** (of 742b071): three high, four medium and three low findings, all fixed with tests:
  - (high) Overlapping matches kept only one span, so part of an enclosing bearer value could stay visible. Overlaps now merge into one span, and the prefix is hidden unless the labelled match begins it.
  - (high) Length caps could leave the tail of a long value: private keys over 16 KiB, long bearer values, quoted passwords with spaces. Values are now extended by a linear scan to their real end.
  - (high) `--text` printed the source name unredacted. It is scanned and redacted, and reported as "source name".
  - (medium) Anthropic keys with a letter-only tail and unsecured JWTs were missed; the bearer minimum was unstated. Fixed, and the deliberate limits are now in the eval.
  - (medium) A `my_` prefix hid real secrets, and UUIDs and commit hashes under a name were flagged. Placeholders are now judged by shape, and those two identifiers are excluded.
  - (medium) Overlap handling was quadratic in the number of matches. It is now one sorted sweep, and unfinished key headers reuse one search for their END line. The tests cover 50,000 matches and 30,000 unfinished headers.
  - (medium) An unreadable server reply could put its bytes on stderr. The redact path checks the reply's shape and prints a fixed sentence.
  - (low) `--text` kept ZWNJ and ZWJ. It now escapes every format character.
  - (low) `constructor` was accepted as a format. The format is now checked exactly.
  - (low) The tests now cover every GitHub, OpenAI and Stripe variant with exact spans and previews, plus full CLI output.
- **Codex, round 2** (of 8b45c18): four high, six medium and two low findings, fixed with tests. The capped patterns are replaced by start patterns plus forward scanners:
  - (high) A quoted value starting with a space or a bracket was never read. The opening quote is now found on its own, and the value is read from inside it to its end.
  - (high) A JWT with a long header or payload was missed. JWTs are now walked segment by segment.
  - (high) An unfinished encrypted key left its body after the blank line under `Proc-Type`/`DEK-Info`. That blank line now belongs to the key.
  - (high) JSON-style `Authorization` headers were missed. Quoted and JSON forms are now found.
  - (medium) An unfinished key could take in prose and a later key. Keys are now walked line by line and stop at the first line that cannot belong to them.
  - (medium) Extending matches was quadratic on nested candidates. Each pattern now resumes after the whole value it found.
  - (medium) A bearer value that began with a GitHub token showed that token's prefix. A prefix is now shown only when the labelled match covers the whole span.
  - (medium) Values starting `env-` or `env.` were skipped. Only complete environment references are skipped now, and the digits-only rule is stated in the eval.
  - (medium) Odd provider or role values could reach `--text`. The reply must now be for the session asked for, with provider and role values the store writes.
  - (medium) A quoted value ending in a backslash could cross a line break. A backslash no longer escapes a line break, for both LF and CRLF.
  - (low) `--text` kept raw tabs. Tabs are now escaped.
  - (low) The tests now require one exact finding and preview for every variant, and compare the full JSON and redacted text.
- **Codex, round 3** (of bb04ac8): four high and two low findings, fixed with tests:
  - (high) A JSON `Authorization` value with an escaped slash was redacted only up to the backslash. Values that can sit in a JSON or quoted string are now read with backslash escapes, stopping at an escaped quote or a line break.
  - (high) A rejected quoted value hid a real key nested inside it, after its own name. A rejected value is no longer skipped; a cached run end keeps nested names in one run from rescanning it. Only a complete `[REDACTED <kind>]` marker counts as a placeholder.
  - (high) Trailing spaces or tabs on a private key's lines stopped the scan before its body. Lines are judged without trailing horizontal white space.
  - (high) An AWS secret followed by a full stop or colon failed its length check. The AWS rule now has its own character class.
  - (low) The scaling test only checked time. It now checks the exact span at each size and a run of 40,000 nested names.
  - (low) The exact-finding tests now check spans, and every CLI mode is compared in full, with its exit status.
- **Codex, round 4** (of e54f244): two high, two medium and two low findings, fixed with tests:
  - (high) Spaces or tabs after a private key's BEGIN marker left the body visible. The scan now allows them.
  - (high) An AWS secret written with JSON escapes (a slash as `\/` or its `\u` form) was not found. Values are now checked with their escapes decoded, and redacted at their original offsets.
  - (medium) Escape handling could run past a value: through an escaped line break in a JSON bearer value, or an escaped comma in a bare assignment. Escapes now count only inside a string, and an escape that decodes to a character outside the value's class ends it.
  - (medium) Trimming a key line's trailing padding used an unanchored pattern, which is slow on long runs of spaces. It now walks back from the line end. The span ends with the END marker, so padding after it is kept.
  - (low) The nested-name tests could pass with the old skipping. A rejected outer AWS value now keeps the real one inside it, and the 40,000-name case pins its exact span.
  - (low) The exact-output CLI test now also requires an empty stderr.
- **Codex, round 5** (of the round 4 fixes, run by the coordinating session): two high and two low findings, fixed with tests:
  - (high) A whole header in quotes, as in curl's `-H "Authorization: Bearer …"`, was not treated as a string, so an escaped slash stopped the value early. A quote just before the header now counts too.
  - (high) Bare values were checked after decoding escapes, so a short password with a backslash fell under the length limit. A bare value is now checked as written; only values in a string are decoded.
  - (low) Padding after a BEGIN marker was taken even when prose followed on the same line. It is now taken only when a line break follows.
  - (low) The fixture audit now names the 17 secret-looking values under names in the test file, beside the generic bearer examples.
- **Codex, round 6** (of cfbc2fd): one high and two low findings, fixed with tests:
  - (high) The round 5 quote check applied to every rule, so a quoted field name such as `"password": …` made a bare value count as a string, leaving part or all of it visible. Only the bearer rule now reads a whole quoted header, and only when the quote opens the header rather than the field name.
  - (low) Padding after a BEGIN marker at the end of the text was still taken. It is now taken only before an LF or CRLF line break.
  - (low) The fixture audit now covers every committed file, as listed above. Exclusions added here for code (calls, snake_case names, special tokens) were removed again after round 7.
- **Codex, round 7** (of 53c9156): two high and one medium finding, all regressions from round 6, fixed with tests:
  - (high) The exclusion for values followed by `(` hid real bearer and password values, and left the tail of a token visible. It is removed.
  - (high) Limiting the quoted-header check to bearer values dropped escaped AWS keys inside a quoted assignment. The check is general again, and precise: a value is inside a string when a quote opens the whole assignment or header, not when it only wraps the field name.
  - (medium) The snake_case and special-token exclusions hid quoted passwords. Both are removed. Missing a secret is worse than redacting a function name, so code under a secret-like name is over-redacted by design.
- **Not reviewed again:** the fixes after round 7. Each round found new edge cases: this is a heuristic scanner over free text, not a guarantee. The PR asks for a human security review before merge (AGENTS.md section 4.4), and the report tells people that values are not shown, not that every secret was found.

### P4b narrowed to key formats (2026-11-18)

Seven Codex rounds kept finding new gaps in the free-text rules, each fix opening another. On 2026-11-18 the user chose to narrow P4b to well-defined key formats.

- **Kept:** provider key formats (Anthropic, OpenAI, GitHub, AWS access key IDs, Slack, Stripe), JWTs, PEM private-key blocks, and the AWS secret access key, which has a fixed 40-character shape under its own name.
- **Removed:** the `bearer-token` rule (the value of an `Authorization: Bearer` header) and the `assigned-secret` rule (any value after a name such as `password`, `api_key` or `token`), with their helpers. A key format inside such a value is still found: `Authorization: Bearer <a GitHub token>` is redacted as `github-token`.
- **What this means for users:** a password or a bearer value that is not in a known key format is no longer flagged. The redaction report says what it looks for, and free-text detection is card P4c.
- **Tests:** tests that covered only the removed rules were dropped, and table rows and assertions about them were removed. The CLI test now expects two findings. A new test pins the scope: free-text values are not flagged, and key formats inside them still are. `tests/secrets.test.mjs` passes 31/31.
- The spec bullets above that describe bearer and assigned values, and review rounds 1 to 7, describe the scanner before it was narrowed.
- **Codex review of the narrowed scanner:** no high findings. One medium and three low, fixed:
  - (medium) "No secrets found" could be read as a clean transcript. The report now says "No known key formats found" and always adds a line saying passwords and other free-text values are not checked.
  - (low) Two branches served only the removed rules (the `unquoted` fallback and the bearer quote check). They are removed.
  - (low) The test that a prefix is hidden when the labelled match covers only part of a span was lost with the bearer cases. It is restored with an AWS access key ID inside an AWS secret access key.
  - (low) The older handoff checkpoint still listed bearer and password detection. It is marked superseded.
  - The realistic-looking password literal in the tests is replaced with an obviously synthetic one.

## P4c — Free-text secret detection (defined 2026-11-18, before implementation)

P4b was narrowed to key formats with a fixed shape, because seven review rounds kept finding gaps in the free-text rules: bearer header values, and values after names such as `password=`. Each gap was the same problem: guessing exactly where a free-text value ends (quotes, escapes, punctuation, code). P4c takes a different approach and measures it against a written budget.

**Approach: line-tail redaction.** After an `Authorization: Bearer` header, or after a secret-like name followed by `:` or `=`, everything from the value's start to the end of that line is redacted. An opening quote stays visible, and nothing on later lines is touched. The scanner never decides where the value ends inside the line, so no fragment of it can be left. The cost is over-redaction of whatever else is on that line, which the budget below bounds.

**What is flagged:** a lead whose line tail starts with a value. Not flagged: an empty tail, a pure number, or a placeholder that fills the whole value (`${TOKEN}`, `<your-key>`, `changeme`, `xxxx`, `[REDACTED <kind>]`, `process.env.NAME`, a UUID or a 40-character commit hash). A tail with anything after such a placeholder is still flagged.

**Proposed budget (the user approves it, and the line-tail approach, before this leaves draft), on a labelled synthetic corpus built at test time:**

- **Misses: zero.** For every secret line, no character of the secret is left visible after redaction. The corpus covers bare, quoted, JSON, single-quoted and curl forms; escapes (`\/`, `\u` forms, an escaped quote, a backslash in a bare value); trailing punctuation; parentheses; long values; and short passwords. It includes every input earlier P4b review rounds reported as missed.
- **False alarms:** at most 10% of the benign lines that contain a secret-like name followed by `:` or `=` (config keys holding placeholders, numbers, code), and none of the benign lines without one (prose, hashes, UUIDs, ordinary code).
- **Line structure:** every line break survives, and text on other lines is unchanged byte for byte.
- **Speed:** a 1 MiB transcript, and 40,000 nested names on one line, each scan in under a second.

### Acceptance for the code

- `node --test tests/*.test.mjs` passes, with the corpus and the budget checks in `tests/secrets-free-text.test.mjs`. The P4b key-format tests still pass unchanged.
- No new dependency. `ledger redact` reports these findings like the others, with no preview.

### P4c results (2026-11-18)

- **Corpus:** `tests/secrets-free-text.test.mjs` has 38 secret lines, including every input earlier P4b review rounds and P4c rounds 1 and 2 reported as missed, plus 23 benign keyed lines and 13 benign plain lines. The test pins the exact list of false alarms and checks that the rendered text is exactly the line with each covered span replaced by its marker.
- **Misses:** 0. No character of any secret is visible after redaction.
- **False alarms:** 2 of 23 benign keyed lines (8.7%; 2 of 21 before round 2 added two benign fixtures), both code under a secret-like name: `token = getToken()` and `apiKey = config.apiKey`. No plain line is flagged. (The first count, 1 of 20, was wrong: it stripped the closing bracket from a redaction marker and so mis-judged it, and it left out `apiKey = config.apiKey`. Review round 1.)
- **Line structure:** line breaks survive and the other lines are unchanged. Each speed case runs well under a second.
- **Tests changed on purpose:** the P4b tests that asserted the narrowed scope now assert P4c's behaviour:
  - `password: hunter2` and short bearer values are now redacted;
  - code under a secret-like name is over-redacted;
  - a line tail merges with a key format on the same line, with no prefix shown.
- **Report wording:** the `ledger redact` scope line now says what is checked: key formats, and the rest of a line after a bearer header or a secret-like name.
- **Scope, stated after review round 1:** one physical line. A line ends at LF, CR or a Unicode line or paragraph separator, and a lead holds only spaces and tabs, so it never reaches the next line. A value that continues onto the next line, such as a quoted string with a line break inside it, is redacted only on the lead's line; the `ledger redact` report says so. A name split by a quote, such as `"pass"word`, is not recognised.
- **Codex, round 1** (of 941e48d): three high, three medium and one low finding, fixed with tests:
  - (high) A lead could cross a line break and redact the next line, and Unicode line separators did not end a line. Leads now hold only spaces and tabs, and every line separator ends a line.
  - (high) The placeholder check stripped punctuation inside quotes, so `password="changeme;"` and `password="}"` stayed visible; it also accepted malformed references and any angle-bracket label. A quoted value is now judged to its closing quote, and placeholders must be complete: `${NAME}`, `$(NAME)`, `$NAME`, or an angle-bracket label naming a key, token, secret, password, value or "here".
  - (high) A value that continues on the next line is only partly redacted. This is the line-tail rule itself, so the scope above and the report now say so.
  - (medium) Trimming the value with a regex was quadratic on long runs of spaces (2.17 s for 64,000). It is now a backward scan, with a timing test.
  - (medium) `api key`, and more than eight spaces or tabs before `=`, were missed. Both are found now; quote-split names stay out of scope.
  - (medium) The false-alarm count was wrong (see above), the corpus lacked the escaped-quote case and a benign fixture, and the rendered-output check could pass with a fragment showing. All fixed.
  - (low) The empty report said "No known key formats found" although both checks ran. It now says "No findings from the checks below", and the scope line names the leads and the placeholder exception.
- **Codex, round 2** (of d6c39db): two high, two medium and two low findings, fixed with tests:
  - (high) A quoted placeholder followed by more text, such as the shell value `password="changeme"synthetic9`, hid the whole value, and an escaped quote was taken as the closing one. The closing quote is now found on the same line past backslash escapes, and the quoted part counts as the whole value only when a delimiter (`, ; ) ] }`) or the line end follows it.
  - (high) The angle-bracket exemption matched a keyword inside any word, so `password=<monkey9>` stayed visible. It now needs a whole word (key, token, secret, password, value or here) split by spaces, underscores or hyphens.
  - (medium) The bearer lead backtracked on long padding before a non-Bearer value (343 ms for 32,000 spaces). The padding after the optional quote is now consumed only with the quote: under 1 ms for 128,000.
  - (medium) Rejected leads each rescanned the rest of the line (4.07 s for 8,000 `token=""`). The line end is now reused for later leads on the same line: 4 ms for 8,000 and 7 ms for 32,000. Both cases are in the timing test.
  - (low) The rendered-output check could miss a short leak. It now compares the exact rendered string.
  - (low) Line preservation was tested for LF and CRLF only. It now covers lone CR, U+2028 and U+2029, each with empty bearer and assignment leads before the separator.
  - Noted, not changed: U+0085 (NEL) is not a line end, so a value before it is redacted along with the text after it on the same physical line. That over-redacts and never leaks.

## Cycle 15 — Teams of many agents, and a split-facts test of the hand-off (defined 2026-11-13, before any run)

Card C15. Every earlier cycle ran a team of three thinking agents (Planner, Critic, Refiner) and a Solver. This cycle asks two questions:

1. What happens to accuracy, time and memory as the team grows to 10 or 100 agents?
2. Does the latent hand-off carry information when the Solver cannot do without it?

On GSM8K the Solver already reads the whole question, so cycles 12 and 13 could not tell "the thoughts carry nothing" apart from "the Solver did not need them". Part 2 splits the facts between the agents to remove that escape.

A measured design fact matters for both parts. The team shares one key-value memory, and it holds every agent's **prompt** as well as its latent steps. So an unsealed later agent, and the Solver, can read the earlier prompts, the question among them, directly. Part 2 therefore adds a **sealed** team. In it, every earlier agent's prompt is hidden from attention (`team.chain`, `sealed=True`), and only the latent steps and the turn-closing tokens stay visible. Their keys and values were computed while each agent read its own prompt. So even a sealed team with random thought vectors can pass on some of what an agent read, and the no-hand-off floor is the Solver alone.

### Setup

- Model: Qwen2.5-3B-Instruct, bf16. It has 2 key-value heads, so it stores about 36 KB of memory per position against about 384 KB for Phi-3.5-mini, and a 100-agent memory fits on the 16 GB GPU.
- No training and no tuned setting. Soft thoughts use the defaults (top-k 16, temperature 1.0), m = 40 latent steps per thinking agent, batch 8 (31 and 101 agents ran at smaller batches; see "Changes from the plan" under the results).
- Team of N thinking agents: the Planner, then Critic and Refiner in alternation (`chain_roles`), then the Solver. N = 3 is the team of every earlier cycle.
- Text team of N agents: each Critic reads the latest plan, each Refiner reads the latest plan and critique, and the Solver reads the latest plan. Each turn is capped at 256 tokens.
- Vote of N: N independent single answers sampled at temperature 0.7, and the most common number wins. This spends many calls without any hand-off, which is the fair comparison for a team of N agents.
- Questions: block 4 of the seed-0 test shuffle (`--count 200 --block 4`, questions 800–999). Cycle 13 used block 4 with Phi-3.5-mini. Nothing in this cycle is tuned on it, and the model is different.

### Part 1, scale (every agent sees the question)

- N = 3, 11, 31 and 101.
- Systems: single; latent_mas@N; latent_random@N; vote@N; and text_mas@N for N = 3 and 11. The text team grows too fast in tokens for larger N.
- Reported for each system: accuracy, mean generated tokens, latent vectors, seconds per question, wall time and peak GPU memory.

### Part 2, split facts

- The questions are the block-4 questions with at least two sentences before the last one. A question's facts are those sentences, and its ask is the last sentence. The number excluded is reported.
- Fact j goes to thinking agent j mod N, and every agent also sees the ask. The Solver sees only the ask.
- N = 3 and 11.
- Systems:
  - single_full: one model with the whole question (the ceiling);
  - alone: one model with the ask only (the floor);
  - latent_sealed@N and random_sealed@N;
  - latent_open@N and random_open@N (unsealed: the facts can also be read from the earlier prompts);
  - text_mas@N, where only the notes reach the Solver.

### What counts

There are eight primary tests, each an exact McNemar test on the same questions, with Bonferroni correction. A result is "established" only at **p < 0.05 / 8 = 0.00625**; anything else is reported as not established, with its numbers.

| Test | Systems compared | Question it answers |
|---|---|---|
| 1–4 | latent_mas@N against latent_random@N, for N = 3, 11, 31 and 101 | Do the thoughts beat random at any team size? |
| 5–6 | latent_sealed@N against alone, for N = 3 and 11 | Does the sealed latent hand-off carry facts at all? |
| 7–8 | latent_sealed@N against random_sealed@N, for N = 3 and 11 | Does the content of the thought vectors matter, beyond what any latent step's keys and values pass on? |

Secondary figures, reported but not gated:
- latent_mas@N against vote@N and against single;
- text_mas against latent_sealed;
- the open systems;
- time and memory against N.

Predictions, written before the run:
- Tests 1–4 are not established.
- vote@N is at least as accurate as latent_mas@N for N ≥ 11.
- Seconds per question grow at least linearly with N for latent_mas.
- Test 5 is established, because the latent positions carry what their agent read.
- Tests 7–8 are the open question.

### Acceptance for the code

- CPU unit tests with the tiny model:
  - chain_roles starts with the Planner and alternates, and chain_roles(3) is the old team;
  - the default latent_mas is unchanged;
  - an all-zero hide changes nothing;
  - sealed hides exactly the prompt columns, and noise written into them does not change the Solver's logits, while unsealed it does;
  - sealed thoughts still carry what their agent read;
  - the text team passes the latest plan and critique;
  - sampling is grouped per question and reproducible by seed, and temperature 0 is greedy;
  - the split rules and the vote tally behave as described;
  - both parts of the runner produce every system and comparison.
- The full runtime suite still passes, and the three-agent path of earlier cycles is unchanged.
- **Code review (Codex, 66da55f):** no sealed-mode leak and no change to the three-agent path were found. Four findings were fixed, each with a test that fails when the fix is reverted:
  1. A vote's winner was written back with `:g`, so 1234567 read as 1.23457. The winner is now scored as a number.
  2. Random thoughts were not seeded per system. Each system now seeds torch from `--seed` and its name.
  3. The leak test corrupted the hidden prompts only after the whole chain and read only the Solver's first step. It now corrupts them before every later agent and over a multi-step decode, with padded rows; removing `hide` at any of the three places fails it.
  4. The compatibility test compared the new code with itself. It now compares with the three-agent algorithm written out. A one-off run of the parent commit's `team.py` beside the new one gives identical latent_mas (soft, aligned, random), text_mas, single, working memory and training loss on the tiny model.

### Results (run 2026-11-14 to 2026-11-16)

The raw reports stay outside the repository because they hold GSM8K text. `tools/c15_stats.mjs`, kept with the run outputs, checks that every system answered the same questions in the same order and recomputes the McNemar tests from the per-question answers. The other figures are the runner's own summaries. Codex recomputed every figure from the per-question records (see the data check at the end).

### Changes from the plan, and why

- **31 agents ran at batch 4, not 8.** At batch 8, latent_mas@31 ran for about 7.5 hours and then stopped with a CUDA out-of-memory error. The slowness before the error points to GPU memory spilling into system memory, but the run's filtered log does not show that directly. A short memory probe on 8 questions, whose accuracy was not used, found a peak of 6.75 GiB at batch 4 and 6.32 GiB at batch 2. The three 31-agent systems were rerun at batch 4 on the same 200 questions. latent_mas@31 finished first. The run stopped when its session ended, and latent_random@31 and vote@31 were run separately afterwards. Each system seeds torch from `--seed` and its own name, so a separate run draws the same random thoughts.
- **101 agents ran on 50 questions at batch 1, not 200 at batch 8.** The probe measured about 181 seconds per question at batch 1 and 341 at batch 2 (4 questions each). The thinking steps run one after another: 101 agents of 40 steps is about 4,000 forward passes before the Solver starts. At that rate, 200 questions would take about 20 hours for latent_mas and latent_random alone. With the user's agreement on 2026-11-14, the 101-agent systems ran on the first 50 of the same 200 questions (`--count 50 --block 16`, shuffle positions 800–849). Their comparisons with other systems use those systems' answers on the same 50 questions.
- Smaller batches mean less padding. They can change greedy answers slightly through bf16 rounding, but not in any direction that favours one system. They do change seconds per question, so time is compared across N only at the same batch.
- The setup's "a 100-agent memory fits on the 16 GB GPU" held for one question at a time (6.79 GiB peak at batch 1), not for batch 8.

### Part 1 results, scale

| System | Questions | Batch | Accuracy | Mean tokens | Forward steps | s / question | Peak GiB |
|---|---|---|---|---|---|---|---|
| single | 200 | 8 | 0.830 | 301.9 | 301.9 | 2.69 | 6.12 |
| latent_mas@3 | 200 | 8 | 0.810 | 251.9 | 371.9 | 3.01 | 6.39 |
| latent_random@3 | 200 | 8 | 0.425 | 247.2 | 367.2 | 3.54 | 6.41 |
| vote@3 | 200 | 96 rows | 0.850 | 910.1 | 910.1 | 2.14 | 8.92 |
| text_mas@3 | 200 | 8 | 0.795 | 880.0 | 880.0 | 7.33 | 6.56 |
| latent_mas@11 | 200 | 8 | 0.780 | 251.9 | 691.9 | 6.45 | 7.13 |
| latent_random@11 | 200 | 8 | 0.235 | 185.7 | 625.7 | 6.69 | 7.06 |
| vote@11 | 200 | 96 rows | 0.880 | 3322.6 | 3322.6 | 7.33 | 8.67 |
| text_mas@11 | 200 | 8 | 0.780 | 2789.3 | 2789.3 | 21.33 | 6.56 |
| latent_mas@31 | 200 | 4 | 0.775 | 251.3 | 1491.3 | 23.64 | 7.38 |
| latent_random@31 | 200 | 4 | 0.055 | 157.7 | 1397.7 | 35.69 | 7.40 |
| vote@31 | 200 | 96 rows | 0.890 | 9375.6 | 9375.6 | 22.20 | 8.82 |
| latent_mas@101 | 50 | 1 | 0.660 | 247.0 | 4287.0 | 223.83 | 6.79 |
| latent_random@101 | 50 | 1 | 0.000 | 233.4 | 4273.4 | 193.14 | 6.79 |
| vote@101 | 50 | 96 rows | 0.940 | 31667.8 | 31667.8 | 39.63 | 8.25 |

The text team hit its 256-token turn cap on 67% (N = 3) and 74% (N = 11) of agent turns. As planned, it did not run at N = 31 or 101.

Accuracy on the 50 questions that every system answered:

| N | single | latent_mas | latent_random | vote | text_mas |
|---|---|---|---|---|---|
| 1 | 0.86 | | | | |
| 3 | | 0.84 | 0.36 | 0.86 | 0.78 |
| 11 | | 0.72 | 0.20 | 0.90 | 0.74 |
| 31 | | 0.76 | 0.06 | 0.84 | |
| 101 | | 0.66 | 0.00 | 0.94 | |

| Test | Comparison | Questions | Only first right / only second right | Exact p | Verdict |
|---|---|---|---|---|---|
| 1 | latent_mas@3 vs latent_random@3 | 200 | 81 / 4 | 1.1e-19 | **established** |
| 2 | latent_mas@11 vs latent_random@11 | 200 | 112 / 3 | 1.2e-29 | **established** |
| 3 | latent_mas@31 vs latent_random@31 | 200 | 147 / 3 | 7.9e-40 | **established** |
| 4 | latent_mas@101 vs latent_random@101 | 50 | 33 / 0 | 2.3e-10 | **established** |

Secondary figures (not gated; questions as in the test of the same N):

| Comparison | N = 3 | N = 11 | N = 31 | N = 101 |
|---|---|---|---|---|
| latent_mas vs vote | 8 / 16, p = 0.15 | 3 / 23, p = 8.8e-5 | 2 / 25, p = 5.6e-6 | 0 / 14, p = 1.2e-4 |
| latent_mas vs single | 9 / 13, p = 0.52 | 6 / 16, p = 0.052 | 6 / 17, p = 0.035 | 0 / 10, p = 0.0020 |
| latent_mas vs text_mas | 15 / 12, p = 0.70 | 15 / 15, p = 1.00 | not run | not run |

Time and memory against N, for latent_mas:

| N | Batch | Forward steps | s / question | ms per forward step | Peak GiB |
|---|---|---|---|---|---|
| 3 | 8 | 372 | 3.01 | 8.1 | 6.39 |
| 11 | 8 | 692 | 6.45 | 9.3 | 7.13 |
| 31 | 4 | 1491 | 23.64 | 15.9 | 7.38 |
| 101 | 1 | 4287 | 223.83 | 52.2 | 6.79 |

Forward steps grow by 40 per thinking agent, as designed. At the same batch (N = 3 to 11), seconds per question grew 2.1 times for 3.7 times the agents, which fits the Solver's decoding being a fixed cost (it writes about 252 tokens at both sizes). Each step also gets slower as the shared memory grows, and the smaller batches at N = 31 and 101 add to that, so the later rows cannot separate the two causes.

### Part 2 results, split facts

- 166 of the 200 block-4 questions had at least two fact sentences; 34 were excluded.
- Every system ran on the same 166 questions in the same order, at batch 8.

| System | Accuracy | Mean tokens | Forward steps | s / question | Peak GiB |
|---|---|---|---|---|---|
| single_full (ceiling) | 0.819 | 303.6 | 303.6 | 3.55 | 6.12 |
| alone (floor) | 0.012 | 119.4 | 119.4 | 2.03 | 6.09 |
| latent_sealed@3 | 0.000 | 189.6 | 309.6 | 3.79 | 6.25 |
| random_sealed@3 | 0.000 | 242.9 | 362.9 | 4.23 | 6.25 |
| latent_open@3 | 0.524 | 270.3 | 390.3 | 3.63 | 6.25 |
| random_open@3 | 0.175 | 234.4 | 354.4 | 3.64 | 6.25 |
| text_mas@3 | 0.301 | 897.5 | 897.5 | 7.54 | 6.45 |
| latent_sealed@11 | 0.006 | 104.0 | 544.0 | 5.56 | 6.58 |
| random_sealed@11 | 0.000 | 232.1 | 672.1 | 6.39 | 6.64 |
| latent_open@11 | 0.367 | 241.3 | 681.3 | 5.83 | 6.57 |
| random_open@11 | 0.102 | 136.1 | 576.1 | 5.60 | 6.64 |
| text_mas@11 | 0.283 | 2897.3 | 2897.3 | 20.77 | 6.45 |

The text team hit its 256-token turn cap on 68% (N = 3) and 82% (N = 11) of agent turns.

| Test | Comparison | Only first right / only second right | Exact p | Verdict |
|---|---|---|---|---|
| 5 | latent_sealed@3 vs alone | 0 / 2 | 0.50 | not established |
| 6 | latent_sealed@11 vs alone | 1 / 2 | 1.00 | not established |
| 7 | latent_sealed@3 vs random_sealed@3 | 0 / 0 | 1.00 | not established |
| 8 | latent_sealed@11 vs random_sealed@11 | 1 / 0 | 1.00 | not established |

Secondary figures (not gated):
- text_mas against latent_sealed: 50 / 0 at N = 3 and 47 / 1 at N = 11 (both p < 1e-12). Text notes carry facts that the sealed latent hand-off does not.
- latent_open against random_open: 60 / 2 at N = 3 and 48 / 4 at N = 11 (both p < 1e-9).
- latent_open against text_mas: 48 / 11 (p = 1.2e-6) at N = 3 and 25 / 11 (p = 0.029) at N = 11.
- single_full against latent_open: 52 / 3 at N = 3 and 78 / 3 at N = 11. Every team stays well below one model with the whole question.

### Predictions against results

| Prediction | Result |
|---|---|
| Tests 1–4 are not established | **Wrong.** All four are established, with the gap widening as N grows. |
| vote@N is at least as accurate as latent_mas@N for N ≥ 11 | **Held**, and vote is ahead at every N ≥ 11 with p < 0.00625. |
| Seconds per question grow at least linearly with N | **Partly.** Forward steps grow linearly. Seconds grew less than linearly from 3 to 11 at the same batch, and much faster beyond that, where the batch also changed. |
| Test 5 is established | **Wrong.** The sealed team is at the floor. |
| Tests 7–8 are the open question | Not established. Both sealed teams are at the floor, so these tests did not distinguish the sealed systems. |

### Reading

- **Tests 1–4 show that random thoughts break the model, not that real thoughts help.** latent_random falls from 0.425 to 0.055 at 31 agents and 0 at 101, while latent_mas never scores above single and is clearly below it at 101 agents (0 / 10, p = 0.002). Beating random thoughts is therefore weak evidence that the thoughts carry anything useful; these runs show no benefit from them.
- **The largest latent team is the worst, and the largest vote the best.** On the 50 questions every system answered, latent_mas scored 0.84, 0.72, 0.76 and 0.66 at 3, 11, 31 and 101 agents, and vote 0.86, 0.90, 0.84 and 0.94. Neither trend is steady, but vote is ahead of latent_mas at every N ≥ 11 (p < 0.00625 each). Vote never hands anything between agents: its gain comes from sampling many independent answers.
- **Against the text team, the latent team is cheaper with no measurable accuracy difference.** At N = 3 and 11 it used 58% and 75% fewer forward steps and 2.4 and 3.3 times less time, at 0.810 against 0.795 and 0.780 against 0.780 (15 / 12, p = 0.70, and 15 / 15, p = 1). No difference was found, which is not the same as showing equal accuracy. The saving comes from not writing text: latent_random takes about the same time and is far less accurate. Vote is more accurate than either team at these sizes, at many times the tokens. It is faster than latent_mas at N = 3 (2.14 against 3.01 s) and 13% slower at N = 11 (7.33 against 6.45 s).
- **The sealed latent hand-off showed no benefit.** With the earlier prompts hidden, the team answers 0 and 1 of 166 questions, no better than the Solver with only the ask (2 of 166). No hand-off of facts was demonstrated, which does not prove the latent steps hold none. Because both sealed teams are at the floor, tests 7 and 8 did not distinguish the thought content from the keys and values of the latent steps.
- The open teams can read the facts straight from the earlier prompts in the shared memory. Random vectors disturbing that reading would explain latent_open beating random_open, so this result cannot be told apart from the thoughts carrying the facts. The sealed results make the first more plausible, but these runs do not separate the two.
- The text team is the only hand-off here that passes facts the Solver could not read for itself. It is also the slowest, at 2–4 times the seconds per question.
- Scope: one model (Qwen2.5-3B-Instruct), no training, one question block, and 50 questions at 101 agents. Cycle 14's trained thoughts were not tested here.

### Data check (Codex, read-only)

Codex recomputed every figure in these results from the per-question records and the run commands. Question order, the 50-question prefix, the batch sizes, the 40 steps, every McNemar split and all four established primary verdicts matched. It found:

- four seconds-per-question values and one p-value rounded from already-rounded summaries, now taken from the raw values;
- memory labelled GB where the runner measures GiB;
- sentences in the reading that claimed more than the data show: equal accuracy with the text team, vote faster at every size, steady trends with N, a cause for tests 1–4, "no usable facts" in the sealed hand-off, and two mechanism claims;
- a description of `c15_stats.mjs` that overstated what it recomputes.

Each was corrected or narrowed above.

### Suites (2026-11-16, after merging main)

- `npm run -s test:graph` passes; `node --test tests/*.test.mjs` 191 of 192 pass, 1 skipped; `npx playwright test` 13 of 13.
- Runtime, `python -m unittest discover -s tests -t .`: 211 tests OK in WSL with torch, and 211 OK with 66 skipped on Windows Python 3.13 without torch.
- The documented command found that `runtime/tests/test_agent_scale.py` imported `test_latent_training` as a top-level module, the problem H1 fixed in the C14 test. It now imports `tests.test_latent_training`.

## P5b — Install passes the database path (defined 2026-11-20, before the code)

G8's `ledger install` passes a `PORT` other than 4317 to each agent's MCP server, but not `CONTEXT_LEDGER_DB`. Since P1e the MCP adapter finds the ledger's token in the file next to that database, so a ledger started on a custom database is unreachable from the agents: every tool call says there is no token. Synthetic data only: the G8 sandbox (fake home, stub CLIs).

| Eval | Expected |
| --- | --- |
| Passed on | With `CONTEXT_LEDGER_DB` set, install adds `CONTEXT_LEDGER_DB=<absolute path>` to both registrations in the place each CLI parses (Claude `-e` before `--scope`, Codex `--env`), beside `PORT` when that is set too. A relative path is resolved against the folder `ledger install` runs in, since the agents start the MCP server elsewhere. |
| Default unchanged | Unset or empty, nothing is added: the registrations are byte for byte the G8 ones. |
| Refused | `:memory:` (the server refuses it) and a value with a line break or other control character are refused before any CLI runs, with a fixed sentence. |
| Dry run | `--dry-run` prints the same commands with the path, escaped. |
| End to end | The MCP adapter started with the environment the stub recorded reaches a real server on a custom database and port: `session_search` answers instead of saying there is no token. |

**Results — P5b (2026-11-20, Windows):** every row passes. Code in `src/install.mjs`, tests in `tests/install.test.mjs`. Suites: graph 9/9; node 487 pass, 10 skipped; Playwright 27/27; runtime 239 OK, 66 skipped.

- **Codex review, round 1** (of 91dde35): no misplaced argument, no unescaped output, no symlink or `/private` mismatch, unset and empty unchanged. Fixed, each with a test:
  - (medium) On Windows a database path with `%` or `"` is refused when the CLI is a `.cmd` shim, but the dry run said it would register the server. The dry run now asks the same check (`refusedByCmd`) and prints the same refusal; the install stops before the instruction step, as it did.
  - (low) Uninstall read `CONTEXT_LEDGER_DB` and stopped on a bad value although it registers nothing. It no longer reads it.
  - (low) A server registered by an earlier install keeps its settings, so the README now says to remove it and install again after changing `PORT` or `CONTEXT_LEDGER_DB`.
  - Accepted: (low) the tests use stub CLIs, so they cannot prove that the real Claude Code keeps both `-e` values and Codex both `--env` values. No test runs the real CLIs (the G8 incident); the stubs follow each CLI's documented options, and a person checks a real install.
- **Codex review, round 2** (of 508acae): the three fixes hold. (low) The manual setup in the README, where the Windows refusal sends people, did not show `CONTEXT_LEDGER_DB`: both examples now do.

## P5a — Node suites on three systems (defined 2026-11-17, before the change)

The product is meant to install on Windows, macOS and Linux, but CI ran the Node suites and browser evals on Linux only (the Python checks already run on Linux and Windows).

- **Expected result:** on every push and pull request, `npm run -s test:graph`, `node --test tests/*.test.mjs` and `npx playwright test` pass on `ubuntu-latest`, `windows-latest` and `macos-latest`, each as its own job, so one system failing does not hide the others.
- **How it is checked:** the CI run on this card's pull request. `tests/*.test.mjs` is expanded by bash on every system, since PowerShell does not expand it.

### P5a: the Windows runner (defined 2026-11-20, before the fix)

With main merged in, the Windows Node job ran until the job limit cancelled it (20, then 45 minutes). The log shows the cause: from the first test that starts a server, every start on the runner ends with "Cannot write the access token file next to the database", so 26 tests fail; then the routes test that waits for the server's first line waits forever (the child has exited, while the test's fake runtimes keep the process alive). A one-off diagnostic job on `windows-latest` printed why the token write fails: the runner's account `runneradmin` is the built-in Administrator (RID 500), which SDDL spells `LA`, so the descriptor reads `O:LA…D:P(A;;FA;;;LA)` and the check, which compares SDDL text with `S-1-5-21-…-500`, refuses the file it has just written.

| Eval | Expected |
| --- | --- |
| Alias of the current user | The token scripts also print how SDDL spells the current user (from a descriptor holding only that SID). `privateToOwner` treats that alias as the same account, for the owner and every allow entry; with no alias, a malformed one, or any other account in the DACL, the file is still refused. A unit test pins this on `O:LA…(A;;FA;;;LA)` with a synthetic RID-500 SID. |
| No hang | The routes test that drives a server child fails at once with "The server child exited" when the child exits before printing a line. CI runs `node --test` with a five-minute limit per test file (the limit applies to each file as a whole), so a future hang fails one file, not the job. The job limit goes back to 30 minutes. |
| Signing key on the runner | P4a's key check reads DACLs with `icacls /save`, which also writes `LA`. It asks PowerShell to spell the SID from a descriptor built in memory (falling back to the SID alone if PowerShell refuses), and `daclAllowsOnly` accepts that spelling like the SID; with no alias, another account spelt `LA` or Everyone in the list, the key is still refused (unit test). |
| Test helper | Token files a test writes by hand are made private by `restrictToOwner`. On the runner `icacls /inheritance:r` was not enough: a file an elevated administrator creates where nothing is inherited gets explicit entries from the token's default DACL and the Administrators group as owner. The helper now writes one whole descriptor (this user as owner and only entry, protected) and throws with the file's SDDL if the result is not private. |
| Slow first call | On the runner the first MCP call (the adapter's start, then a PowerShell token read) took over 5 s, past the test MCP client's wait. The client waits 45 s by default (more than the token read's own 30 s limit); a test that expects silence passes its own limit. |
| Green on three systems | `node (ubuntu-latest)`, `node (windows-latest)` and `node (macos-latest)` pass, with the two runtime jobs. |

**Codex review** (`codex exec --sandbox read-only`):

- **Round 1** (of efdf301, the token fix): no ACL bypass, PowerShell bug or parsing bug found. (medium) The routes test teardown could still wait after a child ended by a signal or failed to spawn: one end promise now covers both. (low) The inherited-ACL assertion in the token test ran only when the check already refused the file: it now uses a folder that hands Everyone read access and asserts the refusal every time. Codex also asked for a check that an account spelt `LA` that is not the current user stays refused: added to the unit test.
- **Round 2** (of e516381, the signing-key fix): (medium) the key check learned the account's spelling from a temporary folder before that folder was private. It now asks PowerShell to spell the SID from a descriptor in memory, as the token scripts do, and reads nothing from disk for it. (low, older than this card) the `icacls /save` reader took the second line without checking which file the record names: `parseSavedAcl` now needs exactly one record for the expected file name, with a unit test for another name, extra records and missing lines.
- **Round 3** (of 5e578dc): both round-2 findings fixed. (medium) In PowerShell's Constrained Language mode the descriptor cannot be built and key creation and loading failed: the spelling now falls back to the SID, which still refuses any alias. (low) The record's file name is compared exactly, not case-folded. (low) The eval row above described the old folder probe: corrected.
- **Round 4** (of 9f8c8cf): the round-3 fixes hold, and the new test helper replaces the whole DACL. (low) The helper checked its result with the reader's policy, which accepts more than it promises: it now requires exactly this user as owner and one protected full-control entry. (low) Its PowerShell call had no timeout: 30 s, as in `src/token.mjs`.
- **Round 5** (of b9d3e19): both round-4 fixes hold. (low) 20 s could still be shorter than the adapter's start plus the token read's own 30 s limit: the default wait is 45 s.

## P2a — Project scope for graphs and MCP (defined 2026-11-21, before the code)

ADR-7a in [the architecture](architecture.md) §12. P1b put every session in a project; graphs, links, rooms and the MCP tools do not know about projects yet. Synthetic transcripts only: two projects, `orbit` and `vela`, each with sessions for two parties.

| Eval | Expected |
| --- | --- |
| A graph's project | `GET /api/graphs` rows carry `project`, the slug of the cited session's project. `?project=<slug>` returns only that project's graphs, with paging; an unknown slug returns none; a malformed one is a 400 with the fixed slug rule, and a repeated one is refused. No packet field names a project. |
| Links stay in a project | Publishing a graph whose link points at a graph of another project is a 400: "A link must point at a graph in the same project." The same link inside one project is accepted as before. |
| Rooms stay in a project | `POST /api/rooms` with graphs from two projects is a 400: "A room needs two graphs from the same project." `GET /api/rooms` rows carry `project`, and `?project=` filters them. A room's "newer graph" notice (G11) names only graphs of the same project. |
| MCP | `session_search`, `graph_list` and `room_list` take an optional `project` (ASCII letters folded to lowercase, like `party`) and pass it on; without it they cover every project. A row from a ledger that ignored the filter (another project, or no `project` field) makes the tool fail with a fixed sentence instead of returning wrong rows. The pinned tool list keeps its fourteen tools; the new arguments have their own size budget. |
| Nothing else moves | Every response pinned by `tests/routes.test.mjs` other than the list rows' new `project` field is unchanged, the token is needed on every route as before, and the browser app and console still pass. |

**Codex review, round 1** (of b7017f8): the auth gate, fixed error texts and republish path hold. Fixed, each with a test in `tests/project-scope.test.mjs`:

- (medium) A room opened across projects before P2a still took choices, and its newer-graph notice searched both projects. Such a room is now read-only (`decide` refuses it with a fixed sentence), names no newer graph, lists with `project: null` and matches no project filter.
- (medium) A session whose project is missing (`project_id` is nullable; the trigger fills it only on insert) matched another such session, so links and rooms between them passed. A missing project now matches nothing.
- (low) Paging with the filter was tested for graphs only: added a room walk over interleaved projects, and a `session_search` whose second ledger page holds another project's row.

**Codex review, round 2** (of e9d310d): the round-1 fixes hold. Two lows fixed: (low) a read-only room still showed Confirm and Reject buttons in the browser, which then failed; the room view now carries `takesChoices`, and the browser shows the recorded choices and a note instead (Playwright test). (low) The missing-project test did not cover the newer-graph notice: a room whose sessions lose their project now shows no newer graph and takes no choices (node test).

**Codex review, round 3** (of 0db171d): both round-2 fixes hold, and the new text is set with `textContent`. (low) The read-only note said "two projects" also when a graph's project is missing: the browser note and the refusal now say the graphs are not both in one known project.

## P2b — Message-key and artifact citations (defined 2026-11-21, before the code)

ADR-7b in [the architecture](architecture.md) §12. Graph nodes still cite file line numbers; P1c gave every stored message a stable key. Synthetic transcripts and made-up repositories only (`orbit-labs/adapter`).

| Eval | Expected |
| --- | --- |
| Version 3 packet | `schemas/semantic-graph-v3.schema.json` is version 2 with `evidence` in place of `evidenceLines`: 1 to 100 unique citations, each exactly `{ "message": "<key>" }` (a `u:`, `h:` or `l:` key) or `{ "artifact": "<64 hex>" }`. Parties, questions, edges and links are as in version 2. Versions 1 and 2 publish and read exactly as before. |
| Citations resolve | Every message key must be a stored message of the packet's session, and every artifact must be registered in that session's project; otherwise a 400 with a fixed sentence that names no key or ID. Order is not identity: citations are sorted in the canonical packet, so a reordered packet gets the same graph ID. |
| Derived citations | The stored graph keeps the packet as sent (canonical) and adds `citations`: for each node, the transcript lines its message keys resolve to and the artifacts it cites (`kind`, `repo`, `ref`). G7 grounding, `context_for`, the G11 diff, the G12 export and the console's evidence panel read lines from there, so a version 3 graph shows the same turns as the version 2 graph with the same lines. |
| Rooms and links | Version 2 and version 3 graphs link to each other and meet in rooms; every party-graph rule (other party, other session, same project, no superseded target) applies to both. |
| Artifacts | Schema version 4 adds an `artifacts` table: per project, kind `commit`, `pr` or `file`, a repository path such as `orbit-labs/adapter`, and a ref (a hex commit of 7 to 64 characters, a pull request number, or a relative file path with no `.` or `..` part). The ID is SHA-256 of the project, kind, repository and ref, so registering twice returns the same row. `POST /api/artifacts` (token and local Origin) and `ledger artifact add <kind> <repo> <ref> [--project <slug>]` register one; `GET /api/artifacts?project=` and `ledger artifact list` list them, newest first, with paging. Nothing registers an artifact by itself. A version 3 file is upgraded in place, and a newer file is refused untouched. |
| MCP | `graph_schema` offers versions 1, 2 and 3, with 3 as the default; `session_read` shows each turn's key beside its line, so an agent can cite it; `graph_publish` says that version 3 cites message keys or artifacts. No MCP tool registers an artifact. The pinned tool list keeps its fourteen tools. |

**Results — P2b (2026-11-21, Windows):** every row passes. Code in `src/artifacts.mjs`, `src/graph.mjs`, `src/store.mjs`, `src/migrate.mjs`, `src/server.mjs`, `src/cli.mjs`, `src/mcp/*` and the readers; tests in `tests/citations.test.mjs` and the console spec.

**Codex review, round 1** (of 4861b83): no cross-session or cross-project resolution at publish, no canonicalization hole, and migration, auth, Origin and escaping hold. Fixed, each with a test:

- (medium) The console dropped artifact citations, and its panel took the raw packet node, which a version 3 node gives no `evidenceLines`. The model now passes lines and artifacts to the panel, which lists each artifact as text and says when a node cites artifacts only (Playwright).
- (medium) The diff and the console compared citations without their session, so `l:1`, a reused record UUID or a line number in another session looked unchanged, and an answer link carried over to a question whose cited turn changed. Citations from another session are now a change in both (node test with one key in two sessions, for version 2 lines and version 3 keys).
- (low) The export flattened artifacts into `source_location` text, where a file path may hold `, ` or `@`: nodes also carry `ledger_artifacts` records.
- (low) `ledger artifact list` could read only the first 20 rows: it takes `--limit` and `--after`.

**Codex review, round 2** (of 4ee2126): the artifact panel, export records and CLI paging hold. Fixed, with a node test: (medium) the console still drew an `answers` edge to a question whose cited turn had changed; the edge is now drawn only while the answered question is the one it was published against. (low) Session scoping also caught artifact-only citations, which belong to the project: only lines and message keys are compared with their session now, in the diff and the console.

**Codex review, round 3** (of a7bf589): both round-2 fixes hold. (low) An answer published after its question had changed still flashed a read line to the changed question: such a link now reads nothing (node test).

## P5c — `npx` entry point (defined 2026-11-21, before the code)

The user's answers of 2026-11-21: prepare the package for npm but do not publish it; default the database to a per-user folder under the bin; when `install` runs through `npx`, register `npx`; the bin is `context-ledger`. Synthetic data only.

| Eval | Expected |
| --- | --- |
| Publishable package | `package.json` has no `private`, a `bin` named `context-ledger`, a `files` allowlist (`bin/`, `src/`, `public/`, `schemas/`, `rules/latent-rules.json`, README, LICENSE), the MIT `license`, the `repository` and `engines` (Node 22.14 or newer). `npm pack --dry-run` lists no test, fixture, `demo/` script or transcript, doc, runtime, `.sqlite`, `.env`, key or token file, and nothing outside the allowlist. The console's bundled synthetic recording (`public/console/demo-recording.json`) is included, because the console's demo mode loads it. No new runtime dependency. Nobody runs `npm publish` in this card. |
| One bin | `context-ledger start` runs the server, `context-ledger mcp` the stdio MCP adapter, and every other argument list runs the `ledger` CLI exactly as `npm run ledger --` does (same output, exit status and escaping). With no arguments it prints the usage. |
| Per-user database | Under the bin, an unset `CONTEXT_LEDGER_DB` becomes `.context-ledger/ledger.sqlite` in the home folder (`USERPROFILE` on Windows, `HOME` elsewhere), for the server, the CLI and the MCP adapter alike, so they find one token file whatever folder each starts in. A set value is kept. `npm start` and `npm run ledger` from a checkout keep today's defaults. |
| Install through `npx` | Run through `npx`, `context-ledger install` registers `npx -y --package <the spec it was run from> context-ledger mcp` (on Windows through `cmd /c`, which agents need for a `.cmd` shim), with `PORT` and the absolute database path as before. A local tarball path is made absolute. A spec that is a URL (it can carry credentials) or holds a space or a shell character is refused before any CLI runs. Run from a checkout or a global install it registers `node <path>/src/mcp.mjs` as today. The registered command, run as an agent would, answers MCP. |
| Works from a tarball | In an empty folder, `npm pack` then `npx -y --package <tarball> context-ledger …` starts the ledger, imports a synthetic transcript, publishes a graph and reads it back; a node test does this on each system. |

**Codex review, round 1** (of f279d69): the server, CLI and adapter share one database and token path under the bin, and the CLI dispatch is unchanged. Fixed, each with a test in `tests/npx-entry.test.mjs`:

- (high) On Windows the spec went into a `cmd /c` line that the agent later hands to cmd.exe, and the filter let shell characters through. (high) A URL spec with credentials would be copied into both agents' configs. Specs are now limited to letters, digits and `@ / \ . _ : # ~ + -`; URLs and anything else are refused before any CLI runs (ADR-15c).
- (medium) A local tarball spec was replayed from the agent's folder, and a path with a space fell back silently to a registry version that does not exist before publication. A local path is now made absolute, and an unusable one is refused, not replaced. The tarball test now runs `install --dry-run` through npx and starts the registered command as an agent would: it answers `session_search`.
- (medium) The tests' server start and MCP replies had no deadline, and a reply waiter never failed when the adapter exited: both now have one (90 s and 60 s) and fail on exit.
- (low) The eval said the tarball holds no demo, while the console's synthetic recording is included (the console's demo mode loads it): the eval now says so.

**Codex review, round 2** (of 693ca01): ordinary relative tarballs become absolute, credential URLs are refused, and the registered command answers MCP. Fixed, each with a test:

- (medium) The URL check missed `git+ssh:` specs without `//`, and the path rule rewrote `@scope/foo.tgz` and `github:owner/repo.tgz` as local paths and kept `file:` as part of a path. Specs are now told apart first: a registry name, a host shorthand, or a local path (`file:` stripped), each with its own grammar; anything else is refused.
- (medium) The test's MCP reader parsed partial lines from the pipe and did not fail on a closed stream: it now parses whole lines only and fails waiters on exit, error or close.
- (low) The ADR said the characters were safe for every shell; it now states the guarantee for the two paths the command takes (one POSIX argument, the Windows `cmd /c` line).

**Codex review, round 3** (of 4296c04), checked against npm's own spec parser (`npm-package-arg` 12): (medium) `dist/pkg.tgz` is a GitHub shorthand to npm, not a local file; (medium) npm resolves `file:~/…` under the home folder; (medium) npm reads `pkg@bundle.tgz` and `pkg@.next` as local paths. Now a bare name ending `.tgz` with no slash is a file, `dir/pkg.tgz` is kept as a shorthand (a local file in a folder is written `./dir/pkg.tgz`), `~` specs are refused, and a registry version must be an exact semver or a plain tag. (low) The test's MCP reader could fail a reply on exit before stdout delivered its last line: it now decides when stdout closes. Each case has an assertion.

**Codex review, round 4** (of d36346a): `dir/pkg.tgz` and the reader fix hold. (medium) npm reads `pkg@1.2.3-foo.tgz` as a local tarball, and (medium) `./~/pkg.tgz` under the home folder; (low) `pkg@x` is a range to npm, and `pkg@1.2.3+build` an exact version. Now no spec ending in a tarball suffix is a registry name (so `@scope/foo.tgz` is refused too), no spec with `~` is written, a tag is lowercase with two or more characters, and an exact version may carry `+build`; each case has an assertion. The rule stays narrow on purpose: a spec it cannot be sure of is refused with the advice to install globally, never rewritten.
- **CI on Windows** then failed the tarball test: the runner's temporary folder is `C:UsersRUNNER~1…`, and the rule refused every `~`. Only `~` as a whole path part (`~/x`, `./~/x`, `file:~/x`) is refused now; inside a name, as in a Windows short name, it is kept (unit assertion).

## P2c — Approval bound to a node hash (defined 2026-11-21, before the code)

ADR-7c and 7d in [the architecture](architecture.md) §12. Synthetic transcripts only.

| Eval | Expected |
| --- | --- |
| Node hash | Each node of a stored version 3 graph has a `nodeSha256` (in the graph's `nodeHashes`, in canonical node order): SHA-256 of the JCS form of `kind`, `label`, `status` and `to` when present, and the canonical `evidence`. A reordered packet gives the same hashes; a change to any of those fields changes the hash; the node ID does not enter it. Versions 1 and 2 have no hashes. |
| A person decides | `POST /api/graphs/<id>/reviews` with `{ nodeId, nodeSha256, decision: "approve" \| "reject", reviewer }` records the decision and returns the graph's current reviews. It needs a browser's sign-in cookie (the bearer token alone is refused), the local Origin and `Sec-Fetch-Site: same-origin`; the CLI and MCP adapter cannot send it, and no MCP tool decides. This keeps agent clients out; it does not prove who clicked. A hash that is not the node's current one is a 409; an unknown node, a version 1 or 2 graph, or a bad decision is a 400; an unknown graph is a 404. The reviewer is 1 to 64 visible characters (no control, format or separator character), typed by the person and shown as self-asserted. |
| Republish | Publishing the same party's graph from the same session again keeps the decision of every node whose hash is unchanged; a changed node starts unreviewed. Another session's graph never sees these decisions. |
| Read | `GET /api/graphs/<id>` adds `reviews`: for each node with a decision on its current hash, `{ nodeId, nodeSha256, decision, reviewer, decidedAt }`. MCP `graph_read` passes them on as data. |
| Browser | The library page has a "Review a graph" section: a graph ID and a reviewer name show each node with its kind, label, cited lines or artifacts, hash prefix and decision, with Approve and Reject buttons. Labels and names are set with `textContent`; a label holding markup stays text. |
| Schema | Schema version 5 adds the reviews table; a version 4 file is upgraded in place, and a newer file is refused. |

**Results — P2c (2026-11-21, Windows):** every row passes. Suites: graph 9/9; node 519 pass, 10 skipped; Playwright 32/32; runtime OK (66 skipped).

**Codex review, round 1** (of ef21bad): no decision leaks past the review key, no field left out of the hash, no review text rendered as HTML. Fixed, each with a test:

- (high) Any local process holding the bearer token could send the browser's `Sec-Fetch-Site` and record a decision, so "no agent can" was false. The route now also needs a browser's sign-in cookie: the bearer token alone is refused even with the header. The README and ADR say what remains: a program running as the person could still sign in as a browser does (ADR-10 trusts the OS user).
- (medium) A graph opened while a decision was in flight kept its buttons disabled: they are drawn again, enabled, when the decision ends (Playwright, with the POST held).
- (medium) A lone surrogate, which the version 3 label schema allows, made the JCS hash fail with a 500: a version 3 label must now be well-formed Unicode (400). Version 2 is unchanged.
- (low) The upgrade of a version 3 graph stored before P2c was untested: a republish now adds its hashes with the same ID and time, and the browser says how to enable review until then.
- (low) Added: a second party in the same session sees no decision, two nodes with the same content keep separate decisions, and a question's recipient enters its hash.

**Codex review, round 2** (of 4430698): the cookie check, re-enabled buttons and the 400 hold. (medium) A bearer holder can still mint a sign-in link and act as a browser, and one ADR line still named the token: the README and ADR now call the route an interface boundary, not a credential one, and the line is corrected (docs only). (low) The race test did not prove the second graph was drawn while the decision waited: it now checks that graph's own label and a disabled button before the decision is released. (low) A failed decision could move focus into the newly opened graph: focus returns only when the graph is the one decided on.

## P5d — Clean-install eval on three systems (defined 2026-11-21, before the code)

P5 asked for a clean-VM install eval on three systems. A fresh GitHub runner is the clean machine: nothing of the ledger is installed, and the check runs outside the checkout. Synthetic data only.

| Eval | Expected |
| --- | --- |
| Install | A `clean install` job on `ubuntu-latest`, `windows-latest` and `macos-latest` packs the checkout with `npm pack`, installs the tarball globally into an empty prefix (`npm install --global --prefix`), and runs everything below through the installed `context-ledger` command (the `.cmd` shim on Windows), from an empty folder with an empty home folder. |
| First run | `context-ledger` with no arguments prints the usage and exits 1. `context-ledger start` listens on loopback and writes its database and token file under `~/.context-ledger`. |
| A round trip | `context-ledger import`, `search`, `graph publish` and `graph read` work against that server; `context-ledger login` prints a one-time sign-in link of the expected shape. |
| Agents | `context-ledger mcp` answers `initialize` and `tools/list`, and `session_search` finds the imported session. |
| Clean stop | The server stops, and the check leaves nothing outside its temporary folder. |
| Local | `node scripts/clean-install-check.mjs` runs the same check on a developer machine (it packs the checkout itself). The script is not in the package. |

**Results — P5d (2026-11-21):** the Clean install workflow passes on `ubuntu-latest`, `windows-latest` and `macos-latest` (run of a32fc37), and `node scripts/clean-install-check.mjs` passes on Windows locally. The first Windows run failed after every step had passed: the check waited for the server's exit event after the `cmd.exe` shim had already exited, so it now waits on the promise made at spawn, for at most 15 s. The adapter's replies are read as whole lines, as in P5c's test after its review.

**Codex review, round 1** (of 7f6370b): no fallback to the checkout (the check runs the absolute shim or bin in the fresh prefix), and the workflow keeps `contents: read`, no persisted credentials and a 15-minute limit. Fixed in the script, run again on Windows from a folder whose name holds spaces:

- (medium) The MCP adapter could outlive a failed check: every process the check starts is tracked from spawn and its tree is stopped in `finally`, with bounded waits.
- (medium) A stop was assumed, not confirmed: `taskkill` has a 15 s limit, and the eval fails if the server's port still answers afterwards.
- (medium) npm ran with the developer's cache and config: both npm calls use an empty cache and empty user and global config under the temporary folder.
- (medium) cmd.exe expands `%` even inside quotes: the check refuses a temporary folder holding `%` or `"` with a fixed message, and its folder name now holds spaces, so the quoting of every command line is exercised.
- (low) Failure messages could print sign-in codes: they are redacted.
- (low) The bind address came from the banner: the check connects to 127.0.0.1 and to each of the machine's other IPv4 addresses, which must refuse.

**Codex review, round 2** (of 8415733): redaction and the loopback probes hold. (medium) Cleanup could report success with a child still running (a launcher can exit before its descendant, and the adapter was not checked): the check now records each process tree while it runs, kills what is left by ID, and fails unless every process is gone within 15 s. (medium) npm still inherited `npm_config_*` settings (in any case): all `npm_*` variables are dropped before its own are set, and the check asserts the checkout has no `.npmrc`. (low) A refused temporary folder was left behind: the parent folder is checked before anything is created.

**Codex review, round 3** (of 60f5e7c; that commit's CI passed all 16 jobs, the clean install on all three systems among them): (high) killing recorded process IDs could hit an unrelated program after an ID was reused, and (high) a parent ID left by an exited process could pull another program into the tree. Processes are now known by ID and creation time: a child counts only when it began after its parent, the launcher's tree is stopped through the launcher only while it still runs, and a leftover is killed by ID only while that ID still has the same creation time. (medium) A tree was read only after each readiness check, so a failure before it left descendants unknown: the tree is read every 2 s while a launcher runs, and again at stop time.

**Codex review, round 4** (of c242623): (high, twice) killing by process ID stays racy however it is checked: an ID can be reused between a check and a signal, and `ps` start times have one-second resolution. The check no longer kills anything by ID. It signals only through a launcher Node still holds (a process handle on Windows, an unreaped child elsewhere, so the ID cannot have been reused), reads trees only while that holds and drops a reading taken across the launcher's exit, and afterwards only looks: a process of the tree still there after 15 s fails the eval. (medium) A descendant started before the first reading of a launcher that then exits: not possible here, since cmd.exe waits for the node it starts and on macOS and Linux the bin link runs node itself; the comment says so. (low) The 15 s limit is now a deadline that counts the table reads.
- **CI** of c242623: 15 of 16 jobs passed; `node (windows-latest)` failed in `tests/e2e/console.spec.mjs` (live mode), whose `.node` locator also matched a node a room test publishes with the same hostile label into the shared e2e database. That is an older order-dependent flake, not this card; the job was run again.

**Codex review, round 5** (of 513a69f): (medium) a tree that was never recorded passed unverified: it now fails the eval. (low) A table reading that finished after the 15 s deadline could still clear it: it no longer counts. (high, accepted) On Windows `taskkill` resolves the launcher's ID itself, so a launcher that exits on its own in the milliseconds between the check and that lookup leaves its ID free for reuse. Closing this needs a Windows Job Object, which Node cannot create without a native module, and adding a runtime dependency for a test script is not worth it. The script runs on throwaway CI runners and on a developer's own machine, and the window is a launcher exiting by itself at the moment cleanup starts. It is written down in the script.
- **Flaky console test fixed here:** `tests/e2e/console.spec.mjs` (live mode) found its node by the hostile label, which a room test also publishes into the shared e2e database, so on Windows it matched two nodes (CI of c242623 and 513a69f). It now selects the node by its own party key. This blocked P5d's green CI, so it is in this pull request.


## P5e — Launch docs (defined 2026-11-21, before the docs)

| Eval | Expected |
| --- | --- |
| Install | The README opens with an Install section: a global install from the GitHub repository, which works today, the same by the npm name once the user publishes it, and `npx` for one-off commands with the whole prefix on each. The package name `@pricepepel/context-ledger` and the command `context-ledger` are both named, with why they differ. |
| First run | It says what `start` prints (the address and a one-time sign-in link), where the data lives (`~/.context-ledger`, `USERPROFILE` on Windows) and how to import a first transcript from the browser or the command line. |
| Agents | It shows `context-ledger install` (and `--dry-run`), what it registers through `npx` and from a global install, and that agents need the ledger running. |
| Upgrade and remove | It says how to upgrade (re-run with a newer version; a database is upgraded in place, an older build refuses a newer one), how to remove the agents' blocks (`uninstall`) and the data folder. |
| Not in this release | It lists what this release leaves out: the license key and paid tier (ADR-13), hosted sync, hash-chained review events and edits (P3), automatic transcript discovery. |
| Accurate | Every command in the section runs as written: a node test runs each `context-ledger` command the section shows (through the bin, against a temporary home) and checks that the commands it does not run (`npx`, `npm install`) name the right package and bin. |

**Codex review, round 1** (of b19c33b):

- (high) After the `npx` quick start there was no `context-ledger` command for the next steps. The section now leads with a global install, which works from GitHub today (`npm install --global github:PricePepel/context-ledger`, checked into an empty prefix: it installs the command) and by name once published; `npx` is kept for one-off commands, with the whole prefix on each.
- (medium) Removing `.context-ledger` left a database named in `CONTEXT_LEDGER_DB`: the removal step names it. (medium) The agent step left out that the `claude` and `codex` CLIs must be on `PATH` (a missing one gets the instruction block but no registration), the `cmd /c` wrapper on Windows, the fallback to the published name and version, and what a global install registers: all said now.
- (medium) The test did not check the npx subcommand, passed with no global install line, and never ran `uninstall`: it checks each, and says that the installed command is driven by P5d's clean-install eval.
- (low) The GitHub install needs Git: named as a prerequisite. (low) The handoff called P5 closed before P5d merged: reworded.

**Codex review, round 2** (of d2bc969): no high or medium finding. (low) The README now names `CONTEXT_LEDGER_CLAUDE_BIN` and `CONTEXT_LEDGER_CODEX_BIN` and says a partial install exits with status 1. (low) The test now requires the GitHub install and the scoped uninstall separately. (low) The test's note points at P5d's `scripts/clean-install-check.mjs`, which merges before this card.


## M2b-S — Latent transfer at 4B scale (defined 2026-11-21, before the run)

Run 1 of M2b (Qwen2.5-0.5B to SmolLM2-360M) passed its gate, but both models are far below the 3B–32B range of the SwaT paper (arXiv 2610.15095). This card scales the sender about 8× on the same 16 GB laptop GPU. A 7B pair does not fit in bf16 with the backward pass through the receiver, so 7B waits for quantized-receiver training or a larger GPU.

- **Pair:** `microsoft/Phi-3.5-mini-instruct` (3.8B, Phi-3 architecture, 32 KV heads, LongRoPE) to `Qwen/Qwen2.5-1.5B-Instruct` (Qwen2, 2 KV heads, RoPE base 1e6). Different families, tokenizers and RoPE, large to small like the paper's Gemma3-12B to Qwen3-4B.
- **Training:** `latent_transfer.train` with `--sender` and `--receiver`, the same two stages as run 1. Batch, mapper size and passage length are set by what fits in 16 GB without spilling to host memory, and recorded with the result.
- **Eval:** 300 SQuAD v1.1 validation questions (seed 0), greedy, token F1 and containment, conditions `text, closed, swat, zeroed, mismatched, t2t`. `t2t` uses the sender's own chat template; run 1's ChatML prompt is unchanged.

| Gate | Pass when |
| --- | --- |
| Carries the passage | `swat` beats `zeroed` and `mismatched` (another item's passage through the same mapper), each with the paired bootstrap 95% interval above zero. The mismatched control comes from the audit in arXiv 2608.04893. |
| Better than text | `swat` beats `t2t` (the sender's 40-word summary read by the receiver), interval above zero. Budgets are not matched in this card. |
| Faster than text | Mean `swat` end to end (sender prefill, mapper, receiver answer) is below mean `t2t` end to end (sender writes the summary, receiver answers). |
| Retention | Reported, with containment beside F1, because stage 2 trains the answer style (run 1's F1 retention of 1.86 was inflated by short answers). |

Not covered here, and named so nobody reads more into a pass: budget-matched compaction (Attention Matching), the fair control of a receiver fine-tuned on the same SQuAD data, and more than one task.
