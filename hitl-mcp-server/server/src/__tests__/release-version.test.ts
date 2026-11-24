import { afterEach, describe, expect, it } from '@jest/globals';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(HERE, '../../..');
const SCRIPT = path.join(PACKAGE_ROOT, 'scripts/release-version.mjs');
const JSON_MANIFESTS = [
  'package.json',
  'server/package.json',
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
const CRATES = ['hitl-client', 'hitl-inbox', 'hitl-transport', 'hitl-store', 'hitl-archivist'];
const temporaryRoots: string[] = [];

function fixture(version = '2.17.1'): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hitl-release-version-'));
  temporaryRoots.push(root);
  for (const relative of JSON_MANIFESTS) {
    const filename = path.join(root, relative);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, `${JSON.stringify({ name: relative, version }, null, 2)}\n`);
  }
  for (const relative of CARGO_MANIFESTS) {
    const filename = path.join(root, relative);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, `[package]\nname = "fixture"\nversion = "${version}"\n`);
  }
  fs.writeFileSync(
    path.join(root, 'package-lock.json'),
    `${JSON.stringify({
      version,
      lockfileVersion: 3,
      packages: {
        '': { version },
        client: { version },
        server: { version },
      },
    }, null, 2)}\n`
  );
  fs.writeFileSync(
    path.join(root, 'Cargo.lock'),
    CRATES.map((name) => `[[package]]\nname = "${name}"\nversion = "${version}"\n`).join('\n')
  );
  return root;
}

function run(root: string, ...args: string[]) {
  return spawnSync(process.execPath, [SCRIPT, ...args, '--root', root], {
    encoding: 'utf8',
  });
}

afterEach(() => {
  while (temporaryRoots.length) {
    fs.rmSync(temporaryRoots.pop()!, { recursive: true, force: true });
  }
});

describe('automatic release versions', () => {
  it('increments minor and synchronizes every manifest and lockfile by default', () => {
    const root = fixture();
    const result = run(root);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('2.18.0');

    for (const relative of JSON_MANIFESTS) {
      expect(JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8')).version).toBe('2.18.0');
    }
    for (const relative of CARGO_MANIFESTS) {
      expect(fs.readFileSync(path.join(root, relative), 'utf8')).toContain('version = "2.18.0"');
    }
    const npmLock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
    expect(npmLock.version).toBe('2.18.0');
    expect(npmLock.packages[''].version).toBe('2.18.0');
    expect(npmLock.packages.client.version).toBe('2.18.0');
    expect(npmLock.packages.server.version).toBe('2.18.0');
    const cargoLock = fs.readFileSync(path.join(root, 'Cargo.lock'), 'utf8');
    for (const crate of CRATES) {
      expect(cargoLock).toContain(`name = "${crate}"\nversion = "2.18.0"`);
    }
  });

  it('accepts an explicit major baseline', () => {
    const root = fixture();
    const result = run(root, '3.0.0');
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('3.0.0');
    expect(JSON.parse(fs.readFileSync(path.join(root, 'server/package.json'), 'utf8')).version).toBe('3.0.0');
  });

  it.each(['2.17.1', '2.16.0', '3', 'not-a-version'])('refuses an invalid or non-advancing version: %s', (version) => {
    const root = fixture();
    const before = fs.readFileSync(path.join(root, 'package.json'), 'utf8');
    const result = run(root, version);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(version === '3' || version === 'not-a-version' ? 'Expected a stable x.y.z version' : 'must be newer');
    expect(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).toBe(before);
  });

  it('refuses to hide existing manifest drift', () => {
    const root = fixture();
    const filename = path.join(root, 'inbox/package.json');
    fs.writeFileSync(filename, `${JSON.stringify({ version: '2.16.0' }, null, 2)}\n`);
    const result = run(root);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('inbox/package.json is 2.16.0, expected 2.17.1');
    expect(JSON.parse(fs.readFileSync(path.join(root, 'server/package.json'), 'utf8')).version).toBe('2.17.1');
  });
});
