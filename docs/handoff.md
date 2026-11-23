# Project handoff

Goal: a local context library inspired by the publicly documented Nessie workflow. Start with explicit Claude Code and Codex transcript import, searchable conversational turns, and verifiable provenance. Make a selected session portable between agents.

Scope decisions: Node 22 with SQLite, a loopback HTTP server, and a browser UI. Synthetic fixtures only in Git. Import begins with a file the user selects. Browser and CLI use the same API. External accounts, background ingestion, embeddings, and sharing are follow-on work.

Project context lives here and in [the eval log](evals.md). Git commits are the implementation checkpoints. For a new feature, add acceptance criteria, implement it, run Playwright, obtain an independent code review, resolve findings, and record the outcome.

Research: [Nessie integrations](https://nessielabs.com/docs/integrations-overview) and [Nessie session handoffs](https://nessielabs.com/docs/resume-agent-session). The project implements its own interfaces using public behavior as a reference.

## Current checkpoint — S1b honest speed-up on the swarm page (2026-11-22)

PR #76: before a live run the ledger times each server alone (one untimed warm-up, then `SWARM_BASELINE_RUNS` timed requests, default 3, on reports from their own seed, median), once per ledger process. "One after another" is now answered agents × solo time per server and "Speed-up" divides it by wall time; the old sum of agents' times under load is only in the API as `agentMsSum`. The KV tile shows the peak during the run. Two Codex rounds, all findings fixed with tests (see evals, S1b). Not done yet: the live check on vLLM, blocked because the GPU is busy with W3 until about 22:00. Next owner: run 100 agents live (expect about 23-30x, a nonzero KV peak), add the numbers to evals and PR #76, then update the investor run sheet line that says not to quote the speed-up tile.

## Current checkpoint — S1 swarm live on vLLM (2026-11-22)

100 live agents (Qwen2.5-7B AWQ on the laptop GPU) finish in 3.5–4.6 s, 100 of 100 correct and verified, combined answer matching the truth; about 23–30× faster than one agent at a time (measured single-agent baseline 1.05 s). The page's own speed-up ratio (53×) overstates this, and its KV figure reads 0% after the run: both go to Backlog card S1b. Two models on one GPU start only with the settings in evals (S1, live run); their timings were taken while another GPU job ran and are not usable. Next owner: S1b, then rerun the two-model timing on an idle GPU.


## Current checkpoint — M2b-S latent transfer at 4B scale (2026-11-22)

Phi-3.5-mini (3.8B) to Qwen2.5-1.5B, trained on the 16 GB laptop GPU and evaluated on 300 SQuAD questions. Three gates pass and retention is reported: `swat` F1 0.872 vs text summary (`t2t`) 0.460, paired 95% interval for the F1 difference [0.36, 0.46]; the mismatched cache scores 0.153 and the zeroed one 0.002, so the gain depends on the correct passage's cache; 426 ms mean end to end vs 3,666 ms for `t2t`. Against the receiver reading the passage, the containment difference is −0.003 [−0.047, 0.040], so claim "finds the answer as often as reading it, within 5 points", not "beats it". Full table in [evals](evals.md) under M2b-S. Next owner: Codex review of the record, then the budget-matched compaction card (Attention Matching) and a receiver fine-tuned on the same SQuAD data as the fair control. Checkpoint stays on the GPU machine at `~/m2b-scale/run1/best.pt`.

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

Read the cycle 4 card table in [the delivery board](graph-delivery.md) and the cycle 4 results in [the eval log](evals.md). The work is committed locally and not pushed. (Later: it reached `main` through PR #1, merged on 2026-11-08.) Next steps:

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
- Neither branch is pushed. (Later: both reached `main` through PR #6, merged on 2026-11-08. PR #4, the draft for `leo/latent-read`, was closed without merging.) Ali's M0 benchmark (cycle 5) is PR #3. Ali requested a Tenki review on PR #1 and PR #3, and none has arrived yet.

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

Branch `ruslan/mcp-paging-discovery`, from `origin/main` 19f6522, merged into `main` as PR #8 on 2026-11-12 (17ecef0). Cycle 8 lives on `vuek0/subagent-graphs` and cycle 9 was PR #7, merged into `main` on 2026-11-12 and merged into this branch. Read the cycle 10 definition and results in [the eval log](evals.md).

- Every MCP tool result is at most 40,000 escaped characters (`maxResultCharacters` in `src/paging.mjs`), measured by `resultSize`: an ASCII letter or whitespace counts 1, other ASCII (digits, punctuation) 2, any other UTF-16 unit 4, so code, JSON and Han-script pages stay near the token count of 40,000 characters of English. A longer result comes in pages: JSON with `more` as its first key, or text whose first line is `[Partial result: ...]` and whose last line repeats that note, which names the arguments to send next. A result that fits is byte-identical to before. `callTool` withholds any oversized result as a bug.
- New tools `graph_list` and `room_list`, over the new `GET /api/graphs` and `GET /api/rooms`. `GET /api/sessions` pages only when it is given `limit` or `after`. `POST /api/latent/files` serves later pages of a latent text fallback without the model.
- `src/migrate.mjs` gives the SQLite file a schema version (`user_version` 1). It adds `created_at` and `party` to graphs and `created_at` to rooms, with indexes, and two triggers that stamp new rows from any insert path. Recreate the triggers if those tables are ever rebuilt. A file with a newer version is refused.
- Merging `vuek0/subagent-graphs`: it also edits `src/mcp.mjs`, `src/store.mjs` and `src/server.mjs`. The new tools come last in the tools Map, and the new routes are separate blocks. If that branch needs a schema change, add it to `migrate.mjs` as version 2, with steps that check the schema the way version 1 does. The paging helpers sit between `requireHex` and `text`, away from where that branch adds `currentTranscript`. In `context_for`, put its quota note into the `after` items, which count against the bound. Later pages come from the briefing that page 1 fetched in this process (`pagedBriefings`), so a read-through fetches `/context` once and counts as one handoff. That branch adds `handoff_publish` (1,881 characters of tools/list); the tools/list budget test in `tests/paging.test.mjs` counts only the 13 tools of this cycle by name, so it passes after the merge, but `tests/mcp.test.mjs` pins the tool names and needs the new one added.
- session_search without `limit` returns every match that fits, as on 19f6522; it reads ledger pages of 100 until the rows pass the bound. With `limit` it pages by that.

Done: the implementation (51aae9a) and three review rounds (fixes in 2a02e98, 404d7d7 and f53418a). The branch was pushed as draft PR #8 with Auto-fix on, and Linux CI passed. On 2026-11-12: the live evals passed (2d6a314), the two round 3 test gaps are closed (9262239), and an ASCII party filter is folded to lowercase in `graph_list` and `room_list` (76fdade), which removes the failed first call Codex made in every live discovery run. Suites on Windows: node 123/124 (one skipped), Playwright 13/13.

Known limits:

- `resultSize` weights are an estimate, not a tokenizer, and there is no caller-chosen page size.
- An ID inside `agreedProposalIds` can still be skipped or repeated if that list spans two pages and a choice changes in between.
- An old ledger (no `next`) whose session list is under 40,000 characters but over the weighted bound gets the restart error. Restarting the ledger clears it.

Next steps:

1. ~~Close the two round 3 test gaps.~~ Done in 9262239.
2. ~~Run the live evals.~~ Done 2026-11-12, all passing. Codex sentinel 9/9 (English, code and Han pages). Fresh-session discovery: Codex 3/3, Claude Code 1/1. Demo rehearsal 18/18 on both arms. The one low finding (Codex sent party `Leo` first) is fixed in 76fdade; the live re-run had no failed call in 3 of 3. See the eval log.
3. Merge with `vuek0/subagent-graphs` once that branch has its own PR and review. Expect conflicts in `src/mcp.mjs` (the instructions string and `context_for`), and check `src/store.mjs` and `src/server.mjs`. Add `handoff_publish` to the tool names in `tests/mcp.test.mjs`.
4. Review round 4 is settled (one low, fixed in d1600d2). PR #8 was merged into `main` on 2026-11-12 (17ecef0) without a recorded review: GitHub shows no reviews and no comments on it. The human review of the stored-schema change (migration to version 1 in `src/migrate.mjs`) is still owed.
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
  - Granite does at least as well as Qwen (better on the dev set, equal on the held-out set), Mistral leads the dev set but cites less on the held-out set, and Llama 3.1 is weakest.
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

## Current checkpoint — cycle 13 (tuning the latent hand-off, 2026-11-13)

Branch `ruslan/latent-tuning`, based on `ruslan/multi-llm` (C12, PR #10). Card C13. Read the cycle 13 definition and results in [the eval log](evals.md).

- **Result: not established at any level.** On 200 held-back GSM8K questions (block 4), latent thoughts on Phi-3.5-mini score no better than random vectors with the same weights:
  - level 1, settings: 0.845 against 0.845;
  - level 2, trained adapter: 0.815 against 0.840;
  - level 3, LoRA: 0.750 against 0.775.
- **The trainer, `runtime/latent_team/train.py`:**
  - The model is frozen. A thought adapter (`--level adapter`) or a hand-written LoRA (`--level lora`, no `peft`) is trained on the solver's answer loss, back through the latent loop.
  - Checkpoints load into `latent_team.evaluate` with `--adapter` / `--lora`, and every system in that run then uses the same weights.
  - Only soft thoughts are trained. Aligned (W_a) thoughts break Phi-3.5-mini (0.13–0.23) and would not be norm-matched to the random control.
- **Memory on the 16 GB laptop GPU:**
  - Use `--grad-agents 2 --max-prompt-tokens 160` and train at m = 10.
  - Phi-3.5-mini has no grouped-query attention, so every latent step keeps a full key and value copy for the backward pass.
  - The cap now counts the chat-template tokens (18fba6e). The completed runs counted the raw prompt text.
- **Run times:** the adapter took 46 minutes on 947 questions, and the LoRA 2 hours on 1,893.

Next steps:

1. Ali reviews the trainer and the LoRA module. The Codex reviews are recorded in the eval log.
2. If the hand-off is tried again, train against the model's own correct answers (self-distillation), not the gold solutions. With gold-solution training, the adapter shortened answers, and the LoRA shortened them and lowered single from 0.855 to 0.730. The cause is not isolated.
3. Train at the step count that is evaluated, which needs more memory or a model with grouped-query attention. A Qwen or Llama model with grouped-query attention would cut the key and value cost several times over.

## Current checkpoint — cycle 14 (self-distilled LoRA targets, 2026-11-13)

Branch `ruslan/self-distill`, based on `ruslan/latent-tuning` (C13, PR #11). Card C14. Read the cycle 14 definition and results in [the eval log](evals.md).

- **Result: not established.** On the unused block 5 (200 questions), the team with the self-distilled LoRA scores 0.870 against 0.860 for random vectors with the same weights (7 / 5, p = 0.77).
- **No style damage this time.** Single with the LoRA scores 0.870 with 274-token answers, the same as the untrained model. The gold-trained LoRA of cycle 13 had cut this to 0.730 and 102 tokens.
- **New code:**
  - `runtime/latent_team/distill.py` writes the untrained model's greedy single answers on the GSM8K train sample. It keeps only right answers that stopped inside the budget.
  - `train.py --targets <file>` trains on those answers instead of the gold solutions. Questions with no kept answer are skipped and counted, never filled with gold. A file from another model is refused.
- **Run settings:** C13 level 3 settings with `--max-target-tokens 512`. The run trained on 1,734 examples in 103 minutes, with a 14.25 GB peak. The targets file holds GSM8K train text and stays with the run outputs; it is not committed.

Next steps:

1. A human reviews the distill code with the C13 trainer. The Codex code review and data check are recorded in the eval log.
2. Do not run more GSM8K training variants against this setup. Two training targets and three levels all tie random. Cycle 15 (sealed agents, split facts, Qwen2.5-3B) tests whether the hand-off can matter at all when the solver cannot read the facts itself.

## Current checkpoint — housekeeping H1–H5 and G10 (2026-11-16)

Six cards from a review of the project map against CI, these notes and the board. Each had its own PR (#13 to #18), all from the claim commit `claude/housekeeping-claim` (8a41b0e), which claims the cards on the board and defines their evals in [the eval log](evals.md). On 2026-11-16 the user asked for every open PR to be merged one by one: C11 to C14 (#9 to #12, retargeted to `main` in turn) first, then these six, then #19. Results, review outcomes and suite counts are under each card's **Results** heading in the eval log.

| Card | PR | What changed |
| --- | --- | --- |
| H1 | #13 | `.github/workflows/runtime.yml` runs the Python runtime checks on Ubuntu (3.12) and Windows (3.13). AGENTS.md and the PR template list the command. It also fixed `runtime/tests/test_self_distill.py` (from C14), which imported `test_latent_training` as a top-level module and failed under the documented command. |
| H2 | #14 | README, these notes, `docs/latent-read.md`, `docs/m2b-transfer.md` and runtime docstrings now match `main`. |
| H3 | #15 | `src/mcp.mjs` is split into `src/mcp/` (largest file 173 lines). `initialize` and `tools/list` output is byte-identical. |
| H4 | #16 | `rules/latent-rules.json` holds the secret-file rule and the quote whitespace for both languages, and `rules/latent-conformance.json` holds cases both suites run. The Python grader port moved to `runtime/tests/grade.py` and now matches `grade.mjs`. |
| H5 | #17 | `src/server.mjs` dispatches from a table of requests and names the runtime's default address once. `tests/routes.test.mjs` pins 192 responses. |
| G10 | #18 | `BENCHMARKS.md` and `evals/handoff/`: 14 graded facts, two graders checked against 82 labelled answers, a runner with a Git-ignored spend log. No live runs yet. |

All six were reviewed by Codex (read-only). A dry run of all eleven merges (Windows, 2026-11-16) found only docs conflicts (board rows, eval sections and handoff checkpoints added on both sides), resolved by keeping both sides. After the C14 import fix it passed node 191/192 (one skipped) and Playwright 13/13. The first hosted `runtime.yml` run, on #13 after C11 to C14 were merged, gave 183 run and 63 skipped on both jobs.

Next steps:

1. **`vuek0/subagent-graphs` now merges onto H3 and H5.** Its `src/mcp.mjs` changes are one large conflict after the split; the H3 results map each change to its new file. Its three server routes become entries in the H5 request table; the H5 results describe them.
2. G10: a person checks the 82 labels in `evals/handoff/labelled.json`, then live runs (`node evals/handoff/run.mjs --agent claude --model M --runs 10`, the same for codex, then `--summary`). Check token and cost parsing on the first live Claude run.
3. Still owed from earlier: Ali's review of the runtime changes from cycle 9, the human review of PR #8's schema migration, and Ali's decision on `VLLM_NGRAM=1` (cycle 11).
4. PR #3 (Ali's draft M0 benchmark, based on `feature/semantic-graph`) was left open: it is Ali's and conflicts with its base.

## Current checkpoint — G6 product and eval review (2026-11-17)

Branch `codex/g6-product-review`. Codex, the card's owner, reviewed the product and evals as they stood on 2026-11-17 (read-only; run from Claude Code). The review is [docs/reviews/g6-2026-11-17.md](reviews/g6-2026-11-17.md). Its main points:

- **Evidence.** The handoff savings rest on synthetic data. The cycle 7 figures come from six early facts, and G10's live runs are still owed. The latent team results show no advantage over random vectors.
- **Risks.** A real citation can support a wrong label. Local transcript text reaches the agent through `session_read` and the latent fallback. Party names in rooms are not verified.
- **Next cycle.** Run G10 live on Claude Code and Codex with human-checked labels, under a pass rule written in advance. Hold the "3× faster, 5× fewer tokens" claim until then.
- **Board.** P1's design part is done. Its implementation should go back to Ready with a named owner and a first storage test.

The board changes it recommends are left to the card owners; this PR only adds the review.

## Current checkpoint — G12 export for code-graph tools (2026-11-17)

Branch `ruslan/g12-graph-export`. `GET /api/export?graph=…`, `GET /api/graphs/:id/export` and `npm run ledger -- graph export <id>…` write graphs as one node-link file for Graphify (`src/export.mjs`). The eval and results are in the G12 section of [the eval log](evals.md).

- Several graphs go in one file because `graphify merge-graphs` prefixes each input file's IDs, and links between graphs survive only inside one file.
- Node IDs are `ctm_<16 hex of the graph ID>__<node id>`, so two snapshots never share a node. Links to graphs outside the export are left out and counted.
- The export is undirected (`merge-graphs` refuses directed graphs), and `ledger_from` and `ledger_to` keep the direction. The HTTP body is the node-link JSON itself, escaped.

Next steps:

1. Merge with a real code graph from `graphify extract` and check that `graphify query` and `graphify explain` find the decisions. This card merged with a small synthetic code graph.
2. Decisions that name files or functions could link to the matching code nodes. That needs Graphify's code node IDs and would be a new card.

## Current checkpoint — U1 Console v0, light (2026-11-17)

Branch `ruslan/console-v0`, from `main` 3a17536. Card U1. Read the U1 eval and its results in [the eval log](evals.md), and [the feature map](feature-map.md).

- **What it is:** `npm start`, then `/console/`. One read-only page: an isometric SVG office (one room for Claude Code, one for Codex, one character per party that published today, shown working, waiting or idle), the ledger graph (one column per party, pop-ins, flash lines from the room to each new or changed node, dashed lines for links to another party's nodes, superseded decisions struck through), a one-click evidence panel (cited turns highlighted, hidden characters escaped as in `src/text.mjs`), an activity list and three numbers (hand-offs today, tokens saved as an estimate, superseded decisions).
- **Data:** only GET routes that already existed. `public/console/source.mjs` polls `GET /api/graphs` every 2 s; graphs are snapshots, so `public/console/model.mjs` diffs each party's newest graph against its previous one to find new and changed nodes. The ledger records no reads, so a "read" line is drawn only from links in a published graph.
- **Demo:** `/console/?demo` (`&speed=2`, `&autoplay=0`) replays `public/console/demo-recording.json`. `node demo/console-recording.mjs` rebuilds it by running the real store on `demo/leo-orbit.jsonl` and `demo/ali-orbit.jsonl`; a node test fails if the committed file differs. Rebuild it whenever the store, graph validation, the meter or those transcripts change.
- **Server:** `src/server.mjs` gains only a fixed list of static files under `/console/`. A new console file must be added to that list.
- **Weight:** 84.5 KB in total with the recording, first contentful paint 56 to 84 ms (Playwright, this laptop). Screenshots and `perf.json` are in `docs/console/`; rerun with `CONSOLE_SHOTS_DIR=docs/console npx playwright test tests/e2e/console.spec.mjs`.
- **Built by:** Claude Code, with the office module (`office.mjs`, `office.css`) written by a subagent against a fixed interface. Reviewed by Codex (read-only) in three rounds; every finding is fixed or recorded as a limit in the eval log.

Known limits:

- G7 is not built, so every node is one neutral colour. `nodeMark` in `model.mjs` reads a `grounding` or `mark` field of `quoted` or `inferred` when G7 adds one.
- Superseded decisions come from `supersedes` edges, not from G11's graph diff.
- The live view starts at the start of today: a party whose newest graph is older is not drawn. More than 6 parties in one room show as "+N" in the office (each still has its graph column).
- The office mascot is a placeholder until U2.

Next steps:

1. **The 60-second recording (raw material for U3) is for a person to make.** Run `npm start`, open `http://127.0.0.1:4317/console/?demo&autoplay=0` in a 1440×900 window, start a screen recorder, click **Play demo**, wait for "Demo finished" (34 s), then click "The ledger stays on port 4317" to open its proof, and stop at about 60 s.
2. A human review of the PR. It touches no security, export or signing code, but it does add static routes to the server.
3. When G7 lands, give the quoted and inferred marks a field name and check the colours in the console.

## Current checkpoint — U3 60-second demo video (2026-11-17)

Branch `ruslan/u3-demo-video`, stacked on U1 (`ruslan/console-v0`). [docs/video/u3-script.md](video/u3-script.md) is the shot list and voice-over, timed to 60 seconds. `node demo/record-console.mjs` records the console part as raw footage into `test-results/u3/console-demo.webm` (about 42 seconds, synthetic Orbit demo, not committed).

Next steps:

1. A person records the terminal shots and the voice-over and cuts the video to the shot list. The install shot uses `npm run ledger -- install` once G8 is merged, or the README's two `mcp add` commands before that.
2. Swap in Pip for the title card once U2 is merged.
3. Link the finished video in the U3 eval section, and move the card to Done.

## Current checkpoint — U2 brand and mascot (2026-11-17)

Branch `ruslan/u2-brand-mascot`. [docs/brand/brand.md](brand/brand.md) is the brand guide: the CTM site's colours (Deep Charcoal, Electric Violet, Acid Lime, Paper), with light (console) and dark (site, video) sets in [tokens.css](brand/tokens.css), each pair checked for WCAG AA contrast. It also sets the quoted and inferred mark colours, the type stacks, and Pip, an original mascot in three poses for the console's idle, working and waiting agents. `tests/brand.test.mjs` checks the colours, the contrast and the SVG rules.

Next steps:

1. Someone on the team signs off on Pip's look.
2. Once U1 (PR #22) is merged, swap the office module's placeholder figure for the three Pip SVGs by state, and use the tokens in the console's CSS.
3. U3 (the demo video) can use Pip and the dark set.

## Current checkpoint — H7 Windows deadline flake (2026-11-17)

The runtime job on the Windows runner failed at random on PRs that do not touch `runtime/` (#29–#32). Three deadline tests got 502 "Model server timed out." instead of 504. `_Run.call` (`runtime/latent_pool/pool.py`) now decides before each model call whether the read deadline is the shorter limit. If that call then times out, the read returns 504, whatever the clock reads afterwards. The client raises `ModelTimeout` (`runtime/latent_pool/__init__.py`), which is still a 502 with the same message, so the client's own timeout and every other 502 behave as before. Regression tests are in `runtime/tests/test_deadline_clock.py`. Eval and results: H7 in `docs/evals.md`.

Next steps:

1. After this merges, rerun the failed `runtime (windows-latest, Python 3.13)` job on any open PR still red from this flake.
2. H8 (Backlog): keep each model call inside the read deadline as a whole, not per socket read, and map a deadline-capped connect timeout to 504 instead of 503.

## Current checkpoint — P1 design landed, implementation split (2026-11-17)

Branch `ruslan/p1-design`. `docs/architecture.md` comes from `product/v1` unchanged except for its links, a status note, and a new section 11 on where `main` has moved. It stays a proposal until P1's owner approves the PR. The board splits P1's implementation into P1a (storage engine decision, which needs the owner), P1b (projects), P1c (message rows and stable keys), P1d (delete and retention) and P1e (loopback token). P1 was "In progress" for "Claude Code workflows" with no commit since 2026-11-07. This session took it over with the user's approval on 2026-11-17, and the G6 review recommended this split.

## Current checkpoint — P1a storage engine decision (2026-11-17)

Branch `ruslan/p1a-storage-decision`, stacked on P1's design PR (#37). It proposes revising ADR-003: stay on `node:sqlite`, use FTS5 when the running Node has it (Node 22.23.4 in CI does; 22.14 locally does not), and fall back to `instr` search with a named warning otherwise. No dependency is added. P1c builds message rows on `node:sqlite` either way; the FTS5 index is a follow-up once this is accepted.

## Current checkpoint — P1b projects (2026-11-17)

Card P1b on `ruslan/p1b-projects`, from `main` 3a17536. The P1 split (PR #37) is not on `main` yet, so this branch adds its own P1b board row. The eval, its results and five rounds of Codex review are in the P1b section of [the eval log](evals.md).

- **Schema version 2** (`src/migrate.mjs`): a `projects` table (`id`, unique `slug`, `name`, `created_at`), `sessions.project_id` and a `default` project that existing sessions join. The `sessions_project` trigger puts a session inserted without a project, including by an older build, in `default`. The steps follow the version 1 style: each checks the schema, is safe to repeat, and runs in one transaction.
- **Opening a file:** a current file opens with no lock and no DDL, and the version is read again before the store is returned. Otherwise the store takes `BEGIN IMMEDIATE`, reads the version again, refuses a newer one, creates the version 0 tables (`bootstrap`, which now includes `roomsSchema` from `src/rooms.mjs`), then migrates.
- **Store, API and CLI:** `importTranscript({ ..., project })` takes a slug (`^[a-z0-9]+(?:-[a-z0-9]+)*$`, at most 64 characters, default `default`) and creates the project on first use. Stored bytes keep their project and nothing is created. Summaries carry `project`. `list`, `listSessionsPage`, `GET /api/sessions?project=` and `ledger search --project` filter by it.

Next steps:

1. A human reviews the migration to version 2 (AGENTS.md section 4, step 4); the review of PR #8's migration to version 1 is also still owed.
2. When PR #37 lands, keep one P1b row on the board (this branch's or #37's) and set it from the PR state.
3. Not in this card: a project picker in the browser (it imports into `default`), a `project` filter on MCP `session_search`, a project list route, and moving sessions between projects. P1c (message rows) and P1d (delete and retention) build on `projects` and `sessions.project_id`.

## Current checkpoint — P1c message rows (2026-11-17)

Card P1c on `ruslan/p1c-message-rows`, stacked on P1b (PR #42, `ruslan/p1b-projects`). The eval, its results and the Codex review rounds are in the P1c section of [the eval log](evals.md). The storage engine decision (P1a) is still open, so this card stays on `node:sqlite` with no new dependency and no FTS5.

- **Schema version 3** (`src/migrate.mjs`): a `messages` table (`id`, `session_id` as a deferred foreign key with cascade, `seq`, `line`, `role`, `text_json`, `key`; unique per session on `key` and on `seq`). `text_json` is the turn's text as a JSON string literal, because `node:sqlite` loses a NUL and lone surrogates in plain text. The step reads each session's JSON messages once, as bytes, and copies them in order with `l:<line>` keys in one JavaScript pass. It fails and rolls back, with the file unchanged, when a stored value is not an array of messages (the error names the session and says what is wrong) or when the file already has a `messages` table or a `sessions_messages` trigger from elsewhere. The `sessions_messages` trigger gives a session inserted by a build from before schema versions its rows from its JSON.
- **Keys on import** (`src/store.mjs`): `u:<uuid>` for the first Claude record with a given UUID-shaped `uuid` (compared without case), otherwise `h:` plus 32 hex of `sha256(sessionId \0 line \0 raw line)`. The rows are written before the session in the same transaction.
- **Readers:** `get`, the line check in `publishGraph` and `getGraphContext` read rows. Each message in `GET /api/sessions/:id` carries `key`. MCP `session_read` output is unchanged.
- **Kept on purpose:** `sessions.messages` is still written, so builds from before versions keep working on the file. Sessions are read from rows; only the version 3 step and the trigger for older builds read the column. `search_text` still serves search. Session IDs and line citations are unchanged. Migrated sessions keep `l:` keys for good, while fresh imports of the same bytes get `u:` or `h:` keys (pinned by a test).
- **Independent review of PR #45 (2026-11-18):** five medium findings, handled in the P1c section of the eval log, followed by two Codex rounds on the fixes (three medium and four low, then one medium and two low, all fixed). The upgrade of a synthetic 2,000-session, 400,000-turn ledger went from 6.6 to 9.3 s down to 4.0 to 4.3 s. **Known limits:** above about 480,000 turns the upgrade still takes longer than the 5 s `busy_timeout`, so another process opening the ledger meanwhile can fail with `database is locked` (opening again works). The file also grows about 1.8 times on upgrade, because turn text is now stored three times. `evals/migration/v3-upgrade.mjs` repeats the measurement.

Next steps:

1. A human reviews the migration to version 3 (AGENTS.md section 4, step 4), together with the owed reviews of versions 1 and 2. Five rounds of Codex review are recorded in the eval log; the last found nothing above low.
2. Merge after PR #42; then retarget this PR to `main`.
3. Next card (add it to the board when PR #37 lands): `provider:uuid` session IDs. It rebuilds `sessions` (so it can drop `sessions.messages`, after a `VACUUM INTO` backup), links legacy sessions to their UUID sessions, and applies the design's rule for repeated UUIDs (skip identical bytes, refuse different ones). P1a then decides what replaces `search_text` (FTS5 over the decoded `messages.text_json`, using `messages.id` as its rowid, or a degraded `LIKE`). P2 can cite messages by `<sessionId>/<key>` from now on.

## Current checkpoint — P1d delete a session (2026-11-17)

Branch `ruslan/p1d-session-delete`, from `main` 3a17536. This is the first part of card P1d (Delete and retention, defined in PR #37's board). Results and both Codex review rounds are under "P1d — Delete a session" in [the eval log](evals.md).

What changed:

- `src/store.mjs`: `deleteSession(id)` deletes one session row (the whole transcript, title and search text). It is refused with a `ConflictError` (HTTP 409, with the graph count) while any graph cites the session, and refused when the database is in WAL mode. It runs in one `BEGIN IMMEDIATE` transaction with `secure_delete` on for that transaction only. No schema change. `publishGraph` now gives its usual 400 if another connection deleted the session mid-publish.
- `src/server.mjs`: `DELETE /api/sessions/:id`, exact same Origin required before the lookup (`requireSameOrigin`, also used by `readJson`).
- `src/cli.mjs`: `npm run ledger -- delete <session-id>`, fixed output only. A response body that is not JSON now gives a fixed message for every command.
- Browser: a Delete button on the open transcript, behind `window.confirm`.
- No MCP tool deletes anything, on purpose.

Next steps:

1. **A human review is needed before merge**: this card deletes user data (AGENTS.md section 4.4).
2. When PR #37 lands, its board rows and this branch's `P1d Delete a session` row sit next to each other: keep both, or fold this row into its P1d row.
3. The rest of P1d, after P1b's projects: delete a project, and purge by `retention_days`. The design's purge (section 6 of the architecture) also runs FTS `optimize`, `wal_checkpoint(TRUNCATE)`, `VACUUM` and backup deletion; this card runs none of them, so a deleted session's freed pages stay in the file (zeroed) until a `VACUUM`.
4. P1c (one row per message) must keep `deleteSession` complete: delete the message rows and their FTS rows too, with FTS `secure-delete` as the design sets it, and keep the bytes test in `tests/delete.test.mjs` passing.
5. Agents with a shell can run `ledger delete`. Only the MCP adapter is closed to them; P1e's token, or a later card, can decide whether the CLI should need a person.

## Current checkpoint — P1e loopback API token (2026-11-17)

ADR-10 is built on `ruslan/p1e-loopback-token`. **It needs a human security review before merge.** At each start the server writes `{ port, token }` (32 random bytes) to `<database>.<port>.token`, one file per port. It does this only after it holds the port and keeps only the digest. The file has mode 0600 on POSIX. On Windows it is created private from the start (owner and only ACL entry: the current user, through PowerShell), and clients refuse a file that others can read or that another account owns. Every route except the static files and `/login` then needs `Authorization: Bearer` or a session cookie, and answers 401 otherwise. The browser signs in through a one-time `/login?code=…` link (60 s, single use), printed at start or by `npm run ledger -- login`. The link sets an HttpOnly, SameSite=Strict cookie for 12 hours. The CLI, the MCP adapter, the handoff benchmark, the demo scripts and the latent evals read the file named by `CONTEXT_LEDGER_DB` and send the token only to the port it names. Tests read their temporary server's file (`tests/ledger-auth.mjs`). Playwright signs pages in through `tests/e2e/fixtures.mjs`. `.token` is now a secret suffix for the latent readers. The threat model, the results, three Codex rounds, the fixes for the independent review's two medium findings (Windows ACL, one token file per port; 2026-11-18) and Codex round 4 of those fixes are in the P1e section of [the eval log](evals.md).

Next steps:

1. Human security review of the PR. The open high finding: browsers send the cookie to every port on 127.0.0.1, so a page served by another local program can take a browser session. The reviewer either accepts this for now (the README warns about it) or asks for card P1f first.
2. P1f (Backlog): an origin-scoped browser credential, for example a secret kept in page storage and sent as a header, in place of or beside the cookie. It changes ADR-10, so P1's owner decides.
3. Known limits: same-user programs can read the token file. The folder is trusted: someone who can write to it can still swap or delete the file. A new data folder on Windows is not restricted, only the token file is. The server's default database is relative to its working folder, while clients default to the repository's. The latent runtime on 4320 has no token of its own. The independent review's low findings (L2–L7) are not addressed on this card. CI runs the Node suite only on Linux, so the Windows ACL tests run only locally (Codex round 4, low, open).
4. After a merge, MCP configs that set only `PORT` keep working when the ledger runs from the repository. A ledger started with another `CONTEXT_LEDGER_DB` needs the same absolute value in the MCP config.

## Current checkpoint — I2 tolerant JSONL parsing (2026-11-17)

Branch `ruslan/i2-tolerant-jsonl`. A transcript line that is not JSON no longer rejects the whole import. The parser skips it, and `POST /api/import` returns `skipped: { count, lines }` (the first ten line numbers) beside the session. The browser shows "Partially imported", with the counts. Messages keep their line numbers in the file, so citations stay true. A file with no readable line is still refused with `Invalid JSONL at line N.`

Next owner: the skip count is not stored, so a reopened session does not show it. Add it with P1's storage work. No schema change was made here.

## Current checkpoint — I1 large-file import (2026-11-17)

Branch `ruslan/i1-file-import`, stacked on I2 (#33). `npm run --silent ledger -- import --provider claude|codex <file.jsonl>` reads the file as a stream and writes the session into `CONTEXT_LEDGER_DB` (or the server's default) with the same ID and messages as a browser import of the same file. It works with or without the server running. Lines over 64 MiB are skipped and counted. More than 64 MiB of message text is refused, because a session is still one row. The browser names the command when a file is too large for it.

Next owner: when P1 stores one row per message, lift the 64 MiB message-text limit.

## Current checkpoint — D3 T3 Code thread importer (2026-11-17)

Branch `ruslan/d3-t3code-importer`, cut from `main`. `npm run ledger -- import-t3 <copy> [--thread <id>] [--list]` imports T3 Code threads from a copy of T3's `statev2.sqlite` that the person makes. It opens the copy read-only, never looks for T3's files, and posts each thread to the running ledger's `/api/import`, so the existing parser and store do the work.

- **Pinned layout.** T3 Code v0.1.10, commit `7d32075e3757ded707914e2450c3e392a9665765`, schema head 96, read from T3's public source only (no T3 install was used or run). The files read, the tables and the rules are in the D3 section of [the eval log](evals.md); the user guide is [docs/integrations/t3code-import.md](integrations/t3code-import.md). Any other migration history, table kind, column type or key is refused.
- **Mapping.** A thread maps to `claude` or `codex` by the `driver` of the provider threads its runs and attempts used (`claudeAgent`, `codex`). Other agents, mixed agents, unattributed answers, subagent threads and threads without runs (V1 copies) are refused, so the sessions table keeps its two providers. Message n in T3's order is line n.
- **Tests.** `tests/import-t3.test.mjs` builds the database at test time with `node:sqlite`; nothing `.sqlite` is committed. Codex reviewed twice; both rounds are recorded in the eval log.

Next steps:

1. Someone with T3 Code v0.1.10 checks the importer on a real copy with synthetic threads (eval "Still owed"). If T3 writes a column type or a migration history differently from its source, the importer refuses the copy; fix the pinned values from that copy's schema, not by loosening the check.
2. For a newer T3 release: read its migrations from 097 on for changes to the six tables, then add its manifest and head as a second pinned layout with its own test database. Do not accept a range of heads.
3. When PR #28 (D1 guide) merges, change its "Not built yet: an importer" bullet in `docs/integrations/t3code.md` to link to the import guide. The board row for D3 is on both branches; keep this branch's.
4. A third provider (for Cursor and other T3 agents) needs P1's schema change; until then they are refused.

## Current checkpoint — G7 quoted or inferred nodes (2026-11-17)

Branch `ruslan/g7-quoted-nodes`. When a graph is published, each node is marked quoted or inferred from the transcript lines it cites, with the floor the latent findings already use (`isGrounded` in `src/latent.mjs`). The eval and results are in the G7 section of [the eval log](evals.md).

- **Stored:** the graph payload gains `quotedNodeIds` and `inferredNodeIds` beside the other derived lists (`src/grounding.mjs`, `src/store.mjs`). The packet and its ID do not change, and there is no schema version change.
- **Graphs from before G7** have no marks, and every reader shows them as unmarked rather than inferred. Publishing the same packet again adds the marks to the existing row; its ID, row and creation time stay.
- **`context_for`:** an inferred node's citation ends `, inferred`, and the briefing says once what that means. A graph with only quoted nodes reads exactly as before, so its cached prefix does not change.
- **Browser:** the room view shows "quoted" or "inferred" beside each node's kind (`public/app.js`); the room API puts `grounding` on each node.
- **MCP paging:** the two lists are paged sections of `graph_read` and `graph_publish`, after the other derived lists, so a large graph's pages stay under the bound.

Next steps:

1. The console (U1, PR #22) reads a `grounding` field on nodes. Once both are merged, point its `nodeMark` at the graph's `quotedNodeIds` and `inferredNodeIds`.
2. The mark is a floor, like the latent check: a label that only shares one content word with its line is quoted. A stricter check (all content words, or an exact quote field on the node) would be a new card with its own eval.

## Current checkpoint — G9 scoped context with a budget (2026-11-17)

Branch `ruslan/g9-scoped-context`. `context_for` takes an optional `question` (up to 500 characters) and `budget` (50 to 100,000 estimated tokens, only with a question), and `GET /api/graphs/:id/context` takes the same two query parameters. The eval and results are in the G9 section of [the eval log](evals.md).

- `src/scope.mjs` ranks the nodes. Matches come first, by how many of the question's words they hold (label, ID, kind or addressee; four-letter prefixes, as in the latent check), then their one-edge neighbours. The budget keeps the largest prefix of that order whose briefing fits the estimate, so neighbours go first.
- The scoped graph keeps only edges between shown nodes, links from shown nodes and state lists of shown nodes, and is rendered by the same `contextText`. Its last line says what was matched, shown and left out, without repeating the question.
- With no question, the briefing is byte for byte what it was.
- The MCP adapter caches a paged scoped briefing under the graph ID, question and budget, and its continuation note says to repeat both.

Next steps:

1. Measure the benefit on the G10 handoff benchmark: the same graded facts with a scoped briefing and a budget, against the whole briefing.
2. Matching is by words, so a question that uses other words than the labels finds nothing and says so. Embeddings would be a new card with an ADR, because they need a dependency.

## Current checkpoint — G8 one-command agent setup (2026-11-17)

Branch `ruslan/g8-agent-install`. `npm run ledger -- install` and `uninstall` (`src/install.mjs`, wired in `src/cli.mjs`) register the MCP server with Claude Code and Codex at user scope through their own CLIs, and add or remove a short marked block in `~/.claude/CLAUDE.md` and `$CODEX_HOME/AGENTS.md`. The eval and results are in the G8 section of [the eval log](evals.md).

- Every change is printed; `--dry-run` changes nothing and runs only `mcp get`.
- Uninstall removes the blocks but not the server registrations: it prints `claude mcp remove --scope user context-ledger` and `codex mcp remove context-ledger` for the person to run. Neither CLI shows a user-scope entry exactly enough to prove that it is the one install made (three Codex review rounds; see the eval log).
- Install never asks Claude with `mcp get`, which can start project servers; Claude's `add` refuses a duplicate itself. Codex's `add` replaces, so install asks `codex mcp get --json` first. A failed server step leaves the instruction file alone. The CLIs run from the home folder.
- Files are read as bytes. A UTF-16 BOM, NUL bytes, invalid UTF-8, unmatched markers and an edited block are refused before any CLI call. BOMs, symbolic links and file modes are kept. Install then uninstall gives back a file's bytes, except a final line break the file did not have.
- The CLI is found on `PATH` by the module itself, because `cmd.exe` gives a missing command the same exit status as a failing one. On Windows a `.cmd` shim runs through `cmd.exe` with every argument quoted; an argument with `"` or `%` is refused.
- Tests use a fake home and stub CLIs only (`tests/install.test.mjs`). A read-only `--dry-run` against the real CLIs on Windows found `claude.exe` and `codex.cmd`, both already registered.

Next steps:

1. A person runs `install` once against their real agents, on Windows and on macOS or Linux, and checks that `claude mcp list` and `codex mcp list` show the server. Then `uninstall`, and the two printed remove commands. The tests only use stubs.
2. U3 (the demo video) was waiting for G8 and can start once this is merged.

## Current checkpoint — G11 graph diff between snapshots (2026-11-17)

Branch `ruslan/g11-graph-diff`. `GET /api/graphs/:id/diff?from=:otherId` and the MCP tool `graph_diff` say what changed from an older snapshot of one party's graph to a newer one. The eval and results are in the G11 section of [the eval log](evals.md).

- `src/diff.mjs` compares the canonical packets. It reports nodes added, removed and changed (each changed field with its old and new value), decisions newly superseded, questions answered or opened, ready actions gained or lost, and edges and links added or removed. Both graphs must be version 2 graphs of the same party.
- `graph_diff` pages a long diff by item, like `graph_read`.
- A room now carries `newerGraphs`: for each party whose newest graph is not the room's, the newer graph's ID and change counts. The room view says so, lists up to 12 changed labels, and offers a button that fills the form with the newer graph. The person still opens the new room, as before.

Next steps:

1. Party names are self-asserted. A newer graph from another transcript under the same party name is shown, marked unverified and without the form button. Lineage across transcripts needs P1's projects.
2. The console (U1, #22) could flash only the changed nodes, using the diff instead of its own comparison.

## Current checkpoint — H8 model calls keep to the read deadline (2026-11-18)

Branch `ruslan/h8-model-call-deadline`, from `main`. Each model call in `runtime/latent_pool/vllm_client.py` now keeps to its whole budget, not a timeout per socket read. One absolute deadline covers the call and its folded retry. A timer shuts the call's socket down at the deadline: the plain socket before it connects, and the TLS socket before its handshake. The name lookup is bounded, redirects are not followed, and every step checks the clock. A connect timeout capped by the deadline now returns 504, not 503, and `_Run.call` returns 504 for a reply or a 503 that lands after the read deadline. Codex reviewed it twice; every finding is fixed with a test (docs/evals.md, H8).

Next owner: nothing is open on this card beyond review. Known limits are listed under H8 in docs/evals.md. Addresses are still tried one after another, and an abandoned lookup finishes on its own thread.

## Current checkpoint — D1 T3 Code integration (2026-11-17)

Branch `ruslan/d1-t3code-guide`. [docs/integrations/t3code.md](integrations/t3code.md) explains how T3 Code's Claude and Codex threads get the ledger: T3 runs those CLIs with their own configuration, so the server is registered for them on the environment's machine. Instances with their own `CLAUDE_CONFIG_DIR` or `CODEX_HOME` need it there too. `tests/integrations-t3.test.mjs` keeps the guide's commands and links in step with the code.

The importer half of the card was not built. T3's store is undocumented, and its layout differs between versions (see the D1 eval). It is the new Backlog card D3, blocked on a sample database of a known T3 version.

Next steps:

1. Someone who runs T3 follows the guide and records the result in the D1 eval section, including whether T3's runs write Claude Code and Codex session files that can be imported.
2. D3, once a sample T3 database exists.

## Current checkpoint — D2 Capy integration guide (2026-11-17)

Branch `ruslan/d2-capy-guide`. [docs/integrations/capy.md](integrations/capy.md) explains how to add the ledger to Capy as a local (STDIO) MCP server. It works only for threads that run on the computer that runs the ledger, through Capy's desktop app or Dock CLI, because the ledger answers on loopback and Capy runs STDIO servers on the thread's machine. The owner is "Only you", because an Organization server would fail on other members' computers and on cloud machines. `tests/integrations.test.mjs` keeps the guide's key, path, README link and TOML block in step with the code.

Next steps:

1. Someone with a Capy organization follows the guide once and records the result in the D2 eval section, including whether a device thread finds `node` on its `PATH`.
2. If Capy threads should use the ledger from the cloud, that needs a design decision first: the ledger would then hold transcripts on Capy's machines.

## Current checkpoint — P4a signed hand-off (2026-11-17)

First slice of P4, after ADR-9 of the design (`origin/ruslan/p1-design`): `ledger keygen` makes an Ed25519 key beside the ledger database; `ledger handoff <id> --sign <new-folder>` writes `handoff.md`, `public-key.pem`, an RFC 8785 canonical `manifest.json` (file name, size and SHA-256) and the raw signature `manifest.sig`; `ledger verify <folder> [--fingerprint]` checks all of it and exits 0 only on a full match. Code: `src/sign.mjs` and `src/cli.mjs`; tests: `tests/sign.test.mjs`; client guide with the OpenSSL-only recipe: `docs/signed-handoff.md`. Eval and three Codex review rounds: P4a in `docs/evals.md`.

Update 2026-11-18, after an independent security review (no high, three medium, seven low) and a fourth Codex round on the fixes (all in the P4a section of `docs/evals.md`):

- On Windows, `keygen` stages the key inside a folder restricted to the current account and gives the key file a protected access list that grants only that account (`icacls`, run without a shell, by SID). Signing refuses a key whose list allows any other account than the user, SYSTEM and Administrators, a key file that is a link, and one replaced while it is checked. POSIX is unchanged.
- `handoff --sign` reads the session from the ledger database in process (design ADR-2) and makes no HTTP request, so a process on `PORT` can no longer get content signed. It never creates or migrates the database: an older-schema file is refused with a sentence that says to start the server once. Plain `handoff` and `search` still use the server.
- Not changed, for the user to decide: `verify` without `--fingerprint` still exits 0 with a stderr warning. The proposal (a required flag, or a distinct exit code with `Unverified signer` on stdout) is in the eval and the PR body.

Next steps:

1. **A human security review before merge** (AGENTS.md section 4). Points to decide: the fingerprint is SHA-256 of the SPKI DER bytes (not of the raw key), for an OpenSSL-only recipe; the private key is unencrypted PKCS#8, 0600 on POSIX and restricted to the account on Windows; the `verify` exit-code proposal above; the seven low findings of the security review, which are left open (among them no owner check of the key file on either system, which Codex round 4 also raised); concurrent writers and NTFS alternate data streams are out of scope (documented).
2. P4b (Backlog): the secret scanner, the redaction diff, allowlist export from cleared excerpts (ADR-8) and the passphrase-encrypted key. Signing today does not redact anything.
3. Version 1 bundles hold exactly one content file. A redaction report or other extra file needs manifest version 2.

## Current checkpoint — P4b secret scanner and redaction diff (2026-11-17)

*Superseded on 2026-11-18: P4b was narrowed to key formats; see the next checkpoint. The bearer and password rules described here were removed.*

Branch `ruslan/p4b-secret-scanner`. `src/secrets.mjs` finds text that looks like a credential: cloud, GitHub, model-provider, Slack and Stripe keys, JWTs, private keys, bearer tokens, and secret-looking values under names such as `password` or `api_key`. It redacts each one as `[REDACTED <kind>]`.

`npm run ledger -- redact <session-id> [--json | --text]` reports line, kind, length and a known public prefix, never a value; `--text` prints the redacted hand-off. `ledger handoff`, the store, the browser and MCP are unchanged.

Next owner: P4a can call `redactSession` before signing an export. The scanner is a heuristic. Codex ran four rounds and every finding is fixed, but round 4's fixes are not reviewed again, and a human security review is still owed.

## Current checkpoint — P4b narrowed to key formats (2026-11-18)

PR #47 now detects only well-defined key formats (provider keys, JWTs, PEM private keys, AWS secret access keys). The free-text `bearer-token` and `assigned-secret` rules were removed at the user's choice after seven Codex rounds kept finding gaps; that work is card P4c. A human security review is still required before merge.

## Current checkpoint — P4c free-text secret detection (2026-11-18)

Branch `ruslan/p4c-free-text-secrets`, stacked on P4b (#47). After an `Authorization: Bearer` header, or a secret-like name followed by `:` or `=`, the rest of that line is redacted, unless the whole value is a placeholder. On the corpus this misses nothing and flags 2 of 23 benign keyed lines (8.7%). Codex reviewed it twice; every finding is fixed with a test (docs/evals.md).

Next owner: the budget (zero misses, at most 10% false alarms) and the line-tail approach are proposals. The user approves them before the PR leaves draft.

## Current checkpoint — cycle 15 (teams of many agents, split facts, 2026-11-16)

Branch `ruslan/agent-scale`. Card C15. Read the cycle 15 definition, results and changes from the plan in [the eval log](evals.md). Qwen2.5-3B-Instruct, no training, GSM8K block 4.

- **Scale (part 1).** Tests 1–4 are all established: latent_mas beats random thoughts at 3, 11, 31 and 101 agents. This happens because random thoughts break the model (0.425 at 3 agents, 0 at 101), not because real thoughts help. The latent team never beats one model alone and gets worse as it grows: 0.81 at 3 agents, 0.66 at 101 (single 0.86 on the same 50 questions, 0 / 10, p = 0.002). A vote of N samples gets better instead (0.85 to 0.94).
- **Cost.** At 3 and 11 agents the latent team matched the text team's accuracy with 58% and 75% fewer forward steps and 2.4 and 3.3 times less time. Time per question then grows fast: 224 s at 101 agents.
- **Split facts (part 2).** Tests 5–8 are not established. With earlier prompts hidden (sealed), the latent team answers 0 and 1 of 166 questions, the same as the Solver with only the ask. Text notes pass the facts (0.30 and 0.28).
- **Changes from the plan:** 31 agents ran at batch 4 after batch 8 ran out of GPU memory; 101 agents ran at batch 1 on the first 50 of the 200 questions, agreed with the user on 2026-11-14.
- **New code:** `runtime/latent_team/scale.py` (the runner for both parts) and, in `team.py`, `chain_roles(N)`, the sealed mode (`hide`), the N-agent text team and grouped sampling for the vote. The three-agent path is unchanged. Run outputs hold GSM8K text and are not committed.

Next steps:

1. A human reviews the sealed mode in `team.py` (`forward(..., hide=...)`, `chain(..., sealed=True)`). The Codex code review and data check are recorded in the eval log.
2. On this evidence, the latent hand-off between untrained agents does not carry facts, and adding agents costs accuracy. Any further latent work should first show a sealed hand-off above the floor on the split-facts set, for example with a trained hand-off, before more scale runs.

## Current checkpoint — P5b install passes the database path (2026-11-20)

PR #57, branch `claude/p5b-install-db`. `ledger install` passes `CONTEXT_LEDGER_DB` (absolute) to both agents' MCP servers beside `PORT`, so agents find the P1e token of a ledger on a custom database. Read the P5b section of [the eval log](evals.md).

- Dry run and install refuse alike a path cmd.exe cannot take (`%`, `"`) on Windows; uninstall ignores the value.
- **Next owner:** a person checks one real install with a custom database against Claude Code and Codex (the tests use stub CLIs). Users who ran install before this card must remove the old registration and install again; the README says how.

## Current checkpoint — P5a Node suites on three systems (2026-11-20)

PR #38, branch `ruslan/p5a-cross-os-ci`. The Node suites, the graph suite and the browser evals run on `ubuntu-latest`, `windows-latest` and `macos-latest`, one job each. Read the P5a section of [the eval log](evals.md).

- **Why Windows hung.** GitHub's Windows runners run as `runneradmin`, the built-in Administrator (RID 500). SDDL spells that SID `LA`, so the P1e token check (`privateToOwner` in `src/token.mjs`) and the P4a key check (`daclAllowsOnly` in `src/sign.mjs`) refused every file they had just made private, every server start failed, and one routes test then waited forever on a child that had exited. A one-off diagnostic job confirmed the spelling (`O:LA…D:P(A;;FA;;;LA)`).
- **Fix.** Both checks ask PowerShell how SDDL spells the current account (from a descriptor built in memory from the SID; the key check falls back to the SID if PowerShell refuses) and accept that spelling like the SID. The test helper `restrictToOwner` writes one owner-only descriptor, since an elevated administrator's new files carry explicit default entries and belong to Administrators. Waits on server children fail when the child exits, the test MCP client waits 45 s for the slow first call, and CI runs `node --test` with a five-minute limit per file.
- **Review:** five Codex rounds, each finding fixed or recorded in the P5a section of the eval log.
- **Next owner:** nothing open on this card. If a new Windows-only failure shows up in CI and not locally, suspect the runner account first: it is an elevated administrator, unlike most developer machines.

## Current checkpoint — P2a project scope (2026-11-21)

PR #58, branch `claude/p2a-project-scope`. P2 is split into P2a–P2c on the board; the user's wave 2 decisions are ADR-7a to 7d in [the architecture](architecture.md) §12. Read the P2a section of [the eval log](evals.md).

- A graph's project is the project of the session it cites. Links and rooms across projects are refused; a session with no project matches nothing.
- Graph and room list rows name the project, and the HTTP lists and MCP `session_search`, `graph_list` and `room_list` take `project`. The MCP tools refuse rows a ledger from before P2a did not filter.
- A room opened across projects before P2a stays readable but takes no choices (`takesChoices: false`); the browser shows its choices without buttons.
- **Next owner:** P2b (version 3 citations) is stacked on this branch; P2c follows it.

## Current checkpoint — P2b message-key and artifact citations (2026-11-21)

PR #59, branch `claude/p2b-citations`. Read the P2b section of [the eval log](evals.md) and ADR-7b in [the architecture](architecture.md) §12.

- Packet version 3 cites `{ message: <P1c key> }` or `{ artifact: <id> }`; versions 1 and 2 are unchanged. The stored graph adds `citations` (lines and artifact rows per node), which every reader uses.
- Artifacts (commit, pull request, file) are registered per project with `ledger artifact add|list` or `/api/artifacts`; schema version 4.
- `graph_schema` defaults to version 3, and `session_read` shows each turn's key.
- Citations compare with their session (lines and keys) in the diff and the console; artifacts compare as they are.
- **Next owner:** P2c (node-hash approval) is stacked on this branch.

## Current checkpoint — P5c `npx` entry point (2026-11-21)

Branch `claude/p5c-npx-entry`. Read the P5c section of [the eval log](evals.md).

- `bin/context-ledger.mjs`: `context-ledger start`, `context-ledger mcp`, and every `ledger` subcommand. Under the bin an unset `CONTEXT_LEDGER_DB` is `~/.context-ledger/ledger.sqlite` (USERPROFILE on Windows); a checkout's `npm start` keeps its own default.
- `package.json` is publishable: no `private`, a `files` allowlist, MIT, repository and engines. The name `context-ledger` is taken on npm by an unrelated package, so the package is `@pricepepel/context-ledger` (publish with `--access public`); the command stays `context-ledger`. Nobody has run `npm publish`: that is the user's step.
- Run through `npx`, `install` registers `npx -y --package <spec> context-ledger mcp` (through `cmd /c` on Windows). A bare `npx -y <tarball>` runs nothing for a local tarball, so use the `--package` form.
- **Next owner:** P5d (clean-install CI job on three systems) and P5e (launch docs).

## Current checkpoint — P2c approval bound to a node hash (2026-11-21)

Branch `claude/p2c-node-approval`. Read the P2c section of [the eval log](evals.md) and ADR-7c ("in practice") in [the architecture](architecture.md) §12.

- Each version 3 node has a `nodeSha256` (JCS of kind, label, status, to and evidence). Decisions are rows keyed by session, party, node ID and hash (schema version 5), so a republish keeps unchanged nodes' decisions.
- People decide in the browser's **Review** section; the route needs the browser's sign-in cookie and `Sec-Fetch-Site`. It is an interface boundary: whoever holds the token can mint a sign-in link.
- **Next owner:** P3 turns these rows into hash-chained events (ADR-6) and adds edit. Ali's prototype (#52) keeps its decisions in browser storage; when it moves to the server, it can call this route.

## Current checkpoint — P5d clean-install eval (2026-11-21)

PR #62, branch `claude/p5d-clean-install`. The Clean install workflow packs the checkout, installs the tarball globally into an empty prefix on Linux, Windows and macOS, and drives the installed `context-ledger` command from an empty folder and home: usage, start, import, search, graph publish and read, login and the MCP adapter. Run it locally with `node scripts/clean-install-check.mjs`. The script is not in the package.

## Current checkpoint — P5e launch docs (2026-11-21)

Branch `claude/p5e-launch-docs`. The README opens with **Install**: a global install from GitHub today and by name once the user publishes `@pricepepel/context-ledger` (with `--access public`), `npx` for one-off commands, first run, data in `~/.context-ledger`, connecting agents, upgrading and removing, and what this release leaves out. `tests/launch-docs.test.mjs` runs the commands the section shows. **Next owner:** the user publishes the package. With P5a–P5e merged, what is left of P5 is the license key (ADR-13), the user's product decision.

## Current checkpoint — S1 swarm demo (2026-11-21)

Branch `claude/swarm-demo`. Read the S1 section of [the eval log](evals.md) and [the run sheet](swarm-demo.md). `/swarm/` runs up to 200 agents at once on local OpenAI-compatible model servers (`SWARM_URLS`, loopback only), shows each agent live, checks each quote against its report, and combines verified answers beside the generator's truth. A seeded simulation, labelled on every number, runs without a GPU.

- **Next owner:** run it live on the laptop GPU once the M2b-S training (branch `claude/m2b-scale`) frees it: one 7B server, then two models. Record wall time, tokens per second, KV-cache use and prefix-cache hit rate at 25, 50 and 100 agents in the eval log.
- Then add the latent lane: a second pass where agents hand a compacted cache instead of text, once M2b-S and Attention Matching pass.

## Current checkpoint — G9b scoped briefing says what it left out (2026-11-21)

Branch `claude/g9b-scoped-state`. Read the G9b section of [the eval log](evals.md). Found while rehearsing the investor demo from a clean install: a `context_for` briefing scoped to a question said `open questions: none` when the graph had an open question the question did not match, and a live agent told Ali that Leo needed nothing from him.

- Each state list in a scoped briefing names the shown items, then counts the rest (`1 left out`, `port; 1 more left out`). The scope line ends with `call context_for without a question for the whole graph` whenever a node is not shown. Unscoped briefings are unchanged.
- A budget now tries the full briefing first, since the hint makes a cut briefing longer.
- Live re-run: 3 of 3 runs no longer say Leo needs nothing.
- **Next owner:** in every live run the agent's first `context_for` call passed `budget` without `question` and was refused. Consider accepting a budget alone (cut the whole briefing), as a separate card.

## Current checkpoint — I3 on P1c message rows (2026-11-21)

PR #34 (`ruslan/i3-codex-agent-messages`) now merges main. Codex messages between agents import as `agent` rows with `author_json` and `recipient_json` columns (JSON string literals), added by schema version 6 (ADR-16 in docs/architecture.md). Encrypted content is never stored. A Codex file imported before I3 gains its agent turns when it is imported again, and every earlier turn keeps its key. Builds from before versions see only user and assistant turns in `sessions.messages`.

Next owner: any later schema step goes after version 6. If the `messages` table is rebuilt again, recreate the `sessions_messages` trigger.

## Current checkpoint — P3 review events (2026-11-21)

PR #67, branch `ruslan/p3-review-events`, merged after I3 (#34) on 2026-11-22; its schema step is version 7. Review decisions are append-only, hash-chained events in `review_events` (ADR-17). The browser review section has Approve, Edit and Reject, and `ledger reviews verify` checks the chain. P2c's rows are migrated.

Next owner: P3b puts the chain's head in the signed hand-off manifest. Ali's P3 prototype (#52) keeps its own decisions in browser storage. Wiring it to `POST /api/graphs/<id>/reviews` is a choice for Ali.

## Current checkpoint — P3b review head in signed hand-offs (2026-11-22)

PR #70, branch `ruslan/p3b-review-head`. `ledger handoff --sign` writes manifest version 2, with the review chain's count and head (ADR-18). `ledger verify` shows them, and `ledger reviews verify --bundle <folder>` checks a ledger against them. Version 1 bundles still verify. docs/signed-handoff.md describes version 2 and the new check.

Next owner: a later manifest version that adds files (P4b's redaction report, say) goes to version 3 and keeps `reviews`.

## Current checkpoint — watchdog design for the latent team (2026-11-21)

Docs only, written on `ruslan/console-direction` (commit a467e6f) and brought onto `main` with W1. Cards W1 to W3 are on the board as Backlog; nobody has claimed them.

- [The watchdog design](watchdog-security.md), version 2: one code watchdog per squad of up to 5 latent subagents and one code supervisor per run. It separates what holds by construction, what an exact check verifies, what is only a statistical check, and what is not covered, for four promises: honest hand-offs, hallucination, unnecessary actions, sensitive data.
- [The research report](watchdog-research.md) behind it: about 95 sources, with the verification status of each group stated at the end.
- The main design decisions are listed under "Decisions taken" in the design. The one that touches the runtime: production squads use soft thoughts with no adapter, because only then is every thought an exact, recorded mix of tokens.
- No code and no evals in `docs/evals.md` yet. The evals are drafted in the design and move to the eval log when a card is claimed.

Next steps:

1. Leo and Ali read the design, in particular open question 3 (soft thoughts only).
2. Claim W1 first. Its first results are new numbers on our own runs: how often a replay matches, how often team and solver agree, and how often the squad changes the answer at all.
3. W2 is required before the latent team is given real project files or tools.

## Current checkpoint — W1 latent team watchdogs: integrity and audits (2026-11-22)

Branch `claude/w1-watchdog-integrity-82aa3b`, PR #73 (to `main`, which it also brings the watchdog design to: the cherry-picked commit a467e6f from `ruslan/console-direction`). Card W1, built by Claude Code for Ruslan. The design is [watchdog-security.md](watchdog-security.md); evals, results and three review rounds are in the W1 section of [the eval log](evals.md).

- **What it is.** One code watchdog per squad (`runtime/latent_team/watchdog.py`): hooks on the model's base see every input and hidden state, the watchdog derives each soft thought's record (16 token ids and weights) itself, and seven exact checks run per question: turn structure against its own plan, configuration (soft, no adapter, no LoRA, weights unchanged and pinned), legibility, span ledger with mask and position checks, a keyed per-row memory checksum at every hand-off, numbers, and budgets. Two statistical scores (degenerate record, relative Mahalanobis distance) are measured, not trusted. Reports are number-only and HMAC-signed (`reports.py`); the supervisor (`supervisor.py`) decides by the fail-closed table; the guard (`guard.py`) runs sampled audits (replay, mismatched memory, solver alone) and the fallback; both service routes go through it, and a hold is HTTP 409 with no answer.
- **Threshold set.** `runtime/latent_team/thresholds/qwen2.5-3b-instruct-soft-m40.json`: quantiles only, pinned to the weights hash. The distance reference statistics stay on the GPU machine (`~/w1/out/reference.pt`); the service uses them only when `LATENT_WATCH_REFERENCE` points at a file whose SHA-256 the threshold set names. Without it, releases are marked `unscreened`.
- **Measured** on block 1 of GSM8K test (200 questions; details in the eval log, "W1 results"): no exact-check failure on clean runs; replay matched on 100% (answer, every top token, memory bitwise equal at every hand-off), so replay stays an exact check; team and solver alone agree on 81.5% (the squad changed the answer on 18.5%); another question's memory changed the answer on 20%; the statistical scores' false alarms were 2.0% (degenerate), 0.5% (distance) and 2.5% (supervisor rule), and they are no signal of a wrong answer (AUROC 0.38 and 0.62); all 19 injected faults were caught on 64 of 64 questions by the check named for each; the watchdog's checks cost 2.2% of median wall time, and audits at 1 in 20 plus every flagged run about 18% more on average.

Next steps:

1. **A human security review** of the PR before merge (watchdog, signatures, fail-closed routes).
2. Leo and Ali: confirm "soft thoughts only" as the production rule (design decision 9).
3. W2 (data gateway) is stacked on this branch; W3 (calibrated abstention) on W2.
4. Not covered, by design and stated in the code: a change made in place in the middle of a turn, and a rewrite of the answer text after decoding (both need code inside the trusted runtime); interrupting a model call that stalls needs a timeout outside the process.

## Current checkpoint — W2 data gateway for latent teams (2026-11-22)

Branch `claude/w2-data-gateway`, PR #71, stacked on W1 (PR #73); it targets `claude/w1-watchdog-integrity-82aa3b` until W1 merges, then `main`. Card W2, built by Claude Code for Ruslan. Evals, results and the review rounds are in the W2 section of [the eval log](evals.md).

- **What it is.** `runtime/latent_team/gateway.py`: labels by origin, need to know (only the request unless a span is named; secret paths refused), placeholders for declared secrets, scanner findings and every other occurrence of those values (128-bit run nonce; the gateway verifies the text the model will read and refuses it if a known value survives), one label for the whole memory, permissions fixed before data, the rule of two, a tool gate on the arguments as sent, and an output gate that redacts and verifies what leaves. Known values and findings are matched in canonical forms too (escapes decoded, invisible characters read as a space or dropped, the same in Python and Node, with shared cases in `rules/canonical-cases.json`), and the prompt, the fitted question and the answer are scanned again after every substitution. Both routes use it: `/latent/team`'s question is the caller's request, the chat route is untrusted as a whole. `secrets` (declared values) are accepted on both routes and through the ledger's HTTP API, `clearance` on `/latent/team`; the ledger's MCP tool does not take them, to keep the tool list within its size budget (`tests/paging.test.mjs`).
- **One set of secret rules.** `rules/secret-rules.json` is read by `src/secrets.mjs` and by `runtime/latent_team/secret_scan.py`; `rules/secret-conformance.json` (63 cases, rebuilt with `node scripts/make-secret-conformance.mjs .` from the ledger's scanner) is run by both suites. Change a rule in the JSON, rebuild the cases, and both suites must pass.
- **Measured.** The scanner finds 100% of the known formats on the synthetic set, with 0% false alarms when look-alikes end their line and 12–14% when prose follows on the line; a canary in no known format is found 0% of the time, which is why declarations matter.

Next steps:

1. **A human security review** before merge (sensitive-data handling, the shared scanner). Twenty-five Codex rounds each found up to two more ways a copy of a secret can change between the gateway and a reader; each is fixed and tested, but the family is open, and a 26th round was refused by the provider's safety filter. Look first at that boundary: any new path that transforms the prompt or the answer after the gateway must be checked against the canonical forms and rescanned.
2. When the latent team gets file input or tools, give each file its own span (origin `file`, a path, a sensitivity from the project's settings) and name the spans the task needs; declare tools with their argument rules and clearance in `Permissions` before admitting anything. A step that calls a tool with outside effect still has to run in text (design decision 3); that is not built.
3. Not covered, and said in the code: a fragment of a secret value, and writes by native code outside the run's folders.

## Current checkpoint — W3 calibrated abstention (2026-11-22)

Branch `claude/w3-calibrated-abstention`, PR #77, stacked on W2 (PR #71); it targets `claude/w2-data-gateway` until W2 merges. Card W3, built by Claude Code for Ruslan. The design is [watchdog-security.md](watchdog-security.md); the pre-registered rules, seven review rounds and the results are in the W3 section of [the eval log](evals.md).

- **What it is.**
  - `runtime/latent_team/confidence.py` scores a released answer by the log-probability of its graded number.
  - `abstain.py` holds the math (learn then test over a grid of 20, Bonferroni, one-sided Clopper-Pearson, a 10% ceiling) and the calibration loader.
  - The calibration is bound to the weights, the policy, the plan, the run and the service profile; `request-public` is the only profile measured.
  - Supervisor row 5 abstains below the threshold. An abstention returns no answer: `{mode: "abstained"}` on `/latent/team`, a fixed sentence on chat.
  - `abstain_eval.py` is the certification driver: single requests through `TeamService`, named runs, shard ownership, barriers between parts, and the worst case for holds.
  - `safety_eval.py` is eval 14 (counts only).
- **Measured** (run `w3-run10`, one job, plan `today`, 418 requests):
  - **Eval 11 fails.** 42 of the 57 finite proposal scores were tied at exactly 0, so only 7 distinct cutoffs were tested, and none certified. The strictest released 149 of 200 certification answers with 18 wrong (bound 21.3% against 10%; at most 5 errors would have passed).
  - This run therefore wrote no calibration file, and the repository has none. A `/latent/team` request with `task` set behaves as before W3: the watchdog and supervisor decide first and can still hold it, and an answer they would release is released marked uncalibrated.
  - Eval 12 was skipped and eval 13 not run.
  - **Eval 14** (JBB-Behaviors), counting replies the fixed keyword rule classifies as refusals. Both systems got the same instruction.
    - Harmful requests: 24 of 100 for the team, against 67 for the model alone. 76 of the team's replies are classified as answers. Paired by request, 46 were refused only by the model alone and 3 only by the team.
    - Benign requests: 0 refusals for the team, against 11.
    - Under that rule, the team's refusal rate fell on both sets. The rule is rough, and nobody read the replies.
  - Median request time: 20 s for one job alone in run 10, against 113 s per request in run 9's two shards. The runs differ in more than the shard count.

Next steps:

1. **A human review** of the PR before merge (security-relevant: the abstention path and the calibration loader). Do not merge it as a working ceiling: the code is the mechanism, and the measurement says the current score cannot certify one.
2. **Eval 14 matters more than eval 11.** Under the keyword rule, 76 of the team's 100 replies to harmful requests are answers, against 33 for the model alone. Before the team serves anyone, decide whether refusals need their own check: a text-mode pass, a refusal check on the solver alone, or holding requests the solver alone refuses. Measure it with a better judge than keywords. This is Backlog card W3b.
3. To try abstention again, use a score that does not tie at 0 on most answers, for example a token margin or a probe. The pre-registered exploratory scores were defined on the batched run, which never finished, so compute candidates on proposal rows first. Any new score needs its own pre-registered certification on fresh rows. This is Backlog card W3c.
4. The run's aggregate files are on the GPU machine (`~/w3/out10/summary.json`, `~/w3/safety10/safety.json`). The certification rows are there too; they hold no text, but they stay off the repository.
