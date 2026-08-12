import { test, expect, type Page } from '@playwright/test';

// The review window develops entirely against review-harness.html, which mocks
// window.__TAURI__ and supplies static fixtures. No live message, no running
// Rust client.

const url = (query = '') => `/review-harness.html${query}`;

function row(page: Page, line: number, side: 'old' | 'new' = 'new') {
  return page.locator(`.diff-row[data-side="${side}"][data-line="${line}"]`);
}

async function addComment(page: Page, start: number, end: number, text: string, side: 'old' | 'new' = 'new') {
  await row(page, start, side).click();
  await row(page, end, side).click({ modifiers: ['Shift'] });
  await page.locator('#comment-input').fill(text);
  await page.locator('#comment-add').click();
}

// ─── Layout ──────────────────────────────────────────────────────────────────

test.describe('Review window layout', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(url());
  });

  test('renders both panes and the comment sidebar', async ({ page }) => {
    await expect(page.locator('#review-pane-diff')).toBeVisible();
    await expect(page.locator('#review-pane-rendered')).toBeVisible();
    await expect(page.locator('.review-comments')).toBeVisible();
    // Rendered pane is read-only markdown, not raw source.
    await expect(page.locator('#rendered-content h1')).toHaveText('Implementation plan');
  });

  test('E-12: the footer sits below the panes and does not overlap them', async ({ page }) => {
    const body = await page.locator('.review-body').boundingBox();
    const footer = await page.locator('.review-footer').boundingBox();
    expect(body).not.toBeNull();
    expect(footer).not.toBeNull();
    expect(footer!.y).toBeGreaterThanOrEqual(body!.y + body!.height - 1);
  });

  test('F-9: only the repo-relative display path is shown', async ({ page }) => {
    await expect(page.locator('.review-path')).toHaveText('docs/plan-v1.md');
  });

  test('line numbers come from the diff hunk header, not DOM order', async ({ page }) => {
    // The fixture removes one line at old-side 20; new-side numbering is
    // unaffected by it, which is only true if the parser tracks both counters.
    await expect(row(page, 20, 'old')).toHaveCount(1);
    await expect(row(page, 20, 'old').locator('.diff-text'))
      .toHaveText('This paragraph was removed in this revision.');
    await expect(row(page, 10, 'new')).toHaveClass(/diff-row-add/);
  });
});

// ─── Range selection and comments ────────────────────────────────────────────

test.describe('Range selection and comments', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(url());
  });

  test('E-2: click line 42, shift-click 47, comment, submit — anchor round-trips', async ({ page }) => {
    await addComment(page, 42, 47, 'This section contradicts section 2.');
    await page.locator('#btn-approve').click();

    const payload = await page.evaluate(() => (window as any).__lastSubmit);
    expect(payload.verdict).toBe('approved');
    expect(payload.inlineComments).toHaveLength(1);
    expect(payload.inlineComments[0]).toMatchObject({
      path: 'docs/plan-v1.md',
      startLine: 42,
      endLine: 47,
      side: 'new',
      comment: 'This section contradicts section 2.',
    });
  });

  test('shift-clicking upwards produces the same normalised anchor', async ({ page }) => {
    await addComment(page, 47, 42, 'Selected bottom-up.');
    await page.locator('#btn-approve').click();

    const payload = await page.evaluate(() => (window as any).__lastSubmit);
    expect(payload.inlineComments[0]).toMatchObject({ startLine: 42, endLine: 47, side: 'new' });
  });

  test('J-2: remove a comment, then re-select the same range', async ({ page }) => {
    await addComment(page, 42, 47, 'first');
    await expect(page.locator('.comment-card-list')).toHaveCount(1);

    await page.locator('.comment-card-list .comment-remove').click();
    await expect(page.locator('.comment-card-list')).toHaveCount(0);
    await expect(page.locator('.comment-card-inline')).toHaveCount(0);

    await addComment(page, 42, 47, 'second');
    await expect(page.locator('.comment-card-list')).toHaveCount(1);
    await expect(page.locator('.comment-card-list .comment-card-body')).toHaveText('second');
  });

  test('E-6: a comment is visible inline at its anchor and in the list', async ({ page }) => {
    await addComment(page, 42, 47, 'inline and listed');
    await expect(page.locator('.comment-card-inline')).toHaveCount(1);
    await expect(page.locator('.comment-card-list')).toHaveCount(1);
    await expect(page.locator('#comment-count')).toHaveText('1');
  });

  test('E-7: two comments on the same anchor are both shown', async ({ page }) => {
    await addComment(page, 42, 47, 'first concern');
    await addComment(page, 42, 47, 'second concern');

    await expect(page.locator('.comment-card-inline')).toHaveCount(2);
    await expect(page.locator('.comment-card-list')).toHaveCount(2);
    const bodies = await page.locator('.comment-card-inline .comment-card-body').allTextContents();
    expect(bodies).toEqual(['first concern', 'second concern']);
  });

  test('a comment can anchor to a removed line on the old side', async ({ page }) => {
    await addComment(page, 20, 20, 'why was this dropped?', 'old');
    await page.locator('#btn-approve').click();

    const payload = await page.evaluate(() => (window as any).__lastSubmit);
    expect(payload.inlineComments[0]).toMatchObject({ startLine: 20, endLine: 20, side: 'old' });
  });

  test('an empty comment is refused rather than silently dropped', async ({ page }) => {
    await row(page, 42).click();
    await page.locator('#comment-add').click();
    await expect(page.locator('#review-error')).toBeVisible();
    await expect(page.locator('.comment-card-list')).toHaveCount(0);
  });

  test('I-1: shift+arrow keyboard selection produces the same anchor as shift-click', async ({ page }) => {
    await row(page, 42).click();
    for (let i = 0; i < 5; i++) await page.keyboard.press('Shift+ArrowDown');

    await page.locator('#comment-input').fill('keyboard selected');
    await page.locator('#comment-add').click();
    await page.locator('#btn-approve').click();

    const payload = await page.evaluate(() => (window as any).__lastSubmit);
    expect(payload.inlineComments[0]).toMatchObject({ startLine: 42, endLine: 47, side: 'new' });
  });

  test('I-1: Enter on a focused line opens the composer for that line', async ({ page }) => {
    await row(page, 30).click();
    await page.keyboard.press('Escape');
    await expect(page.locator('#comment-composer')).toHaveCount(0);

    await row(page, 30).focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#comment-composer .composer-anchor')).toHaveText('Commenting on line 30');
    await expect(page.locator('#comment-input')).toBeFocused();
  });

  test('half-typed comment text survives extending the selection', async ({ page }) => {
    await row(page, 42).click();
    await page.locator('#comment-input').fill('half typed');
    await row(page, 45).click({ modifiers: ['Shift'] });

    await expect(page.locator('#comment-input')).toHaveValue('half typed');
    await expect(page.locator('#comment-composer .composer-anchor')).toHaveText('Commenting on lines 42–45');
  });

  test('I-3: every line in the range is linked to the comment via aria-describedby', async ({ page }) => {
    await addComment(page, 42, 47, 'accessible');
    const commentId = await page.locator('.comment-card-inline').getAttribute('id');
    expect(commentId).toMatch(/^comment-/);

    for (const line of [42, 44, 47]) {
      await expect(row(page, line)).toHaveAttribute('aria-describedby', new RegExp(commentId!));
    }
    // A line outside the range is not described by it.
    await expect(row(page, 41)).not.toHaveAttribute('aria-describedby', new RegExp(commentId!));
  });

  test('I-2: find-in-page locates and highlights a match', async ({ page }) => {
    await page.locator('#review-find-input').fill('bullet item on line 42');
    await expect(page.locator('.diff-row.is-find-current')).toHaveAttribute('data-line', '42');
    await expect(page.locator('#review-find-count')).toHaveText('1/1');
  });
});

// ─── Verdict and validation ──────────────────────────────────────────────────

test.describe('Verdict and validation', () => {
  test('E-8: all three verdict buttons are present in the footer', async ({ page }) => {
    await page.goto(url());
    const footer = page.locator('.review-footer');
    await expect(footer.locator('#btn-approve')).toBeVisible();
    await expect(footer.locator('#btn-request-changes')).toBeVisible();
    await expect(footer.locator('#btn-reject')).toBeVisible();
  });

  test('A-5: changes_requested with no feedback and no comments is blocked', async ({ page }) => {
    await page.goto(url());
    await page.locator('#btn-request-changes').click();

    await expect(page.locator('#review-error')).toBeVisible();
    await expect(page.locator('#review-error')).toContainText('needs a reason');
    const payload = await page.evaluate(() => (window as any).__lastSubmit);
    expect(payload).toBeUndefined();
  });

  test('A-5: reject with overall feedback only is allowed', async ({ page }) => {
    await page.goto(url());
    await page.locator('#overall-feedback').fill('Wrong approach entirely.');
    await page.locator('#btn-reject').click();

    const payload = await page.evaluate(() => (window as any).__lastSubmit);
    expect(payload.verdict).toBe('rejected');
    expect(payload.overallFeedback).toBe('Wrong approach entirely.');
  });

  test('A-5: changes_requested with an inline comment only is allowed', async ({ page }) => {
    await page.goto(url());
    await addComment(page, 42, 42, 'this line is wrong');
    await page.locator('#btn-request-changes').click();

    const payload = await page.evaluate(() => (window as any).__lastSubmit);
    expect(payload.verdict).toBe('changes_requested');
    expect(payload.overallFeedback).toBe('');
  });

  test('approve with nothing at all is allowed', async ({ page }) => {
    await page.goto(url());
    await page.locator('#btn-approve').click();

    const payload = await page.evaluate(() => (window as any).__lastSubmit);
    expect(payload).toMatchObject({ verdict: 'approved', overallFeedback: '', inlineComments: [] });
    await expect(page.locator('.success-title')).toHaveText('Plan approved');
  });

  test('comments are submitted in a stable order regardless of entry order', async ({ page }) => {
    await page.goto(url());
    await addComment(page, 47, 47, 'later line');
    await addComment(page, 12, 12, 'earlier line');
    await page.locator('#btn-approve').click();

    const payload = await page.evaluate(() => (window as any).__lastSubmit);
    expect(payload.inlineComments.map((c: any) => c.startLine)).toEqual([12, 47]);
  });

  test('skip submits a skipped verdict', async ({ page }) => {
    await page.goto(url());
    await page.locator('#btn-skip').click();
    expect(await page.evaluate(() => (window as any).__lastSkip)).toBe(true);
    await expect(page.locator('.success-title')).toHaveText('Review skipped');
  });
});

// ─── Submit failure (C-6 / P3) ───────────────────────────────────────────────

test.describe('Submit failure keeps the review intact', () => {
  test('C-6: a failed submit shows an error, keeps the window open, preserves comments', async ({ page }) => {
    await page.goto(url('?fail=1'));
    await addComment(page, 42, 47, 'do not lose me');
    await page.locator('#overall-feedback').fill('typed feedback');

    await page.locator('#btn-approve').click();

    await expect(page.locator('#review-error')).toBeVisible();
    await expect(page.locator('#review-error')).toContainText('Submit failed');
    // No success screen, and every typed thing survives.
    await expect(page.locator('.success-title')).toHaveCount(0);
    await expect(page.locator('.comment-card-list .comment-card-body')).toHaveText('do not lose me');
    await expect(page.locator('#overall-feedback')).toHaveValue('typed feedback');
    // Controls are usable again so the human can retry.
    await expect(page.locator('#btn-approve')).toBeEnabled();
  });

  test('C-6: a failed skip is reported too', async ({ page }) => {
    await page.goto(url('?fail=1'));
    await page.locator('#btn-skip').click();
    await expect(page.locator('#review-error')).toContainText('Skip failed');
    await expect(page.locator('.success-title')).toHaveCount(0);
  });
});

// ─── Post-first-paint states ─────────────────────────────────────────────────

test.describe('Review states', () => {
  test('D-5/D-6: superseded shows the winning device and never destroys the draft', async ({ page }) => {
    await page.goto(url());
    await addComment(page, 42, 47, 'my draft comment');

    await page.evaluate(() => (window as any).__simulateSuperseded('Kay9'));

    await expect(page.locator('[data-banner="superseded"]')).toContainText('Already reviewed on Kay9');
    // Window stays on the review, draft intact, verdict controls disabled.
    await expect(page.locator('.comment-card-list .comment-card-body')).toHaveText('my draft comment');
    await expect(page.locator('#btn-approve')).toBeDisabled();
    await expect(page.locator('.success-title')).toHaveCount(0);
  });

  test('D-3: agent exited shows a banner and keeps the typed comments', async ({ page }) => {
    await page.goto(url());
    await addComment(page, 42, 47, 'unsent comment');

    await page.evaluate(() => (window as any).__simulateCancelled('agent_exited'));

    await expect(page.locator('[data-banner="cancelled"]')).toContainText('agent exited');
    await expect(page.locator('.comment-card-list .comment-card-body')).toHaveText('unsent comment');
    await expect(page.locator('#btn-approve')).toBeDisabled();

    const draft = await page.evaluate(() => (window as any).__lastDraft);
    expect(draft.inlineComments[0]).toMatchObject({ startLine: 42, endLine: 47 });
  });

  test('C-12: a submit that comes back "lost" re-offers the draft rather than claiming success', async ({ page }) => {
    await page.goto(url('?status=lost'));
    await addComment(page, 42, 42, 'still here');
    await page.locator('#btn-approve').click();

    // submit_plan_review resolved — but the agent will never read the response,
    // so this is a failure wearing a success's clothes.
    await expect(page.locator('.success-title')).toHaveCount(0);
    await expect(page.locator('#review-error')).toContainText('response attachment expired');
    await expect(page.locator('#review-error')).toHaveAttribute('data-tone', 'error');
    await expect(page.locator('#btn-approve')).toBeEnabled();
    await expect(page.locator('.comment-card-list .comment-card-body')).toHaveText('still here');
  });

  test('a submit that comes back "unacknowledged" keeps everything and says so', async ({ page }) => {
    await page.goto(url('?status=unacknowledged'));
    await addComment(page, 42, 42, 'unconfirmed');
    await page.locator('#overall-feedback').fill('some feedback');
    await page.locator('#btn-approve').click();

    // Published but unconfirmed is neither success nor failure — and warning
    // tone matters, because colouring it red trains people to ignore red.
    await expect(page.locator('.success-title')).toHaveCount(0);
    await expect(page.locator('#review-error')).toContainText('has not confirmed');
    await expect(page.locator('#review-error')).toHaveAttribute('data-tone', 'warning');
    await expect(page.locator('#overall-feedback')).toHaveValue('some feedback');
    await expect(page.locator('.comment-card-list .comment-card-body')).toHaveText('unconfirmed');
    await expect(page.locator('#btn-approve')).toBeEnabled();
  });

  test('a submit that comes back "received" is the only one that shows success', async ({ page }) => {
    await page.goto(url());
    await page.locator('#btn-approve').click();
    await expect(page.locator('.success-title')).toHaveText('Plan approved');
  });

  test('C-4: an expired plan gets a first-class panel, not a blank window', async ({ page }) => {
    await page.goto(url('?state=expired'));
    await expect(page.locator('.review-panel[data-state="expired"]')).toBeVisible();
    await expect(page.locator('.review-panel-title')).toHaveText('Plan expired');
    await expect(page.locator('.review-panel-detail')).toContainText('ask the agent to resend');
  });

  // The rest of the _error.kind contract. A plan we cannot vouch for is never
  // rendered — approving the wrong bytes is the failure this feature prevents.
  for (const [kind, title] of [
    ['hash_mismatch', 'Plan does not match its hash'],
    ['decrypt', 'Could not decrypt the plan'],
    ['corrupt', 'Plan is unreadable'],
    ['missing', 'Plan content is missing'],
    ['unavailable', 'Could not fetch the plan'],
  ]) {
    test(`_error.kind "${kind}" refuses visibly and shows no plan`, async ({ page }) => {
      await page.goto(url(`?state=${kind}`));
      await expect(page.locator(`.review-panel[data-state="${kind}"]`)).toBeVisible();
      await expect(page.locator('.review-panel-title')).toHaveText(title);
      await expect(page.locator('#review-pane-diff')).toHaveCount(0);
      await expect(page.locator('#btn-approve')).toHaveCount(0);
    });
  }

  test('A-7: a too-new protocol version shows have-X / need-Y', async ({ page }) => {
    await page.goto(url('?state=upgrade-required&have=2&need=3'));
    await expect(page.locator('.review-panel[data-state="upgrade-required"]')).toBeVisible();
    await expect(page.locator('.review-panel-title')).toHaveText('Needs a newer HITL client');
    await expect(page.locator('.review-panel-detail')).toContainText('version 3');
    await expect(page.locator('.review-panel-detail')).toContainText('version 2');
  });
});

// ─── Performance (E-13 / E-14, measured not mandated) ────────────────────────

test.describe('Naive re-render cost on a 100 KB plan', () => {
  test('E-14: adding and removing a comment stays responsive', async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto(url('?fixture=large'));

    // The measurement is only worth anything if the plan really is 100 KB.
    const size = await page.evaluate(() => (window as any).__fixture.body.content.length);
    expect(size).toBeGreaterThanOrEqual(100 * 1024);

    const initial = await page.evaluate(() => (window as any).__reviewPerf);
    await addComment(page, 500, 520, 'a comment in the middle of a large plan');
    const afterAdd = await page.evaluate(() => (window as any).__reviewPerf);
    await page.locator('.comment-card-list .comment-remove').click();
    const afterRemove = await page.evaluate(() => (window as any).__reviewPerf);

    console.log(`[W3.6] contentBytes=${size} rows=${initial.rowCount} `
      + `markdownParse=${initial.markdownRenderMs.toFixed(1)}ms `
      + `initialDiffRender=${initial.initialRenderMs.toFixed(1)}ms `
      + `add=${afterAdd.lastCommentUpdateMs.toFixed(1)}ms `
      + `remove=${afterRemove.lastCommentUpdateMs.toFixed(1)}ms`);

    // The gate cut the overlay *mandate* and asked for a measured outcome. This
    // bound is the point at which the naive full re-render would need replacing
    // with a line-keyed overlay; the printed numbers are the actual result.
    expect(afterAdd.lastCommentUpdateMs).toBeLessThan(300);
    expect(afterRemove.lastCommentUpdateMs).toBeLessThan(300);
  });

  test('E-14: the re-render does not degrade as comments accumulate', async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto(url('?fixture=large'));

    const samples: number[] = [];
    for (let i = 0; i < 20; i++) {
      const line = 100 + i * 10;
      await addComment(page, line, line + 2, `comment ${i}`);
      samples.push(await page.evaluate(() => (window as any).__reviewPerf.lastCommentUpdateMs));
    }
    console.log(`[W3.6] 20 comments on a 100 KB plan: first=${samples[0].toFixed(1)}ms `
      + `last=${samples[19].toFixed(1)}ms max=${Math.max(...samples).toFixed(1)}ms`);

    await expect(page.locator('.comment-card-list')).toHaveCount(20);
    expect(Math.max(...samples)).toBeLessThan(300);
  });
});
