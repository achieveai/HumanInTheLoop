const { getCurrentWindow } = window.__TAURI__.window;
const { listen } = window.__TAURI__.event;
const { invoke } = window.__TAURI__.core;

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

function addNotificationCard(notification) {
    emptyEl.style.display = 'none';

    const card = document.createElement('div');
    card.className = 'notification-card';
    card.dataset.id = notification.messageId;

    let contextHtml = '';
    if (notification.context) {
        contextHtml = `<div class="notification-context md-content">${renderMarkdown(notification.context)}</div>`;
    }

    const bodyHtml = renderMarkdown(notification.body);
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
            <button class="dismiss-btn" data-id="${escapeHtml(notification.messageId)}">Dismiss</button>
        </div>
    `;

    // Prepend so newest is on top
    listEl.insertBefore(card, listEl.firstChild);

    // Wire up dismiss button
    card.querySelector('.dismiss-btn').addEventListener('click', () => {
        dismissNotification(notification.messageId, card);
    });

    renderNotifications();
}

async function dismissNotification(messageId, cardEl) {
    // Animate out
    cardEl.classList.add('dismissing');

    // Check if this notification was received encrypted
    const notification = notifications.find(n => n.messageId === messageId);
    const encrypted = notification?._wasEncrypted || false;

    try {
        await invoke('dismiss_notification', { notificationId: messageId, encrypted });
    } catch (err) {
        console.error('Failed to dismiss notification:', err);
    }

    // Remove from array
    const idx = notifications.findIndex(n => n.messageId === messageId);
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
    const card = listEl.querySelector(`[data-id="${forMessageId}"]`);
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
    const idx = notifications.findIndex(n => n.messageId === messageId);
    if (idx === -1) return;

    notifications.splice(idx, 1);

    const card = listEl.querySelector(`[data-id="${messageId}"]`);
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

// Parse initial notification from URL params
function loadInitialNotification() {
    const params = new URLSearchParams(window.location.search);
    const notificationParam = params.get('notification');
    if (notificationParam) {
        try {
            const notification = JSON.parse(notificationParam);
            notifications.push(notification);
            addNotificationCard(notification);
        } catch (err) {
            console.error('Failed to parse initial notification:', err);
        }
    }
    renderNotifications();
}

// Listen for new notifications from Rust backend
async function setupListeners() {
    await listen('add-notification', (event) => {
        try {
            const notification = typeof event.payload === 'string'
                ? JSON.parse(event.payload)
                : event.payload;
            
            // Avoid duplicates
            if (notifications.some(n => n.messageId === notification.messageId)) return;

            notifications.push(notification);
            addNotificationCard(notification);
        } catch (err) {
            console.error('Failed to handle add-notification:', err);
        }
    });

    await listen('remove-notification', (event) => {
        const notificationId = event.payload;
        removeNotificationById(notificationId);
    });

    // Sender identity is decoration published as a separate companion message
    // (see docs/superpowers/specs/2026-08-15-sender-identity-metadata-design.md)
    // and can arrive after its card has already rendered.
    await listen('sender-identity', (event) => {
        const payload = typeof event.payload === 'string' ? JSON.parse(event.payload) : event.payload;
        applySenderIdentity(payload?.forMessageId, payload?.sender);
    });
}

// Initialize
loadInitialNotification();
setupListeners();

// Show window after content is fully painted (prevents flash)
requestAnimationFrame(() => {
    requestAnimationFrame(() => {
        invoke('show_no_activate');
    });
});
