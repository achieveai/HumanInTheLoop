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

describe('version sync', () => {
  it('reads SERVER_VERSION from server/package.json rather than a literal', () => {
    expect(SERVER_VERSION).toBe(readJson('server/package.json').version);
    expect(SERVER_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('agrees across the root, server and client package manifests', () => {
    expect(readJson('package.json').version).toBe(SERVER_VERSION);
    expect(readJson('client/package.json').version).toBe(SERVER_VERSION);
  });

  it('agrees with tauri.conf.json', () => {
    expect(readJson('client/src-tauri/tauri.conf.json').version).toBe(SERVER_VERSION);
  });

  it('agrees with the Rust crate version in Cargo.toml', () => {
    const cargo = fs.readFileSync(path.join(REPO, 'client/src-tauri/Cargo.toml'), 'utf8');
    const pkgSection = cargo.slice(cargo.indexOf('[package]'), cargo.indexOf('[build-dependencies]'));
    const version = /^version\s*=\s*"([^"]+)"/m.exec(pkgSection)?.[1];

    expect(version).toBe(SERVER_VERSION);
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
