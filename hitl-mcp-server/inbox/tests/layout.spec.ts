import { test, expect, type Page } from '@playwright/test';
import { Fixture, detail, list, message, project, session, tree } from './fixtures.js';

// Responsive layout (mobile spec §4, §4.1, §4.2).
//
// Every one of these runs on a desktop browser at a chosen width, which is the
// whole point of the design: breakpoints are pane-count decisions, not device
// decisions, so a half-width window *is* the tablet layout. If these could only
// be checked on a phone, the rule would have been written wrong.

const WIDE = { width: 1280, height: 800 };
const TABLET = { width: 900, height: 800 };
const PHONE = { width: 420, height: 800 };

const AGENTS = tree({
  projects: [
    project({
      projectKey: 'Hitl_MCP',
      state: 'waiting',
      pendingCount: 1,
      sessions: [
        session({
          sessionKey: 'Hitl_MCP · master · a3f2',
          label: 'master · a3f2',
          state: 'waiting',
          pendingCount: 1,
        }),
      ],
    }),
  ],
});

const NOTE = message({ messageId: 'n-1', msgType: 'notification', title: 'Deploy finished' });
const QUESTION = message({ messageId: 'q-1', msgType: 'question', title: 'Which storage backend?' });

const FIXTURE: Fixture = {
  messages: list({ messages: [NOTE, QUESTION] }),
  details: {
    'n-1': detail(NOTE, { request: { body: 'All green.' } }),
    'q-1': detail(QUESTION, {
      request: { question: 'Which storage backend?', allowOther: true, options: [{ label: 'SQLite', value: 'sqlite' }] },
    }),
  },
};

async function open(page: Page, viewport: { width: number; height: number }) {
  await page.setViewportSize(viewport);
  await page.addInitScript(f => {
    (window as any).__INBOX_FIXTURE = f;
  }, { sessions: AGENTS, ...FIXTURE });
  await page.goto('/inbox-harness.html');
  await expect(page.locator('.filter-bar .filter')).toHaveCount(4);
}

/**
 * Assert the layout, retrying.
 *
 * A one-shot `getAttribute` races the `matchMedia` change event: the resize has
 * landed but the listener may not have run yet, so it reads the *previous*
 * layout and either fails or — worse — passes by luck in the direction where
 * the old value happens to match. A web-first assertion polls instead, so this
 * proves the layout settled rather than that it was already right.
 */
const expectLayout = (page: Page, value: string) =>
  expect(page.locator('html')).toHaveAttribute('data-layout', value);

test.describe('§4 — how many panes each width shows', () => {
  test('wide shows all three and no chrome', async ({ page }) => {
    await open(page, WIDE);

    await expectLayout(page, 'wide');
    await expect(page.locator('.pane-agents')).toBeVisible();
    await expect(page.locator('.pane-list')).toBeVisible();
    await expect(page.locator('.pane-detail')).toBeVisible();
    // Nothing to navigate, so nothing to navigate with.
    await expect(page.locator('.inbox-bar')).toBeHidden();
  });

  test('tablet keeps list and detail, and hides the agent tree', async ({ page }) => {
    await open(page, TABLET);

    await expectLayout(page, 'tablet');
    await expect(page.locator('.pane-list')).toBeVisible();
    await expect(page.locator('.pane-detail')).toBeVisible();
    await expect(page.locator('.pane-agents')).toBeHidden();
    await expect(page.locator('.inbox-bar')).toBeVisible();
  });

  test('phone shows exactly one', async ({ page }) => {
    await open(page, PHONE);

    await expectLayout(page, 'phone');
    await expect(page.locator('.pane-list')).toBeVisible();
    await expect(page.locator('.pane-detail')).toBeHidden();
    await expect(page.locator('.pane-agents')).toBeHidden();
  });
});

test.describe('§4 — the agent tree as an overlay', () => {
  test('the menu opens it over the list, and the scrim closes it', async ({ page }) => {
    await open(page, TABLET);

    await expect(page.locator('.pane-agents')).toBeHidden();
    await page.locator('#agents-toggle').click();
    await expect(page.locator('.pane-agents')).toBeVisible();
    await expect(page.locator('.inbox-scrim')).toBeVisible();

    // It is an overlay, not a third column: the list is still there under it.
    await expect(page.locator('.pane-list')).toBeVisible();

    await page.locator('.inbox-scrim').click();
    await expect(page.locator('.pane-agents')).toBeHidden();
  });

  test('picking an agent dismisses it', async ({ page }) => {
    await open(page, TABLET);

    await page.locator('#agents-toggle').click();
    await expect(page.locator('.pane-agents')).toBeVisible();

    await page.locator('.agent-row').first().click();
    await expect(page.locator('.pane-agents')).toBeHidden();
  });
});

test.describe('§4.1 — back moves one pane rather than exiting', () => {
  test('list to detail and back again', async ({ page }) => {
    await open(page, PHONE);

    // Home. There is nowhere behind this, so no back control is offered.
    await expect(page.locator('#pane-back')).toBeHidden();

    await page.locator('.message-row[data-message-id="q-1"]').click();
    await expect(page.locator('.pane-detail')).toBeVisible();
    await expect(page.locator('.pane-list')).toBeHidden();
    await expect(page.locator('#pane-back')).toBeVisible();

    await page.locator('#pane-back').click();

    // One pane back — to the list, still inside the app.
    await expect(page.locator('.pane-list')).toBeVisible();
    await expect(page.locator('.pane-detail')).toBeHidden();
    await expect(page.locator('#pane-back')).toBeHidden();
  });

  test('back closes the overlay before it touches the pane behind it', async ({ page }) => {
    await open(page, PHONE);

    await page.locator('#agents-toggle').click();
    await expect(page.locator('.pane-agents')).toBeVisible();

    await page.evaluate(() => (window as any).__PANES?.back());

    await expect(page.locator('.pane-agents')).toBeHidden();
    await expect(page.locator('.pane-list')).toBeVisible();
  });

  test('at home, back reports it consumed nothing', async ({ page }) => {
    await open(page, PHONE);

    // The Android caller needs a false here to know it may exit (spec §4.1);
    // a back() that always claimed the gesture would trap the user in the app.
    expect(await page.evaluate(() => (window as any).__PANES?.back())).toBe(false);
    await expect(page.locator('.pane-list')).toBeVisible();
  });
});

test.describe('§4.2 — selection and layout are independent', () => {
  test('widening past a breakpoint restores both panes with the selection intact', async ({ page }) => {
    await open(page, PHONE);

    await page.locator('.message-row[data-message-id="q-1"]').click();
    await expect(page.locator('.pane-detail')).toBeVisible();
    await expect(page.locator('.pane-list')).toBeHidden();

    await page.setViewportSize(WIDE);

    await expectLayout(page, 'wide');
    await expect(page.locator('.pane-list')).toBeVisible();
    await expect(page.locator('.pane-detail')).toBeVisible();

    // The selection did not reset when the layout changed underneath it.
    await expect(page.locator('.message-row.is-selected')).toHaveAttribute('data-message-id', 'q-1');
    await expect(page.locator('.detail-question')).toHaveCount(1);
  });

  test('narrowing again returns to the pane that was in front', async ({ page }) => {
    await open(page, WIDE);

    await page.locator('.message-row[data-message-id="q-1"]').click();
    await page.setViewportSize(PHONE);

    await expectLayout(page, 'phone');
    // Selecting is what put `detail` in front; the resize did not undo it.
    await expect(page.locator('.pane-detail')).toBeVisible();
    await expect(page.locator('.pane-list')).toBeHidden();
  });
});

test.describe('§4.1 — the reply stays reachable', () => {
  test('detail actions sit inside the viewport, not below a long body', async ({ page }) => {
    await open(page, PHONE);

    await page.locator('.message-row[data-message-id="q-1"]').click();

    const actions = page.locator('.detail-actions');
    await expect(actions).toBeVisible();

    const box = await actions.boundingBox();
    expect(box).not.toBeNull();
    // Pinned means "on screen without scrolling the pane", so its bottom edge
    // must fall within the window rather than somewhere past the fold.
    expect(box!.y + box!.height).toBeLessThanOrEqual(PHONE.height);
  });
});
