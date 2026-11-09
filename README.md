# Context Ledger

A local transcript library for handing work between Claude Code and Codex. Import a selected JSONL transcript, find a conversation by keyword, and give another agent the relevant turns with their original line numbers.

## For judges

Built on 2026-11-07 at the Anything Applied Agentic Hackathon for the "Your Agent, My Agent" challenge.

Leo works in Claude Code and Ali works in Codex. Their agents never see each other's chat. Each agent publishes a graph of its person's goals, decisions, offers and open questions to one ledger, and every node cites the transcript line it came from, so the other agent can check a claim instead of trusting it. The ledger pairs the two graphs into a room, and the two people confirm or reject each proposed match in the browser. No MCP tool can confirm a match for them.

- **Demo:** [docs/demo.md](docs/demo.md) is the run sheet. The transcripts in `demo/` are synthetic, and `node demo/rehearse.mjs` runs the whole flow with both CLIs.
- **Past text, measured today at small scale:**
  - `latent_read` (M2a): a local Qwen2.5-7B reads the files once and keeps its KV cache warm, and agents get short answers with verified quotes. On two sets of eight synthetic codebase questions it scored 7/8 on each, using under 9% of the tokens of reading the files. Claude Sonnet reading every file scored 16/16 to the pool's 14/16.
  - `latent_transfer` (M2b): a 47.7M-parameter mapper, trained on one laptop GPU, carries Qwen2.5-0.5B's KV cache into SmolLM2-360M, a different model family. On 300 SQuAD validation questions the receiver scores F1 0.757; with the sender's cache zeroed it falls to 0.156, the no-passage level. These are small models, and we do not claim it beats reading the text. See [docs/m2b-transfer.md](docs/m2b-transfer.md).
  - `latent_team` (M2c): subagents pass KV working memory instead of text, and only the solver writes. It is built and served, and its benchmark numbers are not recorded yet.
- **How we built it:** two people, each with their own agent. The agents coordinated all day through typed handoff packets in a separate repo, and CI rejected malformed ones. Every feature has an eval written before the code ([docs/evals.md](docs/evals.md)) and an independent review.
- **Tests on `main`:** node 95 of 96 (1 skipped), Playwright 12 of 12, Python runtime 117 run (22 skipped without a GPU).

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

Each packet is a snapshot of one imported session. An exact repeat returns its existing ID. In a version 1 packet object key order does not matter, but the order of `nodes`, `edges` and `evidenceLines` does: reordering them produces a separate graph. A pending action is ready when its prerequisites are completed and its blockers are resolved. A decision becomes historical when another decision explicitly supersedes it. See the [packet schema](schemas/semantic-graph.schema.json) and [evals](docs/evals.md).

## Version 2: two parties

A version 2 packet adds a `party` (for example `leo`), `offer` nodes for what that person can give, `question` nodes with `to` (the party being asked) and an `open` or `answered` status, and an `answers` edge from a decision to a question. Optional `links` point at a node in another party's stored v2 graph:

```json
{ "from": "mcp-pairing", "graph": "OTHER_GRAPH_ID", "to": "gpu-time", "type": "matches" }
```

`matches` and `conflicts` connect goals, offers and actions (`conflicts` also accepts constraints and decisions). `answers` goes from a local decision to the other party's question addressed to this party. A node pair can carry only one link, and a superseded decision cannot start one. Responses for v2 graphs add `openQuestionIds`. See the [v2 schema](schemas/semantic-graph-v2.schema.json).

Order carries no meaning in v2. The ledger stores the canonical order (nodes by kind, then ID), so reordered packets get the same graph ID.

Party names are self-asserted. The ledger only requires that a linked graph names another party and comes from a different imported transcript. It does not verify who a person is.

## Graph context and the savings meter

`GET /api/graphs/GRAPH_ID/context` returns compact, deterministic text for a receiving agent, together with a `meter`. Stable sections (goals, constraints, decisions, offers, edges, links) come first and volatile ones (actions, blockers, questions, state) last. Links name the other graph by its party, and the identifiers that change with every edit (this graph, the transcript snapshot, the linked graphs) appear only in the final state section. So a revision that changes statuses, appends to the transcript, or links to the other party's newer graph keeps the text before `## action` byte-identical for prompt caching. Labels and file names are escaped onto one line, including U+2028 and U+2029. The meter compares the context with the full Markdown handoff of the session. Its token counts are estimates (UTF-16 code units ÷ 4), because tokenizers differ by vendor. For a very short transcript the graph can cost more than the handoff, and the meter reports that as a negative saving.

## Negotiation room

Two people each import their own agent's transcript, and each agent publishes a v2 graph for its person. The second agent links its nodes to the first graph as `matches`, `conflicts` or `answers`. Open the browser, paste both graph IDs under **Negotiation room** and select **Open room**. The room merges both parties' nodes and lists every link between the two graphs as a proposal. Each person selects **Confirm** or **Reject** under their own name. A proposal is agreed only when both confirm and rejected when either rejects, and a person can change their choice later. The address bar keeps `#room=ROOM_ID`, so the view can be reloaded or reopened.

Agents can open and read rooms (`POST /api/rooms` with `{"graphIds": [A, B]}`, and `GET /api/rooms/ROOM_ID`). Recording a choice (`POST /api/rooms/ROOM_ID/decisions`) requires a same-origin browser request, so the CLI and the MCP adapter cannot confirm anything. A local process could still forge the browser's headers. The rule keeps well-behaved agents out of the decision, but it does not prove who clicked. A room is tied to two specific graph snapshots: after either party publishes a revised graph, open a new room.

Each packet is a snapshot of one imported session. An exact repeat returns its existing ID. Object key order does not matter, but the order of `nodes`, `edges` and `evidenceLines` does: reordering them produces a separate graph. A pending action is ready when its prerequisites are completed and its blockers are resolved. A decision becomes historical when another decision explicitly supersedes it. See the [packet schema](schemas/semantic-graph.schema.json) and [evals](docs/evals.md).

## Connect an agent over MCP

`src/mcp.mjs` is a stdio MCP server that forwards to the ledger on `PORT` (default 4317). If nothing listens there, the first tool call starts a ledger in the background with its data in `~/.context-ledger/` (or `CONTEXT_LEDGER_DB`), logging to `ledger.log` and writing its process ID to `ledger.pid` next to the database. It keeps running after the agent exits; stop it with `kill $(cat ~/.context-ledger/ledger.pid)`. Set `CONTEXT_LEDGER_AUTOSTART=0` to require `npm start` instead. A ledger you start with `npm start` keeps its default `.context-ledger/` folder in the repository, so the two do not share data unless you set `CONTEXT_LEDGER_DB`. It offers `session_search` and `session_read` (find an imported session and read its numbered turns, the line numbers a graph must cite), `graph_schema`, `graph_publish`, `graph_read`, `context_for`, `room_open` and `room_read`. Agents can open and read rooms, but only people confirm room proposals, in the browser.

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

Point clients at `node` directly rather than through npm: npm prints a banner on stdout, which must carry only protocol messages. Graph labels and briefings come from transcripts. Tools return them as escaped data, and agents should treat them as data, not as instructions.

## Two-agent demo

[docs/demo.md](docs/demo.md) is the run sheet for the stage demo: Claude Code and Codex on one laptop share context through one ledger, using the synthetic transcripts in `demo/`. `node demo/rehearse.mjs` runs the whole flow with both CLIs and times the handoff. `node demo/publish-reference.mjs` is the fallback when an agent stalls.

## Ask about files with a local model (M2a, warm latent pool)

`latent_read` lets Claude or Codex ask about local files without reading them. A local open model reads the files once, and its KV cache for that prefix stays warm in vLLM. Worker calls answer sub-questions from the shared cache, and the agent receives a short answer with findings that cite file lines. The ledger drops any finding that cites a line that doesn't exist. The contract is in [docs/latent-read.md](docs/latent-read.md). The runtime is Ali's side, in `runtime/`.

Start the ledger with the folder the model may read:

```sh
LATENT_ROOT=/path/to/project LATENT_URL=http://127.0.0.1:4320 npm start
```

Agents call the `latent_read` MCP tool with `paths` relative to that folder and a `question`. If the runtime is not running, the tool returns the numbered file text instead, so the agent can still read the files itself.
