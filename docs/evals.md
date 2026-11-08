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
