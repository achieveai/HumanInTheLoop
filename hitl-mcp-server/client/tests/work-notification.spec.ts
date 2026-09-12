import { test, expect } from '@playwright/test';
function work(revision = 1, alert = true) { return { type: 'work_update', body: 'Editor summary: tests are green', messageId: `event-${revision}`, workId: 'work-1', revision, alert, title: 'Progress', timestamp: Date.now(), document: { workId: 'work-1', title: 'Progress', goal: '<img src=x> Ship it', rootTaskId: 'root', revision, updatedAt: Date.now(), changes: [`Change ${revision}`], tasks: [{ taskId: 'root', parentTaskId: null, revision, owner: 'Agent', status: 'completed', completed: ['Done'], learnings: [], current: null, remaining: [], blockers: [], reportedAt: Date.now() }] } }; }
async function send(page: any, payload: any) { await page.evaluate((payload: any) => (window as any).__listeners['add-notification']({ payload }), payload); }
test('coalesce revisions, dismiss by workId, never revive on quiet or stale alert', async ({ page }) => {
 await page.goto(`/notifications-harness.html?notification=${encodeURIComponent(JSON.stringify(work()))}`);
 await expect(page.locator('.work-document')).toContainText('Change 1');
 await expect(page.locator('.work-document')).toContainText('Editor summary: tests are green');
 await send(page, work(3, false)); await send(page, work(2));
 await expect(page.locator('.notification-card')).toHaveCount(1);
 await expect(page.locator('.work-document')).toContainText('Change 3');
 await expect(page.locator('.work-document img')).toHaveCount(0);
 const calls: string[] = []; page.on('console', msg => calls.push(msg.text()));
 await page.getByRole('button', { name: 'Dismiss' }).click();
 await expect(page.locator('.notification-card')).toHaveCount(0);
 expect(calls.some(c => c.includes('notificationId: work-1'))).toBeTruthy();
 await send(page, work(4, false)); await send(page, work(3));
 await expect(page.locator('.notification-card')).toHaveCount(0);
});
test('quiet updates do not create cards, ordinary notifications still render', async ({ page }) => {
 await page.goto('/notifications-harness.html');
 await send(page, work(1, false)); await expect(page.locator('.notification-card')).toHaveCount(0);
 await send(page, { messageId: 'legacy', title: 'Legacy', body: '**Hello**', timestamp: Date.now() });
 await expect(page.locator('.notification-body strong')).toHaveText('Hello');
});

for (const fails of [false, true]) {
 test(`revision during pending dismissal ${fails ? 'rolls back on failure' : 'is removed on success'}`, async ({ page }) => {
  await page.goto(`/notifications-harness.html?notification=${encodeURIComponent(JSON.stringify(work()))}`);
  await send(page, { messageId: 'other', title: 'Other', body: 'Keep open', timestamp: Date.now() });
  await page.evaluate(() => { (window as any).__DEFER_DISMISS = true; });
  await page.locator('.notification-card[data-id="work-1"] .dismiss-btn').click();
  await send(page, work(2, false));
  await page.evaluate(fails => { const w = window as any; if (fails) w.__rejectDismiss(new Error('offline')); else w.__resolveDismiss(); }, fails);
  if (fails) {
   await expect(page.locator('.notification-card[data-id="work-1"]')).toContainText('Change 2');
   await send(page, work(3, false));
   await expect(page.locator('.notification-card[data-id="work-1"]')).toBeVisible();
   await expect(page.locator('.notification-card[data-id="work-1"]')).toContainText('Change 3');
   await expect(page.locator('.notification-card[data-id="work-1"] .dismiss-btn')).toBeEnabled();
  } else await expect(page.locator('.notification-card[data-id="work-1"]')).toHaveCount(0);
  await expect(page.locator('.notification-card[data-id="other"]')).toBeVisible();
 });
}
