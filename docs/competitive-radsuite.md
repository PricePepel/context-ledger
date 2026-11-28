# Competitive research: RADSuite

*Researched 2026-11-16. Sources: radsuite.com pages, the parent company's site and press release, Crunchbase, the GitHub API, certificate transparency logs, and RADSuite's public JavaScript bundle (the code every visitor's browser downloads). No sign-in, and no requests to any private endpoint. Confidence: high on what the product is; low on traction, because the only number comes from the company itself.*

## Summary

RADSuite is a **hosting and runtime platform for agent apps**. You connect a GitHub repository, and it runs each agent in its own container on Google Cloud Run. Around that it adds:

- secrets, triggers and workflows
- chat "channels" (Discord or its own)
- live logs
- an LLM proxy that bills tokens from a prepaid balance

It is early: a soft launch with **one paying client in Q2 2026**, documentation "being compiled", and an empty GitHub organisation. It comes from a small Nevada company (Bioniclogic Inc.) whose past businesses were browser games and an ad network.

It is **not a competitor** to Context Ledger. It sits a layer below us: it runs agents, while we record and prove what agents know. It's still useful as a reference for operational features (channels, triggers, access roles, live logs, a playground) that our console (card U1) could borrow.

## 1. The company

- **Legal entity:** Tactics Technology LLC, "a division of Bioniclogic Inc." ([terms](https://www.radsuite.com/terms)).
  - Bioniclogic was founded in 2017 and is based in Gardnerville, Nevada ([Bioniclogic](https://www.bioniclogic.com/), [Baton](https://www.baton.com/small-business-value-estimate/bioniclogic-inc-gardnerville-nv-89410)).
  - Its other products: the Supernova SWF Enabler extension (400k weekly users, by its own count) and the FPS game Warmerise. Past businesses: the CPMStar ad platform (sold to Aditude in 2024), MMOHuts and OnRPG.
- **Traction:** FY2025 revenue was **$38K**, from consulting and interest. "RADSuite… operated commercially for a single client throughout Q2 2026", in the president's words (Joshua Goldstein; [press release, 2026-07-14](https://www.bioniclogic.com/pressrelease-2026-07-14.html)). This is a single source, and it is the company's own.
- **Public footprint:**
  - The GitHub org `rad-suite` was created 2026-04-08 and has 0 public repositories ([GitHub API](https://api.github.com/orgs/rad-suite)).
  - The X and LinkedIn accounts are linked from the site. No independent coverage turned up in searches.
  - Searching the name is noisy: "RadSuite" is also a radiology reporting product and a radiation-dose tool, both unrelated.

## 2. What the product does

**Pitch:** "Build, Deploy & Scale Agentic Applications", meaning runtime, deployment and lifecycle management for *supervised* agent apps ([home](https://www.radsuite.com/), [platform](https://www.radsuite.com/platform)).

**How it works**, according to the platform page:

1. Connect a Git repository and give RADSuite an SSH key.
2. Set secrets in an encrypted vault; they are injected into the container only at runtime.
3. Deploy. Each agent runs in "a dedicated, ephemeral container runtime" (Docker), and build logs stream over WebSockets.
4. Control the containers through MCP: "Control container lifecycles, mounted configuration, and secret injection from any MCP-compatible CLI or agent."

**What the app actually contains**, read from the screens and API calls in the public bundle (so this is fact about the shipped client, not marketing copy):

| Area | What's there |
|---|---|
| Projects | GitHub import, a blank repository, or a template. "RADSuite-hosted repositories will be available soon" |
| Environments | Staging, production, or custom names. Compute profiles (CPU/RAM presets), custom domains via CNAME (`*.slashrad.com`), static IPs, a "Job Config (JSON)" editor |
| Channels | Chat interfaces to an agent: **Discord channels** or a private "RAD channel", each tied to a project and environment, with restart and shutdown controls and invite links |
| Triggers → Workflows | Event listeners ("Trigger Event Type", "Prompt / Description Pattern") that run an ordered pipeline of reusable workflow scripts. The features page also promises cron schedules with timezones |
| Access | Roles per resource: owner, manager, member, viewer or guest on projects, environments and channels. Also groups, roles and invites |
| Models | An LLM proxy with a model list and an **"Example cURL request"** playground using a personal access token |
| Logs | Live runtime and build/deploy logs (`/api/logs/cloud-run/:id`, socket event `subscribe_to_job_logs`) |
| Marketplace | "Deploy agent-ready containers in one click" (`/api/marketplace/listings/:id/deploy`). Publishing and monetisation are marked "coming soon" |

**Stack**, from the bundle and certificate logs:

- Front end: Vue 3 + Pinia. Back end: Supabase (auth, Postgres tables such as `channels`, `projects` and `models`) and socket.io.
- Runtime: Google Cloud Run services and jobs. Payments: Braintree.
- Subdomains in certificate logs include `mcp.`, `mcpremote.`, `llmproxy.`, `llmproxy-pricing.`, `container-router.`, `deploy.`, `devpreview.`, `status.` and `deck.radsuite.com` ([crt.sh](https://crt.sh/?q=%25.radsuite.com)).
- Inference: they run a remote MCP endpoint, and their own LLM proxy is how they meter tokens.

**Pricing** (from the pricing screen):

- Prepaid wallet, pay as you go, "no recurring monthly platform fees".
- Container uptime is billed per second of Cloud Run execution, and AI tokens per million.
- When the balance reaches $0, environments and channels are "paused safely". Auto-recharge is recommended.
- An enterprise retainer of **$50/seat** applies to teams of 5 or more.

## 3. Weaknesses

- **Early-stage claims.** The copy hedges throughout: "being designed around… human approval patterns", "being validated through early customer workflows". It promises human approval gates and agent-to-agent communication, but no screen for approvals appears in the bundle. That is inference, from looking for one.
- **Thin product surface.** Docs are "currently being compiled", there are no public repositories, and the marketplace is unfinished.
- **Rough production build.** Debug `console.log` lines (for example "ChannelsView: Making API request to:") ship in the production bundle.
- **Lock-in.** Everything depends on Supabase, Cloud Run and their proxy; there is no self-hosted option.
- **No memory or knowledge layer.** "Context Engineering" means mounting Git, Google Drive and databases into containers with controlled access. Nothing extracts, cites or carries knowledge between agents.

## 4. How Context Ledger differs

| | RADSuite | Context Ledger |
|---|---|---|
| Layer | Runtime and hosting for agent apps | Memory and evidence for coding agents |
| What it manages | Containers, secrets, deploys, chat channels | Transcripts, a cited semantic graph, two-party rooms |
| Where it runs | Their cloud (Cloud Run + Supabase) | Your machine, loopback only |
| Revenue model | Margin on compute and tokens through a prepaid wallet | No resale of compute or tokens |
| "Supervised" | Claimed, in progress | Built: people confirm room proposals in the browser, and every node cites its source lines |
| MCP | Controls their infrastructure | Gives agents cited context |

There is no overlap in what we do. A RADSuite-hosted agent could use the ledger as an MCP server like any other client. A cloud container can't reach our loopback server, though, so that would only work once a hosted or relay mode exists. That isn't planned.

## 5. What we can borrow

These are ideas taken from public behaviour only. No code was copied, and none should be.

1. **Live updates for the console (U1).** They stream logs over socket.io subscriptions. We can do the same with a Server-Sent Events endpoint on the loopback server: no new dependency, and it gives the "graph grows live" view its feed.
2. **A playground screen.** Their Models page shows a ready-made cURL request you can run with your token. A console panel that calls `context_for` or `graph_read` and shows the exact result an agent would get makes the MCP visible. That's useful for demos and for debugging.
3. **Roles per resource.** Owner, manager, member and viewer on each project, environment and channel. This lines up with the MCP access levels already proposed (read only, supervised, full) and with tightening room parties beyond self-asserted names.
4. **Triggers on graph events.** Their pattern is an event, optionally matched against a prompt pattern, followed by an ordered pipeline. For us that could mean "when a new node contradicts a constraint node", "when a room gets a proposal", or "when a graph is republished", each feeding a console alert or a notification. People would still confirm in the browser.
5. **A channel bridge for notifications.** Discord channels attached to an agent. A notification-only bridge, such as "room has a new proposal → link to confirm in the browser", fits our rule that confirmations stay in the browser.
6. **A repo convention.** `.rad/skills/<name>` appears in their bundle. Together with Capy's `skills/<name>/SKILL.md` and `AGENTS.md`, this suggests a `.ledger/` folder where approved, cited decisions can be committed next to the code (ties to card G12).
7. **Remote MCP.** Their `mcp.` and `mcpremote.` hosts suggest MCP over HTTP alongside stdio. A loopback streamable-HTTP transport would let several local clients share one ledger process. It would still need the Host and Origin checks from AGENTS.md section 6.
8. **What not to copy:** the prepaid token wallet and LLM proxy. Reselling tokens goes against the local-first story and adds billing risk.

## Gaps and caveats

- Traction rests on one statement by the company and its own revenue figure.
- Prices per hour and per token weren't readable from the static bundle; they load at runtime from the pricing API.
- Bundle contents show what the client can call, not what the server does or how well it works.
- I didn't sign up or use the product.
