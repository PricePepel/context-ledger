## Verdict

As pitched ("handover packets for agencies, $249/packet"), this is a **lifestyle business**. A $149/mo plan needs about 56,000 paying studios to reach $100M ARR (my arithmetic). Packet revenue is spiky and tied to project endings. It becomes **venture-scale only if the buyer changes**: the enterprise that *receives* AI-built code pays to verify it, and the agency is the distribution wedge. The capture layer is already funded and commoditizing. Your moat has to be **human approval, redaction, signature and third-party verification**, not session import.

## What capital is funding (2025–26)

- **Capture and provenance of agent sessions is a funded category.** Entire raised a $60M seed at a $300M valuation on Feb 10, 2026, led by Felicis, with Madrona and M12 also reported ([TechCrunch mirror](https://hn.jakechampion.name/reader/https://techcrunch.com/2026/02/10/former-github-ceo-raises-record-60m-dev-tool-seed-round-at-300m-valuation), [Inforcapital](https://inforcapital.com/news/former-github-ceo-raises-record-60m-dev-tool-seed-round-at-300m-valuation/)). Its open-source Checkpoints CLI ties prompts and transcripts to commits ([SiliconANGLE](https://siliconangle.com/?p=730571), [Entire docs](https://docs.entire.io/cli-reference/session)).
  - The "Trails links sessions to PRs" claim in the brief is **UNVERIFIED**. "Trails" shows up as a concept in [Maggie Appleton's essay](https://maggieappleton.com/post-pull-request), not as an Entire product.
- **Agent governance and trust seeds are frequent and mid-sized.** All of these come from aggregators and are not checked against primary releases:
  - OpenBox AI: $5M, audit trails for agents ([TechIntelPro](https://techintelpro.com/news/ai/enterprise-ai/openbox-launches-ai-governance-platform-with-5m-seed-funding))
  - Aigentsphere: $4M, led by Main Sequence ([pulse.bot](https://www.pulse.bot/entrepreneurship/news/ai-governance-startup-pockets-4-million-seed-round-447700ff-300d-4dac-b3fc-74938b977a59/))
  - Capsule Security: $7M ([FinTech Global](https://fintech.global/2026/04/16/capsule-security-exits-stealth-with-7m-seed-round))
  - General Analysis: $10M ([pulse.bot](https://www.pulse.bot/entrepreneurship/news/general-analysis-snares-10m-in-seed-funding-cf600633-fd84-4c8b-94aa-ef16ffa4fd84/))
  - Lyrie.ai: $2M pre-seed for an agent attestation protocol ([pulse.bot](https://www.pulse.bot/devops/news/lyrieai-secures-2-million-preseed-to-launch-open-trust-protocol-for-ai-agents-9006ce6c-3385-4a96-88a4-0f557a6b7f5f/))
- **YC's 2026 Requests for Startups lean toward agent infrastructure** ("agent harness", "software for agents"). This is from secondary coverage only, and the official page was not retrieved ([VC Cafe](https://www.vccafe.com/requests-for-startups-summer-2026), [Epsilla](https://www.epsilla.com/blogs/2026-03-08-yc-rfs-2026-agentic-economy)).
- **The tailwind is large.** Cursor reportedly passed a $4B run-rate by June 2026, with about 75% from enterprise ([Dealroom](https://dealroom.co/news/134107-cursor-tops-4b-annualized-revenue/)). In New Relic's survey, 82.6% say AI-generated code makes observability more critical ([New Relic 2026](https://newrelic.com/sites/default/files/2026-09/new-relic-2026-observability-forecast-report.pdf)).
- **a16z / Sequoia:** I found no first-party a16z or Sequoia piece on code provenance. Treat any "VCs say provenance is hot" claim as **UNVERIFIED**.
- **Regulation is a weaker driver than it looks.** The EU AI Act omnibus provisionally moves standalone high-risk obligations to Dec 2, 2027 ([Gibson Dunn](https://www.gibsondunn.com/eu-ai-act-omnibus-agreement-postponed-high-risk-deadlines/), [Sidley](https://datamatters.sidley.com/2026/06/22/eu-lawmakers-reach-provisional-agreement-to-delay-key-eu-ai-act-obligations/)). Don't pitch "compliance deadline urgency."

## Competitor reality check

- **Nessie:** YC Fall 2025, two people, about $500K raised ([YC](https://www.ycombinator.com/companies/nessie), [VCBacked](https://www.vcbacked.co/company/nessie-labs)). The "$80/seat Team" price is **UNVERIFIED**.
- **SpecStory, claude-mem, Supermemory:** not researched here. Their pricing and funding are **UNVERIFIED**.
- **Main threat:** Entire adding approval and export on top of Checkpoints.
- **Defensible gaps:**
  1. Works across vendors (Claude Code plus Codex, offline).
  2. Redaction before anything leaves the machine.
  3. A named reviewer's signature.
  4. **A verifier the client runs without trusting the agency.**

## The UzCombinator angle (strong local fit)

- **Program terms:** 45 days, a $1,000 stipend, office space, and up to $1M investment available at Demo Day in Season 2 ([gov.uz](https://gov.uz/oz/yoshlar/news/view/193066)).
- **Season 1:** 1,453 applicants, 31 founders accepted, $975K total investment raised at Demo Day ([gov.uz](https://gov.uz/oz/yoshlar/news/view/193066)). That averages about $31K per founder (my estimate).
- **Local cheque sizes:** median pre-seed tickets are $20K at Aloqa, $50K at IT Park Ventures, $100K at UzVC and $30K at Yoshlar Ventures ([Kun.uz](https://kun.uz/en/news/2026/05/23/how-much-startup-funding-can-you-raise-in-uzbekistan-693a5e)).
- **Why the beachhead is local:** IT Park residents exported $392.5M in H1 2026 ([Dunyo](https://dunyo.info/en/news/uzbekistan-narashchivaet-eksport-uslug-uchastnikov-it-park)). Uzbekistan has 1,200+ exporting companies, 45% of exports are IT services and 54% go to North America ([gov.uz IT Park](https://gov.uz/en/digital/activity_page/it-park-uzbekistan)). The national target is $5B in IT exports by 2030 ([outsource.gov.uz](https://www.outsource.gov.uz/en/media/uzbekistan-to-boost-it-exports-to-5-billion-by-2030)).
- **The pitch to jurors:** Uzbek outsourcers win US and EU enterprise work when they can *prove* the quality of AI-assisted delivery. That is a story Uzbek jurors want to fund.

## Larger framings, ranked

1. **"Signed receipts for AI-built software." (Best.)** A cross-vendor attestation layer (an in-toto/SLSA-style statement for agent work) where every decision is source-cited and approved by a human.
   - Agencies are the wedge. Enterprise vendor-risk and procurement teams pay for verification and policy.
   - Expands into an outsourcing marketplace trust badge, then insurance and audit integrations.
2. **"Audit trail for agent work inside enterprises."** Same engine, sold directly to in-house platform teams.
   - Bigger annual contracts, but you collide head-on with Entire and observability vendors, and the sales cycle is longer.
3. **"Vendor-transition insurance for AI-heavy projects."** Packets reduce dependence on one agency and handover risk at contract end.
   - Strong ROI story, but it reads as a services product and caps the multiple.

(The current framing, "handover docs for agencies", ranks last.)

## Strongest one-sentence pitch

**"Ledger Handover turns every AI coding-agent session into a signed, human-approved receipt, so enterprises can accept AI-built software from outside vendors with proof of who decided what, and why."**

## Metrics a partner needs at Demo Day

None of these targets comes from a published benchmark. They are my recommendations.

**Realistic within 45 days:**
- 8–12 design-partner agencies, at least 5 of them IT Park exporters with US or EU clients
- At least 3 paying, at **$1–3K MRR** combined
- At least 1 enterprise *recipient* who verified a packet independently. This is the key proof of the larger framing.
- Packets per week growing for 4 or more consecutive weeks
- A signed letter of intent at the client end
- Redaction leak rate of 0 on a synthetic red-team set
- Time-to-packet under 30 minutes

**For a YC-grade follow-on:**
- About $10K+ MRR
- 15–20% weekly growth
- Logo retention at a second packet or project

**Funding benchmarks are noisy:**
- Carta finds no fixed ARR threshold for seed rounds ([Carta](https://carta.com/data/linkedin-arr-required-raise-seed-round-svb/)).
- Cited Series A bars for AI startups range from $1.2M to $3.5M ARR, from sources that are not primary ([Waveup](https://waveup.com/blog/series-a-benchmarks/), [Causo](https://hub.causo.ai/guides/h1-2026-series-a-bar-report)).

## Honest risks

- **Pricing:** $249 per packet anchors you as a document vendor. Move to recipient-side verification seats or per-repo attestation.
- **Platform risk:** Anthropic, OpenAI or GitHub could ship native session export.
- **Weak local demand signal:** agencies may see buyer-requested proof as a liability. Test it now.

Note: Firecrawl hit its keyless daily limit, so all research was done with WebSearch and WebFetch. Many 2026 funding figures come from aggregator sites and were not checked against primary releases.

You've reached Firecrawl's daily limit without an account. Sign up free for 1,000 credits a month: https://firecrawl.dev/k/7wv8dkc6vev1
