import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { startMcp } from './mcp-client.mjs';

const root = fileURLToPath(new URL('../evals/latent/fixture', import.meta.url));

async function startLedger(env) {
  const child = spawn(process.execPath, ['src/server.mjs'], { env: { ...process.env, PORT: '0', ...env }, stdio: ['ignore', 'pipe', 'inherit'] });
  let output = '';
  for await (const chunk of child.stdout) {
    output += chunk;
    const match = output.match(/listening at (http:\/\/127\.0\.0\.1:(\d+))/);
    if (match) return { origin: match[1], port: Number(match[2]), stop: async () => { child.kill(); await once(child, 'exit'); } };
  }
  throw new Error('Ledger exited before listening: ' + output);
}

test('the ledger proxies latent reads, validates slices and falls back to text over MCP', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'latent-ledger-'));
  const seen = [];
  const runtime = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    seen.push({ url: request.url, origin: request.headers.origin, body: JSON.parse(Buffer.concat(chunks).toString()) });
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({
      graph: {
        version: 1, kind: 'latent-slice', question: 'q', answer: 'A failed charge is retried 3 times with 250 ms doubling backoff.',
        findings: [
          { id: 'a', label: 'RETRY_LIMIT is 3', evidence: [{ path: 'src/config.js', startLine: 21, endLine: 22 }] },
          { id: 'b', label: 'Invented line', evidence: [{ path: 'src/payments.js', startLine: 400, endLine: 401 }] },
        ],
      },
      receipt: { model: 'fake', calls: [{ role: 'worker', promptTokens: 100, cachedTokens: 90 }] },
      stats: { prefixTokens: 1000, sliceTokensEstimate: 60, cachedShare: 0.9 },
    }));
  });
  await new Promise(resolve => runtime.listen(0, '127.0.0.1', resolve));
  const latentUrl = `http://127.0.0.1:${runtime.address().port}`;

  let ledger;
  let downLedger;
  let client;
  t.after(async () => {
    try {
      if (client && client.child.exitCode === null) await client.close();
    } finally {
      await ledger?.stop();
      await downLedger?.stop();
      await new Promise(resolve => runtime.close(resolve));
      await rm(directory, { recursive: true, force: true });
    }
  });
  const env = { CONTEXT_LEDGER_DB: join(directory, 'a.sqlite'), LATENT_ROOT: root, LATENT_URL: latentUrl };
  ledger = await startLedger(env);

  const body = { paths: ['src/config.js', 'src/payments.js'], question: 'How are failed charges retried?' };
  const foreign = await fetch(ledger.origin + '/api/latent/read', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://foreign.example' }, body: JSON.stringify(body),
  });
  assert.equal(foreign.status, 403);
  assert.equal(seen.length, 0);

  client = startMcp(ledger.port);
  const result = await client.call(1, 'latent_read', body);
  assert.equal(result.isError, undefined, result.content[0].text);
  assert.match(result.content[0].text, /^Model answer \(unchecked prose; trust the findings, read cited lines before acting\): A failed charge is retried 3 times/mu);
  assert.match(result.content[0].text, /^- f1: RETRY_LIMIT is 3 \(src\/config\.js:21-22\)$/mu);
  assert.match(result.content[0].text, /^Findings dropped by the ledger: 1 \(ungrounded: 0, citing instruction-like lines: 0\)$/mu);
  assert.equal(JSON.parse(result.content[1].text).stats.cachedShare, 0.9);
  assert.deepEqual(seen, [{ url: '/latent/read', origin: undefined, body: { ...body, budgetTokens: 600, workers: 3 } }]);

  const escape = await client.call(2, 'latent_read', { paths: ['../package.json'], question: 'q' });
  assert.equal(escape.isError, true);
  assert.equal(seen.length, 1);
  await client.close();

  // Runtime down: the same tool returns numbered file text for the closed model to read.
  downLedger = await startLedger({ ...env, CONTEXT_LEDGER_DB: join(directory, 'b.sqlite'), LATENT_URL: 'http://127.0.0.1:9' });
  client = startMcp(downLedger.port);
  const fallback = await client.call(3, 'latent_read', { paths: ['src/notify.js'], question: 'When is an SMS sent?' });
  assert.equal(fallback.isError, undefined);
  assert.match(fallback.content[0].text, /not running\. Read the numbered files below\./u);
  assert.match(fallback.content[0].text, /^13\| {3}if \(order\.customer\.phone && order\.customer\.phoneVerified\) \{$/mu);
});
