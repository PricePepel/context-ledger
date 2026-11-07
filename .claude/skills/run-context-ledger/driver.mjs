#!/usr/bin/env node
// Agent driver for Context Ledger: start the real server, seed a two-party
// negotiation through the HTTP API, and drive the browser room with screenshots.
//
//   node .claude/skills/run-context-ledger/driver.mjs demo [--turns N] [--out DIR] [--port N] [--keep]
//   node .claude/skills/run-context-ledger/driver.mjs check [--turns N] [--min-saved 0.85]
//   node .claude/skills/run-context-ledger/driver.mjs seed --url http://127.0.0.1:PORT [--turns N]
//
// --story sprint (default: the M0 benchmark generator) or networking (the hackathon storyline in
// demo/networking.mjs, challenge 5); --turns defaults to 200 per party; --turns 2 is the toy scenario.
//
// Synthetic data only. Paths are relative to the repository root.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const args = process.argv.slice(2);
const command = args[0];
const flag = (name, fallback) => {
  const at = args.indexOf(name);
  if (at === -1) return fallback;
  const value = args[at + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} needs a value`);
  return value;
};

const claudeTurn = (role, content) => JSON.stringify({ type: role, message: { role, content } });
const codexTurn = (role, text) => JSON.stringify({
  type: 'response_item',
  payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] },
});

const transcripts = {
  mara: {
    provider: 'claude',
    source: 'mara-launch-demo.jsonl',
    transcript: [
      claudeTurn('user', 'Ship the launch demo by Friday. I can review the API docs this week.'),
      claudeTurn('assistant', 'Decision: the demo runs on the staging cluster. Plan: record the walkthrough on Saturday. Who owns the design assets?'),
    ].join('\n'),
  },
  teo: {
    provider: 'codex',
    source: 'teo-launch-demo.jsonl',
    transcript: [
      codexTurn('user', 'I can offer a docs review pass. I am away on Saturday. Which cluster does the demo use?'),
      codexTurn('assistant', 'I will benchmark the handoff once the API is frozen.'),
    ].join('\n'),
  },
};

const teoPacket = sessionId => ({
  version: 2,
  sessionId,
  party: 'teo',
  nodes: [
    { id: 'docs-review', kind: 'offer', label: 'A docs review pass', evidenceLines: [1] },
    { id: 'away-saturday', kind: 'constraint', label: 'Away on Saturday', evidenceLines: [1] },
    { id: 'which-cluster', kind: 'question', to: 'mara', status: 'open', label: 'Which cluster does the demo use?', evidenceLines: [1] },
    { id: 'benchmark', kind: 'action', status: 'pending', label: 'Benchmark the handoff', evidenceLines: [2] },
  ],
  edges: [],
});

const maraPacket = (sessionId, teoGraphId) => ({
  version: 2,
  sessionId,
  party: 'mara',
  nodes: [
    { id: 'launch-demo', kind: 'goal', label: 'Launch demo by Friday', evidenceLines: [1] },
    { id: 'api-review', kind: 'offer', label: 'Review the API docs', evidenceLines: [1] },
    { id: 'staging', kind: 'decision', label: 'The demo runs on the staging cluster', evidenceLines: [2] },
    { id: 'record', kind: 'action', status: 'pending', label: 'Record the walkthrough on Saturday', evidenceLines: [2] },
    { id: 'assets-owner', kind: 'question', to: 'teo', status: 'open', label: 'Who owns the design assets?', evidenceLines: [2] },
  ],
  edges: [{ from: 'record', to: 'launch-demo', type: 'advances' }],
  links: [
    { from: 'api-review', graph: teoGraphId, to: 'docs-review', type: 'matches' },
    { from: 'record', graph: teoGraphId, to: 'away-saturday', type: 'conflicts' },
    { from: 'staging', graph: teoGraphId, to: 'which-cluster', type: 'answers' },
  ],
});

async function api(base, method, path, body) {
  const response = await fetch(base + path, {
    method,
    headers: { origin: base, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} -> ${response.status}: ${text}`);
  return JSON.parse(text);
}

const meterOf = async (base, graphId) => (await api(base, 'GET', `/api/graphs/${graphId}/context`)).context.meter;

/** The two-turn hand-written scenario: quick to read, but too small to show a saving. */
async function seedToy(base) {
  const teoSession = (await api(base, 'POST', '/api/import', transcripts.teo)).session.id;
  const teo = (await api(base, 'POST', '/api/graphs', teoPacket(teoSession))).graph;
  const maraSession = (await api(base, 'POST', '/api/import', transcripts.mara)).session.id;
  const mara = (await api(base, 'POST', '/api/graphs', maraPacket(maraSession, teo.id))).graph;
  return { order: ['mara', 'teo'], graphs: { mara: mara.id, teo: teo.id } };
}

/**
 * Demo-scale scenario from the M0 benchmark generator (bench/synth.mjs): synthetic
 * sessions of `turns` turns per party, mostly work chatter with planted facts.
 * Party mara (Claude Code) publishes first; teo (Codex) links to mara.
 */
async function seedScaled(base, turns, seedValue) {
  const { generateParty, packetFor } = await import(new URL('../../../bench/synth.mjs', import.meta.url));
  const parts = { a: generateParty('a', turns, seedValue), b: generateParty('b', turns, seedValue) };
  const importOne = generated => api(base, 'POST', '/api/import', {
    provider: generated.party.provider, source: generated.party.source, transcript: generated.base,
  });
  const maraSession = (await importOne(parts.a)).session.id;
  const mara = (await api(base, 'POST', '/api/graphs', packetFor(parts.a, maraSession))).graph;
  const teoSession = (await importOne(parts.b)).session.id;
  const teo = (await api(base, 'POST', '/api/graphs',
    packetFor(parts.b, teoSession, { linkTo: mara.id, otherFacts: parts.a.facts }))).graph;
  return { order: ['mara', 'teo'], graphs: { mara: mara.id, teo: teo.id } };
}

/**
 * --story networking: the hackathon storyline (demo/networking.mjs). Two attendees' agents network on
 * their behalf; ali publishes first and ruslan's agent proposes matches, a conflict and answers.
 */
async function seedNetworking(base, turns, seedValue) {
  const story = await import(new URL('../../../demo/networking.mjs', import.meta.url));
  const publish = async (name, aliGraphId) => {
    const { lines, ...input } = story.transcriptFor(name, turns, seedValue);
    const session = (await api(base, 'POST', '/api/import', input)).session.id;
    return (await api(base, 'POST', '/api/graphs', story.packetFor(name, session, lines, aliGraphId))).graph.id;
  };
  const ali = await publish('ali');
  const ruslan = await publish('ruslan', ali);
  return {
    order: ['ali', 'ruslan'],
    graphs: { ali, ruslan },
    // The proposals the live demo acts on: both confirm the co-builder match, ruslan rejects the Sunday clash.
    picks: { match: 'MCP adapter', conflict: 'Sunday' },
  };
}

/** Import both transcripts, publish both graphs with links, open a room. */
async function seed(base, turns = Number(flag('--turns', 200)), seedValue = Number(flag('--seed', 42)), story = flag('--story', 'sprint')) {
  if (!Number.isInteger(turns) || turns < 2) throw new Error('--turns must be an integer of at least 2');
  if (!['networking', 'sprint'].includes(story)) throw new Error('--story must be networking or sprint');
  const seeded = turns === 2 ? await seedToy(base)
    : story === 'sprint' ? await seedScaled(base, turns, seedValue) : await seedNetworking(base, turns, seedValue);
  const [first, second] = seeded.order;
  const room = (await api(base, 'POST', '/api/rooms', { graphIds: [seeded.graphs[first], seeded.graphs[second]] })).room;
  const meter = {};
  for (const name of seeded.order) meter[name] = await meterOf(base, seeded.graphs[name]);
  return {
    story: turns === 2 ? 'toy' : story,
    turns,
    parties: seeded.order,
    graphs: seeded.graphs,
    picks: seeded.picks ?? {},
    room: room.id,
    proposals: room.proposals?.length,
    meter,
  };
}

const freePort = () => new Promise((done, fail) => {
  const probe = createServer().once('error', fail).listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => done(port));
  });
});

// Servers this process started, so a signal can stop them and remove their databases.
const running = new Set();

async function startServer(port) {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-run-'));
  const child = spawn(process.execPath, ['src/server.mjs'], {
    cwd: root,
    env: { ...process.env, PORT: String(port), CONTEXT_LEDGER_DB: join(dir, 'ledger.sqlite') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const server = { child, dir };
  running.add(server);
  let log = '';
  child.stdout.on('data', chunk => { log += chunk; });
  child.stderr.on('data', chunk => { log += chunk; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) {
      await stopServer(server);
      throw new Error(`server exited early:\n${log}`);
    }
    // A timeout per probe: a port that accepts but never answers must not hang the driver.
    try { if ((await fetch(base + '/', { signal: AbortSignal.timeout(500) })).ok) return Object.assign(server, { base, log: () => log }); } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  await stopServer(server);
  throw new Error(`server did not answer on ${base}:\n${log}`);
}

async function stopServer(server) {
  const { child, dir } = server;
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise(r => child.once('exit', r));
    child.kill('SIGTERM');
    await Promise.race([exited, new Promise(r => setTimeout(r, 2000))]);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  rmSync(dir, { recursive: true, force: true });
  running.delete(server);
}

// Ctrl-C or a supervisor's SIGTERM must not orphan the server or its temp database.
const signalNumbers = { SIGINT: 2, SIGTERM: 15, SIGHUP: 1 };
let interrupted = false;
for (const [signal, number] of Object.entries(signalNumbers)) {
  process.on(signal, async () => {
    if (interrupted) return;
    interrupted = true;
    await Promise.all([...running].map(stopServer));
    process.stderr.write(`driver: stopped by ${signal}, server and temp database removed\n`);
    process.exit(128 + number);
  });
}

async function demo() {
  const out = resolve(flag('--out', join(tmpdir(), 'ledger-shots')));
  mkdirSync(out, { recursive: true });
  const server = await startServer(Number(flag('--port', 0)) || await freePort());
  const keep = args.includes('--keep');
  let browser;
  try {
    const seeded = await seed(server.base);
    const { chromium } = await import('playwright');
    // The repo pins a Playwright whose browser build may not be installed. Fall back to
    // CHROMIUM_PATH, then to the container's preinstalled Chromium.
    try {
      browser = await chromium.launch();
    } catch (error) {
      if (!String(error).includes("Executable doesn't exist")) throw error;
      const executablePath = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium';
      if (!existsSync(executablePath)) throw error;
      browser = await chromium.launch({ executablePath, args: ['--headless=new', '--no-sandbox'] });
    }
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });

    // The human flow: paste both graph IDs and open the room.
    await page.goto(server.base + '/');
    const [first, second] = seeded.parties;
    await page.getByLabel('First graph ID').fill(seeded.graphs[first]);
    await page.getByLabel('Second graph ID').fill(seeded.graphs[second]);
    await page.getByRole('button', { name: 'Open room' }).click();
    await page.locator('#room-status').filter({ hasText: /\d+ proposals?/u }).waitFor();
    await page.locator('#room').screenshot({ path: join(out, '1-room-open.png') });

    // Proposals re-sort as their state changes, so pin each one by its own sentence.
    const proposal = async (kind, pick) => {
      let candidates = page.locator('#room-proposals > li', { hasText: kind });
      if (pick) candidates = candidates.filter({ hasText: pick });
      const sentence = (await candidates.first().innerText()).split('\n')[0].trim();
      return page.locator('#room-proposals > li', { hasText: sentence });
    };

    // Both people confirm the first match; one rejects the first conflict.
    const match = await proposal('matches', seeded.picks.match);
    await match.getByRole('button', { name: `Confirm as ${first}` }).click();
    await match.filter({ hasText: `${first}: confirm` }).waitFor();
    await match.getByRole('button', { name: `Confirm as ${second}` }).click();
    await match.filter({ hasText: 'State: agreed' }).waitFor();
    const conflict = await proposal('conflicts with', seeded.picks.conflict);
    await conflict.getByRole('button', { name: `Reject as ${second}` }).click();
    await conflict.filter({ hasText: 'State: rejected' }).waitFor();

    // Reload proves the decisions were stored, not just rendered.
    await page.reload();
    await match.filter({ hasText: 'State: agreed' }).waitFor();
    await conflict.filter({ hasText: 'State: rejected' }).waitFor();
    await page.locator('#room').screenshot({ path: join(out, '2-room-decided.png') });
    await page.screenshot({ path: join(out, '3-full-page.png'), fullPage: true });

    const agreed = await page.locator('#room-agreed').innerText();
    console.log(JSON.stringify({
      url: `${server.base}/#room=${seeded.room}`,
      story: seeded.story,
      turns: seeded.turns,
      proposals: seeded.proposals,
      graphs: seeded.graphs,
      room: seeded.room,
      meter: seeded.meter,
      agreed: agreed.trim(),
      pageErrors: errors,
      screenshots: ['1-room-open.png', '2-room-decided.png', '3-full-page.png'].map(f => join(out, f)),
    }, null, 2));
    if (errors.length) process.exitCode = 1;
  } finally {
    await browser?.close();
    if (keep) {
      console.log(`Server kept running at ${server.base} (pid ${server.child.pid}). Stop it with: kill ${server.child.pid}`);
      running.delete(server);
      server.child.unref();
      server.child.stdout.destroy();
      server.child.stderr.destroy();
    } else {
      await stopServer(server);
    }
  }
}

/** Server and seed only, no browser: prints the meters and exits 1 below --min-saved. */
async function check() {
  const server = await startServer(await freePort());
  try {
    const seeded = await seed(server.base);
    const minSaved = Number(flag('--min-saved', 0.85));
    const saved = Object.fromEntries(seeded.parties.map(name => [name, seeded.meter[name].savedShare]));
    const ok = Object.values(saved).every(share => share > minSaved);
    console.log(JSON.stringify({ ok, minSaved, story: seeded.story, turns: seeded.turns, parties: seeded.parties, graphs: seeded.graphs, room: seeded.room, proposals: seeded.proposals, savedShare: saved, meter: seeded.meter }, null, 2));
    if (!ok) process.exitCode = 1;
  } finally {
    await stopServer(server);
  }
}

if (command === 'demo') {
  await demo();
} else if (command === 'check') {
  await check();
} else if (command === 'seed') {
  const url = flag('--url');
  if (!url) throw new Error('seed needs --url http://127.0.0.1:PORT');
  const summary = await seed(url.replace(/\/$/u, ''));
  console.log(JSON.stringify({ ...summary, open: `${url.replace(/\/$/u, '')}/#room=${summary.room}` }, null, 2));
} else {
  console.error('usage: driver.mjs demo [--story sprint|networking] [--turns N] [--out DIR] [--port N] [--keep] | check [--turns N] [--min-saved 0.85] | seed --url http://127.0.0.1:PORT [--turns N]');
  process.exitCode = 2;
}
