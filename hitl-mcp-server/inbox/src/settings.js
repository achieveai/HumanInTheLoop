/**
 * Owns the connection settings without knowing how the Inbox renders: first-run
 * setup, and later edits on Android. An edit may leave the key blank to keep
 * the saved one, so the phone never has to show it.
 */
export function createConnectionSettings({ invoke, dialog, openButton, onConfigured }) {
    const form = dialog?.querySelector('form');
    const server = dialog?.querySelector('#connection-url');
    const topic = dialog?.querySelector('#connection-topic');
    const key = dialog?.querySelector('#connection-key');
    const error = dialog?.querySelector('.connection-error');
    const cancel = dialog?.querySelector('.connection-cancel');
    let required = false;
    let started = false;
    let configured = false;

    /** Once saved, a blank key means "keep it". */
    function markConfigured(value) {
        configured = value;
        if (!key) return;
        key.required = !configured;
        key.placeholder = configured ? 'Leave blank to keep the current key' : '';
    }

    function fill({ topicId, ntfyUrl }) {
        if (topicId && topic) topic.value = topicId;
        if (ntfyUrl && server) server.value = ntfyUrl;
    }

    function startOnce() {
        if (started) return;
        started = true;
        onConfigured();
    }

    function open({ mustConfigure = false, topicId = null, ntfyUrl = null, errorMessage = '' } = {}) {
        if (!dialog) return;
        required = mustConfigure;
        fill({ topicId, ntfyUrl });
        if (cancel) cancel.hidden = required;
        if (error) error.textContent = errorMessage;
        if (!dialog.open) dialog.showModal();
        topic?.focus();
    }

    async function initialize() {
        let settings;
        try {
            settings = await invoke('get_connection_settings');
        } catch (reason) {
            const message = String(reason?.message ?? reason);
            open({
                mustConfigure: true,
                errorMessage: `${message} You can retry by saving the connection again.`,
            });
            return;
        }

        markConfigured(Boolean(settings.configured));
        if (!settings.mobile || settings.configured) {
            fill(settings);
            if (!settings.mobile && openButton) openButton.hidden = true;
            startOnce();
            return;
        }
        open({ mustConfigure: true, topicId: settings.topicId, ntfyUrl: settings.ntfyUrl });
    }

    form?.addEventListener('submit', async event => {
        event.preventDefault();
        if (error) error.textContent = '';
        const submit = form.querySelector('[type="submit"]');
        if (submit) submit.disabled = true;
        try {
            await invoke('save_connection_settings', {
                ntfyUrl: server?.value.trim() ?? '',
                topicId: topic?.value.trim() ?? '',
                encryptionKey: key?.value.trim() ?? '',
            });
            required = false;
            markConfigured(true);
            if (key) key.value = '';
            dialog.close();
            startOnce();
        } catch (reason) {
            if (error) error.textContent = String(reason?.message ?? reason);
        } finally {
            if (submit) submit.disabled = false;
        }
    });

    dialog?.addEventListener('cancel', event => {
        if (required) event.preventDefault();
    });
    dialog?.addEventListener('close', () => {
        if (key) key.value = '';
        if (error) error.textContent = '';
    });
    openButton?.addEventListener('click', () => open());

    return { initialize, open };
}
