import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { DEFAULT_POLICY, hasUninterpretedActivity } from './policy.js';
import { renderMessageTemplate } from './message-template.js';

export const PAUSE_PREFIX = 'Jevpact context maintenance:';
export const RESUME_PREFIX = 'Jevpact compaction complete:';
export const PAUSE_TEXT = `${PAUSE_PREFIX} prepare to compact at the end of your current connected step. If an unresolved result makes this a poor point to pause, say what needs finishing and finish that step first. Briefly preserve any newly settled conclusion, its essential qualifications, and the next action, then end this turn. Leave subagents and background work running; do not wait for them. This is a temporary pause, not task completion. If the assignment is already complete or you need user input, say so. Then wait for the controller to resume any unfinished work.`;
export const RESUME_TEXT = `${RESUME_PREFIX} continue the existing assignment from your saved next action. Check for results from existing subagents before assigning duplicate work. Preserve any user stop, pause, or request for input.`;
export const DEFER_TEXT = `${PAUSE_PREFIX} no compaction occurred. Continue the existing unfinished assignment from your saved next action and resolve any outstanding result before changing phases. Check existing subagent results before assigning duplicate work. Preserve any user stop, pause, or request for input.`;

const stamp = s => `${s.userEpoch}:${s.compactionGeneration}`;
const usage = s => s.usage ?? { inputTokens: s.inputTokens, contextWindow: s.modelContextWindow, recentGrowthTokens: s.recentGrowthTokens ?? 0 };
const chronology = s => ({
  latestAssistantSequence: s.messages?.findLast(m => m.role === 'assistant')?.sequence ?? null,
  latestOmittedActivitySequence: s.latestOmittedActivity?.sequence ?? null,
});
const assistantReport = (s, turnId) => s.messages?.findLast(m => m.role === 'assistant' && m.turnId === turnId) ?? null;
const finalReport = (s, p) => {
  const afterNotice = report => (report?.turnId === p.turnId || p.continuedFrom?.includes(report?.turnId))
    && Number.isFinite(report.sequence) && report.sequence > (p.preNoticeReport?.sequence ?? -1);
  return s.messages?.findLast(m => afterNotice(m) && m.role === 'assistant'
    && ['final', 'final_answer'].includes(m.phase))
    ?? s.recentFinalReports?.findLast(afterNotice) ?? null;
};
const pauseEvidence = (s, p) => {
  const final = finalReport(s, p);
  return JSON.stringify([final?.sequence, final?.text, s.latestOmittedActivity?.sequence,
    s.messages?.findLast(m => m.role === 'assistant')?.sequence]);
};
const PAUSE_RETRY_LIMIT = 2;
const evaluationKey = s => `${stamp(s)}:${s.requests}:${s.messages?.findLast(m => m.role === 'assistant')?.sequence ?? ''}:${s.turnStatus}`;
const cancelled = () => Object.assign(new Error('Controller action cancelled'), { code: 'action-cancelled' });
const controlText = (prefix, body, fallback, context) => body == null ? fallback : `${prefix} ${renderMessageTemplate(body, context)}`;

/** Scheduling is driven by transcript changes and lifecycle hooks, never a polling loop. */
export class Controller extends EventEmitter {
  constructor({ reader, codex, evaluate, decide, config = {}, templateContext = {}, now = Date.now }) {
    super();
    Object.assign(this, { reader, codex, evaluate, decide, config, templateContext, now });
    this.state = 'observing';
    this.pending = null;
    this.evaluation = null;
    this.lastEvaluation = '';
    this.identityGate = { checks: 0, blocked: 0 };
    this.closed = false;
    this.log = [];
    this.observedGeneration = reader.snapshot().compactionGeneration;
    this.onChange = () => {
      const s = this.reader.snapshot();
      if (s.compactionGeneration > this.observedGeneration) {
        this.diagnose('native-compaction-observed', {
          origin: this.state === 'compacting' ? 'during-jevpact-operation' : 'external',
          previousGeneration: this.observedGeneration,
        }, s);
      }
      this.observedGeneration = s.compactionGeneration;
      this.adoptObservedCompaction(s);
      if (this.pending?.delivered && !s.supported && !s.userStopped && s.userEpoch === this.pending.userEpoch) {
        if (this.state !== 'recovery-required') this.recover(this.pending, { code: 'transcript-unavailable' }, 'paused-observation');
      } else if (this.pending && (!s.supported || s.userStopped || s.userEpoch !== this.pending.userEpoch)) {
        this.invalidate('new direction, stop, or unavailable transcript');
      } else if (this.continuationFollowsPause(s)) {
        // T3 opens a run for background activity after a turn ends. No one gave new direction, so the pause stands.
        (this.pending.continuedFrom ??= []).push(this.pending.turnId);
        this.pending.turnId = s.turnId;
      } else if (this.selectedTurnChanged(s)) {
        if (this.pending.delivered) this.countLostPause(s);
        this.invalidate('selected turn changed');
      }
      this.wake();
    };
    reader.on('change', this.onChange);
  }

  continuationFollowsPause(s) {
    const p = this.pending;
    return !!p?.delivered && !!s.runContinuation && !(p.operationId && p.adoptedCompaction)
      && ['awaiting-idle', 'checking-pause'].includes(this.state) && s.turnId != null && s.turnId !== p.turnId;
  }

  countLostPause(s) {
    const count = this.lostPauses?.stamp === stamp(s) ? this.lostPauses.count + 1 : 1;
    this.lostPauses = { stamp: stamp(s), count };
  }

  selectedTurnChanged(s) {
    const p = this.pending;
    if (p?.operationId && s.runMessageObserved === false) return false;
    return p && !(p.operationId && p.adoptedCompaction) && ['awaiting-idle', 'checking-pause'].includes(this.state)
      && s.turnId != null && s.turnId !== p.turnId;
  }

  adoptObservedCompaction(s) {
    const p = this.pending;
    if (!p?.operationId || !p.delivered || !['awaiting-idle', 'checking-pause'].includes(this.state)) return;
    const sameWork = s.turnId === p.turnId || (s.maintenanceRunId && s.workRunId === p.turnId);
    if (!sameWork || (!s.maintenanceRunId && s.compactionGeneration <= p.generation)) return;
    if (!p.adoptedCompaction) this.record('native-compaction-adopted', { turnId: p.turnId, origin: 't3' });
    p.adoptedCompaction = true;
    p.lastBeforeCompaction ??= assistantReport(s, p.turnId)?.text ?? null;
  }

  pauseIsIdle(s, p) {
    if (s.turnStatus !== 'idle') return false;
    if (!p.operationId || !p.adoptedCompaction) return s.turnId === p.turnId;
    return s.compactionGeneration > p.initialGeneration && s.compactionRunStatus === 'completed';
  }

  record(event, details = {}) {
    const item = { time: this.now(), event, ...details };
    this.log.push(item);
    if (this.log.length > 64) this.log.shift();
    this.emit('decision', item);
    this.diagnose(event, item);
  }

  diagnose(event, details = {}, s = this.reader.snapshot()) {
    this.emit('diagnostic', { time: this.now(), event, evaluationId: this.pending?.evaluationId ?? null,
      context: { turnId: s.turnId, turnStatus: s.turnStatus, revision: s.revision,
        userEpoch: s.userEpoch, compactionGeneration: s.compactionGeneration,
        requests: s.requests, requestsSinceCompaction: s.requestsSinceCompaction,
        usage: usage(s), baselineInputTokens: s.baselineInputTokens, chronology: chronology(s) }, ...details });
  }

  skip(reason, s) {
    const key = `${reason}:${evaluationKey(s)}`;
    if (key !== this.lastSkip) {
      this.lastSkip = key;
      this.diagnose('skipped', { reason }, s);
    }
  }

  async assess(s, { signal, purpose = 'timing2', packet }) {
    const evaluationId = randomUUID();
    this.diagnose('evaluation-started', { evaluationId, purpose,
      policy: { ...DEFAULT_POLICY, ...this.config } }, s);
    try {
      const evidence = packet ?? (purpose === 'timing2' ? s.timingPacket : s.packet);
      const result = await this.evaluate(evidence, { signal, purpose,
        onRequest: request => this.diagnose('jev-request', { evaluationId, purpose, request }, s) });
      this.diagnose('evaluation-completed', { evaluationId, purpose, model: result.model,
        answers: result.answers, providerUsage: result.usage, latencyMs: result.latencyMs,
        response: result.response }, s);
      return { ...result, evaluationId };
    } catch (error) {
      this.diagnose('evaluation-failed', { evaluationId, purpose, reason: error.code ?? error.name ?? 'Error' }, s);
      throw error;
    }
  }

  view() {
    const s = this.reader.snapshot();
    return { sessionId: s.sessionId, state: this.state, supported: s.supported,
      mode: this.config.mode ?? 'automatic', configPending: !!this.nextConfig,
      identityGate: { ...this.identityGate },
      disabledReason: s.disabledReason, usage: usage(s), requestsSinceCompaction: s.requestsSinceCompaction,
      pendingTurnId: this.pending?.turnId ?? null, recoveryRequired: this.pending?.failure ?? null, decisions: this.log };
  }

  reconfigure(config) {
    if (this.pending?.delivered) {
      this.nextConfig = config;
      return { applied: false, deferred: true };
    }
    if (this.pending) this.invalidate('configuration changed');
    this.config = config;
    this.nextConfig = null;
    this.lastEvaluation = '';
    this.wake();
    return { applied: true, deferred: false };
  }

  applyDeferredConfig() {
    if (this.nextConfig && !this.pending) this.reconfigure(this.nextConfig);
  }

  invalidate(reason) {
    this.codex.endOperation?.(this.reader.snapshot().sessionId);
    this.evaluation?.abort();
    this.evaluation = null;
    this.pending?.abort.abort();
    this.cancelCompletion?.();
    this.pending = null;
    this.state = 'observing';
    this.record('cancelled', { reason });
    if (this.nextConfig) {
      this.config = this.nextConfig;
      this.nextConfig = null;
      this.lastEvaluation = '';
      this.wake();
    }
  }

  hook(event) {
    if (this.closed) return {};
    const s = this.reader.snapshot();
    if (event.session_id !== s.sessionId) return {};
    if (['PreCompact', 'PostCompact', 'Interrupt'].includes(event.hook_event_name)) {
      this.diagnose('hook', { hook: event.hook_event_name, trigger: event.trigger ?? null });
    }
    if (event.hook_event_name === 'Interrupt') {
      this.stopped = true;
      this.invalidate('user interrupt');
    } else if (event.hook_event_name === 'UserPromptSubmit' && !event.controllerMessage) {
      this.stopped = false;
      // The new direction is part of the transcript; reassess the updated state now rather
      // than discarding the evaluation and treating the stale state as already assessed.
      this.invalidate('new user direction');
      this.lastEvaluation = '';
      this.wake();
    } else if (event.hook_event_name === 'PreCompact' && this.state !== 'compacting') {
      // A native compaction after the pause reached the worker does the job the
      // pause asked for. Keep owning the paused worker so it is not stranded.
      if (this.pending?.delivered && this.state === 'awaiting-idle' && this.isPending(this.pending)) {
        this.pending.adoptedCompaction = true;
        this.pending.lastBeforeCompaction = s.messages?.findLast(message => message.role === 'assistant')?.text ?? null;
        this.record('native-compaction-adopted', { turnId: this.pending.turnId, trigger: event.trigger ?? null });
      } else this.invalidate('native or manual compaction');
    }

    return {};
  }

  wake() {
    if (this.closed) return;
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => this.tick().catch(e => this.fail(e)), this.config.debounceMs ?? 80);
  }

  fail(error) {
    if (this.state === 'recovery-required') return;
    this.evaluation?.abort();
    this.evaluation = null;
    if (this.pending?.delivered && this.isPending(this.pending)) {
      this.recover(this.pending, error, 'paused-observation');
      return;
    }
    if (this.pending) this.codex.endOperation?.(this.reader.snapshot().sessionId);
    this.pending?.abort.abort();
    this.cancelCompletion?.();
    this.pending = null;
    this.state = 'observing';
    // Transport/model errors must never include arbitrary response bodies or credentials.
    this.record('unavailable', { reason: error?.code ?? error?.name ?? 'Error' });
  }

  async tick() {
    if (this.closed) return;
    if (this.busy) { this.needsWake = true; return; }
    this.busy = true;
    try {
      await this.reader.refresh();
      const s = this.reader.snapshot();
      if (!s.supported || this.stopped || s.userStopped) {
        this.skip(!s.supported ? s.disabledReason ?? 'unsupported-transcript' : 'user-stopped', s);
        if (this.pending?.delivered && !s.supported && !this.stopped && !s.userStopped && s.userEpoch === this.pending.userEpoch) {
          if (this.state !== 'recovery-required') this.recover(this.pending, { code: 'transcript-unavailable' }, 'paused-observation');
        } else if (this.pending) this.invalidate('stopped or unavailable transcript');
        return;
      }
      if (this.config.mode === 'off') { this.skip('configuration-off', s); return; }
      if (!this.pending && s.modelRequestIdentityAvailable !== undefined) this.identityGate.checks++;
      if (!this.pending && s.modelRequestIdentityAvailable === false) {
        this.identityGate.blocked++;
        this.skip('model-request-identity-unavailable', s); return;
      }
      if (!this.pending && this.codex.canMaintainAutomatically?.(s.sessionId) === false) {
        this.skip('t3-writes-not-enabled', s); return;
      }
      if (this.state === 'recovery-required') {
        // A failed/ambiguous operation must not silently strand a paused worker or
        // cause a second blind mutation. Only a new user direction releases it.
        if (s.userEpoch === this.pending.userEpoch) return;
        this.invalidate('new direction after unavailable action');
      }
      if (this.pending?.adoptedCompaction && this.pending.stamp !== stamp(s) && this.state === 'awaiting-idle'
        && s.userEpoch === this.pending.userEpoch && s.compactionGeneration > this.pending.generation) {
        this.pending.stamp = stamp(s);
        this.pending.generation = s.compactionGeneration;
      }
      if (this.pending && this.pending.stamp !== stamp(s) && this.state !== 'compacting') {
        if (this.pending.delivered && s.userEpoch === this.pending.userEpoch) {
          this.recover(this.pending, { code: 'compaction-changed-after-pause' }, 'paused-observation');
          return;
        }
        this.invalidate('direction or compaction changed');
      }
      if (this.state === 'compacting') return;
      if (this.state === 'awaiting-idle') {
        if (this.pauseIsIdle(s, this.pending)) await this.afterPause(s);
        return;
      }
      const u = usage(s);
      if (!(u.inputTokens >= (this.config.minInputTokens ?? DEFAULT_POLICY.minInputTokens)) || !u.contextWindow) {
        this.skip(!u.contextWindow ? 'context-capacity-unavailable' : 'below-input-floor', s); return;
      }
      if (s.requestsSinceCompaction < (this.config.minRequests ?? DEFAULT_POLICY.minRequests)) {
        this.skip('insufficient-requests-since-compaction', s); return;
      }
      if (!Number.isFinite(s.baselineInputTokens)
        || u.inputTokens - s.baselineInputTokens < (this.config.minGrowthTokens ?? DEFAULT_POLICY.minGrowthTokens)) {
        this.skip('insufficient-growth-since-compaction', s); return;
      }
      const fingerprint = evaluationKey(s);
      if (fingerprint === this.lastEvaluation) return;
      this.lastEvaluation = fingerprint;
      const policyInput = { usage: u, baseline: { inputTokens: s.baselineInputTokens ?? 0 },
        requestsSinceCompact: s.requestsSinceCompaction, turnStatus: s.turnStatus,
        chronology: chronology(s), timing: s.timingMetadata, config: this.config };
      let decision = this.decide(policyInput);
      if (decision.kind !== 'pressure' && s.turnStatus === 'active'
        && !s.messages?.some(message => message.role === 'assistant' && message.turnId === s.turnId)) {
        this.skip('no-current-turn-assistant-evidence', s); return;
      }
      const deferred = this.deferredBaseline;
      if (decision.kind !== 'pressure' && deferred?.stamp === stamp(s)
        && (s.requests - deferred.requests < (this.config.minRequests ?? DEFAULT_POLICY.minRequests)
          || u.inputTokens - deferred.inputTokens < (this.config.minGrowthTokens ?? DEFAULT_POLICY.minGrowthTokens))) {
        this.skip('waiting-for-fresh-work-after-deferral', s); return;
      }
      let result = null;
      // Headroom is deterministic: a running request cannot make this fallback
      // depend on receiving a fresh semantic classification first.
      if (decision.requiresSignals !== false && (decision.action !== 'checkpoint' || decision.kind !== 'pressure')) {
        this.state = 'evaluating';
        const abort = this.evaluation = new AbortController();
        result = await this.assess(s, { signal: abort.signal });
        if (this.closed || abort.signal.aborted) return;
        await this.reader.refresh();
        const fresh = this.reader.snapshot();
        if (fresh.revision !== s.revision || stamp(fresh) !== stamp(s) || this.stopped || fresh.userStopped) {
          this.state = 'observing';
          this.record('stale-analysis', { evaluationId: result.evaluationId });
          this.wake();
          return;
        }
        decision = this.decide({ ...policyInput, signals: result.answers });
      }
      this.record('assessed', { ...decision, usage: u, chronology: policyInput.chronology,
        evaluationId: result?.evaluationId ?? null, signals: result?.answers ?? null, latencyMs: result?.latencyMs ?? null });
      this.state = 'observing';
      if (decision.action !== 'checkpoint') return;
      if (this.config.mode === 'observe') {
        this.record('would-checkpoint', { kind: decision.kind, reason: decision.reason });
        return;
      }
      if (s.turnStatus === 'active' && this.lostPauses?.stamp === stamp(s) && this.lostPauses.count >= PAUSE_RETRY_LIMIT) {
        this.skip('pause-retry-limit', s); return;
      }
      let operationId;
      if (typeof this.codex.beginOperation === 'function') {
        const isCurrent = () => this.maintenanceIsCurrent(s) && (this.config.mode ?? 'automatic') === 'automatic';
        operationId = await this.codex.beginOperation(s.sessionId, { isCurrent });
        if (!isCurrent()) { this.codex.endOperation(s.sessionId); return; }
      }
      this.pending = { turnId: s.turnId, stamp: stamp(s), generation: s.compactionGeneration,
        operationId, initialGeneration: s.compactionGeneration,
        evaluationId: result?.evaluationId ?? null,
        revision: s.revision, createdAt: this.now(), kind: decision.kind, reason: decision.reason,
        templateContext: { ...this.templateContext }, delivered: false,
        preNoticeReport: assistantReport(s, s.turnId),
        userEpoch: s.userEpoch, abort: new AbortController() };
      if (s.turnStatus === 'idle') await this.compact(s, false);
      else if (s.turnStatus === 'active') await this.requestPause(s);
    } finally {
      this.evaluation = null;
      this.busy = false;
      this.applyDeferredConfig();
      if (!this.pending) this.emit('quiescent');
      if (this.needsWake && !this.closed) { this.needsWake = false; this.wake(); }
    }
  }

  maintenanceIsCurrent(s) {
    const current = this.reader.snapshot();
    return !this.closed && !this.stopped && current.supported && !current.userStopped
      && current.turnId === s.turnId && stamp(current) === stamp(s);
  }

  async requestMaintenance({ resume = false } = {}) {
    if (typeof this.codex.beginOperation !== 'function') throw Object.assign(new Error('Explicit maintenance unavailable'), { code: 'explicit-maintenance-unavailable' });
    if (this.closed || this.stopped || this.config.mode === 'off') throw cancelled();
    if (this.pending || this.busy) throw Object.assign(new Error('A controller action is in progress'), { code: 'action-in-progress' });
    const s = this.reader.snapshot();
    const isCurrent = () => this.maintenanceIsCurrent(s);
    if (!isCurrent()) throw cancelled();
    this.busy = true;
    let operationId;
    try { operationId = await this.codex.beginOperation(s.sessionId, { isCurrent }); }
    finally { this.busy = false; }
    if (!isCurrent()) { this.codex.endOperation(s.sessionId); throw cancelled(); }
    this.pending = { explicit: true, operationId, turnId: s.turnId, stamp: stamp(s), generation: s.compactionGeneration,
      initialGeneration: s.compactionGeneration, evaluationId: null, revision: s.revision, createdAt: this.now(), kind: 'explicit', reason: 'explicit-maintenance',
      templateContext: { ...this.templateContext }, delivered: false, preNoticeReport: assistantReport(s, s.turnId),
      userEpoch: s.userEpoch, abort: new AbortController() };
    this.explicitTask = this.startMaintenance(s, resume);
    this.explicitTask.catch(error => { if (this.pending) this.recover(this.pending, error, 'explicit-maintenance'); });
    return { requested: true, operationId };
  }

  async startMaintenance(s, resume) {
    this.busy = true;
    try {
      if (s.turnStatus === 'active') await this.requestPause(s);
      else if (s.turnStatus === 'idle') await this.compact(s, resume);
      else throw Object.assign(new Error('Unknown thread state'), { code: 'thread-state-unknown' });
    } finally {
      this.busy = false;
      if (!this.pending) this.codex.endOperation?.(s.sessionId);
      if (this.needsWake && !this.closed) { this.needsWake = false; this.wake(); }
    }
  }

  async requestPause(s) {
    const p = this.pending;
    this.state = 'awaiting-idle';
    this.reader.markPrompted?.(p.turnId);
    const isCurrent = () => {
      const current = this.reader.snapshot();
      return this.isPending(p) && current.supported && !current.userStopped
        && current.turnStatus === 'active' && current.turnId === p.turnId && stamp(current) === p.stamp;
    };
    try {
      const message = controlText(PAUSE_PREFIX, this.config.pauseMessage, PAUSE_TEXT,
        { ...p.templateContext, snapshot: this.reader.snapshot(), phase: 'pause', reason: p.reason, trigger: p.kind });
      await this.whilePending(p, () => this.codex.steer(s.sessionId, p.turnId, message, { isCurrent }));
      if (!this.isPending(p)) return;
      p.delivered = true;
      this.record('pause-delivered', { turnId: p.turnId, kind: p.kind, transport: 'native-message' });
    } catch (error) {
      if (!this.isPending(p) || error?.code === 'action-cancelled') return;
      if (error?.ambiguous) {
        p.delivered = true;
        this.recover(p, error, 'pause-message');
      } else this.fail(error);
    }
  }

  isPending(p) {
    return !this.closed && this.pending === p && !p.abort.signal.aborted && !this.stopped;
  }

  async whilePending(p, operation) {
    if (!this.isPending(p)) throw cancelled();
    let abort;
    const cancellation = new Promise((_, reject) => {
      abort = () => reject(cancelled());
      p.abort.signal.addEventListener('abort', abort, { once: true });
    });
    try { return await Promise.race([operation(), cancellation]); }
    finally { p.abort.signal.removeEventListener('abort', abort); }
  }

  async afterPause(s) {
    const p = this.pending;
    if (!p?.delivered || !this.isPending(p)) return;
    const final = finalReport(s, p);
    if (!final?.text?.trim() || final.truncated || final.text.startsWith('[earlier text omitted]')) {
      this.recover(p, { code: 'pause-wrapup-unavailable' }, 'pause-readiness');
      return;
    }
    const evidenceGap = s.latestOmittedActivity?.sequence > final.sequence;
    const packet = {
      source: 'codex-visible-post-pause',
      preNoticeReport: p.preNoticeReport && { text: p.preNoticeReport.text, sequence: p.preNoticeReport.sequence },
      finalWrapUp: { text: final.text, sequence: final.sequence },
      opaqueActivityAfterFinal: !!evidenceGap,
    };
    this.state = 'checking-pause';
    try {
      const result = await this.whilePending(p, () => this.assess(s, { signal: p.abort.signal, purpose: 'pause', packet }));
      await this.reader.refresh();
      if (!this.isPending(p)) return;
      const fresh = this.reader.snapshot();
      if (p.operationId && p.adoptedCompaction && (!this.pauseIsIdle(fresh, p) || stamp(fresh) !== p.stamp)) {
        this.state = 'awaiting-idle'; return;
      }
      if (fresh.runContinuation && fresh.turnStatus === 'active' && stamp(fresh) === p.stamp && fresh.supported && !fresh.userStopped) {
        this.state = 'awaiting-idle'; return;
      }
      if (stamp(fresh) !== p.stamp || fresh.turnStatus !== 'idle' || !fresh.supported || fresh.userStopped) {
        throw Object.assign(new Error('Pause state changed'), { code: 'pause-state-changed' });
      }
      const deferral = result.answers?.deferral?.choice ?? 'unknown';
      const continuation = result.answers?.continuation?.choice ?? 'unknown';
      const freshFinal = finalReport(fresh, p);
      p.pauseWrapUp = freshFinal?.text ?? final.text;
      const freshEvidenceGap = fresh.latestOmittedActivity?.sequence > (freshFinal?.sequence ?? -1);
      // T3 revisions advance on every event, including trailing ones after a turn ends.
      const changed = pauseEvidence(fresh, p) !== pauseEvidence(s, p);
      this.record('pause-checked', { kind: p.kind, deferral, continuation, changed, evidenceGap: !!freshEvidenceGap,
        evaluationId: result.evaluationId, checkpointEvaluationId: p.evaluationId,
        latencyMs: result.latencyMs });
      if (changed) throw Object.assign(new Error('Continuation evidence changed during the pause check'), { code: 'pause-continuation-stale' });
      if (!['yes', 'no'].includes(deferral)) throw Object.assign(new Error('Deferral answer is unknown'), { code: 'deferral-uncertain' });
      if (!['yes', 'no'].includes(continuation)) throw Object.assign(new Error('Continuation answer is unknown'), { code: 'continuation-uncertain' });
      if (p.adoptedCompaction) {
        // Native compaction already ran; never request a second one.
        if (continuation === 'yes') await this.continueWithoutCompaction(fresh, p);
        else {
          this.record('compacted', { kind: p.kind, origin: 'native' });
          this.codex.endOperation?.(s.sessionId);
          this.pending = null;
          this.state = 'observing';
          this.lastEvaluation = evaluationKey(fresh);
        }
        return;
      }
      if (deferral === 'yes' || (freshEvidenceGap && p.kind !== 'pressure')) {
        p.deferralReason = deferral === 'yes' ? 'agent-deferred-compaction' : 'opaque-activity-after-final';
        this.record('checkpoint-withdrawn', { reason: p.deferralReason });
        if (continuation === 'yes') await this.continueWithoutCompaction(fresh, p);
        else {
          this.codex.endOperation?.(s.sessionId);
          this.pending = null;
          this.state = 'observing';
          this.lastEvaluation = evaluationKey(fresh);
        }
        return;
      }
      if (freshEvidenceGap) this.record('pressure-fallback', { reason: 'headroom decision retained despite opaque activity' });
      await this.compact(fresh, continuation === 'yes');
    } catch (error) {
      if (this.isPending(p) && error?.code !== 'action-cancelled') this.recover(p, error, 'pause-check-or-continuation');
    }
  }

  async continueWithoutCompaction(s, p) {
    if (!p.delivered || !this.isPending(p)) return;
    const native = await this.whilePending(p, () => this.codex.status(s.sessionId));
    await this.reader.refresh();
    const isCurrent = () => {
      const current = this.reader.snapshot();
      return this.isPending(p) && current.supported && !current.userStopped
        && current.turnStatus === 'idle' && current.turnId === s.turnId && stamp(current) === stamp(s);
    };
    if (!isCurrent()) throw Object.assign(new Error('Continuation is no longer available'), { code: 'continuation-not-current' });
    if (native.status !== 'idle' || native.goalStatus === 'active') {
      throw Object.assign(new Error('Native thread is not idle'), { code: 'native-thread-not-idle' });
    }
    if (native.lastTurnId !== s.turnId) throw Object.assign(new Error('Native turn changed'), { code: 'stale-turn' });
    // Starting this continuation changes the native turn by design. Keep that
    // transition distinct from an unexpected change to the paused work.
    this.state = 'continuing';
    const adopted = !!p.adoptedCompaction;
    if (!adopted) this.deferredBaseline = { stamp: stamp(s), requests: s.requests, inputTokens: usage(s).inputTokens };
    const message = adopted
      ? controlText(RESUME_PREFIX, this.config.resumeMessage, RESUME_TEXT,
        { ...p.templateContext, snapshot: s, phase: 'resume', reason: 'native-compaction-complete',
          trigger: p.kind, pauseWrapUp: p.pauseWrapUp, lastBeforeCompaction: p.lastBeforeCompaction,
          compactionGeneration: s.compactionGeneration })
      : controlText(PAUSE_PREFIX, this.config.deferMessage, DEFER_TEXT,
        { ...p.templateContext, snapshot: s, phase: 'defer', reason: p.deferralReason, trigger: p.kind,
          pauseWrapUp: p.pauseWrapUp });
    await this.whilePending(p, () => this.codex.resume(s.sessionId, message, {
      expectedTurnId: native.lastTurnId, isCurrent,
    }));
    if (!this.isPending(p)) return;
    this.record(adopted ? 'resumed' : 'continued-without-compaction', adopted ? { origin: 'native-compaction' } : {});
    this.codex.endOperation?.(s.sessionId);
    this.pending = null;
    this.state = 'observing';
    // Reuse the normal request/growth cadence from this deferred checkpoint.
    // A new turn or an acknowledgement alone is not fresh working evidence.
    this.lastEvaluation = evaluationKey(s);
  }

  recover(p, error, stage, ambiguous = error?.ambiguous === true) {
    p.abort.abort();
    this.cancelCompletion?.();
    p.failure = { reason: error?.code ?? error?.name ?? 'Error', stage, ambiguous,
      continuationMayBePaused: p.delivered,
      action: 'Inspect the native thread and continue explicitly if unfinished.' };
    this.state = 'recovery-required';
    this.record('recovery-required', p.failure);
  }

  async compact(s, resume) {
    const p = this.pending;
    if (!p || p.stamp !== stamp(s) || this.stopped || s.userStopped || s.turnStatus !== 'idle') return;
    this.state = 'compacting';
    let completion;
    let stage = 'before-compaction';
    try {
      if (p.operationId && p.continuedFrom?.length && !p.operationRenewed) {
        // T3 binds an operation to its run, so a followed continuation needs a new one.
        this.codex.endOperation(s.sessionId);
        p.operationId = await this.whilePending(p, () => this.codex.beginOperation(s.sessionId, { isCurrent: () => this.isPending(p) }));
        p.operationRenewed = true;
      }
      const before = await this.whilePending(p, () => this.codex.status(s.sessionId));
      await this.reader.refresh();
      const current = this.reader.snapshot();
      if (!this.isPending(p)) return;
      if (!current.supported || stamp(current) !== p.stamp || current.turnStatus !== 'idle' || current.userStopped) {
        if (current.userStopped || current.userEpoch !== p.userEpoch) {
          this.invalidate('changed before compaction');
          return;
        }
        throw Object.assign(new Error('State changed before compaction'), { code: 'changed-before-compaction' });
      }
      p.preCompactionSnapshot = current;
      p.lastBeforeCompaction = current.messages?.findLast(message => message.role === 'assistant')?.text ?? null;
      const isCurrent = () => {
        const snapshot = this.reader.snapshot();
        return this.isPending(p) && snapshot.supported && !snapshot.userStopped
          && stamp(snapshot) === p.stamp && snapshot.turnStatus === 'idle';
      };
      // Subscribe before dispatch so a quick completion cannot be missed.
      completion = this.compactionCompletion(s.compactionGeneration);
      stage = 'compaction-request';
      await this.whilePending(p, () => this.codex.compact(s.sessionId, { expectedTurnId: before.lastTurnId, isCurrent }));
      if (!this.isPending(p)) return;
      this.record('compaction-requested', { resume });
      // Only actual native completion authorizes resumption; an RPC ack is insufficient.
      stage = 'compaction-completion';
      await this.whilePending(p, () => completion.promise);
      await this.reader.refresh();
      const after = this.reader.snapshot();
      if (!this.isPending(p)) return;
      if (!after.supported) throw Object.assign(new Error('Transcript unavailable'), { code: 'transcript-unavailable' });
      if (!after.supported || after.userStopped || after.userEpoch !== s.userEpoch || after.turnStatus !== 'idle') {
        this.record('left-idle', { reason: 'new activity or stop after compaction' });
        return;
      }
      this.record('compacted', { kind: p.kind });
      if (resume) {
        stage = 'before-resume';
        const context = await this.whilePending(p, () => this.codex.status(s.sessionId));
        const resumeCurrent = () => {
          const snapshot = this.reader.snapshot();
          return this.isPending(p) && snapshot.supported && !snapshot.userStopped
            && snapshot.userEpoch === s.userEpoch && snapshot.turnStatus === 'idle'
            && snapshot.compactionGeneration === after.compactionGeneration;
        };
        if (!resumeCurrent()) {
          if (this.isPending(p)) throw Object.assign(new Error('Continuation is no longer available'), { code: 'continuation-not-current' });
          return;
        }
        stage = 'resume-request';
        const message = controlText(RESUME_PREFIX, this.config.resumeMessage, RESUME_TEXT,
          { ...p.templateContext, snapshot: p.preCompactionSnapshot, phase: 'resume',
            reason: 'native-compaction-complete', trigger: p.kind, pauseWrapUp: p.pauseWrapUp,
            lastBeforeCompaction: p.lastBeforeCompaction, compactionGeneration: after.compactionGeneration });
        await this.whilePending(p, () => this.codex.resume(s.sessionId, message, {
          expectedTurnId: context.lastTurnId,
          isCurrent: resumeCurrent,
        }));
        if (!this.isPending(p)) return;
        this.record('resumed');
      }
    } catch (error) {
      if (!this.isPending(p) || error?.code === 'action-cancelled') return;
      const ambiguous = error?.ambiguous === true || stage === 'compaction-completion';
      const reason = error?.code ?? error?.name ?? 'Error';
      if (p.delivered || ambiguous) {
        this.recover(p, error, stage, ambiguous);
      } else this.record('unavailable', { reason });
    } finally {
      completion?.cancel();
      if (this.cancelCompletion === completion?.cancel) this.cancelCompletion = null;
      if (this.pending === p && this.state !== 'recovery-required') {
        this.codex.endOperation?.(s.sessionId);
        this.pending = null;
        this.state = 'observing';
      }
    }
  }

  compactionCompletion(generation) {
    let cancel;
    const promise = new Promise((resolve, reject) => {
      let settled = false;
      const finish = error => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.reader.off('change', check);
        error ? reject(error) : resolve();
      };
      const check = () => {
        const s = this.reader.snapshot();
        if (s.compactionGeneration > generation && s.turnStatus === 'idle'
          && (this.codex.capabilities?.explicitMaintenance !== true || s.compactionRunStatus === 'completed')) finish();
      };
      const timer = setTimeout(() => finish(Object.assign(new Error('No compaction completion'), { code: 'compaction-timeout' })), this.config.compactionTimeoutMs ?? 300000);
      cancel = () => finish(cancelled());
      this.reader.on('change', check);
      this.cancelCompletion = cancel;
      check();
    });
    // An RPC failure can discard the wait; never leak an unhandled rejection.
    promise.catch(() => {});
    return { promise, cancel };
  }

  close() {
    this.codex.endOperation?.(this.reader.snapshot().sessionId);
    this.closed = true;
    clearTimeout(this.debounce);
    this.evaluation?.abort();
    this.pending?.abort.abort();
    this.cancelCompletion?.();
    this.reader.off('change', this.onChange);
  }
}
