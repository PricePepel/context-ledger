# Judge Q&A sheet

Short, honest spoken answers. Every number traces to [the benchmark report](benchmark.md), [the eval log](evals.md), or the cycle 6 eval log on `leo/latent-read`.

**1. Why not just send a summary? A summary is small too.**
A summary is small, but you can't check it, and it drops where each claim came from. Every node in our graph cites the exact chat line, so the receiving agent or a person can verify it. Published research (SwaT, arXiv 2610.15095, by other authors) found latent transfer beat text summaries on accuracy at the same budget. Our own graph-vs-summary benchmark is next work; it needs a model API key.

**2. Who actually clicked Confirm? Can an agent fake it?**
Decisions are accepted only from a same-origin browser request on the local machine. The server binds to loopback, and the CLI and the MCP adapter can't record a decision. Party names are self-asserted today, so this keeps honest agents out but doesn't prove identity. Signing is next on the roadmap (card P4).

**3. Your numbers come from synthetic data. Why should we believe them?**
The benchmark uses seeded synthetic sessions so anyone can reproduce it and no private data is involved. For real data we built `bench/dogfood.mjs`: it runs on your own Claude Code and Codex folders, locally, and reports only totals (how big real handoffs are, by percentile), never any transcript text, file name or path. That gives the real-world size of what we compress.

**4. Building the graph costs tokens too. Did you count that?**
Yes. An agent reads the session once and writes the graph once. At 200 or 1000 turns that pays for itself from the second handoff against today's handoff, and every later handoff is about 90% (200 turns) to 96% (1000 turns) cheaper (estimates; benchmark sections 7 and 8). It's a lower bound, because real extraction also spends tokens on instructions. If a handoff format were made cache-friendly, the graph would still win on very long sessions, but not on short ones. That's why caching-friendly graph rendering is on our list.

**5. How is this different from MCP or A2A?**
We're a layer *over* MCP; our tools are MCP tools. A2A moves messages between agents. We move cited, human-approved state: what each person wants and what both agreed.

**6. Why won't Anthropic or OpenAI just build this?**
Each will build sharing inside its own ecosystem. Neither has a reason to build a neutral bridge into the other's agents. Context Ledger works with Claude Code and Codex in the same room.

**7. What about prompt injection? A file could tell the model to lie.**
We tested exactly that. In the latent layer, every number and name in a finding must appear in the lines it cites, and lines that address an AI reader are flagged. On the injection test the hijacked finding was dropped in 3 of 3 runs, and the answer was marked unverified.

**8. Privacy: where do the transcripts go?**
Nowhere. It runs locally on loopback, imports are explicit (you choose each file), and the latent layer's model runs on your own GPU. Transcripts are never committed; only synthetic data is in the repo.

**9. What's built today, and what's next?**
Built today: cited graphs, cross-graph links, rooms where only people agree, the MCP adapter, the warm latent read (M2a) and the benchmark. Next: cross-family latent transfer (M2b), identity and signing, a summary baseline, and real-session numbers.

**10. Why should we believe the latent layer works?**
The same-model part (M2a) was measured today on a laptop GPU. Latency dropped from 1,972 ms to 426 ms, 98–99% of prompt tokens came from cache, the agent received about 5–9% of the tokens, and both gates passed 3/3. The cross-family part isn't built yet; published research by others (SwaT) is our evidence that it can work.
