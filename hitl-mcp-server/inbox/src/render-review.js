// Pane 3 — the plan-review renderer (spec §8.3).
//
// This file is deliberately thin. The reviewer UI — the two-pane source/rendered
// split, line-range selection, inline comments, the find bar, the verdict
// footer — is `review.js`, which already ships in the desktop client and is
// covered by its Playwright suite. Reimplementing it for the Inbox would mean
// two reviewers that have to agree about what "approve" means, and the second
// one would be the one that quietly disagreed.
//
// So: `review.js` is the reviewer. This module's whole job is to decide *which*
// of its two entry points to call, and with what.
//
//   body.outcome === 'ok'  →  renderPlanReview(...)   the real thing
//   anything else          →  renderReviewPanel(...)  a refusal, no plan shown
//
// # Why a body we cannot vouch for is never rendered
//
// `get_body` verifies `contentHash` against the bytes it decoded (spec §8.3).
// On mismatch it returns `hashMismatch` and the plan text never reaches this
// module — the panel is all there is to draw. That is the point: a plan whose
// hash does not match is a plan whose *content* is unknown, and approving
// unknown content is precisely the failure the hash exists to prevent. Read-only
// with a loud warning is the only honest rendering.
//
// # Why the panel carries a `data-reason`
//
// `review.js` has six panel kinds and the Inbox has more failure modes than
// that — notably "the archivist is not running", which §11 requires every client
// to survive, and which is not the same thing as "the body is gone". Several
// distinct causes therefore land on kind `unavailable`. `data-reason` keeps them
// apart for tests and for anyone reading the DOM, without touching `review.js`.

import { disposeReview, renderPlanReview, renderReviewPanel } from './review.js';
import {
    detailHeader,
    el,
    isOpen,
    removeNotice,
    replaceHeader,
    showNotice,
} from './detail-shell.js';
import { orphanNotice, raceNotice } from './reply.js';

/** No handler was supplied. Saying so beats a silent no-op. */
const UNATTACHED = 'This pane has no reply handler attached.';

const KICKER = 'Plan review';

/**
 * Map a `BodyOutcome` onto a `renderReviewPanel` state.
 *
 * Exported for the tests: this mapping is the whole of the module's judgement,
 * and each arm below is a claim about what the user should go and do next.
 */
export function panelStateFor(body) {
    const outcome = body?.outcome;

    if (outcome === 'hashMismatch') {
        // review.js supplies the copy for this one, and it is the right copy.
        return { kind: 'hash_mismatch', reason: 'hash_mismatch' };
    }

    if (outcome === 'fetching') {
        // Deliberately adjacent to `unreachable` below, because the two are one
        // word apart and opposite in what they ask of the reader. The Inbox
        // grabs an attachment the moment its message arrives; between that and
        // the bytes landing there is a real interval, and this is what it looks
        // like. Saying "start the archivist" here — which is what happened
        // before this arm existed — sends someone to fix a component that has
        // no part in this fetch, and hides the fact that the plan is seconds
        // away.
        return {
            kind: 'unavailable',
            reason: 'fetching',
            message: 'This plan’s body is still downloading. The Inbox started fetching it the '
                + 'moment the message arrived, so nothing is wrong and nothing needs starting — '
                + 'it simply has not finished yet. Reopen this message in a moment.',
        };
    }

    if (outcome === 'unreachable') {
        // Spec §11: every client works when the archivist is down. This is a
        // connection failure, not a `BodyStatus` — the body is very probably
        // fine and nobody has looked at it yet. Naming the process is the
        // difference between a 10-second fix and a hunt.
        return {
            kind: 'unavailable',
            reason: 'unreachable',
            message: 'The archivist is not running, so this plan’s body could not be fetched. '
                + 'Start it and reopen this message — nothing is lost. '
                + `(${body.detail})`,
        };
    }

    if (outcome === 'commandFailed') {
        // The Inbox could not even ask. Distinct from `unreachable`, which
        // means the question was asked and the archivist did not answer.
        return {
            kind: 'unavailable',
            reason: 'command-failed',
            message: `The Inbox could not load this plan’s body. (${body.detail})`,
        };
    }

    if (outcome === 'unreadable') {
        return {
            kind: 'unavailable',
            reason: 'unreadable',
            message: `The archivist answered, but not with the plan body. (${body.detail})`,
        };
    }

    if (outcome === 'undecodable') {
        // Decoding failed on bytes we did receive. `kind` comes from the
        // transport's own error vocabulary.
        if (body.kind === 'decrypt') return { kind: 'decrypt', reason: 'decrypt' };
        if (body.kind === 'too_large') {
            return {
                kind: 'corrupt',
                reason: 'too_large',
                message: 'This plan is larger than the client will decode. Ask the agent to send a smaller plan.',
            };
        }
        return { kind: 'corrupt', reason: body.kind || 'corrupt', message: body.detail || '' };
    }

    if (outcome === 'absent') {
        return {
            kind: 'missing',
            reason: 'absent',
            message: 'This review arrived without a plan body at all. Ask the agent to resend it.',
        };
    }

    if (outcome === 'missing') {
        return missingState(body);
    }

    return { kind: 'error', reason: 'unknown-outcome', message: 'The plan body could not be loaded.' };
}

/**
 * The archivist has the record but not the bytes. `status` is a `BodyStatus`.
 *
 * The three that matter are kept strictly apart, because each sends the reader
 * somewhere different and two of them are routinely conflated:
 *
 *   gone           unrecoverable. The attachment expired. Only the agent can fix it.
 *   undecryptable  the bytes are fine. The *key* is wrong. One config line.
 *   unknown        a reason string from a newer build. Say so; do not guess.
 */
function missingState(body) {
    const status = body.status;

    if (status === 'gone') {
        // review.js's own 'expired' copy explains the 3 h attachment / 12 h
        // message asymmetry, which is the actual cause almost every time.
        return { kind: 'expired', reason: 'gone', message: body.detail || '' };
    }

    if (status === 'undecryptable') {
        // Not 'expired'. Reporting a key mismatch as an expiry sends someone
        // chasing the agent for a resend that will fail exactly the same way.
        return { kind: 'decrypt', reason: 'undecryptable' };
    }

    if (status === 'corrupt') {
        const actual = body.detail ? ` (${body.detail})` : '';
        return { kind: 'corrupt', reason: 'corrupt', message: `The stored plan body does not match its hash${actual}.` };
    }

    if (status === 'unattempted') {
        // Names no component. Two different things land here — the archivist
        // has not got to it, or the Inbox's own fetch failed transiently and
        // left no verdict — and both processes may or may not be running. The
        // old copy blamed the archivist for a fetch the Inbox may well have
        // been making, which is the same mistake as the `unreachable` panel on
        // a body in flight, one layer down.
        return {
            kind: 'unavailable',
            reason: 'unattempted',
            message: 'No copy of this plan’s body has been stored yet, and nothing is fetching one '
                + 'right now. Another attempt is made whenever a client reconnects, so this may '
                + 'clear on its own — reopen this message later to check.',
        };
    }

    if (status === 'unknown') {
        // A reason string this build does not have a case for. Forcing it into
        // `gone` would declare a recoverable body dead.
        const reason = body.reason ? `: “${body.reason}”` : '';
        return {
            kind: 'unavailable',
            reason: 'unknown',
            message: `The plan body is unavailable, and the reason given is one this build does not recognise${reason}. `
                + 'It may still be recoverable — try a newer Inbox, or ask the agent to resend.',
        };
    }

    return {
        kind: 'unavailable',
        reason: status || 'unspecified',
        message: body.detail || 'The plan body is unavailable.',
    };
}

/**
 * The message `review.js` expects, built from the row, the request payload and
 * the decoded body.
 *
 * Diff mode is spec §8.3: a diff is only meaningful against a previous
 * revision, so `isNewPlan` and revision 1 both show the plan whole even when a
 * diff happens to be present in the payload.
 */
function planMessage(detail, body) {
    const { row, request } = detail;
    const revision = request?.revision ?? row.badges?.revision ?? 1;
    const isNewPlan = request?.isNewPlan === true;
    const showDiff = revision > 1 && !isNewPlan;

    return {
        messageId: row.messageId,
        snapshotHash: request?.snapshotHash || '',
        displayPath: request?.displayPath || request?.planPath || '',
        summary: request?.summary || '',
        context: request?.context || '',
        repo: request?.repo,
        // The sender is already in this pane's own header; a second badge
        // saying the same thing two lines lower is noise.
        sender: null,
        revision,
        isNewPlan,
        body: {
            content: body.content || '',
            diff: showDiff ? (body.diff || '') : '',
        },
    };
}

/**
 * Lock a settled review without taking anything off the screen.
 *
 * `setSuperseded` / `setCancelled` are `review.js`'s own resolved states: they
 * disable the verdict buttons, keep every inline comment visible, and push the
 * draft one last time. They are already what the desktop client uses when the
 * race is lost mid-review, so the Inbox opening an already-closed review looks
 * the same as watching one close under you — one behaviour to learn, not two.
 */
function lock(controller, row) {
    if (row.status === 'cancelled') {
        controller.setCancelled('cancelled');
    } else if (row.status === 'agent_gone') {
        controller.setCancelled('agent_gone');
    } else {
        controller.setSuperseded(row.responder);
    }
}

export function renderReview(container, detail, body, actions = {}, draft = null) {
    const { row, request } = detail;

    disposeReview(container.querySelector('.detail-review-host'));
    container.textContent = '';
    const root = el('article', 'detail-root detail-review');
    root.dataset.messageId = row.messageId;
    root.dataset.status = row.status;
    root.appendChild(detailHeader(detail, KICKER));

    const host = el('div', 'detail-review-host');
    root.appendChild(host);
    container.appendChild(root);
    const dispose = () => disposeReview(host);

    if (body?.outcome !== 'ok') {
        const state = panelStateFor(body);
        renderReviewPanel(host, state);
        const panel = host.querySelector('.review-panel');
        if (panel) panel.dataset.reason = state.reason;
        root.dataset.readOnly = 'true';
        // No `applyRow`: there is no form to lock and no plan on screen, so a
        // status change has nothing here to change.
        return { readOnly: true, reason: state.reason, kind: state.kind, dispose };
    }

    root.dataset.readOnly = String(!isOpen(row));

    const planId = request?.planId || '';
    const snapshotHash = request?.snapshotHash || '';

    // Declared before the call because the callbacks below close over it, and
    // `review.js` is free to invoke one of them while it is still rendering.
    let controller;
    controller = renderPlanReview(host, planMessage(detail, body), {
        // `review.js` validates the verdict — `changes_requested` and
        // `rejected` need overall feedback or at least one inline comment —
        // and refuses before ever calling this. That client-side check is the
        // spec §8.3 requirement, met by reuse: re-implementing it here would be
        // a third copy of the server's `normalizeResponseBody()` rule.
        onSubmit: actions.onSubmitReview
            ? payload => actions.onSubmitReview(row, payload)
            : () => Promise.reject(new Error(UNATTACHED)),

        // Skip has no verdict buttons behind it, so it composes its own
        // payload; it is otherwise the same publish.
        onSkip: actions.onSubmitReview
            ? () => actions.onSubmitReview(row, {
                reviewId: row.messageId,
                snapshotHash,
                verdict: 'skipped',
                overallFeedback: '',
                inlineComments: [],
            })
            : () => Promise.reject(new Error(UNATTACHED)),

        // Fired on every edit. A failure is recorded rather than swallowed:
        // the resolved banners read this flag and stop claiming the draft was
        // saved, and claiming a save that failed is how someone loses twenty
        // minutes of review and only finds out later.
        onDraftChange: actions.onSaveDraft
            ? d => actions.onSaveDraft(d).catch(err => {
                console.error('save_review_draft failed:', err);
                controller?.noteDraftSaveFailed();
            })
            : undefined,

        // Fired only on a confirmed `received`. On `lost`, `unacknowledged`,
        // or a lost race, the draft is the only surviving copy.
        onReceived: actions.onClearDraft
            ? () => actions.onClearDraft({ planId, reviewId: row.messageId }).catch(err => {
                console.error('clear_review_draft failed:', err);
                controller?.noteDraftClearFailed();
            })
            : undefined,

        onCancel: actions.onCancel,
    });

    if (draft) controller.restoreDraft(draft);

    if (!isOpen(row)) {
        lock(controller, row);
    } else {
        showNotice(root, orphanNotice(row));
    }

    /**
     * The folded status moved while this review was open (spec §9.3).
     *
     * The draft is not touched. `setSuperseded` leaves every comment on screen
     * and `notifyDraft` has already persisted them, so losing a race costs the
     * reply and nothing else — which is the whole promise of §9.3's fourth row.
     */
    function applyRow(nextRow) {
        root.dataset.status = nextRow.status;
        root.dataset.readOnly = String(!isOpen(nextRow));
        replaceHeader(root, { ...detail, row: nextRow }, KICKER);

        if (isOpen(nextRow)) {
            showNotice(root, orphanNotice(nextRow));
            return;
        }

        removeNotice(root, 'orphan');
        lock(controller, nextRow);
        showNotice(root, raceNotice(nextRow, actions.myResponseId?.(nextRow.messageId) ?? null));
    }

    return {
        readOnly: !isOpen(row),
        controller,
        applyRow,
        captureRecovery: () => controller.captureRecovery(),
        restoreRecovery: recovery => controller.restoreRecovery(recovery),
        dispose,
    };
}
