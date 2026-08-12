import { test, expect, type Page } from '@playwright/test';

// Helpers
const batchUrl = '/test-harness.html?scenario=batch';
const singleUrl = '/test-harness.html';
const previewUrl = '/test-harness.html?scenario=preview';

function tab(page: Page, label: string) {
  return page.locator('.stepper-tab', { hasText: label });
}

// ─── Batch stepper: rendering ────────────────────────────────────────────────

test.describe('Batch stepper rendering', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(batchUrl);
  });

  test('renders stepper tabs for each sub-question', async ({ page }) => {
    const tabs = page.locator('.stepper-tab');
    await expect(tabs).toHaveCount(3);
    await expect(tabs.nth(0)).toHaveText('Priority');
    await expect(tabs.nth(1)).toHaveText('Deploy');
    await expect(tabs.nth(2)).toHaveText('Test Envs');
  });

  test('first tab is active on load', async ({ page }) => {
    await expect(tab(page, 'Priority')).toHaveClass(/active/);
    await expect(tab(page, 'Deploy')).not.toHaveClass(/active/);
    await expect(tab(page, 'Test Envs')).not.toHaveClass(/active/);
  });

  test('only first sub-question is visible on load', async ({ page }) => {
    const steps = page.locator('.sub-question');
    await expect(steps.nth(0)).toBeVisible();
    await expect(steps.nth(1)).toBeHidden();
    await expect(steps.nth(2)).toBeHidden();
  });

  test('shows Skip and Next buttons on first step', async ({ page }) => {
    await expect(page.locator('#btn-skip')).toBeVisible();
    await expect(page.locator('#btn-next')).toHaveText('Next');
    await expect(page.locator('#btn-prev')).toBeHidden();
  });
});

// ─── Batch stepper: navigation ───────────────────────────────────────────────

test.describe('Batch stepper navigation', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(batchUrl);
  });

  test('Next button advances to second step', async ({ page }) => {
    await page.locator('#btn-next').click();

    // Step 2 visible, others hidden
    await expect(page.locator('.sub-question').nth(0)).toBeHidden();
    await expect(page.locator('.sub-question').nth(1)).toBeVisible();
    await expect(page.locator('.sub-question').nth(2)).toBeHidden();

    // Deploy tab is active
    await expect(tab(page, 'Deploy')).toHaveClass(/active/);
    await expect(tab(page, 'Priority')).not.toHaveClass(/active/);
  });

  test('footer buttons update per step', async ({ page }) => {
    // Step 1: Skip visible, Previous hidden, Next
    await expect(page.locator('#btn-skip')).toBeVisible();
    await expect(page.locator('#btn-prev')).toBeHidden();
    await expect(page.locator('#btn-next')).toHaveText('Next');

    // Step 2: Skip hidden, Previous visible, Next
    await page.locator('#btn-next').click();
    await expect(page.locator('#btn-skip')).toBeHidden();
    await expect(page.locator('#btn-prev')).toBeVisible();
    await expect(page.locator('#btn-next')).toHaveText('Next');

    // Step 3 (last): Previous visible, Submit Response
    await page.locator('#btn-next').click();
    await expect(page.locator('#btn-skip')).toBeHidden();
    await expect(page.locator('#btn-prev')).toBeVisible();
    await expect(page.locator('#btn-next')).toHaveText('Submit Response');
  });

  test('Previous button goes back', async ({ page }) => {
    await page.locator('#btn-next').click();
    await page.locator('#btn-prev').click();

    await expect(page.locator('.sub-question').nth(0)).toBeVisible();
    await expect(page.locator('.sub-question').nth(1)).toBeHidden();
    await expect(tab(page, 'Priority')).toHaveClass(/active/);
  });

  test('tab click navigates to any step', async ({ page }) => {
    await tab(page, 'Test Envs').click();

    await expect(page.locator('.sub-question').nth(0)).toBeHidden();
    await expect(page.locator('.sub-question').nth(1)).toBeHidden();
    await expect(page.locator('.sub-question').nth(2)).toBeVisible();
    await expect(tab(page, 'Test Envs')).toHaveClass(/active/);
    await expect(page.locator('#btn-next')).toHaveText('Submit Response');
  });
});

// ─── Batch stepper: answered state ───────────────────────────────────────────

test.describe('Batch stepper answered state', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(batchUrl);
  });

  test('tab shows answered class after selecting an option and navigating away', async ({ page }) => {
    // Select an option on step 1
    await page.locator('.sub-question').nth(0).locator('.option').first().click();
    // Navigate away
    await page.locator('#btn-next').click();

    await expect(tab(page, 'Priority')).toHaveClass(/answered/);
    await expect(tab(page, 'Priority')).not.toHaveClass(/active/);
  });

  test('tab does not show answered class if nothing selected', async ({ page }) => {
    // Navigate away without selecting
    await page.locator('#btn-next').click();

    await expect(tab(page, 'Priority')).not.toHaveClass(/answered/);
  });

  test('typing in textarea marks step as answered', async ({ page }) => {
    await page.locator('.sub-question').nth(0).locator('.other-input').fill('some context');
    await page.locator('#btn-next').click();

    await expect(tab(page, 'Priority')).toHaveClass(/answered/);
  });
});

// ─── Batch stepper: selection persistence ────────────────────────────────────

test.describe('Batch stepper selection persistence', () => {
  test('selections are preserved when navigating between steps', async ({ page }) => {
    await page.goto(batchUrl);

    // Select "New features" on step 1
    await page.locator('.sub-question').nth(0).locator('.option').nth(1).click();
    const radio = page.locator('input[name="options-0"]').nth(1);
    await expect(radio).toBeChecked();

    // Navigate to step 2 and back
    await page.locator('#btn-next').click();
    await page.locator('#btn-prev').click();

    // Selection still there
    await expect(radio).toBeChecked();
  });
});

// ─── Batch stepper: submit ───────────────────────────────────────────────────

test.describe('Batch stepper submit', () => {
  test('collects all sub-answers on submit', async ({ page }) => {
    await page.goto(batchUrl);

    // Step 1: select "features"
    await page.locator('.sub-question').nth(0).locator('.option').nth(1).click();
    await page.locator('#btn-next').click();

    // Step 2: select "auto"
    await page.locator('.sub-question').nth(1).locator('.option').nth(1).click();
    await page.locator('#btn-next').click();

    // Step 3: select "dev" and "staging" (checkboxes)
    await page.locator('.sub-question').nth(2).locator('.option').nth(0).click();
    await page.locator('.sub-question').nth(2).locator('.option').nth(1).click();

    // Submit
    await page.locator('#btn-next').click();

    // Verify success screen
    await expect(page.locator('.success-title')).toHaveText('Response submitted successfully!');

    // Verify payload
    const payload = await page.evaluate(() => (window as any).__lastSubmit);
    expect(payload.selected).toEqual([]);
    expect(payload.subAnswers).toHaveLength(3);
    expect(payload.subAnswers[0].selectedValues).toEqual(['features']);
    expect(payload.subAnswers[1].selectedValues).toEqual(['auto']);
    expect(payload.subAnswers[2].selectedValues).toEqual(['dev', 'staging']);
  });

  test('shows error when no answers provided', async ({ page }) => {
    await page.goto(batchUrl);

    // Navigate to last step without answering anything
    await page.locator('#btn-next').click();
    await page.locator('#btn-next').click();

    // Click Submit Response
    await page.locator('#btn-next').click();

    await expect(page.locator('#error-message')).toBeVisible();
    await expect(page.locator('#error-message')).toHaveText('Please answer at least one question');
  });

  test('skip button works on first step', async ({ page }) => {
    await page.goto(batchUrl);
    await page.locator('#btn-skip').click();

    await expect(page.locator('.success-title')).toHaveText('Skipped');

    const skipped = await page.evaluate(() => (window as any).__lastSkip);
    expect(skipped).toBe(true);
  });
});

// ─── Single question: unaffected ─────────────────────────────────────────────

test.describe('Single question mode unaffected', () => {
  test('no stepper tabs in single mode', async ({ page }) => {
    await page.goto(singleUrl);

    await expect(page.locator('.stepper-tabs')).toHaveCount(0);
    await expect(page.locator('#btn-submit')).toBeVisible();
    await expect(page.locator('#btn-skip')).toBeVisible();
    await expect(page.locator('#btn-next')).toHaveCount(0);
  });

  test('single question submit works', async ({ page }) => {
    await page.goto(singleUrl);

    await page.locator('.option').nth(1).click();
    await page.locator('#btn-submit').click();

    await expect(page.locator('.success-title')).toHaveText('Response submitted successfully!');

    const payload = await page.evaluate(() => (window as any).__lastSubmit);
    expect(payload.selected).toEqual(['graphql']);
  });
});

// ─── Submit failure through app.js (C-6 / P3) ────────────────────────────────

// ?driver=app routes the fixture through app.js's own submit/skip handlers
// rather than the harness's, so this covers the shipping AskUserQuestion path.

test.describe('Submit failure keeps the answer', () => {
  test('a failed submit shows an error and preserves the typed answer', async ({ page }) => {
    await page.goto('/test-harness.html?scenario=single&driver=app&fail=1');

    await page.locator('.option').nth(1).click();
    await page.locator('#other-input').fill('some extra context');
    await page.locator('#btn-submit').click();

    // Previously this was caught with console.error alone — which release
    // builds discard on Windows — so the click produced no feedback at all
    // while the agent stayed blocked waiting for an answer that never left.
    await expect(page.locator('#error-message')).toBeVisible();
    await expect(page.locator('#error-message')).toContainText('Could not send your answer');
    await expect(page.locator('.success-title')).toHaveCount(0);

    // Everything the human chose and typed is still there for a retry.
    await expect(page.locator('input[name="options"]').nth(1)).toBeChecked();
    await expect(page.locator('#other-input')).toHaveValue('some extra context');
    await expect(page.locator('#btn-submit')).toBeVisible();
    expect(await page.evaluate(() => (window as any).__windowClosed)).toBeUndefined();
  });

  test('a failed skip is reported instead of silently succeeding', async ({ page }) => {
    await page.goto('/test-harness.html?scenario=single&driver=app&fail=1');
    await page.locator('#btn-skip').click();

    await expect(page.locator('#error-message')).toContainText('Could not send the skip');
    await expect(page.locator('.success-title')).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).__windowClosed)).toBeUndefined();
  });

  test('a successful submit through app.js still shows the success screen', async ({ page }) => {
    await page.goto('/test-harness.html?scenario=single&driver=app');

    await page.locator('.option').nth(1).click();
    await page.locator('#btn-submit').click();

    await expect(page.locator('.success-title')).toHaveText('Response submitted successfully!');
    await expect(page.locator('#error-message')).toBeHidden();
    const call = await page.evaluate(() => (window as any).__lastInvoke);
    expect(call.cmd).toBe('submit_answer');
    expect(call.args.selectedValues).toEqual(['graphql']);
  });
});

// ─── Payload handoff over IPC (W2.5 / W3.2) ──────────────────────────────────

test.describe('Question payload comes from take_window_payload', () => {
  test('the question renders from the staged payload, not the URL', async ({ page }) => {
    await page.goto('/test-harness.html?scenario=single&driver=app');

    // The fixture's own options prove the staged payload was what rendered.
    await expect(page.locator('.option')).not.toHaveCount(0);
    await expect(page.locator('#btn-submit')).toBeVisible();
    // The whole point of the move: a large question no longer has to survive
    // query-string encoding, and never lands anywhere that logs URLs.
    expect(page.url()).not.toContain('question=');

    // Taken without consuming — the entry stays for the window's lifetime so a
    // reload can ask again.
    expect(await page.evaluate(() => sessionStorage.getItem('__stagedPayload'))).not.toBeNull();
    expect(await page.evaluate(() => Number(sessionStorage.getItem('__payloadReads')))).toBe(1);
  });

  test('a window with nothing staged explains itself instead of spinning forever', async ({ page }) => {
    await page.goto('/test-harness.html?scenario=single&driver=app&nopayload=1');

    // The default markup is a "Waiting for question..." spinner, which is
    // indistinguishable from a hang — and the agent is blocked the whole time.
    await expect(page.locator('#dialog-container')).toContainText('Could not load the question');
    await expect(page.locator('.spinner')).toHaveCount(0);
  });

  test('the question survives a reload', async ({ page }) => {
    // The shipping path, and the one with real users on it. A read-once store
    // turned any refresh — or a WebView2 renderer crash and recover — into a
    // permanently blank dialog with the question already consumed, while the
    // agent stayed blocked waiting for an answer.
    await page.goto('/test-harness.html?scenario=single&driver=app');
    await expect(page.locator('.option')).not.toHaveCount(0);

    await page.reload();

    await expect(page.locator('.option')).not.toHaveCount(0);
    await expect(page.locator('#dialog-container')).not.toContainText('Could not load the question');
    expect(await page.evaluate(() => Number(sessionStorage.getItem('__payloadReads')))).toBe(2);

    // And it still answers, rather than merely rendering.
    await page.locator('.option').nth(1).click();
    await page.locator('#btn-submit').click();
    await expect(page.locator('.success-title')).toHaveText('Response submitted successfully!');
  });
});

// ─── Preview mode: unaffected ────────────────────────────────────────────────


test.describe('Preview mode unaffected', () => {
  test('no stepper tabs in preview mode', async ({ page }) => {
    await page.goto(previewUrl);

    await expect(page.locator('.stepper-tabs')).toHaveCount(0);
    await expect(page.locator('.preview-panel')).toBeVisible();
    await expect(page.locator('#btn-submit')).toBeVisible();
  });

  test('preview panel updates on option click', async ({ page }) => {
    await page.goto(previewUrl);

    // Click second option
    await page.locator('.option').nth(1).click();

    // Preview should contain "Top Nav" related content
    const previewText = await page.locator('.preview-content').textContent();
    expect(previewText).toContain('More vertical space');
  });
});
