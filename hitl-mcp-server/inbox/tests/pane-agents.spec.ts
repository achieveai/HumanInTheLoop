import { test, expect, type Page } from '@playwright/test';
import {
  DAY,
  Fixture,
  MINUTE,
  NOW,
  list,
  message,
  project,
  session,
  tree,
  unattributedNode,
} from './fixtures.js';

// inbox-harness.html imports the real inbox.js / pane-agents.js modules and
// mocks window.__TAURI__, recording every invoke() so a test can assert what
// the UI asked for as well as what it drew.

async function open(page: Page, fixture: Fixture) {
  await page.addInitScript(f => {
    (window as any).__INBOX_FIXTURE = f;
  }, fixture);
  await page.goto('/inbox-harness.html');
  await expect(page.locator('.agent-row--root')).toBeVisible();
}

/** Swap the fixture and push a live `inbox-changed` through the real listener. */
async function landNewEvents(page: Page, fixture: Fixture) {
  await page.evaluate(f => {
    (window as any).__INBOX_FIXTURE = f;
    (window as any).__simulateChange();
  }, fixture);
}

const HITL = project({
  projectKey: 'Hitl_MCP',
  state: 'waiting',
  pendingCount: 2,
  messageCount: 3,
  lastEventAt: NOW - 2 * MINUTE,
  sessions: [
    session({
      sessionKey: 'Hitl_MCP · master · a3f2',
      label: 'master · a3f2',
      state: 'waiting',
      pendingCount: 2,
      messageCount: 2,
      lastEventAt: NOW - 2 * MINUTE,
    }),
    session({
      sessionKey: 'Hitl_MCP · feat/inbox · 9c81',
      label: 'feat/inbox · 9c81',
      state: 'idle',
      lastEventAt: NOW - 41 * MINUTE,
    }),
  ],
});

const MCQDB = project({
  projectKey: 'mcqdb-api',
  state: 'active',
  lastEventAt: NOW - 6 * MINUTE,
  sessions: [
    session({
      sessionKey: 'mcqdb-api · main · 7b1e',
      label: 'main · 7b1e',
      projectKey: 'mcqdb-api',
      state: 'active',
      lastEventAt: NOW - 6 * MINUTE,
    }),
  ],
});

test.describe('Pane 1 — the agent tree', () => {
  test('renders the All agents root, then a project row per project with its sessions nested', async ({ page }) => {
    await open(page, { sessions: tree({ projects: [HITL, MCQDB] }) });

    await expect(page.locator('.agent-row--root .agent-name')).toHaveText('All agents');
    await expect(page.locator('.agent-row--project .agent-name')).toHaveText([
      'Hitl_MCP',
      'mcqdb-api',
    ]);
    await expect(page.locator('.agent-row--session .agent-name')).toHaveText([
      'master · a3f2',
      'feat/inbox · 9c81',
      'main · 7b1e',
    ]);

    // Two levels, and the sessions sit under their own project rather than in
    // one flat list.
    const group = page.locator('.agent-group').first();
    await expect(group.locator('.agent-row--session')).toHaveCount(2);
  });

  test('each row carries the state and glyph the projection decided', async ({ page }) => {
    await open(page, {
      sessions: tree({
        projects: [
          project({
            projectKey: 'Every',
            state: 'waiting',
            pendingCount: 1,
            sessions: [
              session({ sessionKey: 'w', label: 'waiting one', state: 'waiting', pendingCount: 1 }),
              session({ sessionKey: 'a', label: 'active one', state: 'active' }),
              session({ sessionKey: 'i', label: 'idle one', state: 'idle' }),
              session({
                sessionKey: 's',
                label: 'stale one',
                state: 'stale',
                lastEventAt: NOW - 3 * DAY,
              }),
            ],
          }),
        ],
      }),
    });

    const rows = page.locator('.agent-row--session');
    await expect(rows.nth(0)).toHaveAttribute('data-state', 'waiting');
    await expect(rows.nth(0).locator('.agent-glyph')).toHaveText('●');
    await expect(rows.nth(1)).toHaveAttribute('data-state', 'active');
    await expect(rows.nth(1).locator('.agent-glyph')).toHaveText('◐');
    await expect(rows.nth(2)).toHaveAttribute('data-state', 'idle');
    await expect(rows.nth(2).locator('.agent-glyph')).toHaveText('○');
    await expect(rows.nth(3)).toHaveAttribute('data-state', 'stale');
  });

  test('a stale row uses the idle glyph, dimmed', async ({ page }) => {
    // Spec §6.1 gives `stale` "○ dim" — the same mark as idle, distinguished
    // only by weight. A different glyph would read as a different kind of
    // thing rather than as the same thing gone quiet.
    await open(page, {
      sessions: tree({
        projects: [
          project({
            projectKey: 'Old',
            state: 'stale',
            sessions: [session({ sessionKey: 'old', state: 'stale' })],
          }),
        ],
      }),
    });

    const row = page.locator('.agent-row--session');
    await expect(row.locator('.agent-glyph')).toHaveText('○');
    const opacity = await row.evaluate(el => Number(getComputedStyle(el).opacity));
    expect(opacity).toBeLessThan(1);
  });

  test('a pending count is shown only when something is actually pending', async ({ page }) => {
    await open(page, { sessions: tree({ projects: [HITL, MCQDB] }) });

    await expect(page.locator('.agent-row--root .agent-pending')).toHaveText('2');
    const waiting = page.locator('.agent-row--session').first();
    await expect(waiting.locator('.agent-pending')).toHaveText('2');

    const idle = page.locator('.agent-row--session').nth(1);
    await expect(idle.locator('.agent-pending')).toHaveCount(0);
  });

  test('a row shows a relative age and keeps the absolute time on hover', async ({ page }) => {
    await open(page, { sessions: tree({ projects: [HITL] }) });

    const age = page.locator('.agent-row--session').first().locator('.agent-age');
    await expect(age).toHaveText('2m');
    await expect(age).toHaveAttribute('title', /\d/);
  });

  test('clicking a session row asks for exactly that session', async ({ page }) => {
    await open(page, { sessions: tree({ projects: [HITL, MCQDB] }) });

    await page.locator('.agent-row--session', { hasText: 'feat/inbox' }).click();

    const invocations = await page.evaluate(() => (window as any).__INVOCATIONS);
    const last = invocations.filter((i: any) => i.cmd === 'list_messages').pop();
    expect(last.args.sessionKey).toBe('session:Hitl_MCP · feat/inbox · 9c81');
  });

  test('clicking a project row asks for the project, and the root for everything', async ({ page }) => {
    await open(page, { sessions: tree({ projects: [HITL, MCQDB] }) });

    await page.locator('.agent-row--project', { hasText: 'mcqdb-api' }).click();
    let invocations = await page.evaluate(() => (window as any).__INVOCATIONS);
    expect(invocations.filter((i: any) => i.cmd === 'list_messages').pop().args.sessionKey)
      .toBe('project:mcqdb-api');

    await page.locator('.agent-row--root').click();
    invocations = await page.evaluate(() => (window as any).__INVOCATIONS);
    expect(invocations.filter((i: any) => i.cmd === 'list_messages').pop().args.sessionKey)
      .toBe('all');
  });

  test('the selected row is the only highlighted one', async ({ page }) => {
    await open(page, { sessions: tree({ projects: [HITL, MCQDB] }) });

    await expect(page.locator('.agent-row.is-selected')).toHaveCount(1);
    await expect(page.locator('.agent-row.is-selected')).toHaveClass(/agent-row--root/);

    await page.locator('.agent-row--session', { hasText: 'main · 7b1e' }).click();

    await expect(page.locator('.agent-row.is-selected')).toHaveCount(1);
    await expect(page.locator('.agent-row.is-selected .agent-name')).toHaveText('main · 7b1e');
  });

  test('an empty tree says so rather than rendering nothing at all', async ({ page }) => {
    await open(page, { sessions: tree({ projects: [] }) });

    await expect(page.locator('.agents-empty')).toBeVisible();
    await expect(page.locator('.agent-row--root')).toBeVisible();
  });
});

test.describe('Pane 1 — the Unattributed group (spec §5.5)', () => {
  const orphan = unattributedNode({
    state: 'waiting',
    pendingCount: 1,
    messageCount: 1,
    lastEventAt: NOW - 10,
  });

  test('a message whose identity has not joined shows under Unattributed', async ({ page }) => {
    await open(page, { sessions: tree({ projects: [HITL, orphan] }) });

    const group = page.locator('.agent-group--unattributed');
    await expect(group.locator('.agent-name').first()).toHaveText('Unattributed');
    await expect(group.locator('.agent-row--project')).toHaveAttribute('data-scope-key', 'unattributed');
  });

  test('Unattributed has no session rows, because there is no session yet', async ({ page }) => {
    await open(page, { sessions: tree({ projects: [HITL, orphan] }) });

    await expect(page.locator('.agent-group--unattributed .agent-row--session')).toHaveCount(0);
  });

  test('Unattributed stays last even when it holds the newest message', async ({ page }) => {
    // Every question passes through this group on the way in. Sorting it on
    // recency would put it above the projects on every single arrival.
    await open(page, { sessions: tree({ projects: [HITL, orphan] }) });

    await expect(page.locator('.agent-row--project .agent-name')).toHaveText([
      'Hitl_MCP',
      'Unattributed',
    ]);
  });

  test('a message leaves Unattributed silently when its identity lands', async ({ page }) => {
    // The point of §5.5: the UI never sees the race. One more event arrives,
    // the tree is re-derived, and the group is simply gone — no reload, no
    // prompt, nothing for the user to do.
    await open(page, { sessions: tree({ projects: [orphan] }) });
    await expect(page.locator('.agent-group--unattributed')).toHaveCount(1);
    await expect(page.locator('.agent-row--session')).toHaveCount(0);

    await landNewEvents(page, {
      sessions: tree({
        projects: [
          project({
            projectKey: 'Hitl_MCP',
            state: 'waiting',
            pendingCount: 1,
            lastEventAt: NOW - 10,
            sessions: [
              session({
                sessionKey: 'Hitl_MCP · master · a3f2',
                label: 'master · a3f2',
                state: 'waiting',
                pendingCount: 1,
                lastEventAt: NOW - 10,
              }),
            ],
          }),
        ],
      }),
    });

    await expect(page.locator('.agent-group--unattributed')).toHaveCount(0);
    await expect(page.locator('.agent-row--session .agent-name')).toHaveText('master · a3f2');
  });

  test('selecting Unattributed asks for exactly the unattributed messages', async ({ page }) => {
    await open(page, {
      sessions: tree({ projects: [HITL, orphan] }),
      messages: {
        'unattributed|null': list({
          scopeKey: 'unattributed',
          messages: [
            message({
              messageId: 'q-orphan',
              title: 'Who am I from?',
              unattributed: true,
              sessionKey: null,
              sessionLabel: null,
              projectKey: '__unattributed__',
            }),
          ],
        }),
      },
    });

    await page.locator('.agent-group--unattributed .agent-row--project').click();

    const invocations = await page.evaluate(() => (window as any).__INVOCATIONS);
    expect(invocations.filter((i: any) => i.cmd === 'list_messages').pop().args.sessionKey)
      .toBe('unattributed');
    await expect(page.locator('.message-title')).toHaveText('Who am I from?');
  });
});

test.describe('Pane 1 — live updates', () => {
  test('a new event redraws the tree without a reload', async ({ page }) => {
    await open(page, { sessions: tree({ projects: [MCQDB] }) });
    await expect(page.locator('.agent-row--project')).toHaveCount(1);

    await landNewEvents(page, {
      sessions: tree({ projects: [HITL, MCQDB] }),
    });

    await expect(page.locator('.agent-row--project .agent-name')).toHaveText([
      'Hitl_MCP',
      'mcqdb-api',
    ]);
  });

  test('a redraw keeps the current selection', async ({ page }) => {
    await open(page, { sessions: tree({ projects: [HITL, MCQDB] }) });
    await page.locator('.agent-row--session', { hasText: 'main · 7b1e' }).click();

    await landNewEvents(page, {
      sessions: tree({ projects: [HITL, MCQDB] }),
    });

    await expect(page.locator('.agent-row.is-selected .agent-name')).toHaveText('main · 7b1e');
  });

  test('agent-authored labels are never interpreted as markup', async ({ page }) => {
    // A branch name is whatever someone typed, and it reaches the tree through
    // the sender label.
    const hostile = '<img src=x onerror="window.__pwned=1">';
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));

    await open(page, {
      sessions: tree({
        projects: [
          project({
            projectKey: hostile,
            sessions: [session({ sessionKey: 's', label: hostile })],
          }),
        ],
      }),
    });

    await expect(page.locator('.agent-row--project .agent-name')).toHaveText(hostile);
    await expect(page.locator('.agent-name img')).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).__pwned)).toBeUndefined();
    expect(errors).toEqual([]);
  });
});
