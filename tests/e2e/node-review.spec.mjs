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

test('P2c review: a graph opened while a decision is in flight keeps working buttons', async ({ page, request, baseURL }) => {
  const one = await publishV3(request, baseURL, `p2c-race-a-${Date.now().toString(36)}`);
  const two = await publishV3(request, baseURL, `p2c-race-b-${Date.now().toString(36)}`);
  let release;
  const held = new Promise(done => { release = done; });
  await page.route('**/api/graphs/*/reviews', async route => { await held; await route.continue(); });
  await page.goto('/');
  await page.getByLabel('Your name').fill('Leo Park');
  await page.getByLabel('Graph ID', { exact: true }).fill(one.graph.id);
  await page.getByRole('button', { name: 'Show nodes' }).click();
  await page.locator('#review-nodes li[data-node="port"]').getByRole('button', { name: 'Approve' }).click();
  // While that decision waits, the person opens the second graph.
  await page.getByLabel('Graph ID', { exact: true }).fill(two.graph.id);
  await page.getByRole('button', { name: 'Show nodes' }).click();
  // The second graph is drawn while the first decision waits, with its buttons disabled.
  await expect(page.locator('#review-nodes li[data-node="notes"]')).toContainText('p2c-race-b-');
  await expect(page.locator('#review-nodes li[data-node="port"]').getByRole('button', { name: 'Approve' })).toBeDisabled();
  release();
  await expect(page.locator('#review-nodes li[data-node="port"]').getByRole('button', { name: 'Approve' })).toBeEnabled();
  await page.unroute('**/api/graphs/*/reviews');
  await page.locator('#review-nodes li[data-node="port"]').getByRole('button', { name: 'Approve' }).click();
  await expect(page.locator('#review-nodes li[data-node="port"]')).toContainText('Approved by Leo Park');
});


test('P3: a person edits a node label; the edit is kept as an event and shown as text', async ({ page, request, baseURL }) => {
  const marker = `p3-${Date.now().toString(36)}`;
  const { graph } = await publishV3(request, baseURL, marker);
  await page.goto('/');
  await page.getByLabel('Graph ID', { exact: true }).fill(graph.id);
  await page.getByLabel('Your name').fill('Mira');
  await page.getByRole('button', { name: 'Show nodes' }).click();
  const port = page.locator('#review-nodes li[data-node="port"]');
  await port.getByRole('button', { name: 'Edit' }).click();
  const field = port.getByLabel('Corrected label');
  await expect(field).toBeFocused();
  await expect(field).toHaveValue(`Use ${hostile} port 4317`);
  await field.fill(`Port 4317 ${hostile} from Friday`);
  await port.getByRole('button', { name: 'Save edit' }).click();
  await expect(port).toContainText('Edited by Mira (self-asserted)');
  await expect(port.locator('.edited-label .node-label')).toHaveText(`Port 4317 ${hostile} from Friday`);
  await expect(port).toHaveAttribute('data-state', 'edited');
  await expect(port.getByLabel('Corrected label')).toHaveCount(0);
  expect(await page.locator('#review-nodes img').count()).toBe(0);
  // The graph's own label is unchanged.
  await expect(port.locator(':scope > .node-label')).toHaveText(`Use ${hostile} port 4317`);

  // A later approval replaces the edit in the fold; both stay in the chain.
  await port.getByRole('button', { name: 'Approve' }).click();
  await expect(port).toContainText('Approved by Mira (self-asserted)');
  await expect(port.locator('.edited-label')).toHaveCount(0);
  const response = await request.get(`/api/graphs/${graph.id}`, { headers: { origin: baseURL } });
  const { graph: stored } = await response.json();
  expect(stored.reviews.map(review => review.decision)).toEqual(['approve']);
  expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
});

test('P3: Cancel closes the edit field without recording anything', async ({ page, request, baseURL }) => {
  const marker = `p3-cancel-${Date.now().toString(36)}`;
  const { graph } = await publishV3(request, baseURL, marker);
  await page.goto('/');
  await page.getByLabel('Graph ID', { exact: true }).fill(graph.id);
  await page.getByLabel('Your name').fill('Mira');
  await page.getByRole('button', { name: 'Show nodes' }).click();
  const notes = page.locator('#review-nodes li[data-node="notes"]');
  await notes.getByRole('button', { name: 'Edit' }).click();
  await notes.getByRole('button', { name: 'Cancel' }).click();
  await expect(notes.getByLabel('Corrected label')).toHaveCount(0);
  await expect(notes).toContainText('Not reviewed');
});

test('P3 review: a failed save keeps the corrected label the person typed', async ({ page, request, baseURL }) => {
  const marker = `p3-draft-${Date.now().toString(36)}`;
  const { graph } = await publishV3(request, baseURL, marker);
  await page.goto('/');
  await page.getByLabel('Graph ID', { exact: true }).fill(graph.id);
  await page.getByLabel('Your name').fill('Mira');
  await page.getByRole('button', { name: 'Show nodes' }).click();
  const port = page.locator('#review-nodes li[data-node="port"]');
  await port.getByRole('button', { name: 'Edit' }).click();
  await port.getByLabel('Corrected label').fill('Port 4317 from Friday, draft');
  // The first save fails on the network; the field and what was typed stay.
  await page.route(`**/api/graphs/${graph.id}/reviews`, route => route.abort(), { times: 1 });
  await port.getByRole('button', { name: 'Save edit' }).click();
  await expect(page.locator('#review-status')).toContainText('Review failed.');
  await expect(port.getByLabel('Corrected label')).toHaveValue('Port 4317 from Friday, draft');
  await port.getByRole('button', { name: 'Save edit' }).click();
  await expect(port.locator('.edited-label .node-label')).toHaveText('Port 4317 from Friday, draft');
});

test('P3 review 2: the corrected label cannot change while its save is pending', async ({ page, request, baseURL }) => {
  const marker = `p3-pending-${Date.now().toString(36)}`;
  const { graph } = await publishV3(request, baseURL, marker);
  await page.goto('/');
  await page.getByLabel('Graph ID', { exact: true }).fill(graph.id);
  await page.getByLabel('Your name').fill('Mira');
  await page.getByRole('button', { name: 'Show nodes' }).click();
  const port = page.locator('#review-nodes li[data-node="port"]');
  await port.getByRole('button', { name: 'Edit' }).click();
  await port.getByLabel('Corrected label').fill('Port 4317 as sent');
  let release;
  const held = new Promise(resolve => { release = resolve; });
  await page.route(`**/api/graphs/${graph.id}/reviews`, async route => { await held; await route.continue(); }, { times: 1 });
  await port.getByRole('button', { name: 'Save edit' }).click();
  await expect(port.getByLabel('Corrected label')).toBeDisabled();
  release();
  await expect(port.locator('.edited-label .node-label')).toHaveText('Port 4317 as sent');
});
