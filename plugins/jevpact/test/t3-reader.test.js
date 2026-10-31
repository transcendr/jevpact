import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { T3Reader, createT3ReaderFactory } from '../src/t3-reader.js';
import { T3Subscription } from '../src/t3-subscription.js';

const threadId = 'mcp:launch:disposable-test';
const environmentId = 'test-environment';
const stamp = '2026-10-31T12:00:00.000Z';
function fixture(driver) {
  let deliver;
  let sequence = 10;
  const provider = { id: 'provider-thread', driver, providerInstanceId: `${driver}-instance`,
    providerSessionId: 'provider-runtime-session', nativeThreadRef: { nativeId: 'native-session' },
    ownerNodeId: null, appThreadId: threadId, contextUsage: null, updatedAt: stamp, createdAt: stamp };
  const projection = { thread: { id: threadId, activeProviderThreadId: provider.id, defaultProvider: driver },
    runs: [], messages: [], turnItems: [], providerThreads: [provider], providerTurns: [], subagents: [] };
  const subscription = { closed: false,
    async open({ onFrame }) { deliver = onFrame; onFrame({ kind: 'snapshot', snapshotSequence: sequence, projection }); onFrame({ kind: 'synchronized' }); },
    close() { this.closed = true; } };
  const reader = new T3Reader({ threadId, environmentId, subscription });
  const event = (type, payload, overrides = {}) => deliver({ kind: 'event', sequence: ++sequence,
    event: { type, threadId, payload, ...overrides } });
  const message = (id, role, text, extra = {}) => ({ id, threadId, role, text, runId: 'work',
    createdBy: role === 'user' ? 'user' : 'agent', createdAt: stamp, updatedAt: stamp, streaming: false, attachments: [], ...extra });
  const run = (id = 'work', status = 'running', ordinal = 1) => ({ id, threadId, ordinal, status,
    providerThreadId: provider.id, userMessageId: id + '-message' });
  const item = (id, type, extra = {}) => ({ id, type, threadId, runId: 'work', providerThreadId: provider.id,
    status: 'running', startedAt: stamp, updatedAt: stamp, ...extra });
  return { reader, subscription, event, message, run, item, provider, projection,
    frame: value => deliver(value), nextSequence: () => sequence + 1 };
}

for (const driver of ['codex', 'claudeAgent']) {
  test(`${driver}: snapshots preserve identities, human direction, tools, usage and compaction order`, async t => {
    const f = fixture(driver); const { reader, event, message, run, item } = f;
    t.after(() => reader.close());
    const changes = []; reader.on('change', s => changes.push(s));
    await reader.open();
    assert.equal(reader.snapshot().turnStatus, 'idle');
    event('message.updated', message('work-message', 'user', 'Inspect the current date.'));
    event('run.created', run());
    event('provider-turn.updated', { id: 'provider-turn', providerThreadId: 'provider-thread', ordinal: 1,
      nativeTurnRef: { nativeId: 'native-turn' }, status: 'running', tokenUsage: {
        inputTokens: 1000, usedTokens: 1010, maxTokens: 200000, updatedAt: stamp } });
    let s = reader.snapshot();
    assert.deepEqual([s.threadId, s.runId, s.providerThreadId, s.providerSessionId, s.nativeSessionId,
      s.providerTurnId, s.nativeTurnId], [threadId, 'work', 'provider-thread', 'provider-runtime-session',
      'native-session', 'provider-turn', 'native-turn']);
    assert.equal(s.provider, driver);
    assert.equal(s.turnStatus, 'active');
    assert.equal(s.inputTokens, 1000);
    assert.equal(s.contextUsedTokens, 1010);
    assert.equal(s.modelContextWindow, 200000);
    assert.equal(s.baselineInputTokens, 1000);
    assert.equal(s.requests, null);
    assert.equal(s.requestsSinceCompaction, null);
    assert.equal(s.requestCountSupported, false);
    const epoch = s.userEpoch;
    event('message.updated', message('agent-message', 'user', 'A child has finished.', { createdBy: 'agent', creationSource: 'mcp' }));
    assert.equal(reader.snapshot().userEpoch, epoch);
    assert.equal(reader.snapshot().latestUserDirection.text, 'Inspect the current date.');
    assert.equal(reader.snapshot().agentMessages.at(-1).text, 'A child has finished.');
    event('turn-item.updated', item('tool', 'command_execution', { input: 'date -u' }));
    assert.equal(reader.snapshot().toolCalls[0].resultObserved, false);
    event('turn-item.updated', item('tool', 'command_execution', { input: 'date -u', output: 'Sat Oct 31', status: 'completed' }));
    s = reader.snapshot();
    assert.equal(s.toolCalls[0].resultObserved, true);
    assert.equal(s.lastToolResult.text, 'Sat Oct 31');
    assert.equal(JSON.parse(s.packet).messages.length, 0, 'Tool output is excluded from the timing packet');
    event('message.updated', message('answer', 'assistant', 'The date is October 31.'));
    assert.equal(reader.snapshot().messages[0].phase, null, 'A non-streaming message does not prove run completion');
    event('provider-turn.updated', { id: 'provider-turn', providerThreadId: 'provider-thread', ordinal: 1,
      nativeTurnRef: { nativeId: 'native-turn' }, status: 'completed', tokenUsage: {
        inputTokens: 1250, usedTokens: 1260, maxTokens: 200000, updatedAt: '2026-10-31T12:00:01Z' } });
    assert.equal(reader.snapshot().recentGrowthTokens, 250);
    event('run.updated', run('work', 'completed'));
    assert.equal(reader.snapshot().turnStatus, 'idle');
    assert.equal(reader.snapshot().messages[0].phase, 'final');
    assert.equal(reader.snapshot().timingPacket.source, 't3-visible-source-linked-timing');
    event('message.updated', message('compact-message', 'user', '/compact', { runId: 'compact' }));
    assert.equal(reader.snapshot().userEpoch, epoch, 'Native maintenance is not a new assignment');
    event('run.created', run('compact', 'running', 2));
    event('turn-item.updated', item('compaction', 'compaction', { runId: 'compact', status: 'completed',
      completedAt: '2026-10-31T12:00:02Z' }));
    s = reader.snapshot();
    assert.equal(s.compactionGeneration, 1);
    assert.equal(s.turnStatus, 'active', 'Compaction item completion is not run completion');
    assert.equal(s.inputTokens, null, 'Pre-compaction usage is stale');
    assert.equal(s.baselineInputTokens, null);
    assert.equal(s.maintenanceRunId, 'compact');
    assert.equal(s.workRunId, 'work');
    event('turn-item.updated', item('compaction', 'compaction', { runId: 'compact', status: 'completed',
      completedAt: '2026-10-31T12:00:02Z' }));
    assert.equal(reader.snapshot().compactionGeneration, 1);
    event('run.updated', run('compact', 'completed', 2));
    assert.equal(reader.snapshot().turnStatus, 'idle');
    assert(changes.findIndex(s => s.compactionGeneration === 1 && s.turnStatus === 'active')
      < changes.findIndex(s => s.compactionGeneration === 1 && s.turnStatus === 'idle'));
    const copy = reader.snapshot(); copy.messages.length = 0;
    assert.equal(reader.snapshot().messages.length, 1, 'Snapshot mutation cannot change the reader');
  });
}

test('explicit stop survives an agent message and is cleared by a new human direction', async t => {
  const f = fixture('codex'); t.after(() => f.reader.close()); await f.reader.open();
  f.event('message.updated', f.message('first', 'user', 'Do the task.'));
  f.event('turn-item.updated', f.item('stop', 'run_interrupt_request', { status: 'completed', message: 'Stopped by user' }));
  assert.equal(f.reader.snapshot().userStopped, true);
  const epoch = f.reader.snapshot().userEpoch;
  f.event('message.updated', f.message('agent', 'user', 'Continue.', { createdBy: 'agent' }));
  assert.equal(f.reader.snapshot().userStopped, true);
  assert.equal(f.reader.snapshot().userEpoch, epoch);
  f.event('message.updated', f.message('second', 'user', 'Continue now.'));
  assert.equal(f.reader.snapshot().userStopped, false);
  assert.equal(f.reader.snapshot().userEpoch, epoch + 1);
});

test('older run completion and replayed sequence cannot overwrite a newer active run', async t => {
  const f = fixture('claudeAgent'); t.after(() => f.reader.close()); await f.reader.open();
  f.event('run.created', f.run('old', 'running', 1));
  f.event('run.created', f.run('new', 'running', 2));
  f.event('run.updated', f.run('old', 'completed', 1));
  assert.equal(f.reader.snapshot().runId, 'new');
  f.frame({ kind: 'event', sequence: 11, event: { type: 'run.updated', threadId, payload: f.run('new', 'completed', 2) } });
  assert.equal(f.reader.snapshot().turnStatus, 'active');
});

test('queued maintenance cannot hide completion of the preceding work run', async t => {
  const f = fixture('codex'); t.after(() => f.reader.close()); await f.reader.open();
  f.event('run.created', f.run('work', 'running', 1));
  f.event('run.created', f.run('compact', 'queued', 2));
  f.event('run.updated', f.run('work', 'completed', 1));
  assert.equal(f.reader.snapshot().runId, 'work');
  assert.equal(f.reader.snapshot().lastTurnStatus, 'completed');
  assert.equal(f.reader.snapshot().turnStatus, 'idle');
  f.event('run.updated', f.run('compact', 'starting', 2));
  assert.equal(f.reader.snapshot().runId, 'compact');
  assert.equal(f.reader.snapshot().turnStatus, 'active');
});

test('mismatched snapshots and event identities fail closed', async t => {
  for (const malformed of [
    { kind: 'snapshot', snapshotSequence: 20, projection: { thread: { id: 'another-thread' } } },
    { kind: 'event', sequence: 20, event: { threadId: 'another-thread', type: 'run.updated', payload: {} } },
    { kind: 'snapshot', snapshotSequence: 20, projection: { thread: { id: threadId },
      messages: [{ id: 'bad-message', threadId: 'another-thread' }] } },
    { kind: 'unknown-event', sequence: 20, eventType: 'future-control-event' },
  ]) {
    const f = fixture('codex'); t.after(() => f.reader.close()); await f.reader.open();
    f.frame(malformed);
    assert.equal(f.reader.snapshot().supported, false);
    assert.equal(f.reader.snapshot().turnStatus, 'unknown');
  }
});

test('a new snapshot replaces current records without double-counting compactions', async t => {
  const f = fixture('codex'); t.after(() => f.reader.close()); await f.reader.open();
  const projection = { ...f.projection, turnItems: [f.item('compact', 'compaction', { status: 'completed', completedAt: stamp })] };
  f.frame({ kind: 'snapshot', snapshotSequence: 20, projection });
  f.frame({ kind: 'snapshot', snapshotSequence: 21, projection });
  assert.equal(f.reader.snapshot().compactionGeneration, 1);
});

test('snapshot replacement cannot roll back direction epochs or forget an observed stop', async t => {
  const f = fixture('codex'); t.after(() => f.reader.close()); await f.reader.open();
  const first = f.message('request', 'user', 'First direction.');
  const edited = { ...first, text: 'Changed direction.' };
  f.event('message.updated', first);
  f.event('message.updated', edited);
  const epoch = f.reader.snapshot().userEpoch;
  f.frame({ kind: 'snapshot', snapshotSequence: 30, projection: { ...f.projection, messages: [edited] } });
  assert.equal(f.reader.snapshot().userEpoch, epoch);
  f.frame({ kind: 'event', sequence: 31, event: { threadId, type: 'turn-item.updated',
    payload: f.item('stop', 'run_interrupt_request') } });
  const stoppedEpoch = f.reader.snapshot().userEpoch;
  f.frame({ kind: 'snapshot', snapshotSequence: 40, projection: { ...f.projection, messages: [edited] } });
  assert.equal(f.reader.snapshot().userStopped, true);
  assert.equal(f.reader.snapshot().userEpoch, stoppedEpoch);
});

test('completed compaction updates do not discard subsequently observed usage', async t => {
  const f = fixture('claudeAgent'); t.after(() => f.reader.close()); await f.reader.open();
  f.event('turn-item.updated', f.item('compact', 'compaction', { status: 'completed', completedAt: stamp }));
  f.event('provider-thread.updated', { ...f.provider, contextUsage: { inputTokens: 200, usedTokens: 210, maxTokens: 1000 } });
  assert.equal(f.reader.snapshot().inputTokens, 200);
  f.event('turn-item.updated', f.item('compact', 'compaction', { status: 'completed', completedAt: stamp }));
  assert.equal(f.reader.snapshot().inputTokens, 200);
  assert.equal(f.reader.snapshot().baselineInputTokens, 200);
});

test('a truncated visible report cannot become complete timing evidence', async t => {
  const f = fixture('codex'); t.after(() => f.reader.close()); await f.reader.open();
  f.event('run.created', f.run());
  f.event('message.updated', f.message('request', 'user', 'Read the date.'));
  f.event('message.updated', f.message('answer', 'assistant', 'x'.repeat(7000)));
  f.event('run.updated', f.run('work', 'completed'));
  const s = f.reader.snapshot();
  assert.equal(s.omissions.chars, 1000);
  assert.equal(s.recentFinalReports[0].truncated, true);
  assert.equal(s.timingPacket, null);
});

class FakeSocket extends EventEmitter {
  constructor(url) { super(); this.url = url; this.sent = []; FakeSocket.current = this; queueMicrotask(() => this.emit('open')); }
  addEventListener(type, fn) { this.on(type, fn); }
  send(value) { this.sent.push(JSON.parse(value)); }
  close() { this.emit('close'); }
  receive(value) { this.emit('message', { data: JSON.stringify(value) }); }
}

test('authenticated subscription sends only subscribe, acknowledgement and heartbeat frames', async () => {
  const requests = [];
  const subscription = new T3Subscription({ origin: 'http://localhost:3773', token: 'test-secret', WebSocket: FakeSocket,
    fetch: async (url, options) => { requests.push({ url: url.href, options }); return { ok: true, json: async () => ({ ticket: 'one-use-test-ticket' }) }; } });
  const frames = [];
  const opened = subscription.open({ threadId, onFrame: f => frames.push(f), onDisconnect: () => {} });
  await new Promise(resolve => setImmediate(resolve));
  const socket = FakeSocket.current;
  assert.equal(requests[0].url, 'http://localhost:3773/api/auth/websocket-ticket/rpc');
  assert.equal(requests[0].options.headers.Authorization, 'Bearer test-secret');
  assert.equal(new URL(socket.url).searchParams.get('wsTicket'), 'one-use-test-ticket');
  assert.equal(socket.sent[0].tag, 'orchestration.subscribeThread');
  assert.equal(socket.sent[0].payload.threadId, threadId);
  socket.receive({ _tag: 'Chunk', requestId: '1', values: [{ kind: 'synchronized' }] });
  await opened;
  socket.receive({ _tag: 'Ping' });
  assert.deepEqual(socket.sent.slice(1), [{ _tag: 'Ack', requestId: '1' }, { _tag: 'Pong' }]);
  subscription.close();
  assert.equal(frames.length, 1);
});

test('authentication and disconnect errors never expose tokens or arbitrary server text', async () => {
  assert.throws(() => new T3Subscription({ origin: 'test-secret' }), error => error.message === 't3-invalid-origin');
  const subscription = new T3Subscription({ origin: 'http://localhost:3773', token: 'test-secret',
    fetch: async () => { throw Error('test-secret private server body'); } });
  await assert.rejects(subscription.open({ threadId }), error => error.message === 't3-connection-failed');
  subscription.close();
  const f = fixture('codex');
  await f.reader.open();
  assert.equal('steer' in f.reader, false);
  assert.equal('compact' in f.reader, false);
  assert.equal('resume' in f.reader, false);
  await f.reader.close();
  assert.equal(f.subscription.closed, true);
});

test('reader factory scopes attachments by environment and retains no credentials in reader options', async () => {
  const f = fixture('codex');
  const factory = createT3ReaderFactory({ environmentId, subscription: f.subscription, token: 'test-secret', projectRoot: '/project' });
  assert.equal(factory.observationOnly, true);
  assert.equal(factory.validateThreadId(threadId), true);
  assert.equal(factory.validateThreadId(' '), false);
  assert.deepEqual(await factory.locate(threadId), { threadId, cwd: '/project' });
  const reader = factory.create({ threadId });
  await reader.open();
  assert.equal(JSON.stringify(reader.options).includes('test-secret'), false);
  await reader.close();
});
