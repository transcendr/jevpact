const failure = code => Object.assign(new Error(code), { code });

/** Read-only T3 protocol-2 subscription. Credentials and server errors stay out of diagnostics. */
export class T3Subscription {
  #token;

  constructor({ origin, token, fetch = globalThis.fetch, WebSocket = globalThis.WebSocket }) {
    let url;
    try { url = new URL(origin); } catch { throw failure('t3-invalid-origin'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw failure('t3-invalid-origin');
    this.origin = url.origin;
    this.#token = token;
    this.fetch = fetch;
    this.WebSocket = WebSocket;
    this.socket = null;
    this.closed = false;
  }

  async open({ threadId, afterSequence, onFrame, onDisconnect }) {
    if (this.closed) throw failure('t3-subscription-closed');
    this.abort = new AbortController();
    try {
      const token = typeof this.#token === 'function' ? await this.#token() : this.#token;
      if (typeof token !== 'string' || !token) throw failure('t3-missing-token');
      const response = await this.fetch(new URL('/api/auth/websocket-ticket/rpc', this.origin), {
        method: 'POST', headers: { Authorization: `Bearer ${token}` }, signal: this.abort.signal,
      });
      if (!response.ok) throw failure('t3-authentication-failed');
      const { ticket } = await response.json();
      if (typeof ticket !== 'string' || !ticket) throw failure('t3-invalid-ticket');
      if (this.closed) throw failure('t3-subscription-closed');
      const url = new URL('/ws', this.origin);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      url.searchParams.set('orchestrationProtocol', '2');
      url.searchParams.set('wsTicket', ticket);
      await this.listen(url, { threadId, afterSequence, onFrame, onDisconnect });
    } catch (error) {
      this.socket?.close();
      throw failure(error.code?.startsWith('t3-') ? error.code : 't3-connection-failed');
    }
  }

  listen(url, { threadId, afterSequence, onFrame, onDisconnect }) {
    return new Promise((resolve, reject) => {
      const socket = this.socket = new this.WebSocket(url.href);
      let ready = false;
      let ended = false;
      const end = code => {
        if (ended) return;
        ended = true;
        const error = failure(code);
        if (!ready) reject(error);
        if (!this.closed) onDisconnect(error);
      };
      this.rejectOpening = () => end('t3-subscription-closed');
      socket.addEventListener('open', () => {
        if (this.closed) { socket.close(); return; }
        socket.send(JSON.stringify({ _tag: 'Request', id: '1', tag: 'orchestration.subscribeThread',
          payload: { threadId, ...(afterSequence == null ? {} : { afterSequence }), requestCompletionMarker: true }, headers: [] }));
      });
      socket.addEventListener('message', event => {
        if (this.closed || ended) return;
        try {
          this.receive(event.data, { socket, onFrame,
            onSynchronized: () => { if (!ready) { ready = true; resolve(); } } });
        } catch { end('t3-invalid-frame'); socket.close(); }
      });
      socket.addEventListener('error', () => end('t3-connection-failed'));
      socket.addEventListener('close', () => end('t3-disconnected'));
    });
  }

  receive(data, handlers) {
    for (const line of String(data).split('\n').filter(Boolean)) this.handle(JSON.parse(line), handlers);
  }

  handle(message, { socket, onFrame, onSynchronized }) {
    if (message._tag === 'Ping') { socket.send(JSON.stringify({ _tag: 'Pong' })); return; }
    if (message._tag === 'Defect') throw failure('t3-protocol-failed');
    if (String(message.requestId) !== '1') return;
    if (message._tag === 'Exit') throw failure('t3-subscription-ended');
    if (message._tag !== 'Chunk' || !Array.isArray(message.values)) throw failure('t3-invalid-frame');
    for (const frame of message.values) {
      onFrame(frame);
      if (frame.kind === 'synchronized') onSynchronized();
    }
    socket.send(JSON.stringify({ _tag: 'Ack', requestId: '1' }));
  }

  close() {
    this.closed = true;
    this.abort?.abort();
    this.rejectOpening?.();
    this.socket?.close();
    this.socket = null;
  }
}
