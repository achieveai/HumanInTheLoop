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
  await expect(page.locator('.filter-bar .filter')).toHaveCount(4);
}

async function commands(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as any).__INVOCATIONS.map((i: any) => i.cmd));
}

const NOTE = message({ messageId: 'n-1', msgType: 'notification', title: 'Deploy finished' });
const QUESTION = message({ messageId: 'q-1', msgType: 'question', title: 'Which storage backend?' });
const PLAN = message({ messageId: 'p-1', msgType: 'plan_review', title: 'docs/plans/inbox.md', contentHash: 'abc123' });

const FIXTURE: Fixture = {
  messages: list({ messages: [NOTE, QUESTION, PLAN] }),
  details: {
    'n-1': detail(NOTE, { request: { body: 'All green.' } }),
    'q-1': detail(QUESTION, { request: { question: 'Which storage backend?', allowOther: true, options: [{ label: 'SQLite', value: 'sqlite' }] } }),
    'p-1': detail(PLAN, { request: { snapshotHash: 'abc123', displayPath: 'docs/plans/inbox.md', revision: 1, isNewPlan: true } }),
  },
  bodies: { 'p-1': bodyOk('# Plan\n\nOne step.\n') },
};

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
    await expect(page.locator('.filter-bar .filter')).toHaveCount(4);

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
