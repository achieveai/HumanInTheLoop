import { randomUUID } from 'crypto';
import type net from 'net';
import { loadConfig } from '../config.js';
import type { HitlConfig } from '../types.js';
import { NtfyTransport } from '../ntfy-transport.js';
import { handleSync } from './hook.js';
import { tryHoldLock } from './lock.js';
import { NtfyMemoryWire } from './ntfy-wire.js';
import { RemoteSync } from './remote.js';
import { syncAll, syncKey } from './sync.js';

const TICK_MS = 10_000;
const RETRY_LOCK_MS = 30_000;
/** One notification per subject per hour at most. */
const NOTIFY_EVERY_MS = 3_600_000;

export interface MemorySyncer {
  /** Run a last pass if this process holds the lock, then let it go. */
  stop(): void;
}

/**
 * Keep this machine's memory replicas in step while this process runs.
 *
 * Every HITL MCP server calls this. The first to take the machine lock syncs
 * every known repo each tick, and keeps the shared folders in step with other
 * machines over the memory topic; the rest retry the lock now and then, so one
 * takes over when the holder's session ends. Timers are unref'd: syncing never
 * keeps a finished server alive. `HITL_MEMORY_SYNC=0` turns it all off.
 * Syncing with other machines is opt-in: `hitl memory remote on` (see remoteEnabled).
 */
export function startMemorySyncer(log: (message: string) => void = console.error): MemorySyncer {
  if (process.env.HITL_MEMORY_SYNC === '0') return { stop() {} };
  let holder: net.Server | null = null;
  let remote: RemoteSync | null = null;
  let stopped = false;
  const notify = notifier(log);

  const pass = () => {
    try {
      for (const { key, result } of syncAll()) {
        for (const file of result.clashed) {
          notify(`clash:${key}/${file}`, 'Memory kept both versions',
            `Two sessions changed the same lines of \`${file}\` in ${key}. Both versions are in the file; tidy it when convenient.`);
        }
      }
    } catch (err) {
      log(`memory sync pass failed: ${(err as Error).message}`);
    }
    remote?.tick().catch(err => log(`memory sync: sending to other machines failed: ${(err as Error).message}`));
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
      remote = startRemote(log, notify);
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
        remote?.stop();
        holder.close();
        holder = null;
      }
    },
  };
}

/**
 * Whether memory goes to other machines. Off unless `hitl memory remote on`
 * set `memoryRemote` in the HITL config: it sends every synced repo's memory,
 * encrypted, through the ntfy server. `HITL_MEMORY_REMOTE` (0 or 1) overrides.
 */
export function remoteEnabled(config: HitlConfig): boolean {
  if (process.env.HITL_MEMORY_REMOTE === '0') return false;
  if (process.env.HITL_MEMORY_REMOTE === '1') return true;
  return config.memoryRemote === true;
}

/** Sync with other machines, when the HITL config allows it. */
function startRemote(log: (message: string) => void, notify: Notify): RemoteSync | null {
  try {
    const config = loadConfig();
    if (!remoteEnabled(config)) {
      log('memory sync: memory stays on this machine; `hitl memory remote on` syncs it with your other machines');
      return null;
    }
    if (!config.encryptionKey) {
      log('memory sync: no encryptionKey in the HITL config, so memory stays on this machine');
      return null;
    }
    const remote = new RemoteSync({
      wire: new NtfyMemoryWire(config, log),
      onChanged: keys => keys.forEach(key => syncKey(key)),
      notify,
      log,
    });
    remote.start();
    log(`memory sync: syncing with other machines as ${remote.device}`);
    return remote;
  } catch (err) {
    log(`memory sync: not syncing with other machines: ${(err as Error).message}`);
    return null;
  }
}

type Notify = (tag: string, title: string, body: string) => void;

/**
 * Send a HITL notification, at most once per tag per hour. Failures are logged,
 * never thrown. Without an encryptionKey the notice is only logged: it names a
 * repo and a file, and would otherwise go out in plain text.
 */
function notifier(log: (message: string) => void): Notify {
  const last = new Map<string, number>();
  let transport: NtfyTransport | null | undefined;
  return (tag, title, body) => {
    const now = Date.now();
    if (now - (last.get(tag) ?? 0) < NOTIFY_EVERY_MS) return;
    last.set(tag, now);
    try {
      if (transport === undefined) {
        const config = loadConfig();
        transport = config.encryptionKey ? new NtfyTransport(config) : null;
      }
      if (!transport) {
        log(`memory sync: ${title}: ${body}`);
        return;
      }
      transport
        .publish({ type: 'notification', messageId: randomUUID(), timestamp: now, title, body, context: 'HITL memory sync' })
        .catch(err => log(`memory sync: notify failed: ${(err as Error).message}`));
    } catch (err) {
      log(`memory sync: notify failed: ${(err as Error).message}`);
    }
  };
}
