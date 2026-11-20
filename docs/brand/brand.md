# CTM brand: palette, type and Pip

*Card U2, 2026-11-17, revised after review. For the console (U1), the demo video (U3) and anything else people see. It builds on the CTM site's brand rather than starting a second one.*

## Name and words

- **CTM** is the product. **Context Ledger** is the name of this repository and of the MCP server (`context-ledger`); use it when talking about the local tool itself.
- Write short, plain sentences. Say what a thing does and what it cannot do.
- **Savings claims.** Use the measured figure together with its comparison, as [BENCHMARKS.md](../../BENCHMARKS.md) and the eval log state them: which handoff, against what, on which data. Never turn a smaller handoff into "cheaper".
- **Line for the console and video:** "they move conversations, we move evidence".

## Palette

The brand colours are the CTM site's, from its `src/styles/tokens.css`:

- **Deep Charcoal** `#18181c`
- **Electric Violet** `#723bfa`
- **Acid Lime** `#b9f500`
- **Paper** `#f4f3f7`, the light ground
- **Soft Violet** `#9e7bff`, for violet text on Charcoal

[tokens.css](tokens.css) holds them as CSS custom properties, in a light set for the console and a dark set matching the site. The dark set sets every text, fill and button variable again, so nothing light is inherited by mistake.

| Pair | Light (console) | Dark (site, video) |
| --- | --- | --- |
| Text on background | Charcoal on Paper, 16.0:1 | Paper on Charcoal, 16.0:1 |
| Secondary text on background | `#56535e` on Paper, 6.8:1 | `#b7b4c0` on Charcoal, 8.7:1 |
| Link on background | Violet, 5.1:1 | Soft Violet, 5.7:1 |
| Link hover on background | `#5b2bd4`, 6.9:1 | `#b9a2ff`, 8.2:1 |
| Button text on button fill | White on Violet, 5.6:1 | Charcoal on Soft Violet, 5.7:1 |
| Button text on hover fill | White on `#5b2bd4`, 7.7:1 | Charcoal on `#b9a2ff`, 8.2:1 |
| Quoted mark on its fill | `#1b6e46` on `#e3f4ea`, 5.5:1 | `#7ccf8f` on `#1d3a2a`, 6.6:1 |
| Inferred mark on its fill | `#8a4f00` on `#fbeed9`, 5.7:1 | `#f2b049` on `#3d2c12`, 7.1:1 |

[The test](../../tests/brand.test.mjs) checks every pair in this table in both sets, and the text pairs on the surface colour too.

**Lime is for fills and decoration only.** White on lime is 1.3:1, so lime never sits under white text, which is the site's own rule. Charcoal on lime is 13.6:1. Pip's lime spark is 1.2:1 against Paper, so it is decoration and never carries meaning.

## States never rely on colour

The console shows two kinds of state. Each has its colour and a word, at every size.

| State | Colour (light, dark) | Always shown with |
| --- | --- | --- |
| Quoted node (G7) | `#1b6e46`, `#7ccf8f` | the word "quoted" |
| Inferred node (G7) | `#8a4f00`, `#f2b049` | the word "inferred" |
| Agent working | Violet, Soft Violet | the word "Working", and Pip's working pose where Pip is shown |
| Agent waiting | `#8a4f00`, `#f2b049` | the word "Waiting", and Pip's waiting pose |
| Agent idle | `#56535e`, `#b7b4c0` | the word "Idle", and Pip's idle pose |

The poses are an extra cue, not the only one: at small sizes they lose detail, and the word stays.

## Type

- **Inter Tight**, the site's typeface, for headings and text where it is available.
- The console has no build step, and its content security policy loads nothing from outside, so it does not fetch web fonts. Its stack, `--ctm-font-sans`, falls back to the system sans serif: Inter Tight if installed, then Inter, then the system font.
- Code, IDs and cited line numbers (`L26`) use the system monospace stack, `--ctm-font-mono`.

## Pip

Pip keeps the ledger. It is an index card in Electric Violet, with a folded corner and ruled lines, the lime spark of the CTM mark above it, and a citation tag in hand. It is original to CTM.

| Idle | Working | Waiting |
| --- | --- | --- |
| ![Pip idle](pip.svg) | ![Pip working](pip-working.svg) | ![Pip waiting](pip-waiting.svg) |
| Eyes open, holding up a citation tag | Eyes on the tag it holds, reading it; the spark bright | Eyes up at a question bubble, the tag held low; the spark dimmed |

- **Where it goes.** One Pip per agent in the console's office, in the pose of that agent's state, next to the state word. It replaces U1's placeholder figure. Pip also appears in the video's opening and closing frames, and in the site's empty states.
- **Keep** the card shape with its folded corner, the violet, the lime spark and the tag. Pip works on Paper and on Charcoal without changes.
- **Do not:**
  - give Pip a round body with a pale belly, or a stalk on its head (that drifts toward existing characters);
  - make it an animal, or use Capy's capybara or manga styling. Capy's look is theirs; the console direction takes only its warmth.
  - recolour or stretch it.
  - At 24 px or smaller, use the CTM mark instead, with the state word.
- **Colours** are the brand palette (Soft Violet for the folded corner and ruled lines) and White as a neutral, plus two illustration colours: `#5b2bd4` for the feet and arms and `#8a4f00` for the question mark.

### Putting Pip in a page

Pip is plain SVG, about 2 KB per pose. It uses presentation attributes only (`fill`, `stroke`), with no `<style>` element or `style` attribute, no scripts and no outside resources.

- **Inline it.** The console's content security policy (`default-src 'none'; script-src 'self'; style-src 'self'`) has no `img-src`, so the browser would block Pip loaded through `<img>` or a CSS background. Put the SVG markup in the page, or build it with `createElementNS`, as U1's office module already does for its figures.
- **Name it once.** Each file names itself with `aria-label` on the `<svg>`, so several inlined Pips have no ID to clash. Where the state word is visible next to Pip, hide Pip from assistive technology (`aria-hidden="true"`), because the word already says it.
- **As image files instead**, a page needs a route that serves them as `image/svg+xml`, `img-src 'self'` in its policy, and a browser test against the real response headers.

## What this card does not do

- **Put Pip into the console.** U1 (PR #22) is in review, and its office module draws the figures. Once U1 is merged, a small follow-up in U1's files swaps the placeholder for these poses, inlined, next to the state words.
- **Change the logo.** The CTM mark stays as the site has it.
- **Sign off on Pip's look.** A person on the team does, after seeing it side by side with well-known characters with a similar build.
