# Ledger Handover: competitive teardown (as of 2026-11-06)

## Summary
No competitor I found ships a **client-facing, claim-cited, human-approved, signed handover packet**. Entire comes closest. It already captures sessions, estimates attribution and writes summaries, and it could ship a "handover export" fast. Our window is roughly 6–12 months (estimate).

## Competitor matrix

| Competitor | Overlap with handover packet | Pricing | Funding | Time to ship our packet (estimate) |
|---|---|---|---|---|
| **Entire: Checkpoints CLI** | Each agent commit gets a checkpoint holding prompts, transcript and files touched. It is linked to the commit by a trailer and stored under `refs/entire/checkpoints/`. Secret redaction is "best effort". `entire dispatch` summarises recent agent work. Supports Claude Code, Codex, Cursor, Copilot CLI and more. MIT licence, 5.3k stars ([GitHub](https://github.com/entireio/cli)). It also estimates agent vs human line attribution per checkpoint ([docs](https://docs.entire.com/guides/sessions/sessions-in-entire-io)). | CLI free (MIT) | $60M seed at a $300M valuation, led by Felicis ([TechCrunch via mirror](https://hn.jakechampion.name/reader/https://techcrunch.com/2026/02/10/former-github-ceo-raises-record-60m-dev-tool-seed-round-at-300m-valuation)); team of about 50 ([Entire](https://entire.com/news/entire-launches-an-independent-git-forge-for-agent-human-collaboration)) | **1–3 months** for a summary/export. Signed, reviewer-approved claims are off their forge roadmap. |
| **Entire: Trails / forge** | Replaces the PR. Agents score every push against evals, and agent traces are reviewed next to the code. It needs repos hosted on Entire. Self-hosted Git nodes are only planned. No compliance certifications are claimed ([Entire](https://entire.com/news/entire-launches-an-independent-git-forge-for-agent-human-collaboration)). Launched 2026-10-26. | Only agent usage is billed: $100 one-time credit, then model tokens ([andrew.ooo](https://andrew.ooo/answers/what-is-entire-git-forge-dohmke-trails-2026/)). UNVERIFIED against docs.entire.com/billing. | same | Same as above. Blocked wherever the client owns the repo (GitHub, GitLab, Azure DevOps). |
| **Nessie** (YC F25) | Auto-syncs AI chats across ChatGPT, Claude, Claude Code, Codex and others into a shared, queryable context layer. About 1,200 users and 300k+ conversations at launch ([altss/YC profile](https://altss.com/companies/yc/nessie); [YC](https://www.ycombinator.com/companies/nessie)). Job posts list team sharing, permissions and policy as work still to build ([YC jobs](https://www.ycombinator.com/companies/nessie/jobs/3HYCa6v-founding-engineer)). | $80/seat Team: **UNVERIFIED**. One aggregator says pricing is not disclosed ([neuronfeed](https://neuronfeed.com/compare/nessie-vs-xai)). | BoxGroup, Pioneer Fund, YC; amount UNVERIFIED ([altss](https://altss.com/companies/yc/nessie)) | 3–6 months. Internal memory, not a client deliverable. |
| **SpecStory** | Saves Claude Code and other agent chats as local, git-friendly Markdown in `.specstory/` and shares them with teammates ([SpecStory](https://specstory.com/claude-code)). Enterprise page covers governance and live agent visibility ([enterprise](https://specstory.com/enterprise)). | Free / $25 Pro / $300/mo Team / custom Enterprise: third-party figures, UNVERIFIED ([aisotools](https://aisotools.com/compare/claude-code-vs-specstory)) | UNVERIFIED | 2–4 months. Has raw transcripts but no claim extraction, approval or signing. |
| **claude-mem / Supermemory** | Agent memory and recall. Not an audit trail. claude-mem is free under AGPL with about 74k stars ([Augment](https://www.augmentcode.com/learn/claude-mem-74k-stars-agent-memory); [vibecodinghub](https://vibecodinghub.org/tools/claude-mem)). | OSS / API | Supermemory: $2.6M seed, Oct 2025 ([TechCrunch](https://techcrunch.com/2025/10/06/a-19-year-old-nabs-backing-from-google-execs-for-his-ai-memory-startup-supermemory/)) | 6+ months. Wrong buyer. |
| **Swimm** | Has pivoted to services: Application Delivery, System Intelligence and AI Operability, starting with a paid one-week "Grounding sample". No public price list ([swimm.io/pricing](https://swimm.io/pricing)). | Quote only | $33.3M total incl. a $27.6M Series A (2021; date UNVERIFIED) ([FF News](https://ffnews.com/newsarticle/swimm-raises-27-6-million-to-repair-developers-love-hate-relationship-with-documentation)) | Low threat. It is a possible channel partner. |
| **Mintlify / DeepWiki / Devin Wiki** | Auto-docs built from the code, not from the decisions behind it. DeepWiki is free for public repos; private repos go through a Devin account ([Cognition](https://cognition.com/blog/deepwiki)). Devin Wiki can export ([Cognition KB](https://knowledge.cognition.ai/articles/9182101864-wiki-export)). | Mintlify Pro $450/mo annual ([usagepricing](https://www.usagepricing.com/blueprint/activity/mintlify-2026-08-04-pro-tier-reintroduced)) | Mintlify: $45M Series B at a $500M valuation, Apr 2026 ([Built In](https://builtin.com/articles/mintlify-raises-45m-series-b-20260417)) | They document *what* the code is, not *why* it was decided. Adjacent, not overlapping. |
| **Claude Code native** | Sessions are stored as local JSONL under `~/.claude/projects/`, purged after 30 days by default ([dev.to](https://dev.to/nishilbhave/claude-code-save-conversation-find-export-transcripts-2g1b)). Whether `/export` is built in is disputed: UNVERIFIED. claude.ai "Share" links are read-only, and real-time shared sessions are an open request ([GH #60082](https://github.com/anthropics/claude-code/issues/60082)). | bundled | Anthropic | Could ship an export at any time. Unlikely to ship a vendor-neutral, multi-agent, client-signed packet. |
| **Codex native** | Local JSONL under `~/.codex/sessions/` ([blog](https://codex.danielvaughan.com/2026/06/05/codex-cli-session-lifecycle-archive-resume-fork-compact-management/)). Share links and exportable summaries are still community requests ([OpenAI forum](https://community.openai.com/t/new-feture-request-in-codex/1380974)). | bundled | OpenAI | Same as Claude Code. |
| **Git AI** (provenance) | Agents report their own edits. Line-level authorship is kept in Git Notes (`refs/notes/ai`) and survives rebase and squash. Includes `git ai blame` ([GitHub](https://github.com/git-ai-project/git-ai); [docs](https://usegitai.com/docs/get-started/how-git-ai-works)). | CLI free (Apache 2.0). Teams and Enterprise prices not published ([rywalker](https://rywalker.com/research/git-ai)). | Not disclosed | Line provenance only, no decisions. It is a possible import source for us. |
| **Span** (provenance) | Classifier that detects AI-written code, claimed >95% accurate ([BusinessWire](https://www.businesswire.com/news/home/20250916147051/en)). Agent traces added Jun 2026 (UNVERIFIED, [rywalker](https://rywalker.com/research/span)). Sold to engineering leaders as AI adoption metrics. | Enterprise | $25M seed + Series A, Nov 2025 ([BusinessWire](https://www.businesswire.com/news/home/20251105703479/en)) | Different buyer (VP Engineering metrics). |

## Defensible wedge
**The agency-to-client deliverable, not the developer tool.** Every competitor serves the team that writes the code. We serve the moment code changes hands, and three things set us apart:
- **The client is the second reader.** They get a packet they can verify, usually without our software (or with our free verifier).
- **Repo-agnostic and local-first.** It works on client-owned GitHub, GitLab or Azure repos. Trails needs Entire hosting and has no self-hosting yet ([Entire](https://entire.com/news/entire-launches-an-independent-git-forge-for-agent-human-collaboration)). Transcripts never leave the agency's machine before redaction.
- **Priced per handover.** It is billed as a project line item the client effectively funds, not as per-seat developer tooling.

On the Uzbekistan beachhead:
- IT Park has 4,200+ resident companies, and resident revenue reached $2.8B in 2025 ([gov.uz](https://gov.uz/ru/digital/activity_page/it-park-uzbekistan)).
- Resident service exports were $392.5M in H1 2026, up $90.3M on H1 2025 ([UzA](https://uza.uz/ar/posts/eksport-uslug-rezidentov-it-park-dostig-3925-milliona-dollarov_898013)).
- Uzbekistan's 2030 target is $5B in IT exports ([Kazinform](https://www.inform.kz/ru/uzbekistan-nameren-uvelichit-eksport-it-uslug-do-5-mlrd-k-2030-godu-f705fa4b)).
- Agencies that export to foreign enterprise clients need trust signals, which is exactly this pitch.

## Moat over 24 months (judgment)
1. **Open packet schema plus a free verifier.** If clients start writing "Ledger-verified handover" into SOWs, demand comes from the client side and an agency switching tools breaks its client's workflow.
2. **A labelled corpus of approved claims.** Every reviewer approval or rejection of an extracted decision, blocker or action trains better extraction. Collected opt-in and on synthetic and consented data only. Entire's evals score code; they do not score handover claims.
3. **Compliance evidence mappings.** Map packets to SOC 2 change-management and ISO 27001 evidence requests. Not yet validated with auditors: UNVERIFIED.
4. **Multi-agent import breadth.** Import Claude Code, Codex, Entire checkpoints, Git AI notes and SpecStory files. Treating competitors as inputs makes us complementary rather than displaced.
5. **Distribution through IT Park, its export programmes and UzCombinator.** The first regional reference customers are hard for a US-based forge to reach.

## Three features to ship that none offer
1. **Claim-level citation plus a named-reviewer approval gate.** Every decision, blocker and next action is pinned to a transcript message ID and must be approved or rejected by a named reviewer before export.
   - Entire: attribution and evals, no human approval of claims.
   - SpecStory and Nessie: raw or structured history, no approval.
2. **Signed, offline-verifiable packet with a redaction attestation.**
   - Ed25519/Sigstore-style signature over a JSON+PDF bundle, plus a manifest listing which redaction rules fired and how many times.
   - The client verifies with a free CLI or web verifier and needs no account.
   - Entire's redaction is "best effort" and comes with no attestation ([GitHub](https://github.com/entireio/cli)).
3. **SOW-mapped delta handover.**
   - Each claim maps to the contract's deliverables and acceptance criteria.
   - Each packet shows what changed since the last signed one: new decisions, resolved blockers, risks that are still open.
   - This makes it a recurring per-milestone purchase that no forge, memory tool or docs tool produces.

## Risks
- Entire could add "export handover PDF" on top of `dispatch` within one quarter.
- Anthropic or OpenAI could ship native export.

**Mitigation:** win on the client-verification and approval layer, and import their data rather than competing on capture.
