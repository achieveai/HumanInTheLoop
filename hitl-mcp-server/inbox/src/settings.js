/** Owns first-run connection setup without knowing how the Inbox renders. */
export function createConnectionSettings({ invoke, dialog, openButton, onConfigured }) {
    const form = dialog?.querySelector('form');
    const topic = dialog?.querySelector('#connection-topic');
    const key = dialog?.querySelector('#connection-key');
    const error = dialog?.querySelector('.connection-error');
    const cancel = dialog?.querySelector('.connection-cancel');
    let required = false;
    let started = false;

    function startOnce() {
        if (started) return;
        started = true;
        onConfigured();
    }

    function open({ mustConfigure = false, topicId = null, errorMessage = '' } = {}) {
        if (!dialog) return;
        required = mustConfigure;
        if (topicId !== null && topic) topic.value = topicId;
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

        if (!settings.mobile || settings.configured) {
            if (settings.topicId && topic) topic.value = settings.topicId;
            if (!settings.mobile && openButton) openButton.hidden = true;
            startOnce();
            return;
        }
        open({ mustConfigure: true, topicId: settings.topicId });
    }

    form?.addEventListener('submit', async event => {
        event.preventDefault();
        if (error) error.textContent = '';
        const submit = form.querySelector('[type="submit"]');
        if (submit) submit.disabled = true;
        try {
            await invoke('save_connection_settings', {
                topicId: topic?.value ?? '',
                encryptionKey: key?.value ?? '',
            });
            required = false;
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
    openButton?.addEventListener('click', () => open({ topicId: topic?.value ?? null }));

    return { initialize, open };
}
