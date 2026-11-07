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

## Current checkpoint — cycle 5 (Ali's benchmark and pitch, 2026-11-07)

Ali's agent (Claude Code, cloud session) works on `claude/wizardly-pasteur-r1nhhw`, based on feature/semantic-graph at 1d7be89. Cards B1 (M0 benchmark) and B2 (pitch) are in the cycle 5 table of [the delivery board](graph-delivery.md). This section is the status channel to Ruslan's agent and is updated after every step.

- Not touched here: Linux CI for PR #1, the live MCP smoke test, the demo rehearsal, P0/P1, and `src/`.
- Step 1 (done): cards claimed.
- Step 2 (done): benchmark built (ed97b67) with evals first (8d80a00). Results in [benchmark.md](benchmark.md). Draft PR https://github.com/PricePepel/context-ledger/pull/3 into feature/semantic-graph, with `@tenki-reviewer` requested. An independent review subagent and a debug pass are running; fixes follow. The pitch (B2) is deferred until the numbers are final.
- Step 3 (done): at Ali's request, asked `@tenki-reviewer` (Tenki Code Reviewer, a non-Claude reviewer) to review PR #1 in https://github.com/PricePepel/context-ledger/pull/1#issuecomment-6711871153. Ali's agent will not push to feature/semantic-graph. Ruslan triages the findings. The same reviewer will be tagged on Ali's benchmark PR.
- Step 4 (done): review and debug of the benchmark confirmed 10 findings (5 medium, 5 low), all fixed with regression tests in 715ae35, and the report regenerated in 0a9883b. Node tests: 64 of 64 on Linux. The outcome is recorded in the cycle 5 results in [the eval log](evals.md). Correction to step 2: the graph context is smaller but not more cache-stable. The handoff's poor prefix came from one session-ID line.
- For Ruslan (cycle 4 findings in `src/`, not changed here; your call):
  - `src/handoff.mjs` prints the session ID on line 5, and the ID hashes the whole transcript, so every append breaks the handoff's prompt-cache prefix. Moving the ID after the turns would leave 84–99% of the handoff as a stable prefix from 50 turns on, about 30K estimated tokens at 1000 turns.
  - `src/context.mjs` renders `## edges` before links and actions, so a new action's `advances` edge breaks the graph context mid-output (42–55% prefix, never at the 1,024-token cache minimum). Ordering sections by how often they change would keep more of it. With both fixes, the graph would be both smaller and cacheable. See section 3 of docs/benchmark.md.
- Next: Tenki review of PR #3 (pending), then the pitch (B2) from the final numbers.
