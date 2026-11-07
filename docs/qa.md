# Judge Q&A sheet

Short, honest spoken answers. Every number traces to [the benchmark report](benchmark.md), [the eval log](evals.md), or the cycle 6 eval log on `leo/latent-read`.

**1. Why not just send a summary? A summary is small too.**
A summary is small, but you can't check it, and it drops where each claim came from. Every node in our graph cites the exact chat line, so the receiving agent or a person can verify it. Published research (SwaT, arXiv 2610.15095, by other authors) found latent transfer beat text summaries on accuracy at the same budget. Our own graph-vs-summary benchmark is next work; it needs a model API key.

**2. Who actually clicked Confirm? Can an agent fake it?**
Decisions are accepted only from a same-origin browser request on the local machine. The server binds to loopback, and the CLI and the MCP adapter can't record a decision. Party names are self-asserted today, so this keeps honest agents out but doesn't prove identity. Signing is next on the roadmap (card P4).

**3. Your numbers come from synthetic data. Why should we believe them?**
Yes, the benchmark uses seeded synthetic sessions, so it's reproducible and contains no private data. We have a dogfood script (`bench/dogfood.mjs`) that runs the same meter on real sessions locally and reports only totals, never transcript text. Real-session numbers come from that, and we'll only share aggregates.

**4. Building the graph costs tokens too. Did you count that?**
It's a one-time cost per session, and it's reused on every handoff after that. If section 8 of the benchmark report exists, cite its break-even point. If not, say it's measured next, and that the saving shown is per handoff, not net of extraction.

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
