import { test, expect } from '@playwright/test';

// notifications-harness.html imports the real notifications.js module (unlike
// the older test-notifications.html, which hand-duplicated card markup) and
// mocks window.__TAURI__, capturing listen() callbacks so a sender-identity
// event can be simulated through the real listener.

const SENDER = { label: 'Kay9 - work-item/1-reviewplan', source: 'worktree' };

function notificationJson(overrides: Record<string, unknown> = {}) {
  return JSON.stringify(Object.assign({
    messageId: 'notif-001',
    timestamp: Date.now(),
    title: 'Build Complete',
    body: 'All tests passed.',
  }, overrides));
}

function url(notification: string) {
  return `/notifications-harness.html?notification=${encodeURIComponent(notification)}`;
}

test.describe('Sender badge on the notification window', () => {
  test('a notification whose payload already includes sender shows the badge immediately', async ({ page }) => {
    await page.goto(url(notificationJson({ sender: SENDER })));

    const badge = page.locator('.notification-card .badge-sender');
    await expect(badge).toBeVisible();
    await expect(badge).toBeInViewport();
    await expect(badge).toHaveAttribute('title', SENDER.label);

    // Lives in the header area, not nested in the body/context regions.
    await expect(page.locator('.notification-body .badge-sender, .notification-context .badge-sender')).toHaveCount(0);
  });

  test('a live sender-identity event patches an already-rendered card without a re-render', async ({ page }) => {
    await page.goto(url(notificationJson()));
    await expect(page.locator('.badge-sender')).toHaveCount(0);

    await page.evaluate(
      ({ id, sender }) => (window as any).__simulateSenderIdentity(id, sender),
      { id: 'notif-001', sender: SENDER },
    );

    const badge = page.locator('.notification-card .badge-sender');
    await expect(badge).toBeVisible();
    await expect(badge).toHaveAttribute('title', SENDER.label);
    // The rest of the card is untouched by the patch.
    await expect(page.locator('.notification-title')).toHaveText('Build Complete');
  });

  test('a long label truncates with ellipsis and keeps the full text in the title attribute', async ({ page }) => {
    const longLabel = 'Kay9 - a-very-long-linked-worktree-branch-name-that-must-not-wrap-or-overflow';
    await page.goto(url(notificationJson({ sender: { label: longLabel, source: 'worktree' } })));

    const badge = page.locator('.notification-card .badge-sender');
    await expect(badge).toHaveAttribute('title', longLabel);

    const style = await badge.evaluate(el => {
      const computed = getComputedStyle(el);
      return { overflow: computed.overflow, textOverflow: computed.textOverflow, whiteSpace: computed.whiteSpace };
    });
    expect(style.overflow).toBe('hidden');
    expect(style.textOverflow).toBe('ellipsis');
    expect(style.whiteSpace).toBe('nowrap');
  });

  test('a sender-identity event for an unmatched forMessageId is a silent no-op', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(url(notificationJson()));

    await page.evaluate(
      ({ sender }) => (window as any).__simulateSenderIdentity('does-not-exist', sender),
      { sender: SENDER },
    );

    await expect(page.locator('.badge-sender')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('renders no badge when the notification carries no sender', async ({ page }) => {
    await page.goto(url(notificationJson()));
    await expect(page.locator('.badge-sender')).toHaveCount(0);
  });
});
