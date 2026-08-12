// Tauri shell for the plan-review window.
//
// Thin by design: it fetches the payload, injects Tauri-backed callbacks into
// the pure `renderPlanReview`, and forwards window-lifetime events. All review
// behaviour lives in review.js, which knows nothing about Tauri.

import { renderPlanReview, renderReviewPanel } from './review.js';

const container = document.getElementById('review-container');
let controller = null;
let reviewId = null;

/** The wire protocol version this client understands (A-7). */
const SUPPORTED_PROTOCOL_VERSION = 2;

/**
 * The payload leaves the URL entirely (P7/C-10): the Rust side stashes it in
 * PayloadStore keyed by window label and we take it once, here.
 */
async function loadPayload(invoke) {
    const raw = await invoke('take_window_payload');
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

async function init() {
    const { invoke } = window.__TAURI__.core;
    const { listen } = window.__TAURI__.event;

    let message;
    try {
        message = await loadPayload(invoke);
    } catch (err) {
        // Never a blank window: say what failed and what to do about it.
        renderReviewPanel(container, {
            kind: 'error',
            message: `Could not load the plan for review. ${err?.message || err}`,
        });
        await revealWindow(invoke);
        return;
    }

    // A-7. Rust forwards the message whatever its version, so the have/need
    // check is ours to make — and it has to come first, because a newer wire
    // format is exactly the case where our parsing cannot be trusted.
    const version = Number(message?.protocolVersion);
    if (Number.isFinite(version) && version > SUPPORTED_PROTOCOL_VERSION) {
        renderReviewPanel(container, {
            kind: 'upgrade-required',
            have: SUPPORTED_PROTOCOL_VERSION,
            need: version,
            displayPath: message?.displayPath,
        });
        await revealWindow(invoke);
        return;
    }

    // Exactly one of `body` / `_error` is non-null. `_error.kind` is a stable
    // contract string: expired · hash_mismatch · decrypt · corrupt · missing ·
    // unavailable. Only `expired` is the "ask the agent to resend" case; the
    // rest are refusals, and none of them may render a plan.
    if (message?._error) {
        renderReviewPanel(container, {
            kind: message._error.kind || 'error',
            message: message._error.message,
            displayPath: message?.displayPath,
        });
        await revealWindow(invoke);
        return;
    }

    reviewId = message?.messageId || null;
    const wasEncrypted = message?._wasEncrypted === true;

    controller = renderPlanReview(container, message, {
        // Returns {status, responseId, reason} — review.js decides what each
        // status means. A rejection here is a publish that never left.
        onSubmit: (payload) => invoke('submit_plan_review', {
            reviewId: payload.reviewId,
            snapshotHash: payload.snapshotHash,
            verdict: payload.verdict,
            overallFeedback: payload.overallFeedback,
            inlineComments: payload.inlineComments,
            encrypted: wasEncrypted,
        }),
        onSkip: () => invoke('submit_plan_review', {
            reviewId,
            snapshotHash: message?.snapshotHash || '',
            verdict: 'skipped',
            overallFeedback: '',
            inlineComments: [],
            encrypted: wasEncrypted,
        }),
        // Draft persistence is a promise to the human, so a failure is recorded
        // rather than swallowed: the D-3 banner reads this flag and stops
        // claiming the draft was saved. Not surfaced per keystroke — that would
        // be an error message on every character typed.
        onDraftChange: (draft) => {
            invoke('save_review_draft', { draft }).catch(err => {
                console.error('save_review_draft failed:', err);
                controller?.noteDraftSaveFailed();
            });
        },
        // Returning the promise lets review.js fall back to loading in place if
        // the OS hand-off fails, instead of a click that does nothing.
        onOpenExternal: (url) => invoke('open_external', { url }),
    });

    await revealWindow(invoke);

    // Another device reviewed first (D-5/D-6). Emitted only for another device —
    // our own submission never self-fires. Do NOT close the window and do NOT
    // destroy the draft: a 20-minute review must not vanish on a race.
    await listen('review-superseded', (event) => {
        const p = event.payload || {};
        if (p.reviewId && reviewId && p.reviewId !== reviewId) return;
        controller?.setSuperseded(p.respondedFrom);
    });

    // The agent exited (D-3). Comments stay on screen. `reason` is a free
    // string, not an enum — do not switch on it exhaustively.
    await listen('review-cancelled', (event) => {
        const p = event.payload || {};
        if (p.reviewId && reviewId && p.reviewId !== reviewId) return;
        controller?.setCancelled(p.reason);
    });
}

/**
 * Paint before showing, then show without stealing focus (E-10). rAF is paused
 * while the window is hidden on macOS WKWebView, so race it against a timeout —
 * same fallback as app.js:68-71.
 */
async function revealWindow(invoke) {
    await new Promise(resolve => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
        setTimeout(resolve, 100);
    });
    try {
        await invoke('show_no_activate');
    } catch (err) {
        console.error('show_no_activate failed:', err);
    }
}

init().catch(err => {
    console.error('Review window failed to initialise:', err);
    renderReviewPanel(container, { kind: 'error', message: String(err?.message || err) });
});
