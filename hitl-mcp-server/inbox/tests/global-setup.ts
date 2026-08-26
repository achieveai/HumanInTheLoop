import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// `review.js`, `review.css` and the vendored markdown-it live under
// `client/src` and are copied into `inbox/src` by scripts/sync-shared-ui.mjs.
// The copies are gitignored, so on a fresh checkout they do not exist at all —
// and a stale copy is worse than a missing one, because the suite would pass
// against a version of review.js the client no longer ships.
//
// Running the sync here rather than in `webServer.command` is deliberate:
// `reuseExistingServer` skips that command whenever a static server is already
// up, which is most of the time locally.
export default function syncSharedUi() {
  execFileSync(
    process.execPath,
    [fileURLToPath(new URL('../../scripts/sync-shared-ui.mjs', import.meta.url))],
    { stdio: 'inherit' },
  );
}
