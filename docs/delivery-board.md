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
| C10 Bounded MCP results and discovery | Claude Code (for Ruslan) | PR #8, `ruslan/mcp-paging-discovery` | Paging under one bound, `graph_list` and `room_list`, schema version 1; round 3 test gaps; lowercase party guidance | Done (merged 2026-11-12) |
| G7 Quoted or inferred nodes | Unassigned | — | Mark each graph node quoted (its evidence lines contain the label's facts) or inferred at publish time, reusing the latent quote check; show the mark in `context_for` and the browser | Backlog |
| G8 One-command agent setup | Unassigned | — | `ledger install` registers the MCP server for Claude Code and Codex and adds a short "check the ledger first" block to their instruction files; `ledger uninstall` removes both | Backlog |
| G9 Scoped context with a budget | Unassigned | — | `context_for` with a question and a token budget returns only the matching nodes and their neighbours, instead of the whole briefing | Backlog |
| G10 Published handoff benchmark | Unassigned | — | A `BENCHMARKS.md` for the transcript-vs-graph handoff: fixed fairness rules, more graded facts than six (some after page 1), a second grader checked against the first, and a spend log per run | Backlog |
| G11 Graph diff between snapshots | Unassigned | — | What changed between two graphs of one party (added, removed, superseded nodes), for agents and for a room whose graph was republished | Backlog |
| G12 Export for code-graph tools | Unassigned | — | Export a decision graph in a node-link JSON that code-graph tools such as Graphify can merge, so decisions can sit beside code | Backlog |
| C11 Latent runtime performance baseline | Claude Code (for Ruslan) | `ruslan/latent-perf` | Measure time to first token, prefix-cache hit rate, tokens per second and memory per request on the 4090; then measure FP8 KV cache, n-gram speculative decoding, files on the WSL disk and FP8 weights | In review |
| C12 Multi-LLM latent runtime | Claude Code (for Ruslan) | `ruslan/multi-llm` (on C11) | M2a pool on Llama 3.1, Mistral and Granite through vLLM; M2c latent team beyond ChatML (Phi-3.5, Granite) and on an untied model | In progress |

Cards marked "after P1" depend on the new storage layer; build them on `product/v1` once P1 is Done. Cards G7 to G12 come from a read of the public Graphify repository (2026-11-12): ideas only, no code copied.
