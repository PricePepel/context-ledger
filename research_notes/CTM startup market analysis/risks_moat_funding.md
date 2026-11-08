# CTM (Context Telepathy Manager): Risks, Moat and Fundraising Landscape

Research date: 2026-11-08. Method: WebSearch and WebFetch. arxiv.org and alphaxiv.org did not resolve in this session's network, and GitHub API access to third-party repos was not enabled, so paper abstracts and repo licenses were read via search snippets and mirrors, not primary pages. Many 2025-2026 funding figures come from aggregator sites; they are flagged where unverified.

## 0. Review of the team's earlier work (what is outdated or still holds)

Docs read: `origin/product/v1:docs/strategy/uzcombinator/research-fundability.md`, `.../critic-selection-committee.md`, `docs/strategy/research-engineering-gaps.md` (audit dated 2026-11-06).

- **Framing is outdated.** Both UzCombinator docs assess "Ledger Handover" (signed handover packets for agencies, $249/packet, enterprise verification). CTM is a different pitch (cross-vendor agent context via cited semantic graphs over MCP, plus a latent KV layer). The moat argument there (human approval, redaction, signature, third-party verification) carries over only partly; it is closest to the "trust/audit layer" moat below.
- **"Solo founder" is outdated.** The committee critique treats the founder as solo; the brief now says two founders. The committee's other eligibility questions (citizenship/residency, 45 days full-time in Tashkent, deadline "10 Nov") remain open and the deadline is two days from today.
- **Still holds and was re-confirmed:** Entire raised a $60M seed at a $300M valuation led by Felicis on 2026-02-10, with M12 and Madrona reported; its open-source Checkpoints captures prompts/transcripts alongside commits — [SiliconANGLE](https://siliconangle.com/?p=730571), [TechCrunch mirror](https://hn.jakechampion.name/reader/https://techcrunch.com/2026/02/10/former-github-ceo-raises-record-60m-dev-tool-seed-round-at-300m-valuation). Still secondary-sourced (no primary Entire release fetched).
- **Gap now partly filled:** The fundability doc said Supermemory was "not researched"; it is covered in section 5 below.
- **Platform risk was one line in the earlier doc;** there is now concrete evidence (Claude memory import, March 2026; AAIF governance of MCP/AGENTS.md) — section 1.
- **Still unresolved and important for an "open-source" pitch:** as of `origin/product/v1` head `a51751d` (2026-11-07), there is still no LICENSE file and `package.json` still says `"private": true` (checked locally with `git ls-tree` / `git show`). The audit's "no LICENSE, private" blocker has not been fixed, so CTM cannot yet truthfully be called open source.
- **Committee's base rates** (YC acceptance ~0.73-0.84%, "not fundable until validation") were not re-verified here; nothing found contradicts them.

## 1. Platform risk: will Anthropic, OpenAI, Google, Cursor or GitHub ship cross-vendor context sharing themselves?

### Takeaway
The labs are converging on shared, foundation-governed standards (MCP, AGENTS.md, skills folders) and on one-way "come to us" memory import, but I found no vendor shipping live, two-way, cross-vendor session/context exchange as of Nov 2026. The risk is less that a lab builds CTM than that a neutral spec under AAIF absorbs the "agents publish/read context" pattern, which would commoditize CTM's core unless CTM is the reference implementation.

### Cited Findings
- The Agentic AI Foundation (AAIF) launched under the Linux Foundation on 2025-12-09; Anthropic contributed MCP, Block contributed goose, OpenAI contributed AGENTS.md; launch reporting lists 8 Platinum members, with AWS, Google and Microsoft named in some coverage — [SD Times](https://sdtimes.com/ai/linux-foundation-forms-agentic-ai-foundation-to-be-new-home-for-mcp-goose-and-agents-md/), [Campus Technology, 2025-12-15](https://campustechnology.com/articles/2025/12/15/newly-launched-agentic-ai-foundation-brings-together-tech-giants-for-open-source-ai-development.aspx).
- A2A (Google's Agent2Agent protocol) went to the Linux Foundation as its own project in June 2025; secondary sources report it joining AAIF in August 2026 (dates conflict: 2026-08-17 vs 2026-08-20). Membership reportedly grew from <40 at launch to 170+ (April 2026) or 250+ (August 2026) — [FlowHunt](https://www.flowhunt.io/blog/agentic-ai-foundation-a2a-mcp-standards/), [blckalpaca](https://blckalpaca.at/en/knowledge-base/ai-agents/a2a-protocol-basics/linux-foundation-aaif-meaning). **Unverified against an AAIF primary release; sources conflict.**
- Anthropic launched a memory import tool for Claude in early March 2026 (paste a block exported by prompting ChatGPT/Gemini/Grok into Claude settings); chat-history migration reportedly not supported — [MacRumors, 2026-03-02](https://www.macrumors.com/2026/03/02/anthropic-memory-import-tool/), [TechCabal, 2026-05-27](https://techcabal.com/2026/05/27/4-easy-steps-to-move-your-chatgpt-memory-to-claude/).
- ChatGPT's data export reportedly does not include memory as a clean transferable file — [Medium guide](https://medium.com/@unicodeveloper/how-to-import-memory-into-claude-from-chatgpt-gemini-or-grok-step-by-step-guide-c78ac8f7e4a4) (secondary).
- Codex adopted the SKILL.md skills-folder pattern (`.agents/skills/` vs Claude Code's `.claude/skills/`); Codex reads AGENTS.md; Claude Code reads CLAUDE.md (a CLAUDE.md that imports AGENTS.md is the documented workaround per one source). Cross-agent handoff today is done by community bridge tools; no official Anthropic/OpenAI mechanism for handing a live session between the two was found — [The Prompt Index](https://www.thepromptindex.com/claude-code-skills-vs-openai-codex-skills.html), [besthub.dev](https://besthub.dev/articles/openai-codex-adds-official-skills-support-echoing-claude-s-open-agent-standard-48542ab99638) (secondary, may lag official docs).
- Entire (ex-GitHub CEO, $60M seed) already captures agent session context next to commits — [SiliconANGLE](https://siliconangle.com/?p=730571). It is the most-funded adjacent player that could add cross-agent context read/write.

### Inferences
- Pattern: labs cooperate on *tool/instruction* plumbing (MCP, AGENTS.md, skills) because it grows the ecosystem, but compete on *memory* (import into me, not export out of me). A two-way, vendor-neutral context exchange is the thing least likely to be shipped by any single lab, which is CTM's opening, but also the thing most likely to be specified by AAIF if demand appears.
- Highest near-term threats, in my estimate: (1) Entire or a similar well-funded session-capture tool adding a "read context from other agents" MCP server; (2) an AAIF working group defining a context/memory exchange format; (3) Cursor (multi-model by design) building cross-model memory inside its own IDE, which solves the user problem without a neutral layer.
- Being MCP-native is a hedge: CTM rides the standard rather than competing with it. Contributing the graph schema to AAIF as a proposal is a credible defensive move for a 2-person team.

### Gaps
- No primary AAIF release fetched for the A2A merge date or member counts.
- Did not find any public roadmap statement from OpenAI, Google, Cursor or GitHub about cross-vendor memory portability; absence of evidence, not evidence of absence.
- "How have glue-between-platforms startups fared" — no sourced case studies were collected in this pass (budget). The report should not cite specific failures/acquisitions without a source.

## 2. Technical risk for the latent (KV-cache) layer

### Takeaway
Cross-model latent/KV communication is an active, fast-moving 2025-2026 research area with strong published results (C2C at ICLR 2026, LatentMAS at ICML 2026, SwaT Oct 2026, several Aug-Sep 2026 follow-ups), so the idea is credible but not proprietary. All approaches require white-box access to KV caches, so they only work with open-weight (or self-hosted) models, never with Claude/GPT APIs; most need a trained component per sender-receiver pair.

### Cited Findings
- **SwaT** — "Swarm Telepathy: Prefill-Free KV-Cache Transfer Across Families," arXiv 2610.15095 (Alabdulkareem et al.). Claims the first cross-family, prefill-free KV transfer; frozen sender and receiver; trains with <50M tokens and <1 GPU-day; evaluated on 17 benchmarks, 12 LLMs, 6 families; reports vision info from a VLM sender reaching a text-only receiver better than text-to-text; HTML version reportedly gives >90% lowest mean retention in "small to large" pairing; code at Ar-Kareem/SwaT — [arXiv abs (search snippet)](https://arxiv.org/abs/2610.15095), [arXiv HTML](https://arxiv.org/html/2610.15095v1), [GitHub issue noting code and unverified license](https://github.com/mw00/project-maya/issues/655). Mapper size (~300M params, cross-attention blocks) comes from a community write-up only — [brianreborn/familia issue](https://github.com/brianreborn/familia/issues/319). **Could not open the paper directly.**
- **C2C (Cache-to-Cache)** — arXiv 2510.03215, ICLR 2026 (Fu et al., Tsinghua/thu-nics). A neural projector+fuser maps source KV-cache into the target and a learnable gate picks layers; reported 6.4-14.2% higher accuracy than individual models, 3.1-5.4% over text communication, ~2.5x latency speedup (figures differ by paper version) — [arXiv](https://arxiv.org/abs/2510.03215), [ICLR 2026 proceedings](https://proceedings.iclr.cc/paper_files/paper/2026/hash/474ada926b331d78f06d95e8913111cc-Abstract-Conference.html), [HF papers](https://huggingface.co/papers/2510.03215).
- **LatentMAS** — arXiv 2511.20639, ICML 2026. Training-free latent collaboration via last-layer hidden states and a shared layer-wise KV working memory; reported 15-60% fewer tokens and ~4x faster inference vs text multi-agent (4x from a secondary summary); tested on Qwen3 and Llama3; heterogeneous architectures listed as future work (adapters/permutation alignment), i.e., it assumes same architecture/hidden dims — [alphaxiv listing](https://alphaxiv.org/abs/2511.20639), [ICML 2026](https://icml.cc/virtual/2026/poster/61180).
- **Other 2026 cross-model KV work** surfaced: "See What I See, Know What I Think: Dense Latent Communication Across Heterogeneous Agents" (arXiv 2606.13594, lightweight cross-model cache transform, two-phase training) — [deeppaper mirror](https://arxiv.deeppaper.ai/papers/2606.13594); "CacheBridge: Efficient Cross-Model KV Cache Transfer" (arXiv 2609.00891) — [arXiv](https://arxiv.org/pdf/2609.00891); "A Universal Context-Reuse Layer for Cross-Model KV Sharing" (arXiv 2608.30963) — [arXiv](https://arxiv.org/pdf/2608.30963); "LatentPort" (hybrid recurrent-state handoff, 4B to 9B, arXiv 2609.25053) — [arXiv](https://arxiv.org/pdf/2609.25053). Titles from search results; contents not read.
- KVCOMM (training-free KV reuse across overlapping contexts among agents of the same model) reports up to 7.8x speedup in a five-agent setting — [search summary via emergentmind/LatentMAS results](https://www.emergentmind.com/papers/2511.20639) (secondary; exact paper not confirmed).

### Inferences
- **Open-weight only:** every method above reads/writes KV caches or hidden states, which closed APIs (Anthropic, OpenAI, Google) do not expose. The latent layer therefore cannot serve CTM's flagship Claude Code <-> Codex use case; it applies only to Qwen/Kimi/Llama-class self-hosted pairs.
- **Per-pair mappers:** SwaT and C2C train a component per (sender, receiver) pair; N models imply up to N^2 mappers unless a shared latent "hub" space is used (the "Universal Context-Reuse Layer" title suggests others are attacking exactly this). Each model version bump likely invalidates a mapper.
- **CTM's own result is weak evidence:** one run, 0.5B -> 360M, 70% vs 59% containment. Published papers already report larger gains on 12 models; CTM's reimplementation is a replication, not a novelty. Its value is as an engineering demo and recruiting/credibility signal, not a moat.
- **Commercial path:** plausible buyers are inference providers and on-prem/sovereign deployments running heterogeneous open-weight fleets (prefill savings = GPU cost). But inference engines (vLLM/SGLang-class) or the paper authors could ship this as a feature. A 2-person team should treat the latent layer as a research option, not the company.
- **Scale risk:** no evidence found on frontier-size (70B+) pairs or long-context (100K+) transfer; SwaT's ">90% retention small-to-large" is promising but unverified by me.

### Gaps
- Could not read SwaT's or C2C's full text, limitations sections, or licenses (arxiv/alphaxiv blocked; GitHub API blocked for third-party repos).
- No evidence found of any company commercializing cross-model KV transfer.

## 3. Market risk: vitamin or painkiller? Do cheaper tokens and caching erode the value?

### Takeaway
Token-savings alone is a shrinking value proposition: price per unit of capability falls roughly 10x-50x per year by most estimates, and cached input is discounted ~50-90%. The durable pain is not tokens but *continuity and correctness* across agents/vendors/people (lost decisions, re-explaining, unverifiable summaries), plus latency (CTM's 3x speed claim matters more than 5x token claim).

### Cited Findings
- Epoch AI (March 2025): price to reach a fixed benchmark level fell 9x-900x per year depending on threshold, median ~50x/year; GPT-4-level performance on PhD science questions fell ~40x/year — [Epoch AI](https://epoch.ai/data-insights/llm-inference-price-trends).
- A Sept 2026 Epoch post reportedly finds same-performance cost falling 47% per quarter since 2023 (~13x/year) — [pasqualepillitteri.it summary](https://pasqualepillitteri.it/en/news/21044/epoch-ai-ai-prices-fall-47-percent-quarter). **Secondary; original not opened.**
- a16z "LLMflation" (2024): equivalent-performance cost falls ~10x/year — [a16z](https://www.a16z.com/llmflation-llm-inference-cost).
- Counterpoint: while per-token prices fall, the cost of running frontier-level models has risen roughly exponentially, and total inference spend has not fallen in parallel (agents use more tokens per task) — [arXiv 2511.23455](https://arxiv.org/html/2511.23455).
- Prompt caching: Anthropic cache reads ~0.1x input price (90% off) with a premium on cache writes; OpenAI cached input ~50% off; Gemini ~75% off plus storage charges — [techsy.io guide](https://techsy.io/blog/llm-prompt-caching-guide), [memx.app](https://memx.app/blog/prompt-caching-explained-three-providers/). **Low-quality secondary sources that contradict each other on details; verify on official pricing pages.**

### Inferences
- Caching undercuts "5x fewer input tokens" *within one vendor* (re-reading the same transcript is cheap once cached), but caches are per-provider and per-prefix: a Codex agent cannot hit Claude's cache, so cross-vendor handoff is exactly where caching does not help. That is a sharper pitch than raw token savings.
- Longer context windows reduce the hard limit, but do not solve "which of 200K tokens matter, and where did that claim come from." Cited graphs (provenance) and speed are the more durable benefits.
- Vitamin vs painkiller: for individual devs it is a vitamin (copy-paste a summary works). It becomes a painkiller where (a) teams run several vendors' agents on one codebase, (b) compliance requires knowing which source supports a decision, or (c) GPU cost matters (on-prem open-weight fleets — the latent layer). Needs customer interviews; none are evidenced in the repo docs.

### Gaps
- No first-party token price tracker data (Artificial Analysis, OpenRouter) was retrieved.
- No survey data found on how many teams use multiple coding-agent vendors concurrently; this is the key demand statistic to obtain.

## 4. Moat options realistic for a 2-person team

### Takeaway
Of the listed moats, only two are realistic early: (1) becoming the reference open implementation/spec for cited agent context graphs (standard-setting via MCP/AAIF, speed + community), and (2) a trust/provenance layer (citations, redaction, audit) that enterprises pay for. Network effects from shared org graphs are real but only after a team/sync product exists (estimated 10-15 additional engineer-weeks per the team's own audit). Trained mappers are not defensible IP.

### Cited Findings
- Open interop standards now consolidate under AAIF (MCP, AGENTS.md, goose; A2A reported joining 2026) — [SD Times](https://sdtimes.com/ai/linux-foundation-forms-agentic-ai-foundation-to-be-new-home-for-mcp-goose-and-agents-md/), [FlowHunt](https://www.flowhunt.io/blog/agentic-ai-foundation-a2a-mcp-standards/).
- SwaT trains its mapper in <1 GPU-day on <50M tokens — [arXiv 2610.15095](https://arxiv.org/abs/2610.15095); C2C code is public — [arXiv 2510.03215](https://arxiv.org/abs/2510.03215).
- Session capture is funded and moving toward commodity (Entire $60M seed) — [SiliconANGLE](https://siliconangle.com/?p=730571).
- Team's own audit: team sync/sharing is L (6-10 engineer-weeks), smallest sellable single-user product ~12-16 engineer-weeks, team tier ~10-15 more; repo still has no LICENSE — `origin/product/v1:docs/strategy/research-engineering-gaps.md` (internal).

### Inferences
- **Trained mappers as IP: weak.** Methods are published, code is public, training is <1 GPU-day; anyone can retrain. Only a maintained catalogue of mappers for popular model pairs (a "model zoo" service) has some operational value.
- **Standard-setting: realistic but fragile.** Requires shipping early, a clean schema, adapters for many agents, and probably donating/proposing it to AAIF. The moat is mindshare and being the default MCP server, not the spec itself (which by design anyone can implement).
- **Trust/audit layer: most defensible commercially.** Citation-checked graphs, redaction before sharing, signed provenance — aligns with the earlier committee advice and with funded "agent governance" seeds (OpenBox $5M, Capsule $7M etc. per the earlier doc; aggregator-sourced).
- **Integrations breadth: necessary, not a moat.** Easy to copy; but a 2-person team that maintains adapters for Claude Code, Codex, Gemini CLI, Cursor, Aider, Qwen/Kimi runtimes faster than competitors gains distribution.
- **Data/network effects:** only if graphs become the shared, accumulating team memory (org knowledge graph). This competes directly with Mem0/Zep/Letta-style memory layers, which are better funded.

### Gaps
- No evidence found of any startup successfully defending an open agent-interop spec commercially (the report should present this as an untested bet).

## 5. Fundraising landscape and comparables

### Takeaway
Capital for agent memory/infra is available and rounds are larger than classic devtools seeds, but the funded comparables mostly had either strong open-source traction (Mem0, Letta from Berkeley MemGPT) or star founders (Entire). CTM today (two early benchmark runs, no license, no users evidenced) is pre-seed/accelerator-stage; YC, a16z speedrun and local UzCombinator are the realistic entry points.

### Cited Findings
**Comparables (amount, date, lead, where public):**
- **Mem0:** $24M total announced 2025-10-28 — seed led by Kindred Ventures (~$3.9M) and ~$20M Series A led by Basis Set Ventures, with Peak XV, GitHub Fund and Y Combinator participating — [BuiltIn](https://builtin.com/articles/mem0-raises-24m-AI-memory-infrastructure-20251103), [Inc42](https://inc42.com/buzz/mem0-raises-24-mn-to-scale-its-ai-memory-infrastructure). A claimed $150M valuation / Lightspeed lead on one site conflicts with press releases and is **unreliable**; no reliable valuation found.
- **Letta** (UC Berkeley MemGPT spinout): $10M seed, Sept 2024, led by Felicis; Essence VC, Sunflower Capital; angels incl. Jeff Dean, Clem Delangue — [PR Newswire](https://prnewswire.com/news-releases/berkeley-ai-research-lab-spinout-letta-raises-10m-seed-financing-led-by-felicis-to-build-ai-with-memory-302257004.html).
- **Supermemory:** ~$2.6M seed (some trackers say $3M pre-seed), Oct 2025, led by Susa Ventures, Browder Capital, SF1.vc; angels incl. Jeff Dean, Logan Kilpatrick, David Cramer; solo young founder (Dhravya Shah) — [Supermemory blog](https://supermemory.ai/blog/supermemory-raises-3-million-and-building-the-best-memory-engine-for-llms), [Gulf News](https://gulfnews.com/lifestyle/how-middle-class-mumbai-teen-raised-26m-for-ai-startup-after-dropping-out-of-college-1.500297584).
- **Zep:** YC W24; trackers show ~$0.5M-$2.3M raised by 2024 — [CB Insights](https://www.cbinsights.com/company/zep-2/financials), [VCBacked](https://www.vcbacked.co/company/zep-ai). A claimed $20M Felicis seed (Dec 2025) appears on one blog only — [CallSphere](https://www.callsphere.ai/blog/agent-memory-problem-startups-building-long-term-memory-ai-agents). **Uncorroborated; do not cite as fact.**
- **Entire:** $60M seed at $300M, Feb 2026, Felicis lead — [TechCrunch mirror](https://hn.jakechampion.name/reader/https://techcrunch.com/2026/02/10/former-github-ceo-raises-record-60m-dev-tool-seed-round-at-300m-valuation). Outlier driven by founder pedigree.
- **2026 agent-infra rounds (aggregator-sourced, unverified):** Sail Research $80M seed+A (2026-06-25, long-horizon agent infra) — [building.it.com](https://building.it.com/articles/sail-research-seed-funding); Archestra.AI $10M seed and CopilotKit $27M Series A (May-June 2026) — [newmarketpitch](https://newmarketpitch.com/blogs/news/agentic-ai-funding-news). Carta median seed post-money ~$24M by Q4 2025 (per a vendor guide) — [Causo](https://hub.causo.ai/guides/raising-seed-for-ai-agent-startup-2026).

**Accelerators and terms:**
- **Y Combinator:** $500K standard deal: $125K for 7% plus $375K uncapped SAFE with MFN — [YC deal page](https://ycombinator.com/deal), [YC blog](https://www.ycombinator.com/blog/ycs-500-000-standard-deal).
- **a16z speedrun:** SR007 applications opened Oct 2026 — [a16z](https://a16z.com/applications-for-a16z-speedrun-sr007-are-now-open/). Reported terms: up to $1M ($500K upfront for 10% + $500K follow-on), 12 weeks in SF — [Causo guide](https://hub.causo.ai/guides/how-to-apply-to-a16z-speedrun-2026). **Terms secondary-sourced.** (Speedrun historically games-focused, broadened to general tech.)
- **UzCombinator** (from earlier team doc, not re-verified today): 45 days, $1,000 stipend, office, up to $1M available at Demo Day (Season 2); Season 1: 1,453 applicants, 31 founders, $975K raised at Demo Day — [gov.uz](https://gov.uz/oz/yoshlar/news/view/193066). Local median pre-seed tickets $20K-$100K (Aloqa, IT Park Ventures, UzVC, Yoshlar) — [Kun.uz, 2026-05-23](https://kun.uz/en/news/2026/05/23/how-much-startup-funding-can-you-raise-in-uzbekistan-693a5e).
- **Entrepreneur First:** not researched in this pass.

### Inferences
- What the funded comps had that CTM lacks: open-source traction (stars/downloads/active users), a clear single buyer, and (for Letta) a well-known research artifact. CTM's best analog is Supermemory (small team, OSS, early raise ~$2.6-3M from angels + seed funds) — achievable only with visible community adoption.
- Investor ask, inferred: weekly active installs of the MCP server, number of distinct agent vendors connected per user, retention, and at least a handful of teams using it cross-vendor. The 2-run benchmark is a demo, not traction; investors will ask for n>=10 runs, variance, and a public reproducible benchmark.
- The research-heavy latent layer may help with research-minded funds/angels but will look like scope creep to a seed generalist; pitch it as an option.
- Sequencing suggestion: UzCombinator (deadline cited as 10 Nov 2026 in team docs; unverified) for local capital and runway, then YC/speedrun with traction. The 45-day Tashkent full-time requirement must fit.

### Gaps
- No first-party a16z/Sequoia/Menlo/Greylock 2026 agent-infra essays retrieved.
- No reliable valuations for Mem0, Supermemory or Zep.
- No PitchBook/Crunchbase aggregate for AI devtools share of 2026 venture.
- Entrepreneur First and IT Park Uzbekistan programme terms not re-verified.

## 6. Regulatory / legal

### Takeaway
Legal risk is manageable but there are concrete to-dos: add a LICENSE before calling CTM open source; check SwaT/C2C code licenses before copying code (reimplementing from a paper is generally lower risk than copying code, but verify); transcripts contain secrets and personal data, so local-first plus redaction is a selling point; the EU AI Act mainly bites GPAI model providers and high-risk systems, which a developer interop tool generally is not.

### Cited Findings
- SwaT code (Ar-Kareem/SwaT) license was listed as unverified in a public issue — [GitHub issue](https://github.com/mw00/project-maya/issues/655). C2C code is released at thu-nics/C2C — [arXiv 2510.03215](https://arxiv.org/abs/2510.03215); license not verified (GitHub access blocked in session).
- CTM repo (`origin/product/v1`, 2026-11-07): no LICENSE file, `"private": true` (local check).
- EU AI Act: GPAI obligations fall on whoever places a model on the EU market; a downstream actor that only integrates a GPAI model into its system has only AI-system obligations; modifications trigger provider status only above roughly one-third of original training compute; open-source GPAI exemption is lost if monetised and does not apply to systemic-risk models or high-risk systems — [artificialintelligenceact.eu GPAI guidelines overview](https://artificialintelligenceact.eu/gpai-guidelines-overview/), [sota.io](https://sota.io/blog/eu-ai-act-article-53-3-open-source-gpai-partial-exemption-llama-mistral-developer-guide).
- EU AI Act omnibus provisionally delays standalone high-risk obligations to 2027-12-02 — [Gibson Dunn](https://www.gibsondunn.com/eu-ai-act-omnibus-agreement-postponed-high-risk-deadlines/) (from earlier team doc).

### Inferences
- A trained mapper is a small adapter, far below the one-third-compute threshold, so CTM would not become a GPAI provider by training mappers (inference from the threshold; not legal advice).
- Paper vs code: algorithms described in papers are generally not copyright-protected, but code copied from a repo carries its license; arXiv papers carry their own (often non-exclusive arXiv or CC BY) licenses governing the text, not the method. Patents are possible but none found.
- Privacy: transcripts contain code, secrets, customer data; sharing graphs across a team/org is a data-transfer under GDPR if personal data is present. Local-first + redaction + citation-only sharing is the compliant design; the earlier audit flagged that today any local process can read every transcript (no auth token).

### Gaps
- Licenses for SwaT and C2C repos not confirmed.
- No patent search performed on cross-model KV transfer.
- Uzbekistan data-localization rules (personal data of Uzbek citizens stored locally) not researched; relevant if UzCombinator / local clients.
