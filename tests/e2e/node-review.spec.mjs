// Card P2c: a person approves and rejects version 3 nodes in the browser, by hash.
import { expect, test } from './fixtures.mjs';

const hostile = '<img src=x onerror="window.__pwned=1">';

async function publishV3(request, baseURL, marker) {
  // Record UUIDs are hex: each test run gets its own from the clock.
  const tail = (Date.now() + Math.floor(Math.random() * 1e6)).toString(16).slice(-12).padStart(12, '0');
  const uuid = n => `0000000${n}-aaaa-4bbb-8ccc-${tail}`;
  const transcript = [
    JSON.stringify({ type: 'user', uuid: uuid(1), message: { role: 'user', content: `Leo: ${marker} ships on port 4317.` } }),
    JSON.stringify({ type: 'assistant', uuid: uuid(2), message: { role: 'assistant', content: `Noted for ${marker}.` } }),
  ].join('\n');
  const imported = await request.post('/api/import', { headers: { origin: baseURL }, data: { provider: 'claude', source: `${marker}.jsonl`, transcript } });
  expect(imported.ok(), await imported.text()).toBe(true);
  const { session } = await imported.json();
  const packet = label => ({ version: 3, sessionId: session.id, party: 'leo', edges: [], nodes: [
    { id: 'port', kind: 'decision', label, evidence: [{ message: `u:${uuid(1)}` }] },
    { id: 'notes', kind: 'goal', label: `Notes for ${marker}`, evidence: [{ message: `u:${uuid(2)}` }] },
  ] });
  const published = await request.post('/api/graphs', { headers: { origin: baseURL }, data: packet(`Use ${hostile} port 4317`) });
  expect(published.ok(), await published.text()).toBe(true);
  return { graph: (await published.json()).graph, republish: async label => {
    const response = await request.post('/api/graphs', { headers: { origin: baseURL }, data: packet(label) });
    expect(response.ok(), await response.text()).toBe(true);
    return (await response.json()).graph;
  } };
}

test('a person approves and rejects nodes by hash; a changed node starts unreviewed', async ({ page, request, baseURL }) => {
  const marker = `p2c-${Date.now().toString(36)}`;
  const { graph, republish } = await publishV3(request, baseURL, marker);
  await page.goto('/');
  await page.getByLabel('Graph ID', { exact: true }).fill(graph.id);
  await page.getByLabel('Your name').fill('Leo Park');
  await page.getByRole('button', { name: 'Show nodes' }).click();
  const port = page.locator('#review-nodes li[data-node="port"]');
  const notes = page.locator('#review-nodes li[data-node="notes"]');
  await expect(port).toContainText('Not reviewed');
  // The label is text: no element is made and no script runs.
  await expect(port.locator('.node-label')).toHaveText(`Use ${hostile} port 4317`);
  expect(await page.locator('#review-nodes img').count()).toBe(0);
  await expect(port).toContainText(`Cites L1 · hash ${graph.nodeHashes.find(entry => entry.id === 'port').sha256.slice(0, 12)}…`);

  await port.getByRole('button', { name: 'Approve' }).click();
  await expect(port).toContainText('Approved by Leo Park (self-asserted)');
  await expect(port.getByRole('button', { name: 'Approve' })).toHaveAttribute('aria-pressed', 'true');
  await notes.getByRole('button', { name: 'Reject' }).click();
  await expect(notes).toContainText('Rejected by Leo Park (self-asserted)');

  // After a reload the decisions are read back from the ledger.
  await page.reload();
  await page.getByLabel('Graph ID', { exact: true }).fill(graph.id);
  await page.getByRole('button', { name: 'Show nodes' }).click();
  await expect(page.locator('#review-nodes li[data-node="port"]')).toContainText('Approved by Leo Park');

  // Leo's agent relabels the port decision: that node starts unreviewed, the other keeps its decision.
  const newer = await republish('Port 4317 on Friday');
  await page.getByLabel('Graph ID', { exact: true }).fill(newer.id);
  await page.getByRole('button', { name: 'Show nodes' }).click();
  await expect(page.locator('#review-nodes li[data-node="port"]')).toContainText('Not reviewed');
  await expect(page.locator('#review-nodes li[data-node="notes"]')).toContainText('Rejected by Leo Park');
  expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
});

test('a version 2 graph is not reviewed node by node, and a name is needed', async ({ page, request, baseURL }) => {
  const marker = `p2c-v2-${Date.now().toString(36)}`;
  const imported = await request.post('/api/import', { headers: { origin: baseURL },
    data: { provider: 'claude', source: `${marker}.jsonl`, transcript: JSON.stringify({ type: 'user', message: { role: 'user', content: `Plan ${marker}.` } }) } });
  const { session } = await imported.json();
  const published = await request.post('/api/graphs', { headers: { origin: baseURL },
    data: { version: 2, sessionId: session.id, party: 'ali', nodes: [{ id: 'plan', kind: 'goal', label: `Plan ${marker}`, evidenceLines: [1] }], edges: [] } });
  const { graph } = await published.json();
  await page.goto('/');
  await page.getByLabel('Graph ID', { exact: true }).fill(graph.id);
  await page.getByLabel('Your name').fill('Ali');
  await page.getByRole('button', { name: 'Show nodes' }).click();
  await expect(page.locator('#review-status')).toHaveText('Only version 3 graphs are reviewed node by node.');
  await expect(page.locator('#review-nodes li')).toHaveCount(0);

  const { graph: v3 } = await publishV3(request, baseURL, `${marker}-3`);
  await page.getByLabel('Graph ID', { exact: true }).fill(v3.id);
  await page.getByLabel('Your name').fill(' ');
  await page.getByRole('button', { name: 'Show nodes' }).click();
  await page.locator('#review-nodes li[data-node="port"]').getByRole('button', { name: 'Approve' }).click();
  await expect(page.locator('#review-status')).toHaveText('Type your name first.');
  await expect(page.locator('#review-nodes li[data-node="port"]')).toContainText('Not reviewed');
});
