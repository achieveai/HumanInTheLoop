#!/usr/bin/env node
import { statSync } from 'node:fs';

const required = [
  'windows-x64/hitl-client.exe',
  'linux-x64/hitl-client',
  'macos-arm64/hitl-client',
  'macos-x64/hitl-client',
];
const missing = required.filter(binary => {
  try {
    const info = statSync(new URL(`../dist/bin/${binary}`, import.meta.url));
    return !info.isFile() || info.size === 0;
  } catch { return true; }
});
if (missing.length) {
  console.error(`Cannot publish: missing or empty client binaries:\n${missing.join('\n')}\nBuild clients with the release workflow and bundle its artifacts into server/dist/bin first.`);
  process.exitCode = 1;
} else {
  console.log('All four client binaries are present and nonempty.');
}
