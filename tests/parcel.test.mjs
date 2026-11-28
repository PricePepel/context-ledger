// Card R1 (ADR-19): a parcel carries one graph and the transcript lines it cites from one
// ledger to another. Synthetic transcripts, names and credentials only; the fake token is
// put together from fragments so no committed file holds one whole.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { GraphInputError, packetId } from '../src/graph.mjs';
import { handoffMarkdown } from '../src/handoff.mjs';
import { schemaVersion } from '../src/migrate.mjs';
import {
  buildParcel, checkParcel, compatibleTurns, matchesRedacted, maxParcelBytes, parseParcel, sameTurn, serializeParcel,
} from '../src/parcel.mjs';
import { ConflictError, InputError, openStore } from '../src/store.mjs';
import { startMcp } from './mcp-client.mjs';

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
  refused(changed(p => { p.session.messages.pop(); }), InputError, 'A parcel must carry exactly the lines and artifacts its graph cites.');
  refused(changed(p => {
    p.graph.packet.links = [{ from: 'port', graph: 'e'.repeat(64), to: 'x', type: 'conflicts' }];
    p.graph.id = packetId(p.graph.packet);
  }), InputError, 'This graph links to a graph that is not in this ledger. Receive that graph first.');
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
  assert.equal(b.store.getGraphContext(a.graph.id).graphId, a.graph.id);
  assert.equal('baseline' in b.store.getGraphContext(a.graph.id).meter, false);
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

test('R1: a line-cited graph from an upgraded ledger with l:<line> keys is received by a fresh import of the same file', t => {
  const a = vera(t);
  const b = ledger(t, 'b');
  // Codex review of the refresh (2026-11-27): the sender was migrated from before message
  // keys, so its turns are keyed l:<line>; the receiver imported the same file fresh.
  b.store.importTranscript({ provider: 'claude', source: 'vera.jsonl', transcript: claude(veraTurns) });
  const { parcel } = parcelOf(a.store, a.graph.id);
  const legacy = clone(parcel);
  for (const message of legacy.session.messages) message.key = `l:${message.line}`;
  const result = b.store.receiveParcel(checkParcel(legacy));
  assert.equal(result.graph.id, a.graph.id);
  assert.equal(result.added, 0);
  assert.deepEqual(b.store.get(a.session.id).messages.map(message => message.key), [1, 2, 3, 4, 5].map(key), 'the keys here are kept');
  // The same alias does not hide a different turn on that line.
  const c = ledger(t, 'c');
  c.store.importTranscript({ provider: 'claude', source: 'vera.jsonl', transcript: claude(veraTurns) });
  const changed = clone(legacy);
  changed.session.messages[0].text = 'The relay ships on port 6200.';
  const dump = c.dump();
  assert.throws(() => c.store.receiveParcel(checkParcel(changed)), ConflictError);
  assert.equal(c.dump(), dump);
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
    + '1 possible secret in what it carries was replaced by [REDACTED] markers.\n'
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

// ---- Codex review, round 1 ----

const refusedShare = (store, graphId, message) => assert.throws(() => parcelOf(store, graphId),
  error => error instanceof InputError && error.message === message);

test('R1 review: a graph whose own text holds a credential is not shared', t => {
  const a = vera(t, [2, 4]);
  const leaky = 'This graph\'s own text (a label, a name, an artifact or its project) holds what looks like a credential, so it was not shared.';
  // The label repeats the token of the line it cites: the line is redacted, the label cannot be.
  const inLabel = a.store.publishGraph({ version: 2, sessionId: a.session.id, party: 'vera', edges: [],
    nodes: [{ id: 'token', kind: 'decision', label: `Staging token ${fakeToken}`, evidenceLines: [4] }] });
  refusedShare(a.store, inLabel.id, leaky);
  const inOldLabel = a.store.publishGraph({ version: 1, sessionId: a.session.id, edges: [],
    nodes: [{ id: 'token', kind: 'decision', label: `Use ${fakeToken}`, evidenceLines: [4] }] });
  refusedShare(a.store, inOldLabel.id, leaky);
  // An artifact's file path is free text too.
  const file = a.store.registerArtifact({ kind: 'file', repo: 'orbit-labs/adapter', ref: `config/${fakeToken}.env` });
  const inArtifact = a.store.publishGraph({ version: 3, sessionId: a.session.id, party: 'vera', edges: [],
    nodes: [{ id: 'port', kind: 'decision', label: 'Port 6100', evidence: [{ message: key(2) }, { artifact: file.id }] }] });
  refusedShare(a.store, inArtifact.id, leaky);
  // Hashes, keys and repository names are not taken for credentials.
  const commit = a.store.registerArtifact({ kind: 'commit', repo: 'orbit-labs/adapter', ref: 'a1b2c3d4e5f60718'.repeat(4).slice(0, 40) });
  const plain = a.store.publishGraph({ version: 3, sessionId: a.session.id, party: 'vera', edges: [],
    nodes: [{ id: 'port', kind: 'decision', label: 'Port 6100', evidence: [{ message: key(2) }, { artifact: commit.id }] }] });
  assert.equal(parcelOf(a.store, plain.id).parcel.artifacts.length, 1);
});

test('R1 review: a label that repeats a line the graph does not cite is not shared', t => {
  const a = vera(t);
  const repeats = 'A label of this graph repeats a transcript line the graph does not cite, so it was not shared. Cite that line or reword the label.';
  const titled = lines => a.store.publishGraph({ version: 2, sessionId: a.session.id, party: 'vera', edges: [],
    nodes: [{ id: 'aside', kind: 'decision', label: 'Noted:  vera: an aside that no graph cites, about the LYRA budget.', evidenceLines: lines }] });
  // Line 1 is also the session's title; white space and case do not hide it.
  refusedShare(a.store, titled([2]).id, repeats);
  // Citing the line makes it part of what is shared.
  const { parcel } = parcelOf(a.store, titled([1, 2]).id);
  assert.deepEqual(parcel.session.messages.map(message => message.line), [1, 2]);
  // A short line is ordinary words, not a quotation.
  const b = ledger(t, 'short');
  const session = b.store.importTranscript({ provider: 'claude', source: 'short.jsonl',
    transcript: claude([['user', 'Port 6100'], ['assistant', 'The relay ships on port 6100 from Friday.']]) });
  const graph = b.store.publishGraph({ version: 2, sessionId: session.id, party: 'vera', edges: [],
    nodes: [{ id: 'port', kind: 'decision', label: 'Port 6100', evidenceLines: [2] }] });
  assert.equal(serializeParcel(parcelOf(b.store, graph.id).parcel).includes('"line":1'), false);
  // A long uncited line is found by its first 120 characters, as a title is.
  const long = 'The Orion rollout waits for the adapter review, then the smoke test, then the sign-off from the Vega team, and only after that the Friday demo recording.';
  const c = ledger(t, 'long');
  const longSession = c.store.importTranscript({ provider: 'claude', source: 'long.jsonl', transcript: claude([['user', long], ['assistant', 'Understood.']]) });
  const quoted = c.store.publishGraph({ version: 2, sessionId: longSession.id, party: 'vera', edges: [],
    nodes: [{ id: 'plan', kind: 'decision', label: [...long].slice(0, 130).join(''), evidenceLines: [2] }] });
  refusedShare(c.store, quoted.id, repeats);
});

test('R1 review: a parcel carries exactly what its graph cites, whatever the receiver already has', t => {
  const a = ledger(t, 'a');
  const session = a.store.importTranscript({ provider: 'claude', source: 'vera.jsonl', transcript: claude(veraTurns), project: 'lyra' });
  const commit = a.store.registerArtifact({ project: 'lyra', kind: 'commit', repo: 'orbit-labs/adapter', ref: '6100abcdef0' });
  const other = a.store.registerArtifact({ project: 'lyra', kind: 'pr', repo: 'orbit-labs/adapter', ref: '61' });
  const graph = a.store.publishGraph({ version: 3, sessionId: session.id, party: 'vera', edges: [],
    nodes: [{ id: 'port', kind: 'decision', label: 'Port 6100', evidence: [{ message: key(2) }, { message: key(3) }, { artifact: commit.id }] }] });
  const { parcel } = parcelOf(a.store, graph.id);
  const older = a.store.publishGraph(veraGraph(session.id));
  const notExact = 'A parcel must carry exactly the lines and artifacts its graph cites.';

  // B already has everything: the whole transcript and both artifacts. The parcel must still be complete.
  const b = ledger(t, 'b');
  b.store.importTranscript({ provider: 'claude', source: 'vera.jsonl', transcript: claude(veraTurns), project: 'lyra' });
  b.store.registerArtifact({ project: 'lyra', kind: 'commit', repo: 'orbit-labs/adapter', ref: '6100abcdef0' });
  // C has the same lines as excerpts from an earlier parcel.
  const c = ledger(t, 'c');
  carry(a.store, c.store, older.id);
  for (const target of [b, c]) {
    const before = target.dump();
    for (const change of [
      p => { p.session.messages.pop(); },
      p => { p.session.messages.push({ key: key(5), line: 5, role: 'user', text: 'Record the demo on Friday.' }); },
      p => { p.artifacts = []; },
      p => { p.artifacts.push({ kind: other.kind, repo: other.repo, ref: other.ref }); },
      p => { p.artifacts.push(p.artifacts[0]); },
      p => { p.artifacts[0].ref = '6100abcdef1'; },
      // An artifact's ID covers its project, so another project's slug gives other IDs.
      p => { p.project = 'vela'; },
    ]) {
      const copy = clone(parcel);
      change(copy);
      assert.throws(() => target.store.receiveParcel(checkParcel(copy)), error => error instanceof InputError && error.message === notExact);
      assert.equal(target.dump(), before);
    }
    assert.equal(receive(target.store, parcel).graph.id, graph.id);
  }
  // The same for line citations.
  const lines = parcelOf(a.store, older.id).parcel;
  for (const change of [p => { p.session.messages.shift(); }, p => { p.session.messages.push({ key: key(5), line: 5, role: 'user', text: 'Record the demo on Friday.' }); }]) {
    const copy = clone(lines);
    change(copy);
    assert.throws(() => checkParcel(copy), error => error instanceof InputError && error.message === notExact);
  }
});

test('R1 review: text that is not the transcript\'s, or a redaction of it, is a conflict', t => {
  const a = vera(t, [2, 4]);
  const { parcel } = parcelOf(a.store, a.graph.id);
  const mismatch = 'The parcel\'s lines do not match the session of the same ID in this ledger, so the parcel was not stored.';
  const altered = clone(parcel);
  altered.session.messages[0].text = 'The relay ships on port 6200.';

  // Where the transcript is imported: the parcel's text must be its text, or a redaction of it.
  const b = ledger(t, 'b');
  b.store.importTranscript({ provider: 'claude', source: 'vera.jsonl', transcript: claude(veraTurns) });
  const before = b.dump();
  assert.throws(() => b.store.receiveParcel(checkParcel(altered)), error => error instanceof ConflictError && error.message === mismatch);
  assert.equal(b.dump(), before);
  assert.equal(receive(b.store, parcel).added, 0, 'the redacted line 4 matches its original');

  // Excerpts first, then the real file: altered text is not swapped for the file's without a word.
  const c = ledger(t, 'c');
  c.store.receiveParcel(checkParcel(altered));
  const held = c.dump();
  assert.throws(() => c.store.importTranscript({ provider: 'claude', source: 'vera.jsonl', transcript: claude(veraTurns) }),
    error => error instanceof ConflictError && error.message.startsWith('This ledger holds excerpts received from another machine'));
  assert.equal(c.dump(), held);
  // A second parcel that shows another text for a line the excerpts have.
  assert.throws(() => c.store.receiveParcel(checkParcel(parcel)), error => error instanceof ConflictError && error.message === mismatch);
  assert.equal(c.dump(), held);

  // Two parcels may redact the same line differently; the stored one stays.
  const d = ledger(t, 'd');
  const unredacted = clone(parcel);
  unredacted.session.messages[1].text = 'The staging token is [REDACTED assigned-secret] for [REDACTED bearer-token].';
  receive(d.store, parcel);
  const stored = d.store.get(a.session.id).messages[1].text;
  assert.equal(d.store.receiveParcel(checkParcel(unredacted)).added, 0);
  assert.equal(d.store.get(a.session.id).messages[1].text, stored);
});

test('R1 review: an agent turn\'s author and recipient are compared as its text is', t => {
  const a = ledger(t, 'a');
  const codex = (role, text) => JSON.stringify({ type: 'response_item', payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] } });
  const agent = (author, recipient, text) => JSON.stringify({ type: 'response_item', payload: { type: 'agent_message', author, recipient, content: [{ type: 'input_text', text }] } });
  const transcript = [codex('user', 'Check the Orion build before the demo.'), agent('/root', '/root/worker', 'Run the Orion smoke test on port 6100.')].join('\n');
  const session = a.store.importTranscript({ provider: 'codex', source: 'orion.jsonl', transcript });
  const graph = a.store.publishGraph({ version: 2, sessionId: session.id, party: 'orion', edges: [],
    nodes: [{ id: 'smoke', kind: 'action', status: 'pending', label: 'Smoke test', evidenceLines: [2] }] });
  const { parcel } = parcelOf(a.store, graph.id);
  const b = ledger(t, 'b');
  b.store.importTranscript({ provider: 'codex', source: 'orion.jsonl', transcript });
  const forged = clone(parcel);
  forged.session.messages[0].author = '/root/other';
  assert.throws(() => b.store.receiveParcel(checkParcel(forged)), ConflictError);
  const c = ledger(t, 'c');
  c.store.receiveParcel(checkParcel(forged));
  assert.throws(() => c.store.importTranscript({ provider: 'codex', source: 'orion.jsonl', transcript }), ConflictError);
  assert.equal(c.store.get(session.id).excerpts, true);
});

test('R1 review: matchesRedacted accepts a text or a redaction of it and nothing else', () => {
  const m = '[REDACTED github-token]';
  const yes = [
    ['same', 'same'], [`a ${m} b`, 'a SECRET b'], [m, 'x'], [`${m} tail`, 'S tail'], [`head ${m}`, 'head S'],
    [`a ${m} b ${m} c`, 'a 1 b 2 c'], [`${m}${m}`, 'ab'], [`a ${m} b`, `a ${m} b`], [`x ${m} b b`, 'x b b b b'],
    [`a [REDACTED jwt] b`, `a ${m} b`],
  ];
  const no = [
    ['same', 'other'], [`a ${m} b`, 'a b'], [m, ''], [`a ${m} b`, 'a SECRET c'], [`a ${m} b`, 'x SECRET b'],
    [`a ${m} b ${m} c`, 'a 1 c'], [`${m}${m}`, 'a'], ['a [REDACTED Not A Kind] b', 'a SECRET b'], [`a ${m} b`, 'a b'],
    ['port 6200', 'port 6100'], [`${m} b`, 'b'],
  ];
  for (const [shown, original] of yes) assert.equal(matchesRedacted(shown, original), true, `${shown} | ${original}`);
  for (const [shown, original] of no) assert.equal(matchesRedacted(shown, original), false, `${shown} | ${original}`);
  // Many markers against a long text stay fast: no backtracking.
  const started = performance.now();
  assert.equal(matchesRedacted(`${`${m}aab`.repeat(2000)}${m}`, `${'a'.repeat(200_000)}x`), false);
  assert.ok(performance.now() - started < 2000);
});

test('R1 review: an import that waits on a receive completes the excerpts it then finds', async t => {
  const a = vera(t);
  const b = ledger(t, 'b');
  const source = ledger(t, 'c');
  carry(a.store, source.store, a.graph.id);
  source.store.close();
  b.store.close();
  const file = join(b.folder, 'vera.jsonl');
  writeFileSync(file, claude(veraTurns));

  // Another process holds the write lock while it receives a parcel of this very session.
  const raw = new DatabaseSync(b.path);
  let child;
  try {
    raw.exec(`ATTACH '${source.path.replaceAll('\'', '\'\'')}' AS other; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE;`);
    child = run(['import', '--provider', 'claude', file], b.env);
    // The import parses the file, then waits for the lock (busy_timeout is 5 s).
    await new Promise(resolve => setTimeout(resolve, 1500));
    raw.exec(`
      INSERT INTO messages (session_id, seq, line, role, text_json, key, author_json, recipient_json)
        SELECT session_id, seq, line, role, text_json, key, author_json, recipient_json FROM other.messages;
      INSERT INTO sessions (id, provider, source, title, message_count, messages, search_text, project_id)
        SELECT id, provider, source, title, message_count, messages, search_text, (SELECT id FROM projects WHERE slug = 'default') FROM other.sessions;
      INSERT INTO session_excerpts SELECT * FROM other.session_excerpts;
      COMMIT;
    `);
  } finally {
    raw.close();
  }
  const result = await child;
  assert.equal(result.code, 0, result.stderr);
  const { session } = JSON.parse(result.stdout);
  assert.deepEqual(session, { id: a.session.id, provider: 'claude', source: 'vera.jsonl',
    title: 'Vera: an aside that no graph cites, about the Lyra budget.', messageCount: 5, project: 'default' });
  const check = new DatabaseSync(b.path, { readOnly: true });
  try {
    assert.equal(check.prepare('SELECT count(*) AS n FROM session_excerpts').get().n, 0);
    assert.equal(check.prepare('SELECT count(*) AS n FROM messages').get().n, 5);
  } finally {
    check.close();
  }
});

test('R1 review: a graph that cites more text than a parcel holds is refused by share, not by receive', t => {
  const a = ledger(t, 'a');
  const big = 'Orion log line. '.repeat(Math.ceil((maxParcelBytes + 1024) / 16));
  const session = a.store.importTranscript({ provider: 'claude', source: 'big.jsonl', transcript: claude([['user', 'Keep the Orion log.'], ['assistant', big]]) });
  const graph = a.store.publishGraph({ version: 2, sessionId: session.id, party: 'vera', edges: [],
    nodes: [{ id: 'log', kind: 'decision', label: 'Keep the Orion log', evidenceLines: [2] }] });
  refusedShare(a.store, graph.id, 'This graph cites more text than a parcel can carry (8 MiB), so it was not shared.');
});

test('R1 review: a stored graph whose citation snapshot does not match its packet is not shared', t => {
  const a = ledger(t, 'a');
  const session = a.store.importTranscript({ provider: 'claude', source: 'vera.jsonl', transcript: claude(veraTurns) });
  const commit = a.store.registerArtifact({ kind: 'commit', repo: 'orbit-labs/adapter', ref: '6100abcdef0' });
  const graph = a.store.publishGraph({ version: 3, sessionId: session.id, party: 'vera', edges: [],
    nodes: [{ id: 'port', kind: 'decision', label: 'Port 6100', evidence: [{ message: key(2) }, { artifact: commit.id }] }] });
  // An odd payload: the snapshot names line 5 and no artifact; the packet still cites key 2 and the commit.
  const raw = new DatabaseSync(a.path);
  raw.prepare('UPDATE graphs SET payload = json_set(payload, \'$.citations\', json(?)) WHERE id = ?')
    .run(JSON.stringify([{ id: 'port', lines: [5], artifacts: [] }]), graph.id);
  raw.close();
  refusedShare(a.store, graph.id, 'This graph\'s stored citations do not match its packet, so it was not shared.');
  // With the snapshot's artifacts intact, the lines come from the packet's keys, not from the snapshot.
  const fixed = new DatabaseSync(a.path);
  fixed.prepare('UPDATE graphs SET payload = json_set(payload, \'$.citations\', json(?)) WHERE id = ?')
    .run(JSON.stringify([{ id: 'port', lines: [5], artifacts: [{ id: commit.id, kind: 'commit', repo: 'orbit-labs/adapter', ref: '6100abcdef0' }] }]), graph.id);
  fixed.close();
  assert.deepEqual(parcelOf(a.store, graph.id).parcel.session.messages.map(message => message.line), [2]);
});

test('R1 review: a parcel refused for what it holds creates and upgrades no database', async t => {
  const a = vera(t);
  const { parcel } = parcelOf(a.store, a.graph.id);
  const b = ledger(t, 'b');
  b.store.close();
  const wrongId = clone(parcel);
  wrongId.graph.id = 'f'.repeat(64);
  const file = join(b.folder, 'wrong.json');
  writeFileSync(file, serializeParcel(wrongId));

  const absent = join(b.folder, 'none', 'ledger.sqlite');
  const none = await run(['receive', file], { CONTEXT_LEDGER_DB: absent });
  assert.equal(none.stderr, 'The parcel\'s graph ID does not match its packet.\n');
  assert.equal(existsSync(absent), false);
  assert.equal(existsSync(join(b.folder, 'none')), false);

  const raw = new DatabaseSync(b.path);
  raw.exec('DROP TABLE session_excerpts; PRAGMA user_version = 7;');
  raw.close();
  const old = await run(['receive', file], b.env);
  assert.equal(old.stderr, 'The parcel\'s graph ID does not match its packet.\n');
  const check = new DatabaseSync(b.path, { readOnly: true });
  try {
    assert.equal(check.prepare('PRAGMA user_version').get().user_version, 7);
  } finally {
    check.close();
  }
});

test('R1 review: invisible characters in a carried line are written as escapes and read back unchanged', t => {
  const a = ledger(t, 'a');
  const odd = ['Deploy on Friday', String.fromCodePoint(0x202e), 'yadnuS', String.fromCodePoint(0x85, 0x2028, 0xe0041, 0x200d), ' as agreed.'].join('');
  const session = a.store.importTranscript({ provider: 'claude', source: 'odd.jsonl', transcript: claude([['user', odd]]) });
  const graph = a.store.publishGraph({ version: 2, sessionId: session.id, party: 'vera', edges: [],
    nodes: [{ id: 'when', kind: 'decision', label: 'Deploy on Friday', evidenceLines: [1] }] });
  const { parcel, text } = parcelOf(a.store, graph.id);
  assert.equal(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(text.slice(0, -1)), false);
  for (const escape of ['202e', '0085', '2028', 'db40', 'dc41', '200d']) assert.equal(text.includes('\\u' + escape), true, escape);
  assert.equal(text, serializeParcel(parcel));
  const b = ledger(t, 'b');
  b.store.receiveParcel(parseParcel(Buffer.from(text)));
  assert.equal(b.store.get(session.id).messages[0].text, odd);
});

test('R1 review: the savings meter says when its baseline is excerpts', t => {
  const a = vera(t);
  const b = ledger(t, 'b');
  carry(a.store, b.store, a.graph.id);
  const there = b.store.getGraphContext(a.graph.id);
  const here = a.store.getGraphContext(a.graph.id);
  assert.equal(there.graphId, a.graph.id);
  assert.equal(there.meter.baseline, 'excerpts');
  assert.equal('baseline' in here.meter, false);
  assert.ok(there.meter.handoffTokens < here.meter.handoffTokens);
});

test('R1 review: share escapes an odd output path on the terminal', { skip: process.platform === 'win32' && 'Windows file names cannot hold control characters' }, async t => {
  const a = vera(t);
  a.store.close();
  const file = join(a.folder, `odd${escape}[31m.json`);
  const shared = await run(['share', a.graph.id, '--out', file], a.env);
  assert.equal(shared.code, 0, shared.stderr);
  assert.equal(shared.stdout.includes(escape), false);
  assert.equal(shared.stdout.split('\n')[0].endsWith('odd\\u001b[31m.json'), true);
  assert.equal(existsSync(file), true);
});

test('R1 review: the CLI search and hand-off and the MCP session tools show the excerpts mark', async t => {
  const a = vera(t);
  const b = ledger(t, 'b');
  carry(a.store, b.store, a.graph.id);
  b.store.close();
  const server = spawn(process.execPath, ['src/server.mjs'], { env: { ...process.env, PORT: '0', CONTEXT_LEDGER_DB: b.path }, stdio: ['ignore', 'pipe', 'ignore'] });
  let client;
  // Closed here, not in a hook: the ledger's own hook removes the folder first, and the
  // server must have let go of the database by then.
  try {
    let port;
    let output = '';
    for await (const chunk of server.stdout) {
      output += chunk;
      port = /listening at http:\/\/127\.0\.0\.1:(\d+)/u.exec(output)?.[1];
      if (port) break;
    }
    assert.ok(port, 'the server listens');
    const env = { ...b.env, PORT: port };
    const mark = 'Excerpts: only the lines a shared graph cites, received from another machine.';

    const found = await run(['search', 'sunday'], env);
    assert.equal(found.code, 0, found.stderr);
    assert.deepEqual(JSON.parse(found.stdout).map(({ id, excerpts }) => ({ id, excerpts })), [{ id: a.session.id, excerpts: true }]);
    const handoff = await run(['handoff', a.session.id], env);
    assert.equal(handoff.stdout.split('\n').includes(mark), true);

    client = startMcp(Number(port), b.env);
    await client.request(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {} });
    client.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const listed = await client.call(2, 'session_search', { query: 'sunday' });
    assert.equal(JSON.parse(listed.content[0].text).sessions[0].excerpts, true);
    const read = await client.call(3, 'session_read', { sessionId: a.session.id });
    assert.equal(read.content[0].text.split('\n').includes(mark), true);
    assert.equal(read.content[0].text.includes('aside'), false);
  } finally {
    try {
      if (client && client.child.exitCode === null) await client.close();
    } finally {
      server.kill();
      if (server.exitCode === null && server.signalCode === null) await once(server, 'exit');
    }
  }
});

// ---- Codex review, round 2 ----

test('R1 review 2: a credential in the project slug stops the share', t => {
  const a = ledger(t, 'a');
  // A slug of the shape of a Slack token, put together from fragments.
  const project = ['xo', 'xb-', '1234567890-', 'synthetic'].join('');
  const session = a.store.importTranscript({ provider: 'claude', source: 'vera.jsonl', transcript: claude(veraTurns), project });
  const graph = a.store.publishGraph(veraGraph(session.id));
  refusedShare(a.store, graph.id, 'This graph\'s own text (a label, a name, an artifact or its project) holds what looks like a credential, so it was not shared.');
});

test('R1 review 2: the label guard reads a title as the ledger makes it, and each line of a turn', t => {
  const repeats = 'A label of this graph repeats a transcript line the graph does not cite, so it was not shared. Cite that line or reword the label.';
  const a = ledger(t, 'a');
  // The title is made after leading white space is dropped, however much there is.
  const first = `${' '.repeat(5000)}Cancel the confidential Orion acquisition.`;
  const multiline = 'Notes for the week.\nThe Vega contract is void from Monday.\nNothing else.';
  const session = a.store.importTranscript({ provider: 'claude', source: 'orion.jsonl',
    transcript: claude([['user', first], ['assistant', 'Understood, port 6100 stays.'], ['user', multiline]]) });
  assert.equal(session.title, 'Cancel the confidential Orion acquisition.');
  const labelled = label => a.store.publishGraph({ version: 2, sessionId: session.id, party: 'vera', edges: [],
    nodes: [{ id: 'note', kind: 'decision', label, evidenceLines: [2] }] });
  refusedShare(a.store, labelled(session.title).id, repeats);
  refusedShare(a.store, labelled('Agreed: the Vega contract is void from Monday.').id, repeats);
  assert.equal(parcelOf(a.store, labelled('Port 6100 stays').id).parcel.session.messages.length, 1);

  // Words the parcel carries anyway are not a leak, wherever else the session says them.
  const b = ledger(t, 'b');
  const twice = b.store.importTranscript({ provider: 'claude', source: 'twice.jsonl',
    transcript: claude([['user', 'Approved for the Friday release.'], ['assistant', 'Approved for the Friday release.']]) });
  const quoted = b.store.publishGraph({ version: 2, sessionId: twice.id, party: 'vera', edges: [],
    nodes: [{ id: 'ok', kind: 'decision', label: 'Approved for the Friday release.', evidenceLines: [2] }] });
  assert.deepEqual(parcelOf(b.store, quoted.id).parcel.session.messages.map(message => message.line), [2]);
});

test('R1 review 2: matchesRedacted works on whole characters and in linear time', () => {
  const m = '[REDACTED assigned-secret]';
  const face = String.fromCodePoint(0x1f600);
  // One character is one marker's worth, though it is two code units.
  assert.equal(matchesRedacted(m + m, face), false);
  assert.equal(matchesRedacted(m + m, face + face), true);
  assert.equal(matchesRedacted(m, face), true);
  assert.equal(matchesRedacted(face.slice(0, 1) + m, face), false);
  assert.equal(matchesRedacted(m + face.slice(1), face), false);
  assert.equal(matchesRedacted(`a${m}${face}`, `a${face}${face}`), true);
  assert.equal(matchesRedacted(`${m}b${m}`, `${face}b${face}`), true);
  // A long near-match, repeated, was quadratic with a plain search.
  const time = n => {
    const shown = `${m}${'a'.repeat(n / 8)}b${'a'.repeat(n / 8)}${m}`;
    const original = `x${'a'.repeat(n)}y`;
    const started = performance.now();
    assert.equal(matchesRedacted(shown, original), false);
    return performance.now() - started;
  };
  time(1 << 14);
  const small = Math.max(time(1 << 17), 1);
  const large = time(1 << 20);
  assert.ok(large < small * 40, `8 times the text took ${Math.round(large / small)} times as long`);
  assert.ok(large < 3000, `${Math.round(large)} ms`);
});

test('R1 review 2: two sets of excerpts agree when each field is equal or one is the more redacted', () => {
  const m = '[REDACTED assigned-secret]';
  const turn = (text, author = '/root', recipient = '/root/worker') => ({ line: 2, role: 'agent', text, author, recipient });
  // The text is more redacted on one side and the author on the other.
  assert.equal(compatibleTurns(turn(`token ${m}`, '/root/abc'), turn('token B', `/root/${m}`)), true);
  assert.equal(compatibleTurns(turn('token A'), turn('token B')), false);
  assert.equal(compatibleTurns(turn('token A'), { ...turn('token A'), line: 3 }), false);
  // Redacted in different places: not recognised, and docs/parcels.md says so.
  assert.equal(compatibleTurns(turn(`password=${m}; token=B`), turn(`password=A; token=${m}`)), false);
  // Against the transcript every field goes one way.
  assert.equal(sameTurn(turn(`token ${m}`, `/root/${m}`), turn('token B', '/root/abc')), true);
  assert.equal(sameTurn(turn(`token ${m}`, '/root/abc'), turn('token B', `/root/${m}`)), false);
});

test('R1 review 2: what a parcel decides by itself is refused before a ledger is opened', async t => {
  const a = vera(t);
  const { parcel } = parcelOf(a.store, a.graph.id);
  const b = ledger(t, 'b');
  const before = b.dump();
  const changed = change => {
    const copy = clone(parcel);
    change(copy);
    return copy;
  };
  // A packet that is not a valid graph, with the ID such a packet would have.
  const twoNodes = changed(p => {
    p.graph.packet.nodes.push({ ...p.graph.packet.nodes[0] });
    p.graph.id = packetId(p.graph.packet);
  });
  assert.throws(() => checkParcel(twoNodes), error => error instanceof GraphInputError && error.message === 'Node IDs must be unique.');
  const cycle = changed(p => {
    p.graph.packet.nodes = [
      { id: 'one', kind: 'action', status: 'pending', label: 'One', evidenceLines: [2] },
      { id: 'two', kind: 'action', status: 'pending', label: 'Two', evidenceLines: [3] },
    ];
    p.graph.packet.edges = [{ from: 'one', to: 'two', type: 'depends_on' }, { from: 'two', to: 'one', type: 'depends_on' }];
    p.graph.id = packetId(p.graph.packet);
  });
  assert.throws(() => checkParcel(cycle), GraphInputError);
  const notParcel = error => error instanceof InputError && error.message === 'This is not a version 1 Context Ledger parcel.';
  for (const source of ['..', '.', ' padded.jsonl', 'folder/vera.jsonl', 'folder\\vera.jsonl', String.fromCodePoint(0x1f600).repeat(128)]) {
    assert.throws(() => checkParcel(changed(p => { p.session.source = source; })), notParcel, source);
  }
  // The store checks a parcel itself, whoever calls it.
  assert.throws(() => b.store.receiveParcel(twoNodes), GraphInputError);
  assert.throws(() => b.store.receiveParcel(changed(p => { p.session.messages.pop(); })),
    error => error instanceof InputError && error.message === 'A parcel must carry exactly the lines and artifacts its graph cites.');
  assert.equal(b.dump(), before);

  // And the command creates no database for such a file.
  b.store.close();
  const file = join(b.folder, 'two-nodes.json');
  writeFileSync(file, serializeParcel(twoNodes));
  const absent = join(b.folder, 'none', 'ledger.sqlite');
  const result = await run(['receive', file], { CONTEXT_LEDGER_DB: absent });
  assert.equal(result.code, 1);
  assert.equal(result.stderr, 'Node IDs must be unique.\n');
  assert.equal(existsSync(join(b.folder, 'none')), false);
});

test('R1 review 2: a source name that redaction makes too long travels under a fixed name', t => {
  const a = ledger(t, 'a');
  const source = `${'a'.repeat(238)}-password=q`;
  const session = a.store.importTranscript({ provider: 'claude', source, transcript: claude(veraTurns) });
  assert.equal(session.source, source);
  const graph = a.store.publishGraph(veraGraph(session.id));
  const { parcel, redacted } = parcelOf(a.store, graph.id);
  assert.equal(parcel.session.source, 'source name redacted');
  assert.equal(redacted, 1);
  const b = ledger(t, 'b');
  assert.equal(receive(b.store, parcel).session.source, 'source name redacted');
  // A shorter name keeps its redacted form.
  const c = ledger(t, 'c');
  const short = c.store.importTranscript({ provider: 'claude', source: 'notes-password=q', transcript: claude(veraTurns) });
  const named = parcelOf(c.store, c.store.publishGraph(veraGraph(short.id)).id).parcel.session.source;
  assert.match(named, /^notes-password=\[REDACTED [a-z-]+\]$/u);
});

// ---- Codex review, round 3 ----

test('R1 review 3: the label guard sees every kind of line break and folds case one character at a time', t => {
  const repeats = 'A label of this graph repeats a transcript line the graph does not cite, so it was not shared. Cite that line or reword the label.';
  const sentence = 'Uncited synthetic budget sentence';
  for (const code of [0x2028, 0x2029, 0x85, 0x0b, 0x0c]) {
    const a = ledger(t, `break-${code}`);
    const session = a.store.importTranscript({ provider: 'claude', source: 'breaks.jsonl',
      transcript: claude([['user', `Prelude${String.fromCodePoint(code)}${sentence}`], ['assistant', 'Port 6100 stays.']]) });
    const graph = a.store.publishGraph({ version: 2, sessionId: session.id, party: 'vera', edges: [],
      nodes: [{ id: 'note', kind: 'decision', label: sentence, evidenceLines: [2] }] });
    refusedShare(a.store, graph.id, repeats);
  }
  // A capital sigma lower-cases differently at the end of a word; the lead ends on one.
  const sigma = String.fromCodePoint(0x03a3);
  const line = `${'A'.repeat(119)}${sigma}B`;
  const b = ledger(t, 'sigma');
  const session = b.store.importTranscript({ provider: 'claude', source: 'sigma.jsonl', transcript: claude([['user', line], ['assistant', 'Port 6100 stays.']]) });
  const graph = b.store.publishGraph({ version: 2, sessionId: session.id, party: 'vera', edges: [],
    nodes: [{ id: 'note', kind: 'decision', label: line, evidenceLines: [2] }] });
  refusedShare(b.store, graph.id, repeats);
});

test('R1 review 3: the label guard\'s work does not grow with the number of uncited lines', t => {
  const a = ledger(t, 'a');
  const turns = [['user', 'Port 6100 stays.']];
  for (let index = 0; index < 3000; index += 1) turns.push([index % 2 ? 'user' : 'assistant', `${'a'.repeat(20)}${index}`]);
  const transcript = turns.map(([role, text]) => JSON.stringify({ type: role, message: { role, content: text } })).join('\n');
  const session = a.store.importTranscript({ provider: 'claude', source: 'many.jsonl', transcript });
  const nodes = Array.from({ length: 100 }, (_, index) => ({ id: `n${index}`, kind: 'decision', label: `${'a'.repeat(480)} ${index}`, evidenceLines: [1] }));
  const graph = a.store.publishGraph({ version: 2, sessionId: session.id, party: 'vera', edges: [], nodes });
  const started = performance.now();
  assert.equal(parcelOf(a.store, graph.id).parcel.session.messages.length, 1);
  assert.ok(performance.now() - started < 3000, `${Math.round(performance.now() - started)} ms`);
});

test('R1 review 3: an agent path that redaction makes long still travels', t => {
  const a = ledger(t, 'a');
  const author = 'pwd=q\n'.repeat(33);
  const transcript = [
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Check the Orion build.' }] } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'agent_message', author, recipient: '/root', content: [{ type: 'input_text', text: 'The smoke test passed.' }] } }),
  ].join('\n');
  const session = a.store.importTranscript({ provider: 'codex', source: 'orion.jsonl', transcript });
  assert.equal(a.store.get(session.id).messages[1].author, author);
  const graph = a.store.publishGraph({ version: 2, sessionId: session.id, party: 'orion', edges: [],
    nodes: [{ id: 'smoke', kind: 'action', status: 'completed', label: 'Smoke test passed', evidenceLines: [2] }] });
  const { parcel, redacted } = parcelOf(a.store, graph.id);
  assert.ok(parcel.session.messages[0].author.length > 400);
  assert.equal(redacted, 33);
  const b = ledger(t, 'b');
  assert.equal(receive(b.store, parcel).graph.id, graph.id);
  // The real file completes those excerpts: each marker stands for its value.
  assert.equal(b.store.importTranscript({ provider: 'codex', source: 'orion.jsonl', transcript }).excerpts, undefined);
  assert.equal(b.store.get(session.id).messages[1].author, author);
});

test('R1 review 3: what a link says about its own packet is checked before a ledger is opened', t => {
  const a = vera(t);
  const { parcel } = parcelOf(a.store, a.graph.id);
  const linked = links => {
    const copy = clone(parcel);
    copy.graph.packet.links = links;
    copy.graph.id = packetId(copy.graph.packet);
    return copy;
  };
  const other = 'b'.repeat(64);
  assert.throws(() => checkParcel(linked([{ from: 'missing', graph: other, to: 'remote', type: 'matches' }])), GraphInputError);
  assert.throws(() => checkParcel(linked([{ from: 'no-sunday', graph: other, to: 'remote', type: 'matches' }])), GraphInputError, 'a constraint cannot match');
  assert.throws(() => checkParcel(linked([
    { from: 'no-sunday', graph: other, to: 'remote', type: 'conflicts' }, { from: 'no-sunday', graph: other, to: 'remote', type: 'conflicts' },
  ])), GraphInputError);
  // A link that is right in itself waits for the ledger, which says what is missing.
  const fine = linked([{ from: 'no-sunday', graph: other, to: 'remote', type: 'conflicts' }]);
  assert.equal(checkParcel(fine), fine);
  const b = ledger(t, 'b');
  assert.throws(() => b.store.receiveParcel(fine), error => error instanceof InputError
    && error.message === 'This graph links to a graph that is not in this ledger. Receive that graph first.');
});

// ---- Codex review, round 4 ----

test('R1 review 4: the label guard compares leads and labels in one normal form', t => {
  const repeats = 'A label of this graph repeats a transcript line the graph does not cite, so it was not shared. Cite that line or reword the label.';
  const guarded = (name, uncited, label) => {
    const a = ledger(t, name);
    const session = a.store.importTranscript({ provider: 'claude', source: 'form.jsonl', transcript: claude([['user', uncited], ['assistant', 'Port 6100 stays.']]) });
    const graph = a.store.publishGraph({ version: 2, sessionId: session.id, party: 'vera', edges: [],
      nodes: [{ id: 'note', kind: 'decision', label, evidenceLines: [2] }] });
    return () => parcelOf(a.store, graph.id);
  };
  const refused = (name, uncited, label) => assert.throws(guarded(name, uncited, label), error => error instanceof InputError && error.message === repeats, name);
  const point = code => String.fromCodePoint(code);
  // Both lower-case forms of the Greek sigma are one letter.
  const logos = [0x39b, 0x39f, 0x393, 0x39f, 0x3a3].map(point).join('');
  const lower = [0x3bb, 0x3bf, 0x3b3, 0x3bf].map(point).join('');
  refused('final-sigma', `THE PLAN SAYS ${logos} TODAY`, `the plan says ${lower}${point(0x3c2)} today`);
  refused('plain-sigma', `the plan says ${lower}${point(0x3c2)} today`, `THE PLAN SAYS ${logos} TODAY`);
  // NEL is white space in a lead, as it is a line break.
  refused('nel', `Private planning${point(0x85)}budget forty two`, 'Private planning budget forty two');
  // A lead cut on the space between two words, and a label that ends there.
  refused('cut-on-space', `${'A'.repeat(119)} B and more`, 'A'.repeat(119));
  refused('cut-after-space', `${'A'.repeat(118)} B and more words here`, `${'A'.repeat(118)} B`);
  // The 20 characters are counted as written: a letter that lower-cases to two does not make 19 into 20.
  assert.equal(guarded('expanding', `${'a'.repeat(18)}${point(0x130)}`, `${'a'.repeat(18)}${point(0x130)}`)().parcel.session.messages.length, 1);
});

// ---- Codex review of the 2026-11-27 refresh, round 2 ----

test('R1 refresh review: a label that copies a value the scanner found by its context is not shared', t => {
  // Put together from fragments, so no committed line holds a whole assignment.
  const value = ['fixture', 'value', '7341'].join('-');
  const assignment = ['pass', 'word=', value].join('');
  const a = ledger(t, 'a');
  const session = a.store.importTranscript({ provider: 'claude', source: 'kai.jsonl', transcript: claude([
    ['user', 'Kai: the deploy notes for the Lyra cluster.'],
    ['assistant', `Set ${assignment} on the staging box.`],
    ['user', 'And keep the relay on port 6100.'],
  ]) });
  const repeated = 'This graph\'s own text (a label, a name, an artifact or its project) repeats a value the secret scanner found in its transcript, so it was not shared.';
  // The value alone does not look like a credential, so the first check passes it.
  const cited = a.store.publishGraph({ version: 2, sessionId: session.id, party: 'kai', edges: [],
    nodes: [{ id: 'secret', kind: 'decision', label: `Staging uses ${value}`, evidenceLines: [2] }] });
  refusedShare(a.store, cited.id, repeated);
  // A value from a line the graph does not cite counts too.
  const uncited = a.store.publishGraph({ version: 2, sessionId: session.id, party: 'kai', edges: [],
    nodes: [{ id: 'port', kind: 'decision', label: `Port 6100, then ${value}`, evidenceLines: [3] }] });
  refusedShare(a.store, uncited.id, repeated);
  // Without the value, the same lines are shared, and the cited one is redacted.
  const plain = a.store.publishGraph({ version: 2, sessionId: session.id, party: 'kai', edges: [],
    nodes: [{ id: 'secret', kind: 'decision', label: 'Staging has a password', evidenceLines: [2] }] });
  const { parcel } = parcelOf(a.store, plain.id);
  assert.equal(serializeParcel(parcel).includes(value), false);
});

test('R1 refresh review: a legacy key that came in a parcel gives way to the real key when no graph cites it by key', t => {
  const a = vera(t);
  const { parcel } = parcelOf(a.store, a.graph.id);
  const legacy = clone(parcel);
  for (const message of legacy.session.messages) message.key = `l:${message.line}`;

  // A version 3 parcel from a fresh import, citing the same turns by their real keys.
  const v3 = a.store.publishGraph({ version: 3, sessionId: a.session.id, party: 'vera', edges: [],
    nodes: [{ id: 'port', kind: 'decision', label: 'Port 6100', evidence: [{ message: key(2) }, { message: key(3) }] }] });
  const b = ledger(t, 'b');
  b.store.receiveParcel(checkParcel(legacy));
  assert.deepEqual(b.store.get(a.session.id).messages.map(message => message.key), ['l:2', 'l:3']);
  const result = carry(a.store, b.store, v3.id);
  assert.equal(result.added, 0);
  assert.deepEqual(b.store.get(a.session.id).messages.map(message => message.key), [key(2), key(3)]);
  assert.equal(b.store.getGraph(a.graph.id).packet.version, 2, 'the line-cited graph still holds');

  // The full transcript replaces an uncited legacy key with its own.
  const c = ledger(t, 'c');
  c.store.receiveParcel(checkParcel(legacy));
  c.store.importTranscript({ provider: 'claude', source: 'vera.jsonl', transcript: claude(veraTurns) });
  assert.deepEqual(c.store.get(a.session.id).messages.map(message => message.key), [1, 2, 3, 4, 5].map(key));

  // A legacy key a stored version 3 graph cites stays, and a parcel with the real key is refused.
  const d = ledger(t, 'd');
  d.store.receiveParcel(checkParcel(legacy));
  d.store.publishGraph({ version: 3, sessionId: a.session.id, party: 'vera', edges: [],
    nodes: [{ id: 'port', kind: 'decision', label: 'Port 6100', evidence: [{ message: 'l:2' }] }] });
  const dump = d.dump();
  assert.throws(() => carry(a.store, d.store, v3.id), ConflictError);
  assert.equal(d.dump(), dump);
});

test('R1 refresh review: a legacy key must name its own line', t => {
  const a = vera(t);
  const { parcel } = parcelOf(a.store, a.graph.id);
  const forged = clone(parcel);
  forged.session.messages[0].key = 'l:9';
  assert.throws(() => checkParcel(forged), error => error instanceof InputError && error.message === 'This is not a version 1 Context Ledger parcel.');
  const named = clone(parcel);
  named.session.messages[0].key = 'l:2';
  assert.equal(checkParcel(named), named);
});
