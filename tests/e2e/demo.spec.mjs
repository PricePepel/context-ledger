import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { aliReference, leoReference } from '../../demo/reference-graphs.mjs';

// The stage flow with the committed demo files: each person imports their own
// transcript in the browser, the agents publish (here: the reference graphs), and both
// people settle the proposals in the room.
async function importFile(page, provider, name) {
  const buffer = await readFile(new URL(`../../demo/${name}`, import.meta.url));
  await page.getByLabel('Source agent').selectOption(provider);
  await page.getByLabel('Transcript file').setInputFiles({ name, mimeType: 'application/x-ndjson', buffer });
  await page.getByRole('button', { name: 'Import transcript' }).click();
  await expect(page.getByText(`Imported ${name}.`, { exact: true })).toBeVisible();
}

async function sessionId(request, provider, query) {
  const response = await request.get(`/api/sessions?q=${encodeURIComponent(query)}&provider=${provider}`);
  const { sessions } = await response.json();
  expect(sessions.length).toBeGreaterThan(0);
  return sessions[0].id;
}

async function publish(request, baseURL, packet) {
  const response = await request.post('/api/graphs', { headers: { origin: baseURL }, data: packet });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).graph;
}

test('the demo transcripts go from browser import to an agreed room', async ({ page, request, baseURL }) => {
  await page.goto('/');
  await importFile(page, 'claude', 'leo-orbit.jsonl');
  await importFile(page, 'codex', 'ali-orbit.jsonl');

  const leo = await publish(request, baseURL, leoReference(await sessionId(request, 'claude', 'orbit grafana')));
  const ali = await publish(request, baseURL, aliReference(await sessionId(request, 'codex', 'orbit benchmark'), leo.id));
  expect(leo.currentDecisionIds).toEqual(['port-4317']);

  // The briefing Ali's agent reads carries the final answers, not the replaced ones.
  const { context } = await (await request.get(`/api/graphs/${leo.id}/context`)).json();
  expect(context.text).toContain('port-4317 supersedes port-4400');
  expect(context.text).toContain('Saturday at 17:00');
  expect(context.text).not.toMatch(/Sunday/u);
  expect(context.meter.savedTokens).toBeGreaterThan(0);

  await page.getByLabel('First graph ID').fill(leo.id);
  await page.getByLabel('Second graph ID').fill(ali.id);
  await page.getByRole('button', { name: 'Open room' }).click();
  await expect(page.locator('#room-status')).toContainText('2 proposals');

  const pairing = page.locator('#room-proposals > li', { hasText: 'Pair with Ali on the MCP adapter' });
  const gpu = page.locator('#room-proposals > li', { hasText: 'Two evenings of GPU time' });
  for (const party of ['leo', 'ali']) await pairing.getByRole('button', { name: `Confirm as ${party}` }).click();
  await expect(pairing).toContainText('State: agreed');
  await gpu.getByRole('button', { name: 'Confirm as leo' }).click();
  await gpu.getByRole('button', { name: 'Reject as ali' }).click();
  await expect(gpu).toContainText('State: rejected');
  await expect(page.locator('#room-agreed')).toContainText('Pair with Ali on the MCP adapter');
  await expect(page.locator('#room-agreed')).not.toContainText('Two evenings of GPU time');
});
