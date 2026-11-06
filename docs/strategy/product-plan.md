# Context Ledger: Product Plan (2026-11-06)

## 1. Recommendation

**Product:** Ledger Handover

**One-liner:** Turns an agency's Claude Code and Codex sessions on a client project into a handover packet that cites its sources and is approved by a human. Every decision, open blocker and next action links to the message it came from and has been signed off by a named reviewer.

**Beachhead:** fixed-price dev agencies and AI-implementation boutiques of 3–30 people that deliver to enterprise or regulated clients, where the contract has a handover or acceptance sign-off. The buyer is the founder or delivery lead, and the cost goes into the project fee.

**Why now:**
- Handover is already scoped, billable work. Scand advises reserving 10–15% of project scope for technical documentation, and describes clients as technical auditors equipped with AI assistants ([Scand](https://scand.com/company/blog/it-project-acceptance-in-the-ai-era/)).
- 93% of developers say they only trust AI output that has source attribution ([Stack Overflow 2026](https://stackoverflow.blog/2026/10/06/the-results-of-the-2026-developer-survey-are-here/)).
- 66% of developers who use AI work in coding agents, and some organizations deliberately use different models for different work (the survey gives 27% without stating the base). Agency work therefore often crosses vendors.

**Why this over the alternatives:**
- **Ledger Relay** (solo-developer plugin) targets the segment least willing to pay. Native memory and low-cost tools such as claude-mem (open source with paid hosted add-ons) and Supermemory (free tier, paid from $19/mo) already cover it, and OpenAI bans upsell inside plugins.
- **Ledger Trail** (PR decision records) runs into Entire ($60M, free Trails) and long enterprise sales cycles. It would also put transcript text into repositories.
- **Native features stay inside one vendor.** Claude auto memory stays on one machine, Codex has resume, and Cursor removed Memories. LLM-compressed memory (claude-mem, Pieces) can't be audited, and SpecStory archives raw history.
- **Nessie** is local-first (the library starts on the Mac, and cloud sync is optional), with Team at $80/seat/month and custom-priced on-prem ([pricing](https://nessielabs.com/pricing)). Being local is therefore not a differentiator; human approval, signed client packets and cross-vendor projects are.
- **Our one strong asset is the strict, line-cited graph contract**, and Handover is the only direction where that contract is the thing being sold.

**Honest claims.** We say "source-cited, human-approved". We do not say "client-verifiable".
- `validateGraph` checks only that cited lines exist (`src/graph.mjs` `indexNodes`), not that they support the node. Human approval covers that gap.
- Ledger itself sends nothing anywhere. Drafting runs in the agency's own coding agent under the agency's existing vendor terms. The packet goes to the client, because that is the point of it.

**What we take from the other directions:**
- From Relay: a free stdio MCP server as the distribution channel, with no automatic context injection.
- From Trail: commits, PRs and files as artifacts that can be cited as evidence, with no transcript text committed to the repo.

## 2. What the customer buys

**v1 features, in priority order:**
1. **Project ledger.** Import several Claude Code and Codex sessions into one client project. Each session is identified by the provider's session UUID, and each message gets a stable ID (provider record UUID plus a content hash).
2. **Agent-drafted packets.** The agency's own agent publishes goals, decisions, blockers and actions through the MCP tool `ledger_graph_publish`. `validateGraph` rejects any citation to a message that doesn't exist, and also rejects citations to compact summaries or sidechains used as primary evidence.
3. **Reviewer UI.** Each node is shown next to the messages it cites. The reviewer approves, edits or rejects every node, and nothing exports until all nodes are approved.
4. **Allowlist-only redacted export.** The bundle contains only the cited excerpts. Redaction runs on each one and shows a diff of what it removed, and a human signs off each excerpt. Output is a static HTML and Markdown bundle under a strict CSP, rendered with textContent only.
5. **Signed packets.** The agency signs with an Ed25519 key, and `ledger verify` checks the signature. The documentation states plainly that a signature proves authorship and integrity, not completeness.
6. **Artifact anchors.** A node can also cite a commit SHA, a PR or a file path in the client's own repo.
7. **Data controls.** Delete per project, a retention setting, and a per-install bearer token for the HTTP API and MCP.

**Non-goals for v1:**
- In-house LLM extraction
- Hosted sync, accounts or SSO
- Automatic transcript discovery and hooks
- Automatic context injection
- GitHub Action or PR check
- Agent Trace export
- Desktop app or VS Code extension
- Team seats

**Pricing.** All prices are unvalidated and the concierge phase exists to test them.
- **Free, open source:** import, search, Markdown handoff, MCP server, graph validation.
- **Per packet:** $249 for a signed, reviewed client packet.
- **Studio:** $149/mo or $1,490/yr for unlimited packets, one signing key and up to 10 reviewers.

The price is set against the existing handover line item, not against SaaS memory tools. On a $40k fixed-price project the handover budget is $4–6k, and $249 is about 5% of that, which the agency can mark up. Studio sits below Nessie Team's $80/seat. Payment goes through Stripe payment links and an offline signed license key.

## 3. Roadmap

Each wave ends with an independent code review and Playwright, as AGENTS.md requires. All eval data is synthetic.

| Wave | Owner | Scope | Reuses | Acceptance eval (gate) |
|---|---|---|---|---|
| **0. Concierge, weeks 1–2** | Founder and docs | Hand-build 3 paid packets: the existing CLI imports the sessions, Claude drafts the nodes, validateGraph checks them, the founder reviews them, and the output is a Markdown bundle | `cli.mjs`, `graph.mjs` | 3 paid packets delivered. A timing log shows hours per packet, and client feedback is recorded |
| **1. Foundation, 2 weeks** | Engineer, plus eval | `createLedger({dbPath})`; migrations table; session identity from the provider UUID; one row per message; stable message IDs (line plus hash fallback for Codex items with no ID); delete and retention; bearer token; LICENSE; contract tests for each format version | `store.mjs` `importTranscript`, `parseTranscript`, `messageAt`, server hardening | Re-importing a transcript with k lines appended gives the same session with N+k messages. The v0 database migrates with the fixtures intact. After delete, scanning the raw `.sqlite` bytes for fixture text finds nothing. A request with no token gets 401. An unknown format version fails closed with a named error |
| **2. MCP and graph v2, 1.5 weeks** | Engineer | stdio MCP tools `import`, `search`, `handoff`, `graph_read` (all read-only) and `graph_publish` (the only write); a drafting skill; v2 schema with project scope, stable node IDs, message-ID citations, artifact anchors and an `approvedBy` field | `validateGraph`, edge and cycle checks, derived ready actions | A scripted synthetic agent publishes 20 packets. The 5 that cite made-up message IDs are rejected, the packet citing a compact summary is flagged, and all v1 graph tests still pass |
| **3. Reviewer UI, 2 weeks** | Design and engineer | Graph view in `public/` with node and evidence side by side; approve, edit or reject; an edit history | `app.js` rendering that uses textContent only | Playwright: export is blocked while any node is unapproved. Edits are saved with the reviewer's name. An injection fixture (HTML/bidi) renders inert. A 30-node synthetic project can be reviewed with keyboard only |
| **4. Redaction and signed export, 2 weeks** | Security and engineer | Pattern and entropy scanner; redaction diff; sign-off per excerpt; HTML and Markdown bundle; Ed25519 signing; `ledger verify` | CSP headers, `visibleText` escaping | Seed a synthetic corpus with 200 secrets of 30 types across 40 sessions. Every seeded secret in a cited excerpt is either redacted or held at sign-off. Grep finds no uncited message text in the bundle. Changing one byte makes `verify` fail |
| **5. Packaging and launch, 1.5 weeks** | Engineer and docs | npx install; OS data directory; CI on Windows, macOS and Linux; decide between bundling `node:sqlite` and using `better-sqlite3`; license key with offline grace; docs; privacy policy; clean-room legal review against Nessie | `cli.mjs`, existing CI | On a fresh VM on each of the 3 operating systems, install to first signed packet takes under 15 minutes with the synthetic fixture. An expired license keeps everything readable and blocks only signed export |

**Total:** about 9 engineer-weeks after concierge, or 11 calendar weeks to a paid v1. Plan for slipping to 13–14, because redaction and the reviewer UI carry the most risk.

**Distribution track.** After wave 2, the free MCP server ships in a repo containing `.claude-plugin/marketplace.json`, which both Claude Code and Codex read, and is listed in the official MCP Registry. It has no hooks and no upsell inside the plugin.

## 4. Go-to-market (first 30 days)

**Channels:**
- **A named list of 40 agencies** built from Clutch listings and LinkedIn "AI implementation" boutiques, filtered to fixed-price work for enterprise or regulated clients.
- **The founder's network:** 2 contacts.
- **Communities:** r/ClaudeCode, r/codex and Hacker News for the free MCP server. That channel is for distribution, not revenue.

**Agent ecosystems:**
- **List now:** our own Claude Code and Codex marketplace repo, and the MCP Registry, which also puts the server in VS Code's `@mcp` gallery.
- **Hold back:** the Anthropic directory, because policy sections 1E and 1G could block a transcript tool, so we wait for the legal review. The OpenAI public directory is out of reach, since it accepts local stdio servers only from allowlisted partners.

**Path to the first 10 paying customers:**
- Days 1–14: 10 agency conversations, then sell 3 concierge packets at $299–499, paid up front. These are not free pilots.
- Days 15–30: ask for a referral and a case study from each concierge customer.
- Realistically there will be 3 paying customers by day 30 and 10 by about day 75, after v1 ships. Ten in 30 days is not credible.

**What to measure:**
- How many conversations turn into paid packets
- Hours to assemble a packet, by hand and later with the tool
- The share of drafted nodes that reviewers edit or reject
- Whether the client opens the packet and expands its citations
- Redaction misses found in human review (target 0)
- Free MCP installs and how many people still use it after a week

## 5. Decision gates and kill criteria

**G0, day 14 (concierge):**
- Continue if at least 3 of 10 targeted agencies pay $299 or more.
- Pivot if 1–2 pay: retest as internal teammate handoff (segment 2), with an agency still as the buyer.
- Stop if none pay. Keep the free MCP server as open source and do not build waves 3–5.

**G1, after wave 3:**
- Continue if a 3-session pilot project is reviewed in under 45 minutes and at least 2 of the 3 concierge customers would switch from the concierge service to the tool.
- If Claude Code or Codex ships a cited handoff export first, reassess whether cross-vendor coverage, signing and the approval trail are still enough to pay for.

**G2, launch plus 60 days:**
- Continue if there are 5 or more paying customers, at least 1 repeat packet or subscription renewal, and no redaction incidents.
- Stop if there are fewer than 3 paying customers.
- If any client reports a leak, halt export until the root cause is fixed and the eval corpus covers it.

## 6. Risks

1. **Agencies may not want clients to see transcripts.** Raw sessions show how much was done by agents, the dead ends, and offhand remarks. Mitigation: the client view is curated by default and shows typed nodes with short redacted quotes. Full excerpts are opt-in. Artifact anchors let the evidence lean on the client's own repo.
2. **A redaction miss would be a breach of the client's IP or credentials.** Mitigation: export is allowlist-only, a human signs off every excerpt, there is a seeded-secret eval corpus, and the export fails closed on any detection the reviewer hasn't cleared.
3. **The platforms may absorb this.** Shareable Claude sessions (reported), Codex memories, Entire and Nessie could all move here. Mitigation: compete on attestation, signing and cross-vendor projects, not on capture. The concierge gate keeps sunk cost low, and G1 re-checks the market.
4. **Vendor transcript formats are undocumented.** A vendor release can silently drop turns or leak them. Mitigation: detect format versions, run contract tests per version in CI on 3 operating systems, and fail closed on unknown formats.
5. **Willingness to pay is unproven, and agencies can build this themselves** (Metal Toad built a handoff generator in 3 days). Mitigation: charge before building, and price against the existing line item. Linked risks: the product is modelled on Nessie's public workflow, so a clean-room legal review happens before any public marketing, and the wording and UI stay original.

## 7. Open questions for the founder

1. **License for the free core.** Permissive (Apache-2.0, our recommendation) or source-available? This decides whether the MCP server can spread through the ecosystem.
2. **Headline price.** Per packet or Studio subscription? The concierge phase can test only one framing cleanly.
3. **White-labelling.** Do agencies get packets under their own brand, or do Ledger-branded packets act as referral marketing?
4. **Legal budget.** Who does the clean-room review against Nessie, and the directory-policy review, and with what budget?
5. **Founder time.** Can the founder personally run 10 agency conversations in weeks 1–2? Which 2 network contacts go first?

## Fact-check (2026-11-06)

An independent check of the sources this plan relies on found:

- **Confirmed:** Scand recommends reserving 10–15% of scope for technical documentation, and calls clients AI-equipped technical auditors. The Stack Overflow 2026 survey reports that 93% need source attribution to trust AI output. Entire raised a $60M seed (Feb 2026) and lists Trails as free; Trails links the Claude Code and Codex sessions behind a change. Cursor staff said Memories was intentionally removed in 2.1.x, though a later reply suggests only the management UI was removed. The OpenAI directory shared by ChatGPT and Codex forbids ads and upgrade promotion in plugins.
- **Corrected above:** Nessie is local-first, not cloud-first. The survey's 66% covers developers who use AI, not all developers, and the 27% figure has no stated base. claude-mem and Supermemory are not simply free.
- **Implication:** Entire is the closest well-funded competitor for agent decision trails, so the plan must not drift toward PR context (the Trail direction). The defensible wedge is a curated, human-approved, signed deliverable for the agency's client.
