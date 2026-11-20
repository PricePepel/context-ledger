# The 60-second CTM demo: shot list and voice-over

*Card U3, 2026-11-17, revised after review. Everything shown is synthetic: the Orbit demo transcripts in `demo/` and the console's bundled recording.*

## What is ready and what a person does

- **Raw console footage:** `node demo/record-console.mjs` records it. The script starts a ledger on a throwaway database and lets the page load only the console's own files. It plays `/console/?demo` at 1.3× speed, opens the proof of one decision, and shows the numbers. It saves `console-demo-<time>.webm` (1280×720, about 44 s) and `console-demo-<time>.cues.json` in `test-results/u3/`, and touches no other file there. The footage is not committed: record it again from the branch you edit on.
- **The cue sheet** gives the second at which each moment happens: `play`, `firstLink`, `answerLink`, `finished`, `proofOpen`, `numbers` and `end`. The times are measured from page load and can run a second or two ahead of the video, so check them in the editor. One take on Windows: play 1.8, answer link 22.2, finished 28.1, proof open 29.7, numbers 38.8, end 45.8.
- **A person** records the terminal shot and the voice-over, then cuts the pieces to the shots below. That needs a microphone and a screen recorder.

## The terminal shot, without anything real on screen

Record it in a throwaway user account or a virtual machine. Then:

- No other ledger database is on the machine, and `CONTEXT_LEDGER_DB` is not set.
- Claude Code and Codex hold only demo settings.
- The shell history is empty, and the paths are short synthetic ones, such as `~/ctm-demo`.
- Only the synthetic `demo/` transcripts get imported.

## Shots

| Time | Shot | On screen | Voice-over |
| --- | --- | --- | --- |
| 0:00–0:05 | Title | "CTM", and the line "They move conversations. We move evidence." Pip once U2 is merged. | "Two coding agents, one project, and no memory between them." |
| 0:05–0:15 | Terminal | `npm start`, then the setup. After G8: `npm run ledger -- install`. Before it: the `claude mcp add` command and the Codex `config.toml` lines from the README. | After G8: "CTM is a ledger on your own machine. One command connects Claude Code and Codex to it." Before G8: "CTM is a ledger on your own machine. Claude Code and Codex connect to it over MCP." |
| 0:15–0:42 | Console footage, from cue `play` to cue `finished` (about 26 s) | The empty office, then Leo's Claude Code and Ali's Codex publish. Their cards pop into the ledger, and dashed lines join Ali's question to Leo's answer at cue `answerLink`. | "In this replay, both agents publish what they decided, citing their transcripts. Ali asks which port the ledger uses, and Leo's decision answers." |
| 0:42–0:54 | Console footage, from just before cue `proofOpen` to cue `numbers` (about 10 s; hold the last frame) | A click on "The ledger stays on port 4317" opens the proof, with lines L27 and L28 highlighted | "One click shows the proof: the exact lines where the plan changed." |
| 0:54–1:00 | Console footage, from cue `numbers` to cue `end` | Hand-offs today and tokens saved, which the console labels as an estimate | "The ledger stays on your machine. Agents get cited context." |

## Rules for the cut

- Keep the console's label "estimate" visible whenever the tokens-saved number is on screen, and say no figure the console does not show.
- Use only the synthetic demo. Never record a real transcript, a real home folder or a real terminal history.
- The voice-over is about 95 words, at most 2.5 words a second in any shot, so it is easy to follow.
- Captions: burn in the voice-over text, so the video works with the sound off.
