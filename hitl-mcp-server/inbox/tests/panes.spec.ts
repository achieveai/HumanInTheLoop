import { test, expect, type Page } from '@playwright/test';
import { Fixture, detail, list, message, project, session, tree } from './fixtures.js';

// Hand-set pane controls: the collapse cycle and the drag handles.
//
// The distinction that matters here is the one layout.js already draws. There,
// `layout` is a function of viewport width and is never set by hand. Here,
// `collapse` and `widths` are the opposite: set by hand and never by width.
// Keeping them apart is what lets a collapse survive a resize, so most of these
// tests are about the seam between the two rather than about either alone.

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

const FIXTURE: Fixture = {
  messages: list({ messages: [NOTE] }),
  details: { 'n-1': detail(NOTE, { request: { body: 'All green.' } }) },
};

async function open(page: Page, viewport: { width: number; height: number }) {
  await page.setViewportSize(viewport);
  await page.addInitScript(f => {
    (window as any).__INBOX_FIXTURE = f;
  }, { sessions: AGENTS, ...FIXTURE });
  await page.goto('/inbox-harness.html');
  await expect(page.locator('.filter-bar .filter')).toHaveCount(4);
}

/** Web-first, for the same reason `expectLayout` is: the attribute settles asynchronously. */
const expectCollapse = (page: Page, value: string) =>
  expect(page.locator('html')).toHaveAttribute('data-collapse', value);

test.describe('the collapse cycle', () => {
  test('starts with nothing collapsed', async ({ page }) => {
    await open(page, WIDE);

    await expectCollapse(page, '0');
    await expect(page.locator('.pane-agents')).toBeVisible();
    await expect(page.locator('.pane-list')).toBeVisible();
    await expect(page.locator('.pane-detail')).toBeVisible();
  });

  test('one step hides the agent tree', async ({ page }) => {
    await open(page, WIDE);

    await page.locator('#pane-cycle').click();

    await expectCollapse(page, '1');
    await expect(page.locator('.pane-agents')).toBeHidden();
    await expect(page.locator('.pane-list')).toBeVisible();
    await expect(page.locator('.pane-detail')).toBeVisible();
  });

  test('two steps leave the detail pane alone on screen', async ({ page }) => {
    await open(page, WIDE);

    await page.locator('#pane-cycle').click();
    await page.locator('#pane-cycle').click();

    await expectCollapse(page, '2');
    await expect(page.locator('.pane-agents')).toBeHidden();
    await expect(page.locator('.pane-list')).toBeHidden();
    await expect(page.locator('.pane-detail')).toBeVisible();
  });

  test('a third step wraps back to all three', async ({ page }) => {
    await open(page, WIDE);

    for (let i = 0; i < 3; i++) await page.locator('#pane-cycle').click();

    await expectCollapse(page, '0');
    await expect(page.locator('.pane-agents')).toBeVisible();
    await expect(page.locator('.pane-list')).toBeVisible();
  });
});

test.describe('the keyboard', () => {
  test('Control+B steps the cycle', async ({ page }) => {
    await open(page, WIDE);

    await page.keyboard.press('Control+b');
    await expectCollapse(page, '1');

    await page.keyboard.press('Control+b');
    await expectCollapse(page, '2');
  });

  test('Escape returns to all three panes', async ({ page }) => {
    await open(page, WIDE);

    await page.locator('#pane-cycle').click();
    await page.locator('#pane-cycle').click();
    await expectCollapse(page, '2');

    await page.keyboard.press('Escape');

    await expectCollapse(page, '0');
  });
});

test.describe('collapse and the breakpoints are independent', () => {
  test('a collapse survives a trip through tablet and back', async ({ page }) => {
    await open(page, WIDE);
    await page.locator('#pane-cycle').click();
    await expectCollapse(page, '1');

    await page.setViewportSize(TABLET);
    await expect(page.locator('html')).toHaveAttribute('data-layout', 'tablet');

    await page.setViewportSize(WIDE);
    await expect(page.locator('html')).toHaveAttribute('data-layout', 'wide');

    // The whole point of keeping the two apart: the width came back, and so did
    // the layout, but the hand-set choice was never touched by either.
    await expectCollapse(page, '1');
    await expect(page.locator('.pane-agents')).toBeHidden();
  });

  test('phone ignores it: one pane already fits, so data-pane still governs', async ({ page }) => {
    await open(page, WIDE);
    await page.locator('#pane-cycle').click();
    await page.locator('#pane-cycle').click();
    await expectCollapse(page, '2');

    await page.setViewportSize(PHONE);
    await expect(page.locator('html')).toHaveAttribute('data-layout', 'phone');

    // `collapse` is still 2 — it is not reset, merely not consulted here.
    await expectCollapse(page, '2');
    await expect(page.locator('.pane-list')).toBeVisible();
    await expect(page.locator('.pane-detail')).toBeHidden();
  });
});

test.describe('the drag handles', () => {
  /** Width of a pane as the browser actually laid it out. */
  const widthOf = async (page: Page, selector: string) => {
    const box = await page.locator(selector).boundingBox();
    return box?.width ?? 0;
  };

  async function drag(page: Page, handle: string, byX: number) {
    const box = await page.locator(handle).boundingBox();
    if (!box) throw new Error(`${handle} has no box`);
    const y = box.y + box.height / 2;
    await page.mouse.move(box.x + box.width / 2, y);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + byX, y, { steps: 10 });
    await page.mouse.up();
  }

  test('dragging the first handle widens the agent tree', async ({ page }) => {
    await open(page, WIDE);
    const before = await widthOf(page, '.pane-agents');

    await drag(page, '#pane-handle-1', 80);

    expect(await widthOf(page, '.pane-agents')).toBeGreaterThan(before + 50);
  });

  test('a drag past the minimum clamps instead of collapsing the pane', async ({ page }) => {
    await open(page, WIDE);

    // Far further left than the list can give up.
    await drag(page, '#pane-handle-2', -900);

    // 320px is the list's existing floor, and a clamp must respect it rather
    // than letting a drag do what only the collapse control is allowed to do.
    expect(await widthOf(page, '.pane-list')).toBeGreaterThanOrEqual(320);
    await expect(page.locator('.pane-list')).toBeVisible();
  });

  test('double-click resets a boundary to its default', async ({ page }) => {
    await open(page, WIDE);
    const original = await widthOf(page, '.pane-agents');

    await drag(page, '#pane-handle-1', 80);
    expect(await widthOf(page, '.pane-agents')).toBeGreaterThan(original + 50);

    await page.locator('#pane-handle-1').dblclick();

    expect(await widthOf(page, '.pane-agents')).toBeCloseTo(original, 0);
  });

  test('no handles where there is no boundary to drag', async ({ page }) => {
    await open(page, PHONE);

    await expect(page.locator('#pane-handle-1')).toBeHidden();
    await expect(page.locator('#pane-handle-2')).toBeHidden();
  });
});

test.describe('both survive a restart', () => {
  test('the collapse is still there after a reload', async ({ page }) => {
    await open(page, WIDE);
    await page.locator('#pane-cycle').click();
    await expectCollapse(page, '1');

    await page.reload();
    await expect(page.locator('.filter-bar .filter')).toHaveCount(4);

    await expectCollapse(page, '1');
    await expect(page.locator('.pane-agents')).toBeHidden();
  });

  test('a dragged width is still there after a reload', async ({ page }) => {
    await open(page, WIDE);
    const box = await page.locator('#pane-handle-1').boundingBox();
    if (!box) throw new Error('no handle');
    const y = box.y + box.height / 2;
    await page.mouse.move(box.x + box.width / 2, y);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 80, y, { steps: 10 });
    await page.mouse.up();

    const widened = (await page.locator('.pane-agents').boundingBox())?.width ?? 0;

    await page.reload();
    await expect(page.locator('.filter-bar .filter')).toHaveCount(4);

    const after = (await page.locator('.pane-agents').boundingBox())?.width ?? 0;
    expect(after).toBeCloseTo(widened, 0);
  });

  test('a stored width too wide for the viewport is clamped on read, not discarded', async ({ page }) => {
    await open(page, WIDE);
    await page.evaluate(() => {
      localStorage.setItem('inbox.panes', JSON.stringify({ collapse: 0, widths: [5000, 400] }));
    });

    await page.reload();
    await expect(page.locator('.filter-bar .filter')).toHaveCount(4);

    // Clamped to something that fits, and the panes it would have pushed off
    // screen are still on it.
    const agents = (await page.locator('.pane-agents').boundingBox())?.width ?? 0;
    expect(agents).toBeLessThan(1280);
    await expect(page.locator('.pane-detail')).toBeVisible();
  });
});

test.describe('a handle sits on the boundary it drags', () => {
  /**
   * Position, not just presence.
   *
   * The drag tests above pass whether or not the handles are where they claim
   * to be: Playwright aims at the element's own box, so a handle stacked at the
   * left edge still drags. Only a human would notice there was nothing to grab
   * at the seam. That is what this asserts.
   */
  const leftEdgeOf = async (page: Page, selector: string) =>
    (await page.locator(selector).boundingBox())?.x ?? -1;

  test('with three panes, each handle is at the seam behind it', async ({ page }) => {
    await open(page, WIDE);

    const listLeft = await leftEdgeOf(page, '.pane-list');
    const detailLeft = await leftEdgeOf(page, '.pane-detail');

    // The handle straddles the seam, so its own left edge sits half a width to
    // the left of it.
    expect(await leftEdgeOf(page, '#pane-handle-1')).toBeCloseTo(listLeft - 5, 0);
    expect(await leftEdgeOf(page, '#pane-handle-2')).toBeCloseTo(detailLeft - 5, 0);
  });

  test('collapsing moves the remaining handle to the seam that is left', async ({ page }) => {
    await open(page, WIDE);
    await page.locator('#pane-cycle').click();
    await expectCollapse(page, '1');

    const detailLeft = await leftEdgeOf(page, '.pane-detail');

    expect(await leftEdgeOf(page, '#pane-handle-2')).toBeCloseTo(detailLeft - 5, 0);
  });

  test('a drag carries the handle along with the seam', async ({ page }) => {
    await open(page, WIDE);
    const handle = page.locator('#pane-handle-1');
    const box = await handle.boundingBox();
    if (!box) throw new Error('no handle');
    const y = box.y + box.height / 2;

    await page.mouse.move(box.x + box.width / 2, y);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 80, y, { steps: 10 });
    await page.mouse.up();

    const listLeft = await leftEdgeOf(page, '.pane-list');
    expect(await leftEdgeOf(page, '#pane-handle-1')).toBeCloseTo(listLeft - 5, 0);
  });
});
