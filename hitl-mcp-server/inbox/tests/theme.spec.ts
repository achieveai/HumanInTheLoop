import { test, expect } from '@playwright/test';

test('dark mode can be switched and survives reload', async ({ page }) => {
  await page.addInitScript(() => { (window as any).__INBOX_FIXTURE = {}; });
  await page.goto('/inbox-harness.html');
  const toggle = page.getByRole('button', { name: 'Dark mode' });
  await toggle.click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await toggle.focus();
  await page.keyboard.press('Space');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
});

test('message type filters switch to labeled icons in a narrow column', async ({ page }) => {
  await page.addInitScript(() => { (window as any).__INBOX_FIXTURE = {}; });
  await page.goto('/inbox-harness.html');
  const filters = page.locator('#type-filter-set');
  await page.evaluate(async () => {
    const { renderTypeFilterBar } = await import('./pane-list.js');
    const container = document.querySelector('#type-filter-set') as HTMLElement;
    container.style.width = '300px'; container.style.flex = 'none';
    renderTypeFilterBar(container, [{ msgType: 'question' }], new Set(['question']));
  });
  await expect(filters.getByRole('button', { name: 'Questions' })).toBeVisible();
  await expect(filters.locator('[data-type="question"] .type-filter-icon')).toBeVisible();
  await expect(filters.locator('[data-type="question"] .type-filter-label')).toBeHidden();
});

test('marked review controls and Mermaid viewer use dark surfaces', async ({ page }) => {
  await page.addInitScript(() => { (window as any).__INBOX_FIXTURE = {}; });
  await page.goto('/inbox-harness.html');
  await page.getByRole('button', { name: 'Dark mode' }).click();
  const styles = await page.evaluate(() => {
    const sample = document.createElement('div');
    sample.className = 'detail-review-host';
    sample.innerHTML = '<div class="review-pane-label review-rendered-toolbar"></div><div class="diagram-viewer" data-diagram-kind="mermaid"><div class="diagram-viewport"><img></div></div>';
    document.body.append(sample);
    const toolbar = getComputedStyle(sample.querySelector('.review-rendered-toolbar')!);
    const image = getComputedStyle(sample.querySelector('img')!);
    const result = { background: toolbar.backgroundColor, filter: image.filter };
    sample.remove();
    return result;
  });
  expect(styles.background).toBe('oklch(0.24 0.02 260)');
  expect(styles.filter).toContain('invert(1)');
});

test('before/after heading and review banners use dark surfaces', async ({ page }) => {
  await page.addInitScript(() => { (window as any).__INBOX_FIXTURE = {}; });
  await page.goto('/inbox-harness.html');
  await page.getByRole('button', { name: 'Dark mode' }).click();
  const styles = await page.evaluate(() => {
    const banner = document.createElement('div');
    banner.className = 'review-banner-superseded';
    banner.textContent = 'Already reviewed on another device.';
    const cancelled = document.createElement('div');
    cancelled.className = 'review-banner-cancelled';
    cancelled.textContent = 'The agent exited before this review was settled.';
    const side = document.createElement('div');
    side.className = 'before-after-side';
    side.innerHTML = '<h2 class="before-after-heading">Before</h2>';
    document.body.append(banner, cancelled, side);
    const bannerStyle = getComputedStyle(banner);
    const cancelledStyle = getComputedStyle(cancelled);
    const headingStyle = getComputedStyle(side.querySelector('.before-after-heading')!);
    const result = {
      bannerBackground: bannerStyle.backgroundColor,
      bannerColor: bannerStyle.color,
      bannerBorder: bannerStyle.borderColor,
      cancelledBackground: cancelledStyle.backgroundColor,
      cancelledColor: cancelledStyle.color,
      cancelledBorder: cancelledStyle.borderColor,
      headingBackground: headingStyle.backgroundColor,
      headingColor: headingStyle.color,
      headingBorder: headingStyle.borderBottomColor,
    };
    banner.remove(); cancelled.remove(); side.remove();
    return result;
  });
  expect(styles.bannerBackground).toBe('oklch(0.32 0.07 255)');
  expect(styles.bannerColor).toBe('oklch(0.85 0.09 255)');
  expect(styles.bannerBorder).toBe('oklch(0.48 0.1 255)');
  expect(styles.cancelledBackground).toBe('oklch(0.32 0.08 60)');
  expect(styles.cancelledColor).toBe('oklch(0.85 0.11 60)');
  expect(styles.cancelledBorder).toBe('oklch(0.48 0.12 60)');
  expect(styles.headingBackground).toBe('oklch(0.29 0.025 260)');
  expect(styles.headingColor).toBe('oklch(0.78 0.02 260)');
  expect(styles.headingBorder).toBe('oklch(0.43 0.03 260)');
});

test('source diff rows and comment controls use dark surfaces', async ({ page }) => {
  await page.addInitScript(() => { (window as any).__INBOX_FIXTURE = {}; });
  await page.goto('/inbox-harness.html');
  await page.getByRole('button', { name: 'Dark mode' }).click();
  const styles = await page.evaluate(() => {
    const host = document.createElement('div');
    host.innerHTML = `
      <div class="diff-row diff-row-add is-selected"><span class="diff-mark">+</span></div>
      <div class="diff-row diff-row-del"><span class="diff-mark">-</span></div>
      <div class="diff-row is-find-current"></div>
      <div class="diff-row-hunk">@@ header</div>
      <div class="comment-card-actions">
        <button class="comment-control">Edit</button>
        <button class="comment-control comment-delete">Delete</button>
      </div>
      <div class="detail-review-host"><div class="review-pane-label">Source</div></div>`;
    document.body.append(host);
    const cs = (sel: string) => getComputedStyle(host.querySelector(sel)!);
    const result = {
      addBackground: cs('.diff-row-add').backgroundColor,
      addMark: cs('.diff-mark').color,
      delBackground: cs('.diff-row-del').backgroundColor,
      delMark: cs('.diff-row-del .diff-mark').color,
      findBackground: cs('.is-find-current').backgroundColor,
      hunkBackground: cs('.diff-row-hunk').backgroundColor,
      hunkColor: cs('.diff-row-hunk').color,
      controlColor: cs('.comment-control').color,
      controlBorder: cs('.comment-control').borderColor,
      labelBackground: cs('.review-pane-label').backgroundColor,
      labelColor: cs('.review-pane-label').color,
    };
    host.remove();
    return result;
  });
  expect(styles.addBackground).toBe('oklch(0.38 0.09 160)');
  expect(styles.addMark).toBe('oklch(0.76 0.13 160)');
  expect(styles.delBackground).toBe('oklch(0.29 0.06 25)');
  expect(styles.delMark).toBe('oklch(0.71 0.12 25)');
  expect(styles.findBackground).toBe('oklch(0.36 0.03 260)');
  expect(styles.hunkBackground).toBe('oklch(0.24 0.02 260)');
  expect(styles.hunkColor).toBe('oklch(0.78 0.02 260)');
  expect(styles.controlColor).toBe('oklch(0.78 0.02 260)');
  expect(styles.controlBorder).toBe('oklch(0.43 0.03 260)');
  expect(styles.labelBackground).toBe('oklch(0.24 0.02 260)');
  expect(styles.labelColor).toBe('oklch(0.94 0.01 260)');
});

for (const kind of ['handoff', 'review']) {
  test(`${kind} card header keeps a dark hover surface`, async ({ page }) => {
    await page.addInitScript(() => { (window as any).__INBOX_FIXTURE = {}; });
    await page.goto('/inbox-harness.html');
    await page.getByRole('button', { name: 'Dark mode' }).click();
    await page.evaluate(kind => {
      const card = document.createElement('article');
      card.className = 'thread-card';
      card.innerHTML = `<article class="detail-${kind}"><header class="detail-header">Example</header></article>`;
      document.querySelector('#pane-detail')!.append(card);
    }, kind);
    const header = page.locator(`.thread-card .detail-${kind} > .detail-header`);
    await header.hover();
    await expect(header).toHaveCSS('background-color', 'oklch(0.18 0.02 260)');
  });
}
