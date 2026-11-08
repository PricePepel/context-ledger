# CTM: ideal customer profile and buyer pain (research as of 2026-11-08)

**Method caveat, read first.** In this session WebFetch could not reach stackoverflow.blog, survey.stackoverflow.co, news.ycombinator.com, newsletter.pragmaticengineer.com or codex.danielvaughan.com. Those hosts have to be allowed in the session's network settings before anyone can read the pages directly. WebSearch worked, so every finding below comes from search-result summaries, not from reading the full page. As a result:
- **I have no verified verbatim quotes from real people in these notes.** Statements attributed to HN, Reddit or blog authors are paraphrases from search summaries and are labelled that way. Before any quote goes into a deck, open the link and copy the exact text.
- Survey figures marked "(search summary)" are from secondary coverage or snippets of the primary page, and should be checked against the primary page.

---

## Q0. Check of the team's earlier work (origin/product/v1)

### Takeaway
The earlier docs research a different product: "Ledger Handover", which sells signed handoff packets that agencies give to clients. They are only partly reusable for CTM, which is cross-vendor agent-to-agent context interoperability. Several figures in them are unverified or outdated, and their main conclusion ("memory is free, sell compliance packets") cuts against CTM's core value proposition, so it has to be revisited, not inherited.

### Cited Findings
- `research-buyers.md` cites "27% use different models for different work" from the Stack Overflow 2026 survey. My searches found the 93% attribution figure and the per-tool agent shares, but **no multi-model percentage** in any SO 2026 coverage. Until someone checks the primary page, treat the 27% as UNVERIFIED. — [SO blog, 2026 results](https://stackoverflow.blog/2026/10/06/the-results-of-the-2026-developer-survey-are-here/), [SO AI section](https://survey.stackoverflow.co/2026/ai)
- The 93% "source attribution needed to trust AI" figure is corroborated by search snippets of the SO blog. This is strong support for CTM's "every claim cites a transcript line" feature, and it has the most direct relevance of anything in the earlier docs. — [SO blog](https://stackoverflow.blog/2026/10/06/the-results-of-the-2026-developer-survey-are-here/)
- The SO 2026 per-tool shares (Claude Code ~65.5–66%, Copilot ~59%, Codex ~29.5–30%, Cursor ~26%) were not in the earlier docs and add up to well over 100%, which implies multi-tool use (see Q1). — [SO AI data](https://survey.stackoverflow.co/2026/ai/data/ai-code-agent) (search summary)
- The JetBrains 2026 figures (90% weekly / 68% daily agent use) were already flagged UNVERIFIED in the earlier docs (page returned 403), and that is still true. One summary quotes JetBrains mid-2026 at Claude Code 39% vs Codex 16% of professional developers at work. — [JetBrains research blog](https://blog.jetbrains.com/research/2026/08/ai-coding-agent-adoption-2026/) (UNVERIFIED, search summary only), [dev.to summary](https://dev.to/sangrokjung/claude-code-vs-codex-2026-what-500-reddit-developers-really-think-31pb)
- The earlier pain-evidence file dated its Reddit items from a mirror's "post age" and marked them UNVERIFIED. Most items are about trust in AI-written code and disclosure to agency clients, not cross-agent context transfer. Only #4, #5, #8 and #21 bear directly on CTM's pain. — prior doc `docs/strategy/uzcombinator/research-pain-evidence.md`
- Mem0's OpenMemory local MCP server was sunset in April 2026 and removed on 2026-07-29. Zep discontinued its self-hosted Community Edition in April 2025. Neither event is in the earlier competitive tables, and both matter for the "local" positioning. — [Best MCP memory servers (vendor comparison)](https://coworker.ai/blog/best-mcp-memory-servers), [Atlan memory frameworks](https://atlan.com/know/best-ai-agent-memory-frameworks-2026/), [ChatForest Mem0 review](https://chatforest.com/reviews/mem0-mcp-server/)

### Inferences
- **Weak and outdated for CTM:** (1) the beachhead "Uzbek agencies selling signed client packets" is an agency-to-client trust product, not agent-to-agent interop; (2) the TAM tables rest on stacked UNVERIFIED multipliers; (3) "memory is free, Entire owns it" applies to *single-vendor session capture*, not to *cross-vendor, cited, token-reducing context exchange*. CTM's measured 5.4x token reduction (291k → 54k) and 3.2x latency gain give it an economic claim that Entire's free capture does not make.
- **Still valid and reusable:** the 93% attribution stat, the Entire and Nessie competitive facts, the Claude Code local-JSONL retention point (30-day default), and the observation that small handoff tools are multiplying, which is both demand evidence and a sign of crowding.

### Gaps
- The primary SO 2026 page could not be fetched, so the "27% different models" figure remains unverified.
- No independent check of the Nessie and Entire pricing was possible this session.

---

## Q1. Which teams run more than one coding agent / LLM vendor at once, how common is it, and why?

### Takeaway
Using several agents is the norm, not the exception. The evidence is strong at the enterprise level (a16z: 81% of Global 2000 CIOs use 3+ model families) and implied at the developer level (SO 2026 agent shares sum to well over 100%). No primary survey measures "Claude Code + Codex used together on the same task". The reasons are model strengths by task, second-opinion review, separate rate limits that add up to more capacity, and avoiding vendor lock-in.

### Cited Findings
- **Enterprise multi-model (strong):** a16z's 2025 survey of 100 CIOs found 37% using 5+ models (up from 29%). The main driver was use-case differentiation, with lock-in avoidance secondary. — [a16z, "How 100 Enterprise CIOs Are Building and Buying Gen AI in 2025"](https://a16z.com/ai-enterprise-2025/)
- a16z's 2026 report (Global 2000 CIOs, 2026-01-30): 81% use 3+ model families in testing or production, up from 68% less than a year earlier. 78% use OpenAI in production and 44% Anthropic. This comes from secondary coverage. a16z is an OpenAI investor. — [a16z news](https://www.a16z.news/p/leaders-gainers-and-unexpected-winners) (search summary)
- CB Insights is reported to find 94% using 2+ LLM providers. This is secondary and unverified. — cited in [Verax multi-AI strategy](https://www.verax.ai/blog/multi-ai-strategy-challenges) (search summary)
- **Developer level (moderate):** SO 2026 agent users: Claude Code ~66%, GitHub Copilot ~59%, OpenAI Codex ~30%, Cursor ~26%. Coding assistants/agents are used by 66% of respondents and automated agent workflows by 26.2%. The shares sum to more than 100%, so many respondents use several agents. The sample is self-selected SO readers. — [SO AI data 2026](https://survey.stackoverflow.co/2026/ai/data/ai-code-agent), [SO press release](https://stackoverflow.co/company/press/archive/stack-overflow-annual-developer-survey-ai-trust-conditional), [matthewswong analysis of sample bias](https://www.matthewswong.com/en/blog/stack-overflow-developer-survey-2026-ai-agent-trust/) (search summaries)
- One secondary article says most SO respondents use more than one coding agent, "often pairing Copilot completions with Claude Code or Codex for larger tasks". I could not verify this against SO. — [shattered.io](https://shattered.io/codex-vs-claude-code-stack-overflow-65-5-vs-29-5-2026/), [tech-insider](https://tech-insider.org/ca/claude-code-vs-codex-2026/) (low-quality SEO sources)
- **Why: second-opinion review (anecdote).** Pablo Stanley (designer/founder) describes running Claude Code output through Codex for a second pass. Paraphrase: Codex caught bugs and suggested a better approach when Claude kept looping on the same error. He got the tip from a Reddit comment. — [Pablo Stanley, "A Heated Rivalry: Claude Code + OpenAI Codex"](https://pablostanley.substack.com/p/a-heated-rivalry-claude-code-openai)
- **Why: rate limits / capacity (moderate).** Anthropic introduced weekly Claude Code limits in July 2025 because of heavy background use, and expected them to affect fewer than 5% of subscribers. — [TechCrunch 2025-07-28](https://techcrunch.com/2025/07/28/anthropic-unveils-new-rate-limits-to-curb-claude-code-power-users/) (2025). A 2026 guide argues that separate vendor subscriptions let a user switch when one locks them out. This is the guide's own framing. — [SessionWatcher guide](https://sessionwatcher.com/guides/claude-code-vs-codex); [DEV: "strategic diversification" around rate limits](https://dev.to/bredmond1019/navigating-claude-code-rate-limits-the-art-of-model-selection-and-strategic-diversification-3m8m)
- **Why: task split (anecdote).** Reddit write-ups describe Claude Code for architecture and Codex for review or autonomous work. — [dev.to, "What 500+ Reddit developers think"](https://dev.to/sangrokjung/claude-code-vs-codex-2026-what-500-reddit-developers-really-think-31pb)
- **Why: open-weight for cost/control.** vLLM/SGLang are described as the standard for multi-user self-hosting. Qwen 27B-class models fit one 48 GB GPU, while Kimi-class models need multi-GPU nodes (one source lists 16×H200 at ~$91/h). — [Qovery self-host guide](https://www.qovery.com/blog/self-host-open-source-llm-setups), [ContextStudios open-weight guide](https://www.contextstudios.ai/guides/best-open-weight-llms-2026), [TrueFoundry gateway](https://www.truefoundry.com/blog/self-hosted-open-weight-models-gateway) (vendor/listicle sources, figures conflict)

### Inferences
- Multi-vendor use is near-universal at enterprises, but there it is mostly *different models for different apps*, not *agents handing context to each other*. CTM's pain only bites when two agents work on the **same task or repo**. That pattern is clearest among individual power users and small AI-native teams (Claude Code + Codex review loops, falling back to the other tool at a rate limit).
- The rate-limit driver is fragile: if vendors raise limits, some of the switching goes away. Model-strength and review-diversity drivers look more durable.

### Gaps
- No primary statistic on the share of developers or teams using 2+ *coding agents* on the same work. The SO "27%" figure is unverified.
- No company engineering blog found that documents a formal multi-agent coding policy (e.g., "we standardise on Claude Code + Codex"). The Pragmatic Engineer "AI Tooling for Software Engineers in 2026" survey likely has tool-count data but was unreachable. — [Pragmatic Engineer](https://newsletter.pragmaticengineer.com/p/ai-tooling-2026)

---

## Q2. Concrete pain evidence: handoff context loss, transcript pasting, instruction-file sprawl, token cost, context rot, compaction

### Takeaway
The pain is real and shows up as builder activity: many people have built tools to move sessions between Claude Code and Codex because they were "tired of copy-pasting". Compaction losing detail is widely documented. Direct complaints about the **token cost** of long transcripts are scarce, so CTM's token/latency result is a differentiated claim, but the market has not yet voiced it as a pain.

### Cited Findings
- **Transcript pasting → tools (moderate, repeated signal).** Several independent 2026 tools exist only to move context between Claude Code and Codex:
  - Show HN "ctx": a local SQLite-backed skill, a cross-agent `/resume`, built to continue a Claude workstream in Codex. A commenter notes (paraphrase) that moving a session across providers keeps the visible transcript but loses the model's reasoning. — [HN 47836740](https://news.ycombinator.com/item?id=47836740) (search summary)
  - "Handoff: pick up where you left off when switching between Claude Code and Codex". A commenter says (paraphrase) they were tired of copy-pasting between the two tools. The tool offers full, focused and minimal detail levels. — [HN 47206954](https://news.ycombinator.com/item?id=47206954) (search summary)
  - "Message your other Claude Code sessions": commenters describe handoff files and tmux setups, and note that Codex stores sessions as JSONL in `~/.codex`. — [HN 49222824](https://news.ycombinator.com/item?id=49222824) (search summary)
  - Coincide (open-source Mac app) hands a thread between Claude Code, Codex and four other agents, each getting a compact recap of the turns it missed. — [dev.to, apoorvdarshan](https://dev.to/apoorvdarshan/how-i-hand-one-conversation-between-claude-code-codex-and-four-other-coding-agents-8mn)
  - authsec-bridge CLI transfers sessions across Claude Code, Codex and Gemini, with a fallback HANDOFF.md. — [authsec.ai](https://authsec.ai/blogs/stop-re-explaining-bridge-claude-codex-gemini)
  - "Two agent CLIs, one repo: sharing context between Claude Code and Codex without stepping on each other". — [dev.to, thedevtimeline](https://dev.to/thedevtimeline/two-agent-clis-one-repo-sharing-context-between-claude-code-and-codex-without-stepping-on-each-1k13)
  - Earlier team evidence: r/ClaudeCode context-loss thread, r/codex "how do you share coding session between Claude and Codex", and a "Handoff" tool post. — [r/ClaudeCode](https://www.reddit.com/r/ClaudeCode/comments/1qn5tfc/how_do_you_handle_context_loss_between_claude/), [r/codex](https://www.reddit.com/r/codex/comments/1uzv7pt/how_do_you_share_codding_session_between_claude/) (cited in the earlier docs, not re-read)
- **Instruction-file sprawl (moderate).** Claude Code reads CLAUDE.md while Codex and most others read AGENTS.md. Practitioners report the duplicated files drifting apart and fix it with symlinks (`ln -s AGENTS.md CLAUDE.md`) or `@AGENTS.md` imports. — [Plexus guide](https://minilv.github.io/Plexus/how-to-keep-claude-md-and-agents-md-in-sync.html), [dev.to "One AGENTS.md for every agent"](https://dev.to/mudassirworks/one-agentsmd-for-every-coding-agent-stop-maintaining-claudemd-and-geminimd-separately-34g4), [Tessl on AGENTS.md as single source of truth](https://tessl.io/blog/the-rise-of-agents-md-an-open-standard-and-single-source-of-truth-for-ai-coding-agents/). One write-up says Claude Code now reads AGENTS.md when no CLAUDE.md exists (v2.1.277+), which reduces this pain. — [lotsnotes](https://lotsnotes.com/blog/claude-code-handoff) (UNVERIFIED version claim)
- An arXiv study analysed 2,303 context files from 1,925 repos across Claude Code, Codex and Copilot. This is academic evidence that these files are widespread. Evidence on whether they help is described as mixed. — [arXiv 2511.12884](https://web3.arxiv.org/pdf/2511.12884) (search summary)
- **Compaction loses detail (moderate, many practitioner posts).** Compaction drops file paths, architectural decisions, exact error messages and progress state, and keeps "the gist". — [dev.to compaction 2026](https://dev.to/jsmanifest/claude-code-session-compaction-in-2026-how-context-summarization-works-and-what-your-agent-forgets-am0), [bswen 2026-02-09](https://docs.bswen.com/blog/2026-02-09-claude-context-loss-compaction/), [chudi.dev](https://chudi.dev/blog/claude-context-management-dev-docs)
- **Context rot (anecdote/blog).** One author reports the model forgetting earlier decisions, contradicting itself and repeating completed work, with degradation from about 65% context use. This is not a benchmark. — [vincentvandeth.nl](https://vincentvandeth.nl/blog/context-rot-claude-code-automatic-rotation); compaction buffer ~33k tokens — [claudefa.st](https://claudefa.st/blog/guide/mechanics/context-buffer-management)
- **Session resume bug (hard evidence, single vendor).** `--resume`/`--continue` lose prior context. — [anthropics/claude-code #43696](https://github.com/anthropics/claude-code/issues/43696) (2026-04-04, from earlier docs)
- **Multi-agent product failures (moderate, academic).** The Berkeley MAST study (1,600+ traces, 7 frameworks) reports failure rates of 41%–86.7%, with ~4 in 5 failures due to specification/coordination rather than model limits. Reported second-hand by Atlan. Vendors claim "context inconsistency" is the top production failure cause, which is an industry view, not a measurement. — [Atlan orchestration](https://atlan.com/know/multi-agent-system-orchestration/), [Atlan interoperability](https://atlan.com/know/agent-interoperability-protocols/)
- **Token cost.** Searches returned **no direct practitioner complaints** about the token cost of pasting long transcripts. The closest is advice to push large reads into subagents. — [mindstudio /compact](https://www.mindstudio.ai/blog/claude-code-compact-command-context-management). DX estimates $200–600/dev/month for agentic tool spend. — [DX](https://getdx.com/blog/ai-coding-assistant-pricing/) (from earlier docs)

### Inferences
- **Strong evidence:** that people move context between Claude Code and Codex, and that compaction and resume lose detail. **Anecdote:** reasons and feelings, since no quote has been verified verbatim.
- The pain is mostly felt by individuals and handled with free tools, which matches the earlier docs' finding that solo devs won't pay much. CTM needs a payer whose pain is *cost at scale* or *audit*, not convenience.
- The HN comment that cross-provider transfer "loses the reasoning" is the gap CTM's latent (KV) layer aims at, but that layer only works within open-weight families and is research stage.

### Gaps
- No verbatim quotes. HN, Reddit and SO need to be unblocked, then quotes copied with permalinks.
- No survey quantifying time lost to re-explaining context between agents or teammates.
- No evidence yet that team leads track token spend from long-context handoffs as a budget line.

---

## Q3. Current workarounds and why they are unsatisfying

### Takeaway
Workarounds fall into five groups: (1) shared instruction files (AGENTS.md/CLAUDE.md symlinks), (2) hand-written handoff markdown, (3) session-transfer CLIs, (4) memory MCP servers (Mem0, Zep, Letta, etc.), and (5) vendor-native memory and capture (Claude Code JSONL, Entire Checkpoints). None of them gives cited, cross-vendor, compact, locally stored context. The memory vendors have moved *away* from local: Mem0's local server is sunset and Zep's self-hosted edition is discontinued.

### Cited Findings
- **Instruction files:** they are static, cover rules not task state, and drift when duplicated. — [Plexus](https://minilv.github.io/Plexus/how-to-keep-claude-md-and-agents-md-in-sync.html), [the-prompt-shelf](https://the-prompt-shelf.pages.dev/blog/writing-effective-agentsmd-guide)
- **Handoff notes/files:** recommended before compaction or at session end, but they depend on discipline. A chat-only instruction survives only if the summary kept it. — [bswen](https://docs.bswen.com/blog/2026-02-09-claude-context-loss-compaction/), [lotsnotes](https://lotsnotes.com/blog/claude-code-handoff), [Portable Handoff](https://baeseokjae.github.io/posts/portable-handoff-agent-context/)
- **Session transfer tools** (ctx, Handoff, Coincide, authsec-bridge): they move a recap or the transcript, not a cited, queryable structure, and per the HN comment they lose the model's reasoning. Most are free personal projects. — see links in Q2
- **Mem0:** its primary MCP server sends memories to Mem0's cloud. Graph memory is paywalled (Pro, reportedly $249/mo) and was removed from the OSS SDK. It has no native temporal model, stale facts persist, and a CVSS 8.1 injection vuln was disclosed 2026-04-17. OpenMemory (local MCP) was sunset in April 2026 and removed on 2026-07-29. — [Atlan](https://atlan.com/know/best-ai-agent-memory-frameworks-2026/), [ChatForest](https://chatforest.com/reviews/mem0-mcp-server/), [coworker.ai](https://coworker.ai/blog/best-mcp-memory-servers) (vendor-authored comparisons, cross-check)
- **Zep:** self-hosted Community Edition discontinued (Apr 2025). Setup needs Postgres + pgvector + Neo4j. Cypher injection CVE-2026-32247 (Mar 2026). Its strength is temporal reasoning. — [vectorize.io](https://vectorize.io/articles/mem0-vs-zep), [maximem](https://www.maximem.ai/compare/mem0-vs-zep)
- Multi-agent shared memory "requires custom implementation; it is not native" (Atlan), versus Mem0's shared `user_id` with a different `agent_id` pattern. — [Atlan](https://atlan.com/know/best-ai-agent-memory-frameworks-2026/), [vectorize.io](https://vectorize.io/articles/mem0-vs-zep)
- **Protocols:** MCP connects agents to tools and A2A handles delegation, but neither defines shared *meaning*. Commentators call this a semantic gap. — [Atlan interoperability](https://atlan.com/know/agent-interoperability-protocols/), [glukhov A2A 2026](https://www.glukhov.org/ai-systems/comparisons/a2a-protocol-2026-adoption/)
- **Vendor-native capture:** Entire raised a $60M seed for Checkpoints, which are free. Claude Code stores local JSONL with 30-day default deletion. — [TechCrunch on Entire](https://techcrunch.com/2026/02/10/former-github-ceo-raises-record-60m-dev-tool-seed-round-at-300m-valuation/), earlier docs

### Inferences
- CTM's open lane is the combination of **local + cross-vendor + cited + compact**. Each workaround covers one or two of these at most. Local memory servers are being abandoned by the funded vendors, so "runs locally, open-source" is a real differentiator now, though a crowd of small OSS MCP memory servers also exists (SynaBun, Dakera, Hindsight, omegamax lists).
- Risk: the vendors (Anthropic, OpenAI) or Entire could ship cross-agent handoff natively. AGENTS.md convergence already reduces one pain.

### Gaps
- No user reviews (G2, etc.) of Mem0 or Zep from teams using them *between coding agents* specifically.
- Pricing of Zep's seat-based MCP server is not confirmed.

---

## Q4. Candidate ICP segments: evaluation and ranking

### Takeaway
Recommended ranking: **(1) AI-native startups/agencies with 5–50 engineers (design partners and usage), (2) platform/devex teams at mid-size and enterprise companies (revenue), (3) multi-agent product builders (OSS/SDK adoption), (4) open-weight self-hosters (latent-layer research customers, later).** Segment 1 has the clearest pain but weak willingness to pay. Segment 2 has budget and a "local, cited, model-agnostic" buying reason but a long cycle. The deal sizes below are my estimates, as no pricing data was found for this category.

### Cited Findings
- **Segment (a): AI-native startups/agencies, 5–50 engineers**
  - Who: teams already pairing Claude Code with Codex and Cursor. SO 2026 tool shares and the handoff-tool boom show the behaviour (Q1, Q2).
  - Pain today: copy-paste handoffs and compaction loss (Q2 links). Agencies also have a handover deliverable, budgeting 10–15% of fixed-price scope for documentation and handover. — [Scand](https://scand.com/company/blog/it-project-acceptance-in-the-ai-era/) (from earlier docs)
  - How they solve it now: AGENTS.md, HANDOFF.md, free transfer CLIs (Q3).
  - Payer: the founder or CTO. Comparable price points: Nessie Team $80/seat/mo, Supermemory $19–399/mo. — [Nessie pricing](https://nessielabs.com/pricing) (earlier docs), [Supermemory pricing](https://supermemory.ai/pricing)
  - Spend context: DX puts agentic spend at $200–600/dev/month. — [DX](https://getdx.com/blog/ai-coding-assistant-pricing/)
- **Segment (b): platform/devex teams at mid-size and enterprise companies with model-agnostic policies**
  - Who: 81% of G2000 CIOs run 3+ model families, and lock-in avoidance is a stated driver. — [a16z 2025](https://a16z.com/ai-enterprise-2025/), [a16z 2026](https://www.a16z.news/p/leaders-gainers-and-unexpected-winners)
  - Pain: no shared context layer across vendors, governance, and 93% of developers needing attribution to trust AI. — [SO 2026](https://stackoverflow.blog/2026/10/06/the-results-of-the-2026-developer-survey-are-here/)
  - Current tools: AI gateways (LiteLLM, TrueFoundry) handle keys and budgets, not shared context. — [TrueFoundry](https://www.truefoundry.com/blog/self-hosted-open-weight-models-gateway), [Torii token tracking tools](https://www.toriihq.com/articles/seven-tools-for-tracking-ai-token-usage-across-vendors)
  - Crowding in governance/audit: Microsoft Agent Governance Toolkit, Coder, Checkmarx, Codacy, MintMCP audit trails. — [Checkmarx list](https://checkmarx.com/learn/ai-security/ai-coding-assistants-with-audit-trails-and-security-governance-top-8-options/) (earlier docs), [MintMCP](https://www.mintmcp.com/blog/build-audit-trails-ai-coding-agents)
- **Segment (c): open-weight self-hosters (vLLM)**
  - Who: teams running Qwen, GLM, DeepSeek or Kimi on vLLM/SGLang for cost and data control. — [Qovery](https://www.qovery.com/blog/self-host-open-source-llm-setups), [pinggy](https://pinggy.io/blog/best_open_source_self_hosted_llms_for_coding/)
  - Willingness to pay for KV-cache infrastructure is real: Tensormesh (KV-caching inference platform) raised $20M (total $24.5M), with Nvidia, AMD and CoreWeave participating (2026-05-27). LMCache + vLLM reports up to 15× throughput on multi-round QA (MLSys 2026). LMCache has ~10.1k GitHub stars. — [pulse.bot on Tensormesh](https://www.pulse.bot/ai/news/tensormesh-raises-20m-launches-ai-inference-platform-built-on-kv-caching-7aba5cf9-665f-489b-800e-c147e6a0b64e/), [SiliconANGLE](https://siliconangle.com/?p=763478), [MLSys 2026 LMCache](https://mlsys.org/virtual/2026/oral/3646)
  - Academic work on cross-agent KV sharing: LRAgent (ICML 2026) shares the base-model KV across multi-LoRA agents. — [arXiv 2602.01053](https://arxiv.org/abs/2602.01053)
- **Segment (d): multi-agent product builders**
  - Pain: MAST failure rates of 41–86.7%, mostly coordination and specification. MCP and A2A lack shared semantics. — [Atlan](https://atlan.com/know/multi-agent-system-orchestration/), [Atlan interoperability](https://atlan.com/know/agent-interoperability-protocols/)
  - Security concern on the MCP→A2A boundary (IETF draft, June 2026, lateral movement). — summarised in [Atlan interoperability](https://atlan.com/know/agent-interoperability-protocols/) (search summary); see also [arXiv 2609.01693 on verbatim field egress MCP-to-A2A](https://arxiv.org/pdf/2609.01693)

### Inferences
Segment table. Persona, deal size and urgency are **my estimates** unless cited.

| Rank | Segment | Buyer persona | User persona | Budget owner | Deal size (estimate) | Sales motion | Urgency | WTP strength |
|---|---|---|---|---|---|---|---|---|
| 1 | (a) AI-native startups/agencies, 5–50 eng | CTO/founder | Engineers running Claude Code + Codex daily | CTO/founder (tooling budget next to $200–600/dev/mo agent spend) | $0 OSS → $20–50/seat/mo team tier; $3–25k/yr | PLG via OSS + founder-led design partners | High (felt daily) | Weak–moderate: free tools and markdown are "good enough"; the token-savings ROI is the hook |
| 2 | (b) Platform/devex at mid-size/enterprise | VP Eng / Head of Platform; CISO co-signs | Platform engineers, then all developers | Platform/devex or AI-enablement budget | $25–150k/yr self-hosted license + support | Enterprise sales (3–9 months), land through a team already using the OSS | Medium (governance-driven, not burning) | Moderate–strong: budgets exist, local + cited + model-agnostic fits policy; needs SSO, audit export, SOC 2 |
| 3 | (d) Multi-agent product builders | Founding engineer / AI lead | Developers building agent apps | Eng lead | OSS/SDK; usage or hosted tier later $500–5k/mo | Dev-rel, OSS, integrations (LangGraph, A2A, MCP registries) | Medium | Weak now; they build in-house and adopt OSS. Distribution, not revenue |
| 4 | (c) Open-weight self-hosters | Head of ML infra | Inference/ML engineers | Infra/GPU budget | Potentially large ($50k+) but needs production-grade latent layer | Technical sales, benchmarks, papers | Low today for CTM (latent layer is research stage) | Strong for proven KV-cache savings (Tensormesh/LMCache show it), unproven for CTM's cross-family mapper |

- **Ranking rationale:** CTM's measured result (5.4× fewer input tokens, 3.2× faster, same accuracy, n=2 runs) speaks to segments 1 and 2 today. Segment 1 makes the best design partners because of short cycles, visible pain and fast feedback. Segment 2 is where revenue would come from once the token-savings and audit story holds at scale. Segment 4 is the venture-scale "latent layer" story, but it competes with funded KV-cache infrastructure players and needs the research to mature.
- The earlier docs' pick of agencies selling client packets can sit inside segment 1 as a use case (handover to a teammate's or client's agent) rather than being the whole ICP.
- The n=2 benchmark is too thin for enterprise buyers. A 20+ task benchmark across vendors is a prerequisite for segment 2.

### Gaps
- No pricing data for "cross-agent context" products specifically. Nessie and Supermemory are the nearest comparables.
- No interviews. Willingness to pay for every segment is inferred, not observed.
- No data on what share of enterprises let developers use more than one *coding agent* (as opposed to more than one model).

---

## Q5. Security and compliance requirements that make "local, cited, auditable" a buying reason

### Takeaway
Regulated buyers need audit trails that show what an agent read and decided, attributed to a person, and kept for regulator-defined periods. Vendor cloud retention (e.g., Claude Code's 30-day / 5-year opt-in terms) and cloud memory servers clash with that. "Local plus line-level citations plus human approval gate" lines up well with these needs. I found no regulation that specifically mandates coding-agent transcript retention.

### Cited Findings
- HIPAA audit controls, PCI DSS Requirement 10 and SEC/FINRA books-and-records rules apply to AI systems "the instant they touch regulated data" (vendor guide). — [Lorikeet regulated audit-trail guide](https://www.lorikeetcx.ai/articles/ai-agent-audit-trails-regulated-guide)
- A transcript shows what the model said, not what it read, and often credits a service account rather than a person. — [Polygraf AI audit trails](https://www.polygraf.ai/?p=29547) (vendor)
- Auditable coding agents should log diffs, tool calls and decisions as machine-readable events. Suggested retention: 90 days minimum, longer for financial services. This is a vendor recommendation, not law. — [Layer3 Labs](https://www.layer3labs.io/guides/auditable-ai-coding-agents), [MintMCP](https://www.mintmcp.com/blog/build-audit-trails-ai-coding-agents), [Bitloops](https://bitloops.com/resources/governance/audit-trails-for-ai-assisted-development)
- Claude Code retention depended on the model-improvement opt-in: 30 days if opted out, 5 years if opted in (January 2026 analysis; check current terms). — [Data Leverage, "The Coding Agent Data Deal"](https://dataleverage.substack.com/p/the-coding-agent-data-deal)
- Auditors want repository-level evidence and an AIBOM, not policy documents. — [Codacy](https://blog.codacy.com/what-auditors-will-ask-about-ai-generated-code-in-2026) (from earlier docs)
- EU AI Act high-risk obligations are slipping to Dec 2027, so EU-Act urgency is weak. — [Gibson Dunn](https://www.gibsondunn.com/eu-ai-act-omnibus-agreement-postponed-high-risk-deadlines/) (from earlier docs)
- Draft GSA rule: federal contractors disclose AI systems within 30 days of award. — [JD Supra](https://www.jdsupra.com/legalnews/gsa-ai-procurement-rules-would-6012707/) (from earlier docs)
- 65% of agency clients call disclosure of how client data is protected "essentially required". — [AMI](https://agencymanagementinstitute.com/podcasts/2026-agency-edge-insights/) (from earlier docs)
- Memory-server security incidents (Mem0 CVSS 8.1, Zep CVE-2026-32247) give a concrete reason to prefer a small, local, auditable store. — [ChatForest](https://chatforest.com/reviews/mem0-mcp-server/), [maximem](https://www.maximem.ai/compare/mem0-vs-zep)
- Cross-protocol leakage: research on "verbatim field egress" in MCP-to-A2A configurations. — [arXiv 2609.01693](https://arxiv.org/pdf/2609.01693)

### Inferences
- "Transcripts never leave the machine" is a *disqualifier remover* for regulated segment-2 buyers, not a reason to buy on its own. The buying reason is citations + human approval + an exportable audit trail. CTM would need export to the formats auditors use (e.g., Agent Trace, SIEM/JSON events) to turn that into a purchase.
- Local-only also weakens team features (sharing across machines). CTM needs a self-hosted team sync story for segment 2.

### Gaps
- No primary regulatory text checked. Retention periods (FINRA 17a-4, HIPAA 6-year documentation) need confirming from primary sources.
- No evidence of an enterprise RFP that names cross-agent context provenance as a requirement.
