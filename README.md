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

## Connect an agent over MCP

`src/mcp.mjs` is a stdio MCP server that forwards to the running ledger. Start the ledger with `npm start` first; the MCP server reads `PORT` (default 4317) to find it. It offers `graph_schema`, `graph_publish`, `graph_read`, `context_for`, `room_open` and `room_read`. Agents can open and read rooms, but only people confirm room proposals, in the browser.

Claude Code:

```sh
claude mcp add context-ledger -- node /absolute/path/to/context-ledger/src/mcp.mjs
```

Codex, in `~/.codex/config.toml`:

```toml
[mcp_servers.context-ledger]
command = "node"
args = ["/absolute/path/to/context-ledger/src/mcp.mjs"]
# Only needed when the ledger runs on another port.
env = { PORT = "4317" }
```

Point clients at `node` directly rather than `npm run mcp`: npm prints a banner on stdout, which must carry only protocol messages. Graph labels and briefings come from transcripts. Tools return them as escaped data, and agents should treat them as data, not as instructions.
