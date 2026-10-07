import { test, expect, type Page } from '@playwright/test';
import {
  DAY,
  Fixture,
  HOUR,
  MINUTE,
  NOW,
  list,
  message,
  project,
  session,
  tree,
} from './fixtures.js';

// Pane 2 is a **list only** — headers, no body, no controls (spec §7). These
// tests check the §7.1 header fields render from the shapes the Rust commands
// return, and that the filter bar asks for what it claims to.

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

async function open(page: Page, fixture: Fixture) {
  await page.addInitScript(f => {
    (window as any).__INBOX_FIXTURE = f;
  }, { sessions: AGENTS, ...fixture });
  await page.goto('/inbox-harness.html');
  await expect(page.locator('.filter-bar .filter')).toHaveCount(3);
  await expect(page.locator('.type-filter')).toHaveCount(4);
}

/** One list, answering every scope/filter combination. */
function only(...messages: ReturnType<typeof message>[]): Fixture {
  return { messages: list({ messages }) };
}

async function projectionCounts(page: Page) {
  return page.evaluate(() => ({
    trees: (window as any).__INVOCATIONS.filter((call: any) => call.cmd === 'list_sessions').length,
    lists: (window as any).__INVOCATIONS.filter((call: any) => call.cmd === 'list_messages').length,
  }));
}

test.describe('Incremental message refresh', () => {
  test('one arriving message keeps existing rows and keyboard focus', async ({ page }) => {
    await open(page, only(message({ messageId: 'base' })));
    const result = await page.evaluate(async base => {
      const modulePath = '/pane-list.js';
      const { renderMessageList } = await import(modulePath);
      const container = document.createElement('div');
      document.body.appendChild(container);
      const messages = Array.from({ length: 150 }, (_, i) => ({ ...base, messageId: `old-${i}` }));
      renderMessageList(container, { messages });
      const before = Array.from(container.children);
      (before[50] as HTMLElement).focus();
      const observer = new MutationObserver(() => {});
      observer.observe(container, { childList: true });
      renderMessageList(container, { messages: [{ ...base, messageId: 'new' }, ...messages] });
      const mutations = observer.takeRecords();
      observer.disconnect();
      return {
        retained: before.every((row, i) => container.children[i + 1] === row),
        focused: document.activeElement === before[50],
        removed: mutations.reduce((sum, record) => sum + record.removedNodes.length, 0),
        added: mutations.reduce((sum, record) => sum + record.addedNodes.length, 0),
      };
    }, message({ messageId: 'base' }));
    expect(result).toEqual({ retained: true, focused: true, removed: 0, added: 1 });
  });

  test('reused rows select fresh data and the latest callback', async ({ page }) => {
    await open(page, only(message({ messageId: 'base' })));
    const result = await page.evaluate(async base => {
      const modulePath = '/pane-list.js';
      const { renderMessageList } = await import(modulePath);
      const container = document.createElement('div');
      document.body.appendChild(container);
      let oldCalls = 0;
      const selected: number[] = [];
      renderMessageList(container, { messages: [{ ...base, revisionForSelection: 1 }] }, { onSelect: () => oldCalls++ });
      const row = container.firstElementChild as HTMLElement;
      renderMessageList(container, { messages: [{ ...base, revisionForSelection: 2 }] }, {
        onSelect: (m: any) => selected.push(m.revisionForSelection),
      });
      (container.firstElementChild as HTMLElement).click();
      container.firstElementChild!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return { retained: row === container.firstElementChild, oldCalls, selected };
    }, message({ messageId: 'base' }));
    expect(result).toEqual({ retained: true, oldCalls: 0, selected: [2, 2] });
  });

  test('reorders, removes and updates rows without duplicating them', async ({ page }) => {
    await open(page, only(message({ messageId: 'base' })));
    const result = await page.evaluate(async base => {
      const modulePath = '/pane-list.js';
      const { renderMessageList } = await import(modulePath);
      const container = document.createElement('div');
      const a = { ...base, messageId: 'a' }, b = { ...base, messageId: 'b' }, c = { ...base, messageId: 'c' };
      document.body.appendChild(container);
      renderMessageList(container, { messages: [a, b, c, { ...base, messageId: 'removed' }] });
      const oldC = container.children[2];
      (oldC as HTMLElement).focus();
      renderMessageList(container, { messages: [c, a, { ...b, title: 'Updated', status: 'answered' }] }, { selectedId: 'b' });
      return {
        ids: Array.from(container.children).map((row: any) => row.dataset.messageId),
        keptC: oldC === container.firstElementChild,
        focusedC: document.activeElement === oldC,
        title: container.lastElementChild!.querySelector('.message-title')!.textContent,
        selected: container.lastElementChild!.classList.contains('is-selected'),
        status: (container.lastElementChild as HTMLElement).dataset.status,
      };
    }, message({ messageId: 'base' }));
    expect(result).toEqual({ ids: ['c', 'a', 'b'], keptC: true, focusedC: true, title: 'Updated', selected: true, status: 'answered' });
  });
});

test.describe('Large lists render on scroll', () => {
  test('preserves the reading position across the virtualization threshold in both directions', async ({ page }) => {
    await open(page, only(message({ messageId: 'base' })));
    const shifts = await page.evaluate(async base => {
      const modulePath = '/pane-list.js';
      const { renderMessageList } = await import(modulePath);
      const container = document.createElement('div');
      container.className = 'message-list';
      container.style.cssText = 'height:400px;width:600px;position:fixed;top:0;overflow:auto;flex:none';
      document.body.appendChild(container);
      const messages = Array.from({ length: 200 }, (_, i) => ({ ...base, messageId: `threshold-${i}` }));
      renderMessageList(container, { messages });
      container.scrollTop = 5000;
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
      const row = Array.from(container.querySelectorAll<HTMLElement>('.message-row')).find(r => r.getBoundingClientRect().bottom > 0)!;
      const id = row.dataset.messageId;
      const before = row.getBoundingClientRect().top;
      renderMessageList(container, { messages: [{ ...base, messageId: 'arrival' }, ...messages] });
      const anchoredRow = container.querySelector(`[data-message-id="${id}"]`);
      if (!anchoredRow) throw new Error(JSON.stringify({ id, before, scrollTop: container.scrollTop, mounted: Array.from(container.children).map((r: any) => r.dataset.messageId) }));
      const after = anchoredRow.getBoundingClientRect().top;
      renderMessageList(container, { messages });
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
      const restored = container.querySelector(`[data-message-id="${id}"]`)!.getBoundingClientRect().top;
      return [after - before, restored - before];
    }, message({ messageId: 'base' }));
    expect(Math.abs(shifts[0]), JSON.stringify(shifts)).toBeLessThan(2);
    expect(Math.abs(shifts[1]), JSON.stringify(shifts)).toBeLessThan(2);
  });

  const history = () => Array.from({ length: 5000 }, (_, i) => message({
    messageId: `history-${i}`, title: `History ${i}`, contextSnippet: i % 2 ? 'Extra context' : null,
  }));

  test('bounds mounted rows and reaches the last message by scrolling', async ({ page }) => {
    await open(page, only(...history()));
    await expect.poll(() => page.locator('.message-row').count()).toBeLessThan(100);
    await page.locator('#message-list').evaluate(el => { el.scrollTop = el.scrollHeight; });
    const last = page.locator('[data-message-id="history-4999"]');
    await expect(last).toBeInViewport();
    await expect(last).toHaveAccessibleDescription('Message 5000 of 5000');
    await expect.poll(() => page.locator('.message-row').count()).toBeLessThan(100);
  });

  test('keyboard navigation reaches unmounted messages', async ({ page }) => {
    await open(page, only(...history()));
    await page.locator('[data-message-id="history-0"]').focus();
    await page.keyboard.press('End');
    await expect(page.locator('[data-message-id="history-4999"]')).toBeFocused();
    await expect(page.locator('[data-message-id="history-4999"]')).toBeInViewport();
    await page.keyboard.press('Home');
    await expect(page.locator('[data-message-id="history-0"]')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('[data-message-id="history-1"]')).toBeFocused();
  });

  test('arrival preserves the row being read and filter changes discard old rows', async ({ page }) => {
    const rows = history();
    await open(page, { messages: {
      'all|null': list({ messages: rows, filter: 'all' }),
      'all|all': list({ messages: rows, filter: 'all' }),
      'all|needs_you': list({ messages: [rows[0]], filter: 'needs_you' }),
    } });
    await page.locator('#message-list').evaluate(el => { el.scrollTop = el.scrollHeight / 2; });
    await expect(page.locator('[data-message-id="history-0"]')).toHaveCount(0);
    const anchor = await page.evaluate(() => {
      const list = document.getElementById('message-list')!;
      const top = list.getBoundingClientRect().top;
      const row = Array.from(list.querySelectorAll<HTMLElement>('.message-row')).find(r => r.getBoundingClientRect().bottom > top)!;
      return { id: row.dataset.messageId!, top: row.getBoundingClientRect().top };
    });
    await page.evaluate(projection => {
      (window as any).__INBOX_FIXTURE.messages['all|all'] = projection;
      (window as any).__simulateChange();
    }, list({ messages: [message({ messageId: 'arrived' }), ...rows], filter: 'all' }));
    await expect(page.locator('.filter[data-filter="all"]')).toContainText('5001');
    await expect.poll(async () => Math.abs(await page.locator(`[data-message-id="${anchor.id}"]`).evaluate(r => r.getBoundingClientRect().top) - anchor.top)).toBeLessThan(2);
    await page.locator('.filter[data-filter="needs_you"]').click();
    await expect(page.locator('.message-row')).toHaveCount(1);
    await expect(page.locator('.message-row')).toHaveAttribute('data-message-id', 'history-0');
    await expect(page.locator('#message-list')).not.toHaveAttribute('data-virtual', 'true');
  });
});

test.describe('Pane 2 — the header fields (spec §7.1)', () => {
  test('a question row shows every field it has a source for', async ({ page }) => {
    await open(page, only(message({
      messageId: 'q-1',
      msgType: 'question',
      title: 'Which storage backend?',
      status: 'answered',
      responder: 'Kay9 laptop',
      respondedAt: NOW - MINUTE,
      createdAt: NOW - 2 * HOUR,
      contextSnippet: 'Picking between SQLite and a flat file for the local projection',
      badges: { repo: 'Hitl_MCP · master', batchCount: null, revision: null, attachment: false, plaintext: null },
    })));

    const row = page.locator('.message-row');
    await expect(row.locator('.message-glyph')).toHaveText('?');
    await expect(row.locator('.message-title')).toHaveText('Which storage backend?');
    await expect(row.locator('.status-pill-label')).toHaveText('answered');
    await expect(row.locator('.message-age')).toHaveText('2h');
    await expect(row.locator('.message-responder')).toHaveText('Kay9 laptop');
    await expect(row.locator('.message-context'))
      .toHaveText('Picking between SQLite and a flat file for the local projection');
    await expect(row.locator('.badge-repo')).toHaveText('Hitl_MCP · master');
  });

  test('the age is relative in the row and absolute on hover', async ({ page }) => {
    await open(page, only(
      message({ messageId: 'q-now', createdAt: NOW - 10 }),
      message({ messageId: 'q-min', createdAt: NOW - 5 * MINUTE }),
      message({ messageId: 'q-hour', createdAt: NOW - 3 * HOUR }),
      message({ messageId: 'q-day', createdAt: NOW - 2 * DAY }),
    ));

    await expect(page.locator('.message-age')).toHaveText(['now', '5m', '3h', '2d']);
    await expect(page.locator('.message-age').first()).toHaveAttribute('title', /\d/);
  });

  test('a pending row shows no responder at all', async ({ page }) => {
    await open(page, only(message({ messageId: 'q-1', status: 'pending' })));

    await expect(page.locator('.status-pill-label')).toHaveText('pending');
    await expect(page.locator('.message-responder')).toHaveCount(0);
  });

  test('the title source differs by message type', async ({ page }) => {
    await open(page, only(
      message({ messageId: 'q-1', msgType: 'question', title: 'Proceed with the migration?' }),
      message({ messageId: 'n-1', msgType: 'notification', title: 'Build Complete' }),
      message({ messageId: 'p-1', msgType: 'plan_review', title: 'docs/plans/inbox.md' }),
    ));

    const rows = page.locator('.message-row');
    await expect(rows.nth(0).locator('.message-title')).toHaveText('Proceed with the migration?');
    await expect(rows.nth(0).locator('.message-glyph')).toHaveText('?');
    await expect(rows.nth(1).locator('.message-title')).toHaveText('Build Complete');
    await expect(rows.nth(1).locator('.message-glyph')).toHaveText('!');
    await expect(rows.nth(2).locator('.message-title')).toHaveText('docs/plans/inbox.md');
    await expect(rows.nth(2).locator('.message-glyph')).toHaveText('▤');
  });

  test('a batch question is titled by its count and badged with it', async ({ page }) => {
    await open(page, only(message({
      messageId: 'q-1',
      title: '3 questions',
      badges: { repo: null, batchCount: 3, revision: null, attachment: false, plaintext: null },
    })));

    await expect(page.locator('.message-title')).toHaveText('3 questions');
    await expect(page.locator('.badge-batch')).toHaveText('3×');
  });

  test('an answered plan review carries its verdict as a pill sub-label', async ({ page }) => {
    await open(page, only(message({
      messageId: 'p-1',
      msgType: 'plan_review',
      title: 'docs/plans/inbox.md',
      status: 'answered',
      verdict: 'changes_requested',
      responder: 'phone',
      badges: { repo: null, batchCount: null, revision: 3, attachment: true, plaintext: null },
    })));

    await expect(page.locator('.status-pill-label')).toHaveText('answered');
    // Underscores are a wire spelling, not something to read in a pill.
    await expect(page.locator('.status-pill-verdict')).toHaveText('changes requested');
    await expect(page.locator('.badge-revision')).toHaveText('r3');
    await expect(page.locator('.badge-attachment')).toBeVisible();
  });

  test('a stale row is styled apart from a pending one', async ({ page }) => {
    // `stale` is the projection layer's own status — a pending nobody has
    // heard about in a day. If it looked identical to `pending` the overlay
    // would be pointless.
    await open(page, only(
      message({ messageId: 'q-1', status: 'pending' }),
      message({ messageId: 'q-2', status: 'stale' }),
    ));

    await expect(page.locator('.status-pill--stale')).toHaveCount(1);
    await expect(page.locator('.status-pill--pending')).toHaveCount(1);
    await expect(page.locator('.message-row[data-status="stale"] .status-pill-label'))
      .toHaveText('stale');
  });

  test('the plaintext badge appears only when the log actually says so', async ({ page }) => {
    // `null` means the log does not record whether the envelope was encrypted.
    // An unknown is not a warning; raising the badge on one would cry wolf on
    // every message in the Inbox.
    await open(page, only(
      message({ messageId: 'q-unknown' }),
      message({
        messageId: 'q-plain',
        badges: { repo: null, batchCount: null, revision: null, attachment: false, plaintext: true },
      }),
    ));

    await expect(page.locator('.badge-plaintext')).toHaveCount(1);
    await expect(page.locator('.message-row[data-message-id="q-plain"] .badge-plaintext'))
      .toBeVisible();
  });

  test('a row is a header and nothing else — no body, no controls', async ({ page }) => {
    // Spec §7 in one assertion. A Dismiss button or a rendered plan body
    // creeping into this pane is exactly the drift this guards against.
    await open(page, only(message({
      messageId: 'p-1',
      msgType: 'plan_review',
      title: 'docs/plans/inbox.md',
      contextSnippet: 'why you are being asked',
    })));

    const row = page.locator('.message-row');
    await expect(row.locator('button, input, textarea, select, form')).toHaveCount(0);
    await expect(row.locator('.message-body, .plan-body, .notification-body')).toHaveCount(0);
  });

  test('agent-authored titles and context are never interpreted as markup', async ({ page }) => {
    const hostile = '<img src=x onerror="window.__pwned=1">';
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));

    await open(page, only(message({
      messageId: 'q-1',
      title: hostile,
      contextSnippet: hostile,
      responder: hostile,
    })));

    await expect(page.locator('.message-title')).toHaveText(hostile);
    await expect(page.locator('.message-row img')).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).__pwned)).toBeUndefined();
    expect(errors).toEqual([]);
  });
});

test.describe('Pane 2 — ordering and selection', () => {
  test('the list is drawn in the order the server sent it, newest first', async ({ page }) => {
    await open(page, only(
      message({ messageId: 'q-new', title: 'newest', createdAt: NOW - MINUTE }),
      message({ messageId: 'q-mid', title: 'middle', createdAt: NOW - HOUR }),
      message({ messageId: 'q-old', title: 'oldest', createdAt: NOW - 3 * HOUR }),
    ));

    await expect(page.locator('.message-title')).toHaveText(['newest', 'middle', 'oldest']);
  });

  test('selecting a row highlights exactly that row', async ({ page }) => {
    await open(page, only(
      message({ messageId: 'q-1', title: 'first' }),
      message({ messageId: 'q-2', title: 'second' }),
    ));

    await expect(page.locator('.message-row.is-selected')).toHaveCount(0);
    await page.locator('.message-row', { hasText: 'second' }).click();

    await expect(page.locator('.message-row.is-selected')).toHaveCount(1);
    await expect(page.locator('.message-row.is-selected')).toHaveAttribute('data-message-id', 'q-2');
  });

  test('a row is reachable and selectable from the keyboard', async ({ page }) => {
    await open(page, only(message({ messageId: 'q-1', title: 'first' })));

    await page.locator('.message-row').focus();
    await page.keyboard.press('Enter');

    await expect(page.locator('.message-row.is-selected')).toHaveCount(1);
  });

  test('selection hands pane 3 the message', async ({ page }) => {
    // What pane 3 then *does* with it is pane-detail.spec.ts. All this checks
    // is the handoff: the click reaches the right renderer with the right id.
    await open(page, {
      ...only(message({
        messageId: 'p-1',
        msgType: 'notification',
        title: 'Deploy finished',
      })),
      details: {
        'p-1': {
          row: message({ messageId: 'p-1', msgType: 'notification', title: 'Deploy finished' }),
          request: { body: 'All green.' },
          settlement: null,
          sender: null,
        },
      },
    });

    await page.locator('.message-row').click();

    const detail = page.locator('.detail-root');
    await expect(detail).toHaveAttribute('data-message-id', 'p-1');
    await expect(detail.locator('.detail-title')).toHaveText('Deploy finished');
  });

  test('an empty list says so rather than showing a blank pane', async ({ page }) => {
    await open(page, { messages: list({ messages: [] }) });

    await expect(page.locator('.list-empty')).toBeVisible();
    await expect(page.locator('.message-row')).toHaveCount(0);
  });
});

test.describe('Pane 2 — event refresh scheduling', () => {
  test('refreshes after 100ms quiet and by 500ms under continuous events', async ({ page }) => {
    await page.clock.install({ time: new Date('2026-09-04T08:00:00Z') });
    await open(page, only(message({ messageId: 'q-1' })));
    await page.clock.pauseAt(new Date('2026-09-04T09:00:00Z'));

    const initial = await projectionCounts(page);
    await page.evaluate(() => (window as any).__simulateChange());
    await page.clock.runFor(99);
    expect(await projectionCounts(page)).toEqual(initial);

    await page.clock.runFor(1);
    await expect.poll(() => projectionCounts(page)).toEqual({
      trees: initial.trees + 1,
      lists: initial.lists + 1,
    });

    const beforeNoisyBurst = await projectionCounts(page);
    await page.evaluate(() => (window as any).__simulateChange());
    for (let event = 0; event < 5; event += 1) {
      await page.clock.runFor(90);
      await page.evaluate(() => (window as any).__simulateChange());
    }
    await page.clock.runFor(49);
    expect(await projectionCounts(page)).toEqual(beforeNoisyBurst);

    await page.clock.runFor(1);
    await expect.poll(() => projectionCounts(page)).toEqual({
      trees: beforeNoisyBurst.trees + 1,
      lists: beforeNoisyBurst.lists + 1,
    });
  });

  test('keeps one active projection, one trailing projection, and immediate explicit refreshes', async ({ page }) => {
    await page.clock.install({ time: new Date('2026-09-04T08:00:00Z') });
    await open(page, {
      messages: {
        'all|null': list({ messages: [message({ messageId: 'q-open', title: 'open' })] }),
        'all|answered': list({
          filter: 'answered',
          messages: [message({ messageId: 'q-done', title: 'done', status: 'answered' })],
        }),
      },
    });
    await page.clock.pauseAt(new Date('2026-09-04T09:00:00Z'));

    const beforeExplicit = await projectionCounts(page);
    await page.evaluate(() => (window as any).__simulateChange());
    await page.locator('.filter[data-filter="answered"]').click();
    await expect.poll(() => projectionCounts(page)).toEqual({
      trees: beforeExplicit.trees + 1,
      lists: beforeExplicit.lists + 1,
    });
    await expect(page.locator('.message-title')).toHaveText('done');
    await page.clock.runFor(100);
    expect(await projectionCounts(page)).toEqual({
      trees: beforeExplicit.trees + 1,
      lists: beforeExplicit.lists + 1,
    });

    await page.evaluate(async ({ agents, projection }) => {
      const { createInbox } = await import('/inbox.js');
      const host = document.createElement('section');
      host.innerHTML = '<div class="agents"></div><div class="filters"></div>'
        + '<div class="types"></div><div class="messages"></div><div class="detail"></div>';
      document.body.appendChild(host);

      const calls: string[] = [];
      let releaseFirstTree: ((value: unknown) => void) | null = null;
      let holdFirstTree = true;
      const invoke = (command: string) => {
        calls.push(command);
        if (command === 'list_sessions' && holdFirstTree) {
          holdFirstTree = false;
          return new Promise(resolve => { releaseFirstTree = resolve; });
        }
        if (command === 'list_sessions') return Promise.resolve(agents);
        if (command === 'list_messages') return Promise.resolve(projection);
        return Promise.resolve(null);
      };
      const inbox = createInbox({
        invoke,
        elements: {
          agents: host.querySelector('.agents'),
          filterBar: host.querySelector('.filters'),
          typeFilterSet: host.querySelector('.types'),
          messageList: host.querySelector('.messages'),
          detail: host.querySelector('.detail'),
        },
      });
      (window as any).__CONTROLLED_REFRESH = {
        calls,
        inbox,
        host,
        releaseFirstTree: () => releaseFirstTree?.(agents),
      };
    }, {
      agents: AGENTS,
      projection: list({ messages: [message({ messageId: 'q-final', title: 'final' })] }),
    });

    await page.evaluate(() => {
      void (window as any).__CONTROLLED_REFRESH.inbox.refreshAfterChange();
    });
    await page.clock.runFor(100);
    expect(await page.evaluate(() => (window as any).__CONTROLLED_REFRESH.calls)).toEqual(['list_sessions']);

    await page.evaluate(() => {
      const controlled = (window as any).__CONTROLLED_REFRESH;
      for (let event = 0; event < 20; event += 1) void controlled.inbox.refreshAfterChange();
    });
    await page.clock.runFor(100);
    await page.evaluate(() => (window as any).__CONTROLLED_REFRESH.releaseFirstTree());

    await expect.poll(() => page.evaluate(() => ({
      calls: (window as any).__CONTROLLED_REFRESH.calls,
      title: (window as any).__CONTROLLED_REFRESH.host.querySelector('.message-title')?.textContent,
    }))).toEqual({ calls: ['list_sessions', 'list_sessions', 'list_messages'], title: 'final' });
  });

  test('bounds 500 paced events and converges to the final authoritative row', async ({ page }) => {
    await page.clock.install({ time: new Date('2026-09-04T08:00:00Z') });
    await open(page, only(message({ messageId: 'q-1', title: 'event-0' })));
    await page.clock.pauseAt(new Date('2026-09-04T09:00:00Z'));
    const before = await projectionCounts(page);

    await page.evaluate(() => {
      const browserWindow = window as any;
      const messageList = document.querySelector('#message-list') as HTMLElement;
      const replaceChildren = messageList.replaceChildren.bind(messageList);
      browserWindow.__LIST_COMMITS = 0;
      messageList.replaceChildren = (...nodes: (Node | string)[]) => {
        browserWindow.__LIST_COMMITS += 1;
        replaceChildren(...nodes);
      };

      let emitted = 0;
      const interval = setInterval(() => {
        emitted += 1;
        const current = browserWindow.__INBOX_FIXTURE.messages;
        browserWindow.__INBOX_FIXTURE.messages = {
          ...current,
          messages: current.messages.map((row: any, index: number) => index === 0
            ? { ...row, title: `event-${emitted}` }
            : row),
        };
        browserWindow.__simulateChange();
        if (emitted === 500) {
          clearInterval(interval);
          browserWindow.__EMITTED_EVENTS = emitted;
        }
      }, 10);
    });

    await page.clock.runFor(5_100);
    await expect(page.locator('.message-title')).toHaveText('event-500');
    const result = await page.evaluate(() => ({
      commits: (window as any).__LIST_COMMITS,
      emitted: (window as any).__EMITTED_EVENTS,
    }));
    const after = await projectionCounts(page);

    expect(result.emitted).toBe(500);
    expect(after.trees - before.trees).toBeLessThanOrEqual(11);
    expect(after.lists - before.lists).toBeLessThanOrEqual(11);
    expect(result.commits).toBeLessThanOrEqual(11);
  });
});

test.describe('Pane 2 — the filters (spec §7.3)', () => {
  const FILTERED = {
    'all|null': list({
      filter: 'needs_you',
      defaultFilter: 'needs_you',
      counts: { all: 4, needsYou: 2, answered: 2, notifications: 1 },
      messages: [
        message({ messageId: 'q-1', title: 'still open' }),
        message({ messageId: 'n-1', msgType: 'notification', title: 'undismissed' }),
      ],
    }),
    'all|answered': list({
      filter: 'answered',
      defaultFilter: 'needs_you',
      counts: { all: 4, needsYou: 2, answered: 2, notifications: 1 },
      messages: [
        message({ messageId: 'q-2', title: 'closed', status: 'answered', responder: 'phone' }),
        message({ messageId: 'n-2', msgType: 'notification', title: 'gone', status: 'dismissed' }),
      ],
    }),
    'all|notifications': list({
      filter: 'notifications',
      defaultFilter: 'needs_you',
      counts: { all: 4, needsYou: 2, answered: 2, notifications: 1 },
      messages: [message({ messageId: 'n-1', msgType: 'notification', title: 'undismissed' })],
    }),
  };

  test('status tabs and message type toggles are separate filter dimensions', async ({ page }) => {
    await open(page, { messages: FILTERED });

    await expect(page.locator('.filter')).toHaveText([
      /All\s*4/,
      /Needs you\s*2/,
      /Answered\s*2/,
    ]);
    await expect(page.locator('.type-filter')).toHaveText([
      /Work\s*0/,
      /Notifications\s*1/,
      /Questions\s*1/,
      /Review plans\s*0/,
    ]);
    await expect(page.locator('.type-filter[aria-pressed="true"]')).toHaveCount(4);
  });

  test('a keyboard type toggle keeps focus on the same control after projection', async ({ page }) => {
    await open(page, { messages: FILTERED });
    const toggle = page.locator('.type-filter[data-type="notification"]');
    await toggle.focus();
    await page.keyboard.press('Enter');
    await expect(toggle).toBeFocused();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  });

  test('counted mark-all-read is a separate scope-wide action with one guarded activation and mobile reflow', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    const answeredScope = list({
      filter: 'answered',
      defaultFilter: 'needs_you',
      actionableNotificationIds: ['n-hidden-status', 'n-hidden-type', 'n-visible'],
      counts: { all: 5, needsYou: 3, answered: 2, notifications: 3 },
      messages: [
        message({ messageId: 'q-answered', title: 'answered question', status: 'answered' }),
        message({ messageId: 'n-dismissed', msgType: 'notification', title: 'read', status: 'dismissed' }),
      ],
    });
    await open(page, {
      messages: list({
        filter: 'answered',
        defaultFilter: 'needs_you',
        actionableNotificationIds: [],
        counts: { all: 2, needsYou: 0, answered: 2, notifications: 1 },
        messages: answeredScope.messages,
      }),
    });

    const outer = page.locator('#type-filter-bar');
    await expect(outer).not.toHaveAttribute('role', 'group');
    await expect(outer.locator('.type-filter-set')).toHaveAttribute('role', 'group');
    await expect(outer.locator('.type-filter-set')).toHaveAttribute('aria-label', 'Message types');
    await expect(outer.locator('.list-actions')).toHaveCount(1);

    const mark = page.locator('.mark-all-read');
    await expect(mark).toBeHidden();
    await page.evaluate(projection => {
      (window as any).__INBOX_FIXTURE.messages = projection;
      (window as any).__simulateChange();
    }, answeredScope);
    await expect(mark).toBeVisible();
    await expect(mark).toHaveAccessibleName('Mark all read (3)');
    const describedBy = await mark.getAttribute('aria-describedby');
    await expect(page.locator(`#${describedBy}`))
      .toContainText('Status and message type filters do not limit this action.');

    for (const width of [320, 420, 599, 600]) {
      await page.setViewportSize({ width, height: 800 });
      const layout = await page.evaluate(() => {
        const row = document.querySelector('.type-filter-bar')!;
        const actions = document.querySelector('.list-actions')!;
        const rowStyle = getComputedStyle(row);
        return {
        documentFits: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        paneFits: document.querySelector('.pane-list')!.scrollWidth
          <= document.querySelector('.pane-list')!.clientWidth,
        actionWraps: getComputedStyle(document.querySelector('.mark-all-read')!).whiteSpace,
          actionWidth: actions.getBoundingClientRect().width,
          rowContentWidth: row.getBoundingClientRect().width
            - Number.parseFloat(rowStyle.paddingLeft)
            - Number.parseFloat(rowStyle.paddingRight),
        };
      });
      expect(layout).toMatchObject({ documentFits: true, paneFits: true, actionWraps: 'nowrap' });
      if (width < 600) expect(layout.actionWidth).toBeCloseTo(layout.rowContentWidth, 0);
    }

    await page.evaluate(() => {
      const browserWindow = window as any;
      browserWindow.__MARK_NODE = document.querySelector('.mark-all-read');
      browserWindow.__REPLIES ??= {};
      browserWindow.__REPLIES.dismiss_notifications = new Promise(() => {});
    });
    await mark.focus();
    await page.keyboard.press('Enter');

    await expect(mark).toHaveText('Marking 3…');
    await expect(mark).toHaveAttribute('aria-disabled', 'true');
    expect(await page.evaluate(() => {
      const browserWindow = window as any;
      const current = document.querySelector('.mark-all-read');
      return browserWindow.__MARK_NODE === current && current?.isConnected;
    })).toBe(true);

    await mark.dispatchEvent('click');
    expect(await page.evaluate(() => (window as any).__INVOCATIONS
      .filter((call: any) => call.cmd === 'dismiss_notifications').length)).toBe(1);

    await page.evaluate(projectProjection => {
      const fixture = (window as any).__INBOX_FIXTURE;
      fixture.messages = {
        'all|answered': fixture.messages,
        'project:Hitl_MCP|null': projectProjection,
      };
    }, list({
      messages: [message({ messageId: 'n-project', msgType: 'notification' })],
      actionableNotificationIds: ['n-project'],
      scopeKey: 'project:Hitl_MCP',
      filter: 'needs_you',
      defaultFilter: 'needs_you',
    }));
    await page.setViewportSize({ width: 1200, height: 800 });
    await page.locator('.agent-row--project', { hasText: 'Hitl_MCP' }).click();
    await expect(mark).toHaveAccessibleName('Bulk action in All messages…');
    await expect(mark).toHaveAttribute('aria-disabled', 'true');
  });

  test('Needs you is the default when anything is pending', async ({ page }) => {
    await open(page, { messages: FILTERED });

    // The UI asks for `null` — "you pick" — and the server resolves it, so the
    // §7.3 rule lives in one place rather than in both.
    const invocations = await page.evaluate(() => (window as any).__INVOCATIONS);
    const first = invocations.find((i: any) => i.cmd === 'list_messages');
    expect(first.args.filter).toBeNull();

    await expect(page.locator('.filter.is-active')).toHaveText(/Needs you/);
    await expect(page.locator('.filter[data-filter="needs_you"]'))
      .toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.message-title')).toHaveText(['still open', 'undismissed']);
  });

  test('All is the default when nothing is pending', async ({ page }) => {
    await open(page, {
      messages: list({
        messages: [message({ messageId: 'q-1', status: 'answered', responder: 'phone' })],
      }),
    });

    await expect(page.locator('.filter.is-active')).toHaveText(/All/);
  });

  test('clicking a filter asks the server for it and redraws', async ({ page }) => {
    await open(page, { messages: FILTERED });

    await page.locator('.filter[data-filter="answered"]').click();

    const invocations = await page.evaluate(() => (window as any).__INVOCATIONS);
    expect(invocations.filter((i: any) => i.cmd === 'list_messages').pop().args.filter)
      .toBe('answered');
    await expect(page.locator('.filter.is-active')).toHaveText(/Answered/);
    await expect(page.locator('.message-title')).toHaveText(['closed', 'gone']);
  });

  test('type combinations apply locally without another native projection', async ({ page }) => {
    await open(page, only(
      message({ messageId: 'n-1', msgType: 'notification', title: 'notification' }),
      message({ messageId: 'q-1', title: 'question' }),
      message({ messageId: 'p-1', msgType: 'plan_review', title: 'review' }),
    ));
    const before = await page.evaluate(() => (window as any).__INVOCATIONS.length);

    await page.locator('.type-filter[data-type="notification"]').click();
    await page.locator('.type-filter[data-type="plan_review"]').click();
    await page.locator('.type-filter[data-type="work"]').click();

    await expect(page.locator('.message-title')).toHaveText(['question']);
    expect(await page.evaluate(() => (window as any).__INVOCATIONS.length)).toBe(before);
    await expect(page.locator('.type-filter[data-type="question"]')).toBeDisabled();
  });

  test('an enabled combination with no rows names the combined filters', async ({ page }) => {
    await open(page, only(message({ messageId: 'q-1' })));

    await page.locator('.type-filter[data-type="question"]').click();

    await expect(page.locator('.list-empty')).toHaveText('Nothing matches these filters.');
  });

  test('the type combination survives a status refresh', async ({ page }) => {
    await open(page, { messages: FILTERED });
    await page.locator('.type-filter[data-type="notification"]').click();

    await page.locator('.filter[data-filter="answered"]').click();

    await expect(page.locator('.type-filter[data-type="notification"]'))
      .toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('.message-title')).toHaveText(['closed']);
  });

  test('the type combination survives an agent-scope refresh', async ({ page }) => {
    const messages = {
      'all|null': list({
        filter: 'needs_you',
        messages: [
          message({ messageId: 'n-all', msgType: 'notification', title: 'all notification' }),
          message({ messageId: 'q-all', title: 'all question' }),
        ],
      }),
      'session:Hitl_MCP · master · a3f2|null': list({
        filter: 'needs_you',
        messages: [
          message({ messageId: 'n-session', msgType: 'notification', title: 'session notification' }),
          message({ messageId: 'q-session', title: 'session question' }),
        ],
      }),
    };
    await open(page, { messages });
    await page.locator('.type-filter[data-type="notification"]').click();

    await page.locator('.agent-row--session').click();

    await expect(page.locator('.type-filter[data-type="notification"]'))
      .toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('.message-title')).toHaveText(['session question']);
  });

  test('excluding a selected middle type selects the next surviving row without phone navigation', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 800 });
    await open(page, only(
      message({ messageId: 'n-1', msgType: 'notification', title: 'before' }),
      message({ messageId: 'q-1', title: 'selected' }),
      message({ messageId: 'p-1', msgType: 'plan_review', title: 'after' }),
    ));

    await page.locator('.message-row[data-message-id="q-1"]').click();
    await page.locator('#pane-back').click();
    await page.locator('.type-filter[data-type="question"]').click();

    await expect(page.locator('.message-row.is-selected')).toHaveAttribute('data-message-id', 'p-1');
    await expect(page.locator('html')).toHaveAttribute('data-pane', 'list');
    await expect(page.locator('.pane-list')).toBeVisible();
  });

  test('excluding a selected final type selects the previous surviving row', async ({ page }) => {
    await open(page, only(
      message({ messageId: 'n-1', msgType: 'notification', title: 'before' }),
      message({ messageId: 'q-1', title: 'middle' }),
      message({ messageId: 'p-1', msgType: 'plan_review', title: 'selected' }),
    ));

    await page.locator('.message-row[data-message-id="p-1"]').click();
    await page.locator('.type-filter[data-type="plan_review"]').click();

    await expect(page.locator('.message-row.is-selected')).toHaveAttribute('data-message-id', 'q-1');
  });

  test('changing agent re-defaults the filter rather than inheriting it', async ({ page }) => {
    // A different agent is a different question about what needs you.
    await open(page, { messages: FILTERED });
    await page.locator('.filter[data-filter="answered"]').click();

    await page.locator('.agent-row--session').click();

    const invocations = await page.evaluate(() => (window as any).__INVOCATIONS);
    const last = invocations.filter((i: any) => i.cmd === 'list_messages').pop();
    expect(last.args.sessionKey).toBe('session:Hitl_MCP · master · a3f2');
    expect(last.args.filter).toBeNull();
  });
});
