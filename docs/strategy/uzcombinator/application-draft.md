# UzCombinator Batch 3 application — draft

Deadline: **10 November 2026, 23:59** (confirmed on uzcombinator.uz on 6 November). The form is behind a login, so the exact questions are not known. These answers cover the usual ones; paste and trim them to the form. Replace every `[[...]]` before submitting. Do not claim anything the founder cannot show in the interview.

## One line

Ledger Handover turns AI coding-agent sessions into signed, human-approved handover receipts, so a software agency can prove to its client who decided what, and why, in AI-built code.

## What are you building? (in your own words)

Software agencies now build a large part of their clients' code with AI agents such as Claude Code and Codex. When the project ends, the client receives code but not the reasoning: which decisions were made, what was rejected, what is still open, and what the AI did versus the people. That reasoning is buried in thousands of lines of agent transcripts that nobody can share safely.

Ledger Handover reads those transcripts on the agency's own machine. The agency's AI agent drafts a handover — goals, decisions, open blockers and next actions — and every item must point to the exact message it came from. A named person at the agency approves or edits each item, secrets are redacted, and the packet is digitally signed and tied to the client's commit hashes. The client can verify it offline and countersign it at acceptance.

The core (import, search, agent handoff) is free and open source, so it spreads through Claude Code and Codex plugin marketplaces. Agencies pay for signed client packets.

## What is already built?

[[Update on 9–10 November with what the demo sprint actually shipped.]]

- A working local tool (Node.js, SQLite) that imports Claude Code and Codex transcripts, searches across them, and exports cited handoffs that one agent can use to continue another's work.
- A validated "semantic graph" format: decisions, actions and blockers that must cite real transcript lines, with automatic checks for broken references and cycles.
- Tested on 394 of the founder's own real agent sessions (1.3 GB): this surfaced three real-world problems (very large sessions, damaged lines, agent-to-agent messages) that are now being fixed.
- 20+ automated tests, browser end-to-end tests and CI on every change; independent AI code review on every feature.
- [[If the demo sprint lands: signed, redacted, human-approved packet with an offline verifier and client countersignature.]]

## Who is the customer and why will they pay?

The first customers are software export companies with 3–30 people, especially IT Park residents who build for US and European clients on fixed-price contracts. Handover is already a paid part of these contracts (typically 10–15% of scope goes to technical documentation). A signed, cited handover is something the agency can bill for and that wins trust with clients who are now nervous about AI-written code: in Sonar's 2026 survey, 96% of developers said they do not fully trust AI-generated code.

Later, the client side pays: enterprises that receive AI-built software from many vendors need one way to verify what they accepted.

## Why now?

- Most professional developers now work with AI coding agents every week, and many companies use more than one vendor's agent.
- Clients and regulators are starting to require disclosure of AI use in software contracts.
- Uzbekistan is pushing IT exports toward $5 billion by 2030. Trust with foreign clients is what decides whether Uzbek agencies keep and grow those contracts.

## Competitors and why we win

- Entire (raised $60M) links agent sessions to code changes, but it is built for a developer's own repository, not a signed deliverable that a client approves.
- Nessie, SpecStory and memory plugins store or search transcripts for the person who wrote them.
- None of them produce a client-facing, human-approved, signed and redacted handover. Our wedge is the agency-to-client moment of acceptance, and our distribution is the Uzbek IT export community.

## Traction

[[Be exact. Today: 0 customer interviews. Target by 10 November: 5–10 conversations with agency owners from the target list below, and any written interest (LOI or email). Count only real ones.]]

## Team

[[Founder name, role, citizenship or residency, whether full-time, can be in Tashkent for 45 days. Co-founder: name and role, or "looking — using UzCombinator co-founder matching". If the new collaborator (GitHub: Vuek0) is a co-founder, say so with their role.]]

Why us: [[founder-market fit — e.g. we use Claude Code and Codex daily, built this tool to hand work between our own agents, and know the Uzbek agency market.]]

## What will you achieve in the 45 days?

1. Week 1–2: 20 interviews with agency owners; 3 paid hand-assembled packets (concierge), priced $299–499.
2. Week 3–4: first agencies using the tool on a live client project; first client verifies and countersigns a packet.
3. Week 5–6: free core listed in Claude Code and Codex marketplaces and the MCP registry; 3+ paying agencies and 1 enterprise recipient interested in verifying packets from several vendors.

## Business model

Free open-source core. Paid: $249 per signed client packet, or a Studio plan around $149 per month for unlimited packets. Enterprise verification for clients that receive work from many vendors comes later.

## Target agencies to contact this week

From the Clutch Uzbekistan list (fit is unverified until a conversation): UzVIP, USOFT Round Umbrella, ZK-Digital, Udevs, Exadot, IT Brick, Tezcode, SSD Software Solutions, Azzimut, IOTA.UZ, ShahNur Software, Appx Group, Automatic Technology Solutions, NAPA Team, Digerati Group.

## Questions the interview will ask — prepare answers

1. "How many agency owners have you spoken to, and which one would show this packet to a client?" — needs real names by the interview.
2. "The agency holds the key and chooses what to import. What does the signature prove?" — It proves who approved the packet and that it was not changed afterwards, and it is tied to the client's own commit hashes; the client countersigns at acceptance. It does not prove the agency included every session, and we say so.
3. "Entire has $60M. Why can't they add this in a sprint?" — They could add a button; they are not building the agency-to-client workflow, the redaction and approval trail, or the distribution into Central Asian and Eastern European export agencies.
