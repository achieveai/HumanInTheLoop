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
function renderMarkdown(text, inline = false) {
    if (!text) return '';
    if (typeof marked === 'undefined') return escapeHtml(text);
    try {
        marked.setOptions({ breaks: true, gfm: true });
        return inline ? marked.parseInline(text) : marked.parse(text);
    } catch {
        return escapeHtml(text);
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
            <span class="dialog-titlebar-label">HITL</span>
            <button class="dialog-close" id="btn-close" title="Close">✕</button>
        </div>
        <div class="dialog-scroll">
            <div class="header">
                <h1 class="title">Human Input Required</h1>
                <p class="subtitle">An AI agent needs your guidance to continue</p>
            </div>
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
            <div class="button-container">
                <button class="button button-secondary" id="btn-skip">Skip</button>
                <button class="button button-primary" id="btn-submit">Submit Response</button>
            </div>
        </div>
    `;

    // Render markdown context
    if (llmContext && typeof marked !== 'undefined') {
        const contextEl = document.getElementById('context-content');
        if (contextEl) {
            try {
                marked.setOptions({ breaks: true, gfm: true });
                contextEl.innerHTML = marked.parse(llmContext);
            } catch {
                contextEl.textContent = llmContext;
            }
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
    document.getElementById('btn-submit').addEventListener('click', () => {
        if (isBatch) {
            const subAnswers = collectBatchAnswers(container, question.questions);
            const hasAnyAnswer = subAnswers.some(sa => sa.selectedValues.length > 0 || sa.otherText);
            if (!hasAnyAnswer) {
                showError('Please answer at least one question');
                return;
            }
            callbacks.onSubmit([], null, subAnswers);
        } else {
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
        }
    });

    document.getElementById('btn-skip').addEventListener('click', () => {
        callbacks.onSkip();
    });

    document.getElementById('btn-close')?.addEventListener('click', () => {
        window.close();
    });

    // Ctrl+Enter to submit from textarea
    container.querySelectorAll('.other-input').forEach(textarea => {
        textarea.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && e.ctrlKey) {
                document.getElementById('btn-submit').click();
            }
        });
    });
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
    return subQuestions.map((sq, i) => {
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

        return `
            <div class="sub-question" id="sub-question-${i}" data-index="${i}">
                <div class="sub-question-header">
                    ${headerChip}
                    <div class="sub-question-text md-content">${renderMarkdown(sq.question)}</div>
                </div>
                ${optionsSection}
                ${otherHtml}
            </div>
        `;
    }).join('');
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
