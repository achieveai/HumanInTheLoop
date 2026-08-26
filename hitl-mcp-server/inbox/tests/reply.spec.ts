import { test, expect, type Page } from '@playwright/test';
import { DAY, MINUTE, NOW, bodyOk, detail, message, type MessageRow } from './fixtures.js';
import { applyRow, mount, recorded } from './mount.js';

// Replying from the Inbox, and the race that comes with it (spec §9).
//
// Two halves, tested two ways.
//
// The **decisions** are pure functions of a row and one string, so they are
// called directly and the *wording* is asserted as a value. That matters more
// than it looks: the banner is the only thing standing between "somebody else
// answered, go and look there" and "your answer is the one the agent used", and
// those two sentences send a reader to different places.
//
// The **promise** — that losing a race never costs you what you typed — cannot
// be tested as a value, because the whole risk is a re-render. So those tests
// type into a live form, move the log underneath it, and read the text back out
// of the DOM afterwards. If pane-detail.js ever goes back to re-rendering on a
// status change, they fail; nothing else in the suite would notice.

/** A question with a free-text field, which is the thing that can be lost. */
const QUESTION = detail(
  message({ messageId: 'q-1', title: 'Ship it?' }),
  {
    request: {
      question: 'Ship it?',
      allowOther: true,
      options: [
        { label: 'Ship', value: 'ship' },
        { label: 'Hold', value: 'hold' },
      ],
    },
  },
);

const PLAN = '# Plan\n\nFirst step.\nSecond step.\n';

const REVIEW = detail(
  message({
    messageId: 'p-1',
    msgType: 'plan_review',
    title: 'docs/plans/inbox.md',
    badges: { repo: 'Hitl_MCP', revision: 1 } as any,
  }),
  {
    request: {
      planId: 'plan-1',
      snapshotHash: 'abc123',
      displayPath: 'docs/plans/inbox.md',
      summary: 'Two steps.',
      revision: 1,
      isNewPlan: true,
    },
  },
);

const DRAFT = {
  reviewId: 'p-1',
  planId: 'plan-1',
  snapshotHash: 'abc123',
  overallFeedback: 'Step two is in the wrong order.',
  inlineComments: [
    { path: 'docs/plans/inbox.md', startLine: 2, endLine: 2, side: 'new', comment: 'Reorder these.' },
  ],
};

/** The row as it comes back once somebody, somewhere, has settled it. */
function settled(over: Partial<MessageRow> = {}): MessageRow {
  return message({
    messageId: 'q-1',
    status: 'answered',
    responder: 'Kay9 phone',
    responseId: 'resp-theirs',
    ...over,
  });
}

// ── the pure decisions ───────────────────────────────────────────────────────

async function call(page: Page, fn: string, ...args: unknown[]) {
  return page.evaluate(async ({ fn, args }) => {
    const mod: any = await import('./reply.js');
    return mod[fn](...(args as any[]));
  }, { fn, args });
}

const outcome = (page: Page, row: MessageRow, mine: string | null = null) =>
  call(page, 'raceOutcome', row, mine) as Promise<string>;

const notice = (page: Page, row: MessageRow, mine: string | null = null) =>
  call(page, 'raceNotice', row, mine) as Promise<{ kind: string; title: string; detail: string } | null>;

test.describe('Who won (spec §9.2, §9.3)', () => {
  test.beforeEach(async ({ page }) => { await page.goto('/inbox-harness.html'); });

  test('nothing is decided while the message is still open', async ({ page }) => {
    for (const status of ['pending', 'stale']) {
      const row = message({ messageId: 'q-1', status });
      expect(await outcome(page, row, 'resp-mine')).toBe('open');
      expect(await notice(page, row, 'resp-mine')).toBeNull();
    }
  });

  test('the winner is the id the fold named, and only the publisher can check it', async ({ page }) => {
    // The whole fold-only path, in three lines. `responseId` is the winning
    // response's own messageId, chosen by ntfy order and therefore identical on
    // every device; `myResponseId` is what this device's publish returned and is
    // known nowhere else. No ack is involved, which is what makes this work for
    // questions, where no ack exists.
    const row = settled({ responseId: 'resp-mine' });

    expect(await outcome(page, row, 'resp-mine')).toBe('won');
    expect(await outcome(page, row, 'resp-theirs')).toBe('lost');
    // Never replied from here at all — someone answered while you were reading.
    expect(await outcome(page, row, null)).toBe('lost');

    // Winning draws no banner: the header already says who answered, and a
    // banner would be arguing with it.
    expect(await notice(page, row, 'resp-mine')).toBeNull();
  });

  test('losing your own race says your answer was not the one used', async ({ page }) => {
    const shown = await notice(page, settled(), 'resp-mine');

    expect(shown?.kind).toBe('answered-elsewhere');
    expect(shown?.title).toBe('Answered elsewhere');
    expect(shown?.detail).toBe(
      'Answered by Kay9 phone. Your response was published but arrived second, '
      + 'so the agent never used it. '
      + 'Nothing you have typed has been discarded — it just cannot be sent from here.');
  });

  test('being answered while you type does not claim you sent anything', async ({ page }) => {
    // §9.3 row 4. The previous test's sentence would be a lie here: this device
    // published nothing, so there is no second-place response to explain.
    const shown = await notice(page, settled(), null);

    expect(shown?.title).toBe('Answered elsewhere');
    expect(shown?.detail).toBe('Answered by Kay9 phone. '
      + 'Nothing you have typed has been discarded — it just cannot be sent from here.');
    expect(shown?.detail).not.toContain('arrived second');
  });

  test('an acknowledged-unread answer is not "somebody else answered"', async ({ page }) => {
    // `Status::Lost` is the ack path: a response did win the topic order and the
    // agent then said it never read one. Nobody's answer got through, so
    // pointing the reader at another device would send them to look at an
    // answer that was equally ignored. It outranks the id comparison — even the
    // device that won gets told this.
    const row = settled({ status: 'lost', responseId: 'resp-mine' });

    expect(await outcome(page, row, 'resp-mine')).toBe('unread');

    const shown = await notice(page, row, 'resp-mine');
    expect(shown?.title).toBe('Answered elsewhere');
    expect(shown?.detail).toContain('acknowledged that it never read that response');
    expect(shown?.detail).toContain('no answer got through');
  });

  test('a message nobody replied to is closed, not lost', async ({ page }) => {
    const reasons: Record<string, string> = {
      cancelled: 'This was cancelled before anyone replied.',
      superseded: 'A newer revision replaced this one.',
      agent_gone: 'The agent exited before this was answered.',
    };

    for (const [status, why] of Object.entries(reasons)) {
      const row = settled({ status, responder: null, responseId: null });
      expect(await outcome(page, row, 'resp-mine')).toBe('closed');

      const shown = await notice(page, row, 'resp-mine');
      expect(shown?.kind).toBe('closed-elsewhere');
      expect(shown?.title).toBe('Closed elsewhere');
      expect(shown?.detail).toContain(why);
      // Still true, and still the reader's first question.
      expect(shown?.detail).toContain('Nothing you have typed has been discarded');
    }
  });

  test('a dismissal elsewhere does not promise to keep writing that never existed', async ({ page }) => {
    // A notification has no form. "Nothing you have typed has been discarded" is
    // reassurance about a thing that never happened, and reassurance nobody
    // asked for reads as a warning.
    const shown = await notice(page, settled({ msgType: 'notification', status: 'dismissed' }), 'resp-mine');

    expect(shown?.title).toBe('Dismissed elsewhere');
    expect(shown?.detail).toBe('Dismissed by Kay9 phone. There is nothing left to dismiss here.');
    expect(shown?.detail).not.toContain('typed');
  });

  test('a settled message names who settled it, falling back to the device that did not say', async ({ page }) => {
    const shown = await notice(page, settled({ responder: null }), null);
    expect(shown?.detail).toContain('Answered by another device.');
  });
});

test.describe('Orphans (spec §16.5)', () => {
  test.beforeEach(async ({ page }) => { await page.goto('/inbox-harness.html'); });

  test('a request from a silent agent is marked as the probable orphan it is', async ({ page }) => {
    const shown = await call(page, 'orphanNotice', message({ messageId: 'q-1', status: 'stale' })) as any;

    expect(shown.kind).toBe('orphan');
    expect(shown.title).toBe('Probably an orphan');
    expect(shown.detail).toBe('Nothing has been heard from this agent in over a day, so the '
      + 'process that asked has most likely exited. You can still reply, but it may go nowhere.');
  });

  test('nothing else is an orphan', async ({ page }) => {
    // Live work is not marked, a settled message has no one waiting on it, and
    // a decayed notification is old rather than orphaned — nothing was ever
    // blocked on it, so there is no dead request to warn about.
    expect(await call(page, 'orphanNotice', message({ messageId: 'q-1' }))).toBeNull();
    expect(await call(page, 'orphanNotice', settled())).toBeNull();
    expect(await call(page, 'orphanNotice',
      message({ messageId: 'n-1', msgType: 'notification', status: 'stale' }))).toBeNull();
  });

  test('the mark is a warning, not a lock', async ({ page }) => {
    // Spec §16 question 5 is open, and an Inbox that refused to let you reply
    // would have closed it. A silent agent is strong evidence and never a fact:
    // a session that exits cleanly emits no signal either.
    await mount(page, 'question', detail(
      message({ messageId: 'q-1', status: 'stale', createdAt: NOW - 2 * DAY, title: 'Ship it?' }),
      { request: QUESTION.request },
    ), { wire: true });

    await expect(page.locator('.detail-banner[data-banner="orphan"] .detail-banner-title'))
      .toHaveText('Probably an orphan');
    await expect(page.locator('.detail-actions .button', { hasText: 'Submit Response' })).toBeEnabled();
  });

  test('the mark comes down when the request finally settles', async ({ page }) => {
    await mount(page, 'question', detail(
      message({ messageId: 'q-1', status: 'stale', title: 'Ship it?' }),
      { request: QUESTION.request },
    ), { wire: true, myResponseId: 'resp-mine' });

    await expect(page.locator('.detail-banner[data-banner="orphan"]')).toHaveCount(1);

    await applyRow(page, settled());

    // Replaced, not stacked. An orphan warning left underneath an "answered
    // elsewhere" banner would be telling the reader to reply to a dead agent.
    await expect(page.locator('.detail-banner[data-banner="orphan"]')).toHaveCount(0);
    await expect(page.locator('.detail-banner[data-banner="answered-elsewhere"]')).toHaveCount(1);
  });
});

test.describe('Publishing a reply (spec §9.1)', () => {
  test('an answer goes out and the controls stay down', async ({ page }) => {
    // Optimistic on purpose. Once the answer is on the wire this is a race, and
    // offering to send a second answer would only add a second loser.
    await mount(page, 'question', QUESTION, { wire: true });

    await page.locator('.option[data-value="ship"]').click();
    await page.locator('.other-input').fill('Ship after the migration lands.');
    await page.locator('.detail-actions .button', { hasText: 'Submit Response' }).click();

    expect(await recorded(page)).toEqual([{
      action: 'submit',
      messageId: 'q-1',
      selectedValues: ['ship'],
      otherText: 'Ship after the migration lands.',
      subAnswers: null,
    }]);

    await expect(page.locator('.detail-progress'))
      .toHaveText('Sent. Waiting for the log to confirm it is the answer that won.');
    await expect(page.locator('.detail-actions .button', { hasText: 'Submit Response' })).toBeDisabled();
    await expect(page.locator('.detail-actions .button', { hasText: 'Skip' })).toBeDisabled();
  });

  test('a publish that failed says nothing left the machine, and gives the form back', async ({ page }) => {
    // The distinction the reader needs: a failed publish is not a lost race.
    // Nothing was sent, so everything on screen is still submittable — and the
    // form has to actually be usable again, not merely say so.
    await mount(page, 'question', QUESTION, { wire: true, failWith: 'ntfy refused the publish' });

    await page.locator('.option[data-value="hold"]').click();
    await page.locator('.detail-actions .button', { hasText: 'Submit Response' }).click();

    const error = page.locator('.detail-error');
    await expect(error).toBeVisible();
    await expect(error).toContainText('Could not send your answer — nothing left this machine.');
    await expect(error).toContainText('ntfy refused the publish');
    await expect(page.locator('.detail-progress')).toBeHidden();

    await expect(page.locator('.detail-actions .button', { hasText: 'Submit Response' })).toBeEnabled();
    await expect(page.locator('.other-input')).toBeEnabled();
    await expect(page.locator('.detail-banner')).toHaveCount(0);
  });

  test('a dismissal that failed leaves the button pressable', async ({ page }) => {
    await mount(page, 'notification', detail(
      message({ messageId: 'n-1', msgType: 'notification', title: 'Deploy finished' }),
      { request: { body: 'Shipped.' } },
    ), { wire: true, failWith: 'no network' });

    const button = page.locator('.detail-actions .button', { hasText: 'Dismiss' });
    await button.click();

    await expect(page.locator('.detail-error')).toContainText('Could not dismiss this — nothing left this machine.');
    await expect(button).toBeEnabled();
  });

  test('a verdict that needs a reason is refused before anything is published', async ({ page }) => {
    // Spec §8.3's client-side check, and it is `review.js`'s own — the same
    // function the desktop client runs, so the two apps cannot disagree about
    // what "request changes" requires. The point of the test is that nothing
    // reached the transport, not merely that a message appeared.
    await mount(page, 'review', REVIEW, { wire: true, body: bodyOk(PLAN) });

    await page.locator('[data-verdict="changes_requested"]').click();

    await expect(page.locator('#review-error'))
      .toHaveText('Request changes needs a reason — add overall feedback or at least one inline comment.');
    expect(await recorded(page)).toEqual([]);

    await page.locator('[data-verdict="rejected"]').click();
    await expect(page.locator('#review-error'))
      .toHaveText('Reject needs a reason — add overall feedback or at least one inline comment.');
    expect(await recorded(page)).toEqual([]);
  });

  test('the same verdict with a reason publishes it', async ({ page }) => {
    await mount(page, 'review', REVIEW, { wire: true, body: bodyOk(PLAN) });

    await page.locator('#overall-feedback').fill('Swap the two steps.');
    await page.locator('[data-verdict="changes_requested"]').click();

    expect(await recorded(page)).toContainEqual({
      action: 'submit-review',
      messageId: 'p-1',
      reviewId: 'p-1',
      snapshotHash: 'abc123',
      verdict: 'changes_requested',
      overallFeedback: 'Swap the two steps.',
      inlineComments: [],
    });
  });

  test('an approval needs no reason', async ({ page }) => {
    await mount(page, 'review', REVIEW, { wire: true, body: bodyOk(PLAN) });

    await page.locator('[data-verdict="approved"]').click();

    expect(await recorded(page)).toContainEqual({
      action: 'submit-review',
      messageId: 'p-1',
      reviewId: 'p-1',
      snapshotHash: 'abc123',
      verdict: 'approved',
      overallFeedback: '',
      inlineComments: [],
    });
  });
});

test.describe('Losing the race must not cost the writing (spec §9.3)', () => {
  test('a question locks in place and keeps what was typed', async ({ page }) => {
    // The one outcome §9.3 rules out in as many words. A question has no draft
    // store — nothing persists "Additional Context" to disk — so the *only*
    // copy of this paragraph is the DOM node it is sitting in, and re-rendering
    // pane 3 on a status change would destroy it with no way back.
    await mount(page, 'question', QUESTION, { wire: true, myResponseId: 'resp-mine' });

    await page.locator('.option[data-value="ship"]').click();
    await page.locator('.other-input').fill('Only after the migration lands — see the thread.');

    await applyRow(page, settled());

    const banner = page.locator('.detail-banner[data-banner="answered-elsewhere"]');
    await expect(banner.locator('.detail-banner-title')).toHaveText('Answered elsewhere');
    await expect(banner.locator('.detail-banner-detail')).toContainText('arrived second');

    // Still there, still readable, still copyable.
    await expect(page.locator('.other-input')).toHaveValue('Only after the migration lands — see the thread.');
    await expect(page.locator('.option[data-value="ship"] input')).toBeChecked();

    // And locked: every control disabled, no Submit left to press.
    await expect(page.locator('.other-input')).toBeDisabled();
    await expect(page.locator('.option[data-value="hold"] input')).toBeDisabled();
    await expect(page.locator('.detail-actions .button')).toHaveCount(0);

    // The header tells the truth about who closed it, alongside the banner.
    await expect(page.locator('.detail-responder')).toHaveText('Kay9 phone');
    await expect(page.locator('.detail-root')).toHaveAttribute('data-status', 'answered');
  });

  test('winning says so once, and not twice', async ({ page }) => {
    // The row names this device's own response, so there is nothing to warn
    // about. A banner here would be contradicting the header two lines above it.
    await mount(page, 'question', QUESTION, { wire: true, myResponseId: 'resp-mine' });

    await page.locator('.option[data-value="ship"]').click();
    await applyRow(page, settled({ responseId: 'resp-mine', responder: 'Kay9 laptop' }));

    await expect(page.locator('.detail-banner')).toHaveCount(0);
    await expect(page.locator('.detail-retained'))
      .toHaveText('This question is settled. The selection above is what the agent received.');
  });

  test('a review keeps every comment and every word of feedback', async ({ page }) => {
    // Reviews *do* have a draft store, and `drafts.rs` is where the comments
    // already are — but the draft is only reloaded when the message is opened
    // again, and this is the case where it is not. `setSuperseded` keeps the
    // comments on screen; `applyRow` deliberately does not touch the draft.
    await mount(page, 'review', REVIEW, { wire: true, body: bodyOk(PLAN), draft: DRAFT, myResponseId: 'resp-mine' });

    await expect(page.locator('#overall-feedback')).toHaveValue('Step two is in the wrong order.');
    await expect(page.locator('.comment-card-list')).toHaveCount(1);

    await page.locator('#overall-feedback').fill('Step two is in the wrong order, and step one needs a rollback plan.');

    await applyRow(page, message({
      messageId: 'p-1',
      msgType: 'plan_review',
      status: 'answered',
      verdict: 'approved',
      responder: 'Kay9 phone',
      respondedAt: NOW - MINUTE,
      responseId: 'resp-theirs',
    }));

    await expect(page.locator('.detail-banner[data-banner="answered-elsewhere"] .detail-banner-detail'))
      .toContainText('Nothing you have typed has been discarded');

    // Every word of it, including the edit made a moment before the race was
    // lost — which is the edit most likely to exist only here.
    await expect(page.locator('#overall-feedback'))
      .toHaveValue('Step two is in the wrong order, and step one needs a rollback plan.');
    await expect(page.locator('.comment-card-list')).toHaveCount(1);
    await expect(page.locator('.comment-card-list .comment-card-body')).toHaveText('Reorder these.');

    // review.js's own resolved state, so this looks the same as it does in the
    // desktop client.
    await expect(page.locator('.review-banner-superseded')).toContainText('Kay9 phone');
    await expect(page.locator('[data-verdict="approved"]')).toBeDisabled();
    await expect(page.locator('.detail-root')).toHaveAttribute('data-read-only', 'true');
  });

  test('a review the agent walked away from says so, and still keeps the comments', async ({ page }) => {
    // Not "answered elsewhere": nobody answered. Sending the reader to look for
    // another device's verdict would be sending them to look for nothing.
    await mount(page, 'review', REVIEW, { wire: true, body: bodyOk(PLAN), draft: DRAFT });

    await applyRow(page, message({
      messageId: 'p-1',
      msgType: 'plan_review',
      status: 'agent_gone',
    }));

    await expect(page.locator('.detail-banner[data-banner="closed-elsewhere"] .detail-banner-title'))
      .toHaveText('Closed elsewhere');
    await expect(page.locator('.detail-banner[data-banner="closed-elsewhere"] .detail-banner-detail'))
      .toContainText('The agent exited before this was answered.');
    await expect(page.locator('.review-banner-cancelled')).toContainText('agent exited');
    await expect(page.locator('.comment-card-list .comment-card-body')).toHaveText('Reorder these.');
  });

  test('a dismissal elsewhere closes the notification without ceremony', async ({ page }) => {
    await mount(page, 'notification', detail(
      message({ messageId: 'n-1', msgType: 'notification', title: 'Deploy finished' }),
      { request: { body: 'Shipped **v2.11.2**.' } },
    ), { wire: true, myResponseId: 'resp-mine' });

    await applyRow(page, settled({ messageId: 'n-1', msgType: 'notification', status: 'dismissed' }));

    await expect(page.locator('.detail-banner .detail-banner-title')).toHaveText('Dismissed elsewhere');
    await expect(page.locator('.detail-actions .button')).toHaveCount(0);
    // The body survives, which is the whole reason a dismissed notification is
    // kept at all.
    await expect(page.locator('.notification-body strong')).toHaveText('v2.11.2');
  });
});
