#!/usr/bin/env node
// Copy the webview assets the Inbox shares with the desktop client.
//
// # Why a copy and not an import
//
// Both apps are Tauri apps with `frontendDist` pointing at their own `src/`,
// and no build step. Tauri embeds exactly that directory: an ES module import
// that reaches outside it resolves to nothing in a bundled app, and there is no
// bundler in the chain to inline it. The two asset roots are disjoint, so a
// module both apps load has to be present under both.
//
// # Why the client's copy is the original
//
// `client/src/review.js` is 968 lines backing a shipping app and 117 Playwright
// tests. Moving it would mean the client's build had to run this script too,
// and a release path that missed it would ship a client with no plan-review
// JavaScript and no error anywhere. The client keeps its file exactly where it
// has always been; only the Inbox's copy is generated.
//
// # There is still only one source of truth
//
// The generated copies are gitignored, so nothing here can be edited and
// committed by mistake — `git status` will not offer them, and
// `inbox/tests/render-review.spec.ts` re-runs this script through Playwright's
// global setup, so a stale copy cannot survive a test run either.
//
// Idempotent: a copy that already matches is left alone, so this is cheap
// enough to run before every build, dev session and test run.

import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** `hitl-mcp-server/`, resolved from this file rather than from the cwd. */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Paths relative to each app's `src/`.
 *
 * `review.js` is the module spec §8.3 requires the Inbox to reuse rather than
 * reimplement. `review.css` is the styling it renders into — the module writes
 * class names, not inline styles, so without it the pane draws unstyled. The
 * vendored markdown-it is what `createMarkdownRenderer()` looks for on
 * `window`, and is also what the Inbox's own notification and question
 * renderers use, so the two apps render a plan the same way.
 */
const ASSETS = [
    'review.js',
    'review.css',
    'vendor/markdown-it.min.js',
    'vendor/diff.min.js',
    'vendor/diff.LICENSE.txt',
];

let copied = 0;
let missing = 0;

for (const asset of ASSETS) {
    const from = join(root, 'client', 'src', asset);
    const to = join(root, 'inbox', 'src', asset);

    if (!existsSync(from)) {
        console.error(`sync-shared-ui: ${from} does not exist`);
        missing += 1;
        continue;
    }

    const source = readFileSync(from);
    if (existsSync(to) && readFileSync(to).equals(source)) continue;

    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
    copied += 1;
}

if (missing > 0) {
    // Loudly, and non-zero: a silent skip here is an Inbox that opens with a
    // blank pane 3 and no explanation.
    console.error(`sync-shared-ui: ${missing} shared asset(s) missing; the Inbox will not render plan reviews`);
    process.exit(1);
}

console.log(`sync-shared-ui: ${ASSETS.length} shared asset(s) in sync (${copied} copied)`);
