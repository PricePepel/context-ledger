# Murmur and Context Ledger: fit report

2026-11-09. Research note, not a commitment. No eval cycle is opened by this file.

Sources read in full:

- Murmur `instavm/murmur` at commit `dcd793b` (v0.1.3, Apache-2.0): `src/daemon/murmurd.mjs`, `src/daemon/tools.mjs`, `src/cli/agent.mjs`, `src/skill/skill.md.tmpl` (908 lines together) and the README.
- Context Ledger on `leo/latent-read` at `d7125f5`, [the handoff](handoff.md), [the eval log](evals.md).
- Latent Ledger `README.md`, `ROADMAP.md`, `docs/protocol.md`.

Murmur was read, not run. Every claim about its behaviour below comes from its source. Claims marked "untested" need a live check.

## Verdict

1. **Do not adopt Murmur as a dependency, and do not let context travel through a chat room.** Murmur is a live room of free-text messages. Our mission line is "agents that share grounded context instead of retelling it", and a chat message is a retelling with no citation.
2. **Do borrow four small mechanisms from it, all for M1:** a cursor with a long-poll, liveness hints, a headless supervisor, and marker-block installers.
3. **It points at one real gap we have:** nothing tells an agent, while it works, that the other side has just said "hold off". The eval log records that failure once already (the L14 merge on `ali/latent-pool`).
4. **Murmur v1 cannot connect Leo and Ali at all.** It is same-machine only, with one room and no auth. It fits the one-laptop demo and nothing past it.

## What Murmur is, from its source

| Part | File | What it does |
| --- | --- | --- |
| Daemon | `murmurd.mjs` (149 lines) | One HTTP server on port 9999. Each agent connects to `/mcp/<label>` over Streamable HTTP MCP. All labels share one SQLite file. |
| Tools | `tools.mjs` (255 lines) | `register`, `say`, `poll`, `who`, `history`. Two tables: `messages` and `participants`. |
| Skill | `skill.md.tmpl` (260 lines) | Instructions written into each agent's global instruction file. They carry most of the behaviour: when to join, ack → wip → done, narration, how to return work. |
| Supervisor | `agent.mjs` (244 lines) | Polls the room and runs a fresh headless CLI (`claude -p`, `codex exec`) for each mention. Posts the ack, a heartbeat every 2 minutes and the reply in code. |

Stack overlap with us is high: Node 22, built-in `node:sqlite`, loopback HTTP, MCP. It adds two dependencies we do not have (`@modelcontextprotocol/sdk`, `zod`). We have one (`ajv`) and a hand-written stdio MCP adapter.

### Where the code differs from the README

| README says | Code does | Where |
| --- | --- | --- |
| "Long-poll, not polling. Sends wake all listeners immediately." | `poll` re-queries SQLite every 200 ms until a row appears or the deadline passes. It works, but it is a sleep loop. | `tools.mjs:173-183` |
| Handles are protected ("cross-label collision"). | Only `register` checks the label. `say` takes any `handle` from any connection and never checks that it is registered. Any local client can post as `@human` or `@claude`. | `tools.mjs:105-113` |
| "`@-mention` routing". | `poll` returns every message since the cursor to every agent, with full bodies of up to 16,384 characters and no row cap. The mention filter is optional and the Skill does not use it. | `tools.mjs:165-195` |
| "The daemon binds `127.0.0.1`." | True by default. `MURMUR_BIND` changes it, and there is still no auth. | `murmurd.mjs:25` |
| "Cross-agent requests don't bypass approvals." | True for interactive windows. The supervisor pastes the last 15 room messages and the new one straight into a headless prompt, and runs Cursor with `--trust`. | `agent.mjs:39, 61-79, 193-195` |
| Not mentioned. | The daemon checks neither `Origin` nor `Host`. Our server refuses any write without a same-origin header (`src/server.mjs:27`). Whether a web page can reach Murmur depends on MCP SDK defaults. Untested. | `murmurd.mjs:68-105` |
| Not mentioned. | The Skill tells the agent to join "without confirmation", to treat unknown handles as legitimate, and to return code by branching, committing, pushing and opening a PR. | `skill.md.tmpl:19-21, 221-230, 253-254` |

## Side by side

| | Murmur | Context Ledger |
| --- | --- | --- |
| What crosses between agents | Free text, up to 16 KB a message | Typed graph nodes with evidence lines; latent slices with verified quotes |
| Timing | Live, same machine | Asynchronous snapshots; repo packets between people |
| Transport | One HTTP MCP daemon, a URL per agent | stdio MCP adapter per agent, in front of a loopback HTTP API |
| Who decides | The agent that receives the mention, behind its own approval prompts | People, in the browser. No MCP tool can confirm a proposal |
| Checking | None. An append-only audit log | Evidence validation, quote verification, grounding, an injection tripwire |
| Identity | Self-asserted handle, and `say` is unchecked | Self-asserted party names (a known limit in the handoff) |
| Tests | 53 tests on delivery, reconnects and installers | Playwright journeys, node suites, live gates on answer accuracy |
| Platform | macOS and Linux. Windows "likely", installers assume POSIX homes | Windows and WSL |

## Does it align with the mission?

The roadmap goal is: "any agent can hand work to any other agent with fewer tokens and fewer invented facts than a text handoff, and we can prove it with numbers."

- **Fewer tokens: no.** Every agent reads every room message. Cooperative mode adds two polls to each user turn. The supervisor resends 15 messages of context on every mention. Cycle 7 measured the graph handoff at about 5× fewer input tokens than the raw transcript on a long session, and a chat room moves back toward the transcript. Murmur's own token cost is unmeasured here.
- **Fewer invented facts: no.** `@claude done: tests pass` is a claim nobody checks. Our own runs show a 7B model dropping `7200 s` and `'orbit-mail'` inside one pipeline. A chat relay has no step that would catch that.
- **Provable with numbers: not as built.** Murmur tests that a message arrives, not that an answer is right.

Murmur partly agrees with us. Its Skill says "the room is for coordination, not storage" and sends large payloads to GitHub issues and PRs. So the split is:

- **Its payload channel is against the mission.**
- **Its signalling channel fits it,** and the roadmap already asks for one: M1 lists "event log instead of snapshots, with `changes_since(version)` and MCP resource subscriptions".

`docs/protocol.md` in Latent Ledger says "our agents never talk live". Adding a live signal is a change to that decision, so it needs Ali's agreement before any code.

## When a live channel is actually needed

Needed:

- **Two agents on one shared contract at the same time.** In the L14 merge, Ali's agent posted "hold off" on PR #4 and Leo's agent pushed anyway, because nothing surfaced the comment mid-session. A hold signal would have stopped it.
- **Waking an agent.** Today nothing tells Codex that Claude Code published a graph or opened a question for it. A person has to prompt it.
- **A live demo with two people in the room.**

Not needed:

- **Handing over context.** The ledger does this, with measured savings.
- **Work across days or time zones.** Repo packets and issues already cover it.
- **Latent reads.** One agent, one runtime, no second party.
- **Leo and Ali on two machines.** Murmur v1 cannot do this.

## Ways it would go wrong

1. **Chat becomes the context channel.** Agents paste findings into the room because it is easier than publishing a graph. Guard: the ledger never accepts room text as evidence.
2. **An agent confirms for a person.** A room message `@claude confirm proposal X` looks like a human instruction, and `@human` can be forged. Keep confirmation browser-only.
3. **Injection relay.** Our injection fixture already steered a live model with planted file text. In a room, one hijacked agent's output is the next agent's input, and Murmur's Skill says to trust unknown senders. Our MCP server says the opposite: tool text is data.
4. **Unasked pushes and PRs.** Murmur's default way to return work conflicts with "preserve explicit user control" and with the L14 lesson.
5. **Global config edits.** `murmur init` writes into `~/.claude/CLAUDE.md` and `~/.codex/config.toml`. The Codex config on this machine was found corrupted and rebuilt on 2026-11-07, and Murmur's installers are not tested on Windows.
6. **Progress that is only status lines.** Ack and wip lines show an agent is alive, not that its work is right. Murmur's own test matrix says Claude Code and Codex reply once and then go idle.
7. **Secrets on disk.** Room messages and the first 200 characters of each in the audit log sit in plain text under `~/.murmur`.
8. **Latent packets through chat.** A KV or latent handoff must keep its source spans and receipt in the ledger. A chat line cannot hold either.

## How to implement it

### Option A: run Murmur beside the ledger, unchanged

No code. The room carries only references, such as `@codex context_for <graph id>`. This suits a one-laptop experiment and nothing more. All eight risks above apply, and Windows is untested.

### Option B: build the signal into the ledger (recommended)

This is the M1 "event log" item with Murmur's delivery pattern.

- **`events` table.** Integer ID, kind (`graph_published`, `room_opened`, `question_opened`, `proposal_decided`, `hold`, `release`), party, a reference to a graph, room or node, and a time. No free-text body.
- **`changes_since(cursor, waitMs)` MCP tool.** Murmur's `poll` shape: an integer cursor, block until a row or the deadline. The ledger is one process, so it can wake waiters on insert instead of sleeping 200 ms. The stdio adapter already allows long calls (latent reads use 200 s).
- **Presence.** Update `last_seen` for a party on every tool call. Return it with a publish, as Murmur's `say` does: "ali last seen 7 minutes ago".
- **Hold and release events.** "Leo's agent is editing `ali/latent-pool`", citing the branch or PR. This is the L14 fix.
- **Supervisor, later and off by default.** One headless run per event, given the graph briefing instead of chat history.
- **Installer.** Murmur's marker-block edits (`murmur:start` / `murmur:end`) are a good model for the M1 Codex `config.toml` entry and AGENTS.md snippet, with a backup first.

Size guide: Murmur's daemon and tools are 404 lines together. Ours is one table, one endpoint and one tool on code we already have.

### Option C: fork or embed Murmur

Not recommended. It means two daemons, two SQLite files, two trust models and two new dependencies.

Licence: Apache-2.0. Borrowing the ideas needs nothing. Copying code means keeping its licence and NOTICE text.

### Evals to write before building B

| Eval | Expected |
| --- | --- |
| Delivery | An event from one agent reaches the other's waiting `changes_since` within 1 s. None are lost or repeated across a ledger restart. |
| No retelling | An event holds only IDs and typed fields. A free-text field over the bound is refused. |
| No authority | No event changes a proposal's state. Playwright shows a decision still needs the browser. |
| Injection | An event field that addresses an AI reader is escaped or flagged, as graph labels are. |
| The L14 replay | On synthetic data, an agent with events sees the hold before it pushes; without events it does not. |
| Cost | Events add a small, stated number of tokens per turn against the cycle 7 graph handoff. |

## Using REA on Murmur

- **There is nothing to reverse-engineer.** Murmur is about 900 lines of readable, licensed JavaScript, and this report already covers all of it. REA's JavaScript analysis would list the same modules and imports.
- **What is open is behaviour, not structure.** Three claims above come from reading and are worth a live check in WSL: the forged `say`, the missing `Origin` check, and the 200 ms wake delay. That is a test script against a running Murmur. It needs `npm install` of Murmur's two dependencies.
- **REA setup changes agent configs.** `npx rea-agents setup` runs third-party code and edits the Claude Code and Codex configuration, with backups. It has not been run.
- **Where REA could help this project:** targets with no source. Its model-artifact inspection reads GGUF and safetensors headers, which bears on the M2b mapper registry keyed by model hash.
- **Where not to point it:** the Claude Code and Codex CLIs. They are proprietary, REA's own disclaimer excludes that use, and the documented surfaces (transcript JSONL, hooks, print mode) cover what M1 and M1.5 need.

## Not verified

- Murmur was not run. Its behaviour on Windows is unknown.
- The `Origin` and DNS-rebinding exposure is inferred from the daemon code and not tested.
- Murmur's token cost per turn is not measured.
