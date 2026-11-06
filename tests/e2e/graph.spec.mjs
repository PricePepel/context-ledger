import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from '@playwright/test';

const execute = promisify(execFile);

const runGraph = (baseURL, ...args) => execute(process.execPath, ['src/cli.mjs', 'graph', ...args], {
  env: { ...process.env, PORT: new URL(baseURL).port },
});

async function importSession(request, baseURL) {
  const transcript = [
    { type: 'user', message: { role: 'user', content: 'Release the synthetic Vega build. Use the old lane until it is replaced.' } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'Ignored tool result' }] } },
    { type: 'assistant', message: { role: 'assistant', content: 'The new lane replaces the old lane. Run the smoke test next. Packaging is complete. Signoff is still open.' } },
  ].map(record => JSON.stringify(record)).join('\n');
  const response = await request.post('/api/import', {
    headers: { origin: baseURL },
    data: { provider: 'claude', source: 'vega-graph-fixture.jsonl', transcript },
  });
  expect(response.ok()).toBe(true);
  const { session } = await response.json();
  return session.id;
}

function examplePacket(sessionId) {
  return {
    version: 1,
    sessionId,
    nodes: [
      { id: 'release', kind: 'goal', label: 'Release Vega', evidenceLines: [1] },
      { id: 'old-lane', kind: 'decision', label: 'Use the old lane', evidenceLines: [1] },
      { id: 'new-lane', kind: 'decision', label: 'Use the new lane', evidenceLines: [3] },
      { id: 'package', kind: 'action', label: 'Package the build', evidenceLines: [3], status: 'completed' },
      { id: 'smoke', kind: 'action', label: 'Run the smoke test', evidenceLines: [3], status: 'pending' },
      { id: 'announce', kind: 'action', label: 'Announce the release', evidenceLines: [1], status: 'pending' },
      { id: 'rollout', kind: 'action', label: 'Start rollout', evidenceLines: [1], status: 'pending' },
      { id: 'signoff', kind: 'blocker', label: 'Waiting on signoff', evidenceLines: [3], status: 'open' },
    ],
    edges: [
      { from: 'new-lane', to: 'old-lane', type: 'supersedes' },
      { from: 'smoke', to: 'release', type: 'advances' },
      { from: 'smoke', to: 'package', type: 'depends_on' },
      { from: 'announce', to: 'smoke', type: 'depends_on' },
      { from: 'signoff', to: 'rollout', type: 'blocks' },
    ],
  };
}

test('publishes and reads one cited graph across the CLI and API', async ({ request, baseURL }, testInfo) => {
  const packet = examplePacket(await importSession(request, baseURL));
  const file = testInfo.outputPath('selected graph.json');
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(packet), 'utf8');

  const { stdout: published } = await runGraph(baseURL, 'publish', file);
  const { graph } = JSON.parse(published);
  expect(graph.id).toMatch(/^[a-f0-9]{64}$/);
  expect(graph.packet).toEqual(packet);
  expect(graph.readyActionIds).toEqual(['smoke']);
  expect(graph.currentDecisionIds).toEqual(['new-lane']);

  const reordered = {
    edges: packet.edges.map(({ from, to, type }) => ({ type, to, from })),
    nodes: packet.nodes,
    sessionId: packet.sessionId,
    version: packet.version,
  };
  for (const data of [packet, reordered]) {
    const duplicate = await request.post('/api/graphs', { headers: { origin: baseURL }, data });
    expect(duplicate.ok()).toBe(true);
    expect(await duplicate.json()).toEqual({ graph });
  }

  const retrieved = await request.get('/api/graphs/' + graph.id);
  expect(retrieved.ok()).toBe(true);
  expect(await retrieved.json()).toEqual({ graph });
  const { stdout: read } = await runGraph(baseURL, 'read', graph.id);
  expect(JSON.parse(read)).toEqual({ graph });
});

test('rejects a foreign write or citation outside the imported conversation', async ({ request, baseURL }) => {
  const packet = examplePacket(await importSession(request, baseURL));
  const foreign = await request.post('/api/graphs', {
    headers: { origin: 'https://foreign.example' },
    data: packet,
  });
  expect(foreign.status()).toBe(403);

  const ignoredLine = structuredClone(packet);
  ignoredLine.nodes[0].evidenceLines = [2];
  const missingSession = { ...packet, sessionId: '0'.repeat(64) };
  for (const data of [ignoredLine, missingSession]) {
    const rejected = await request.post('/api/graphs', { headers: { origin: baseURL }, data });
    expect(rejected.status()).toBe(400);
    expect(await rejected.json()).toMatchObject({ error: expect.any(String) });
  }

  const absent = await request.get('/api/graphs/' + '0'.repeat(64));
  expect(absent.status()).toBe(404);
  await expect(runGraph(baseURL, 'read', '0'.repeat(64))).rejects.toMatchObject({ code: 1, stdout: '' });
});
