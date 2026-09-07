import { expect, test } from '@playwright/test';

async function install(page, response: unknown, saveResponse: unknown = undefined) {
  await page.goto('/index.html');
  await page.evaluate(async ({ response, saveResponse }) => {
    const settings = await import('./settings.js');
    const win = window as any;
    win.__SETTINGS_CALLS = [];
    win.__CONFIGURED = 0;
    const invoke = (command: string, args?: unknown) => {
      win.__SETTINGS_CALLS.push({ command, args });
      if (command === 'get_connection_settings') {
        if ((response as any)?.error) return Promise.reject(new Error((response as any).error));
        return Promise.resolve(response);
      }
      if (command === 'save_connection_settings') {
        if ((saveResponse as any)?.error) return Promise.reject(new Error((saveResponse as any).error));
        return Promise.resolve(saveResponse);
      }
      return Promise.reject(new Error(`unexpected ${command}`));
    };
    win.__SETTINGS = settings.createConnectionSettings({
      invoke,
      dialog: document.getElementById('connection-dialog'),
      openButton: document.getElementById('connection-settings'),
      onConfigured: () => { win.__CONFIGURED += 1; },
    });
    await win.__SETTINGS.initialize();
  }, { response, saveResponse });
}

test('missing mobile configuration opens connection setup without starting the Inbox', async ({ page }) => {
  await install(page, { mobile: true, configured: false, topicId: null });

  await expect(page.getByRole('dialog', { name: 'Connect Inbox' })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__CONFIGURED)).toBe(0);
});

test('valid settings save closes setup, clears the secret, and starts the Inbox once', async ({ page }) => {
  await install(page, { mobile: true, configured: false, topicId: null });
  await page.getByLabel('Topic ID').fill('phone-topic_123');
  await page.getByLabel('Encryption key').fill('ab'.repeat(32));
  await page.getByRole('button', { name: 'Save connection' }).click();

  await expect(page.getByRole('dialog', { name: 'Connect Inbox' })).not.toBeVisible();
  expect(await page.getByLabel('Encryption key').inputValue()).toBe('');
  expect(await page.evaluate(() => (window as any).__CONFIGURED)).toBe(1);
  const calls = await page.evaluate(() => (window as any).__SETTINGS_CALLS);
  expect(calls.at(-1)).toEqual({
    command: 'save_connection_settings',
    args: { topicId: 'phone-topic_123', encryptionKey: 'ab'.repeat(32) },
  });
});

test('failed save preserves entered values and announces an inline error', async ({ page }) => {
  await install(
    page,
    { mobile: true, configured: false, topicId: null },
    { error: 'Encryption key must be exactly 64 hexadecimal characters.' },
  );
  await page.getByLabel('Topic ID').fill('phone-topic');
  await page.getByLabel('Encryption key').fill('not-a-key');
  await page.getByRole('button', { name: 'Save connection' }).click();

  await expect(page.getByRole('alert')).toContainText('exactly 64 hexadecimal');
  await expect(page.getByLabel('Topic ID')).toHaveValue('phone-topic');
  await expect(page.getByLabel('Encryption key')).toHaveValue('not-a-key');
  expect(await page.evaluate(() => (window as any).__CONFIGURED)).toBe(0);
});

test('configured mobile startup bypasses setup', async ({ page }) => {
  await install(page, { mobile: true, configured: true, topicId: 'phone-topic' });

  await expect(page.getByRole('dialog', { name: 'Connect Inbox' })).not.toBeVisible();
  expect(await page.evaluate(() => (window as any).__CONFIGURED)).toBe(1);
});

test('configured desktop startup uses the registered settings command and hides mobile settings', async ({ page }) => {
  await install(page, { mobile: false, configured: true, topicId: null });

  await expect(page.getByRole('dialog', { name: 'Connect Inbox' })).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Connection settings' })).toBeHidden();
  expect(await page.evaluate(() => (window as any).__CONFIGURED)).toBe(1);
});

test('an unknown settings command is surfaced instead of starting through a test fallback', async ({ page }) => {
  await install(page, { error: 'unmocked command: get_connection_settings' });

  await expect(page.getByRole('dialog', { name: 'Connect Inbox' })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('unmocked command');
  expect(await page.evaluate(() => (window as any).__CONFIGURED)).toBe(0);
});

test('real settings load failures stay visible and do not start the Inbox', async ({ page }) => {
  await install(page, {
    error: 'Stored connection settings are invalid. Reset or reinstall the app and try again.',
  });

  await expect(page.getByRole('dialog', { name: 'Connect Inbox' })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('Reset or reinstall');
  expect(await page.evaluate(() => (window as any).__CONFIGURED)).toBe(0);
});
