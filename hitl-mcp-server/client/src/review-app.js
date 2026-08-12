// Tauri shell for the plan-review window.
//
// Thin by design: it fetches the payload, injects Tauri-backed callbacks into
// the pure `renderPlanReview`, and forwards window-lifetime events. All review
// behaviour lives in review.js, which knows nothing about Tauri.

import { renderPlanReview, renderReviewPanel } from './review.js';

const container = document.getElementById('review-container');
let controller = null;
let reviewId = null;

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

    // States that arrive with no reviewable body at all.
    if (message?.state === 'expired' || message?.state === 'upgrade-required' || message?.state === 'error') {
        renderReviewPanel(container, message);
        await revealWindow(invoke);
        return;
    }

    reviewId = message?.messageId || null;
    const wasEncrypted = new URLSearchParams(window.location.search).get('encrypted') === 'true';

    controller = renderPlanReview(container, message, {
        onSubmit: async (payload) => {
            const result = await invoke('submit_plan_review', {
                reviewId: payload.reviewId,
                snapshotHash: payload.snapshotHash,
                verdict: payload.verdict,
                overallFeedback: payload.overallFeedback,
                inlineComments: payload.inlineComments,
                encrypted: wasEncrypted,
            });
            // C-12: the ack is what proves the server actually read the body.
            // Response attachments expire in 3 h, so "the PUT succeeded" is not
            // the same as "delivered" — treat 'lost' as a failed submit so the
            // C-6 path keeps the window open with every comment intact.
            if (result && result.status === 'lost') {
                throw new Error(result.reason || 'the agent never received it.');
            }
            return result;
        },
        onSkip: async () => {
            const result = await invoke('submit_plan_review', {
                reviewId,
                snapshotHash: message?.snapshotHash || '',
                verdict: 'skipped',
                overallFeedback: '',
                inlineComments: [],
                encrypted: wasEncrypted,
            });
            if (result && result.status === 'lost') {
                throw new Error(result.reason || 'the agent never received it.');
            }
            return result;
        },
        onDraftChange: (draft) => {
            // Best-effort: a client without the command must not break editing.
            invoke('save_review_draft', { draft }).catch(() => {});
        },
        onOpenExternal: (url) => {
            invoke('open_external', { url }).catch(err => console.error('open_external failed:', err));
        },
    });

    await revealWindow(invoke);

    // Another device reviewed first (D-5/D-6). Do NOT close the window and do
    // NOT destroy the draft — a 20-minute review must not vanish on a race.
    await listen('review-superseded', (event) => {
        const p = event.payload || {};
        if (p.reviewId && reviewId && p.reviewId !== reviewId) return;
        controller?.setSuperseded(p.respondedFrom || p.device);
    });

    // The agent exited (D-3). Comments stay on screen and are persisted.
    await listen('review-cancelled', (event) => {
        const p = event.payload || {};
        if (p.reviewId && reviewId && p.reviewId !== reviewId) return;
        controller?.setCancelled(p.reason);
    });

    // A late ack that downgrades a submit we already reported as sent.
    await listen('review-ack', (event) => {
        const p = event.payload || {};
        if (p.reviewId && reviewId && p.reviewId !== reviewId) return;
        if (p.status === 'lost') controller?.reoffer(p.reason);
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
