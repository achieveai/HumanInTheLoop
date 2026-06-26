// Main app entry point for the HITL Tauri client frontend.
// Reads question data from URL query param and renders the dialog.

import { renderDialog, showSuccess } from './dialog.js';

let currentQuestionId = null;

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
                    }
                },
                onSkip: async () => {
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
            await getCurrentWindow().show();
            await getCurrentWindow().setFocus();
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
