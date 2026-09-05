// The Inbox shell: fetch both panes, draw them, and redraw when the log moves.
//
// The latest server projection remains authoritative. The only local view
// state is selection plus the enabled message types, which project that list
// without asking the native side to recompute it.

import { createLayoutObserver, createPaneState } from './layout.js';
import { createPaneSizing, bindPaneControls } from './panes.js';
import { renderAgentTree } from './pane-agents.js';
import { createDetailPane } from './pane-detail.js';
import {
    filterMessagesByType,
    renderFilterBar,
    renderMessageList,
    renderTypeFilterBar,
    TYPES,
} from './pane-list.js';
import { createReplyActions } from './reply.js';

/** Emitted by the Rust side when a genuinely new event lands. */
const CHANGED_EVENT = 'inbox-changed';
const CHANGE_QUIET_MS = 100;
const CHANGE_MAXIMUM_MS = 500;

/**
 * `panes` is the pane-visibility state from layout.js. It is optional because
 * the renderer tests build an Inbox without any shell around it; when it is
 * absent every navigation call is a no-op and the three panes simply coexist,
 * which is exactly the wide layout.
 */
export function createInbox({ invoke, elements, onError = console.error, actions = {}, panes = null }) {
    const {
        agents,
        filterBar,
        typeFilterSet,
        messageList,
        detail,
        actionErrorDialog,
        listActions,
        bulkStatus,
    } = elements;

    /** Pending local settlements layered over the latest authoritative rows. */
    const optimistic = new Map();
    const markAllButton = listActions?.querySelector('.mark-all-read');
    const markAllDescription = listActions?.querySelector('#mark-all-read-description');
    const undoButton = bulkStatus?.querySelector('.undo-mark-all-read');
    const dismissBulkStatusButton = bulkStatus?.querySelector('.dismiss-bulk-status');
    const bulkStatusMessage = bulkStatus?.querySelector('.bulk-status-message');
    let rollbackFocus = null;
    let bulkSequence = 0;
    let bulkOperation = null;
    const detailPane = createDetailPane({
        container: detail,
        invoke,
        onError,
        actions: optimisticActions(actions),
    });
    actionErrorDialog?.addEventListener('close', () => {
        const target = rollbackFocus;
        rollbackFocus = null;
        if (!target || target.scopeKey !== state.scopeKey) return;
        if (target.kind === 'mark-all') {
            if (!markAllButton?.hidden) markAllButton.focus();
            return;
        }
        const row = [...messageList.querySelectorAll('.message-row')]
            .find(candidate => candidate.dataset.messageId === target.messageId);
        row?.focus();
    });
    markAllButton?.addEventListener('click', () => {
        if (markAllButton.getAttribute('aria-disabled') === 'true') return;
        run(markAllRead());
    });
    undoButton?.addEventListener('click', () => {
        if (undoButton.getAttribute('aria-disabled') === 'true') return;
        run(undoMarkAllRead());
    });
    dismissBulkStatusButton?.addEventListener('click', () => {
        if (!bulkOperation || bulkOperation.phase === 'marking' || bulkOperation.phase === 'undoing') return;
        bulkOperation = null;
        renderBulkControls();
    });
    let refreshGeneration = 0;
    let pendingChangeGeneration = null;
    let changeRefresh = null;
    let scheduledChangeGeneration = null;
    let changeQuietTimer = null;
    let changeMaximumTimer = null;
    let scheduledChangeRefresh = null;

    const state = {
        /** A `scopeKey` handed out by `list_sessions()`. Never composed here. */
        scopeKey: 'all',
        /**
         * `null` means "let the server pick" — which resolves to `Needs you`
         * when anything in scope is pending (spec §7.3). Adopted once the first
         * list comes back, so a later answer cannot move the highlighted tab
         * out from under the user, and reset to `null` whenever the scope
         * changes so each agent gets its own default.
        */
        filter: null,
        /** Local multi-select projection over the latest server-backed list. */
        types: new Set(TYPES.map(type => type.key)),
        selectedId: null,
        /** The folded status pane 3 was last drawn with. See `refresh()`. */
        selectedStatus: null,
    };
    let latestList = null;
    let visibleMessages = [];

    function statusAdmits(message, filter) {
        const open = message.status === 'pending' || message.status === 'stale';
        if (filter === 'needs_you') return open;
        if (filter === 'answered') return !open;
        if (filter === 'notifications') return message.msgType === 'notification';
        return true;
    }

    function predictedRow(message, transaction) {
        if (!transaction) return message;
        const { _eventObservedOpen, ...prediction } = transaction.prediction;
        return { ...message, ...prediction };
    }

    function renderProjection(list) {
        const statusMessages = list.messages
            .map(message => {
                const transaction = optimistic.get(message.messageId);
                return { message: predictedRow(message, transaction), predicted: Boolean(transaction) };
            })
            // The server already filtered authoritative rows. Only a local
            // prediction needs the active status rule applied in the browser.
            .filter(({ message, predicted }) => !predicted
                || statusAdmits(message, state.filter ?? list.filter))
            .map(({ message }) => message);
        const messages = filterMessagesByType(statusMessages, state.types);
        renderTypeFilterBar(typeFilterSet, statusMessages, state.types, { onToggle: selectType });
        renderMessageList(messageList, { ...list, messages }, {
            selectedId: state.selectedId,
            onSelect: selectMessage,
            emptyText: statusMessages.length > 0 && messages.length === 0
                ? 'Nothing matches these filters.'
                : undefined,
        });
        visibleMessages = messages;
        renderBulkControls();
        return messages;
    }

    function selectAdjacent(messages, previousVisible) {
        if (!state.selectedId || messages.some(message => message.messageId === state.selectedId)) return false;

        if (!messages.length) {
            state.selectedId = null;
            state.selectedStatus = null;
            detailPane.clear();
            return true;
        }

        const oldVisibleIndex = previousVisible.findIndex(message => message.messageId === state.selectedId);
        const replacement = messages[Math.min(Math.max(oldVisibleIndex, 0), messages.length - 1)];
        // A projection update must not bring pane 3 in front on a phone.
        selectMessage(replacement, { navigate: false });
        return true;
    }

    function selectAfterTargets(targetIds, previousVisible) {
        if (!state.selectedId || !targetIds.has(state.selectedId)) return;
        const visibleIndex = previousVisible.findIndex(message => message.messageId === state.selectedId);
        const survivors = visibleMessages.filter(message => !targetIds.has(message.messageId));
        if (survivors.length) {
            const nextIndex = Math.min(Math.max(visibleIndex, 0), survivors.length - 1);
            selectMessage(survivors[nextIndex], { navigate: false });
            return;
        }
        state.selectedId = null;
        state.selectedStatus = null;
        for (const messageRow of messageList.querySelectorAll('.message-row')) {
            messageRow.classList.remove('is-selected');
        }
        detailPane.clear();
    }

    function beginOptimistic(row, prediction, actionLabel) {
        if (!latestList || optimistic.has(row.messageId)) return null;

        const transaction = {
            row,
            prediction,
            actionLabel,
            scopeKey: latestList.scopeKey ?? state.scopeKey,
        };

        const previousVisible = visibleMessages;
        detailPane.park(row.messageId);
        optimistic.set(row.messageId, transaction);
        renderProjection(latestList);
        selectAfterTargets(new Set([row.messageId]), previousVisible);
        return transaction;
    }

    function confirmOptimistic(messageId) {
        if (!optimistic.delete(messageId)) return false;
        if (state.selectedId === messageId) state.selectedStatus = null;
        detailPane.discard(messageId);
        return true;
    }

    function rollbackOptimistic(messageId, expectedTransaction, error = null) {
        const transaction = optimistic.get(messageId);
        if (!transaction || transaction !== expectedTransaction) return false;

        optimistic.delete(messageId);
        if (latestList
            && statusAdmits(transaction.row, state.filter ?? latestList.filter)
            && !latestList.messages.some(message => message.messageId === messageId)) {
            latestList = { ...latestList, messages: [transaction.row, ...latestList.messages] };
        }
        if (latestList) renderProjection(latestList);
        const restoredRow = visibleMessages.find(message => message.messageId === messageId);
        if (restoredRow && transaction.scopeKey === state.scopeKey) {
            selectMessage(restoredRow, { navigate: false });
        } else {
            // The failed editor belongs to another scope/filter. Retain only
            // renderer-owned form data; the full detached DOM and its global
            // listeners must not live indefinitely.
            detailPane.discard(messageId, { recover: true });
        }

        if (error && actionErrorDialog) {
            showActionError(
                'Could not send',
                `${transaction.actionLabel} delivery could not be confirmed; the local view was restored. `
                    + String(error?.message ?? error),
                { kind: 'row', messageId, scopeKey: transaction.scopeKey },
            );
        }
        return true;
    }

    function showActionError(title, message, focusTarget = null) {
        if (!actionErrorDialog) return;
        rollbackFocus = focusTarget;
        const heading = actionErrorDialog.querySelector('#action-error-title');
        const body = actionErrorDialog.querySelector('.action-error-message');
        if (heading) heading.textContent = title;
        if (body) body.textContent = message;
        if (!actionErrorDialog.open) actionErrorDialog.showModal();
    }

    function reconcileOptimistic(list, eventDriven) {
        const authoritativeById = new Map(list.messages.map(message => [message.messageId, message]));
        for (const [messageId, transaction] of optimistic) {
            const authoritative = authoritativeById.get(messageId);
            const predictsOpen = statusAdmits(transaction.prediction, 'needs_you');
            if (predictsOpen) {
                if (eventDriven && authoritative && statusAdmits(authoritative, 'needs_you')) {
                    transaction.prediction._eventObservedOpen = true;
                    if (transaction.actionLabel.endsWith(':sent')) confirmOptimistic(messageId);
                }
                continue;
            }
            const terminal = authoritative && !statusAdmits(authoritative, 'needs_you');
            const absentFromOriginNeedsYou = eventDriven
                && list.filter === 'needs_you'
                && list.scopeKey === transaction.scopeKey
                && !authoritative;
            if ((terminal || absentFromOriginNeedsYou) && !transaction.retainUntilReceived) {
                confirmOptimistic(messageId);
            }
        }
    }

    async function sendOptimistically(row, predictedRow, actionLabel, publish, requiresReceived = false) {
        const transaction = beginOptimistic(row, predictedRow, actionLabel);
        if (transaction) transaction.retainUntilReceived = requiresReceived;
        try {
            const result = await publish();
            if (optimistic.get(row.messageId) !== transaction) return result;

            if (requiresReceived && result?.status !== 'received') {
                rollbackOptimistic(row.messageId, transaction);
                return result;
            }

            if (requiresReceived) {
                transaction.retainUntilReceived = false;
                if (latestList) reconcileOptimistic(latestList, false);
                if (optimistic.get(row.messageId) !== transaction) return result;
            }

            if (statusAdmits(transaction.prediction, 'needs_you')) {
                transaction.actionLabel = `${transaction.actionLabel}:sent`;
                if (transaction.prediction._eventObservedOpen) confirmOptimistic(row.messageId);
            }
            return result;
        } catch (error) {
            rollbackOptimistic(row.messageId, transaction, error);
            throw error;
        }
    }

    function optimisticActions(base) {
        return {
            ...base,
            onDismiss: base.onDismiss
                ? row => sendOptimistically(
                    row,
                    { status: 'dismissed' },
                    'Dismiss',
                    () => base.onDismiss(row),
                )
                : undefined,
            onSubmit: base.onSubmit
                ? payload => sendOptimistically(
                    payload.row,
                    { status: 'answered' },
                    'Submit response',
                    () => base.onSubmit(payload),
                )
                : undefined,
            onSkip: base.onSkip
                ? row => sendOptimistically(
                    row,
                    { status: 'skipped' },
                    'Skip question',
                    () => base.onSkip(row),
                )
                : undefined,
            onSubmitReview: base.onSubmitReview
                ? (row, payload) => sendOptimistically(
                    row,
                    {
                        status: payload.verdict === 'skipped' ? 'skipped' : 'answered',
                        verdict: payload.verdict === 'skipped' ? row.verdict : payload.verdict,
                    },
                    payload.verdict === 'skipped' ? 'Skip review' : 'Submit review',
                    () => base.onSubmitReview(row, payload),
                    true,
                )
                : undefined,
            onRestore: base.onRestore
                ? row => sendOptimistically(
                    row,
                    {
                        status: 'pending',
                        responder: null,
                        respondedAt: null,
                        responseId: null,
                        _eventObservedOpen: false,
                    },
                    'Mark unread',
                    () => base.onRestore(row),
                )
                : undefined,
        };
    }

    function scopeName(scopeKey) {
        if (scopeKey === 'all') return 'All messages';
        if (scopeKey === 'unattributed') return 'Unattributed';
        if (scopeKey?.startsWith('project:')) return `project ${scopeKey.slice('project:'.length)}`;
        if (scopeKey?.startsWith('session:')) return `session ${scopeKey.slice('session:'.length)}`;
        return scopeKey || 'this scope';
    }

    function actionableIds() {
        if (!latestList || latestList.scopeKey !== state.scopeKey) return [];
        const seen = new Set();
        const ids = [];
        for (const id of latestList.actionableNotificationIds ?? []) {
            if (!id || seen.has(id) || optimistic.has(id)) continue;
            seen.add(id);
            ids.push(id);
        }
        return ids;
    }

    function bulkInFlight() {
        return bulkOperation?.phase === 'marking' || bulkOperation?.phase === 'undoing';
    }

    function renderBulkControls() {
        if (!markAllButton) return;
        const ids = actionableIds();
        const inFlight = bulkInFlight();
        const sameOrigin = bulkOperation?.scopeKey === state.scopeKey;
        const showMark = ids.length > 0 || (inFlight && sameOrigin);
        markAllButton.hidden = !showMark || !actions.onDismissMany;
        markAllButton.setAttribute('aria-disabled', String(inFlight));

        if (showMark) {
            if (bulkOperation?.phase === 'marking' && sameOrigin) {
                markAllButton.textContent = `Marking ${bulkOperation.targetCount}…`;
            } else if (inFlight) {
                markAllButton.textContent = `Bulk action in ${bulkOperation.scopeName}…`;
            } else {
                markAllButton.textContent = `Mark all read (${ids.length})`;
            }
        }
        if (markAllDescription) {
            const describedScope = inFlight ? bulkOperation.scopeName : scopeName(state.scopeKey);
            markAllDescription.textContent = `Marks all unread notifications in ${describedScope}. `
                + 'Status and message type filters do not limit this action.';
        }

        const showStatus = Boolean(bulkOperation)
            && sameOrigin
            && ['undo-available', 'undoing', 'complete'].includes(bulkOperation.phase);
        if (bulkStatus) bulkStatus.hidden = !showStatus;
        if (!showStatus) return;

        if (bulkStatusMessage) bulkStatusMessage.textContent = bulkOperation.statusMessage;
        const canUndo = bulkOperation.phase === 'undo-available' || bulkOperation.phase === 'undoing';
        if (undoButton) {
            undoButton.hidden = !canUndo;
            undoButton.textContent = bulkOperation.phase === 'undoing'
                ? `Marking ${bulkOperation.targetCount} unread…`
                : 'Undo mark all read';
            undoButton.setAttribute('aria-disabled', String(bulkOperation.phase === 'undoing'));
        }
        if (dismissBulkStatusButton) {
            dismissBulkStatusButton.hidden = bulkOperation.phase === 'undoing';
            dismissBulkStatusButton.setAttribute(
                'aria-label',
                bulkOperation.phase === 'complete' ? 'Dismiss status' : 'Dismiss Undo',
            );
        }
    }

    function installBulkPredictions(ids, predictionFor, actionLabel, scopeKey) {
        const targetIds = new Set(ids);
        const previousVisible = visibleMessages;
        if (state.selectedId && targetIds.has(state.selectedId)) detailPane.park(state.selectedId);
        for (const messageId of ids) {
            optimistic.set(messageId, {
                prediction: predictionFor(messageId),
                actionLabel,
                scopeKey,
            });
        }
        if (latestList) renderProjection(latestList);
        selectAfterTargets(targetIds, previousVisible);
    }

    function removeBulkPredictions(ids, actionLabel) {
        let changed = false;
        for (const messageId of ids) {
            const transaction = optimistic.get(messageId);
            if (!transaction || !transaction.actionLabel.startsWith(actionLabel)) continue;
            optimistic.delete(messageId);
            // Bulk actions target notifications only, so a failed prediction
            // has no editor draft to preserve. Release a pane parked when the
            // batch advanced selection even if the user stays on its neighbor.
            detailPane.discard(messageId);
            changed = true;
        }
        if (changed && latestList) renderProjection(latestList);
    }

    function firstReason(failures) {
        const reason = String(failures[0]?.error ?? '').replace(/\s+/g, ' ').trim();
        return reason ? ` ${reason}` : '';
    }

    function refreshSelectedAttribution(successes) {
        if (!latestList || !successes.some(success => success.notificationId === state.selectedId)) return;
        const row = latestList.messages.find(message => message.messageId === state.selectedId);
        if (!row || statusAdmits(row, 'needs_you')) return;
        state.selectedStatus = row.status;
        run(detailPane.show(row));
    }

    function prepareUndoFocus() {
        if (!undoButton || bulkOperation?.scopeKey !== state.scopeKey) return false;
        if (bulkStatus) bulkStatus.hidden = false;
        undoButton.hidden = false;
        undoButton.focus();
        return true;
    }

    async function markAllRead() {
        if (bulkInFlight() || !actions.onDismissMany) return;
        const notificationIds = actionableIds();
        if (!notificationIds.length) return;

        const operation = {
            batchId: ++bulkSequence,
            phase: 'marking',
            scopeKey: state.scopeKey,
            scopeName: scopeName(state.scopeKey),
            targetCount: notificationIds.length,
            pairs: [],
            statusMessage: '',
        };
        bulkOperation = operation;
        installBulkPredictions(notificationIds, () => ({ status: 'dismissed' }), 'Mark all read', operation.scopeKey);

        let result;
        try {
            result = await actions.onDismissMany(notificationIds);
        } catch (error) {
            if (bulkOperation !== operation) return;
            removeBulkPredictions(notificationIds, 'Mark all read');
            bulkOperation = null;
            renderBulkControls();
            if (state.scopeKey === operation.scopeKey) {
                showActionError(
                    'Could not send',
                    `Mark all read delivery could not be confirmed; the local view was restored. ${String(error?.message ?? error)}`,
                    { kind: 'mark-all', scopeKey: operation.scopeKey },
                );
            }
            return;
        }
        if (bulkOperation !== operation) return;

        const successes = result?.successes ?? [];
        const failures = result?.failures ?? [];
        removeBulkPredictions(failures.map(failure => failure.notificationId), 'Mark all read');
        refreshSelectedAttribution(successes);

        operation.phase = successes.length ? 'undo-available' : 'complete';
        operation.pairs = successes.map(success => ({
            notificationId: success.notificationId,
            dismissalId: success.dismissalId,
        }));
        operation.statusMessage = successes.length
            ? `Marked ${successes.length} notifications read. `
                + 'Marked items remain available under All and Answered.'
            : 'No notifications were marked read.';

        if (!failures.length && successes.length) prepareUndoFocus();
        renderBulkControls();
        if (failures.length && state.scopeKey === operation.scopeKey) {
            showActionError(
                'Some notifications weren’t marked read',
                `Marked ${successes.length} of ${operation.targetCount} notifications read. `
                    + `${failures.length} remain unread.${firstReason(failures)}`,
                { kind: 'mark-all', scopeKey: operation.scopeKey },
            );
        }
    }

    async function undoMarkAllRead() {
        const operation = bulkOperation;
        if (!operation || operation.phase !== 'undo-available' || state.scopeKey !== operation.scopeKey
            || !actions.onRestoreMany) return;
        const restorations = operation.pairs.map(pair => ({ ...pair }));
        if (!restorations.length) return;

        operation.phase = 'undoing';
        operation.targetCount = restorations.length;
        operation.statusMessage = `Marking ${restorations.length} notifications unread…`;
        installBulkPredictions(
            restorations.map(restoration => restoration.notificationId),
            () => ({
                status: 'pending',
                responder: null,
                respondedAt: null,
                responseId: null,
                _eventObservedOpen: false,
            }),
            'Undo mark all read',
            operation.scopeKey,
        );

        let result;
        try {
            result = await actions.onRestoreMany(restorations);
        } catch (error) {
            if (bulkOperation !== operation) return;
            removeBulkPredictions(
                restorations.map(restoration => restoration.notificationId),
                'Undo mark all read',
            );
            operation.phase = 'undo-available';
            operation.targetCount = restorations.length;
            operation.statusMessage = 'Undo is still available.';
            renderBulkControls();
            if (state.scopeKey === operation.scopeKey) {
                showActionError(
                    'Could not send',
                    `Mark unread delivery could not be confirmed; the local view was restored. ${String(error?.message ?? error)}`,
                    { kind: 'mark-all', scopeKey: operation.scopeKey },
                );
            }
            return;
        }
        if (bulkOperation !== operation) return;

        const successes = result?.successes ?? [];
        const failures = result?.failures ?? [];
        for (const success of successes) {
            const transaction = optimistic.get(success.notificationId);
            if (!transaction || !transaction.actionLabel.startsWith('Undo mark all read')) continue;
            transaction.actionLabel = 'Undo mark all read:sent';
            if (transaction.prediction._eventObservedOpen) confirmOptimistic(success.notificationId);
        }
        removeBulkPredictions(failures.map(failure => failure.notificationId), 'Undo mark all read');

        operation.pairs = failures.map(failure => ({
            notificationId: failure.notificationId,
            dismissalId: failure.dismissalId,
        }));
        operation.phase = failures.length ? 'undo-available' : 'complete';
        operation.statusMessage = failures.length
            ? 'Undo remains available for notifications that are still read.'
            : `Marked ${successes.length} notifications unread.`;
        renderBulkControls();

        if (failures.length && state.scopeKey === operation.scopeKey) {
            showActionError(
                'Some notifications weren’t marked unread',
                `Marked ${successes.length} of ${restorations.length} notifications unread. `
                    + `${failures.length} remain read.${firstReason(failures)}`,
                { kind: 'mark-all', scopeKey: operation.scopeKey },
            );
        }
    }

    async function refreshGenerationOnce(generation, eventDriven = false) {
        const tree = await invoke('list_sessions');
        if (generation !== refreshGeneration) return;
        renderAgentTree(agents, tree, {
            selectedScope: state.scopeKey,
            onSelect: selectScope,
        });

        const list = await invoke('list_messages', {
            sessionKey: state.scopeKey,
            filter: state.filter,
        });
        if (generation !== refreshGeneration) return;
        if (state.filter === null) state.filter = list.filter;

        const previousVisible = visibleMessages;
        reconcileOptimistic(list, eventDriven);
        latestList = list;
        renderFilterBar(filterBar, list, { onFilter: selectFilter });
        const messages = renderProjection(list);

        // Pane 3 is told only when the *selected* message's folded status
        // actually moved — someone answered it on another device, the agent
        // exited. Reacting to every event instead would throw away scroll
        // position and half-typed review comments each time an unrelated
        // message arrived, which is a worse failure than a stale pane.
        //
        // `update` rather than `show`: the pane locks itself in place and keeps
        // everything the reader has typed (spec §9.3).
        const selected = messages.find(m => m.messageId === state.selectedId);
        if (selectAdjacent(messages, previousVisible)) return;
        if (selected && selected.status !== state.selectedStatus) {
            state.selectedStatus = selected.status;
            run(detailPane.update(selected));
        }
    }

    function refresh() {
        return refreshGenerationOnce(++refreshGeneration);
    }

    function startChangeRefresh() {
        if (changeRefresh) return changeRefresh;

        changeRefresh = (async () => {
            while (pendingChangeGeneration !== null) {
                const generation = pendingChangeGeneration;
                pendingChangeGeneration = null;
                if (generation === refreshGeneration) {
                    await refreshGenerationOnce(generation, true);
                }
            }
        })().finally(() => {
            changeRefresh = null;
        });
        return changeRefresh;
    }

    function flushScheduledChange() {
        clearTimeout(changeQuietTimer);
        clearTimeout(changeMaximumTimer);
        changeQuietTimer = null;
        changeMaximumTimer = null;

        const generation = scheduledChangeGeneration;
        const scheduled = scheduledChangeRefresh;
        scheduledChangeGeneration = null;
        scheduledChangeRefresh = null;
        if (generation === null || !scheduled) return;

        pendingChangeGeneration = generation;
        startChangeRefresh().then(scheduled.resolve, scheduled.reject);
    }

    function refreshAfterChange() {
        scheduledChangeGeneration = ++refreshGeneration;
        if (!scheduledChangeRefresh) {
            let resolve;
            let reject;
            const promise = new Promise((onResolve, onReject) => {
                resolve = onResolve;
                reject = onReject;
            });
            scheduledChangeRefresh = { promise, resolve, reject };
        }

        clearTimeout(changeQuietTimer);
        changeQuietTimer = setTimeout(flushScheduledChange, CHANGE_QUIET_MS);
        changeMaximumTimer ??= setTimeout(flushScheduledChange, CHANGE_MAXIMUM_MS);
        return scheduledChangeRefresh.promise;
    }

    function run(promise) {
        return promise.catch(onError);
    }

    function selectScope(scopeKey) {
        state.scopeKey = scopeKey;
        // A different agent is a different question about what needs you, so
        // its filter is re-defaulted rather than inherited.
        state.filter = null;
        renderBulkControls();
        // Picking an agent is picking a list to read (spec §4.2). This also
        // dismisses the overlay the pick was made from.
        panes?.show('list');
        return run(refresh());
    }

    function selectFilter(filter) {
        state.filter = filter;
        return run(refresh());
    }

    function selectType(type) {
        if (!latestList) return;
        if (state.types.has(type)) {
            if (state.types.size === 1) return;
            state.types.delete(type);
        } else {
            state.types.add(type);
        }

        const previousVisible = visibleMessages;
        const messages = renderProjection(latestList);
        selectAdjacent(messages, previousVisible);
    }

    function selectMessage(message, { navigate = true } = {}) {
        state.selectedId = message.messageId;
        state.selectedStatus = message.status;
        // Selection and layout are independent (spec §4.2): this records which
        // pane is frontmost, and never touches which message is selected. That
        // is why widening the window restores the pair intact.
        if (navigate) panes?.show('detail');
        for (const row of messageList.querySelectorAll('.message-row')) {
            row.classList.toggle('is-selected', row.dataset.messageId === message.messageId);
        }
        return run(detailPane.show(message));
    }

    return { refresh, refreshAfterChange, selectScope, selectFilter, selectType, selectMessage, detailPane, state };
}

async function main() {
    const tauri = window.__TAURI__;
    if (!tauri) return;

    const invoke = tauri.core.invoke;

    // Layout first: it writes `data-layout` before the first paint, so the
    // window opens in the right shape instead of flashing three panes and
    // collapsing to one.
    createLayoutObserver();
    const panes = createPaneState();

    // Sizing is the hand-set half of the layout, and is published before the
    // first paint for the same reason the observer is: a window that opens
    // collapsed should not flash three panes on the way there.
    const sizing = createPaneSizing();
    sizing.publish();
    bindPaneControls({ sizing });

    // The back gesture has no DOM event to hang off: on Android the platform
    // delivers it to the shell, which has to reach into the page to answer it
    // (spec §4.1). A named global is that reach-in point. It returns false when
    // there was nothing to go back to, which is the shell's signal that exiting
    // is now the correct response.
    window.__PANES = panes;

    document.getElementById('agents-toggle')?.addEventListener('click', () => panes.toggleAgents());
    document.getElementById('pane-back')?.addEventListener('click', () => panes.back());
    document.getElementById('inbox-scrim')?.addEventListener('click', () => panes.toggleAgents(false));

    const inbox = createInbox({
        invoke,
        panes,
        // Replies go out through `hitl-transport` on the shared topic, exactly
        // as any other device's do (spec §9.1). Nothing here records a status:
        // the reply is an event, and the next fold decides what it meant.
        actions: createReplyActions({ invoke }),
        elements: {
            agents: document.getElementById('pane-agents'),
            filterBar: document.getElementById('filter-bar'),
            typeFilterSet: document.getElementById('type-filter-set'),
            listActions: document.getElementById('list-actions'),
            bulkStatus: document.getElementById('bulk-status'),
            messageList: document.getElementById('message-list'),
            detail: document.getElementById('pane-detail'),
            actionErrorDialog: document.getElementById('action-error-dialog'),
        },
    });

    await inbox.refresh();

    // The view is a function of the log, so there is nothing finer-grained to
    // listen for: one event lands, both panes are re-derived.
    await tauri.event.listen(CHANGED_EVENT, () => {
        inbox.refreshAfterChange().catch(console.error);
    });
}

main().catch(console.error);
