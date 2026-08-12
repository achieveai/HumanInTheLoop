import { test, expect, type Page } from '@playwright/test';

// Covers review.html + review-app.js — the seam between the pure renderer and
// the Tauri command surface. The commands and events stubbed here are the exact
// shape this lane codes against; if the Rust side lands different names, this
// spec is where the rename shows up.

type InvokeStub = { payload: unknown; failSubmit?: boolean; submitResult?: unknown };

async function stubTauri(page: Page, opts: InvokeStub) {
  await page.addInitScript((o: InvokeStub) => {
    const w = window as any;
    w.__calls = [];
    w.__listeners = {};
    w.__emit = (name: string, payload: unknown) => (w.__listeners[name] || []).forEach((h: any) => h({ payload }));
    w.__TAURI__ = {
      core: {
        invoke: (cmd: string, args: unknown) => {
          w.__calls.push({ cmd, args });
          if (cmd === 'take_window_payload') {
            if (o.payload === null) return Promise.reject(new Error('no payload for this window'));
            return Promise.resolve(JSON.stringify(o.payload));
          }
          if (cmd === 'submit_plan_review') {
            if (o.failSubmit) return Promise.reject(new Error('ntfy publish failed'));
            return Promise.resolve(o.submitResult ?? { status: 'received', responseId: 'r1', reason: null });
          }
          return Promise.resolve();
        },
      },
      event: {
        listen: (name: string, handler: unknown) => {
          (w.__listeners[name] = w.__listeners[name] || []).push(handler);
          return Promise.resolve(() => {});
        },
      },
      window: { getCurrentWindow: () => ({ close: () => { w.__windowClosed = true; } }) },
    };
  }, opts);
}

function samplePlan(overrides: Record<string, unknown> = {}) {
  const lines = ['# Plan', '', 'Step one.', 'Step two.', 'Step three.'];
  return {
    type: 'plan_review',
    messageId: 'rev-1',
    protocolVersion: 2,
    repo: { name: 'Hitl_MCP', branch: 'main' },
    context: 'why',
    summary: '',
    displayPath: 'docs/plan.md',
    planId: 'plan-1',
    revision: 1,
    isNewPlan: true,
    snapshotHash: 'sha256:abc',
    body: {
      content: lines.join('\n'),
      diff: ['--- plan.md', '+++ plan.md', `@@ -1,${lines.length} +1,${lines.length} @@`,
             ...lines.map(l => ` ${l}`)].join('\n'),
    },
    _error: null,
    _wasEncrypted: false,
    _device: 'ThisBox',
    ...overrides,
  };
}

test.describe('review.html shell', () => {
  test('C-10: the payload comes from take_window_payload, not the URL', async ({ page }) => {
    await stubTauri(page, { payload: samplePlan() });
    await page.goto('/review.html');

    await expect(page.locator('#review-pane-diff')).toBeVisible();
    await expect(page.locator('.review-path')).toHaveText('docs/plan.md');
    expect(page.url()).not.toContain('Step one');

    const calls = await page.evaluate(() => (window as any).__calls.map((c: any) => c.cmd));
    expect(calls).toContain('take_window_payload');
    // E-10: shown without activation once the content is painted.
    expect(calls).toContain('show_no_activate');
  });

  test('a submit reaches submit_plan_review with the anchor payload', async ({ page }) => {
    await stubTauri(page, { payload: samplePlan() });
    await page.goto('/review.html');

    await page.locator('.diff-row[data-side="new"][data-line="3"]').click();
    await page.locator('#comment-input').fill('this step is wrong');
    await page.locator('#comment-add').click();
    await page.locator('#btn-request-changes').click();

    await expect(page.locator('.success-title')).toHaveText('Changes requested');
    const call = await page.evaluate(() =>
      (window as any).__calls.find((c: any) => c.cmd === 'submit_plan_review'));
    expect(call.args).toMatchObject({
      reviewId: 'rev-1',
      snapshotHash: 'sha256:abc',
      verdict: 'changes_requested',
      overallFeedback: '',
    });
    expect(call.args.inlineComments).toEqual([
      { path: 'docs/plan.md', startLine: 3, endLine: 3, side: 'new', comment: 'this step is wrong' },
    ]);
  });

  test('C-12: an ack of "lost" is treated as a failed submit, not a success', async ({ page }) => {
    await stubTauri(page, { payload: samplePlan(), submitResult: { status: 'lost', reason: 'response attachment expired' } });
    await page.goto('/review.html');

    await page.locator('#overall-feedback').fill('needs work');
    await page.locator('#btn-reject').click();

    await expect(page.locator('.success-title')).toHaveCount(0);
    await expect(page.locator('#review-error')).toContainText('response attachment expired');
    await expect(page.locator('#overall-feedback')).toHaveValue('needs work');
  });

  test('encrypted is taken from _wasEncrypted, not the URL', async ({ page }) => {
    await stubTauri(page, { payload: samplePlan({ _wasEncrypted: true }) });
    await page.goto('/review.html');

    await page.locator('#btn-approve').click();
    const call = await page.evaluate(() =>
      (window as any).__calls.find((c: any) => c.cmd === 'submit_plan_review'));
    expect(call.args.encrypted).toBe(true);
  });

  test('C-6: a rejected submit_plan_review keeps the window open with the draft', async ({ page }) => {
    await stubTauri(page, { payload: samplePlan(), failSubmit: true });
    await page.goto('/review.html');

    await page.locator('.diff-row[data-side="new"][data-line="4"]').click();
    await page.locator('#comment-input').fill('keep me');
    await page.locator('#comment-add').click();
    await page.locator('#btn-approve').click();

    await expect(page.locator('#review-error')).toContainText('Submit failed');
    await expect(page.locator('.comment-card-list .comment-card-body')).toHaveText('keep me');
    expect(await page.evaluate(() => (window as any).__windowClosed)).toBeUndefined();
  });

  test('D-6: review-superseded shows the winning device and does not close the window', async ({ page }) => {
    await stubTauri(page, { payload: samplePlan() });
    await page.goto('/review.html');

    await page.locator('.diff-row[data-side="new"][data-line="3"]').click();
    await page.locator('#comment-input').fill('draft survives');
    await page.locator('#comment-add').click();

    await page.evaluate(() => (window as any).__emit('review-superseded', { reviewId: 'rev-1', respondedFrom: 'Kay9' }));

    await expect(page.locator('[data-banner="superseded"]')).toContainText('Kay9');
    await expect(page.locator('.comment-card-list .comment-card-body')).toHaveText('draft survives');
    expect(await page.evaluate(() => (window as any).__windowClosed)).toBeUndefined();
  });

  test('D-3: review-cancelled shows "agent exited" and keeps the typed comments', async ({ page }) => {
    await stubTauri(page, { payload: samplePlan() });
    await page.goto('/review.html');

    await page.locator('.diff-row[data-side="new"][data-line="3"]').click();
    await page.locator('#comment-input').fill('unsent');
    await page.locator('#comment-add').click();
    await page.evaluate(() => (window as any).__emit('review-cancelled', { reviewId: 'rev-1', reason: 'agent_exited' }));

    await expect(page.locator('[data-banner="cancelled"]')).toContainText('agent exited');
    // The comments stay on screen — that, not a persistence command, is what
    // D-3 requires, and there is no save_review_draft command in the client.
    await expect(page.locator('.comment-card-list .comment-card-body')).toHaveText('unsent');
    expect(await page.evaluate(() => (window as any).__windowClosed)).toBeUndefined();
  });

  test('C-4: an expired payload renders the expired panel', async ({ page }) => {
    await stubTauri(page, {
      payload: samplePlan({ body: null, _error: { kind: 'expired', message: 'attachment gone' } }),
    });
    await page.goto('/review.html');
    await expect(page.locator('.review-panel[data-state="expired"]')).toBeVisible();
  });

  test('a hash mismatch refuses visibly and renders no plan', async ({ page }) => {
    await stubTauri(page, {
      payload: samplePlan({ body: null, _error: { kind: 'hash_mismatch', message: 'sha256 differs' } }),
    });
    await page.goto('/review.html');

    await expect(page.locator('.review-panel[data-state="hash_mismatch"]')).toBeVisible();
    // Nothing approvable, and no plan text shown at all.
    await expect(page.locator('#btn-approve')).toHaveCount(0);
    await expect(page.locator('#review-pane-diff')).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText('Step one.');
  });

  test('A-7: a protocolVersion newer than this client shows have-X / need-Y', async ({ page }) => {
    await stubTauri(page, { payload: samplePlan({ protocolVersion: 3 }) });
    await page.goto('/review.html');

    await expect(page.locator('.review-panel[data-state="upgrade-required"]')).toBeVisible();
    await expect(page.locator('.review-panel-detail')).toContainText('version 3');
    await expect(page.locator('.review-panel-detail')).toContainText('version 2');
    // Checked before the body, because a newer wire format is exactly when our
    // parsing cannot be trusted.
    await expect(page.locator('#review-pane-diff')).toHaveCount(0);
  });

  test('a failed take_window_payload explains itself rather than leaving a blank window', async ({ page }) => {
    await stubTauri(page, { payload: null });
    await page.goto('/review.html');

    await expect(page.locator('.review-panel[data-state="error"]')).toBeVisible();
    await expect(page.locator('.review-panel-detail')).toContainText('no payload for this window');
  });
});
