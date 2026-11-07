# Context Ledger: three-minute pitch

Track: **wildcard**. Positioning: **horizontal**, meaning a trust layer between any two agents, shown through one concrete demo. This is the team's decision of 2026-11-07. Written to be spoken. Timings are targets. Every number traces to [the benchmark report](benchmark.md), [the eval log](evals.md), or the cycle 6 eval log on `leo/latent-read`.

## 1. Problem (0:00 to 0:20)

> Ruslan uses Claude Code. I use Codex. Every team now runs agents from more than one vendor, and those agents can't share what they know.
> Today the only bridge is pasting a whole chat into the other agent. It's huge, nobody can check it, and nobody controls what the agents agree to on our behalf.

## 2. The layer (0:20 to 0:55)

> Context Ledger is a layer over MCP that any two agents can share. It doesn't care which vendor made them or what job they do. It has two parts.
>
> The **text layer is for people**. Each agent turns its session into a small graph of goals, offers, constraints, decisions and open questions. Every claim cites the chat line it came from. When two agents link their graphs, the links are only proposals. **Only the two people can agree.** The server refuses agents that try.
>
> The **latent layer is for machines**. Today, a local open model reads the files once and keeps its memory warm, and other calls reuse it instead of re-reading. Ruslan built and measured this today. Passing that memory between *different* model families is next, and published research (SwaT, arXiv 2610.15095, by other authors) shows it can work.

## 3. Demo (0:55 to 1:55)

**One vertical, live: two people, two agents from different vendors, one room.** Say up front that this is one use of the layer, not the product's limit.

1. **0:55.** Show the two terminals: Claude Code (Ruslan) and Codex (Ali), both connected to the ledger over MCP. Each agent publishes its person's graph.
   > "Two vendors, one layer. Each agent publishes what its person wants, offers and can't do, and cites the line it came from."
2. **1:10.** In the browser, paste both graph IDs and select **Open room**. The proposals appear.
   > "The agents found these matches, a conflict and two answers. They decided nothing."
3. **1:25.** Ali selects **Confirm** on the co-builder match, then Ruslan does.
   > "Agreed only when both of us say yes."
4. **1:35.** Ruslan selects **Reject** on the Sunday conflict.
   > "One no is enough."
5. **1:45.** Reload the page. The decisions are still there.
   > "Stored, not just shown. An agent can't click these buttons."

**If the live run fails:** play `docs/demo/networking-demo.mp4` (61 s, recorded from the real app) and narrate the same five lines.

**Pre-seeded room for a fallback without agents:**
`node .claude/skills/run-context-ledger/driver.mjs seed --url http://127.0.0.1:4317 --story networking`

## 4. Numbers (1:55 to 2:25)

Say each caveat out loud. It costs two seconds and protects you in Q&A.

| Claim | Number | Caveat | Source |
| --- | --- | --- | --- |
| Graph size vs the full handoff | 25.7% at 50 turns, 10.2% at 200, 3.8% at 1000 (characters) | Synthetic sessions | [benchmark §1](benchmark.md) |
| Cost per 1,000 handoffs of a 1000-turn session, Claude Opus 5.5 | $119.36 for today's handoff (it can't be cached), $4.58 to $4.72 for the graph | Estimates (characters ÷ 4) at list prices; about 96% cheaper. Building the graph once pays for itself from the 2nd handoff. A *cache-friendly* handoff (which needs a format change) would cost $7.22, so the graph still wins at 1000 turns, but at 50–200 turns a cache-friendly handoff would be about as cheap | [benchmark §7–8](benchmark.md) |
| Nothing lost | Every planted fact recalled, every claim cited | The benchmark builds the graphs itself, so this tests rendering, not AI extraction | [benchmark §2](benchmark.md) |
| Latent layer, measured today | Latency 1,972 ms → 426 ms on the warm prefix; 98–99% of prompt tokens served from cache; the agent receives about 5–9% of the tokens; both gates pass 3/3 | Qwen2.5-7B on a laptop GPU, synthetic codebase | Cycle 6/6b eval log, `leo/latent-read` |
| Quality of process | A second model (Tenki) reviewed every PR: 1 high and 5 medium findings, all fixed; 75+ tests; all built today | — | [eval log](evals.md), PRs #1, #3, #4 |

> Spoken: "The graph is about 4% of the chat at a thousand turns. In our estimates that's about 96% cheaper than handing over the chat, and building the graph pays for itself from the second handoff. And every claim cites its source line, which neither a chat dump nor a summary can do."

## 5. Horizontal (2:25 to 2:45)

This is the core of a wildcard pitch, not an afterthought. Give three verticals in one breath, then the wedge.

> "You just saw two people's agents coordinate. The same layer, unchanged, does code handoffs: Ruslan's Claude Code hands its context to my Codex, and mine reads a small cited graph instead of the whole chat. It does hiring and team-forming, and it works between companies whose agents come from different vendors. Wherever two agents have to trust what the other one knows, and a person has to stay in control, this is the layer. We start with developer teams that already run Claude Code and Codex side by side."

## 6. Ask (2:45 to 2:55)

> "We want teams who run more than one agent vendor to try it on real sessions. Talk to us after."

## Do not say

- **"A new industry standard."** MCP and A2A exist. Say "a layer over MCP". "Horizontal" means it works across vendors and use cases, not that it's a standard.
- **"It does everything."** Horizontal pitches lose judges when they're vague. Always name the first users: developer teams running Claude Code and Codex.
- **"Saves time."** It isn't measured. The only measured timing is M2a's 1,972 ms → 426 ms.
- **"Fast" as the headline.** Human approval is deliberately not fast, and it's the differentiator.
- **SwaT's numbers as ours.** SwaT is published research by others; cite it as related work. Cross-family transfer (M2b) isn't built.
- **Exact token counts.** All token figures are estimates (characters ÷ 4).
- **"Cheaper than a cached chat" as a general claim.** It only holds for very long sessions (1000 turns: $4.72 vs $7.22); at 50–200 turns a cache-friendly handoff would be about as cheap. Today's handoff can't be cached at all, so compare with what exists today.
- **Caching claims for the graph context.** Its stable prefix stays under the 1,024-token cache minimum, unless Ruslan lands the two `src/` fixes (see the [handoff](handoff.md)).
