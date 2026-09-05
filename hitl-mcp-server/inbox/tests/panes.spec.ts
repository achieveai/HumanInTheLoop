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
  await expect(page.locator('.filter-bar .filter')).toHaveCount(3);
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
    await expect(page.locator('.filter-bar .filter')).toHaveCount(3);

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
    await expect(page.locator('.filter-bar .filter')).toHaveCount(3);

    const after = (await page.locator('.pane-agents').boundingBox())?.width ?? 0;
    expect(after).toBeCloseTo(widened, 0);
  });

  test('a stored width too wide for the viewport is clamped on read, not discarded', async ({ page }) => {
    await open(page, WIDE);
    await page.evaluate(() => {
      localStorage.setItem('inbox.panes', JSON.stringify({ collapse: 0, widths: [5000, 400] }));
    });

    await page.reload();
    await expect(page.locator('.filter-bar .filter')).toHaveCount(3);

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

test.describe('remembered reading-pane orientation', () => {
  const orientation = (page: Page, value: 'right' | 'bottom') =>
    expect(page.locator('html')).toHaveAttribute('data-reading-pane', value);

  async function dragBy(page: Page, selector: string, byX: number, byY: number, yRatio = 0.5) {
    const box = await page.locator(selector).boundingBox();
    if (!box) throw new Error(`${selector} has no box`);
    const x = box.x + box.width / 2;
    const y = box.y + box.height * yRatio;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + byX, y + byY, { steps: 10 });
    await page.mouse.up();
  }

  test('legacy storage defaults to Right and publishes the next-action label', async ({ page }) => {
    await open(page, WIDE);
    await page.evaluate(() => {
      localStorage.setItem('inbox.panes', JSON.stringify({ collapse: 1, widths: [280, 410] }));
    });
    await page.reload();
    await expect(page.locator('.filter-bar .filter')).toHaveCount(3);

    await orientation(page, 'right');
    await expectCollapse(page, '1');
    await expect(page.locator('#reading-pane-toggle')).toHaveAccessibleName('Place reading pane below message list');
  });

  test('toggle changes only geometry and keeps selection, filters, collapse, and scroll positions', async ({ page }) => {
    await open(page, WIDE);
    await page.locator('.message-row[data-message-id="n-1"]').click();
    await page.locator('#pane-cycle').click();
    await page.getByRole('tab', { name: 'All' }).click();
    await page.getByRole('button', { name: 'Questions' }).click();
    await page.evaluate(() => {
      const messageList = document.querySelector('#message-list') as HTMLElement;
      const detailScroll = document.querySelector('.detail-scroll') as HTMLElement;
      const listSpacer = document.createElement('div');
      const detailSpacer = document.createElement('div');
      listSpacer.style.height = '1200px';
      listSpacer.style.minHeight = '1200px';
      detailSpacer.style.height = '1200px';
      detailSpacer.style.minHeight = '1200px';
      messageList.append(listSpacer);
      detailScroll.append(detailSpacer);
      // A position valid in both the tall Right list and the shorter Bottom
      // list; a browser may only preserve up to the new scroll maximum.
      messageList.scrollTop = 60;
      detailScroll.scrollTop = 73;
    });
    const before = await page.evaluate(() => ({
      selected: document.querySelector('.message-row.is-selected')?.getAttribute('data-message-id'),
      filter: document.querySelector('.filter[aria-selected="true"]')?.textContent,
      types: [...document.querySelectorAll('.type-filter')].map(button => ({
        name: button.textContent,
        pressed: button.getAttribute('aria-pressed'),
      })),
      scope: document.querySelector('.agent-row.is-selected')?.textContent,
      pane: document.documentElement.dataset.pane,
      listScroll: (document.querySelector('#message-list') as HTMLElement).scrollTop,
      detailScroll: (document.querySelector('.detail-scroll') as HTMLElement).scrollTop,
    }));
    expect(before.listScroll).toBeGreaterThan(0);
    expect(before.detailScroll).toBeGreaterThan(0);
    expect(await page.locator('#message-list').evaluate(element => getComputedStyle(element).overflowAnchor)).toBe('none');
    expect(await page.locator('.detail-scroll').evaluate(element => getComputedStyle(element).overflowAnchor)).toBe('none');

    await page.locator('#reading-pane-toggle').click();

    await orientation(page, 'bottom');
    await expectCollapse(page, '1');
    await expect(page.locator('#reading-pane-toggle')).toHaveAccessibleName('Place reading pane to the right of message list');
    await expect.poll(() => page.evaluate(() => ({
      selected: document.querySelector('.message-row.is-selected')?.getAttribute('data-message-id'),
      filter: document.querySelector('.filter[aria-selected="true"]')?.textContent,
      types: [...document.querySelectorAll('.type-filter')].map(button => ({
        name: button.textContent,
        pressed: button.getAttribute('aria-pressed'),
      })),
      scope: document.querySelector('.agent-row.is-selected')?.textContent,
      pane: document.documentElement.dataset.pane,
      listScroll: (document.querySelector('#message-list') as HTMLElement).scrollTop,
      detailScroll: (document.querySelector('.detail-scroll') as HTMLElement).scrollTop,
    }))).toEqual(before);

    await page.locator('#reading-pane-toggle').click();
    await orientation(page, 'right');
    await expect.poll(() => page.evaluate(() => ({
      selected: document.querySelector('.message-row.is-selected')?.getAttribute('data-message-id'),
      filter: document.querySelector('.filter[aria-selected="true"]')?.textContent,
      types: [...document.querySelectorAll('.type-filter')].map(button => ({
        name: button.textContent,
        pressed: button.getAttribute('aria-pressed'),
      })),
      scope: document.querySelector('.agent-row.is-selected')?.textContent,
      pane: document.documentElement.dataset.pane,
      listScroll: (document.querySelector('#message-list') as HTMLElement).scrollTop,
      detailScroll: (document.querySelector('.detail-scroll') as HTMLElement).scrollTop,
    }))).toEqual(before);

    expect(await page.locator('#message-list').evaluate(element => getComputedStyle(element).overflowAnchor)).toBe('none');
    await page.waitForTimeout(100);
    await page.locator('#message-list').evaluate((element: HTMLElement) => { element.scrollTop = 90; });
    await expect.poll(() => page.locator('#message-list').evaluate(element => element.scrollTop)).toBe(90);
  });

  test('app-controlled scroll owners stay stable through insertion, removal, and late layout', async ({ page }) => {
    await open(page, WIDE);
    await page.locator('.message-row[data-message-id="n-1"]').click();
    const before = await page.evaluate(() => {
      const owners = [
        document.querySelector('#message-list') as HTMLElement,
        document.querySelector('.detail-scroll') as HTMLElement,
      ];
      owners.forEach((owner, index) => {
        const tail = document.createElement('div');
        tail.id = `scroll-tail-${index}`;
        tail.style.height = '1600px';
        tail.style.minHeight = '1600px';
        owner.append(tail);
        owner.scrollTop = 240 + index * 30;
      });
      return owners.map(owner => owner.scrollTop);
    });
    expect(before.every(top => top > 0)).toBe(true);

    const mutate = async (operation: 'insert' | 'grow' | 'remove') => page.evaluate(async operationName => {
      const owners = [
        document.querySelector('#message-list') as HTMLElement,
        document.querySelector('.detail-scroll') as HTMLElement,
      ];
      owners.forEach((owner, index) => {
        const id = `scroll-update-${index}`;
        if (operationName === 'insert') {
          const update = document.createElement('div');
          update.id = id;
          update.style.height = '24px';
          update.style.minHeight = '24px';
          owner.prepend(update);
        } else if (operationName === 'grow') {
          const update = document.getElementById(id) as HTMLElement;
          update.style.height = '96px';
          update.style.minHeight = '96px';
        } else {
          document.getElementById(id)?.remove();
        }
      });
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
      return owners.map(owner => ({
        top: owner.scrollTop,
        anchor: getComputedStyle(owner).overflowAnchor,
      }));
    }, operation);

    for (const operation of ['insert', 'grow', 'remove'] as const) {
      expect(await mutate(operation)).toEqual(before.map(top => ({ top, anchor: 'none' })));
    }
  });

  test('persists Bottom and its height independently from Right widths', async ({ page }) => {
    await open(page, WIDE);
    await dragBy(page, '#pane-handle-1', 70, 0);
    const rightWidth = (await page.locator('.pane-agents').boundingBox())?.width ?? 0;

    await page.locator('#reading-pane-toggle').click();
    const initialHeight = (await page.locator('.pane-list').boundingBox())?.height ?? 0;
    await dragBy(page, '#pane-handle-2', 0, 70);
    const bottomHeight = (await page.locator('.pane-list').boundingBox())?.height ?? 0;
    expect(bottomHeight).toBeGreaterThan(initialHeight + 40);

    await page.reload();
    await expect(page.locator('.filter-bar .filter')).toHaveCount(3);
    await orientation(page, 'bottom');
    expect((await page.locator('.pane-list').boundingBox())?.height ?? 0).toBeCloseTo(bottomHeight, 0);

    await page.locator('#reading-pane-toggle').click();
    await orientation(page, 'right');
    expect((await page.locator('.pane-agents').boundingBox())?.width ?? 0).toBeCloseTo(rightWidth, 0);
  });

  test('Bottom height clamps and double-click restores the balanced default', async ({ page }) => {
    await open(page, WIDE);
    await page.locator('#reading-pane-toggle').click();
    const balanced = (await page.locator('.pane-list').boundingBox())?.height ?? 0;

    await dragBy(page, '#pane-handle-2', 0, -900);
    const clamped = (await page.locator('.pane-list').boundingBox())?.height ?? 0;
    expect(clamped).toBeGreaterThanOrEqual(180);
    await expect(page.locator('.pane-detail')).toBeVisible();

    await page.locator('#pane-handle-2').dblclick();
    expect((await page.locator('.pane-list').boundingBox())?.height ?? 0).toBeCloseTo(balanced, 0);
  });

  test('resizing agents in Bottom preserves the remembered Right list width', async ({ page }) => {
    await open(page, WIDE);
    await page.evaluate(() => localStorage.setItem('inbox.panes', JSON.stringify({
      collapse: 0, widths: [260, 670], readingPane: 'bottom', listHeight: null,
    })));
    await page.reload();
    await expect(page.locator('.filter-bar .filter')).toHaveCount(3);
    await orientation(page, 'bottom');

    // Avoid the exact crossing point with Bottom's horizontal divider so this
    // is a non-vacuous pointer drag of handle 1.
    await dragBy(page, '#pane-handle-1', 300, 0, 0.25);
    expect((await page.locator('.pane-agents').boundingBox())?.width ?? 0).toBeGreaterThan(500);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('inbox.panes')!).widths[1])).toBe(670);
    await page.locator('#pane-handle-1').focus();
    await page.keyboard.press('ArrowRight');

    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('inbox.panes')!).widths[1])).toBe(670);
    await page.locator('#reading-pane-toggle').click();
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('inbox.panes')!).widths[1])).toBe(670);

    await page.locator('#reading-pane-toggle').click();
    await dragBy(page, '#pane-handle-1', -300, 0, 0.25);
    await page.locator('#reading-pane-toggle').click();
    expect((await page.locator('.pane-list').boundingBox())?.width ?? 0).toBeCloseTo(670, 0);
  });

  test('separator maximums are the actual clamp boundaries with no horizontal overflow', async ({ page }) => {
    await open(page, WIDE);
    const second = page.locator('#pane-handle-2');
    const rightMaxWithDefaultAgent = Number(await second.getAttribute('aria-valuemax'));
    expect(rightMaxWithDefaultAgent).toBe(1280 - 260 - 340);

    await dragBy(page, '#pane-handle-2', 1000, 0);
    expect((await page.locator('.pane-list').boundingBox())?.width ?? 0).toBeCloseTo(rightMaxWithDefaultAgent, 0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);

    await page.evaluate(() => localStorage.setItem('inbox.panes', JSON.stringify({
      collapse: 0, widths: [300, 500], readingPane: 'right', listHeight: null,
    })));
    await page.reload();
    await expect(page.locator('.filter-bar .filter')).toHaveCount(3);
    await page.locator('#pane-cycle').click();
    await expectCollapse(page, '1');
    const collapsedMax = Number(await second.getAttribute('aria-valuemax'));
    expect(collapsedMax).toBe(1280 - 340);

    await dragBy(page, '#pane-handle-2', 1000, 0);
    expect((await page.locator('.pane-list').boundingBox())?.width ?? 0).toBeCloseTo(collapsedMax, 0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  });

  test('responsive refits preserve remembered desktop widths and Bottom height', async ({ page }) => {
    await open(page, WIDE);
    await page.evaluate(() => localStorage.setItem('inbox.panes', JSON.stringify({
      collapse: 0, widths: [300, 500], readingPane: 'right', listHeight: 500,
    })));
    await page.reload();
    await expect(page.locator('.filter-bar .filter')).toHaveCount(3);
    expect((await page.locator('.pane-agents').boundingBox())?.width ?? 0).toBeCloseTo(300, 0);
    expect((await page.locator('.pane-list').boundingBox())?.width ?? 0).toBeCloseTo(500, 0);

    await page.setViewportSize({ width: 420, height: 420 });
    await expect(page.locator('html')).toHaveAttribute('data-layout', 'phone');
    await page.setViewportSize(WIDE);
    await expect(page.locator('html')).toHaveAttribute('data-layout', 'wide');
    expect((await page.locator('.pane-agents').boundingBox())?.width ?? 0).toBeCloseTo(300, 0);
    expect((await page.locator('.pane-list').boundingBox())?.width ?? 0).toBeCloseTo(500, 0);

    await page.locator('#pane-cycle').click();
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('inbox.panes')!).widths)).toEqual([300, 500]);
    await page.locator('#pane-cycle').click();
    await page.locator('#pane-cycle').click();
    await page.locator('#reading-pane-toggle').click();
    expect((await page.locator('.pane-list').boundingBox())?.height ?? 0).toBeCloseTo(500, 0);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('inbox.panes')!).listHeight)).toBe(500);
  });

  test('the second separator switches axis, metadata, keyboard, and placement without stale coordinates', async ({ page }) => {
    await open(page, WIDE);
    const first = page.locator('#pane-handle-1');
    const second = page.locator('#pane-handle-2');

    await expect(first).toHaveAttribute('role', 'separator');
    await expect(first).toHaveAttribute('tabindex', '0');
    await expect(first).toHaveAttribute('aria-orientation', 'vertical');
    await expect(first).toHaveAttribute('aria-controls', 'pane-agents');
    await expect(second).toHaveAttribute('role', 'separator');
    await expect(second).toHaveAttribute('aria-orientation', 'vertical');
    await expect(second).toHaveAttribute('aria-controls', 'pane-list');
    const rightRanges = await page.evaluate(() => {
      const read = (selector: string) => {
        const element = document.querySelector(selector) as HTMLElement;
        return {
          min: Number(element.getAttribute('aria-valuemin')),
          max: Number(element.getAttribute('aria-valuemax')),
          now: Number(element.getAttribute('aria-valuenow')),
        };
      };
      const inbox = document.querySelector('.inbox') as HTMLElement;
      const agents = document.querySelector('.pane-agents') as HTMLElement;
      const list = document.querySelector('.pane-list') as HTMLElement;
      return { inboxWidth: inbox.clientWidth, agentWidth: agents.offsetWidth, listWidth: list.offsetWidth,
        first: read('#pane-handle-1'), second: read('#pane-handle-2') };
    });
    expect(rightRanges.first).toEqual({ min: 180, max: rightRanges.inboxWidth - 320 - 340, now: rightRanges.agentWidth });
    expect(rightRanges.second).toEqual({
      min: 320,
      max: rightRanges.inboxWidth - rightRanges.agentWidth - 340,
      now: rightRanges.listWidth,
    });
    for (const range of [rightRanges.first, rightRanges.second]) {
      expect(range.now).toBeGreaterThanOrEqual(range.min);
      expect(range.now).toBeLessThanOrEqual(range.max);
    }
    await first.focus();
    const focusStyle = await first.evaluate(element => {
      const style = getComputedStyle(element);
      return { outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth };
    });
    expect(focusStyle).toEqual({ outlineStyle: 'solid', outlineWidth: '2px' });
    const initialAgentWidth = (await page.locator('.pane-agents').boundingBox())?.width ?? 0;
    await page.keyboard.press('ArrowRight');
    await expect(first).toHaveAttribute('aria-valuenow', String(Math.round(initialAgentWidth + 10)));
    const initialWidth = (await page.locator('.pane-list').boundingBox())?.width ?? 0;
    await second.focus();
    await page.keyboard.press('ArrowDown');
    expect((await page.locator('.pane-list').boundingBox())?.width ?? 0).toBeCloseTo(initialWidth, 0);
    await page.keyboard.press('ArrowRight');
    expect((await page.locator('.pane-list').boundingBox())?.width ?? 0).toBeGreaterThan(initialWidth);
    await expect(second).toHaveAttribute('aria-valuenow', String(Math.round(initialWidth + 10)));
    expect(await second.evaluate(element => (element as HTMLElement).style.top)).toBe('');
    expect(await second.evaluate(element => (element as HTMLElement).style.left)).not.toBe('');

    await page.locator('#reading-pane-toggle').click();
    await expect(second).toHaveAttribute('aria-orientation', 'horizontal');
    const bottomAgentRange = await page.evaluate(() => {
      const inbox = document.querySelector('.inbox') as HTMLElement;
      const handle = document.querySelector('#pane-handle-1') as HTMLElement;
      return { max: Number(handle.getAttribute('aria-valuemax')), inboxWidth: inbox.clientWidth };
    });
    expect(bottomAgentRange.max).toBe(bottomAgentRange.inboxWidth - 340);
    const initialHeight = (await page.locator('.pane-list').boundingBox())?.height ?? 0;
    const bottomRange = await page.evaluate(() => {
      const inbox = document.querySelector('.inbox') as HTMLElement;
      const handle = document.querySelector('#pane-handle-2') as HTMLElement;
      return {
        min: Number(handle.getAttribute('aria-valuemin')),
        max: Number(handle.getAttribute('aria-valuemax')),
        now: Number(handle.getAttribute('aria-valuenow')),
        inboxHeight: inbox.clientHeight,
      };
    });
    expect(bottomRange).toEqual({ min: 180, max: bottomRange.inboxHeight - 220,
      now: Math.round(initialHeight), inboxHeight: bottomRange.inboxHeight });
    await second.focus();
    await page.keyboard.press('ArrowRight');
    expect((await page.locator('.pane-list').boundingBox())?.height ?? 0).toBeCloseTo(initialHeight, 0);
    await page.keyboard.press('ArrowDown');
    expect((await page.locator('.pane-list').boundingBox())?.height ?? 0).toBeGreaterThan(initialHeight);
    await expect(second).toHaveAttribute('aria-valuenow', String(Math.round(initialHeight + 10)));
    expect(await second.evaluate(element => (element as HTMLElement).style.left)).toBe('');
    expect(await second.evaluate(element => (element as HTMLElement).style.top)).not.toBe('');
    const bottomSeam = await page.evaluate(() => {
      const handle = document.querySelector('#pane-handle-2')!.getBoundingClientRect();
      const list = document.querySelector('.pane-list')!.getBoundingClientRect();
      const detail = document.querySelector('.pane-detail')!.getBoundingClientRect();
      return { handle: { x: handle.x, y: handle.y, width: handle.width, height: handle.height },
        list: { x: list.x, right: list.right }, detailTop: detail.top };
    });
    expect(bottomSeam.handle.y).toBeCloseTo(bottomSeam.detailTop - 5, 0);
    expect(bottomSeam.handle.x).toBeCloseTo(bottomSeam.list.x, 0);
    expect(bottomSeam.handle.width).toBeCloseTo(bottomSeam.list.right - bottomSeam.list.x, 0);
    expect(bottomSeam.handle.height).toBeCloseTo(10, 0);

    await page.locator('#reading-pane-toggle').click();
    expect(await second.evaluate(element => (element as HTMLElement).style.top)).toBe('');
    expect(await second.evaluate(element => (element as HTMLElement).style.left)).not.toBe('');
  });

  test('Bottom respects every collapse step and phone ignores but remembers it', async ({ page }) => {
    await open(page, WIDE);
    await page.locator('#reading-pane-toggle').click();
    await orientation(page, 'bottom');

    await page.locator('#pane-cycle').click();
    await expectCollapse(page, '1');
    await expect(page.locator('.pane-agents')).toBeHidden();
    await expect(page.locator('.pane-list')).toBeVisible();
    await expect(page.locator('.pane-detail')).toBeVisible();

    await page.locator('#pane-cycle').click();
    await expectCollapse(page, '2');
    await expect(page.locator('.pane-list')).toBeHidden();
    await expect(page.locator('.pane-detail')).toBeVisible();

    await page.setViewportSize(PHONE);
    await expect(page.locator('html')).toHaveAttribute('data-layout', 'phone');
    await expect(page.locator('#reading-pane-toggle')).toBeHidden();
    await expect(page.locator('html')).toHaveAttribute('data-pane', 'list');
    await expect(page.locator('.pane-list')).toBeVisible();
    await expect(page.locator('.pane-detail')).toBeHidden();
    await orientation(page, 'bottom');

    await page.setViewportSize(WIDE);
    await expect(page.locator('html')).toHaveAttribute('data-layout', 'wide');
    await orientation(page, 'bottom');
    await expectCollapse(page, '2');
    await page.locator('#pane-cycle').click();
    await expectCollapse(page, '0');
  });
});
