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

One command runs the whole two-person demo. It starts the server, imports a Claude Code and a Codex transcript (200 synthetic turns each, from the M0 benchmark generator), publishes both v2 graphs with links (matches, conflicts, answers) and opens the room in Chromium (9 proposals). Then mara and teo both confirm the first match, teo rejects the first conflict, the page reloads to prove the decisions were stored, and the server stops. It takes about 2 s. Add `--turns 2` for the hand-written toy scenario (3 proposals).

```bash
node .claude/skills/run-context-ledger/driver.mjs demo --out /tmp/ledger-shots
```

It prints JSON with the room URL, both graph IDs, the savings `meter`, the agreed proposals, `pageErrors` (non-empty sets exit code 1) and the screenshot paths:

- `1-room-open.png`: the room with its proposals, nothing decided yet.
- `2-room-decided.png`: after the reload. The match shows `State: agreed`, the conflict `State: rejected`, and the "answers" proposal is still `proposed`.
- `3-full-page.png`: the whole page.

Keep the server running to keep poking it with `curl` or a browser:

```bash
node .claude/skills/run-context-ledger/driver.mjs demo --keep --port 4399 --out /tmp/ledger-shots
# last line: "Server kept running at http://127.0.0.1:4399 (pid N). Stop it with: kill N"
```

Record the captioned backup video (about 60 s, 1280x800 MP4, real-time pacing) for when the live demo can't run:

```bash
node .claude/skills/run-context-ledger/driver.mjs demo --story networking --record --out /tmp/ledger-video
# -> /tmp/ledger-video/demo.mp4; the committed copy is docs/demo/networking-demo.mp4
```

Check the demo's savings meter without a browser. It exits 1 if either party saves 85% or less:

```bash
node .claude/skills/run-context-ledger/driver.mjs check     # 200 turns: mara 0.916, teo 0.898 saved (estimates)
```

Seed a server that is already running, with no browser:

```bash
node .claude/skills/run-context-ledger/driver.mjs seed --url http://127.0.0.1:4399
```

| command | what it does |
| --- | --- |
| `demo [--story sprint\|networking] [--turns N] [--out DIR] [--port N] [--keep]` | Server, seed and browser room flow with screenshots. Uses a free port unless `--port` is given. |
| `check [--turns N] [--min-saved 0.85]` | Server and seed, no browser. Prints both meters and fails below the threshold. `tests/demo-seed.test.mjs` runs it. |
| `seed --url URL [--turns N]` | Imports, publishes and opens a room on a running server, then prints the IDs and both meters. |

`--turns` defaults to 200, and `--seed` (default 42) picks the synthetic content. `--story networking` loads the hackathon storyline (`demo/networking.mjs`): two attendees, ali and ruslan, whose agents network for them, with 7 hand-reviewed proposals and about 92% saved. The demo confirms the co-builder match and rejects the Sunday clash.

## Run (human path)

```bash
PORT=4400 CONTEXT_LEDGER_DB=/tmp/ledger.sqlite npm start
# -> "Context Ledger listening at http://127.0.0.1:4400". Stop with: lsof -ti:4400 -sTCP:LISTEN | xargs -r kill
```

Without `CONTEXT_LEDGER_DB`, data goes to `.context-ledger/ledger.sqlite`, which Git ignores.

## Test

```bash
node --test tests/*.test.mjs   # 75 pass on Linux, including the benchmark and demo-seed tests
npm run bench                  # M0 benchmark; rewrites nothing unless --markdown is given
```

## Gotchas

- **Playwright's browser build is missing.** The repo pins Playwright 1.65.0, which wants `chromium_headless_shell-1254`, but the container ships build 1243 at `/opt/pw-browsers/chromium`. So `chromium.launch()` fails with "Executable doesn't exist". The driver catches that and relaunches with `executablePath` set to `CHROMIUM_PATH` or `/opt/pw-browsers/chromium`. Do not run `npx playwright install`.
- **The context API wraps its reply.** `GET /api/graphs/:id/context` returns `{ "context": { text, meter, ... } }`, not the fields at top level.
- **The meter is negative on tiny transcripts.** With `--turns 2` the graph context is larger than the handoff (`savedShare` -1.08 for mara). Savings show from about 50 turns, which is why the demo defaults to 200. Never present a toy session's meter.
- **Proposals re-sort when their state changes.** Agreed and rejected items move, so `.first()` can point at a different proposal after a click. The driver pins each proposal by its sentence text.
- **Generated pairings don't read sensibly.** At 200 turns the links pair facts by kind, not meaning (an offer about one component "matches" a goal about another). They are fine for measuring but weak to read on stage.
- **Writes need Origin, and the Host must be loopback.** Every POST must send `origin: http://127.0.0.1:PORT`. A request with another `Host` gets 403 "Unrecognized local host." Room decisions also require a browser same-origin fetch, so `curl` cannot confirm or reject. Use the browser (the driver does).
- **Seeding is idempotent.** Graphs, rooms and sessions are content-addressed, so a second `seed` against the same server returns the same IDs and the existing decisions.
- **`--keep` leaves the temp database.** Only the non-keep path deletes its `ledger-run-*` directory under the OS temp dir.
- **The graph ID inputs are empty after a reload.** The room reloads from `#room=…` in the URL, not from the form fields, so don't use the inputs to tell which room is open.

- **Playwright's video recorder needs its own ffmpeg build.** The pinned Playwright asks for `/opt/pw-browsers/ffmpeg-1013`, and the container has 1011. `--record` therefore captures JPEG frames itself (about 10 per second) and encodes them with the system `/usr/bin/ffmpeg` on a constant 10 fps timeline.
- **The first screenshots stall while the page settles.** Captions shown before the first frame vanish from the video, so capture starts after `goto` and one warm-up frame. ffmpeg's concat demuxer ignored per-image durations (a 61 s run came out as 26 s), which is why frames are laid onto fixed ticks instead.

## Troubleshooting

- **`browserType.launch: Executable doesn't exist at /opt/pw-browsers/chromium_headless_shell-1254/...`**: the browser build doesn't match (see Gotchas). The driver handles it. In your own scripts, pass `executablePath: '/opt/pw-browsers/chromium'`.
- **`ExperimentalWarning: SQLite is an experimental feature`** on start: expected on Node 22 (`node:sqlite`). Harmless.
