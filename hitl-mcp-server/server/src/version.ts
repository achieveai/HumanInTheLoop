import { createRequire } from 'module';

const require = createRequire(import.meta.url);

/**
 * The single source of truth for the server's version — read from package.json
 * rather than duplicated as a literal, which had already drifted five ways
 * (root 2.0.0 / server 2.9.6 / client 2.6.0 / shared 2.0.0 / Cargo 2.9.6).
 *
 * Resolves identically from `src/` (ts-jest) and from `dist/` (compiled): both
 * sit one directory below the package root.
 *
 * This is NOT the wire protocol version — see PROTOCOL_VERSION in types.ts,
 * which is a small integer bumped only when the message shape changes.
 */
export const SERVER_VERSION: string = (require('../package.json') as { version: string }).version;
