import { randomUUID } from 'node:crypto';

export const t3Error = (code, ambiguous = false) => Object.assign(new Error(code), { code, ambiguous });
const maintenanceCodes = new Set(['maintenance-unavailable', 'maintenance-stale-target', 'maintenance-direction-changed',
  'maintenance-thread-unavailable', 'maintenance-busy', 'maintenance-unsupported', 'maintenance-invalid-continuation',
  'maintenance-ambiguous-delivery', 'maintenance-invalid-input']);

function rejection(cause, mutation) {
  const pending = [cause];
  while (pending.length) {
    const item = pending.pop();
    if (!item || typeof item !== 'object') continue;
    if (maintenanceCodes.has(item.code)) return t3Error(item.code, item.code === 'maintenance-ambiguous-delivery');
    if (item._tag === 'EnvironmentAuthorizationError') return t3Error('t3-authorization-failed');
    for (const key of ['cause', 'error', 'reason']) if (item[key]) pending.push(item[key]);
    if (Array.isArray(item.reasons)) pending.push(...item.reasons);
  }
  return t3Error('t3-rpc-rejected', mutation);
}

/** Protocol-2 RPC connection. Native errors and credential-bearing URLs never enter errors. */
export class T3Rpc {
  #token;
  constructor({ origin, token, fetch = globalThis.fetch, WebSocket = globalThis.WebSocket }) {
    let url;
    try { url = new URL(origin); } catch { throw t3Error('t3-invalid-origin'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw t3Error('t3-invalid-origin');
    this.origin = url.origin; this.#token = token; this.fetch = fetch; this.WebSocket = WebSocket;
    this.pending = new Map(); this.closed = false;
  }

  async credential() {
    const token = typeof this.#token === 'function' ? await this.#token() : this.#token;
    if (typeof token !== 'string' || !token) throw t3Error('t3-missing-token');
    return token;
  }

  connect() {
    if (this.closed) return Promise.reject(t3Error('t3-rpc-closed'));
    if (this.socket?.readyState === 1) return Promise.resolve();
    if (this.connecting) return this.connecting;
    this.connecting = this.open().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  async open() {
    try {
      const token = await this.credential();
      const response = await this.fetch(new URL('/api/auth/websocket-ticket/rpc', this.origin), {
        method: 'POST', headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) throw t3Error('t3-authentication-failed');
      const { ticket } = await response.json();
      if (!ticket) throw t3Error('t3-invalid-ticket');
      if (this.closed) throw t3Error('t3-rpc-closed');
      const url = new URL('/ws', this.origin); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      url.searchParams.set('orchestrationProtocol', '2'); url.searchParams.set('wsTicket', ticket);
      await this.listen(url);
    } catch (error) { throw t3Error(error.code?.startsWith('t3-') ? error.code : 't3-connection-failed'); }
  }

  listen(url) {
    return new Promise((resolve, reject) => {
      const socket = this.socket = new this.WebSocket(url.href);
      const ended = () => { reject(t3Error('t3-disconnected')); this.fail(socket); };
      socket.addEventListener('open', () => { if (this.closed) { socket.close(); ended(); } else resolve(); });
      socket.addEventListener('error', ended); socket.addEventListener('close', ended);
      socket.addEventListener('message', event => {
        if (this.socket !== socket) return;
        try { for (const line of String(event.data).split('\n').filter(Boolean)) this.handle(JSON.parse(line), socket); }
        catch { this.fail(socket, 't3-invalid-frame'); socket.close(); }
      });
    });
  }

  fail(socket, code = 't3-disconnected') {
    if (this.socket !== socket) return;
    this.socket = null;
    for (const request of this.pending.values()) request.reject(t3Error(code, request.mutation && request.sent));
    this.pending.clear();
  }

  handle(message, socket) {
    if (message._tag === 'Ping') { socket.send(JSON.stringify({ _tag: 'Pong' })); return; }
    if (message._tag === 'Defect') { this.fail(socket, 't3-protocol-failed'); socket.close(); return; }
    const request = this.pending.get(String(message.requestId));
    if (!request) return;
    if (message._tag !== 'Exit') throw t3Error('t3-invalid-frame');
    this.pending.delete(String(message.requestId));
    if (message.exit?._tag === 'Success') request.resolve(message.exit.value);
    else request.reject(rejection(message.exit?.cause, request.mutation));
  }

  async request(tag, payload, { mutation = false, isCurrent } = {}) {
    await this.connect();
    if (isCurrent && !isCurrent()) throw t3Error('stale-action');
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const request = { resolve, reject, mutation, sent: false }; this.pending.set(id, request);
      try {
        request.sent = true;
        this.socket.send(JSON.stringify({ _tag: 'Request', id, tag, payload, headers: [] }));
      } catch { this.pending.delete(id); reject(t3Error('t3-send-failed', mutation)); }
    });
  }

  async history(threadId, cursor) {
    const url = new URL(`/api/orchestration/threads/${encodeURIComponent(threadId)}/history`, this.origin);
    url.searchParams.set('cursor', cursor);
    const token = await this.credential();
    try {
      const response = await this.fetch(url, { headers: { Authorization: `Bearer ${token}`, 'x-t3-orchestration-protocol': '2' } });
      if (!response.ok) throw t3Error('t3-history-unavailable');
      return await response.json();
    } catch { throw t3Error('t3-history-unavailable'); }
  }

  close() {
    this.closed = true;
    const socket = this.socket;
    this.fail(socket, 't3-rpc-closed'); socket?.close();
  }
}
