// Demo storyline for the hackathon (wildcard track, horizontal layer): two attendees'
// agents network on their behalf, one vertical of the cross-vendor layer. Synthetic: seeded filler chatter plus hand-written facts,
// so every proposal in the room reads as a real match, conflict or answer.
import { deriveSeed, prng } from '../bench/synth.mjs';

export const people = {
  ali: { provider: 'codex', source: 'ali-hackathon-networking.jsonl', other: 'ruslan' },
  ruslan: { provider: 'claude', source: 'ruslan-hackathon-networking.jsonl', other: 'ali' },
};

// What each person said to their own agent. `say` is the sentence planted in the transcript;
// `label` is what the agent publishes. Ali publishes first; ruslan's agent links to ali.
const facts = {
  ali: [
    { id: 'find-cobuilder', kind: 'goal', label: 'Find a technical co-builder for the HackerHouse residency interview', say: 'My real goal today: find a technical co-builder for the HackerHouse residency interview.' },
    { id: 'demo-by-six', kind: 'goal', label: 'Ship a working agent demo by 18:00 today', say: 'We need a working agent demo on stage by 18:00 today.' },
    { id: 'run-pitch', kind: 'offer', label: 'I run the three-minute pitch and the judge Q&A', say: 'I can run the three-minute pitch and handle the judge Q&A.' },
    { id: 'founder-intros', kind: 'offer', label: 'Intros to five founders who want agent tooling', say: 'I can introduce five founders who want agent tooling.' },
    { id: 'leave-by-seven', kind: 'constraint', label: 'I have to leave by 19:00 tonight', say: 'Hard stop for me: I have to leave by 19:00 tonight.' },
    { id: 'wildcard-track', kind: 'decision', label: 'Enter the wildcard track as a horizontal agent layer', say: 'Decided: we enter the wildcard track as a horizontal agent layer.' },
    { id: 'book-slot', kind: 'action', status: 'pending', label: "Book the judges' demo slot", say: "Next step: book the judges' demo slot." },
    { id: 'record-video-sunday', kind: 'action', status: 'pending', label: 'Record the backup demo video on Sunday', say: 'Plan: record the backup demo video on Sunday.' },
    { id: 'who-owns-mcp', kind: 'question', status: 'open', to: 'ruslan', label: 'Who owns the MCP integration?', say: 'Question for ruslan: who owns the MCP integration?' },
    { id: 'which-slot', kind: 'question', status: 'open', to: 'ruslan', label: 'Which demo slot should we take?', say: 'Question for ruslan: which demo slot should we take?' },
  ],
  ruslan: [
    { id: 'win-live-demo', kind: 'goal', label: 'Win with a live two-agent demo', say: 'Goal: win this with a live two-agent demo.' },
    { id: 'real-users', kind: 'goal', label: 'Get the first real users for Context Ledger', say: 'I also want the first real users for Context Ledger.' },
    { id: 'build-mcp', kind: 'offer', label: 'I build the MCP adapter and the live demo', say: 'I can build the MCP adapter and the live demo.' },
    { id: 'pitch-numbers', kind: 'offer', label: 'Pair on the benchmark numbers for the pitch', say: 'Happy to pair on the benchmark numbers for the pitch.' },
    { id: 'no-solo-stage', kind: 'constraint', label: 'I will not present on stage alone', say: 'I will not present on stage alone.' },
    { id: 'away-sunday', kind: 'constraint', label: 'Away all of Sunday', say: 'I am away all of Sunday.' },
    { id: 'i-own-mcp', kind: 'decision', label: 'I own the MCP integration', say: 'Decided: I own the MCP integration.' },
    { id: 'take-1730', kind: 'decision', label: 'Take the 17:30 demo slot', say: 'Decided: we take the 17:30 demo slot.' },
    { id: 'rehearse', kind: 'action', status: 'pending', label: 'Rehearse the two-person demo at 17:00', say: 'Next: rehearse the two-person demo at 17:00.' },
    { id: 'judge-form', kind: 'question', status: 'open', to: 'ali', label: 'Can you get the judging form before 17:00?', say: 'Question for ali: can you get the judging form before 17:00?' },
  ],
};

// Ruslan's agent proposes these links to ali's graph. Reviewed by hand: each reads sensibly.
export const links = [
  { from: 'build-mcp', to: 'find-cobuilder', type: 'matches' },
  { from: 'win-live-demo', to: 'demo-by-six', type: 'matches' },
  { from: 'pitch-numbers', to: 'run-pitch', type: 'matches' },
  { from: 'real-users', to: 'founder-intros', type: 'matches' },
  { from: 'away-sunday', to: 'record-video-sunday', type: 'conflicts' },
  { from: 'i-own-mcp', to: 'who-owns-mcp', type: 'answers' },
  { from: 'take-1730', to: 'which-slot', type: 'answers' },
];

const edges = {
  ali: [
    { from: 'book-slot', to: 'demo-by-six', type: 'advances' },
    { from: 'record-video-sunday', to: 'demo-by-six', type: 'advances' },
  ],
  ruslan: [{ from: 'rehearse', to: 'win-live-demo', type: 'advances' }],
};

const topics = ['the MCP adapter', 'the demo laptop', 'the venue Wi-Fi', 'the judging rubric', 'the room UI', 'the benchmark',
  'lunch', 'the slide deck', 'the sponsor table', 'the residency interview', 'the token meter', 'the team channel'];
const userFiller = [t => `Can you check ${t} for me?`, t => `What is the status of ${t}?`, t => `Quick note on ${t} before I forget.`,
  t => `Remind me what we said about ${t}.`, t => `Someone asked me about ${t}, any thoughts?`];
const agentFiller = [t => `I looked at ${t}; nothing blocking right now.`, t => `Noted on ${t}. I will keep it in the shared notes.`,
  t => `Summary of ${t}: still on track for the afternoon.`, t => `I checked ${t} again and updated the list.`];

const claudeRecord = (role, text, index) => ({
  type: role,
  timestamp: new Date(Date.UTC(2026, 10, 7, 17, 0, index * 20)).toISOString(),
  message: { role, content: role === 'user' ? text : [{ type: 'text', text }] },
});
const codexRecord = (role, text) => ({
  type: 'response_item',
  payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] },
});

/** One person's transcript of `turns` turns, with their facts said by them at spread-out user turns. */
export function transcriptFor(name, turns, seed) {
  if (!Number.isInteger(turns) || turns < facts[name].length * 2) {
    throw new RangeError(`The networking story needs at least ${facts[name].length * 2} turns.`);
  }
  const person = people[name];
  const rng = prng(deriveSeed(seed, name === 'ali' ? 11 : 12));
  const list = facts[name];
  // Facts land on user turns (even indexes), spread evenly through the session.
  const slots = new Map(list.map((fact, index) => [2 * Math.floor(((index + 0.5) * turns) / (2 * list.length)), fact]));
  const records = [];
  if (person.provider === 'codex') {
    records.push({ type: 'session_meta', payload: { id: 'synthetic-session', cwd: '/synthetic/hackathon', originator: 'codex_cli' } });
    records.push(codexRecord('user', '<environment_context>\n  <cwd>/synthetic/hackathon</cwd>\n</environment_context>'));
  }
  const lines = new Map();
  for (let turn = 0; turn < turns; turn += 1) {
    const role = turn % 2 === 0 ? 'user' : 'assistant';
    const fact = slots.get(turn);
    const text = fact ? fact.say : rng.pick(role === 'user' ? userFiller : agentFiller)(rng.pick(topics));
    records.push(person.provider === 'claude' ? claudeRecord(role, text, turn) : codexRecord(role, text));
    if (fact) lines.set(fact.id, records.length);
  }
  return {
    provider: person.provider,
    source: person.source,
    transcript: records.map(record => JSON.stringify(record)).join('\n'),
    lines,
  };
}

/** The v2 packet one person's agent publishes. Ruslan's links to ali's graph. */
export function packetFor(name, sessionId, lines, aliGraphId) {
  const packet = {
    version: 2,
    sessionId,
    party: name,
    nodes: facts[name].map(({ say, ...node }) => ({ ...node, evidenceLines: [lines.get(node.id)] })),
    edges: edges[name],
  };
  if (name === 'ruslan') packet.links = links.map(link => ({ ...link, graph: aliGraphId }));
  return packet;
}
