## Card

<!-- Which card in docs/delivery-board.md does this PR deliver? -->

## What and why

## Checklist (see AGENTS.md section 4)

- [ ] Card claimed on the delivery board and its state updated
- [ ] Acceptance eval written in `docs/evals.md` before implementation
- [ ] Tests added: node:test and, for browser flows, Playwright
- [ ] `node scripts/check.mjs`, `npm run -s test:graph`, `node --test tests/*.test.mjs`, `npx playwright test` and, in `runtime/`, `python -m unittest discover -s tests -t .` pass locally
- [ ] Independent review by a different agent or model; findings fixed with regression tests
- [ ] Each repeated review finding (AGENTS.md section 4, step 5) became a `scripts/check.mjs` rule or an API change, or `docs/evals.md` says why no pattern can catch it
- [ ] Review outcome recorded in `docs/evals.md`
- [ ] `docs/handoff.md` updated for the next owner
- [ ] No real transcripts, secrets, `.sqlite` or `.env` files committed

## Agents involved

<!-- e.g. implemented by Codex, reviewed by Claude Code, approved by @owner -->
