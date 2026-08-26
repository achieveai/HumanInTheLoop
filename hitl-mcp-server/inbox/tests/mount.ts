// Mounts one pane-3 renderer on its own, inside the harness page.
//
// The renderer tests want three things the whole-app harness cannot give them:
// a message of an exact shape without a matching list around it, a *wired*
// reply path, and a handle on the controller the renderer returned so a status
// change can be pushed through `applyRow` without inventing a whole event.
//
// The recorded calls land on `window.__ACTIONS`, so a test asserts on the
// payload the renderer *produced*, not merely on which button lit up.

import { expect, type Page } from '@playwright/test';

export interface MountOptions {
  /** Supply reply handlers. Off by default — that is a valid shipping state. */
  wire?: boolean;
  /** The `BodyOutcome`, for `renderReview` only. */
  body?: unknown;
  /** A persisted `ReviewDraft` to restore, for `renderReview` only. */
  draft?: unknown;
  /** What `myResponseId()` answers — i.e. what this device published. */
  myResponseId?: string | null;
  /** Make every wired publish fail, without anything leaving the machine. */
  failWith?: string;
}

export interface RecordedAction {
  action: string;
  messageId?: string;
  selectedValues?: string[];
  otherText?: string;
  subAnswers?: unknown[];
  verdict?: string;
  overallFeedback?: string;
  inlineComments?: unknown[];
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
      if (options.failWith) return Promise.reject(new Error(options.failWith));
      return null;
    };

    const actions = options.wire
      ? {
          myResponseId: () => options.myResponseId ?? null,
          onDismiss: (row: any) =>
            record('dismiss', { messageId: row.messageId }) ?? Promise.resolve('resp-mine'),
          onSkip: (row: any) =>
            record('skip', { messageId: row?.messageId }) ?? Promise.resolve('resp-mine'),
          onSubmit: (payload: any) => {
            const { row, ...rest } = payload ?? {};
            return record('submit', { messageId: row?.messageId, ...rest })
              ?? Promise.resolve('resp-mine');
          },
          onSubmitReview: (row: any, payload: any) =>
            record('submit-review', { messageId: row?.messageId, ...payload })
              ?? Promise.resolve({ status: 'received', responseId: 'resp-mine', reason: null }),
          onSaveDraft: (draft: any) =>
            record('save-draft', { ...draft }) ?? Promise.resolve(),
          onClearDraft: (keys: any) =>
            record('clear-draft', { ...keys }) ?? Promise.resolve(),
        }
      : {};

    const container = document.getElementById('pane-detail')!;
    // Kept so a test can drive `applyRow` — the §9.3 path, which is reached by
    // the log moving under an open form and by nothing the user can click.
    win.__CONTROLLER = module === 'review'
      ? render(container, detail, options.body, actions, options.draft ?? null)
      : render(container, detail, actions);
  }, { module, detail, options });

  await expect(page.locator('.detail-root')).toHaveCount(1);
}

/** Push a newer `MessageRow` through the mounted renderer's `applyRow`. */
export async function applyRow(page: Page, row: unknown): Promise<void> {
  await page.evaluate(next => (window as any).__CONTROLLER.applyRow(next), row);
}

export async function recorded(page: Page): Promise<RecordedAction[]> {
  return page.evaluate(() => (window as any).__ACTIONS ?? []);
}
