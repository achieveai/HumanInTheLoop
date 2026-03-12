// Dialog rendering and interaction logic for the HITL Tauri client.

/**
 * Escape HTML to prevent XSS in user-provided content.
 */
function escapeHtml(text) {
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
    return text.replace(/[&<>"']/g, m => map[m]);
}

/**
 * Render the full dialog HTML for a question into the container.
 */
export function renderDialog(container, question, callbacks) {
    const { options, allowMultiple, allowOther, context: llmContext, repo } = question;

    // Build metadata badges
    let metaBadges = '';
    if (repo) {
        metaBadges += `<span class="badge"><span class="badge-icon">📁</span> ${escapeHtml(repo.name)}</span>`;
        if (repo.branch) {
            metaBadges += `<span class="badge"><span class="badge-icon">🌿</span> ${escapeHtml(repo.branch)}</span>`;
        }
    }

    // Build options HTML
    const inputType = allowMultiple ? 'checkbox' : 'radio';
    const optionsHtml = options.map((opt, i) => `
        <div class="option" data-index="${i}">
            <input type="${inputType}" name="options" id="option-${i}" value="${escapeHtml(opt.value)}">
            <div class="option-content">
                <div class="option-label">${escapeHtml(opt.label)}</div>
                ${opt.description ? `<div class="option-description">${escapeHtml(opt.description)}</div>` : ''}
            </div>
        </div>
    `).join('');

    const otherHtml = allowOther ? `
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
            <div class="question">${escapeHtml(question.question)}</div>
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
            <div class="options-container">${optionsHtml}</div>
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

    // Wire up option click handlers
    container.querySelectorAll('.option').forEach(optionDiv => {
        optionDiv.addEventListener('click', () => {
            const input = optionDiv.querySelector('input');
            if (!allowMultiple) {
                container.querySelectorAll('.option').forEach(el => el.classList.remove('selected'));
                container.querySelectorAll('input[name="options"]').forEach(el => el.checked = false);
            }
            input.checked = !input.checked;
            optionDiv.classList.toggle('selected', input.checked);
        });
    });

    // Wire up buttons
    document.getElementById('btn-submit').addEventListener('click', () => {
        const selected = [];
        container.querySelectorAll('input[name="options"]:checked').forEach(el => {
            selected.push(el.value);
        });
        const otherText = allowOther ? document.getElementById('other-input')?.value?.trim() || '' : '';

        if (selected.length === 0 && !otherText) {
            showError('Please select at least one option and/or provide additional context');
            return;
        }

        callbacks.onSubmit(selected, otherText);
    });

    document.getElementById('btn-skip').addEventListener('click', () => {
        callbacks.onSkip();
    });

    document.getElementById('btn-close')?.addEventListener('click', () => {
        window.close();
    });

    // Ctrl+Enter to submit from textarea
    if (allowOther) {
        document.getElementById('other-input')?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && e.ctrlKey) {
                document.getElementById('btn-submit').click();
            }
        });
    }
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
