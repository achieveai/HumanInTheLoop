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

async function open(
  page: Page,
  viewport: { width: number; height: number },
  fixture: Fixture = FIXTURE,
) {
  await page.setViewportSize(viewport);
  await page.addInitScript(f => {
    (window as any).__INBOX_FIXTURE = f;
  }, { sessions: AGENTS, ...fixture });
  await page.goto('/inbox-harness.html');
  await expect(page.locator('.filter-bar .filter')).toHaveCount(3);
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
  test('wide shows all three and no navigation chrome', async ({ page }) => {
    await open(page, WIDE);

    await expectLayout(page, 'wide');
    await expect(page.locator('.pane-agents')).toBeVisible();
    await expect(page.locator('.pane-list')).toBeVisible();
    await expect(page.locator('.pane-detail')).toBeVisible();

    // Nothing to navigate, so nothing to navigate with. The bar itself is on
    // screen at this width because the collapse control lives in it, but every
    // control that exists to move between panes stays hidden.
    await expect(page.locator('#pane-back')).toBeHidden();
    await expect(page.locator('#agents-toggle')).toBeHidden();
    await expect(page.locator('.inbox-bar-title')).toBeHidden();
    await expect(page.locator('#pane-cycle')).toBeVisible();
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

test.describe('§4 — large-list resize containment', () => {
  test('contains cold and warm mixed-height rows through refresh and breakpoints', async ({ page }) => {
    test.setTimeout(30_000);
    const errors: string[] = [];
    page.on('console', message => {
      if (message.type() === 'error') errors.push(message.text());
    });
    page.on('pageerror', error => errors.push(error.message));

    const rows = Array.from({ length: 2_322 }, (_, index) => message({
      messageId: `large-${index}`,
      title: index === 2_321 ? 'Final mixed-height row' : `Mixed-height row ${index}`,
      contextSnippet: index % 4 === 1 || index % 4 === 3
        ? `Context for mixed-height row ${index}`
        : null,
      badges: index % 4 >= 2
        ? { repo: `Hitl_MCP · branch-${index}`, batchCount: null, revision: null, attachment: false, plaintext: null }
        : undefined,
    }));
    const finalRow = rows.at(-1)!;
    const largeFixture: Fixture = {
      messages: list({ messages: rows }),
      details: { [finalRow.messageId]: detail(finalRow, { request: { body: 'Final row body.' } }) },
    };
    await open(page, WIDE, largeFixture);

    const messageRows = page.locator('.message-row');
    await expect(messageRows).toHaveCount(2_322);
    const cold = await page.evaluate(() => {
      const listElement = document.querySelector('#message-list') as HTMLElement;
      const rowElements = [...document.querySelectorAll('.message-row')] as HTMLElement[];
      const style = getComputedStyle(rowElements[0]);
      return {
        contentVisibility: style.contentVisibility,
        containIntrinsicSize: style.containIntrinsicSize,
        scrollHeight: listElement.scrollHeight,
        visibleHeights: [...new Set(rowElements.slice(0, 4).map(row => row.getBoundingClientRect().height))],
      };
    });
    expect(cold.contentVisibility).toBe('auto');
    expect(cold.containIntrinsicSize).toBe('auto 38px');
    expect(cold.visibleHeights.length).toBeGreaterThan(1);

    const last = messageRows.last();
    await last.evaluate(row => row.scrollIntoView({ block: 'end' }));
    await expect(last).toBeInViewport();
    await last.click();
    await last.focus();
    await expect(last).toBeFocused();
    await expect(last).toHaveAccessibleName(/Final mixed-height row/);

    const beforeRefresh = await page.evaluate(() => {
      const listElement = document.querySelector('#message-list') as HTMLElement;
      const selected = document.querySelector('.message-row.is-selected') as HTMLElement;
      const listRect = listElement.getBoundingClientRect();
      const rowRect = selected.getBoundingClientRect();
      return {
        scrollHeight: listElement.scrollHeight,
        scrollTop: listElement.scrollTop,
        clientHeight: listElement.clientHeight,
        bottomGap: listRect.bottom - rowRect.bottom,
      };
    });
    expect(Math.abs(beforeRefresh.scrollHeight - cold.scrollHeight) / cold.scrollHeight)
      .toBeLessThanOrEqual(0.01);

    const refreshedRows = rows.map((row, index) => index === rows.length - 1
      ? { ...row, title: 'Final mixed-height row refreshed' }
      : row);
    const refreshedFinal = refreshedRows.at(-1)!;
    await page.evaluate(({ projection, refreshedDetail }) => {
      const fixture = (window as any).__INBOX_FIXTURE;
      fixture.messages = projection;
      fixture.details[refreshedDetail.row.messageId] = refreshedDetail;
      (window as any).__simulateChange();
    }, {
      projection: list({ messages: refreshedRows }),
      refreshedDetail: detail(refreshedFinal, { request: { body: 'Refreshed final row body.' } }),
    });

    const selected = page.locator('.message-row.is-selected');
    await expect(selected).toHaveAttribute('data-message-id', finalRow.messageId);
    await expect(selected).toHaveAccessibleName(/Final mixed-height row refreshed/);
    const afterRefresh = await page.evaluate(() => {
      const listElement = document.querySelector('#message-list') as HTMLElement;
      const selectedRow = document.querySelector('.message-row.is-selected') as HTMLElement;
      const listRect = listElement.getBoundingClientRect();
      const rowRect = selectedRow.getBoundingClientRect();
      return {
        scrollHeight: listElement.scrollHeight,
        scrollTop: listElement.scrollTop,
        clientHeight: listElement.clientHeight,
        bottomGap: listRect.bottom - rowRect.bottom,
      };
    });
    expect(Math.abs(afterRefresh.scrollHeight - beforeRefresh.scrollHeight) / beforeRefresh.scrollHeight)
      .toBeLessThanOrEqual(0.01);
    expect(Math.abs(afterRefresh.scrollTop - beforeRefresh.scrollTop))
      .toBeLessThanOrEqual(beforeRefresh.clientHeight);
    expect(Math.abs(afterRefresh.bottomGap - beforeRefresh.bottomGap))
      .toBeLessThanOrEqual(2);

    await selected.focus();
    await expect(selected).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('.detail-title')).toHaveText('Final mixed-height row refreshed');

    let previousGeometry = afterRefresh;
    for (const [viewport, layout] of [
      [TABLET, 'tablet'],
      [PHONE, 'phone'],
      [WIDE, 'wide'],
    ] as const) {
      await page.setViewportSize(viewport);
      await expectLayout(page, layout);
      await page.evaluate(() => (window as any).__PANES?.show('list'));
      await expect(page.locator('.pane-list')).toBeVisible();
      await expect(selected).toBeInViewport();
      const readGeometry = () => page.evaluate(() => {
        const documentElement = document.documentElement;
        const pane = document.querySelector('.pane-list') as HTMLElement;
        const listElement = document.querySelector('#message-list') as HTMLElement;
        const selectedRow = document.querySelector('.message-row.is-selected') as HTMLElement;
        const listRect = listElement.getBoundingClientRect();
        const rowRect = selectedRow.getBoundingClientRect();
        return {
          documentFits: documentElement.scrollWidth <= documentElement.clientWidth,
          paneFits: pane.scrollWidth <= pane.clientWidth,
          listFits: listElement.scrollWidth <= listElement.clientWidth,
          scrollHeight: listElement.scrollHeight,
          scrollTop: listElement.scrollTop,
          clientHeight: listElement.clientHeight,
          bottomGap: listRect.bottom - rowRect.bottom,
        };
      });
      await expect.poll(readGeometry)
        .toMatchObject({ documentFits: true, paneFits: true, listFits: true });
      const geometry = await readGeometry();
      expect(Math.abs(geometry.scrollHeight - previousGeometry.scrollHeight) / previousGeometry.scrollHeight)
        .toBeLessThanOrEqual(0.01);
      expect(Math.abs(geometry.scrollTop - previousGeometry.scrollTop))
        .toBeLessThanOrEqual(Math.max(geometry.clientHeight, previousGeometry.clientHeight));
      expect(
        Math.abs(geometry.bottomGap - previousGeometry.bottomGap),
        `${layout} selected-row bottom gap drifted from ${previousGeometry.bottomGap} to ${geometry.bottomGap}`,
      )
        .toBeLessThanOrEqual(8);
      previousGeometry = geometry;
    }

    await expect(page.locator('html')).toHaveAttribute('data-pane', 'list');
    await expect(page.locator('.message-row.is-selected')).toHaveAttribute('data-message-id', finalRow.messageId);
    const beforeOrientation = await page.evaluate(() => {
      const list = document.querySelector('#message-list') as HTMLElement;
      return { scrollHeight: list.scrollHeight, scrollTop: list.scrollTop };
    });
    await page.locator('#reading-pane-toggle').click();
    await expect(page.locator('html')).toHaveAttribute('data-reading-pane', 'bottom');
    const bottomContainment = await page.evaluate(() => {
      const documentElement = document.documentElement;
      const inbox = document.querySelector('.inbox') as HTMLElement;
      const pane = document.querySelector('.pane-list') as HTMLElement;
      const list = document.querySelector('#message-list') as HTMLElement;
      const selected = document.querySelector('.message-row.is-selected') as HTMLElement;
      const style = getComputedStyle(selected);
      const paneRect = pane.getBoundingClientRect();
      const inboxRect = inbox.getBoundingClientRect();
      return {
        contentVisibility: style.contentVisibility,
        containIntrinsicSize: style.containIntrinsicSize,
        scrollHeight: list.scrollHeight,
        scrollTop: list.scrollTop,
        documentFits: documentElement.scrollWidth <= documentElement.clientWidth
          && documentElement.scrollHeight <= documentElement.clientHeight,
        inboxFits: inbox.scrollWidth <= inbox.clientWidth && inbox.scrollHeight <= inbox.clientHeight,
        paneInside: paneRect.top >= inboxRect.top && paneRect.bottom <= inboxRect.bottom,
      };
    });
    expect(bottomContainment.contentVisibility).toBe('auto');
    expect(bottomContainment.containIntrinsicSize).toBe('auto 38px');
    expect(Math.abs(bottomContainment.scrollHeight - beforeOrientation.scrollHeight) / beforeOrientation.scrollHeight)
      .toBeLessThanOrEqual(0.01);
    expect(bottomContainment.scrollTop).toBe(beforeOrientation.scrollTop);
    expect(bottomContainment.documentFits).toBe(true);
    expect(bottomContainment.inboxFits).toBe(true);
    expect(bottomContainment.paneInside).toBe(true);

    await page.locator('#reading-pane-toggle').click();
    await expect(page.locator('html')).toHaveAttribute('data-reading-pane', 'right');
    expect(await page.evaluate(() => (document.querySelector('#message-list') as HTMLElement).scrollTop))
      .toBe(beforeOrientation.scrollTop);
    expect(errors).toEqual([]);
  });
});

test.describe('§4 — Right and Bottom reading-pane geometry', () => {
  test('Bottom stacks list over detail beside the wide agent pane and fills the collapsed width', async ({ page }) => {
    await open(page, WIDE);
    await page.locator('#reading-pane-toggle').click();
    await expect(page.locator('html')).toHaveAttribute('data-reading-pane', 'bottom');

    const wide = await page.evaluate(() => {
      const rect = (selector: string) => (document.querySelector(selector) as HTMLElement).getBoundingClientRect();
      return { inbox: rect('.inbox'), agents: rect('.pane-agents'), list: rect('.pane-list'), detail: rect('.pane-detail') };
    });
    expect(wide.agents.top).toBeCloseTo(wide.inbox.top, 0);
    expect(wide.agents.bottom).toBeCloseTo(wide.inbox.bottom, 0);
    expect(wide.list.left).toBeCloseTo(wide.detail.left, 0);
    expect(wide.list.right).toBeCloseTo(wide.detail.right, 0);
    expect(wide.list.bottom).toBeCloseTo(wide.detail.top, 0);

    await page.locator('#pane-cycle').click();
    const collapsed = await page.evaluate(() => {
      const inbox = document.querySelector('.inbox')!.getBoundingClientRect();
      const list = document.querySelector('.pane-list')!.getBoundingClientRect();
      const detail = document.querySelector('.pane-detail')!.getBoundingClientRect();
      return { inbox, list, detail, overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth };
    });
    expect(collapsed.list.left).toBeCloseTo(collapsed.inbox.left, 0);
    expect(collapsed.list.right).toBeCloseTo(collapsed.inbox.right, 0);
    expect(collapsed.detail.left).toBeCloseTo(collapsed.inbox.left, 0);
    expect(collapsed.detail.right).toBeCloseTo(collapsed.inbox.right, 0);
    expect(collapsed.overflow).toBe(false);

    await page.locator('#pane-cycle').click();
    const detailOnly = await page.evaluate(() => {
      const documentElement = document.documentElement;
      const inbox = document.querySelector('.inbox')!.getBoundingClientRect();
      const detail = document.querySelector('.pane-detail')!.getBoundingClientRect();
      return {
        inbox: { left: inbox.left, top: inbox.top, right: inbox.right, bottom: inbox.bottom },
        detail: { left: detail.left, top: detail.top, right: detail.right, bottom: detail.bottom },
        fits: documentElement.scrollWidth <= documentElement.clientWidth
          && documentElement.scrollHeight <= documentElement.clientHeight,
      };
    });
    expect(detailOnly.detail).toEqual(detailOnly.inbox);
    expect(detailOnly.fits).toBe(true);
  });

  test('Bottom stacks at tablet, then phone navigation remains one pane and the preference returns', async ({ page }) => {
    await open(page, WIDE);
    await page.locator('#reading-pane-toggle').click();
    await page.setViewportSize(TABLET);
    await expectLayout(page, 'tablet');
    await expect(page.locator('#reading-pane-toggle')).toBeVisible();
    const tablet = await page.evaluate(() => {
      const list = document.querySelector('.pane-list')!.getBoundingClientRect();
      const detail = document.querySelector('.pane-detail')!.getBoundingClientRect();
      return { list, detail };
    });
    expect(tablet.list.left).toBeCloseTo(tablet.detail.left, 0);
    expect(tablet.list.bottom).toBeCloseTo(tablet.detail.top, 0);

    await page.locator('#pane-cycle').click();
    await expect(page.locator('html')).toHaveAttribute('data-collapse', '1');
    await expect(page.locator('.pane-list')).toBeVisible();
    await expect(page.locator('.pane-detail')).toBeVisible();
    const tabletCollapsed = await page.evaluate(() => {
      const inbox = document.querySelector('.inbox')!.getBoundingClientRect();
      const list = document.querySelector('.pane-list')!.getBoundingClientRect();
      const detail = document.querySelector('.pane-detail')!.getBoundingClientRect();
      return { inbox: { left: inbox.left, right: inbox.right }, list: { left: list.left, right: list.right },
        detail: { left: detail.left, right: detail.right } };
    });
    expect(tabletCollapsed.list).toEqual(tabletCollapsed.inbox);
    expect(tabletCollapsed.detail).toEqual(tabletCollapsed.inbox);

    await page.locator('#pane-cycle').click();
    await expect(page.locator('html')).toHaveAttribute('data-collapse', '2');
    await expect(page.locator('.pane-list')).toBeHidden();
    const tabletDetailOnly = await page.evaluate(() => {
      const documentElement = document.documentElement;
      const inbox = document.querySelector('.inbox')!.getBoundingClientRect();
      const detail = document.querySelector('.pane-detail')!.getBoundingClientRect();
      return { inbox: { left: inbox.left, top: inbox.top, right: inbox.right, bottom: inbox.bottom },
        detail: { left: detail.left, top: detail.top, right: detail.right, bottom: detail.bottom },
        fits: documentElement.scrollWidth <= documentElement.clientWidth
          && documentElement.scrollHeight <= documentElement.clientHeight };
    });
    expect(tabletDetailOnly.detail).toEqual(tabletDetailOnly.inbox);
    expect(tabletDetailOnly.fits).toBe(true);

    await page.setViewportSize(PHONE);
    await expectLayout(page, 'phone');
    await expect(page.locator('#reading-pane-toggle')).toBeHidden();
    await page.locator('.message-row[data-message-id="q-1"]').click();
    await expect(page.locator('.pane-detail')).toBeVisible();
    await page.locator('#pane-back').click();
    await expect(page.locator('.pane-list')).toBeVisible();

    await page.setViewportSize(WIDE);
    await expectLayout(page, 'wide');
    await expect(page.locator('html')).toHaveAttribute('data-reading-pane', 'bottom');
    await expect(page.locator('html')).toHaveAttribute('data-collapse', '2');
  });
});
