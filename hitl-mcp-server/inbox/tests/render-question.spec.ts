import { test, expect } from '@playwright/test';
import { MINUTE, NOW, detail, message } from './fixtures.js';
import { mount, recorded } from './mount.js';

// Pane 3, questions (spec §8.2).
//
// Two shapes behind one renderer — a single question, and a batch of up to four
// behind a stepper — plus the settled form, which is the same DOM with the
// controls locked and the winning answer marked.

const SINGLE = {
  question: 'Which storage backend?',
  context: 'Picking between SQLite and a flat file for the local projection.',
  allowMultiple: false,
  allowOther: true,
  options: [
    { label: 'SQLite', value: 'sqlite', description: 'Indexed, transactional', preview: 'CREATE TABLE events (…)' },
    { label: 'Flat file', value: 'flat', description: 'One JSON per line', preview: '{"id":1}\n{"id":2}' },
  ],
};

const BATCH = {
  context: 'Three decisions before I start.',
  questions: [
    {
      header: 'Storage',
      question: 'Which storage backend?',
      allowMultiple: false,
      options: [{ label: 'SQLite', value: 'sqlite' }, { label: 'Flat file', value: 'flat' }],
    },
    {
      header: 'Runtime',
      question: 'Which runtimes must it support?',
      allowMultiple: true,
      options: [{ label: 'Node 18', value: 'n18' }, { label: 'Node 20', value: 'n20' }],
    },
    {
      header: 'Rollout',
      question: 'Ship behind a flag?',
      allowMultiple: false,
      allowOther: false,
      options: [{ label: 'Yes', value: 'yes' }, { label: 'No', value: 'no' }],
    },
  ],
};

function pending(request: Record<string, unknown>, over = {}) {
  return detail(
    message({ messageId: 'q-1', msgType: 'question', title: 'Which storage backend?', ...over }),
    { request },
  );
}

test.describe('Pane 3 — a single question (spec §8.2)', () => {
  // Reported from a screenshot: the radio sat "almost a line above" its label.
  //
  // Two causes, and neither was the radio. `align-items: flex-start` top-aligns
  // a 13px control against a 22.4px line box, and `.md-content p` (review.css,
  // generated from the client) gives the label's wrapping `<p>` a 6px top margin
  // that collapses through the label and drags it down 6px more.
  //
  // Asserted as a geometric relationship rather than as fixed coordinates, so
  // this still holds if the font, the padding or the line-height change — and
  // still fails if either cause comes back.
  test('the control is centred on its label, not floating above it', async ({ page }) => {
    await mount(page, 'question', pending(SINGLE));

    for (const label of ['SQLite', 'Flat file']) {
      const offset = await page
        .locator('.option', { hasText: label })
        .evaluate(option => {
          const centre = (el: Element) => {
            const box = el.getBoundingClientRect();
            return box.top + box.height / 2;
          };
          const text = option.querySelector('.option-label')!;
          // The label's own box is its first line: the description is a sibling.
          return centre(option.querySelector('input')!) - centre(text);
        });

      expect(Math.abs(offset), `radio is off-centre against "${label}" by ${offset}px`).toBeLessThan(1);
    }
  });

  test('renders the context, radio options and the additional-context field', async ({ page }) => {
    await mount(page, 'question', pending(SINGLE));

    await expect(page.locator('.detail-kicker')).toHaveText('Question');
    await expect(page.locator('.detail-root')).toHaveAttribute('data-mode', 'single');

    await page.locator('.detail-context-toggle').click();
    await expect(page.locator('.detail-context-body')).toContainText('SQLite and a flat file');

    await expect(page.locator('.option')).toHaveCount(2);
    await expect(page.locator('.option input[type="radio"]')).toHaveCount(2);
    await expect(page.locator('.option-description').first()).toHaveText('Indexed, transactional');
    await expect(page.locator('.other-input')).toBeVisible();
  });

  test('allowMultiple swaps radios for checkboxes and submits every choice', async ({ page }) => {
    await mount(page, 'question', pending({ ...SINGLE, allowMultiple: true }), { wire: true });

    await expect(page.locator('.option input[type="checkbox"]')).toHaveCount(2);
    await page.locator('.option', { hasText: 'SQLite' }).click();
    await page.locator('.option', { hasText: 'Flat file' }).click();
    await page.locator('.button', { hasText: 'Submit Response' }).click();

    const [submitted] = await recorded(page);
    expect(submitted.selectedValues).toEqual(['sqlite', 'flat']);
  });

  test('the preview panel follows the focused option, single-select only', async ({ page }) => {
    // With checkboxes there is no one option the panel could be about, which is
    // the same rule dialog.js follows.
    await mount(page, 'question', pending(SINGLE));

    await expect(page.locator('.preview-panel')).toBeVisible();
    await expect(page.locator('.preview-content')).toContainText('CREATE TABLE');

    await page.locator('.option', { hasText: 'Flat file' }).click();
    await expect(page.locator('.preview-content')).toContainText('{"id":1}');

    await mount(page, 'question', pending({ ...SINGLE, allowMultiple: true }));
    await expect(page.locator('.preview-panel')).toHaveCount(0);
  });

  test('Ctrl+Enter in the additional-context field submits', async ({ page }) => {
    await mount(page, 'question', pending(SINGLE), { wire: true });

    await page.locator('.option', { hasText: 'SQLite' }).click();
    await page.locator('.other-input').fill('Prefer whatever survives a crash mid-write.');
    await page.locator('.other-input').press('Control+Enter');

    const [submitted] = await recorded(page);
    expect(submitted.action).toBe('submit');
    expect(submitted.selectedValues).toEqual(['sqlite']);
    expect(submitted.otherText).toBe('Prefer whatever survives a crash mid-write.');
  });

  test('an empty response is refused rather than sent', async ({ page }) => {
    await mount(page, 'question', pending(SINGLE), { wire: true });

    // Nothing is preselected — the preview panel shows the first option's
    // preview without checking its radio, so an undecided reader stays
    // undecided rather than having the first option submitted on their behalf.
    await expect(page.locator('.option input:checked')).toHaveCount(0);
    await page.locator('.button', { hasText: 'Submit Response' }).click();

    await expect(page.locator('.detail-error')).toBeVisible();
    expect(await recorded(page)).toEqual([]);
  });

  test('Skip and Submit are disabled while the reply path is not attached', async ({ page }) => {
    await mount(page, 'question', pending(SINGLE));

    await expect(page.locator('.button', { hasText: 'Skip' })).toBeDisabled();
    await expect(page.locator('.button', { hasText: 'Submit Response' })).toBeDisabled();
  });
});

test.describe('Pane 3 — a batch question (spec §8.2)', () => {
  const BATCHED = pending(BATCH, { title: '3 questions', badges: { batchCount: 3 } as any });

  test('one sub-question at a time, with its header as the chip', async ({ page }) => {
    await mount(page, 'question', BATCHED);

    await expect(page.locator('.detail-root')).toHaveAttribute('data-mode', 'batch');
    await expect(page.locator('.stepper-tab')).toHaveCount(3);
    await expect(page.locator('.stepper-tab').first()).toHaveText('Storage');

    await expect(page.locator('.sub-question[data-index="0"]')).toBeVisible();
    await expect(page.locator('.sub-question[data-index="1"]')).toBeHidden();

    await page.locator('.stepper-tab', { hasText: 'Runtime' }).click();
    await expect(page.locator('.sub-question[data-index="0"]')).toBeHidden();
    await expect(page.locator('.sub-question[data-index="1"]')).toBeVisible();
    // Per-question allowMultiple, not one setting for the whole batch.
    await expect(page.locator('.sub-question[data-index="1"] input[type="checkbox"]')).toHaveCount(2);
  });

  test('Next walks the batch and the last step submits every answer', async ({ page }) => {
    await mount(page, 'question', BATCHED, { wire: true });

    await page.locator('.sub-question[data-index="0"] .option', { hasText: 'SQLite' }).click();
    await expect(page.locator('.button', { hasText: 'Previous' })).toBeHidden();
    await page.locator('.button', { hasText: 'Next' }).click();

    await page.locator('.sub-question[data-index="1"] .option', { hasText: 'Node 20' }).click();
    await page.locator('.sub-question[data-index="1"] .other-input').fill('Node 18 is EOL in October.');
    await page.locator('.button', { hasText: 'Next' }).click();

    await page.locator('.sub-question[data-index="2"] .option', { hasText: 'Yes' }).click();
    // allowOther:false on this one, so there is no field to fill.
    await expect(page.locator('.sub-question[data-index="2"] .other-input')).toHaveCount(0);

    await page.locator('.button', { hasText: 'Submit Response' }).click();

    const [submitted] = await recorded(page);
    expect(submitted.subAnswers).toEqual([
      { questionIndex: 0, questionText: 'Which storage backend?', selectedValues: ['sqlite'], responseType: 'selection' },
      {
        questionIndex: 1,
        questionText: 'Which runtimes must it support?',
        selectedValues: ['n20'],
        otherText: 'Node 18 is EOL in October.',
        responseType: 'selection_with_context',
      },
      { questionIndex: 2, questionText: 'Ship behind a flag?', selectedValues: ['yes'], responseType: 'selection' },
    ]);
  });

  test('answered steps are marked so a half-finished batch is visible', async ({ page }) => {
    await mount(page, 'question', BATCHED, { wire: true });

    await page.locator('.sub-question[data-index="0"] .option', { hasText: 'SQLite' }).click();
    await page.locator('.stepper-tab', { hasText: 'Runtime' }).click();

    await expect(page.locator('.stepper-tab', { hasText: 'Storage' })).toHaveClass(/answered/);
    await expect(page.locator('.stepper-tab', { hasText: 'Rollout' })).not.toHaveClass(/answered/);
  });
});

test.describe('Pane 3 — an answered question (spec §8.2)', () => {
  test('locks the selection and says who answered, and when', async ({ page }) => {
    await mount(page, 'question', detail(
      message({
        messageId: 'q-1',
        msgType: 'question',
        title: 'Which storage backend?',
        status: 'answered',
        responder: 'Kay9 phone',
        respondedAt: NOW - MINUTE,
      }),
      {
        request: SINGLE,
        settlement: { selectedValues: ['flat'], otherText: 'Simpler to debug.' },
      },
    ));

    await expect(page.locator('.detail-closed-verb')).toHaveText('Answered by');
    await expect(page.locator('.detail-responder')).toHaveText('Kay9 phone');
    await expect(page.locator('.detail-closed-at')).not.toBeEmpty();

    // The selection is shown as the same control it was answered with, marked
    // and disabled — not swapped for a different read-only widget that could
    // disagree with it.
    const chosen = page.locator('.option.is-chosen');
    await expect(chosen).toHaveCount(1);
    await expect(chosen).toHaveAttribute('data-value', 'flat');
    await expect(page.locator('.option input:not(:disabled)')).toHaveCount(0);

    await expect(page.locator('.other-answered-text')).toHaveText('Simpler to debug.');
    await expect(page.locator('.other-input')).toHaveCount(0);
    await expect(page.locator('.detail-actions .button')).toHaveCount(0);
    await expect(page.locator('.detail-retained')).toContainText('what the agent received');
  });

  test('a lost race says so rather than showing your answer as the answer', async ({ page }) => {
    // Spec §9.3. "Answered" alone would let someone believe the agent acted on
    // what they sent.
    await mount(page, 'question', detail(
      message({
        messageId: 'q-1',
        msgType: 'question',
        status: 'lost',
        responder: 'Kay9 desktop',
        respondedAt: NOW - MINUTE,
      }),
      { request: SINGLE, settlement: { selectedValues: ['sqlite'] } },
    ));

    await expect(page.locator('.detail-closed-verb')).toHaveText('Answered first by');
    await expect(page.locator('.detail-lost-note')).toContainText('lost the race');
  });

  test('an answered batch marks each sub-question with its own answer', async ({ page }) => {
    await mount(page, 'question', detail(
      message({
        messageId: 'q-2',
        msgType: 'question',
        title: '3 questions',
        status: 'answered',
        responder: 'Kay9 laptop',
        respondedAt: NOW - MINUTE,
      }),
      {
        request: BATCH,
        settlement: {
          subAnswers: [
            { questionIndex: 0, selectedValues: ['flat'] },
            { questionIndex: 1, selectedValues: ['n18', 'n20'], otherText: 'Both, for now.' },
            { questionIndex: 2, selectedValues: ['no'] },
          ],
        },
      },
    ));

    await expect(page.locator('.sub-question[data-index="0"] .option.is-chosen')).toHaveAttribute('data-value', 'flat');
    await page.locator('.stepper-tab', { hasText: 'Runtime' }).click();
    await expect(page.locator('.sub-question[data-index="1"] .option.is-chosen')).toHaveCount(2);
    await expect(page.locator('.sub-question[data-index="1"] .other-answered-text')).toHaveText('Both, for now.');
    await expect(page.locator('.detail-actions .button')).toHaveCount(0);
  });
});
