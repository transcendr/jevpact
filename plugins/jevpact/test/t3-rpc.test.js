import test from 'node:test';
import assert from 'node:assert/strict';
import { T3Rpc } from '../src/t3-rpc.js';

const turn = () => new Promise(resolve => setImmediate(resolve));
function fixture(t) {
  const sockets = []; const requests = [];
  class Socket extends EventTarget {
    constructor(url) { super(); this.url = url; this.readyState = 0; sockets.push(this);
      queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event('open')); }); }
    send(value) { requests.push(JSON.parse(value)); }
    receive(value) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) })); }
    close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
  }
  const rpc = new T3Rpc({ origin: 'http://localhost:1234', token: 'private-credential', WebSocket: Socket,
    fetch: async (_url, options) => { assert.equal(options.headers.Authorization, 'Bearer private-credential');
      return { ok: true, json: async () => ({ ticket: 'private-ticket' }) }; } });
  t.after(() => rpc.close());
  const reply = (exit, index = requests.length - 1) => sockets.at(-1).receive({ _tag: 'Exit', requestId: requests[index].id, exit });
  return { rpc, sockets, requests, reply };
}

test('authenticated protocol-2 requests correlate receipts without exposing credentials in payloads', async t => {
  const f = fixture(t); const result = f.rpc.request('server.getConfig', {}); await turn();
  const url = new URL(f.sockets[0].url); assert.equal(url.searchParams.get('orchestrationProtocol'), '2');
  assert.equal(url.searchParams.get('wsTicket'), 'private-ticket');
  assert.equal(JSON.stringify(f.requests).includes('private-'), false);
  f.reply({ _tag: 'Success', value: { guardedMaintenance: 1 } }); assert.deepEqual(await result, { guardedMaintenance: 1 });
});

test('auth failure is closed, sanitized, and sends no command', async () => {
  const rpc = new T3Rpc({ origin: 'http://localhost:1234', token: 'private-credential',
    fetch: async () => { throw Error('private-credential raw body'); } });
  await assert.rejects(rpc.request('orchestration.dispatchCommand', {}, { mutation: true }), error =>
    error.code === 't3-connection-failed' && !error.message.includes('private-') && error.ambiguous === false);
  rpc.close();
});

test('socket disconnect after mutation send is ambiguous; reconnection uses a fresh ticket', async t => {
  const f = fixture(t); const action = f.rpc.request('orchestration.dispatchCommand', { commandId: 'fixed' }, { mutation: true });
  await turn(); f.sockets[0].close(); await assert.rejects(action, { code: 't3-disconnected', ambiguous: true });
  const next = f.rpc.request('server.getConfig', {}); await turn(); assert.equal(f.sockets.length, 2);
  f.reply({ _tag: 'Success', value: {} }); await next;
});

test('known rejection codes are definite and arbitrary server bodies remain sanitized', async t => {
  const f = fixture(t);
  const rejected = f.rpc.request('orchestration.dispatchCommand', {}, { mutation: true }); await turn();
  f.reply({ _tag: 'Failure', cause: { reasons: [{ _tag: 'Fail', error: { code: 'maintenance-stale-target', message: 'private-credential' } }] } });
  await assert.rejects(rejected, { code: 'maintenance-stale-target', ambiguous: false });
  const unknown = f.rpc.request('orchestration.dispatchCommand', {}, { mutation: true }); await turn();
  f.reply({ _tag: 'Failure', cause: { reasons: [{ error: { message: 'private-credential' } }] } });
  await assert.rejects(unknown, error => error.code === 't3-rpc-rejected' && error.ambiguous && !error.message.includes('private-'));
});

test('stale request is rejected after authentication and before any socket write', async t => {
  const f = fixture(t);
  await assert.rejects(f.rpc.request('orchestration.dispatchCommand', {}, { mutation: true, isCurrent: () => false }), { code: 'stale-action' });
  assert.equal(f.requests.length, 0);
});

test('server ambiguity code keeps the uncertain-delivery flag', async t => {
  const f = fixture(t); const action = f.rpc.request('orchestration.dispatchCommand', {}, { mutation: true }); await turn();
  f.reply({ _tag: 'Failure', cause: { reasons: [{ error: { code: 'maintenance-ambiguous-delivery' } }] } });
  await assert.rejects(action, { code: 'maintenance-ambiguous-delivery', ambiguous: true });
});

test('shell and thread streams share one authenticated socket and unsubscribe separately', async t => {
  const f=fixture(t);const frames=[];const shell=f.rpc.subscribe('orchestration.subscribeShell',{}, {onFrame:x=>frames.push(x),onDisconnect(){}});await turn();
  const shellRequest=f.requests[0];f.sockets[0].receive({_tag:'Chunk',requestId:shellRequest.id,values:[{kind:'synchronized'}]});const unsubscribe=await shell;
  const thread=f.rpc.subscribe('orchestration.subscribeThread',{threadId:'one'}, {onFrame:x=>frames.push(x),onDisconnect(){}});await turn();
  const threadRequest=f.requests.find(r=>r.tag==='orchestration.subscribeThread');f.sockets[0].receive({_tag:'Chunk',requestId:threadRequest.id,values:[{kind:'synchronized'}]});await thread;
  assert.equal(f.sockets.length,1);unsubscribe();assert.equal(f.rpc.streams.size,1);assert(f.requests.some(r=>r._tag==='Interrupt'&&r.requestId===shellRequest.id));
});


test('actual Effect RPC failure arrays preserve definite guard and authorization rejections',async t=>{
 const f=fixture(t);const result=f.rpc.request('orchestration.dispatchCommand',{}, {mutation:true});await turn();
 f.reply({_tag:'Failure',cause:[{_tag:'Fail',error:{_tag:'OrchestrationV2DispatchCommandError',code:'maintenance-busy'}}]});
 await assert.rejects(result,{code:'maintenance-busy',ambiguous:false});
});
