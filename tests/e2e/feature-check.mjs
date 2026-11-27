// Card H11: one entry of docs/features.json opens and reaches its last step. Card H14: an
// entry that starts a swarm run is checked in swarm.spec.mjs, which waits for the ledger's
// one swarm slot before each test; the other entries are checked in features.spec.mjs.
// The spec files call test() themselves, so a failure names the spec file and line.
import { openFeature } from '../../scripts/drive.mjs';
import { expect, test } from './fixtures.mjs';

export const featureTitle = feature => `H11 feature map: ${feature.id} (${feature.name}) opens and shows its proof`;

export function checkFeature(feature) {
  return async ({ page, baseURL }) => {
    test.setTimeout((feature.timeoutMs ?? 30_000) + 30_000);
    await page.setViewportSize({ width: 1300, height: 900 });
    // H14 review: whether an entry starts a swarm run is read from what the page asks the
    // ledger, not guessed from a selector, so a wrong runsSwarm fails here.
    // Attempts and runs the ledger accepted are counted apart (review 2: a 409 is no run).
    let swarmAttempts = 0;
    let swarmRuns = 0;
    const isRunStart = request => request.method() === 'POST' && new URL(request.url()).pathname === '/api/swarm/runs';
    page.on('request', request => { if (isRunStart(request)) swarmAttempts += 1; });
    page.on('response', response => { if (isRunStart(response.request()) && response.status() === 200) swarmRuns += 1; });
    const target = await openFeature(page, baseURL, feature);
    if (target !== page) await expect(target).toBeVisible();
    expect(await target.screenshot()).toBeInstanceOf(Buffer);
    if (feature.runsSwarm) expect(swarmRuns, `${feature.id} is marked runsSwarm but the ledger started no run`).toBeGreaterThan(0);
    else expect(swarmAttempts, `${feature.id} asked for a swarm run: mark it "runsSwarm": true in docs/features.json`).toBe(0);
  };
}
