import { test, expect } from '@playwright/test';

// Line-number integrity (G-1, J-5). Every case here is one where a plausible
// implementation silently renumbers the plan and points every anchor at the
// wrong line, with no error anywhere.

const url = (fixture: string) => `/review-harness.html?fixture=${fixture}`;

function rows(page: import('@playwright/test').Page) {
  return page.locator('.diff-row[data-line][data-side="new"]');
}

async function openSource(page: import('@playwright/test').Page) {
  await page.getByRole('tab', { name: 'Source' }).click();
}

async function revealAllUnchanged(page: import('@playwright/test').Page) {
  const reveal = page.locator('#rendered-content .formatted-unchanged-reveal');
  while (await reveal.count()) await reveal.first().click();
}

async function selectRenderedRange(
  page: import('@playwright/test').Page,
  startSelector: string,
  endSelector = startSelector,
  reverse = false,
) {
  await page.evaluate(({ startSelector, endSelector, reverse }) => {
    const start = document.querySelector(startSelector);
    const end = document.querySelector(endSelector);
    if (!start || !end) throw new Error('Rendered selection endpoint missing');

    const textNode = (element: Element, fromEnd: boolean) => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      const nodes: Text[] = [];
      while (walker.nextNode()) nodes.push(walker.currentNode as Text);
      const node = fromEnd ? nodes.at(-1) : nodes[0];
      if (!node) throw new Error('Rendered selection endpoint has no text');
      return node;
    };

    const startNode = textNode(start, false);
    const endNode = textNode(end, true);
    const selection = window.getSelection();
    if (!selection) throw new Error('Selection API unavailable');
    selection.removeAllRanges();
    if (reverse && typeof selection.setBaseAndExtent === 'function') {
      selection.setBaseAndExtent(endNode, endNode.data.length, startNode, 0);
    } else {
      const range = document.createRange();
      range.setStart(startNode, 0);
      range.setEnd(endNode, endNode.data.length);
      selection.addRange(range);
    }
    start.closest('#rendered-content')?.dispatchEvent(new PointerEvent('pointerup', {
      bubbles: true,
      pointerType: 'touch',
    }));
  }, { startSelector, endSelector, reverse });
}

async function submitRenderedComment(page: import('@playwright/test').Page, comment: string) {
  await page.locator('#comment-rendered-selection').click();
  await page.locator('#comment-input').fill(comment);
  await page.locator('#comment-add').click();
  await page.locator('#btn-approve').click();
  return page.evaluate(() => (window as any).__lastSubmit);
}

test.describe('Literal backslash-n (G-1)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(url('literal-backslash-n'));
  });

  test('a literal \\n two-character sequence does not create a new line', async ({ page }) => {
    await openSource(page);
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
    await openSource(page);
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
    await openSource(page);
    await expect(rows(page)).toHaveCount(4);
    await expect(page.locator('.diff-row[data-side="new"][data-line="4"] .diff-text')).toHaveText('fourth line');
    // No stray carriage returns leaked into the rendered row text.
    const texts = await page.locator('.diff-row[data-side="new"] .diff-text').allTextContents();
    expect(texts.some(t => t.includes('\r'))).toBe(false);
  });

  test('a CRLF anchor round-trips', async ({ page }) => {
    await page.goto(url('crlf'));
    await openSource(page);
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
    await openSource(page);
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
    await openSource(page);

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
    await openSource(page);
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

test.describe('Rendered Markdown source maps', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(url('mapped-blocks'));
  });

  test('opening and standalone blocks expose validated 1-based inclusive raw lines', async ({ page }) => {
    await revealAllUnchanged(page);
    await expect(page.locator('#rendered-content h1').first()).toHaveAttribute('data-source-start', '1');
    await expect(page.locator('#rendered-content h1').first()).toHaveAttribute('data-source-end', '1');
    await expect(page.locator('#rendered-content h1').nth(1)).toHaveAttribute('data-source-start', '3');
    await expect(page.locator('#rendered-content h1').nth(1)).toHaveAttribute('data-source-end', '4');
    await expect(page.locator('#rendered-content p').filter({ hasText: 'starts this multiline' }))
      .toHaveAttribute('data-source-start', '6');
    await expect(page.locator('#rendered-content p').filter({ hasText: 'starts this multiline' }))
      .toHaveAttribute('data-source-end', '7');
    await expect(page.locator('#rendered-content [data-source-start="18"]')).toHaveAttribute('data-source-end', '20');
    await expect(page.locator('#rendered-content [data-source-side="new"]')).not.toHaveCount(0);
  });

  test('a multiline paragraph selection snaps to its whole raw block despite duplicate text and emoji', async ({ page }) => {
    const paragraph = '#rendered-content p[data-source-start="6"]';
    await selectRenderedRange(page, paragraph);
    const payload = await submitRenderedComment(page, 'paragraph mapping');

    expect(payload.inlineComments[0]).toMatchObject({
      path: 'docs/plan-v1.md', startLine: 6, endLine: 7, side: 'new', comment: 'paragraph mapping',
    });
  });

  test('reverse multi-block selection normalises the innermost intersecting blocks', async ({ page }) => {
    await selectRenderedRange(
      page,
      '#rendered-content p[data-source-start="9"]',
      '#rendered-content li[data-source-start="12"]',
      true,
    );
    const payload = await submitRenderedComment(page, 'nested range');
    expect(payload.inlineComments[0]).toMatchObject({ startLine: 9, endLine: 12, side: 'new' });
  });

  test('selecting only a deep list item excludes its enclosing blockquote and list maps', async ({ page }) => {
    await selectRenderedRange(page, '#rendered-content li[data-source-start="12"]');
    const payload = await submitRenderedComment(page, 'deep item only');
    expect(payload.inlineComments[0]).toMatchObject({ startLine: 12, endLine: 12, side: 'new' });
  });

  test('real mouse selection anchors the second of two identical emoji paragraphs', async ({ page }) => {
    const duplicates = page.locator('#rendered-content p').filter({ hasText: 'Same 😀 duplicate.' });
    await expect(duplicates).toHaveCount(2);
    const textBox = await duplicates.nth(1).evaluate(element => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const rect = range.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    });
    const y = textBox.y + textBox.height / 2;
    await page.mouse.move(textBox.x + 1, y);
    await page.mouse.down();
    await page.mouse.move(textBox.x + textBox.width - 1, y, { steps: 10 });
    await page.mouse.up();
    expect(await page.evaluate(() => window.getSelection()?.toString())).toContain('Same 😀 duplicate.');
    const resolved = await page.evaluate(async () => {
      const review = await import('/review.js');
      return review.mappedAnchorFromSelection(
        document.querySelector('#rendered-content'),
        window.getSelection(),
      );
    });
    expect(resolved).toMatchObject({ startLine: 28, endLine: 28, side: 'new' });
    await expect(page.locator('#comment-rendered-selection')).toBeEnabled();
    const payload = await submitRenderedComment(page, 'second duplicate');
    expect(payload.inlineComments[0]).toMatchObject({ startLine: 28, endLine: 28, side: 'new' });
  });

  test('the mapped document preserves the existing Source keyboard block path', async ({ page }) => {
    await openSource(page);
    await page.locator('.diff-row[data-side="new"][data-line="6"]').click();
    await page.keyboard.press('Shift+ArrowDown');
    await page.keyboard.press('Enter');
    await page.locator('#comment-input').fill('source keyboard');
    await page.locator('#comment-add').click();
    await page.locator('#btn-approve').click();
    const payload = await page.evaluate(() => (window as any).__lastSubmit);
    expect(payload.inlineComments[0]).toMatchObject({ startLine: 6, endLine: 7, side: 'new' });
  });

  test('table and fenced-code selections use their physical raw line ranges', async ({ page }) => {
    await revealAllUnchanged(page);
    await selectRenderedRange(page, '#rendered-content tr[data-source-start="16"]');
    let payload = await submitRenderedComment(page, 'table row');
    expect(payload.inlineComments[0]).toMatchObject({ startLine: 16, endLine: 16, side: 'new' });

    await page.goto(url('mapped-blocks'));
    await revealAllUnchanged(page);
    await selectRenderedRange(page, '#rendered-content [data-source-start="18"]');
    payload = await submitRenderedComment(page, 'fence');
    expect(payload.inlineComments[0]).toMatchObject({ startLine: 18, endLine: 20, side: 'new' });
  });

  test('CRLF and no-final-newline documents keep rendered block anchors stable', async ({ page }) => {
    await page.goto(url('crlf'));
    await selectRenderedRange(page, '#rendered-content p');
    let payload = await submitRenderedComment(page, 'crlf paragraph');
    expect(payload.inlineComments[0]).toMatchObject({ startLine: 2, endLine: 4, side: 'new' });

    await page.goto(url('no-trailing-newline'));
    await selectRenderedRange(page, '#rendered-content p');
    payload = await submitRenderedComment(page, 'no final newline');
    expect(payload.inlineComments[0]).toMatchObject({ startLine: 2, endLine: 3, side: 'new' });
  });
});

test.describe('Full-document reconstruction for formatted review', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/review-harness.html');
  });

  test('reconstructs all-added, unchanged, deleted, and replaced documents', async ({ page }) => {
    const cases = await page.evaluate(async () => {
      const { reconstructReviewDocuments } = await import('/review.js');
      return {
        allAdded: reconstructReviewDocuments(
          '# New\n\nBody\n',
          '--- a/plan.md\n+++ b/plan.md\n@@ -0,0 +1,3 @@\n+# New\n+\n+Body\n',
        ),
        unchanged: reconstructReviewDocuments(
          '# Same\n\nBody\n',
          '--- a/plan.md\n+++ b/plan.md\n@@ -1,3 +1,3 @@\n # Same\n \n Body\n',
        ),
        replaced: reconstructReviewDocuments(
          '# Plan\n\nNew wording\nKeep\n',
          '--- a/plan.md\n+++ b/plan.md\n@@ -1,4 +1,4 @@\n # Plan\n \n-Old wording\n+New wording\n Keep\n',
        ),
        deleted: reconstructReviewDocuments(
          '# Plan\n\nKeep\n',
          '--- a/plan.md\n+++ b/plan.md\n@@ -1,4 +1,3 @@\n # Plan\n \n-Delete me\n Keep\n',
        ),
      };
    });

    expect(cases.allAdded).toMatchObject({ ok: true, oldSource: '', newSource: '# New\n\nBody\n' });
    expect(cases.unchanged).toMatchObject({ ok: true, oldSource: '# Same\n\nBody\n' });
    expect(cases.replaced).toMatchObject({ ok: true, oldSource: '# Plan\n\nOld wording\nKeep\n' });
    expect(cases.deleted).toMatchObject({ ok: true, oldSource: '# Plan\n\nDelete me\nKeep\n' });
  });

  test('preserves logical lines for CRLF and no-final-newline markers', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { reconstructReviewDocuments } = await import('/review.js');
      return reconstructReviewDocuments(
        '# Plan\r\n\r\nAfter\r\n',
        '--- a/plan.md\r\n+++ b/plan.md\r\n@@ -1,3 +1,3 @@\r\n # Plan\r\n \r\n-Before\r\n\\ No newline at end of file\r\n+After\r\n',
      );
    });

    expect(result).toMatchObject({
      ok: true,
      oldSource: '# Plan\n\nBefore',
      newSource: '# Plan\r\n\r\nAfter\r\n',
      oldLines: ['# Plan', '', 'Before'],
      newLines: ['# Plan', '', 'After'],
    });
  });

  test('fails closed when a patch is partial, malformed, or disagrees with current content', async ({ page }) => {
    const failures = await page.evaluate(async () => {
      const { reconstructReviewDocuments } = await import('/review.js');
      return [
        reconstructReviewDocuments('one\ntwo\nthree\n', '@@ -2,1 +2,1 @@\n-two\n+changed\n'),
        reconstructReviewDocuments('new\n', '@@ nonsense @@\n-old\n+new\n'),
        reconstructReviewDocuments('authoritative\n', '@@ -1,1 +1,1 @@\n-old\n+different\n'),
      ];
    });

    expect(failures.every(result => result.ok === false)).toBe(true);
    expect(failures.map(result => result.newSource)).toEqual([
      'one\ntwo\nthree\n',
      'new\n',
      'authoritative\n',
    ]);
  });
});

test.describe('Review lifecycle cleanup', () => {
  test('disposeReview removes the document Ctrl+F listener', async ({ page }) => {
    await page.goto('/review-harness.html');
    const focused = await page.evaluate(async () => {
      const { disposeReview } = await import('/review.js');
      const host = document.querySelector('#review-container')!;
      disposeReview(host);
      (document.body as HTMLElement).tabIndex = -1;
      (document.body as HTMLElement).focus();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true }));
      return document.activeElement?.id || document.activeElement?.tagName;
    });
    expect(focused).not.toBe('review-find-input');
  });

  test('repeated remounts leave exactly one Ctrl+F listener, then disposal leaves none', async ({ page }) => {
    await page.goto('/review-harness.html');
    const counts = await page.evaluate(async () => {
      const { renderPlanReview, disposeReview } = await import('/review.js');
      const host = document.querySelector('#review-container')!;
      renderPlanReview(host, (window as any).__fixture, {});
      renderPlanReview(host, (window as any).__fixture, {});
      let reads = 0;
      const mountedEvent = new KeyboardEvent('keydown', { key: 'f', bubbles: true, cancelable: true });
      Object.defineProperty(mountedEvent, 'ctrlKey', { get: () => { reads++; return true; } });
      document.dispatchEvent(mountedEvent);
      const mountedReads = reads;
      disposeReview(host);
      const disposedEvent = new KeyboardEvent('keydown', { key: 'f', bubbles: true, cancelable: true });
      Object.defineProperty(disposedEvent, 'ctrlKey', { get: () => { reads++; return true; } });
      document.dispatchEvent(disposedEvent);
      return { mountedReads, disposedReads: reads - mountedReads };
    });
    expect(counts).toEqual({ mountedReads: 1, disposedReads: 0 });
  });
});
