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


## Current checkpoint — cycle 8 (S1, Claude Code subagents through graphs, 2026-11-09)

Branch `vuek0/subagent-graphs`, card S1 on [the delivery board](delivery-board.md), evals in the cycle 8 section of [the eval log](evals.md).

Done in stage 1:

- `src/launcher.mjs` and `GET /api/health`: the MCP adapter starts a ledger on demand, detached, with data in `~/.context-ledger/`, a log and a pid file. `CONTEXT_LEDGER_AUTOSTART=0` turns it off. Test clients default to off.
- `evals/subagent/run.mjs`: the parent-to-subagent handoff eval, with an exploratory baseline recorded before any S1 code.

Next:

1. Stage 2: import the current Claude Code session through a user-installed hook (`~/.claude/projects` only, above the 8 MiB HTTP limit) and a `current_session` tool.
2. Stage 3: quote evidence, then a handoff skill and a `ledger-reader` subagent for the parent agent.
3. An independent review before the PR. Codex is not installed on this machine, so use a separate Claude reviewer and a human.
