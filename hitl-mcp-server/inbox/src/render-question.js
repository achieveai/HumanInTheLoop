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
//
// # Losing the race must not cost the typing
//
// A question has no draft store — nothing persists "Additional Context" to
// disk the way `drafts.rs` persists review comments. So when another device
// answers first, the form is locked *in place*: `applyRow` redraws the header,
// slides in the banner and disables the inputs, and never rebuilds the body.
// Re-rendering would be simpler and would silently discard a paragraph the
// reader had been typing for a minute, which is the one outcome §9.3 rules out
// in as many words.

import {
    actionButton,
    contextBlock,
    detailHeader,
    el,
    isOpen,
    removeNotice,
    renderMarkdownInto,
    replaceHeader,
    showNotice,
} from './detail-shell.js';
import { orphanNotice, raceNotice } from './reply.js';

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

/** The footer note on a question that closed with this device's answer. */
const SETTLED = 'This question is settled. The selection above is what the agent received.';

export function renderQuestion(container, detail, actions = {}) {
    const { row, request, settlement } = detail;
    const subQuestions = Array.isArray(request?.questions) ? request.questions : [];
    const isBatch = subQuestions.length > 0;
    const locked = !isOpen(row);
    const kicker = isBatch ? `Question · ${subQuestions.length} parts` : 'Question';

    container.textContent = '';
    const root = el('article', 'detail-root detail-question');
    root.dataset.messageId = row.messageId;
    root.dataset.status = row.status;
    root.dataset.mode = isBatch ? 'batch' : 'single';

    root.appendChild(detailHeader(detail, kicker));

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

    // Submitting is a state, not a moment (spec §9.3): the publish is a network
    // round trip and the window must not look frozen while it happens.
    const progress = el('p', 'detail-progress');
    progress.hidden = true;
    progress.setAttribute('role', 'status');
    scroll.appendChild(progress);

    root.appendChild(scroll);

    const footer = el('footer', 'detail-actions');
    root.appendChild(footer);
    container.appendChild(root);

    // Spec §16.5, on first paint: a decayed request is marked as the probable
    // orphan it is rather than drawn as ordinary live work.
    showNotice(root, orphanNotice(row));

    function showError(message) {
        error.textContent = message;
        error.hidden = false;
        progress.hidden = true;
    }

    function showProgress(message) {
        progress.textContent = message;
        progress.hidden = false;
        error.hidden = true;
    }

    /** Nobody may act on this any more: it settled, here or somewhere else. */
    let settled = locked;
    /** A publish is in flight. Distinct from `settled` — this one can be undone. */
    let busy = false;

    function setBusy(value) {
        busy = value;
        for (const button of footer.querySelectorAll('.button')) {
            button.disabled = value || settled;
        }
    }

    function lockForm() {
        settled = true;
        for (const input of scroll.querySelectorAll('input, textarea')) {
            input.disabled = true;
        }
        setBusy(false);
    }

    /**
     * The message's folded status moved while this pane was open (spec §9.3).
     *
     * Called by `pane-detail.js` instead of a re-render, which is the whole
     * point: everything below the header — including whatever the reader has
     * typed into "Additional Context" — is left exactly where it is.
     */
    function applyRow(nextRow) {
        root.dataset.status = nextRow.status;
        replaceHeader(root, { ...detail, row: nextRow }, kicker);

        if (isOpen(nextRow)) {
            // Still open. The only move available here is pending → stale, so
            // the orphan mark may need to appear.
            showNotice(root, orphanNotice(nextRow));
            return;
        }

        removeNotice(root, 'orphan');
        lockForm();
        progress.hidden = true;
        error.hidden = true;
        footer.textContent = '';

        const notice = raceNotice(nextRow, actions.myResponseId?.(nextRow.messageId) ?? null);
        if (notice) {
            // The banner says what happened and that the writing survives.
            // A footer note underneath would only say it a second time — and
            // the settled note would be false, since what is on screen is this
            // device's own selection and not the answer the agent received.
            showNotice(root, notice);
        } else {
            footer.appendChild(el('p', 'detail-retained', SETTLED));
        }
    }

    function selectionFor(name) {
        return [...root.querySelectorAll(`input[name="${name}"]:checked`)].map(i => i.value);
    }

    function otherFor(name) {
        return root.querySelector(`#other-${name}`)?.value.trim() ?? '';
    }

    /**
     * Publish, and keep the form locked afterwards (spec §9.3).
     *
     * Optimistic on purpose: the controls stay disabled once the answer is on
     * the wire, because from here it is a race and offering to send a second
     * answer would only add a second loser. The next fold says whether this
     * device's answer is the one the agent received, and `applyRow` reports it.
     *
     * A *failure* is different, and unlocks: nothing left the machine, so
     * everything typed is still submittable.
     */
    async function send(publish) {
        if (settled || busy) return;
        setBusy(true);
        showProgress('Sending your answer…');
        try {
            await publish();
            showProgress('Sent. Waiting for the log to confirm it is the answer that won.');
        } catch (err) {
            setBusy(false);
            showError(`Could not send your answer — nothing left this machine. ${err?.message ?? err}`);
        }
    }

    function collectAndSubmit() {
        if (settled || !actions.onSubmit) return;
        error.hidden = true;

        if (!isBatch) {
            const selectedValues = selectionFor('options');
            const otherText = request?.allowOther ? otherFor('options') : '';
            if (selectedValues.length === 0 && !otherText) {
                showError('Please select at least one option and/or provide additional context.');
                return;
            }
            return send(() => actions.onSubmit({ row, selectedValues, otherText, subAnswers: null }));
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
        return send(() => actions.onSubmit({ row, selectedValues: [], otherText: '', subAnswers }));
    }

    if (locked) {
        // Nothing to press. The header already says who closed it and when.
        footer.appendChild(el('p', 'detail-retained', SETTLED));
        return { locked: true, applyRow };
    }

    footer.appendChild(actionButton('Skip', 'button-secondary',
        actions.onSkip ? () => send(() => actions.onSkip(row)) : null));

    if (!isBatch) {
        footer.appendChild(actionButton('Submit Response', 'button-primary',
            actions.onSubmit ? collectAndSubmit : null));
        return { locked: false, applyRow };
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

    return { locked: false, steps, applyRow };
}
