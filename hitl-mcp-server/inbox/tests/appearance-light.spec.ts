import { expect, test } from '@playwright/test';
import { detail, message } from './fixtures.js';
import { mount } from './mount.js';

test.use({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
test.skip(process.platform !== 'win32', 'Pre-change raster baselines were captured on Windows.');

for (const kind of ['question', 'notification', 'handoff'] as const) {
  test(`${kind} preserves the light content pane`, async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-08-13T12:00:00Z'));
    const row = message({ messageId: 'appearance', msgType: kind, title: 'Appearance fixture' });
    await mount(page, kind, detail(row, { request: {
      question: 'Choose a storage format', title: 'Work completed', summary: 'Ready for your review.',
      body: '## Result\n\nA **readable** report with `code`.\n\n> A useful note',
      allowMultiple: false, allowOther: true,
      options: [{ label: 'SQLite', value: 'sql', description: 'Transactional storage' },
        { label: 'JSON', value: 'json', description: 'Plain text' }],
    } }), { wire: true });
    const pane = page.locator('#pane-detail');
    await expect(pane).toHaveScreenshot(`${kind}-light.png`, { animations: 'disabled', maxDiffPixels: 0 });
    if (await page.evaluate(() => Boolean(document.querySelector('script[src="theme.js"]')))) {
      await page.evaluate(async () => {
        const { applyAppearance } = await import('/theme.js');
        applyAppearance('dark');
        applyAppearance('light');
      });
      await expect(pane).toHaveScreenshot(`${kind}-light.png`, { animations: 'disabled', maxDiffPixels: 0 });
    }
  });
}
