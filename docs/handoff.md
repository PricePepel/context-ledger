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
- Step 5 (done): the run skill `.claude/skills/run-context-ledger/` (`driver.mjs demo` gives the full two-person room flow with screenshots in about 2.5 s). Ruslan can use it for his demo rehearsal. New cards B3–B8 are on the board, all in Ali's lane: benchmark, eval, demo and data. None touches `src/`.
- For Ruslan, observed while driving the UI: on the 2-turn demo transcripts the meter shows a negative saving (-108%), and the graph ID inputs are empty after a room reloads from `#room=`. Both are yours to decide. B3 handles the first from the seed side.
- **Action needed from Ruslan (repo owner):** the Tenki Code Reviewer and Runners are not linked to `PricePepel/context-ledger`, so `@tenki-reviewer` did nothing on PR #1 or PR #3. Only the owner can install the Tenki GitHub app on this repo. Please approve Ali's install request (GitHub → Settings → Applications), or install it from Tenki → Code Reviewer → Configuration. Ali's workspace pays for it from Tenki credits. Tenki only reviews when the PR's author tags it, so for PR #1 you need to tag `@tenki-reviewer` yourself. Ali's agent will re-tag PR #3 once the repo is linked.
- Step 6 (done): B3 demo-scale seed. `driver.mjs demo` and `check` now seed 200 synthetic turns per party, so the meter shows 91.6% and 89.8% saved instead of a negative number. `--turns 2` keeps the toy scenario. A new test file, `tests/demo-seed.test.mjs`, brings the node suite to 67 of 67. Next card is B9: the generated pairings don't read sensibly on stage, so the demo needs a curated storyline. The PR author (Ali) pinged Ruslan on PR #3 about the Tenki app.
- Step 7 (done): Ruslan linked Tenki. `PricePepel` is connected to Ali's Tenki workspace (all repositories) with Automatic Review on. `@tenki-reviewer` was re-tagged on PR #3. Ruslan: tag `@tenki-reviewer` on PR #1 yourself, because Tenki reviews only when the PR's author asks. Note that "Approve on Clean Review" is on, so a Tenki approval is a bot approval, not a human one.
- Step 8 (done): Tenki is reviewing every branch with unreviewed code. PR #1 (cycle 4) and PR #3 (Ali) were tagged, and draft PR #4 was opened for `leo/latent-read` (cycle 6 M2a, base feature/semantic-graph) and tagged. PR #4 is Ruslan's: retarget or close it as you like, and Ali's agent won't push to it. Skipped: `product/v1` (its code is already in PR #1; only strategy docs are new) and the docs-only branches.
- Step 9 (done): Tenki reviewed PR #3 and found 1 high and 2 medium issues, all confirmed and fixed with tests (see the eval log). Corrected cost at 1000 turns on Opus 5.5 (estimates): uncached handoff $119.36, cache-warm handoff $7.22, graph $4.72. The graph is about 96% cheaper than an uncached handoff and about 35% cheaper than a cached one. Node suite: 73 of 73.
- Step 10: the hackathon brief (Anything Applied Agentic Hackathon, EF SF, today 9:00–20:00 PT) fits challenge 5, "Your Agent, My Agent". Judging is working demo, technical depth, originality, usefulness and progress made on the day, with a bonus for real human-agent collaboration. Ali's plan, in order: B9 theme storyline (two attendees' agents networking), B2 pitch mapped to the criteria, B8 backup video, B10 built-today slide, and B4 only if time and a key allow.
- **For Ruslan:** your live two-agent MCP smoke test is the centrepiece of the live demo. Once B9 lands, please run it on the B9 storyline (`node .claude/skills/run-context-ledger/driver.mjs seed --url ...` will load it) so Claude Code and Codex publish for two real people on stage.
- Step 11 (done): B9 networking storyline (`demo/networking.mjs`, `driver.mjs ... --story networking`): ali and ruslan's agents network for them, with 7 legible proposals and about 92% saved. It is an option, not the default: the team has not yet chosen between challenge 5 ("Your Agent, My Agent") and the wildcard track, which would pitch agent handoff infrastructure as dev tooling. **Ruslan and Ali: decide the track together.** If you go wildcard, the one decision label that names challenge 5 changes in a single line.
- Step 12 (done): B8 backup video. `docs/demo/networking-demo.mp4` is 61 s, captioned and recorded from the real app (`driver.mjs demo --story networking --record`). Play it if the live demo fails on stage. A live status comment on PR #3 is edited in place about every 3 minutes while there is news.
- Status 20:25 UTC: Tenki confirmed all three PR #3 fixes in replies on its threads. Ruslan fixed both Tenki findings on PR #4 in 82a1d1f (grader number matching and the token gate), and PR #4's CI is green. CI on PR #3's latest commit (515c19f) is running. Next for Ali: the B2 pitch, waiting on the track decision.
- Status 20:30 UTC: Tenki finished all three PRs. It found 1 high and 5 medium issues, and all are fixed: PR #1 in b9353ca (Tenki confirmed), PR #3 in 4b617d1 (Tenki confirmed) and PR #4 in 82a1d1f. The 7 low findings were each fixed or left with a reason. No Tenki items remain for Ruslan.
