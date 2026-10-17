import { test, expect, type Page } from '@playwright/test';
import { detail, list, message, project, session, tree } from './fixtures.js';

// Which machine each agent runs on: on its rows, its detail, and the tree.

const fixture = () => {
  const onKay9 = message({ messageId: 'n-1', msgType: 'notification', title: 'Build done', machine: 'Kay9' });
  const older = message({ messageId: 'n-2', msgType: 'notification', title: 'Older sender' });
  return {
    sessions: tree({
      projects: [
        project({
          projectKey: 'Hitl_MCP',
          sessions: [
            session({ sessionKey: 'Hitl_MCP · a3f2', label: 'master · a3f2', machine: 'Kay9' }),
            session({ sessionKey: 'Hitl_MCP · b4c5', label: 'master · b4c5', machine: 'Laptop',
              sessionName: 'Release prep', objective: 'Ship 2.16.0.' }),
            session({ sessionKey: 'Hitl_MCP · 77aa', label: 'master · 77aa' }),
          ],
        }),
      ],
    }),
    messages: list({ messages: [onKay9, older], filter: 'all', defaultFilter: 'all' }),
    details: {
      'n-1': detail(onKay9, { request: { title: 'Build done', body: 'ok' } }),
      'n-2': detail(older, { request: { title: 'Older sender', body: 'ok' } }),
    },
  };
};

async function open(page: Page) {
  await page.addInitScript(f => {
    (window as any).__INBOX_FIXTURE = f;
  }, fixture());
  await page.goto('/inbox-harness.html');
  await expect(page.locator('.message-row')).toHaveCount(2);
}

const agent = (page: Page, key: string) => page.locator(`.agent-row[data-scope-key="session:${key}"] .agent-name`);

test.describe('Machine names', () => {
  test('a message row and its detail say which machine the agent runs on', async ({ page }) => {
    await open(page);
    const row = page.locator('.message-row[data-message-id="n-1"]');
    await expect(row.locator('.message-machine')).toHaveText('on Kay9');
    await expect(page.locator('.message-row[data-message-id="n-2"] .message-machine')).toHaveCount(0);

    await row.click();
    await expect(page.locator('.detail-meta .badge-machine')).toHaveText('on Kay9');
    await page.locator('.message-row[data-message-id="n-2"]').click();
    await expect(page.locator('.detail-root')).toHaveAttribute('data-message-id', 'n-2');
    await expect(page.locator('.badge-machine')).toHaveCount(0);
  });

  test('the tree shows the machine as small text, and on hover', async ({ page }) => {
    await open(page);
    await expect(agent(page, 'Hitl_MCP · a3f2').locator('.agent-label')).toHaveText('Kay9');
    await expect(agent(page, 'Hitl_MCP · a3f2')).toHaveAttribute('title', 'On Kay9');

    const named = agent(page, 'Hitl_MCP · b4c5');
    await expect(named.locator('.agent-label')).toHaveText('master · b4c5 · Laptop');
    await expect(named).toHaveAttribute('title', 'Ship 2.16.0.\nmaster · b4c5\nOn Laptop');

    await expect(agent(page, 'Hitl_MCP · 77aa').locator('.agent-label')).toHaveCount(0);
  });

  test('search finds agents by machine', async ({ page }) => {
    await open(page);
    await page.locator('.agent-search').fill('laptop');
    await expect(page.locator('.agent-row--session')).toHaveCount(1);
    await expect(agent(page, 'Hitl_MCP · b4c5')).toBeVisible();
  });
});
