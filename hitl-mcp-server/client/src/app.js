// Main app entry point for the HITL Tauri client frontend.
// Reads question data from URL query param and renders the dialog.

import { renderDialog, showSuccess } from './dialog.js';

let currentQuestionId = null;

/**
 * Report a failed submit without destroying what the human typed (C-6 / P3).
 *
 * Before this, a failed `invoke('submit_answer', …)` was caught with nothing but
 * a `console.error` — which release builds discard on Windows, since main.rs:1
 * sets `#![windows_subsystem = "windows"]`. The click produced no error, no
 * success screen and no retry prompt: the answer simply never left the machine
 * while the agent stayed blocked waiting for it.
 *
 * The message is persistent (no auto-hide) because the user has to act on it,
 * and every selection and every character of typed context stays in the DOM so
 * a second click on Submit re-sends the same answer.
 */
function showSubmitError(message) {
    const el = document.getElementById('error-message');
    if (!el) return;
    el.textContent = message;
    el.style.display = 'block';
    el.scrollIntoView({ block: 'nearest' });
}

function clearSubmitError() {
    const el = document.getElementById('error-message');
    if (!el) return;
    el.textContent = '';
    el.style.display = 'none';
}

async function init() {
    const { listen } = window.__TAURI__.event;
    const { invoke } = window.__TAURI__.core;
    const { getCurrentWindow } = window.__TAURI__.window;

    const dialogContainer = document.getElementById('dialog-container');
    const dismissedContainer = document.getElementById('dismissed-container');

    // Read question data from URL query parameter (set by Rust backend)
    const params = new URLSearchParams(window.location.search);
    const questionParam = params.get('question');
    const wasEncrypted = params.get('encrypted') === 'true';

    if (questionParam) {
        try {
            const question = JSON.parse(questionParam);
            currentQuestionId = question.messageId;

            dismissedContainer.style.display = 'none';
            dialogContainer.style.display = 'block';

            renderDialog(dialogContainer, question, {
                onSubmit: async (selectedValues, otherText, subAnswers) => {
                    clearSubmitError();
                    try {
                        await invoke('submit_answer', {
                            questionId: currentQuestionId,
                            selectedValues,
                            otherText: otherText || null,
                            skipped: false,
                            subAnswers: subAnswers || null,
                            encrypted: wasEncrypted,
                        });
                        showSuccess(dialogContainer);
                        setTimeout(() => getCurrentWindow().close(), 2000);
                    } catch (err) {
                        console.error('Submit failed:', err);
                        showSubmitError(`Could not send your answer: ${err?.message || err}. `
                            + 'Your response is still here — press Submit again to retry.');
                    }
                },
                onSkip: async () => {
                    clearSubmitError();
                    try {
                        await invoke('submit_answer', {
                            questionId: currentQuestionId,
                            selectedValues: [],
                            otherText: null,
                            skipped: true,
                            subAnswers: null,
                            encrypted: wasEncrypted,
                        });
                        showSuccess(dialogContainer, 'Question skipped');
                        setTimeout(() => getCurrentWindow().close(), 2000);
                    } catch (err) {
                        console.error('Skip failed:', err);
                        showSubmitError(`Could not send the skip: ${err?.message || err}. `
                            + 'Nothing was sent — press Skip again to retry.');
                    }
                },
            });

            // Show window only after content is painted (prevents flash). On macOS
            // WKWebView, requestAnimationFrame is paused while the window is hidden,
            // so the rAF callback would never fire and show() would never run. Race
            // it against a short timeout fallback (timers still fire while hidden).
            await new Promise(resolve => {
                requestAnimationFrame(() => requestAnimationFrame(resolve));
                setTimeout(resolve, 100);
            });
            await invoke('show_no_activate');
        } catch (err) {
            console.error('Failed to parse question from URL:', err);
            dialogContainer.innerHTML = '<p style="color:red;padding:24px;">Failed to load question data.</p>';
        }
    }

    // Listen for dismiss events (another device answered)
    await listen('dismiss-question', (event) => {
        const answer = event.payload;

        if (answer.questionId === currentQuestionId) {
            dialogContainer.style.display = 'none';
            dismissedContainer.style.display = 'block';

            const deviceEl = document.getElementById('dismissed-device');
            if (deviceEl) {
                deviceEl.textContent = `Answered by: ${answer.respondedFrom}`;
            }

            setTimeout(() => getCurrentWindow().close(), 3000);
        }
    });
}

init().catch(console.error);
