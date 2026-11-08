import { expect, test } from '@playwright/test';
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
