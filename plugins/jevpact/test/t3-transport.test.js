import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { T3Transport } from '../src/t3-transport.js';
import { Controller } from '../src/controller.js';
import { decide, DEFAULT_POLICY } from '../src/policy.js';

const turn = () => new Promise(resolve => setImmediate(resolve));
class Reader extends EventEmitter {
  constructor() {
    super(); this.s = { supported: true, environmentId: 'env', sessionId: 'thread', threadId: 'thread',
      provider: 'codex', providerInstanceId: 'codex', providerThreadId: 'provider', providerSessionId: 'session',
      nativeSessionRef: { driver: 'codex', nativeId: 'native', strength: 'strong' }, eventSequence: 10,
      runId: 'work', turnId: 'work', workRunId: 'work', runAttemptId: 'attempt', turnStatus: 'active',
      userEpoch: 1, userStopped: false, compactionGeneration: 0, compactionItemId: null,
      historyComplete: true, revision: 1, messages: [], controlMessages: [], lastTurnStatus: 'running' };
  }
  snapshot() { return structuredClone(this.s); }
  async refresh() {}
  update(patch) { Object.assign(this.s, patch); this.s.revision++; this.s.eventSequence++; this.emit('change'); }
}
function fixture(t, { allowWrites = true, capability = 1 } = {}) {
  const reader = new Reader(); const commands = [];
  const rpc = { async request(tag, payload) {
    if (tag === 'server.getConfig') return { guardedMaintenance: capability, guardedMaintenanceActivePause: true, environment: { environmentId: 'env' } };
    commands.push(structuredClone(payload)); return { sequence: 12 };
  }, close() {} };
  const transport = new T3Transport({ rpc, environmentId: 'env' });
  transport.bindReader('thread', reader, { allowWrites });
  const deliver = (action, status = 'delivered') => {
    const command = commands.findLast(c => c.action === action);
    assert.ok(command, `No ${action} command`);
    const record = { id: command.messageId, runId: action === 'pause' ? 'work' : action,
      maintenance: { operationId: command.operationId, action, status, rejectionCode: 'maintenance-stale-target' } };
    reader.update({ controlMessages: [...reader.s.controlMessages.filter(m => m.id !== record.id), record] });
    return command;
  };
  t.after(() => transport.close()); return { reader, rpc, commands, transport, deliver };
}
function controller(t, f, answers = { deferral: { choice: 'no' }, continuation: { choice: 'yes' } }) {
  const c = new Controller({ reader: f.reader, codex: f.transport, config: { mode: 'observe' },
    evaluate: async () => ({ answers }), decide: () => { throw new Error('Automatic policy must stay off'); } });
  t.after(() => c.close()); return c;
}
function automaticController(t, f, answers = { deferral: { choice: 'no' }, continuation: { choice: 'yes' } }) {
  Object.assign(f.reader.s, { inputTokens: DEFAULT_POLICY.nativeLimitTokens,
    modelContextWindow: DEFAULT_POLICY.nativeLimitTokens + DEFAULT_POLICY.reserveTokens,
    baselineInputTokens: 0, recentGrowthTokens: 1000, requests: DEFAULT_POLICY.minRequests,
    requestsSinceCompaction: DEFAULT_POLICY.minRequests });
  const c = new Controller({ reader: f.reader, codex: f.transport, config: { mode: 'automatic' }, decide,
    evaluate: async () => ({ answers }) });
  t.after(() => c.close()); return c;
}
async function pause(t, answers, automatic = false) {
  const f = fixture(t); const c = automatic ? automaticController(t, f, answers) : controller(t, f, answers);
  let task;
  if (automatic) task = c.tick(); else await c.requestMaintenance();
  await turn(); f.deliver('pause'); await (task ?? c.explicitTask);
  f.reader.update({ turnStatus: 'idle', lastTurnStatus: 'completed', messages: [
    { role: 'assistant', turnId: 'work', sequence: 20, phase: 'final', text: 'Step one is verified. Next implement step two; no input is needed.' }] });
  return { ...f, c };
}

test('read-only default and old-server capability prevent every mutation', async t => {
  for (const options of [{ allowWrites: false }, { capability: undefined }]) {
    const f = fixture(t, options);
    if (options.capability === undefined && options.allowWrites !== false) f.rpc.request = async () => ({ environment: { environmentId: 'env' } });
    await assert.rejects(f.transport.beginOperation('thread'), { code: options.allowWrites === false ? 't3-writes-not-enabled' : 't3-guarded-maintenance-unavailable' });
    assert.equal(f.commands.length, 0);
  }
});

test('read-only attachment cannot enter automatic maintenance at the policy pressure ceiling', async t => {
  const f = fixture(t, { allowWrites: false }); const c = automaticController(t, f); await c.tick();
  assert.equal(f.commands.length, 0); assert.equal(c.pending, null);
});

for (const provider of ['codex', 'claudeAgent']) {
  test(`${provider}: real automatic policy opens a guarded operation and pauses the active run`, async t => {
    const f = fixture(t); f.reader.s.provider = provider; const c = automaticController(t, f);
    const tick = c.tick(); await turn(); assert.deepEqual(f.commands.map(c => c.action), ['pause']);
    assert.ok(c.pending.operationId); assert.equal(c.pending.explicit, undefined);
    f.deliver('pause'); await tick; assert.equal(c.state, 'awaiting-idle');
  });
  test(`${provider}: real automatic policy compacts an idle run through the guarded transport`, async t => {
    const f = fixture(t); f.reader.s.provider = provider; f.reader.s.turnStatus = 'idle';
    const c = automaticController(t, f); const tick = c.tick(); await turn();
    assert.deepEqual(f.commands.map(c => c.action), ['compact']); f.deliver('compact');
    f.reader.update({ runId: 'compact', turnId: 'compact', runAttemptId: 'compact-attempt',
      compactionGeneration: 1, compactionItemId: 'item', compactionRunStatus: 'completed',
      requestsSinceCompaction: 0, baselineInputTokens: null });
    await tick; assert.equal(c.log.filter(e => e.event === 'compacted').length, 1);
    assert.equal(f.commands.length, 1);
  });
}

test('accepted is not delivered; same action is exactly once and guards keep the original fence', async t => {
  const f = fixture(t); await f.transport.beginOperation('thread');
  let settled = false;
  const pause = f.transport.steer('thread', 'work', 'Pause.').then(v => { settled = true; return v; });
  const duplicate = f.transport.steer('thread', 'work', 'Pause.');
  await turn(); assert.equal(settled, false); assert.equal(f.commands.length, 1);
  f.deliver('pause', 'accepted'); await turn(); assert.equal(settled, false);
  f.deliver('pause'); assert.equal((await pause).completed, false); await duplicate;
  f.reader.update({ turnStatus: 'idle', runId: 'compact', turnId: 'compact', runAttemptId: 'compact-attempt', compactionItemId: 'item' });
  const resume = f.transport.resume('thread', 'Continue.'); await turn(); f.deliver('resume'); await resume;
  const [p, r] = f.commands;
  assert.equal(r.operationId, p.operationId); assert.equal(r.guard.observedSequence, 10);
  assert.equal(r.guard.workRunId, 'work'); assert.equal(r.guard.runId, 'compact'); assert.equal(r.guard.compactionItemId, 'item');
});

test('disconnect after send remains ambiguous and explicit reconciliation reuses every command ID', async t => {
  const f = fixture(t); const request = f.rpc.request.bind(f.rpc);
  f.rpc.request = async (tag, payload) => { const value = await request(tag, payload);
    if (tag !== 'server.getConfig') throw Object.assign(new Error('disconnected'), { code: 't3-disconnected', ambiguous: true }); return value; };
  await f.transport.beginOperation('thread');
  await assert.rejects(f.transport.steer('thread', 'work', 'Pause.'), { ambiguous: true });
  assert.equal(f.commands.length, 1);
  f.rpc.request = request;
  const reconcile = f.transport.reconcile('thread', 'pause'); await turn();
  assert.deepEqual(f.commands[1], f.commands[0]); f.deliver('pause'); await reconcile;
  assert.equal(new Set(f.commands.map(c => c.messageId)).size, 1);
});

for (const status of ['rejected', 'uncertain']) test(`${status} delivery does not count as successful delivery`, async t => {
  const f = fixture(t); await f.transport.beginOperation('thread');
  const action = f.transport.steer('thread', 'work', 'Pause.'); await turn(); f.deliver('pause', status);
  await assert.rejects(action, { code: status === 'uncertain' ? 'maintenance-ambiguous-delivery' : 'maintenance-stale-target' });
});

for (const change of [{ userStopped: true }, { userEpoch: 2 }, { providerSessionId: 'replacement' }, { supported: false }]) {
  test(`pending mutation cancels on ${Object.keys(change)[0]} without a successor command`, async t => {
    const f = fixture(t); await f.transport.beginOperation('thread');
    const action = f.transport.steer('thread', 'work', 'Pause.'); await turn(); f.reader.update(change);
    await assert.rejects(action, { code: 'stale-action' }); assert.equal(f.commands.length, 1);
  });
}

test('Claude active pause uses the advertised capability without a provider-specific refusal', async t => {
  const f = fixture(t); f.reader.s.provider = 'claudeAgent'; await f.transport.beginOperation('thread');
  const action = f.transport.steer('thread', 'work', 'Pause.'); await turn();
  assert.equal(f.commands[0].action, 'pause'); f.deliver('pause'); await action;
});

for (const provider of ['codex', 'claudeAgent']) test(`${provider} pause requires the explicit active-pause capability`, async t => {
  const f = fixture(t); f.reader.s.provider = provider;
  f.rpc.request = async tag => { assert.equal(tag, 'server.getConfig'); return { guardedMaintenance: 1, environment: { environmentId: 'env' } }; };
  await f.transport.beginOperation('thread');
  await assert.rejects(f.transport.steer('thread', 'work', 'Pause.'), { code: 't3-active-pause-unavailable' });
  assert.equal(f.commands.length, 0);
});

test('compaction history is exhausted instead of guessing there was no earlier compaction', async t => {
  const f = fixture(t); f.reader.update({ historyComplete: false, historyCursor: 'older' });
  f.rpc.history = async () => ({ items: [{ item: { id: 'old', type: 'compaction', status: 'completed', providerThreadId: 'provider' } }], hasMoreHistory: false });
  await f.transport.beginOperation('thread');
  const action = f.transport.steer('thread', 'work', 'Pause.'); await turn();
  assert.equal(f.commands[0].guard.compactionItemId, 'old'); f.deliver('pause'); await action;
});

test('concurrent operation starts cannot replace the owned operation', async t => {
  const f = fixture(t); const starts = await Promise.allSettled([f.transport.beginOperation('thread'), f.transport.beginOperation('thread')]);
  assert.equal(starts.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(starts.find(r => r.status === 'rejected').reason.code, 'action-in-progress');
});

test('full controller cycle waits for native compaction and successful run terminality before one continuation', async t => {
  const f = await pause(t); const tick = f.c.tick(); await turn();
  assert.deepEqual(f.commands.map(c => c.action), ['pause', 'compact']);
  f.deliver('compact', 'accepted'); await turn(); assert.equal(f.c.state, 'compacting');
  f.deliver('compact');
  f.reader.update({ runId: 'compact', turnId: 'compact', runAttemptId: 'compact-attempt', turnStatus: 'active',
    compactionGeneration: 1, compactionItemId: 'item', compactionRunId: 'compact', compactionRunStatus: 'running' });
  await turn(); assert.equal(f.commands.length, 2);
  f.reader.update({ turnStatus: 'idle', lastTurnStatus: 'completed' }); await turn();
  assert.equal(f.commands.length, 2, 'Idle alone is not successful compaction-run completion');
  f.reader.update({ compactionRunStatus: 'completed' }); await turn();
  assert.deepEqual(f.commands.map(c => c.action), ['pause', 'compact', 'resume']);
  f.deliver('resume'); await tick; await f.c.tick();
  assert.equal(f.c.log.filter(e => e.event === 'resumed').length, 1); assert.equal(f.commands.length, 3);
});

test('deferral continues unfinished work once without issuing compaction', async t => {
  const f = await pause(t, { deferral: { choice: 'yes' }, continuation: { choice: 'yes' } });
  const tick = f.c.tick(); await turn(); assert.deepEqual(f.commands.map(c => c.action), ['pause', 'resume']);
  f.deliver('resume'); await tick; assert.equal(f.c.state, 'observing');
  assert.equal(f.c.log.at(-1).event, 'continued-without-compaction');
});

for (const automatic of [false, true]) test(`independent compaction is adopted without duplicate dispatch (automatic=${automatic})`, async t => {
  const f = await pause(t, undefined, automatic);
  f.reader.update({ runId: 'independent', turnId: 'independent', runMessageObserved: false,
    workRunId: 'independent', runAttemptId: 'independent-attempt', turnStatus: 'active' });
  await f.c.tick(); assert.ok(f.c.pending, 'Run creation alone cannot classify its missing message');
  f.reader.update({ runId: 'independent', turnId: 'independent', maintenanceRunId: 'independent',
    workRunId: 'work', runMessageObserved: true, runAttemptId: 'independent-attempt', turnStatus: 'active' });
  await f.c.tick(); assert.equal(f.c.pending.adoptedCompaction, true); assert.equal(f.commands.length, 1);
  f.reader.update({ compactionGeneration: 1, compactionItemId: 'item', compactionRunId: 'independent', compactionRunStatus: 'running' });
  await f.c.tick(); assert.equal(f.commands.length, 1);
  f.reader.update({ turnStatus: 'idle', compactionRunStatus: 'completed' });
  const tick = f.c.tick(); await turn(); assert.deepEqual(f.commands.map(c => c.action), ['pause', 'resume']);
  f.deliver('resume'); await tick; assert.equal(f.c.state, 'observing');
});

for (const change of [{ userStopped: true, userEpoch: 2 }, { userEpoch: 2 }]) test('controller invalidation leaves no continuation after Stop or new direction', async t => {
  const f = await pause(t); f.reader.update(change); await f.c.tick();
  assert.equal(f.c.pending, null); assert.deepEqual(f.commands.map(c => c.action), ['pause']);
});

test('own run creation before the accepted message does not cancel an already-sent idle command', async t => {
  const f = fixture(t); f.reader.update({ turnStatus: 'idle' }); await f.transport.beginOperation('thread');
  const action = f.transport.compact('thread', { isCurrent: () => f.reader.s.turnStatus === 'idle' });
  let settled = false; action.finally(() => { settled = true; }); await turn();
  f.reader.update({ runId: 'compact', turnId: 'compact', runAttemptId: 'compact-attempt', turnStatus: 'active' });
  await turn(); assert.equal(settled, false);
  f.deliver('compact', 'accepted'); await turn(); assert.equal(settled, false);
  f.deliver('compact'); assert.equal((await action).delivered, true);
});

test('capability is rechecked before every phase, including after reconnection', async t => {
  const f = fixture(t); await f.transport.beginOperation('thread');
  f.rpc.request = async tag => { assert.equal(tag, 'server.getConfig'); return { environment: { environmentId: 'env' } }; };
  await assert.rejects(f.transport.steer('thread', 'work', 'Pause.'), { code: 't3-guarded-maintenance-unavailable' });
  assert.equal(f.commands.length, 0);
});

test('archiving after acceptance cancels the delivery wait without continuing', async t => {
  const f = fixture(t); await f.transport.beginOperation('thread');
  const action = f.transport.steer('thread', 'work', 'Pause.'); await turn(); f.deliver('pause', 'accepted');
  f.reader.update({ threadUnavailable: true }); await assert.rejects(action, { code: 'stale-action', ambiguous: true });
  assert.equal(f.commands.length, 1);
});

test('failed compaction run cannot authorize a controller continuation', async t => {
  const f = await pause(t); const tick = f.c.tick(); await turn(); f.deliver('compact');
  f.reader.update({ runId: 'compact', turnId: 'compact', turnStatus: 'idle', compactionGeneration: 1,
    compactionRunStatus: 'failed', compactionRunId: 'compact', compactionItemId: 'item' });
  await turn(); assert.deepEqual(f.commands.map(c => c.action), ['pause', 'compact']);
  f.reader.update({ userStopped: true, userEpoch: 2 }); await tick;
});

test('compaction arriving during the pause assessment is adopted after a fresh assessment', async t => {
  const f = await pause(t); let resolve; let calls = 0;
  f.c.evaluate = async () => { calls++; if (calls === 1) await new Promise(done => { resolve = done; });
    return { answers: { deferral: { choice: 'no' }, continuation: { choice: 'yes' } } }; };
  const assessment = f.c.tick(); await turn();
  f.reader.update({ runId: 'independent', turnId: 'independent', maintenanceRunId: 'independent',
    runAttemptId: 'independent-attempt', turnStatus: 'idle', compactionGeneration: 1,
    compactionItemId: 'item', compactionRunId: 'independent', compactionRunStatus: 'completed' });
  resolve(); await assessment; assert.equal(f.c.state, 'awaiting-idle'); assert.equal(f.commands.length, 1);
  const tick = f.c.tick(); await turn(); assert.equal(calls, 2);
  assert.deepEqual(f.commands.map(c => c.action), ['pause', 'resume']); f.deliver('resume'); await tick;
});

test('detachment during the capability read prevents the pending socket mutation', async t => {
  const f = fixture(t); await f.transport.beginOperation('thread'); let release;
  const request = f.rpc.request.bind(f.rpc);
  f.rpc.request = async (tag, payload) => {
    if (tag === 'server.getConfig') await new Promise(done => { release = done; });
    return request(tag, payload);
  };
  const action = f.transport.steer('thread', 'work', 'Pause.'); await turn();
  f.transport.unbindReader('thread', f.reader); release();
  await assert.rejects(action, { code: 'stale-action' }); assert.equal(f.commands.length, 0);
});
