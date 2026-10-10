import { gunzipSync, gzipSync } from 'zlib';
import { CHUNK_THRESHOLD_BYTES } from '../chunking.js';
import { decrypt, encrypt, isEncryptedEnvelope } from '../crypto.js';
import {
  AttachmentExpiredError, NtfyPublishError, NtfySubscribeError, NtfyTransport, classifyNtfyError, parseAttachment,
} from '../ntfy-transport.js';
import type { HitlConfig } from '../types.js';
import { MessageLostError, type Payload, type Wire, type WireEvent } from './remote.js';

/** What the decrypted ntfy message holds: the gzipped payload inline, or a note that it is attached. */
interface Envelope {
  type: 'memory';
  z?: string;
  attached?: boolean;
}

/** The memory topic for a HITL config: its own topic, so Inbox clients and phones never see it. */
export const memoryTopic = (config: HitlConfig) => `${config.topicId}-memory`;

/**
 * Memory payloads over ntfy, always encrypted with the HITL key.
 *
 * A payload is gzipped, then encrypted. Small ones ride inline; larger ones go
 * as one attachment whose message only says so. ntfy keeps attachments 3 h,
 * so a machine that catches up later fails to load one and asks for a snapshot.
 */
export class NtfyMemoryWire implements Wire {
  private readonly transport: NtfyTransport;
  private readonly topicUrl: string;
  private readonly key: string;
  private warnedKey = false;

  constructor(config: HitlConfig, private readonly log: (message: string) => void = console.error) {
    if (!config.encryptionKey) throw new Error('memory sync between machines needs an encryptionKey in the HITL config');
    this.key = config.encryptionKey;
    this.transport = new NtfyTransport({ ...config, topicId: memoryTopic(config) });
    this.topicUrl = `${config.ntfyUrl.replace(/\/+$/, '')}/${memoryTopic(config)}`;
  }

  async publish(payload: Payload): Promise<void> {
    const z = gzipSync(JSON.stringify(payload)).toString('base64');
    const inline = this.seal({ type: 'memory', z });
    if (Buffer.byteLength(inline, 'utf8') <= CHUNK_THRESHOLD_BYTES) {
      await this.transport.publishRaw(inline);
      return;
    }
    await this.transport.uploadAttachment(encrypt(z, this.key), this.seal({ type: 'memory', attached: true }));
  }

  async stream(since: number, onEvent: (event: WireEvent) => void, signal: AbortSignal): Promise<void> {
    const response = await fetch(`${this.topicUrl}/json?since=${Math.max(1, since)}`, {
      headers: { Accept: 'application/x-ndjson' },
      signal,
    });
    if (!response.ok) {
      const verdict = classifyNtfyError(response.status, await response.text().catch(() => ''));
      throw new NtfySubscribeError(`memory topic subscription failed: ${verdict.message}`, response.status, verdict.retryable, verdict.code);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body from ntfy');

    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const event = this.toEvent(line);
          if (event) onEvent(event);
        }
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      throw err;
    }
  }

  private toEvent(line: string): WireEvent | null {
    let raw: { id?: unknown; time?: unknown; event?: unknown; message?: unknown };
    try {
      raw = JSON.parse(line);
    } catch {
      return null;
    }
    if (typeof raw.time !== 'number') return null;
    const id = typeof raw.id === 'string' ? raw.id : '';
    if (raw.event === 'keepalive') return { id, time: raw.time };
    // Not `open`: its time is now, and the replay after it is older (see Wire.stream).
    if (raw.event !== 'message' || typeof raw.message !== 'string') return null;
    const message = raw.message;
    return { id, time: raw.time, load: () => this.load(message, raw) };
  }

  /**
   * The payload in one message, or null when it is not a memory message under
   * our key. Throws MessageLostError when it is ours but can never be read.
   */
  private async load(message: string, raw: unknown): Promise<Payload | null> {
    let envelope: Envelope;
    try {
      envelope = JSON.parse(decrypt(message, this.key)) as Envelope;
    } catch {
      this.warnIfOtherKey(message);
      return null;
    }
    if (envelope?.type !== 'memory') return null;
    let z = envelope.z;
    if (envelope.attached) {
      const attachment = parseAttachment(raw);
      if (!attachment) throw new MessageLostError('its attachment is missing');
      let sealed: string;
      try {
        sealed = await this.transport.downloadAttachment(attachment);
      } catch (err) {
        // Expired or refused for good; a network error or 5xx is worth trying again.
        const refused = err instanceof NtfyPublishError && err.status < 500 && err.status !== 429;
        if (err instanceof AttachmentExpiredError || refused) throw new MessageLostError((err as Error).message);
        throw err;
      }
      try {
        z = decrypt(sealed, this.key);
      } catch {
        throw new MessageLostError('its attachment did not decrypt');
      }
    }
    if (!z) return null;
    try {
      return JSON.parse(gunzipSync(Buffer.from(z, 'base64')).toString('utf8')) as Payload;
    } catch {
      throw new MessageLostError('its payload is corrupt');
    }
  }

  /** An encrypted message we cannot open usually means another machine has a different key. Say so once. */
  private warnIfOtherKey(message: string): void {
    if (this.warnedKey) return;
    try {
      if (!isEncryptedEnvelope(JSON.parse(message))) return;
    } catch {
      return;
    }
    this.warnedKey = true;
    this.log("memory: a message on the memory topic did not decrypt with this machine's key; "
      + 'check that encryptionKey is the same in the HITL config on every machine');
  }

  private seal(envelope: Envelope): string {
    return encrypt(JSON.stringify(envelope), this.key);
  }
}
