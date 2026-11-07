# Context Ledger: deck brief and image prompts

Everything needed to build the presentation in another tool (ChatGPT, Gamma, Canva, Keynote). Product content only. Every number has its caveat beside it: keep them together.

---

## Part 1. Image-generator prompts

Image generators garble text, so every prompt asks for **no text, letters or logos**. Add the words yourself in the deck. The style line keeps all images consistent, so paste it into every prompt.

**Style line (use in every prompt):**
> Minimal editorial illustration, strictly black and white with soft greys (#0F0F0F, #FFFFFF, #F5F5F7), lots of white space, fine thin lines, subtle paper grain, calm and premium, like a design-led AI company. No color, no gradients, no text, no letters, no numbers, no logos, no UI chrome. 16:9.

**1. Cover hero: two agents, one trusted bridge**
> Two abstract geometric figures, one built from circles and one from squares, standing on opposite sides of a narrow gap. Between them, a single thin bridge made of small connected nodes, like a ledger of linked dots. A small human hand rests on the middle of the bridge, as if approving it. Centered composition, generous empty space above for a title. [style line]

**2. The problem: a wall of pasted chat**
> One abstract figure pushing an enormous, towering, messy stack of paper scrolls toward another small figure, who is buried under it. The scrolls are blank, with only faint grey lines suggesting text. Overwhelming scale, slightly humorous. [style line]

**3. Text layer: a cited graph**
> A clean network graph of about eight nodes of different shapes (circle, square, diamond, triangle) joined by thin lines. From each node, a fine dotted thread runs down to a specific line on a long, faint document page below, like footnotes anchoring every claim to its source. Precise and architectural. [style line]

**4. Latent layer: read once, reuse many times**
> A single glowing (in white) abstract brain or lens shape that has absorbed a stack of pages, with four thin beams going out from it to four small identical figures that each receive one small card. The pages are read once; the cards are small. Calm, technical, symmetrical. [style line]

**5. Only people agree**
> Two human hands from opposite sides of the frame each pressing a simple round button at the same time. Two small abstract robot or agent shapes stand behind the buttons, unable to reach them, held back by a thin line. Clear, symbolic. [style line]

**6. Horizontal: one layer, many pairs**
> A single thin horizontal band running across the whole image. Above and below it, four different pairs of abstract figures (two code brackets, two people shaking hands, a briefcase and a person, two buildings) each connected to the band by a thin vertical line. Evenly spaced, diagram-like. [style line]

**7. Closing: local and private**
> A small, solid black cube sitting on a desk next to a laptop, with a few thin lines connecting it only to the laptop and nothing else: no cloud, no outside connections. Quiet, secure feeling. [style line]

---

## Part 2. Deck brief (paste into the deck tool)

### Brand and design

- **Colors:** black and white only. Near-black `#0F0F0F`, white `#FFFFFF`, soft grey panels `#F5F5F7`, secondary text `#666666`, lines `#E6E6E6`. No accent colors.
- **Font:** Montserrat throughout (Google Fonts). Headings semibold (600), big numbers and the title bold (700), body text regular (400), small uppercase labels medium (500) with wide letter spacing. Italics in headings for emphasis on one or two words.
- **Feel:** editorial, calm, lots of white space, rounded grey cards, big serif numbers. One idea per slide. Alternate white slides with a few black statement slides.
- **Do not use:** the Expedite name or logo. This is our product, styled in that look.

### What the product is (one paragraph)

Context Ledger is the trust layer between any two AI agents. Today, when one person's agent (say Claude Code) has to share what it knows with another person's agent (say Codex), the only way is to paste the whole chat: huge, impossible to check, and nobody controls what the agents agree to. Context Ledger replaces that with a small graph in which every claim cites the exact chat line it came from. The agents can propose links between their graphs, but only the two people can agree. It works across vendors over MCP (Model Context Protocol), runs locally, and has a second, machine-side layer that lets a local model read files once and serve many questions from that memory.

**Tagline:** The trust layer between *any* two agents.
**Sub-line:** Cited, cross-vendor, human-approved, over MCP.

### Slide-by-slide content (10 slides, about 3 minutes)

**1. Cover**
- Title: Context Ledger
- Line: The trust layer between *any* two agents.
- Sub-line: Cited, cross-vendor, human-approved, over MCP.
- Image: prompt 1.

**2. The problem** (0:00–0:20)
- Heading: Every team runs agents from more than one vendor, and they *can't share* what they know.
- Three cards:
  - **Huge.** The only bridge today is pasting the whole chat into the other agent.
  - **Uncheckable.** Nobody can tell which claim came from where.
  - **Uncontrolled.** Nobody controls what agents agree to on our behalf.
- Image: prompt 2.
- Say: "One person uses Claude Code, the other uses Codex. Their agents can't share what they know. Today the only bridge is pasting a whole chat. It's huge, nobody can check it, and nobody controls what the agents agree to on our behalf."

**3. The layer** (0:20–0:55)
- Heading: A layer over MCP that *any* two agents can share.
- Card 1, for people (built): **Text layer: cited graphs.** Each agent turns its session into goals, offers, constraints, decisions and questions. Every claim cites its chat line. Links between agents are proposals; only the two people agree.
- Card 2, for machines (first version built): **Latent layer: warm memory.** A local open model reads the files once and keeps its memory warm; other calls reuse it. Only a small, quote-checked slice reaches the closed model.
- Images: prompts 3 and 4.

**4. How it works** (optional, keep if time allows)
- Heading: From a chat to a decision *both people* own.
- Five steps with arrows:
  1. **Import:** each person picks their Claude Code or Codex transcript.
  2. **Publish:** the agent writes a cited graph and publishes it over MCP.
  3. **Check:** the ledger refuses citations that point at no real line.
  4. **Propose:** agents link the two graphs as matches, conflicts and answers.
  5. **Decide:** only people confirm, in the browser.

**5. Live demo** (0:55–1:55)
- Heading: Two people, two vendors, *one room*.
- Screenshot: the negotiation room after the decisions (`docs/demo/networking-room-decided.png`).
- Five beats:
  1. Each agent publishes its person's cited graph.
  2. Open the room: the agents proposed links. They decided nothing.
  3. Both people confirm a match: agreed.
  4. One person rejects a conflict: one no is enough.
  5. Reload: the decisions are stored. Agents can't click.
- Backup: the 61-second video `docs/demo/networking-demo.mp4`.

**6. Statement slide (black)**
- Heading: Agents propose. *Only people agree.*
- Line: A decision is recorded only from a same-origin browser request. The command line and the MCP tools can't confirm anything.
- Image: prompt 5.

**7. Numbers: text layer** (1:55–2:25)
- Heading: Smaller, cheaper, and every claim *cited*.
- **3.8%**: the graph's size compared with the full chat for a 1,000-turn session (10.2% at 200 turns, 25.7% at 50).
- **$4.72 vs $119.36**: cost per 1,000 handoffs of a 1,000-turn session on Claude Opus 5.5. About 96% cheaper.
- **2nd handoff**: building the graph has already paid for itself.
- **Every planted fact recalled, every claim cited** (in the benchmark).
- Footer caveat (keep it on the slide): estimates (characters ÷ 4) on synthetic sessions, at list prices. A cache-friendly chat handoff would cost $7.22, so at 50–200 turns it would be about as cheap.

**8. Numbers: latent layer, measured**
- Heading: One model reads once; *every call reuses it*.
- **426 ms**: down from 1,972 ms on the warm prefix.
- **98–99%**: of prompt tokens served from cache.
- **5–9%**: of the tokens reach the closed model.
- **3 / 3**: quality gates passed, with quotes verified against the cited lines.
- Footer caveat: measured with Qwen2.5-7B on a laptop GPU, on a synthetic codebase.

**9. Horizontal** (2:25–2:45)
- Heading: Wherever two agents must trust what the other knows, *and a person stays in control*.
- Four cards:
  - **Code handoffs (first users):** Claude Code hands its context to Codex as a small cited graph.
  - **Team-forming (the demo):** two people's agents find matches and conflicts.
  - **Hiring (next):** candidate and recruiter agents, with cited claims.
  - **Across companies (next):** agents from different vendors, people approve.
- Image: prompt 6.
- Say: "The same layer, unchanged, does code handoffs, team-forming, hiring, and works between companies whose agents come from different vendors. We start with developer teams that already run Claude Code and Codex side by side."

**10. Run it / close** (2:45–2:55)
- Heading: Local, open, *one command*.
- **Start the ledger:** `npm ci` then `npm start`. Runs on your machine only; transcripts never leave it.
- **Connect any agent:** `claude mcp add context-ledger -- node /path/to/src/mcp.mjs`. Codex connects through the same MCP server.
- **Six MCP tools:** graph_publish, graph_read, context_for, room_open, room_read, graph_schema. None of them can confirm a decision.
- Close: "We want teams who run more than one agent vendor to try it on real sessions."
- Image: prompt 7.

### Facts the deck may use

- **Node kinds:** goal, offer, constraint, decision, action, blocker, question.
- **Links between two people's graphs:** matches, conflicts, answers.
- **Rooms:** a proposal is agreed only when both people confirm, rejected when either rejects, and decisions survive a reload.
- **Security:**
  - runs on the local machine only (loopback) and checks Host and Origin;
  - labels are shown as plain text;
  - transcripts are imported only when a person picks the file.
- **Latent layer checks:** every quote must appear in the lines it cites; lines that try to instruct an AI are flagged; the free-text answer is marked unverified.

### Never say

- **"A new industry standard."** Say "a layer over MCP".
- **"It does everything."** Always name the first users: developer teams running Claude Code and Codex.
- **"Saves time"** as a claim. Only the latent layer's 1,972 → 426 ms is measured.
- **Exact token counts.** Every token figure is an estimate (characters ÷ 4).
- **"Cheaper than a cached chat"** in general. It holds only for very long sessions.
- **Passing memory between different model families as built.** It is the next step.

### Likely judge questions (short answers)

1. **Why not a summary?** A summary can't be checked and drops where each claim came from. Every node in our graph cites its exact line.
2. **Can an agent fake a confirmation?** Decisions need a same-origin browser request; the command line and MCP tools can't record them. Names are self-declared today; signing is next.
3. **The numbers are synthetic?** Yes, so anyone can reproduce them with no private data. A local script measures real sessions and reports totals only, never transcript text.
4. **Building the graph costs tokens too?** Yes. It pays for itself from the second handoff, and every handoff after that is about 90% (200 turns) to 96% (1,000 turns) cheaper (estimates).
5. **How is this different from MCP or A2A?** We're a layer over MCP. A2A moves messages; we move cited, human-approved state.
6. **Why won't the big labs build this?** Each will build sharing inside its own ecosystem. Neither has a reason to build a neutral bridge into the other's agents.
7. **Prompt injection?** Every quote must appear in its cited lines and instruction-like lines are flagged. In the injection test the hijacked finding was dropped 3 of 3 times.
8. **Privacy?** Everything runs locally, files are imported only when chosen, and the latent model runs on your own GPU.
9. **"Horizontal" sounds too broad: who first?** Developer teams that run Claude Code and Codex side by side and hand work between them.

---

## Part 3. Style prompts for other tools

### For presentation tools (ChatGPT, Gamma, Canva, Claude, Keynote)

```
Design this presentation in the following exact style. Follow every rule.

CANVAS: 16:9, 1920×1080. Margins 128px on all sides. One idea per slide.

COLORS (no others, no gradients, no accent colors):
- Near-black #0F0F0F: headings and text on light slides; background of statement slides
- White #FFFFFF: main slide background; text on dark slides
- Soft grey #F5F5F7: card and panel backgrounds on white slides
- Mid grey #666666: body text and small labels on light backgrounds
- Light grey #B3B3B3: body text on black backgrounds
- Label grey #8C8C8C: small labels on black backgrounds
- Hairline #E6E6E6: thin dividers, if any
Rhythm: mostly white slides, with 3 black statement slides (cover, one key claim, closing).

FONT: Montserrat only (Google Fonts).
- Title: 128px, bold 700
- Slide headings: 72px, semibold 600, line-height 1.1, sentence case. Italicize 1–3 key words in the heading for emphasis.
- Big numbers/stats: 96px (or 64px in 4-column rows), bold 700
- Card titles: 44px, semibold 600
- Body text: 28–32px, regular 400, line-height 1.4, in mid grey
- Eyebrow label above each heading: 24px, medium 500, UPPERCASE, letter-spacing 4px, mid grey
- Footnotes/caveats: 24px, mid grey, pinned at the bottom of the slide
Never go below 24px.

LAYOUT:
- Every content slide: eyebrow label at top left, heading below it, then content. Headings left-aligned and never centered on content slides.
- Content sits in rounded cards: background #F5F5F7, corner radius 20px, padding 40px, no borders, no shadows, 24px gaps.
- Highlight exactly one card per row by making it black (#0F0F0F) with white title and light grey text.
- Prefer 2–4 cards in a row, big-number stat cards, or a 5-step row joined by thin black arrows over bullet lists.
- Statement slides: black background, one large heading (96–120px) with an italic phrase, one short grey line under it, lots of empty space.
- Code or commands: monospace (Courier New) in grey on a slightly lighter black card (#1C1C1C).

FEEL: minimal, editorial, calm, premium, a lot of white space. Like a design-led AI company. No icons, no clip art, no emoji, no stock photos, no drop shadows, no decorative shapes.
```

### For image generators (ChatGPT images, Midjourney, Ideogram)

```
Minimal editorial illustration, strictly black and white with soft greys (#0F0F0F near-black, #FFFFFF white, #F5F5F7 soft grey). Generous white space, fine thin lines, simple geometric forms (circles, squares, nodes and connecting lines), subtle paper grain, flat with no 3D rendering and no shadows. Calm, premium, design-led, like an illustration for a modern AI company's website. No color, no gradients, no text, no letters, no numbers, no logos, no UI elements. Centered composition with empty space for a slide heading. 16:9.

Subject: [describe the scene here; Part 1 has one per slide]
```
