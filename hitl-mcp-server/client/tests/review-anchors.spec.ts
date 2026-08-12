import { test, expect } from '@playwright/test';

// Line-number integrity (G-1, J-5). Every case here is one where a plausible
// implementation silently renumbers the plan and points every anchor at the
// wrong line, with no error anywhere.

const url = (fixture: string) => `/review-harness.html?fixture=${fixture}`;

function rows(page: import('@playwright/test').Page) {
  return page.locator('.diff-row[data-line][data-side="new"]');
}

test.describe('Literal backslash-n (G-1)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(url('literal-backslash-n'));
  });

  test('a literal \\n two-character sequence does not create a new line', async ({ page }) => {
    // normalizeNewlines() (dialog.js:17) would rewrite the escape into a real
    // newline and turn these four lines into five, shifting every anchor below
    // it by one. It must never be applied to a plan body.
    await expect(rows(page)).toHaveCount(4);
    await expect(page.locator('.diff-row[data-side="new"][data-line="2"] .diff-text'))
      .toHaveText('The sequence \\n is a literal backslash followed by n.');
    await expect(page.locator('.diff-row[data-side="new"][data-line="3"] .diff-text'))
      .toHaveText('This must still be line 3.');
    await expect(page.locator('.diff-row[data-side="new"][data-line="4"] .diff-text'))
      .toHaveText('And this must still be line 4.');
  });

  test('an anchor on the line after the escape round-trips to the same source line', async ({ page }) => {
    await page.locator('.diff-row[data-side="new"][data-line="3"]').click();
    await page.locator('#comment-input').fill('anchored below the escape');
    await page.locator('#comment-add').click();
    await page.locator('#btn-approve').click();

    const payload = await page.evaluate(() => (window as any).__lastSubmit);
    expect(payload.inlineComments[0]).toMatchObject({ startLine: 3, endLine: 3, side: 'new' });
  });
});

test.describe('CRLF line endings (B-11 / J-5)', () => {
  test('a CRLF plan yields the same anchors as its LF twin', async ({ page }) => {
    await page.goto(url('crlf'));
    await expect(rows(page)).toHaveCount(4);
    await expect(page.locator('.diff-row[data-side="new"][data-line="4"] .diff-text')).toHaveText('fourth line');
    // No stray carriage returns leaked into the rendered row text.
    const texts = await page.locator('.diff-row[data-side="new"] .diff-text').allTextContents();
    expect(texts.some(t => t.includes('\r'))).toBe(false);
  });

  test('a CRLF anchor round-trips', async ({ page }) => {
    await page.goto(url('crlf'));
    await page.locator('.diff-row[data-side="new"][data-line="2"]').click();
    await page.locator('.diff-row[data-side="new"][data-line="4"]').click({ modifiers: ['Shift'] });
    await page.locator('#comment-input').fill('crlf range');
    await page.locator('#comment-add').click();
    await page.locator('#btn-approve').click();

    const payload = await page.evaluate(() => (window as any).__lastSubmit);
    expect(payload.inlineComments[0]).toMatchObject({ startLine: 2, endLine: 4, side: 'new' });
  });
});

test.describe('No trailing newline (J-5)', () => {
  test('the "\\ No newline at end of file" marker consumes no source line', async ({ page }) => {
    await page.goto(url('no-trailing-newline'));
    await expect(rows(page)).toHaveCount(3);
    await expect(page.locator('.diff-row[data-side="new"][data-line="3"] .diff-text')).toHaveText('line three');
    // The marker renders, but is not selectable and holds no line number.
    const marker = page.locator('.diff-row-meta', { hasText: 'No newline at end of file' });
    await expect(marker).toHaveCount(1);
    await expect(marker).not.toHaveAttribute('data-line', /.*/);
  });
});

test.describe('Diff coordinate space', () => {
  test('added lines advance only the new counter, removed lines only the old', async ({ page }) => {
    await page.goto('/review-harness.html');

    // The fixture adds one line at new-side 10 and removes one at old-side 20.
    await expect(page.locator('.diff-row-add')).toHaveCount(1);
    await expect(page.locator('.diff-row-add')).toHaveAttribute('data-line', '10');
    await expect(page.locator('.diff-row-add')).toHaveAttribute('data-side', 'new');

    await expect(page.locator('.diff-row-del')).toHaveCount(1);
    await expect(page.locator('.diff-row-del')).toHaveAttribute('data-line', '20');
    await expect(page.locator('.diff-row-del')).toHaveAttribute('data-side', 'old');

    // The added line does not shift new-side numbering of what follows: the
    // last content line is 60 in both the source and the diff.
    await expect(page.locator('.diff-row[data-side="new"][data-line="60"]')).toHaveCount(1);
    await expect(page.locator('.diff-row[data-side="new"][data-line="61"]')).toHaveCount(0);
  });

  test('a range never straddles the two sides', async ({ page }) => {
    await page.goto('/review-harness.html');
    // Start on a new-side line, then shift-click the removed old-side line:
    // that restarts the selection rather than producing a mixed-space anchor.
    await page.locator('.diff-row[data-side="new"][data-line="18"]').click();
    await page.locator('.diff-row[data-side="old"][data-line="20"]').click({ modifiers: ['Shift'] });
    await page.locator('#comment-input').fill('old side only');
    await page.locator('#comment-add').click();
    await page.locator('#btn-approve').click();

    const payload = await page.evaluate(() => (window as any).__lastSubmit);
    expect(payload.inlineComments).toHaveLength(1);
    expect(payload.inlineComments[0]).toMatchObject({ startLine: 20, endLine: 20, side: 'old' });
  });
});
