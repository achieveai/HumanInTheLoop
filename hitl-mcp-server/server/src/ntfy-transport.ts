import type { QuestionMessage, AnswerMessage, HitlMessage, HitlConfig } from './types.js';
import { encrypt, decrypt, isEncryptedEnvelope } from './crypto.js';
import { shouldChunk, splitIntoChunks } from './chunking.js';

/**
 * Transport layer for communicating with ntfy.sh.
 *
 * - Publishes messages (HTTP POST)
 * - Subscribes for answer messages (SSE stream)
 */
export class NtfyTransport {
  private config: HitlConfig;
  private abortController: AbortController | null = null;

  constructor(config: HitlConfig) {
    this.config = config;
  }

  /** Full URL for the ntfy topic. */
  private get topicUrl(): string {
    const base = this.config.ntfyUrl.replace(/\/+$/, '');
    return `${base}/${this.config.topicId}`;
  }

  /**
   * Publish any HITL message to the ntfy topic.
   * If an encryption key is configured, the message payload is encrypted.
   */
  async publish(msg: HitlMessage): Promise<void> {
    let body: string;
    if (this.config.encryptionKey) {
      body = encrypt(JSON.stringify(msg), this.config.encryptionKey);
    } else {
      body = JSON.stringify(msg);
    }

    if (!shouldChunk(body)) {
      await this.publishRaw(body);
      return;
    }

    for (const chunk of splitIntoChunks(body, msg.messageId)) {
      await this.publishRaw(JSON.stringify(chunk));
    }
  }

  /** POST a single raw body string to the ntfy topic. */
  private async publishRaw(body: string): Promise<void> {
    const response = await fetch(this.topicUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });

    if (!response.ok) {
      throw new Error(`Failed to publish message: ${response.status} ${response.statusText}`);
    }
  }

  /** @deprecated Use publish() instead */
  async publishQuestion(msg: QuestionMessage): Promise<void> {
    return this.publish(msg);
  }

  /** @deprecated Use publish() instead */
  async publishAnswer(msg: AnswerMessage): Promise<void> {
    return this.publish(msg);
  }

  /**
   * Subscribe and wait for an answer to a specific question.
   * Opens an SSE connection and filters for answer messages matching questionId.
   *
   * @param questionId - The messageId of the question to wait for
   * @param timeout - Timeout in ms (0 = no timeout)
   * @returns The answer message
   */
  async waitForAnswer(questionId: string, timeout?: number): Promise<AnswerMessage> {
    return new Promise<AnswerMessage>((resolve, reject) => {
      this.abortController = new AbortController();
      const { signal } = this.abortController;

      let timer: NodeJS.Timeout | undefined;
      if (timeout && timeout > 0) {
        timer = setTimeout(() => {
          this.abortController?.abort();
          reject(new Error('Dialog timeout'));
        }, timeout);
      }

      const cleanup = () => {
        if (timer) clearTimeout(timer);
      };

      // Use ntfy's JSON stream endpoint — since=<now_unix> to only get future messages
      const sinceTs = Math.floor(Date.now() / 1000);
      const sseUrl = `${this.topicUrl}/json?since=${sinceTs}`;

      this.startSSEListener(sseUrl, signal, (msg: HitlMessage) => {
        if (msg.type === 'answer' && msg.questionId === questionId) {
          cleanup();
          resolve(msg as AnswerMessage);
        }
      }).catch((err) => {
        cleanup();
        if (!signal.aborted) {
          reject(err);
        }
      });

      signal.addEventListener('abort', () => {
        cleanup();
      });
    });
  }

  /**
   * Open a streaming connection to ntfy and invoke the callback for each parsed HITL message.
   * Uses fetch streaming (works in Node 18+).
   */
  private async startSSEListener(
    url: string,
    signal: AbortSignal,
    onMessage: (msg: HitlMessage) => void
  ): Promise<void> {
    const response = await fetch(url, {
      headers: { Accept: 'application/x-ndjson' },
      signal,
    });

    if (!response.ok) {
      throw new Error(`ntfy subscription failed: ${response.status} ${response.statusText}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body from ntfy');

    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          try {
            const ntfyEvent = JSON.parse(trimmed);
            // ntfy wraps messages — the actual payload is in the 'message' field
            if (ntfyEvent.message) {
              try {
                const parsed = JSON.parse(ntfyEvent.message);
                let hitlMsg: HitlMessage;

                if (isEncryptedEnvelope(parsed)) {
                  if (!this.config.encryptionKey) {
                    console.error('Received encrypted message but no encryptionKey configured — skipping');
                    continue;
                  }
                  try {
                    const decrypted = decrypt(ntfyEvent.message, this.config.encryptionKey);
                    hitlMsg = JSON.parse(decrypted) as HitlMessage;
                  } catch (decryptErr) {
                    console.error('Failed to decrypt message:', decryptErr);
                    continue;
                  }
                } else {
                  hitlMsg = parsed as HitlMessage;
                }

                if (hitlMsg.type) {
                  onMessage(hitlMsg);
                }
              } catch {
                // Not a valid HITL message, ignore
              }
            }
          } catch {
            // Not valid JSON, ignore
          }
        }
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') return;
      throw err;
    }
  }

  /**
   * Close any active subscriptions.
   */
  close(): void {
    this.abortController?.abort();
    this.abortController = null;
  }
}
