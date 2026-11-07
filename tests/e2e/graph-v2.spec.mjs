import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from '@playwright/test';
import { aliPacket, importParty, leoPacket, publish } from './party-fixtures.mjs';

const execute = promisify(execFile);

test('two parties publish linked v2 graphs through the API and CLI', async ({ request, baseURL }, testInfo) => {
  const ali = await publish(request, baseURL, aliPacket(await importParty(request, baseURL, 'ali')));
  expect(ali.openQuestionIds).toEqual(['which-port']);

  const packet = leoPacket(await importParty(request, baseURL, 'leo'), ali.id);
  const file = testInfo.outputPath('leo graph.json');
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(packet), 'utf8');
  const { stdout } = await execute(process.execPath, ['src/cli.mjs', 'graph', 'publish', file], {
    env: { ...process.env, PORT: new URL(baseURL).port },
  });
  const { graph: leo } = JSON.parse(stdout);
  expect(leo.readyActionIds).toEqual(['record-demo']);
  expect(leo.currentDecisionIds).toEqual(['port-4317']);
  expect(leo.openQuestionIds).toEqual(['gpu-owner']);
  expect(leo.packet.links).toHaveLength(3);

  const read = await request.get('/api/graphs/' + leo.id);
  expect(await read.json()).toEqual({ graph: leo });

  const dangling = structuredClone(packet);
  dangling.links[0].to = 'no-such-node';
  const rejected = await request.post('/api/graphs', { headers: { origin: baseURL }, data: dangling });
  expect(rejected.status()).toBe(400);
  expect((await rejected.json()).error).toMatch(/remote node/);
});
