// Pane 3 — the HandOff renderer.
//
// An agent finished its work and is waiting for what to do next. The pane shows
// its summary, a box for the next instruction and an **End** checkbox. Typing
// an instruction unchecks End: an instruction and "no more work" contradict
// each other, and the text is the more deliberate of the two.
//
// The reply is an ordinary `answer` (the seam is `actions.onSubmit`, exactly as
// for a question): End sends `selectedValues: ['end']`, the instruction rides in
// `otherText`. Locking on settle and the lost-race banner follow the question
// renderer, for the same reason — never rebuild the body under someone typing.

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

const KICKER = 'Handoff';
const END = 'end';
const SETTLED = 'This handoff is settled. The reply above is what the agent received.';

/** What was sent, as a read-only block on a settled handoff. */
function sentReply(settlement) {
    const ended = settlement?.skipped === true || (settlement?.selectedValues ?? []).includes(END);
    const text = settlement?.otherText && settlement.otherText !== 'SKIPPED' ? settlement.otherText : '';
    const block = el('div', 'other-answered');
    if (!ended && text) {
        block.appendChild(el('div', 'other-label', 'Next instruction sent'));
        block.appendChild(el('pre', 'other-answered-text', text));
    } else {
        block.appendChild(el('div', 'other-label', 'Ended: no more work'));
        if (text) block.appendChild(el('pre', 'other-answered-text', text));
    }
    return block;
}

export function renderHandoff(container, detail, actions = {}) {
    const { row, request, settlement } = detail;
    const locked = !isOpen(row);

    container.textContent = '';
    const root = el('article', 'detail-root detail-handoff');
    root.dataset.messageId = row.messageId;
    root.dataset.status = row.status;
    root.appendChild(detailHeader(detail, KICKER));

    const scroll = el('div', 'detail-scroll');
    const context = contextBlock(request?.context);
    if (context) scroll.appendChild(context);

    const summary = el('div', 'question-text handoff-summary md-content');
    renderMarkdownInto(summary, request?.summary ?? row.title);
    scroll.appendChild(summary);

    let input = null;
    let end = null;
    if (locked) {
        scroll.appendChild(sentReply(settlement));
    } else {
        const section = el('div', 'other-section');
        const label = el('label', 'other-label', 'Next instruction');
        label.htmlFor = 'handoff-next';
        section.appendChild(label);
        input = document.createElement('textarea');
        input.className = 'other-input';
        input.id = 'handoff-next';
        input.rows = 4;
        input.placeholder = 'What should the agent do next?';
        section.appendChild(input);
        scroll.appendChild(section);

        const endRow = el('label', 'option handoff-end');
        end = document.createElement('input');
        end.type = 'checkbox';
        end.id = 'handoff-end';
        end.value = END;
        endRow.appendChild(end);
        const endText = el('div', 'option-content');
        endText.appendChild(el('div', 'option-label', 'End: no more work'));
        endRow.appendChild(endText);
        scroll.appendChild(endRow);

        const paintEnd = () => endRow.classList.toggle('selected', end.checked);
        input.addEventListener('input', () => {
            if (input.value.trim() && end.checked) {
                end.checked = false;
                paintEnd();
            }
        });
        end.addEventListener('change', paintEnd);
        // Ctrl+Enter sends, the same shortcut as a question's text box.
        input.addEventListener('keydown', event => {
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                submit();
            }
        });
    }

    const error = el('p', 'detail-error');
    error.hidden = true;
    error.setAttribute('role', 'alert');
    scroll.appendChild(error);
    const progress = el('p', 'detail-progress');
    progress.hidden = true;
    progress.setAttribute('role', 'status');
    scroll.appendChild(progress);

    root.appendChild(scroll);
    const footer = el('footer', 'detail-actions');
    root.appendChild(footer);
    container.appendChild(root);
    showNotice(root, orphanNotice(row));

    let settled = locked;
    let busy = false;

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

    function setBusy(value) {
        busy = value;
        for (const button of footer.querySelectorAll('.button')) button.disabled = value || settled;
    }

    async function send(publish) {
        if (settled || busy) return;
        setBusy(true);
        showProgress('Sending your reply…');
        try {
            await publish();
            showProgress('Sent. Waiting for the log to confirm it is the reply that won.');
        } catch (err) {
            setBusy(false);
            showError(`Could not send your reply — nothing left this machine. ${err?.message ?? err}`);
        }
    }

    function submit() {
        if (settled || !actions.onSubmit || !input) return;
        const otherText = input.value.trim();
        const selectedValues = end.checked ? [END] : [];
        if (!otherText && !end.checked) {
            showError('Type your next instruction, or check End.');
            return;
        }
        return send(() => actions.onSubmit({ row, selectedValues, otherText, subAnswers: null }));
    }

    /** Status moved while open: lock in place, never rebuild (see render-question.js). */
    function applyRow(nextRow) {
        root.dataset.status = nextRow.status;
        replaceHeader(root, { ...detail, row: nextRow }, KICKER);
        if (isOpen(nextRow)) {
            showNotice(root, orphanNotice(nextRow));
            return;
        }
        removeNotice(root, 'orphan');
        settled = true;
        for (const control of scroll.querySelectorAll('input, textarea')) control.disabled = true;
        setBusy(false);
        progress.hidden = true;
        error.hidden = true;
        footer.textContent = '';
        const notice = raceNotice(nextRow, actions.myResponseId?.(nextRow.messageId) ?? null);
        if (notice) showNotice(root, notice);
        else footer.appendChild(el('p', 'detail-retained', SETTLED));
    }

    if (locked) {
        footer.appendChild(el('p', 'detail-retained', SETTLED));
        return { locked: true, applyRow };
    }

    footer.appendChild(actionButton('Send', 'button-primary', actions.onSubmit ? submit : null));

    return {
        locked: false,
        applyRow,
        captureRecovery: () => ({ text: input.value, end: end.checked }),
        restoreRecovery: recovery => {
            input.value = recovery?.text ?? '';
            end.checked = recovery?.end === true;
            end.dispatchEvent(new Event('change'));
        },
    };
}
