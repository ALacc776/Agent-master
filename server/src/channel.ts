import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

// Async iterable the SDK reads user turns from; lets us push follow-up messages mid-run.
export class InputChannel implements AsyncIterable<SDKUserMessage> {
  private buf: SDKUserMessage[] = [];
  private waiter: ((r: IteratorResult<SDKUserMessage>) => void) | null = null;
  closed = false;

  push(text: string) {
    if (this.closed) return false;
    const msg: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      origin: { kind: 'human' },
    };
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w({ value: msg, done: false });
    } else this.buf.push(msg);
    return true;
  }
  close() {
    this.closed = true;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w({ value: undefined as any, done: true });
    }
  }
  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const m = this.buf.shift();
        if (m) return Promise.resolve({ value: m, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as any, done: true });
        return new Promise((resolve) => (this.waiter = resolve));
      },
    };
  }
}
