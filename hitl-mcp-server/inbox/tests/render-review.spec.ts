import { test, expect, type Page } from '@playwright/test';
import { MINUTE, NOW, bodyOk, detail, message } from './fixtures.js';
import { mount } from './mount.js';

// Pane 3, plan reviews (spec §8.3).
//
// The reviewer itself is client/src/review.js, unchanged and already covered by
// the client's own suite. What is new here is the two decisions around it:
// whether a body is fit to render at all, and — when it is not — whether the
// reason given actually points at the thing the reader has to go and fix.
//
// That second one is the whole point of these tests. `gone`, `undecryptable`
// and `unknown` are three different problems with three different fixes, and
// collapsing any of them into "the plan is unavailable" sends someone to the
// wrong place: chasing an agent for a resend that will fail identically, or
// editing a config that was never wrong.

const CONTENT = '# Plan\n\nFirst step.\nSecond step.\nThird step.\n';
const DIFF = [
  '--- a/plan.md',
  '+++ b/plan.md',
  '@@ -1,3 +1,3 @@',
  ' # Plan',
  '-Second step.',
  '+Second step, revised.',
  '',
].join('\n');

function review(over: Record<string, unknown> = {}, row: Record<string, unknown> = {}) {
  return detail(
    message({
      messageId: 'p-1',
      msgType: 'plan_review',
      title: 'docs/plans/inbox.md',
      badges: { repo: 'Hitl_MCP', revision: 1, attachment: true } as any,
      ...row,
    }),
    {
      request: {
        snapshotHash: 'abc123',
        displayPath: 'docs/plans/inbox.md',
        summary: 'Three steps.',
        context: 'Check the ordering before I start.',
        revision: 1,
        isNewPlan: true,
        repo: { name: 'Hitl_MCP', branch: 'design/llm-inbox' },
        ...over,
      },
    },
  );
}

/** The panel text, for the copy assertions. */
async function panel(page: Page) {
  return {
    state: await page.locator('.review-panel').getAttribute('data-state'),
    reason: await page.locator('.review-panel').getAttribute('data-reason'),
    title: await page.locator('.review-panel-title').textContent(),
    detail: await page.locator('.review-panel-detail').textContent(),
  };
}

test.describe('Pane 3 — a reviewable plan (spec §8.3)', () => {
  test('renders the client reviewer, unmodified, inside the pane', async ({ page }) => {
    await mount(page, 'review', review(), { body: bodyOk(CONTENT) });

    await expect(page.locator('.detail-kicker')).toHaveText('Plan review');
    await expect(page.locator('.review-root')).toHaveCount(1);
    await expect(page.locator('.diff-row[data-line]')).toHaveCount(6);
    await expect(page.locator('[data-verdict="approved"]')).toBeEnabled();
    await expect(page.locator('.review-panel')).toHaveCount(0);
  });

  test('a revision shows the diff; a new plan shows the plan whole', async ({ page }) => {
    // A diff is only meaningful against a previous revision. Revision 1 and
    // `isNewPlan` both mean there is nothing to diff against, so the payload's
    // diff — if it carries one at all — is not what to read.
    await mount(page, 'review', review({ revision: 2, isNewPlan: false }, { badges: { revision: 2 } as any }),
      { body: bodyOk(CONTENT, DIFF) });

    await expect(page.locator('.diff-row-add')).toHaveCount(1);
    await expect(page.locator('.diff-row-del')).toHaveCount(1);

    await mount(page, 'review', review({ revision: 1, isNewPlan: true }), { body: bodyOk(CONTENT, DIFF) });
    await expect(page.locator('.diff-row-add')).toHaveCount(0);
    await expect(page.locator('.diff-row[data-line]')).toHaveCount(6);
  });

  test('a settled review keeps the plan and loses the controls', async ({ page }) => {
    await mount(page, 'review', review({}, {
      status: 'answered',
      verdict: 'approved',
      responder: 'Kay9 desktop',
      respondedAt: NOW - MINUTE,
    }), { body: bodyOk(CONTENT) });

    await expect(page.locator('.detail-root')).toHaveAttribute('data-read-only', 'true');
    await expect(page.locator('.diff-row[data-line]')).toHaveCount(6);
    await expect(page.locator('[data-verdict="approved"]')).toBeDisabled();
    await expect(page.locator('.review-banner-superseded')).toContainText('Kay9 desktop');
  });

  test('a cancelled review says the agent left, not that someone else answered', async ({ page }) => {
    await mount(page, 'review', review({}, { status: 'agent_gone' }), { body: bodyOk(CONTENT) });

    await expect(page.locator('.review-banner-cancelled')).toContainText('agent exited');
    await expect(page.locator('[data-verdict="approved"]')).toBeDisabled();
  });
});

test.describe('Pane 3 — a plan that cannot be vouched for (spec §8.3)', () => {
  test('a hash mismatch renders read-only, with the plan withheld', async ({ page }) => {
    // The bytes decoded, but they are not the bytes the agent said it sent. The
    // content is therefore unknown, and approving unknown content is the exact
    // failure the hash exists to catch — so nothing is shown and nothing can be
    // approved from here.
    await mount(page, 'review',
      review({}, { contentHash: 'abc123' }),
      { body: { outcome: 'hashMismatch', expected: 'abc123', actual: 'def456' } });

    const shown = await panel(page);
    expect(shown.state).toBe('hash_mismatch');
    expect(shown.reason).toBe('hash_mismatch');
    expect(shown.title).toBe('Plan does not match its hash');
    expect(shown.detail).toContain('It has not been shown, and nothing can be approved from here.');

    await expect(page.locator('.detail-root')).toHaveAttribute('data-read-only', 'true');
    await expect(page.locator('.review-root')).toHaveCount(0);
    await expect(page.locator('[data-verdict]')).toHaveCount(0);
    await expect(page.locator('.detail-review-host')).not.toContainText('First step');
  });

  test('gone means unrecoverable: ask the agent to resend', async ({ page }) => {
    await mount(page, 'review', review(), { body: { outcome: 'missing', status: 'gone', detail: null, reason: null } });

    const shown = await panel(page);
    expect(shown.state).toBe('expired');
    expect(shown.reason).toBe('gone');
    expect(shown.title).toBe('Plan expired');
    expect(shown.detail).toContain('ask the agent to resend the plan');
    // Not a key problem. Sending someone to their config here wastes the trip.
    expect(shown.detail).not.toContain('encryption key');
  });

  test('undecryptable means the bytes are fine and the key is not', async ({ page }) => {
    // The failure this test exists to prevent: reporting a key mismatch as an
    // expiry. The plan is sitting right there, intact, one config line away —
    // and the reader would be off asking the agent for a resend that decrypts
    // exactly as badly as the first one did.
    await mount(page, 'review', review(),
      { body: { outcome: 'missing', status: 'undecryptable', detail: null, reason: null } });

    const shown = await panel(page);
    expect(shown.state).toBe('decrypt');
    expect(shown.reason).toBe('undecryptable');
    expect(shown.title).toBe('Could not decrypt the plan');
    expect(shown.detail).toBe('This plan was encrypted with a key this device does not have. '
      + 'Check that both ends share the same HITL encryption key.');
    expect(shown.detail).not.toContain('expired');
  });

  test('an unrecognised reason is reported as unrecognised, not as dead', async ({ page }) => {
    // `unknown` is a reason string from a newer build. Folding it into `gone`
    // would declare a body dead that a newer Inbox could very well read.
    await mount(page, 'review', review(),
      { body: { outcome: 'missing', status: 'unknown', detail: null, reason: 'quarantined_by_policy' } });

    const shown = await panel(page);
    expect(shown.state).toBe('unavailable');
    expect(shown.reason).toBe('unknown');
    expect(shown.detail).toContain('one this build does not recognise');
    expect(shown.detail).toContain('quarantined_by_policy');
    expect(shown.detail).toContain('may still be recoverable');
  });

  test('an archivist that is not running is its own state', async ({ page }) => {
    // Spec §11: every client works when the archivist is down. This is a
    // connection failure, not a BodyStatus — the body is almost certainly fine
    // and nobody has looked at it yet. Naming the process is what makes this a
    // ten-second fix instead of a hunt.
    await mount(page, 'review', review(),
      { body: { outcome: 'unreachable', detail: 'connection refused' } });

    const shown = await panel(page);
    expect(shown.state).toBe('unavailable');
    expect(shown.reason).toBe('unreachable');
    expect(shown.detail).toContain('The archivist is not running');
    expect(shown.detail).toContain('nothing is lost');
    expect(shown.detail).toContain('connection refused');
    await expect(page.locator('[data-verdict]')).toHaveCount(0);
  });

  test('a body still downloading never tells the reader to start the archivist', async ({ page }) => {
    // The panel this whole state exists for. Before it, a body mid-download
    // looked exactly like a body nobody had ever fetched, so the reader got
    // "start the archivist" — and starting it does nothing, because the Inbox
    // is doing this fetch itself. That advice cost an hour of hunting.
    await mount(page, 'review', review(), { body: { outcome: 'fetching' } });

    const shown = await panel(page);
    expect(shown.state).toBe('unavailable');
    expect(shown.reason).toBe('fetching');
    expect(shown.detail).toContain('still downloading');
    expect(shown.detail).toContain('nothing needs starting');
    expect(shown.detail).not.toContain('archivist');
    await expect(page.locator('[data-verdict]')).toHaveCount(0);
  });

  test('nothing has fetched it yet, which is neither gone nor in flight', async ({ page }) => {
    // Two processes can fetch a body and neither may be running, so this panel
    // names no component. It also has to stay distinct from `fetching`: there,
    // a download is under way and will finish; here, nothing is happening.
    await mount(page, 'review', review(),
      { body: { outcome: 'missing', status: 'unattempted', detail: null, reason: null } });

    const shown = await panel(page);
    expect(shown.reason).toBe('unattempted');
    expect(shown.detail).toContain('nothing is fetching one right now');
    expect(shown.detail).toContain('may clear on its own');
    expect(shown.detail).not.toContain('archivist');
    expect(shown.detail).not.toContain('downloading');
  });

  test('a review that arrived with no body at all says exactly that', async ({ page }) => {
    await mount(page, 'review', review(), { body: { outcome: 'absent' } });

    const shown = await panel(page);
    expect(shown.state).toBe('missing');
    expect(shown.reason).toBe('absent');
    expect(shown.detail).toContain('without a plan body at all');
  });

  test('every refusal keeps the header, so the message still identifies itself', async ({ page }) => {
    await mount(page, 'review', review(), { body: { outcome: 'unreachable', detail: 'connection refused' } });

    await expect(page.locator('.detail-title')).toHaveText('docs/plans/inbox.md');
    await expect(page.locator('.detail-kicker')).toHaveText('Plan review');
  });
});


// The header block — path, chips, the agent's summary and the context toggle —
// is ~215px of a 859px window, which left the source and rendered panes about
// 265px between them. Collapsing it is worth ~173px, roughly a 65% taller
// review area.
//
// The titlebar deliberately survives a collapse: it carries "Find in plan", and
// in the client popup `review.js` is the whole window, so there is nowhere else
// for search to live.
test.describe('the review header collapses (spec §8.3)', () => {
  const toggle = '#review-header-toggle';
  const body = '#review-header-body';

  test('starts expanded, with the path, chips and summary on screen', async ({ page }) => {
    await mount(page, 'review', review(), { body: bodyOk(CONTENT, DIFF) });

    await expect(page.locator(toggle)).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('.review-meta')).toBeVisible();
    await expect(page.locator('.review-summary')).toContainText('Three steps.');
  });

  test('collapsing hides the block but keeps the title and the find box', async ({ page }) => {
    await mount(page, 'review', review(), { body: bodyOk(CONTENT, DIFF) });

    await page.locator(toggle).click();

    await expect(page.locator(toggle)).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator(body)).toBeHidden();
    await expect(page.locator('.review-meta')).toBeHidden();
    await expect(page.locator('.review-summary')).toBeHidden();

    // The two things a collapse must never take with it.
    await expect(page.locator('.review-title')).toBeVisible();
    await expect(page.locator('#review-find-input')).toBeVisible();
  });

  // Against what the header actually gave up, not a fixed pixel count: this
  // fixture's summary is one line where a real one is a paragraph, so any
  // constant here would either be unreachable or prove nothing.
  test('collapsing gives the reviewing panes the height it took', async ({ page }) => {
    await mount(page, 'review', review(), { body: bodyOk(CONTENT, DIFF) });
    const panes = () => page.locator('.review-body').boundingBox();

    const before = (await panes())?.height ?? 0;
    const surrendered = (await page.locator(body).boundingBox())?.height ?? 0;

    await page.locator(toggle).click();

    const gained = ((await panes())?.height ?? 0) - before;
    expect(surrendered, 'the header body had no height to give').toBeGreaterThan(40);
    expect(gained, 'the panes did not get what the header gave up')
      .toBeGreaterThan(surrendered * 0.9);
  });

  // Structural rather than behavioural on purpose. Driving a message into the
  // superseded state from here is a different fixture; what has to hold is that
  // no future edit can move the banners inside the region that gets hidden,
  // because a cancelled review that silently stops saying so is the worst
  // outcome this pane has.
  test('banners are never inside the part that collapses', async ({ page }) => {
    await mount(page, 'review', review(), { body: bodyOk(CONTENT, DIFF) });

    const nested = await page.evaluate(() =>
      Boolean(document.querySelector('#review-header-body #review-banners')));

    expect(nested, '#review-banners is inside the collapsible region').toBe(false);
  });

  test('the choice is remembered for the next review', async ({ page }) => {
    await mount(page, 'review', review(), { body: bodyOk(CONTENT, DIFF) });
    await page.locator(toggle).click();
    await expect(page.locator(body)).toBeHidden();

    // Re-mounted rather than reloaded: the harness stages its fixture per
    // mount, and "the next review" is literally a second mount anyway.
    await mount(page, 'review', review(), { body: bodyOk(CONTENT, DIFF) });

    await expect(page.locator(toggle)).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator(body)).toBeHidden();
  });
});
