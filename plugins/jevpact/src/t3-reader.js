import { EventEmitter } from 'node:events';
import { T3Subscription } from './t3-subscription.js';
import { T3State } from './t3-state.js';

export const validT3ThreadId = id => typeof id === 'string' && id.length > 0 && id.trim() === id;

/** Observation only: this reader exposes no T3 command-dispatch operation. */
export class T3Reader extends EventEmitter {
  constructor({ threadId, environmentId, subscription, ...options }) {
    super();
    if (!validT3ThreadId(threadId) || !validT3ThreadId(environmentId)) throw new Error('Invalid T3 identity');
    this.options = { watch: true, maxChars: options.maxChars ?? 12000, maxMessages: options.maxMessages ?? 10 };
    this.state = new T3State({ threadId, environmentId, ...options });
    this.subscription = subscription ?? new T3Subscription(options);
    Object.defineProperty(this, 'observationOnly', { value: true });
    this.closed = false;
  }

  async open() {
    if (this.opening || this.state.thread) throw new Error('T3 reader is already open');
    this.opening = this.subscription.open({ threadId: this.state.threadId,
      onFrame: frame => {
        if (this.closed) return;
        this.state.accept(frame);
        this.emit('change', this.snapshot());
      },
      onDisconnect: error => {
        if (this.closed) return;
        this.state.disable(error.code);
        this.emit('change', this.snapshot());
      },
    });
    try { await this.opening; }
    catch (error) { this.state.disable(error.code ?? 't3-connection-failed'); throw error; }
    finally { this.opening = null; }
    return this.snapshot();
  }

  async refresh() { if (this.opening) await this.opening; return this.snapshot(); }
  snapshot() { return this.state.snapshot(); }
  async close() { this.closed = true; this.subscription.close(); }
}

export function createT3ReaderFactory(options) {
  return {
    observationOnly: true,
    namespace: `t3-${Buffer.from(options.environmentId).toString('base64url')}`,
    validateThreadId: validT3ThreadId,
    async locate(threadId) { return { threadId, cwd: options.projectRoot }; },
    create({ threadId }) { return new T3Reader({ ...options, threadId }); },
  };
}
