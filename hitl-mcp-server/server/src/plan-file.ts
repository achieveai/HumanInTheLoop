import { lstatSync, realpathSync, statSync, readFileSync } from 'fs';
import path from 'path';

/**
 * Validation and reading of the markdown file an agent hands to ReviewPlan.
 *
 * A plan is untrusted input in two directions: the agent chooses the path, and
 * the file's own bytes end up rendered on someone's phone. The checks below run
 * in a fixed order so no widening step can undo a narrowing one:
 *
 *   1. reject NUL                (F-3 — a NUL truncates the path inside libc)
 *   2. resolve the realpath      (F-2 — collapses symlinks and `..`)
 *   3. re-check the extension on the RESOLVED path (F-2 — a `.md` symlink
 *      pointing at `~/.ssh/id_rsa` passes an extension check on the link name)
 *   4. lstat + stat: regular files only, no directories, no devices (F-3)
 *   5. size cap as a HARD error, never truncation (F-4)
 *
 * The file is read exactly once, after every check, and hashed from the bytes
 * actually read — so the hash always describes what was reviewed.
 */

/** Extensions accepted as a plan. Checked on the resolved realpath, not the argument. */
const MARKDOWN_EXTENSIONS = ['.md', '.markdown'];

/** Default hard ceiling on plan size. 1 MB gzips to ~250 KB, well under ntfy's 2 MB. */
export const PLAN_MAX_BYTES = 1024 * 1024;

/** Raised for every rejection in this module, so the caller can map one error kind. */
export class PlanFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanFileError';
  }
}

/** A validated plan file plus the bytes that were actually read. */
export interface PlanFile {
  /** Fully resolved, symlink-free absolute path. */
  resolvedPath: string;
  /** utf-8 content, line endings preserved verbatim (B-11). */
  content: string;
  /** utf-8 byte length of `content`. */
  byteLength: number;
}

/**
 * Validate and read a plan file.
 *
 * @param filePath - Absolute or `cwd`-relative path supplied by the agent
 * @param cwd - Base for a relative path; defaults to the server's cwd
 * @param maxBytes - Hard size ceiling; over it is an error, never a truncation
 */
export function readPlanFile(
  filePath: string,
  cwd: string = process.cwd(),
  maxBytes: number = PLAN_MAX_BYTES
): PlanFile {
  if (typeof filePath !== 'string' || filePath.trim() === '') {
    throw new PlanFileError('filePath must be a non-empty string');
  }

  // 1. NUL — must precede every fs call, since the path is truncated at the NUL
  //    by the OS layer and the checks below would then describe a different file.
  if (filePath.includes('\0')) {
    throw new PlanFileError('filePath contains a NUL byte');
  }

  const absolute = path.resolve(cwd, filePath);

  // 2. realpath — collapses symlinks and `..` so steps 3-5 describe the real target.
  let resolvedPath: string;
  try {
    resolvedPath = realpathSync.native(absolute);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new PlanFileError(`Plan file not found: ${absolute}`);
    }
    throw new PlanFileError(`Cannot resolve plan file ${absolute}: ${(err as Error).message}`);
  }

  // 3. Extension on the RESOLVED path. Checking the argument instead would let
  //    `plan.md -> /etc/shadow` through (F-2).
  const ext = path.extname(resolvedPath).toLowerCase();
  if (!MARKDOWN_EXTENSIONS.includes(ext)) {
    throw new PlanFileError(
      `Plan file must be markdown (${MARKDOWN_EXTENSIONS.join(' or ')}); ` +
        `${resolvedPath} resolves to '${ext || 'no extension'}'`
    );
  }

  // 4. lstat on the resolved path catches a symlink chain that realpath could
  //    not fully collapse; stat catches directories, FIFOs, sockets, devices.
  const linkStat = lstatSync(resolvedPath);
  if (linkStat.isSymbolicLink()) {
    throw new PlanFileError(`Plan file is still a symlink after resolution: ${resolvedPath}`);
  }

  const fileStat = statSync(resolvedPath);
  if (fileStat.isDirectory()) {
    throw new PlanFileError(`Plan file is a directory: ${resolvedPath}`);
  }
  if (!fileStat.isFile()) {
    throw new PlanFileError(`Plan file is not a regular file: ${resolvedPath}`);
  }

  // 5. Size — a hard error. Truncating would hand the human a plan that differs
  //    from the one on disk while still hashing as "what was reviewed" (F-4).
  if (fileStat.size > maxBytes) {
    throw new PlanFileError(
      `Plan file is ${fileStat.size} bytes, over the ${maxBytes}-byte limit. ` +
        `Split the plan or raise the limit — it is never truncated.`
    );
  }

  const buffer = readFileSync(resolvedPath);

  // Re-check against the bytes read, not the stat: the file may have grown
  // between stat and read (TOCTOU).
  if (buffer.byteLength > maxBytes) {
    throw new PlanFileError(
      `Plan file grew to ${buffer.byteLength} bytes while being read, over the ${maxBytes}-byte limit.`
    );
  }

  return {
    resolvedPath,
    content: buffer.toString('utf8'),
    byteLength: buffer.byteLength,
  };
}
