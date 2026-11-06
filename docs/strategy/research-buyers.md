# Context Ledger: who would pay, and which segment to sell to first

## Market facts (cited)
- **Nessie, the closest analog:** Plus is $28/mo, Pro is $79/mo, Team is $80/seat/mo (all billed yearly), and On-prem is "talk to us". It syncs 20+ tools and offers MCP and a CLI. https://nessielabs.com/pricing, https://nessielabs.com/
- **Entire (ex-GitHub CEO Thomas Dohmke):** raised a $60M seed at a $300M valuation. It ships "Checkpoints" that capture agent context automatically. https://pureai.com/articles/2026/02/10/dohmke-launches-startup.aspx, https://x.com/ashtom/status/2021255786966708280. Session Storage, Trails and Continuous Memory are **free**. It earns money on agent tokens and Enterprise contracts. https://entire.com/pricing
- **Cursor's Agent Trace spec:** an open spec (v0.1.0, RFC, Jan 2026) for recording which code came from AI and which from humans. Cline, OpenCode and Git AI show early support, and the Thoughtworks Radar rates it "Assess". https://github.com/cursor/agent-trace, https://www.thoughtworks.com/radar/platforms/agent-trace
- **Stack Overflow 2026 survey:** 66% of respondents use coding agents and 73% of AI users use AI daily. 93% say they can only trust AI output with source attribution. 27% use different models for different work. https://stackoverflow.blog/2026/10/06/the-results-of-the-2026-developer-survey-are-here/
- **JetBrains 2026 survey:** 90% of professional developers use agents weekly and 68% daily (15k+ respondents). https://blog.jetbrains.com/research/2026/08/ai-coding-agent-adoption-2026/. This came from a search summary only; the page returned 403, so the figures are UNVERIFIED. I found no primary figure for the share of developers using several agents at once.
- **Spend per developer:** DX estimates $200–600 per developer per month in seats plus tokens for teams using agentic tools. https://getdx.com/blog/ai-coding-assistant-pricing/

## Segments

### 1. Solo devs using several agents
- **Job to be done:** switch between Claude Code and Codex mid-task without re-explaining everything.
- **Evidence:** Reddit threads about losing context between sessions and about handing off from Claude to Codex. https://www.reddit.com/r/ClaudeCode/comments/1qn5tfc/how_do_you_handle_context_loss_between_claude/, https://www.reddit.com/r/codex/comments/1uzv7pt/how_do_you_share_codding_session_between_claude/. Many people solve it themselves with a few markdown files (https://www.reddit.com/r/ClaudeCode/comments/1vr4zg0/how_i_carry_context_between_claude_code_sessions/), or with free tools like "Handoff" (https://www.reddit.com/r/ClaudeCode/comments/1sd5ubf/i_built_a_tool_handoff_switch_ai_agents/).
- **Budget owner:** the developer personally.
- **Price:** a free open-source core, or $5–12/mo. Nessie sells at $28 and up, and one directory claims the category sustains roughly $10–15/mo (https://fyicombinator.com/company/nessie, UNVERIFIED).
- **Sales motion:** product-led growth.
- **Channel:** r/ClaudeCode, r/codex, Hacker News.
- **Verdict:** the pain is real, but people are unwilling to pay much. A markdown file is a good-enough fix, and Entire's free tier sets the price expectation. Use this segment for distribution, not revenue.

### 2. Small dev teams and agencies sharing agent work
- **Job to be done:** a teammate or a client picks up agent-built work and needs to know what was decided, why, and what is blocked.
- **Evidence:** clients now review handover deliverables with their own AI tools, and agencies are advised to reserve 10–15% of fixed-price scope for documentation and handover (https://scand.com/company/blog/it-project-acceptance-in-the-ai-era/). Agencies are building internal handoff-document generators (https://www.metaltoad.com/blog/building-an-ai-powered-handoff-document-generator-in-3-days).
- **Budget owner:** the agency founder or delivery lead. The cost can be passed into the project fee.
- **Price:** $30–50/seat/mo, or a flat $99–199/mo per studio. UNVERIFIED (my estimate). It sits under Nessie Team's $80.
- **Sales motion:** founder-led sales plus self-serve.
- **Channel:** agency founder communities on X and LinkedIn, Clutch-listed studios, and partner directories for Claude and OpenAI consultancies (UNVERIFIED that such directories exist).

### 3. Engineering orgs needing audit and provenance
- **Job to be done:** show auditors and customers which agent changed what, under which instruction, and with whose approval.
- **Evidence:** Codacy says auditors want repository-level evidence and an AI bill of materials (AIBOM), not policy documents (https://blog.codacy.com/what-auditors-will-ask-about-ai-generated-code-in-2026). Axiom Studio says commits name the human who committed the code, not the model that wrote it (https://axiomstudio.ai/blog/building-an-ai-audit-trail-from-model-selection-to-production). Augment ties traceability to the EU AI Act's August 2, 2026 milestone (https://www.augmentcode.com/guides/eu-ai-act-2026). That is vendor content, and whether coding tools are in scope as high-risk systems is UNVERIFIED.
- **Budget owner:** the CISO, VP Engineering or GRC lead.
- **Price:** a self-hosted license at $15–50k/yr, or $20–40 per developer per year. UNVERIFIED (my estimate).
- **Sales motion:** enterprise sales with a 3–9 month cycle. Buyers will expect SOC 2, SSO and Agent Trace export.
- **Crowding:** the space is already busy. Microsoft's Agent Governance Toolkit, Coder, Encephalon, Checkmarx and Codacy all compete here (https://encephalon.net/blog/best-ai-code-governance-platform-for-enterprise/, https://checkmarx.com/learn/ai-security/ai-coding-assistants-with-audit-trails-and-security-governance-top-8-options/).
- **Verdict:** the biggest budgets, but too early for a solo-built prototype.

### 4. AI-native consultancies handing work between people and agents
- **Job to be done:** turn agent sessions into a deliverable the client can check line by line: decisions, open blockers, next actions, each traced to its source. This also protects the consultancy if a dispute comes up later.
- **Evidence:** the same handover sources as segment 2. I found no source on including agent transcripts in client handovers or on disclosing AI authorship (gap, UNVERIFIED).
- **Budget owner:** the managing partner. It can be billed as a line item.
- **Price:** $49–99/seat/mo, or $99–299 per published client handoff packet. UNVERIFIED (my estimate).
- **Sales motion:** founder-led sales. Partners refer each other.
- **Channel:** LinkedIn outreach to "AI implementation" boutiques, and their clients' procurement teams.

## Recommended beachhead: segments 2 and 4 together
Target small agencies and AI-native consultancies of 3–30 people whose deliverable is code built by agents.

1. **The pain turns into a billable deliverable.** Handover documentation is already scoped work (Scand). The cited handoff packet replaces hours of manual write-up, so the payback is easy to explain.
2. **The prototype's strongest feature fits this buyer.** Line-cited typed decisions and blockers, the semantic graph, is what a client auditor wants. 93% of developers tie trust to attribution (Stack Overflow). Neither Nessie's search-and-chat approach nor Entire's checkpoint approach is built around a handoff contract the client can verify.
3. **Local and explicit-import is a selling point.** Agencies handle client IP and will often refuse cloud sync of transcripts. A per-agency self-hosted license avoids competing with Entire's free hosted storage. Nessie's on-prem tier has no published price.
4. **It leads into segment 3.** The packets an agency sends its enterprise clients pull in the clients' governance teams. Agent Trace compatibility gives a standard to plug into.
5. **Short sales cycle.** The founder decides, and no SOC 2 is needed to land the first deals.

## Risks for the product manager
- Entire's funding and free tier could make "capture" a commodity. Compete on the handoff and verification layer, not on storage.
- Nessie already sells handoff to teams. Positioning has to be "client-verifiable provenance", not "shared memory".
- Context Ledger is built from Nessie's public workflow. Clean-room the code and avoid matching their wording or UI.
- None of the buyer-segment prices above have been validated. Before building more, run 10 agency interviews and test willingness to pay for a $199 "handoff packet".

## First 10 customers
1. Five studios found through r/ClaudeCode and r/codex posts about agency handoffs.
2. Three AI-implementation boutiques found through LinkedIn searches.
3. Two of the founder's own network contacts.

Offer each a free pilot of one client handover in exchange for a case study.

Research note: Firecrawl reached its daily limit partway through, so the rest of the research used WebSearch and WebFetch. The JetBrains survey page and Reddit could not be fetched, so the figures from those sources come from search summaries.

You've reached Firecrawl's daily limit without an account. Sign up free for 1,000 credits a month: https://firecrawl.dev/k/7wv8dkc6vev1
