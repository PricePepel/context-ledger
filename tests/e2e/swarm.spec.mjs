import { expect, test } from './fixtures.mjs';

// Card S1: the swarm page with the labelled simulation (the e2e ledger has no model server).
test('a simulated 100-agent run finishes, shows the answer and one agent’s proof', async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 900 });
  await page.goto('/swarm/');
  await expect(page.locator('#mode-live')).toBeDisabled();
  await expect(page.locator('#mode-simulated')).toBeChecked();
  await expect(page.locator('#live-reason')).toContainText('timings are made up');
  await expect(page.locator('#stats')).toBeHidden();

  await page.getByRole('button', { name: 'Run' }).click();
  await expect(page.locator('#mode-badge')).toHaveText('Simulated');
  await expect(page.locator('.tile')).toHaveCount(100);
  await expect(page.locator('body')).toHaveAttribute('data-run-state', 'done', { timeout: 30_000 });
  await expect(page.locator('.tile[data-state="done"]')).toHaveCount(100);
  await expect(page.locator('#status')).toContainText('Done: 100 agents');
  await expect(page.locator('#status')).toContainText('(simulated)');
  await expect(page.locator('#stats')).toContainText('100 / 100');
  await expect(page.locator('#stats')).toContainText('not measured');
  // Card S1b: a simulated run shows no speed-up at all, not a made-up one.
  await expect(page.locator('#stats .stat', { hasText: 'Speed-up' })).toContainText('not measured');
  await expect(page.locator('#stats .stat', { hasText: 'KV cache peak' })).toContainText('not measured');
  await expect(page.locator('#answer')).toContainText('Truth from the generator');

  // An unverified agent: its quote is not in its report, and the page says so.
  const unverified = page.locator('.tile[data-verified="false"]').first();
  await unverified.click();
  await expect(page.locator('#detail')).toContainText('Not found in the report');

  // A verified agent: its quote is marked inside its report.
  await page.locator('.tile[data-verified="true"]').first().click();
  await expect(page.locator('#detail mark')).toHaveCount(1);
  await expect(page.locator('#detail')).toContainText('Found in the report');
  await expect(page.locator('#detail .detail-meta')).toContainText('out (simulated)');
  const marked = await page.locator('#detail mark').textContent();
  expect(await page.locator('#detail .report').textContent()).toContain(marked);
});

test('a run the ledger no longer keeps stops the page polling and frees the Run button', async ({ page }) => {
  await page.goto('/swarm/');
  let polls = 0;
  await page.route(/\/api\/swarm\/runs\/[a-f0-9]{64}$/u, route => {
    polls += 1;
    return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'Not found.' }) });
  });
  await page.getByRole('button', { name: 'Run' }).click();
  await expect(page.locator('#status')).toContainText('no longer kept');
  await expect(page.getByRole('button', { name: 'Run' })).toBeEnabled();
  const seen = polls;
  await page.waitForTimeout(1000);
  expect(polls).toBe(seen);
});

// Card U7: the same swarm, run from the console's swarm room. It lives in this file because the
// ledger runs one swarm at a time, and tests in one file run one after another.
test('U7: the console runs the simulated swarm in its own room and shows honest numbers', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const requests = [];
  page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/swarm')) requests.push(`${request.method()} ${new URL(request.url()).pathname}`); });
  await page.goto('/console/');
  const room = page.locator('#swarm');
  await expect(room.getByRole('heading', { name: 'Local swarm' })).toBeVisible();
  await expect(room.locator('#swarm-mode')).toHaveText('Simulated');
  await expect(room.locator('#swarm-status')).toContainText('timings are made up');
  await expect(room.getByRole('link', { name: 'Open the swarm page' })).toHaveAttribute('href', '/swarm/');
  // Before Run, the room only asks which mode the server offers.
  expect(requests).toEqual(['GET /api/swarm']);

  await room.getByRole('button', { name: 'Run 100 agents' }).click();
  await expect(room.locator('#swarm-grid li')).toHaveCount(100);
  await expect(room).toHaveAttribute('data-run-state', 'done', { timeout: 30_000 });
  await expect(room.getByRole('button', { name: 'Run 100 agents' })).toBeEnabled();
  await expect(room.locator('#swarm-status')).toContainText('Done: 100 agents');
  const stats = Object.fromEntries(await room.locator('#swarm-stats div').evaluateAll(boxes => boxes.map(box => [box.querySelector('dt').textContent, box.querySelector('dd').textContent])));
  expect(stats['Agents finished']).toBe('100 / 100');
  expect(stats['Speed-up']).toBe('not measured');
  expect(stats['Wall time']).toMatch(/ \(simulated\)$/u);
  expect(stats['Quotes verified']).toMatch(/^\d+ \/ 100$/u);
  const states = await room.locator('#swarm-grid li').evaluateAll(tiles => tiles.map(tile => tile.dataset.state));
  expect(states.every(state => ['verified', 'dropped', 'failed'].includes(state))).toBe(true);
  // The run went through the swarm API only, and the rest of the console still works.
  expect(requests.filter(line => line.startsWith('POST'))).toEqual(['POST /api/swarm/runs']);
  await expect(page.locator('#status')).toContainText('Live: watching the ledger');
  await expect(page.locator('#office')).toBeVisible();
});
