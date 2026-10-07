import { describe, it, expect } from '@jest/globals';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const server = fileURLToPath(new URL('../../', import.meta.url));
const binaries = ['windows-x64/hitl-client.exe', 'linux-x64/hitl-client', 'macos-arm64/hitl-client', 'macos-x64/hitl-client'];

describe('publication binary guard', () => {
  it.each(['missing', 'empty', 'directory', 'complete'])('checks a %s bundle', mode => {
    const root = mkdtempSync(join(tmpdir(), 'hitl-publish-'));
    try {
      mkdirSync(join(root, 'scripts'));
      writeFileSync(join(root, 'package.json'), '{"type":"module"}');
      copyFileSync(join(server, 'scripts/verify-binaries.js'), join(root, 'scripts/verify-binaries.js'));
      for (const binary of binaries) {
        const target = join(root, 'dist/bin', binary);
        mkdirSync(join(target, '..'), { recursive: true });
        if (mode === 'directory') mkdirSync(target);
        else if (mode !== 'missing') writeFileSync(target, mode === 'empty' ? '' : 'test binary');
      }
      const result = spawnSync(process.execPath, [join(root, 'scripts/verify-binaries.js')], { encoding: 'utf8' });
      expect(result.status).toBe(mode === 'complete' ? 0 : 1);
      if (mode !== 'complete') for (const binary of binaries) expect(result.stderr).toContain(binary);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('runs the guard before the build in manual publishing', () => {
    const manifest = JSON.parse(readFileSync(join(server, 'package.json'), 'utf8'));
    expect(manifest.scripts.prepublishOnly).toBe('node scripts/verify-binaries.js && npm run build');
  });
});
