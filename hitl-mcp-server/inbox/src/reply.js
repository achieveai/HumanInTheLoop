// Replying from the Inbox, and the race that comes with it (spec §9).
//
// Two things live here, and they are deliberately separate.
//
// The **decisions** — `raceOutcome`, `raceNotice`, `orphanNotice` — are pure
// functions of a `MessageRow` and one string. No DOM, no `invoke`, no clock.
// They are the interesting half and the half worth testing directly.
//
// The **wiring** — `createReplyActions` — is the thin part: it calls the Tauri
// commands, which publish through `hitl-transport` on the shared topic exactly
// as the popup client and the phone do. There is no Inbox-only message type and
// no Inbox-only channel; §9.1's whole argument is that the shared total order
// already makes an arbiter unnecessary, and a private path is the one thing
// that could break it.
//
// # How `lost` is detected without an ack
//
// For a plan review the MCP server sends `plan_review_ack{status:'lost'}`, and
// the fold reads it. **There is no equivalent for a question.** So the fold
// cannot be the only signal, and the race is decided instead by the one fact
// only the publisher holds: the `messageId` it minted for its own reply.
//
//   `submit_answer` mints an id, publishes, returns it.
//   The id is kept here, against the question it answered.
//   `fold` names the winning response on `row.responseId` (spec §9.2).
//   They match — you won. They do not — you lost.
//
// Every device runs that comparison against the same total order and reaches
// the same answer, which is the property `crates/hitl-store/tests/
// two_devices_agree.rs` exists to protect. The ack, when there is one, is
// confirmation on top: it turns the row's status into `lost` for everybody,
// including whoever won the ntfy race, because "first in topic order" and "the
// one the agent actually consumed" are not always the same thing.

import { formatAbsolute } from './pane-list.js';

/** Statuses in which somebody still has to act. Mirrors `isOpen`. */
const OPEN = new Set(['pending', 'stale']);

/** Statuses reached because the exchange was called off, not replied to. */
const CLOSED_WITHOUT_A_REPLY = {
    cancelled: 'This was cancelled before anyone replied.',
    superseded: 'A newer revision replaced this one.',
    agent_gone: 'The agent exited before this was answered.',
};

/** How a settled message is described, by the way it settled. */
const VERBS = {
    answered: 'Answered',
    skipped: 'Skipped',
    dismissed: 'Dismissed',
};

// Said the same way every time, because it is the thing a reader most needs to
// believe: a lost race costs you the reply, never the writing.
const KEPT = 'Nothing you have typed has been discarded — it just cannot be sent from here.';

/**
 * What the log says about a message you may have replied to (spec §9.3).
 *
 *   open    nobody has settled it; the form is still live
 *   won     the winning response is the one this device published
 *   lost    it settled, and the winner is not this device's response
 *   unread  it settled, and the agent acknowledged it never read the winner
 *   closed  it ended without anybody replying at all
 *
 * `myResponseId` is what `createReplyActions` remembered for this message, or
 * `null` when this device never replied. Note that a `null` id can still yield
 * `lost`: somebody answering while you are typing is the fourth row of §9.3's
 * table, and it locks the form for exactly the same reason.
 */
export function raceOutcome(row, myResponseId = null) {
    if (OPEN.has(row.status)) return 'open';
    // Ack-confirmed, and it outranks the id comparison: `Status::Lost` means
    // the fold's winner was acknowledged as never consumed, so nobody won —
    // including this device, even when the winning id is its own.
    if (row.status === 'lost') return 'unread';
    if (row.status in CLOSED_WITHOUT_A_REPLY) return 'closed';
    if (myResponseId && row.responseId === myResponseId) return 'won';
    return 'lost';
}

/** "Answered by Kay9 laptop at 12 Aug 2026, 10:32." */
function attribution(row) {
    const verb = VERBS[row.status] ?? 'Answered';
    const who = row.responder || 'another device';
    const when = row.respondedAt ? ` at ${formatAbsolute(row.respondedAt)}` : '';
    return `${verb} by ${who}${when}.`;
}

/**
 * The banner to slide in when a message settles under an open form, or `null`
 * while it is still live — and `null` when this device is the one that won,
 * since the header already says so and a banner would only argue with it.
 *
 * Returned rather than rendered so the wording is assertable without a DOM.
 */
export function raceNotice(row, myResponseId = null) {
    const outcome = raceOutcome(row, myResponseId);

    if (outcome === 'open' || outcome === 'won') return null;

    if (outcome === 'unread') {
        return {
            kind: 'answered-elsewhere',
            title: 'Answered elsewhere',
            // Distinct from losing to another device: here a response did win
            // the topic order, and the agent then said it never read one.
            // Nobody's answer got through, so "somebody else answered" would
            // be the wrong thing to go and check.
            detail: `${attribution(row)} The agent has acknowledged that it never read that `
                + `response, so no answer got through. ${KEPT}`,
        };
    }

    if (outcome === 'closed') {
        return {
            kind: 'closed-elsewhere',
            title: 'Closed elsewhere',
            detail: `${CLOSED_WITHOUT_A_REPLY[row.status]} ${KEPT}`,
        };
    }

    if (row.status === 'dismissed') {
        // A notification is never "answered", and it has no form to lose: the
        // reader typed nothing, so promising that nothing was discarded would
        // be reassurance about a thing that never existed.
        return {
            kind: 'answered-elsewhere',
            title: 'Dismissed elsewhere',
            detail: `${attribution(row)} There is nothing left to dismiss here.`,
        };
    }

    return {
        kind: 'answered-elsewhere',
        title: 'Answered elsewhere',
        detail: myResponseId
            // §9.3 row 3. Saying only "answered elsewhere" here would let
            // someone believe their own reply is what the agent acted on.
            ? `${attribution(row)} Your response was published but arrived second, `
                + `so the agent never used it. ${KEPT}`
            // §9.3 row 4: answered while you were typing.
            : `${attribution(row)} ${KEPT}`,
    };
}

/**
 * Spec §16.5 — the incident this whole pane was pointed at.
 *
 * A review whose publishing MCP process has died gets replayed out of ntfy's
 * cache and reads `pending` forever, because no ack will ever arrive to settle
 * it. It is then indistinguishable from live work, and approving it sends the
 * response nowhere — which is exactly what happened, twice, during the design
 * session that produced this spec.
 *
 * The Inbox can tell the two apart: a session silent for a day is `stale`
 * (§6.1), and `stale` is the projection layer's overlay on a `pending` nothing
 * has moved. So the request is *marked*, explicitly, rather than being drawn as
 * ordinary live work.
 *
 * It is marked and not disabled. Spec §16 question 5 — whether the Inbox should
 * go further and publish `cancel_review` for orphans, or only display them as
 * dead — is open, and an Inbox that refused to let you reply would have decided
 * it. A silent agent is strong evidence, never a fact: §6.1 says so in as many
 * words, since a session that exits cleanly emits no signal at all.
 *
 * Notifications are exempt. Nothing is blocked on one, so a decayed
 * notification is not an orphan, just old.
 */
export function orphanNotice(row) {
    if (row.status !== 'stale' || row.msgType === 'notification') return null;
    return {
        kind: 'orphan',
        title: 'Probably an orphan',
        detail: 'Nothing has been heard from this agent in over a day, so the process that '
            + 'asked has most likely exited. You can still reply, but it may go nowhere.',
    };
}

function keyedOutcomes(outcomes, keyOf) {
    const keyed = new Map();
    if (!Array.isArray(outcomes)) return keyed;
    for (const outcome of outcomes) {
        const key = keyOf(outcome);
        if (!key) continue;
        const bucket = keyed.get(key) ?? [];
        bucket.push(outcome);
        keyed.set(key, bucket);
    }
    return keyed;
}

function outcomeFailure(target, matches, successStatus) {
    if (matches.length === 0) return { ...target, error: 'missing outcome' };
    if (matches.length > 1) return { ...target, error: 'duplicate outcome' };
    const [outcome] = matches;
    if (outcome.status === 'failed') {
        return { ...target, error: String(outcome.error || 'native command failed') };
    }
    if (outcome.status !== successStatus) {
        return { ...target, error: `unknown outcome status: ${String(outcome.status)}` };
    }
    if (!outcome.responseId) return { ...target, error: 'missing response ID' };
    return null;
}

function normalizeDismissOutcomes(notificationIds, outcomes) {
    const keyed = keyedOutcomes(outcomes, outcome => outcome?.notificationId);
    const successes = [];
    const failures = [];
    for (const notificationId of notificationIds) {
        const matches = keyed.get(notificationId) ?? [];
        const failure = outcomeFailure({ notificationId }, matches, 'dismissed');
        if (failure) {
            failures.push(failure);
        } else {
            successes.push({ notificationId, dismissalId: matches[0].responseId });
        }
    }
    return { successes, failures };
}

function restoreKey(value) {
    return value?.notificationId && value?.dismissalId
        ? `${value.notificationId}\u0000${value.dismissalId}`
        : null;
}

function normalizeRestoreOutcomes(restorations, outcomes) {
    const keyed = keyedOutcomes(outcomes, restoreKey);
    const successes = [];
    const failures = [];
    for (const restoration of restorations) {
        const matches = keyed.get(restoreKey(restoration)) ?? [];
        const failure = outcomeFailure(restoration, matches, 'restored');
        if (failure) {
            failures.push(failure);
        } else {
            successes.push({ ...restoration, responseId: matches[0].responseId });
        }
    }
    return { successes, failures };
}

/**
 * The handlers pane 3 replies through.
 *
 * Every one of them publishes and returns; none of them touches a status.
 * Status arrives the way every other status does — folded out of the log on the
 * next event — so a reply this device sent and a reply the phone sent are
 * indistinguishable to everything downstream, which is what makes them agree.
 */
export function createReplyActions({ invoke }) {
    /** messageId → the `messageId` this device minted for its own reply. */
    const mine = new Map();

    const remember = (messageId, responseId) => {
        if (responseId) mine.set(messageId, responseId);
        return responseId;
    };

    const answer = (row, { selectedValues, otherText, subAnswers, skipped }) =>
        invoke('submit_answer', {
            questionId: row.messageId,
            selectedValues,
            // `''` and `undefined` both mean "the human typed nothing"; the
            // wire field is nullable and the server distinguishes absent from
            // empty, so it is sent absent.
            otherText: otherText || null,
            skipped,
            subAnswers: subAnswers ?? null,
        }).then(id => remember(row.messageId, id));

    const dismissMany = notificationIds => invoke('dismiss_notifications', { notificationIds })
        .then(outcomes => {
            const result = normalizeDismissOutcomes(notificationIds, outcomes);
            for (const success of result.successes) {
                remember(success.notificationId, success.dismissalId);
            }
            return result;
        });

    const restoreMany = restorations => invoke('restore_notifications', { restorations })
        .then(outcomes => normalizeRestoreOutcomes(restorations, outcomes));

    return {
        /** What this device published for `messageId`, or `null`. */
        myResponseId: messageId => mine.get(messageId) ?? null,

        onSubmit: ({ row, selectedValues, otherText, subAnswers }) =>
            answer(row, { selectedValues, otherText, subAnswers, skipped: false }),

        // A skip is an answer that declined, on the same message type — the
        // popup client sends it identically, and the fold reads `skipped:true`
        // as its own status.
        onSkip: row =>
            answer(row, { selectedValues: [], otherText: '', subAnswers: null, skipped: true }),

        onDismiss: row =>
            invoke('dismiss_notification', { notificationId: row.messageId })
                .then(id => remember(row.messageId, id)),

        onDismissMany: dismissMany,

        onRestoreMany: restoreMany,

        onRestore: row => {
            if (!row.responseId) return Promise.reject(new Error('This notification has no dismissal to restore.'));
            return restoreMany([{ notificationId: row.messageId, dismissalId: row.responseId }])
                .then(result => {
                    if (result.successes.length === 1) return result.successes[0].responseId;
                    throw new Error(result.failures[0]?.error ?? 'Could not mark this notification unread.');
                });
        },

        /**
         * Returns `{status, responseId, reason}` — `review.js` decides what each
         * status means, and only `received` lets it drop the draft. A rejection
         * is a publish that never left the machine.
         */
        onSubmitReview: (row, payload) =>
            invoke('submit_plan_review', {
                reviewId: payload.reviewId,
                snapshotHash: payload.snapshotHash,
                verdict: payload.verdict,
                overallFeedback: payload.overallFeedback,
                inlineComments: payload.inlineComments,
            }).then(result => {
                remember(row.messageId, result?.responseId);
                return result;
            }),

        onSaveDraft: draft => invoke('save_review_draft', { draft }),
        onLoadDraft: ({ planId, reviewId, snapshotHash }) =>
            invoke('load_review_draft', { planId, reviewId, snapshotHash }),
        onClearDraft: ({ planId, reviewId }) =>
            invoke('clear_review_draft', { planId, reviewId }),
    };
}
