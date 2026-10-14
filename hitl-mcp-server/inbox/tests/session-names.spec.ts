import { test, expect, type Page } from '@playwright/test';
import { detail, list, message, project, session, tree } from './fixtures.js';

// Sessions the agent named with NameSession: the name leads everywhere, the
// branch and id stay as small text, and earlier names show as "Formerly".

const TAG = '0123456789ab';
const KEY = 'Hitl_MCP · a3f2';
const NAMING = {
  sessionName: 'Session names',
  objective: 'Let agents name their sessions.',
  formerNames: ['Android build', 'Inbox fix'],
};

const agents = (naming: Partial<typeof NAMING>) => tree({
  projects: [
    project({
      projectKey: 'Hitl_MCP',
      sessions: [
        session({ sessionKey: KEY, label: 'master · a3f2', sessionTag: TAG, ...naming }),
        session({ sessionKey: 'Hitl_MCP · 77aa', label: 'master · 77aa' }),
      ],
    }),
  ],
});

const NOTE = message({ messageId: 'n-1', msgType: 'notification', title: 'Build done', sessionTag: TAG, ...NAMING });
const PLAIN = message({ messageId: 'n-2', msgType: 'notification', title: 'Unnamed agent' });

const fixture = (naming: Partial<typeof NAMING>, note = NOTE) => ({
  sessions: agents(naming),
  messages: list({ messages: [note, PLAIN], filter: 'all', defaultFilter: 'all' }),
  details: {
    'n-1': detail(note, { request: { title: 'Build done', body: 'ok' } }),
    'n-2': detail(PLAIN, { request: { title: 'Unnamed agent', body: 'ok' } }),
  },
});

async function open(page: Page, naming: Partial<typeof NAMING> = NAMING, note = NOTE) {
  await page.addInitScript(f => {
    (window as any).__INBOX_FIXTURE = f;
  }, fixture(naming, note));
  await page.goto('/inbox-harness.html');
  await expect(page.locator('.message-row')).toHaveCount(2);
}

const named = (page: Page) => page.locator(`.agent-row[data-scope-key="session:${KEY}"]`);

test.describe('Session names', () => {
  test('the tree shows the name first, the branch small, and the rest on hover', async ({ page }) => {
    await open(page);
    const name = named(page).locator('.agent-name');
    await expect(name).toContainText('Session names');
    await expect(name.locator('.agent-label')).toHaveText('master · a3f2');
    await expect(name).toHaveAttribute('title',
      'Let agents name their sessions.\nmaster · a3f2\nFormerly: Android build · Inbox fix');

    const plain = page.locator('.agent-row[data-scope-key="session:Hitl_MCP · 77aa"] .agent-name');
    await expect(plain).toHaveText('master · 77aa');
    await expect(plain).not.toHaveAttribute('title', /./);
  });

  test('search finds a session by its name, objective or a former name', async ({ page }) => {
    await open(page);
    const search = page.locator('.agent-search');
    for (const query of ['session names', 'name their', 'android']) {
      await search.fill(query);
      await expect(named(page)).toBeVisible();
      await expect(page.locator('.agent-row--session')).toHaveCount(1);
    }
  });

  test('a message row and its detail name the session', async ({ page }) => {
    await open(page);
    const row = page.locator('.message-row[data-message-id="n-1"]');
    await expect(row.locator('.message-session')).toHaveText('Session names');
    await expect(page.locator('.message-row[data-message-id="n-2"] .message-session')).toHaveCount(0);

    await row.click();
    const line = page.locator('.detail-session');
    await expect(line.locator('.detail-session-name')).toHaveText('Session names');
    await expect(line.locator('.detail-session-objective')).toHaveText('Let agents name their sessions.');
    await expect(line.locator('.detail-session-former')).toHaveText('Formerly: Android build · Inbox fix');
    await expect(page.locator('.detail-compose .detail-compose-to')).toHaveText('To: Session names');
  });

  test('the list box follows a rename without losing what was typed', async ({ page }) => {
    await open(page, {});
    await named(page).click();
    const to = page.locator('#list-compose .detail-compose-to');
    await expect(to).toHaveText('To: Hitl_MCP · master · a3f2');
    const text = page.locator('#list-compose textarea');
    await text.fill('half typed');

    await page.evaluate(f => {
      (window as any).__INBOX_FIXTURE = f;
      (window as any).__simulateChange();
    }, fixture(NAMING));

    await expect(to).toHaveText('To: Session names');
    await expect(text).toHaveValue('half typed');
  });

  test('Rename asks the agent to rename itself, in words you can see', async ({ page }) => {
    await open(page);
    await named(page).click();
    const box = page.locator('#list-compose');
    await box.getByRole('button', { name: 'Rename' }).click();
    // The caret sits inside the quotes, so typing fills in the name.
    await page.keyboard.type('Release prep');
    await box.getByRole('button', { name: 'Send' }).click();
    await expect(box.locator('.detail-compose-status')).toContainText('Sent.');

    const sent = await page.evaluate(() => (window as any).__INVOCATIONS
      .filter((call: any) => call.cmd === 'send_agent_message').map((call: any) => call.args));
    expect(sent).toHaveLength(1);
    expect(sent[0].sessionTag).toBe(TAG);
    expect(sent[0].text).toBe('Rename this session to "Release prep". Call NameSession with that name, and update the objective if it changed.');
  });

  test('an agent that cannot take messages has no Rename button', async ({ page }) => {
    await open(page);
    await page.locator('.agent-row[data-scope-key="session:Hitl_MCP · 77aa"]').click();
    await expect(page.locator('#list-compose textarea')).toBeDisabled();
    await expect(page.locator('#list-compose').getByRole('button', { name: 'Rename' })).toHaveCount(0);
  });

  test('an open message follows a rename without losing what was typed', async ({ page }) => {
    const unnamed = message({ messageId: 'n-1', msgType: 'notification', title: 'Build done', sessionTag: TAG });
    await open(page, {}, unnamed);
    await page.locator('.message-row[data-message-id="n-1"]').click();
    const detailBox = page.locator('#pane-detail .detail-compose');
    await expect(page.locator('.detail-session')).toHaveCount(0);
    const text = detailBox.locator('textarea');
    await text.fill('half typed');

    await page.evaluate(f => {
      (window as any).__INBOX_FIXTURE = f;
      (window as any).__simulateChange();
    }, fixture(NAMING));

    await expect(page.locator('.detail-session-name')).toHaveText('Session names');
    await expect(detailBox.locator('.detail-compose-to')).toHaveText('To: Session names');
    await expect(text).toHaveValue('half typed');
  });
});
