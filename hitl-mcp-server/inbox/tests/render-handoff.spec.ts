import { test, expect } from '@playwright/test';
import { detail, message } from './fixtures.js';
import { applyRow, mount, recorded } from './mount.js';

// Pane 3, HandOff: an agent's end-of-work summary, a box for the next
// instruction and an End checkbox. The reply is an ordinary `answer`.

const REQUEST = {
  title: 'Inbox fix merged',
  summary: '**Outcome:** done\n\n**Did:**\n- merged the fix\n- 228 tests pass',
  context: 'Hitl_MCP: repaint freeze',
};

function pending(over = {}) {
  return detail(
    message({ messageId: 'h-1', msgType: 'handoff', title: 'Inbox fix merged', ...over }),
    { request: REQUEST },
  );
}

test.describe('Pane 3 — a handoff', () => {
  test('shows the context, the summary as markdown, a text box and an unchecked End checkbox', async ({ page }) => {
    await mount(page, 'handoff', pending(), { wire: true });

    await expect(page.locator('.detail-root')).toHaveClass(/detail-handoff/);
    await expect(page.locator('.handoff-summary strong').first()).toHaveText('Outcome:');
    await expect(page.locator('.handoff-summary li')).toHaveCount(2);
    await expect(page.locator('#handoff-next')).toBeVisible();
    await expect(page.locator('#handoff-end')).toHaveAttribute('type', 'checkbox');
    await expect(page.locator('#handoff-end')).not.toBeChecked();
    await expect(page.locator('input[type="radio"]')).toHaveCount(0);
  });

  test('typing an instruction unchecks End, and Send delivers the instruction', async ({ page }) => {
    await mount(page, 'handoff', pending(), { wire: true });

    await page.locator('.handoff-end').click();
    await expect(page.locator('#handoff-end')).toBeChecked();
    await page.locator('#handoff-next').fill('Now add a dedicated message type.');
    await expect(page.locator('#handoff-end')).not.toBeChecked();

    await page.locator('.button', { hasText: 'Send' }).click();
    const [sent] = await recorded(page);
    expect(sent).toMatchObject({
      action: 'submit',
      messageId: 'h-1',
      selectedValues: [],
      otherText: 'Now add a dedicated message type.',
    });
  });

  test('End alone sends the end value', async ({ page }) => {
    await mount(page, 'handoff', pending(), { wire: true });

    await page.locator('.handoff-end').click();
    await page.locator('.button', { hasText: 'Send' }).click();
    const [sent] = await recorded(page);
    expect(sent).toMatchObject({ action: 'submit', selectedValues: ['end'], otherText: '' });
  });

  test('Ctrl+Enter in the text box sends', async ({ page }) => {
    await mount(page, 'handoff', pending(), { wire: true });

    await page.locator('#handoff-next').fill('Run the release.');
    await page.locator('#handoff-next').press('Control+Enter');
    const [sent] = await recorded(page);
    expect(sent).toMatchObject({ selectedValues: [], otherText: 'Run the release.' });
  });

  test('an empty reply is refused rather than sent', async ({ page }) => {
    await mount(page, 'handoff', pending(), { wire: true });

    await page.locator('.button', { hasText: 'Send' }).click();
    await expect(page.locator('.detail-error')).toHaveText('Type your next instruction, or check End.');
    expect(await recorded(page)).toEqual([]);
  });

  test('a settled handoff shows the instruction that was sent, with no controls', async ({ page }) => {
    const settled = detail(
      message({ messageId: 'h-1', msgType: 'handoff', status: 'answered', responder: 'phone' }),
      { request: REQUEST, settlement: { selectedValues: [], otherText: 'Ship it.', skipped: false } },
    );
    await mount(page, 'handoff', settled, { wire: true });

    await expect(page.locator('.other-answered')).toContainText('Next instruction sent');
    await expect(page.locator('.other-answered-text')).toHaveText('Ship it.');
    await expect(page.locator('textarea, input')).toHaveCount(0);
    await expect(page.locator('.detail-retained')).toBeVisible();
  });

  test('settling elsewhere locks the form in place and keeps the typing', async ({ page }) => {
    await mount(page, 'handoff', pending(), { wire: true, myResponseId: null });

    await page.locator('#handoff-next').fill('half-typed instruction');
    await applyRow(page, message({
      messageId: 'h-1', msgType: 'handoff', status: 'answered', responder: 'phone', responseId: 'resp-other',
    }));

    await expect(page.locator('#handoff-next')).toBeDisabled();
    await expect(page.locator('#handoff-next')).toHaveValue('half-typed instruction');
    await expect(page.locator('.button', { hasText: 'Send' })).toHaveCount(0);
  });
});
