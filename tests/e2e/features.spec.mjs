// Card H11: every entry in docs/features.json opens and reaches its last step, so the
// map an agent drives cannot drift from the app.
import { loadFeatures, openFeature } from '../../scripts/drive.mjs';
import { expect, test } from './fixtures.mjs';

for (const feature of loadFeatures()) {
  test(`H11 feature map: ${feature.id} (${feature.name}) opens and shows its proof`, async ({ page, baseURL }) => {
    test.setTimeout((feature.timeoutMs ?? 30_000) + 30_000);
    await page.setViewportSize({ width: 1300, height: 900 });
    const target = await openFeature(page, baseURL, feature);
    if (target !== page) await expect(target).toBeVisible();
    expect(await target.screenshot()).toBeInstanceOf(Buffer);
  });
}
