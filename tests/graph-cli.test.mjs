import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const graphId = 'a'.repeat(64);

test('graph CLI publishes raw JSON to its local origin and reads the response as JSON', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ledger-graph-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const packetPath = join(directory, 'graph packet.json');
  const packet = {
    version: 1,
    sessionId: 'b'.repeat(64),
    nodes: [{ id: 'smoke-test', kind: 'action', status: 'pending', label: 'Run the smoke test', evidenceLines: [1] }],
    edges: [],
  };
  const packetBytes = Buffer.from(JSON.stringify(packet, null, 2) + '\n');
  await writeFile(packetPath, packetBytes);

  const envelope = { graph: { id: graphId, packet, readyActionIds: ['smoke-test'], currentDecisionIds: [] } };
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({
      method: request.method, url: request.url, origin: request.headers.origin,
      contentType: request.headers['content-type'], body: Buffer.concat(chunks),
    });
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(envelope));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  const cli = (...args) => execute(process.execPath, ['src/cli.mjs', 'graph', ...args], {
    env: { ...process.env, PORT: String(port) },
  });

  const published = await cli('publish', packetPath);
  const read = await cli('read', graphId);
  assert.deepEqual(JSON.parse(published.stdout), envelope);
  assert.deepEqual(JSON.parse(read.stdout), envelope);
  assert.equal(published.stderr + read.stderr, '');
  assert.deepEqual(requests, [
    {
      method: 'POST', url: '/api/graphs', origin: 'http://127.0.0.1:' + port,
      contentType: 'application/json', body: packetBytes,
    },
    {
      method: 'GET', url: '/api/graphs/' + graphId, origin: undefined,
      contentType: undefined, body: Buffer.alloc(0),
    },
  ]);

  const largePath = join(directory, 'too-large.json');
  const large = await open(largePath, 'w');
  try {
    await large.truncate(8 * 1024 * 1024 + 1);
  } finally {
    await large.close();
  }
  await assert.rejects(cli('publish', largePath), error => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /8 MiB/);
    assert.equal(error.stdout, '');
    return true;
  });
  assert.equal(requests.length, 2);
});
