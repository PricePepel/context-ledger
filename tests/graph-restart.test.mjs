import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// G2 acceptance: a published graph is retrievable after the server restarts on the same database.
async function startServer(database) {
  const child = spawn(process.execPath, ['src/server.mjs'], {
    env: { ...process.env, PORT: '0', CONTEXT_LEDGER_DB: database },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  let output = '';
  for await (const chunk of child.stdout) {
    output += chunk;
    const match = output.match(/listening at (http:\/\/127\.0\.0\.1:\d+)/);
    if (match) return { origin: match[1], stop: async () => { child.kill(); await once(child, 'exit'); } };
  }
  throw new Error('Server exited before listening: ' + output);
}

const post = (origin, path, body) => fetch(origin + path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Origin: origin },
  body: JSON.stringify(body),
});

test('a published graph survives a server restart on the same database', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ledger-restart-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const database = join(directory, 'ledger.sqlite');

  const first = await startServer(database);
  let graph;
  try {
    const transcript = [
      { type: 'user', message: { role: 'user', content: 'Ship the synthetic Orion build.' } },
      { type: 'assistant', message: { role: 'assistant', content: 'Run the Orion smoke test next.' } },
    ].map(record => JSON.stringify(record)).join('\n');
    const imported = await post(first.origin, '/api/import', { provider: 'claude', source: 'orion.jsonl', transcript });
    assert.equal(imported.status, 200);
    const { session } = await imported.json();
    const published = await post(first.origin, '/api/graphs', {
      version: 1,
      sessionId: session.id,
      nodes: [
        { id: 'ship', kind: 'goal', label: 'Ship Orion', evidenceLines: [1] },
        { id: 'smoke', kind: 'action', status: 'pending', label: 'Run the smoke test', evidenceLines: [2] },
      ],
      edges: [{ from: 'smoke', to: 'ship', type: 'advances' }],
    });
    assert.equal(published.status, 200);
    ({ graph } = await published.json());
  } finally {
    await first.stop();
  }

  const second = await startServer(database);
  try {
    const read = await fetch(second.origin + '/api/graphs/' + graph.id);
    assert.equal(read.status, 200);
    assert.deepEqual(await read.json(), { graph });
    assert.deepEqual(graph.readyActionIds, ['smoke']);
  } finally {
    await second.stop();
  }
});
