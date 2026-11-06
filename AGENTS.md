# Context Ledger — rules for every agent and contributor

These rules apply to every human and every coding agent (Claude Code, Codex, Cursor or any other) working in this repository. Claude Code loads them through `CLAUDE.md`; Codex and most other agents read this file directly. If a rule here conflicts with a personal or tool default, this file wins for this repository.

## 1. Read before you work

1. [docs/handoff.md](docs/handoff.md) — current checkpoint and scope decisions.
2. [docs/delivery-board.md](docs/delivery-board.md) — who owns what right now.
3. [docs/evals.md](docs/evals.md) — acceptance evals and results so far.
4. [docs/architecture.md](docs/architecture.md) and [docs/strategy/](docs/strategy/) when they exist on your base branch.

Do not start coding until you know which card you are working on.

## 2. Claim work on the delivery board

- Every piece of work is a card in `docs/delivery-board.md`. Before you start, set the card's owner and state to `In progress` in your first commit, and push that commit promptly so others can see the claim.
- One owner per card. Do not edit files that an `In progress` card owned by someone else is changing; ask in the PR or add a new card instead.
- New ideas go on the board as `Backlog` cards. Do not widen a card's scope silently.

## 3. Branches and pull requests

- Never commit directly to `main`. All changes reach `main` through a pull request with green CI.
- Branch names: `<owner>/<card-or-topic>`, for example `vuek0/codex-agent-messages`, `claude/wave2-mcp`, `codex/g6-strategy`.
- Keep one card per PR. Rebase or merge the latest base before asking for review.
- Fill in the PR template checklist. A PR that skips a box must say why.
- Do not force-push shared branches, rewrite another owner's commits, or merge someone else's PR without their approval in the PR.

## 4. Definition of done for a feature

1. Write the acceptance eval first in `docs/evals.md` (what is tested, expected result, synthetic data used).
2. Implement it with tests: `node:test` for units and APIs, Playwright for browser journeys.
3. Run everything locally: `npm run -s test:graph`, `node --test tests/*.test.mjs`, `npx playwright test`.
4. Get an independent code review from a different agent or model than the one that wrote the code (for example Claude reviews Codex work and Codex reviews Claude work), plus a human for anything touching security, export or signing.
5. Fix the findings, each with a regression test, and record the review outcome in `docs/evals.md`.
6. Update `docs/handoff.md` with what changed and what the next owner should do.

## 5. Data and secrets

- Tests, fixtures and reviews use synthetic transcripts only. Never commit real transcripts, customer data, `.sqlite` files, `.env` files, keys or tokens.
- Running the product on your own real transcripts ("dogfooding") is encouraged, but only aggregate numbers (counts, rates, timings) may be committed — never transcript text.
- Never paste credentials into prompts, issues, PRs or commits.

## 6. Engineering invariants

- Node 22, ES modules, no build step. Add a runtime dependency only with a short ADR in `docs/architecture.md`.
- The server binds to loopback only and checks Host and Origin. Browser rendering uses `textContent`, never `innerHTML` with transcript data.
- Anything printed to a terminal or exported must escape control, format and bidi characters (see `terminalJson` and `visibleText` in `src/cli.mjs`).
- Imports stay explicit and user-controlled; no background collection of transcripts without consent.
- Tooling quirk: some agent editors turn typed `\u2028`-style escapes into raw invisible characters. Use `String.fromCodePoint(...)` or `\p{...}` classes, and check that `src/` and `tests/` contain no raw control or format characters other than tab, newline and carriage return.

## 7. Working across agents

- Hand work between agents with the local CLIs, from the repository root:
  - Ask Claude Code for a read-only review: `claude -p --permission-mode plan --output-format json -- "<prompt>"`
  - Ask Codex for a read-only review: `codex exec --sandbox read-only --json -C . -- "<prompt>"`
- Keep one agent responsible for edits on a card; others review or propose patches.
- End every session by updating `docs/handoff.md` and the card state, so the next agent — yours or someone else's — can continue without the chat history.

## 8. Commits

- Write commit messages that say what changed and why.
- Credit agents with a trailer, for example `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` or the equivalent for your agent.
