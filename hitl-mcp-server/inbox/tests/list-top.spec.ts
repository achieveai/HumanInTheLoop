import { test, expect, type Page } from '@playwright/test';
import { list, message, MINUTE, NOW } from './fixtures.js';

// The list keeps what you are reading still when new messages arrive, with one
// exception: at the top (the first message visible), new messages show.

const rows = (count: number) => Array.from({ length: count }, (_, i) => message({
  messageId: `m-${i}`,
  title: `Message ${i}`,
  createdAt: NOW - (i + 1) * MINUTE,
}));

async function open(page: Page, messages: ReturnType<typeof rows>) {
  await page.addInitScript(f => {
    (window as any).__INBOX_FIXTURE = f;
  }, { messages: list({ messages, filter: 'all', defaultFilter: 'all' }) });
  await page.goto('/inbox-harness.html');
  await expect(page.locator('.message-row').first()).toBeVisible();
}

async function arrive(page: Page, messages: ReturnType<typeof rows>, count = 2) {
  const fresh = Array.from({ length: count }, (_, i) => message({
    messageId: `new-${i}`,
    title: `New ${i}`,
    createdAt: NOW + (count - i) * MINUTE,
  }));
  const lists = () => page.evaluate(() => (window as any).__INVOCATIONS
    .filter((call: any) => call.cmd === 'list_messages').length);
  const before = await lists();
  await page.evaluate(projection => {
    (window as any).__INBOX_FIXTURE.messages = projection;
    (window as any).__simulateChange();
  }, list({ messages: [...fresh, ...messages], filter: 'all', defaultFilter: 'all' }));
  // A long list mounts only what is on screen, so wait for the refresh itself.
  await expect.poll(lists).toBeGreaterThan(before);
  await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
}

const scrollTop = (page: Page) => page.locator('#message-list').evaluate(el => el.scrollTop);

for (const [kind, count] of [['short', 30], ['long (virtual)', 260]] as const) {
  test.describe(`A ${kind} list`, () => {
    test('at the top, with a message open, new messages show', async ({ page }) => {
      const messages = rows(count);
      await open(page, messages);
      await page.locator('.message-row[data-message-id="m-0"]').click();
      await expect(page.locator('.message-row.is-selected')).toHaveAttribute('data-message-id', 'm-0');

      await arrive(page, messages);
      await expect(page.locator('.message-row[data-message-id="new-0"]')).toBeInViewport();
      expect(await scrollTop(page)).toBe(0);
    });

    test('with the first message only partly visible, new messages still show', async ({ page }) => {
      const messages = rows(count);
      await open(page, messages);
      await page.locator('.message-row[data-message-id="m-1"]').click();
      await page.locator('#message-list').evaluate(el => { el.scrollTop = 20; });

      await arrive(page, messages);
      await expect(page.locator('.message-row[data-message-id="new-0"]')).toBeInViewport();
      expect(await scrollTop(page)).toBe(0);
    });

    test('scrolled down, what you are reading stays put', async ({ page }) => {
      const messages = rows(count);
      await open(page, messages);
      const row = page.locator('.message-row[data-message-id="m-12"]');
      await row.scrollIntoViewIfNeeded();
      await row.click();
      await page.locator('#message-list').evaluate(el => {
        const target = el.querySelector('[data-message-id="m-12"]') as HTMLElement;
        el.scrollTop += target.getBoundingClientRect().top - el.getBoundingClientRect().top - 100;
      });
      const before = await row.evaluate(r => r.getBoundingClientRect().top);

      await arrive(page, messages);
      await expect.poll(async () => Math.abs(await row.evaluate(r => r.getBoundingClientRect().top) - before)).toBeLessThan(2);
      await expect(page.locator('.message-row[data-message-id="new-0"]')).not.toBeInViewport();
    });
  });
}
