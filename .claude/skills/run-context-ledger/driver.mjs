#!/usr/bin/env node
// Agent driver for Context Ledger: start the real server, seed a two-party
// negotiation through the HTTP API, and drive the browser room with screenshots.
//
//   node .claude/skills/run-context-ledger/driver.mjs demo [--out DIR] [--port N] [--keep]
//   node .claude/skills/run-context-ledger/driver.mjs seed --url http://127.0.0.1:PORT
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
  return at === -1 ? fallback : args[at + 1];
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

/** Import both transcripts, publish both graphs with links, open a room. */
async function seed(base) {
  const teoSession = (await api(base, 'POST', '/api/import', transcripts.teo)).session.id;
  const teo = (await api(base, 'POST', '/api/graphs', teoPacket(teoSession))).graph;
  const maraSession = (await api(base, 'POST', '/api/import', transcripts.mara)).session.id;
  const mara = (await api(base, 'POST', '/api/graphs', maraPacket(maraSession, teo.id))).graph;
  const room = (await api(base, 'POST', '/api/rooms', { graphIds: [mara.id, teo.id] })).room;
  const { context } = await api(base, 'GET', `/api/graphs/${mara.id}/context`);
  return { maraGraph: mara.id, teoGraph: teo.id, room: room.id, meter: context.meter, contextText: context.text };
}

const freePort = () => new Promise((done, fail) => {
  const probe = createServer().once('error', fail).listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => done(port));
  });
});

async function startServer(port) {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-run-'));
  const child = spawn(process.execPath, ['src/server.mjs'], {
    cwd: root,
    env: { ...process.env, PORT: String(port), CONTEXT_LEDGER_DB: join(dir, 'ledger.sqlite') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', chunk => { log += chunk; });
  child.stderr.on('data', chunk => { log += chunk; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`server exited early:\n${log}`);
    try { if ((await fetch(base + '/')).ok) return { base, child, dir, log: () => log }; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  child.kill();
  throw new Error(`server did not answer on ${base}:\n${log}`);
}

async function stopServer({ child, dir }) {
  if (child.exitCode === null) {
    const exited = new Promise(r => child.once('exit', r));
    child.kill('SIGTERM');
    await exited;
  }
  rmSync(dir, { recursive: true, force: true });
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
    await page.getByLabel('First graph ID').fill(seeded.maraGraph);
    await page.getByLabel('Second graph ID').fill(seeded.teoGraph);
    await page.getByRole('button', { name: 'Open room' }).click();
    await page.locator('#room-status').filter({ hasText: '3 proposals' }).waitFor();
    await page.locator('#room').screenshot({ path: join(out, '1-room-open.png') });

    // Both people confirm the match; one rejects the conflict.
    const match = page.locator('#room-proposals > li', { hasText: 'matches' });
    await match.getByRole('button', { name: 'Confirm as mara' }).click();
    await match.filter({ hasText: 'mara: confirm' }).waitFor();
    await match.getByRole('button', { name: 'Confirm as teo' }).click();
    await match.filter({ hasText: 'State: agreed' }).waitFor();
    const conflict = page.locator('#room-proposals > li', { hasText: 'conflicts with' });
    await conflict.getByRole('button', { name: 'Reject as teo' }).click();
    await conflict.filter({ hasText: 'State: rejected' }).waitFor();

    // Reload proves the decisions were stored, not just rendered.
    await page.reload();
    await page.locator('#room-proposals > li', { hasText: 'matches' }).filter({ hasText: 'State: agreed' }).waitFor();
    await page.locator('#room').screenshot({ path: join(out, '2-room-decided.png') });
    await page.screenshot({ path: join(out, '3-full-page.png'), fullPage: true });

    const agreed = await page.locator('#room-agreed').innerText();
    console.log(JSON.stringify({
      url: `${server.base}/#room=${seeded.room}`,
      maraGraph: seeded.maraGraph,
      teoGraph: seeded.teoGraph,
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
      server.child.unref();
      server.child.stdout.destroy();
      server.child.stderr.destroy();
    } else {
      await stopServer(server);
    }
  }
}

if (command === 'demo') {
  await demo();
} else if (command === 'seed') {
  const url = flag('--url');
  if (!url) throw new Error('seed needs --url http://127.0.0.1:PORT');
  const { contextText, ...summary } = await seed(url.replace(/\/$/u, ''));
  console.log(JSON.stringify({ ...summary, open: `${url.replace(/\/$/u, '')}/#room=${summary.room}` }, null, 2));
} else {
  console.error('usage: driver.mjs demo [--out DIR] [--port N] [--keep] | seed --url http://127.0.0.1:PORT');
  process.exitCode = 2;
}
