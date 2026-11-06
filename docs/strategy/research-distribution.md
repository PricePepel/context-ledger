## Context Ledger: distribution channels inside coding agents (research input, 2026-11-06)

### Channel by channel

**1. Official MCP Registry (registry.modelcontextprotocol.io)**
- **Listing:** you publish metadata only, using a CLI. A pull request to the repo does not publish anything. The `server.json` points at a public npm, PyPI or Docker package, or a public remote URL. Names are namespaced (`io.github.user/server`) and verified through GitHub or DNS. The registry does not support private servers. It is still in preview, and "breaking changes or data resets may occur." https://modelcontextprotocol.io/registry/about , https://github.com/modelcontextprotocol/registry
- **Reach:** indirect. Aggregators and marketplaces are the intended consumers, not host apps (same source). VS Code's `@mcp` gallery in the Extensions view lists servers from the GitHub MCP Registry, and only registry-listed servers can be added through it. https://code.visualstudio.com/docs/copilot/customization/mcp-servers , https://docs.github.com/en/copilot/how-tos/provide-context/use-mcp-in-your-ide/extend-copilot-chat-with-mcp . PulseMCP lists 21,584 servers, so discovery is crowded. https://www.pulsemcp.com/servers
- **Money:** none. It is a metadata index.
- **Minimal integration:** an npm package (`npx context-ledger-mcp`) plus a `server.json` under 4KB. https://modelcontextprotocol.io/registry/faq

**2. Claude Code plugins**
- **Own marketplace:** a `.claude-plugin/marketplace.json` in a git repo. There is no review and no submission form. Users run `claude plugin marketplace add owner/repo` and then `claude plugin install`. Auto-update is off by default on the user's side. https://code.claude.com/docs/en/plugins/publish
- **Anthropic directory:** submitted through claude.ai/directory/manage and needs a paid Claude plan. Each version gets automated validation and a security scan. A person reviews a new listing, and review time isn't fixed. The plugin bundle must come from a public GitHub repo. Directory installs reach Claude Code as `<name>@synced`, and you get usage figures (installs, runs, error rates). The directory no longer accepts local servers packaged as desktop extensions (MCPB); a local MCP server has to ship inside a plugin bundle. https://claude.com/docs/directory/publish . `claude-plugins-official` takes no portal submissions. https://code.claude.com/docs/en/plugins/publish
- **Surface limits:** local MCP servers load in Claude Code and in Cowork running on the user's computer, but are ignored in claude.ai chat. Hooks are also ignored in chat. https://claude.com/docs/plugins/platform-support
- **Policy risk:** directory policy section 1G prohibits extracting data from Claude's "memory, chat history," and section 1E bars collecting "extraneous conversation data." A transcript importer could fail review. UNVERIFIED how reviewers treat reading local JSONL transcripts the user picked. https://support.claude.com/en/articles/13145358-anthropic-software-directory-policy
- **Money:** the policy bans ads. It does not directly address payments or upselling. (same source)

**3. Claude Code hooks (shipped inside the plugin)**
- `SessionStart` (matchers: startup, resume, clear, compact, fork) can inject `additionalContext`. Strings over 10,000 characters are saved to a file and Claude gets a 2,000-character preview.
- On `PreCompact`, the hook's stdout becomes instructions for the compaction summary.
- `SessionEnd` hooks get 1.5s by default, raised to a per-hook timeout of up to 60s.
- Plugin hooks merge with user and project hooks. https://code.claude.com/docs/en/hooks

**4. Codex / OpenAI plugins**
- **Format:** a portable `plugin.json` (Agent Plugins schema) plus `mcp.json` and `skills/`.
- **Distribution:** `codex plugin marketplace add owner/repo`. Codex also reads `$REPO_ROOT/.claude-plugin/marketplace.json` as a legacy-compatible source, so one repo can serve both Claude Code and Codex. https://developers.openai.com/plugins/build/plugins
- **Public directory blockers:**
  - Plugins with lifecycle hooks are not eligible for the public directory (same source).
  - Local stdio MCP submissions are limited to allowlisted partners and listed as "Desktop only." https://developers.openai.com/plugins/deploy/desktop-only
- **Money:** you may not sell digital subscriptions in the plugin, show plans, or promote upgrades. Users may sign in to an existing paid account. A published privacy policy is required. https://developers.openai.com/plugins/plugin-guidelines

**5. Cursor marketplace**
- Accepts the Agent Plugin format (root `plugin.json`, with skills and MCP only) or `.cursor-plugin/plugin.json` (which adds rules, hooks, agents and commands).
- Every plugin is manually reviewed and must be open source. Team marketplaces are on the Teams and Enterprise plans. https://cursor.com/docs/plugins
- The launch date is reported as Feb 17, 2026 (Cursor 2.5), but that comes from third-party sources only. UNVERIFIED review turnaround. https://www.claudemarket.ai/blog/best-mcp-directories-to-list-your-mcp-server

**6. AGENTS.md**
- A plain-markdown convention, now stewarded by the Linux Foundation's Agentic AI Foundation. It has no listing and no money.
- Adoption is reported as 40k+ projects https://siliconangle.com/2025/12/09/linux-foundation-announces-agentic-ai-foundation-joined-anthropic-openai-block/ and as 60k+ https://redmondmag.com/Articles/2025/12/09/Linux-Foundation-Launches-Agentic-AI-Foundation.aspx . Treat both counts as UNVERIFIED.
- Use for Context Ledger: a one-line pointer such as "read `.ledger/handoff.md` / call `ledger_ready_actions` before work."

**Price anchor:** Nessie (CLI + MCP + agent skill, cross-tool sessions) charges $28/mo Plus, $79/mo Pro and $80/seat Team, billed yearly. https://nessielabs.com/pricing , https://nessielabs.com

### Recommendations

**Fastest path to real usage:** one repo containing a portable `plugin.json`, `mcp.json` (a local stdio Node server), `skills/` and `.claude-plugin/marketplace.json`. Install is two commands in Claude Code and one in Codex. Also publish the npm package to the official MCP Registry so it appears in VS Code's `@mcp` gallery. Neither path needs a review gate. Submit to the Anthropic directory and to Cursor after that, since both are manually reviewed and the Anthropic one carries the 1G risk above. Skip the OpenAI public directory for now because of the partner allowlist and the hooks ban.

**Strongest lock-in:**
- **Hooks:** an opt-in `SessionEnd`/`PreCompact` hook auto-imports the current transcript, and a `SessionStart` hook injects ready actions and current decisions in under 10k characters. This makes capture automatic and the cited graph builds up with every session.
- **Graph packet format:** publish it as an open spec and point to it from AGENTS.md, so other agents write to it.
- **Where the money goes:** charge for hosted team sync and shared graphs outside the plugin. In-plugin upsell is banned on OpenAI, and Cursor requires open source.

### Minimal MCP tool set (stdio, loopback, local-only)
1. `ledger_import(path?, provider?)`: imports an explicit transcript. With no path, it imports the current session only if the user has opted in.
2. `ledger_search(query, provider?, limit)`: returns hits with session id and line numbers.
3. `ledger_handoff(session_id, max_chars?)`: returns the cited Markdown handoff.
4. `ledger_graph_read(session_id | project)`: returns ready actions, current decisions and open blockers, each with line citations.
5. `ledger_graph_publish(packet)`: validates a packet and writes it, returning validation errors as tool errors.
6. `ledger_sessions(limit)`: lists imported sessions.
7. Resource `ledger://handoff/latest` for clients that read resources.

Mark tools 1–4 and 6 read-only for approval-mode defaults. Leave `publish` as the only write.

---
Research stopped at the Cursor publish page (Firecrawl ran out of daily credits; the rest used built-in web tools). Per-channel install and reach numbers are UNVERIFIED; no source gave them. I edited no files.

You've reached Firecrawl's daily limit without an account. Sign up free for 1,000 credits a month: https://firecrawl.dev/k/7wv8dkc6vev1
