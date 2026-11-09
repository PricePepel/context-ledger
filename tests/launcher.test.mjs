import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { autostartEnabled, defaultDatabase, ensureLedger, probeLedger } from '../src/launcher.mjs';
import { startMcp } from './mcp-client.mjs';

async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

// A temporary data folder whose ledger, if one was started, is stopped after the test.
async function dataDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'ledger-launch-'));
  t.after(async () => {
    const pidFile = join(dir, 'ledger.pid');
    if (existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, 'utf8'));
      try { process.kill(pid, 'SIGTERM'); } catch {}
      for (let i = 0; i < 50 && existsSync(pidFile); i += 1) await new Promise(resolve => setTimeout(resolve, 50));
    }
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

test('the default database is in the home folder and auto-start is on unless set to 0', () => {
  assert.match(defaultDatabase(), /\.context-ledger[\\/]ledger\.sqlite$/);
  assert.equal(autostartEnabled({}), true);
  assert.equal(autostartEnabled({ CONTEXT_LEDGER_AUTOSTART: '1' }), true);
  assert.equal(autostartEnabled({ CONTEXT_LEDGER_AUTOSTART: '0' }), false);
});

test('ensureLedger starts a ledger once, records its pid and reuses it', async t => {
  const dir = await dataDir(t);
  const port = await freePort();
  const database = join(dir, 'ledger.sqlite');
  assert.equal(await probeLedger(port), 'none');

  const first = await ensureLedger({ port, database });
  assert.equal(first.started, true);
  assert.equal(first.database, database);
  assert.equal(await probeLedger(port), 'ledger');
  assert.match(readFileSync(join(dir, 'ledger.pid'), 'utf8'), /^\d+\n$/);
  assert.equal(existsSync(database), true);

  const second = await ensureLedger({ port, database });
  assert.equal(second.started, false);
});

test('two clients starting at once end with one ledger', async t => {
  const dir = await dataDir(t);
  const port = await freePort();
  const database = join(dir, 'ledger.sqlite');
  const results = await Promise.all([ensureLedger({ port, database }), ensureLedger({ port, database })]);
  assert.equal(results.length, 2);
  assert.equal(await probeLedger(port), 'ledger');
});

test('a service on the port that is not a ledger is reported, not replaced', async t => {
  const other = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ name: 'something-else' }));
  });
  await new Promise(resolve => other.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => other.close(resolve)));
  const { port } = other.address();

  assert.equal(await probeLedger(port), 'other');
  await assert.rejects(ensureLedger({ port, database: join(tmpdir(), 'unused.sqlite') }), /used by another service/);
});

test('health names the app and keeps the Host check', async t => {
  const dir = await dataDir(t);
  const port = await freePort();
  await ensureLedger({ port, database: join(dir, 'ledger.sqlite') });

  const response = await fetch(`http://127.0.0.1:${port}/api/health`);
  const body = await response.json();
  assert.deepEqual(Object.keys(body).sort(), ['name', 'version']);
  assert.equal(body.name, 'context-ledger');

  // fetch cannot override Host, so send this one with node:http.
  const status = await new Promise((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port, path: '/api/health', headers: { Host: `evil.example:${port}` } }, response => {
      response.resume();
      resolve(response.statusCode);
    });
    request.on('error', reject);
    request.end();
  });
  assert.equal(status, 403);
});

test('the first MCP tool call starts the ledger when auto-start is on', async t => {
  const dir = await dataDir(t);
  const port = await freePort();
  const client = startMcp(port, { CONTEXT_LEDGER_AUTOSTART: '1', CONTEXT_LEDGER_DB: join(dir, 'ledger.sqlite') });
  t.after(async () => { if (client.child.exitCode === null) await client.close(); });

  await client.request(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  const result = await client.call(2, 'session_search', {});
  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  assert.deepEqual(JSON.parse(result.content[0].text), { sessions: [] });
  assert.equal(await probeLedger(port), 'ledger');
  assert.deepEqual(client.nonProtocol(), []);
});

test('with auto-start off the MCP call keeps the old error and starts nothing', async t => {
  const port = await freePort();
  const client = startMcp(port);
  t.after(async () => { if (client.child.exitCode === null) await client.close(); });

  await client.request(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  const result = await client.call(2, 'session_search', {});
  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, `Cannot reach Context Ledger on port ${port}. Start it with npm start.`);
  assert.equal(await probeLedger(port), 'none');
});
