import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { startMcp } from './mcp-client.mjs';

async function startServer(database) {
  const child = spawn(process.execPath, ['src/server.mjs'], {
    env: { ...process.env, PORT: '0', CONTEXT_LEDGER_DB: database },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  let output = '';
  for await (const chunk of child.stdout) {
    output += chunk;
    const match = output.match(/listening at (http:\/\/127\.0\.0\.1:(\d+))/);
    if (match) {
      return { origin: match[1], port: Number(match[2]), stop: async () => { child.kill(); await once(child, 'exit'); } };
    }
  }
  throw new Error('Server exited before listening: ' + output);
}

test('an agent publishes and reads back a v2 graph through MCP against the real ledger', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ledger-mcp-live-'));
  let server;
  let client;
  // One hook, in order: the MCP process and the server must release the database
  // before Windows lets the temporary directory go.
  t.after(async () => {
    try {
      if (client && client.child.exitCode === null) await client.close();
    } finally {
      try {
        await server?.stop();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  });
  server = await startServer(join(directory, 'ledger.sqlite'));

  const transcript = [
    { type: 'user', message: { role: 'user', content: 'Plan the synthetic demo for the Vega team.' } },
    { type: 'assistant', message: { role: 'assistant', content: 'Draft the Vega demo outline next.' } },
  ].map(record => JSON.stringify(record)).join('\n');
  const imported = await fetch(server.origin + '/api/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: server.origin },
    body: JSON.stringify({ provider: 'claude', source: 'vega.jsonl', transcript }),
  });
  assert.equal(imported.status, 200);
  const { session } = await imported.json();

  client = startMcp(server.port);
  const { result: initialized } = await client.request(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {} });
  assert.equal(initialized.protocolVersion, '2025-06-18');
  client.send({ jsonrpc: '2.0', method: 'notifications/initialized' });

  const packet = {
    version: 2,
    sessionId: session.id,
    party: 'leo',
    nodes: [{ id: 'demo', kind: 'goal', label: 'Synthetic demo', evidenceLines: [1] }],
    edges: [],
  };
  const published = await client.call(2, 'graph_publish', { packet });
  assert.equal(published.isError, undefined, published.content[0].text);
  const { graph } = JSON.parse(published.content[0].text);
  assert.match(graph.id, /^[a-f0-9]{64}$/);
  assert.deepEqual(graph.packet, packet);

  const read = await client.call(3, 'graph_read', { graphId: graph.id });
  assert.equal(read.isError, undefined);
  assert.deepEqual(JSON.parse(read.content[0].text), { graph });

  const rejected = await client.call(4, 'graph_publish', {
    packet: { ...packet, nodes: [{ ...packet.nodes[0], evidenceLines: [9] }] },
  });
  assert.equal(rejected.isError, true);
  assert.equal(rejected.content[0].text, 'Evidence must refer to stored lines in the source session.');

  const missing = await client.call(5, 'graph_read', { graphId: 'f'.repeat(64) });
  assert.deepEqual(missing, { content: [{ type: 'text', text: 'Graph not found.' }], isError: true });
});
