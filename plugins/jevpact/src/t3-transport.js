import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { T3Rpc, t3Error } from './t3-rpc.js';

const sameIdentity = (left, right) => left.providerInstanceId === right.providerInstanceId
  && left.providerThreadId === right.providerThreadId && left.providerSessionId === right.providerSessionId
  && ['driver', 'nativeId', 'strength', 'fingerprint', 'ordinal'].every(key => left.nativeSessionRef?.[key] === right.nativeSessionRef?.[key]);

/** Maintenance is attachment-scoped, explicitly triggered, and guarded by the T3 server. */
export class T3Transport extends EventEmitter {
  constructor({ rpc, environmentId, ...options }) {
    super(); this.rpc = rpc ?? new T3Rpc(options); this.environmentId = environmentId;
    this.readers = new Map(); this.operations = new Map();
    this.capabilities = Object.freeze({ status: true, explicitMaintenance: true, automatic: false,
      compact: true, resume: true, steer: true, exactTurnSteer: true, atomicIdleMutation: true, childPreservingInterrupt: false });
  }

  async connect() {
    const config = await this.rpc.request('server.getConfig', {});
    if (config.guardedMaintenance !== 1) throw t3Error('t3-guarded-maintenance-unavailable');
    if (config.environment?.environmentId !== this.environmentId) throw t3Error('t3-environment-mismatch');
    return config;
  }

  bindReader(threadId, reader, { allowWrites = false } = {}) {
    const s = reader.snapshot();
    if (s.threadId !== threadId || s.environmentId !== this.environmentId || reader.closed) throw t3Error('t3-reader-identity-mismatch');
    this.readers.set(threadId, { reader, allowWrites: allowWrites === true });
  }

  unbindReader(threadId, reader) {
    if (this.readers.get(threadId)?.reader !== reader) return false;
    this.endOperation(threadId); return this.readers.delete(threadId);
  }

  binding(threadId, writing = false) {
    const binding = this.readers.get(threadId);
    if (!binding || binding.reader.closed) throw t3Error('t3-reader-unavailable');
    if (writing && !binding.allowWrites) throw t3Error('t3-writes-not-enabled');
    const s = binding.reader.snapshot();
    if (!s.supported || s.threadUnavailable || s.threadId !== threadId || s.environmentId !== this.environmentId) throw t3Error('t3-observation-unavailable');
    return binding;
  }

  async status(threadId) {
    const { reader } = this.binding(threadId); await reader.refresh();
    const s = reader.snapshot();
    return { status: s.turnStatus, turnId: s.turnStatus === 'active' ? s.turnId : null,
      lastTurnId: s.turnId, lastTurnStatus: s.lastTurnStatus, userEpoch: s.userEpoch,
      userStopped: s.userStopped, goalStatus: s.goalStatus, stateSource: 't3-subscription' };
  }

  async historicalCompaction(s, isCurrent) {
    if (s.compactionItemId || s.historyComplete) return s.compactionItemId;
    let cursor = s.historyCursor; const seen = new Set();
    while (cursor && !seen.has(cursor)) {
      if (isCurrent && !isCurrent()) throw t3Error('stale-action');
      seen.add(cursor);
      const page = await this.rpc.history(s.threadId, cursor);
      const item = page.items?.map(entry => entry.item ?? entry).findLast(entry => entry.type === 'compaction'
        && entry.status === 'completed' && entry.providerThreadId === s.providerThreadId);
      if (item) return item.id;
      if (page.hasMoreHistory === false) return null;
      cursor = page.nextCursor;
    }
    throw t3Error('t3-history-unavailable');
  }

  async beginOperation(threadId, { isCurrent } = {}) {
    const { reader } = this.binding(threadId, true);
    if (this.operations.has(threadId)) throw t3Error('action-in-progress');
    const s = reader.snapshot();
    await this.connect();
    const historicalCompactionId = await this.historicalCompaction(s, isCurrent);
    if (this.operations.has(threadId)) throw t3Error('action-in-progress');
    if ((isCurrent && !isCurrent()) || !sameIdentity(s, reader.snapshot())) throw t3Error('stale-action');
    if (s.userStopped || !s.runAttemptId || !s.nativeSessionRef?.nativeId || !Number.isSafeInteger(s.eventSequence)) throw t3Error('t3-guard-unavailable');
    const operation = { id: randomUUID(), original: s, observedSequence: s.eventSequence,
      workRunId: s.workRunId, historicalCompactionId, actions: new Map(), commands: new Map(), cancellations: new Set() };
    this.operations.set(threadId, operation); return operation.id;
  }

  guard(operation, s) {
    if (!sameIdentity(operation.original, s) || s.userEpoch !== operation.original.userEpoch || s.userStopped) throw t3Error('stale-action');
    return { observedSequence: operation.observedSequence, providerInstanceId: s.providerInstanceId,
      providerThreadId: s.providerThreadId, providerSessionId: s.providerSessionId, nativeThreadRef: s.nativeSessionRef,
      runId: s.runId, attemptId: s.runAttemptId, workRunId: operation.workRunId,
      compactionItemId: s.compactionItemId ?? operation.historicalCompactionId };
  }

  observationCurrent(operation, s) {
    return s.supported && !s.threadUnavailable && !s.userStopped
      && s.userEpoch === operation.original.userEpoch && sameIdentity(operation.original, s);
  }

  delivery(threadId, operation, command, isCurrent) {
    const { reader } = this.binding(threadId, true);
    let check; let cancel; let finished = false;
    const promise = new Promise((resolve, reject) => {
      const finish = (error, value) => {
        if (finished) return; finished = true; reader.off('change', check); operation.cancellations.delete(cancel);
        error ? reject(error) : resolve(value);
      };
      cancel = () => finish(t3Error('action-cancelled', command.sent === true));
      check = () => {
        const s = reader.snapshot();
        if (!this.observationCurrent(operation, s)) {
          finish(t3Error('stale-action', command.sent === true)); return;
        }
        const record = s.controlMessages?.find(message => message.id === command.messageId);
        if (!record) { if (!command.sent && isCurrent && !isCurrent()) cancel(); return; }
        if (record.maintenance.operationId !== operation.id || record.maintenance.action !== command.action) {
          finish(t3Error('t3-delivery-identity-mismatch', true)); return;
        }
        const state = record.maintenance.status;
        if (state === 'delivered') finish(null, { accepted: true, delivered: true, completed: false,
          threadId, runId: record.runId, commandId: command.commandId, messageId: command.messageId, operationId: operation.id });
        else if (state === 'rejected') finish(t3Error(record.maintenance.rejectionCode ?? 'maintenance-unavailable'));
        else if (state === 'uncertain') finish(t3Error('maintenance-ambiguous-delivery', true));
      };
      operation.cancellations.add(cancel); reader.on('change', check); check();
    });
    promise.catch(() => {});
    return { promise, check: () => check(), reject: cancel };
  }

  async send(threadId, action, text, { expectedTurnId, isCurrent } = {}) {
    const { reader } = this.binding(threadId, true);
    const operation = this.operations.get(threadId);
    if (!operation) throw t3Error('t3-operation-required');
    if (operation.actions.has(action)) return operation.actions.get(action);
    const s = reader.snapshot();
    if (expectedTurnId != null && s.turnId !== expectedTurnId) throw t3Error('stale-turn');
    if (isCurrent && !isCurrent()) throw t3Error('stale-action');
    if (action === 'pause' && s.provider !== 'codex') throw t3Error('maintenance-unsupported');
    const command = { type: 'maintenance.dispatch', threadId, commandId: randomUUID(), messageId: randomUUID(),
      operationId: operation.id, action, text, guard: this.guard(operation, s) };
    operation.commands.set(action, command);
    const task = this.dispatch(threadId, operation, command, isCurrent);
    operation.actions.set(action, task); return task;
  }

  operationCurrent(threadId, operation, isCurrent) {
    const binding = this.readers.get(threadId);
    return this.operations.get(threadId) === operation && binding?.allowWrites && !binding.reader.closed
      && this.observationCurrent(operation, binding.reader.snapshot()) && (!isCurrent || isCurrent());
  }

  async dispatch(threadId, operation, command, isCurrent) {
    const delivery = this.delivery(threadId, operation, command, isCurrent);
    const { sent, ...payload } = command;
    try {
      await this.connect();
      const current = () => this.operationCurrent(threadId, operation, isCurrent);
      if (!current()) throw t3Error('stale-action');
      command.sent = true;
      const receipt = this.rpc.request('orchestration.dispatchCommand', payload, { mutation: true, isCurrent: current });
      return await Promise.race([delivery.promise, receipt.then(() => { delivery.check(); return delivery.promise; })]);
    } catch (error) {
      delivery.reject(); throw error;
    }
  }

  async reconcile(threadId, action) {
    const { reader } = this.binding(threadId, true);
    const operation = this.operations.get(threadId);
    const command = operation?.commands.get(action);
    if (!command) throw t3Error('t3-operation-required');
    await this.connect();
    this.guard(operation, reader.snapshot());
    const task = this.dispatch(threadId, operation, command);
    operation.actions.set(action, task); return task;
  }

  steer(threadId, expectedTurnId, text, context = {}) { return this.send(threadId, 'pause', text, { ...context, expectedTurnId }); }
  compact(threadId, context = {}) { return this.send(threadId, 'compact', '/compact', context); }
  resume(threadId, text, context = {}) { return this.send(threadId, 'resume', text, context); }

  endOperation(threadId) {
    const operation = this.operations.get(threadId);
    if (!operation) return;
    for (const cancel of [...operation.cancellations]) cancel();
    this.operations.delete(threadId);
  }

  close() {
    for (const id of this.operations.keys()) this.endOperation(id);
    this.readers.clear(); this.rpc.close();
  }
}
