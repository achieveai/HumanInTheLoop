import { test, expect, type Page } from '@playwright/test';

// Covers review.html + review-app.js — the seam between the pure renderer and
// the Tauri command surface. The commands and events stubbed here are the exact
// shape this lane codes against; if the Rust side lands different names, this
// spec is where the rename shows up.

type InvokeStub = {
  payload: unknown;
  failSubmit?: boolean;
  submitResult?: unknown;
  failDraftSave?: boolean;
  failDraftClear?: boolean;
  failOpenExternal?: boolean;
};

async function stubTauri(page: Page, opts: InvokeStub) {
  // A stage id per stubTauri call. addInitScript re-runs on every load, so
  // without this the stub would re-fabricate the payload on reload and a
  // reload test would pass even against a read-once store — proving nothing.
  // Keyed instead, sessionStorage survives the reload the way PayloadStore
  // survives it, and a later stubTauri call stages a genuinely new payload.
  const stageId = `stage-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await page.addInitScript((o: InvokeStub & { __stageId: string }) => {
    const w = window as any;
    const KEY = `__payloadStore:${o.__stageId}`;
    const READS = `__payloadReads:${o.__stageId}`;
    // Separate from KEY and never cleared: staging must happen once per window,
    // not once per load. Guarding on KEY alone would refill the store on every
    // reload, which silently re-creates the read-once bug's escape hatch and
    // makes the reload test pass against a consuming store.
    const STAGED = `__payloadStaged:${o.__stageId}`;
    w.__calls = [];
    w.__listeners = {};
    w.__emit = (name: string, payload: unknown) => (w.__listeners[name] || []).forEach((h: any) => h({ payload }));
    // Staged once, before the window exists — exactly like payload_store::put.
    if (o.payload !== null && sessionStorage.getItem(STAGED) === null) {
      sessionStorage.setItem(STAGED, '1');
      sessionStorage.setItem(KEY, JSON.stringify(o.payload));
    }
    w.__payloadReads = () => Number(sessionStorage.getItem(READS) || '0');
    w.__TAURI__ = {
      core: {
        invoke: (cmd: string, args: unknown) => {
          w.__calls.push({ cmd, args });
          if (cmd === 'take_window_payload') {
            const staged = sessionStorage.getItem(KEY);
            if (staged === null) return Promise.reject(new Error('no payload for this window'));
            // Non-consuming: the entry stays for the window's lifetime.
            sessionStorage.setItem(READS, String(Number(sessionStorage.getItem(READS) || '0') + 1));
            return Promise.resolve(staged);
          }
          if (cmd === 'submit_plan_review') {
            if (o.failSubmit) return Promise.reject(new Error('ntfy publish failed'));
            return Promise.resolve(o.submitResult ?? { status: 'received', responseId: 'r1', reason: null });
          }
          if (cmd === 'save_review_draft' && o.failDraftSave) {
            return Promise.reject(new Error('disk full'));
          }
          if (cmd === 'clear_review_draft' && o.failDraftClear) {
            return Promise.reject(new Error('draft file locked'));
          }
          if (cmd === 'open_external' && o.failOpenExternal) {
            return Promise.reject(new Error('no handler registered'));
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
  }, { ...opts, __stageId: stageId });
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

async function openSource(page: Page) {
  await page.getByRole('tab', { name: 'Source' }).click();
}

test.describe('review.html shell', () => {
  test('C-10: the payload comes from take_window_payload, not the URL', async ({ page }) => {
    await stubTauri(page, { payload: samplePlan() });
    await page.goto('/review.html');

    await expect(page.locator('#review-pane-diff')).toBeHidden();
    await expect(page.getByRole('tab', { name: 'Changes' })).toHaveAttribute('aria-selected', 'true');
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

    await openSource(page);
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

    await openSource(page);
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

    await openSource(page);
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

    await openSource(page);
    await page.locator('.diff-row[data-side="new"][data-line="3"]').click();
    await page.locator('#comment-input').fill('unsent');
    await page.locator('#comment-add').click();
    await page.evaluate(() => (window as any).__emit('review-cancelled', { reviewId: 'rev-1', reason: 'agent_exited' }));

    await expect(page.locator('[data-banner="cancelled"]')).toContainText('agent exited');
    await expect(page.locator('[data-banner="cancelled"]')).toContainText('saved as a draft');
    await expect(page.locator('.comment-card-list .comment-card-body')).toHaveText('unsent');
    expect(await page.evaluate(() => (window as any).__windowClosed)).toBeUndefined();

    const draftCall = await page.evaluate(() =>
      (window as any).__calls.filter((c: any) => c.cmd === 'save_review_draft').pop());
    expect(draftCall.args.draft.inlineComments[0]).toMatchObject({ startLine: 3, endLine: 3 });
  });

  test('a failed draft save stops the banner promising the draft was saved', async ({ page }) => {
    await stubTauri(page, { payload: samplePlan(), failDraftSave: true });
    await page.goto('/review.html');

    await openSource(page);
    await page.locator('.diff-row[data-side="new"][data-line="3"]').click();
    await page.locator('#comment-input').fill('unsent');
    await page.locator('#comment-add').click();
    await expect
      .poll(() => page.evaluate(() => (window as any).__calls.some((c: any) => c.cmd === 'save_review_draft')))
      .toBe(true);

    await page.evaluate(() => (window as any).__emit('review-cancelled', { reviewId: 'rev-1', reason: 'agent_exited' }));

    // Telling someone their work is saved when it is not is how they close the
    // window and lose it.
    await expect(page.locator('[data-banner="cancelled"]')).toContainText('could not be saved');
    await expect(page.locator('[data-banner="cancelled"]')).not.toContainText('have been saved as a draft');
    await expect(page.locator('.comment-card-list .comment-card-body')).toHaveText('unsent');
  });

  test('a remote image hands off to open_external', async ({ page }) => {
    const lines = ['# Plan', '', '![pixel](https://attacker.example/pixel.png)'];
    await stubTauri(page, {
      payload: samplePlan({
        body: {
          content: lines.join('\n'),
          diff: ['--- plan.md', '+++ plan.md', `@@ -1,${lines.length} +1,${lines.length} @@`,
                 ...lines.map(l => ` ${l}`)].join('\n'),
        },
      }),
    });
    await page.goto('/review.html');

    await page.locator('#rendered-content .md-image-placeholder').click();
    const call = await page.evaluate(() =>
      (window as any).__calls.find((c: any) => c.cmd === 'open_external'));
    expect(call.args).toEqual({ url: 'https://attacker.example/pixel.png' });
  });

  test('a failed open_external falls back to loading in place, not a dead click', async ({ page }) => {
    const lines = ['# Plan', '', '![pixel](https://attacker.example/pixel.png)'];
    await page.route('**://attacker.example/**', route => route.abort());
    await stubTauri(page, {
      failOpenExternal: true,
      payload: samplePlan({
        body: {
          content: lines.join('\n'),
          diff: ['--- plan.md', '+++ plan.md', `@@ -1,${lines.length} +1,${lines.length} @@`,
                 ...lines.map(l => ` ${l}`)].join('\n'),
        },
      }),
    });
    await page.goto('/review.html');

    await page.locator('#rendered-content .md-image-placeholder').click();
    // The load is blocked, so the URL surfaces as text — never silently nothing.
    await expect(page.locator('.md-image-blocked')).toContainText('https://attacker.example/pixel.png');
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

  test('the plan survives a reload', async ({ page }) => {
    // The payload used to be consumed on first read, so a refresh, a devtools
    // reload or a WebView2 renderer crash left the window permanently on the
    // error panel with the plan already gone. On master the payload was in the
    // URL and a reload recovered by itself.
    //
    // Scope, so this is not read as more than it is: this covers the frontend
    // half — that review-app.js re-requests on every load and renders what it
    // gets. That the *store* is non-consuming is Rust's, and is unit-tested in
    // payload_store.rs. The stub models a store rather than re-fabricating the
    // payload, so this fails if the frontend stops re-requesting.
    await stubTauri(page, { payload: samplePlan() });
    await page.goto('/review.html');
    await expect(page.locator('.review-path')).toHaveText('docs/plan.md');
    expect(await page.evaluate(() => (window as any).__payloadReads())).toBe(1);

    await page.reload();

    await expect(page.locator('#review-pane-diff')).toBeHidden();
    await expect(page.locator('.review-path')).toHaveText('docs/plan.md');
    await expect(page.locator('.review-panel[data-state="error"]')).toHaveCount(0);
    // The second read is the whole point: it happened, and it returned content.
    expect(await page.evaluate(() => (window as any).__payloadReads())).toBe(2);

    // Still fully usable, not just rendered.
    await openSource(page);
    await page.locator('.diff-row[data-side="new"][data-line="3"]').click();
    await page.locator('#comment-input').fill('works after a reload');
    await page.locator('#comment-add').click();
    await page.locator('#btn-approve').click();
    await expect(page.locator('.success-title')).toHaveText('Plan approved');
  });
});

// ─── Draft persistence ───────────────────────────────────────────────────────

const savedDraft = {
  reviewId: 'rev-1',
  planId: 'plan-1',
  snapshotHash: 'sha256:abc',
  overallFeedback: 'picking this up again',
  inlineComments: [
    { path: 'docs/plan.md', startLine: 4, endLine: 4, side: 'new', comment: 'from yesterday' },
  ],
  savedAt: 1786543402123,
};

test.describe('Draft restore and clear', () => {
  test('_draft is restored into the feedback box and the comment list', async ({ page }) => {
    await stubTauri(page, { payload: samplePlan({ _draft: savedDraft }) });
    await page.goto('/review.html');

    await expect(page.locator('#overall-feedback')).toHaveValue('picking this up again');
    await expect(page.locator('.comment-card-list .comment-card-body')).toHaveText('from yesterday');
    // And it goes back out on submit, anchored where it was.
    await page.locator('#btn-approve').click();
    const call = await page.evaluate(() =>
      (window as any).__calls.find((c: any) => c.cmd === 'submit_plan_review'));
    expect(call.args.inlineComments).toEqual([
      { path: 'docs/plan.md', startLine: 4, endLine: 4, side: 'new', comment: 'from yesterday' },
    ]);
  });

  test('a null _draft restores nothing and shows no notice', async ({ page }) => {
    await stubTauri(page, { payload: samplePlan({ _draft: null }) });
    await page.goto('/review.html');

    await expect(page.locator('#overall-feedback')).toHaveValue('');
    await expect(page.locator('.comment-card-list')).toHaveCount(0);
    await expect(page.locator('#review-error')).toBeHidden();
  });

  test('a changed plan restores prose but says why the comments are gone', async ({ page }) => {
    // Rust drops inlineComments when the snapshot hash moved: line anchors
    // against changed content would point at different text.
    await stubTauri(page, {
      payload: samplePlan({
        snapshotHash: 'sha256:NEW',
        _draft: { ...savedDraft, snapshotHash: 'sha256:abc', inlineComments: [] },
      }),
    });
    await page.goto('/review.html');

    await expect(page.locator('#overall-feedback')).toHaveValue('picking this up again');
    await expect(page.locator('.comment-card-list')).toHaveCount(0);
    // Vanishing without explanation reads as a bug and costs trust in the draft.
    await expect(page.locator('#review-error')).toContainText('The plan changed');
    await expect(page.locator('#review-error')).toHaveAttribute('data-tone', 'warning');
  });

  test('clear_review_draft fires on a received submit, keyed by plan and review', async ({ page }) => {
    await stubTauri(page, { payload: samplePlan({ _draft: savedDraft }) });
    await page.goto('/review.html');

    await page.locator('#btn-approve').click();
    await expect(page.locator('.success-title')).toBeVisible();

    const call = await page.evaluate(() =>
      (window as any).__calls.find((c: any) => c.cmd === 'clear_review_draft'));
    expect(call.args).toEqual({ planId: 'plan-1', reviewId: 'rev-1' });
  });

  // The one that deletes someone's work if it goes wrong: on 'lost' and
  // 'unacknowledged' the persisted draft is the only surviving copy.
  for (const status of ['lost', 'unacknowledged']) {
    test(`clear_review_draft never fires on "${status}"`, async ({ page }) => {
      await stubTauri(page, {
        payload: samplePlan({ _draft: savedDraft }),
        submitResult: { status, responseId: 'r1', reason: 'no ack' },
      });
      await page.goto('/review.html');

      await page.locator('#btn-approve').click();
      await expect(page.locator('#review-error')).toBeVisible();
      await expect(page.locator('.success-title')).toHaveCount(0);

      const cleared = await page.evaluate(() =>
        (window as any).__calls.some((c: any) => c.cmd === 'clear_review_draft'));
      expect(cleared).toBe(false);
      // The work is still on screen as well as on disk.
      await expect(page.locator('.comment-card-list .comment-card-body')).toHaveText('from yesterday');
    });
  }

  test('clear_review_draft never fires when the publish itself failed', async ({ page }) => {
    await stubTauri(page, { payload: samplePlan({ _draft: savedDraft }), failSubmit: true });
    await page.goto('/review.html');

    await page.locator('#btn-approve').click();
    await expect(page.locator('#review-error')).toContainText('Submit failed');

    const cleared = await page.evaluate(() =>
      (window as any).__calls.some((c: any) => c.cmd === 'clear_review_draft'));
    expect(cleared).toBe(false);
  });

  test('a failed clear is reported on the success screen, not swallowed', async ({ page }) => {
    await stubTauri(page, { payload: samplePlan({ _draft: savedDraft }), failDraftClear: true });
    await page.goto('/review.html');

    await page.locator('#btn-approve').click();

    // The review did land, so this is a note under the success screen rather
    // than an error — but it is said out loud.
    await expect(page.locator('.success-title')).toHaveText('Plan approved');
    await expect(page.locator('.success-note')).toContainText('could not be cleared');
  });

  test('a draft written by one window is restored by the next, unchanged', async ({ page }) => {
    // The real round trip. The two ends are separate code paths — currentDraft()
    // writes and restoreDraft() reads — so injecting a hand-written fixture
    // would not catch the two drifting apart. This feeds the actual saved
    // object back in.
    await stubTauri(page, { payload: samplePlan() });
    await page.goto('/review.html');

    await page.locator('#overall-feedback').fill('half-finished thought');
    await openSource(page);
    await page.locator('.diff-row[data-side="new"][data-line="3"]').click();
    await page.locator('#comment-input').fill('come back to this');
    await page.locator('#comment-add').click();

    const written = await page.evaluate(() =>
      (window as any).__calls.filter((c: any) => c.cmd === 'save_review_draft').pop().args.draft);
    expect(written.inlineComments).toEqual([
      { path: 'docs/plan.md', startLine: 3, endLine: 3, side: 'new', comment: 'come back to this' },
    ]);

    // Close the window and open a new one carrying exactly what was saved.
    await stubTauri(page, { payload: samplePlan({ _draft: written }) });
    await page.goto('/review.html');

    await expect(page.locator('#overall-feedback')).toHaveValue('half-finished thought');
    await expect(page.locator('.comment-card-list .comment-card-body')).toHaveText('come back to this');
    // Same hash, so nothing was dropped and there is nothing to warn about.
    await expect(page.locator('#review-error')).toBeHidden();
    // And the anchor still points where it did.
    await openSource(page);
    await expect(page.locator('.diff-row[data-side="new"][data-line="3"]'))
      .toHaveAttribute('aria-describedby', /comment-/);
  });
});
