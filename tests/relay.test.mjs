// Card R2 (ADR-20): a relay holds one sealed parcel per one-time code, and never the
// parcel's text or key. Synthetic transcripts and names only.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { InputError } from '../src/errors.mjs';
import { packetId } from '../src/graph.mjs';
import { buildParcel, serializeParcel } from '../src/parcel.mjs';
import { createRelay, defaultLimits, listeningNotice, maxSealedBytes, relayName } from '../src/relay.mjs';
import {
  accessToken, checkRelay, deleteSealed, fetchSealed, formatCode, isLoopback, newSecret, openParcel, parseCode,
  relayOrigin, sealParcel, sendSealed,
} from '../src/relay-client.mjs';
import { openStore } from '../src/store.mjs';

const uuid = n => `0000000${n}-aaaa-4bbb-8ccc-00000000000${n}`;
const transcript = [
  ['user', 'Vera: an aside that no graph cites.'],
  ['assistant', 'The relay ships on port 6100.'],
  ['user', 'Agreed, and no deploys on Sunday.'],
].map(([role, text], index) => JSON.stringify({ type: role, uuid: uuid(index + 1), message: { role, content: text } })).join('\n');

/** A relay listening on a loopback port for one test. */
async function relay(t, options) {
  const { server, stats, arriving, leaving } = createRelay(options);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => {
    server.closeAllConnections();
    server.close(resolve);
  }));
  return { origin: `http://127.0.0.1:${server.address().port}`, stats, arriving, leaving, port: server.address().port };
}

const put = (origin, token, body, headers = {}) => fetch(origin + '/v1/parcel', {
  method: 'PUT', headers: { ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }), ...headers }, body,
});
const sealedBytes = size => Buffer.alloc(size, 7);

test('R2: a sealed parcel opens only with its own secret, and only unchanged', () => {
  const secret = newSecret();
  const text = serializeParcel({ any: 'parcel text', lines: ['The relay ships on port 6100.'] });
  const sealed = sealParcel(secret, text);
  assert.equal(sealed.subarray(0, 4).toString('ascii'), 'CLR1');
  assert.equal(sealed.length, 4 + 12 + Buffer.byteLength(text) + 16);
  assert.equal(sealed.includes('port 6100'), false);
  assert.equal(openParcel(secret, sealed).toString('utf8'), text);
  assert.notDeepEqual(sealParcel(secret, text), sealed, 'a fresh nonce each time');

  const refused = bytes => assert.throws(() => openParcel(secret, bytes),
    error => error instanceof InputError && error.message === 'This code does not open what the relay holds. Nothing was stored.');
  assert.throws(() => openParcel(newSecret(), sealed), InputError);
  for (const index of [0, 4, 16, sealed.length - 17, sealed.length - 1]) {
    const changed = Buffer.from(sealed);
    changed[index] ^= 1;
    refused(changed);
  }
  refused(sealed.subarray(0, sealed.length - 1));
  refused(Buffer.concat([sealed, Buffer.from([0])]));
  refused(Buffer.alloc(0));
  refused(Buffer.from('CLR1'));
  // The token is derived one way: it is not the key and not the secret.
  assert.match(accessToken(secret), /^[A-Za-z0-9_-]{43}$/u);
  assert.notEqual(accessToken(secret), secret.toString('base64url'));
  assert.throws(() => openParcel(Buffer.from(accessToken(secret), 'base64url'), sealed), InputError);
});

test('R2: a code is the relay address with the secret as its fragment, in one spelling', () => {
  const secret = newSecret();
  const code = formatCode('http://192.168.1.20:4319', secret);
  assert.equal(code, `http://192.168.1.20:4319/#${secret.toString('base64url')}`);
  assert.deepEqual(parseCode(code), { origin: 'http://192.168.1.20:4319', secret });
  assert.deepEqual(parseCode(`https://relay.example.test#${secret.toString('base64url')}`).origin, 'https://relay.example.test');
  const fragment = secret.toString('base64url');
  // 43 base64url characters hold 258 bits, so the last one has two spare bits: only zero is canonical.
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const spare = alphabet[alphabet.indexOf(fragment.at(-1)) | 1];
  const other = spare === fragment.at(-1) ? alphabet[alphabet.indexOf(fragment.at(-1)) ^ 1] : spare;
  for (const bad of [
    '', 'http://192.168.1.20:4319', `http://192.168.1.20:4319/#${fragment.slice(1)}`, `http://192.168.1.20:4319/#${fragment}A`,
    `http://192.168.1.20:4319/#${fragment.slice(0, -1)}${other}`, `ftp://192.168.1.20/#${fragment}`, `http://user:pw@192.168.1.20/#${fragment}`,
    `http://192.168.1.20:4319/path#${fragment}`, `http://192.168.1.20:4319/?q=1#${fragment}`, `#${fragment}`, 42, undefined,
  ]) {
    assert.throws(() => parseCode(bad), error => error instanceof InputError && error.message === 'That is not a Context Ledger relay code.', String(bad));
  }
  for (const bad of ['192.168.1.20:4319', 'http://', 'file:///tmp/x', 'http://host/path', 'http://host/?a=1', 'http://host/#x', 'http://u@host']) {
    assert.throws(() => relayOrigin(bad), InputError, bad);
  }
  assert.equal(relayOrigin('http://Example.Test:4319/'), 'http://example.test:4319');
  assert.deepEqual(['http://127.0.0.1:4319', 'http://localhost:4319', 'http://[::1]:4319', 'http://127.8.9.1', 'http://localhost.:4319', 'http://app.localhost',
    'http://[::ffff:127.0.0.1]:4319', 'http://192.168.1.20:4319', 'https://relay.example.test', 'http://notlocalhost'].map(isLoopback),
  [true, true, true, true, true, true, true, false, false, false]);
});

test('R2: the relay stores one parcel per token, gives it back, and forgets it when asked', async t => {
  const { origin, stats } = await relay(t);
  const secret = newSecret();
  const token = accessToken(secret);
  await checkRelay(origin);
  assert.deepEqual(await (await fetch(origin + '/v1/health')).json(), { relay: relayName, version: 1 });

  const sealed = sealParcel(secret, 'a parcel');
  await sendSealed(origin, secret, sealed);
  assert.deepEqual(stats(), { parcels: 1, bytes: sealed.length });
  assert.deepEqual(await fetchSealed(origin, secret), sealed);
  assert.deepEqual(await fetchSealed(origin, secret), sealed, 'a fetch does not remove it');

  const again = await put(origin, token, sealParcel(secret, 'another'));
  assert.equal(again.status, 409);
  assert.deepEqual(await again.json(), { error: 'This box already holds a parcel.' });
  assert.deepEqual(await fetchSealed(origin, secret), sealed, 'the first parcel stays');

  await assert.rejects(fetchSealed(origin, newSecret()), { message: 'The relay holds no parcel for this code. It may have been received already, or have expired.' });
  assert.equal(await deleteSealed(origin, secret), true);
  assert.deepEqual(stats(), { parcels: 0, bytes: 0 });
  await assert.rejects(fetchSealed(origin, secret), /holds no parcel/u);
  assert.equal((await fetch(origin + '/v1/parcel', { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })).status, 404);
});

test('R2: the relay refuses requests without a token of the right shape, and never echoes one', async t => {
  const { origin, stats } = await relay(t);
  const token = accessToken(newSecret());
  for (const authorization of [undefined, token, `Bearer ${token.slice(1)}`, `Bearer ${token}=`, `Basic ${token}`, `bearer ${token}`, `Bearer ${token} extra`]) {
    for (const method of ['GET', 'PUT', 'DELETE']) {
      const response = await fetch(origin + '/v1/parcel', {
        method, headers: authorization === undefined ? {} : { Authorization: authorization }, ...(method === 'PUT' ? { body: sealedBytes(64) } : {}),
      });
      assert.equal(response.status, 401, `${method} ${authorization}`);
      const text = await response.text();
      assert.equal(text, '{"error":"A relay access token is required."}');
      assert.equal(response.headers.get('www-authenticate'), 'Bearer');
    }
  }
  assert.deepEqual(stats(), { parcels: 0, bytes: 0 });
  for (const [method, path, status] of [
    ['GET', '/', 404], ['GET', '/v1', 404], ['GET', '/v1/parcel/extra', 404], ['GET', '/api/sessions', 404], ['POST', '/v1/health', 405],
  ]) {
    assert.equal((await fetch(origin + path, { method })).status, status, `${method} ${path}`);
  }
  const post = await fetch(origin + '/v1/parcel', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: sealedBytes(64) });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get('allow'), 'GET, PUT, DELETE');
  // A web page gets nothing, whatever it asks for and whatever name it used for the relay.
  await sendSealed(origin, newSecret(), sealedBytes(64));
  for (const [method, path] of [['GET', '/v1/health'], ['GET', '/v1/parcel'], ['PUT', '/v1/parcel'], ['DELETE', '/v1/parcel']]) {
    const reply = await fetch(origin + path, {
      method, headers: { Authorization: `Bearer ${token}`, Origin: origin }, ...(method === 'PUT' ? { body: sealedBytes(64) } : {}),
    });
    assert.equal(reply.status, 403, `${method} ${path}`);
    assert.equal(await reply.text(), '{"error":"The relay does not answer web pages."}');
    assert.equal(reply.headers.get('access-control-allow-origin'), null);
  }
  assert.deepEqual(stats(), { parcels: 1, bytes: 64 });
});

test('R2: the relay holds a bounded size, count and total, for a bounded time', async t => {
  let time = 1_000_000;
  const limits = { parcels: 2, bytes: 300, lifetimeMs: 60_000 };
  const { origin, stats } = await relay(t, { limits, now: () => time });
  const tokens = [1, 2, 3, 4].map(() => accessToken(newSecret()));

  const tooSmall = await put(origin, tokens[0], sealedBytes(32));
  assert.equal(tooSmall.status, 400);
  const tooLarge = await put(origin, tokens[0], sealedBytes(maxSealedBytes + 1));
  assert.equal(tooLarge.status, 413);
  assert.deepEqual(await tooLarge.json(), { error: 'The parcel is too large for the relay.' });
  assert.deepEqual(stats(), { parcels: 0, bytes: 0 }, 'nothing of a refused body is held');

  assert.equal((await put(origin, tokens[0], sealedBytes(200))).status, 201);
  const overBytes = await put(origin, tokens[1], sealedBytes(101));
  assert.equal(overBytes.status, 507);
  assert.deepEqual(await overBytes.json(), { error: 'The relay is full.' });
  assert.equal((await put(origin, tokens[1], sealedBytes(100))).status, 201);
  assert.equal((await put(origin, tokens[2], sealedBytes(40))).status, 507, 'the count is bounded too');
  assert.deepEqual(stats(), { parcels: 2, bytes: 300 });

  // A parcel expires, and its room is free again.
  time += limits.lifetimeMs - 1;
  assert.equal((await fetch(origin + '/v1/parcel', { headers: { Authorization: `Bearer ${tokens[0]}` } })).status, 200);
  time += 1;
  assert.equal((await fetch(origin + '/v1/parcel', { headers: { Authorization: `Bearer ${tokens[0]}` } })).status, 404);
  assert.deepEqual(stats(), { parcels: 0, bytes: 0 });
  const stored = await put(origin, tokens[3], sealedBytes(300));
  assert.deepEqual(await stored.json(), { stored: true, expiresInSeconds: 60 });
  assert.equal(defaultLimits.lifetimeMs, 24 * 60 * 60 * 1000);
});

test('R2: an upload must say its length, and counts against the limits while it arrives', async t => {
  const limits = { parcels: 2, bytes: 1000, lifetimeMs: 60_000 };
  const { origin, stats, arriving, port } = await relay(t, { limits });
  // A chunked body has no Content-Length: refused, however long it is.
  const chunked = total => {
    let sent = 0;
    return new ReadableStream({
      async pull(controller) {
        await new Promise(resolve => setImmediate(resolve));
        if (sent >= total) return controller.close();
        const size = Math.min(1024 * 1024, total - sent);
        sent += size;
        return controller.enqueue(Buffer.alloc(size, 7));
      },
    });
  };
  const send = total => fetch(origin + '/v1/parcel', {
    method: 'PUT', headers: { Authorization: `Bearer ${accessToken(newSecret())}` }, body: chunked(total), duplex: 'half',
  }).then(response => response.status, () => 'closed');
  assert.equal(await send(100), 411);
  assert.equal(await send(3 * maxSealedBytes), 'closed', 'far too long: the connection is cut');
  assert.deepEqual(stats(), { parcels: 0, bytes: 0 });

  // An upload that declares 600 bytes and then stalls holds its room.
  const { connect } = await import('node:net');
  const stalled = connect(port, '127.0.0.1');
  await once(stalled, 'connect');
  t.after(() => stalled.destroy());
  stalled.write(`PUT /v1/parcel HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${accessToken(newSecret())}\r\nContent-Length: 600\r\n\r\n${'x'.repeat(100)}`);
  for (let tries = 0; arriving().uploads === 0 && tries < 200; tries += 1) await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(arriving(), { uploads: 1, bytes: 600 });
  assert.equal((await put(origin, accessToken(newSecret()), sealedBytes(401))).status, 507, 'the bytes still arriving count');
  assert.equal((await put(origin, accessToken(newSecret()), sealedBytes(400))).status, 201);
  assert.equal((await put(origin, accessToken(newSecret()), sealedBytes(40))).status, 507, 'and so does the upload itself');
  // When the stalled sender goes away, its room is free again.
  stalled.destroy();
  for (let tries = 0; arriving().uploads !== 0 && tries < 200; tries += 1) await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(arriving(), { uploads: 0, bytes: 0 });
  assert.equal((await put(origin, accessToken(newSecret()), sealedBytes(40))).status, 201);
  assert.deepEqual(stats(), { parcels: 2, bytes: 440 });
});

/**
 * A download whose reader never finishes: the relay's request handler is given a response
 * that only ends when the relay destroys it. A real slow socket cannot show this on every
 * system, because the system can take a whole parcel into its own buffers at once.
 */
async function stuckDownload(server, secret) {
  const { EventEmitter } = await import('node:events');
  const response = new EventEmitter();
  response.status = null;
  response.writeHead = status => { response.status = status; };
  response.end = () => {};
  response.destroy = () => { response.destroyed = true; response.emit('close'); };
  response.finish = () => response.emit('close');
  server.emit('request', { headers: { authorization: `Bearer ${accessToken(secret)}` }, url: '/v1/parcel', method: 'GET' }, response);
  assert.equal(response.status, 200);
  return response;
}

test('R2: a parcel still being downloaded counts against the limit after it is deleted, until the download ends', async t => {
  // Codex review of the refresh (2026-11-27): a slow reader kept a deleted parcel's buffer
  // in memory while new uploads filled the room it had freed.
  const limits = { parcels: 8, bytes: 1000, lifetimeMs: 60_000, downloadMs: 60_000 };
  const { server, stats, leaving } = createRelay({ limits });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const secret = newSecret();
  await sendSealed(origin, secret, sealedBytes(600));
  const first = await stuckDownload(server, secret);
  const second = await stuckDownload(server, secret);
  assert.equal(await deleteSealed(origin, secret), true);
  assert.deepEqual(stats(), { parcels: 0, bytes: 0 });
  assert.deepEqual(leaving(), { bytes: 600 }, 'one buffer, still being sent twice');
  assert.equal((await put(origin, accessToken(newSecret()), sealedBytes(401))).status, 507);
  first.finish();
  assert.deepEqual(leaving(), { bytes: 600 }, 'until the last download ends');
  second.finish();
  assert.deepEqual(leaving(), { bytes: 0 });
  assert.equal((await put(origin, accessToken(newSecret()), sealedBytes(401))).status, 201);
  // A download that ended before the delete leaves nothing behind.
  const other = newSecret();
  await sendSealed(origin, other, sealedBytes(100));
  (await stuckDownload(server, other)).finish();
  assert.equal(await deleteSealed(origin, other), true);
  assert.deepEqual(leaving(), { bytes: 0 });
});

test('R2: one download has a deadline, however slowly its reader keeps reading', async t => {
  const { server, leaving } = createRelay({ limits: { parcels: 2, bytes: 1000, lifetimeMs: 60_000, downloadMs: 50 } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const secret = newSecret();
  await sendSealed(origin, secret, sealedBytes(200));
  const download = await stuckDownload(server, secret);
  const cut = new Promise(resolve => download.once('close', () => resolve(true)));
  const late = new Promise(resolve => setTimeout(() => resolve(false), 5_000).unref());
  assert.equal(await Promise.race([cut, late]), true, 'the relay cut the download');
  assert.equal(download.destroyed, true);
  assert.equal(await deleteSealed(origin, secret), true);
  assert.deepEqual(leaving(), { bytes: 0 });
});

test('R2: a parcel expires on an idle relay, with no request to prompt it', async t => {
  const { origin, stats } = await relay(t, { limits: { parcels: 2, bytes: 1000, lifetimeMs: 150 } });
  await sendSealed(origin, newSecret(), sealedBytes(64));
  assert.deepEqual(stats(), { parcels: 1, bytes: 64 });
  for (let tries = 0; stats().parcels !== 0 && tries < 100; tries += 1) await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(stats(), { parcels: 0, bytes: 0 });
});

test('R2: the relay imports only Node built-ins, so it cannot open a ledger', async () => {
  const source = readFileSync(new URL('../src/relay.mjs', import.meta.url), 'utf8');
  // Every module specifier, in either kind of quotes: import and export from, a bare
  // import, a dynamic import and require.
  const specifiers = [...source.matchAll(/\b(?:from|import|require)\s*\(?\s*(['"`])([^'"`]+)\1/gu)].map(match => match[2]);
  assert.deepEqual(specifiers.sort(), ['node:crypto', 'node:http']);
  assert.doesNotMatch(source, /\bimport\s*\(|\brequire\b|getBuiltinModule|node:fs|node:sqlite|process\.(?:env|binding|dlopen)/u);
  // And as loaded: the relay in a fresh process brings in no ledger module and no database.
  const { execFileSync } = await import('node:child_process');
  const loaded = execFileSync(process.execPath, ['--input-type=module', '-e',
    "import './src/relay.mjs'; console.log(JSON.stringify(process.moduleLoadList.filter(name => name.includes('sqlite'))));"],
  { encoding: 'utf8' });
  assert.deepEqual(JSON.parse(loaded.trim().split('\n').at(-1)), []);
});

test('R2: the client reports a relay that is absent, or is not one, in fixed words', async t => {
  const { server } = createRelay();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const dead = `http://127.0.0.1:${server.address().port}`;
  await new Promise(resolve => server.close(resolve));
  await assert.rejects(checkRelay(dead), { message: 'Cannot reach the relay. Check the address and that the relay is running.' });
  assert.equal(await deleteSealed(dead, newSecret()), false);

  // Something else answers on the address: a relay of another version, with an endless
  // health answer; a parcel too long to be one; and redirects to a second listener.
  const { createServer } = await import('node:http');
  let elsewhere = 0;
  const second = createServer((request, response) => {
    elsewhere += 1;
    response.end('{}');
  });
  second.listen(0, '127.0.0.1');
  await once(second, 'listening');
  let mode = 'version';
  const other = createServer((request, response) => {
    if (mode === 'redirect') {
      response.writeHead(307, { Location: `http://127.0.0.1:${second.address().port}${request.url}` });
      return response.end();
    }
    if (request.url === '/v1/health' && mode === 'version') return response.end(JSON.stringify({ relay: relayName, version: 2 }));
    if (request.url === '/v1/health') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      const more = () => {
        if (!response.destroyed && response.write(' '.repeat(65536))) setImmediate(more);
        else if (!response.destroyed) response.once('drain', more);
      };
      return more();
    }
    response.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    return response.end(Buffer.alloc(maxSealedBytes + 1, 1));
  });
  other.listen(0, '127.0.0.1');
  await once(other, 'listening');
  t.after(() => Promise.all([other, second].map(server => new Promise(resolve => {
    server.closeAllConnections();
    server.close(resolve);
  }))));
  const origin = `http://127.0.0.1:${other.address().port}`;
  const notRelay = { message: 'That address does not answer as a Context Ledger relay.' };
  await assert.rejects(checkRelay(origin), notRelay);
  // An endless health answer is read for its first kilobyte and no further.
  mode = 'endless';
  const before = process.memoryUsage().arrayBuffers;
  await assert.rejects(checkRelay(origin), notRelay);
  assert.ok(process.memoryUsage().arrayBuffers - before < 32 * 1024 * 1024);
  await assert.rejects(fetchSealed(origin, newSecret()), { message: 'The relay sent more than a parcel can hold. Nothing was stored.' });
  // A redirect is never followed, so no token and no parcel go anywhere else.
  mode = 'redirect';
  const unreachable = { message: 'Cannot reach the relay. Check the address and that the relay is running.' };
  await assert.rejects(checkRelay(origin), unreachable);
  await assert.rejects(sendSealed(origin, newSecret(), sealedBytes(64)), unreachable);
  await assert.rejects(fetchSealed(origin, newSecret()), unreachable);
  assert.equal(await deleteSealed(origin, newSecret()), false);
  assert.equal(elsewhere, 0);
});

test('R2: the client does not read a relay answer that says it is compressed', async t => {
  // Codex review of the refresh (2026-11-27): fetch unpacks a compressed answer even when
  // asked for it as it is, so a small hostile answer could unpack into a large one.
  const { createServer } = await import('node:http');
  const { gzipSync } = await import('node:zlib');
  let served = 0;
  const hostile = createServer((request, response) => {
    served += 1;
    const body = request.url === '/v1/health'
      ? gzipSync(JSON.stringify({ relay: relayName, version: 1 }))
      : gzipSync(Buffer.alloc(4 * maxSealedBytes, 7));
    response.writeHead(200, { 'Content-Encoding': 'gzip', 'Content-Length': body.length, 'Content-Type': 'application/octet-stream' });
    response.end(body);
  });
  hostile.listen(0, '127.0.0.1');
  await once(hostile, 'listening');
  t.after(() => new Promise(resolve => { hostile.closeAllConnections(); hostile.close(resolve); }));
  const origin = `http://127.0.0.1:${hostile.address().port}`;
  await assert.rejects(checkRelay(origin), { message: 'That address does not answer as a Context Ledger relay.' });
  await assert.rejects(fetchSealed(origin, newSecret()), { message: 'The relay sent a compressed answer, which a relay never does. Nothing was stored.' });
  assert.equal(served, 2);
});

test('R2: a parcel whose upload was stored but not confirmed is deleted again', async t => {
  // A front that passes requests to a real relay, and drops the answer to a PUT.
  const real = await relay(t);
  const { createServer, request: httpRequest } = await import('node:http');
  const front = createServer((request, response) => {
    const forward = httpRequest(real.origin + request.url, { method: request.method, headers: request.headers }, answer => {
      if (request.method === 'PUT') return answer.resume().on('end', () => response.destroy());
      response.writeHead(answer.statusCode, answer.headers);
      return answer.pipe(response);
    });
    request.pipe(forward);
  });
  front.listen(0, '127.0.0.1');
  await once(front, 'listening');
  t.after(() => new Promise(resolve => {
    front.closeAllConnections();
    front.close(resolve);
  }));
  const secret = newSecret();
  await assert.rejects(sendSealed(`http://127.0.0.1:${front.address().port}`, secret, sealedBytes(64)),
    { message: 'Cannot reach the relay. Check the address and that the relay is running.' });
  assert.deepEqual(real.stats(), { parcels: 0, bytes: 0 });
});

// ---- The commands, with a relay process and two ledgers ----

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

/** `ledger relay serve` on a free loopback port; its origin once it says it is listening. */
async function relayProcess(t, args = ['--port', '0']) {
  const child = spawn(process.execPath, ['src/cli.mjs', 'relay', 'serve', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  let output = '';
  child.stdout.setEncoding('utf8');
  for await (const chunk of child.stdout) {
    output += chunk;
    const match = /^Context Ledger relay listening on (http:\/\/\S+)$/mu.exec(output);
    if (match && output.endsWith('\n')) return { origin: match[1], output, child };
  }
  throw new Error('The relay process ended before it listened.');
}

function ledger(t, name) {
  const folder = mkdtempSync(join(tmpdir(), `ledger-r2-${name}-`));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const path = join(folder, 'data', 'ledger.sqlite');
  return { folder, path, env: { CONTEXT_LEDGER_DB: path } };
}

function vera(t) {
  const a = ledger(t, 'a');
  const store = openStore(a.path);
  const session = store.importTranscript({ provider: 'claude', source: 'vera.jsonl', transcript });
  const graph = store.publishGraph({ version: 2, sessionId: session.id, party: 'vera', edges: [], nodes: [
    { id: 'port', kind: 'decision', label: 'Port 6100', evidenceLines: [2] },
    { id: 'no-sunday', kind: 'constraint', label: 'No deploys on Sunday', evidenceLines: [3] },
  ] });
  const parcel = buildParcel(store.getGraph(graph.id), store.get(session.id)).parcel;
  store.close();
  return { ...a, session, graph, parcel };
}

const dump = path => {
  const raw = new DatabaseSync(path, { readOnly: true });
  try {
    return JSON.stringify(['sessions', 'messages', 'graphs', 'session_excerpts'].map(table => raw.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
  } finally {
    raw.close();
  }
};

test('R2: share --relay and receive --from carry a graph between two ledgers, and the relay keeps nothing', async t => {
  const { origin, output } = await relayProcess(t);
  assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/u, 'loopback unless --host says otherwise');
  assert.equal(output, `Context Ledger relay listening on ${origin}\n`
    + 'It holds sealed parcels in memory for up to 24 hours and cannot read them.\n'
    + 'Only this machine can reach it. To serve another machine, start it with --host and an address of this machine.\n');
  const a = vera(t);
  const b = ledger(t, 'b');
  openStore(b.path).close();

  const shared = await run(['share', a.graph.id, '--relay', origin], a.env);
  assert.equal(shared.code, 0, shared.stderr);
  const lines = shared.stdout.trimEnd().split('\n');
  const code = lines.at(-1);
  assert.deepEqual(lines.slice(0, -1), [
    `Parcel sent to the relay at ${origin}`,
    `Graph: ${a.graph.id}`,
    'It carries the 2 lines the graph cites, of 3 in the session.',
    'Give this code to the other person over a channel you trust. Anyone who has it can read the parcel, so keep it secret.',
    'On the other machine, run: ledger receive --from <code>',
  ]);
  assert.match(code, new RegExp(`^${origin.replaceAll('.', '\\.')}/#[A-Za-z0-9_-]{43}$`, 'u'));
  assert.equal(shared.stderr, 'Note: the relay address is a loopback address, so only this machine can use this code.\n');

  // What the relay holds says nothing of the parcel.
  const { secret } = parseCode(code);
  const held = await fetchSealed(origin, secret);
  for (const text of ['Port 6100', 'port 6100', 'Sunday', 'vera', a.session.id, a.graph.id, 'context-ledger-parcel', '"version"']) {
    assert.equal(held.includes(text), false, text);
  }
  assert.equal(openParcel(secret, held).toString('utf8'), serializeParcel(a.parcel));

  const before = dump(b.path);
  const wrong = await run(['receive', '--from', formatCode(origin, newSecret())], b.env);
  assert.equal(wrong.code, 1);
  assert.equal(wrong.stderr, 'The relay holds no parcel for this code. It may have been received already, or have expired.\n');
  assert.equal(dump(b.path), before);

  const received = await run(['receive', '--from', code], b.env);
  assert.equal(received.code, 0, received.stderr);
  assert.equal(received.stdout, `Received graph ${a.graph.id} of party vera into project default.\n`
    + `Session ${a.session.id}: 2 lines added; it holds 2 excerpt lines received from another machine.\n`
    + 'The relay no longer holds the parcel.\n');
  assert.equal(received.stdout.includes(secret.toString('base64url')), false);
  const store = openStore(b.path);
  try {
    assert.deepEqual(store.getGraph(a.graph.id).packet, a.parcel.graph.packet);
    assert.deepEqual(store.get(a.session.id).messages.map(message => message.line), [2, 3]);
  } finally {
    store.close();
  }
  const twice = await run(['receive', '--from', code], b.env);
  assert.equal(twice.code, 1);
  assert.equal(twice.stderr, 'The relay holds no parcel for this code. It may have been received already, or have expired.\n');
});

test('R2: receive --from does not promise that a relay which refused the delete will drop its copy', async t => {
  // Codex review of the refresh (2026-11-27): only the bundled relay is known to delete
  // after 24 hours; a relay that refuses the delete may keep the copy.
  const a = vera(t);
  const b = ledger(t, 'b');
  openStore(b.path).close();
  const secret = newSecret();
  const sealed = sealParcel(secret, serializeParcel(a.parcel));
  const { createServer } = await import('node:http');
  const keeper = createServer((request, response) => {
    if (request.url === '/v1/health') {
      const body = JSON.stringify({ relay: relayName, version: 1 });
      response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
      return response.end(body);
    }
    if (request.method === 'GET') {
      response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': sealed.length });
      return response.end(sealed);
    }
    response.writeHead(500, { 'Content-Length': 0 });
    return response.end();
  });
  keeper.listen(0, '127.0.0.1');
  await once(keeper, 'listening');
  t.after(() => new Promise(resolve => { keeper.closeAllConnections(); keeper.close(resolve); }));
  const received = await run(['receive', '--from', formatCode(`http://127.0.0.1:${keeper.address().port}`, secret)], b.env);
  assert.equal(received.code, 0, received.stderr);
  assert.equal(received.stdout.trimEnd().split('\n').at(-1),
    'The relay did not confirm that it deleted its sealed copy. A Context Ledger relay deletes a copy after 24 hours; a relay that is not one may keep it.');
  assert.equal(received.stdout.includes('expires within'), false);
});

test('R2: a parcel the ledger refuses stays on the relay, and a changed one is not opened', async t => {
  const { origin, stats } = await relay(t);
  const a = vera(t);
  const b = ledger(t, 'b');
  openStore(b.path).close();
  const before = dump(b.path);

  // A parcel whose graph links to a graph B does not have.
  const linked = structuredClone(a.parcel);
  linked.graph.packet.links = [{ from: 'port', graph: 'e'.repeat(64), to: 'x', type: 'conflicts' }];
  linked.graph.id = packetId(linked.graph.packet);
  const secret = newSecret();
  await sendSealed(origin, secret, sealParcel(secret, serializeParcel(linked)));
  const refused = await run(['receive', '--from', formatCode(origin, secret)], b.env);
  assert.equal(refused.code, 1);
  assert.equal(refused.stderr, 'This graph links to a graph that is not in this ledger. Receive that graph first.\n');
  assert.equal(dump(b.path), before);
  assert.equal(stats().parcels, 1, 'still there to try again');

  // Bytes the relay (or the network) changed do not open.
  const other = newSecret();
  const sealed = sealParcel(other, serializeParcel(a.parcel));
  sealed[20] ^= 1;
  await sendSealed(origin, other, sealed);
  const changed = await run(['receive', '--from', formatCode(origin, other)], b.env);
  assert.equal(changed.code, 1);
  assert.equal(changed.stderr, 'This code does not open what the relay holds. Nothing was stored.\n');
  assert.equal(dump(b.path), before);
  assert.equal(stats().parcels, 2);

  // Sealed bytes that open but are not a parcel.
  const junk = newSecret();
  await sendSealed(origin, junk, sealParcel(junk, JSON.stringify({ format: 'something-else' })));
  const notParcel = await run(['receive', '--from', formatCode(origin, junk)], b.env);
  assert.equal(notParcel.stderr, 'This is not a version 1 Context Ledger parcel.\n');
  assert.equal(dump(b.path), before);
});

test('R2: the commands refuse bad arguments and unreachable relays before touching anything', async t => {
  const a = vera(t);
  const usage = /^Usage: /u;
  for (const args of [
    ['share', a.graph.id, '--relay', 'http://127.0.0.1:1', '--out', join(a.folder, 'x.json')],
    ['share', a.graph.id],
    ['share', a.graph.id, '--relay', ''],
    ['receive', '--from'],
    ['receive', 'file.json', '--from', 'http://127.0.0.1:1/#' + 'A'.repeat(43)],
    ['relay'], ['relay', 'serve', 'extra'], ['relay', 'serve', '--port', '70000'], ['relay', 'serve', '--port', 'x'], ['relay', 'stop'],
  ]) {
    const result = await run(args, a.env);
    assert.equal(result.code, 1, args.join(' '));
    assert.match(result.stderr, usage, args.join(' '));
  }
  const badAddress = await run(['share', a.graph.id, '--relay', 'http://127.0.0.1:1/path'], a.env);
  assert.equal(badAddress.stderr, 'The relay address must be an http or https address with no path, such as http://192.168.1.20:4319.\n');
  const badCode = await run(['receive', '--from', 'http://127.0.0.1:1/#short'], a.env);
  assert.equal(badCode.stderr, 'That is not a Context Ledger relay code.\n');

  const { server } = createRelay();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const dead = `http://127.0.0.1:${server.address().port}`;
  await new Promise(resolve => server.close(resolve));
  const noRelay = await run(['share', a.graph.id, '--relay', dead], a.env);
  assert.equal(noRelay.code, 1);
  assert.equal(noRelay.stderr, 'Cannot reach the relay. Check the address and that the relay is running.\n');
  assert.equal(noRelay.stdout, '');
  const noRelayReceive = await run(['receive', '--from', formatCode(dead, newSecret())], a.env);
  assert.equal(noRelayReceive.stderr, 'Cannot reach the relay. Check the address and that the relay is running.\n');
});

test('R2: relay serve says so when it listens beyond this machine, and refuses a port in use', async t => {
  // The notice is checked as text: a test that listened on every interface would raise a
  // firewall prompt on a developer's machine.
  const beyond = 'It listens beyond this machine: anyone who can reach this address can use it. Run it only on a network you trust.';
  const here = 'Only this machine can reach it. To serve another machine, start it with --host and an address of this machine.';
  const notice = (address, family = 'IPv4') => listeningNotice({ address, family, port: 4319 }).split('\n');
  assert.deepEqual(notice('0.0.0.0'), ['Context Ledger relay listening on http://0.0.0.0:4319', 'It holds sealed parcels in memory for up to 24 hours and cannot read them.', beyond]);
  assert.deepEqual(notice('192.168.1.20').at(-1), beyond);
  assert.deepEqual(notice('::', 'IPv6'), ['Context Ledger relay listening on http://[::]:4319', 'It holds sealed parcels in memory for up to 24 hours and cannot read them.', beyond]);
  assert.deepEqual(notice('127.0.0.1').at(-1), here);
  assert.deepEqual(notice('127.8.9.1').at(-1), here);
  assert.deepEqual(notice('::1', 'IPv6').slice(0, 1).concat(notice('::1', 'IPv6').at(-1)), ['Context Ledger relay listening on http://[::1]:4319', here]);

  const first = await relayProcess(t, ['--port', '0', '--host', '127.0.0.1']);
  const port = new URL(first.origin).port;
  await checkRelay(first.origin);
  const second = await run(['relay', 'serve', '--port', port, '--host', '127.0.0.1'], {});
  assert.equal(second.code, 1);
  assert.equal(second.stderr, 'The relay could not listen on that address and port. It may be in use.\n');
  assert.equal(second.stdout, '');
});
