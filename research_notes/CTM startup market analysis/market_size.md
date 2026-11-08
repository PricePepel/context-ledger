# Market size (TAM/SAM/SOM) for CTM (Context Telepathy Manager), as of 2026-11-08

Method note: web search was available, but page fetches to the primary hosts (menlovc.com, blog.jetbrains.com, wikipedia.org) were blocked in this session's network. Most figures below therefore come from search-result summaries of primary pages, or from secondary press. Each line says which it is. "Reported" means a number a vendor, analyst or survey published. "Estimate (ours)" means our own arithmetic, with the assumptions shown.

## Q0. Check of the team's earlier sizing work (origin/product/v1)

### Takeaway
The earlier `uzcombinator/research-market-sizing.md` sizes a **different product**: signed handover packets for dev agencies in Central Asia, the CIS and Eastern Europe ($86M TAM, $11M SAM, $0.85M SOM). None of those numbers should be reused as CTM's market. CTM is a global, cross-vendor agent-interop and context layer, and its buyer is an engineering team running 2+ agent vendors, not an agency doing fixed-price handovers. Several of its input facts are still valid and are reused below.

### Cited Findings
- Still valid and consistent with 2026 data:
  - JetBrains 2026: 90% of pro devs use agents weekly, 68% daily; Claude Code adoption 39%. This matches the August 2026 JetBrains survey summaries — [JetBrains Research](https://blog.jetbrains.com/research/2026/08/18/ai-coding-agent-adoption-2026), [ADTmag](https://adtmag.com/articles/jetbrains-survey-finds-ai-coding-agents-becoming-routine-developer-tools.aspx)
  - SO 65.9% use coding assistants or agents. This matches the 66% in the October 2026 SO survey — [Stack Overflow blog](https://stackoverflow.blog/2026/10/06/the-results-of-the-2026-developer-survey-are-here/)
- **F17, Copilot 4.7M paid subscribers.** The old doc marks this UNVERIFIED, but it is now corroborated: Nadella cited 4.7M paid Copilot subscribers, +75% YoY, on the January 28, 2026 earnings call — [MarketBeat call summary](https://www.marketbeat.com/instant-alerts/microsoft-q2-earnings-call-highlights-2026-01-28/?.tsrc=rss). The "~140k orgs" figure is still unverified, and the 4.7M figure is ten months old.
- **Pricing inconsistency between the two old docs.** The sizing doc says Nessie "$80/seat Team is UNVERIFIED". The competitor doc cites nessielabs.com/pricing for Team at $80/seat/mo. One of them is stale; the competitor doc, which cites the vendor page, is the better source.
- **Stray text in a committed file.** `docs/strategy/research-market.md` on origin/product/v1 ends with a line of tool error text ("You've reached Firecrawl's daily limit..."). It should be removed.
- **Stale or unsupported inputs in the old sizing.**
  - Every agency-count multiplier (A1, A2, the 35% fixed-price share, the 80% agent share applied to firms) is marked UNVERIFIED in the doc itself.
  - The F16 AI-governance ranges ($0.34B–$0.94B for 2025) come from three vendor reports that differ by about 3x. That is not a reliable cross-check.
  - The "Upsell TAM ≈$140M" rests on four stacked unverified assumptions.
- **What the old competitor doc gets right for CTM.** The strongest objection is still platform absorption: Anthropic auto-memory, Codex resume, Entire ($60M seed) and Nessie (an MCP server covering Claude Code and Codex). That objection shrinks CTM's addressable segment to **cross-vendor** teams. This is the basis for the SAM filter below.

### Inferences
- Reuse the old docs' facts (JetBrains, SO, Copilot) and the competitor price anchors ($79–80/seat/mo team context tools). Do not reuse their TAM, SAM or SOM.

### Gaps
- Primary Nessie and ContextStream pricing pages were not re-fetched this session.

## Q1. AI coding assistant / coding agent market: size, growth, developer counts, multi-vendor share

### Takeaway
On spend, the coding-agent market in 2026 is far larger than the market-research "AI code assistant" reports show (about $5–10B). Menlo Ventures estimates **enterprise AI coding spend at about $34B** (to Sept 2026), with Claude Code and Codex taking **$24B (70%)**. That is up from $4.0B in Menlo's 2025 report. Vendor run rates (Anthropic, Cursor) are consistent with the Menlo figure.
- Developers: about **36.5M professional developers** (early 2025), and roughly 60–90% of them use AI coding agents, depending on the survey.
- Multi-tool use is the norm: about 85% use 2+ AI tools (biased sample). No survey cleanly measures "2+ coding-agent vendors".

### Cited Findings

**Spend: analyst and VC estimates**
- Menlo 2025 report (published Dec 9, 2025). Survey of 495 US enterprise decision-makers, Nov 2025, plus a bottom-up model.
  - Enterprise gen-AI spend in 2025: $37B (3.2x YoY).
  - Coding: $4.0B, about 55% of $7.3B departmental AI spend, up from $550M the prior year.
  - Anthropic: 40% of enterprise LLM API spend vs OpenAI 27%. Its coding share is reported (secondary) at 54% vs 21%.
  - Sources: [SaaStr](https://www.saastr.com/55-of-all-departmental-ai-spend-is-now-on-coding-and-its-not-slowing-down), [NoJitter](https://www.nojitter.com/ai-automation/menlo-ventures-estimates-19-billion-in-gen-ai-spend-during-2025), [Menlo](https://menlovc.com/perspective/2025-the-state-of-generative-AI-in-the-enterprise/)
- Menlo 2026 report (published Nov 3, 2026; secondary summaries).
  - Enterprise AI spend: $176.8B by Sept 2026, up 5.4x from $33B a year earlier.
  - Enterprise LLM API share: Anthropic 55%, OpenAI 31%, Google 9%.
  - Claude Code and Codex: $24.0B, 70% of about $34B AI coding spend.
  - Agents generate 80% of OpenRouter tokens.
  - Caveat: Menlo is an Anthropic investor.
  - Sources: [LetsDataScience](https://letsdatascience.com/news/menlo-ventures-report-puts-2026-enterprise-ai-spend-at-177-b-5671d63f), [FourWeekMBA – coding](https://fourweekmba.com/ai-menlo-claude-code-and-codex-now-take-70-of-34b-ai-coding/), [FourWeekMBA – API share](https://fourweekmba.com/ai-anthropics-enterprise-api-share-is-now-6x-googles-at-55/)
- Market-research "AI code assistant" reports are much smaller and disagree widely:
  - Meticulous: $4.60B (2025) to about $9.8B (2026), then $68.7B by 2036.
  - Astute: $4.2B (2025) to $40B by 2035.
  - SNS Insider: $5.42B (2026) to $19.43B by 2035.
  - MarketsandMarkets: $8.14B (2025) to $127.05B by 2032 (48.1% CAGR).
  - Sources: [Meticulous](https://www.meticulousresearch.com/product/ai-code-assistants-market-6877), [SNS Insider](https://snsinsider.com/reports/ai-code-assistant-market-9087), [MarketsandMarkets](https://www.marketsandmarkets.com/PressReleases/ai-code-assistants.asp)

**Vendor run rates (reported, not audited)**
- Anthropic: about $9B (end 2025), $14B (Feb 2026), $47B (May 2026), then about $65B run rate (end July 2026, per Bloomberg via secondary sources) — [TechEconomy](https://techeconomy.ng/anthropics-annual-revenue-run-rate-tops-65-billion), [Yahoo/Reuters](https://finance.yahoo.com/news/exclusive-anthropic-aims-nearly-triple-170234463.html)
- Claude Code: $1B run rate (Nov 2025), then >$2.5B (Feb 2026). No later official figure found — [getpanto](https://www.getpanto.ai/blog/anthropic-ai-statistics)
- Cursor (Anysphere): $2B ARR (Feb 2026), $3B (late Apr), >$4B (early June 2026). Projected year-end run rate >$6B (CNBC) — [Dealroom](https://dealroom.co/news/134107-cursor-tops-4b-annualized-revenue/)
- Cursor acquisition: a search summary reports SpaceX acquired Cursor for $60B in stock (closed Aug 14, 2026). I could not open a primary source. **Treat as unverified.**

**Users**
- OpenAI Codex: about 600k weekly active users (WAU) at the start of 2026, >5M WAU (June 2, 2026), and 8M active across Codex and ChatGPT Work (July 2026, not split by product). About 20% of users are non-developers — [Constellation](https://constellationr.com/insights/news/openai-touts-broadening-codex-usage-5-million-weekly-active-users), [AIWeekly](https://aiweekly.co/node/7466)
- GitHub Copilot: 4.7M paid subscribers (Jan 2026) — [MarketBeat](https://www.marketbeat.com/instant-alerts/microsoft-q2-earnings-call-highlights-2026-01-28/?.tsrc=rss). A "50M users" figure (July 2026) appears in a single uncorroborated source.

**Developer population**
- SlashData: 47.2M developers including **36.5M professional** (early 2025), up from 21.8M professional in early 2022 — [SlashData](https://www.slashdata.co/post/global-developer-population-trends-2025-how-many-developers-are-there)
- IDC forecast: 40.2M developers (2025) to 58.7M (2029) — [quashbugs summary](https://quashbugs.com/blog/software-engineer-statistics)
- GitHub: 180M+ accounts. These are accounts, not developers.

**Adoption**
- JetBrains Developer Ecosystem 2026 (15k+ respondents, May–July 2026):
  - 90% of professional devs use AI coding agents weekly; 68% daily.
  - Tool share: Claude Code 39%, Copilot 21%, Codex 16%, Cursor 12%.
  - Sources: [ADTmag](https://adtmag.com/articles/jetbrains-survey-finds-ai-coding-agents-becoming-routine-developer-tools.aspx), [i-programmer](https://www.i-programmer.info/news/99-professional/19118-jetbrains-reveals-widespread-adoption-of-ai-coding-agents-.html)
- Stack Overflow 2026 survey (published Oct 6, 2026):
  - 66% use coding assistants or agents; 73% of those use them daily; 26.2% use automated agent workflows.
  - The respondent count is unclear: 16,664 vs about 30,900 in different sources.
  - Sources: [SO blog](https://stackoverflow.blog/2026/10/06/the-results-of-the-2026-developer-survey-are-here/), [@IT](https://atmarkit.itmedia.co.jp/ait/spv/2610/27/news029.html)
- SO April 2026 pulse: agent use at work 59% (vs 31% in 2025); Claude Code 41% to 55% — [SO blog](https://stackoverflow.blog/2026/05/27/agents-on-a-leash-agentic-ai-remains-mostly-monitored-at-work)

**Multi-vendor use**
- Pragmatic Engineer AI tooling survey (about 1,000 subscribers, Jan–Feb 2026):
  - **70% use 2–4 AI tools at once, 15% use 5+**.
  - Codex already has 60% of Cursor's usage.
  - 46% "most loved" Claude Code.
  - Source: [Pragmatic Engineer](https://newsletter.pragmaticengineer.com/p/ai-tooling-2026)
- a16z CIO survey (100 CIOs, June 2025): **37% use 5+ models** (vs 29% in 2024) — [a16z](https://a16z.com/ai-enterprise-2025/), [eMarketer](https://www.emarketer.com/content/openai-leads--anthropic-surges-enterprise-ai-shifts-multi-model-reality)
- Small surveys: "65% run two agents" (n=40, aibuilderclub). Too small to use.

### Inferences
- The relevant 2026 spend pool is "enterprise AI coding spend ≈ $34B (Menlo)". The $5–10B market-research figures are definitional laggards and probably exclude API and agent token spend.
- Tool counts overlap: Claude Code 39% plus Copilot 21% plus Codex 16% plus Cursor 12% in JetBrains is "most used". Combined with the Pragmatic Engineer data, a large minority of teams very likely run **two or more coding-agent vendors**.
- Estimate (ours): **30–50% of agent-using pro devs use 2+ coding-agent vendors** at least weekly. This is not directly measured. Pragmatic Engineer's 85% counts chatbots and its sample skews senior/US.

### Gaps
- No survey reports "% of teams using ≥2 coding-agent vendors in the same repo" or "% pasting transcripts between agents". This is the single most important unmeasured input. Validate with user interviews or the JetBrains raw data.
- No US/EU split found for coding-agent spend. Menlo samples US enterprises only.
- No Claude Code run rate after Feb 2026. Cognition/Windsurf figures were not researched this session.

## Q2. Adjacent markets: agent infrastructure and orchestration, LLM memory/context, LLMOps/observability, enterprise LLM API spend, open-weight inference

### Takeaway
Adjacent-market estimates range from hundreds of millions to tens of billions, depending on the definition.
- The most decision-useful figures are the Menlo enterprise LLM API share and Gartner's agentic-AI spend.
- Niche "agent memory" and "LLM observability" reports put 2025–2026 at roughly $0.5–6B.
- Open-weight models now carry a large share of tokens but a small share of spend, which caps how much the latent (KV-cache) layer can monetize in the near term.

### Cited Findings

**Agentic AI and AI agents**
- Gartner (abstract, Feb 2026): agentic AI software spend **$985B by 2030**, 62.7% CAGR 2025–30. This counts agent capability embedded in all software, not a standalone market — [Gartner](https://www.gartner.com/en/documents/7455226), [TNW audit](https://thenextweb.com/news/auditing-agent-economy-agentic-ai-forecasts)
- Gartner (Sept 2026, blog summary): worldwide AI spending $2.67T in 2026 (+49.5%), heading to $5.95T by 2030. Agentic workflows rise to 50% of gen-AI model revenue by 2030 (from 5% in 2025) — [Software Strategies blog](https://softwarestrategiesblog.com/2026/09/21/gartners-239b-ai-forecast-agentic-workflows-take-half-of-genai-model-revenue/)
- "AI agents market" research reports:
  - MarketsandMarkets: $7.84B (2025) to $52.62B (2030).
  - BCC: $48.3B by 2030.
  - Grand View: $7.6B (2025) to $10.9B (2026).
  - Source: [chatmaxima summary](https://chatmaxima.com/blog/ai-agents-market-size/)

**Agent memory and context**
- Agentic AI orchestration and memory systems:
  - TBRC: $6.35B (2025), 35.5% CAGR.
  - Same category, roughly $37B by 2030 at 40.2% CAGR (press release).
  - SkyQuest: $4.55B base.
  - Sources: [GII/TBRC](https://www.giiresearch.com/report/tbrc1987567-agentic-artificial-intelligence-ai-orchestration.html), [press release](https://lifestyle.folsomlocalnews.com/?p=643523), [SkyQuest](https://www.skyquestt.com/report/agentic-ai-orchestration-and-memory-systems-market)
- Narrow "AI memory systems": $0.52B (2026) to $3.32B (2031). "Semantic memory infrastructure": $145M (2026) — [Knowledge Sourcing](https://www.knowledge-sourcing.com/report/ai-memory-systems-market), [KSI semantic](https://www.knowledge-sourcing.com/report/ai-semantic-memory-infrastructure-market)

**LLMOps and observability**
- LLM observability:
  - Market.us: $672.8M (2025) to $8.1B (2034).
  - TBRC: $1.97B (2025) to $6.80B (2029).
  - Citi Ventures: about $2B (2025) to more than $9B (2030).
  - Sources: [Market.us](https://scoop.market.us/llm-observability-platform-market-news/), [MarketResearch/TBRC](https://www.marketresearch.com/Business-Research-Company-v4006/Large-Language-Model-LLM-Observability-43145964), [Sahm/Citi](https://www.sahmcapital.com/news/content/citi-ventures-sees-llm-observability-market-rising-from-nearly-2-billion-in-2025-to-more-than-9-billion-by-2030-2026-07-14)
- LLMOps software: $4.39B (2025, Bosson) or $5.12B (2025) to $20.14B (2032, LP Information) — [Bosson](https://www.marketresearch.com/Bosson-Research-v4252/Global-Large-Language-Model-Operationalization-44399614), [LP Info](https://www.marketresearch.com/LP-Information-Inc-v4134/Global-Large-Language-Model-Operationalization-44137881)

**Enterprise LLM API spend**
- $3.5B (Nov 2024) to $8.4B (mid-2025), per Menlo's July 2025 update — [NatLawReview](https://natlawreview.com/press-releases/enterprise-llm-spend-reaches-84b-anthropic-overtakes-openai-according-new)
- Menlo 2026: Anthropic and OpenAI hold 86% of enterprise API spend (above). No clean 2026 total API figure was found in summaries.

**Open-weight inference**
- Survey of 200 enterprises (Sept 2026): open-weight models are **34% of enterprise token usage** (vs 23% a year earlier), expected to reach 41% — [Techstrong](https://techstrong.ai/articles/open-weight-ai-models-expected-to-capture-41-of-enterprise-token-usage/)
- Futurum, same sample: 42% of enterprises use open-weight models in production — [Futurum PDF](https://futurumgroup.com/wp-content/uploads/2026/10/Enterprises-Embrace-Open-Weights-but-Infrastructure-Sellers-Profit-Most_AIONP202610.pdf)
- Vercel AI Gateway: open-weight models are 56% of production tokens but **about 14% of spend** (Aug 2026) — [Techstrong](https://techstrong.ai/articles/open-weight-ai-models-seize-token-lead-but-proprietary-systems-still-make-the-money/)
- OpenRouter: about 72% of tokens are open-weight (mid-Sept 2026), 69% from Chinese labs (secondary, same source cluster).

### Inferences
- Top-down slice for CTM's core (estimate, ours):
  - If a cross-agent context/interop layer captured 1–3% of the about $34B AI coding spend, that is **$0.3–1.0B/yr** (2026 basis).
  - This sits inside the $0.5–6B "agent memory/orchestration" report range, which supports the plausibility of the order of magnitude.
- The latent KV-transfer layer targets self-hosted multi-family open-weight inference. Token volume there is large, but monetized spend is about 14% of gateway spend, and infrastructure sellers capture most of it (Futurum).
  - Treat it as R&D and option value, not a 2026–2028 revenue line.
  - Cross-family KV transfer is unproven beyond small models (CTM's own run: 0.5B to 360M).

### Gaps
- No credible standalone size exists for "agent interoperability" or "MCP tooling". No MCP-adoption counts were gathered this session.
- No self-hosted vLLM/open-weight inference spend in dollars was found.
- No US/EU split was found for adjacent markets.

## Q3. Token spend per developer and team for agentic coding (value driver)

### Takeaway
Anthropic's own docs put **Claude Code enterprise spend at about $13 per dev per active day, or $150–250 per dev per month**. That doubled from the $6/day the docs showed before April 2026, and 90% of users stay under $30/day. CTM's measured result (about 5.4x fewer input tokens and about 3.2x faster on a cross-agent read) makes the value per cross-agent handoff concrete. The share of total spend that goes to cross-agent reads is unmeasured.

### Cited Findings
- Claude Code cost docs: about $13/dev/active day, $150–250/dev/month, under $30/day for 90% of users — [Claude Code docs](https://code.claude.com/docs/en/costs?ref=t01.li)
- The docs previously said $6/day; Business Insider reported the change — [Yahoo/BI](https://finance.yahoo.com/sectors/technology/articles/anthropic-quietly-doubles-estimate-much-220101627.html), [LetsDataScience](https://letsdatascience.com/news/anthropic-doubles-claude-code-developer-cost-estimate-2f1d51b3)
- Third-party estimates: $50–200 and $100–200/dev/month (blog estimates, not data) — [Verdent](https://www.verdent.ai/guides/claude-code-pricing-2026), [eesel](https://www.eesel.ai/blog/claude-code-pricing)
- Seat anchors:
  - Claude Enterprise is reported at about $20/seat/mo with a 20-seat minimum, plus usage at API rates (secondary, unverified) — [eesel](https://www.eesel.ai/blog/claude-code-pricing)
  - Competitor context tools: ContextStream $79/user/mo; Nessie Team $80/seat/mo (from the team's competitor doc).
- CTM's measured result (product fact, 2 runs): 54k vs 291k input tokens (−81%) and 10.6s vs 33.7s for a question about a 68k-token colleague session.

### Inferences (estimate, ours)
- Value per cross-agent read:
  - Saved tokens: 237k input tokens. At about $1.25–3 per M input tokens (frontier-model list prices, unverified this session), that is roughly $0.30–0.70 per read before cache discounts, plus about 23s saved.
  - At 3–10 cross-agent reads per dev-day, that is about $1–7/dev/day of tokens, or $20–150/month, but only for devs who actually work across vendors.
- Conservative framing: if cross-agent context transfer is 5–10% of a $200/mo agent bill and CTM cuts it by about 80%, the saving is **$8–16/dev/mo**. Capturing 30–50% of that supports **$3–8/dev/mo** on token value alone.
- Time value plus governance and audit value plausibly lift willingness to pay to a $10–20/dev/mo team tier. That is still well under the $79–80 anchors for context tools.

### Gaps
- No published Codex or Cursor per-developer spend averages were found.
- No data was found on how often devs move context between vendors. Instrument this in the CTM beta.

## Q4. Bottom-up TAM/SAM/SOM (2026 basis, global)

### Takeaway
Estimate, ours:
- **TAM about $1.1B/yr**: devs using 2+ coding-agent vendors, at $10/dev/mo.
- **SAM about $0.25–0.35B/yr**: segments reachable by an open-source, local, self-hostable product, sold bottom-up.
- **SOM about $2–4M ARR in 3 years**: 0.5–1% of SAM.

The top-down cross-check (1–3% of about $34B coding spend = $0.3–1.0B) brackets the TAM.

### Cited Findings (inputs)
- Professional devs: 36.5M (early 2025) — [SlashData](https://www.slashdata.co/post/global-developer-population-trends-2025-how-many-developers-are-there)
- Agent use: 66% (SO 2026) to 90% weekly (JetBrains 2026) — [SO](https://stackoverflow.blog/2026/10/06/the-results-of-the-2026-developer-survey-are-here/), [ADTmag](https://adtmag.com/articles/jetbrains-survey-finds-ai-coding-agents-becoming-routine-developer-tools.aspx)
- Multi-tool: 85% use 2+ AI tools — [Pragmatic Engineer](https://newsletter.pragmaticengineer.com/p/ai-tooling-2026)
- Coding spend: about $34B (Menlo 2026) — [FourWeekMBA](https://fourweekmba.com/ai-menlo-claude-code-and-codex-now-take-70-of-34b-ai-coding/)

### Inferences: the math (all estimates, ours)

| Step | Assumption | Result |
|---|---|---|
| Pro devs (2026, about 3% growth on 36.5M) | ~38M | 38M |
| × using AI coding agents at work | 65% (SO-anchored, below JetBrains) | 24.7M |
| × using 2+ coding-agent vendors | 40% (range 30–50%; unmeasured) | **9.9M devs** |
| ÷ team size | 8 devs/team | ~1.2M teams |
| **TAM** | 9.9M × $10/dev/mo × 12 | **≈$1.19B/yr** (range $0.7B at 30%/$8 to $2.4B at 50%/$15) |
| SAM filter 1 | Orgs that allow local/OSS dev tools without a long procurement cycle (startups, SMB, mid-market and platform teams in enterprise): 50% | 4.9M |
| SAM filter 2 | Reachable by PLG through OSS/MCP distribution (English-first, GitHub-active): 60% | **2.95M devs (~370k teams)** |
| **SAM** | 2.95M × $120/yr | **≈$0.35B/yr** (low case $0.25B) |
| **SOM, Y3 (2029)** | 1% of SAM devs paying = 29.5k seats × $120 | **≈$3.5M ARR** |
| SOM low / high | 0.3% × $96 (~$0.9M) / 1.5% × $180 plus 10 enterprise deals × $50k (~$8.5M) | $0.9M–$8.5M |

- **Team framing check:** 370k SAM teams × 2–3% paying × $1,200/yr ≈ $9–13M. This is above the seat-based base case, which suggests the 1% seat conversion is conservative for teams that adopt.
- **Pricing check:** $10/dev/mo is about 5% of the $200/mo Claude Code spend per dev, and below the $79–80 seat price of context-tool competitors. That is defensible only if the saving is visible, for example through the existing savings meter.
- **Regional split:** no data. Assume roughly North America 35–40%, Europe 25–30%, rest of world 30–40% of the developer base. SlashData and IDC publish regional splits that were not retrieved.
- **Latent layer:** excluded from TAM. It is an option on open-weight multi-family inference. Open-weight is about 34% of enterprise tokens but about 14% of gateway spend (above).

### Gaps
- The multi-vendor share (40%) and the SAM filters (50%, 60%) are the weakest inputs, and none is sourced. The TAM moves linearly with each.
- Open-source-to-paid conversion benchmarks for dev tools were not sourced this session.

## Q5. Which analyst forecasts are most credible, and where they disagree

### Takeaway
For CTM's purposes, VC and vendor-anchored estimates are the most decision-useful: Menlo (survey plus bottom-up model, n≈495) and vendor run rates. Gartner is credible on direction but sizes "spend including embedded agent features", so its figures are an order of magnitude larger. The single-number market-research vendors (MarketsandMarkets, Meticulous, TBRC, etc.) disagree by 3–25x and lag real spend.

### Cited Findings
- Menlo: transparent survey plus model, but US-only and Menlo is an Anthropic investor. Its 2025 coding figure ($4.0B) vs 2026 ($34B) implies an extremely fast ramp — [SaaStr](https://www.saastr.com/55-of-all-departmental-ai-spend-is-now-on-coding-and-its-not-slowing-down), [FourWeekMBA](https://fourweekmba.com/ai-menlo-claude-code-and-codex-now-take-70-of-34b-ai-coding/)
- Gartner does not size a standalone "AI agents market". Its $985B (2030) agentic figure counts agent features embedded in existing software — [TNW](https://thenextweb.com/news/auditing-agent-economy-agentic-ai-forecasts), [Gartner](https://www.gartner.com/en/documents/7455226)
- Code-assistant 2025 base ranges from $4.2B (Astute) to $8.14B (MarketsandMarkets); 2032–2036 forecasts range from $19B to $127B — [Meticulous](https://www.meticulousresearch.com/product/ai-code-assistants-market-6877), [MarketsandMarkets](https://www.marketsandmarkets.com/PressReleases/ai-code-assistants.asp)
- Open-weight share disagrees by method: 34% (enterprise survey tokens), 56% (Vercel tokens), 72% (OpenRouter tokens), but 14% (Vercel spend) — [Techstrong](https://techstrong.ai/articles/open-weight-ai-models-seize-token-lead-but-proprietary-systems-still-make-the-money/)
- a16z 2025 CIO survey (n=100): the multi-model signal (37% use 5+ models) is directionally strong, but the sample is small — [a16z](https://a16z.com/ai-enterprise-2025/)

### Inferences
- Anchor the pitch on Menlo's $34B coding spend plus Anthropic and Cursor run rates (reported), and present CTM's slice bottom-up.
- Cite Gartner only for direction.
- Avoid quoting MarketsandMarkets-type CAGRs as evidence.

### Gaps
- IDC, Bain and McKinsey coding-agent-specific sizing was not retrieved this session.
- Menlo's 2026 report, the JetBrains post and Wikipedia could not be opened directly (network block). All of them were read via summaries. Re-verify the $34B, $24B, 55% and 90% figures against the primaries before external use.
