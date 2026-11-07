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
- Track analysis (20:35 UTC), for Ali and Ruslan to decide. Recommendation: enter challenge 5 ("Your Agent, My Agent") and differentiate on depth: "everyone builds agents that network for you; we built the trust layer". That means cited claims, cross-vendor over MCP, 96% smaller than raw chats, and only humans can agree. Using today's real sessions live on stage (never committed) would make the "two people, live" moment real. Choose wildcard (agent handoff infrastructure) instead if challenge 5 is clearly crowded or the judges lean dev-tool. Switching is one storyline label plus the pitch opening.
- Track options updated (20:40 UTC). There is a new candidate: **challenge 1, "Serendipity Engine"**, using challenge 2 ("knowledge that finds you") as its mechanism. A scan across 6–8 attendees' graphs ranks surprising, useful pairs (your open question meets someone's cited decision; your offer meets their goal) and opens rooms where both must confirm. It mirrors the event's own Mystery Match, adds originality and keeps the two-people-live bonus. Proposed card B11 (`demo/serendipity.mjs`, no `src/` changes, about 2–3 h) is waiting on Ali's go and the track decision with Ruslan. With an API key, each person's agent could judge candidate pairs over MCP, which would be the real product.
- Pitch positioning (20:50 UTC), Ali's idea critiqued. Thesis: a horizontal layer shown through one vivid vertical demo. Lead with what the layer is (verifiable, cross-vendor, human-approved, over MCP); "smaller" is the bonus. Avoid claiming "a new industry standard": MCP and A2A exist, so say "a layer over MCP". Avoid "time saving": it is unmeasured. Avoid "fast": human approval is deliberately slow, and it is the differentiator. Be honest on tokens: 96% vs the raw transcript, about 35% vs a cache-warm handoff, both estimates on synthetic data, with no summary baseline yet. Q&A risk: "vs a summary?" A summary baseline needs an API key, so otherwise answer with citations (a summary loses provenance). Cross-vendor neutrality is the "why us": the giants won't bridge each other's agents.
- Latent framing (20:50 UTC). Context: SwaT ("Swarm Telepathy", arXiv 2610.15095, github.com/Ar-Kareem/SwaT) transfers KV caches across model families. It reports over 90% score retention, and about 40% more accuracy and 4× the speed of text summaries at matched budgets. Proposed pitch architecture: a **text layer for people** (cited graph, human-only agreement; built) plus a **latent layer for machines** (M2a warm telepathy, built; M2b cross-family = SwaT, not built). This revives "fast / token-saving" if attributed precisely: SwaT's numbers are the paper's on open models. Today's measured M2a numbers: 1,972 → 426 ms, 98–99% of prompt tokens cached, the agent gets about 5–9% of the tokens, gates pass 3/3 in cycle 6b. The "vs summary" Q&A hole is answered by the SwaT paper.
- **Ali's cycle 6 task was missed until now.** Ali owns the `ali/latent-pool` runtime and must approve the `docs/latent-read.md` contract (`q-latent-contract`). The branch is not pushed, so Ali's agent cannot review it. **Ruslan: please push `ali/latent-pool`.**
- Gap-closing list L1–L18 added to [the delivery board](graph-delivery.md). P0 items needing Ruslan: **L3, the repo is private** (judges can't open it), **L4, `main` is stale** (merge PRs #1, #4 and #3), and **L5, rehearse on your laptop**. L1 (track) and L2 (submission rules) are for both of you.
- Status 21:05 UTC. Done: L15 [built-today slide](built-today.md) and L16 judge header at the top of the README (7a9c6d8); L6 [pitch](pitch.md), L12 [Q&A sheet](qa.md) and L11 attribution (8ddd86f). **SwaT is related work by other authors. Nobody on the team wrote it, so never claim it.** L2 (submission rules) is dropped for now, by Ali's call. In progress: L8 dogfood script (`bench/dogfood.mjs`) and L10 graph-building cost (benchmark §8). Still on Ruslan: L3 private repo, L4 stale `main`, L5 rehearsal, L13 caching fixes, L14 push `ali/latent-pool`.
- Status 21:10 UTC. Ruslan pushed `ali/latent-pool`, which unblocks L14. An independent reviewer is going through the runtime and the `docs/latent-read.md` contract for Ali. Ali decides the approval once the verdict is in. Ruslan also pushed the cycle 6b review fixes (9392642), and CI is green.
- Status 21:15 UTC. L8 is done: `bench/dogfood.mjs` measures real sessions locally and reports aggregates only. Ali runs it with `node bench/dogfood.mjs ~/.claude/projects ~/.codex/sessions`. L10 is done: benchmark §8 shows building the graph pays for itself from the 2nd handoff against today's (uncacheable) handoff at 200–1000 turns. Against a hypothetically cache-friendly handoff the graph wins only at 1000 turns (from the 57th handoff). At 50–200 turns a cache-friendly handoff would be about as cheap ($1.56 vs $1.86, $2.51 vs $2.70 per 1,000 on Opus). The pitch and Q&A now say this exactly. Node suite 81/81.
- Status 21:20 UTC. **L14 review done: approve with changes** ([docs/reviews/latent-pool-review.md](reviews/latent-pool-review.md)). There are no high findings, and path confinement, validation and prefix determinism hold (54 runtime tests pass). Two medium resource issues: abandoned requests are never cancelled and hold 1 of 4 slots behind a semaphore with no timeout, and 64 slow clients lock the service out. Also 9 contract gaps, including that the two branches' copies of `docs/latent-read.md` differ. Recommendation: approve the contract after gaps 1, 2 and 5; merge the runtime after findings 1 and 2. Not demo-blocking. **Ali decides.** Ruslan: whose agent applies the fixes on `ali/latent-pool`?
- Status 21:30 UTC. **Ali approved the L14 review** and asked Ali's agent to apply the fixes on `ali/latent-pool`. That is the one exception to "Ali's agent pushes only to its own branch", with Ali's explicit OK. Ruslan was told first on PR #4 (https://github.com/PricePepel/context-ledger/pull/4#issuecomment-6713124976). **Ruslan: please don't push to `ali/latent-pool` until the done note appears here and on PR #4.** Scope:
  - Mediums 1 and 2: a request deadline under 180 s, 503 busy, and an overall read deadline.
  - The quick lows.
  - Contract gaps 1, 2, 5, 6 and 7.
  - Nothing in `src/` or `leo/latent-read` changes.
- Status 21:45 UTC. **L14 fixes applied on `ali/latent-pool` (72ce5cb), and Ali approved the contract.**
  - Mediums 1 and 2 are fixed: a 150 s request deadline, 503 busy after a 2 s wait for a slot, and a 10 s limit to read the whole request.
  - Lows 3–9 and design note 10 are fixed.
  - Contract gaps are closed (1, 2, 3, 4, 5, 6, 7, 8, 9).
  - Runtime tests: 73/73, three runs.
  - Ruslan was told on PR #4, and `ali/latent-pool` is free to push again.
  - **Ruslan:** copy `docs/latent-read.md` from `ali/latent-pool` to `leo/latent-read` so the two copies match. Optionally, give the ledger a clearer message for the runtime's new 504.
- Status 21:55 UTC. **Collision on `ali/latent-pool`.** Ruslan's agent fixed the same L14 blockers in parallel (runtime `105ebe2`, `ffea03b`, not pushed; ledger 023123e and f166765 on `leo/latent-read`), while Ali's agent pushed 72ce5cb. The details are on PR #4 (comment of 21:55 UTC).
  - **Ali's agent stays off `ali/latent-pool` from now on.** Ruslan rebases onto 72ce5cb, without force-pushing. Where the two overlap, keep Ruslan's version: 5 s slot wait, 15 s read deadline, the disconnect check, and `preambleVersion` as the string "2". Drop Ali's added preamble sentence so the live gate stays valid. Keep Ali's low fixes and `test_review_fixes.py`.
  - Contract: Ruslan's copy as the base, plus Ali's Paths, File text and Secrets sections.
- Status 22:00 UTC. **Independent review of 72ce5cb** (a separate agent that did not write it): no high or medium findings, and 73/73 tests pass. Slots are released on every path, no timers are left behind, and the worst case is about 162 s, under the ledger's 180 s. Three lows for Ruslan to fold into the merge (details in the PR #4 merge-plan comment):
  1. Drop "Cn" from the path check (Python's Unicode tables are older than Node's).
  2. Secret denylist: add `.git-credentials`, `.docker/` and `.kube/`, allow `.env.example`, and mirror the rule in `src/latent.mjs`.
  3. A test that the deadline is checked before the next call.
- Status 22:10 UTC. **Track decided (L1): wildcard, positioned as a horizontal layer.** A trust layer between any two agents, cross-vendor, over MCP. The networking room is the one live vertical. Code handoffs between Claude Code and Codex are named as the first users, and hiring, team-forming and cross-company coordination are the other verticals.
  - Updated: [pitch](pitch.md) (track, demo framing, a new horizontal section, "do not say" items on vagueness), [Q&A](qa.md) #11 ("too broad, who first?") and the demo's decision label (`demo/networking.mjs`).
  - The 61 s backup video is unchanged and still accurate, because that decision is never shown in the room.
  - Node suite 81/81.
  - **Ruslan:** rehearse with the new pitch. Section 5 (horizontal) is now the core of the pitch, not an afterthought.
- Status 22:40 UTC. **Pitch deck built** (10 slides, product only, Expedite-style black and white): https://claude.ai/artifact/8V31nrtNkBWLLBoouFFk1e
  - It follows the wildcard pitch, and the speaker notes hold the script with timings.
  - It is private until Ali shares it, so Ruslan can't open the link yet.
  - Fonts: Geist for text, Instrument Serif for headings, standing in for Expedite's paid PP Editorial Old.
  - `expedite.now` was added to the cloud environment's allowed hosts so its stylesheet could be read.
- Status 22:50 UTC. **L14 closed.**
  - Ruslan merged onto 72ce5cb in `adcc7fb`, without force-pushing, following the PR #4 plan. Both branches carry one identical approved `docs/latent-read.md`.
  - The ledger follows the merged contract (3c2a4f6), and word-only findings must be grounded in their cited lines (0de471a, 5e6b733).
  - Live gates pass 3/3 on both sets: original 7/8 accuracy and 7/8 citations; held-out 7/8 and 8/8.
  - Ali's agent re-ran the runtime suite on adcc7fb: all pass, two runs.
  - **Lesson recorded on PR #4:** the "untrusted data" preamble sentence from 72ce5cb cut accuracy to 6/8 and leaked the injection probe live, so it was rightly dropped. Prompt changes need a live gate run.
