import { expect, test } from '@playwright/test';
import { unreadableText } from '../../client/tests/appearance-contrast.js';
import { detail, message, project, session, tree, list } from './fixtures.js';
import { mount } from './mount.js';

test.use({ viewport: { width: 1280, height: 900 } });

test('appearance is explicit, save-first, keyboard accessible and independent of notifications', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/inbox-harness.html');
  await expect(page.locator('html')).not.toHaveAttribute('data-hitl-theme', 'dark');
  const toggle = page.getByRole('button', { name: 'Dark mode', exact: true });
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(toggle).toHaveAttribute('title', 'Switch to dark mode');
  await toggle.click();
  await expect(page.locator('html')).toHaveAttribute('data-hitl-theme', 'dark');
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(toggle).toHaveAttribute('title', 'Switch to light mode');
  await expect(toggle).toBeFocused();
  await expect(page.locator('dialog[open]')).toHaveCount(0);
  await expect(page.locator('#notifications-toggle')).toHaveAttribute('aria-pressed', 'true');
  await page.evaluate(() => { (window as any).__APPEARANCE_ERROR = 'disk full'; });
  await toggle.click();
  await expect(page.locator('#appearance-warning')).toContainText('disk full');
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(toggle).toHaveAttribute('aria-disabled', 'false');
  await expect(toggle).toBeFocused();
  await expect(page.locator('html')).toHaveAttribute('data-hitl-theme', 'dark');
  await page.evaluate(() => { delete (window as any).__APPEARANCE_ERROR; });
  await toggle.press('Enter');
  await expect(page.locator('html')).not.toHaveAttribute('data-hitl-theme', 'dark');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(toggle).not.toHaveAttribute('aria-busy', 'true');
  await toggle.press('Space');
  await expect(page.locator('html')).toHaveAttribute('data-hitl-theme', 'dark');
});

test('toggle reflects saved themes and changes from another window', async ({ page }) => {
  await page.addInitScript(() => { (window as any).__APPEARANCE = 'dark'; });
  await page.goto('/inbox-harness.html');
  const toggle = page.getByRole('button', { name: 'Dark mode', exact: true });
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await page.evaluate(() => (window as any).__listeners['appearance-changed']({
    payload: { theme: 'light', warning: null },
  }));
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(toggle).toHaveAttribute('title', 'Switch to dark mode');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
});

test('pending saves keep focus and ignore repeated clicks', async ({ page }) => {
  await page.goto('/inbox-harness.html');
  const toggle = page.getByRole('button', { name: 'Dark mode', exact: true });
  await expect(toggle).toHaveAttribute('aria-disabled', 'false');
  await page.evaluate(() => {
    const w = window as any;
    const invoke = w.__TAURI__.core.invoke;
    w.__themeSaveCount = 0;
    w.__TAURI__.core.invoke = (cmd: string, args: unknown) => {
      if (cmd !== 'set_appearance') return invoke(cmd, args);
      w.__themeSaveCount++;
      return new Promise(resolve => { w.__finishThemeSave = resolve; });
    };
  });
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-busy', 'true');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(toggle).toBeFocused();
  await toggle.evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
  expect(await page.evaluate(() => (window as any).__themeSaveCount)).toBe(1);
  await page.evaluate(() => (window as any).__finishThemeSave({ theme: 'dark', warning: null }));
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(toggle).toHaveAttribute('aria-disabled', 'false');
  await expect(toggle).toBeFocused();
});

test('all shell row states retain readable text in dark mode', async ({ page }) => {
  const messages = ['pending', 'stale', 'answered', 'lost', 'sent', 'replied'].map((status, i) =>
    message({ messageId: `state-${i}`, title: `${status} message`, status, machine: 'Desktop', sessionName: 'Agent' }));
  await page.addInitScript(fixture => { (window as any).__INBOX_FIXTURE = fixture; }, {
    sessions: tree({ projects: [project({ projectKey: 'HITL', sessions: [
      session({ sessionKey: 'waiting', state: 'waiting', pendingCount: 2 }),
      session({ sessionKey: 'stale', state: 'stale' }),
    ] })] }),
    messages: list({ messages }),
  });
  await page.goto('/inbox-harness.html');
  await page.evaluate(async () => (await import('/theme.js')).applyAppearance('dark'));
  expect(await unreadableText(page)).toEqual([]);
});

for (const kind of ['question', 'notification', 'handoff'] as const) {
  test(`${kind} content and controls have readable dark pairs`, async ({ page }) => {
    await mount(page, kind, detail(message({ messageId: 'q', msgType: kind }), { request: {
      question: 'Choose a backend', title: 'Result', summary: 'Finished',
      body: 'A **report** with `code` and a [link](https://example.com).',
      allowOther: true, options: [{ label: 'SQLite', value: 'sql', description: 'Storage', preview: '## Preview\n\nSome text' }],
    } }), { wire: true });
    await page.evaluate(async () => (await import('/theme.js')).applyAppearance('dark'));
    expect(await unreadableText(page)).toEqual([]);
  });
}
