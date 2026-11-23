import { mkdir } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

// Card P3: the reviewer prototype, in demo mode only, kept in this browser.
const shotsDir = process.env.CONSOLE_SHOTS_DIR ?? 'test-results/console';

async function finishedDemo(page) {
  await page.goto('/console/?demo&speed=8');
  await expect(page.locator('body')).toHaveAttribute('data-demo', 'finished', { timeout: 15_000 });
}

test('approve, edit and reject demo nodes; they survive a reload and undo clears one', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const methods = [];
  page.on('request', request => methods.push(request.method()));
  await finishedDemo(page);
  const review = page.locator('#review');
  await expect(review).toBeHidden();

  // Approve.
  await page.getByRole('button', { name: /^goal, quoted: Orbit demo live/u }).click();
  await expect(review).toBeVisible();
  await expect(review).toContainText('kept in this browser only');
  await review.getByRole('button', { name: 'Approve' }).click();
  await expect(review).toContainText('You approved this node.');
  await expect(review.getByRole('button', { name: 'Undo' })).toBeFocused();
  const goal = page.getByRole('button', { name: /^goal, quoted: Orbit demo live.*approved/u });
  await expect(goal).toHaveClass(/review-approved/u);

  // Edit: an empty save is refused, then a new label is kept and shown as text.
  await page.getByRole('button', { name: /^offer, quoted: Pair with Ali/u }).click();
  await review.getByRole('button', { name: 'Edit' }).click();
  const field = review.getByLabel('New label');
  await expect(field).toBeFocused();
  await expect(field).toHaveValue('Pair with Ali on the MCP adapter');
  await field.fill('   ');
  await review.getByRole('button', { name: 'Save' }).click();
  await expect(review).toContainText('Use 1 to 300 characters');
  await field.fill('Pair with Ali <b>tonight</b>');
  await review.getByRole('button', { name: 'Save' }).click();
  await expect(review).toContainText('You edited this node\'s label.');
  await expect(review.locator('.review-label')).toHaveText('Pair with Ali <b>tonight</b>');
  await expect(page.locator('#evidence-heading')).toHaveText('Pair with Ali on the MCP adapter');
  const edited = page.locator('.node.review-edited');
  await expect(edited.locator('.node-label')).toHaveText('Pair with Ali <b>tonight</b>');
  await expect(edited.locator('.node-meta')).toHaveText('edited');
  expect(await page.locator('.brain b, #review b').count()).toBe(0);

  // Reject.
  await page.getByRole('button', { name: /^question, quoted: Who owns the GPU box/u }).click();
  await review.getByRole('button', { name: 'Reject' }).click();
  await expect(page.locator('.node.review-rejected .node-meta')).toHaveText('open · to ali · rejected');
  // The panel's state colour is not the node's: an approved node keeps its usual text colour.
  const ink = await page.locator('.node.review-approved .node-label').evaluate(node => getComputedStyle(node).color);
  expect(ink).toBe(await page.locator('.node:not([class*="review-"]) .node-label').first().evaluate(node => getComputedStyle(node).color));
  await expect(page.locator('.flash-line')).toHaveCount(0);
  await mkdir(shotsDir, { recursive: true });
  await page.screenshot({ path: `${shotsDir}/07-review.png`, fullPage: true });

  // Reload and replay: all three are still there.
  await page.reload();
  await expect(page.locator('body')).toHaveAttribute('data-demo', 'finished', { timeout: 15_000 });
  await expect(page.locator('.node.review-approved, .node.review-edited, .node.review-rejected')).toHaveCount(3);
  await page.getByRole('button', { name: 'Replay demo' }).click();
  await expect(page.locator('body')).toHaveAttribute('data-demo', 'finished', { timeout: 15_000 });
  await expect(page.locator('.node.review-approved, .node.review-edited, .node.review-rejected')).toHaveCount(3);

  // Undo clears one.
  await page.locator('.node.review-rejected').click();
  await review.getByRole('button', { name: 'Undo' }).click();
  await expect(page.locator('.node.review-rejected')).toHaveCount(0);
  await expect(review.getByRole('button', { name: 'Edit' })).toBeFocused();
  expect(methods.every(method => method === 'GET')).toBe(true);
});

test('a republish is a new snapshot: the open review follows it and starts unreviewed', async ({ page }) => {
  await page.goto('/console/?demo&autoplay=0&speed=2');
  await expect(page.locator('body')).toHaveAttribute('data-demo', 'ready');
  await page.getByRole('button', { name: 'Play demo' }).click();
  // Leo's first graph holds the goal; his next publishes keep it unchanged under new graph IDs.
  const goal = page.getByRole('button', { name: /^goal, quoted: Orbit demo live/u });
  await goal.click();
  const review = page.locator('#review');
  await review.getByRole('button', { name: 'Approve' }).click();
  await expect(goal).toHaveClass(/review-approved/u);
  await expect(page.locator('body')).toHaveAttribute('data-demo', 'finished', { timeout: 25_000 });
  await expect(goal).not.toHaveClass(/review-approved/u);
  await expect(review).not.toContainText('You approved');
  // A decision now lands on the snapshot that is shown.
  await review.getByRole('button', { name: 'Reject' }).click();
  await expect(goal).toHaveClass(/review-rejected/u);
});

test('an open edit keeps its text when the same node is picked again', async ({ page }) => {
  await page.goto('/console/?demo&speed=8');
  await expect(page.locator('body')).toHaveAttribute('data-demo', 'finished', { timeout: 15_000 });
  const node = page.getByRole('button', { name: /^offer, quoted: Pair with Ali/u });
  await node.click();
  await page.locator('#review').getByRole('button', { name: 'Edit' }).click();
  await page.getByLabel('New label').fill('Half-typed');
  await node.click();
  await expect(page.getByLabel('New label')).toHaveValue('Half-typed');
});

test('live mode has no review controls', async ({ page }) => {
  const paths = [];
  page.on('request', request => paths.push(new URL(request.url()).pathname));
  await page.goto('/console/');
  await expect(page.locator('#status')).toContainText('Live');
  await expect(page.locator('#review')).toBeHidden();
  await expect(page.locator('#review button')).toHaveCount(0);
  // Live mode never fetches the review code.
  expect(paths).not.toContain('/console/review.mjs');
});

test('stored reviews that are not valid are ignored, and the demo still plays', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('ctm-console-reviews-v0', '{"not": "a list"'));
  await finishedDemo(page);
  await expect(page.locator('[class*="review-"].node')).toHaveCount(0);
  await page.locator('.node').first().click();
  await expect(page.locator('#review').getByRole('button', { name: 'Approve' })).toBeVisible();
});
