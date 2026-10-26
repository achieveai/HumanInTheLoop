export function applyAppearance(theme) {
    if (theme !== 'light' && theme !== 'dark') throw new Error('Invalid appearance theme');
    const root = document.documentElement;
    const previous = root.dataset.hitlTheme === 'dark' ? 'dark' : 'light';
    if (theme === 'dark') root.dataset.hitlTheme = theme;
    else delete root.dataset.hitlTheme;
    if (previous !== theme) window.dispatchEvent(new CustomEvent('hitl-theme-changed', { detail: theme }));
}

function showWarning(message) {
    let warning = document.getElementById('appearance-warning');
    if (!warning && message) {
        warning = document.createElement('div');
        warning.id = 'appearance-warning';
        warning.setAttribute('role', 'alert');
        const text = document.createElement('span');
        text.id = 'appearance-warning-text';
        const close = document.createElement('button');
        close.type = 'button';
        close.textContent = 'Dismiss';
        close.addEventListener('click', () => { warning.hidden = true; });
        warning.append(text, close);
        document.body.append(warning);
    }
    if (warning) {
        warning.querySelector('span').textContent = message || '';
        warning.hidden = !message;
    }
}

export async function initializeAppearance(tauri = window.__TAURI__) {
    if (!tauri) return;
    const listeners = [];
    let revision = 0;
    let current = document.documentElement.dataset.hitlTheme === 'dark' ? 'dark' : 'light';
    let busy = true;
    const toggle = document.getElementById('appearance-toggle');
    const renderToggle = () => {
        if (!toggle) return;
        const dark = current === 'dark';
        toggle.textContent = dark ? '◑' : '◐';
        toggle.setAttribute('aria-pressed', String(dark));
        toggle.setAttribute('aria-disabled', String(busy));
        toggle.title = dark ? 'Switch to light mode' : 'Switch to dark mode';
        if (busy) toggle.setAttribute('aria-busy', 'true');
        else toggle.removeAttribute('aria-busy');
    };
    renderToggle();
    const receive = snapshot => {
        if (!snapshot || !['light', 'dark'].includes(snapshot.theme)) throw new Error('Invalid appearance response');
        applyAppearance(snapshot.theme);
        current = snapshot.theme;
        renderToggle();
        showWarning(snapshot.warning);
    };
    try {
        listeners.push(await tauri.event.listen('appearance-changed', event => {
            revision++;
            try { receive(event.payload); } catch (error) { showWarning(error.message); }
        }));
        listeners.push(await tauri.event.listen('appearance-error', event => showWarning(event.payload)));
        const before = revision;
        const snapshot = await tauri.core.invoke('get_appearance');
        if (before === revision) receive(snapshot);
    } catch (error) {
        showWarning(`Could not load appearance: ${error?.message ?? error}`);
    } finally {
        busy = false;
        renderToggle();
    }

    toggle?.addEventListener('click', async () => {
        if (busy) return;
        const theme = current === 'dark' ? 'light' : 'dark';
        busy = true;
        renderToggle();
        try {
            const before = revision;
            const snapshot = await tauri.core.invoke('set_appearance', { theme });
            if (before === revision) receive(snapshot);
        } catch (error) {
            showWarning(`Could not save appearance: ${error?.message ?? error}`);
        } finally {
            busy = false;
            renderToggle();
        }
    });
    window.addEventListener('pagehide', () => listeners.forEach(unlisten => unlisten()), { once: true });
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => initializeAppearance(), { once: true });
} else {
    initializeAppearance();
}
