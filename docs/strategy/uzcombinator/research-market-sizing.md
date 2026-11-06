# Ledger Handover: bottom-up TAM/SAM/SOM (as of 2026-11-06)

**Bottom line:** the core agency product has a TAM of about **$86M/yr**. The SAM in Central Asia, the CIS and Eastern Europe is about **$11M/yr** (about $14M if Russia is included). A realistic 3-year SOM is about **$0.85M ARR**, with a range of $0.18M to $2.1M. The SAM is enough for an UzCombinator-stage company. Going past a seed round needs global PLG (product-led growth through the open-source core) and the enterprise upsell. The two weakest inputs are the share of agencies doing fixed-price work and how much they spend on handover. Neither could be verified.

## 1. Evidence base

| # | Fact | Value | Source |
|---|---|---|---|
| F1 | Clutch custom-dev listings (page undated) | 49,221 | https://clutch.co/developers |
| F2 | GoodFirms software-dev listings | 23,801+ | https://www.goodfirms.co/directory/languages/top-software-development-companies?cid=1725 |
| F3 | All software companies (ceiling, overlapping labels), Sep 2026 | 1,332,427 | https://discolike.com/company-stats/software/ |
| F4 | JetBrains 2026: pro devs using coding agents weekly / daily; Claude Code adoption | 90% / 68%; 39% | https://blog.jetbrains.com/research/2026/08/18/ai-coding-agent-adoption-2026 |
| F5 | SO 2026: use coding assistants or agents (secondary report) | 65.9% | https://itbrief.co.uk/story/stack-overflow-survey-shows-developers-trust-ai-with-caveats |
| F6 | SO pulse Apr 2026: agent use at work, up from 31% in 2025 | 59% | https://stackoverflow.blog/2026/05/27/agents-on-a-leash-agentic-ai-remains-mostly-monitored-at-work · https://survey.stackoverflow.co/2025/ |
| F7 | Employers that have published approved AI tools or guidance (the governance gap) | 24% | F6 pulse URL |
| F8 | GitHub developers | 180M+ | https://github.blog/news-insights/octoverse/octoverse-a-new-developer-joins-github-every-second-as-ai-leads-typescript-to-1/ |
| F9 | Uzbekistan: IT Park residents 4,200+ (undated); exports 54% to North America | — | https://gov.uz/en/digital/activity_page/it-park-uzbekistan |
| F10 | Uzbekistan: residents actively exporting, H1 2026 | 1,050 | https://www.it-park.uz/uz/itpark/news/it-park-rezidentlarining-eksport-geografiyasi-102-ta-mamlakatga-yetdi |
| F11 | Uzbekistan: IT Park exports, H1 2026 | $392.5M (+$90.3M YoY) | https://uza.uz/ar/posts/exports-of-services-from-it-park-residents-reach-3925-million_898121 |
| F12 | Kazakhstan IT companies, 2024 | 18,683 | https://caspianpost.com/kazakhstan/kazakhstan-s-it-sector-booms-with-over-18-000-companies-now-operating |
| F13 | Russia: accredited IT companies, Aug 2025 | ~20,000 | https://www.comnews.ru/content/240737/2025-08-15/2025-w33/1009/rossii-pochti-20-tys-it-kompaniy-sokhranili-akkreditaciyu-mincifry |
| F14 | Eastern Europe outsourcing firms on Clutch (exact source page UNVERIFIED) | 3,900+ | https://www.index.dev/blog/software-development-outsourcing-in-eastern-europe |
| F15 | Custom software development market, 2025 | $45.4B | https://www.grandviewresearch.com/industry-analysis/custom-software-development-market-report/dashboard |
| F16 | AI governance market, 2025 → 2030 | $0.34B → $1.21B / $0.94B → $7.38B / $17B by 2030 | https://www.giiresearch.com/report/moi1689967-ai-governance-market-share-analysis-industry.html · https://aws.amazon.com/marketplace/pp/prodview-vqc2rbyqo4gbc · https://www.marketresearch.com/Market-Glass-Inc-v1039/Artificial-Intelligence-AI-Governance-41342431 |
| F17 | Copilot: 4.7M paid subscribers, ~140k orgs (secondary, UNVERIFIED) | — | https://www.getpanto.ai/blog/github-statistics |
| F18 | EU AI Act Art. 12 logging applies to high-risk systems only; high-risk deadline may move to Dec 2027 | — | https://www.helpnetsecurity.com/2026/04/16/eu-ai-act-logging-requirements/ · https://www.cequence.ai/?p=25259 |
| F19 | Example Clutch listing rate band | $25–49/hr | https://clutch.co/developers/small-business?page=175 |

**Comparable pricing**

| Competitor | Pricing | Source |
|---|---|---|
| Supermemory | $19 / $100 / $399 per month | https://supermemory.ai/pricing |
| ContextStream Team | $79/user/mo, 3-seat minimum | https://www.contextstream.io/pricing |
| Nessie | No public pricing found; **$80/seat Team is UNVERIFIED** | https://neuronfeed.com/compare/nessie-vs-xai |
| Entire | $60M seed at a $300M valuation | https://devops.com/former-github-ceo-bets-60m-that-developer-tools-need-a-factory-reset-for-the-ai-age/ |
| Entire Trails | Launched Oct 26; free start plus $100 review credit (secondary) | https://andrew.ooo/answers/what-is-entire-git-forge-dohmke-trails-2026/ |
| SpecStory, claude-mem | UNVERIFIED (pricing page returned 404) | — |

**Not found:** no 2025 or 2026 data on the share of fixed-price projects or on what agencies spend on handover documentation. Both are assumptions below.

## 2. TAM: core agency product

| Step | Assumption | Result |
|---|---|---|
| A1 | Global custom-dev service firms: 100k. Directories (F1, F2) under-count; F3 is the ceiling. **UNVERIFIED** | 100,000 |
| A2 | Share with 3–30 staff: 60%. **UNVERIFIED** | 60,000 |
| A3 | Firms with at least one developer on agents: 80%, set conservatively below F4 and above F5 | 48,000 |
| A4 | Revenue per account (ARPA): $1,800/yr, either Studio ($149 × 12) or ~7 packets × $249 | — |
| **TAM** | 48,000 × $1,800 | **$86M/yr** |

- **Beachhead TAM:** if 35% of firms do fixed-price work for enterprise or regulated clients (**UNVERIFIED**), the beachhead is 16,800 firms, or about **$30M/yr**.
- **Price check:** a handover of 16–24 hours (UNVERIFIED) at the F19 rates costs $400–1,200 in labour. A $249 packet pays for itself.

## 3. SAM: reachable regions

| Region | Logic | Agencies |
|---|---|---|
| Uzbekistan | Exporting residents (F10) | 1,050 |
| Kazakhstan | F12 × 15% that are client-services agencies (UNVERIFIED) | 2,800 |
| Other CIS and Caucasus | **UNVERIFIED** | 1,500 |
| Eastern Europe | F14 × 2 for directory under-coverage × 60% in the 3–30 size band | 4,680 |
| **Subtotal** | | **10,030** |
| With agents (× 80%) | | **~8,000** |

- **Base SAM:** 8,000 × $1,400 blended ARPA (CIS pricing at roughly half; UNVERIFIED) = **$11.2M/yr**.
- **High case with Russia:** 20,000 × 20% × 80% × $900 adds $2.9M, for **$14.1M/yr**. Sanctions and payment rails make Russia legally and operationally uncertain (UNVERIFIED), so it stays out of the base case.
- **Why Uzbekistan works as a launch market:** 54% of Uzbek IT exports go to North America (F9). These agencies already deliver to US enterprise clients, who are the buyers most likely to demand signed, cited handovers.

## 4. SOM: 3 years, base case

| Year | Paying accounts | ARPA | ARR |
|---|---|---|---|
| Y1 (2027) | 40 | $1,200 | $48k |
| Y2 | 180 | $1,500 | $270k |
| Y3 | 450 (≈250 from SAM, 3.1%; ≈200 global via the open-source core) | $1,700 | $765k |
| Y3 enterprise pilots | 4 × $20k | — | $80k |
| **Y3 total** | | | **≈$0.85M** |

The 2–4% conversion from open-source users to paid is a benchmark assumption (**UNVERIFIED**).

**Sensitivity (Y3 ARR)**

| Case | Assumptions | Y3 ARR |
|---|---|---|
| Low | 150 accounts × $1,200, no enterprise | **$0.18M** |
| Base | as above | **$0.85M** |
| High | 900 × $2,000, plus 15 enterprise deals × $20k | **$2.1M** |

- Account count ±50% moves Y3 ARR by about ±$380k.
- ARPA ±30% moves it by about ±$230k.
- Account count matters most. It depends on open-source traction and on whether Entire bundles a free handover feature.

## 5. Adjacent upsell: enterprise "AI agent audit trail"

| Step | Assumption | Result |
|---|---|---|
| E1 | Organisations paying for Copilot (F17, UNVERIFIED) | 140,000 |
| E2 | Regulated share (finance, health, government): 20%. **UNVERIFIED** | 28,000 |
| E3 | Need an audit trail beyond what the vendors provide natively: 25%. **UNVERIFIED** | 7,000 |
| E4 | Annual contract value (ACV) $20k (≈40 devs × $42/mo). **UNVERIFIED** | — |
| **Upsell TAM** | | **≈$140M/yr** |

- **Top-down check:** the 2025 AI governance market is $0.34–0.94B (F16), so $140M would be a 15–40% slice. That is plausible but on the high side.
- **Demand signals:** only 24% of employers have published AI tool guidance (F7), and survey respondents rate source attribution highly (F5).
- **Caveat on regulation:** EU AI Act Art. 12 covers high-risk systems. Coding agents usually are not high-risk, so the Act is an indirect, procurement-driven tailwind rather than a mandate, and its deadline may slip (F18).

## 6. Verdict and what to validate

- **Viability:** the market is real but small regionally. The $11M SAM supports a $1M ARR business; a venture-scale company needs the global TAM ($86M) plus the enterprise tier ($140M).
- **Main risks:**
  - Entire ($60M funded, Trails already launched) could add signed handovers for free.
  - Fixed-price share and handover cost are both unverified.
  - Directory counts of agencies are soft.
- **Before applying to UzCombinator:**
  - Interview 20 agencies among the 1,050 exporting IT Park residents (F10), confirming fixed-price share, handover hours and willingness to pay $249.
  - Get 3 paid pilots.
  - Pull Clutch's size-band counts for Eastern Europe and Central Asia to replace the A2 and coverage multipliers.
