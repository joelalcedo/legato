import type { Usage } from './pricing.js';

/**
 * Incremental parser for the Messages API event stream. It only listens for
 * usage: `message_start` carries input and cache tokens, `message_delta`
 * carries the final output count. Bytes are forwarded to the client untouched.
 */
export class UsageTap {
  private buffer = '';
  private decoder = new TextDecoder();
  usage: Usage = {};
  responseModel?: string;
  stopReason?: string;

  push(chunk: Uint8Array): void {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    let idx: number;
    while ((idx = this.buffer.indexOf('\n\n')) !== -1) {
      const raw = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      this.handleEvent(raw);
    }
  }

  end(): void {
    if (this.buffer.trim()) this.handleEvent(this.buffer);
    this.buffer = '';
  }

  private handleEvent(raw: string): void {
    const data = raw
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trimStart())
      .join('\n');
    if (!data) return;
    let evt: any;
    try {
      evt = JSON.parse(data);
    } catch {
      return;
    }
    if (evt.type === 'message_start' && evt.message) {
      this.responseModel = evt.message.model;
      this.merge(evt.message.usage);
    } else if (evt.type === 'message_delta') {
      this.merge(evt.usage);
      if (evt.delta?.stop_reason) this.stopReason = evt.delta.stop_reason;
    }
  }

  private merge(u: Usage | undefined): void {
    if (!u) return;
    for (const [k, v] of Object.entries(u)) {
      if (typeof v === 'number') {
        const cur = (this.usage as Record<string, number>)[k] ?? 0;
        (this.usage as Record<string, number>)[k] = Math.max(cur, v);
      } else if (v && typeof v === 'object') {
        (this.usage as Record<string, unknown>)[k] = { ...((this.usage as any)[k] ?? {}), ...v };
      }
    }
  }
}

/** Usage from a non-streaming JSON response body. */
export function usageFromJson(text: string): { usage: Usage; model?: string } {
  try {
    const j = JSON.parse(text);
    return { usage: j.usage ?? {}, model: j.model };
  } catch {
    return { usage: {} };
  }
}
