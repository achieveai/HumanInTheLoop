/**
 * The bell in the Inbox bar: turns desktop notifications on and off.
 *
 * The Rust side owns the setting and shows the toasts; this only reads it,
 * flips it, and says which way it is. The button stays as it was when a save
 * fails, so it never claims a state the next start would not have.
 */
export function createNotificationToggle({ invoke, button }) {
    let enabled = true;
    let saving = false;

    function render() {
        if (!button) return;
        // The state is in aria-pressed alone; a label that also said it would
        // be read twice.
        button.textContent = enabled ? '🔔' : '🔕';
        button.setAttribute('aria-pressed', String(enabled));
        button.setAttribute('aria-label', 'Desktop notifications');
        button.title = enabled
            ? 'Desktop notifications on. Click to turn them off.'
            : 'Desktop notifications off. Click to turn them on.';
    }

    async function toggle() {
        // A guard, not `disabled`: disabling the focused button would drop
        // keyboard focus to the page.
        if (!button || saving) return;
        saving = true;
        button.setAttribute('aria-busy', 'true');
        try {
            enabled = await invoke('set_notifications_enabled', { enabled: !enabled });
        } catch (error) {
            console.error('could not change desktop notifications', error);
            button.title = `Could not change notifications: ${error?.message ?? error}`;
            return;
        } finally {
            saving = false;
            button.removeAttribute('aria-busy');
        }
        render();
    }

    async function initialize() {
        if (!button) return;
        try {
            enabled = await invoke('get_notifications_enabled');
        } catch (error) {
            // An Inbox without the command (an older shell) has no toasts to
            // turn off; hide the bell rather than show a switch that does nothing.
            console.error('could not read desktop notification setting', error);
            button.hidden = true;
            return;
        }
        render();
        button.addEventListener('click', () => { toggle(); });
    }

    return { initialize, toggle, get enabled() { return enabled; } };
}
