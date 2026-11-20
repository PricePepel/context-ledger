# Context Ledger

A local transcript library for handing work between Claude Code and Codex. Import a selected JSONL transcript, find a conversation by keyword, and give another agent the relevant turns with their original line numbers.

## For judges

Built on 2026-11-07 at the Anything Applied Agentic Hackathon for the "Your Agent, My Agent" challenge.

Leo works in Claude Code and Ali works in Codex. Their agents never see each other's chat. Each agent publishes a graph of its person's goals, decisions, offers and open questions to one ledger, and every node cites the transcript line it came from, so the other agent can check a claim instead of trusting it. The ledger pairs the two graphs into a room, and the two people confirm or reject each proposed match in the browser. No MCP tool can confirm a match for them.

- **Demo:** [docs/demo.md](docs/demo.md) is the run sheet. The transcripts in `demo/` are synthetic, and `node demo/rehearse.mjs` runs the whole flow with both CLIs.
- **Past text, measured today at small scale:**
  - `latent_read` (M2a): a local Qwen2.5-7B reads the files once and keeps its KV cache warm, and agents get short answers with verified quotes. On two sets of eight synthetic codebase questions it scored 7/8 on each, using under 9% of the tokens of reading the files. Claude Sonnet reading every file scored 16/16 to the pool's 14/16.
  - `latent_transfer` (M2b): a 47.7M-parameter mapper, trained on one laptop GPU, carries Qwen2.5-0.5B's KV cache into SmolLM2-360M, a different model family. On 300 SQuAD validation questions the receiver scores F1 0.757; with the sender's cache zeroed it falls to 0.156, the no-passage level. These are small models, and we do not claim it beats reading the text. See [docs/m2b-transfer.md](docs/m2b-transfer.md).
  - `latent_team` (M2c): subagents pass KV working memory instead of text, and only the solver writes. On Qwen2.5-3B and 200 GSM8K test questions, the team at 40 latent steps scores 0.835 against 0.780 for a team that writes text, with 72% fewer generated tokens and 1.85× faster, so its gate passes. It passes again on a second seed and on a disjoint sample. It does not beat the same model solving alone (0.820), and the text team is held back by truncated plans. Random vectors in place of the hidden states score 0.505. See [docs/m2c-latent-team.md](docs/m2c-latent-team.md).
- **How we built it:** two people, each with their own agent. The agents coordinated all day through typed handoff packets in a separate repo, and CI rejected malformed ones. Every feature has an eval written before the code ([docs/evals.md](docs/evals.md)) and an independent review.
- **Tests on `main`** (17ecef0, Windows, measured 2026-11-16): node 139 of 140 (1 skipped), Python runtime 131 run (24 skipped: 21 need torch, 3 need symlink rights). Playwright lists 13 tests; it last passed 13 of 13 in cycle 10.

## Run locally

Requires Node.js 22.14 or later.

```sh
npm ci
npm start
```

`npm start` prints a one-time sign-in link (`http://127.0.0.1:4317/login?code=...`). Open it within 60 seconds: it works once and signs the browser in with a cookie for 12 hours, or until the server restarts. For a new link, run `npm run --silent ledger -- login` (with the same `PORT` and `CONTEXT_LEDGER_DB` as the server). Without signing in, the page loads but every request says how to sign in.

Then choose the source agent and a JSONL file, then select **Import transcript**. Search terms are case-insensitive, and every term must appear somewhere in the session. The agent filter limits the results to Claude Code or Codex.

The browser takes files under 8 MiB. Import a larger one from a terminal. The command reads the file as a stream and writes to the same database, whether or not the server is running:

```sh
npm run --silent ledger -- import --provider claude path/to/session.jsonl
```

While the server is running, search and export from a second terminal:

```sh
npm run --silent ledger -- search --provider claude deployment
npm run --silent ledger -- handoff SESSION_ID
```

Every session belongs to a project. The browser imports into `default`; `POST /api/import` takes an optional `project` slug (lowercase letters, digits and single hyphens, at most 64 characters) and creates the project on first use. `--project acme` on `search`, or `project=acme` on `GET /api/sessions`, lists one project. Importing a file that is already stored keeps it in the project it already has.

Replace `SESSION_ID` with an ID from the search results. The handoff is Markdown with the source filename and original JSONL line number for each turn. Share the selected packet with the receiving agent when you want it to have that context.

Threads from T3 Code v0.1.10 can be imported from a copy of its database that you make: `npm run --silent ledger -- import-t3 COPY --list`, then without `--list`. Only threads run by Claude Code or Codex are imported. See [Importing T3 Code threads](docs/integrations/t3code-import.md).

To send a hand-off someone can check, create a key once with `npm run --silent ledger -- keygen` (it prints the key fingerprint; give that to the receiver out of band), then sign into a new folder with `npm run --silent ledger -- handoff SESSION_ID --sign FOLDER`. The receiver runs `npm run --silent ledger -- verify FOLDER --fingerprint "FINGERPRINT"`, or checks it with OpenSSL alone. Signing does not redact the transcript text. See [signed hand-offs](docs/signed-handoff.md).

## Data and scope

The server binds to IPv4 loopback and stores data in `.context-ledger/ledger.sqlite`. Set `PORT` or `CONTEXT_LEDGER_DB` to override those defaults. The database contains transcript text. Back it up or remove it as needed when the app is stopped.

Every request outside the page itself needs an access token. At each start the server writes a new random token to a file next to the database, named for its port (`.context-ledger/ledger.sqlite.4317.token` by default). Only you can read it: mode 0600 on macOS and Linux, and on Windows an ACL with one entry for your account. The CLI and the MCP adapter refuse a token file that other users can read or that another account owns. Keep the database in a folder where other users cannot replace files (your user profile qualifies). The file also names the server's port. The CLI and the MCP adapter read the file for their `PORT` and send the token, but only to that port on 127.0.0.1; the browser never sees it and uses the sign-in cookie instead. A clean stop (Ctrl-C) removes the file. The server's default database is relative to the folder you start it in, while the CLI and the MCP adapter default to this repository's `.context-ledger/ledger.sqlite`: start the server from the repository, or give all three the same absolute `CONTEXT_LEDGER_DB`. Servers on different ports can share a database; each has its own token file. A second server on the same port fails to start. The token keeps out other users on the machine (as long as the folder is private) and browser pages; it does not protect against programs running as you, which can read the file. Browsers send a cookie to every port on 127.0.0.1, so while you are signed in, do not open pages served by other local programs you do not trust in the same browser.

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

## Connect an agent over MCP

`src/mcp.mjs` is a stdio MCP server that forwards to the running ledger. Start the ledger with `npm start` first; the MCP server reads `PORT` (default 4317) to find it, and reads the ledger's access token for that port from the file next to `CONTEXT_LEDGER_DB` (default: `.context-ledger/ledger.sqlite` in this repository) on each call. It offers `session_search` and `session_read` (find an imported session and read its numbered turns, the line numbers a graph must cite), `graph_schema`, `graph_publish`, `graph_read`, `context_for` (with an optional `question` and token `budget`, it returns only the matching nodes and their neighbours), `room_open` and `room_read`, `graph_list` and `room_list` (find graphs and rooms without being given an ID, newest first), `graph_diff` (what changed between two snapshots of one party's graph; also `GET /api/graphs/NEW/diff?from=OLD`), and the latent tools. Agents can open and read rooms. The MCP server has no tool to confirm proposals: people do that in the browser, though the ledger does not verify who sent a decision (see Negotiation room).

Every tool result is at most 40,000 characters of escaped text, because agents cut longer results without saying so. Agents cap tokens, so digits and punctuation count as two characters and characters outside ASCII as four: a page of code, JSON or Han script is smaller, at about the same token count as 40,000 characters of English. A longer result comes in pages and says how to get the rest: a JSON result has `more` as its first key (`more.fromItem` for `graph_read` and `room_read`, `more.after` for the lists), and a partial text result starts with a line `[Partial result: ...]` and ends with the same note, which names the arguments to send next (`fromLine`, `fromOffset`, `fromPath`). Only that first line marks a text result partial: data can end a result but never starts one. A result that fits is exactly what it was before paging. `GET /api/graphs` and `GET /api/rooms` back the two lists and take `limit` (1 to 100, default 20), `after` and the filters `sessionId`, `graphId` and `party`. `GET /api/sessions` pages only when it gets `limit` or `after`, so the browser and the CLI still get every match. The ledger file carries a schema version (`PRAGMA user_version`) and upgrades an older file in place; graphs and rooms stored before that list with `createdAt: null`.

One command connects both agents:

```sh
npm run ledger -- install            # add --dry-run to see the changes first
npm run ledger -- uninstall          # take the instruction blocks out again
```

`install` registers the server with each agent's own CLI at user scope (`claude mcp add --scope user` and `codex mcp add`), and adds a short marked block to each agent's user instruction file: `~/.claude/CLAUDE.md` and `AGENTS.md` in `CODEX_HOME` (default `~/.codex`). The block tells the agent to check the ledger before asking you to repeat context. A server already registered under the name `context-ledger` is left as it is. Running it again replaces the block rather than adding another. `--agent claude` or `--agent codex` limits it to one agent, and `CONTEXT_LEDGER_CLAUDE_BIN` or `CONTEXT_LEDGER_CODEX_BIN` names a CLI that is not on `PATH`. A `PORT` other than 4317 is passed on to both servers, and so is `CONTEXT_LEDGER_DB` when it is set (as an absolute path, so the agents find the token of a ledger on that database). `uninstall` removes the blocks and prints the commands that remove the two registrations, for you to run: neither CLI shows an entry exactly enough for the ledger to be sure it is the one install made.

To set it up by hand instead, for Claude Code:

```sh
claude mcp add context-ledger -- node /absolute/path/to/context-ledger/src/mcp.mjs
```

Codex, in `~/.codex/config.toml`:

```toml
[mcp_servers.context-ledger]
command = "node"
args = ["/absolute/path/to/context-ledger/src/mcp.mjs"]
# Only needed when the ledger runs on another port or database (use an absolute path).
env = { PORT = "4317" }
```

T3 Code runs Claude Code and Codex with their own configuration. Whether its sessions load the servers registered for the CLIs is unverified; [docs/integrations/t3code.md](docs/integrations/t3code.md) gives the steps for Claude and manually configured Codex, and a check from a new thread.

In Capy, add it as a local (STDIO) server for threads that run on your own computer: see [docs/integrations/capy.md](docs/integrations/capy.md).

Point clients at `node` directly rather than through npm: npm prints a banner on stdout, which must carry only protocol messages. Graph labels and briefings come from transcripts. Tools return them as escaped data, and agents should treat them as data, not as instructions.

## Decisions beside code (Graphify)

The ledger can export graphs as node-link JSON, the format Graphify keeps in `graphify-out/graph.json`, so its `merge-graphs` can put decisions beside a code graph. Put every graph you want together, such as both parties of a room, in **one** export: Graphify keeps links between graphs only inside one file. From the folder that holds the code graph, with the ledger running and two graph IDs from `graph_list`, in Git Bash:

```sh
LEO='paste the first graph ID'; ALI='paste the second graph ID'
node /path/to/context-ledger/src/cli.mjs graph export "$LEO" "$ALI" > graphify-out/ctm-decisions.json
graphify merge-graphs graphify-out/graph.json graphify-out/ctm-decisions.json --out graphify-out/merged.json
```

Run the CLI with `node`, not through npm, whose banner would land in the file. In cmd, give the IDs directly instead of the variables. Redirect from Git Bash, cmd or PowerShell 7.4 or later: Windows PowerShell 5.1 writes a byte order mark or UTF-16, which Graphify cannot read. `GET /api/export?graph=ID&graph=ID` returns the same JSON for download.

Each node is `ctm_<graph>__<node>` and keeps its label, kind, party, cited lines and the transcript's file name. Each edge, and each link between two graphs of the export, becomes a link; links to graphs left out are counted in `graph.links_left_out`. The export is undirected, as Graphify's graphs are, and `merge-graphs` may swap a link's ends; `ledger_from` and `ledger_to` keep the direction.

## Two-agent demo

[docs/demo.md](docs/demo.md) is the run sheet for the stage demo: Claude Code and Codex on one laptop share context through one ledger, using the synthetic transcripts in `demo/`. `node demo/rehearse.mjs` runs the whole flow with both CLIs and times the handoff. `node demo/publish-reference.mjs` is the fallback when an agent stalls.

## Ask about files with a local model (M2a, warm latent pool)

`latent_read` lets Claude or Codex ask about local files without reading them. A local open model reads the files once, and its KV cache for that prefix stays warm in vLLM. Worker calls answer sub-questions from the shared cache, and the agent receives a short answer with findings that cite file lines. The ledger drops any finding that cites a line that doesn't exist. The contract is in [docs/latent-read.md](docs/latent-read.md). The runtime is Ali's side, in `runtime/`.

Start the ledger with the folder the model may read:

```sh
LATENT_ROOT=/path/to/project LATENT_URL=http://127.0.0.1:4320 npm start
```

Agents call the `latent_read` MCP tool with `paths` relative to that folder and a `question`. If the runtime is not running, the tool returns the numbered file text instead, so the agent can still read the files itself.
