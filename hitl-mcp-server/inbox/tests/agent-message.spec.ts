import { test, expect, type Page } from '@playwright/test';
import { detail, list, message, project, session, tree } from './fixtures.js';

// Messages to agents: the compose box under a message whose session has a tag,
// the box under the list for the agent picked in the tree, and the row for a
// message already sent. Driven through the real app so the
// command and its arguments are what the Rust side receives.

const TAG = '0123456789ab';

const AGENTS = tree({
  projects: [
    project({
      projectKey: 'Hitl_MCP',
      sessions: [
        session({ sessionKey: 'Hitl_MCP · a3f2', label: 'master · a3f2', sessionTag: TAG }),
        session({ sessionKey: 'Hitl_MCP · 77aa', label: 'master · 77aa' }),
      ],
    }),
  ],
});

const NOTE = message({ messageId: 'n-1', msgType: 'notification', title: 'Build done', sessionTag: TAG });
const UNTAGGED = message({ messageId: 'n-2', msgType: 'notification', title: 'Old server' });
const SENT = message({ messageId: 'm-1', msgType: 'agent_message', glyph: '→', title: 'check the build', status: 'replied', sessionTag: TAG });

async function open(page: Page) {
  await page.addInitScript(f => {
    (window as any).__INBOX_FIXTURE = f;
  }, {
    sessions: AGENTS,
    messages: list({ messages: [NOTE, UNTAGGED, SENT], filter: 'all', defaultFilter: 'all' }),
    details: {
      'n-1': detail(NOTE, { request: { title: 'Build done', body: 'ok' } }),
      'n-2': detail(UNTAGGED, { request: { title: 'Old server', body: 'ok' } }),
      'm-1': detail(SENT, { request: { type: 'agent_message', text: 'check the build\nthen report', to: TAG } }),
    },
  });
  await page.goto('/inbox-harness.html');
  await expect(page.locator('.message-row')).toHaveCount(3);
}

const sends = (page: Page) => page.evaluate(() => (window as any).__INVOCATIONS
  .filter((call: any) => call.cmd === 'send_agent_message')
  .map((call: any) => call.args));

test.describe('Messages to agents', () => {
  test('the reading pane has no compose box; you message from the list', async ({ page }) => {
    await open(page);
    await page.locator('.message-row[data-message-id="n-1"]').click();
    await expect(page.locator('.detail-root')).toHaveAttribute('data-message-id', 'n-1');
    await expect(page.locator('#pane-detail .detail-compose')).toHaveCount(0);
  });

  test('the list box trims and sends, then clears', async ({ page }) => {
    await open(page);
    await page.locator('.agent-row[data-scope-key="session:Hitl_MCP · a3f2"]').click();
    const compose = page.locator('#list-compose');
    const send = compose.getByRole('button', { name: 'Send' });
    await expect(send).toBeDisabled();

    await compose.locator('textarea').fill('  please rerun the tests  ');
    await send.click();

    await expect(compose.locator('.detail-compose-status')).toContainText('Sent.');
    await expect(compose.locator('textarea')).toHaveValue('');
    expect(await sends(page)).toEqual([{ sessionTag: TAG, text: 'please rerun the tests' }]);
  });

  test('Ctrl+Enter sends, and a failed send keeps the text', async ({ page }) => {
    await open(page);
    await page.evaluate(() => {
      (window as any).__REPLIES = { send_agent_message: { __error: 'offline' } };
    });
    await page.locator('.agent-row[data-scope-key="session:Hitl_MCP · a3f2"]').click();

    const box = page.locator('#list-compose');
    const text = box.locator('textarea');
    await text.fill('hello');
    await text.press('Control+Enter');

    await expect(box.locator('.detail-compose-status')).toHaveText('Not sent. offline');
    await expect(text).toHaveValue('hello');
    await expect(box.getByRole('button', { name: 'Send' })).toBeEnabled();
  });

  test('a sent message shows its text and that the agent replied', async ({ page }) => {
    await open(page);
    await expect(page.locator('.message-row[data-message-id="m-1"] .status-pill--replied')).toBeVisible();
    await page.locator('.message-row[data-message-id="m-1"]').click();

    await expect(page.locator('.detail-kicker')).toHaveText('Message to agent');
    await expect(page.locator('.agent-message-text')).toHaveText('check the build\nthen report');
    await expect(page.locator('.detail-retained')).toContainText('The agent replied');
  });

  test('a session outside a repo is named once', async ({ page }) => {
    await page.goto('/inbox-harness.html');
    const to = await page.evaluate(async () => {
      const { listComposer } = await import('./render-agent-message.js');
      const session = { sessionTag: '0123456789ab', projectKey: 'scratchpad/spike · 90eb', label: 'scratchpad/spike · 90eb' };
      return listComposer(session, () => Promise.resolve('id')).querySelector('.detail-compose-to').textContent;
    });
    expect(to).toBe('To: scratchpad/spike · 90eb');
  });

  test('picking an agent puts a box under the list that sends to it', async ({ page }) => {
    await open(page);
    const box = page.locator('#list-compose');
    await expect(box).toHaveText('Pick an agent to message it.');

    await page.locator('.agent-row[data-scope-key="session:Hitl_MCP · a3f2"]').click();
    await expect(box.locator('.detail-compose-to')).toHaveText('To: Hitl_MCP · master · a3f2');
    await box.locator('textarea').fill('what are you on?');
    await box.locator('textarea').press('Control+Enter');

    await expect(box.locator('.detail-compose-status')).toContainText('Sent.');
    expect(await sends(page)).toEqual([{ sessionTag: TAG, text: 'what are you on?' }]);
  });

  test('a send from the list box shows the whole thread, not just what needs you', async ({ page }) => {
    await open(page);
    await page.locator('.agent-row[data-scope-key="session:Hitl_MCP · a3f2"]').click();
    await page.locator('.filter[data-filter="needs_you"]').click();
    const box = page.locator('#list-compose');
    await box.locator('textarea').fill('hi');
    await box.getByRole('button', { name: 'Send' }).click();
    await expect(box.locator('.detail-compose-status')).toContainText('Sent.');
    const filters = await page.evaluate(() => (window as any).__INVOCATIONS
      .filter((call: any) => call.cmd === 'list_messages').map((call: any) => call.args.filter));
    expect(filters.slice(-2)).toEqual(['needs_you', 'all']);
  });

  test('an agent without a tag gets a disabled box that says why', async ({ page }) => {
    await open(page);
    await page.locator('.agent-row[data-scope-key="session:Hitl_MCP · 77aa"]').click();
    const box = page.locator('#list-compose');
    await expect(box.locator('textarea')).toBeDisabled();
    await expect(box.getByRole('button', { name: 'Send' })).toBeDisabled();
    await expect(box.locator('.detail-compose-status')).toHaveText('Restart this agent to message it (its HITL is older).');
  });

  test('a project or all agents asks you to pick one', async ({ page }) => {
    await open(page);
    await page.locator('.agent-row[data-scope-key="session:Hitl_MCP · a3f2"]').click();
    await expect(page.locator('#list-compose textarea')).toBeVisible();
    await page.locator('.agent-row[data-scope-key="project:Hitl_MCP"]').click();
    await expect(page.locator('#list-compose')).toHaveText('Pick an agent to message it.');
  });

  test('a refresh keeps half-typed text in the list box', async ({ page }) => {
    await open(page);
    await page.locator('.agent-row[data-scope-key="session:Hitl_MCP · a3f2"]').click();
    const text = page.locator('#list-compose textarea');
    await text.fill('half typed');
    await page.locator('#type-filter-set').getByText('Sent').click();
    await page.locator('.agent-row[data-scope-key="session:Hitl_MCP · a3f2"]').click();
    await expect(text).toHaveValue('half typed');
  });

  test('sent messages have their own type chip', async ({ page }) => {
    await open(page);
    await expect(page.locator('#type-filter-set')).toContainText('Sent');
  });
});
