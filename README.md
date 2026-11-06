# Context Ledger

A local transcript library for handing work between Claude Code and Codex. Import a selected JSONL transcript, find a conversation by keyword, and give another agent the relevant turns with their original line numbers.

## Run locally

Requires Node.js 22.14 or later.

```sh
npm ci
npm start
```

Open http://127.0.0.1:4317. Choose the source agent and a JSONL file, then select **Import transcript**. Search terms are case-insensitive, and every term must appear somewhere in the session. The agent filter limits the results to Claude Code or Codex.

While the server is running, search and export from a second terminal:

```sh
npm run --silent ledger -- search --provider claude deployment
npm run --silent ledger -- handoff SESSION_ID
```

Replace `SESSION_ID` with an ID from the search results. The handoff is Markdown with the source filename and original JSONL line number for each turn. Share the selected packet with the receiving agent when you want it to have that context.

## Data and scope

The server binds to IPv4 loopback and stores data in `.context-ledger/ledger.sqlite`. Set `PORT` or `CONTEXT_LEDGER_DB` to override those defaults. The database contains transcript text. Back it up or remove it as needed when the app is stopped.

The first version imports conversational text from supported Claude Code and Codex JSONL records. It skips tool outputs, internal instructions, and unsupported records. Select files explicitly. Automatic discovery, account sync, images, tool replay, and team permissions are outside the current version. The HTTP import request is capped at 8 MiB, including JSON encoding.

## Evaluate

```sh
npx playwright install chromium
npm test
```

Playwright uses synthetic records and a separate test database. See [the handoff notes](docs/handoff.md) and [eval log](docs/evals.md) for decisions and checkpoints.

## Exchange a semantic graph

Import a transcript first. Take its session ID from `npm run --silent ledger -- search`, then create a JSON packet with that ID and the original JSONL line numbers shown in the reader. For example, if line 1 states the rollout goal and line 2 gives the next action, the packet can contain:

```json
{
  "version": 1,
  "sessionId": "REPLACE_WITH_IMPORTED_SESSION_ID",
  "nodes": [
    { "id": "rollout", "kind": "goal", "label": "Continue the rollout", "evidenceLines": [1] },
    { "id": "canary", "kind": "action", "label": "Run the Canary smoke test", "evidenceLines": [2], "status": "pending" }
  ],
  "edges": [
    { "from": "canary", "to": "rollout", "type": "advances" }
  ]
}
```

```sh
npm run --silent ledger -- graph publish packet.json
npm run --silent ledger -- graph read GRAPH_ID
```

Both commands return JSON containing the graph ID, packet, ready action IDs, and current decision IDs. Use the ID from publish in the read command. Either agent can consume the returned packet. The ledger checks that cited lines exist in the chosen transcript. Review the source text to establish whether it supports the claim, and use the usual approval process before acting.

Evidence must cite a line that produced a stored user or assistant turn. Lines that held only tool output or injected context are not stored, so citing them is rejected.

Each packet is a snapshot of one imported session. An exact repeat returns its existing ID. Object key order does not matter, but the order of `nodes`, `edges` and `evidenceLines` does: reordering them produces a separate graph. A pending action is ready when its prerequisites are completed and its blockers are resolved. A decision becomes historical when another decision explicitly supersedes it. See the [packet schema](schemas/semantic-graph.schema.json) and [evals](docs/evals.md).
