import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

const reportedWorkflow = `flowchart TB
    W["YOUR workflow file"] --> H["HOST<br/>Invoke · pass data · save · route"]
    H --> L["LLM + SKILLS<br/>Understand and act"]
    H --> S["SCRIPTS<br/>Repeatable operations"]
    classDef llm fill:#d7f2df,stroke:#397653,color:#102e1b;
    classDef script fill:#dcecff,stroke:#386aa0,color:#142d49;
    classDef host fill:#eef0f3,stroke:#586174,color:#17202e;
    class W,H host;
    class L llm;
    class S script;`;
const reportedReplacement = `flowchart TB
    A["RETIRE<br/>Fixed stage dispatcher"] --> D["REPLACE WITH<br/>Declared workflow"]
    B["RETIRE<br/>Task-specific agent wrappers"] --> E["REPLACE WITH<br/>Skills + contracts"]
    C["REMOVE POLICY<br/>Prose parsing · reply decisions<br/>Knowledge ranking · close sequence"] --> F["REPLACE WITH<br/>LLM decisions + declared steps"]`;

test('reported flowcharts render despite perl/css fences and preserve labels and source', async ({ page }) => {
  await review(page, '```perl\n' + reportedWorkflow + '\n```\n\n```css\n' + reportedReplacement + '\n```');
  const viewers = page.locator('#rendered-content .diagram-viewer');
  await expect(viewers).toHaveCount(2);
  for (let i = 0; i < 2; i++) {
    const viewer = viewers.nth(i);
    await expect(viewer.locator('img')).toBeVisible();
    const svg = decodeURIComponent((await viewer.locator('img').getAttribute('src'))!);
    const labelText = await page.evaluate(svg => {
      const xml = new DOMParser().parseFromString(svg.slice(svg.indexOf('<svg')), 'image/svg+xml');
      return Array.from(xml.querySelectorAll('text')).map(node => node.textContent).join(' ').replace(/\s/g, '');
    }, svg);
    expect(labelText).toContain(i === 0 ? 'YOURworkflowfile' : 'Fixedstagedispatcher');
    expect(svg).not.toContain('<foreignObject');
    await expect(viewer.locator('code')).toHaveText((i === 0 ? reportedWorkflow : reportedReplacement) + '\n');
  }
  await page.screenshot({ path: test.info().outputPath('reported-flowcharts.png'), fullPage: true });
});

test('ordinary CSS and Perl code stay code while an unlabelled flowchart renders', async ({ page }) => {
  await review(page, '```css\n.graph { color: red; }\n```\n\n```perl\nprint "flowchart TB";\n```\n\n```\nflowchart LR\nA --> B\n```');
  await expect(page.locator('#rendered-content .diagram-viewer img')).toBeVisible();
  await expect(page.locator('#rendered-content .diagram-viewer')).toHaveCount(1);
  await expect(page.locator('#rendered-content pre > code.language-css')).toBeVisible();
  await expect(page.locator('#rendered-content pre > code.language-perl')).toBeVisible();
});

test.beforeEach(async ({ page, baseURL }) => {
  const origin = new URL(baseURL!).origin;
  page.on('pageerror', error => console.log('Browser error:', error.message));
  // Tauri does NOT serve Access-Control-Allow-Origin: *. In particular, ES
  // modules in an opaque sandbox fail despite passing the normal test server.
  const csp = JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8')).app.security.csp;
  await page.route('**/*', async route => {
    if (new URL(route.request().url()).origin !== origin) return route.abort();
    const response = await route.fetch();
    const headers = { ...response.headers(), 'access-control-allow-origin': origin };
    if (route.request().resourceType() === 'document') headers['content-security-policy'] = csp;
    await route.fulfill({ response, headers });
  });
});

// Finish CSP-serving callbacks before Playwright closes the page. Some source
// fallback assertions finish while the renderer is still loading its assets.
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'wait' });
});

async function review(page: Page, content: string) {
  await page.goto('/review-harness.html');
  await page.evaluate(async content => {
    const { renderPlanReview } = await import('/review.js');
    renderPlanReview(document.querySelector('#review-container'), {
      messageId: 'diagram-test', snapshotHash: 'hash', revision: 1, isNewPlan: true,
      body: { content, diff: '' },
    }, { onSubmit() {} });
  }, content);
}

test('Mermaid and PlantUML render as readable diagrams with source anchors', async ({ page }) => {
  await review(page, '# Design\n\n```mermaid\nflowchart LR\n A[Start] --> B[Finish]\n```\n\n```plantuml\n@startuml\nAlice -> Bob : Hello\n@enduml\n```');
  const diagrams = page.locator('#rendered-content .diagram-viewer');
  await expect(diagrams).toHaveCount(2);
  await expect(diagrams.first().locator('img')).toBeVisible();
  await expect(diagrams.last().locator('img')).toBeVisible();
  expect(await diagrams.first().locator('img').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
  await expect(diagrams.first()).toHaveAttribute('data-source-start', '3');
  await expect(diagrams.first()).toHaveAttribute('data-source-end', '6');
  await diagrams.first().getByRole('button', { name: 'Zoom in', exact: true }).click();
  await expect(diagrams.first().locator('output')).toHaveText('125%');
  await diagrams.first().getByRole('button', { name: 'Expand diagram' }).click();
  await expect(page.getByRole('dialog', { name: 'Expanded diagram' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await diagrams.first().getByText('Diagram source', { exact: true }).click();
  await expect(diagrams.first().locator('code')).toContainText('A[Start]');
});

test('invalid diagrams retain their source and do not block following diagrams', async ({ page }) => {
  await review(page, '```mermaid\nnot a diagram\n```\n\n```mermaid\nsequenceDiagram\nAlice->>Bob: Hello\n```');
  await expect(page.locator('.diagram-error')).toContainText('Could not render');
  await expect(page.locator('.diagram-error').locator('..').locator('code')).toContainText('not a diagram');
  await expect(page.locator('#rendered-content .diagram-viewer img')).toBeVisible();
});

for (const [name, kind, source] of [
  ['Mermaid class', 'mermaid', 'classDiagram\nAnimal <|-- Duck\nAnimal : +int age'],
  ['Mermaid state', 'mermaid', 'stateDiagram-v2\n[*] --> Ready\nReady --> Done'],
  ['Mermaid ER', 'mermaid', 'erDiagram\nCUSTOMER ||--o{ ORDER : places'],
  ['PlantUML class', 'plantuml', '@startuml\nAnimal <|-- Duck\nclass Animal {\n+int age\n}\n@enduml'],
  ['PlantUML activity', 'puml', '@startuml\nstart\n:Read plan;\n:Approve;\nstop\n@enduml'],
]) {
  test(`${name} renders under the packaged app CSP`, async ({ page }) => {
    await review(page, '```' + kind + '\n' + source + '\n```');
    const image = page.locator('#rendered-content .diagram-viewer img');
    await expect(image).toBeVisible({ timeout: 12000 });
    const svg = await image.getAttribute('src');
    expect(decodeURIComponent(svg || '')).not.toMatch(/Syntax Error|Syntax error|An error has occurred/);
  });
}

test('external PlantUML includes remain source with an explanation', async ({ page }) => {
  await review(page, '```plantuml\n@startuml\n!include https://example.com/secret\n@enduml\n```');
  await expect(page.locator('.diagram-error')).toContainText('External includes are unavailable');
});

test('notification Markdown also gets diagram controls', async ({ page }) => {
  const notification = { messageId: 'diagram', title: 'Design', timestamp: Date.now(),
    body: '```mermaid\nflowchart LR\nA --> B\n```' };
  await page.goto('/notifications-harness.html?notification=' + encodeURIComponent(JSON.stringify(notification)));
  await expect(page.locator('.notification-body .diagram-viewer img')).toBeVisible();
});

test('question previews render diagrams after changing the selected option', async ({ page }) => {
  await page.goto('/test-harness.html');
  await page.evaluate(async () => {
    const { renderDialog } = await import('/dialog.js');
    renderDialog(document.querySelector('#dialog-container'), {
      question: 'Choose a design', options: [
        { label: 'First', value: 'one', preview: '```mermaid\nflowchart LR\nA --> B\n```' },
        { label: 'Second', value: 'two', preview: '```mermaid\nclassDiagram\nAnimal <|-- Duck\n```' },
      ],
    }, { onSubmit() {}, onSkip() {} });
  });
  await expect(page.locator('.diagram-viewer img')).toBeVisible();
  await page.getByText('Second', { exact: true }).click();
  await expect(page.locator('.diagram-viewer img')).toBeVisible();
  await expect(page.locator('.diagram-viewer code')).toContainText('Animal');
});

test('expanded diagrams close when the owning review is removed', async ({ page }) => {
  await review(page, '```mermaid\nflowchart LR\nA --> B\n```');
  await page.getByRole('button', { name: 'Expand diagram' }).click();
  await page.evaluate(() => document.querySelector('#review-container')?.replaceChildren());
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('diagram source remains commentable at the original fence lines', async ({ page }) => {
  await review(page, '# Heading\n\n```mermaid\nflowchart LR\nA --> B\n```');
  await expect(page.locator('.diagram-viewer img')).toBeVisible();
  await page.getByText('Diagram source', { exact: true }).click();
  await page.evaluate(() => {
    const code = document.querySelector('.diagram-viewer code')!;
    const range = document.createRange(); range.selectNodeContents(code);
    window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range);
    code.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  });
  await expect(page.locator('#comment-rendered-selection')).toBeEnabled();
  await page.locator('#comment-rendered-selection').click();
  await page.locator('#comment-input').fill('Check this transition');
  await page.locator('#comment-add').click();
  await expect(page.locator('#comment-list')).toContainText('3');
  await expect(page.locator('#comment-list')).toContainText('6');
});

test('expanded diagrams fit a phone screen and remain readable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await review(page, '```mermaid\nflowchart TD\nA[Read the plan] --> B{Changes needed?}\nB -->|Yes| C[Add a comment]\nB -->|No| D[Approve]\nC --> A\n```');
  await page.getByRole('button', { name: 'Expand diagram' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.locator('img')).toBeVisible();
  expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath('phone-diagram.png') });
  await page.getByRole('button', { name: 'Actual size' }).last().click();
  await page.getByRole('button', { name: 'Fit diagram' }).last().click();
  await expect(dialog.locator('img')).toBeInViewport();
});

test('lazy Before and after view also renders diagrams', async ({ page }) => {
  await review(page, '```mermaid\nclassDiagram\nReviewer --> Plan : reviews\n```');
  await page.getByRole('tab', { name: 'Before & after' }).click();
  await expect(page.locator('#after-content .diagram-viewer img')).toBeVisible();
});

test('Fit accounts for the height of tall diagrams in expanded view', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 600 });
  await review(page, '```mermaid\nflowchart TD\n' + Array.from({ length: 80 }, (_, i) => `N${i} --> N${i + 1}`).join('\n') + '\n```');
  await page.getByRole('button', { name: 'Expand diagram' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Fit diagram' }).click();
  await expect.poll(() => dialog.locator('.diagram-viewport').evaluate(node => node.scrollHeight <= node.clientHeight + 1)).toBe(true);
  const width = await dialog.locator('img').evaluate(image => image.getBoundingClientRect().width);
  await dialog.getByRole('button', { name: 'Zoom out' }).click();
  expect(await dialog.locator('img').evaluate(image => image.getBoundingClientRect().width)).toBeLessThan(width);
});
