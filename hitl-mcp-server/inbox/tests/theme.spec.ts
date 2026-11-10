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
