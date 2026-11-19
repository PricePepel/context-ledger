import { expect, test } from './fixtures.mjs';
import { aliPacket, importParty, leoPacket, publish } from './party-fixtures.mjs';

const htmlLabel = '<img src=x onerror="window.__pwned=1"> GPU time';

// Tests share one database, so each passes its own label to get its own graphs and room.
async function publishPair(request, baseURL, label = htmlLabel) {
  const ali = await publish(request, baseURL, aliPacket(await importParty(request, baseURL, 'ali'), label));
  const leo = await publish(request, baseURL, leoPacket(await importParty(request, baseURL, 'leo'), ali.id));
  return { ali, leo };
}

test('two people open a room, confirm a match, reject a conflict and see it after reload', async ({ page, request, baseURL }, testInfo) => {
  // A distinct label per repeat gives each run its own graphs and room.
  const label = htmlLabel + ' #' + testInfo.repeatEachIndex;
  const { ali, leo } = await publishPair(request, baseURL, label);

  await page.goto('/');
  await page.getByLabel('First graph ID').fill(leo.id);
  await page.getByLabel('Second graph ID').fill(ali.id);
  await page.getByRole('button', { name: 'Open room' }).click();

  await expect(page.locator('#room-status')).toContainText('3 proposals');
  await expect(page.getByRole('region', { name: 'Party ali' })).toContainText('No work on Sunday');
  await expect(page.getByRole('region', { name: 'Party leo' })).toContainText('Pair on the MCP adapter');
  await expect(page.getByRole('region', { name: 'Party ali' })).toContainText(label);
  // Card G7: the planted label's "=1" is not in its cited line, so it is inferred.
  const aliNodes = page.getByRole('region', { name: 'Party ali' }).locator('.party-nodes > li');
  await expect(aliNodes.filter({ hasText: label }).locator('.node-kind')).toHaveText('offer · inferred');
  await expect(aliNodes.filter({ hasText: 'No work on Sunday' }).locator('.node-kind')).toHaveText('constraint · quoted');
  await expect(aliNodes.filter({ hasText: label })).toHaveAttribute('data-grounding', 'inferred');
  expect(await page.evaluate(() => window.__pwned)).toBeUndefined();

  const match = page.locator('#room-proposals > li', { hasText: 'matches' });
  const conflict = page.locator('#room-proposals > li', { hasText: 'conflicts with' });
  await expect(match).toContainText(`leo · offer “Pair on the MCP adapter” matches ali · offer “${label}”`);

  await match.getByRole('button', { name: 'Confirm as leo' }).click();
  await expect(match).toContainText('State: proposed');
  // Focus returns to the re-rendered button, so keyboard users keep their place.
  await expect(match.getByRole('button', { name: 'Confirm as leo' })).toBeFocused();
  await expect(match.locator('bdi[dir="auto"]').nth(1)).toHaveText(label);
  await expect(match).toContainText('leo: confirm');
  await expect(page.locator('#room-agreed')).toContainText('Nothing agreed yet.');
  await match.getByRole('button', { name: 'Confirm as ali' }).click();
  await expect(match).toContainText('State: agreed');
  await expect(page.locator('#room-agreed')).toContainText('Pair on the MCP adapter');

  await conflict.getByRole('button', { name: 'Confirm as leo' }).click();
  await conflict.getByRole('button', { name: 'Reject as ali' }).click();
  await expect(conflict).toContainText('State: rejected');
  await expect(conflict.getByRole('button', { name: 'Reject as ali' })).toHaveAttribute('aria-pressed', 'true');

  // A burst of clicks: while a decision is in flight the buttons are disabled, so the
  // stored choice is always the one shown.
  const answer = page.locator('#room-proposals > li', { hasText: 'answers' });
  await answer.getByRole('button', { name: 'Reject as leo' }).click();
  await answer.getByRole('button', { name: 'Confirm as leo' }).click();
  await expect(answer).toContainText('leo: confirm');
  await answer.getByRole('button', { name: 'Reject as leo' }).click();
  await expect(answer).toContainText('leo: reject');
  await answer.getByRole('button', { name: 'Confirm as leo' }).click();
  await expect(answer).toContainText('leo: confirm');

  expect(page.url()).toMatch(/#room=[a-f0-9]{64}$/u);
  await page.reload();
  await expect(page.locator('#room-proposals > li', { hasText: 'matches' })).toContainText('State: agreed');
  await expect(page.locator('#room-proposals > li', { hasText: 'conflicts with' })).toContainText('State: rejected');
  const reloadedAnswer = page.locator('#room-proposals > li', { hasText: 'answers' });
  await expect(reloadedAnswer).toContainText('State: proposed');
  await expect(reloadedAnswer).toContainText('leo: confirm');

  // A failed open clears the previous room so a reload cannot bring it back.
  await page.getByLabel('First graph ID').fill(ali.id);
  await page.getByLabel('Second graph ID').fill(ali.id);
  await page.getByRole('button', { name: 'Open room' }).click();
  await expect(page.locator('#room-status')).toContainText('Unable to open room. A room needs two different graphs.');
  await expect(page.locator('#room-view')).toBeHidden();
  expect(page.url()).not.toContain('#room=');
});

test('the room view fits a phone-width screen without sideways scrolling', async ({ page, request, baseURL }) => {
  const { ali, leo } = await publishPair(request, baseURL, 'GPU time for the phone check');
  const opened = await request.post('/api/rooms', { headers: { origin: baseURL }, data: { graphIds: [ali.id, leo.id] } });
  const { room } = await opened.json();
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto('/#room=' + room.id);
  await expect(page.locator('#room-proposals > li')).toHaveCount(3);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test('room API rejects agent decisions, foreign origins and invalid rooms', async ({ request, baseURL }) => {
  const { ali, leo } = await publishPair(request, baseURL, 'GPU time for the API check');
  const opened = await request.post('/api/rooms', { headers: { origin: baseURL }, data: { graphIds: [ali.id, leo.id] } });
  expect(opened.ok()).toBe(true);
  const { room } = await opened.json();
  expect((await (await request.get('/api/rooms/' + room.id)).json()).room).toEqual(room);

  const decision = { proposalId: room.proposals[0].id, party: 'leo', choice: 'confirm' };
  const agent = await request.post(`/api/rooms/${room.id}/decisions`, { headers: { origin: baseURL }, data: decision });
  expect(agent.status()).toBe(403);
  expect((await agent.json()).error).toMatch(/people in the browser/);
  const foreign = await request.post(`/api/rooms/${room.id}/decisions`, {
    headers: { origin: 'https://foreign.example', 'sec-fetch-site': 'cross-site' }, data: decision,
  });
  expect(foreign.status()).toBe(403);
  expect((await (await request.get('/api/rooms/' + room.id)).json()).room.proposals[0].choices.leo).toBeNull();

  const foreignOpen = await request.post('/api/rooms', { headers: { origin: 'https://foreign.example' }, data: { graphIds: [ali.id, leo.id] } });
  expect(foreignOpen.status()).toBe(403);
  const sameGraph = await request.post('/api/rooms', { headers: { origin: baseURL }, data: { graphIds: [ali.id, ali.id] } });
  expect(sameGraph.status()).toBe(400);
  expect((await request.get('/api/rooms/' + '0'.repeat(64))).status()).toBe(404);
});

async function openRoom(page, first, second) {
  await page.getByLabel('First graph ID').fill(first);
  await page.getByLabel('Second graph ID').fill(second);
  await page.getByRole('button', { name: 'Open room' }).click();
  await expect(page.locator('#room-status')).toContainText('proposals');
  return page.url().match(/#room=([a-f0-9]{64})$/u)[1];
}

test('a second Enter while a room is opening sends no second request', async ({ page, request, baseURL }, testInfo) => {
  const { ali, leo } = await publishPair(request, baseURL, 'double submit #' + testInfo.repeatEachIndex);
  let posts = 0;
  let release;
  const held = new Promise(resolve => { release = resolve; });
  await page.route('**/api/rooms', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    posts += 1;
    await held;
    await route.continue();
  });

  await page.goto('/');
  await page.getByLabel('First graph ID').fill(leo.id);
  await page.getByLabel('Second graph ID').fill(ali.id);
  await page.getByLabel('Second graph ID').press('Enter');
  await expect(page.getByRole('button', { name: 'Open room' })).toBeDisabled();
  await page.getByLabel('Second graph ID').press('Enter');
  release();

  await expect(page.locator('#room-status')).toContainText('3 proposals');
  await expect(page.getByRole('button', { name: 'Open room' })).toBeEnabled();
  expect(posts).toBe(1);
});

test('a decision that lands after switching rooms does not replace the new room', async ({ page, request, baseURL }, testInfo) => {
  const first = await publishPair(request, baseURL, 'stale first #' + testInfo.repeatEachIndex);
  const second = await publishPair(request, baseURL, 'stale second #' + testInfo.repeatEachIndex);
  await page.goto('/');
  const firstRoom = await openRoom(page, first.leo.id, first.ali.id);

  let release;
  const held = new Promise(resolve => { release = resolve; });
  let arrived;
  const decisionSent = new Promise(resolve => { arrived = resolve; });
  await page.route('**/api/rooms/*/decisions', async route => {
    arrived();
    await held;
    await route.continue();
  });
  const decisionDone = page.waitForResponse(response => response.url().endsWith('/decisions'));
  await page.locator('#room-proposals > li', { hasText: 'matches' }).getByRole('button', { name: 'Confirm as leo' }).click();
  await decisionSent;

  const secondRoom = await openRoom(page, second.leo.id, second.ali.id);
  expect(secondRoom).not.toBe(firstRoom);
  release();
  await decisionDone;

  await expect(page.locator('#room-status')).toContainText(`Room ${secondRoom.slice(0, 12)}`);
  await expect(page.getByRole('region', { name: 'Party ali' })).toContainText('stale second');
  await expect(page.locator('#room-proposals > li', { hasText: 'matches' })).toContainText('leo: undecided');
  expect(page.url()).toMatch(new RegExp(`#room=${secondRoom}$`, 'u'));
});

test('a graph stored before G7 shows no mark in the room', async ({ page, request, baseURL }) => {
  const { ali, leo } = await publishPair(request, baseURL, 'Two evenings of GPU time, unmarked');
  // A ledger that has not republished an older graph sends nodes without a mark.
  await page.route('**/api/rooms', async route => {
    const response = await route.fetch();
    const body = await response.json();
    for (const party of body.room.parties) for (const node of party.nodes) node.grounding = null;
    delete body.room.parties[0].nodes[0].grounding;
    await route.fulfill({ response, json: body });
  });
  await page.goto('/');
  await page.getByLabel('First graph ID').fill(leo.id);
  await page.getByLabel('Second graph ID').fill(ali.id);
  await page.getByRole('button', { name: 'Open room' }).click();
  const kinds = page.locator('.party-nodes .node-kind');
  await expect(kinds.first()).toBeVisible();
  for (const text of await kinds.allTextContents()) expect(text).not.toMatch(/quoted|inferred|null|undefined/u);
  await expect(page.getByRole('region', { name: 'Party ali' }).locator('.party-nodes > li', { hasText: 'No work on Sunday' }).locator('.node-kind')).toHaveText('constraint');
  expect(await page.locator('.party-nodes > li[data-grounding]').count()).toBe(0);
});

test('a room says when a party has published a newer graph, and what changed', async ({ page, request, baseURL }, testInfo) => {
  // Card G11. The label is set with textContent, so markup in it stays text.
  const label = `<b>GPU</b> evenings #g11-${testInfo.repeatEachIndex}-${Date.now()}`;
  const { ali, leo } = await publishPair(request, baseURL, label);
  await page.goto('/');
  await page.getByLabel('First graph ID').fill(leo.id);
  await page.getByLabel('Second graph ID').fill(ali.id);
  await page.getByRole('button', { name: 'Open room' }).click();
  await expect(page.locator('#room-status')).toContainText('3 proposals');

  // Leo publishes again: the goal is relabelled and the action is done.
  const revised = leoPacket(leo.packet.sessionId, ali.id);
  revised.nodes = revised.nodes.map(node => (node.id === 'orbit-demo' ? { ...node, label: `${label} demo live by 19:00` }
    : node.id === 'record-demo' ? { ...node, status: 'completed' } : node));
  const newer = await publish(request, baseURL, revised);
  await page.reload();
  const update = page.getByRole('region', { name: 'Newer graph from leo' });
  await expect(update).toContainText(`leo has published a newer graph (${newer.id.slice(0, 12)}…): 2 changed, 1 action no longer ready`);
  // A readiness change wins over the generic "Changed" row for the same node.
  await expect(update.locator('li')).toHaveText([/^No longer ready action: Record the demo on Sunday$/u, /^Changed goal: /u]);
  await expect(update.locator('li').nth(1).locator('bdi')).toHaveText(`${label} demo live by 19:00`);
  expect(await update.locator('b').count()).toBe(0);

  await update.getByRole('button', { name: "Use leo's newer graph" }).click();
  await expect(page.getByLabel('First graph ID')).toHaveValue(newer.id);
  await expect(page.getByLabel('Second graph ID')).toHaveValue(ali.id);
  await page.getByRole('button', { name: 'Open room' }).click();
  await expect(page.locator('#room-status')).toContainText('3 proposals');
  await expect(page.getByRole('region', { name: 'Newer graph from leo' })).toHaveCount(0);
});

test('a diff that answers after the person opened another room does not touch the new room', async ({ page, request, baseURL }, testInfo) => {
  const tag = `#g11-race-${testInfo.repeatEachIndex}-${Date.now()}`;
  const first = await publishPair(request, baseURL, `GPU A ${tag}`);
  const revised = leoPacket(first.leo.packet.sessionId, first.ali.id);
  revised.nodes = revised.nodes.map(node => (node.id === 'orbit-demo' ? { ...node, label: `Demo A ${tag}` } : node));
  await publish(request, baseURL, revised);
  const second = await publishPair(request, baseURL, `GPU B ${tag}`);

  // Hold room A's diff until room B is open.
  let release;
  const held = new Promise(resolve => { release = resolve; });
  await page.route('**/diff?from=*', async route => { await held; await route.continue(); });
  await page.goto('/');
  await page.getByLabel('First graph ID').fill(first.leo.id);
  await page.getByLabel('Second graph ID').fill(first.ali.id);
  await page.getByRole('button', { name: 'Open room' }).click();
  await expect(page.getByRole('region', { name: 'Newer graph from leo' }).first()).toBeVisible();

  await page.getByLabel('First graph ID').fill(second.leo.id);
  await page.getByLabel('Second graph ID').fill(second.ali.id);
  await page.getByRole('button', { name: 'Open room' }).click();
  await expect(page.locator('#room-status')).toContainText('3 proposals');
  await expect(page.getByRole('region', { name: 'Party ali' })).toContainText(`GPU B ${tag}`);
  const before = await page.locator('#room-updates').innerHTML();
  release();
  await page.waitForTimeout(300);
  expect(await page.locator('#room-updates').innerHTML()).toBe(before);
  await expect(page.locator('#room-updates')).not.toContainText(`Demo A ${tag}`);
});
