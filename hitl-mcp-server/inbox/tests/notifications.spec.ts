// The bell in the Inbox bar: desktop notifications on and off.
//
// The toasts themselves are Rust (src-tauri/src/toast.rs, with its own tests);
// this covers the switch: it shows the saved state, flips it through the
// command, and does not claim a state it could not save.

import { expect, test, type Page } from '@playwright/test';

const bell = (page: Page) => page.locator('#notifications-toggle');
const calls = (page: Page, cmd: string) =>
  page.evaluate(cmd => (window as any).__INVOCATIONS.filter((c: any) => c.cmd === cmd), cmd);

test('the bell shows notifications on by default and turns them off and on again', async ({ page }) => {
  await page.goto('/inbox-harness.html');
  await expect(bell(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(bell(page)).toHaveText('🔔');

  await bell(page).click();
  await expect(bell(page)).toHaveAttribute('aria-pressed', 'false');
  await expect(bell(page)).toHaveText('🔕');
  await expect(bell(page)).toHaveAttribute('title', /off\. Click to turn them on/);
  await expect(bell(page)).toHaveAccessibleName('Desktop notifications');

  await bell(page).click();
  await expect(bell(page)).toHaveAttribute('aria-pressed', 'true');
  expect((await calls(page, 'set_notifications_enabled')).map((c: any) => c.args)).toEqual([
    { enabled: false },
    { enabled: true },
  ]);
});

test('the bell shows a saved off when the Inbox opens', async ({ page }) => {
  await page.addInitScript(() => { (window as any).__NOTIFICATIONS = false; });
  await page.goto('/inbox-harness.html');
  await expect(bell(page)).toHaveAttribute('aria-pressed', 'false');
  await expect(bell(page)).toHaveText('🔕');
});

test('a save that fails leaves the bell as it was and says why', async ({ page }) => {
  await page.goto('/inbox-harness.html');
  await expect(bell(page)).toHaveAttribute('aria-pressed', 'true');
  await page.evaluate(() => { (window as any).__NOTIFICATIONS = new Error('disk full'); });

  await bell(page).click();
  await expect(bell(page)).toHaveAttribute('title', /Could not change notifications: disk full/);
  await expect(bell(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(bell(page)).toBeFocused();
  await expect(bell(page)).not.toHaveAttribute('aria-busy', 'true');
});

test('the bell works from the keyboard and keeps focus', async ({ page }) => {
  await page.goto('/inbox-harness.html');
  await bell(page).focus();
  await page.keyboard.press('Enter');
  await expect(bell(page)).toHaveAttribute('aria-pressed', 'false');
  await expect(bell(page)).toBeFocused();
  await page.keyboard.press('Space');
  await expect(bell(page)).toHaveAttribute('aria-pressed', 'true');
});
