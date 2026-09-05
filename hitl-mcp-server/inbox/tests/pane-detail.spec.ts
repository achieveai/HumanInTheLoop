import { test, expect, type Page } from '@playwright/test';
import { Fixture, bodyOk, detail, list, message, project, session, tree } from './fixtures.js';

// Pane 3's shell (spec §8, §11) — driven through the real app, not a mounted
// renderer, because what is under test here is the wiring: which command is
// called, when, and what happens when one of them does not answer.

const AGENTS = tree({
  projects: [
    project({
      projectKey: 'Hitl_MCP',
      state: 'waiting',
      pendingCount: 1,
      sessions: [session({ sessionKey: 'Hitl_MCP · master · a3f2', label: 'master · a3f2', state: 'waiting', pendingCount: 1 })],
    }),
  ],
});

async function open(page: Page, fixture: Fixture) {
  await page.addInitScript(f => {
    (window as any).__INBOX_FIXTURE = f;
  }, { sessions: AGENTS, ...fixture });
  await page.goto('/inbox-harness.html');
  await expect(page.locator('.filter-bar .filter')).toHaveCount(3);
}

async function commands(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as any).__INVOCATIONS.map((i: any) => i.cmd));
}

async function deferReply(page: Page, command: string) {
  await page.evaluate(cmd => {
    const browserWindow = window as any;
    browserWindow.__REPLIES ??= {};
    browserWindow.__REPLIES[cmd] = new Promise(() => {});
  }, command);
}

async function controlReply(page: Page, command: string) {
  await page.evaluate(cmd => {
    const browserWindow = window as any;
    browserWindow.__REPLIES ??= {};
    browserWindow.__REPLIES[cmd] = new Promise((resolve, reject) => {
      browserWindow.__resolveReply = resolve;
      browserWindow.__rejectReply = (message: string) => reject(new Error(message));
    });
  }, command);
}

async function controlRepliesIndependently(page: Page, command: string) {
  await page.evaluate(cmd => {
    const browserWindow = window as any;
    browserWindow.__CONTROLLED_REPLIES = [];
    browserWindow.__REPLIES ??= {};
    browserWindow.__REPLIES[cmd] = {
      then(resolve: (value: unknown) => void, reject: (error: Error) => void) {
        browserWindow.__CONTROLLED_REPLIES.push({ resolve, reject });
      },
    };
  }, command);
}

async function resolveControlledReply(page: Page, index: number, value: unknown) {
  await page.evaluate(({ replyIndex, result }) => {
    const control = (window as any).__CONTROLLED_REPLIES[replyIndex];
    if (!control) throw new Error(`Controlled reply ${replyIndex} is not pending`);
    control.resolve(result);
  }, { replyIndex: index, result: value });
}

async function rejectReply(page: Page, message: string) {
  await page.evaluate(text => (window as any).__rejectReply(text), message);
}

async function replyCount(page: Page, command: string) {
  return page.evaluate(cmd => (window as any).__INVOCATIONS
    .filter((call: any) => call.cmd === cmd).length, command);
}

async function expectImmediateAdvance(page: Page, targetId: string, command: string, nextId: string) {
  await expect(page.locator(`.message-row[data-message-id="${targetId}"]`)).toHaveCount(0, { timeout: 1_000 });
  await expect(page.locator('.message-row.is-selected')).toHaveCount(1);
  await expect(page.locator('.message-row.is-selected')).toHaveAttribute('data-message-id', nextId);
  await expect(page.locator('.detail-root')).toHaveAttribute('data-message-id', nextId);
  expect(await replyCount(page, command)).toBe(1);

  const listCalls = await replyCount(page, 'list_messages');
  await page.evaluate(() => (window as any).__simulateChange());
  await expect.poll(() => replyCount(page, 'list_messages')).toBe(listCalls + 1);
  await expect(page.locator(`.message-row[data-message-id="${targetId}"]`)).toHaveCount(0);
  await expect(page.locator('.message-row.is-selected')).toHaveAttribute('data-message-id', nextId);
}

async function mountDetailController(page: Page, fixture: Fixture = FIXTURE) {
  await open(page, fixture);
  await page.evaluate(async () => {
    const { createDetailPane } = await import('/pane-detail.js');
    const browserWindow = window as any;
    browserWindow.__PARK_DETAIL = createDetailPane({
      container: document.getElementById('pane-detail'),
      invoke: browserWindow.__TAURI__.core.invoke,
    });
  });
}

async function showDetail(page: Page, row: ReturnType<typeof message>) {
  await page.evaluate(async messageRow => {
    await (window as any).__PARK_DETAIL.show(messageRow);
  }, row);
}

async function reviewDocumentListenerProbe(page: Page) {
  return page.evaluate(async () => {
    const originalRaf = window.requestAnimationFrame;
    const nativeRaf = originalRaf.bind(window);
    let scheduledFrames = 0;
    let ctrlKeyReads = 0;
    window.requestAnimationFrame = callback => {
      scheduledFrames += 1;
      return nativeRaf(callback);
    };

    try {
      const keyEvent = new KeyboardEvent('keydown', {
        key: 'f',
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(keyEvent, 'ctrlKey', {
        get: () => {
          ctrlKeyReads += 1;
          return true;
        },
      });
      document.dispatchEvent(keyEvent);
      document.dispatchEvent(new Event('selectionchange'));
      await new Promise(resolve => nativeRaf(() => nativeRaf(resolve)));
      return { ctrlKeyReads, defaultPrevented: keyEvent.defaultPrevented, scheduledFrames };
    } finally {
      window.requestAnimationFrame = originalRaf;
    }
  });
}

const NOTE = message({ messageId: 'n-1', msgType: 'notification', title: 'Deploy finished' });
const QUESTION = message({ messageId: 'q-1', msgType: 'question', title: 'Which storage backend?' });
const PLAN = message({ messageId: 'p-1', msgType: 'plan_review', title: 'docs/plans/inbox.md', contentHash: 'abc123' });
const NEXT = message({ messageId: 'q-next', msgType: 'question', title: 'What should happen next?' });

const FIXTURE: Fixture = {
  messages: list({ messages: [NOTE, QUESTION, PLAN] }),
  details: {
    'n-1': detail(NOTE, { request: { body: 'All green.' } }),
    'q-1': detail(QUESTION, { request: { question: 'Which storage backend?', allowOther: true, options: [{ label: 'SQLite', value: 'sqlite' }] } }),
    'p-1': detail(PLAN, { request: { snapshotHash: 'abc123', displayPath: 'docs/plans/inbox.md', revision: 1, isNewPlan: true } }),
  },
  bodies: { 'p-1': bodyOk('# Plan\n\nOne step.\n') },
};

function actionFixture(target: ReturnType<typeof message>, messages = [target, NEXT]): Fixture {
  return {
    messages: list({ messages, filter: 'needs_you', defaultFilter: 'needs_you' }),
    details: {
      [target.messageId]: target.msgType === 'notification'
        ? detail(target, { request: { body: 'Action required.' } })
        : target.msgType === 'plan_review'
          ? detail(target, {
            request: {
              planId: 'plan-1',
              snapshotHash: 'abc123',
              displayPath: 'docs/plans/inbox.md',
              revision: 1,
              isNewPlan: true,
            },
          })
          : detail(target, {
            request: {
              question: target.title,
              allowOther: true,
              options: [{ label: 'Proceed', value: 'proceed' }],
            },
          }),
      [NEXT.messageId]: detail(NEXT, {
        request: { question: NEXT.title, options: [{ label: 'Continue', value: 'continue' }] },
      }),
    },
    bodies: target.msgType === 'plan_review'
      ? { [target.messageId]: bodyOk('# Plan\n\nOne step.\n') }
      : {},
  };
}

test.describe('Pane 3 — picking a renderer (spec §8)', () => {
  test('each message type gets its own renderer', async ({ page }) => {
    await open(page, FIXTURE);

    await page.locator('.message-row[data-message-id="n-1"]').click();
    await expect(page.locator('.detail-notification')).toHaveCount(1);

    await page.locator('.message-row[data-message-id="q-1"]').click();
    await expect(page.locator('.detail-question')).toHaveCount(1);

    await page.locator('.message-row[data-message-id="p-1"]').click();
    await expect(page.locator('.detail-review .review-root')).toHaveCount(1);
  });

  test('nothing selected says so instead of showing a blank pane', async ({ page }) => {
    await open(page, FIXTURE);
    await expect(page.locator('.detail-empty')).toContainText('Pick a message');
  });
});

test.describe('Pane 3 — when bodies are fetched (spec §11)', () => {
  test('painting the list touches no bodies at all', async ({ page }) => {
    // `list_messages` is pure and pane 2 renders straight from it. A fetch on
    // the paint path would make pane 2 render differently depending on whether
    // the archivist happened to be running — a list whose shape depends on
    // another process's uptime is not a list anyone can trust.
    await open(page, FIXTURE);

    await expect(page.locator('.message-row')).toHaveCount(3);
    expect(await commands(page)).toEqual(['list_sessions', 'list_messages']);
  });

  test('selecting a notification or a question fetches no body either', async ({ page }) => {
    // Both carry their whole body in the request payload. There is nothing to
    // fetch, so nothing is.
    await open(page, FIXTURE);

    await page.locator('.message-row[data-message-id="n-1"]').click();
    await expect(page.locator('.detail-notification')).toHaveCount(1);
    await page.locator('.message-row[data-message-id="q-1"]').click();
    await expect(page.locator('.detail-question')).toHaveCount(1);

    expect(await commands(page)).toEqual(['list_sessions', 'list_messages', 'get_message', 'get_message']);
  });

  test('selecting a plan review fetches its body, once', async ({ page }) => {
    await open(page, FIXTURE);

    await page.locator('.message-row[data-message-id="p-1"]').click();
    await expect(page.locator('.review-root')).toHaveCount(1);

    // `load_review_draft` joins `get_body` on the selection path, and only there
    // — it is asked for after the body succeeds, because a draft is a set of
    // comments anchored to lines of a plan and there is no point restoring them
    // against a plan that could not be shown.
    expect(await commands(page))
      .toEqual(['list_sessions', 'list_messages', 'get_message', 'get_body', 'load_review_draft']);
  });
});

test.describe('Pane 3 — parked detail state', () => {
  test('replacing active reviews releases their document listeners instead of accumulating them', async ({ page }) => {
    await mountDetailController(page);

    for (let cycle = 0; cycle < 3; cycle += 1) {
      await showDetail(page, PLAN);
      await expect(page.locator('.detail-review .review-root')).toHaveCount(1);
      await showDetail(page, cycle % 2 === 0 ? QUESTION : NOTE);
    }

    expect(await reviewDocumentListenerProbe(page)).toEqual({
      // One read belongs to the Inbox's Ctrl+B pane shortcut listener. A
      // retained review would add another read and prevent this Ctrl+F event.
      ctrlKeyReads: 1,
      defaultPrevented: false,
      scheduledFrames: 0,
    });
  });

  test('a parked review is inert, resumes through restore, and releases listeners when discarded', async ({ page }) => {
    await mountDetailController(page);
    await showDetail(page, PLAN);
    await page.locator('#overall-feedback').fill('Keep this exact live controller.');
    await page.evaluate(() => {
      (window as any).__PARKED_REVIEW_NODE = document.querySelector('.detail-root');
    });

    expect(await page.evaluate(() => (window as any).__PARK_DETAIL.park('p-1'))).toBe(true);
    await showDetail(page, NOTE);
    const whileParked = await reviewDocumentListenerProbe(page);
    expect(whileParked).toEqual({ ctrlKeyReads: 1, defaultPrevented: false, scheduledFrames: 0 });
    expect(await page.evaluate(() => (window as any).__PARK_DETAIL.restore('p-1'))).toBe(true);
    expect(await page.evaluate(() =>
      document.querySelector('.detail-root') === (window as any).__PARKED_REVIEW_NODE)).toBe(true);
    await expect(page.locator('#overall-feedback')).toHaveValue('Keep this exact live controller.');
    expect(await reviewDocumentListenerProbe(page)).toMatchObject({ ctrlKeyReads: 2, defaultPrevented: true });

    expect(await page.evaluate(() => (window as any).__PARK_DETAIL.park('p-1'))).toBe(true);
    await showDetail(page, NOTE);
    await page.evaluate(() => (window as any).__PARK_DETAIL.discard('p-1'));
    expect(await reviewDocumentListenerProbe(page)).toEqual({
      ctrlKeyReads: 1,
      defaultPrevented: false,
      scheduledFrames: 0,
    });
  });

  test('parked detail restores the exact question nodes without refetching', async ({ page }) => {
    // Replacing the detail container currently destroys question text because
    // questions have no persisted draft store. The parked pane must therefore
    // preserve the live controls themselves, not reconstruct equivalent ones.
    await mountDetailController(page);
    await showDetail(page, QUESTION);

    await page.locator('.option[data-value="sqlite"]').click();
    await page.locator('.other-input').fill('Keep the WAL on the same volume.');
    await page.evaluate(() => {
      (window as any).__PARKED_DETAIL_NODE = document.querySelector('.detail-root');
    });

    expect(await page.evaluate(() => (window as any).__PARK_DETAIL.park('q-1'))).toBe(true);
    await showDetail(page, NOTE);
    await expect(page.locator('.detail-notification')).toHaveCount(1);

    await showDetail(page, QUESTION);

    expect(await page.evaluate(() =>
      document.querySelector('.detail-root') === (window as any).__PARKED_DETAIL_NODE)).toBe(true);
    await expect(page.locator('.option[data-value="sqlite"] input')).toBeChecked();
    await expect(page.locator('.other-input')).toHaveValue('Keep the WAL on the same volume.');
    expect(await page.evaluate(() => (window as any).__INVOCATIONS
      .filter((call: any) => call.cmd === 'get_message' && call.args?.messageId === 'q-1').length)).toBe(1);
  });

  test('parked detail restores the exact review controller state', async ({ page }) => {
    await mountDetailController(page);
    await showDetail(page, PLAN);

    await page.locator('#overall-feedback').fill('Add a rollback step before deploy.');
    await page.getByRole('tab', { name: 'Source' }).click();
    await page.locator('.diff-row[data-line]').first().click();
    await page.locator('#comment-input').fill('Name the owner for this step.');
    await page.locator('#comment-add').click();
    await page.evaluate(() => {
      (window as any).__PARKED_DETAIL_NODE = document.querySelector('.detail-root');
    });

    expect(await page.evaluate(() => (window as any).__PARK_DETAIL.park('p-1'))).toBe(true);
    await showDetail(page, NOTE);
    await expect(page.locator('.detail-notification')).toHaveCount(1);
    expect(await page.evaluate(() => (window as any).__PARK_DETAIL.restore('p-1'))).toBe(true);

    expect(await page.evaluate(() =>
      document.querySelector('.detail-root') === (window as any).__PARKED_DETAIL_NODE)).toBe(true);
    await expect(page.locator('#overall-feedback')).toHaveValue('Add a rollback step before deploy.');
    await expect(page.locator('.comment-card-list .comment-card-body'))
      .toHaveText('Name the owner for this step.');
    expect(await page.evaluate(() => (window as any).__INVOCATIONS
      .filter((call: any) => call.cmd === 'get_body' && call.args?.messageId === 'p-1').length)).toBe(1);
  });

  test('discarded parked detail is reconstructed on the next show', async ({ page }) => {
    await mountDetailController(page);
    await showDetail(page, QUESTION);
    await page.locator('.other-input').fill('This draft must be released.');
    await page.evaluate(() => {
      (window as any).__PARKED_DETAIL_NODE = document.querySelector('.detail-root');
    });

    expect(await page.evaluate(() => (window as any).__PARK_DETAIL.park('q-1'))).toBe(true);
    await page.evaluate(() => (window as any).__PARK_DETAIL.discard('q-1'));
    await showDetail(page, QUESTION);

    expect(await page.evaluate(() =>
      document.querySelector('.detail-root') === (window as any).__PARKED_DETAIL_NODE)).toBe(false);
    await expect(page.locator('.other-input')).toHaveValue('');
    expect(await page.evaluate(() => (window as any).__INVOCATIONS
      .filter((call: any) => call.cmd === 'get_message' && call.args?.messageId === 'q-1').length)).toBe(2);
  });
});

test.describe('Pane 3 — when a command does not answer (spec §11)', () => {
  test('a failed lookup names the message and reports the failure', async ({ page }) => {
    await open(page, {
      ...FIXTURE,
      details: { ...FIXTURE.details, 'n-1': { __error: 'store is locked' } },
    });

    await page.locator('.message-row[data-message-id="n-1"]').click();
    await expect(page.locator('.detail-failed')).toContainText('store is locked');
  });

  test('a message that has left the log says so rather than going blank', async ({ page }) => {
    await open(page, { ...FIXTURE, details: {} });

    await page.locator('.message-row[data-message-id="n-1"]').click();
    await expect(page.locator('.detail-failed')).toContainText('no longer in the log');
  });

  test('a failed body fetch is reported as its own reason, not as a dead plan', async ({ page }) => {
    await open(page, { ...FIXTURE, bodies: { 'p-1': { __error: 'archivist port not set' } } });

    await page.locator('.message-row[data-message-id="p-1"]').click();
    const panel = page.locator('.review-panel');
    await expect(panel).toHaveAttribute('data-reason', 'command-failed');
    await expect(panel).toContainText('archivist port not set');
  });

  test('a slow fetch cannot paint over the message you moved on to', async ({ page }) => {
    // Two awaits per selection and a user who clicks faster than either. The
    // generation token drops the stale result instead of letting it land.
    await open(page, {
      ...FIXTURE,
      details: {
        ...FIXTURE.details,
        'p-1': { __delayMs: 400, value: FIXTURE.details!['p-1'] },
      },
    });

    await page.locator('.message-row[data-message-id="p-1"]').click();
    await page.locator('.message-row[data-message-id="n-1"]').click();
    await expect(page.locator('.detail-notification')).toHaveCount(1);

    // Long enough for the abandoned fetch to have resolved and, if the guard
    // were missing, repainted.
    await page.waitForTimeout(600);
    await expect(page.locator('.detail-notification')).toHaveCount(1);
    await expect(page.locator('.detail-review')).toHaveCount(0);
  });
});

test.describe('Pane 3 — staying in step with the log (spec §4.2)', () => {
  test('dismissal advances from the selected notification to the first visible row', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 800 });
    await page.addInitScript(f => {
      (window as any).__INBOX_FIXTURE = f;
    }, {
      sessions: AGENTS,
      messages: { 'all|*': list({ messages: [NOTE, QUESTION] }) },
      details: FIXTURE.details,
      bodies: FIXTURE.bodies,
    });
    await page.goto('/inbox-harness.html');
    await expect(page.locator('.filter-bar .filter')).toHaveCount(3);

    await page.locator('.message-row[data-message-id="n-1"]').click();
    await expect(page.locator('.detail-notification')).toHaveCount(1);
    await page.locator('#pane-back').click();
    await expect(page.locator('.pane-list')).toBeVisible();
    await expect(page.locator('.pane-detail')).toBeHidden();

    // The dismiss event folds the notification closed, so the active
    // `needs_you` projection no longer contains it. The remaining row is the
    // selection now; pane 3 must not keep displaying an item pane 2 cannot
    // identify as selected.
    await page.evaluate(nextList => {
      const fixture = (window as any).__INBOX_FIXTURE;
      fixture.messages['all|*'] = nextList;
      (window as any).__simulateChange();
    }, list({ messages: [QUESTION], filter: 'needs_you' }));

    await expect(page.locator('.message-row.is-selected'))
      .toHaveAttribute('data-message-id', 'q-1');
    await expect(page.locator('.detail-question')).toHaveCount(1);
    await expect(page.locator('.detail-title')).toHaveText('Which storage backend?');
    await expect(page.locator('.pane-list')).toBeVisible();
    await expect(page.locator('.pane-detail')).toBeHidden();
  });

  test('dismissal clears the reading pane when no visible row remains', async ({ page }) => {
    await page.addInitScript(f => {
      (window as any).__INBOX_FIXTURE = f;
    }, {
      sessions: AGENTS,
      messages: { 'all|*': list({ messages: [NOTE] }) },
      details: FIXTURE.details,
      bodies: FIXTURE.bodies,
    });
    await page.goto('/inbox-harness.html');
    await expect(page.locator('.filter-bar .filter')).toHaveCount(3);

    await page.locator('.message-row[data-message-id="n-1"]').click();
    await expect(page.locator('.detail-notification')).toHaveCount(1);

    await page.evaluate(emptyNeedsYou => {
      const fixture = (window as any).__INBOX_FIXTURE;
      fixture.messages['all|*'] = emptyNeedsYou;
      (window as any).__simulateChange();
    }, list({
      messages: [],
      filter: 'needs_you',
      defaultFilter: 'all',
      counts: { all: 1, needsYou: 0, answered: 1, notifications: 1 },
    }));

    await expect(page.locator('.message-row')).toHaveCount(0);
    await expect(page.locator('.detail-empty')).toContainText('Pick a message');
  });

  test('an older refresh cannot replace selection from a newer filter', async ({ page }) => {
    const dismissed = message({
      messageId: 'n-1',
      msgType: 'notification',
      title: 'Deploy finished',
      status: 'dismissed',
    });

    await page.addInitScript(f => {
      (window as any).__INBOX_FIXTURE = f;
    }, {
      sessions: AGENTS,
      messages: { 'all|*': list({ messages: [NOTE, QUESTION] }) },
      details: FIXTURE.details,
      bodies: FIXTURE.bodies,
    });
    await page.goto('/inbox-harness.html');
    await expect(page.locator('.filter-bar .filter')).toHaveCount(3);

    await page.locator('.message-row[data-message-id="n-1"]').click();
    await expect(page.locator('.detail-notification')).toHaveCount(1);

    // Hold an event-driven refresh at list_messages, then let a newer filter
    // refresh complete. Releasing the older result last must not let its stale
    // projection redraw the list or choose a replacement selection.
    await page.evaluate(({ slowList, answeredList }) => {
      const fixture = (window as any).__INBOX_FIXTURE;
      let releaseOldRefresh: (value: unknown) => void;
      fixture.messages['all|needs_you'] = new Promise(resolve => {
        releaseOldRefresh = resolve;
      });
      fixture.messages['all|answered'] = answeredList;
      (window as any).__releaseOldRefresh = () => releaseOldRefresh(slowList);
      (window as any).__simulateChange();
    }, {
      slowList: list({ messages: [QUESTION], filter: 'needs_you' }),
      answeredList: list({ messages: [dismissed], filter: 'answered' }),
    });
    await page.waitForFunction(() => {
      const calls = (window as any).__INVOCATIONS;
      return calls.some((call: any) =>
        call.cmd === 'list_messages' && call.args?.filter === 'needs_you');
    });

    await page.locator('.filter[data-filter="answered"]').click();
    await expect(page.locator('.filter[data-filter="answered"]')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.message-row')).toHaveAttribute('data-message-id', 'n-1');

    await page.evaluate(() => (window as any).__releaseOldRefresh());

    await expect(page.locator('.filter[data-filter="answered"]')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.message-row')).toHaveAttribute('data-message-id', 'n-1');
    await expect(page.locator('.message-row.is-selected')).toHaveAttribute('data-message-id', 'n-1');
  });

  test('a burst of log changes starts one refresh and one trailing refresh', async ({ page }) => {
    await page.clock.install({ time: new Date('2026-09-04T08:00:00Z') });
    await open(page, FIXTURE);
    await page.clock.pauseAt(new Date('2026-09-04T09:00:00Z'));

    await page.evaluate(() => {
      const fixture = (window as any).__INBOX_FIXTURE;
      const sessions = fixture.sessions;
      let releaseSessions: (value: unknown) => void;
      fixture.sessions = new Promise(resolve => {
        releaseSessions = resolve;
      });
      (window as any).__releaseSessions = () => releaseSessions(sessions);
      (window as any).__INVOCATIONS.length = 0;
      (window as any).__simulateChange();
    });
    await page.clock.runFor(100);

    const callsWhileBlocked = await page.evaluate(() => (window as any).__INVOCATIONS
      .filter((call: any) => call.cmd === 'list_sessions').length);
    expect(callsWhileBlocked).toBe(1);

    await page.evaluate(() => {
      for (let i = 0; i < 10; i += 1) {
        (window as any).__simulateChange();
      }
    });
    await page.clock.runFor(100);

    await page.evaluate(() => (window as any).__releaseSessions());
    await expect.poll(async () => page.evaluate(() => (window as any).__INVOCATIONS
      .filter((call: any) => call.cmd === 'list_messages').length)).toBe(1);

    expect(await page.evaluate(() => (window as any).__INVOCATIONS
      .filter((call: any) => call.cmd === 'list_sessions').length)).toBe(2);
  });

  test('an answer from another device locks the selected message in place', async ({ page }) => {
    // Task 8 re-rendered here, which showed the winning selection but threw
    // away whatever the reader had typed. Spec §9.3 rules that out in as many
    // words, so the pane is now *told* the new row instead: the header and the
    // banner change, and everything below them is left exactly where it was.
    // What the winner actually chose is one click away — reselect the message —
    // and a paragraph of half-written context is not recoverable at all.
    const answered = message({
      messageId: 'q-1',
      msgType: 'question',
      title: 'Which storage backend?',
      status: 'answered',
      responder: 'Kay9 phone',
    });

    await page.addInitScript(f => {
      (window as any).__INBOX_FIXTURE = f;
    }, {
      sessions: AGENTS,
      messages: { 'all|*': list({ messages: [NOTE, QUESTION, PLAN] }) },
      details: FIXTURE.details,
      bodies: FIXTURE.bodies,
    });
    await page.goto('/inbox-harness.html');
    await expect(page.locator('.filter-bar .filter')).toHaveCount(3);

    await page.locator('.message-row[data-message-id="q-1"]').click();
    await expect(page.locator('.detail-root')).toHaveAttribute('data-status', 'pending');
    await page.locator('.other-input').fill('Only if it survives a restart.');

    // The log moves: the question is now answered, everywhere.
    await page.evaluate(f => {
      const fixture = (window as any).__INBOX_FIXTURE;
      fixture.messages['all|*'].messages[1] = f.row;
      fixture.details['q-1'] = f.detail;
    }, {
      row: answered,
      detail: detail(answered, {
        request: { question: 'Which storage backend?', options: [{ label: 'SQLite', value: 'sqlite' }] },
        settlement: { selectedValues: ['sqlite'] },
      }),
    });
    await page.evaluate(() => (window as any).__simulateChange());

    await expect(page.locator('.detail-root')).toHaveAttribute('data-status', 'answered');
    await expect(page.locator('.detail-banner[data-banner="answered-elsewhere"] .detail-banner-title'))
      .toHaveText('Answered elsewhere');
    await expect(page.locator('.detail-responder')).toHaveText('Kay9 phone');

    // The part that matters: locked, and every word still on screen.
    await expect(page.locator('.other-input')).toHaveValue('Only if it survives a restart.');
    await expect(page.locator('.other-input')).toBeDisabled();
    await expect(page.locator('.detail-actions .button')).toHaveCount(0);
  });
});

test.describe('Pane 3 — optimistic actions', () => {
  test('bulk mark read predicts every target in one click-turn commit and one native invocation', async ({ page }) => {
    const inFlight = message({ messageId: 'n-in-flight', msgType: 'notification', title: 'single in flight' });
    const first = message({ messageId: 'n-bulk-a', msgType: 'notification', title: 'bulk first' });
    const survivor = message({ messageId: 'q-bulk-survivor', title: 'bulk survivor' });
    const last = message({ messageId: 'n-bulk-b', msgType: 'notification', title: 'bulk last' });
    const pending = list({
      messages: [inFlight, first, survivor, last],
      actionableNotificationIds: ['n-status-hidden', 'n-in-flight', 'n-bulk-a', 'n-bulk-b'],
      filter: 'needs_you',
      defaultFilter: 'needs_you',
    });
    const emptyAnswered = list({
      messages: [],
      actionableNotificationIds: pending.actionableNotificationIds,
      filter: 'answered',
      defaultFilter: 'needs_you',
      counts: pending.counts,
    });
    await open(page, {
      messages: {
        'all|null': pending,
        'all|needs_you': pending,
        'all|answered': emptyAnswered,
      },
      details: Object.fromEntries([inFlight, first, survivor, last].map(row => [
        row.messageId,
        row.msgType === 'notification'
          ? detail(row, { request: { body: `${row.title} body.` } })
          : detail(row, { request: { question: row.title, options: [{ label: 'Continue', value: 'continue' }] } }),
      ])),
    });
    await deferReply(page, 'dismiss_notification');

    await page.locator('.message-row[data-message-id="n-in-flight"]').click();
    await page.getByRole('button', { name: 'Dismiss' }).click();
    await expect(page.locator('.message-row[data-message-id="n-in-flight"]')).toHaveCount(0);

    await page.locator('.message-row[data-message-id="n-bulk-a"]').click();
    await controlReply(page, 'dismiss_notifications');
    const immediate = await page.evaluate(() => {
      const browserWindow = window as any;
      const listElement = document.getElementById('message-list')!;
      const replaceChildren = listElement.replaceChildren.bind(listElement);
      browserWindow.__LIST_COMMITS = 0;
      listElement.replaceChildren = (...nodes: (Node | string)[]) => {
        browserWindow.__LIST_COMMITS += 1;
        replaceChildren(...nodes);
      };
      (document.querySelector('.mark-all-read') as HTMLButtonElement).click();
      return {
        commits: browserWindow.__LIST_COMMITS,
        rows: [...document.querySelectorAll('.message-row')].map((row: any) => row.dataset.messageId),
        selected: (document.querySelector('.message-row.is-selected') as HTMLElement)?.dataset.messageId,
        detail: (document.querySelector('.detail-loading, .detail-root') as HTMLElement)?.dataset.messageId,
        bulkInvocations: browserWindow.__INVOCATIONS.filter((call: any) => call.cmd === 'dismiss_notifications'),
      };
    });

    expect(immediate).toEqual({
      commits: 1,
      rows: ['q-bulk-survivor'],
      selected: 'q-bulk-survivor',
      detail: 'q-bulk-survivor',
      bulkInvocations: [{
        cmd: 'dismiss_notifications',
        args: { notificationIds: ['n-status-hidden', 'n-bulk-a', 'n-bulk-b'] },
      }],
    });

    await page.locator('.filter[data-filter="answered"]').click();
    await page.locator('.filter[data-filter="needs_you"]').click();
    await expect(page.locator('.message-row')).toHaveAttribute('data-message-id', 'q-bulk-survivor');

    await page.evaluate(() => (window as any).__resolveReply([
      { status: 'dismissed', notificationId: 'n-status-hidden', responseId: 'd-hidden' },
      { status: 'dismissed', notificationId: 'n-bulk-a', responseId: 'd-a' },
      { status: 'dismissed', notificationId: 'n-bulk-b', responseId: 'd-b' },
    ]));
    const undo = page.getByRole('button', { name: 'Undo mark all read' });
    await expect(undo).toBeFocused();
    await expect(page.locator('#bulk-status')).toContainText('Marked 3 notifications read');
    expect(await replyCount(page, 'dismiss_notifications')).toBe(1);
  });

  test('rapid consecutive dismissals remain independent through authoritative settlements', async ({ page }) => {
    const first = message({ messageId: 'n-fast-a', msgType: 'notification', title: 'First fast action' });
    const second = message({ messageId: 'n-fast-b', msgType: 'notification', title: 'Second fast action' });
    const survivor = message({ messageId: 'n-fast-c', msgType: 'notification', title: 'Surviving row' });
    const pending = [first, second, survivor];
    await open(page, {
      messages: list({ messages: pending, filter: 'needs_you', defaultFilter: 'needs_you' }),
      details: Object.fromEntries(pending.map(row => [
        row.messageId,
        detail(row, { request: { body: `${row.title} body.` } }),
      ])),
    });
    await controlRepliesIndependently(page, 'dismiss_notification');

    await page.locator('.message-row[data-message-id="n-fast-a"]').click();
    await page.getByRole('button', { name: 'Dismiss' }).click();
    await expect(page.locator('.message-row[data-message-id="n-fast-a"]')).toHaveCount(0);
    await expect(page.locator('.message-row.is-selected')).toHaveAttribute('data-message-id', 'n-fast-b');
    await expect(page.locator('.detail-root')).toHaveAttribute('data-message-id', 'n-fast-b');

    await page.getByRole('button', { name: 'Dismiss' }).click();
    await expect(page.locator('.message-row[data-message-id="n-fast-b"]')).toHaveCount(0);
    await expect(page.locator('.message-row.is-selected')).toHaveAttribute('data-message-id', 'n-fast-c');
    await expect(page.locator('.detail-root')).toHaveAttribute('data-message-id', 'n-fast-c');
    await expect.poll(() => page.evaluate(() => (window as any).__CONTROLLED_REPLIES.length)).toBe(2);

    const dismissalIds = await page.evaluate(() => (window as any).__INVOCATIONS
      .filter((call: any) => call.cmd === 'dismiss_notification')
      .map((call: any) => call.args.notificationId));
    expect(dismissalIds).toEqual(['n-fast-a', 'n-fast-b']);

    const refresh = async (messages: typeof pending) => {
      const before = await replyCount(page, 'list_messages');
      await page.evaluate(nextList => {
        (window as any).__INBOX_FIXTURE.messages = nextList;
        (window as any).__simulateChange();
      }, list({ messages, filter: 'needs_you', defaultFilter: 'needs_you' }));
      await expect.poll(() => replyCount(page, 'list_messages')).toBe(before + 1);
      await expect(page.locator('.message-row[data-message-id="n-fast-a"]')).toHaveCount(0);
      await expect(page.locator('.message-row[data-message-id="n-fast-b"]')).toHaveCount(0);
      await expect(page.locator('.message-row.is-selected')).toHaveAttribute('data-message-id', 'n-fast-c');
    };

    // Both authoritative rows are still pending: neither optimistic row may flash back.
    await refresh(pending);

    // Confirm the second transaction first while the first transport is unresolved.
    await resolveControlledReply(page, 1, 'resp-fast-b');
    await refresh([first, survivor]);

    // Confirm the first transaction independently; the second must stay gone.
    await resolveControlledReply(page, 0, 'resp-fast-a');
    await refresh([survivor]);
    expect(await replyCount(page, 'dismiss_notification')).toBe(2);
  });

  test('optimistic action dismiss advances before transport settles and does not flash back', async ({ page }) => {
    await open(page, actionFixture(NOTE));
    await deferReply(page, 'dismiss_notification');

    await page.locator('.message-row[data-message-id="n-1"]').click();
    await expect(page.locator('.detail-notification')).toHaveCount(1);
    await page.getByRole('button', { name: 'Dismiss' }).click();

    await expectImmediateAdvance(page, 'n-1', 'dismiss_notification', 'q-next');
  });

  test('optimistic action question submit advances before transport settles and does not flash back', async ({ page }) => {
    await open(page, actionFixture(QUESTION));
    await deferReply(page, 'submit_answer');

    await page.locator('.message-row[data-message-id="q-1"]').click();
    await page.locator('.option[data-value="proceed"]').click();
    await page.locator('.other-input').fill('Keep this exact answer.');
    await page.getByRole('button', { name: 'Submit Response' }).click();

    await expectImmediateAdvance(page, 'q-1', 'submit_answer', 'q-next');
    await page.locator('.filter[data-filter="all"]').click();
    await expect(page.locator('.message-row[data-message-id="q-1"]')).toHaveAttribute('data-status', 'answered');
  });

  test('optimistic action question skip advances before transport settles and does not flash back', async ({ page }) => {
    await open(page, actionFixture(QUESTION));
    await deferReply(page, 'submit_answer');

    await page.locator('.message-row[data-message-id="q-1"]').click();
    await page.getByRole('button', { name: 'Skip' }).click();

    await expectImmediateAdvance(page, 'q-1', 'submit_answer', 'q-next');
    await page.locator('.filter[data-filter="all"]').click();
    await expect(page.locator('.message-row[data-message-id="q-1"]')).toHaveAttribute('data-status', 'skipped');
  });

  test('optimistic action review verdict advances before transport settles and does not flash back', async ({ page }) => {
    await open(page, actionFixture(PLAN));
    await deferReply(page, 'submit_plan_review');

    await page.locator('.message-row[data-message-id="p-1"]').click();
    await expect(page.locator('.review-root')).toHaveCount(1);
    await page.locator('[data-verdict="approved"]').click();

    await expectImmediateAdvance(page, 'p-1', 'submit_plan_review', 'q-next');
    await page.locator('.filter[data-filter="all"]').click();
    await expect(page.locator('.message-row[data-message-id="p-1"]')).toHaveAttribute('data-status', 'answered');
    await expect(page.locator('.message-row[data-message-id="p-1"] .status-pill-verdict')).toHaveText('approved');
  });

  test('optimistic action review skip advances before transport settles and does not flash back', async ({ page }) => {
    await open(page, actionFixture(PLAN));
    await deferReply(page, 'submit_plan_review');

    await page.locator('.message-row[data-message-id="p-1"]').click();
    await expect(page.locator('.review-root')).toHaveCount(1);
    await page.getByRole('button', { name: 'Skip' }).click();

    await expectImmediateAdvance(page, 'p-1', 'submit_plan_review', 'q-next');
    await page.locator('.filter[data-filter="all"]').click();
    await expect(page.locator('.message-row[data-message-id="p-1"]')).toHaveAttribute('data-status', 'skipped');
    await expect(page.locator('.message-row[data-message-id="p-1"] .status-pill-verdict')).toHaveCount(0);
  });

  test('optimistic action on the final row selects its immediate previous neighbor', async ({ page }) => {
    const previous = message({ messageId: 'q-before', title: 'Previous question' });
    const final = message({ messageId: 'n-last', msgType: 'notification', title: 'Final notification' });
    const fixture = actionFixture(final, [NEXT, previous, final]);
    fixture.details![previous.messageId] = detail(previous, {
      request: { question: previous.title, options: [{ label: 'Continue', value: 'continue' }] },
    });
    await open(page, fixture);
    await deferReply(page, 'dismiss_notification');

    await page.locator('.message-row[data-message-id="n-last"]').click();
    await page.getByRole('button', { name: 'Dismiss' }).click();

    await expectImmediateAdvance(page, 'n-last', 'dismiss_notification', 'q-before');
  });

  test('optimistic action keeps its predicted terminal row under All while advancing detail', async ({ page }) => {
    await open(page, {
      ...actionFixture(NOTE),
      messages: list({ messages: [NOTE, NEXT], filter: 'all', defaultFilter: 'all' }),
    });
    await deferReply(page, 'dismiss_notification');

    await page.locator('.message-row[data-message-id="n-1"]').click();
    await page.getByRole('button', { name: 'Dismiss' }).click();

    await expect(page.locator('.message-row[data-message-id="n-1"]')).toHaveAttribute('data-status', 'dismissed');
    await expect(page.locator('.message-row.is-selected')).toHaveCount(1);
    await expect(page.locator('.message-row.is-selected')).toHaveAttribute('data-message-id', 'q-next');
    await expect(page.locator('.detail-root')).toHaveAttribute('data-message-id', 'q-next');
    expect(await replyCount(page, 'dismiss_notification')).toBe(1);
  });
});

test.describe('Pane 3 — optimistic rollback and settlement races', () => {
  for (const outcome of ['whole', 'partial'] as const) {
    test(`bulk ${outcome} failure releases the parked notification while selection stays adjacent`, async ({ page }) => {
      const first = message({ messageId: `n-${outcome}-a`, msgType: 'notification', title: 'selected notification' });
      const second = message({ messageId: `n-${outcome}-b`, msgType: 'notification', title: 'other notification' });
      const survivor = message({ messageId: `q-${outcome}`, title: 'adjacent question' });
      const fixture = actionFixture(first, [first, second, survivor]);
      fixture.messages = list({
        messages: [first, second, survivor],
        actionableNotificationIds: [first.messageId, second.messageId],
        filter: 'all',
        defaultFilter: 'all',
      });
      fixture.details[second.messageId] = detail(second, { request: { body: 'Other body.' } });
      fixture.details[survivor.messageId] = detail(survivor, {
        request: { question: survivor.title, options: [{ label: 'Continue', value: 'continue' }] },
      });
      await open(page, fixture);
      await controlReply(page, 'dismiss_notifications');

      await page.locator(`.message-row[data-message-id="${first.messageId}"]`).click();
      await page.evaluate(() => {
        (window as any).__BULK_FAILED_PANE = document.querySelector('.detail-root');
      });
      await page.getByRole('button', { name: 'Mark all read (2)' }).click();
      await expect(page.locator('.message-row.is-selected')).toHaveAttribute('data-message-id', survivor.messageId);

      if (outcome === 'whole') {
        await rejectReply(page, 'whole batch failed');
      } else {
        await page.evaluate(({ failed, succeeded }) => (window as any).__resolveReply([
          { status: 'failed', notificationId: failed, error: 'one item failed' },
          { status: 'dismissed', notificationId: succeeded, responseId: 'dismissal-success' },
        ]), { failed: first.messageId, succeeded: second.messageId });
      }

      // Do not consume the parked entry before the result. The neighboring
      // pane must remain selected while failure cleanup releases it.
      await expect(page.locator('.message-row.is-selected')).toHaveAttribute('data-message-id', survivor.messageId);
      await page.locator('#action-error-dialog').getByRole('button', { name: 'Close' }).click();
      await page.locator(`.message-row[data-message-id="${first.messageId}"]`).click();
      expect(await page.evaluate(() =>
        document.querySelector('.detail-root') !== (window as any).__BULK_FAILED_PANE)).toBe(true);
    });
  }

  test('bulk partial outcomes keep authority, refresh attribution, and retry only exact Undo pairs', async ({ page }) => {
    const first = message({ messageId: 'n-partial-a', msgType: 'notification', title: 'first notification' });
    const settledElsewhere = message({ messageId: 'n-partial-b', msgType: 'notification', title: 'second notification' });
    const missing = message({ messageId: 'n-partial-c', msgType: 'notification', title: 'third notification' });
    const survivor = message({ messageId: 'q-partial', title: 'surviving question' });
    const rows = [first, settledElsewhere, missing, survivor];
    const details = Object.fromEntries(rows.map(row => [
      row.messageId,
      row.msgType === 'notification'
        ? detail(row, { request: { body: `${row.title} body.` } })
        : detail(row, { request: { question: row.title, options: [{ label: 'Continue', value: 'continue' }] } }),
    ]));
    await open(page, {
      messages: list({
        messages: rows,
        actionableNotificationIds: [first.messageId, settledElsewhere.messageId, missing.messageId],
        filter: 'all',
        defaultFilter: 'all',
      }),
      details,
    });
    await controlReply(page, 'dismiss_notifications');

    await page.locator('.message-row[data-message-id="n-partial-a"]').click();
    await page.getByRole('button', { name: 'Mark all read (3)' }).click();
    await page.locator('.message-row[data-message-id="n-partial-a"]').click();

    const dismissedA = message({
      ...first,
      status: 'dismissed',
      responder: 'This device',
      respondedAt: first.createdAt + 1,
      responseId: 'd-partial-a',
    });
    const dismissedB = message({
      ...settledElsewhere,
      status: 'dismissed',
      responder: 'Another device',
      respondedAt: settledElsewhere.createdAt + 1,
      responseId: 'd-other-b',
    });
    await page.evaluate(authoritative => {
      const fixture = (window as any).__INBOX_FIXTURE;
      fixture.messages = authoritative.list;
      fixture.details['n-partial-a'] = authoritative.detailA;
      fixture.details['n-partial-b'] = authoritative.detailB;
      (window as any).__simulateChange();
    }, {
      list: list({
        messages: [dismissedA, dismissedB, missing, survivor],
        actionableNotificationIds: [missing.messageId],
        filter: 'all',
        defaultFilter: 'all',
      }),
      detailA: detail(dismissedA, { request: { body: 'first notification body.' }, settlement: {} }),
      detailB: detail(dismissedB, { request: { body: 'second notification body.' }, settlement: {} }),
    });
    await expect(page.locator('.detail-banner')).toContainText('Dismissed elsewhere');

    await page.evaluate(() => (window as any).__resolveReply([
      { status: 'dismissed', notificationId: 'n-partial-a', responseId: 'd-partial-a' },
      { status: 'failed', notificationId: 'n-partial-b', error: 'ntfy said <b>offline</b>' },
    ]));

    expect(await page.locator('.message-row').evaluateAll(rows =>
      rows.map((row: any) => row.dataset.messageId))).toEqual([
      'n-partial-a', 'n-partial-b', 'n-partial-c', 'q-partial',
    ]);
    await expect(page.locator('.message-row[data-message-id="n-partial-b"]'))
      .toHaveAttribute('data-status', 'dismissed');
    await expect(page.locator('.detail-banner')).toHaveCount(0);
    const dialog = page.locator('#action-error-dialog');
    await expect(dialog.getByRole('heading')).toHaveText('Some notifications weren’t marked read');
    await expect(dialog.getByRole('alert')).toHaveText(
      'Marked 1 of 3 notifications read. 2 remain unread. ntfy said <b>offline</b>',
    );
    await expect(dialog.locator('b')).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Close' }).click();

    await controlReply(page, 'restore_notifications');
    await page.getByRole('button', { name: 'Undo mark all read' }).click();
    expect(await page.evaluate(() => (window as any).__INVOCATIONS
      .filter((call: any) => call.cmd === 'restore_notifications').pop().args)).toEqual({
      restorations: [{ notificationId: 'n-partial-a', dismissalId: 'd-partial-a' }],
    });
    await page.evaluate(() => (window as any).__resolveReply([
      {
        status: 'failed',
        notificationId: 'n-partial-a',
        dismissalId: 'd-partial-a',
        error: 'restore <i>offline</i>',
      },
    ]));

    await expect(dialog.getByRole('heading')).toHaveText('Some notifications weren’t marked unread');
    await expect(dialog.getByRole('alert')).toHaveText(
      'Marked 0 of 1 notifications unread. 1 remain read. restore <i>offline</i>',
    );
    await expect(dialog.locator('i')).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(page.getByRole('button', { name: 'Undo mark all read' })).toBeVisible();
  });

  test('rollback restores a rejected Dismiss and focuses its row when the dialog closes', async ({ page }) => {
    await open(page, actionFixture(NOTE));
    await controlReply(page, 'dismiss_notification');

    await page.locator('.message-row[data-message-id="n-1"]').click();
    await page.getByRole('button', { name: 'Dismiss' }).click();
    await expect(page.locator('.message-row[data-message-id="n-1"]')).toHaveCount(0);

    await rejectReply(page, 'ntfy said <strong>offline</strong>');

    await expect(page.locator('.message-row[data-message-id="n-1"]')).toHaveCount(1);
    const dialog = page.locator('#action-error-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('heading')).toHaveText('Could not send');
    await expect(dialog.getByRole('alert')).toContainText('Dismiss');
    await expect(dialog.getByRole('alert')).toContainText('ntfy said <strong>offline</strong>');
    await expect(dialog.locator('strong')).toHaveCount(0);

    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(dialog).toBeHidden();
    await expect.poll(() => page.evaluate(() =>
      (document.activeElement as HTMLElement)?.dataset.messageId)).toBe('n-1');
  });

  test('rollback restores a rejected question Submit with its exact live fields', async ({ page }) => {
    await open(page, actionFixture(QUESTION));
    await controlReply(page, 'submit_answer');

    await page.locator('.message-row[data-message-id="q-1"]').click();
    await page.locator('.option[data-value="proceed"]').click();
    await page.locator('.other-input').fill('Keep spacing & <literal> text exactly.');
    await page.getByRole('button', { name: 'Submit Response' }).click();
    await expect(page.locator('.message-row[data-message-id="q-1"]')).toHaveCount(0);

    await rejectReply(page, 'answer transport rejected');

    await expect(page.locator('.message-row[data-message-id="q-1"]')).toHaveCount(1);
    await expect(page.locator('#action-error-dialog')).toBeVisible();
    await page.getByRole('button', { name: 'Close' }).click();
    await page.locator('.message-row[data-message-id="q-1"]').click();
    await expect(page.locator('.option[data-value="proceed"] input')).toBeChecked();
    await expect(page.locator('.other-input')).toHaveValue('Keep spacing & <literal> text exactly.');
    await expect(page.locator('.detail-error')).toContainText('answer transport rejected');
  });

  test('rollback restores a rejected plan review with feedback and inline comments', async ({ page }) => {
    await open(page, actionFixture(PLAN));
    await controlReply(page, 'submit_plan_review');

    await page.locator('.message-row[data-message-id="p-1"]').click();
    await expect(page.locator('.review-root')).toHaveCount(1);
    await page.locator('#overall-feedback').fill('Keep the rollback paragraph exactly.');
    await page.getByRole('tab', { name: 'Source' }).click();
    await page.locator('.diff-row[data-line]').first().click();
    await page.locator('#comment-input').fill('Keep this anchored comment.');
    await page.locator('#comment-add').click();
    await page.evaluate(() => {
      (window as any).__ROLLBACK_REVIEW_NODE = document.querySelector('.detail-root');
    });
    await page.locator('[data-verdict="changes_requested"]').click();
    await expect(page.locator('.message-row[data-message-id="p-1"]')).toHaveCount(0);

    await rejectReply(page, 'review publish failed');

    await expect(page.locator('.message-row[data-message-id="p-1"]')).toHaveCount(1);
    await expect(page.locator('.message-row.is-selected')).toHaveAttribute('data-message-id', 'p-1');
    expect(await page.evaluate(() =>
      document.querySelector('.detail-root') === (window as any).__ROLLBACK_REVIEW_NODE)).toBe(true);
    await expect(page.locator('#overall-feedback')).toHaveValue('Keep the rollback paragraph exactly.');
    await expect(page.locator('#action-error-dialog')).toBeVisible();
    await page.getByRole('button', { name: 'Close' }).click();
    await expect(page.locator('.comment-card-list .comment-card-body')).toHaveText('Keep this anchored comment.');
    await expect(page.locator('#review-error')).toContainText('review publish failed');
  });

  test('authoritative settlement before a local rejection is never rolled back', async ({ page }) => {
    await open(page, actionFixture(NOTE));
    await controlReply(page, 'dismiss_notification');

    await page.locator('.message-row[data-message-id="n-1"]').click();
    await page.getByRole('button', { name: 'Dismiss' }).click();
    await expect(page.locator('.message-row[data-message-id="n-1"]')).toHaveCount(0);

    const listCalls = await replyCount(page, 'list_messages');
    await page.evaluate(nextList => {
      (window as any).__INBOX_FIXTURE.messages = nextList;
      (window as any).__simulateChange();
    }, list({ messages: [NEXT], filter: 'needs_you', defaultFilter: 'needs_you' }));
    await expect.poll(() => replyCount(page, 'list_messages')).toBe(listCalls + 1);

    await rejectReply(page, 'late local rejection');

    await expect(page.locator('.message-row[data-message-id="n-1"]')).toHaveCount(0);
    await expect(page.locator('#action-error-dialog')).toBeHidden();
    await expect(page.locator('.message-row.is-selected')).toHaveAttribute('data-message-id', 'q-next');
  });

  test('authoritative confirmation updates a reopened predicted row under All', async ({ page }) => {
    const dismissed = message({
      ...NOTE,
      status: 'dismissed',
      responder: 'Kay9 laptop',
      responseId: 'dismiss-response',
    });
    await open(page, {
      ...actionFixture(NOTE),
      messages: list({ messages: [NOTE, NEXT], filter: 'all', defaultFilter: 'all' }),
    });
    await controlReply(page, 'dismiss_notification');

    await page.locator('.message-row[data-message-id="n-1"]').click();
    await page.getByRole('button', { name: 'Dismiss' }).click();
    await expect(page.locator('.message-row[data-message-id="n-1"]')).toHaveAttribute('data-status', 'dismissed');

    await page.locator('.message-row[data-message-id="n-1"]').click();
    await expect(page.locator('.detail-root')).toHaveAttribute('data-status', 'pending');

    const listCalls = await replyCount(page, 'list_messages');
    await page.evaluate(authoritative => {
      const fixture = (window as any).__INBOX_FIXTURE;
      fixture.messages = authoritative.list;
      fixture.details['n-1'] = authoritative.detail;
      (window as any).__simulateChange();
    }, {
      list: list({ messages: [dismissed, NEXT], filter: 'all', defaultFilter: 'all' }),
      detail: detail(dismissed, { request: { body: 'Action required.' } }),
    });
    await expect.poll(() => replyCount(page, 'list_messages')).toBe(listCalls + 1);

    await expect(page.locator('.detail-root')).toHaveAttribute('data-status', 'dismissed');
    await expect(page.getByRole('button', { name: 'Mark unread' })).toBeEnabled();
    await expect(page.locator('.detail-retained')).toContainText('Dismissed everywhere');
  });

  test('rollback survives a row omitted only by an explicit status refresh', async ({ page }) => {
    const fixture = actionFixture(NOTE);
    fixture.messages = {
      'all|*': fixture.messages,
      'all|answered': list({ messages: [], filter: 'answered', defaultFilter: 'needs_you' }),
    };
    await open(page, fixture);
    await controlReply(page, 'dismiss_notification');

    await page.locator('.message-row[data-message-id="n-1"]').click();
    await page.getByRole('button', { name: 'Dismiss' }).click();
    await page.locator('.filter[data-filter="answered"]').click();
    await expect(page.locator('.filter[data-filter="answered"]')).toHaveAttribute('aria-selected', 'true');

    await rejectReply(page, 'rejected after changing filters');

    await expect(page.locator('#action-error-dialog')).toBeVisible();
    await expect(page.locator('#action-error-dialog').getByRole('alert'))
      .toContainText('rejected after changing filters');
    await expect(page.locator('.message-row[data-message-id="n-1"]')).toHaveCount(0);
  });

  test('off-filter rollback releases a live question pane and restores its data-only draft', async ({ page }) => {
    const questionFixture = actionFixture(QUESTION);
    questionFixture.messages = {
      'all|null': questionFixture.messages,
      'all|answered': list({ messages: [], filter: 'answered', defaultFilter: 'needs_you' }),
      'all|needs_you': questionFixture.messages,
    };
    await open(page, questionFixture);
    await controlReply(page, 'submit_answer');
    await page.locator('.message-row[data-message-id="q-1"]').click();
    await page.locator('.option[data-value="proceed"]').click();
    await page.locator('.other-input').fill('recover question text');
    await page.getByRole('button', { name: 'Submit Response' }).click();
    await page.locator('.filter[data-filter="answered"]').click();
    await rejectReply(page, 'off-filter question failure');
    await page.locator('#action-error-dialog').getByRole('button', { name: 'Close' }).click();
    await page.locator('.filter[data-filter="needs_you"]').click();
    await page.locator('.message-row[data-message-id="q-1"]').click();
    await expect(page.locator('.option[data-value="proceed"] input')).toBeChecked();
    await expect(page.locator('.other-input')).toHaveValue('recover question text');

  });

  test('a repeated off-filter rollback restores a half-typed rendered review composer', async ({ page }) => {
    const fixture = actionFixture(PLAN);
    fixture.messages = {
      'all|null': fixture.messages,
      'all|answered': list({ messages: [], filter: 'answered', defaultFilter: 'needs_you' }),
      'all|needs_you': fixture.messages,
    };
    await open(page, fixture);
    await controlReply(page, 'submit_plan_review');
    await page.locator('.message-row[data-message-id="p-1"]').click();
    await page.locator('#overall-feedback').fill('recover overall review text');
    await page.evaluate(() => {
      const block = document.querySelector('#rendered-content [data-source-side="new"][data-source-start]');
      if (!block) throw new Error('Rendered selection block missing');
      const range = document.createRange();
      range.selectNodeContents(block);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      block.closest('#rendered-content')?.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    });
    await page.locator('#comment-rendered-selection').click();
    await page.locator('#comment-input').fill('recover half-typed composer');
    await page.locator('[data-verdict="approved"]').click();
    await page.locator('.filter[data-filter="answered"]').click();
    await rejectReply(page, 'off-filter review failure');

    expect(await reviewDocumentListenerProbe(page)).toEqual({
      ctrlKeyReads: 1,
      defaultPrevented: false,
      scheduledFrames: 0,
    });
    await page.locator('#action-error-dialog').getByRole('button', { name: 'Close' }).click();
    await page.locator('.filter[data-filter="needs_you"]').click();
    await page.locator('.message-row[data-message-id="p-1"]').click();
    await expect(page.locator('#overall-feedback')).toHaveValue('recover overall review text');
    await expect(page.locator('#comment-input')).toHaveValue('recover half-typed composer');
  });

  for (const result of [
    { status: 'lost', responseId: 'resp-review', reason: 'agent restarted' },
    { status: 'unacknowledged', responseId: 'resp-review', reason: 'ack timed out' },
  ]) {
    test(`rollback restores a review after ${result.status} without a transport modal`, async ({ page }) => {
      await open(page, actionFixture(PLAN));
      await page.evaluate(replyResult => {
        (window as any).__REPLIES = { submit_plan_review: replyResult };
      }, result);

      await page.locator('.message-row[data-message-id="p-1"]').click();
      await page.locator('#overall-feedback').fill(`Draft kept after ${result.status}.`);
      await page.locator('[data-verdict="approved"]').click();

      await expect(page.locator('.message-row[data-message-id="p-1"]')).toHaveCount(1);
      await expect(page.locator('#action-error-dialog')).toBeHidden();
      await page.locator('.message-row[data-message-id="p-1"]').click();
      await expect(page.locator('#overall-feedback')).toHaveValue(`Draft kept after ${result.status}.`);
      await expect(page.locator('#review-error')).toContainText(result.status === 'lost'
        ? 'never received your review'
        : 'has not confirmed it');
    });
  }

  test('a terminal event before an unacknowledged review result keeps and restores the exact draft', async ({ page }) => {
    await open(page, actionFixture(PLAN));
    await controlReply(page, 'submit_plan_review');
    await page.locator('.message-row[data-message-id="p-1"]').click();
    await page.locator('#overall-feedback').fill('Draft survives event-before-result.');
    await page.evaluate(() => {
      (window as any).__RACE_REVIEW_NODE = document.querySelector('.detail-root');
    });
    await page.locator('[data-verdict="approved"]').click();

    const settled = message({ ...PLAN, status: 'answered', responder: 'Another device', responseId: 'other-response' });
    await page.evaluate(authoritative => {
      (window as any).__INBOX_FIXTURE.messages = authoritative;
      (window as any).__simulateChange();
    }, list({ messages: [settled, NEXT], filter: 'needs_you', defaultFilter: 'needs_you' }));
    await page.evaluate(() => (window as any).__resolveReply({
      status: 'unacknowledged', responseId: 'local-response', reason: 'ack timed out',
    }));

    await expect(page.locator('.message-row.is-selected')).toHaveAttribute('data-message-id', 'p-1');
    expect(await page.evaluate(() =>
      document.querySelector('.detail-root') === (window as any).__RACE_REVIEW_NODE)).toBe(true);
    await expect(page.locator('#overall-feedback')).toHaveValue('Draft survives event-before-result.');
  });

  test('validation failures leave their rows selected and never open the send-failure dialog', async ({ page }) => {
    await open(page, FIXTURE);

    await page.locator('.message-row[data-message-id="q-1"]').click();
    await page.getByRole('button', { name: 'Submit Response' }).click();
    await expect(page.locator('.message-row[data-message-id="q-1"]')).toHaveCount(1);
    await expect(page.locator('.message-row.is-selected')).toHaveAttribute('data-message-id', 'q-1');
    await expect(page.locator('.detail-error')).toContainText('Please select at least one option');
    await expect(page.locator('#action-error-dialog')).toBeHidden();
    expect(await replyCount(page, 'submit_answer')).toBe(0);

    await page.locator('.message-row[data-message-id="p-1"]').click();
    await page.locator('[data-verdict="changes_requested"]').click();
    await expect(page.locator('.message-row[data-message-id="p-1"]')).toHaveCount(1);
    await expect(page.locator('.message-row.is-selected')).toHaveAttribute('data-message-id', 'p-1');
    await expect(page.locator('#review-error')).toContainText('needs a reason');
    await expect(page.locator('#action-error-dialog')).toBeHidden();
    expect(await replyCount(page, 'submit_plan_review')).toBe(0);
  });
});
