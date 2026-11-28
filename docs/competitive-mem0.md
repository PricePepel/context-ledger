# Competitive research: Mem0

*Researched 2026-11-23. Sources: mem0.ai (home, pricing, research), docs.mem0.ai (introduction), the `mem0ai/mem0` GitHub README and file tree, Mem0's Claude Code guide (updated 2026-09-23), their post "Beyond AGENTS.md: shared memory for coding agents across services and repos" (2026-07-29, read as a summary), and TechCrunch plus Mem0's own Series A post (2025-10-28). I didn't sign up or run it. Confidence: high on what it does and how it is built, since the README and guides are specific. Medium on their numbers: every benchmark and usage figure is self-reported.*

## Summary

Mem0 ("mem-zero", YC S24) is a **memory layer you put inside an AI product**. A developer calls `add(messages, user_id=...)` after a conversation. An LLM pulls short "memories" out of it ("vegetarian, allergic to nuts"). Later, `search(query, filters)` returns the few memories that fit the question, and the developer puts them in the prompt. It ships as a hosted API, an Apache-2.0 library (Python and TypeScript) and a self-hosted Docker server, with plugins for Claude Code, Codex, Cursor and other coding agents.

Their pitch has three parts:

1. **Fewer tokens.** About 7K tokens per retrieval call instead of 25K+ for full context.
2. **Better recall.** Self-reported 92.5 on LoCoMo and 94.4 on LongMemEval.
3. **Memory that follows you** across sessions, tools, repos and teammates. Their founder calls it a "memory passport".

**The core difference from us:** Mem0 stores *what an LLM concluded* from a conversation. Context Ledger stores *the conversation*, and every claim points to the line that supports it. Mem0 is built so an agent can recall cheaply. We are built so a person or another agent can check a claim. A shorter way to put it: Mem0 remembers, Context Ledger proves.

They are **the biggest player in agent memory and they are moving toward our use case**. Their July post shows our hackathon scenario almost exactly (agent A changes an API contract, agent B in another repo has to learn about it), and their Claude Code plugin now hooks session start, compaction and session end. What they hand agent B is an unsourced fact. They have no citations, no human confirmation and no local-only default.

## 1. The company

| | |
|---|---|
| Founded | January 2024, pivoted from Embedchain. Founders Taranjeet Singh and Deshraj Yadav, who earlier built EvalAI. |
| Funding | $24M: a $3.9M seed (Kindred Ventures) and a $20M Series A (Basis Set Ventures, with Peak XV, GitHub Fund and YC). Angels include the CEOs of Datadog, Supabase and PostHog. |
| Traction (their figures) | "200,000+ developers". API calls grew to 186M in Q3 2025, about 30% month over month (TechCrunch). The logo wall includes AWS, NVIDIA, Vercel, Dify, Samsung and Adobe, with no detail on how each uses it. |
| Open source | `mem0ai/mem0`: 69.4k stars, 8.2k forks, 415 contributors, 2,681 commits, last commit 2026-11-18. Apache-2.0. About 58% Python and 40% TypeScript. |
| Compliance | SOC 2 (the home page says Type 1, the Claude Code guide says Type II), HIPAA, GDPR, BYOK, a trust center at trust.mem0.ai. |
| Research | arXiv 2504.19413 (2025). The benchmark harness is open in `mem0ai/memory-benchmarks`. They launched DolphinBench this month: 600 tool-based tasks testing whether agents act correctly from memory. |

## 2. Structure: what the product is made of

### Three ways to deploy, one API

| | Library | Self-hosted server | Cloud platform |
|---|---|---|---|
| Setup | `pip install mem0ai` / `npm install mem0ai` | `cd server && make bootstrap` (Docker, dashboard on :3000) | Sign up at app.mem0.ai |
| Auth | none | on by default (admin key, API keys) | API keys |
| Advanced features | none | "teasers" | all |

The README says plainly that the benchmark scores come from the managed platform, "which includes proprietary optimizations not available in the open-source SDK". So the open-source version is a funnel and the platform is the product. A `scripts/` migration from self-hosted Qdrant to the platform, and a `/mem0-oss-to-platform` skill, push users the same way.

### How memory is written and read (the April 2026 algorithm)

- **Write: single-pass, ADD-only extraction.** One LLM call per `add`. It never updates or deletes, so memories pile up and old facts are kept. Facts the agent states ("I deployed X") count as much as facts from the user. Entities are pulled out, embedded and linked across memories.
- **Read: multi-signal retrieval.** Semantic (vector), BM25 keyword and entity matches are scored in parallel and merged. Only the top matches go back to the caller (top_200 budget in the benchmarks).
- **Temporal reasoning.** Each memory is classified by time when it is written. At read time, queries about "current", "past" and "upcoming" are ranked toward the right dated version. Because writes are ADD-only, this is how a newer fact beats an older one.
- **Memory decay.** Recency ranking, run without waiting ("fire-and-forget"), so they claim median latency rises by only +1ms.
- **Storage.** Vector store, key-value store, and an optional graph store. Self-hosting supports 24+ vector databases (pgvector, Mongo, Pinecone, Milvus, Qdrant) and 16+ LLM providers. Defaults are `gpt-5-mini` and `text-embedding-3-small`.
- **Scoping.** Every memory is tagged with `user_id`, `agent_id`, `run_id` (session) and `app_id`, and search filters on those. That is all the isolation model there is.

### Surfaces

- SDKs (Python, TypeScript, sync and async), REST API, CLI (`@mem0/cli`, `mem0-cli`).
- A hosted MCP server at `mcp.mem0.ai/mcp` with nine tools: `add_memory`, `search_memories`, `get_memories`, `get_memory`, `update_memory`, `delete_memory`, `delete_all_memories`, `delete_entities`, `list_entities`.
- Agent plugins in the repo: `.claude-plugin`, `.codex-plugin`, `.cursor-plugin`, `.kimi-plugin`, plus guides for OpenCode, OpenClaw, Antigravity and others. Integrations for 22 frameworks (LangChain, CrewAI, LlamaIndex, Vercel AI SDK).
- Agent skills (`npx skills add ... --skill mem0`, `mem0-integrate`, `mem0-test-integration`), which teach coding agents to add Mem0 to the user's own app.
- **Agent sign-up:** `mem0 init --agent` creates an account and API key in four commands, with no email and no person involved. The owner claims it later.
- A browser extension that shares memory across ChatGPT, Perplexity and Claude.
- **OpenMemory MCP**, a local-first variant. The guide still links to it, but I didn't check whether it is actively maintained.

### The Claude Code plugin in detail

This is where they meet us directly.

- **SessionStart:** announces the `user_id` and tells Claude to call `search_memories`. After compaction, a script stores the compaction summary as a memory tagged `compact_summary`.
- **PreCompact:** stores a session summary as-is (`infer=False`). Session-state memories expire after 90 days. Decisions, conventions and anti-patterns never expire.
- **Task completed / Stop:** reminds Claude to save what it learned.
- **PreToolUse:** `block_memory_write.sh` stops writes to `MEMORY.md` and `.claude/memory/*` and sends them to `add_memory` instead. **They replace Claude Code's own memory store, not just extend it**, even though the guide says Mem0 "isn't competing with Auto Memory".
- It does not inject memories before every reply. It injects a decision rubric and leaves searching to the agent.
- `user_id` is derived from the API key, so anyone using the same key shares the same memory. Team sharing works through shared scopes.

### Pricing (as of today)

| | Free | Custom |
|---|---|---|
| Price | $0, then usage-based billing with a monthly cap you set | contract |
| Adds / retrievals per month | 10K / 1K for the first 30 days with model calls paid by Mem0; after that 50K / 10K with your own LLM key | set to your volume |
| Held back for Custom | none | graph memory, user profiles, "Dream" memory consolidation, advanced analytics, SSO, audit logs, SLA, on-prem |

The pricing page has no public Pro tier any more, yet the Claude Code guide still says graph memory is "on the Pro plan". They seem to have cut the plans down to free with bring-your-own-key, plus enterprise. That makes heavy users pay for their own LLM calls, and keeps the features enterprises want (graph, audit, SSO, on-prem) behind a sales call.

## 3. Value proposition, and how much of it holds up

| Claim | Evidence | My read |
|---|---|---|
| 3 to 4x fewer tokens than full context | About 7K vs 25K+ mean tokens per retrieval call, on their harness | Believable, since this is how retrieval works. The comparison is against stuffing the whole history in, which is a weak baseline. |
| High recall: LoCoMo 92.5, LongMemEval 94.4, BEAM 1M 64.1, BEAM 10M 48.6 | Open harness, LLM judge, platform-only optimizations | Self-reported, and the open-source version won't match it. Recall falls a lot at 10M tokens (48.6), which is the production scale. |
| Persistent across sessions, tools and teams | Plugins, hosted MCP, shared scopes | Real. This is their strongest practical advantage over Claude Code's Auto Memory (one project, 200 lines / 25KB, no search). |
| Built for enterprise | SOC 2, HIPAA, BYOK, air-gapped, read/write audit log | Real, but kept for Custom plans. |
| Drop-in, no pipeline changes | Two calls: `add` and `search` | True for the API. Getting good results still depends on the extraction model (see their "which model should write your memories" post). |

**What the pitch leaves out:**

- **No provenance.** A memory is a sentence an LLM wrote. There is a `session_id` in its metadata, but no quote and no line. If a memory is wrong, nothing shows where it came from or whether the source supports it. ADD-only writes make this worse: wrong facts are never removed, only outranked.
- **The agent decides what is true.** Agents write, update and bulk-delete memories with no review step. Agent sign-up even removes the person from account creation. For one user's preferences that is fine. For a decision that binds two people, it isn't.
- **Cloud by default.** The plugin, MCP and benchmarks all assume `mcp.mem0.ai`. Local use exists (the library, the self-hosted server, OpenMemory), but it is the weaker product.
- **Lossy by design.** Extraction throws away the conversation. "Why did we decide this?" can't be answered from a memory store.

## 4. Mem0 vs Context Ledger

| | Mem0 | Context Ledger |
|---|---|---|
| Unit stored | An extracted memory (a sentence written by an LLM) | The imported transcript, plus graph nodes that cite its lines |
| Can you check a claim? | No source line, only metadata | Yes: every node cites the transcript turn, and is marked quoted or inferred |
| Who decides what is shared or true | The agent (write, update, delete through MCP) | People confirm room matches in the browser. No MCP tool can confirm. |
| Capture | Automatic: every `add`, plus plugin hooks at session start, compaction and stop | Explicit import. No background collection without consent (AGENTS.md section 6). |
| Where data lives | Mem0 cloud by default. Self-hosted or library as an option. | Local only: loopback server, SQLite in `~/.context-ledger` |
| Main buyer | Developers building end-user AI apps (support, healthcare, companions), and developers giving their coding agent memory | Developers handing work between their own agents (Claude Code and Codex) and between two people's agents |
| Retrieval | Vector + BM25 + entity fusion, temporal ranking, decay | Keyword session search, `context_for` briefings from the cited graph, `latent_read` on a local model |
| Conflicting facts | ADD-only, newer ranked first | Graph diff, stale or superseded decisions (G11) |
| Multi-party | Shared `user_id`/`app_id` scope, so everyone sees one pool | Rooms: two graphs, proposed matches, confirmation by each side |
| Scale and proof | 69k stars, $24M, published benchmarks | Hackathon project. Small-scale evals in `docs/evals.md`, no public benchmark. |
| Price | Free with your own key, enterprise on contract | Not decided (ADR-13) |

**Where they overlap:** both say "agents start from zero, and AGENTS.md is static", and both sell continuity between agents across repos and between people. Their July post walks through our scenario: agent A rewrites a contract and agent B in another service has to find out. A developer who reads that post and installs their plugin has had our basic need met well enough. **Mem0 is a substitute for the casual user.**

**Where we are different, and they would find it hard to follow:**

1. **Citations.** Their design (ADD-only LLM extraction into vectors) throws away the source text on purpose to save tokens. Adding line-level evidence would go against their main pitch.
2. **Human confirmation.** Their whole product is agents writing memory without supervision. Adding a review step slows the funnel they are optimizing (agent sign-up, auto-capture hooks).
3. **Local and private by default.** Their revenue depends on the hosted platform, and open source is the funnel. We have no cloud to push people toward.

**Where they are clearly ahead:** distribution (plugins for every coding agent, a marketplace listing, 22 framework integrations), retrieval quality (hybrid search, time ranking), automatic capture, compliance, and a public benchmark story.

## 5. What to take from them

1. **Lifecycle capture hooks, but opt-in.** Their SessionStart, PreCompact and Stop hooks are the right moments to suggest "import this session?" We should keep to consent: suggest at the hook and import only when the person confirms. Never import in the background. Card idea: `Backlog: import prompt on PreCompact/Stop`.
2. **Save compaction summaries.** The step where `isCompactSummary` is read back at SessionStart is a small trick worth copying. A compaction summary is a ready-made handoff, and we could store it as a node that cites the turns it summarizes.
3. **Hybrid search for `session_search`.** BM25 + entity + semantic fusion. Start with BM25 and entity matching, which need no new runtime dependency (an ADR is needed for any dependency).
4. **Expiry by memory type.** Session state expires and decisions don't. This fits our quoted/inferred and superseded model.
5. **A public benchmark.** They win attention with LoCoMo and LongMemEval numbers. Our version would measure citation accuracy: how often a briefing's claim is supported by the line it cites. Mem0 can't report that number, because it keeps no source. An eval card belongs in `docs/evals.md` before anything is built.
6. **Don't copy:** agent sign-up without a person, letting agents bulk-delete through MCP, or blocking writes to `MEMORY.md`. Each goes against AGENTS.md sections 5 and 6, or against how much the user controls.

## 6. Positioning line

> Mem0 gives your agent a memory. Context Ledger gives it a receipt.

For a pitch or a video: show the same handoff both ways. With Mem0, agent B "knows" the contract changed. With the ledger, agent B knows it changed, can show the line where it was decided and who confirmed it, and nothing left the laptop. Before making this claim in public, run their plugin once on a synthetic transcript to confirm how it behaves (see the open items).

## 7. Open items

- I didn't run their plugin or the open-source server. Running it once on a synthetic transcript would confirm what a stored memory looks like and how much of the source survives.
- I didn't check whether OpenMemory MCP is still maintained.
- The SOC 2 type (Type 1 or Type II) and the Pro plan conflict between their own pages. Ask before citing either.
- DolphinBench (600 tool-based tasks) could be a neutral benchmark to run `context_for` on. I haven't read its license or task format.
