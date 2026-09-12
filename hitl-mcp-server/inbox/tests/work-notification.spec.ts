import { test, expect } from '@playwright/test';
import { detail, message, list } from './fixtures.js';
import { mount } from './mount.js';
function work(revision = 1) {
 const task = (taskId: string, parentTaskId: string | null) => ({ taskId, parentTaskId, revision, owner: 'UI agent', reportedBy: 'Lead', status: 'in_progress', completed: ['Read code'], learnings: ['Status separate'], current: { action: `Revision ${revision}`, purpose: 'Keep informed' }, remaining: ['Verify'], blockers: [], reportedAt: Date.now() });
 return detail(message({ messageId: 'work-1', msgType: 'notification', title: 'Progress', badges: { revision } } as any), { request: { type: 'work_update', body: 'Editor summary: tests are green', workId: 'work-1', revision, document: { workId: 'work-1', title: 'Progress', goal: '<img src=x> Ship it', rootTaskId: 'root', revision, updatedAt: Date.now(), changes: ['Tests added'], tasks: [task('root', null), task('child', 'root'), task('grandchild', 'child')] } } });
}
test('safe recursive work document', async ({ page }) => {
 await mount(page, 'notification', work(), { wire: true });
 await expect(page.locator('.work-document')).toContainText('What changed');
 await expect(page.locator('.work-document')).toContainText('Editor summary: tests are green');
 await expect(page.locator('.work-document')).toContainText('Reported by Lead');
 await expect(page.locator('.work-document img')).toHaveCount(0);
 await page.locator('details[data-task-id="child"] > summary').click();
 await page.locator('details[data-task-id="grandchild"] > summary').click();
 await expect(page.locator('details[data-task-id="grandchild"]')).toHaveAttribute('open', '');
});
test('revision refresh preserves expansion on update and show', async ({ page }) => {
 await page.goto('/inbox-harness.html');
 await page.evaluate(async initial => { const { createDetailPane } = await import('./pane-detail.js'); const w = window as any; w.nextWork = initial; w.workPane = createDetailPane({ container: document.getElementById('pane-detail')!, invoke: async () => w.nextWork }); await w.workPane.show(initial.row); }, work());
 await page.locator('details[data-task-id="child"] > summary').click();
 for (const revision of [2, 3]) {
 await page.evaluate(async next => { const w = window as any; w.nextWork = next; await w.workPane[next.request.revision === 2 ? 'update' : 'show'](next.row); }, work(revision));
 await expect(page.locator('.work-document')).toContainText(`Revision ${revision}`);
 await expect(page.locator('details[data-task-id="child"]')).toHaveAttribute('open', '');
 }
});

test('Inbox event refreshes work with unchanged status', async ({ page }) => {
 const initial = work();
 await page.addInitScript(f => { (window as any).__INBOX_FIXTURE = f; }, { messages: list({ messages: [initial.row] }), details: { 'work-1': initial } });
 await page.goto('/inbox-harness.html');
 await page.locator('.message-row[data-message-id="work-1"]').click();
 await expect(page.locator('.work-document')).toContainText('Revision 1');
 await page.locator('details[data-task-id="child"] > summary').click();
 const next = work(2);
 await page.evaluate(f => { const w = window as any; w.__INBOX_FIXTURE = f; w.__simulateChange(); }, { messages: list({ messages: [next.row] }), details: { 'work-1': next } });
 await expect(page.locator('.work-document')).toContainText('Revision 2');
 await expect(page.locator('details[data-task-id="child"]')).toHaveAttribute('open', '');
});
