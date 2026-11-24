import { chmodSync, readdirSync, rmSync } from 'fs';
import path from 'path';

/** Remove a temporary tree, including Git's read-only object files on Windows. */
export function removeTree(root: string, options: { recursive: boolean; force: boolean }): void {
  if (process.platform === 'win32') {
    const makeWritable = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const target = path.join(dir, entry.name);
        if (entry.isDirectory()) makeWritable(target);
        else chmodSync(target, 0o666);
      }
    };
    makeWritable(root);
  }
  rmSync(root, options);
}
