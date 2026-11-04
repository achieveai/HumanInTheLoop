import { expect, test } from '@playwright/test';

const URI = `hitl-inbox://connect?v=1&server=https%3A%2F%2Fntfy.example.test&topic=phone-topic_123&key=${'ab'.repeat(32)}`;

async function install(page, mobile: boolean) {
  await page.clock.install();
  await page.goto('/index.html');
  await page.evaluate(async ({ mobile, uri }) => {
    const { createConnectionShare } = await import('./share.js');
    const win = window as any;
    win.__SHARE_CALLS = [];
    win.__IMPORTED = 0;
    let pending = mobile ? uri : null;
    const invoke = (command: string, args?: unknown) => {
      win.__SHARE_CALLS.push({ command, args });
      switch (command) {
        case 'get_connection_settings':
          return Promise.resolve({ mobile, configured: true });
        case 'share_connection_qr':
          return Promise.resolve('<svg viewBox="0 0 10 10"><path d="M0 0h10v10H0z"/></svg>');
        case 'take_pending_import': {
          const claimed = pending;
          pending = null;
          return Promise.resolve(claimed);
        }
        case 'inspect_connection_import':
          return Promise.resolve({ server: 'https://ntfy.example.test', topicId: 'phone-topic_123' });
        case 'import_connection':
          return Promise.resolve();
        default:
          return Promise.reject(new Error(`unexpected ${command}`));
      }
    };
    win.__SHARE = createConnectionShare({
      invoke,
      shareButton: document.getElementById('share-connection'),
      shareDialog: document.getElementById('share-dialog'),
      importDialog: document.getElementById('import-dialog'),
      onImported: () => { win.__IMPORTED += 1; },
    });
    await win.__SHARE.initialize();
  }, { mobile, uri: URI });
}

test('desktop share shows the Rust QR and removes it after 60 seconds', async ({ page }) => {
  await install(page, false);
  await expect(page.locator('#share-connection svg')).toBeVisible();
  await page.getByRole('button', { name: 'Share connection' }).click();

  const dialog = page.getByRole('dialog', { name: 'Share connection to Android' });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.share-qr svg')).toBeVisible();
  await expect(dialog.locator('.share-countdown')).toHaveText('Hiding in 60s.');

  await page.clock.fastForward(60_000);
  await expect(dialog).not.toBeVisible();
  await expect(page.locator('#share-dialog .share-qr')).toBeEmpty();
});

test('closing desktop share removes the QR immediately', async ({ page }) => {
  await install(page, false);
  await page.getByRole('button', { name: 'Share connection' }).click();
  const dialog = page.getByRole('dialog', { name: 'Share connection to Android' });
  await expect(dialog.locator('.share-qr svg')).toBeVisible();

  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.locator('#share-dialog .share-qr')).toBeEmpty();
});

test('Android previews a pending connection without displaying its key, and cancel does not save', async ({ page }) => {
  await install(page, true);
  const dialog = page.getByRole('dialog', { name: 'Import connection' });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.import-server')).toHaveText('https://ntfy.example.test');
  await expect(dialog.locator('.import-topic')).toHaveText('phone-topic_123');
  await expect(dialog.locator('.import-overwrite-note')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Replace connection' })).toBeVisible();
  expect(await dialog.textContent()).not.toContain('ab'.repeat(32));

  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).not.toBeVisible();
  const calls = await page.evaluate(() => (window as any).__SHARE_CALLS);
  expect(calls.filter(call => call.command === 'import_connection')).toEqual([]);
  expect(calls.filter(call => call.command === 'take_pending_import')).toHaveLength(1);
});

test('confirmed Android import uses the claimed URI and notifies the Inbox once', async ({ page }) => {
  await install(page, true);
  const dialog = page.getByRole('dialog', { name: 'Import connection' });
  await dialog.getByRole('button', { name: 'Replace connection' }).click();

  await expect(dialog).not.toBeVisible();
  expect(await page.evaluate(() => (window as any).__IMPORTED)).toBe(1);
  const calls = await page.evaluate(() => (window as any).__SHARE_CALLS);
  expect(calls.at(-1)).toEqual({ command: 'import_connection', args: { uri: URI } });
});

test('invalid Android codes cannot be confirmed and show no stale overwrite warning', async ({ page }) => {
  await page.goto('/index.html');
  await page.evaluate(async (uri) => {
    const { createConnectionShare } = await import('./share.js');
    let pending = uri;
    const invoke = (command: string) => {
      if (command === 'get_connection_settings') return Promise.resolve({ mobile: true, configured: true });
      if (command === 'take_pending_import') {
        const claimed = pending;
        pending = null;
        return Promise.resolve(claimed);
      }
      if (command === 'inspect_connection_import') return Promise.reject(new Error('Server must be HTTPS.'));
      return Promise.reject(new Error(`unexpected ${command}`));
    };
    await createConnectionShare({
      invoke,
      shareButton: document.getElementById('share-connection'),
      shareDialog: document.getElementById('share-dialog'),
      importDialog: document.getElementById('import-dialog'),
    }).initialize();
  }, URI.replace('https%3A', 'http%3A'));

  const dialog = page.getByRole('dialog', { name: 'Import connection' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('alert')).toHaveText('Server must be HTTPS.');
  await expect(dialog.getByRole('button', { name: 'Import connection' })).toBeDisabled();
  await expect(page.locator('#import-dialog .import-overwrite-note')).toBeHidden();
});
