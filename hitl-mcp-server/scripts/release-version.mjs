#!/usr/bin/env node

/**
 * Advance every release manifest together. With no version argument, increment
 * the minor version and reset the patch. An explicit x.y.z version establishes
 * a new baseline (for example, 3.0.0). Nothing is committed or tagged here.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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
const CRATE_NAMES = [
  'hitl-client',
  'hitl-inbox',
  'hitl-transport',
  'hitl-store',
  'hitl-archivist',
];

function readJson(root, relative) {
  return JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
}

function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
  if (!match) throw new Error(`Expected a stable x.y.z version, received: ${value}`);
  return match.slice(1).map(Number);
}

function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

function cargoVersion(source, relative) {
  const packageStart = source.indexOf('[package]');
  const rest = source.slice(packageStart + '[package]'.length);
  const packageEnd = rest.search(/^\[/m);
  const packageSection = packageEnd === -1 ? rest : rest.slice(0, packageEnd);
  const match = /^version\s*=\s*"([^"]+)"/m.exec(packageSection);
  if (!match) throw new Error(`No [package] version found in ${relative}`);
  return match[1];
}

function replaceCargoVersion(source, relative, version) {
  const pattern = /^(\[package\][\s\S]*?^version\s*=\s*")[^"]+(")/m;
  if (!pattern.test(source)) throw new Error(`No [package] version found in ${relative}`);
  return source.replace(pattern, `$1${version}$2`);
}

function replaceLockedCrate(source, crate, version) {
  const escaped = crate.replaceAll('-', '\\-');
  const pattern = new RegExp(`(\\[\\[package\\]\\]\\r?\\nname = "${escaped}"\\r?\\nversion = ")[^"]+(")`, 'g');
  const matches = source.match(pattern);
  if (matches?.length !== 1) {
    throw new Error(`Expected exactly one Cargo.lock entry for ${crate}; found ${matches?.length ?? 0}`);
  }
  return source.replace(pattern, `$1${version}$2`);
}

function assertSynchronized(root, current) {
  for (const relative of JSON_MANIFESTS) {
    const actual = readJson(root, relative).version;
    if (actual !== current) throw new Error(`${relative} is ${actual}, expected ${current}`);
  }
  for (const relative of CARGO_MANIFESTS) {
    const actual = cargoVersion(fs.readFileSync(path.join(root, relative), 'utf8'), relative);
    if (actual !== current) throw new Error(`${relative} is ${actual}, expected ${current}`);
  }

  const lock = readJson(root, 'package-lock.json');
  const lockVersions = new Map([
    ['package-lock.json', lock.version],
    ['package-lock.json packages[""]', lock.packages?.['']?.version],
    ['package-lock.json packages.client', lock.packages?.client?.version],
    ['package-lock.json packages.server', lock.packages?.server?.version],
  ]);
  for (const [label, actual] of lockVersions) {
    if (actual !== current) throw new Error(`${label} is ${actual}, expected ${current}`);
  }
}

function updateVersions(root, requested) {
  const current = readJson(root, 'server/package.json').version;
  parseVersion(current);
  assertSynchronized(root, current);

  const [major, minor] = parseVersion(current);
  const version = requested ?? `${major}.${minor + 1}.0`;
  if (compareVersions(version, current) <= 0) {
    throw new Error(`Release version ${version} must be newer than ${current}`);
  }

  const updates = new Map();
  for (const relative of JSON_MANIFESTS) {
    const json = readJson(root, relative);
    json.version = version;
    updates.set(relative, `${JSON.stringify(json, null, 2)}\n`);
  }

  const packageLock = readJson(root, 'package-lock.json');
  packageLock.version = version;
  packageLock.packages[''].version = version;
  packageLock.packages.client.version = version;
  packageLock.packages.server.version = version;
  updates.set('package-lock.json', `${JSON.stringify(packageLock, null, 2)}\n`);

  for (const relative of CARGO_MANIFESTS) {
    const source = fs.readFileSync(path.join(root, relative), 'utf8');
    updates.set(relative, replaceCargoVersion(source, relative, version));
  }

  let cargoLock = fs.readFileSync(path.join(root, 'Cargo.lock'), 'utf8');
  for (const crate of CRATE_NAMES) cargoLock = replaceLockedCrate(cargoLock, crate, version);
  updates.set('Cargo.lock', cargoLock);

  // Validate and stage every edit in memory before touching any file.
  for (const [relative, contents] of updates) {
    fs.writeFileSync(path.join(root, relative), contents);
  }
  return version;
}

function main() {
  const args = process.argv.slice(2);
  let root = DEFAULT_ROOT;
  const rootIndex = args.indexOf('--root');
  if (rootIndex !== -1) {
    if (!args[rootIndex + 1]) throw new Error('--root requires a directory');
    root = path.resolve(args[rootIndex + 1]);
    args.splice(rootIndex, 2);
  }
  if (args.length > 1) throw new Error('Usage: node scripts/release-version.mjs [x.y.z] [--root directory]');
  process.stdout.write(`${updateVersions(root, args[0])}\n`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
