import { test, expect, type Page } from '@playwright/test';
import { detail, list, message, project, session, tree } from './fixtures.js';

// Clicking a toast raises the Inbox and sends `inbox-reveal` with the toast's
// message id. The page opens that message even when the list in front hides it.

const KEY = 'Hitl_MCP · a3f2';
const ASK = message({ messageId: 'q-1', msgType: 'question', title: 'Red or blue?', status: 'pending' });
const DONE = message({ messageId: 'n-1', msgType: 'notification', title: 'Build done', status: 'answered' });
const ALL = list({ messages: [ASK, DONE], filter: 'all', defaultFilter: 'needs_you' });

const fixture = (messages: Record<string, unknown>) => ({
  sessions: tree({ projects: [project({ projectKey: 'Hitl_MCP', sessions: [session({ sessionKey: KEY, label: 'master · a3f2' })] })] }),
  messages,
  details: {
    'q-1': detail(ASK, { request: { question: 'Red or blue?', options: [] } }),
    'n-1': detail(DONE, { request: { title: 'Build done', body: 'ok' } }),
  },
});

async function open(page: Page, messages: Record<string, unknown>, rows: number) {
  await page.addInitScript(f => {
    (window as any).__INBOX_FIXTURE = f;
  }, fixture(messages));
  await page.goto('/inbox-harness.html');
  await expect(page.locator('.message-row')).toHaveCount(rows);
}

const reveal = (page: Page, messageId: string) =>
  page.evaluate(id => (window as any).__listeners['inbox-reveal']({ payload: { messageId: id } }), messageId);

const selected = (page: Page) => page.locator('.message-row.is-selected');

test.describe('Toast click', () => {
  test('opens its message when the agent and status filter hide it', async ({ page }) => {
    await open(page, {
      // An agent picked, under its default "Needs you": the finished build is hidden.
      [`session:${KEY}|null`]: list({ messages: [ASK], filter: 'needs_you', scopeKey: `session:${KEY}` }),
      'all|null': list({ messages: [ASK], filter: 'needs_you' }),
      'all|all': ALL,
    }, 1);
    await page.locator(`.agent-row[data-scope-key="session:${KEY}"]`).click();
    await expect(page.locator('.message-row')).toHaveCount(1);

    await reveal(page, 'n-1');

    await expect(selected(page)).toHaveAttribute('data-message-id', 'n-1');
    await expect(page.locator('.filter[data-filter="all"]')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.agent-row[data-scope-key="all"]')).toHaveClass(/is-selected/);
    await expect(page.locator('#pane-detail')).toContainText('Build done');
    await expect(selected(page)).toBeInViewport();
  });

  test('turns its type back on when the type chips hide it', async ({ page }) => {
    await open(page, { 'all|null': ALL, 'all|all': ALL }, 2);
    await page.locator('.type-filter[data-type="notification"]').click();
    await expect(page.locator('.message-row')).toHaveCount(1);

    await reveal(page, 'n-1');

    await expect(selected(page)).toHaveAttribute('data-message-id', 'n-1');
    await expect(page.locator('.type-filter[data-type="notification"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#pane-detail')).toContainText('Build done');
  });

  test('scrolls a long list to its message and marks it selected', async ({ page }) => {
    // Past 200 rows the list draws only what is on screen.
    const many = Array.from({ length: 250 }, (_, i) =>
      message({ messageId: `old-${i}`, msgType: 'notification', title: `Old ${i}`, status: 'answered' }));
    const far = many[240];
    await page.addInitScript(f => {
      (window as any).__INBOX_FIXTURE = f;
    }, {
      ...fixture({ 'all|null': list({ messages: [ASK], filter: 'needs_you' }), 'all|all': list({ messages: [ASK, ...many], filter: 'all' }) }),
      details: { 'old-240': detail(far, { request: { title: 'Old 240', body: 'ok' } }) },
    });
    await page.goto('/inbox-harness.html');
    await expect(page.locator('.message-row')).toHaveCount(1);

    await reveal(page, 'old-240');

    await expect(selected(page)).toHaveAttribute('data-message-id', 'old-240');
    await expect(selected(page)).toBeInViewport();
    await expect(page.locator('#pane-detail')).toContainText('Old 240');
  });

  test('waits for a message that reaches the list after the click', async ({ page }) => {
    // The toast is clicked before the refresh its own arrival started is done.
    await open(page, { 'all|null': list({ messages: [ASK], filter: 'all' }), 'all|all': list({ messages: [ASK], filter: 'all' }) }, 1);

    await reveal(page, 'n-1');
    await expect(selected(page)).toHaveCount(0);

    await page.evaluate(all => {
      const fixture = (window as any).__INBOX_FIXTURE;
      fixture.messages['all|null'] = all;
      fixture.messages['all|all'] = all;
      (window as any).__simulateChange();
    }, ALL);

    await expect(selected(page)).toHaveAttribute('data-message-id', 'n-1');
    await expect(page.locator('#pane-detail')).toContainText('Build done');
  });

  test('a row picked while waiting wins over the late message', async ({ page }) => {
    await open(page, { 'all|null': list({ messages: [ASK], filter: 'all' }), 'all|all': list({ messages: [ASK], filter: 'all' }) }, 1);
    await reveal(page, 'n-1');
    await page.locator('.message-row[data-message-id="q-1"]').click();

    await page.evaluate(all => {
      const fixture = (window as any).__INBOX_FIXTURE;
      fixture.messages['all|null'] = all;
      fixture.messages['all|all'] = all;
      (window as any).__simulateChange();
    }, ALL);

    await expect(page.locator('.message-row')).toHaveCount(2);
    await expect(selected(page)).toHaveAttribute('data-message-id', 'q-1');
  });

  test('leaves the list alone for a message the Inbox does not have', async ({ page }) => {
    await open(page, { 'all|null': ALL, 'all|all': ALL }, 2);
    await page.locator('.message-row[data-message-id="q-1"]').click();

    await reveal(page, 'gone');

    await expect(selected(page)).toHaveAttribute('data-message-id', 'q-1');
    await expect(page.locator('.message-row')).toHaveCount(2);
  });
});
