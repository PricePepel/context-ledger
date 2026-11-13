# Project handoff

Goal: a local context library inspired by the publicly documented Nessie workflow. Start with explicit Claude Code and Codex transcript import, searchable conversational turns, and verifiable provenance. Make a selected session portable between agents.

Scope decisions: Node 22 with SQLite, a loopback HTTP server, and a browser UI. Synthetic fixtures only in Git. Import begins with a file the user selects. Browser and CLI use the same API. External accounts, background ingestion, embeddings, and sharing are follow-on work.

Project context lives here and in [the eval log](evals.md). Git commits are the implementation checkpoints. For a new feature, add acceptance criteria, implement it, run Playwright, obtain an independent code review, resolve findings, and record the outcome.

Research: [Nessie integrations](https://nessielabs.com/docs/integrations-overview) and [Nessie session handoffs](https://nessielabs.com/docs/resume-agent-session). The project implements its own interfaces using public behavior as a reference.

## Current checkpoint — 2026-11-06

The initial import/search and CLI handoff cycles are implemented and tested. Claude reviewed the design and the CLI. The independent Codex reviewer checked the backend, browser and CLI and verified the review fixes. The fixtures are synthetic. Start a new eval cycle before adding format coverage, incremental imports, or automatic discovery. Preserve explicit user control over which transcript content is ingested and which handoff is shared.

## Current checkpoint — cycle 3 (semantic graph)

Superseded by cycle 4 below. Branch feature/semantic-graph is pushed to origin and is waiting for Linux CI and a draft PR. Read [the delivery board](graph-delivery.md) and the cycle 3 results in [the eval log](evals.md). G1–G4 are done. G5 is being closed by Claude Code because Codex hit its usage limit mid-release. The next owner picks up G6: a read-only product review that recommends cycle 4 and names the eval that would justify it. Candidates already noted are bidi-safe handoff Markdown, semantic deduplication of reordered packets, and graph viewing in the browser UI. The graph/* worktree branches are kept for history and are not merge targets.

## Current checkpoint — cycle 4 (M0 two-party negotiation, 2026-11-07)

Leo's M0 items from the latent-ledger roadmap are implemented on feature/semantic-graph:

- Schema v2: parties, offers, questions and cross-graph links.
- Canonical v2 identity, cache-stable graph context and an estimated savings meter.
- The stdio MCP adapter (`node src/mcp.mjs`).
- Negotiation rooms, where people confirm proposals in the browser.

Read the cycle 4 card table in [the delivery board](graph-delivery.md) and the cycle 4 results in [the eval log](evals.md). The work is committed locally and not pushed. Next steps:

1. Push, then watch Linux CI. The workflow now runs every node test file.
2. Run a live smoke test with Claude Code and Codex both connected over MCP to one ledger.
3. Rehearse the two-person demo flow from the README section "Negotiation room".

Known limits:

- Party names are self-asserted.
- The decisions route keeps honest agents out (it requires a browser same-origin fetch) but does not prove who clicked.
- A room is tied to two graph snapshots.
- Meter tokens are estimates.

Ali owns the benchmark and pitch. The `.claude/worktrees/` agent worktree and its branch can be removed once the cherry-picked commit 964f70d is pushed.

## Current checkpoint — cycle 6 (M2a warm latent pool, 2026-11-07)

Every milestone is now split into a Leo side and an Ali side (latent-ledger `leo/split-roadmap`). M2a follows that split:

- **Leo side** (`leo/latent-read`): the `latent_read` MCP tool, the `POST /api/latent/read` proxy with slice validation, the text fallback, and the gate runner `evals/latent/run.mjs`.
- **Ali side** (`ali/latent-pool`, worktree `context-ledger-ali`): the stdlib Python warm pool in `runtime/` behind vLLM. Leo's agent built it for Ali's review. Ali owns it and should approve the contract (`q-latent-contract`) before it merges.
- Neither branch is pushed. Ali's M0 benchmark (cycle 5) is PR #3. Ali requested a Tenki review on PR #1 and PR #3, and none has arrived yet.

To run M2a live from WSL:

```sh
bash runtime/serve-vllm.sh
cd runtime && LATENT_ROOT=<folder> ~/venvs/latent/bin/python -m latent_pool.server
```

Then start the ledger with `LATENT_ROOT` set to the same folder (Windows path) and `LATENT_URL=http://127.0.0.1:4320`.

Results are in the cycle 6 section of [the eval log](evals.md). Next steps:

1. ~~Run the closed-model baseline.~~ Done: Claude Sonnet 16/16, latent pool 14/16 (see the eval log).
2. Ali reviews the runtime.
3. Triage Ali's benchmark finding that the graph context's stable prefix stays under the 1,024-token cache minimum (causes named in his handoff: session-ID line position, edge section order).

## Current checkpoint — cycle 7 (two-agent demo, 2026-11-07)

The demo runs on one laptop: the user's Claude Code plays Leo, the user's Codex plays Ali, and both connect over MCP to one ledger. Read [the run sheet](demo.md) and the cycle 7 results in [the eval log](evals.md).

- New MCP tools: `session_search`, and `session_read` with paging.
- Demo transcripts and reference graphs: `demo/`.
- Stage fallback: `demo/publish-reference.mjs`.
- Rehearsal: `demo/rehearse.mjs`.

Result: on a long session the graph handoff was about 3× faster and used about 5× fewer input tokens than the raw transcript, with the same accuracy. On a short session it saves tokens but not time.

The user's Claude Code (user scope) and Codex (`~/.codex/config.toml`, rebuilt after it was found corrupted) both connect to the ledger. A recorded take passed end to end after the fixes in the eval log's "Take 2" notes. Next steps: record the final video, then run more rehearsal rounds for a time estimate with a spread.


## Current checkpoint — cycle 9 (M2a tuning and the M2c measurement, 2026-11-10)

Branch `ruslan/m2a-m2c-tuning`, from `origin/main`, merged into `main` as PR #7 on 2026-11-12 (eb83866). The PR records no review, so Ali's review of the runtime part is still open (step 1). Read the cycle 9 sections of [the eval log](evals.md) and "Result: the full measurement" in [the M2c doc](m2c-latent-team.md).

- **Closed-model baseline re-run:** Claude Sonnet scores 8/8 with 8/8 citations on all three M2a sets in every run.
- **New fresh set:** `evals/latent/fresh.json` on `evals/latent/fixture-library`, written before tuning. `run.mjs` and `baseline.mjs` take `--set fresh`.
- **Strict citations, opt-in** with `LATENT_STRICT_CITATIONS=1`. The runtime limits quotes to real file lines (a structured-output enum) and asks for constants' literal values.
  - With Qwen2.5-14B-AWQ it scores 15/16 on the dev sets and 7/8 with 8/8 citations on the fresh set (strict grading since 2026-11-12), at about 2.9× the 7B time per question.
  - With the 7B model it costs citations, so it stays off by default, and the default 7B results are unchanged.
  - Ali should approve the runtime part (`docs/latent-read.md`, "pending Ali's approval").
- **Ledger grounding:** a quoted string literal in a finding's label must now appear on the cited lines.
- **M2c:** the gate passes on two seeds. Latent thinking needs real hidden states, but it does not beat one model solving alone, and between 30 and 50 steps the best value moves from sample to sample.
- **Follow-up of the PR #7 review (2026-11-12):** all three open lows are closed, and the live gate is re-run. See the cycle 9 follow-up sections of the eval log.
  - **Fresh grader:** stricter, measured at 81/90 against 90 independently labelled answers, with no right answer refused. The re-grade lowers some recorded fresh scores from 8/8 to 7/8. The gate verdicts stand.
  - **M2c:** `--block` gives disjoint samples. The disjoint re-run confirms the verdict.
  - **Runtime:** it folds whitespace exactly as the ledger does.
  - **Live re-run after f8ada62:** no loss on either setup. Accuracy is the same, and 14B held-out citations rose from 7, 7, 7 to 7, 8, 8.

Next steps:
1. Ali reviews the runtime changes, now on `main`: strict citations, and the whitespace fold in 8f00940.
2. Decide whether a 14B strict mode is worth 2.9× the latency for agents.
3. Measure grammar compile time at the enum caps (1000 choices or 60,000 characters).
4. Run M2c on an untied model.
5. Grade extra claims: the keyword grader still accepts 9 of 45 wrong answers that add a false detail. Use a judge model checked against a second judge (card G10 on [the delivery board](delivery-board.md)).

## Current checkpoint — cycle 10 (bounded MCP results and discovery, 2026-11-11)

Branch `ruslan/mcp-paging-discovery`, from `origin/main` 19f6522. Cycle 8 lives on `vuek0/subagent-graphs` and cycle 9 was PR #7, merged into `main` on 2026-11-12 and merged into this branch. Read the cycle 10 definition and results in [the eval log](evals.md).

- Every MCP tool result is at most 40,000 escaped characters (`maxResultCharacters` in `src/paging.mjs`), measured by `resultSize`: an ASCII letter or whitespace counts 1, other ASCII (digits, punctuation) 2, any other UTF-16 unit 4, so code, JSON and Han-script pages stay near the token count of 40,000 characters of English. A longer result comes in pages: JSON with `more` as its first key, or text whose first line is `[Partial result: ...]` and whose last line repeats that note, which names the arguments to send next. A result that fits is byte-identical to before. `callTool` withholds any oversized result as a bug.
- New tools `graph_list` and `room_list`, over the new `GET /api/graphs` and `GET /api/rooms`. `GET /api/sessions` pages only when it is given `limit` or `after`. `POST /api/latent/files` serves later pages of a latent text fallback without the model.
- `src/migrate.mjs` gives the SQLite file a schema version (`user_version` 1). It adds `created_at` and `party` to graphs and `created_at` to rooms, with indexes, and two triggers that stamp new rows from any insert path. Recreate the triggers if those tables are ever rebuilt. A file with a newer version is refused.
- Merging `vuek0/subagent-graphs`: it also edits `src/mcp.mjs`, `src/store.mjs` and `src/server.mjs`. The new tools come last in the tools Map, and the new routes are separate blocks. If that branch needs a schema change, add it to `migrate.mjs` as version 2, with steps that check the schema the way version 1 does. The paging helpers sit between `requireHex` and `text`, away from where that branch adds `currentTranscript`. In `context_for`, put its quota note into the `after` items, which count against the bound. Later pages come from the briefing that page 1 fetched in this process (`pagedBriefings`), so a read-through fetches `/context` once and counts as one handoff. That branch adds `handoff_publish` (1,881 characters of tools/list); the tools/list budget test in `tests/paging.test.mjs` counts only the 13 tools of this cycle by name, so it passes after the merge, but `tests/mcp.test.mjs` pins the tool names and needs the new one added.
- session_search without `limit` returns every match that fits, as on 19f6522; it reads ledger pages of 100 until the rows pass the bound. With `limit` it pages by that.

Done: the implementation (51aae9a) and three review rounds (fixes in 2a02e98, 404d7d7 and f53418a). The branch is pushed as draft PR #8 with Auto-fix on, and Linux CI passes. On 2026-11-12: the live evals passed (2d6a314), the two round 3 test gaps are closed (9262239), and an ASCII party filter is folded to lowercase in `graph_list` and `room_list` (76fdade), which removes the failed first call Codex made in every live discovery run. Suites on Windows: node 123/124 (one skipped), Playwright 13/13.

Known limits:

- `resultSize` weights are an estimate, not a tokenizer, and there is no caller-chosen page size.
- An ID inside `agreedProposalIds` can still be skipped or repeated if that list spans two pages and a choice changes in between.
- An old ledger (no `next`) whose session list is under 40,000 characters but over the weighted bound gets the restart error. Restarting the ledger clears it.

Next steps:

1. ~~Close the two round 3 test gaps.~~ Done in 9262239.
2. ~~Run the live evals.~~ Done 2026-11-12, all passing. Codex sentinel 9/9 (English, code and Han pages). Fresh-session discovery: Codex 3/3, Claude Code 1/1. Demo rehearsal 18/18 on both arms. The one low finding (Codex sent party `Leo` first) is fixed in 76fdade; the live re-run had no failed call in 3 of 3. See the eval log.
3. Merge with `vuek0/subagent-graphs` once that branch has its own PR and review. Expect conflicts in `src/mcp.mjs` (the instructions string and `context_for`), and check `src/store.mjs` and `src/server.mjs`. Add `handoff_publish` to the tool names in `tests/mcp.test.mjs`.
4. Review round 4 is settled (one low, fixed in d1600d2). PR #8 is still a draft: mark it ready for review on GitHub, then get a human review before merging, because it changes the stored schema (migration to version 1).
5. Backlog cards G7 to G12 on [the delivery board](delivery-board.md) come from a comparison with the public Graphify repository. G7 (quoted or inferred nodes) and G10 (a published handoff benchmark) are the cheapest and strengthen the pitch most.

## Current checkpoint — cycle 11 (latent runtime performance baseline, 2026-11-12)

Branch `ruslan/latent-perf`, from `origin/main` 17ecef0 (PR #8 merged). Card C11. Read the cycle 11 definition and results in [the eval log](evals.md).

- `evals/latent/perf.mjs` measures a latent configuration end to end, with the pure helpers in `evals/latent/perf-lib.mjs` and 26 tests in `tests/perf.test.mjs`. It sends the dev set through the ledger like `run.mjs` and reads vLLM's `/metrics` before and after every read. It reports TTFT, prefix-cache hit rate, tokens per second, speculative-decoding acceptance, GPU memory (`nvidia-smi`), KV pool and per-read KV memory, read latency and accuracy.
  - Usage: `LEDGER=http://127.0.0.1:4327 node evals/latent/perf.mjs --repeat 3 --label A --hf-config <model config.json> --out report.json`.
  - The ledger must run with the dev fixture, as for `run.mjs`.
- **Baseline on the 4090 Laptop (Qwen2.5-7B AWQ):**
  - TTFT 40 ms at p50 and 179 ms at p90
  - 96.8% of prompt tokens from the prefix cache
  - about 89 tokens/s per request
  - 5.2 s per read at p50
  - 14,078 MiB (13.7 GiB) of GPU memory, held by vLLM's reservation
  - a sampled peak of about 151 MiB of KV cache per read
- `runtime/serve-vllm.sh` has two opt-in switches, both off by default, because runtime defaults are Ali's to change:
  - `VLLM_NGRAM=1`: n-gram speculative decoding. 7B reads are 29% faster at p50 with the same accuracy, so it is recommended as the default.
  - `VLLM_KV_FP8=1`: FP8 KV cache on Triton. Usable with the 14B strict setup; it breaks the 7B AWQ model.
- FP8 weights are slower than AWQ on this GPU and were rejected.

Next steps:

1. Ali decides whether `VLLM_NGRAM=1` becomes the default in `serve-vllm.sh`.
2. Find why the fixture on the WSL disk decodes about 9% faster (configuration E), and why the 14B FP8 KV pool is smaller than expected (B-C).
3. C12 (multi-LLM) continues on `ruslan/multi-llm`, which is based on this branch.

## Current checkpoint — cycle 12 (multi-LLM latent runtime, 2026-11-12)

Branch `ruslan/multi-llm`, based on `ruslan/latent-perf` (C11, PR #9). Card C12. Read the cycle 12 definition and results in [the eval log](evals.md).

- **M2a pool: any vLLM-served chat model.** It is measured on four families (Qwen2.5, Llama 3.1, Mistral v0.3, Granite 3.1), with no failed reads.
  - The one code change is in `runtime/latent_pool/vllm_client.py`. When a chat template refuses system messages (Mistral), the client folds the system text into the user message after the first refusal. The shared prefix stays first, so caching still works.
  - Granite matches Qwen on accuracy, Mistral leads the dev set but cites less on the held-out set, and Llama 3.1 is weakest.
  - Run another model with `LATENT_MODEL=<hf id>` for both `serve-vllm.sh` and the pool.
  - vLLM 0.33 refuses GPTQ checkpoints with `desc_act=True`.
- **M2c latent team: any chat template.**
  - `runtime/latent_team/chat_turns.py` derives the turn texts from the tokenizer's own template. ChatML is byte-identical to before, and a template it cannot handle is refused by name.
  - The stop tokens come from the tokenizer, the generation config and the derived close token.
  - Measured on Phi-3.5-mini, which is not ChatML and has untied embeddings: see the eval log. Run it with `python -m latent_team.evaluate --model microsoft/Phi-3.5-mini-instruct --batch 4`. Batch 8 spills past the laptop's 16 GB and runs about 4.5× slower.
- **M2b transfer** is still per pair: another sender and receiver need their own trained mapper.

Next steps:

1. Ali reviews the runtime changes: the system-message fold, and the chat-template derivation in the latent team.
2. Strict citations (`LATENT_STRICT_CITATIONS=1`) have only been measured on Qwen. Run them on Granite and Mistral.
3. Mistral cites 5 of 8 held-out answers; check whether strict citations close that gap.
