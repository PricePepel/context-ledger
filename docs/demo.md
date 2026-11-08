# Two-agent demo: Leo on Claude Code, Ali on Codex

Leo works in Claude Code and Ali works in Codex. Their agents never see each other's chat. They share context through one Context Ledger: each agent publishes a cited graph of its person's goals, decisions, offers and open questions, the room pairs the two graphs, and Leo and Ali confirm or reject each proposed match in the browser. Ali's Codex then answers a question about Leo's plans from the graph briefing instead of Leo's transcript.

The transcripts are synthetic: [demo/leo-orbit.jsonl](../demo/leo-orbit.jsonl) (Claude Code format) and [demo/ali-orbit.jsonl](../demo/ali-orbit.jsonl) (Codex format). Two of Leo's facts change mid-session: the port moves from 4400 to 4317, and the recording moves from Sunday to Saturday at 17:00. A receiver that keeps the first mention gets them wrong.

## Setup

Everything runs on one laptop: the ledger, Claude Code in one terminal (Leo's side) and Codex in another (Ali's side), plus one browser window for the room. Nothing depends on the venue network except the two model APIs.

```sh
npm ci
npm start   # http://127.0.0.1:4317
```

Connect both agents to the same ledger. Use absolute paths and call `node` directly, not npm.

Claude Code:

```sh
claude mcp add context-ledger -- node /absolute/path/to/context-ledger/src/mcp.mjs
```

Codex, in `~/.codex/config.toml`:

```toml
[mcp_servers.context-ledger]
command = "node"
args = ["/absolute/path/to/context-ledger/src/mcp.mjs"]
# Codex asks before every MCP call unless the server's tools are approved.
default_tools_approval_mode = "approve"
```

The ledger accepts only `127.0.0.1` and `localhost`, so a second laptop could only join through an SSH port forward. The demo doesn't need one.

## Stage flow

1. **Import.** Open http://127.0.0.1:4317. Leo imports `demo/leo-orbit.jsonl` as Claude Code and Ali imports `demo/ali-orbit.jsonl` as Codex.
2. **Leo's Claude publishes.** Paste `leoPublish` from [demo/prompts.mjs](../demo/prompts.mjs). The agent returns a graph ID (LEO_ID).
3. **Ali's Codex publishes and links.** Paste `aliPublish` with LEO_ID filled in. The agent returns a second graph ID (ALI_ID).
4. **Room.** Paste both IDs under **Negotiation room** and select **Open room**. Each person selects **Confirm** or **Reject** under their own name. Agents can't settle a proposal; no tool exists for it.
5. **Handoff.** Paste `aliHandoff` with LEO_ID filled in. Expected answers: 4317, Saturday at 17:00, and who owns the GPU box.

The rehearsal script sends the same prompts. The ledger's errors name the edge or link that broke a rule and the kinds it allows, so an agent fixes a rejected packet in one retry. A link to a decision the other party has replaced is rejected, so the room never shows a conflict with an outdated plan.

Publishing takes an agent one to two minutes. For a five-minute slot, run steps 1–3 before going on stage and show the room and the handoff live.

**Fallback.** If an agent stalls, publish the hand-written reference graphs and open their room:

```sh
PORT=4317 node demo/publish-reference.mjs
```

## What the numbers support

- Same accuracy from the graph briefing as from the raw transcript: 18/18 and 12/12 in the rehearsals.
- Fewer tokens: the meter estimates 72% fewer for the short demo file and 99% for a long session.
- Faster only on long sessions. At about 67k transcript tokens, the Codex handoff took 10.6 s from the graph against 33.7 s from the paged transcript, with two runs each. On the short demo file the times were equal.

## Rehearsal script

`node demo/rehearse.mjs` runs the whole flow without a person. It starts its own ledger on port 4327 with a temporary database, imports both transcripts, runs Leo's Claude Code (`claude -p`) and Ali's Codex (`codex exec`) against it over MCP, opens the room and runs the timed handoff. The handoff asks Ali's agent the same six-part question twice: once reading Leo's raw transcript (`session_read`) and once reading the graph briefing (`context_for`). Each reply is graded against the expected answers.

```sh
node demo/rehearse.mjs --runs 3                 # Codex as Ali
node demo/rehearse.mjs --ali claude --runs 3    # Claude on both sides
node demo/rehearse.mjs --chatter 150 --runs 3   # a longer session for Leo
node demo/rehearse.mjs --wait-room              # pause until people settle the room in the browser
```

Reports go to `demo/out/` (ignored by Git). The script spends model credits on both CLIs. Results are in the eval log.
