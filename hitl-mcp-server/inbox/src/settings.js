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
    const scanOption = dialog?.querySelector('.connection-scan');
    const scanButton = dialog?.querySelector('.scan-connection');
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
        if (scanOption) scanOption.hidden = !settings.mobile;
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

    // Bound handlers do not depend on inline HTML event behavior in a WebView.
    cancel?.addEventListener('click', () => {
        if (!required) dialog.close();
    });
    scanButton?.addEventListener('click', async () => {
        if (error) error.textContent = '';
        scanButton.disabled = true;
        try {
            await invoke('open_qr_scanner');
            // Returning through a scanned link presents the import confirmation;
            // do not leave a second modal underneath it.
            dialog.close();
        } catch (reason) {
            if (error) error.textContent = String(reason?.message ?? reason);
        } finally {
            scanButton.disabled = false;
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
