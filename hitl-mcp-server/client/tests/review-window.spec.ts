import { test, expect, type Page } from '@playwright/test';

// The review window develops entirely against review-harness.html, which mocks
// window.__TAURI__ and supplies static fixtures. No live message, no running
// Rust client.

const url = (query = '') => `/review-harness.html${query}`;

function row(page: Page, line: number, side: 'old' | 'new' = 'new') {
  return page.locator(`.diff-row[data-side="${side}"][data-line="${line}"]`);
}

async function addComment(page: Page, start: number, end: number, text: string, side: 'old' | 'new' = 'new') {
  const sourceTab = page.getByRole('tab', { name: 'Source' });
  if (await sourceTab.getAttribute('aria-selected') !== 'true') await sourceTab.click();
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

  test('renders the default formatted view, Source fallback, and comment sidebar', async ({ page }) => {
    await expect(page.locator('#review-pane-diff')).toBeHidden();
    await expect(page.locator('#review-pane-rendered')).toBeVisible();
    await expect(page.locator('.review-comments')).toBeVisible();
    // Rendered pane is read-only markdown, not raw source.
    await expect(page.locator('#rendered-content h1')).toHaveText('Implementation plan');
  });

  test('empty comment guidance offers both rendered text and Source lines', async ({ page }) => {
    await expect(page.locator('.comment-empty')).toContainText('Select text in the rendered plan');
    await expect(page.locator('.comment-empty')).toContainText('click lines in Source');
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
    await page.getByRole('tab', { name: 'Source' }).click();
    // The fixture removes one line at old-side 20; new-side numbering is
    // unaffected by it, which is only true if the parser tracks both counters.
    await expect(row(page, 20, 'old')).toHaveCount(1);
    await expect(row(page, 20, 'old').locator('.diff-text'))
      .toHaveText('This paragraph was removed in this revision.');
    await expect(row(page, 10, 'new')).toHaveClass(/diff-row-add/);
  });
});

test.describe('Formatted review modes', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(url());
  });

  test('defaults to one formatted Changes flow and exposes one labelled view switcher', async ({ page }) => {
    const tabs = page.getByRole('tablist', { name: 'Review view' });
    await expect(tabs.getByRole('tab')).toHaveText(['Changes', 'Before & after', 'Source']);
    await expect(tabs.getByRole('tab', { name: 'Changes' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#review-pane-rendered')).toBeVisible();
    await expect(page.locator('#review-pane-before-after')).toBeHidden();
    await expect(page.locator('#review-pane-diff')).toBeHidden();
    await expect(page.locator('.review-comments')).toBeVisible();
    await expect(page.locator('#rendered-content h1')).toHaveText('Implementation plan');
  });

  test('Changes keeps complete mapped blocks and labels removals and additions without color alone', async ({ page }) => {
    const removed = page.locator('#rendered-content .formatted-change-removed');
    const added = page.locator('#rendered-content .formatted-change-added');
    await expect(removed).not.toHaveCount(0);
    await expect(added).not.toHaveCount(0);
    await expect(removed.first().locator('.formatted-change-label')).toHaveText('Removed');
    await expect(added.first().locator('.formatted-change-label')).toHaveText('Added');
    await expect(removed.first().locator('[data-source-side="old"]')).not.toHaveCount(0);
    await expect(added.first().locator('[data-source-side="new"]')).not.toHaveCount(0);
    await expect(removed.first().locator(':scope > p, :scope > h1, :scope > h2, :scope > ul, :scope > ol, :scope > table, :scope > pre'))
      .not.toHaveCount(0);
  });

  test('tab keyboard navigation switches panels without destroying Source rows', async ({ page }) => {
    const changes = page.getByRole('tab', { name: 'Changes' });
    const beforeAfter = page.getByRole('tab', { name: 'Before & after' });
    const source = page.getByRole('tab', { name: 'Source' });

    await changes.focus();
    await page.keyboard.press('ArrowRight');
    await expect(beforeAfter).toBeFocused();
    await expect(beforeAfter).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#review-pane-before-after')).toBeVisible();

    await page.keyboard.press('End');
    await expect(source).toBeFocused();
    await expect(source).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#review-pane-diff')).toBeVisible();
    await expect(page.locator('.diff-row[data-line]')).not.toHaveCount(0);

    await page.keyboard.press('Home');
    await expect(changes).toBeFocused();
    await expect(page.locator('#review-pane-rendered')).toBeVisible();
  });

  test('old and new formatted selections keep their source side in submitted comments', async ({ page }) => {
    const selectBlock = async (selector: string) => {
      await page.evaluate((selector) => {
        const block = document.querySelector(selector)!;
        const range = document.createRange();
        range.selectNodeContents(block);
        const selection = window.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);
        block.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
      }, selector);
      await page.locator('#comment-rendered-selection').click();
    };

    await selectBlock('#rendered-content .formatted-change-removed [data-source-side="old"]');
    await page.locator('#comment-input').fill('removed concern');
    await page.locator('#comment-add').click();
    await selectBlock('#rendered-content .formatted-change-added [data-source-side="new"]');
    await page.locator('#comment-input').fill('added concern');
    await page.locator('#comment-add').click();
    await page.locator('#btn-approve').click();

    const payload = await page.evaluate(() => (window as any).__lastSubmit);
    expect(payload.inlineComments.map((comment: any) => comment.side).sort()).toEqual(['new', 'old']);
  });

  test('switching views preserves half-typed comment and overall feedback', async ({ page }) => {
    await page.evaluate(() => {
      const block = document.querySelector('#rendered-content .formatted-change-added [data-source-side="new"]')!;
      const range = document.createRange();
      range.selectNodeContents(block);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      block.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    });
    await page.locator('#comment-rendered-selection').click();
    await page.locator('#comment-input').fill('half typed');
    await page.locator('#overall-feedback').fill('overall draft');

    await page.getByRole('tab', { name: 'Source' }).click();
    await page.getByRole('tab', { name: 'Changes' }).click();
    await expect(page.locator('#comment-input')).toHaveValue('half typed');
    await expect(page.locator('#overall-feedback')).toHaveValue('overall draft');
    await expect(page.getByRole('tab', { name: 'Changes' })).toHaveAttribute('aria-selected', 'true');
  });

  test('find follows the active formatted or Source view', async ({ page }) => {
    await page.locator('#review-find-input').fill('This paragraph was removed in this revision.');
    await expect(page.locator('#rendered-content .is-find-current')).toBeVisible();
    await expect(page.locator('#review-find-count')).toHaveText('1/1');

    await page.getByRole('tab', { name: 'Source' }).click();
    await expect(page.locator('#review-pane-diff .is-find-current')).toBeVisible();
    await expect(page.locator('#review-find-count')).toHaveText('1/1');
  });

  test('Before & after renders complete independently mapped old and new documents', async ({ page }) => {
    await page.getByRole('tab', { name: 'Before & after' }).click();
    const before = page.locator('#before-content');
    const after = page.locator('#after-content');
    await expect(before.locator('h1')).toHaveText('Implementation plan');
    await expect(after.locator('h1')).toHaveText('Implementation plan');
    await expect(before).toContainText('This paragraph was removed in this revision.');
    await expect(after).not.toContainText('This paragraph was removed in this revision.');
    await expect(before.locator('[data-source-side="old"]')).not.toHaveCount(0);
    await expect(after.locator('[data-source-side="new"]')).not.toHaveCount(0);
  });

  test('comments stay anchored when Before & after is materialized lazily', async ({ page }) => {
    await page.evaluate(() => {
      const block = document.querySelector('#rendered-content .formatted-change-removed [data-source-side="old"]')!;
      const range = document.createRange();
      range.selectNodeContents(block);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      block.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    });
    await page.locator('#comment-rendered-selection').click();
    await page.locator('#comment-input').fill('old block concern');
    await page.locator('#comment-add').click();

    await page.getByRole('tab', { name: 'Before & after' }).click();
    const anchored = page.locator('#before-content .has-comment[data-source-side="old"]').first();
    await expect(anchored).toHaveClass(/has-comment/);
    await expect(anchored).toHaveAttribute('aria-describedby', /comment-/);
  });

  test('narrow Before & after shows one labelled side at a time', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 800 });
    await page.reload();
    await page.getByRole('tab', { name: 'Before & after' }).click();
    const sides = page.getByRole('group', { name: 'Comparison side' });
    await expect(sides.getByRole('button')).toHaveText(['Before', 'After']);
    await expect(page.locator('.before-after-side[aria-label="Before"]')).toBeVisible();
    await expect(page.locator('.before-after-side[aria-label="After"]')).toBeHidden();
    await sides.getByRole('button', { name: 'After' }).click();
    await expect(page.locator('.before-after-side[aria-label="Before"]')).toBeHidden();
    await expect(page.locator('.before-after-side[aria-label="After"]')).toBeVisible();
    const documentPane = await page.locator('#review-pane-rendered').boundingBox();
    const comments = await page.locator('.review-comments').boundingBox();
    expect(documentPane!.width).toBeGreaterThanOrEqual(390);
    expect(comments!.y).toBeGreaterThanOrEqual(documentPane!.y + documentPane!.height - 1);
    expect(comments!.height).toBeLessThanOrEqual(160);
  });

  test('embedded narrow review uses its container width, not the browser viewport', async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 800 });
    await page.locator('#review-container').evaluate(element => { element.style.width = '500px'; });
    await page.getByRole('tab', { name: 'Before & after' }).click();
    await expect(page.getByRole('group', { name: 'Comparison side' })).toBeVisible();
    const documentPane = await page.locator('#review-pane-rendered').boundingBox();
    const comments = await page.locator('.review-comments').boundingBox();
    expect(documentPane!.width).toBeGreaterThanOrEqual(490);
    expect(comments!.y).toBeGreaterThanOrEqual(documentPane!.y + documentPane!.height - 1);
  });

  test('Previous and Next change buttons are keyboard-operable and focus linked hunks', async ({ page }) => {
    const next = page.getByRole('button', { name: 'Next change' });
    await next.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.formatted-hunk:focus')).toHaveAttribute('id', /^change-/);
    const firstId = await page.locator('.formatted-hunk:focus').getAttribute('id');
    await next.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.formatted-hunk:focus')).not.toHaveAttribute('id', firstId || '');
    const previous = page.getByRole('button', { name: 'Previous change' });
    await previous.focus();
    await page.keyboard.press(' ');
    await expect(page.locator('.formatted-hunk:focus')).toHaveAttribute('id', firstId || '');
  });

  test('Before & after change navigation focuses the linked complete block', async ({ page }) => {
    await page.getByRole('tab', { name: 'Before & after' }).click();
    const next = page.getByRole('button', { name: 'Next change' });
    await expect(next).toBeVisible();
    await next.click();
    await expect(page.locator('#review-pane-before-after .formatted-change:focus')).toHaveAttribute('data-change-hunk', /^change-/);
  });

  test('narrow Before & after navigation reveals the side containing its focused hunk', async ({ page }) => {
    await page.goto(url('?fixture=added-only'));
    await page.setViewportSize({ width: 1200, height: 800 });
    await page.locator('#review-container').evaluate(element => { element.style.width = '500px'; });
    await page.getByRole('tab', { name: 'Before & after' }).click();
    await page.getByRole('group', { name: 'Comparison side' }).getByRole('button', { name: 'Before' }).click();
    await page.getByRole('button', { name: 'Next change' }).click();
    await expect(page.getByRole('group', { name: 'Comparison side' })
      .getByRole('button', { name: 'After' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#review-pane-before-after .formatted-change:focus')).toBeVisible();
  });

  test('narrow Before & after Find reveals the side containing its current match', async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 800 });
    await page.locator('#review-container').evaluate(element => { element.style.width = '500px'; });
    await page.getByRole('tab', { name: 'Before & after' }).click();
    await page.getByRole('group', { name: 'Comparison side' }).getByRole('button', { name: 'Before' }).click();
    await page.locator('#review-find-input').fill('Paragraph line 10 of the plan');
    await expect(page.locator('#review-find-count')).toHaveText('1/1');
    await expect(page.getByRole('group', { name: 'Comparison side' })
      .getByRole('button', { name: 'After' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#review-pane-before-after .is-find-current')).toBeVisible();
  });

  test('visually silent syntax and destination changes expose a Source escape hatch', async ({ page }) => {
    await page.goto(url('?fixture=source-only-changes'));
    const indicator = page.getByRole('button', { name: 'Source change; inspect Source' });
    await expect(indicator).not.toHaveCount(0);
    await indicator.first().click();
    await expect(page.getByRole('tab', { name: 'Source' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#review-pane-diff')).toBeVisible();
    await expect(page.locator('.diff-row:focus')).toHaveAttribute('data-side', /old|new/);
  });

  for (const fixture of ['eof-newline-only', 'blank-line-only']) {
    test(`${fixture} exposes an explicit Source-change indicator`, async ({ page }) => {
      await page.goto(url(`?fixture=${fixture}`));
      await expect(page.getByRole('button', { name: 'Source change; inspect Source' })).not.toHaveCount(0);
    });
  }

  test('bounded alignment falls back to Before & after and keeps Source available', async ({ page }) => {
    await page.goto(url('?diffFallback=1'));
    await expect(page.getByRole('tab', { name: 'Changes' })).toBeDisabled();
    await expect(page.getByRole('tab', { name: 'Before & after' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#review-view-status')).toContainText('Formatted Changes could not be built');
    await page.getByRole('tab', { name: 'Source' }).click();
    await expect(page.locator('.diff-row[data-line]')).not.toHaveCount(0);
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('tab', { name: 'Before & after' })).toBeFocused();
    await expect(page.getByRole('tab', { name: 'Before & after' })).toHaveAttribute('aria-selected', 'true');
  });

  test('long equal regions collapse only at block boundaries and reveal with stable focus', async ({ page }) => {
    await page.goto(url('?fixture=long-blocks'));
    const reveal = page.getByRole('button', { name: /Show \d+ unchanged blocks/ }).first();
    await expect(reveal).toBeVisible();
    const hiddenCount = await page.locator('#rendered-content .formatted-unchanged-collapsed').count();
    expect(hiddenCount).toBeGreaterThan(0);
    await reveal.click();
    await expect(page.locator('#rendered-content .formatted-unchanged-collapsed')).toHaveCount(hiddenCount - 1);
    await expect(page.locator('#rendered-content [data-source-start]:focus')).toHaveCount(1);
  });

  test('find reveals and searches text inside a collapsed unchanged region', async ({ page }) => {
    await page.goto(url('?fixture=long-blocks'));
    await expect(page.getByRole('button', { name: /Show \d+ unchanged blocks/ }).first()).toBeVisible();
    await page.locator('#review-find-input').fill('Paragraph 2.');
    await expect(page.locator('#review-find-count')).toHaveText('1/1');
    await expect(page.locator('#rendered-content .is-find-current')).toContainText('Paragraph 2.');
  });
});

// ─── Range selection and comments ────────────────────────────────────────────

test.describe('Range selection and comments', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(url());
    await page.getByRole('tab', { name: 'Source' }).click();
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
    // runFind only fires on the input event, so a fill that lands before the
    // rows are in the DOM would search an empty pane and never re-run.
    await expect(row(page, 42)).toBeVisible();
    await page.locator('#review-find-input').fill('bullet item on line 42');
    await expect(page.locator('.diff-row.is-find-current')).toHaveAttribute('data-line', '42');
    await expect(page.locator('#review-find-count')).toHaveText('1/1');
  });

  test('rendered touch selection waits for explicit action before moving focus', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 780 });
    await page.goto(url('?fixture=mapped-blocks'));
    const selectedText = await page.evaluate(() => {
      const paragraph = document.querySelector('#rendered-content p[data-source-start="6"]');
      const text = paragraph?.firstChild;
      if (!paragraph || !text) throw new Error('mapped paragraph missing');
      const range = document.createRange();
      range.selectNodeContents(paragraph);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      paragraph.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'touch' }));
      return selection?.toString() || '';
    });

    expect(selectedText).toContain('Duplicate text');
    await expect(page.locator('#comment-rendered-selection')).toBeEnabled();
    await expect(page.locator('#comment-input')).toHaveCount(0);
    expect(await page.evaluate(() => window.getSelection()?.toString())).toContain('Duplicate text');

    await page.locator('#comment-rendered-selection').click();
    await expect(page.locator('#comment-input')).toBeFocused();
  });

  test('rendered comments highlight and describe the mapped source block', async ({ page }) => {
    await page.goto(url('?fixture=mapped-blocks'));
    await page.evaluate(() => {
      const paragraph = document.querySelector('#rendered-content p[data-source-start="6"]')!;
      const range = document.createRange();
      range.selectNodeContents(paragraph);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      paragraph.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    });
    await page.locator('#comment-rendered-selection').click();
    await page.locator('#comment-input').fill('rendered accessibility');
    await page.locator('#comment-add').click();

    const block = page.locator('#rendered-content p[data-source-start="6"]');
    await expect(block).toHaveClass(/has-comment/);
    const describedBy = await block.getAttribute('aria-describedby');
    expect(describedBy).toMatch(/^comment-/);
    await expect(page.locator(`#${describedBy}`)).toContainText('rendered accessibility');
  });

  test('a comment-list jump focuses its formatted source block', async ({ page }) => {
    await page.getByRole('tab', { name: 'Changes' }).click();
    await page.evaluate(() => {
      const block = document.querySelector('#rendered-content .formatted-change-removed [data-source-side="old"]')!;
      const range = document.createRange();
      range.selectNodeContents(block);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      block.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    });
    await page.locator('#comment-rendered-selection').click();
    await page.locator('#comment-input').fill('jump to old block');
    await page.locator('#comment-add').click();
    await page.locator('.comment-jump').click();
    await expect(page.locator('#rendered-content [data-source-side="old"]:focus')).toHaveCount(1);
  });

  test('a rendered block omitted from a partial Source diff still opens a sidebar composer', async ({ page }) => {
    await page.goto(url('?fixture=partial-mapped-blocks'));
    await page.evaluate(() => {
      const paragraph = document.querySelector('#rendered-content p[data-source-start="6"]')!;
      const range = document.createRange();
      range.selectNodeContents(paragraph);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      paragraph.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    });
    await page.locator('#comment-rendered-selection').click();
    await expect(page.locator('.review-comments #comment-composer')).toBeVisible();
    await page.locator('#comment-input').fill('outside the diff hunk');
    await page.locator('#comment-add').click();
    await page.locator('#btn-approve').click();
    const payload = await page.evaluate(() => (window as any).__lastSubmit);
    expect(payload.inlineComments[0]).toMatchObject({
      path: 'docs/plan-v1.md', startLine: 6, endLine: 7, side: 'new', comment: 'outside the diff hunk',
    });
  });

  test('removing the last prior comment preserves the live rendered composer and its draft', async ({ page }) => {
    await addComment(page, 42, 42, 'prior comment');
    await page.getByRole('tab', { name: 'Changes' }).click();
    await page.evaluate(() => {
      const block = document.querySelector('#rendered-content [data-source-side="new"][data-source-start="42"]')!;
      const range = document.createRange();
      range.selectNodeContents(block);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      block.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    });
    await page.getByRole('button', { name: 'Comment on selection' }).click();
    await page.locator('#comment-input').fill('half-typed exact draft');
    await page.locator('#comment-input').evaluate((input: HTMLTextAreaElement) => {
      input.focus();
      input.setSelectionRange(5, 10, 'backward');
    });
    await page.evaluate(() => {
      (window as any).__composerBeforeRemoval = document.querySelector('#comment-composer');
    });

    await page.getByRole('button', { name: 'Remove comment' }).evaluate((button: HTMLButtonElement) => button.click());

    await expect(page.locator('#comment-input')).toHaveValue('half-typed exact draft');
    expect(await page.evaluate(() =>
      (window as any).__composerBeforeRemoval === document.querySelector('#comment-composer'))).toBe(true);
    expect(await page.locator('#comment-input').evaluate((input: HTMLTextAreaElement) => ({
      active: document.activeElement === input,
      start: input.selectionStart,
      end: input.selectionEnd,
      direction: input.selectionDirection,
    }))).toEqual({ active: true, start: 5, end: 10, direction: 'backward' });
    await expect(page.locator('#comment-add')).toBeEnabled();
  });

  test('selectionchange in an unrelated textarea skips mapped-leaf repaint work', async ({ page }) => {
    await page.locator('#overall-feedback').fill('ordinary textarea selection');
    await page.evaluate(() => {
      const review = (window as any).__review;
      review.perf.lastMappedLeafCount = -1;
      const input = document.querySelector('#overall-feedback') as HTMLTextAreaElement;
      input.focus();
      input.setSelectionRange(0, 8);
      document.dispatchEvent(new Event('selectionchange'));
    });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    expect(await page.evaluate(() => (window as any).__review.perf.lastMappedLeafCount)).toBe(-1);
    await expect(page.locator('#comment-rendered-selection')).toBeDisabled();
    await expect(page.locator('#rendered-content .is-selection-candidate')).toHaveCount(0);
  });

  test('a resolved review cannot re-enable rendered commenting after reselection', async ({ page }) => {
    await page.goto(url('?fixture=mapped-blocks'));
    await page.evaluate(() => (window as any).__simulateSuperseded('phone'));
    await page.evaluate(() => {
      const paragraph = document.querySelector('#rendered-content p[data-source-start="6"]')!;
      const range = document.createRange();
      range.selectNodeContents(paragraph);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      paragraph.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    });
    await expect(page.locator('#comment-rendered-selection')).toBeDisabled();
    await expect(page.locator('#rendered-content .is-selection-candidate')).toHaveCount(0);
  });

  test('collapsed, outside, generated-node, and mixed-side rendered ranges stay non-actionable', async ({ page }) => {
    await page.goto(url('?fixture=mapped-blocks'));
    const button = page.locator('#comment-rendered-selection');

    for (const kind of ['collapsed', 'outside', 'generated', 'mixed'] as const) {
      await page.evaluate((kind) => {
        const rendered = document.querySelector('#rendered-content')!;
        const first = rendered.querySelector('[data-source-start]')!;
        const second = rendered.querySelector('p[data-source-start="6"]')!;
        const selection = window.getSelection()!;
        selection.removeAllRanges();
        const range = document.createRange();

        if (kind === 'collapsed') {
          range.setStart(first.firstChild!, 0);
          range.collapse(true);
        } else if (kind === 'outside') {
          const outside = document.querySelector('.review-title')!.firstChild!;
          range.selectNodeContents(outside);
        } else if (kind === 'generated') {
          const generated = document.createElement('span');
          generated.id = 'generated-selection-node';
          generated.textContent = 'Generated UI text';
          rendered.append(generated);
          range.selectNodeContents(generated);
        } else {
          first.setAttribute('data-source-side', 'old');
          range.setStart(first.firstChild!, 0);
          range.setEnd(second.lastChild!, second.lastChild!.textContent!.length);
        }
        selection.addRange(range);
        rendered.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
      }, kind);
      await expect(button).toBeDisabled();
    }
  });

  test('a safe rendered link activates normally when there is no text range', async ({ page }) => {
    await page.goto(url('?fixture=mapped-blocks'));
    await page.locator('#rendered-content a', { hasText: 'Jump to target' }).click();
    await expect(page).toHaveURL(/#safe-target$/);
  });
});

test.describe('Rendered touch selection', () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 780 } });

  test('real touch activation preserves the cached range through pointerdown', async ({ page }) => {
    await page.goto(url('?fixture=mapped-blocks'));
    await page.evaluate(() => {
      const paragraph = document.querySelector('#rendered-content p[data-source-start="6"]')!;
      const range = document.createRange();
      range.selectNodeContents(paragraph);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      paragraph.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'touch' }));
      const button = document.querySelector('#comment-rendered-selection')!;
      button.addEventListener('pointerdown', (event) => {
        (window as any).__touchPointerDown = {
          pointerType: event.pointerType,
          defaultPrevented: event.defaultPrevented,
          selection: window.getSelection()?.toString() || '',
        };
      });
    });

    const action = page.locator('#comment-rendered-selection');
    await action.scrollIntoViewIfNeeded();
    const box = await action.boundingBox();
    expect(box).not.toBeNull();
    await page.touchscreen.tap(box!.x + box!.width / 2, box!.y + box!.height / 2);
    expect(await page.evaluate(() => (window as any).__touchPointerDown)).toMatchObject({
      pointerType: 'touch', defaultPrevented: true,
    });
    expect(await page.evaluate(() => (window as any).__touchPointerDown.selection)).toContain('Duplicate text');
    await expect(page.locator('#comment-input')).toBeFocused();
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

  test('an unrecognized status fails safe to unacknowledged, never to success', async ({ page }) => {
    await page.goto(url('?status=something-new'));
    await addComment(page, 42, 42, 'must survive');
    await page.locator('#btn-approve').click();

    // A newer client, a renamed status, a dropped field — guessing "received"
    // silently discards the review, so anything unknown is treated as unsent.
    await expect(page.locator('.success-title')).toHaveCount(0);
    await expect(page.locator('#review-error')).toHaveAttribute('data-tone', 'warning');
    await expect(page.locator('.comment-card-list .comment-card-body')).toHaveText('must survive');
    await expect(page.locator('#btn-approve')).toBeEnabled();
  });

  test('a submit resolving with no status at all also fails safe', async ({ page }) => {
    await page.goto(url('?status='));
    await page.locator('#btn-approve').click();
    await expect(page.locator('.success-title')).toHaveCount(0);
    await expect(page.locator('#review-error')).toHaveAttribute('data-tone', 'warning');
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

// ─── Sender badge ─────────────────────────────────────────────────────────────

test.describe('Sender badge', () => {
  test('shows a prominent sender badge in the header when the message carries one', async ({ page }) => {
    await page.goto(url('?fixture=sender-badge'));

    const badge = page.locator('.review-badges .badge-sender');
    await expect(badge).toBeVisible();
    await expect(badge).toBeInViewport();
    await expect(badge).toHaveAttribute('title', 'Kay9 - work-item/1-reviewplan');

    // Header badge row, never inside the scrolling plan panes.
    await expect(page.locator('#review-pane-diff .badge-sender')).toHaveCount(0);
    await expect(page.locator('#review-pane-rendered .badge-sender')).toHaveCount(0);
  });

  test('truncates a long label with ellipsis instead of wrapping', async ({ page }) => {
    await page.goto(url('?fixture=sender-badge'));
    const badge = page.locator('.review-badges .badge-sender');
    const style = await badge.evaluate(el => {
      const computed = getComputedStyle(el);
      return { overflow: computed.overflow, textOverflow: computed.textOverflow, whiteSpace: computed.whiteSpace };
    });
    expect(style.overflow).toBe('hidden');
    expect(style.textOverflow).toBe('ellipsis');
    expect(style.whiteSpace).toBe('nowrap');
  });

  test('renders no sender badge when the message omits sender', async ({ page }) => {
    await page.goto(url());
    await expect(page.locator('.badge-sender')).toHaveCount(0);
  });
});

// ─── Performance (E-13 / E-14, measured not mandated) ────────────────────────

/** E-14's budget: a comment edit must stay under this on a 100 KB plan. */
const E14_BUDGET_MS = 100;

/**
 * Separate and deliberately looser: the point at which the naive full
 * re-render would need replacing with a line-keyed overlay. The gate cut the
 * overlay *mandate* and asked for a measured outcome, and this is the number
 * that would reopen that decision — not the acceptance criterion.
 */
const OVERLAY_REWRITE_THRESHOLD_MS = 300;

test.describe('Bounded formatted diff performance', () => {
  for (const fixture of ['formatted-1k', 'formatted-10k']) {
    test(`${fixture} records parse, alignment, DOM, and selection costs`, async ({ page }) => {
      test.setTimeout(60_000);
      await page.goto(url(`?fixture=${fixture}`));
      const block = page.locator('#rendered-content [data-source-start]').first();
      await page.evaluate(() => {
        const element = document.querySelector('#rendered-content [data-source-start]')!;
        const range = document.createRange();
        range.selectNodeContents(element);
        const selection = window.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);
        element.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
      });
      await expect(block).toHaveClass(/is-selection-candidate/);
      const perf = await page.evaluate(() => (window as any).__reviewPerf);
      for (const key of ['formattedParseMs', 'formattedDiffMs', 'formattedDomRenderMs', 'lastSelectionMapMs']) {
        expect(Number.isFinite(perf[key]), `${key} must be recorded`).toBe(true);
        expect(perf[key]).toBeGreaterThanOrEqual(0);
      }
      console.log(`[Task11] ${fixture}: blocks=${perf.formattedBlockCount} parse=${perf.formattedParseMs.toFixed(1)}ms `
        + `diff=${perf.formattedDiffMs.toFixed(1)}ms dom=${perf.formattedDomRenderMs.toFixed(1)}ms `
        + `selection=${perf.lastSelectionMapMs.toFixed(1)}ms`);
    });
  }

  test('all-changed input deterministically falls back when max edit work is exhausted', async ({ page }) => {
    await page.goto(url('?fixture=formatted-all-changed&diffMax=10'));
    await expect(page.getByRole('tab', { name: 'Changes' })).toBeDisabled();
    await expect(page.getByRole('tab', { name: 'Before & after' })).toHaveAttribute('aria-selected', 'true');
    expect(await page.evaluate(() => (window as any).__reviewPerf.formattedFallback)).toBe(true);
  });

  test('10k all-changed fallback keeps complete documents with a bounded leaf scan', async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto(url('?fixture=formatted-all-changed-10k&diffMax=10'));
    await expect(page.getByRole('tab', { name: 'Before & after' })).toHaveAttribute('aria-selected', 'true');
    const perf = await page.evaluate(() => (window as any).__reviewPerf);
    expect(perf.formattedFallback).toBe(true);
    expect(perf.lastMappedLeafCount).toBeLessThanOrEqual(perf.formattedBlockCount);
    await expect(page.locator('#before-content [data-source-start]')).not.toHaveCount(0);
    // On fallback the current document retains Task 10's canonical ID.
    await expect(page.locator('#rendered-content [data-source-start]')).not.toHaveCount(0);
  });

  test('10k full-panel range resolves innermost blocks with linear containment work', async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto(url('?fixture=formatted-all-changed-10k&diffMax=10'));
    const work = await page.evaluate(async () => {
      const { mappedAnchorFromSelection } = await import('/review.js');
      const root = document.querySelector('.review-view-panels')!;
      const fakeRange = {
        collapsed: false,
        startContainer: root,
        endContainer: root,
        intersectsNode: () => true,
      };
      const fakeSelection = {
        rangeCount: 1,
        isCollapsed: false,
        toString: () => 'selected',
        getRangeAt: () => fakeRange,
      };
      const stats: Record<string, number> = {};
      const result = mappedAnchorFromSelection(root, fakeSelection as any, stats);
      return { stats, result };
    });
    expect(work.result).toBeNull();
    expect(work.stats.intersectionTests).toBeGreaterThan(0);
    expect(work.stats.containmentChecks).toBeLessThanOrEqual(work.stats.intersectionTests * 2);
  });
});

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

    expect(afterAdd.lastCommentUpdateMs).toBeLessThan(E14_BUDGET_MS);
    expect(afterRemove.lastCommentUpdateMs).toBeLessThan(E14_BUDGET_MS);
    // Well inside the rewrite threshold too, which is why the naive render stands.
    expect(afterAdd.lastCommentUpdateMs).toBeLessThan(OVERLAY_REWRITE_THRESHOLD_MS);
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
    expect(Math.max(...samples)).toBeLessThan(E14_BUDGET_MS);
  });
});
