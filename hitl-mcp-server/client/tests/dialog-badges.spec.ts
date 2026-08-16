import { test, expect } from '@playwright/test';

// The sender badge must be prominent: outside any collapsible section, visible
// in the initial viewport with no scrolling/expanding, and truncated with an
// ellipsis + title attribute rather than wrapping or overflowing layout — so
// the human is never confused about which machine/agent sent a question.

const SENDER = { label: 'Kay9 - work-item/1-reviewplan', source: 'worktree' };

function fixtureUrl(question: Record<string, unknown>) {
  return `/test-harness.html?question=${encodeURIComponent(JSON.stringify(question))}`;
}

function baseQuestion(overrides: Record<string, unknown> = {}) {
  return Object.assign({
    messageId: 'test-sender-001',
    type: 'question',
    repo: { name: 'Hitl_MCP', branch: 'main' },
    context: 'Deciding on an approach.',
    question: 'Which approach should we use?',
    options: [
      { label: 'Option A', value: 'a' },
      { label: 'Option B', value: 'b' },
    ],
    allowMultiple: false,
    allowOther: false,
  }, overrides);
}

test.describe('Sender badge on the dialog window', () => {
  test('renders a visible badge in the meta-row, sibling of the repo/branch badges', async ({ page }) => {
    await page.goto(fixtureUrl(baseQuestion({ sender: SENDER })));

    const badge = page.locator('.badge-sender');
    await expect(badge).toBeVisible();
    await expect(badge).toBeInViewport();

    // Sibling of the repo/branch badges inside .meta-row.
    await expect(page.locator('.meta-row > .badge-sender')).toHaveCount(1);
    await expect(page.locator('.meta-row .badge')).toHaveCount(3); // repo, branch, sender

    // Never inside the collapsible context section.
    await expect(page.locator('.context-section .badge-sender')).toHaveCount(0);
  });

  test('carries a title attribute with the full label and truncates rather than wraps', async ({ page }) => {
    const longLabel = 'Kay9 - a-very-long-linked-worktree-branch-name-that-must-not-wrap-or-overflow-the-dialog';
    await page.goto(fixtureUrl(baseQuestion({ sender: { label: longLabel, source: 'worktree' } })));

    const badge = page.locator('.badge-sender');
    await expect(badge).toHaveAttribute('title', longLabel);

    const style = await badge.evaluate(el => {
      const computed = getComputedStyle(el);
      return { overflow: computed.overflow, textOverflow: computed.textOverflow, whiteSpace: computed.whiteSpace };
    });
    expect(style.overflow).toBe('hidden');
    expect(style.textOverflow).toBe('ellipsis');
    expect(style.whiteSpace).toBe('nowrap');
  });

  test('renders no badge when the question carries no sender', async ({ page }) => {
    await page.goto(fixtureUrl(baseQuestion()));
    await expect(page.locator('.badge-sender')).toHaveCount(0);
  });

  test('a live sender-identity event patches the badge into an already-rendered dialog', async ({ page }) => {
    const query = new URLSearchParams({
      driver: 'app',
      question: JSON.stringify(baseQuestion()),
    });
    await page.goto(`/test-harness.html?${query.toString()}`);

    await expect(page.locator('.option')).not.toHaveCount(0);
    await expect(page.locator('.badge-sender')).toHaveCount(0);

    await page.evaluate((sender) => (window as any).__simulateSenderIdentity(sender), SENDER);

    const badge = page.locator('.badge-sender');
    await expect(badge).toBeVisible();
    await expect(badge).toHaveAttribute('title', SENDER.label);
    // Live patch does not disturb the rest of the dialog.
    await expect(page.locator('.option')).not.toHaveCount(0);
  });
});
