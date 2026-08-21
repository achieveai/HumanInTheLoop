// Mounts one pane-3 renderer on its own, inside the harness page.
//
// The renderer tests want two things the whole-app harness cannot give them:
// a message of an exact shape without a matching list around it, and a *wired*
// reply path. Task 9 owns the real reply path; until it lands `inbox.js` passes
// no handlers at all, which is itself worth testing — but it means the only way
// to check that Submit sends what it claims to send is to supply the handlers
// here.
//
// The recorded calls land on `window.__ACTIONS`, so a test asserts on the
// payload the renderer *produced*, not merely on which button lit up.

import { expect, type Page } from '@playwright/test';

export interface MountOptions {
  /** Supply reply handlers. Off by default — that is the shipping state. */
  wire?: boolean;
  /** The `BodyOutcome`, for `renderReview` only. */
  body?: unknown;
}

export interface RecordedAction {
  action: string;
  messageId?: string;
  selectedValues?: string[];
  otherText?: string;
  subAnswers?: unknown[];
  verdict?: string;
  overallFeedback?: string;
}

/**
 * Render `fn` from `module` into `#pane-detail` and return once it has painted.
 *
 * The harness page is loaded first so the real stylesheets, the markdown-it
 * bundle and the `window.__TAURI__` mock are all present — a renderer that only
 * works without its CSS is not a renderer that works.
 */
export async function mount(
  page: Page,
  module: string,
  detail: unknown,
  options: MountOptions = {},
): Promise<void> {
  await page.goto('/inbox-harness.html');
  await page.evaluate(async ({ module, detail, options }) => {
    const mod = await import(`./render-${module}.js`);
    const render = mod[`render${module[0].toUpperCase()}${module.slice(1)}`];

    const win = window as any;
    win.__ACTIONS = [];
    const record = (action: string, extra: Record<string, unknown> = {}) => {
      win.__ACTIONS.push({ action, ...extra });
    };

    const actions = options.wire
      ? {
          onDismiss: (row: any) => record('dismiss', { messageId: row.messageId }),
          onSkip: (row: any) => {
            record('skip', { messageId: row?.messageId });
            return Promise.resolve({ status: 'received' });
          },
          onSubmit: (payload: any) => {
            const { row, ...rest } = payload ?? {};
            record('submit', { messageId: row?.messageId, ...rest });
            return Promise.resolve({ status: 'received' });
          },
        }
      : {};

    const container = document.getElementById('pane-detail')!;
    if (module === 'review') {
      render(container, detail, options.body, actions);
    } else {
      render(container, detail, actions);
    }
  }, { module, detail, options });

  await expect(page.locator('.detail-root')).toHaveCount(1);
}

export async function recorded(page: Page): Promise<RecordedAction[]> {
  return page.evaluate(() => (window as any).__ACTIONS ?? []);
}
