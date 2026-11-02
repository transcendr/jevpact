import test from 'node:test';
import assert from 'node:assert/strict';
import { QUESTIONS, TIMING2_QUESTIONS } from '../src/jev.js';
import { decide } from '../src/policy.js';

function signals(overrides = {}) {
  const choices = { boundary: 'yes', continuity: 'no', open_result: 'no', settled: 'yes', ...overrides };
  return Object.fromEntries(Object.entries(choices).map(([id, choice]) => {
    const options = Object.keys(QUESTIONS[id].criteria);
    return [id, { type: 'choice', choice, confidence: 0.8, probabilities: Object.fromEntries(options.map(option => [option, choice === option ? 0.9 : 0.1 / (options.length - 1)])) }];
  }));
}
const input = () => ({ usage: { inputTokens: 320000, contextWindow: 498750, recentGrowthTokens: 10000 }, baseline: { inputTokens: 60000 }, requestsSinceCompact: 20, signals: signals() });

function timingSignals(overrides = {}) {
  const choices = { relation: 'checkpoint', open_result: 'no', settled: 'yes', next: 'now', ...overrides };
  return Object.fromEntries(Object.entries(choices).map(([id, choice]) => {
    const options = Object.keys(TIMING2_QUESTIONS[id].criteria);
    return [id, { type: 'choice', choice, confidence: 0.8,
      probabilities: Object.fromEntries(options.map(option => [option, option === choice ? 0.9 : 0.1 / (options.length - 1)])) }];
  }));
}

test('source-linked timing accepts a settled substantive step but rejects an incidental answer', () => {
  const current = { ...input(), signals: timingSignals(), timing: { available: true, prompted: false, waitingEvidence: false } };
  assert.equal(decide(current).action, 'checkpoint');
  current.signals = timingSignals({ relation: 'side_answer' });
  assert.equal(decide(current).action, 'wait');
  current.signals = timingSignals({ open_result: 'yes' });
  assert.equal(decide(current).action, 'wait');
});

test('a parent waiting for a required result can checkpoint, but a prompted wrap-up cannot', () => {
  const current = { ...input(), signals: timingSignals({ relation: 'continuation', next: 'await' }),
    timing: { available: true, prompted: false, waitingEvidence: true } };
  assert.equal(decide(current).action, 'checkpoint');
  current.timing.waitingEvidence = false;
  assert.equal(decide(current).action, 'wait');
  current.timing.prompted = true;
  assert.deepEqual(decide(current), { action: 'wait', kind: 'semantic',
    reason: 'Controller-prompted wrap-up is not an independent checkpoint', requiresSignals: false });
});

test('incomplete timing evidence waits without a Jev request unless headroom pressure applies', () => {
  const current = { ...input(), signals: timingSignals(), timing: { available: false, prompted: false } };
  assert.equal(decide(current).requiresSignals, false);
  assert.equal(decide(current).action, 'wait');
  current.usage.inputTokens = 410000;
  assert.equal(decide(current).kind, 'pressure');
});

test('same pressure above ordinary threshold yields opposite semantic decisions', () => {
  const current = input();
  assert.equal(decide(current).action, 'checkpoint');
  current.signals = signals({ boundary: 'no', continuity: 'yes', settled: 'not_applicable' });
  assert.deepEqual(decide(current), { action: 'wait', reason: 'An unsettled connected step is continuing', kind: 'semantic' });
});

test('clear transition below ordinary threshold can checkpoint', () => {
  const current = input(); current.usage.inputTokens = 230000;
  assert.equal(decide(current).action, 'checkpoint');
});

test('open result overrides completion claim and a clear next action', () => {
  const current = input(); current.signals = signals({ open_result: 'yes', settled: 'no' });
  assert.equal(decide(current).action, 'wait');
});

test('unknown never silently means no and not_applicable never means settled', () => {
  for (const overrides of [{ continuity: 'unknown' }, { open_result: 'unknown' }, { settled: 'not_applicable' }, { boundary: 'unknown' }]) {
    assert.equal(decide({ ...input(), signals: signals(overrides) }).action, 'wait');
  }
});

test('low probability or confidence does not qualify a transition', () => {
  const current = input(); current.signals.boundary.confidence = 0.1;
  assert.equal(decide(current).action, 'wait');
  current.signals = signals(); current.signals.boundary.probabilities = { yes: 0.6, no: 0.2, unknown: 0.2 };
  assert.equal(decide(current).action, 'wait');
});

test('pressure fallback is identified separately even with unknown semantic evidence', () => {
  const current = input(); current.usage.inputTokens = 410000; current.signals = null;
  assert.equal(decide(current).kind, 'pressure');
  assert.equal(decide(current).action, 'checkpoint');
});

test('runtime smaller window takes precedence over configured native limit', () => {
  const current = input(); current.usage.contextWindow = 350000;
  assert.equal(decide(current).kind, 'pressure');
});

test('recent growth increases required headroom', () => {
  const current = input(); current.usage.recentGrowthTokens = 70000;
  assert.equal(decide(current).kind, 'pressure');
});

test('compaction floor and cooldown stop low-value repeated compactions', () => {
  for (const change of [value => { value.usage.inputTokens = 100000; }, value => { value.requestsSinceCompact = 1; }, value => { value.baseline.inputTokens = 310000; }]) {
    const current = input(); change(current);
    assert.equal(decide(current).kind, 'ineligible');
  }
});

test('missing usage, counts, baseline, or malformed signals cannot create semantic checkpoint', () => {
  for (const change of [value => { delete value.usage.contextWindow; }, value => { value.usage.recentGrowthTokens = -1; }, value => { value.requestsSinceCompact = undefined; }, value => { value.baseline = null; }, value => { value.signals = {}; }]) {
    const current = input(); change(current); assert.equal(decide(current).action, 'wait');
  }
});

test('invalid config is rejected rather than changing policy silently', () => {
  assert.throws(() => decide({ ...input(), config: { minProbability: 2 } }), /Invalid policy setting/);
});

test('opaque result after final interpretation contains the observed confident Jev false positive', () => {
  const current = input();
  // The failed live synthetic chronology probe selected these choices and distributions.
  current.signals = {
    boundary: { type: 'choice', choice: 'yes', probabilities: { unknown: 0, yes: 1, no: 0 }, probability: 1, confidence: 1 },
    continuity: { type: 'choice', choice: 'no', probabilities: { unknown: 0, yes: 0, no: 1 }, probability: 1, confidence: 0.99 },
    open_result: { type: 'choice', choice: 'no', probabilities: { unknown: 0.14, yes: 0.01, no: 0.85 }, probability: 0.85, confidence: 0.77 },
    settled: { type: 'choice', choice: 'yes', probabilities: { unknown: 0.01, yes: 0.93, not_applicable: 0, no: 0.06 }, probability: 0.93, confidence: 0.91 },
  };
  assert.equal(decide(current).action, 'checkpoint');
  current.chronology = { latestAssistantSequence: 86, latestOmittedActivitySequence: 87 };
  assert.equal(decide(current).action, 'wait');
  assert.equal(decide(current).kind, 'semantic');
  assert.equal(current.signals.open_result.choice, 'no', 'containment must not relabel the model answer');
  current.chronology.latestOmittedActivitySequence = 81;
  assert.equal(decide(current).action, 'checkpoint');
});

test('absent assistant or invalid supplied chronology never becomes evidence of interpretation', () => {
  for (const chronology of [null, {}, { latestAssistantSequence: null, latestOmittedActivitySequence: 87 },
    { latestAssistantSequence: 86, latestOmittedActivitySequence: undefined }]) {
    assert.equal(decide({ ...input(), chronology }).action, 'wait');
  }
  assert.equal(decide({ ...input(), chronology: { latestAssistantSequence: 86, latestOmittedActivitySequence: null } }).action, 'checkpoint');
});

test('headroom pressure remains explicit despite an uninterpreted opaque result', () => {
  const current = input();
  current.usage.inputTokens = 410000;
  current.chronology = { latestAssistantSequence: 86, latestOmittedActivitySequence: 87 };
  assert.equal(decide(current).action, 'checkpoint');
  assert.equal(decide(current).kind, 'pressure');
});

test('incomplete timing evidence never asks for signals, even with uninterpreted activity', () => {
  const decision = decide({ usage: { inputTokens: 210000, contextWindow: 570000, recentGrowthTokens: 1000 }, baseline: { inputTokens: 0 },
    requestsSinceCompact: 10, chronology: { latestAssistantSequence: 5, latestOmittedActivitySequence: 9 },
    timing: { available: false, reason: 'timing-evidence-incomplete' } });
  assert.equal(decision.action, 'wait');
  assert.equal(decision.requiresSignals, false);
});
