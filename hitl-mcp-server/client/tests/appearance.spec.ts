import { expect, test } from '@playwright/test';
import { unreadableText } from './appearance-contrast.js';

test.use({ viewport: { width: 1100, height: 850 } });

for (const [name, url] of [
  ['question', '/test-harness.html'],
  ['notifications', '/notifications-harness.html?notification=' + encodeURIComponent(JSON.stringify({
    messageId: 'theme', title: 'A notification', body: '## Report\n\nText and **bold**, [link](https://example.com), `code`.\n\n```\ncode text\n```\n\n> Note',
    timestamp: 1786600000000, context: 'A useful context',
  }))],
  ['review', '/review-harness.html'],
  ['expired review', '/review-harness.html?state=expired'],
]) {
  test(`${name} has readable dark text`, async ({ page }) => {
    await page.goto(url);
    await page.waitForTimeout(400);
    await page.evaluate(async () => (await import('/theme.js')).applyAppearance('dark'));
    await page.addStyleTag({ content: '*, *::before, *::after { animation: none !important; transition: none !important; }' });
    expect(await unreadableText(page)).toEqual([]);
    await expect(page.locator('#appearance-warning')).toHaveCount(0);
  });
}

test('theme switching preserves a review draft and selected view', async ({ page }) => {
  await page.goto('/review-harness.html');
  const feedback = page.locator('#overall-feedback');
  await feedback.fill('Keep this unfinished feedback');
  await feedback.focus();
  const before = await feedback.evaluate((el: HTMLTextAreaElement) => {
    el.setSelectionRange(5, 12);
    return { start: el.selectionStart, end: el.selectionEnd };
  });
  await page.evaluate(async () => {
    const { applyAppearance } = await import('/theme.js');
    for (let i = 0; i < 10; i++) { applyAppearance('dark'); applyAppearance('light'); }
  });
  await expect(feedback).toHaveValue('Keep this unfinished feedback');
  await expect(feedback).toBeFocused();
  expect(await feedback.evaluate((el: HTMLTextAreaElement) => ({ start: el.selectionStart, end: el.selectionEnd }))).toEqual(before);
  expect(await page.evaluate(() => (window as any).__lastSubmit)).toBeUndefined();
});

test('native bootstrap is applied before first page content without OS preference', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/review-harness.html');
  await expect(page.locator('html')).not.toHaveAttribute('data-hitl-theme', 'dark');
  await page.addInitScript(() => { (window as any).__HITL_THEME__ = 'dark'; });
  // A real native host returns the same persisted preference after bootstrap.
  await page.route('**/review-harness.html', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: (await response.text()).replace("theme: 'light', warning: null", "theme: 'dark', warning: null") });
  });
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-hitl-theme', 'dark');
});

test('diagrams switch in place, including the expanded copy and authored colors', async ({ page }) => {
  await page.goto('/review-harness.html');
  await page.evaluate(async () => {
    const { renderPlanReview } = await import('/review.js');
    renderPlanReview(document.querySelector('#review-container'), {
      messageId: 'theme-diagrams', snapshotHash: 'hash', revision: 1, isNewPlan: true,
      body: { content: '```mermaid\nflowchart LR\nA[Start] --> B[Finish]\n```\n\n```plantuml\n@startuml\nAlice -> Bob: Hello\n@enduml\n```', diff: '' },
    }, { onSubmit() {} });
  });

  const diagrams = page.locator('.diagram-viewer');
  await expect(diagrams.nth(1).locator('img')).toBeVisible();
  await diagrams.first().getByRole('button', { name: 'Expand diagram' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Zoom in', exact: true }).click();
  const zoom = await dialog.locator('output').textContent();
  await page.evaluate(async () => (await import('/theme.js')).applyAppearance('dark'));
  await expect(diagrams.nth(1)).toHaveAttribute('data-render-theme', 'dark');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('output')).toHaveText(zoom!);
  for (const image of await diagrams.locator('img').all()) {
    const svg = decodeURIComponent((await image.getAttribute('src'))!);
    expect(svg).not.toMatch(/Syntax Error|Syntax error/);
  }
  await page.evaluate(async () => (await import('/theme.js')).applyAppearance('light'));
  await expect(diagrams.nth(1)).toHaveAttribute('data-render-theme', 'light');
  await expect(dialog).toBeVisible();
});

for (const view of ['Changes', 'Before & after', 'Source']) {
  test(`${view} keeps combined highlights and controls readable`, async ({ page }) => {
    await page.setViewportSize({ width: 700, height: 900 });
    await page.goto('/review-harness.html');
    await page.getByRole('tab', { name: view, exact: true }).click();
    await page.evaluate(async () => {
      (await import('/theme.js')).applyAppearance('dark');
      document.querySelector('.diff-row-add')?.classList.add('is-selected', 'is-find-current', 'has-comment');
      document.querySelector('.diff-row-del')?.classList.add('is-selected', 'is-find-match', 'has-comment');
      document.querySelector('.md-content [data-source-start]')?.classList.add('is-selected', 'is-find-current');
    });
    expect(await unreadableText(page)).toEqual([]);
  });
}

test('authored diagram colors are preserved with a safe light backing', async ({ page }) => {
  await page.goto('/review-harness.html');
  await page.evaluate(async () => {
    const { renderPlanReview } = await import('/review.js');
    renderPlanReview(document.querySelector('#review-container'), {
      messageId: 'custom', snapshotHash: 'hash', revision: 1, isNewPlan: true,
      body: { content: '```mermaid\nflowchart LR\nA --> B\nclassDef custom fill:#ffffff,color:#111111;\nclass A custom;\n```', diff: '' },
    }, { onSubmit() {} });
    (await import('/theme.js')).applyAppearance('dark');
  });
  const diagram = page.locator('.diagram-viewer');
  await expect(diagram).toHaveAttribute('data-render-theme', 'dark');
  await expect(diagram).toHaveAttribute('data-light-backing', 'true');
  await expect(diagram.locator('code')).toContainText('fill:#ffffff,color:#111111');
});

for (const [name, source] of [
  ['sequence', '@startuml\nAlice -> Bob: Review\n@enduml'],
  ['class', '@startuml\nclass Animal {\n+int age\n}\nAnimal <|-- Duck\n@enduml'],
  ['activity', '@startuml\nstart\n:Review;\n:Approve;\nstop\n@enduml'],
]) {
  test(`dark PlantUML ${name} uses readable default labels`, async ({ page }) => {
    await page.goto('/review-harness.html');
    await page.evaluate(async source => {
      (await import('/theme.js')).applyAppearance('dark');
      const { renderPlanReview } = await import('/review.js');
      renderPlanReview(document.querySelector('#review-container'), {
        messageId: 'puml-dark', snapshotHash: 'hash', revision: 1, isNewPlan: true,
        body: { content: '```plantuml\n' + source + '\n```', diff: '' },
      }, { onSubmit() {} });
    }, source);
    const image = page.locator('.diagram-viewer img');
    await expect(image).toBeVisible();
    const svg = decodeURIComponent((await image.getAttribute('src'))!).split(',').slice(1).join(',');
    expect(svg).not.toMatch(/Syntax Error|Syntax error/);
    const colors = await page.evaluate(svg => {
      const xml = new DOMParser().parseFromString(svg, 'image/svg+xml');
      return [...xml.querySelectorAll('text')].filter(text => text.textContent?.trim())
        .map(text => text.getAttribute('fill')?.toLowerCase());
    }, svg);
    expect(colors.length).toBeGreaterThan(0);
    expect(colors.every(color => color === '#e7edf5')).toBe(true);
    await page.getByRole('button', { name: 'Expand diagram' }).click();
    await page.screenshot({ path: test.info().outputPath(`dark-${name}.png`) });
  });
}

test('contrast checker detects opacity and foreground/background failures', async ({ page }) => {
  await page.setContent('<p style="color:black;background:white">Readable</p>');
  expect(await unreadableText(page)).toEqual([]);
  await page.setContent('<div style="background:white"><p style="color:black;opacity:.1">Faded</p></div>');
  expect(await unreadableText(page)).toHaveLength(1);
  await page.setContent('<p style="color:rgb(30,30,30);background:rgb(35,35,35)">Hidden</p>');
  expect(await unreadableText(page)).toHaveLength(1);
});

test('disabled verdict buttons remain readable rather than fading text on accent fills', async ({ page }) => {
  await page.goto('/review-harness.html');
  await page.evaluate(async () => {
    (await import('/theme.js')).applyAppearance('dark');
    document.querySelectorAll('button').forEach(button => { button.disabled = true; });
  });
  expect(await unreadableText(page)).toEqual([]);
});
