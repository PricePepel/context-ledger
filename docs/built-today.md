# Built today: one slide

*Judging criterion: "progress made on the day." Everything here was built on 2026-11-07, during the event, and every line links to evidence in this repository.*

## The timeline (Pacific time)

| Time | What shipped | Branch / PR |
| --- | --- | --- |
| 10:34 | Cycle 4 evals written **before** the code | `feature/semantic-graph` (PR #1) |
| 10:39–10:52 | Semantic graph v2 (parties, offers, questions, cross-graph links), cache-stable context and savings meter, negotiation rooms, MCP adapter | PR #1 |
| 11:00–11:03 | Review fixes (rooms couldn't fake state), CI runs every test file | PR #1 |
| 11:15–11:25 | M0 benchmark: evals first, then the harness, then 10 review findings fixed | `claude/wizardly-pasteur-r1nhhw` (PR #3) |
| 11:26–11:33 | M2a latent read: the ledger side of the warm KV-cache pool, plus its gate runner | `leo/latent-read` (PR #4) |
| 11:32–11:42 | Run skill (one command runs the demo) and the demo seed at 200 turns | PR #3 |
| 12:05–12:07 | Tenki (a second, non-Claude reviewer) findings fixed on PR #3 and PR #4 | PR #3, PR #4 |
| 12:13–12:22 | Networking storyline and a 61 s captioned backup video recorded from the real app | PR #3 |
| 12:22–12:43 | Cycle 6b: quote-verified latent evidence, held-out questions, **both gates pass 3/3** | PR #4 |

**55 commits today** across the three branches. Three PRs, CI green on each.

## How it was built

- **Evals first, every cycle.** The acceptance criteria are written down before any code: [`docs/evals.md`](evals.md).
- **Reviewed by another model.** Tenki Code Reviewer reviewed every PR. It found **1 high and 5 medium issues, and all are fixed.** Its replies confirm the fixes on [PR #1](https://github.com/PricePepel/context-ledger/pull/1) and [PR #3](https://github.com/PricePepel/context-ledger/pull/3); [PR #4](https://github.com/PricePepel/context-ledger/pull/4)'s fix is in `82a1d1f`. Our own reviewer and debug agents found 10 more issues in the benchmark before Tenki saw it.
- **Every fix has a regression test.** Ali's branch passes 75 node tests; CI runs them plus the Playwright browser journeys on Linux.
- **Two people, two agents, one shared log.** Ali's agent (Claude Code, cloud) and Ruslan's agents coordinated through [`docs/handoff.md`](handoff.md) and a live status comment, without repeating each other's work.

## Numbers this slide may quote

| Claim | Value | Source and caveat |
| --- | --- | --- |
| Graph vs full handoff, 1000-turn session | 3.8% of the characters | [`docs/benchmark.md`](benchmark.md) §1; synthetic data |
| Cost per 1,000 handoffs (Opus 5.5, 1000 turns) | $119.36 raw, $7.22 cache-warm, $4.72 graph | `docs/benchmark.md` §7; estimates (chars/4) |
| Warm latent read, live on a laptop GPU | 1,972 ms → 426 ms; 98–99% of prompt tokens cached | Cycle 6 in `docs/evals.md` on `leo/latent-read`; Qwen2.5-7B |
| Latent read quality gates | Pass 3/3 on two question sets | Cycle 6b on `leo/latent-read` |
