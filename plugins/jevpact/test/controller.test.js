import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Controller, DEFER_TEXT } from '../src/controller.js';
import { reduceHook } from '../src/hook.js';
import { resolveKey } from '../src/credentials.js';
import { decide } from '../src/policy.js';
import { QUESTIONS } from '../src/jev.js';
import { buildPacket } from '../src/transcript.js';
import { Codex } from '../src/codex.js';

class Reader extends EventEmitter {
  constructor() {
    super();
    this.s = { supported: true, sessionId: 'thread', revision: 1, userEpoch: 1,
      compactionGeneration: 0, requests: 5, requestsSinceCompaction: 5,
      turnStatus: 'active', turnId: 'turn-1', inputTokens: 220000,
      modelContextWindow: 498750, baselineInputTokens: 0, packet: 'pause excerpt',
      timingPacket: 'bounded excerpt', timingMetadata: { available: true, prompted: false },
      messages: [{ role: 'assistant', turnId: 'turn-1', sequence: 8, text: 'The current check is settled; the next stage remains.' }] };
  }
  snapshot() { return structuredClone(this.s); }
  async refresh() {}
  update(patch) { Object.assign(this.s, patch); this.emit('change'); }
  markPrompted(turnId) { this.prompted = turnId; }
}
function make(t, overrides = {}) {
  const reader = new Reader();
  const actions = [];
  const pauses = [];
  const codex = {
    async steer(id, turnId, text, context) { assert.ok(context.isCurrent()); pauses.push({ id, turnId, text }); },
    async status() { return { lastTurnId: reader.s.turnId, status: 'idle' }; },
    async compact(id, context) { assert.ok(context.isCurrent()); actions.push('compact'); },
    async resume() { actions.push('resume'); },
  };
  const controller = new Controller({ reader, codex, evaluate: async () => ({ answers: clearContinuation() }),
    decide: () => ({ action: 'checkpoint', kind: 'semantic', reason: 'boundary' }), ...overrides });
  t.after(() => controller.close());
  return { reader, codex, controller, actions, pauses };
}
function clearContinuation(extra = {}) {
  return { deferral: { choice: 'no', probability: 0.95, confidence: 0.8 },
    continuation: { choice: 'yes', probability: 0.95, confidence: 0.8 }, ...extra };
}
test('diagnostics correlate exact requests, answers and stale decisions without changing the status ring', async t => {
  const { reader, controller } = make(t);
  const diagnostics = [];
  controller.on('diagnostic', event => diagnostics.push(event));
  const response = deferred();
  controller.evaluate = async (packet, { onRequest }) => {
    onRequest({ state: { excerpt: packet }, questions: QUESTIONS, model: 'test' });
    return response.promise;
  };
  const tick = controller.tick();
  await nextTask();
  reader.update({ revision: 2, requests: 6 });
  response.resolve({ model: 'test', answers: clearContinuation(), response: '{"test":true}', latencyMs: 1 });
  await tick;
  assert.deepEqual(diagnostics.map(d => d.event), ['evaluation-started', 'jev-request', 'evaluation-completed', 'stale-analysis']);
  assert.equal(new Set(diagnostics.map(d => d.evaluationId)).size, 1);
  assert.equal(diagnostics[1].request.state.excerpt, 'bounded excerpt');
  assert.equal(diagnostics[1].context.revision, 1, 'Retain the actual evaluated state, not the newer one');
  assert.equal(diagnostics[2].response, '{"test":true}');
  assert.equal(controller.log.length, 1, 'Exact payloads do not enter normal status output');
});

test('ordinary assessment sends the selected timing packet with the timing2 schema', async t => {
  const { reader, controller } = make(t);
  let observed;
  controller.evaluate = async (packet, options) => {
    observed = { packet, purpose: options.purpose };
    return { answers: clearContinuation() };
  };
  await controller.assess(reader.snapshot(), { signal: new AbortController().signal });
  assert.deepEqual(observed, { packet: 'bounded excerpt', purpose: 'timing2' });
});

test('early policy skips are retained once per changed work state', async t => {
  const { reader, controller } = make(t);
  const events = [];
  controller.on('diagnostic', event => events.push(event));
  reader.s.inputTokens = 100000;
  await controller.tick();
  await controller.tick();
  assert.equal(events.length, 1);
  assert.equal(events[0].reason, 'below-input-floor');
  reader.s.requests++;
  await controller.tick();
  assert.equal(events.length, 2);
  reader.update({ compactionGeneration: 1 });
  assert.equal(events.at(-1).event, 'native-compaction-observed');
  assert.equal(events.at(-1).origin, 'external');
});
test('checkpoint sends one ordinary message to the selected active turn', async t => {
  const { reader, controller, pauses } = make(t);
  await controller.tick();
  assert.equal(controller.state, 'awaiting-idle');
  assert.equal(pauses.length, 1);
  assert.equal(pauses[0].turnId, 'turn-1');
  assert.match(pauses[0].text, /Leave subagents/);
  assert.equal(reader.prompted, 'turn-1');
  assert.deepEqual(controller.hook({ session_id: 'thread', turn_id: 'turn-1', hook_event_name: 'PostToolUse' }), {});
  await controller.tick();
  assert.equal(pauses.length, 1);
});

test('scoped control-message bodies are injected with the fixed Jevpact prefixes', async t => {
  const { reader, controller, codex, pauses } = make(t, { config: {
    pauseMessage: 'Finish the current check and stop this turn.',
    resumeMessage: 'Continue the saved next action.',
    deferMessage: 'Continue the current check without compaction.',
  } });
  const resumed = [];
  codex.resume = async (_id, text) => { resumed.push(text); };
  await pauseParent(reader, controller);
  assert.equal(pauses[0].text, 'Jevpact context maintenance: Finish the current check and stop this turn.');
  const tick = controller.tick();
  await nextTask();
  reader.update({ compactionGeneration: 1, turnId: 'compact-turn' });
  await tick;
  assert.deepEqual(resumed, ['Jevpact compaction complete: Continue the saved next action.']);
});

test('pause and resume templates expand at their lifecycle stages and freeze pre-compaction text', async t => {
  const { reader, controller, codex, pauses } = make(t, {
    config: {
      pauseMessage: 'Pause for {{user.latestPrompt}}; wrap-up={{pause.wrapUp}}',
      resumeMessage: 'Before={{assistant.lastBeforeCompaction}}; wrap-up={{pause.wrapUp}}; project={{project.root}}; profile={{profile.name}}; tokens={{context.inputTokens}}; generation={{compaction.generation}}',
    },
    templateContext: { projectRoot: '/tmp/project', profileName: 'deep-work' },
  });
  reader.s.recentUserRequests = [{ origin: 'ordinary', text: 'Implement the parser.' }];
  const resumed = [];
  codex.resume = async (_id, text) => { resumed.push(text); };
  await pauseParent(reader, controller);
  assert.match(pauses[0].text, /Pause for Implement the parser/);
  assert.match(pauses[0].text, /wrap-up=\[unavailable: pause\.wrapUp\]/);
  const tick = controller.tick();
  await nextTask();
  reader.update({ compactionGeneration: 1, turnId: 'compact-turn', messages: [] });
  await tick;
  assert.equal(resumed.length, 1);
  assert.match(resumed[0], /Before=The local behavior is verified/);
  assert.match(resumed[0], /wrap-up=The local behavior is verified/);
  assert.match(resumed[0], /project=\/tmp\/project; profile=deep-work; tokens=220000; generation=1/);
});

test('defer template sees the pause wrap-up and names the observed deferral reason', async t => {
  const { reader, controller, codex } = make(t, { config: {
    deferMessage: 'Wrap-up={{pause.wrapUp}}; prior={{assistant.lastBeforeCompaction}}; reason={{lifecycle.reason}}',
  } });
  const resumed = [];
  codex.resume = async (_id, text) => { resumed.push(text); };
  await pauseParent(reader, controller);
  controller.evaluate = async () => ({ answers: clearContinuation({ deferral: { choice: 'yes' } }) });
  await controller.tick();
  assert.equal(resumed.length, 1);
  assert.match(resumed[0], /Wrap-up=The local behavior is verified/);
  assert.match(resumed[0], /prior=\[unavailable: assistant\.lastBeforeCompaction\]/);
  assert.match(resumed[0], /reason=agent-deferred-compaction/);
});

test('observe mode records a checkpoint without sending a pause or compaction', async t => {
  const { controller, pauses, actions } = make(t, { config: { mode: 'observe' } });
  await controller.tick();
  assert.equal(controller.log.at(-1).event, 'would-checkpoint');
  assert.deepEqual(pauses, []);
  assert.deepEqual(actions, []);
});

test('a delivered pause keeps its settings until new direction releases it', async t => {
  const { reader, controller, actions } = make(t);
  await pauseParent(reader, controller);
  assert.deepEqual(controller.reconfigure({ mode: 'off' }), { applied: false, deferred: true });
  assert.equal(controller.view().configPending, true);
  controller.hook({ session_id: 'thread', hook_event_name: 'UserPromptSubmit', turn_id: 'new-turn' });
  assert.equal(controller.view().mode, 'off');
  assert.equal(controller.view().configPending, false);
  await controller.tick();
  assert.deepEqual(actions, []);
});

test('an already idle checkpoint compacts without a pause assessment', async t => {
  const purposes = [];
  const { reader, controller, actions, pauses } = make(t);
  reader.s.turnStatus = 'idle';
  controller.evaluate = async (_packet, { purpose }) => { purposes.push(purpose); return { answers: clearContinuation() }; };
  const tick = controller.tick();
  await nextTask();
  assert.deepEqual(purposes, ['timing2']);
  assert.deepEqual(pauses, []);
  assert.deepEqual(actions, ['compact']);
  reader.update({ compactionGeneration: 1, turnId: 'compact-turn' });
  await tick;
});
test('an active native goal is rejected before any pause reaches the working task', async t => {
  const codex = new Codex();
  t.after(() => codex.close());
  codex.status = async () => ({ status: 'active', turnId: 'turn-1', goalStatus: 'active' });
  const sent = [];
  codex.request = async method => { sent.push(method); return { result: { result: { turnId: 'turn-1' } } }; };
  const { controller } = make(t, { codex });
  await controller.tick();
  assert.deepEqual(sent, []);
  assert.equal(controller.state, 'observing');
  assert.equal(controller.pending, null);
  assert.ok(controller.log.some(item => item.event === 'unavailable' && item.reason === 'active-goal-unsupported'));
  assert.ok(!controller.log.some(item => ['pause-delivered', 'recovery-required'].includes(item.event)));
});
test('an explicit user stop invalidates pending pause and prevents reassessment', async t => {
  const { controller } = make(t);
  await controller.tick();
  controller.hook({ session_id: 'thread', hook_event_name: 'Interrupt' });
  await controller.tick();
  assert.equal(controller.pending, null);
  assert.equal(controller.stopped, true);
});
test('new user direction invalidates an in-flight semantic response', async t => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const { reader, controller } = make(t, { evaluate: () => pending });
  const tick = controller.tick();
  await new Promise(resolve => setImmediate(resolve));
  reader.update({ userEpoch: 2, revision: 2 });
  release({ answers: {} });
  await tick;
  assert.equal(controller.pending, null);
  assert.ok(controller.log.some(e => e.event === 'stale-analysis'));
});
test('a successful RPC acknowledgement does not resume; native completion does', async t => {
  const { reader, controller, actions } = make(t);
  await controller.tick();
  controller.hook({ session_id: 'thread', turn_id: 'turn-1', hook_event_name: 'PostToolUse' });
  reader.update({ turnStatus: 'idle', messages: [{ role: 'assistant', phase: 'final', turnId: 'turn-1', sequence: 10, text: 'The local fix is verified. Next I will run the integration check.' }] });
  const tick = controller.tick();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(actions, ['compact']);
  reader.update({ compactionGeneration: 1, turnId: 'compact-turn', turnStatus: 'idle' });
  await tick;
  assert.deepEqual(actions, ['compact', 'resume']);
});
test('a user interrupt during compaction prevents continuation', async t => {
  const { reader, controller, actions } = make(t);
  await controller.tick();
  controller.hook({ session_id: 'thread', turn_id: 'turn-1', hook_event_name: 'PostToolUse' });
  reader.update({ turnStatus: 'idle', messages: [{ role: 'assistant', phase: 'final', turnId: 'turn-1', sequence: 10, text: 'The diagnosis is settled. I still need to verify the integration behavior.' }] });
  const tick = controller.tick();
  await new Promise(resolve => setImmediate(resolve));
  controller.hook({ session_id: 'thread', hook_event_name: 'Interrupt' });
  reader.update({ compactionGeneration: 1, turnStatus: 'idle' });
  await tick;
  assert.deepEqual(actions, ['compact']);
});
test('an accepted settled checkpoint compacts a completed or waiting parent without resuming', async t => {
  for (const text of ['All requested work is complete.', 'I need the user to choose the target before I can continue.', 'My step is complete; only the child verification result remains pending.']) {
    const { reader, controller, actions } = make(t);
    await pauseParent(reader, controller);
    reader.s.messages.at(-1).text = text;
    reader.s.packet = buildPacket(reader.s);
    controller.evaluate = async (packet, options) => {
      assert.equal(options.purpose, 'pause');
      assert.equal(packet.finalWrapUp.text, text);
      assert.match(packet.preNoticeReport.text, /current check is settled/);
      return { answers: clearContinuation({ continuation: { choice: 'no', probability: 0.95, confidence: 0.8 } }) };
    };
    const tick = controller.tick();
    await nextTask();
    assert.deepEqual(actions, ['compact']);
    assert.equal(controller.state, 'compacting', 'RPC acknowledgement is not completion');
    reader.update({ compactionGeneration: 1, turnId: 'compact-turn', turnStatus: 'idle' });
    await tick;
    assert.deepEqual(actions, ['compact']);
    assert.ok(controller.log.some(e => e.event === 'compacted'));
    assert.equal(controller.pending, null);
  }
});

test('a clear deferral with no actionable continuation leaves the parent idle without compaction', async t => {
  for (const extra of [
    { deferral: { choice: 'yes', probability: 0.95, confidence: 0.8 } },
    { deferral: { choice: 'yes', probability: 0.62, confidence: 0.43 } },
  ]) {
    const { reader, controller, actions } = make(t);
    await pauseParent(reader, controller);
    controller.evaluate = async () => ({ answers: clearContinuation({
      continuation: { choice: 'no', probability: 0.95, confidence: 0.8 }, ...extra,
    }) });
    await controller.tick();
    assert.deepEqual(actions, []);
    assert.equal(controller.pending, null);
    assert.ok(controller.log.some(e => e.event === 'checkpoint-withdrawn' && e.reason === 'agent-deferred-compaction'));
  }
});

test('the reported waiting-parent wrap-up compacts and stays idle', async t => {
  const { reader, controller, actions } = make(t);
  await pauseParent(reader, controller);
  reader.s.messages.at(-1).text = 'This is a good point to pause for compaction. Five remediation sessions are running; the heartbeat will assign more work as slots free up. No user input is needed now.';
  controller.evaluate = async packet => {
    assert.match(packet.finalWrapUp.text, /good point to pause/);
    assert.match(packet.preNoticeReport.text, /current check is settled/);
    return { answers: clearContinuation({ continuation: { choice: 'no', probability: 0.89, confidence: 0.83 } }) };
  };
  const tick = controller.tick();
  await nextTask();
  assert.deepEqual(actions, ['compact']);
  reader.update({ compactionGeneration: 1, turnId: 'compact-turn' });
  await tick;
  assert.deepEqual(actions, ['compact']);
  assert.ok(controller.log.some(e => e.event === 'pause-checked' && e.deferral === 'no' && e.continuation === 'no'));
});

test('pause assessment uses the final answer after intermediate commentary', async t => {
  const { reader, controller, actions } = make(t);
  await pauseParent(reader, controller);
  reader.s.messages = [
    { role: 'assistant', phase: 'commentary', turnId: 'turn-1', sequence: 9, text: 'I may need to defer while checking the result.' },
    { role: 'assistant', phase: 'final', turnId: 'turn-1', sequence: 10, text: 'The result is checked; this is a good point to compact.' },
  ];
  controller.evaluate = async packet => {
    assert.match(packet.finalWrapUp.text, /good point to compact/);
    assert.doesNotMatch(packet.finalWrapUp.text, /defer/);
    return { answers: clearContinuation({ continuation: { choice: 'no' } }) };
  };
  const tick = controller.tick();
  await nextTask();
  assert.deepEqual(actions, ['compact']);
  reader.update({ compactionGeneration: 1, turnId: 'compact-turn' });
  await tick;
});

test('unknown deferral enters recovery instead of silently canceling a paused task', async t => {
  const { reader, controller, actions } = make(t);
  await pauseParent(reader, controller);
  controller.evaluate = async () => ({ answers: clearContinuation({
    deferral: { choice: 'unknown', probability: 0.9, confidence: 0.8 },
  }) });
  await controller.tick();
  assert.deepEqual(actions, []);
  assert.equal(controller.state, 'recovery-required');
  assert.equal(controller.view().recoveryRequired.reason, 'deferral-uncertain');
});

test('a selected low-score continuation resumes only after native compaction completes', async t => {
  const { reader, controller, actions } = make(t);
  await pauseParent(reader, controller);
  controller.evaluate = async () => ({ answers: clearContinuation({
    continuation: { choice: 'yes', probability: 0.57, confidence: 0.34 },
  }) });
  const tick = controller.tick();
  await nextTask();
  assert.deepEqual(actions, ['compact']);
  reader.update({ compactionGeneration: 1, turnId: 'compact-turn' });
  await tick;
  assert.deepEqual(actions, ['compact', 'resume']);
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const nextTask = () => new Promise(resolve => setImmediate(resolve));
async function pauseParent(reader, controller) {
  await controller.tick();
  controller.hook({ session_id: 'thread', turn_id: 'turn-1', hook_event_name: 'PostToolUse' });
  reader.update({ turnStatus: 'idle', messages: [{ role: 'assistant', phase: 'final', turnId: 'turn-1', sequence: 10, text: 'The local behavior is verified. The next step is to run the integration check.' }] });
  reader.s.packet = buildPacket(reader.s);
}

test('new user hook cancels pending status before transcript epoch advances', async t => {
  const { reader, codex, controller, actions } = make(t);
  await pauseParent(reader, controller);
  const request = deferred();
  codex.status = () => request.promise;
  const tick = controller.tick();
  await nextTask();
  controller.hook({ session_id: 'thread', hook_event_name: 'UserPromptSubmit' });
  await tick;
  assert.equal(controller.busy, false);
  request.resolve({ lastTurnId: 'turn-1', status: 'idle' });
  await nextTask();
  assert.deepEqual(actions, []);
  assert.equal(controller.pending, null);
});

test('new direction during a pending compact RPC settles immediately and cannot resume later', async t => {
  const { reader, codex, controller, actions } = make(t);
  await pauseParent(reader, controller);
  const request = deferred();
  let context;
  codex.compact = async (_, value) => { context = value; actions.push('compact'); return request.promise; };
  const tick = controller.tick();
  await nextTask();
  controller.hook({ session_id: 'thread', hook_event_name: 'UserPromptSubmit' });
  assert.equal(context.isCurrent(), false);
  await tick;
  assert.equal(reader.listenerCount('change'), 1);
  request.resolve();
  reader.update({ compactionGeneration: 1, turnId: 'compact-turn', turnStatus: 'idle' });
  await nextTask();
  assert.deepEqual(actions, ['compact']);
});

test('closing while awaiting native completion settles the turn and removes listeners', async t => {
  const { reader, controller, actions } = make(t);
  await pauseParent(reader, controller);
  const tick = controller.tick();
  await nextTask();
  assert.equal(reader.listenerCount('change'), 2);
  controller.close();
  await tick;
  assert.equal(controller.busy, false);
  assert.equal(reader.listenerCount('change'), 0);
  assert.deepEqual(actions, ['compact']);
});

test('a transcript-only stop cancels compaction wait without waiting for completion', async t => {
  const { reader, controller, actions } = make(t);
  await pauseParent(reader, controller);
  const tick = controller.tick();
  await nextTask();
  reader.update({ userStopped: true });
  await tick;
  assert.equal(reader.listenerCount('change'), 1);
  assert.deepEqual(actions, ['compact']);
});

test('a failed or ambiguous compact after delivered pause is exposed for explicit recovery', async t => {
  for (const ambiguous of [false, true]) {
    const { reader, codex, controller, actions } = make(t);
    await pauseParent(reader, controller);
    codex.compact = async () => { actions.push('compact'); throw Object.assign(new Error('private response'), { code: 'request-failed', ambiguous }); };
    await controller.tick();
    assert.equal(controller.state, 'recovery-required');
    assert.equal(controller.view().recoveryRequired.continuationMayBePaused, true);
    assert.equal(controller.view().recoveryRequired.ambiguous, ambiguous);
    assert.equal(JSON.stringify(controller.log).includes('private response'), false);
    assert.equal(reader.listenerCount('change'), 1);
    reader.update({ compactionGeneration: 1 });
    await controller.tick();
    assert.deepEqual(actions, ['compact']);
    controller.hook({ session_id: 'thread', hook_event_name: 'UserPromptSubmit' });
    assert.equal(controller.view().recoveryRequired, null);
  }
});

test('a completion timeout preserves uncertainty and releases its listener', async t => {
  const { reader, controller, actions } = make(t, { config: { compactionTimeoutMs: 10 } });
  await pauseParent(reader, controller);
  await controller.tick();
  assert.equal(controller.state, 'recovery-required');
  assert.equal(controller.view().recoveryRequired.reason, 'compaction-timeout');
  assert.equal(controller.view().recoveryRequired.ambiguous, true);
  assert.equal(reader.listenerCount('change'), 1);
  assert.deepEqual(actions, ['compact']);
});

test('new direction during resume status prevents continuation before epoch advances', async t => {
  const { reader, codex, controller, actions } = make(t);
  await pauseParent(reader, controller);
  const resumeStatus = deferred();
  let statusCalls = 0;
  codex.status = async () => ++statusCalls === 1 ? { lastTurnId: 'turn-1' } : resumeStatus.promise;
  const tick = controller.tick();
  await nextTask();
  reader.update({ compactionGeneration: 1, turnId: 'compact-turn', turnStatus: 'idle' });
  await nextTask();
  assert.equal(statusCalls, 2);
  controller.hook({ session_id: 'thread', hook_event_name: 'UserPromptSubmit' });
  await tick;
  resumeStatus.resolve({ lastTurnId: 'compact-turn' });
  await nextTask();
  assert.deepEqual(actions, ['compact']);
});

test('lost connection after compaction leaves an explicit paused recovery state', async t => {
  const { reader, codex, controller, actions } = make(t);
  await pauseParent(reader, controller);
  const tick = controller.tick();
  await nextTask();
  codex.status = async () => { throw Object.assign(new Error('Owner disconnected'), { code: 'disconnected' }); };
  reader.update({ compactionGeneration: 1, turnId: 'compact-turn', turnStatus: 'idle' });
  await tick;
  assert.deepEqual(actions, ['compact']);
  assert.equal(controller.state, 'recovery-required');
  assert.equal(controller.view().recoveryRequired.continuationMayBePaused, true);
});

test('opaque tool revisions do not cause more paid evaluations of unchanged model activity', async t => {
  let calls = 0;
  const { reader, controller } = make(t, {
    evaluate: async () => { calls++; return { answers: clearContinuation() }; },
    decide: () => ({ action: 'wait' }),
  });
  await controller.tick();
  for (let revision = 2; revision <= 5; revision++) {
    reader.update({ revision, latestOmittedActivity: { sequence: revision, kind: 'tool' } });
    await controller.tick();
  }
  assert.equal(calls, 1);
  reader.update({ revision: 6, requests: 6, messages: [{ role: 'assistant', turnId: 'turn-1', sequence: 20, text: 'The result is interpreted.' }] });
  await controller.tick();
  assert.equal(calls, 2);
});

test('a stale evaluation is not retried solely because opaque activity changed its revision', async t => {
  let calls = 0;
  const response = deferred();
  const { reader, controller } = make(t, {
    evaluate: () => { calls++; return response.promise; }, decide: () => ({ action: 'wait' }),
  });
  const tick = controller.tick();
  await nextTask();
  reader.update({ revision: 2 });
  response.resolve({ answers: clearContinuation() });
  await tick;
  await controller.tick();
  assert.equal(calls, 1);
  assert.ok(controller.log.some(item => item.event === 'stale-analysis'));
});

test('minimum growth and known baseline are required before a paid evaluation', async t => {
  let calls = 0;
  const { reader, controller } = make(t, {
    evaluate: async () => { calls++; return { answers: clearContinuation() }; }, decide: () => ({ action: 'wait' }),
  });
  reader.update({ baselineInputTokens: null });
  await controller.tick();
  reader.update({ baselineInputTokens: 200000 });
  await controller.tick();
  assert.equal(calls, 0);
  reader.update({ inputTokens: 240000 });
  await controller.tick();
  assert.equal(calls, 1);
});

test('an explicit post-notice deferral withdraws semantic compaction and continues the paused assignment', async t => {
  const { reader, codex, controller, actions } = make(t);
  await pauseParent(reader, controller);
  let checkedPacket;
  reader.s.messages.at(-1).text = 'The new result conflicts with the fix; I must interpret it before compaction.';
  controller.evaluate = async packet => { checkedPacket = packet; return { answers: clearContinuation({
    deferral: { choice: 'yes', probability: 0.95, confidence: 0.8 },
  }) }; };
  let input;
  codex.resume = async (_, text, context) => { assert.equal(context.isCurrent(), true); input = text; actions.push('resume'); };
  await controller.tick();
  assert.match(checkedPacket.finalWrapUp.text, /before compaction/);
  assert.equal(checkedPacket.opaqueActivityAfterFinal, false);
  assert.deepEqual(actions, ['resume']);
  assert.equal(input, DEFER_TEXT);
  assert.ok(!input.includes('compaction complete'));
  assert.equal(controller.pending, null);
  assert.ok(controller.log.some(item => item.event === 'checkpoint-withdrawn'));
});

test('a selected deferral continues the paused task despite lower probability or confidence', async t => {
  for (const deferral of [
    { choice: 'yes', probability: 0.62, confidence: 0.43 },
    { choice: 'yes', probability: 0.57, confidence: 0.34 },
  ]) {
    const { reader, controller, actions } = make(t);
    await pauseParent(reader, controller);
    controller.evaluate = async () => ({ answers: clearContinuation({ deferral }) });
    await controller.tick();
    assert.deepEqual(actions, ['resume']);
    assert.ok(controller.log.some(item => item.event === 'continued-without-compaction'));
  }
});

test('post-pause execution uses ordinary prose and continuation without boundary answers', async t => {
  const { reader, controller, actions } = make(t);
  await pauseParent(reader, controller);
  controller.evaluate = async (packet, { purpose }) => {
    assert.equal(purpose, 'pause');
    assert.match(packet.finalWrapUp.text, /integration check/);
    return { answers: clearContinuation() };
  };
  const tick = controller.tick();
  await nextTask();
  assert.deepEqual(actions, ['compact']);
  reader.update({ compactionGeneration: 1, turnId: 'compact-turn' });
  await tick;
  assert.deepEqual(actions, ['compact', 'resume']);
});

test('pressure remains an explicitly identified fallback through opaque activity after the wrap-up', async t => {
  const { reader, controller, actions } = make(t, { decide: () => ({ action: 'checkpoint', kind: 'pressure' }) });
  await pauseParent(reader, controller);
  reader.s.latestOmittedActivity = { kind: 'tool-result-content-omitted', sequence: 11, turnId: 'turn-1' };
  controller.evaluate = async packet => {
    assert.equal(packet.opaqueActivityAfterFinal, true);
    return { answers: clearContinuation() };
  };
  const tick = controller.tick();
  await nextTask();
  assert.deepEqual(actions, ['compact']);
  assert.ok(controller.log.some(item => item.event === 'pressure-fallback'));
  reader.update({ compactionGeneration: 1, turnId: 'compact-turn' });
  await tick;
});

test('new user direction or stop during post-pause classification forbids both mutations', async t => {
  for (const hook_event_name of ['UserPromptSubmit', 'Interrupt']) {
    const { reader, controller, actions } = make(t);
    await pauseParent(reader, controller);
    const response = deferred();
    let signal;
    controller.evaluate = (_, context) => { signal = context.signal; return response.promise; };
    const tick = controller.tick();
    await nextTask();
    controller.hook({ session_id: 'thread', hook_event_name });
    await tick;
    assert.equal(signal.aborted, true);
    response.resolve({ answers: clearContinuation({ deferral: { choice: 'unknown' } }) });
    await nextTask();
    assert.deepEqual(actions, []);
    assert.equal(controller.pending, null);
  }
});

test('a failed post-pause classification leaves explicit recovery instead of dropping the paused worker', async t => {
  const { reader, controller, actions } = make(t);
  await pauseParent(reader, controller);
  controller.evaluate = async () => { throw Object.assign(new Error('private provider body'), { code: 'provider-timeout' }); };
  await controller.tick();
  assert.equal(controller.state, 'recovery-required');
  assert.equal(controller.view().recoveryRequired.continuationMayBePaused, true);
  assert.equal(JSON.stringify(controller.log).includes('private provider body'), false);
  assert.deepEqual(actions, []);
});

test('deferred continuation still requires the matching native idle state', async t => {
  for (const blockedBy of ['active', 'new-idle-turn']) {
    const { reader, codex, controller, actions } = make(t);
    await pauseParent(reader, controller);
    controller.evaluate = async () => {
      return { answers: clearContinuation({ deferral: { choice: 'yes' } }) };
    };
    if (blockedBy === 'active') codex.status = async () => ({ status: 'active', lastTurnId: 'other' });
    if (blockedBy === 'new-idle-turn') codex.status = async () => ({ status: 'idle', lastTurnId: 'other' });
    await controller.tick();
    assert.equal(controller.state, 'recovery-required');
    assert.deepEqual(actions, []);
  }
});

test('activity changing during post-pause assessment surfaces stale continuation without resuming', async t => {
  const { reader, controller, actions } = make(t);
  await pauseParent(reader, controller);
  const response = deferred();
  controller.evaluate = () => response.promise;
  const tick = controller.tick();
  await nextTask();
  reader.update({ revision: reader.s.revision + 1, latestOmittedActivity: { sequence: 99 } });
  response.resolve({ answers: clearContinuation() });
  await tick;
  assert.deepEqual(actions, []);
  assert.equal(controller.state, 'recovery-required');
  assert.equal(controller.view().recoveryRequired.reason, 'pause-continuation-stale');
});

test('a trailing event with no new evidence during post-pause assessment does not strand the pause', async t => {
  const { reader, controller, actions } = make(t);
  await pauseParent(reader, controller);
  const response = deferred();
  controller.evaluate = () => response.promise;
  const tick = controller.tick();
  await nextTask();
  reader.update({ revision: reader.s.revision + 1 });
  response.resolve({ answers: clearContinuation() });
  await nextTask();
  assert.notEqual(controller.state, 'recovery-required');
  assert.deepEqual(actions, ['compact']);
  reader.update({ compactionGeneration: 1, turnId: 'compact-turn', turnStatus: 'idle' });
  await tick;
  assert.deepEqual(actions, ['compact', 'resume']);
});

test('losing transcript support after pause cancels classification and preserves recovery status', async t => {
  const { reader, controller, actions } = make(t);
  await pauseParent(reader, controller);
  const response = deferred();
  controller.evaluate = () => response.promise;
  const tick = controller.tick();
  await nextTask();
  reader.update({ supported: false });
  await tick;
  await controller.tick();
  assert.equal(controller.state, 'recovery-required');
  assert.equal(controller.view().recoveryRequired.reason, 'transcript-unavailable');
  assert.deepEqual(actions, []);
  response.resolve({ answers: clearContinuation() });
});

test('an intervening native compaction after delivered pause is surfaced for recovery', async t => {
  const { reader, controller, actions } = make(t);
  await pauseParent(reader, controller);
  reader.update({ compactionGeneration: 1 });
  await controller.tick();
  assert.equal(controller.state, 'recovery-required');
  assert.equal(controller.view().recoveryRequired.reason, 'compaction-changed-after-pause');
  controller.fail(new Error('later observation error'));
  assert.equal(controller.state, 'recovery-required');
  assert.deepEqual(actions, []);
});
test('a native compaction after a delivered pause is adopted and the paused worker resumes once', async t => {
  const { reader, controller, codex, actions } = make(t);
  const resumed = [];
  codex.resume = async (_id, text) => { actions.push('resume'); resumed.push(text); };
  await controller.tick();
  assert.equal(controller.state, 'awaiting-idle');
  controller.hook({ session_id: 'thread', hook_event_name: 'PreCompact', trigger: 'auto' });
  assert.equal(controller.state, 'awaiting-idle');
  assert.equal(controller.log.at(-1).event, 'native-compaction-adopted');
  reader.update({ compactionGeneration: 1 });
  controller.hook({ session_id: 'thread', hook_event_name: 'PostCompact' });
  await controller.tick();
  assert.equal(controller.state, 'awaiting-idle');
  reader.update({ turnStatus: 'idle', messages: [{ role: 'assistant', phase: 'final', turnId: 'turn-1', sequence: 10, text: 'The local behavior is verified. The next step is to run the integration check.' }] });
  reader.s.packet = buildPacket(reader.s);
  await controller.tick();
  assert.deepEqual(actions, ['resume'], 'No second compaction; one resume');
  assert.match(resumed[0], /^Jevpact compaction complete:/);
  assert.equal(controller.state, 'observing');
  assert.equal(controller.log.at(-1).event, 'resumed');
});

test('an adopted native compaction leaves a completed or waiting worker idle', async t => {
  const { reader, controller, actions } = make(t);
  controller.evaluate = async () => ({ answers: clearContinuation({ continuation: { choice: 'no', probability: 0.9, confidence: 0.8 } }) });
  await controller.tick();
  controller.hook({ session_id: 'thread', hook_event_name: 'PreCompact', trigger: 'auto' });
  reader.update({ compactionGeneration: 1 });
  reader.update({ turnStatus: 'idle', messages: [{ role: 'assistant', phase: 'final', turnId: 'turn-1', sequence: 10, text: 'The assignment is complete.' }] });
  reader.s.packet = buildPacket(reader.s);
  await controller.tick();
  assert.deepEqual(actions, []);
  assert.equal(controller.state, 'observing');
});

test('a native compaction before the pause is delivered still releases the checkpoint', async t => {
  const { controller, codex, actions } = make(t);
  const steer = deferred();
  codex.steer = () => steer.promise;
  const tick = controller.tick();
  await nextTask();
  controller.hook({ session_id: 'thread', hook_event_name: 'PreCompact', trigger: 'auto' });
  steer.resolve();
  await tick;
  assert.equal(controller.state, 'observing');
  assert.equal(controller.log.at(-1).reason, 'native or manual compaction');
  assert.deepEqual(actions, []);
});

test('hook metadata excludes arbitrary prompt, tool input and output', () => {
  const reduced = reduceHook({ session_id: 'thread', turn_id: 't', hook_event_name: 'PostToolUse',
    prompt: 'private prompt', tool_input: { secret: 'private' }, tool_response: 'source dump' });
  assert.ok(!JSON.stringify(reduced).includes('private'));
  assert.ok(!('tool_input' in reduced));
});
test('JEV_TEST_KEY precedes both local and global API key; API is fallback', async () => {
  assert.equal(await resolveKey({ env: { JEV_TEST_KEY: 'test', JEV_API_KEY: 'api' }, globalValue: async () => 'global' }), 'test');
  assert.equal(await resolveKey({ env: { JEV_API_KEY: 'api' }, globalValue: async name => name === 'JEV_TEST_KEY' ? 'global-test' : '' }), 'global-test');
  assert.equal(await resolveKey({ env: { JEV_API_KEY: 'api' }, globalValue: async () => '' }), 'api');
});

function confidentBoundary() {
  const selected = { boundary: 'yes', continuity: 'no', open_result: 'no', settled: 'yes' };
  return Object.fromEntries(Object.entries(QUESTIONS).map(([id, question]) => {
    const choices = Object.keys(question.criteria);
    return [id, { type: 'choice', choice: selected[id], probability: 0.9, confidence: 0.8,
      probabilities: Object.fromEntries(choices.map(choice => [choice, choice === selected[id] ? 0.9 : 0.1 / (choices.length - 1)])) }];
  }));
}

test('actual snapshot chronology contains a confident opaque-after-final model checkpoint', async t => {
  const answers = confidentBoundary();
  let submitted;
  const { reader, controller, actions } = make(t, {
    decide,
    evaluate: async packet => { submitted = JSON.parse(packet); return { answers }; },
  });
  reader.s.messages = [{ role: 'assistant', turnId: 'turn-1', sequence: 86,
    timestamp: '2026-09-21T19:58:06.864Z', prompted: false,
    text: 'The assigned review is complete; the checked commands agree with the documented behavior.' }];
  reader.s.latestOmittedActivity = { kind: 'tool-result-content-omitted', sequence: 87,
    timestamp: '2026-09-21T19:58:07.864Z', turnId: 'turn-1', interpretation: 'unknown' };
  reader.s.packet = buildPacket(reader.s);
  reader.s.timingPacket = reader.s.packet;
  await controller.tick();
  assert.equal(submitted.latestOmittedActivity.sequence, 87);
  assert.equal(submitted.messages.at(-1).sequence, 86);
  assert.equal(controller.pending, null);
  assert.deepEqual(actions, []);
  const assessment = controller.log.find(item => item.event === 'assessed');
  assert.equal(assessment.action, 'wait');
  assert.equal(assessment.kind, 'semantic');
  assert.deepEqual(assessment.chronology, { latestAssistantSequence: 86, latestOmittedActivitySequence: 87 });
  assert.equal(assessment.signals.open_result.choice, 'no');
  reader.s.messages.push({ role: 'assistant', turnId: 'turn-1', sequence: 90,
    timestamp: '2026-09-21T19:58:10.000Z', prompted: false,
    text: 'The new result confirms the same checked outcome; no unresolved result remains.' });
  reader.s.packet = buildPacket(reader.s);
  reader.s.timingPacket = reader.s.packet;
  reader.update({ revision: 2, requests: 6 });
  await controller.tick();
  assert.equal(controller.state, 'awaiting-idle');
});

test('opaque activity after the prompted wrap-up also withdraws semantic compaction', async t => {
  const { reader, controller, actions } = make(t);
  await pauseParent(reader, controller);
  reader.s.latestOmittedActivity = { kind: 'tool-result-content-omitted', sequence: 11,
    timestamp: '2026-09-21T19:58:07.864Z', turnId: 'turn-1', interpretation: 'unknown' };
  await controller.tick();
  assert.deepEqual(actions, ['resume']);
  assert.ok(controller.log.some(item => item.event === 'pause-checked' && item.evidenceGap));
  assert.ok(controller.log.some(item => item.event === 'checkpoint-withdrawn'));
});

test('deterministic pressure asks for the exact-turn pause without awaiting unavailable Jev', async t => {
  let calls = 0;
  const { reader, controller, pauses } = make(t, { decide,
    evaluate: async () => { calls++; throw new Error('Provider unavailable'); } });
  reader.s.inputTokens = 410000;
  await controller.tick();
  assert.equal(calls, 0);
  assert.equal(controller.state, 'awaiting-idle');
  assert.equal(controller.pending.kind, 'pressure');
  assert.deepEqual(controller.hook({ session_id: 'thread', turn_id: 'other', hook_event_name: 'PostToolUse' }), {});
  assert.match(pauses[0].text, /prepare to compact/);
  assert.equal(controller.log.find(item => item.event === 'assessed').signals, null);
});

test('unknown continuation requires recovery even under pressure', async t => {
  for (const kind of ['semantic', 'pressure']) {
    const { reader, controller, actions } = make(t, { decide: () => ({ action: 'checkpoint', kind }) });
    await pauseParent(reader, controller);
    controller.evaluate = async () => ({ answers: clearContinuation({
      continuation: { choice: 'unknown', probability: 0.9, confidence: 0.8 },
    }) });
    await controller.tick();
    assert.deepEqual(actions, []);
    assert.equal(controller.state, 'recovery-required');
    assert.equal(controller.view().recoveryRequired.reason, 'continuation-uncertain');
    assert.equal(controller.view().recoveryRequired.continuationMayBePaused, true);
  }
});

test('native idle without a visible ordinary wrap-up reports missing continuation evidence', async t => {
  const { reader, controller, actions } = make(t);
  await pauseParent(reader, controller);
  reader.s.messages = [];
  await controller.tick();
  assert.deepEqual(actions, []);
  assert.equal(controller.state, 'recovery-required');
  assert.equal(controller.view().recoveryRequired.reason, 'pause-wrapup-unavailable');
});


test('comparison scheduling skips timing classification but retains the ordinary pause check', async t => {
  const purposes = [];
  const { reader, controller, actions } = make(t, {
    decide: input => { assert.ok(['active', 'idle'].includes(input.turnStatus)); return { action: 'checkpoint', kind: 'semantic', requiresSignals: false }; },
    evaluate: async (_, { purpose }) => { purposes.push(purpose); return { answers: clearContinuation() }; },
  });
  await pauseParent(reader, controller);
  assert.deepEqual(purposes, []);
  const tick = controller.tick();
  await nextTask();
  assert.deepEqual(purposes, ['pause']);
  assert.deepEqual(actions, ['compact']);
  reader.update({ compactionGeneration: 1, turnId: 'compact-turn', turnStatus: 'idle' });
  await tick;
  assert.deepEqual(actions, ['compact', 'resume']);
});

test('a deferred checkpoint tolerates its own new turn and waits for fresh work before asking again', async t => {
  const { reader, codex, controller, actions, pauses } = make(t, {
    decide: () => ({ action: 'checkpoint', kind: 'semantic', requiresSignals: false }),
  });
  await pauseParent(reader, controller);
  controller.evaluate = async () => ({ answers: clearContinuation({
    deferral: { choice: 'yes', probability: 0.95, confidence: 0.8 },
  }) });
  codex.resume = async (_, text, context) => {
    assert.equal(context.isCurrent(), true);
    assert.equal(text, DEFER_TEXT);
    actions.push('resume');
    reader.update({ turnId: 'continued-turn', turnStatus: 'active', revision: 2 });
    return { turnId: 'continued-turn' };
  };
  await controller.tick();
  assert.deepEqual(actions, ['resume']);
  assert.ok(controller.log.some(item => item.event === 'continued-without-compaction'));
  assert.ok(!controller.log.some(item => item.event === 'cancelled' && item.reason === 'selected turn changed'));
  await controller.tick();
  assert.equal(pauses.length, 1);
  reader.update({ requests: 6, requestsSinceCompaction: 6, inputTokens: 220500, revision: 3,
    messages: [{ role: 'assistant', turnId: 'continued-turn', sequence: 12, text: 'I am continuing the saved check.' }] });
  await controller.tick();
  assert.equal(pauses.length, 1);
  reader.update({ requests: 8, requestsSinceCompaction: 8, inputTokens: 260000, revision: 4,
    messages: [{ role: 'assistant', turnId: 'continued-turn', sequence: 16, text: 'The pending check is complete; its result is settled.' }] });
  await controller.tick();
  assert.equal(pauses.length, 2);
});

test('native headroom pressure can act during deferred-checkpoint cooldown', async t => {
  const { reader, controller, pauses } = make(t);
  await pauseParent(reader, controller);
  controller.evaluate = async () => ({ answers: clearContinuation({ deferral: { choice: 'yes' } }) });
  await controller.tick();
  controller.decide = decide;
  controller.evaluate = async () => { throw new Error('Pressure must not await a timing classification'); };
  reader.update({ turnId: 'continued-turn', turnStatus: 'active', inputTokens: 410000, revision: 2 });
  await controller.tick();
  assert.equal(pauses.length, 2);
  assert.equal(controller.pending.kind, 'pressure');
});


test('a follow-up turn cannot inherit a pause decision from the previous turn', async t => {
  let calls = 0;
  const { reader, controller, pauses } = make(t, {
    evaluate: async () => { calls++; return { answers: clearContinuation() }; },
  });
  reader.update({ turnId: 'new-user-turn', userEpoch: 2, revision: 2 });
  await controller.tick();
  assert.equal(pauses.length, 0);
  assert.equal(calls, 0);
  reader.update({ requests: 6, revision: 3, messages: [{ role: 'assistant', turnId: 'new-user-turn', sequence: 12, text: 'The new requirement is understood; I have settled its first check.' }] });
  await controller.tick();
  assert.equal(pauses.length, 1);
  assert.equal(pauses[0].turnId, 'new-user-turn');
});
test('new user direction reassesses the updated state instead of marking it assessed', async t => {
  const decisions = [];
  const { reader, controller } = make(t, { decide: input => { decisions.push(input.usage.inputTokens);
    return { action: 'wait', kind: 'semantic', reason: 'not yet' }; } });
  await controller.tick();
  const before = decisions.length;
  // The transcript already shows the new direction when the hook fires.
  reader.s.userEpoch = 2;
  controller.hook({ session_id: 'thread', hook_event_name: 'UserPromptSubmit' });
  await controller.tick();
  assert.ok(decisions.length > before);
});

test('status counts each request-identity gate check and refusal', async t => {
  const { reader, controller } = make(t);
  reader.s.modelRequestIdentityAvailable = false;
  await controller.tick();
  await controller.tick();
  assert.deepEqual(controller.view().identityGate, { checks: 2, blocked: 2 });
  reader.s.modelRequestIdentityAvailable = true;
  reader.s.inputTokens = 100;
  await controller.tick();
  assert.deepEqual(controller.view().identityGate, { checks: 3, blocked: 2 });
});
