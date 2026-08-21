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

import { renderPlanReview, renderReviewPanel } from './review.js';
import { detailHeader, el, isOpen } from './detail-shell.js';

/** The reply path is Task 9's. Until then, saying so beats a silent no-op. */
const UNATTACHED = 'Replying from the Inbox is not attached yet.';

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
        return {
            kind: 'unavailable',
            reason: 'unattempted',
            message: 'The archivist has not fetched this plan’s body yet. Give it a moment and reopen this message.',
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

export function renderReview(container, detail, body, actions = {}) {
    const { row } = detail;

    container.textContent = '';
    const root = el('article', 'detail-root detail-review');
    root.dataset.messageId = row.messageId;
    root.dataset.status = row.status;
    root.appendChild(detailHeader(detail, 'Plan review'));

    const host = el('div', 'detail-review-host');
    root.appendChild(host);
    container.appendChild(root);

    if (body?.outcome !== 'ok') {
        const state = panelStateFor(body);
        renderReviewPanel(host, state);
        const panel = host.querySelector('.review-panel');
        if (panel) panel.dataset.reason = state.reason;
        root.dataset.readOnly = 'true';
        return { readOnly: true, reason: state.reason, kind: state.kind };
    }

    root.dataset.readOnly = String(!isOpen(row));

    // No handler means no reply path yet (Task 9). Rejecting is what makes
    // review.js print "nothing was sent" — which is true — instead of its
    // "sent but unconfirmed" notice, which would not be.
    const controller = renderPlanReview(host, planMessage(detail, body), {
        onSubmit: actions.onSubmit ?? (() => Promise.reject(new Error(UNATTACHED))),
        onSkip: actions.onSkip ?? (() => Promise.reject(new Error(UNATTACHED))),
        onCancel: actions.onCancel,
        onDraftChange: actions.onDraftChange,
        onReceived: actions.onReceived,
    });

    // A settled review keeps its plan and its comments on screen and loses its
    // controls. `setSuperseded`/`setCancelled` are exactly that, and they are
    // already what the client uses when the race is lost mid-review — so the
    // Inbox opening an already-closed review looks the same as watching one
    // close under you, which is one behaviour to learn instead of two.
    if (!isOpen(row)) {
        if (row.status === 'cancelled') {
            controller.setCancelled('cancelled');
        } else if (row.status === 'agent_gone') {
            controller.setCancelled('agent_gone');
        } else {
            controller.setSuperseded(row.responder);
        }
    }

    return { readOnly: !isOpen(row), controller };
}
