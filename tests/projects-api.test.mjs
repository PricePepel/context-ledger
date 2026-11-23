import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// Card U5: GET /api/projects lists every project with its session count, for the
// library's project picker. Synthetic transcripts only.
async function startServer(t) {
  const directory = await mkdtemp(join(tmpdir(), 'ledger-projects-'));
  const child = spawn(process.execPath, ['src/server.mjs'], {
    env: { ...process.env, PORT: '0', CONTEXT_LEDGER_DB: join(directory, 'ledger.sqlite') },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  t.after(async () => {
    if (child.exitCode === null) { child.kill(); await once(child, 'exit'); }
    await rm(directory, { recursive: true, force: true });
  });
  let output = '';
  for await (const chunk of child.stdout) {
    output += chunk;
    const port = output.match(/listening at http:\/\/127\.0\.0\.1:(\d+)/u)?.[1];
    if (port) return `http://127.0.0.1:${port}`;
  }
  throw new Error(`Server exited: ${output}`);
}

const turn = text => JSON.stringify({ type: 'user', message: { role: 'user', content: text } });

async function importInto(base, project, text) {
  const response = await fetch(`${base}/api/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ provider: 'claude', source: `${text}.jsonl`, transcript: turn(text), ...(project ? { project } : {}) }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  return (await response.json()).session;
}

test('GET /api/projects lists each project by slug with its session count', async t => {
  const base = await startServer(t);
  const empty = await fetch(`${base}/api/projects`);
  assert.equal(empty.status, 200);
  assert.equal(empty.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(await empty.json(), { projects: [{ slug: 'default', sessions: 0 }] });

  await importInto(base, 'orbit', 'first orbit note');
  await importInto(base, 'orbit', 'second orbit note');
  await importInto(base, 'alpha-2', 'alpha note');
  await importInto(base, null, 'loose note');
  // The same bytes again keep their first project and create nothing.
  await importInto(base, 'zeta', 'alpha note');

  const listed = await (await fetch(`${base}/api/projects?ignored=1`)).json();
  assert.deepEqual(listed, { projects: [
    { slug: 'alpha-2', sessions: 1 },
    { slug: 'default', sessions: 1 },
    { slug: 'orbit', sessions: 2 },
  ] });
});

// Answers exactly like the existing read route /api/sessions to the same foreign Host,
// foreign Origin and wrong method, with the same security headers.
test('GET /api/projects keeps the Host and Origin checks and headers of the other read routes', async t => {
  const base = await startServer(t);
  const port = new URL(base).port;
  const { request } = await import('node:http');
  const send = (path, { method = 'GET', headers = {} } = {}) => new Promise((resolve, reject) => {
    const sent = request({ host: '127.0.0.1', port, path, method, headers }, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }));
    });
    sent.on('error', reject);
    sent.end();
  });
  const cases = [
    {},
    { headers: { Host: 'evil.example' } },
    { headers: { Host: `127.0.0.1:${port}`, Origin: 'http://evil.example' } },
    { method: 'POST', headers: { Host: `127.0.0.1:${port}`, Origin: base } },
    { method: 'DELETE' },
  ];
  for (const options of cases) {
    const projects = await send('/api/projects', options);
    const sessions = await send('/api/sessions', options);
    const label = JSON.stringify(options);
    assert.equal(projects.status, sessions.status, label);
    if (projects.status !== 200) assert.equal(projects.body, sessions.body, label);
    for (const header of ['content-security-policy', 'x-content-type-options', 'referrer-policy', 'cache-control', 'content-type']) {
      assert.equal(projects.headers[header], sessions.headers[header], `${label} ${header}`);
    }
  }
  assert.equal((await send('/api/projects', { headers: { Host: 'evil.example' } })).status === 200, false);
});

test('default is listed at 0 beside a project that holds every session', async t => {
  const base = await startServer(t);
  await importInto(base, 'solo', 'solo note');
  const listed = await (await fetch(`${base}/api/projects`)).json();
  assert.deepEqual(listed.projects, [{ slug: 'default', sessions: 0 }, { slug: 'solo', sessions: 1 }]);
});
