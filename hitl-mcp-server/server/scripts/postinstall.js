#!/usr/bin/env node

// Postinstall script: ensure bundled client binary is executable on Unix platforms.

import { readdirSync, chmodSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const binDir = join(__dirname, '..', 'dist', 'bin');

if (process.platform === 'win32') {
  process.exit(0);
}

try {
  const platforms = readdirSync(binDir);
  for (const platform of platforms) {
    const platformDir = join(binDir, platform);
    if (!statSync(platformDir).isDirectory()) continue;

    const files = readdirSync(platformDir);
    for (const file of files) {
      if (file.startsWith('hitl-client')) {
        const filePath = join(platformDir, file);
        chmodSync(filePath, 0o755);
        console.log(`postinstall: chmod +x ${filePath}`);
      }
    }
  }
} catch {
  // bin/ directory may not exist if binaries aren't bundled (dev install)
}
