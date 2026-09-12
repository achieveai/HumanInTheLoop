import { renderWorkDocument, workExpansion } from './work-document.js';
import './diagrams.js';

const { getCurrentWindow } = window.__TAURI__.window;
const { listen } = window.__TAURI__.event;
const { invoke } = window.__TAURI__.core;

const workRevisions = new Map();
const pendingWorkDismissals = new Set();
const notificationKey = item => item.type === 'work_update' ? item.workId : item.messageId;
const findCard = id => [...listEl.querySelectorAll('.notification-card')].find(card => card.dataset.id === id);
const notifications = []; // Array of notification objects
const listEl = document.getElementById('notifications-list');
const emptyEl = document.getElementById('empty-state');
const countBadge = document.getElementById('count-badge');

function formatTime(timestamp) {
    const d = new Date(timestamp);
    const now = new Date();
    const diff = now - d;
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function normalizeNewlines(text) {
    return text ? text.replace(/\\n/g, '\n') : '';
}

function renderMarkdown(text) {
    if (!text) return '';
    text = normalizeNewlines(text);
    if (typeof marked === 'undefined') {
        return escapeHtml(text).replace(/\n/g, '<br>');
    }
    try {
        marked.setOptions({ breaks: true, gfm: true });
        return marked.parse(text);
    } catch {
        return escapeHtml(text).replace(/\n/g, '<br>');
    }
}

function renderNotifications() {
    // Update count badge
    countBadge.textContent = notifications.length;

    if (notifications.length === 0) {
        emptyEl.style.display = 'block';
        // Auto-close window after brief delay when empty
        setTimeout(async () => {
            if (notifications.length === 0) {
                const win = getCurrentWindow();
                await win.close();
            }
        }, 1500);
        return;
    }

    emptyEl.style.display = 'none';
}

/**
 * Build the sender-identity badge markup, or '' when there is no sender.
 * Shared by the initial card render and the live-patch `applySenderIdentity`
 * path below, so there is exactly one place that builds this badge.
 */
function renderSenderBadgeHtml(sender) {
    if (!sender?.label) return '';
    const label = escapeHtml(sender.label);
    return `<span class="badge badge-sender" title="${label}">${label}</span>`;
}

function addNotificationCard(notification, previousCard = null) {
    const expanded = previousCard ? workExpansion(previousCard) : new Set();
    const id = notificationKey(notification);
    emptyEl.style.display = 'none';

    const card = document.createElement('div');
    card.className = 'notification-card';
    card.dataset.id = id;

    let contextHtml = '';
    if (notification.type !== 'work_update' && notification.context) {
        contextHtml = `<div class="notification-context md-content">${renderMarkdown(notification.context)}</div>`;
    }

    const bodyHtml = notification.type === 'work_update' ? '' : renderMarkdown(notification.body);
    const senderBadgeHtml = renderSenderBadgeHtml(notification.sender);

    card.innerHTML = `
        <div class="notification-header">
            <div class="notification-title">${escapeHtml(notification.title)}</div>
            <div class="notification-time">${formatTime(notification.timestamp)}</div>
        </div>
        ${senderBadgeHtml ? `<div class="notification-badges">${senderBadgeHtml}</div>` : ''}
        <div class="notification-body md-content">${bodyHtml}</div>
        ${contextHtml}
        <div class="notification-dismiss">
            <button class="dismiss-btn" data-id="${escapeHtml(id)}">Dismiss</button>
        </div>
    `;

    if (notification.type === 'work_update') renderWorkDocument(card.querySelector('.notification-body'), notification.document, expanded, notification.body);
    // Revisions stay in place; new notifications appear first.
    if (previousCard) previousCard.replaceWith(card);
    else listEl.insertBefore(card, listEl.firstChild);

    // Wire up dismiss button
    card.querySelector('.dismiss-btn').addEventListener('click', () => {
        dismissNotification(id, card);
    });

    renderNotifications();
}

async function dismissNotification(messageId, cardEl) {
    // Animate out
    cardEl.classList.add('dismissing');

    // Check if this notification was received encrypted
    const notification = notifications.find(n => notificationKey(n) === messageId);
    const encrypted = notification?._wasEncrypted || false;
    const isWork = notification?.type === 'work_update';
    if (isWork) {
        if (pendingWorkDismissals.has(messageId)) return;
        pendingWorkDismissals.add(messageId);
        cardEl.querySelector('.dismiss-btn').disabled = true;
    }

    try {
        await invoke('dismiss_notification', { notificationId: messageId, encrypted });
    } catch (err) {
        console.error('Failed to dismiss notification:', err);
        if (isWork) {
            pendingWorkDismissals.delete(messageId);
            const latest = notifications.find(item => notificationKey(item) === messageId);
            const currentCard = findCard(messageId);
            if (latest && currentCard) addNotificationCard(latest, currentCard);
            return;
        }
    }
    pendingWorkDismissals.delete(messageId);

    // Remove from array
    const idx = notifications.findIndex(n => notificationKey(n) === messageId);
    if (idx !== -1) notifications.splice(idx, 1);

    // Remove card after animation
    setTimeout(() => {
        cardEl.remove();
        renderNotifications();
    }, 300);
}

/**
 * Patch a sender-identity badge into an already-rendered card. Decoration
 * only: a `forMessageId` that matches no rendered card is a silent no-op —
 * the companion message may have arrived for a card that was never opened
 * here, or after it was dismissed.
 */
export function applySenderIdentity(forMessageId, sender) {
    const card = findCard(forMessageId);
    if (!card) return;
    const badgeHtml = renderSenderBadgeHtml(sender);
    if (!badgeHtml) return;

    let row = card.querySelector('.notification-badges');
    if (!row) {
        row = document.createElement('div');
        row.className = 'notification-badges';
        card.querySelector('.notification-header')?.after(row);
    }
    row.innerHTML = badgeHtml;
}

function removeNotificationById(messageId) {
    const idx = notifications.findIndex(n => notificationKey(n) === messageId);
    if (idx === -1) return;

    notifications.splice(idx, 1);

    const card = findCard(messageId);
    if (card) {
        card.classList.add('dismissing');
        setTimeout(() => {
            card.remove();
            renderNotifications();
        }, 300);
    } else {
        renderNotifications();
    }
}

/** Remember quiet revisions too, so delayed alerts cannot reopen older work. */
function receiveNotification(notification) {
    const id = notificationKey(notification);
    const index = notifications.findIndex(item => notificationKey(item) === id);
    if (notification.type === 'work_update') {
        const doc = notification.document;
        if (!id || !Number.isSafeInteger(notification.revision) || notification.revision < 1
            || doc?.workId !== id || doc?.revision !== notification.revision || !Array.isArray(doc?.tasks)) return;
        if (notification.revision <= (workRevisions.get(id) || 0)) return;
        workRevisions.set(id, notification.revision);
        if (index < 0 && notification.alert !== true) return;
        const card = findCard(id);
        if (index >= 0) notifications[index] = notification;
        else notifications.push(notification);
        // Keep the dismissing DOM stable; retain the newest data for rollback.
        if (pendingWorkDismissals.has(id)) return;
        addNotificationCard(notification, card);
        return;
    }
    if (index >= 0) return;
    notifications.push(notification);
    addNotificationCard(notification);
}

// Parse initial notification from URL params
function loadInitialNotification() {
    const params = new URLSearchParams(window.location.search);
    const notificationParam = params.get('notification');
    if (notificationParam) {
        try {
            const notification = JSON.parse(notificationParam);
            receiveNotification(notification);
        } catch (err) {
            console.error('Failed to parse initial notification:', err);
        }
    }
    renderNotifications();
}

// Listen for new notifications from Rust backend
async function setupListeners() {
    // Buffer live events while IPC drains earlier events so a quiet update
    // cannot overtake the alert that first creates its card.
    let startupComplete = false;
    const arriving = [];
    // One bad payload must not abort the drain or strand subsequent live events.
    const dispatch = entry => {
        try {
            if (entry.event === 'remove-notification') removeNotificationById(entry.payload);
            else if (entry.event === 'add-notification') {
                receiveNotification(typeof entry.payload === 'string' ? JSON.parse(entry.payload) : entry.payload);
            }
        } catch (err) { console.error('Failed to handle notification event:', err); }
    };
    const receive = (event, payload) => {
        const entry = { event, payload };
        if (startupComplete) dispatch(entry);
        else arriving.push(entry);
    };
    await listen('add-notification', (event) => {
        receive('add-notification', event.payload);
    });

    await listen('remove-notification', (event) => {
        receive('remove-notification', event.payload);
    });

    // Sender identity is decoration published as a separate companion message
    // (see docs/superpowers/specs/2026-08-15-sender-identity-metadata-design.md)
    // and can arrive after its card has already rendered.
    await listen('sender-identity', (event) => {
        const payload = typeof event.payload === 'string' ? JSON.parse(event.payload) : event.payload;
        applySenderIdentity(payload?.forMessageId, payload?.sender);
    });
    try {
        const pending = await invoke('notifications_ready');
        for (const entry of pending || []) dispatch(entry);
    } catch (err) {
        console.error('Failed to read startup notifications:', err);
    }
    for (const entry of arriving) dispatch(entry);
    startupComplete = true;
}

// Initialize
loadInitialNotification();
setupListeners();

// Show window after content is fully painted (prevents flash)
requestAnimationFrame(() => {
    requestAnimationFrame(() => {
        if (notifications.length) invoke('show_no_activate');
    });
});
