import { expect, test } from '@playwright/test';

// Captured before theme changes at 72113bd4429b086db264135cef6c8c6efdd4de25.
// Never update these snapshots to accept a theme regression.
test.use({ viewport: { width: 1100, height: 850 }, deviceScaleFactor: 1 });
test.skip(process.platform !== 'win32', 'Pre-change raster baselines were captured on Windows.');

for (const [name, url] of [
  ['question', '/test-harness.html'],
  ['notifications', '/notifications-harness.html'],
  ['review', '/review-harness.html'],
  ['expired', '/review-harness.html?state=expired'],
]) {
  test(`${name} retains its light rendering`, async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-08-13T12:00:00Z'));
    await page.goto(url);
    await page.locator('body').waitFor();
    await page.waitForTimeout(400);
    const options = { animations: 'disabled' as const, maxDiffPixels: 0 };
    await expect(page).toHaveScreenshot(`${name}-light.png`, options);
    // The baseline run deliberately predates the theme controller.
    if (await page.evaluate(() => Boolean(document.querySelector('script[src="theme.js"]')))) {
      await page.evaluate(async () => {
        const { applyAppearance } = await import('/theme.js');
        applyAppearance('dark');
        applyAppearance('light');
      });
      await expect(page).toHaveScreenshot(`${name}-light.png`, options);
    }
  });
}
