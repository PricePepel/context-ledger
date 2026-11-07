---
name: run-context-ledger
description: Run, start, demo and drive Context Ledger. Use when asked to start the ledger server, seed a two-party negotiation, open a negotiation room in the browser, take screenshots of the UI, check the savings meter, or run the tests and the M0 benchmark.
---

Context Ledger is a loopback Node server (`src/server.mjs`) with a browser UI. Drive it with `.claude/skills/run-context-ledger/driver.mjs`. The driver starts the real server on a temporary database, seeds two parties through the HTTP API, and uses Playwright to click through the negotiation room, taking screenshots. All paths are relative to the repository root.

## Prerequisites

Node 22 (tested with v22.23.4) and the repository's own dependencies. No `apt-get` packages were needed in a Claude cloud container.

```bash
npm ci
```

## Run (agent path)

One command runs the whole two-person demo. It starts the server, imports a Claude Code and a Codex transcript, publishes both v2 graphs with links (matches, conflicts, answers) and opens the room in Chromium. Then mara and teo both confirm the match, teo rejects the conflict, the page reloads to prove the decisions were stored, and the server stops. It takes about 2.5 s.

```bash
node .claude/skills/run-context-ledger/driver.mjs demo --out /tmp/ledger-shots
```

It prints JSON with the room URL, both graph IDs, the savings `meter`, the agreed proposals, `pageErrors` (non-empty sets exit code 1) and the screenshot paths:

- `1-room-open.png`: the room with 3 proposals, nothing decided yet.
- `2-room-decided.png`: after the reload. The match shows `State: agreed`, the conflict `State: rejected`, and the "answers" proposal is still `proposed`.
- `3-full-page.png`: the whole page.

Keep the server running to keep poking it with `curl` or a browser:

```bash
node .claude/skills/run-context-ledger/driver.mjs demo --keep --port 4399 --out /tmp/ledger-shots
# last line: "Server kept running at http://127.0.0.1:4399 (pid N). Stop it with: kill N"
```

Seed a server that is already running, with no browser:

```bash
node .claude/skills/run-context-ledger/driver.mjs seed --url http://127.0.0.1:4399
```

| command | what it does |
| --- | --- |
| `demo [--out DIR] [--port N] [--keep]` | Server, seed and browser room flow with screenshots. Uses a free port unless `--port` is given. |
| `seed --url URL` | Imports, publishes and opens a room on a running server, then prints the IDs and the meter. |

## Run (human path)

```bash
PORT=4400 CONTEXT_LEDGER_DB=/tmp/ledger.sqlite npm start
# -> "Context Ledger listening at http://127.0.0.1:4400". Stop with: lsof -ti:4400 -sTCP:LISTEN | xargs -r kill
```

Without `CONTEXT_LEDGER_DB`, data goes to `.context-ledger/ledger.sqlite`, which Git ignores.

## Test

```bash
node --test tests/*.test.mjs   # 64 pass on Linux, including the benchmark tests
npm run bench                  # M0 benchmark; rewrites nothing unless --markdown is given
```

## Gotchas

- **Playwright's browser build is missing.** The repo pins Playwright 1.65.0, which wants `chromium_headless_shell-1254`, but the container ships build 1243 at `/opt/pw-browsers/chromium`. So `chromium.launch()` fails with "Executable doesn't exist". The driver catches that and relaunches with `executablePath` set to `CHROMIUM_PATH` or `/opt/pw-browsers/chromium`. Do not run `npx playwright install`.
- **The context API wraps its reply.** `GET /api/graphs/:id/context` returns `{ "context": { text, meter, ... } }`, not the fields at top level.
- **The meter is negative on tiny transcripts.** On the 2-turn demo transcripts the graph context is larger than the handoff (`savedShare` about -1.08). The M0 benchmark shows savings only from roughly 50 turns. Don't present the meter from a toy session as the product's saving.
- **Writes need Origin, and the Host must be loopback.** Every POST must send `origin: http://127.0.0.1:PORT`. A request with another `Host` gets 403 "Unrecognized local host." Room decisions also require a browser same-origin fetch, so `curl` cannot confirm or reject. Use the browser (the driver does).
- **Seeding is idempotent.** Graphs, rooms and sessions are content-addressed, so a second `seed` against the same server returns the same IDs and the existing decisions.
- **`--keep` leaves the temp database.** Only the non-keep path deletes its `ledger-run-*` directory under the OS temp dir.
- **The graph ID inputs are empty after a reload.** The room reloads from `#room=…` in the URL, not from the form fields, so don't use the inputs to tell which room is open.

## Troubleshooting

- **`browserType.launch: Executable doesn't exist at /opt/pw-browsers/chromium_headless_shell-1254/...`**: the browser build doesn't match (see Gotchas). The driver handles it. In your own scripts, pass `executablePath: '/opt/pw-browsers/chromium'`.
- **`ExperimentalWarning: SQLite is an experimental feature`** on start: expected on Node 22 (`node:sqlite`). Harmless.
