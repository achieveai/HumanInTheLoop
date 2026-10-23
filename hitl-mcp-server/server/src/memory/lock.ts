import { createHash } from 'crypto';
import { existsSync, mkdirSync, rmSync } from 'fs';
import net from 'net';
import path from 'path';
import { memoryRoot } from './sync.js';

/**
 * The one-writer-per-machine lock, as a named pipe (a Unix socket elsewhere).
 *
 * Only one process can listen on it, and the OS frees it when that process
 * exits or crashes, so it can never be left stale. The holder runs every sync;
 * anyone else connects and asks it to sync one repo now.
 */
export function lockAddress(): string {
  const tag = createHash('sha256').update(path.resolve(memoryRoot()).toLowerCase()).digest('hex').slice(0, 12);
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\hitl-memory-${tag}`
    : path.join(memoryRoot(), '.sync', `lock-${tag}.sock`);
}

export interface SyncRequest {
  op: 'sync';
  key: string;
  replica?: { path: string; host: 'claude' | 'codex' | 'copilot' };
}

export type Handler = (request: SyncRequest) => Promise<unknown> | unknown;

/** Become the lock holder, or resolve null when another process already is. */
export async function tryHoldLock(handle: Handler): Promise<net.Server | null> {
  const address = lockAddress();
  if (process.platform !== 'win32') mkdirSync(path.dirname(address), { recursive: true });

  const server = net.createServer(socket => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', async chunk => {
      buffer += chunk;
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      try {
        const result = await handle(JSON.parse(buffer.slice(0, end)) as SyncRequest);
        socket.end(`${JSON.stringify({ ok: true, result })}\n`);
      } catch (err) {
        socket.end(`${JSON.stringify({ ok: false, error: (err as Error).message })}\n`);
      }
    });
    socket.on('error', () => {});
  });

  const listen = () => new Promise<boolean>(resolve => {
    server.once('error', () => resolve(false));
    server.listen(address, () => resolve(true));
  });
  if (await listen()) return server;

  // A Unix socket file outlives a crashed holder; if nobody answers, clear it.
  if (process.platform !== 'win32' && existsSync(address) && !(await answers(address))) {
    rmSync(address, { force: true });
    if (await listen()) return server;
  }
  return null;
}

function answers(address: string): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.connect(address, () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => resolve(false));
  });
}

/** Ask the lock holder to run `request`. Rejects when there is no holder or it times out. */
export function askHolder(request: SyncRequest, timeoutMs = 10_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(lockAddress());
    let reply = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('memory sync holder did not answer in time'));
    }, timeoutMs);
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on('data', chunk => (reply += chunk));
    socket.on('end', () => {
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(reply) as { ok: boolean; result?: unknown; error?: string };
        if (parsed.ok) resolve(parsed.result);
        else reject(new Error(parsed.error));
      } catch (err) {
        reject(err as Error);
      }
    });
    socket.on('error', err => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Run `request` under the lock: hold it briefly when it is free, or hand the
 * request to whoever holds it.
 */
export async function runLocked(request: SyncRequest, handle: Handler, timeoutMs?: number): Promise<unknown> {
  const deadline = timeoutMs === undefined ? Infinity : Date.now() + timeoutMs;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (Date.now() >= deadline) break;
    const server = await tryHoldLock(handle);
    if (server) {
      try {
        return await handle(request);
      } finally {
        await new Promise(resolve => server.close(resolve));
      }
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    try {
      return await askHolder(request, Math.min(10_000, remaining));
    } catch {
      // The holder exited between our two tries; take another turn.
    }
  }
  throw new Error('could not reach the memory sync lock');
}
