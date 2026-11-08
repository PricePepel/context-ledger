// Synthetic transcripts for the two-agent demo: Leo works in Claude Code, Ali in Codex.
// Every name, number and plan here is made up. Run `node demo/fixtures.mjs` to rewrite
// the JSONL files next to this module.
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const claudeTurn = (role, content) => JSON.stringify({ type: role, message: { role, content } });
const codexTurn = (role, text) => JSON.stringify({
  type: 'response_item',
  payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] },
});

// Work chatter that a receiving agent has to read past in the raw transcript.
const chatter = [
  ['The slide title font looks heavy on the projector. Can we try something lighter?',
    'Switched the deck to a lighter weight and bumped the line height. The title now fits on one line at 1280 pixels wide, and the speaker notes are unchanged.'],
  ['The room test flaked again on the second run. Look at it before we change anything else.',
    'The flake came from a test that reused the database file between runs. Each run now gets its own temporary folder and the test passed ten times in a row.'],
  ['Remind me what the savings meter actually counts.',
    'It counts UTF-16 code units divided by four for both the full handoff and the graph context, and it labels the numbers as estimates because tokenizers differ by vendor.'],
  ['Is the browser view readable on a small screen?',
    'At 375 pixels the room view stacks the two parties vertically and every button stays reachable. The proposal list scrolls inside its card.'],
  ['Lunch is at 13:00, I will be away for forty minutes.',
    'Noted. I will keep going on the README section while you are away and will not push anything.'],
  ['Can you tidy the README intro? It reads like a spec.',
    'Rewrote the intro as two short paragraphs: what the ledger does and how two agents use it. The command reference moved below.'],
  ['Why does the context put actions last?',
    'Stable sections go first so the prefix stays byte-identical across revisions and providers can cache it. Statuses change often, so actions, blockers and questions come last.'],
  ['The CI run on Linux took eleven minutes. Is that normal?',
    'Most of it is the Playwright browser download. Caching the browser folder would save around six minutes, which is worth doing after the demo.'],
  ['Check the escaping of labels with odd Unicode.',
    'Labels with line separators, bidi controls or control characters are escaped onto one line. I added a test with a right-to-left override and it renders as an escape.'],
  ['What happens if both of us publish the same packet twice?',
    'An exact repeat returns the same graph ID, so nothing is duplicated. A changed packet gets a new ID and needs a new room.'],
  ['The colour of the reject button is too close to the confirm button.',
    'Reject now uses the outline style and confirm the filled style. Both pass the contrast check in light and dark mode.'],
  ['Do we need to mention the latent pool in the demo?',
    'Only as a closing slide. The two-agent room is the main story and the latent pool needs the GPU box, which may not be on stage.'],
  ['The judges get five minutes per team.',
    'Then the live part should take three minutes at most, with a recorded fallback ready if the network or a CLI misbehaves.'],
  ['Can the room survive a page reload?',
    'Yes. The address bar keeps the room ID after the hash sign, so a reload reopens the same room with the same choices.'],
  ['Write down the risks for the demo.',
    'Main risks: a CLI asking for login on stage, the tunnel dropping between laptops, and a model taking longer than expected. Each has a fallback in the run sheet.'],
  ['How long does a publish take?',
    'Under twenty milliseconds on this laptop for a graph with a dozen nodes. Validation and hashing dominate, and the database write is small.'],
];

function leoTranscript(extra = 0) {
  const turns = [];
  const say = (user, assistant) => turns.push(claudeTurn('user', user), claudeTurn('assistant', assistant));
  const filler = index => say(...chatter[index % chatter.length]);

  say('We are demoing Orbit at the hackathon. The goal: the Orbit demo is live by 19:00 on Saturday.',
    'Understood. The goal is the Orbit demo live by 19:00 on Saturday. I will keep a list of decisions as we go.');
  say('Run the ledger on port 4400 for the demo.', 'Decision recorded: the ledger runs on port 4400 for the demo.');
  filler(0); filler(1); filler(2);
  say('Plan to record the demo video on Sunday morning.', 'Added an action: record the demo video on Sunday morning.');
  filler(3); filler(4); filler(5); filler(6);
  say('I can pair with Ali on the MCP adapter, that is my offer to him.',
    'Noted your offer to Ali: you will pair with him on the MCP adapter.');
  filler(7); filler(8);
  say('Port 4400 clashes with Ali\'s Grafana. Change of plan: the ledger stays on port 4317.',
    'Decision updated: the ledger stays on port 4317. This supersedes the earlier choice of port 4400.');
  filler(9); filler(10); filler(11);
  say('Stage Wi-Fi was flaky at the last event. Everything must run on the local laptop, not over stage Wi-Fi.',
    'Constraint recorded: everything runs on the local laptop and nothing depends on stage Wi-Fi.');
  filler(12); filler(13);
  say('Ali said he cannot work on Sunday. Move the recording to Saturday at 17:00.',
    'Moved the action: record the demo video on Saturday at 17:00, two hours before the deadline. The Sunday plan is dropped.');
  filler(14); filler(15); filler(0); filler(3);
  say('One thing I still need from Ali: who owns the GPU box?',
    'Open question for Ali: who owns the GPU box? I will leave it open until he answers.');
  filler(6); filler(9);
  // Appended chatter leaves every line above, and so the reference graph, unchanged.
  for (let index = 0; index < extra; index += 1) filler(index + 1);
  return turns.join('\n');
}

function aliTranscript() {
  return [
    codexTurn('user', 'I can offer two evenings of GPU time on the box for the benchmark.'),
    codexTurn('assistant', 'Noted: you offer two evenings of GPU time for the benchmark.'),
    codexTurn('user', 'I cannot work on Sunday at all.'),
    codexTurn('assistant', 'Constraint noted: no work on Sunday.'),
    codexTurn('user', 'Which port does Leo\'s ledger use? I need it for the Codex config.'),
    codexTurn('assistant', 'That is an open question for Leo: which port does the ledger use?'),
    codexTurn('user', 'I will benchmark the Orbit handoff once the MCP adapter works.'),
    codexTurn('assistant', 'Pending action: benchmark the Orbit handoff after the MCP adapter works.'),
  ].join('\n');
}

export function makeParties(extraChatter = 0) {
  return {
    leo: { provider: 'claude', source: 'leo-orbit.jsonl', transcript: leoTranscript(extraChatter) },
    ali: { provider: 'codex', source: 'ali-orbit.jsonl', transcript: aliTranscript() },
  };
}

export const parties = makeParties();

// What Ali's agent must get right about Leo's context. Two of the answers changed
// during Leo's session, so an agent that stops at the first mention gets them wrong.
export const handoffQuestion = 'Using only Leo\'s shared context, answer with one JSON object and nothing else, with these keys: ' +
  '"port" (number: the port the ledger runs on), "deadline" (when the demo must be live), ' +
  '"recordingSlot" (when the demo video is recorded), "leoPairsOn" (what Leo offers to pair on), ' +
  '"questionForAli" (what Leo still needs Ali to answer), "network" (where the demo runs).';

// The first port-like number decides, so "4317 (was 4400)" passes and "4400" fails.
const firstPort = value => Number(String(value).match(/\b\d{4,5}\b/u)?.[0]);
const checks = {
  port: value => firstPort(value) === 4317,
  deadline: value => /19[:.]?00|7\s*pm/i.test(value) && /sat/i.test(value),
  recordingSlot: value => /17[:.]?00|5\s*pm/i.test(value) && /sat/i.test(value),
  leoPairsOn: value => /mcp/i.test(value),
  questionForAli: value => /gpu/i.test(value) && /own/i.test(value),
  network: value => /local|laptop/i.test(value) && !/\bnot\b[^.]*\blocal/i.test(value),
};

/** The outermost JSON object in a reply, even with prose or other braces around it. */
function findObject(text) {
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    for (let end = text.lastIndexOf('}'); end > start; end = text.lastIndexOf('}', end - 1)) {
      try {
        const value = JSON.parse(text.slice(start, end + 1));
        if (value && typeof value === 'object' && !Array.isArray(value)) return value;
      } catch {
        // Try a shorter span.
      }
    }
  }
  return {};
}

/** Grade an agent's reply: find the JSON object and check each key. */
export function gradeHandoff(reply) {
  const answer = findObject(String(reply));
  const results = Object.fromEntries(Object.entries(checks).map(([key, check]) => [key, answer[key] !== undefined && check(String(answer[key]))]));
  return { score: Object.values(results).filter(Boolean).length, total: Object.keys(checks).length, results, answer };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const { source, transcript } of Object.values(parties)) {
    await writeFile(new URL(source, import.meta.url), transcript + '\n');
    console.log(`wrote demo/${source} (${transcript.split('\n').length} lines, ${transcript.length} characters)`);
  }
}
