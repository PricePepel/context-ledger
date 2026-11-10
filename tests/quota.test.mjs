import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { parties } from '../demo/fixtures.mjs';
import { leoReference } from '../demo/reference-graphs.mjs';
import { ensureLedger } from '../src/launcher.mjs';
import { createQuotaClient, mountQuotaStore, readLease } from '../src/quota.mjs';
import { periodOf, startQuotaServer } from '../src/quota-server.mjs';
import { removeDir, stopProcess } from './cleanup.mjs';
import { startMcp } from './mcp-client.mjs';

// A temporary folder, removed after the test once whatever the test pushed onto `closers`
// (a server or process using a database in it) has stopped: Windows keeps open files.
async function tempDir(t, closers = []) {
  const dir = await mkdtemp(join(tmpdir(), 'ledger-quota-'));
  t.after(async () => {
    for (const close of closers) await close();
    await removeDir(dir);
  });
  return dir;
}

async function service(t, options) {
  const closers = [];
  const dir = await tempDir(t, closers);
  const server = await startQuotaServer({ dataDir: dir, ...options });
  closers.push(() => server.close());
  return { ...server, url: `http://127.0.0.1:${server.port}` };
}

function client(url, options = {}) {
  const database = new DatabaseSync(':memory:');
  return createQuotaClient({ serviceUrl: url, persist: mountQuotaStore(database), ...options });
}

async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('a month is a UTC calendar month and resets on the first of the next one', () => {
  assert.deepEqual(periodOf(Date.UTC(2026, 10, 30, 23, 59)), { period: '2026-11', end: Date.UTC(2026, 11, 1) });
  assert.deepEqual(periodOf(Date.UTC(2026, 11, 31, 12)), { period: '2026-12', end: Date.UTC(2027, 0, 1) });
});

test('handoffs are spent from leases until the monthly limit, then refused with the reset date', async t => {
  const usage = await service(t, { freeLimit: 3, leaseSize: 2 });
  const quota = client(usage.url);

  const spent = [];
  for (let index = 0; index < 3; index += 1) spent.push(await quota.consume());
  assert.deepEqual(spent.map(result => result.ok), [true, true, true]);
  assert.deepEqual(spent.map(result => result.usage.used), [1, 2, 3]);
  assert.equal(spent[0].usage.limit, 3);

  const refused = await quota.consume();
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'limit');
  assert.equal(refused.usage.limit, 3);
  assert.equal(refused.usage.resetsAt, new Date(periodOf(Date.now()).end).toISOString());

  await quota.report();
  const response = await fetch(`${usage.url}/v1/usage?deviceId=${quota.deviceId}`);
  assert.equal((await response.json()).usage.used, 3);
});

test('reports carry only a device ID, event IDs, lease IDs and times', async t => {
  const usage = await service(t, { freeLimit: 5, leaseSize: 1 });
  const bodies = [];
  const quota = client(usage.url, {
    fetchImpl: (url, init) => {
      if (init?.body) bodies.push({ path: new URL(url).pathname, body: JSON.parse(init.body) });
      return fetch(url, init);
    },
  });
  await quota.consume();
  await quota.consume();
  await quota.report();
  const reports = bodies.filter(entry => entry.path === '/v1/usage/report');
  assert.ok(reports.length > 0);
  for (const { body } of reports) {
    assert.deepEqual(Object.keys(body).sort(), ['deviceId', 'events']);
    for (const event of body.events) assert.deepEqual(Object.keys(event).sort(), ['at', 'eventId', 'leaseId']);
  }
  for (const { body } of bodies.filter(entry => entry.path === '/v1/leases')) assert.deepEqual(Object.keys(body), ['deviceId']);
});

test('a lease with a bad signature is never spent', async t => {
  // A discarded lease stays reserved on the service until it expires, so leave room for two.
  const usage = await service(t, { freeLimit: 10, leaseSize: 2 });
  const persist = mountQuotaStore(new DatabaseSync(':memory:'));
  const quota = createQuotaClient({
    serviceUrl: usage.url,
    persist,
    offlineAllowance: 1,
    fetchImpl: async (url, init) => {
      const response = await fetch(url, init);
      if (new URL(url).pathname !== '/v1/leases' || response.status !== 200) return response;
      const body = await response.json();
      const forged = JSON.parse(Buffer.from(body.token, 'base64url').toString());
      forged.credits = 1000;
      body.token = Buffer.from(JSON.stringify(forged)).toString('base64url');
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  });
  const first = await quota.consume();
  assert.equal(first.ok, true);
  assert.equal(first.offline, true, 'a forged lease is treated as an unavailable service');
  assert.equal(persist.activeLease(Date.now()), undefined, 'the forged lease was not stored');
  // The service is reachable for reports, so the offline handoff is counted there.
  await quota.report();
  const response = await fetch(`${usage.url}/v1/usage?deviceId=${quota.deviceId}`);
  assert.ok((await response.json()).usage.used >= 1);
});

test('readLease rejects another device, an expired lease and a wrong key', async t => {
  const usage = await service(t, { freeLimit: 5, leaseSize: 2 });
  const deviceId = '00000000-0000-4000-8000-000000000001';
  const issued = await (await fetch(`${usage.url}/v1/leases`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceId }),
  })).json();
  const { publicKey } = await (await fetch(`${usage.url}/v1/public-key`)).json();
  const now = Date.now();
  assert.equal(readLease(issued, publicKey, deviceId, now)?.credits, 2);
  assert.equal(readLease(issued, publicKey, '00000000-0000-4000-8000-000000000002', now), undefined);
  assert.equal(readLease(issued, publicKey, deviceId, now + 40 * 24 * 60 * 60 * 1000), undefined);
  const other = await service(t, {});
  const { publicKey: otherKey } = await (await fetch(`${other.url}/v1/public-key`)).json();
  assert.equal(readLease(issued, otherKey, deviceId, now), undefined);
});

test('an unreachable service allows a few handoffs and counts them once it is back', async t => {
  const port = await freePort();
  const closers = [];
  const dir = await tempDir(t, closers);
  const database = new DatabaseSync(':memory:');
  const persist = mountQuotaStore(database);
  const quota = createQuotaClient({ serviceUrl: `http://127.0.0.1:${port}`, persist, offlineAllowance: 2 });

  assert.deepEqual(await quota.consume(), { ok: true, offline: true });
  assert.deepEqual(await quota.consume(), { ok: true, offline: true });
  assert.deepEqual(await quota.consume(), { ok: false, reason: 'unreachable' });

  const usage = await startQuotaServer({ port, dataDir: dir, freeLimit: 10, leaseSize: 2 });
  closers.push(() => usage.close());
  const back = await quota.consume();
  assert.equal(back.ok, true);
  assert.equal(back.offline, undefined);
  assert.equal(back.usage.used, 3, 'two offline handoffs were reported before the new lease');
});

test('in Claude the last handoffs warn and the next one asks the user to stop or continue without the ledger', async t => {
  // The ledger's folder comes first, so after the test the ledger stops before the usage service closes.
  const stops = [];
  const dir = await tempDir(t, stops);
  const usage = await service(t, { freeLimit: 2, leaseSize: 1 });
  const port = await freePort();
  await ensureLedger({ port, database: join(dir, 'ledger.sqlite'), env: { ...process.env, CONTEXT_LEDGER_QUOTA_URL: usage.url } });
  const pid = Number(readFileSync(join(dir, 'ledger.pid'), 'utf8'));
  stops.push(() => stopProcess(pid));
  const origin = `http://127.0.0.1:${port}`;
  const post = async (path, body) => {
    const response = await fetch(origin + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body),
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  const { session } = await post('/api/import', parties.leo);
  const { graph } = await post('/api/graphs', leoReference(session.id));

  const mcp = startMcp(port);
  t.after(async () => { if (mcp.child.exitCode === null) await mcp.close(); });
  await mcp.request(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });

  const first = await mcp.call(2, 'context_for', { graphId: graph.id });
  assert.notEqual(first.isError, true);
  assert.equal(first.content.length, 2, 'no note while most of the limit is left');

  const second = await mcp.call(3, 'context_for', { graphId: graph.id });
  assert.notEqual(second.isError, true);
  assert.match(second.content.at(-1).text, /^Context Ledger: 0 of 2 free graph handoffs left this month; the limit resets on \d{1,2} \w+ \d{4}\./);

  const third = await mcp.call(4, 'context_for', { graphId: graph.id });
  assert.equal(third.isError, true);
  const message = third.content[0].text;
  assert.match(message, /the free plan's 2 graph handoffs for this month are used up/);
  assert.match(message, /The limit resets on \d{1,2} \w+ \d{4}\./);
  assert.match(message, /\(1\) stop the agents/);
  assert.match(message, /\(2\) continue without Context Ledger/);
  assert.deepEqual(mcp.nonProtocol(), []);
});
