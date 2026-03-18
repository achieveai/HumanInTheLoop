// Dialog rendering and interaction logic for the HITL Tauri client.

/**
 * Escape HTML to prevent XSS in user-provided content.
 */
function escapeHtml(text) {
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
    return String(text).replace(/[&<>"']/g, m => map[m]);
}

/**
 * Render markdown text to HTML. Falls back to escapeHtml if marked is unavailable.
 */
/**
 * Normalize literal \n sequences (backslash + n from JSON round-trips) to real newlines.
 */
function normalizeNewlines(text) {
    return text ? text.replace(/\\n/g, '\n') : '';
}

function renderMarkdown(text, inline = false) {
    if (!text) return '';
    text = normalizeNewlines(text);
    if (typeof marked === 'undefined') {
        return escapeHtml(text).replace(/\n/g, '<br>');
    }
    try {
        marked.setOptions({ breaks: true, gfm: true });
        return inline ? marked.parseInline(text) : marked.parse(text);
    } catch {
        return escapeHtml(text).replace(/\n/g, '<br>');
    }
}

/**
 * Build the HTML for a single set of options (shared by single-question and sub-question).
 */
function buildOptionsHtml(options, inputType, groupName) {
    return options.map((opt, i) => `
        <div class="option" data-index="${i}">
            <input type="${inputType}" name="${groupName}" id="${groupName}-${i}" value="${escapeHtml(opt.value)}">
            <div class="option-content">
                <div class="option-label">${renderMarkdown(opt.label, true)}</div>
                ${opt.description ? `<div class="option-description">${renderMarkdown(opt.description)}</div>` : ''}
            </div>
        </div>
    `).join('');
}

/**
 * Update a preview panel with rendered markdown.
 */
function updatePreviewPanel(panelId, markdown) {
    const el = document.getElementById(panelId);
    if (!el) return;
    el.innerHTML = renderMarkdown(markdown || '');
}

/**
 * Render the full dialog HTML for a question into the container.
 */
export function renderDialog(container, question, callbacks) {
    const { context: llmContext, repo } = question;
    const isBatch = Array.isArray(question.questions) && question.questions.length > 0;

    // Build metadata badges
    let metaBadges = '';
    if (repo) {
        metaBadges += `<span class="badge"><span class="badge-icon">📁</span> ${escapeHtml(repo.name)}</span>`;
        if (repo.branch) {
            metaBadges += `<span class="badge"><span class="badge-icon">🌿</span> ${escapeHtml(repo.branch)}</span>`;
        }
    }

    let mainContentHtml;

    if (isBatch) {
        mainContentHtml = renderBatchQuestions(question.questions);
    } else {
        mainContentHtml = renderSingleQuestion(question);
    }

    const otherHtml = (!isBatch && question.allowOther) ? `
        <div class="other-section">
            <label class="other-label" for="other-input">Additional Context (optional):</label>
            <textarea class="other-input" id="other-input" rows="3"
                placeholder="Provide any additional context, clarifications, or notes..."></textarea>
        </div>
    ` : '';

    container.innerHTML = `
        <div class="dialog-titlebar">
            <span class="dialog-titlebar-label">Human Input Required</span>
            <button class="dialog-close" id="btn-close" title="Close">✕</button>
        </div>
        <div class="dialog-scroll">
            ${metaBadges ? `<div class="meta-row">${metaBadges}</div>` : ''}
            ${!isBatch ? `<div class="question md-content">${renderMarkdown(question.question)}</div>` : ''}
            ${llmContext ? `
                <div class="context-section">
                    <button class="context-toggle" id="context-toggle">
                        <span class="arrow open" id="context-arrow">▶</span> Context
                    </button>
                    <div class="context-body" id="context-body">
                        <div id="context-content"></div>
                    </div>
                </div>
            ` : ''}
            ${mainContentHtml}
            ${otherHtml}
            <div class="error-message" id="error-message"></div>
        </div>
        <div class="dialog-footer">
            ${isBatch ? `
            <div class="button-container stepper-footer">
                <button class="button button-secondary" id="btn-skip">Skip</button>
                <button class="button button-secondary" id="btn-prev" style="display:none">Previous</button>
                <button class="button button-primary" id="btn-next">Next</button>
            </div>
            ` : `
            <div class="button-container">
                <button class="button button-secondary" id="btn-skip">Skip</button>
                <button class="button button-primary" id="btn-submit">Submit Response</button>
            </div>
            `}
        </div>
    `;

    // Render markdown context
    if (llmContext) {
        const contextEl = document.getElementById('context-content');
        if (contextEl) {
            contextEl.innerHTML = renderMarkdown(llmContext);
        }
    }

    // Wire up context toggle
    const toggleBtn = document.getElementById('context-toggle');
    if (toggleBtn) {
        toggleBtn.addEventListener('click', () => {
            const body = document.getElementById('context-body');
            const arrow = document.getElementById('context-arrow');
            const isHidden = body.style.display === 'none';
            body.style.display = isHidden ? 'block' : 'none';
            arrow.classList.toggle('open', isHidden);
        });
    }

    if (isBatch) {
        wireBatchOptions(container, question.questions);
    } else {
        wireSingleOptions(container, question);
    }

    // Wire up buttons
    if (isBatch) {
        initBatchStepper(container, question.questions, callbacks);
    } else {
        document.getElementById('btn-submit').addEventListener('click', () => {
            const selected = [];
            container.querySelectorAll('input[name="options"]:checked').forEach(el => {
                selected.push(el.value);
            });
            const otherText = question.allowOther ? document.getElementById('other-input')?.value?.trim() || '' : '';

            if (selected.length === 0 && !otherText) {
                showError('Please select at least one option and/or provide additional context');
                return;
            }
            callbacks.onSubmit(selected, otherText);
        });

        document.getElementById('btn-skip').addEventListener('click', () => {
            callbacks.onSkip();
        });
    }

    document.getElementById('btn-close')?.addEventListener('click', () => {
        if (window.__TAURI__?.window?.getCurrentWindow) {
            window.__TAURI__.window.getCurrentWindow().close();
        } else {
            window.close();
        }
    });

    // Ctrl+Enter to submit from textarea
    container.querySelectorAll('.other-input').forEach(textarea => {
        textarea.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && e.ctrlKey) {
                const btn = document.getElementById('btn-submit') || document.getElementById('btn-next');
                if (btn) btn.click();
            }
        });
    });

    // Guard against accidental keypresses when window steals focus.
    // Block Enter/Space on footer buttons for a short window after render.
    let inputGuardActive = true;
    setTimeout(() => { inputGuardActive = false; }, 500);
    container.querySelector('.dialog-footer')?.addEventListener('keydown', (e) => {
        if (inputGuardActive && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault();
            e.stopPropagation();
        }
    }, true);

    // Ensure no button has focus on initial render
    document.activeElement?.blur?.();
}

/**
 * Render HTML for a single question (non-batch).
 */
function renderSingleQuestion(question) {
    const { options, allowMultiple } = question;
    const inputType = allowMultiple ? 'checkbox' : 'radio';
    const hasPreview = !allowMultiple && options.some(o => o.preview);
    const optionsHtml = buildOptionsHtml(options, inputType, 'options');

    if (hasPreview) {
        const initialPreview = renderMarkdown(options[0]?.preview || '');
        return `
            <div class="options-preview-wrapper">
                <div class="options-column" data-group-root="options">${optionsHtml}</div>
                <div class="preview-panel">
                    <div class="preview-panel-label">Preview</div>
                    <div class="preview-content md-content" id="preview-panel-options">${initialPreview}</div>
                </div>
            </div>
        `;
    }

    return `<div class="options-container" data-group-root="options">${optionsHtml}</div>`;
}

/**
 * Render HTML for batch questions.
 */
function renderBatchQuestions(subQuestions) {
    // Build stepper tabs
    const tabs = subQuestions.map((sq, i) => {
        const label = sq.header || `Q${i + 1}`;
        return `<button class="stepper-tab${i === 0 ? ' active' : ''}" data-step="${i}">${escapeHtml(label)}</button>`;
    }).join('');

    const tabsHtml = `<div class="stepper-tabs">${tabs}</div>`;

    const stepsHtml = subQuestions.map((sq, i) => {
        const inputType = (sq.allowMultiple ?? false) ? 'checkbox' : 'radio';
        const groupName = `options-${i}`;
        const hasPreview = !(sq.allowMultiple ?? false) && sq.options.some(o => o.preview);
        const optionsHtml = buildOptionsHtml(sq.options, inputType, groupName);

        const otherHtml = (sq.allowOther !== false) ? `
            <div class="other-section">
                <label class="other-label" for="other-input-${i}">Additional Context (optional):</label>
                <textarea class="other-input" id="other-input-${i}" rows="2"
                    placeholder="Provide any additional context..."></textarea>
            </div>
        ` : '';

        let optionsSection;
        if (hasPreview) {
            const initialPreview = renderMarkdown(sq.options[0]?.preview || '');
            optionsSection = `
                <div class="options-preview-wrapper">
                    <div class="options-column" data-group-root="${groupName}">${optionsHtml}</div>
                    <div class="preview-panel">
                        <div class="preview-panel-label">Preview</div>
                        <div class="preview-content md-content" id="preview-panel-${groupName}">${initialPreview}</div>
                    </div>
                </div>
            `;
        } else {
            optionsSection = `<div class="options-container" data-group-root="${groupName}">${optionsHtml}</div>`;
        }

        const headerChip = sq.header ? `<span class="sub-question-chip">${escapeHtml(sq.header)}</span>` : '';

        const hiddenClass = i === 0 ? '' : ' stepper-step-hidden';
        return `
            <div class="sub-question${hiddenClass}" id="sub-question-${i}" data-index="${i}">
                <div class="sub-question-header">
                    ${headerChip}
                    <div class="sub-question-text md-content">${renderMarkdown(sq.question)}</div>
                </div>
                ${optionsSection}
                ${otherHtml}
            </div>
        `;
    }).join('');

    return tabsHtml + `<div class="stepper-body">${stepsHtml}</div>`;
}

/**
 * Wire up option interactions for single-question mode.
 */
function wireSingleOptions(container, question) {
    const { options, allowMultiple } = question;
    const hasPreview = !allowMultiple && options.some(o => o.preview);

    container.querySelectorAll('[data-group-root="options"] .option').forEach((optionDiv, i) => {
        optionDiv.addEventListener('click', () => {
            const input = optionDiv.querySelector('input');
            if (!allowMultiple) {
                container.querySelectorAll('input[name="options"]').forEach(el => {
                    el.checked = false;
                    el.closest('.option')?.classList.remove('selected');
                });
            }
            input.checked = !input.checked;
            optionDiv.classList.toggle('selected', input.checked);

            if (hasPreview && input.checked) {
                updatePreviewPanel('preview-panel-options', options[i]?.preview || '');
            }
        });
    });

    // Select first option by default when preview is active
    if (hasPreview && options.length > 0) {
        const firstInput = container.querySelector('input[name="options"]');
        if (firstInput) {
            firstInput.checked = true;
            firstInput.closest('.option')?.classList.add('selected');
        }
    }
}

/**
 * Wire up option interactions for each sub-question in batch mode.
 */
function wireBatchOptions(container, subQuestions) {
    subQuestions.forEach((sq, i) => {
        const groupName = `options-${i}`;
        const allowMultiple = sq.allowMultiple ?? false;
        const hasPreview = !allowMultiple && sq.options.some(o => o.preview);

        container.querySelectorAll(`[data-group-root="${groupName}"] .option`).forEach((optionDiv, j) => {
            optionDiv.addEventListener('click', () => {
                const input = optionDiv.querySelector('input');
                if (!allowMultiple) {
                    container.querySelectorAll(`input[name="${groupName}"]`).forEach(el => {
                        el.checked = false;
                        el.closest('.option')?.classList.remove('selected');
                    });
                }
                input.checked = !input.checked;
                optionDiv.classList.toggle('selected', input.checked);

                if (hasPreview && input.checked) {
                    updatePreviewPanel(`preview-panel-${groupName}`, sq.options[j]?.preview || '');
                }
            });
        });

        // Select first option by default when preview is active
        if (hasPreview && sq.options.length > 0) {
            const firstInput = container.querySelector(`input[name="${groupName}"]`);
            if (firstInput) {
                firstInput.checked = true;
                firstInput.closest('.option')?.classList.add('selected');
            }
        }
    });
}

/**
 * Initialize the batch stepper controller — one question visible at a time.
 */
function initBatchStepper(container, subQuestions, callbacks) {
    let currentStep = 0;
    const totalSteps = subQuestions.length;
    const tabs = container.querySelectorAll('.stepper-tab');
    const steps = container.querySelectorAll('.stepper-body .sub-question');
    const btnSkip = document.getElementById('btn-skip');
    const btnPrev = document.getElementById('btn-prev');
    const btnNext = document.getElementById('btn-next');
    const scrollArea = container.querySelector('.dialog-scroll');

    function isStepAnswered(index) {
        const step = steps[index];
        if (!step) return false;
        const hasChecked = step.querySelector('input:checked') !== null;
        const textarea = step.querySelector('.other-input');
        const hasText = textarea ? textarea.value.trim().length > 0 : false;
        return hasChecked || hasText;
    }

    function updateTabStates() {
        tabs.forEach((tab, i) => {
            tab.classList.toggle('active', i === currentStep);
            tab.classList.toggle('answered', i !== currentStep && isStepAnswered(i));
        });
    }

    function updateFooterButtons() {
        // Skip only on first step
        btnSkip.style.display = currentStep === 0 ? '' : 'none';
        // Previous hidden on first step
        btnPrev.style.display = currentStep > 0 ? '' : 'none';
        // Last step shows "Submit Response", others show "Next"
        if (currentStep === totalSteps - 1) {
            btnNext.textContent = 'Submit Response';
        } else {
            btnNext.textContent = 'Next';
        }
    }

    function goToStep(index) {
        if (index < 0 || index >= totalSteps) return;
        steps.forEach((step, i) => {
            step.classList.toggle('stepper-step-hidden', i !== index);
        });
        currentStep = index;
        updateTabStates();
        updateFooterButtons();
        if (scrollArea) scrollArea.scrollTop = 0;
    }

    // Tab clicks
    tabs.forEach((tab, i) => {
        tab.addEventListener('click', () => goToStep(i));
    });

    // Previous button
    btnPrev.addEventListener('click', () => goToStep(currentStep - 1));

    // Next / Submit button
    btnNext.addEventListener('click', () => {
        if (currentStep < totalSteps - 1) {
            goToStep(currentStep + 1);
        } else {
            // Last step — collect and submit
            const subAnswers = collectBatchAnswers(container, subQuestions);
            const hasAnyAnswer = subAnswers.some(sa => sa.selectedValues.length > 0 || sa.otherText);
            if (!hasAnyAnswer) {
                showError('Please answer at least one question');
                return;
            }
            callbacks.onSubmit([], null, subAnswers);
        }
    });

    // Skip button
    btnSkip.addEventListener('click', () => callbacks.onSkip());

    // Real-time tab state updates on input changes
    const stepperBody = container.querySelector('.stepper-body');
    if (stepperBody) {
        stepperBody.addEventListener('change', () => updateTabStates());
        stepperBody.addEventListener('input', () => updateTabStates());
    }

    // Initialize
    goToStep(0);
}

/**
 * Collect answers from all sub-questions in batch mode.
 */
function collectBatchAnswers(container, subQuestions) {
    return subQuestions.map((sq, i) => {
        const groupName = `options-${i}`;
        const selected = [];
        container.querySelectorAll(`input[name="${groupName}"]:checked`).forEach(el => selected.push(el.value));
        const otherInput = document.getElementById(`other-input-${i}`);
        const otherText = (sq.allowOther !== false) ? (otherInput?.value?.trim() || '') : '';

        // Find preview of selected option
        let selectedPreview;
        if (selected.length > 0 && !sq.allowMultiple) {
            const selectedOpt = sq.options.find(o => o.value === selected[0]);
            selectedPreview = selectedOpt?.preview;
        }

        let responseType = 'none';
        if (selected.length > 0 && otherText) responseType = 'selection_with_context';
        else if (selected.length > 0) responseType = 'selection';
        else if (otherText) responseType = 'context_only';

        return {
            questionIndex: i,
            questionText: sq.question,
            selectedValues: selected,
            otherText: otherText || undefined,
            responseType,
            selectedPreview,
        };
    });
}

function showError(message) {
    const el = document.getElementById('error-message');
    if (el) {
        el.textContent = message;
        el.style.display = 'block';
        setTimeout(() => { el.style.display = 'none'; }, 5000);
    }
}

/**
 * Show success state after submission.
 */
export function showSuccess(container, message = 'Response submitted successfully!') {
    container.innerHTML = `
        <div class="success-container">
            <div class="success-icon">✓</div>
            <h2 class="success-title">${escapeHtml(message)}</h2>
            <p class="success-subtitle">You can close this window now.</p>
        </div>
    `;
}
