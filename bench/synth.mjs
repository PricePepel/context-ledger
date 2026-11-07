// Synthetic two-party negotiation transcripts for the M0 benchmark. Everything is
// derived from a seeded PRNG, so the same seed always produces the same bytes.

/** mulberry32: a small, well-known 32-bit PRNG. Never Math.random. */
export function prng(seed) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: n => Math.floor(next() * n),
    pick: list => list[Math.floor(next() * list.length)],
  };
}

/**
 * Derive an independent 32-bit seed from a user seed (0..2^32-1) and a small salt,
 * in 32-bit integer arithmetic (murmur3 fmix32). For a fixed seed, different salts
 * always give different results, so the parties never share a PRNG stream.
 */
export function deriveSeed(seed, salt) {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new RangeError('The seed must be an integer from 0 to 4294967295.');
  let hash = (seed ^ Math.imul(salt, 0x9e3779b9)) >>> 0;
  hash = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b);
  hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35);
  return (hash ^ (hash >>> 16)) >>> 0;
}

/** Fisher-Yates shuffle with a seeded generator, returning a new array. */
export function shuffled(list, rng) {
  const copy = [...list];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const other = rng.int(index + 1);
    [copy[index], copy[other]] = [copy[other], copy[index]];
  }
  return copy;
}

export const parties = {
  a: { name: 'mara', provider: 'claude', source: 'mara-negotiation.jsonl', other: 'teo' },
  b: { name: 'teo', provider: 'codex', source: 'teo-negotiation.jsonl', other: 'mara' },
};

const topics = [
  'billing export', 'search index', 'audit log', 'session cache', 'retry queue', 'rate limiter',
  'webhook relay', 'report builder', 'invoice renderer', 'login page', 'CSV import', 'usage meter',
  'alert rules', 'tenant settings', 'backup job', 'feature flags', 'email digest', 'status page',
];

const labels = {
  goal: [t => `Ship the ${t} change before the Friday review`, t => `Get the ${t} work merged this sprint`],
  offer: [t => `Two hours of pairing on the ${t} work`, t => `A full review pass on the ${t} branch`],
  constraint: [t => `No schema changes to the ${t} this sprint`, t => `The ${t} must stay backward compatible`],
  decision: [t => `Keep the ${t} behind a feature flag`, t => `Use the existing queue for the ${t}`],
  action: [t => `Write the migration notes for the ${t}`, t => `Add load tests for the ${t}`],
  question: [t => `Who signs off on the ${t} rollout?`, t => `Can the ${t} wait until next week?`],
};

const phrasing = {
  goal: label => `Goal for this week: ${label}.`,
  offer: label => `I can offer this: ${label}.`,
  constraint: label => `Hard constraint: ${label}.`,
  decision: label => `Decision: ${label}.`,
  action: label => `Next action: ${label}.`,
};

const fillerUser = [
  t => `Can you look at the failing ${t} test again? It flaked twice on CI this morning.`,
  t => `I pushed a small fix to the ${t} branch. Please rerun the suite when you get a chance.`,
  t => `The logs for the ${t} show a timeout after 30s. Not sure if it is the network or our code.`,
  t => `Let's rename the helper in the ${t} module to something clearer.`,
  t => `What does the ${t} do when the input file is empty?`,
  () => 'Thanks, that looks right. Carry on with the next step.',
  () => 'Run the linter and tell me what it reports.',
];
const fillerAssistant = [
  t => `I ran \`npm test\` for the ${t}: 48 passed, 0 failed, 2 skipped in 3.4s.`,
  t => `I read the ${t} module. The retry loop catches the error but never logs it, so failures look silent.`,
  t => `Updated the ${t} handler to return 400 on malformed input and added a unit test for it.`,
  t => `The ${t} timeout comes from the default 30000 ms client limit; raising it hides the issue, so I left it.`,
  t => `Here is the diff summary for the ${t}: 3 files changed, 41 insertions, 12 deletions.`,
  () => 'The linter reports two unused imports and one long line. I fixed all three.',
  () => 'Done. The working tree is clean and the build passes locally.',
];

// Kind order for each party's planted facts. Party B's offers, constraints and
// decisions are the ones that link to party A's goals/offers, actions and questions.
const kindCycle = {
  a: ['goal', 'offer', 'question', 'action', 'constraint', 'decision'],
  b: ['offer', 'constraint', 'decision', 'goal', 'action', 'question'],
};

/** Planted facts per party: about sqrt(turns) + 4, so the graph grows sublinearly. */
export const factCount = turns => 4 + Math.floor(Math.sqrt(turns));

function plantFacts(key, turns, rng) {
  const party = parties[key];
  const count = factCount(turns);
  const offset = key === 'a' ? 0 : 7;
  const facts = [];
  for (let index = 0; index < count; index += 1) {
    const kind = kindCycle[key][index % kindCycle[key].length];
    const slot = (index + offset) % topics.length;
    const round = Math.floor((index + offset) / topics.length);
    const topic = topics[slot] + (round ? ` part ${round + 1}` : '');
    const label = rng.pick(labels[kind])(topic);
    const fact = { id: `${kind}-${index + 1}`, kind, label, turn: Math.floor(((index + 0.5) * turns) / count) };
    if (kind === 'action') fact.status = 'pending';
    if (kind === 'question') Object.assign(fact, { status: 'open', to: party.other });
    facts.push(fact);
  }
  return facts;
}

function factSentence(fact) {
  if (fact.kind === 'question') return `Question for ${fact.to}: ${fact.label}`;
  return phrasing[fact.kind](fact.label);
}

const claudeRecord = (role, text, index) => ({
  type: role,
  timestamp: new Date(Date.UTC(2026, 10, 2, 9, 0, index * 20)).toISOString(),
  message: { role, content: role === 'user' ? text : [{ type: 'text', text }] },
});
const codexRecord = (role, text) => ({
  type: 'response_item',
  payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] },
});
// Records the importers skip, so line numbers and message indices diverge as in real files.
const claudeNoise = index => ({ type: 'system', subtype: 'tool_result_summary', content: `tool call ${index} finished` });
const codexNoise = index => ({ type: 'event_msg', payload: { type: 'token_count', info: { turn: index } } });

/**
 * Generate one party's transcript of `turns` conversation turns, plus `extraTurns`
 * appended filler turns (the first of which plants one extra action). The base
 * transcript is a byte prefix of the extended one.
 */
export function generateParty(key, turns, seed, extraTurns = 0) {
  const party = parties[key];
  const rng = prng(deriveSeed(seed, key === 'a' ? 1 : 2));
  const facts = plantFacts(key, turns, rng);
  const appended = {
    id: 'action-appended', kind: 'action', status: 'pending',
    label: `Publish the benchmark notes for the ${topics[(turns + (key === 'a' ? 0 : 7)) % topics.length]}`,
    turn: turns,
  };

  const records = [];
  if (party.provider === 'codex') {
    records.push({ type: 'session_meta', payload: { id: 'synthetic-session', cwd: '/synthetic/project', originator: 'codex_cli' } });
    records.push(codexRecord('user', '<environment_context>\n  <cwd>/synthetic/project</cwd>\n</environment_context>'));
  }

  const turnLines = [];
  const lastTurn = turns + extraTurns;
  let baseLength = 0;
  for (let turn = 0; turn < lastTurn; turn += 1) {
    if (turn > 0 && rng.next() < 0.15) records.push(party.provider === 'claude' ? claudeNoise(turn) : codexNoise(turn));
    const role = turn % 2 === 0 ? 'user' : 'assistant';
    const topic = rng.pick(topics);
    const parts = [rng.pick(role === 'user' ? fillerUser : fillerAssistant)(topic)];
    const planted = facts.filter(fact => fact.turn === turn);
    if (turn === appended.turn && extraTurns > 0) planted.push(appended);
    parts.push(...planted.map(factSentence));
    const text = parts.join(' ');
    records.push(party.provider === 'claude' ? claudeRecord(role, text, turn) : codexRecord(role, text));
    turnLines.push(records.length);
    if (turn === turns - 1) baseLength = records.length;
  }

  const lines = records.map(record => JSON.stringify(record));
  const lineOf = turn => turnLines[turn];
  const withLines = fact => ({ ...fact, line: lineOf(fact.turn), previousLine: fact.turn > 0 ? lineOf(fact.turn - 1) : undefined });
  return {
    party,
    facts: facts.map(withLines),
    appended: extraTurns > 0 ? withLines(appended) : undefined,
    base: lines.slice(0, baseLength).join('\n'),
    extended: lines.join('\n'),
  };
}

function node(fact) {
  // Cite the planted line and, when there is one, the turn before it as context.
  const evidenceLines = fact.previousLine ? [fact.line, fact.previousLine] : [fact.line];
  const result = { id: fact.id, kind: fact.kind, label: fact.label, evidenceLines };
  if (fact.status) result.status = fact.status;
  if (fact.to) result.to = fact.to;
  return result;
}

function localEdges(facts) {
  const firstGoal = facts.find(fact => fact.kind === 'goal');
  const firstAction = facts.find(fact => fact.kind === 'action');
  const edges = [];
  for (const fact of facts) {
    if (fact.kind === 'action' && firstGoal) edges.push({ from: fact.id, to: firstGoal.id, type: 'advances' });
    if (fact.kind === 'constraint' && firstAction) edges.push({ from: fact.id, to: firstAction.id, type: 'constrains' });
  }
  return edges;
}

/** Links from party B to party A: offers match, constraints conflict, decisions answer. */
function crossLinks(factsB, factsA, graphA) {
  const ofKind = (facts, kinds) => facts.filter(fact => kinds.includes(fact.kind));
  const pairs = [
    ['matches', ofKind(factsB, ['offer']), ofKind(factsA, ['goal', 'offer'])],
    ['conflicts', ofKind(factsB, ['constraint']), ofKind(factsA, ['action'])],
    ['answers', ofKind(factsB, ['decision']), ofKind(factsA, ['question']).filter(fact => fact.to === parties.b.name)],
  ];
  return pairs.flatMap(([type, from, to]) => from.slice(0, to.length)
    .map((fact, index) => ({ from: fact.id, graph: graphA, to: to[index].id, type })));
}

/** Build the v2 packet for one party. `extra` facts (the appended action) are added last. */
export function packetFor(generated, sessionId, { linkTo, otherFacts, extra = [] } = {}) {
  const facts = [...generated.facts, ...extra];
  const packet = {
    version: 2,
    sessionId,
    party: generated.party.name,
    nodes: facts.map(node),
    edges: localEdges(facts),
  };
  if (linkTo) packet.links = crossLinks(generated.facts, otherFacts, linkTo);
  return packet;
}

/** A copy of a packet with nodes, evidence, edges and links in a seeded random order. */
export function shuffledPacket(packet, rng) {
  const copy = {
    ...packet,
    nodes: shuffled(packet.nodes, rng).map(entry => ({ ...entry, evidenceLines: shuffled(entry.evidenceLines, rng) })),
    edges: shuffled(packet.edges, rng),
  };
  if (packet.links) copy.links = shuffled(packet.links, rng);
  return copy;
}
