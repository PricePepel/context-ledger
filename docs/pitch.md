# Context Ledger: three-minute pitch

Written to be spoken. Timings are targets. The thesis is fixed, and the showcase in section 3 can be swapped. Every number traces to [the benchmark report](benchmark.md), [the eval log](evals.md), or the cycle 6 eval log on `leo/latent-read`.

## 1. Problem (0:00 to 0:20)

> Ruslan uses Claude Code. I use Codex. Our agents can't share what they know.
> Today the only way is to paste a whole chat into the other agent. That's huge, nobody can check it, and nobody controls what the agents agree to on our behalf.

## 2. The layer (0:20 to 0:50)

> Context Ledger is a layer over MCP with two parts.
>
> The **text layer is for people**. Each agent turns its session into a small graph of goals, offers, constraints, decisions and open questions. Every claim cites the chat line it came from. When two agents link their graphs, the links are only proposals. **Only the two people can agree.** The server refuses agents that try.
>
> The **latent layer is for machines**. Today, a local open model reads the files once and keeps its memory warm, and other calls reuse it instead of re-reading. Ruslan built and measured this today. Passing that memory between *different* model families is next, and published research (SwaT, arXiv 2610.15095) shows it can work.

## 3. Demo (0:50 to 1:50)

**Default showcase: two people, two agents, one room.** This works for challenge 5, "Your Agent, My Agent".

1. **0:50.** Show the two terminals: Claude Code (Ruslan) and Codex (Ali), both connected to the ledger over MCP. Each agent publishes its person's graph.
   > "Each agent publishes what its person wants, offers and can't do, and cites the line it came from."
2. **1:05.** In the browser, paste both graph IDs and select **Open room**. The proposals appear.
   > "The agents found these matches, a conflict and two answers. They decided nothing."
3. **1:20.** Ali selects **Confirm** on the co-builder match, then Ruslan does.
   > "Agreed only when both of us say yes."
4. **1:30.** Ruslan selects **Reject** on the Sunday conflict.
   > "One no is enough."
5. **1:40.** Reload the page. The decisions are still there.
   > "Stored, not just shown. An agent can't click these buttons."

**If the live run fails:** play `docs/demo/networking-demo.mp4` (61 s, recorded from the real app) and narrate the same five lines.

**Pre-seeded room for a fallback without agents:**
`node .claude/skills/run-context-ledger/driver.mjs seed --url http://127.0.0.1:4317 --story networking`

> **Swappable showcase.** Use one of these openings in place of step 1's line.
>
> - **Challenge 1 + 2, serendipity:** "Your agent knows what you're stuck on. Someone in this room already solved it. We find that coincidence from the evidence in both chats, and introduce you only if you both say yes." Demo sentence: "Out of every pair in the room, these are the three fits nobody would have searched for. Here's ours."
> - **Wildcard, handoff infrastructure:** "Claude Code and Codex can't hand work to each other. We give them a cited, human-approved way to do it, over MCP." Demo sentence: "Ruslan's agent hands its context to mine. Mine reads a small cited graph, not the whole chat."

## 4. Numbers (1:50 to 2:20)

Say each caveat out loud. It costs two seconds and protects you in Q&A.

| Claim | Number | Caveat | Source |
| --- | --- | --- | --- |
| Graph size vs the full handoff | 25.7% at 50 turns, 10.2% at 200, 3.8% at 1000 (characters) | Synthetic sessions | [benchmark §1](benchmark.md) |
| Cost per 1,000 handoffs of a 1000-turn session, Claude Opus 5.5 | $119.36 for today's handoff (it can't be cached), $4.58 to $4.72 for the graph | Estimates (characters ÷ 4) at list prices; about 96% cheaper. Building the graph once pays for itself from the 2nd handoff. A *cache-friendly* handoff (which needs a format change) would cost $7.22, so the graph still wins at 1000 turns, but at 50–200 turns a cache-friendly handoff would be about as cheap | [benchmark §7–8](benchmark.md) |
| Nothing lost | Every planted fact recalled, every claim cited | The benchmark builds the graphs itself, so this tests rendering, not AI extraction | [benchmark §2](benchmark.md) |
| Latent layer, measured today | Latency 1,972 ms → 426 ms on the warm prefix; 98–99% of prompt tokens served from cache; the agent receives about 5–9% of the tokens; both gates pass 3/3 | Qwen2.5-7B on a laptop GPU, synthetic codebase | Cycle 6/6b eval log, `leo/latent-read` |
| Quality of process | A second model (Tenki) reviewed every PR: 1 high and 5 medium findings, all fixed; 75+ tests; all built today | — | [eval log](evals.md), PRs #1, #3, #4 |

> Spoken: "The graph is about 4% of the chat at a thousand turns. In our estimates that's about 96% cheaper than handing over the chat, and building the graph pays for itself from the second handoff. And every claim cites its source line, which neither a chat dump nor a summary can do."

## 5. Horizontal (2:20 to 2:35)

> "The same layer works anywhere two agents have to trust what the other one knows: hiring, team-forming, code handoffs."

## 6. Ask (2:35 to 2:45)

> "We want teams who run more than one agent vendor to try it on real sessions. Talk to us after."

## Do not say

- **"A new industry standard."** MCP and A2A exist. Say "a layer over MCP".
- **"Saves time."** It isn't measured. The only measured timing is M2a's 1,972 ms → 426 ms.
- **"Fast" as the headline.** Human approval is deliberately not fast, and it's the differentiator.
- **SwaT's numbers as ours.** SwaT is published research by others; cite it as related work. Cross-family transfer (M2b) isn't built.
- **Exact token counts.** All token figures are estimates (characters ÷ 4).
- **"Cheaper than a cached chat" as a general claim.** It only holds for very long sessions (1000 turns: $4.72 vs $7.22); at 50–200 turns a cache-friendly handoff would be about as cheap. Today's handoff can't be cached at all, so compare with what exists today.
- **Caching claims for the graph context.** Its stable prefix stays under the 1,024-token cache minimum, unless Ruslan lands the two `src/` fixes (see the [handoff](handoff.md)).
