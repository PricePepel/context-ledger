# CTM Console: what it does

The console is one page in the local app. Open it with `npm start`, then go to <http://127.0.0.1:4317/console/>. It shows which agents are working, what they put into the ledger, and the transcript line that proves each fact. It only reads: it never runs agents and never changes the ledger.

| Feature | In your words | Where |
| --- | --- | --- |
| Agents office | "Who is working right now?" A furnished pixel office with one room for Claude Code (wood floor) and one for Codex (tiled floor): six desks with monitors and chairs, bookshelves, plants, windows with daylight, ceiling lamps, a whiteboard, a kitchen with a water cooler, and a lounge. Each agent that published today is a pixel character: Clawd for Claude Code, a blue cloud bot for Codex. It sits at its desk with the monitor lit while **working** (it published in the last minute), stands beside its desk with a question mark while **waiting** (it asked another agent something nobody has answered), and relaxes in the lounge when **idle**. The state is written under each agent too. | Top |
| Agent roles | "What kind of agent is that?" An agent whose name says its job gets a prop: a notebook for a planner, a hard hat for a builder, a flask for a tester, glasses (a magnifier on Codex) for a reviewer, a pencil for a writer, a safari hat for a scout. | On each agent |
| Logo | The CTM logo in the header and as the browser tab icon. Pip stands in until the logo file arrives. | Header |
| Ledger graph | "What do they know?" Every fact the agents published: goals, constraints, decisions, offers, actions and questions, one column per agent. New facts pop in as they are published. A decision that was later replaced is struck through. A question shows whether it is still open or already answered. | Centre |
| Quoted or inferred | "Can I trust this fact?" Each fact says **quoted** when the lines it cites hold what it claims, and **inferred** when they do not, so you know which ones to open first. Facts published before the ledger checked this say neither. | On each fact |
| Flash lines | "Who wrote that?" When an agent publishes, a short line flashes from its room to each fact it added or changed. A dashed line shows which of another agent's facts it linked to, so you can see one agent reading another's work. | Over the page |
| Lines between facts | "How do they connect?" Grey lines join facts inside one agent's graph (this action advances that goal, this decision replaces that one). Dashed purple lines join facts across agents (this offer matches that need, this decision answers that question). | Centre |
| One-click proof | "Prove it." Click any fact (or press Enter on it) and the evidence panel shows the transcript turns it cites, with the cited lines highlighted, the line numbers and the source file. Hidden characters in a transcript are shown as escapes, so the proof cannot be disguised. A message one Codex agent sent another says who sent it, such as "Agent /root/worker to /root". | Right |
| Activity | "What just happened?" A running list such as "leo (Claude Code) published: 2 new" and "ali linked to 2 nodes of leo". | Right, under the evidence |
| Hand-offs today | How many graphs agents published today. Each one is a packet another agent can pick up instead of rereading a transcript. | Bottom |
| Tokens saved (estimate) | Roughly how many tokens an agent saves by reading each current graph instead of its whole transcript, using the ledger's meter (characters divided by four). It is an estimate, and labelled as one. | Bottom |
| Superseded decisions | How many decisions were replaced by a later one, so nobody acts on a stale answer. | Bottom |
| Live updates | The page checks the ledger every 2 seconds, so a new publish shows up by itself. | Whole page |
| Demo mode | "Show me without my data." Open <http://127.0.0.1:4317/console/?demo> to watch a made-up 34-second session: Leo plans a hackathon demo in Claude Code, Ali answers from Codex, and their graphs link up. **Replay demo** starts it again. Add `&speed=2` to play it faster. | Whole page |
| Phone | On a narrow screen the parts stack in one column. | Whole page |
| Back to the library | The **Library** button returns to the transcript library; the library has a **Console** link back. | Header |

Not in v0: the quoted or inferred colours (they appear by themselves once card G7 marks nodes), approving or editing facts (card P3), a graph diff between versions (card G11), a brand and mascot (card U2), and other MCP clients' rooms (the ledger imports Claude Code and Codex transcripts only).
