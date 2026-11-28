# Competitive research: Linger

*Researched 2026-11-26. Sources: the `simplexai-labs/linger` GitHub README, its docs folder (`wiki-and-memory.md`, `team-md.md`, `task-delegation.md`, `model-scheduling.md`, `proactive.md`, `architecture.md`, `local-inference.md`), and docs.heylinger.com (`knowledge/personal-memory`, `rooms/team-md`, `concepts/memory-layers`, `concepts/where-your-data-lives`, `security/approvals`, `developers/teamhub-cli`), plus the repository's issues and releases pages. I didn't install or run it. Four pages went unread when the scraper's daily limit ran out: `knowledge/memory` (agent memory), `concepts/agents-rooms-contexts`, `reference/cli` and the benchmarks page. Confidence: high on the documented mechanisms, which are specific. Low on its numbers: the LoCoMo score is a README image with no method.*

## Summary

Linger is an **open-source personal agent that runs on your own computer**. It is a whole stack: a local inference engine for mixture-of-experts models, a server ("TeamHub") on PostgreSQL, a desktop app, and adapters that run Claude Code, Codex, Pi and Antigravity as the agents. A personal agent ("Another Me") reads your mail, chats and meetings, keeps a wiki about your clients, contacts and projects, and runs teams of agents and background tasks for you. The repository went public on 2026-11-10 and had 4.8k stars and 28 contributors two weeks later.

**The core difference from us:** Linger is a place agents *live*. Context Ledger is a record that agents *hand over*. Linger owns the runtime, the model and the memory, and everything happens inside it. The ledger sits on top of whatever agents a developer already runs, imports their transcripts when asked, and lets a second agent or person check each claim against the line it came from.

**It is closer to us than Mem0 on provenance.** Mem0 keeps an LLM's conclusion and drops the source ([competitive-mem0.md](competitive-mem0.md)). Linger's wiki facts "cite the message or file version they came from", and a rewrite "must keep every source the old text cited or say why it dropped one". So "we cite, they don't" is not true against Linger. What still holds:

- **A person confirms each claim with us; the app checks them in Linger.** A model proposes every wiki change and the app checks it against the page it replaces. No person approves a fact.
- **The ledger's history is complete; Linger's is short.** Linger's Change Log keeps the newest 20 lines per page. Our review events are an append-only hash chain over the whole ledger (ADR-17).
- **A second party can verify a ledger claim; Linger serves only its owner.** Linger's memory is scoped to one person and their agents. It has no export, no signed bundle and nothing a client or teammate can check.

Its market is different too. Linger is a personal assistant for one person's mail, calendar and meetings. We serve developers handing coding work between agents and between people. It is a **neighbour, not a substitute**, and its design notes are worth more to us than its users.

## 1. The project

| | |
|---|---|
| Who | simplexai-labs. The pitch is "break Big Tech's grip on AI" with local models on consumer hardware. |
| Released | First public commit 2026-11-10, a squash of a private repository. Desktop 0.1.0 to 0.1.10 shipped between 2026-11-10 and 2026-11-26. |
| Activity | 1,131 commits, 129 branches, several commits a day. 29 open and 59 closed issues. |
| Community | 4.8k stars, 457 forks, 28 contributors (the `claude` and `codex` bot accounts among them). |
| Code | TypeScript 56%, Go 38.5%. vitest and an `e2e/` folder; no coverage figure. |
| License | "Linger Open Source License": Apache 2.0 with extra conditions. I didn't read the conditions. |
| Platforms | Desktop app for macOS 14+ on Apple silicon, Windows x64 and Linux x64 (glibc 2.35+). Docker Compose for the rest, with at least 5 GiB for its VM. |
| Hardware claim | A 125B MoE model at 45.5 tokens per second on an RTX 3060 12 GB with 64 GB RAM, by keeping busy experts on the GPU and the rest in RAM or on SSD. Not checked. |

## 2. Memory

### Three layers

- **Personal wiki**, one per person, which every agent working for that person can search.
- **Agent memory**, one per agent, which "crosses Rooms but not agents".
- **`memory.md`**, "the short portrait Another Me reads in every chat".

### Capture is automatic

- Connecting a mailbox backfills "the last few months" of mail. After that, "new mail arrives each night".
- A Room conversation is ingested "soon after its Room goes quiet", and a meeting page "soon after it ends".
- Separately, the proactive agent polls Gmail, Outlook, Calendar and Slack mentions every 10 minutes, looking for things you need to decide.
- Agent memory reads only Room conversations. Delegated tasks and document work are left out.

### The wiki

- **Raw** keeps the originals plus "short facts pulled from your conversations". Fact extraction and search are credited to Hindsight (vectorize-io).
- **Wiki pages** are typed Markdown: Client, Contact, Project and Topic pages ("one page per real-world entity"), Session pages that link to the entities they touched, and daily and weekly reports. Pages link to each other; there is no separate graph database.
- **Size limits.** Summary sections hold up to 3,000 characters. Lists hold 20 entries of 500 characters, and past that the oldest are merged into one dated entry.
- **Nightly refresh.** It starts at midnight in the server's time zone and updates only the pages that day's sources touched. It gets 150 minutes of model time, a 4-hour cap overall, and starts no new step after 3.5 hours.

### How a page changes (the part to study)

- A model proposes changes section by section, and "the app checks every change against the page it replaces".
- A summary section is either kept or rewritten "with a stated reason".
- List entries change one at a time, by an ID the app assigns, not the model.
- Every fact cites its source message or file version. A rewrite keeps every source the old text cited, or says why it dropped one.
- The Change Log "is written by the app, not the model": one dated line per rewrite, edit, retraction or merge, newest 20 kept.
- Conflicts: "What you say now wins". A correction is used at once, the page is rewritten the next night, and the Change Log records it. The docs describe no decay, no staleness model and no way for a person to make it forget something.

### Retrieval

- Agents run `teamhub knowledge search`. The server scopes results by the agent's registration, so an agent searches only its own person's knowledge.
- One search returns two ranked lists, wiki pages with reports and the originals, with the text around each hit.
- Ranking is PostgreSQL full-text search, run once for the query and once for each of up to six alternate wordings (translations among them), merged by reciprocal rank fusion with a time-aware vote. "Search uses keywords only, with no embedding or reranker model."
- An agent "must search the originals before it says something was never recorded".
- Anything that changes (a date, a role, an amount) is checked "against its latest source" before it is stated as current.

### Agent memory

| Stage | When | What happens |
|---|---|---|
| Extract | Every 5 successful runs | A session summary plus candidate memories |
| Consolidate | After 6 hours idle, or at compaction (early at 64 KB or 30 conversations) | Merges candidates, drops duplicates and "disproven facts" |
| Recall | The first message of a session | The summary index is attached |

The summary is attached as "a hidden note on a message, never in the system prompt", so the prompt cache stays valid. It keeps preferences, procedures, decisions and lessons, and leaves out "progress notes, generic advice, secrets and guesses".

### Where data lives

- Server-side PostgreSQL plus artifact storage, under `~/.simplexai/instances/desktop` for the quick install or in Docker volumes. Read-only copies sit in each agent's workspace.
- Memory and wiki calls run on the agent's own model. If that model is remote, "it receives the input needed".
- Data also leaves through Composio (which holds the app keys), Soniox (speech) and xAI, when those are enabled.
- Saved API keys are encrypted (`TEAMHUB_SECRET_ENCRYPTION_KEY`). Encryption of the memory itself is not documented.

### The LoCoMo claim

"Linger 95%, Zep 94.7%, Mem0 92.5%" appears only as a README image. I found no harness, model, judge or settings in the pages I read, and the benchmarks page was one I couldn't reach. Treat it as marketing until a method is published.

## 3. Agent teams

### team.md

- YAML front matter names a `collaborate_pattern`: `classify-and-act`, `fan-out-and-synthesize`, `adversarial-verification`, `tournament` or `loop-until-done`.
- Then a `## Task Goal`, an `## Orchestrator` (name and agent ID), and `## Team Member` entries, each with an ID, a role, "Report to" and "Receive from".
- An agent in the Room writes it (usually Another Me, with the `collaborate` skill, after a plain request). It invites existing agents, creates missing ones, and publishes with `teamhub room collaborate`. A background task cannot publish a plan.
- TeamHub accepts the file only if every ID is an agent in the Room. Each publish replaces the whole file and @mentions every member. Members read it with `teamhub room protocol` and start when their inputs are ready.
- **It is soft.** The order "is guidance that the agents follow, not a rule that Linger enforces", and "the plan grants no permission". Handoffs are ordinary Room messages. The UI draws a collaboration graph.

### Background tasks

- The chat agent hands a task to a copy of itself, up to 10 per agent, each with its own session and workspace.
- The copy does not read the chat: "the brief carries what it needs". It never asks the user anything; its questions go into its report.
- Output goes to `playground/<task-id>/`, which other tasks from the same Room can read.

### Approvals

- Each action passes rules on the computer, then reuse of an earlier approval card, then an LLM review that scores it low, medium, high or critical. Critical is refused outright.
- Sending mail or Slack messages, and writes to Notion or GitHub, always wait for a person's card. A confirmation card expires after 24 hours, an authorization card after 30 minutes, and a card raised by a background task after 10 minutes.
- Pi skips the computer-side checks.

### Model scheduling

- One priority queue per model endpoint: approvals, then recording, chat, conversation work, tasks and documents, compaction, and last the memory and wiki jobs.
- The number of requests at once adapts: it rises while a probe stays within 1.3x of single-request speed and backs off past 1.8x.
- Higher-priority work preempts lower work, which yields a session it can resume. Codex's own sub-agents are turned off.

## 4. Interfaces

- **No MCP server for memory.** The `teamhub` CLI "replaces per-tool MCP servers": 155 commands (56 TeamHub, 99 connectors) over HTTPS with a token per agent, generated from an OpenAPI contract.
- **Outside agents can use it.** The CLI "works without an active run", so an agent elsewhere with its own token can call it, though Room and task commands then fail with `configuration_error`. How such an agent gets a token isn't in what I read.
- **It uses MCP as a client.** Playwright MCP, dynamic MCP sync for Pi, and an open issue asking for custom Streamable HTTP MCP connectors.
- **No transcript import and no latent sharing.** Nothing documents importing Claude Code or Codex session files from outside, or passing hidden states or KV caches between agents. KV cache comes up only as a quantization setting for fitting models.

## 5. Linger vs Context Ledger

| | Linger | Context Ledger |
|---|---|---|
| What it is | A personal-agent platform: runtime, local models, server, desktop app | A record and handoff layer on top of the agents you already run |
| Main user | One person and their assistant: mail, calendar, meetings, clients | Developers handing coding work between Claude Code and Codex, and between two people's agents |
| Unit stored | Originals, extracted facts, and wiki pages per entity | Imported transcripts, plus graph nodes that cite their lines |
| Citations | Yes: facts cite a message or file version, and rewrites must keep sources | Yes: nodes cite transcript turns or artifacts, and are marked quoted or inferred |
| Who decides what is true | A model proposes and the app checks. "What you say now wins" in chat. | A named person approves, edits or rejects each node hash (ADR-7c). No MCP tool can. |
| History | Change Log, newest 20 lines per page, written by the app | Append-only, hash-chained review events over the whole ledger (ADR-17), with the head in signed bundles (ADR-18) |
| Proof for a second party | None: memory is scoped to its owner | Signed bundle with `ledger verify` and an OpenSSL path |
| Capture | Automatic: mailbox backfill, nightly mail, Rooms when they go quiet, 10-minute polling | Explicit import only (AGENTS.md section 6) |
| Where data lives | Local server, but remote models, Composio, Soniox and xAI can receive data | Local only: loopback server, SQLite, no egress in v1 |
| Search | Postgres full-text search over up to six rewordings, fused by rank, with a time vote; no embeddings | Keyword session search today; FTS5 where the Node build has it (§5.1) |
| Multi-agent | team.md plans (soft), background copies, rooms of agents | Rooms of two graphs with confirmed matches, the swarm, the latent team (M2c) |
| Latent or KV sharing | None documented | M2b transfer and the M2c latent team on one open model |
| Agent interface | `teamhub` CLI, 155 commands, token per agent | stdio MCP (`context_for`, `graph_publish`, `room_open` and others) and the CLI |
| Inference | Its own engine (PolyStrata/Strata) for MoE models on consumer GPUs | vLLM in `runtime/`, for the swarm and latent work |
| Scale | Two weeks public, 4.8k stars, 28 contributors, 0.1.x | Hackathon project, small evals in `docs/evals.md` |

**Where they overlap:** both keep cited, searchable memory on the user's machine, and both coordinate several agents through a shared written plan or graph. A developer who already uses Linger for everything gets a cited personal wiki and agent teams from it, and may not see why a ledger is needed.

**Where we differ, and why it would be hard for them to follow:**

1. **Human sign-off per claim.** Linger's design is an assistant that acts for you and asks only before outward actions. A review step on every fact would go against its "proactive Another Me" pitch.
2. **Proof for someone else.** Linger's memory is one person's. Signed, verifiable handoffs to a client or another developer are not on its path.
3. **Works with the agents a developer already has.** Linger wants to be the place Claude Code and Codex run. The ledger imports their transcripts wherever they ran.

**Where they are clearly ahead:** the wiki pipeline (typed entity pages, nightly refresh, size limits, sources kept on rewrite), retrieval across rewordings, a scheduler that shares one GPU between chat and background work, approval cards with expiry, and momentum.

**Possible integration, not checked:** Linger runs Claude Code and Codex as its agents, so their session files should exist on the computer and the ledger could import them. Whether Linger keeps those files, and in what format, is an open item.

## 6. What to take from them

1. **"A rewrite keeps every source or says why it dropped one."** Apply it to graph republishes: when a node in a new version loses a citation the old version had, the publish must give a reason, and the graph diff (G11) shows it. Card idea: `Backlog: citation-drop reason on republish`.
2. **Search over rewordings, fused by rank.** Run `session_search` for the query and a few rewordings, then merge with reciprocal rank fusion. It needs no embedding model and no new runtime dependency, which fits §5.1. An eval belongs in `docs/evals.md` first.
3. **"Search the originals before saying it was never recorded."** Add this rule to the drafting skill and the `context_for` briefing, so an agent doesn't report a decision as missing just because no graph node holds it.
4. **Check changeable facts against the latest source.** Dates, owners and amounts in a briefing get the newest citing line, which fits superseded decisions.
5. **Briefings as a hidden note, not the system prompt.** If we ever offer a SessionStart briefing, attaching it to the first message keeps the agent's prompt cache valid.
6. **A named pattern for rooms and the swarm.** Their five `collaborate_pattern` values (`fan-out-and-synthesize`, `adversarial-verification` and the rest) are a small vocabulary we could reuse for swarm runs and room purposes.
7. **A priority scheduler for one GPU.** The swarm, the latent team and `latent_read` share the laptop GPU. A queue that lets an interactive read preempt a background batch would help once more than one runs at a time.
8. **Don't copy:** automatic mailbox backfill and polling (AGENTS.md section 6 requires consent for every import), a history that keeps only the last 20 changes, or a plan that "grants no permission" but reads like one.

## 7. Positioning line

> Linger remembers for you. Context Ledger proves it to someone else.

Use it carefully. Against Linger, "we cite and they don't" is false. The honest claim is that a named person confirmed each fact, the whole history is kept, and a second party can verify it without trusting either agent.

## 8. Open items

- Run the desktop app or Docker setup once on a synthetic mailbox and transcript to see a wiki page, its citations and its Change Log as stored.
- Read the four pages the scraper didn't reach: agent memory, agents-rooms-contexts, the CLI reference and the benchmarks page.
- Find whether a LoCoMo harness or method exists anywhere in the repository.
- Read the extra conditions in the Linger Open Source License before suggesting anyone build on it.
- Check whether Linger keeps the Claude Code and Codex session files of the agents it runs, which would let the ledger import them.
