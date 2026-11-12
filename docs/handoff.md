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


## Current checkpoint — cycle 10 (bounded MCP results and discovery, 2026-11-11)

Branch `ruslan/mcp-paging-discovery`, from `origin/main` 19f6522. Cycle 8 lives on `vuek0/subagent-graphs` and cycle 9 on PR #7. Read the cycle 10 definition and results in [the eval log](evals.md).

- Every MCP tool result is at most 40,000 escaped characters (`maxResultCharacters` in `src/paging.mjs`), measured by `resultSize`: an ASCII letter or whitespace counts 1, other ASCII (digits, punctuation) 2, any other UTF-16 unit 4, so code, JSON and Han-script pages stay near the token count of 40,000 characters of English. A longer result comes in pages: JSON with `more` as its first key, or text whose first line is `[Partial result: ...]` and whose last line repeats that note, which names the arguments to send next. A result that fits is byte-identical to before. `callTool` withholds any oversized result as a bug.
- New tools `graph_list` and `room_list`, over the new `GET /api/graphs` and `GET /api/rooms`. `GET /api/sessions` pages only when it is given `limit` or `after`. `POST /api/latent/files` serves later pages of a latent text fallback without the model.
- `src/migrate.mjs` gives the SQLite file a schema version (`user_version` 1). It adds `created_at` and `party` to graphs and `created_at` to rooms, with indexes, and two triggers that stamp new rows from any insert path. Recreate the triggers if those tables are ever rebuilt. A file with a newer version is refused.
- Merging `vuek0/subagent-graphs`: it also edits `src/mcp.mjs`, `src/store.mjs` and `src/server.mjs`. The new tools come last in the tools Map, and the new routes are separate blocks. If that branch needs a schema change, add it to `migrate.mjs` as version 2, with steps that check the schema the way version 1 does. The paging helpers sit between `requireHex` and `text`, away from where that branch adds `currentTranscript`. In `context_for`, put its quota note into the `after` items, which count against the bound. Later pages come from the briefing that page 1 fetched in this process (`pagedBriefings`), so a read-through fetches `/context` once and counts as one handoff. That branch adds `handoff_publish` (1,881 characters of tools/list); the tools/list budget test in `tests/paging.test.mjs` counts only the 13 tools of this cycle by name, so it passes after the merge, but `tests/mcp.test.mjs` pins the tool names and needs the new one added.
- session_search without `limit` returns every match that fits, as on 19f6522; it reads ledger pages of 100 until the rows pass the bound. With `limit` it pages by that.

Next steps: an independent review, a debug pass, and the live evals (Codex sentinel, fresh-session discovery, demo rehearsal). Then push, and run Linux CI.
