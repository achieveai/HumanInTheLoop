import type { QuestionMessage, AnswerMessage, HitlMessage, HitlConfig } from '@hitl/shared';

/**
 * Transport layer for communicating with ntfy.sh.
 *
 * - Publishes question messages (HTTP POST)
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
   * Publish a question message to the ntfy topic.
   */
  async publishQuestion(msg: QuestionMessage): Promise<void> {
    const response = await fetch(this.topicUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(msg),
    });

    if (!response.ok) {
      throw new Error(`Failed to publish question: ${response.status} ${response.statusText}`);
    }
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
   * Publish an answer message to the ntfy topic (used by client app, exposed here for testing).
   */
  async publishAnswer(msg: AnswerMessage): Promise<void> {
    const response = await fetch(this.topicUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(msg),
    });

    if (!response.ok) {
      throw new Error(`Failed to publish answer: ${response.status} ${response.statusText}`);
    }
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
                const hitlMsg = JSON.parse(ntfyEvent.message) as HitlMessage;
                if (hitlMsg.type === 'question' || hitlMsg.type === 'answer') {
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
