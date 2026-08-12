import { test, expect } from '@playwright/test';

// A plan is untrusted input. Prompt injection via a README, a fetched page or
// dependency docs is mainstream, and ReviewPlan is precisely the gate meant to
// catch a misbehaving agent — so it has to be robust against what it gates.

const securityUrl = '/review-harness.html?fixture=security';

test.describe('Rendered-pane hardening', () => {
  test('F-6: an injected <script> executes nothing and fires no invoke', async ({ page }) => {
    await page.goto(securityUrl);
    await page.waitForTimeout(300);

    expect(await page.evaluate(() => (window as any).__xssFired)).toBeUndefined();
    // The only invoke the harness records would be a forged submit_answer.
    expect(await page.evaluate(() => (window as any).__lastInvoke)).toBeUndefined();
    // markdown-it with html:false drops the tag entirely; it survives as text.
    await expect(page.locator('#rendered-content script')).toHaveCount(0);
    await expect(page.locator('#rendered-content')).toContainText('__xssFired');
  });

  test('F-5: a position:fixed overlay cannot paint over the verdict buttons', async ({ page }) => {
    await page.goto(securityUrl);

    // Raw HTML never becomes an element…
    await expect(page.locator('#spoof-overlay')).toHaveCount(0);
    await expect(page.locator('#rendered-content div')).toHaveCount(0);

    // …and the verdict controls are outside the scrolling plan container, so
    // even an element that did escape could not cover them.
    const footer = page.locator('.review-footer');
    await expect(footer.locator('#btn-approve')).toBeVisible();
    const box = await footer.locator('#btn-approve').boundingBox();
    expect(box).not.toBeNull();

    // The click reaches the real button rather than an interposed overlay.
    await footer.locator('#btn-approve').click();
    const payload = await page.evaluate(() => (window as any).__lastSubmit);
    expect(payload.verdict).toBe('approved');
  });

  test('the verdict footer is not a descendant of either scrolling pane', async ({ page }) => {
    await page.goto(securityUrl);
    const nested = await page.evaluate(() => {
      const btn = document.querySelector('#btn-approve');
      return Boolean(btn?.closest('.review-pane'));
    });
    expect(nested).toBe(false);
  });

  test('F-6: a javascript: link is not turned into a live href', async ({ page }) => {
    await page.goto(securityUrl);
    await expect(page.locator('#rendered-content a[href^="javascript:"]')).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).__jsUriFired)).toBeUndefined();
  });
});

test.describe('Remote images (F-7)', () => {
  test('a remote image fires no network request on render', async ({ page }) => {
    const requested: string[] = [];
    await page.route('**://attacker.example/**', route => {
      requested.push(route.request().url());
      return route.abort();
    });

    await page.goto(securityUrl);
    await page.waitForTimeout(500);

    expect(requested).toEqual([]);
    // It renders as a click-to-load placeholder that shows the URL.
    const ph = page.locator('.md-image-placeholder');
    await expect(ph).toHaveCount(1);
    await expect(ph).toContainText('https://attacker.example/pixel.png?d=leak');
    await expect(page.locator('#rendered-content img')).toHaveCount(0);
  });

  test('the placeholder loads only on an explicit click', async ({ page }) => {
    const requested: string[] = [];
    await page.route('**://attacker.example/**', route => {
      requested.push(route.request().url());
      return route.abort();
    });

    await page.goto(securityUrl);
    await page.waitForTimeout(300);
    expect(requested).toEqual([]);

    await page.locator('.md-image-placeholder').click();
    await expect.poll(() => requested.length).toBeGreaterThan(0);
  });
});

test.describe('Vendored libraries (E-11 / F-8)', () => {
  test('no page requests a CDN', async ({ page }) => {
    const external: string[] = [];
    page.on('request', req => {
      const u = req.url();
      if (!u.startsWith('http://127.0.0.1:3848') && !u.startsWith('data:')) external.push(u);
    });

    for (const path of ['/index.html', '/notifications.html', '/test-harness.html',
                        '/test-notifications.html', '/review-harness.html']) {
      await page.goto(path);
      await page.waitForTimeout(200);
    }

    expect(external.filter(u => u.includes('jsdelivr'))).toEqual([]);
  });

  test('markdown-it and marked are served from src/vendor', async ({ page, request }) => {
    const mdit = await request.get('/vendor/markdown-it.min.js');
    expect(mdit.status()).toBe(200);
    expect((await mdit.text())).toContain('markdown-it 14.1.0');

    const marked = await request.get('/vendor/marked.umd.js');
    expect(marked.status()).toBe(200);
    expect((await marked.text())).toContain('marked v11.1.1');

    await page.goto('/review-harness.html');
    expect(await page.evaluate(() => typeof (window as any).markdownit)).toBe('function');
  });
});
