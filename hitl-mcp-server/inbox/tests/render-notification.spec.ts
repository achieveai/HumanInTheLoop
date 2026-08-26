import { test, expect } from '@playwright/test';
import { MINUTE, NOW, detail, message } from './fixtures.js';
import { mount, recorded } from './mount.js';

// Pane 3, notifications (spec §8.1).
//
// The renderer is short and the interesting behaviour is all at its edges: what
// markdown is allowed to do, and what "dismissed" means here as against what it
// means in the popup.

const REQUEST = {
  title: 'Deploy finished',
  body: 'Shipped **v2.11.2** to production.\n\n- 3 services\n- 0 rollbacks',
  context: 'You asked to be told when the release went out.',
};

const OPEN = detail(
  message({
    messageId: 'n-1',
    msgType: 'notification',
    title: 'Deploy finished',
    status: 'pending',
  }),
  { request: REQUEST, sender: { label: 'Hitl_MCP · master · a3f2', source: 'session' } },
);

const DISMISSED = detail(
  message({
    messageId: 'n-1',
    msgType: 'notification',
    title: 'Deploy finished',
    status: 'dismissed',
    responder: 'Kay9 phone',
    respondedAt: NOW - MINUTE,
  }),
  { request: REQUEST, settlement: {}, sender: { label: 'Hitl_MCP · master · a3f2', source: 'session' } },
);

test.describe('Pane 3 — notifications (spec §8.1)', () => {
  test('shows the title, the body as markdown, the sender and the context', async ({ page }) => {
    await mount(page, 'notification', OPEN);

    await expect(page.locator('.detail-kicker')).toHaveText('Notification');
    await expect(page.locator('.detail-title')).toHaveText('Deploy finished');

    // Markdown, not a literal asterisk pair.
    await expect(page.locator('.notification-body strong')).toHaveText('v2.11.2');
    await expect(page.locator('.notification-body li')).toHaveCount(2);

    const badge = page.locator('.badge-sender');
    await expect(badge).toHaveText('Hitl_MCP · master · a3f2');
    await expect(badge).toHaveAttribute('data-source', 'session');

    // Context is collapsed until asked for — the notification is the point.
    await expect(page.locator('.detail-context-body')).toBeHidden();
    await page.locator('.detail-context-toggle').click();
    await expect(page.locator('.detail-context-body')).toContainText('You asked to be told');
  });

  test('a body cannot paint its own UI', async ({ page }) => {
    // markdown-it runs with `html: false`, so agent-authored markup is text.
    // A notification that can draw a convincing fake button is a notification
    // that can be used to make someone approve something.
    await mount(page, 'notification', detail(
      message({ messageId: 'n-2', msgType: 'notification', title: 'Heads up' }),
      { request: { body: '<button class="button button-primary">Approve</button> and <img src="x">' } },
    ));

    await expect(page.locator('.notification-body button')).toHaveCount(0);
    await expect(page.locator('.notification-body img')).toHaveCount(0);
    await expect(page.locator('.notification-body')).toContainText('<button');
  });

  test('Dismiss is shown but disabled while the reply path is not attached', async ({ page }) => {
    // Hiding it would misstate what the message affords; enabling it would be a
    // button that silently does nothing.
    await mount(page, 'notification', OPEN);

    const button = page.locator('.detail-actions .button', { hasText: 'Dismiss' });
    await expect(button).toBeDisabled();
    await expect(button).toHaveAttribute('data-unattached', 'true');
  });

  test('Dismiss hands the row back when the reply path is attached', async ({ page }) => {
    await mount(page, 'notification', OPEN, { wire: true });

    await page.locator('.detail-actions .button', { hasText: 'Dismiss' }).click();

    expect(await recorded(page)).toEqual([{ action: 'dismiss', messageId: 'n-1' }]);
  });

  test('a dismissed notification is kept, not discarded', async ({ page }) => {
    // The divergence from the popup, and the reason the Inbox is worth having:
    // the popup drops the card, so "what did that agent tell me an hour ago"
    // has no answer. Here the message stays, with its status folded from the
    // `dismiss_notification` event — which is also why a dismissal on the
    // phone shows up on the desktop.
    await mount(page, 'notification', DISMISSED);

    await expect(page.locator('.detail-root')).toHaveAttribute('data-status', 'dismissed');
    await expect(page.locator('.status-pill-label')).toHaveText('dismissed');
    await expect(page.locator('.detail-closed-verb')).toHaveText('Dismissed by');
    await expect(page.locator('.detail-responder')).toHaveText('Kay9 phone');

    await expect(page.locator('.detail-actions .button')).toHaveCount(0);
    await expect(page.locator('.detail-retained'))
      .toContainText('kept in the Inbox so the agent’s history stays readable');

    // Still readable. A dismissed notification whose body vanished would be a
    // record of nothing.
    await expect(page.locator('.notification-body strong')).toHaveText('v2.11.2');
  });
});
