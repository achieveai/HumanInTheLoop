import type net from 'net';
import { handleSync } from './hook.js';
import { tryHoldLock } from './lock.js';
import { syncAll } from './sync.js';

const TICK_MS = 10_000;
const RETRY_LOCK_MS = 30_000;

export interface MemorySyncer {
  /** Run a last pass if this process holds the lock, then let it go. */
  stop(): void;
}

/**
 * Keep this machine's memory replicas in step while this process runs.
 *
 * Every HITL MCP server calls this. The first to take the machine lock syncs
 * every known repo each tick; the rest retry the lock now and then, so one
 * takes over when the holder's session ends. Timers are unref'd: syncing never
 * keeps a finished server alive. `HITL_MEMORY_SYNC=0` turns it off.
 */
export function startMemorySyncer(log: (message: string) => void = console.error): MemorySyncer {
  if (process.env.HITL_MEMORY_SYNC === '0') return { stop() {} };
  let holder: net.Server | null = null;
  let stopped = false;

  const pass = () => {
    try {
      syncAll();
    } catch (err) {
      log(`memory sync pass failed: ${(err as Error).message}`);
    }
  };
  const tick = setInterval(() => {
    if (holder) pass();
  }, TICK_MS);
  tick.unref();

  const claim = async () => {
    if (holder || stopped) return;
    holder = await tryHoldLock(handleSync).catch(() => null);
    if (holder) {
      holder.unref();
      log('memory sync: this process holds the machine lock');
      pass();
    }
  };
  void claim();
  const retry = setInterval(() => void claim(), RETRY_LOCK_MS);
  retry.unref();

  return {
    stop() {
      stopped = true;
      clearInterval(tick);
      clearInterval(retry);
      if (holder) {
        pass();
        holder.close();
        holder = null;
      }
    },
  };
}
