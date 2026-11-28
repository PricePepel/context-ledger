# Competitive research: FlashDrive

*Researched 2026-11-19. Sources: flashdrive.space (home, pricing, roadmap, comparison page, manifesto, security page, seven blog posts, `llms.txt`), the YC company and launch pages, and the founders' launch posts on X and LinkedIn. I didn't sign up or use the product. Confidence: high on what it does, because their own docs are detailed and frank about limits. Low on traction: it launched this month and the only numbers are social engagement.*

## Summary

FlashDrive (YC F26, by Evokoa Inc.) is a **cloud filesystem shared by a team and its agents**. You mount it on macOS or Linux, or reach it over MCP, a CLI, a Python SDK or a REST API. Claude Code, Codex and Cursor on different machines and in cloud sandboxes then work in the same live files.

What it does well:

- It refuses stale writes.
- It merges edits that don't overlap.
- Its search uses grep, run on the server.
- It hands each cloud job a short-lived key scoped to one folder.

Their thesis is the opposite of ours, stated plainly: **"shared context is a place"**, not a memory layer. Agents hand off by one writing a file and the next one reading it.

It is **closer to us than RADSuite**. Both products pitch "agents on different machines pick up each other's work". The difference is what moves between agents:

- **FlashDrive moves files.** Whatever an agent wrote, with no record of why it was written or whether anyone agreed to it.
- **Context Ledger moves evidence.** A claim, the transcript line that supports it, and a human confirmation where two parties are involved.

So FlashDrive is a substitute for the casual user. For anyone who needs to know where a decision came from, it is a place our output could live.

## 1. The company

- **Evokoa Inc.**, San Francisco, two people, YC Fall 2026 ([YC](https://www.ycombinator.com/companies/flashdrive)).
  - Dale Ng (CEO) previously founded WonderSearch and scaled an earlier company to 5,000+ paying customers.
  - Dalton Prescott Ng (CTO) is a two-time Apple WWDC scholar.
- **Prior products, by their own account** ([manifesto](https://flashdrive.space/manifesto/)):
  - Polygres: Postgres rebuilt in Rust as a serverless graph and vector layer. The YC post says it has 1k+ developers.
  - WonderSearch: data indexed so it can be searched with code. "In our own evals, letting agents search with grep and regular expressions gave them better and more flexible search than anything else we tried." This is their own unpublished eval.
- **Launch:** mid-November 2026, on [X](https://x.com/flashdrive_ai), LinkedIn and a [YC launch post](https://www.ycombinator.com/launches/XiG-flashdrive-a-shared-drive-for-your-team-and-all-your-ai-agents). The LinkedIn post the team shared had about 900 reactions. That measures interest, not usage.
- **Cadence:** seven blog posts in about three weeks, plus a public roadmap and a dated, sourced comparison page. They are shipping and marketing hard.

## 2. What the product does

**Ways in:**

- A mount on macOS and Linux.
- MCP at `mcp.flashdrive.space`, for cloud agents with no filesystem.
- A CLI with pull and push (this is the Windows path), a Python SDK and a REST API.

All of these come from [`llms.txt`](https://flashdrive.space/llms.txt) and the [comparison page](https://flashdrive.space/compare/cloud-drives/).

| Area | What they say |
|---|---|
| Concurrency | Every write names the revision it was based on, and a write against a stale revision is refused, so the agent re-reads and redoes its edit. Through a mount, non-overlapping edits to text or markdown merge, and overlapping edits keep both versions. CSV rows merge "like a database". |
| Search | Keyword search and grep or regex across the whole drive, run on the server, with path filters and reads by line range. The point is that an agent can grep a cloud drive without downloading it. |
| Large files | Files show up at full size but take "zero bytes on disk". Only the byte ranges a program reads are fetched, and only changed ranges are sent back. |
| Sandbox tokens | One drive or one folder; `read` or `read_write`; 5 minutes to 12 hours; can be extended and revoked; at most 500 live per workspace. **"A sandbox token can never write agent instruction files."** |
| Safeguards | Deleted files stay in the trash for 1 hour; there are hourly service backups. Retained version history and point-in-time recovery are **not** launch features. |
| Limits | 500,000 files and 1 TB per drive, and 10 GB per file. |
| Feedback loop | Ask your agent to "report a bug to FlashDrive". It files the steps, error codes and versions, and nothing from your files. |

**Roadmap** ([roadmap](https://flashdrive.space/roadmap/)):

- Full versioning, and branches of a whole drive.
- Database connectors, starting with Postgres.
- More "agent-native file primitives": merging by markdown section, JSON key, JSONL append and YAML setting.
- Cold storage, a desktop app, and more concurrency (1,000 sandboxes).

**Pricing** ([pricing](https://flashdrive.space/pricing/)):

| Plan | Price | Includes |
|---|---|---|
| Free | $0 | 10 GB and a limited compute quota |
| Personal | $20/mo | 500 GB and 3 mounts |
| Team | $50 per human seat a month | 1 TB per seat, pooled |

**Agents never need a seat.** Compute covers reads, writes and searches under a fair-use cap. The first month is half price.

## 3. Their argument against us, and against the console

Two of their posts argue directly with parts of our plan, so we should answer them rather than ignore them.

1. **"Shared context is a place"** ([post](https://flashdrive.space/blog/your-agents-already-work-as-a-team/)).
   - Their claim: a memory layer is the wrong framing; put the plan in a shared file and every agent inherits it.
   - Their example: the CTO's Claude Code tightened the goals in `plan.md`, and later the CEO's Codex added owners to tasks. Codex kept the new goals without knowing anyone had changed them.
   - Our answer: that is exactly the failure we prevent. Codex silently accepted a change nobody had agreed to, and nothing in the file records who changed the goals, why, or on what evidence. It works between two co-founders who trust each other; it doesn't hold up for two parties or a decision you need to audit.
2. **"Who even uses dashboards?"** ([post](https://flashdrive.space/blog/who-even-uses-dashboards/)).
   - Their claim: dashboards get built and then go unopened. "Asking is quicker than looking": an agent reads the files and answers "in a sentence, with where it came from".
   - This is a fair hit on a Grafana-style console (card U1).
   - Our answer: the "where it came from" part is our product. The console should lead with **ask, then see the cited answer and the line behind it**, with panels second (see section 5).

## 4. How Context Ledger differs

| | FlashDrive | Context Ledger |
|---|---|---|
| What moves between agents | Files: whatever the last agent wrote | A cited graph: every claim points to transcript lines |
| Why something is true | Not recorded. The file is the only state | The citation to the original turn |
| Agreement between people | None. Last non-stale write wins, or a conflict copy is kept | Two-party rooms; people confirm proposals in the browser |
| History | 1-hour trash; versioning is on the roadmap | Graph snapshots; card G11 adds a diff between them |
| Where data lives | Their cloud | Your machine, loopback only |
| Input | Whatever agents choose to write down | The agents' actual transcripts, imported explicitly |
| Search | Grep over every file in the drive | Search over sessions and graph nodes |
| Business | Storage and compute; humans pay, agents free | Not decided (P5) |

**Where they're stronger:** zero setup across machines, cloud sandboxes and many people; real concurrency control; any file type; and a large, obvious market ("Google Drive for agents").

**Where we're stronger:**
- Provenance: a claim, its line, and its confirmation.
- Nothing has to be written down: we read the transcripts, so knowledge an agent never put in a file still gets captured.
- Local-first privacy.
- Disagreement handled as data, not as a conflict copy.

**Risk:** if they add version history plus an "explain this change" feature, files would gain some provenance. Even then it would come from file diffs, not from the conversation that led to the change.

**Complement:** a FlashDrive folder is a natural place to put the ledger's output: approved, cited decisions as markdown next to the team's files. That makes them a possible channel, like T3 and Capy.

## 5. What we can borrow

These ideas come from public material only; no code was seen or copied.

1. **Refuse stale publishes.**
   - `graph_publish` would take the snapshot ID it was based on. If someone published since then, it is refused, and the agent re-reads the graph and retries.
   - This is the cheapest fix for the concurrent-publish gap already noted in the T3/Capy research, and their whole product shows the pattern works.
   - Candidate card **G13**.
2. **Grep-style search for agents.**
   - Add a regex mode, a path or session filter, and reads by line range to `session_search` and `session_read`.
   - They report that agents searched better with grep and regex than with anything else they tried. That is their own unpublished eval, but it matches how coding agents already behave in a repository.
   - This fits the paging we already have.
3. **Short-lived, scoped MCP tokens.**
   - A token for one graph or room, read-only or read-and-publish, that expires and can be revoked.
   - This fleshes out the "MCP access levels" idea and helps with self-asserted party names.
   - Their rule that a token can never write agent instruction files maps to ours: no agent token can confirm a room proposal. Worth stating as a property of every token.
4. **Lead the console with a question.** In answer to the dashboards post:
   - U1's first screen is an ask box. The answer comes back with the cited node and the transcript line highlighted.
   - Panels for tokens saved and handoffs come second.
   - This also makes a better 10-second video shot than a chart.
5. **Export decisions as files.**
   - Write the approved graph as markdown, with one decision per section and a citation link on each line, into any folder the user picks, such as a `.ledger/` folder in the repo, FlashDrive or Google Drive.
   - Agents that only read files (their whole user base) then get our evidence for free.
   - This extends G12 and the `.ledger/` idea from the RADSuite doc.
6. **Bug reports filed by the agent.**
   - A `ledger report` command or MCP tool drafts a GitHub issue with the steps, versions and error codes, and **no transcript text**. That is our AGENTS.md section 5 rule built into the tool.
   - Useful for dogfooding and for early users.
7. **Be frank about limits.**
   - Their `llms.txt` and FAQ state the trash window, the missing version history, and what backups don't cover.
   - A short "limits" section in our README (self-asserted parties, loopback only, synthetic benchmarks) would build the same trust. An `llms.txt` is already on our list from the Capy research.
8. **A comparison page with sources and dates**, like theirs: "this comparison is published by the vendor… checked on November 13". Use it for G10's `BENCHMARKS.md` and any marketing page.
9. **Pricing signal for P5:** charge per human and leave agents free. It's simple to explain, and it removes the fear of scaling agents.

**Not worth copying:** the mount driver, byte-range streaming and cloud storage. That is a different business, and it would break loopback-only.

## Gaps and caveats

- Everything comes from their own site and launch posts. There are no independent reviews yet, and the product is days old.
- Their search eval and the Polygres usage figure are unpublished, so take them as claims.
- I didn't see the MCP tool list: `mcp.flashdrive.space` needs an account. I only checked that the endpoint exists.
- The site loads in a browser but not through Firecrawl, so I read the server-rendered HTML directly with plain HTTP requests.
