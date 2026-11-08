# CTM (Context Telepathy Manager): Business Model, Pricing and Go-to-Market

Research date: 2026-11-08. Method note: direct page fetches (mem0.ai, getzep.com, langchain.com, letta.com) were blocked by this session's network allowlist, so the findings below come from web-search result pages. Many of these are third-party pricing trackers (pricingsaas, costbench, usagepricing, toolradar), not the vendors' own pages. Each figure says which kind of source it rests on. Re-check every price on the vendor's own page before using it in a pitch or on a pricing page.

## Q0. Check of the team's earlier work (origin/product/v1: docs/strategy/research-distribution.md, product-plan.md, both dated 2026-11-06)

### Takeaway
The distribution research is mostly still sound, but parts of its MCP-directory picture went stale in late Oct 2026. The product plan sells something narrower than CTM's current pitch: "Ledger Handover", signed and human-approved handover packets for dev agencies at $249 per packet or $149/mo. That is a different buyer and value story from "cross-vendor agents share a cited graph and save tokens." The founders need to pick one framing or explicitly sequence the two.

### Cited Findings
- **Smithery changed (new since the 6 Nov docs; one vendor-blog source):** Smithery's MCP proxy shut down on 31 Oct 2026, and smithery.ai continues as a plain directory run by Arcade.dev. Paid subscriptions were refunded back to 5 Aug 2026, the day Arcade announced it had acquired Smithery. — [Apideck blog](https://www.apideck.com/blog/mcp-server-directories)
- **PulseMCP paused submissions:** the same post says new server submissions and listing changes are paused on PulseMCP's homepage as of 31 Oct 2026. The distribution doc used PulseMCP's 21,584-server count as its crowding indicator. — [Apideck blog](https://www.apideck.com/blog/mcp-server-directories)
- **Glama:** listing is free and boosted listings cost $49/month ([Apideck blog](https://www.apideck.com/blog/mcp-server-directories)). A review on 28 Oct 2026 counted 111,899 servers, 7,294 of them marked Official ([eSEOspace](https://eseospace.com/blog/glama-mcp/)), so discovery is even more crowded than the doc assumed.
- **Server counts:** deduplicated counts across directories disagree widely: 22,561 distinct servers in a June 2026 report ([State of MCP, June 2026](https://dominion-observatory.sgdata.workers.dev/atlas/report)) against about 9,400 in a May 2026 tracker ([Digital Applied](https://www.digitalapplied.com/blog/mcp-server-ecosystem-tracker-50-servers-cataloged-2026)).
- **Mem0 pricing may have changed:** a PricingSaaS headline dated 27 Oct 2026 says Mem0 dropped its Starter and Pro self-serve plans in favour of Free and Custom. Only the headline was visible. — [PricingSaaS](https://pricingsaas.com/news/article/mem0-drops-starter-and-pro-self-serve-pricing-for-free-and-custom-plans)
- **Claude Code token spend estimate:** Anthropic raised its public estimate of average Claude Code spend from $6 to $13 per developer per active day in mid-April 2026. The product plan doesn't use this figure; it is the anchor for value-based pricing (see Q2). — [Shopifreaks](https://www.shopifreaks.com/anthropic-more-than-doubles-its-public-estimate-of-average-daily-claude-code-spending-from-6-to-13-per-developer/); [Yahoo Finance](https://finance.yahoo.com/sectors/technology/articles/anthropic-quietly-doubles-estimate-much-220101627.html)
- **Native memory confirmed (consistent with the plan's competitor analysis):** Codex memories are local generated state, and Claude Code auto memory isn't shared across machines or cloud environments. — [Mem0 blog on Codex memory](https://mem0.ai/blog/how-memory-works-in-codex-cli)
- **New cross-agent competitors the plan doesn't list:**
  - claude-mem: Apache-2.0, can give Codex access to the same memory through an MCP URL ([neura.market listing](https://neura.market/ai-tools-directory/all/claude-mem))
  - MemNexus: cross-agent memory for Claude Code, Codex, Copilot, Cursor and Windsurf; invite-only, no public pricing ([MemNexus](https://memnexus-marketing-site.pages.dev/))
  - Walrus Memory: portable memory that installs through a Claude Code plugin marketplace ([Walrus blog](https://blog.walrus.xyz/how-to-add-portable-memory-to-claude-code-and-codex-with-walrus-memory/))

### Inferences
- **Still valid in the distribution doc:** use your own `.claude-plugin/marketplace.json` (read by both Claude Code and Codex), publish to the official MCP Registry (which feeds VS Code's `@mcp` gallery), sell nothing inside the plugin (OpenAI bans upsell), and charge for hosted team sync outside the plugin. I found nothing contradicting these points.
- **Outdated in the distribution doc:** Smithery as an install or proxy channel, and PulseMCP as a place to submit. Glama plus the official registry are now the main third-party directories. Mark the "official registry still in preview" status for re-checking; I could not verify it today.
- **Product plan vs. pitch:** the plan's "token savings" story is absent. Its value case is agencies' handover line item (10–15% of project scope). The current CTM pitch leads with cross-vendor interop and 3x speed / 5x fewer tokens. These can coexist: the free OSS layer gets usage on token and speed savings, and paid features sell audit, approval and team sync. Agree this explicitly so the pitch and the plan don't contradict each other.
- **Kill-gate realism:** the plan's own estimate of "3 paying by day 30, 10 by about day 75" is consistent with the enterprise-cycle evidence in Q4 and should stay.

### Gaps
- I could not fetch the official MCP Registry page to confirm whether it is still in preview.
- I could not confirm the Smithery/Arcade or PulseMCP claims from those companies' own pages; there is one source for each.

## Q1. Business model comparables (open-core vs hosted vs usage vs seat; what is paywalled)

### Takeaway
Every comparable gives away the single-developer or local experience. They charge either for usage of a hosted service (Mem0, Zep, PostHog, Supabase, Letta API) or for seats plus usage on collaboration and observability (LangSmith). They then gate SSO, RBAC, audit logs, compliance (SOC 2/HIPAA), BYOC/self-hosting and SLAs in a team or enterprise tier. That is the "buyer-based open core" pattern: features that individual contributors want stay free, and features managers and execs want are paid.

### Cited Findings
- **Buyer-based open core:** a framework coined at GitLab by Sid Sijbrandij. Features an individual contributor wants stay open; features managers and executives want are proprietary. It is most often used by companies that charge per user tier. — [Open Core Ventures handbook](https://handbook.opencoreventures.com/buyer-based-segmentation); [OCV blog](https://www.opencoreventures.com/blog/a-standard-pricing-model-for-open-core)
- **Typical top-tier gates:** SSO, RBAC, audit logs and SLAs usually sit in the top tier; Grafana's enterprise entry is cited at $25k/year. Cal.com moved SAML SSO up a tier between 2023 and 2026. — [DEV Community, "Pricing the open source software vol 2"](https://dev.to/beton/pricing-the-open-source-software-vol-2-145p) (single author, 2026)
- **PostHog:** MIT core with enterprise features (SSO, RBAC) in a separately licensed directory ([DEV Community](https://dev.to/beton/pricing-the-open-source-software-vol-2-145p)). Pricing is usage-based with 1M events free every month and identified events from $0.000248 each ([PostHog pricing](https://posthog.com/pricing); [PostHog analytics pricing](https://posthog.com/product-analytics/pricing)). Its Enterprise plan includes SAML SSO and project permissions, and PostHog publishes enterprise pricing instead of "talk to sales" ([PostHog blog](https://posthog.com/blog/transparent-enterprise-pricing.md)).
- **Grafana:** AGPL dashboards, with enhanced RBAC, audit logging and enterprise plugins proprietary ([OneUptime](https://oneuptime.com/blog/post/2026-03-03-open-source-vs-open-core-whats-the-difference/markdown)). It monetises advanced authentication, reporting and HA ([Monetizely](https://www.getmonetizely.com/articles/what-features-should-you-gate-in-your-open-core-product)).
- **Sentry:** self-hosted is open; the hosted product runs under different terms. — [OneUptime](https://oneuptime.com/blog/post/2026-03-03-open-source-vs-open-core-whats-the-difference/markdown)
- **Supabase:** hosted usage-based, per organisation. Free; Pro $25/month plus usage; Team "from $599/month", which adds SOC 2 and ISO 27001 reports, dashboard SSO, project-scoped/read-only access, HIPAA as a paid add-on, and priority support with SLAs; Enterprise custom. There is no tier between $25 and $599. — [Supabase pricing](https://supabase.com/pricing.md); [Jetadmin review](https://www.jetadmin.io/blog/supabase-review/)
- **HashiCorp (cautionary, 2023, older):** in Aug 2023 HashiCorp moved Terraform, Vault and others from MPL 2.0 to BSL 1.1. This produced the Linux-Foundation-hosted OpenTofu fork, backed by competitors such as Gruntwork, Spacelift and env0, and a "sense of betrayal". One analysis found no discernible effect on HashiCorp's growth a year later. — [TechTarget](https://www.techtarget.com/searchitoperations/news/366610212/OpenTofu-OpenBao-reach-milestones-post-HashiCorp-BSL); [Logz.io](https://logz.io/blog/terraform-is-no-longer-open-source-is-opentofu-opentf-the-successor); [The Stack](https://www.thestack.technology/hashicorps-threats-to-a-terraform-fork-fell-flat-and-might-have-made-it-stronger/)
- **Mem0 (AI memory, hosted API, usage tiers; third-party trackers):** Starter $19/mo (50k add requests, 5k retrievals) and Pro $249/mo (500k adds, 50k retrievals). Graph memory (entity linking), advanced analytics and private Slack support are Pro features. A $79 Growth tier was retired in July 2026. A "Dream" memory-consolidation feature is limited to Pro and Enterprise (Aug 2026). A possible Oct 2026 move to Free plus Custom only is noted in Q0. Sources conflict on whether graph memory is on all plans. — [UsagePricing (Growth retired)](https://www.usagepricing.com/blueprint/activity/mem0-2026-07-21-growth-tier-retired); [UsagePricing (Aug 2026 packaging)](https://usagepricing.com/blueprint/activity/mem0-2026-08-06-packaging); [PricingSaaS 2026Q2](https://pricingsaas.com/companies/mem0/diffs/2026Q2)
- **Zep (AI memory, credits; third-party trackers, conflicting):** a Q2 2026 overhaul is reported as Flex from $25 to $125/mo (50k credits), Flex Plus from $475 to $375/mo (200k credits), annual billing at 17% off, and the Free tier raised to 10k credits. BYOC was folded into a quote-based Enterprise plan in late 2025. — [PricingSaaS 2026Q2](https://pricingsaas.com/companies/getzep/diffs/2026Q2); [Zep blog (metered billing and BYOC)](https://blog.getzep.com/introducing-metered-billing-and-byoc-deployments/)
- **Letta (agent memory; vendor docs):** Pro is $20/mo for personal use with up to 20 stateful agents. The API Plan is $20/mo with unlimited agents plus $0.10 per active agent per month. Letta's marketing page says "unlimited" for Pro, which conflicts. — [Letta docs pricing](https://docs.letta.com/pricing); [letta.com/pricing](https://letta.com/pricing)
- **LangSmith (seat plus usage):** Developer is free with 1 seat; Plus is $39/seat/month, unlimited seats, with 10k base traces a month shared by the org. Sources conflict on the per-trace overage: $2.50, $5 or $7.50 per 1k. — [LangChain pricing](https://langchain.com/pricing); [UsagePricing](https://usagepricing.com/blueprint/langsmith); [CostBench](https://www.costbench.com/software/ai-observability/langsmith/)
- **CrewAI:** as of July 2026 the pricing page reportedly lists only Free (50 workflow executions/mo) and custom Enterprise (up to about 30k executions/mo). An earlier $25 Professional tier appears in 2025 data. — [Activepieces](https://www.activepieces.com/blog/crewai-pricing-for-2026-and-what-your-workload-costs); [dailyaifixs](https://dailyaifixs.com/blog/crewai-pricing-2026-free-or-enterprise-nothing-between)

### Inferences
- **Closest analogues:** for CTM these are Mem0 and Zep (hosted memory store, usage-priced, graph features gated higher) and LangSmith (collaboration across a team's agent runs, priced per seat). CTM's local-first design means the free tier costs CTM almost nothing to serve, as with PostHog or Sentry self-host. Revenue therefore has to come from something hosted or something managerial.
- **Candidate paywall for CTM, by buyer:**
  - Free for an individual: the local graph, MCP server, Claude Code and Codex plugins, and the open graph spec.
  - Team: a hosted, shared graph store and sync across machines and teammates' agents, access controls per project, retention, and a handoff/savings analytics dashboard.
  - Enterprise: SSO/SAML, audit log of which agent read or wrote which node, policy controls (which vendor or model may read which graph and redaction rules), self-hosted or BYOC, and the latent KV-cache layer for self-hosted open-weight inference.
- **License:** CTM should not relicense later. The HashiCorp episode shows the trust cost, and both the Codex and Cursor channels favour open source (Q3). Keep the core permissive (Apache-2.0/MIT) and put paid code in a separate directory or a hosted service, as PostHog does.
- **Tier gaps:** the big price gaps in Supabase ($25 to $599) and CrewAI (free to enterprise) suggest small teams are underserved. A $20–40/seat team tier is the usual fill.

### Gaps
- I couldn't confirm Mem0's current (Nov 2026) pricing or Zep's live Flex prices on the vendors' own pages.
- Sentry and Grafana current list prices weren't retrieved.
- I found no data on what share of revenue open-core AI memory startups make from team vs enterprise tiers.

## Q2. Pricing benchmarks and value-based pricing anchored on token savings

### Takeaway
Seat prices for comparable dev and AI tooling cluster at $20–80/seat/month, and hosted memory APIs at $19–375/month before custom enterprise pricing. Anthropic's own estimate puts Claude Code spend at about $150–250 per developer per month. Unless handoffs make up a large share of total tokens, CTM's measured 5x saving on the handoff step alone justifies only a modest per-seat price. Price on team coordination and governance; use token savings as proof, not as the price meter.

### Cited Findings
- **Claude Code spend (Anthropic's figure, as quoted by press):** about $13 per developer per active day, $150–250 per developer per month, with 90% of users under $30 per active day. Before 16 Apr 2026 the estimate was $6/day. — [Shopifreaks](https://www.shopifreaks.com/anthropic-more-than-doubles-its-public-estimate-of-average-daily-claude-code-spending-from-6-to-13-per-developer/); [Claude Code costs docs](https://code.claude.com/docs/en/costs?ref=t01.li)
- **Third-party Claude Code estimate:** about $100–200 per developer per month on Sonnet 4.6, with large variance by number of instances. — [Verdent](https://www.verdent.ai/guides/claude-code-pricing-2026)
- **Seat and plan anchors:**
  - LangSmith Plus: $39/seat ([LangChain pricing](https://langchain.com/pricing))
  - Letta Pro: $20/mo ([Letta docs](https://docs.letta.com/pricing))
  - Nessie, the closest cross-tool session product: Plus $28/mo, Pro $79/mo, Team $80/seat, billed yearly (from the team's earlier doc; not re-verified today) ([Nessie pricing](https://nessielabs.com/pricing))
  - Supabase: Pro $25 and Team $599 per org ([Supabase](https://supabase.com/pricing.md))
- **Usage anchors:**
  - Mem0: $19 for 50k adds, $249 for 500k adds ([PricingSaaS](https://pricingsaas.com/companies/mem0/diffs/2026Q2))
  - Zep: Flex $125 for 50k credits ([PricingSaaS](https://pricingsaas.com/companies/getzep/diffs/2026Q2))
  - Letta: $0.10 per active agent per month ([Letta docs](https://docs.letta.com/pricing))
  - PostHog: 1M events free ([PostHog](https://posthog.com/product-analytics/pricing))
- **Token-compression competitors (savings figures are all vendor-reported):**
  - Edgee: about 10% savings from tool-result trimming and about 50% combined on a coding session
  - Compresr: up to 64%
  - Headroom: "50–90%"
  - The Token Company: YC W26, sells input compression
  - No published prices were found for any of them, so there is no "percent of savings" price precedent in this set. — [Edgee on Product Hunt](https://www.producthunt.com/posts/edgee-claude-code-compressor-v2); [Compresr](https://extruct.ai/hub/compresr-ai/); [Headroom on PyPI](https://pypi.org/project/headroom-ai/0.32.0/); [YC](https://ycombinator.com/companies/the-token-company)

### Inferences
- **Worked example (illustrative; the handoff share is an assumption, not data):**
  - A 10-developer team at about $200/dev/month (Anthropic's range) spends about $2,000/month.
  - Assume 15–25% of input tokens go to re-establishing context across sessions or agents, and CTM's 5x reduction (80%) applies to that slice.
  - Savings come to about $240–400/month. A 10–20% value capture is about $25–80/month for the whole team, or $2.50–8/seat. That is below the $20–40 seat norm.
  - Token savings alone therefore probably can't carry a seat price, though the 3x speed-up (developer time) is worth much more than the tokens.
- **Time-based value (also an assumption):** if a handoff saves one developer 5–10 minutes and happens a few times a week, a $30–50/hr loaded developer cost gives about $10–35 per developer per month. That supports a $15–25/seat team tier.
- **Where token-based value is strong:** in self-hosted, open-weight inference (Qwen, Kimi), where the latent KV-cache transfer saves GPU prefill. A usage meter there (per handoff, or per million tokens avoided) is defensible, and it fits enterprise or self-hosting buyers.
- **Suggested starting prices to test, consistent with the comparables:**
  - Free OSS
  - Team about $20/seat/month (or $199/mo flat for up to 10 seats) with hosted sync and analytics
  - Enterprise from about $15–25k/yr (Grafana's quoted enterprise floor is $25k/yr) for SSO, audit, policy and self-hosting
  - These are hypotheses to validate, not benchmarks.
- **Product-plan pricing:** $249 per packet is priced against agency handover budgets, not token savings. Test it only if the agency wedge is kept.

### Gaps
- I found no public data on what fraction of coding-agent tokens goes to context re-establishment or handoffs. CTM should measure this itself, using its own telemetry with opt-in.
- I found no published per-token or percent-of-savings prices from any context-compression vendor.
- CTM's 3x/5x result comes from only 2 runs; any savings-based claim needs more runs before it goes on a pricing page.

## Q3. Distribution channels for MCP servers and dev tools (2025–2026)

### Takeaway
Discovery through directories is saturated: tens of thousands to 100k+ listed servers, and two directories changed status in Oct 2026. The channels that convert are the ones with installs built in: your own Claude Code/Codex plugin marketplace repo, the official MCP Registry feeding VS Code's `@mcp` gallery, and later the Anthropic and Cursor directories. Pair them with a well-timed Show HN and a seeded first-degree network. HN star bumps are real but short-lived.

### Cited Findings
- **HN launch data:**
  - An analysis of 188,085 Show HN posts found each HN upvote converts to about 1.4 GitHub stars within 48 hours, and 92% of the star impact is over after 48h. Comments are a weak predictor (r = 0.10). Blog analysis, not peer-reviewed. — [Show HN by the Numbers (Apr 2026)](https://danfking.github.io/blog/2026/04/23/show-hn-by-the-numbers/)
  - An arXiv preprint on 138 AI/LLM repos from 2024–2025 found that the "Show HN" tag gave no statistical advantage after controls. Small sample, not peer-reviewed. — [arXiv 2511.04453](https://arxiv.org/html/2511.04453v1)
- **First-100 playbooks:** one team seeded its launch by finding 100 relevant first-degree connections willing to star, and posted on social once it had a few dozen stars ([Encore: how we got 1500 stars](https://encore.dev/blog/how-we-got-1500-stars)). HN front page or Product Hunt can add 100+ stars in a day ([DEV Community](https://dev.to/whatshipped/how-to-get-your-first-100-real-users-for-an-open-source-project-46k3)). Both are anecdotal.
- **Directory size and changes:** Glama has about 111.9k servers and $49/mo boosts; Smithery is now a plain directory under Arcade.dev with its proxy shut down 31 Oct 2026; PulseMCP has paused submissions (see Q0). — [Apideck](https://www.apideck.com/blog/mcp-server-directories); [eSEOspace](https://eseospace.com/blog/glama-mcp/)
- **Install channels (team's earlier doc, sources cited there, not re-fetched today):**
  - Claude Code and Codex both read `.claude-plugin/marketplace.json`.
  - The Anthropic directory gives install, run and error-rate analytics but needs human review, and policy 1E/1G may affect transcript tools.
  - The OpenAI public directory takes local stdio servers only from allowlisted partners and bans upsell.
  - Cursor's marketplace requires open source and manual review.
  - Sources: [Claude Code plugin publishing](https://code.claude.com/docs/en/plugins/publish); [Claude directory publishing](https://claude.com/docs/directory/publish); [OpenAI plugin guidelines](https://developers.openai.com/plugins/plugin-guidelines); [Cursor plugins](https://cursor.com/docs/plugins)
- **Cross-agent memory competitors already ship through plugin marketplaces:** Walrus Memory installs via a Claude Code marketplace command ([Walrus](https://blog.walrus.xyz/how-to-add-portable-memory-to-claude-code-and-codex-with-walrus-memory/)), and claude-mem exposes an MCP URL for Codex ([neura.market](https://neura.market/ai-tools-directory/all/claude-mem)).
- **PostHog** launched its open-source product analytics on HN in Feb 2020 (older). — [LeadWave dossier](https://getleadwave.io/dossier/posthog)

### Inferences
- **Plan for the first 100 users:**
  1. Ship the plugin marketplace repo and register on the official MCP Registry and Glama (free).
  2. Seed 30–50 users from the hackathon cohort and the founders' networks before going public.
  3. Do a Show HN with a reproducible benchmark ("Claude Code to Codex handoff: 3x faster, 5x fewer tokens; here's the script"), and r/ClaudeCode, r/codex and r/LocalLLaMA posts (the Qwen/Kimi angle).
  4. Follow up within 48h, since that is when the bump decays.
  5. Make a short YouTube or X demo of two vendors' agents handing off live.
- **Differentiate against MemNexus, Walrus and claude-mem** on "cited, verifiable, cross-vendor graph, open spec", not on "memory". An open graph spec referenced from AGENTS.md is the most durable distribution asset because other tools can write to it.
- **Partnerships:** Anthropic and OpenAI are unlikely to promote a cross-vendor layer early. Open-weight hosts and inference platforms (the Qwen/Kimi ecosystem, and self-hosting stacks) are more natural partners for the latent layer.

### Gaps
- I found no published install or traffic data for any MCP directory, and no founder case study tying MCP-server user growth to a specific channel.
- I found no data on conversion from Claude plugin installs to weekly active use.
- Product Hunt's effect on dev tools in 2025–2026 isn't quantified in the sources found.

## Q4. Enterprise motion: security and compliance, sales cycle, ACV

### Takeaway
Don't get SOC 2 before a real enterprise prospect asks for it. Start with Type I when a deal of about $80k+ justifies roughly $15k of audit cost. Enterprise dev-infra cycles run 6–18 months, with ACVs around $75–150k for mature vendors. A two-founder seed company should expect bottom-up team revenue first and the first enterprise deal months later. CTM's local-first design delays the compliance burden, because nothing leaves the machine in the free tier.

### Cited Findings
- **When to get SOC 2:** the trigger is a real enterprise prospect sending a security questionnaire; at seed SOC 2 is "a sales unlock, not a security project". A roughly $15k audit makes little sense against a $30k ACV pilot, but pays off on the first $80k+ contract. Start with Type I. — [Causo hub guide (2026)](https://hub.causo.ai/guides/soc2-for-seed-startups-enterprise-deals-2026); [soc2auditors.org](https://soc2auditors.org/guides/is-soc-2-worth-it-for-pre-seed-startups/) (vendor and consultancy content)
- **Sales cycle and ACV:**
  - Enterprise dev-tool sales cycles average 6–18 months ([daily.dev business](https://business.daily.dev/resources/sell-developer-tools-enterprise-from-individual-user-to-procurement/)).
  - An enterprise AE listing cites 6–9 month cycles and $75–150k ACV ([Jobgether/Embrace listing](https://jobgether.com/offer/6a3ea9322da8cde35c764598-enterprise-account-executive)).
  - One unsourced claim says security review adds 4–8 weeks without SOC 2 ([Agency blog](https://blog.getagency.com/articles/b2b-saas-soc-2-enterprise-deals-case-study)).
- **Bottom-up first:** HashiCorp, Kong and LaunchDarkly used bottom-up models before their first enterprise deals; developers use the tool while executives or procurement buy it. — [daily.dev business](https://business.daily.dev/resources/how-to-sell-developer-tools-to-enterprise-from-individual-user-to-procurement/)
- **What the comparables bundle at the higher tier:**
  - Supabase Team ($599) includes SOC 2/ISO 27001 reports, dashboard SSO and SLAs ([Supabase](https://supabase.com/pricing.md)).
  - Zep Enterprise offers Cloud, Cloud+BYOK or BYOC ([PricingSaaS](https://pricingsaas.com/companies/getzep/diffs/2026W27)).
  - PostHog Enterprise includes SAML SSO and project permissions ([PostHog](https://posthog.com/blog/transparent-enterprise-pricing.md)).

### Inferences
- **Compliance sequence for CTM:**
  1. Free/local: no compliance needed. Publish a privacy policy, which the OpenAI directory requires anyway (earlier doc), plus a data-flow diagram showing nothing leaves the machine.
  2. Team hosted sync: a security page, encryption, data deletion and a DPA. Use a compliance-automation tool only once the first $10k+ prospect asks.
  3. Enterprise: SSO/SAML, audit logs, self-hosted or BYOC option, and SOC 2 Type I once an $80k+ deal is in hand.
- **Self-hosted Enterprise edition:** CTM's local or self-hosted architecture makes a self-hosted edition cheap to offer, and it removes most of the SOC 2 pressure, since data never reaches CTM. This is a real advantage over hosted Mem0 and Zep in regulated buyers.
- **Seed-stage ACV expectation:** first enterprise-ish deals are likely $10–30k design-partner contracts, not $75–150k. That fits pilots without SOC 2. This is an inference from the cost-vs-ACV guidance; it is not a benchmark.
- **UzCombinator angle:** local-first and self-hosting suits customers in data-residency-sensitive markets. I didn't research this.

### Gaps
- I found no peer-reviewed or survey-based ACV and sales-cycle benchmarks specifically for seed-stage AI dev infra; the figures above come from vendor blogs and a job listing.
- I found no data on how agent vendors' enterprise customers treat third-party MCP servers in security reviews.

## Q5. Phased plan and metrics

### Takeaway
A three-phase ladder fits the comparables and the evidence:
1. Free OSS that measures and reports savings locally.
2. A hosted Team tier at about $20/seat or about $199/team, for sync, a shared graph and analytics.
3. Enterprise from about $15–25k/yr, for SSO, audit, policy, self-hosting and the latent layer.

North-star metrics should prove cross-vendor handoffs happen repeatedly, not only that installs happen.

### Cited Findings
- **Gating pattern to follow:** individual features free, manager/exec features (SSO, audit, RBAC, SLAs) paid. — [OCV](https://handbook.opencoreventures.com/buyer-based-segmentation); [DEV Community](https://dev.to/beton/pricing-the-open-source-software-vol-2-145p)
- **Free-to-team ladders in comparables:** Supabase (Free, $25 Pro, $599 Team), Mem0 (Hobby, $19, $249, Enterprise), LangSmith (free 1 seat, then $39/seat). — [Supabase](https://supabase.com/pricing.md); [PricingSaaS Mem0](https://pricingsaas.com/companies/mem0/diffs/2026Q2); [LangChain](https://langchain.com/pricing)
- **Speed vs. revenue (team's own plan):** 10 paying customers in 30 days is not credible; 3 by day 30 and about 10 by day 75 is realistic. Charge before building (concierge). — product-plan.md (origin/product/v1)
- **HN attention decays within 48h** (above), so retention matters more than launch-day stars. — [Show HN by the Numbers](https://danfking.github.io/blog/2026/04/23/show-hn-by-the-numbers/)

### Inferences
- **Phase 0 (weeks 0–4): first 100 users.**
  - Ship OSS, plugin marketplace, MCP Registry and Glama, then the HN, Reddit and demo launch.
  - Add opt-in local telemetry that shows each user "tokens saved this week".
  - Recruit 10 design-partner teams that use both Claude Code and Codex (or open-weight models).
  - Success: 100 installs, 30 weekly active, and at least 10 teams with cross-vendor handoffs.
- **Phase 1 (months 1–3): first 10 paying.**
  - Team tier (hosted shared graph, sync across machines and teammates, retention, a savings dashboard).
  - Sell to design partners through Stripe links at about $20/seat or a flat $199/mo; offer founding-customer annual discounts.
  - Optionally keep the agency handover packet ($249) as a parallel test, per product-plan.md.
  - Success: 10 paying teams, at least 1 renewal or expansion.
- **Phase 2 (months 3–12): Enterprise.**
  - SSO/SAML, audit log, policy (vendor/model read permissions, redaction), self-hosted/BYOC, and the latent KV layer for self-hosted inference.
  - $15–25k/yr design-partner contracts; SOC 2 Type I once an $80k+ deal needs it.
- **Metrics to track:**
  - Activation: install to first published graph, and time to first cross-agent read.
  - Engagement:
    - weekly active agents (distinct agent and vendor identities that publish or read)
    - handoffs per week per team
    - share of handoffs that are cross-vendor
    - graph reads per publish
  - Value:
    - input tokens avoided per handoff (graph vs. transcript baseline)
    - wall-clock handoff time
    - accuracy parity on a sampled eval (keep running the 3x/5x benchmark beyond 2 runs)
  - Retention: week-4 retention of active agents and of teams.
  - Monetisation:
    - free-to-team conversion
    - seats per team
    - net revenue retention
    - number of enterprise asks (SSO requests) as the trigger for compliance work
  - Trust: citation validation failure rate and redaction misses (target 0, as in the product plan).

### Gaps
- I found no benchmark conversion rates (free to paid) specific to MCP servers or AI memory tools. General OSS conversion figures weren't retrieved in this session.
- I found no public data on retention of MCP servers after install.
