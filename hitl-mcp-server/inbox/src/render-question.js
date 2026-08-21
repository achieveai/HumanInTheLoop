// Pane 3 — the question renderer (spec §8.2).
//
// Two modes, one renderer. **Single**: one question, one option list, radio or
// checkbox per `allowMultiple`. **Batch**: up to four sub-questions behind a
// stepper, each with its own `header` chip and its own `allowMultiple` /
// `allowOther`. Both follow the layout the existing `dialog.js` popup uses, so
// answering from the Inbox and answering from the popup are the same gesture.
//
// The controls are drawn here; publishing an `answer` is not this module's job
// (spec §9). `actions.onSubmit` / `actions.onSkip` are the seam — absent, the
// buttons render disabled and say so rather than pretending to send.
//
// # The answered form is not a second renderer
//
// A settled question renders through exactly this code with the inputs locked
// and the winning selection marked. Building a separate read-only view would
// mean two descriptions of what an option looks like, and the read-only one
// would be the one nobody noticed had drifted.

import {
    actionButton,
    contextBlock,
    detailHeader,
    el,
    isOpen,
    renderMarkdownInto,
} from './detail-shell.js';

/** The value an option submits. Matches dialog.js: `value`, else the label. */
function optionValue(option) {
    return option.value || option.label || '';
}

/** What was actually chosen for one question, or `null` while pending. */
function chosen(settlement, index) {
    if (!settlement) return null;
    if (index === null) {
        return {
            values: settlement.selectedValues ?? [],
            otherText: settlement.otherText ?? '',
            skipped: settlement.skipped === true,
        };
    }
    const sub = (settlement.subAnswers ?? [])[index];
    return {
        values: sub?.selectedValues ?? [],
        otherText: sub?.otherText ?? '',
        skipped: settlement.skipped === true,
    };
}

/**
 * One option row.
 *
 * The input is real even when locked — `disabled` rather than replaced with a
 * tick — so the answered form has the same shape as the pending one and a test
 * that reads the selection reads it the same way in both.
 */
function optionRow(option, { name, index, type, locked, isChosen, onFocus }) {
    const row = el('div', 'option');
    row.dataset.index = String(index);
    const value = optionValue(option);
    row.dataset.value = value;

    const input = document.createElement('input');
    input.type = type;
    input.name = name;
    input.id = `${name}-${index}`;
    input.value = value;
    input.disabled = locked;
    if (isChosen) {
        input.checked = true;
        row.classList.add('selected', 'is-chosen');
    }
    row.appendChild(input);

    const content = el('div', 'option-content');
    const label = el('div', 'option-label md-content');
    renderMarkdownInto(label, option.label ?? value);
    content.appendChild(label);
    if (option.description) {
        const description = el('div', 'option-description md-content');
        renderMarkdownInto(description, option.description);
        content.appendChild(description);
    }
    row.appendChild(content);

    if (locked) return row;

    row.addEventListener('click', () => {
        if (type === 'radio') {
            for (const other of row.parentElement.querySelectorAll('.option')) {
                other.classList.remove('selected');
                const otherInput = other.querySelector('input');
                if (otherInput !== input) otherInput.checked = false;
            }
            input.checked = true;
        } else {
            input.checked = !input.checked;
        }
        row.classList.toggle('selected', input.checked);
        if (input.checked) onFocus?.(option);
    });

    return row;
}

/**
 * The option list, with the preview side panel when one is warranted.
 *
 * Preview is single-select only, matching dialog.js: with checkboxes there is
 * no one focused option for the panel to be about.
 */
function optionsSection(question, { name, locked, picked }) {
    const options = Array.isArray(question.options) ? question.options : [];
    const allowMultiple = question.allowMultiple === true;
    const type = allowMultiple ? 'checkbox' : 'radio';
    const hasPreview = !allowMultiple && options.some(o => o.preview);

    const column = el('div', hasPreview ? 'options-column' : 'options-container');
    column.dataset.groupRoot = name;

    let panel = null;
    if (hasPreview) {
        panel = el('div', 'preview-content md-content');
        panel.id = `preview-${name}`;
    }
    const showPreview = option => renderMarkdownInto(panel, option?.preview ?? '');

    options.forEach((option, index) => {
        const isChosen = picked ? picked.values.includes(optionValue(option)) : false;
        column.appendChild(optionRow(option, {
            name,
            index,
            type,
            locked,
            isChosen,
            onFocus: hasPreview ? showPreview : undefined,
        }));
    });

    if (!hasPreview) return column;

    // Whatever was chosen drives the panel; failing that, the first option, so
    // the panel is never blank on arrival. Note that this *shows* the first
    // preview without *selecting* the first option: pre-checking a radio to
    // fill a panel would turn "the reader has not decided" into an answer the
    // agent receives as deliberate.
    showPreview(options.find(o => picked?.values.includes(optionValue(o))) ?? options[0]);

    const wrapper = el('div', 'options-preview-wrapper');
    wrapper.appendChild(column);
    const side = el('aside', 'preview-panel');
    side.appendChild(el('div', 'preview-panel-label', 'Preview'));
    side.appendChild(panel);
    wrapper.appendChild(side);
    return wrapper;
}

/** The free-text field, when the agent said it would read one. */
function otherSection(name, { locked, picked, onSubmit }) {
    const section = el('div', 'other-section');
    const label = el('label', 'other-label', 'Additional Context (optional)');
    label.htmlFor = `other-${name}`;
    section.appendChild(label);

    const input = document.createElement('textarea');
    input.className = 'other-input';
    input.id = `other-${name}`;
    input.rows = 3;
    input.placeholder = 'Provide any additional context, clarifications, or notes…';
    input.disabled = locked;
    if (picked?.otherText) input.value = picked.otherText;

    // Ctrl+Enter submits, matching the popup's shortcut so the habit carries.
    input.addEventListener('keydown', event => {
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            onSubmit?.();
        }
    });

    section.appendChild(input);
    return section;
}

/** The free text someone already sent, shown verbatim (spec §8.2). */
function answeredOther(picked) {
    if (!picked?.otherText) return null;
    const block = el('div', 'other-answered');
    block.appendChild(el('div', 'other-label', 'Additional context given'));
    block.appendChild(el('pre', 'other-answered-text', picked.otherText));
    return block;
}

function subQuestion(question, index, { locked, settlement, onSubmit }) {
    const name = `options-${index}`;
    const picked = chosen(settlement, index);
    const step = el('section', 'sub-question');
    step.dataset.index = String(index);

    const head = el('div', 'sub-question-header');
    if (question.header) head.appendChild(el('span', 'sub-question-chip', question.header));
    const text = el('div', 'sub-question-text md-content');
    renderMarkdownInto(text, question.question ?? '');
    head.appendChild(text);
    step.appendChild(head);

    step.appendChild(optionsSection(question, { name, locked, picked }));

    // `allowOther` defaults to true per sub-question, matching dialog.js.
    if (question.allowOther !== false) {
        step.appendChild(locked
            ? (answeredOther(picked) ?? el('div', 'other-answered other-answered--empty', 'No additional context given.'))
            : otherSection(name, { locked, picked, onSubmit }));
    }

    return step;
}

/** One question visible at a time, with the `header` chips as the tabs. */
function stepper(container, count) {
    const tabs = [...container.querySelectorAll('.stepper-tab')];
    const steps = [...container.querySelectorAll('.sub-question')];
    let current = 0;

    function go(index) {
        if (index < 0 || index >= count) return;
        current = index;
        steps.forEach((step, i) => { step.hidden = i !== index; });
        tabs.forEach((tab, i) => {
            tab.classList.toggle('active', i === index);
            tab.setAttribute('aria-selected', String(i === index));
        });
        container.querySelector('.detail-scroll')?.scrollTo?.(0, 0);
    }

    tabs.forEach((tab, i) => tab.addEventListener('click', () => go(i)));
    go(0);
    return {
        go,
        get current() { return current; },
        get count() { return count; },
    };
}

export function renderQuestion(container, detail, actions = {}) {
    const { row, request, settlement } = detail;
    const subQuestions = Array.isArray(request?.questions) ? request.questions : [];
    const isBatch = subQuestions.length > 0;
    const locked = !isOpen(row);

    container.textContent = '';
    const root = el('article', 'detail-root detail-question');
    root.dataset.messageId = row.messageId;
    root.dataset.status = row.status;
    root.dataset.mode = isBatch ? 'batch' : 'single';

    root.appendChild(detailHeader(detail, isBatch ? `Question · ${subQuestions.length} parts` : 'Question'));

    const scroll = el('div', 'detail-scroll');

    // Context first — why you are being asked (spec §8.2).
    const context = contextBlock(request?.context);
    if (context) scroll.appendChild(context);

    const submit = () => collectAndSubmit();

    if (isBatch) {
        const tabs = el('div', 'stepper-tabs');
        tabs.setAttribute('role', 'tablist');
        subQuestions.forEach((sub, i) => {
            const tab = el('button', 'stepper-tab', sub.header || `Q${i + 1}`);
            tab.type = 'button';
            tab.dataset.step = String(i);
            tab.setAttribute('role', 'tab');
            tabs.appendChild(tab);
        });
        scroll.appendChild(tabs);

        const body = el('div', 'stepper-body');
        subQuestions.forEach((sub, i) => {
            body.appendChild(subQuestion(sub, i, { locked, settlement, onSubmit: submit }));
        });
        scroll.appendChild(body);
    } else {
        const text = el('div', 'question-text md-content');
        renderMarkdownInto(text, request?.question ?? row.title);
        scroll.appendChild(text);

        const picked = chosen(settlement, null);
        scroll.appendChild(optionsSection(request ?? {}, { name: 'options', locked, picked }));

        if (request?.allowOther) {
            scroll.appendChild(locked
                ? (answeredOther(picked) ?? el('div', 'other-answered other-answered--empty', 'No additional context given.'))
                : otherSection('options', { locked, picked, onSubmit: submit }));
        } else if (locked) {
            const extra = answeredOther(picked);
            // The agent said it would not read free text and a device sent some
            // anyway — a batch answer replayed into a single question, say.
            // Showing it is more honest than dropping it.
            if (extra) scroll.appendChild(extra);
        }
    }

    const error = el('p', 'detail-error');
    error.hidden = true;
    error.setAttribute('role', 'alert');
    scroll.appendChild(error);
    root.appendChild(scroll);

    const footer = el('footer', 'detail-actions');
    root.appendChild(footer);
    container.appendChild(root);

    function showError(message) {
        error.textContent = message;
        error.hidden = false;
    }

    function selectionFor(name) {
        return [...root.querySelectorAll(`input[name="${name}"]:checked`)].map(i => i.value);
    }

    function otherFor(name) {
        return root.querySelector(`#other-${name}`)?.value.trim() ?? '';
    }

    function collectAndSubmit() {
        if (locked || !actions.onSubmit) return;
        error.hidden = true;

        if (!isBatch) {
            const selectedValues = selectionFor('options');
            const otherText = request?.allowOther ? otherFor('options') : '';
            if (selectedValues.length === 0 && !otherText) {
                showError('Please select at least one option and/or provide additional context.');
                return;
            }
            actions.onSubmit({ row, selectedValues, otherText, subAnswers: null });
            return;
        }

        const subAnswers = subQuestions.map((sub, i) => {
            const name = `options-${i}`;
            const selectedValues = selectionFor(name);
            const otherText = sub.allowOther !== false ? otherFor(name) : '';
            return {
                questionIndex: i,
                questionText: sub.question,
                selectedValues,
                otherText: otherText || undefined,
                responseType: selectedValues.length && otherText ? 'selection_with_context'
                    : selectedValues.length ? 'selection'
                    : otherText ? 'context_only'
                    : 'none',
            };
        });

        if (!subAnswers.some(a => a.selectedValues.length > 0 || a.otherText)) {
            showError('Please answer at least one question.');
            return;
        }
        actions.onSubmit({ row, selectedValues: [], otherText: '', subAnswers });
    }

    if (locked) {
        // Nothing to press. The header already says who closed it and when.
        footer.appendChild(el('p', 'detail-retained', 'This question is settled. The selection above is what the agent received.'));
        return { locked: true };
    }

    footer.appendChild(actionButton('Skip', 'button-secondary',
        actions.onSkip ? () => actions.onSkip(row) : null));

    if (!isBatch) {
        footer.appendChild(actionButton('Submit Response', 'button-primary',
            actions.onSubmit ? collectAndSubmit : null));
        return { locked: false };
    }

    const previous = actionButton('Previous', 'button-secondary', () => steps.go(steps.current - 1));
    const next = actionButton('Next', 'button-primary', () => {
        if (steps.current < steps.count - 1) {
            steps.go(steps.current + 1);
        } else {
            collectAndSubmit();
        }
    });
    footer.appendChild(previous);
    footer.appendChild(next);

    const steps = stepper(root, subQuestions.length);
    const paint = () => {
        previous.hidden = steps.current === 0;
        next.textContent = steps.current === steps.count - 1 ? 'Submit Response' : 'Next';
        for (const [i, tab] of [...root.querySelectorAll('.stepper-tab')].entries()) {
            tab.classList.toggle('answered', i !== steps.current && answeredStep(i));
        }
    };

    function answeredStep(index) {
        const step = root.querySelector(`.sub-question[data-index="${index}"]`);
        if (!step) return false;
        return step.querySelector('input:checked') !== null
            || (step.querySelector('.other-input')?.value.trim().length ?? 0) > 0;
    }

    // The stepper's own `go` repaints the steps; this repaints the footer and
    // the tab states around it, on every move and on every edit.
    for (const tab of root.querySelectorAll('.stepper-tab')) tab.addEventListener('click', paint);
    previous.addEventListener('click', paint);
    next.addEventListener('click', paint);
    root.querySelector('.stepper-body')?.addEventListener('change', paint);
    root.querySelector('.stepper-body')?.addEventListener('input', paint);
    paint();

    return { locked: false, steps };
}
