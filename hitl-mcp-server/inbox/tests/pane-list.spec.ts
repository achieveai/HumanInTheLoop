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
  await expect(page.locator('.filter-bar .filter')).toHaveCount(4);
}

/** One list, answering every scope/filter combination. */
function only(...messages: ReturnType<typeof message>[]): Fixture {
  return { messages: list({ messages }) };
}

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

  test('all four filters are pinned at the top of the pane, with counts', async ({ page }) => {
    await open(page, { messages: FILTERED });

    await expect(page.locator('.filter')).toHaveText([
      /All\s*4/,
      /Needs you\s*2/,
      /Answered\s*2/,
      /Notifications\s*1/,
    ]);
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

  test('the Notifications filter selects by type, not by status', async ({ page }) => {
    await open(page, { messages: FILTERED });

    await page.locator('.filter[data-filter="notifications"]').click();

    await expect(page.locator('.message-row')).toHaveCount(1);
    await expect(page.locator('.message-row')).toHaveAttribute('data-type', 'notification');
  });

  test('a filter with nothing under it names the filter rather than claiming an empty inbox', async ({ page }) => {
    await open(page, {
      messages: {
        'all|null': list({
          filter: 'needs_you',
          defaultFilter: 'needs_you',
          counts: { all: 3, needsYou: 1, answered: 2, notifications: 0 },
          messages: [message({ messageId: 'q-1' })],
        }),
        'all|notifications': list({
          filter: 'notifications',
          defaultFilter: 'needs_you',
          counts: { all: 3, needsYou: 1, answered: 2, notifications: 0 },
          messages: [],
        }),
      },
    });

    await page.locator('.filter[data-filter="notifications"]').click();

    await expect(page.locator('.list-empty')).toHaveText('Nothing under Notifications.');
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
