import { describe, it, expect } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { SERVER_VERSION } from '../version.js';
import { PROTOCOL_VERSION } from '../types.js';

/**
 * The version string had already drifted five ways (root 2.0.0 / server 2.9.6 /
 * client 2.6.0 / shared 2.0.0 / Cargo 2.9.6) before anyone noticed. This test
 * is the thing that stops it drifting again.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../..');

function readJson(relPath: string): { version?: string } {
  return JSON.parse(fs.readFileSync(path.join(REPO, relPath), 'utf8'));
}

/**
 * Reads `version` out of a Cargo manifest's `[package]` section specifically.
 *
 * Slicing to the *next* section header rather than to a named one matters: not
 * every crate here has `[build-dependencies]`, and a dependency that happens to
 * share the project's version number (`bitflags`, `tauri-runtime`) sits further
 * down the file waiting to be matched by a looser regex.
 */
function readCargoVersion(relPath: string): string | undefined {
  const cargo = fs.readFileSync(path.join(REPO, relPath), 'utf8');
  const start = cargo.indexOf('[package]');
  const rest = cargo.slice(start + '[package]'.length);
  const end = rest.search(/^\[/m);
  const pkgSection = end === -1 ? rest : rest.slice(0, end);

  return /^version\s*=\s*"([^"]+)"/m.exec(pkgSection)?.[1];
}

/**
 * Every manifest that must carry the release version.
 *
 * Each of these files states in a comment that this test fails the build when
 * its version drifts. That claim was false for five of them once, and
 * `inbox/src-tauri/tauri.conf.json` had already drifted to 2.11.3 while the rest
 * of the repo read 2.12.0. Adding a manifest here is what makes the comment true.
 */
const JSON_MANIFESTS = [
  'package.json',
  'client/package.json',
  'inbox/package.json',
  'client/src-tauri/tauri.conf.json',
  'inbox/src-tauri/tauri.conf.json',
];

const CARGO_MANIFESTS = [
  'client/src-tauri/Cargo.toml',
  'inbox/src-tauri/Cargo.toml',
  'crates/hitl-transport/Cargo.toml',
  'crates/hitl-store/Cargo.toml',
  'crates/hitl-archivist/Cargo.toml',
];

describe('version sync', () => {
  it('reads SERVER_VERSION from server/package.json rather than a literal', () => {
    expect(SERVER_VERSION).toBe(readJson('server/package.json').version);
    expect(SERVER_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it.each(JSON_MANIFESTS)('agrees with %s', (relPath) => {
    expect(readJson(relPath).version).toBe(SERVER_VERSION);
  });

  it.each(CARGO_MANIFESTS)('agrees with the [package] version in %s', (relPath) => {
    expect(readCargoVersion(relPath)).toBe(SERVER_VERSION);
  });

  it('covers every versioned manifest in the repo', () => {
    // The guard above only helps for files it has been told about, so a new
    // crate or app can reintroduce the drift by simply not being listed. Walk
    // the tree instead and fail on anything carrying a version we do not check.
    const skip = new Set(['node_modules', 'target', 'dist', '.git']);
    const found: string[] = [];

    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(path.join(REPO, dir), { withFileTypes: true })) {
        const rel = dir ? `${dir}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (!skip.has(entry.name)) walk(rel);
        } else if (entry.name === 'Cargo.toml' && readCargoVersion(rel)) {
          found.push(rel);
        } else if (entry.name === 'tauri.conf.json') {
          found.push(rel);
        }
      }
    };
    walk('');

    expect(found.sort()).toEqual(
      [...CARGO_MANIFESTS, ...JSON_MANIFESTS.filter((p) => p.endsWith('tauri.conf.json'))].sort()
    );
  });

  it('does not derive the wire protocol version from the package version', () => {
    // PROTOCOL_VERSION is a small integer bumped only when the message shape
    // changes. Tying it to the release version would force every client to
    // upgrade on every release.
    expect(PROTOCOL_VERSION).toBe(2);
    expect(String(PROTOCOL_VERSION)).not.toBe(SERVER_VERSION);
  });

  it('has no leftover shared/ workspace', () => {
    const root = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')) as {
      workspaces: string[];
      scripts: Record<string, string>;
    };

    expect(root.workspaces).toEqual(['server', 'client']);
    expect(root.scripts['build:shared']).toBeUndefined();
    expect(fs.existsSync(path.join(REPO, 'shared'))).toBe(false);
  });
});
