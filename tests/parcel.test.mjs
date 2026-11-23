// Card R1 (ADR-19): a parcel carries one graph and the transcript lines it cites from one
// ledger to another. Synthetic transcripts, names and credentials only; the fake token is
// put together from fragments so no committed file holds one whole.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { GraphInputError } from '../src/graph.mjs';
import { handoffMarkdown } from '../src/handoff.mjs';
import { schemaVersion } from '../src/migrate.mjs';
import { buildParcel, checkParcel, maxParcelBytes, parseParcel, serializeParcel } from '../src/parcel.mjs';
import { ConflictError, InputError, openStore } from '../src/store.mjs';

const uuid = n => `0000000${n}-aaaa-4bbb-8ccc-00000000000${n}`;
const key = n => `u:${uuid(n)}`;
const claude = turns => turns
  .map(([role, text], index) => JSON.stringify({ type: role, uuid: uuid(index + 1), message: { role, content: text } })).join('\n');
const fakeToken = ['gh', 'p_', 'Ab3D'.repeat(9)].join('');
// Control characters are built here, never typed (AGENTS.md section 6).
const bell = String.fromCodePoint(7);
const escape = String.fromCodePoint(27);

// Vera's session: line 1 is never cited, line 4 holds a fake credential.
const veraTurns = [
  ['user', 'Vera: an aside that no graph cites, about the Lyra budget.'],
  ['assistant', 'The relay ships on port 6100.'],
  ['user', 'Agreed, and no deploys on Sunday.'],
  ['assistant', `The staging token is ${fakeToken} for now.`],
  ['user', 'Record the demo on Friday.'],
];
const veraGraph = (sessionId, lines = [2, 3]) => ({
  version: 2, sessionId, party: 'vera', edges: [],
  nodes: [
    { id: 'port', kind: 'decision', label: 'Port 6100', evidenceLines: [lines[0]] },
    { id: 'no-sunday', kind: 'constraint', label: 'No deploys on Sunday', evidenceLines: [lines[1]] },
  ],
});

const tables = ['projects', 'sessions', 'messages', 'graphs', 'artifacts', 'session_excerpts', 'rooms', 'review_events'];

/** A ledger in its own temporary folder: its store, and dump(), every row of every table. */
function ledger(t, name = 'ledger') {
  const folder = mkdtempSync(join(tmpdir(), `ledger-r1-${name}-`));
  const path = join(folder, 'data', 'ledger.sqlite');
  const store = openStore(path);
  t.after(() => {
    try { store.close(); } catch { /* a test may have closed it */ }
    rmSync(folder, { recursive: true, force: true });
  });
  const dump = () => {
    const raw = new DatabaseSync(path, { readOnly: true });
    try {
      return JSON.stringify(tables.map(table => raw.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
    } finally {
      raw.close();
    }
  };
  return { folder, path, store, dump, env: { CONTEXT_LEDGER_DB: path } };
}

/** Vera's ledger with her session and a graph over the given lines. */
function vera(t, lines, project) {
  const a = ledger(t, 'a');
  const session = a.store.importTranscript({ provider: 'claude', source: 'vera.jsonl', transcript: claude(veraTurns), ...(project ? { project } : {}) });
  const graph = a.store.publishGraph(veraGraph(session.id, lines));
  return { ...a, session, graph };
}

const parcelOf = (store, graphId) => {
  const graph = store.getGraph(graphId);
  return buildParcel(graph, store.get(graph.packet.sessionId));
};
/** What `ledger receive` does with a parcel file's bytes. */
const receive = (store, parcel) => store.receiveParcel(parseParcel(Buffer.from(serializeParcel(parcel))));
const carry = (from, to, graphId) => receive(to, parcelOf(from, graphId).parcel);
const clone = value => JSON.parse(JSON.stringify(value));

// Node's own warning that node:sqlite is experimental is not part of what the CLI says.
const withoutNodeWarning = text => text.split('\n')
  .filter(line => !/^\(node:\d+\) ExperimentalWarning: SQLite |^\(Use `node --trace-warnings /u.test(line)).join('\n');

function run(args, env) {
  return new Promise(resolve => {
    execFile(process.execPath, ['src/cli.mjs', ...args], { env: { ...process.env, ...env } }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code : 0, stdout, stderr: withoutNodeWarning(stderr) });
    });
  });
}

test('R1: a graph and the lines it cites travel; the graph has the same ID on both ledgers', t => {
  const a = vera(t);
  const b = ledger(t, 'b');
  const { parcel, redacted, links } = parcelOf(a.store, a.graph.id);
  assert.equal(redacted, 0);
  assert.equal(links, 0);
  const result = receive(b.store, parcel);
  assert.equal(result.graph.id, a.graph.id);
  assert.equal(result.added, 2);
  assert.deepEqual(b.store.getGraph(a.graph.id).packet, a.store.getGraph(a.graph.id).packet);
  assert.deepEqual(b.store.getGraph(a.graph.id).quotedNodeIds, a.store.getGraph(a.graph.id).quotedNodeIds);
  const stored = b.store.get(a.session.id);
  assert.deepEqual(stored.messages, [
    { role: 'assistant', text: 'The relay ships on port 6100.', line: 2, key: key(2) },
    { role: 'user', text: 'Agreed, and no deploys on Sunday.', line: 3, key: key(3) },
  ]);
  assert.deepEqual({ ...stored, messages: undefined }, {
    id: a.session.id, provider: 'claude', source: 'vera.jsonl', title: 'Agreed, and no deploys on Sunday.',
    messageCount: 2, project: 'default', excerpts: true, messages: undefined,
  });
});

test('R1: only cited lines leave: no other line and no title is in the parcel', t => {
  const a = vera(t);
  const { parcel } = parcelOf(a.store, a.graph.id);
  const text = serializeParcel(parcel);
  assert.equal(a.session.title, 'Vera: an aside that no graph cites, about the Lyra budget.');
  for (const absent of ['aside', 'Lyra', 'Friday', 'staging token', fakeToken]) assert.equal(text.includes(absent), false, absent);
  assert.deepEqual(parcel.session.messages.map(message => message.line), [2, 3]);
  assert.deepEqual(Object.keys(parcel).sort(), ['artifacts', 'format', 'graph', 'project', 'redacted', 'session', 'version']);
  assert.deepEqual(Object.keys(parcel.session).sort(), ['id', 'messages', 'provider', 'source']);
  assert.equal(text.endsWith('\n') && !text.slice(0, -1).includes('\n'), true, 'one line');
});

test('R1: a credential in a cited line is a marker in the parcel and on the other ledger', t => {
  const a = vera(t, [2, 4]);
  const b = ledger(t, 'b');
  const { parcel, redacted } = parcelOf(a.store, a.graph.id);
  assert.equal(redacted, 1);
  assert.equal(parcel.redacted, 1);
  const text = serializeParcel(parcel);
  assert.equal(text.includes(fakeToken), false);
  assert.equal(text.includes('Ab3D'), false);
  receive(b.store, parcel);
  assert.equal(b.store.get(a.session.id).messages[1].text, 'The staging token is [REDACTED github-token] for now.');
  assert.equal(a.store.get(a.session.id).messages[3].text.includes(fakeToken), true, 'the sender keeps its own text');
});

test('R1: a version 3 graph travels with its keys, its artifacts and its agent turns', t => {
  const a = ledger(t, 'a');
  const b = ledger(t, 'b');
  const codex = (role, text) => JSON.stringify({ type: 'response_item', payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] } });
  const agent = (author, recipient, text) => JSON.stringify({ type: 'response_item', payload: { type: 'agent_message', author, recipient, content: [{ type: 'input_text', text }] } });
  const transcript = [
    codex('user', 'Check the Orion build before the demo.'),
    agent('/root', '/root/worker', 'Run the Orion smoke test on port 6100.'),
    agent('/root/worker', '/root', 'The smoke test passed.'),
    codex('assistant', 'The worker found no regressions.'),
  ].join('\n');
  const session = a.store.importTranscript({ provider: 'codex', source: 'orion.jsonl', transcript, project: 'orion' });
  const messages = a.store.get(session.id).messages;
  const commit = a.store.registerArtifact({ project: 'orion', kind: 'commit', repo: 'orbit-labs/adapter', ref: '6100abcdef0' });
  const graph = a.store.publishGraph({
    version: 3, sessionId: session.id, party: 'orion-team', edges: [],
    nodes: [
      { id: 'smoke', kind: 'action', status: 'completed', label: 'Smoke test on port 6100', evidence: [{ message: messages[1].key }, { message: messages[2].key }, { artifact: commit.id }] },
      { id: 'pinned', kind: 'decision', label: 'Pinned to the adapter commit', evidence: [{ artifact: commit.id }] },
    ],
  });
  const result = carry(a.store, b.store, graph.id);
  assert.equal(result.graph.id, graph.id);
  assert.deepEqual(b.store.getGraph(graph.id).citations, a.store.getGraph(graph.id).citations);
  assert.deepEqual(b.store.getGraph(graph.id).nodeHashes, a.store.getGraph(graph.id).nodeHashes);
  assert.deepEqual(b.store.get(session.id).messages, messages.slice(1, 3));
  assert.equal(b.store.get(session.id).project, 'orion');
  assert.deepEqual(b.store.listArtifacts({ project: 'orion', limit: 10 }).artifacts.map(({ id, kind, repo, ref }) => ({ id, kind, repo, ref })),
    [{ id: commit.id, kind: 'commit', repo: 'orbit-labs/adapter', ref: '6100abcdef0' }]);
});

test('R1: a version 1 graph travels too', t => {
  const a = ledger(t, 'a');
  const b = ledger(t, 'b');
  const session = a.store.importTranscript({ provider: 'claude', source: 'vera.jsonl', transcript: claude(veraTurns) });
  const graph = a.store.publishGraph({
    version: 1, sessionId: session.id, edges: [{ from: 'record', to: 'demo', type: 'advances' }],
    nodes: [
      { id: 'demo', kind: 'goal', label: 'Demo on Friday', evidenceLines: [5] },
      { id: 'record', kind: 'action', status: 'pending', label: 'Record the demo', evidenceLines: [5] },
    ],
  });
  assert.equal(carry(a.store, b.store, graph.id).graph.id, graph.id);
  assert.deepEqual(b.store.getGraph(graph.id).readyActionIds, ['record']);
  assert.deepEqual(b.store.get(session.id).messages.map(message => message.line), [5]);
});

test('R1: a graph that cites only artifacts has no line to carry and is not shared', t => {
  const a = ledger(t, 'a');
  const session = a.store.importTranscript({ provider: 'claude', source: 'vera.jsonl', transcript: claude(veraTurns) });
  const commit = a.store.registerArtifact({ kind: 'commit', repo: 'orbit-labs/adapter', ref: '6100abcdef0' });
  const graph = a.store.publishGraph({ version: 3, sessionId: session.id, party: 'vera', edges: [],
    nodes: [{ id: 'pinned', kind: 'decision', label: 'Pinned to the adapter commit', evidence: [{ artifact: commit.id }] }] });
  assert.throws(() => parcelOf(a.store, graph.id), error => error instanceof InputError
    && error.message === 'This graph cites no transcript lines, so it cannot be shared.');
});

test('R1: a parcel that fails any check is refused and changes nothing', t => {
  const a = vera(t);
  const b = ledger(t, 'b');
  // B has a graph of its own, so "unchanged" covers more than empty tables.
  const own = b.store.importTranscript({ provider: 'claude', source: 'own.jsonl', transcript: claude([['user', 'Nora: we offer review time.']]) });
  b.store.publishGraph({ version: 2, sessionId: own.id, party: 'nora', edges: [], nodes: [{ id: 'review', kind: 'offer', label: 'Review time', evidenceLines: [1] }] });
  const before = b.dump();
  const { parcel } = parcelOf(a.store, a.graph.id);
  const changed = change => {
    const copy = clone(parcel);
    change(copy);
    return copy;
  };
  const refused = (copy, kind, message) => {
    assert.throws(() => b.store.receiveParcel(checkParcel(copy)), error => error instanceof kind && (message === undefined || error.message === message), JSON.stringify(message));
    assert.equal(b.dump(), before);
  };
  const notParcel = 'This is not a version 1 Context Ledger parcel.';
  refused(changed(p => { p.graph.id = 'f'.repeat(64); }), InputError, 'The parcel\'s graph ID does not match its packet.');
  refused(changed(p => { p.graph.packet.nodes[0].label = 'Port 6200'; }), InputError, 'The parcel\'s graph ID does not match its packet.');
  refused(changed(p => { p.session.messages.pop(); }), GraphInputError, 'Evidence must refer to stored lines in the source session.');
  refused(changed(p => { p.graph.packet.links = [{ from: 'port', graph: 'e'.repeat(64), to: 'x', type: 'conflicts' }]; }), InputError,
    'This graph links to a graph that is not in this ledger. Receive that graph first.');
  refused(changed(p => { p.graph.packet.sessionId = 'e'.repeat(64); }), InputError, 'The parcel\'s graph cites another session than the one it carries.');
  refused(changed(p => { p.graph.packet.nodes = 'none'; }), GraphInputError);
  for (const change of [
    p => { p.version = 2; },
    p => { p.format = 'context-ledger-signed-handoff'; },
    p => { p.extra = true; },
    p => { p.session.title = 'A title'; },
    p => { delete p.redacted; },
    p => { p.project = 'Not A Slug'; },
    p => { p.session.id = 'short'; },
    p => { p.session.provider = 'other'; },
    p => { p.session.source = 'a' + bell + 'b.jsonl'; },
    p => { p.session.messages[0].key = 'x:1'; },
    p => { p.session.messages[0].line = 0; },
    p => { p.session.messages[0].line = 1.5; },
    p => { p.session.messages[0].role = 'system'; },
    p => { p.session.messages[0].text = '   '; },
    p => { p.session.messages[0].author = '/root'; },
    p => { Object.assign(p.session.messages[0], { role: 'agent', author: '/root' }); },
    p => { p.session.messages = []; },
    p => { p.artifacts = [{ kind: 'commit', repo: 'orbit-labs/adapter', ref: '6100abcdef0', id: 'a'.repeat(64) }]; },
    p => { p.graph.packet = []; },
  ]) refused(changed(change), InputError, notParcel);
  refused(changed(p => { p.session.messages[1].line = p.session.messages[0].line; }), InputError, 'A parcel must carry each message once.');
  refused(changed(p => { p.session.messages[1].key = p.session.messages[0].key; }), InputError, 'A parcel must carry each message once.');
  // An artifact the ledger would not register is refused by the same rule as `artifact add`.
  refused(changed(p => { p.artifacts = [{ kind: 'commit', repo: 'no-slash', ref: '6100abcdef0' }]; }), InputError);

  for (const bytes of [Buffer.from('not json'), Buffer.from([0xff, 0xfe, 0x7b, 0x7d]), Buffer.from('null'), Buffer.from('[]')]) {
    assert.throws(() => parseParcel(bytes), error => error instanceof InputError && error.message === notParcel);
  }
  assert.throws(() => parseParcel(Buffer.alloc(maxParcelBytes + 1, 0x20)), error => error instanceof InputError && error.message === 'A parcel is at most 8 MiB.');
  assert.equal(b.dump(), before);
  // And the parcel as written is still accepted.
  assert.equal(receive(b.store, parcel).graph.id, a.graph.id);
});

test('R1: a second parcel of the same session adds its new lines in order; the same parcel twice changes nothing', t => {
  const a = vera(t, [3, 5]);
  const b = ledger(t, 'b');
  assert.equal(carry(a.store, b.store, a.graph.id).added, 2);
  const once = b.dump();
  const again = carry(a.store, b.store, a.graph.id);
  assert.equal(again.added, 0);
  assert.equal(again.graph.id, a.graph.id);
  assert.equal(b.dump(), once);

  const second = a.store.publishGraph({ version: 2, sessionId: a.session.id, party: 'vera', edges: [],
    nodes: [{ id: 'port', kind: 'decision', label: 'Port 6100', evidenceLines: [2, 3] }] });
  const result = carry(a.store, b.store, second.id);
  assert.equal(result.added, 1);
  assert.deepEqual(b.store.get(a.session.id).messages.map(message => [message.line, message.key]), [[2, key(2)], [3, key(3)], [5, key(5)]]);
  assert.equal(result.session.messageCount, 3);
  assert.equal(result.session.excerpts, true);
  assert.equal(b.store.list('port 6100', null, null).length, 1, 'the new line is searchable');
  assert.ok(b.store.getGraph(a.graph.id) && b.store.getGraph(second.id));
});

test('R1: where the transcript was imported, the session stays as it is and the graph is published', t => {
  const a = vera(t);
  const b = ledger(t, 'b');
  const own = b.store.importTranscript({ provider: 'claude', source: 'my-copy.jsonl', transcript: claude(veraTurns) });
  assert.equal(own.id, a.session.id);
  const messages = b.store.get(own.id).messages;
  const result = carry(a.store, b.store, a.graph.id);
  assert.equal(result.added, 0);
  assert.equal(result.session.excerpts, undefined);
  assert.equal(result.session.source, 'my-copy.jsonl');
  assert.deepEqual(b.store.get(own.id).messages, messages);
  assert.equal(b.store.getGraph(a.graph.id).id, a.graph.id);

  const before = b.dump();
  const { parcel } = parcelOf(a.store, a.graph.id);
  const mismatch = 'The parcel\'s lines do not match the session of the same ID in this ledger, so the parcel was not stored.';
  for (const change of [
    p => { p.session.messages[0].role = 'user'; },
    p => { p.session.messages[0].key = 'h:' + 'a'.repeat(32); },
    p => { p.session.messages.push({ key: 'h:' + 'b'.repeat(32), line: 9, role: 'user', text: 'A line the session never had.' }); },
  ]) {
    const copy = clone(parcel);
    change(copy);
    assert.throws(() => b.store.receiveParcel(checkParcel(copy)), error => error instanceof ConflictError && error.message === mismatch);
    assert.equal(b.dump(), before);
  }
  const elsewhere = clone(parcel);
  elsewhere.project = 'lyra';
  assert.throws(() => b.store.receiveParcel(checkParcel(elsewhere)), error => error instanceof ConflictError
    && error.message === 'This ledger has the parcel\'s session under another provider or project, so the parcel was not stored.');
  assert.equal(b.dump(), before);
});

test('R1: importing the full transcript later replaces the excerpts and keeps the graph', t => {
  const a = vera(t, [2, 4]);
  const b = ledger(t, 'b');
  carry(a.store, b.store, a.graph.id);
  assert.equal(b.store.get(a.session.id).messages[1].text.includes('[REDACTED'), true);
  const imported = b.store.importTranscript({ provider: 'claude', source: 'vera-full.jsonl', transcript: claude(veraTurns), project: 'ignored' });
  assert.deepEqual({ ...imported }, { id: a.session.id, provider: 'claude', source: 'vera-full.jsonl',
    title: 'Vera: an aside that no graph cites, about the Lyra budget.', messageCount: 5, project: 'default' });
  assert.deepEqual(b.store.get(a.session.id).messages, a.store.get(a.session.id).messages);
  assert.equal(b.store.list('lyra budget', null, null).length, 1);
  assert.equal(b.store.getGraphContext(a.graph.id).graphId ?? a.graph.id, a.graph.id);
  // Nothing marks it any more: the next import is the plain duplicate it always was.
  const raw = new DatabaseSync(b.path, { readOnly: true });
  assert.equal(raw.prepare('SELECT count(*) AS n FROM session_excerpts').get().n, 0);
  raw.close();
  const dump = b.dump();
  b.store.importTranscript({ provider: 'claude', source: 'vera-full.jsonl', transcript: claude(veraTurns) });
  assert.equal(b.dump(), dump);
});

test('R1: excerpts with a legacy key keep it when the full transcript arrives', t => {
  const a = vera(t);
  const b = ledger(t, 'b');
  // A sender whose session was migrated from before message keys has l:<line> keys.
  const { parcel } = parcelOf(a.store, a.graph.id);
  const legacy = clone(parcel);
  legacy.session.messages[0].key = 'l:2';
  b.store.receiveParcel(checkParcel(legacy));
  const cited = { version: 3, sessionId: a.session.id, party: 'vera', edges: [],
    nodes: [{ id: 'port', kind: 'decision', label: 'Port 6100', evidence: [{ message: 'l:2' }, { message: key(3) }] }] };
  const graph = b.store.publishGraph(cited);
  b.store.importTranscript({ provider: 'claude', source: 'vera.jsonl', transcript: claude(veraTurns) });
  assert.deepEqual(b.store.get(a.session.id).messages.map(message => message.key), [key(1), 'l:2', key(3), key(4), key(5)]);
  assert.equal(b.store.publishGraph(cited).id, graph.id, 'its citations still resolve');
});

test('R1: a file whose lines do not match the excerpts is refused, and nothing changes', t => {
  const a = vera(t);
  const b = ledger(t, 'b');
  const { parcel } = parcelOf(a.store, a.graph.id);
  // Someone sent excerpts under this session's ID that its transcript does not hold.
  const forged = clone(parcel);
  forged.session.messages[0].role = 'user';
  b.store.receiveParcel(checkParcel(forged));
  const before = b.dump();
  assert.throws(() => b.store.importTranscript({ provider: 'claude', source: 'vera.jsonl', transcript: claude(veraTurns) }),
    error => error instanceof ConflictError && error.message === 'This ledger holds excerpts received from another machine under this transcript\'s ID, '
      + 'and the file\'s lines do not match them. Nothing was changed.');
  assert.equal(b.dump(), before);
  assert.equal(b.store.get(a.session.id).excerpts, true);
});

test('R1: two machines link their graphs and open the same room', t => {
  const a = vera(t, [2, 3], 'lyra');
  const b = ledger(t, 'b');
  carry(a.store, b.store, a.graph.id);
  const noraSession = b.store.importTranscript({ provider: 'claude', source: 'nora.jsonl', project: 'lyra',
    transcript: claude([['user', 'Nora: we deploy on Sunday night, and port 6100 suits us.']]) });
  const nora = b.store.publishGraph({
    version: 2, sessionId: noraSession.id, party: 'nora', edges: [],
    nodes: [{ id: 'sunday-deploy', kind: 'action', status: 'pending', label: 'Deploy on Sunday night', evidenceLines: [1] }],
    links: [{ from: 'sunday-deploy', graph: a.graph.id, to: 'no-sunday', type: 'conflicts' }],
  });
  const roomB = b.store.openRoom({ graphIds: [nora.id, a.graph.id] });
  assert.deepEqual(roomB.proposals.map(p => [p.type, p.from.nodeId, p.to.nodeId]), [['conflicts', 'sunday-deploy', 'no-sunday']]);

  const { parcel, links } = parcelOf(b.store, nora.id);
  assert.equal(links, 1);
  assert.equal(receive(a.store, parcel).graph.id, nora.id);
  const roomA = a.store.openRoom({ graphIds: [a.graph.id, nora.id] });
  assert.equal(roomA.id, roomB.id);
  assert.deepEqual(roomA.proposals.map(p => p.id), roomB.proposals.map(p => p.id));
});

test('R1: a received graph can be shared onward from its excerpts', t => {
  const a = vera(t);
  const b = ledger(t, 'b');
  const c = ledger(t, 'c');
  carry(a.store, b.store, a.graph.id);
  assert.equal(carry(b.store, c.store, a.graph.id).graph.id, a.graph.id);
  assert.deepEqual(c.store.get(a.session.id), b.store.get(a.session.id));
});

test('R1: the hand-off of an excerpt session says so, and no other does', t => {
  const a = vera(t);
  const b = ledger(t, 'b');
  carry(a.store, b.store, a.graph.id);
  const line = 'Excerpts: only the lines a shared graph cites, received from another machine.';
  assert.equal(handoffMarkdown(b.store.get(a.session.id)).split('\n').includes(line), true);
  assert.equal(handoffMarkdown(a.store.get(a.session.id)).includes('Excerpts:'), false);
  assert.equal(a.store.get(a.session.id).excerpts, undefined);
  assert.equal('excerpts' in a.store.list('', null, null)[0], false);
  assert.equal(b.store.list('', null, null)[0].excerpts, true);
  assert.equal(b.store.listSessionsPage({ query: '', limit: 5 }).sessions[0].excerpts, true);
});

test('R1: deleting an excerpt session removes its mark', t => {
  const a = vera(t);
  const b = ledger(t, 'b');
  const { parcel } = parcelOf(a.store, a.graph.id);
  receive(b.store, parcel);
  assert.throws(() => b.store.deleteSession(a.session.id), ConflictError, 'a graph cites it');
  const raw = new DatabaseSync(b.path);
  raw.exec('PRAGMA foreign_keys = ON; DELETE FROM graphs;');
  raw.close();
  assert.equal(b.store.deleteSession(a.session.id), true);
  const check = new DatabaseSync(b.path, { readOnly: true });
  assert.equal(check.prepare('SELECT count(*) AS n FROM session_excerpts').get().n, 0);
  check.close();
});

test('R1: schema version 8 adds the excerpts table to a version 7 file and changes nothing else', t => {
  const a = vera(t);
  a.store.close();
  assert.equal(schemaVersion, 8);
  const raw = new DatabaseSync(a.path);
  raw.exec('DROP TABLE session_excerpts; PRAGMA user_version = 7;');
  const rows = () => JSON.stringify(['projects', 'sessions', 'messages', 'graphs'].map(table => raw.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
  const before = rows();
  raw.close();
  const store = openStore(a.path);
  const check = new DatabaseSync(a.path, { readOnly: true });
  try {
    assert.equal(check.prepare('PRAGMA user_version').get().user_version, 8);
    assert.equal(check.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type = 'table' AND name = 'session_excerpts'").get().n, 1);
    assert.equal(JSON.stringify(['projects', 'sessions', 'messages', 'graphs'].map(table => check.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())), before);
    assert.equal(store.get(a.session.id).excerpts, undefined);
  } finally {
    check.close();
    store.close();
  }
});

test('R1: share writes a new private file and receive stores it, from the command line', async t => {
  const a = vera(t, [2, 4]);
  const b = ledger(t, 'b');
  a.store.close();
  b.store.close();
  const file = join(a.folder, 'vera.parcel.json');
  const shared = await run(['share', a.graph.id, '--out', file], a.env);
  assert.equal(shared.code, 0, shared.stderr);
  assert.equal(shared.stdout, `Parcel written to ${file}\nGraph: ${a.graph.id}\n`
    + 'It carries the 2 lines the graph cites, of 5 in the session.\n'
    + '1 possible secret in those lines was replaced by [REDACTED] markers.\n'
    + 'On the other machine, run: ledger receive <this file>\n');
  assert.equal(shared.stdout.includes('Ab3D'), false);
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
  const bytes = readFileSync(file);
  assert.equal(bytes.includes(fakeToken), false);

  const again = await run(['share', a.graph.id, '--out', file], a.env);
  assert.equal(again.code, 1);
  assert.equal(again.stderr, 'The output file already exists. Choose a new file.\n');
  assert.deepEqual(readFileSync(file), bytes);
  const nowhere = await run(['share', a.graph.id, '--out', join(a.folder, 'missing', 'x.json')], a.env);
  assert.equal(nowhere.stderr, 'The folder of the output file does not exist.\n');
  const unknown = await run(['share', 'f'.repeat(64), '--out', join(a.folder, 'none.json')], a.env);
  assert.equal(unknown.stderr, 'Graph not found.\n');
  assert.equal(existsSync(join(a.folder, 'none.json')), false);

  const received = await run(['receive', file], b.env);
  assert.equal(received.code, 0, received.stderr);
  assert.equal(received.stdout, `Received graph ${a.graph.id} of party vera into project default.\n`
    + `Session ${a.session.id}: 2 lines added; it holds 2 excerpt lines received from another machine.\n`);
  const twice = await run(['receive', file], b.env);
  assert.equal(twice.stdout, `Received graph ${a.graph.id} of party vera into project default.\n`
    + `Session ${a.session.id}: 0 lines added; it holds 2 excerpt lines received from another machine.\n`);
  const check = openStore(b.path);
  try {
    assert.equal(check.getGraph(a.graph.id).id, a.graph.id);
  } finally {
    check.close();
  }
});

test('R1: receive refuses a bad file in fixed words and leaves the ledger as it was', async t => {
  const a = vera(t);
  const b = ledger(t, 'b');
  const { parcel } = parcelOf(a.store, a.graph.id);
  b.store.close();
  const before = b.dump();
  const write = (name, text) => {
    const path = join(b.folder, name);
    writeFileSync(path, text);
    return path;
  };
  const tampered = clone(parcel);
  tampered.graph.packet.nodes[0].label = 'Port 6200';
  for (const [path, message] of [
    [write('garbage.json', JSON.stringify({ secret: escape + '[31m not a parcel' })), 'This is not a version 1 Context Ledger parcel.'],
    [write('tampered.json', serializeParcel(tampered)), 'The parcel\'s graph ID does not match its packet.'],
    [join(b.folder, 'absent.json'), 'Cannot read parcel file.'],
    [b.folder, 'Parcel must be a regular file.'],
  ]) {
    const result = await run(['receive', path], b.env);
    assert.equal(result.code, 1);
    assert.equal(result.stderr, message + '\n');
    assert.equal(result.stdout, '');
    assert.equal(b.dump(), before);
  }
  for (const args of [['receive'], ['receive', '--out', 'x'], ['share', a.graph.id], ['share', 'short', '--out', 'x'], ['share', a.graph.id, '--out', '']]) {
    const result = await run(args, b.env);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /^Usage: /u);
  }
});

test('R1: share reads read-only and asks for an upgrade of an older file', async t => {
  const a = vera(t);
  a.store.close();
  const raw = new DatabaseSync(a.path);
  raw.exec('DROP TABLE session_excerpts; PRAGMA user_version = 7;');
  raw.close();
  const result = await run(['share', a.graph.id, '--out', join(a.folder, 'x.json')], a.env);
  assert.equal(result.code, 1);
  assert.equal(result.stderr, 'This ledger database has an older schema. Start Context Ledger once with npm start to upgrade it, then share again.\n');
  const check = new DatabaseSync(a.path, { readOnly: true });
  assert.equal(check.prepare('PRAGMA user_version').get().user_version, 7, 'not migrated by a read');
  check.close();
  assert.equal(existsSync(join(a.folder, 'x.json')), false);
});
