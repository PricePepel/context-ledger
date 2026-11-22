# Delivery board

Claim a card before working on it (AGENTS.md section 2). States: Backlog, Ready, In progress, In review, Done.

| Card | Owner | Branch or PR | Scope | State |
| --- | --- | --- | --- | --- |
| C3 Semantic graph handoff | Claude Code (integrating for Codex) | PR #1, `feature/semantic-graph` | Graph packets, API, CLI, review fixes | In review |
| P0 Product strategy | Claude Code | `product/strategy`, `product/v1` | Research, product plan, UzCombinator validation | In progress |
| P1 Architecture and foundation (wave 1) | Claude Code workflows | `product/v1` | `docs/architecture.md`, projects, one row per message, stable IDs, migrations, delete and retention, API token | In progress |
| P2 MCP server and graph v2 (wave 2) | Unassigned | — | Stdio MCP tools, project-scoped graph with message-ID citations and approvals | Backlog (after P1) |
| P3 Reviewer UI (wave 3) | Unassigned | — | Node and evidence side by side; approve, edit or reject | Backlog (after P2) |
| P4 Redaction and signed export (wave 4) | Unassigned | — | Secret scanner, redaction diff, Ed25519 signing, `ledger verify` | Backlog (after P2) |
| P5 Packaging and launch (wave 5) | Unassigned | — | npx install, cross-OS CI, license key, docs | Backlog |
| I1 Large-file streaming import | Unassigned | — | Real data: 16% of Claude Code sessions exceed the 8 MiB HTTP limit; import from a file path with streaming | Ready (after P1) |
| I2 Tolerant JSONL parsing | Unassigned | — | Real data: one corrupt line rejects a whole session; skip and count bad lines instead | Ready (after P1) |
| I3 Codex agent-to-agent messages | Unassigned | — | Real data: `response_item/agent_message` records (author/recipient) are dropped | Ready (after P1) |
| G6 Product review for cycle 4 | Codex | — | Read-only product and eval review | Ready |
| C10 Bounded MCP results and discovery | Claude Code (for Ruslan) | PR #8, `ruslan/mcp-paging-discovery` | Paging under one bound, `graph_list` and `room_list`, schema version 1; round 3 test gaps; lowercase party guidance | Done (merged 2026-11-12, with no GitHub review recorded; the human review of the schema migration is still owed) |
| G7 Quoted or inferred nodes | Unassigned | — | Mark each graph node quoted (its evidence lines contain the label's facts) or inferred at publish time, reusing the latent quote check; show the mark in `context_for` and the browser | Backlog |
| G8 One-command agent setup | Unassigned | — | `ledger install` registers the MCP server for Claude Code and Codex and adds a short "check the ledger first" block to their instruction files; `ledger uninstall` removes both | Backlog |
| G9 Scoped context with a budget | Unassigned | — | `context_for` with a question and a token budget returns only the matching nodes and their neighbours, instead of the whole briefing | Backlog |
| G10 Published handoff benchmark | Claude Code | `claude/g10-handoff-benchmark` | A `BENCHMARKS.md` for the transcript-vs-graph handoff: fixed fairness rules, more graded facts than six (some after page 1), a second grader checked against the first, and a spend log per run. Offline parts only; the paid live runs come after review | In progress |
| G11 Graph diff between snapshots | Unassigned | — | What changed between two graphs of one party (added, removed, superseded nodes), for agents and for a room whose graph was republished | Backlog |
| G12 Export for code-graph tools | Unassigned | — | Export a decision graph in a node-link JSON that code-graph tools such as Graphify can merge, so decisions can sit beside code | Backlog |
| H1 Runtime checks in CI | Claude Code | `claude/h1-runtime-ci` | Run the Python runtime checks on every push and pull request | In progress |
| H2 Docs match what is merged | Claude Code | `claude/h2-stale-docs` | README, handoff notes and runtime docstrings that lag behind `main` | In progress |
| H3 Split the MCP adapter | Claude Code | `claude/h3-split-mcp` | Move the tool groups out of the 1,000-line `src/mcp.mjs` with no change in behaviour | In progress |
| H4 One source for cross-language rules | Claude Code | `claude/h4-shared-rules` | The secret-file rule, whitespace fold and latent grader are kept in step by shared data or shared test cases instead of by hand | In progress |
| H5 Server request table | Claude Code | `claude/h5-server-routes` | One default runtime address and a table of requests in `src/server.mjs`, with no change in behaviour | In progress |
| C11 Latent runtime performance baseline | Claude Code (for Ruslan) | `ruslan/latent-perf` | Measure time to first token, prefix-cache hit rate, tokens per second and memory per request on the 4090; then measure FP8 KV cache, n-gram speculative decoding, files on the WSL disk and FP8 weights | In review |
| C12 Multi-LLM latent runtime | Claude Code (for Ruslan) | `ruslan/multi-llm` (on C11) | M2a pool on Llama 3.1, Mistral and Granite through vLLM; M2c latent team beyond ChatML (Phi-3.5, Granite) and on an untied model | In review |
| C13 Tuning the latent hand-off | Claude Code (for Ruslan) | `ruslan/latent-tuning` (on C12) | Level 1 settings sweep, level 2 trained projection adapter, level 3 LoRA through the latent loop, on Phi-3.5-mini; latent vs random control on a held-back block | In review |
| C14 Self-distilled LoRA targets | Claude Code (for Ruslan) | `ruslan/self-distill` (on C13) | Train the C13 level 3 LoRA on the model's own correct GSM8K train answers instead of the gold solutions; latent vs random with the same weights on the unused block 5 | In review |
| U1 Console v0 | Unassigned | — | Read-only Grafana-style console in the loopback browser app, built on today's API: live graph as agents publish, evidence pane with cited lines highlighted, panels for handoffs, estimated tokens saved, quoted vs inferred nodes and which agent read or published what (aggregate counts only for dogfooding). Review actions stay in P3 | Backlog |
| U2 Brand and mascot | Unassigned | — | Original character, palette and type for the console and video; take Capy's warmth as a reference only, no copied assets or look | Backlog |
| U3 60-second demo video | Unassigned | — | Script and record install, two agents, graph growing, click-through to a cited line; synthetic transcripts only | Backlog (after U1, G8) |
| D1 T3 Code integration | Unassigned | — | Guide for adding the ledger as an outside MCP server in T3 Code, plus an explicit, user-chosen importer for T3's thread store | Backlog |
| D2 Capy integration guide | Unassigned | — | Guide for adding the ledger as an MCP server for a Capy organization | Backlog |
| W1 Latent team watchdogs: integrity and audits | Unassigned | — | One code watchdog per squad of up to 5 latent subagents, reporting to one code supervisor. Thought record (the tokens and weights of each soft thought), exact checks at every hand-off (turn structure, fed vector equals its record, span ledger, memory checksum, budgets), signed number-only reports, fail-closed decisions, three audits (replay, mismatched memory, solver alone) and two drift scores. Design in [watchdog-security.md](watchdog-security.md) | Backlog |
| W2 Data gateway for latent teams | Unassigned | — | Before a squad reads anything: labels by origin, memory built only from what the task needs, placeholders for declared secrets, one label for the whole memory, permissions and budgets fixed before data, rule of two, tool gate. Needed before the latent team reads real files or calls tools | Backlog (after W1) |
| W3 Calibrated abstention | Unassigned | — | A confidence score and a threshold per kind of task so released answers stay under a chosen error rate, with abstention; a probe experiment on our own hidden states; refusals compared alone and as a team | Backlog (after W1) |

Cards marked "after P1" depend on the new storage layer; build them on `product/v1` once P1 is Done. Cards G7 to G12 come from a read of the public Graphify repository (2026-11-12): ideas only, no code copied. Cards U1 to U3, D1 and D2 come from [the console direction](product-direction-console.md) and [the T3 Code and Capy research](competitive-t3code-capy.md) (2026-11-16). Cards W1 to W3 come from Ruslan's direction for the security layer and [the watchdog research](watchdog-research.md) (2026-11-21).
