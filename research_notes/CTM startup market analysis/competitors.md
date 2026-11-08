# CTM (Context Telepathy Manager): competitive landscape (as of 2026-11-08)

Method notes for the report writer:
- These notes rest on web search (about 30 tool calls).
- Two primary sources were unreachable from this session because the hosts are not in the session's allowed network domains: modelcontextprotocol.io (MCP spec changelog) and github.blog (Copilot memory changelog). Their facts below come from secondary coverage and are marked as such.
- The GitHub API (`gh api repos/...`) was also blocked for third-party repos, so **no GitHub star count below is verified**. Star figures come from third-party pages and conflict.
- Funding figures are reported only where a source states them. Otherwise they are marked "not found".

---

## 0. Check of the team's earlier competitor research (`origin/product/v1:docs/strategy/uzcombinator/research-competitors.md`, dated 2026-11-06)

### Takeaway
The earlier file is a teardown for a **different product**: a client-facing, signed "Ledger Handover" packet for agencies, with Uzbekistan / IT Park as the beachhead. It is not a teardown for CTM's cross-vendor semantic graph and latent KV layer. Its handover-adjacent rows still apply (Entire, Nessie, SpecStory, claude-mem/Supermemory, native Claude Code and Codex session storage). It misses the entire memory-layer, protocol, KV-cache and orchestration categories, and it leaves out the most important vendor-native threat: GitHub Copilot's cross-agent memory.

### Cited Findings
- **Supermemory funding is inconsistent.** The earlier file says "$2.6M seed, Oct 2025".
  - Third-party reports give $2.6M led by Susa Ventures ([Dealroom](https://nz.dealroom.co/news/feed/supermemory-secures-2-6m-for-ai-memory)).
  - Supermemory's own blog headline says $3M ([Supermemory blog](https://supermemory.ai/blog/supermemory-raises-3-million-and-building-the-best-memory-engine-for-llms)).
  - Both should be cited, or the company's figure should be preferred.
- **Nessie funding is still unconfirmed.** One aggregator lists a $500K seed with YC as backer and a Fall 2025 batch, but I found no primary source ([neuronfeed](https://neuronfeed.com/startups/nessie)). YC's own page says Nessie unifies context from ChatGPT and Claude, and that "Next, we are unlocking sharing" ([YC](https://www.ycombinator.com/companies/nessie)). The earlier "$80/seat Team" figure remains UNVERIFIED.
- **Entire's product docs match the earlier file.** Checkpoints link session context (prompts, tool calls, file changes) to commits, metadata sits on a separate branch, and agent-vs-human attribution is estimated ([Entire docs: checkpoints](https://docs.entire.io/guides/checkpoints/capture-checkpoints.md); [sessions](https://docs.entire.io/guides/sessions/sessions-in-entire-io)). I found no Entire news after the 2026-10-26 forge launch.
- **Missing from the earlier file:**
  - GitHub Copilot agentic memory, which shares knowledge across Copilot agents on a repository, public preview Jan 2026 ([GitHub changelog via search](https://github.blog/changelog/2026-01-15-agentic-memory-for-github-copilot-is-in-public-preview/)).
  - The Agentic AI Foundation (MCP + AGENTS.md + goose under the Linux Foundation) ([SD Times](https://sdtimes.com/ai/linux-foundation-forms-agentic-ai-foundation-to-be-new-home-for-mcp-goose-and-agents-md/)).
  - Mem0, Zep, Letta and Cognee.
  - Tensormesh/LMCache.
  - Cache-to-Cache research.
- **Open-source cross-agent memory tools for coding agents** have appeared and are not in the earlier file:
  - agentmemory (local-first, Claude Code + Codex + Cursor + Gemini CLI via a shared MCP server) ([knightli, 2026-05-19](https://knightli.com/en/2026/05/19/agentmemory-persistent-memory-ai-coding-agents/)).
  - Cross Context (`~/.xctx/`, wires Claude, Codex, Copilot and Cursor) ([project page](https://arturdonda.github.io/cross-context/)).
  - Memorix ([DEV](https://dev.to/varun_pratapbhardwaj_b13/why-every-ai-coding-agent-will-need-persistent-memory-by-2027-10h6)).
  - claude-mem now also targets Codex ([aitoolly, 2026-10-07](https://aitoolly.com/ai-news/article/2026-10-07-claude-mem-brings-persistent-cross-session-context-and-ai-powered-compression-to-claude-code-codex-a)).

### Inferences
- **The earlier file's "6–12 month window" was judged for the handover-packet wedge and does not carry over to CTM.** For CTM, the most direct substitutes are free OSS cross-agent memory MCP servers (agentmemory, claude-mem, Cross Context, Memorix) and Copilot's native cross-agent memory, not Entire.
- **The earlier file's "import competitors as inputs" idea transfers well to CTM.** Entire checkpoints, SpecStory `.specstory/` files and Codex/Claude JSONL are natural sources for CTM's cited graph.

### Gaps
- I did not re-verify claude-mem's "74k stars" or Entire's 5.3k stars, because the GitHub API was blocked.
- I did not re-check whether Claude Code has a built-in `/export`.

---

## 1. Agent memory / context layers (Mem0, Zep/Graphiti, Letta, Cognee, Supermemory, LangMem, newcomers)

### Takeaway
This is the best-funded direct category: Mem0 at $24M is the largest. Every player sells **memory for one agent or app, keyed by user/session**, recalled through vector or graph search. None of them markets cross-vendor agent-to-agent publishing with line-level, quote-verified citations back to source transcripts. The bigger near-term substitutes are free local OSS "shared memory MCP servers" for coding agents.

### Cited Findings
**Mem0**
- **Funding:** $24M total, a seed led by Kindred Ventures plus a Series A led by Basis Set Ventures, with Peak XV, GitHub Fund and YC participating. Announced 2025-10-28 ([TechCrunch via mirror](https://hn.jakechampion.name/reader/https://techcrunch.com/2025/10/28/mem0-raises-24m-from-yc-peak-xv-and-basis-set-to-build-the-memory-layer-for-ai-apps); [Pulse2](https://pulse2.com/mem0-24-million-raised-for-powering-memory-layer-for-ai-agents/)). Some sources split it as a $3.9M seed plus a $20M Series A. CB Insights dates it differently (July 2025).
- **No 2026 round found.**
- **Pricing (third-party, verified 2026-03-10):** free tier with 10K memories and 1K retrievals/month, Pro at $19–249/month, custom Enterprise ([rywalker](https://rywalker.com/research/mem0)). I could not reach Mem0's official pricing page.
- **Cross-tool memory for coding agents:** Mem0 markets this on top of Claude Code Auto Memory and Codex ([Mem0 library](https://mem0.ai/library/coding-agents)).

**Zep / Graphiti**
- **What it is:** a temporal knowledge-graph architecture for agent memory ([arXiv 2501.13956](https://arxiv.org/html/2501.13956)).
- **Licensing:** Graphiti is Apache 2.0 and can run without Zep Cloud. Zep discontinued its community self-hosted edition ([aitoolsatlas](https://aitoolsatlas.ai/tools/zep/pricing); [makerstack](https://makerstack.co/reviews/zep-review/)).
- **Pricing:** credit-based, one credit per 350 bytes per ingested episode. Free-tier figures conflict (10K vs 1K credits/month) ([Zep blog](https://getzep.com/blog/introducing-zeps-new-pricing-more-value-start-up-credits); [activepieces](https://www.activepieces.com/blog/zep-ai-pricing-in-2026-plans-and-what-you-pay.md)).
- **Funding:** a Series A is mentioned with no amount, date or investors, so it is unverified ([callsphere](https://callsphere.ai/blog/agent-memory-problem-startups-building-long-term-memory-ai-agents)). Amount: not found.
- **Stars:** Graphiti is cited at about 28.9K (third-party, unverified) ([techsy](https://techsy.io/en/blog/best-ai-agent-memory-tools)).

**Letta (ex-MemGPT)**
- **Funding:** $10M seed led by Felicis, with Founders Fund and YC; emerged from stealth in Sept 2024 ([PR Newswire](https://prnewswire.com/news-releases/berkeley-ai-research-lab-spinout-letta-raises-10m-seed-financing-led-by-felicis-to-build-ai-with-memory-302257004.html)). No 2026 round found.
- **2026 product news:** desktop app (Apr 2026), and Channels replaced LettaBot (May 2026) ([rywalker](https://rywalker.com/research/letta)).
- **Pricing (third-party):** usage-based API at about $0.10 per active agent per month plus model and tool costs. A Pro tier at $20/month is reported, and Letta Code is free with bring-your-own keys ([techsy](https://techsy.io/en/blog/best-ai-agent-memory-tools)). Not verified against letta.com.
- **Stars:** estimates range from about 14K to 23K (conflicting).

**Cognee (Berlin)**
- **Funding:** €7.5M seed in Feb 2026, led by Pebblebed, with 42CAP, Combination VC and Vermilion Cliffs ([nordic9](https://nordic9.com/news/cognee-raised-75m-in-seed-funding-led-by-pebblebed-joined-by-42cap-combination-vc-and-vermilion-cliffs-ventures-and-angel-investors); [pulse.bot](https://www.pulse.bot/ai/deals/cognee-secures-75m-funding-round-led-by-pebblebed-284905c9-30c1-4f28-a35c-8df9cb034c71)). The currency is reported variously as € or $.
- **License and plans:** Apache 2.0 core. Plans are Free, Developer, Cloud (Team) and On-prem Enterprise ([costbench](https://costbench.com/software/ai-memory-context/cognee/)).
- **Stars:** 6K vs 29.9K, conflicting ([makerstack](https://makerstack.co/reviews/cognee-review/)).

**Supermemory**
- **Funding:** $2.6M–$3M seed in Oct 2025, led by Susa Ventures, with backing from Google executives ([TechCrunch](https://techcrunch.com/2025/10/06/a-19-year-old-nabs-backing-from-google-execs-for-his-ai-memory-startup-supermemory/); [Supermemory blog](https://supermemory.ai/blog/supermemory-raises-3-million-and-building-the-best-memory-engine-for-llms)). No 2026 round found.

**Sector**
- Dedicated memory-layer startups had raised more than $55M by March 2026 ([moklabs](https://moklabs-research.pages.dev/reports/technology/2026-03-20-ai-agent-memory-state-management-patterns)). This is a third-party estimate.

**Free OSS cross-vendor coding-agent memory (direct substitutes)**
- **agentmemory:** local-first and SQLite-based, with hooks for Claude Code and Codex CLI plus a shared MCP server. Supports Cursor and Gemini CLI ([knightli](https://knightli.com/en/2026/05/19/agentmemory-persistent-memory-ai-coding-agents/); [shiporskip](https://shiporskip.io/compare/agentmemory-persistent-memory-ai-coding-agents-sqlite-2026-vs-openai-codex-cli-2-multi-file-editing-git-integration)).
- **ai-memory:** a typed "where you left off" block for handing work from Claude Code to Codex ([toolhunter](https://toolhunter.cc/tools/ai-memory)).
- **Cross Context:** see section 0 ([project](https://arturdonda.github.io/cross-context/)).
- **claude-mem:** now supports Codex ([aitoolly](https://aitoolly.com/ai-news/article/2026-10-07-claude-mem-brings-persistent-cross-session-context-and-ai-powered-compression-to-claude-code-codex-a)).
- **Hosted cross-chat context:** Unabyss, Relay and UltraContext pitch shared context between ChatGPT, Codex and Claude Code ([Unabyss blog](https://unabyss.com/blog/codex-claude-code-shared-context)).

### Inferences
- **Overlap with CTM:** high on "agents share memory", low on "cited, quote-verified claims". Mem0, Zep and Cognee store extracted facts or entities. From what I found, they do not advertise line-level provenance that is verified against the source transcript.
- **Most likely threat:** Mem0 or Zep ship a "coding-agent pack": an MCP server plus hooks for Claude Code and Codex, with a provenance field. Separately, agentmemory or claude-mem add citation metadata. Either would erase CTM's feature lead fast, because SQLite-local, MCP-served, multi-vendor memory already exists for free.
- **CTM is weaker than Mem0, Zep and Letta on:** funding, hosted scale, benchmarks (LoCoMo/LongMemEval-style), and enterprise features (SSO, on-prem).

### Gaps
- Official current pricing pages for Mem0, Zep and Letta could not be confirmed.
- I found no 2026 rounds for Mem0, Zep, Letta or Supermemory. Absence in search results is not proof that none happened.
- LangMem (LangChain's memory SDK) was not separately researched. It is free OSS inside the LangChain ecosystem; funding is LangChain's (section 6).
- No verified star counts (GitHub API blocked).

---

## 2. Agent-to-agent protocols and standards (MCP, A2A, ACP, AGNTCY, OpenAI standards)

### Takeaway
The standards stack has consolidated under the Linux Foundation:
- MCP, AGENTS.md and goose sit in the Agentic AI Foundation.
- A2A sits in the Linux Foundation, and IBM's ACP has merged into it.
- AGNTCY's OASF ingests A2A Agent Cards and MCP descriptions.

**None of them defines a shared, cited knowledge graph between agents.** MCP connects an agent to tools and resources. A2A covers task delegation and messaging. AGENTS.md is a static instruction file. That keeps CTM's niche open, but CTM depends entirely on MCP staying the default transport.

### Cited Findings
**Agentic AI Foundation (AAIF)**
- **Launch:** 2025-12-09 with MCP (Anthropic), goose (Block) and AGENTS.md (OpenAI) ([SD Times](https://sdtimes.com/ai/linux-foundation-forms-agentic-ai-foundation-to-be-new-home-for-mcp-goose-and-agents-md/); [Linux Foundation PR](https://www.linuxfoundation.org/press/linux-foundation-announces-the-formation-of-the-agentic-ai-foundation?hs_amp=true)).
- **Platinum members:** AWS, Anthropic, Block, Bloomberg, Cloudflare, Google, Microsoft and OpenAI ([Campus Technology](https://campustechnology.com/articles/2025/12/15/newly-launched-agentic-ai-foundation-brings-together-tech-giants-for-open-source-ai-development.aspx)).
- **Growth:** 247 organizations by Aug 2026 ([latent.space wiki](https://latent.space/wiki/aaif/)). One source says 300+ members and 10 hosted projects by 2026-10-22 ([serpapi blog](https://serpapi.com/blog/the-state-of-mcp-everything-that-changed-in-h1-2026/)). This is secondary and unconfirmed.
- **Projects:** agentgateway was added as the 4th hosted project on 2026-06-04 ([latent.space wiki](https://latent.space/wiki/aaif/)).

**MCP spec**
- **2026-07-28 release:** reported as the largest revision since launch. The core becomes stateless (protocol-level sessions eliminated) and the old HTTP+SSE transport is deprecated ([DEV: stateless](https://dev.to/rabinarayanpatra/why-mcp-2026-07-28-spec-drops-sessions-and-goes-stateless-1gd); [DEV: breaking changes](https://dev.to/akaranjkar08/mcp-spec-ships-july-28-every-breaking-change-and-how-to-migrate-4co8)). These are secondary sources, partly written against the release candidate. modelcontextprotocol.io was unreachable to verify.
- **MCP Apps:** the first official extension (UI in chat), shipped 2026-01-26 ([mcpplaygroundonline](https://mcpplaygroundonline.com/blog/mcp-2026-roadmap-whats-changing-for-developers)).
- **Memory:** I found no MCP spec feature for shared memory or knowledge graphs between agents. Resources and tools remain the primitives.

**A2A**
- **Governance:** donated by Google to the Linux Foundation in June 2025 ([futureagi](https://futureagi.com/blog/mcp-vs-a2a-2025/)).
- **Version:** v1.0 was reported in March or April 2026 (sources disagree) with 150+ supporting organizations. Agent Cards are signed in v1.0 ([agentic-portal](https://agentic-portal.pages.dev/a2a/reference/whats-new-v1); [josenobile](https://josenobile.pages.dev/guides/a2a-protocol/)). v1.0.1 is reported on GitHub 2026-05-28 ([danilchenko](https://www.danilchenko.dev/posts/ai-agent-protocols/)).
- **Scope:** "MCP connects an agent to its tools, A2A connects agents to each other" ([agenticwire](https://www.agenticwire.news/article/a2a-vs-mcp-protocol)).
- **AAIF:** one source says A2A joined AAIF on 2026-08-17. This is unconfirmed.

**IBM ACP**
- Merged into A2A on 2025-08-29 under LF AI & Data. "The ACP team is winding down active development and contributing its technology and expertise to A2A" ([zuplo](https://zuplo.com/blog/agent-protocol-stack-mcp-a2a-acp-2026.md)).

**AGNTCY**
- OASF accepts A2A Agent Cards and MCP server descriptions as inputs. It is a layer above A2A, not a rival ([lossless-group corpus](https://lossless-group.github.io/context-vigilance-kit/corpus/agent-2-agent/)).

**OpenAI**
- AGENTS.md was released in Aug 2025 and is reportedly adopted by 60,000+ OSS projects (third-party figure) ([agnost](https://agnost.ai/blog/mcp-agents-md-join-agentic-ai-foundation)).

### Inferences
- **None of these solves shared context directly.** A2A passes messages and artifacts per task. It does not keep a persistent, queryable, cited graph of what each agent knows. AGENTS.md covers static human-authored facts, not facts the agents generate.
- **Most likely threat:** an AAIF working group standardizes an MCP "memory" or "knowledge" extension, as it did with MCP Apps, or an A2A "context artifact" type. If CTM's graph schema is not submitted early, a standard designed by a larger player could make it non-standard.
- **Opportunity:** propose CTM's typed-node + citation schema as an MCP extension or AAIF project.
- **Risk:** the stateless 2026-07-28 MCP core may force CTM to keep its own state server-side, in SQLite, rather than in session state. That is compatible with CTM's design but needs migration work.

### Gaps
- The official MCP changelog and A2A spec text could not be fetched. Check for any "memory" or "resources subscription" changes in the 2026-07-28 spec.
- I found no evidence on whether A2A v1.0 includes a context-sharing primitive.

---

## 3. Vendor-native features that could make CTM redundant

### Takeaway
Every major vendor now ships **its own** persistent memory:
- Claude Code: Auto Memory and CLAUDE.md.
- Claude API: memory tool, and Managed Agents memory (Apr 2026).
- Codex: `~/.codex/memories`.
- Copilot: agentic memory.
- Gemini CLI: GEMINI.md hierarchy.

Copilot's memory is explicitly **cross-agent, but only within GitHub's own agents**. I found **no announced cross-vendor memory sharing** between Anthropic, OpenAI, Google or GitHub. The only shared cross-vendor layer is static AGENTS.md.

### Cited Findings
**Claude / Anthropic**
- **Claude API memory tool:** announced 2025-09-29. It is client-side: Claude requests file operations against a `/memories` directory that the developer hosts. Context editing is a separate beta ([webpronews](https://www.webpronews.com/anthropic-launches-context-editing-and-memory-tools-for-claude-ai); [Claude docs mirror](https://scriptagc.wasmer.app/https_docs_claude_com/en/docs/build-with-claude/context-editing)).
- **Managed Agents memory:** public beta in Apr 2026. Memories are stored as exportable, editable files ([edtechinnovationhub](https://edtechinnovationhub.com/anthropic-brings-persistent-memory-to-claude-managed-agents-in-public-beta/)).
- **Claude Code:** reads CLAUDE.md at startup and has Auto Memory ([Mem0 library](https://mem0.ai/library/coding-agents)). Secondary sources date automatic cross-session memory to March 2026 ([the-ai-corner](https://www.the-ai-corner.com/p/everything-claude-shipped-2026-complete-guide)).

**OpenAI Codex**
- Summarizes prior sessions into the local `~/.codex/memories/`. This is separate from ChatGPT memory, per-user, with no cross-machine sync, and does not pick up what was told to Claude Code or Cursor ([Mem0 on Codex memory](https://mem0.ai/blog/how-memory-works-in-codex-cli); [memoryplugin](https://blog.memoryplugin.com/does-codex-remember-past-conversations/)). These are vendor-authored, competitor-leaning sources.

**GitHub Copilot**
- **Launch:** agentic memory entered public preview in Jan 2026 for all paid plans ([GitHub changelog](https://github.blog/changelog/2026-01-15-agentic-memory-for-github-copilot-is-in-public-preview/); [GitHub blog](https://github.blog/ai-and-ml/github-copilot/building-an-agentic-memory-system-for-github-copilot/)). These pages were seen through search only, because the github.blog host was blocked.
- **Scope:** memories are repository-scoped, and "knowledge discovered by one agent becomes available to all other agents working on the same repository" ([letsdatascience](https://letsdatascience.com/news/github-copilot-introduces-cross-agent-memory-system-628570b4)).
- **Availability:** an Nov 2026 post describes Memory as GA and "Dreaming" as in preview. It says memory is shared across the Copilot app, CLI, cloud agent, code review, Autofix, Mobile, Slack and Teams, and only the root agent writes memories ([itnext](https://itnext.io/github-copilot-memory-dreaming-code-search-9e16e1492bba)). The GA status is unconfirmed.
- **Citations:** GitHub's engineering blog describes memories being validated against cited code locations before use ([GitHub blog](https://github.blog/ai-and-ml/github-copilot/building-an-agentic-memory-system-for-github-copilot/)). **Not directly verified**: I could not fetch the page, so this is from memory of the Jan 2026 post and should be confirmed before it is used.

**Cursor**
- Removed its built-in Memories in v2.1 and told users to convert them to rules ([memu.pro](https://memu.pro/blog/cursor-automations-always-on-agents)). This is a secondary vendor blog and is unverified against Cursor's changelog.

**Gemini CLI**
- Uses layered GEMINI.md context files (global, project, subdirectory). It can be configured to read AGENTS.md through a `fileName` array ([Gemini CLI docs](https://google-gemini.github.io/gemini-cli/docs/cli/gemini-md.html)). A PR to make AGENTS.md a default appeared to still be open ([PR mirror](https://github.gg22.workers.dev/google-gemini/gemini-cli/pull/24913)).

**OpenAI Agents SDK**
- Sessions carry the transcript across handoffs but provide no cross-session semantic memory ([Hindsight](https://hindsight.vectorize.io/blog/2026/04/17/openai-agents-persistent-memory)).

**Cross-vendor sharing**
- I found no official Anthropic/OpenAI shared memory store. All cross-agent solutions found are third-party ([Unabyss](https://unabyss.com/blog/codex-claude-code-shared-context); [knightli](https://knightli.com/en/2026/05/19/agentmemory-persistent-memory-ai-coding-agents/)).

### Inferences
- **Copilot is the clearest proof the need is real and the clearest threat.** GitHub already does "agents publish memories other agents read, with cited code locations", but only for Copilot surfaces. Copilot also hosts third-party models and agents (Claude, Codex) in its agent HQ. If GitHub opens Copilot Memory to non-Copilot agents through MCP, CTM's cross-vendor pitch shrinks to "local and not GitHub-hosted".
- **Most likely threat:** "memory files" become an AAIF standard, the way AGENTS.md did, for example `.agents/memory/`. Then Claude Code, Codex and Gemini CLI read and write a common format natively. The vendors' incentive to lock memory in cuts against this, which supports CTM's durability.
- **Vendor memories are per-tool silos.** CTM's value is as the neutral layer between them: it reads `~/.codex/memories`, Claude's `/memories` and CLAUDE.md, and re-exports them as cited graph nodes.

### Gaps
- No primary Anthropic doc was fetched for Claude Code Auto Memory, subagent or skills memory behaviour.
- No information was found on Devin/Cognition Knowledge or Google Jules memory. The search returned only third-party marketing.
- Cursor background agents and rules were not deeply researched.

---

## 4. Coding-context tools (Context7, Sourcegraph/Cody/Amp, Augment, Greptile, Pieces, SpecStory, Entire, Nessie)

### Takeaway
These tools give agents context about **code and documentation**: indexes, docs, PR review. They do not share **what one agent learned in a conversation**. The transcript/session tools (SpecStory, Entire, Nessie) are closer to CTM. They capture or share raw sessions, but they do not offer a cited, agent-readable graph exchanged between vendors.

### Cited Findings
- **Augment Code Context Engine**
  - Shipped as a standalone MCP server usable by any AI coding tool on 2026-02-06 ([Augment changelog](https://www.augmentcode.com/changelog/context-engine-mcp-in-ga); [Augment blog](https://augmentcode.com/blog/context-engine-mcp-now-live)).
  - Funding is about $252M total, including a $227M Series B at $977M post-money in Apr 2024 ([rywalker](https://rywalker.com/research/augment-context-engine)). No 2026 round found.
- **Greptile:** $29.5M over 3 rounds, the latest a $25M Series A on 2025-08-22 with YC participating ([CB Insights](https://www.cbinsights.com/company/onboard-ai/financials)).
- **Context7 (Upstash):** an MCP server serving version-specific library docs to coding agents ([DEV](https://dev.to/grove_chatforest/context7-mcp-server-real-time-library-docs-for-ai-coding-agents-40k3)). Funding for Upstash or Context7: not found.
- **Entire:** for the checkpoints and sessions linked to commits and agent attribution, see section 0 ([Entire docs](https://docs.entire.io/guides/sessions/sessions-in-entire-io)). The earlier team file records a $60M seed at a $300M valuation, led by Felicis (Feb 2026).
- **Nessie (YC F25):** auto-syncs chats from ChatGPT, Claude, Gemini, Perplexity and Codex into a queryable knowledge base for humans and agents ([neuronfeed](https://neuronfeed.com/startups/nessie); [YC](https://www.ycombinator.com/companies/nessie)).
- **SpecStory:** local Markdown capture of agent chats in `.specstory/`. See the earlier file; funding not found.
- **Sourcegraph/Cody/Amp and Pieces:** not researched in this pass. Funding and pricing not found.

### Inferences
- **Augment's Context Engine MCP is the model for a well-funded player** turning an internal context layer into a cross-tool MCP product. If Augment adds "session knowledge" to its codebase index, it competes head-on with CTM, with far more distribution.
- **Nessie is the closest startup analogue** for cross-vendor sharing, but it is aimed at chat users and hosted. It is not local, and no source shows citations.
- **Most likely threat:** Entire adds an MCP "read other agents' checkpoints" server. It already captures Claude Code, Codex, Cursor and Copilot sessions, which would give agents cross-vendor session recall tied to commits.

### Gaps
- No current data on Sourcegraph Amp, Pieces, or SpecStory funding and pricing.
- No star counts verified.

---

## 5. KV-cache sharing / latent communication infrastructure

### Takeaway
Commercial KV-cache infrastructure (LMCache/Tensormesh, NVIDIA Dynamo, vLLM prefix caching) reuses caches **within one model** to save compute. It does not translate memory **between model families**. Cross-family latent communication is an active 2025–2026 research area:
- C2C (ICLR 2026)
- LatentMAS
- Latent Cache Flow
- Mixture-of-Translators
- a cross-model KV adapter
- CacheBridge
- a "Universal Context-Reuse Layer"

I found **no startup commercializing cross-model KV transfer**. CTM's latent layer is novel as a product but faces crowded academic prior art and no moat from the method itself.

### Cited Findings
- **Tensormesh (commercial LMCache)**
  - Raised a $20M extension in late May 2026, bringing the total to $24.5M. Investors are NVentures (NVIDIA), AMD Ventures, CoreWeave, Valley Capital Partners and Laude Ventures. The earlier seed was $4.5M led by Laude ([Pulse2](https://pulse2.com/tensormesh-20-million-raised-to-scale-kv-caching-infrastructure-for-enterprise-ai-inference/); [SDxCentral](https://www.sdxcentral.com/news/nvidia-and-amd-plough-20m-in-ai-inference-disruptor/)).
  - Launched Tensormesh Inference SaaS to GA, pitching up to 10x lower GPU spend and latency.
  - LMCache integrates with vLLM, SGLang, TensorRT, NVIDIA Dynamo and SageMaker, with more than 8K stars (third-party) ([convergedigest](https://convergedigest.com/tensormesh-raises-20m-for-kv-cache-based-inference-platform/?amp=1)).
- **NVIDIA:** introduced an Inference Context Memory Storage (ICMS) platform through the BlueField-4 DPU in 2026 ([SDxCentral](https://www.sdxcentral.com/news/nvidia-and-amd-plough-20m-in-ai-inference-disruptor/)). An August 2026 NVIDIA cross-model linear KV mapping technique was reported only by a Spanish startup newsletter and is unverified ([ecosistemastartup](https://ecosistemastartup.com/?p=100463)).
- **Cache-to-Cache (C2C), Fu et al., ICLR 2026**
  - Projects a source model's KV cache and fuses it into a target model's cache, with a learned gate choosing the target layers.
  - Reports +8.5–10.5% accuracy over individual models, +3.0–5.0% over text communication, and about 2.0x lower latency. Code is at github.com/thu-nics/C2C ([ICLR proceedings](https://proceedings.iclr.cc/paper_files/paper/2026/hash/474ada926b331d78f06d95e8913111cc-Abstract-Conference.html)).
- **LatentMAS (arXiv 2511.20639)**
  - Training-free. Agents exchange last-layer latent thoughts through a shared latent working memory held in KV caches.
  - Reports up to +14.6% over single models and +2.8–4.6% over text-based multi-agent systems. v3 was posted 2026-06-01 ([arXiv](https://arxiv.org/abs/2511.20639)).
  - Works mainly with homogeneous models (inference from the method description).
- **Heterogeneous KV communication with dense alignment (arXiv 2606.13594):** notes that latent communication is "largely restricted to homogeneous agents" and proposes a lightweight two-stage cross-model KV adapter. It cites KVComm (Shi et al., 2025) ([arXiv](https://arxiv.org/html/2606.13594)).
- **Latent Cache Flow / LCF-X (arXiv 2605.22863):** critiques C2C's position-wise fusion and compresses the sharer cache into a fixed-size tensor for different contexts ([alphaxiv](https://www.alphaxiv.org/abs/2605.22863)).
- **Other 2026 cross-model KV work:**
  - Closed-form per-head linear map, same family ([arXiv 2608.03893](https://arxiv.org/pdf/2608.03893)).
  - CacheBridge ([arXiv 2609.00891](https://arxiv.org/pdf/2609.00891)).
  - A Universal Context-Reuse Layer for cross-model KV sharing ([arXiv 2608.30963](https://arxiv.org/pdf/2608.30963)).
  - Mixture-of-Translators, Dery et al. per-model adapters, and SwiftCache (KV sharing across co-located heterogeneous models over NVLink) are all cited within [arXiv 2606.16135](https://arxiv.org/html/2606.16135v1).

### Inferences
- **The prior art makes the latent layer a research feature, not a moat.** At least 6–8 2026 papers do cross-model KV transfer with small trained adapters, which is CTM's approach (SwaT-style). CTM's edge would have to come from packaging (a local, MCP-addressable latent channel) and from trained mappers for popular pairs (for example Qwen↔Kimi).
- **Most likely threat:** Tensormesh/LMCache or NVIDIA Dynamo add a "cross-model cache translation" module. They own the serving path, so they would be the default place to do it. NVIDIA's reported linear-mapping work signals intent.
- **Practical weakness for CTM:** closed models (Claude, GPT) do not expose KV caches. The latent layer therefore applies only to open-weight to open-weight pairs, a small slice of today's coding-agent usage.

### Gaps
- No startup commercializing cross-architecture KV transfer was found. This is absence of evidence, not proof.
- The CTM-referenced paper (arXiv 2610.15095) was not indexed by search (not researched, per instructions).
- The NVIDIA August 2026 technique is unverified.

---

## 6. Agent orchestration platforms with shared state (LangGraph, CrewAI, AutoGen/Microsoft Agent Framework, OpenAI Agents SDK)

### Takeaway
Orchestration frameworks provide shared state and memory **inside one framework's runtime**: LangGraph checkpointers and stores, CrewAI memory, Agents SDK Sessions. Agents built in other vendors' tools cannot read that state. They compete with CTM only when a team builds every agent in the same framework.

### Cited Findings
- **LangChain/LangGraph:** $125M Series B at a $1.25B valuation, led by IVP, with CapitalG, ServiceNow, Workday, Cisco, Datadog and Databricks. Announced 2025-10-20 ([Fortune](https://fortune.com/2025/10/20/exclusive-early-ai-darling-langchain-is-now-a-unicorn-with-a-fresh-125-million-in-funding/); [SiliconANGLE](https://siliconangle.com/2025/10/20/ai-agent-tooling-provider-langchain-raises-125m-1-25b-valuation)). Total is about $260M; CB Insights gives $160M, so the sources conflict.
- **CrewAI:** $18M total, including a Series A led by Insight Partners (Oct 2024) ([vmblog](https://vmblog.com/bylines/crewai-launches-multi-agentic-platform-to-deliver-on-the-promise-of-generative-ai-for-enterprise/)). A Sept 2026 report says $3.2M ARR and 50 employees, with no new round ([descubre.vc](https://www.descubre.vc/noticia/crewai-alcanza-3-2m-en-arr-y-consolida-18m-en-financiamiento-total-2026-09-15)). Aggregator totals vary ($12M–$24.5M).
- **OpenAI Agents SDK:** core primitives are Agents, Handoffs, Guardrails, Sessions and Tracing ([PyPI](https://pypi.org/p/openai-agents)). The session belongs to the conversation and carries across handoffs, but there is no cross-session semantic memory ([Hindsight](https://hindsight.vectorize.io/blog/2026/04/17/openai-agents-persistent-memory)). An Apr 2026 update reportedly added sandbox and memory snapshots ([DEV](https://dev.to/jangwook_kim_e31e7291ad98/openai-agents-sdk-sandbox-memory-and-mcp-in-2026-3end)).
- **OpenAI Conversations API:** persists conversation state as a durable object alongside the Responses API ([OpenAI docs](https://developers.openai.com/api/docs/guides/conversation-state/index.html)).
- **Microsoft Agent Framework (AutoGen successor):** GA date and details not found.

### Inferences
- **These frameworks are hosts, not rivals.** CTM can be one more MCP server that LangGraph, CrewAI and Agents SDK agents call.
- **Most likely threat:** LangChain (well-funded, with LangMem) ships a "cross-framework memory over MCP" product inside LangSmith. Its distribution in enterprise multi-agent builds is much larger than CTM's.

### Gaps
- No verified info on Microsoft Agent Framework GA, AutoGen status, or framework licenses and stars. LangGraph and CrewAI are believed MIT, and AutoGen is believed MIT/CC; none of these was verified this session.

---

## 7. Where is the white space (cross-vendor + cited + local), and how durable is it?

### Takeaway
A real but **narrow and fragile** white space exists. I found no product that combines all four of these:
- cross-vendor agent-to-agent publishing (Claude Code ↔ Codex ↔ open-weight agents)
- line-level, quote-verified citations to source transcripts
- local-first SQLite over MCP
- typed graph nodes

Each property on its own is already offered by someone, mostly for free. Durability is probably **12–18 months at best (judgment)**. CTM is weaker on funding, distribution, benchmarks and enterprise readiness, and its latent layer has heavy academic prior art.

### Cited Findings
**Who already has each property**
- **Cross-vendor and local:** agentmemory, Cross Context, claude-mem and Memorix ([knightli](https://knightli.com/en/2026/05/19/agentmemory-persistent-memory-ai-coding-agents/); [Cross Context](https://arturdonda.github.io/cross-context/)).
- **Cross-agent with citations, single vendor:** GitHub Copilot memory ([GitHub blog](https://github.blog/ai-and-ml/github-copilot/building-an-agentic-memory-system-for-github-copilot/)). The citation detail needs confirmation.
- **Cross-vendor and hosted, no citations found:** Nessie ([YC](https://www.ycombinator.com/companies/nessie)).
- **Graph memory with funding:** Zep/Graphiti, Cognee (€7.5M) and Mem0 ($24M) ([nordic9](https://nordic9.com/news/cognee-raised-75m-in-seed-funding-led-by-pebblebed-joined-by-42cap-combination-vc-and-vermilion-cliffs-ventures-and-angel-investors); [TechCrunch mirror](https://hn.jakechampion.name/reader/https://techcrunch.com/2025/10/28/mem0-raises-24m-from-yc-peak-xv-and-basis-set-to-build-the-memory-layer-for-ai-apps)).
- **Session capture across vendors, tied to commits:** Entire ([Entire docs](https://docs.entire.io/guides/sessions/sessions-in-entire-io)).

**Standards gap**
- MCP, A2A and AGENTS.md all live in Linux Foundation bodies, and none covers shared cited memory ([SD Times](https://sdtimes.com/ai/linux-foundation-forms-agentic-ai-foundation-to-be-new-home-for-mcp-goose-and-agents-md/)).

**Latent layer**
- No commercial cross-model KV transfer product was found, while many 2026 papers exist ([arXiv 2606.13594](https://arxiv.org/html/2606.13594); [ICLR C2C](https://proceedings.iclr.cc/paper_files/paper/2026/hash/474ada926b331d78f06d95e8913111cc-Abstract-Conference.html)).

### Inferences
**Where CTM is genuinely differentiated**
- **Provenance and verifiability:** every claim cites a transcript line and is quote-checked. This matters for trust (agents hallucinating "what the other agent said"), audit and compliance. Memory tools optimize recall, not verifiability.
- **Vendor neutrality plus local storage:** no hosted competitor can claim it, and vendors have an incentive not to build it.
- **Token economics:** sharing a small graph instead of pasting transcripts is a measurable claim CTM can benchmark.

**Where CTM is weaker (honest view)**
- **Capital and distribution:** Mem0 $24M, LangChain $1.25B valuation, Augment ~$252M, Entire $60M seed, Tensormesh $24.5M backed by NVIDIA.
- **Free OSS substitutes already exist** with the same local MCP + multi-vendor pitch. Switching cost is near zero, and "citations" alone may not pull users away.
- **Platform risk:** if GitHub opens Copilot Memory to MCP clients, or AAIF standardizes a memory file format, CTM's core shrinks to a format adapter.
- **Latent layer:** it works only for open-weight pairs. It is already demonstrated in academia (C2C, LatentMAS, LCF, adapters). Small-scale results give no defensibility, and inference-infrastructure owners (Tensormesh, NVIDIA Dynamo) are better placed to ship it.
- **No benchmarks or traction data versus Mem0/Zep** on standard memory evaluations.

**How durable is the white space**
- The cited-graph schema and verifier are durable **if** they become the open standard. CTM should submit the schema to AAIF as an MCP extension early.
- An accumulated cross-vendor adapter library (Claude JSONL, Codex sessions and memories, Copilot, Entire, SpecStory) adds some defensibility.
- The latent layer should be positioned as a research differentiator and recruiting signal, not the moat.
- **Likely threat order (judgment):**
  1. OSS memory MCP servers add citations (months).
  2. Mem0 or Zep add a coding-agent provenance pack (2–3 quarters).
  3. GitHub opens Copilot Memory cross-vendor, or AAIF standardizes agent memory (1–2 years).
  4. Inference vendors ship cross-model KV translation (1–2 years).

### Gaps
- No user-demand data, such as surveys on cross-vendor agent use or willingness to pay for verifiable memory.
- No verified evidence of whether Mem0, Zep or Cognee expose per-fact source provenance in their APIs. That deserves a direct docs check, because it is the crux of CTM's differentiation.
- Star counts and current pricing pages need direct verification. The GitHub API, modelcontextprotocol.io and github.blog were blocked in this session.
