import { readFile } from 'node:fs/promises';
import { T3Rpc } from './t3-rpc.js';
import { T3Transport } from './t3-transport.js';
import { T3Reader, createT3ReaderFactory } from './t3-reader.js';

const busy = shell => !!(shell?.activeRunId || shell?.activityRunStatus || shell?.pendingBackgroundTasks?.length);
const visible = shell => shell && !shell.archivedAt && !shell.deletedAt;

class ThreadObservation {
  constructor(fleet, id) { this.fleet = fleet; this.id = id; }
  async open(handlers) {
    this.handlers = handlers;
    if (busy(this.fleet.shells.get(this.id)) && this.fleet.observed(this.id)) return this.resume();
    const shell = this.fleet.shells.get(this.id);
    const driver = this.fleet.providers.get(shell.providerInstanceId);
    handlers.onFrame({ kind: 'snapshot', snapshotSequence: this.fleet.sequence, historyCursor: null,
      hasMoreHistory: true, projection: { thread: { ...shell, defaultProvider: driver },
        runs: [], messages: [], providerThreads: [], providerTurns: [], turnItems: [], subagents: [] } });
    handlers.onFrame({ kind: 'synchronized' });
  }
  async resume() {
    if (this.closed || this.unsubscribe || this.opening) return this.opening;
    this.opening = this.fleet.rpc.subscribe('orchestration.subscribeThread', { threadId: this.id,
      acceptBoundedSnapshot: true, requestCompletionMarker: true }, this.handlers)
      .then(unsubscribe => { if (this.closed) unsubscribe(); else this.unsubscribe = unsubscribe; })
      .finally(() => { this.opening = null; });
    return this.opening;
  }
  suspend() { this.unsubscribe?.(); this.unsubscribe = null; }
  close() { this.closed = true; this.suspend(); this.fleet.observers.delete(this.id); }
}

export class T3Fleet {
  constructor({ origin, environmentId, token, runtimeFile, allowWrites = false, rpcFactory = options => new T3Rpc(options),
    schedule = setTimeout, cancel = clearTimeout }) {
    Object.assign(this, { origin, environmentId, token, runtimeFile, allowWrites, rpcFactory, schedule, cancel });
    this.shells = new Map(); this.projects = new Map(); this.observers = new Map(); this.providers = new Map();
    this.sequence = 0; this.work = Promise.resolve(); this.failures = 0; this.connected = false; this.connecting = true;
    const rpc = { request: (...args) => this.rpc.request(...args), history: (...args) => this.rpc.history(...args), close() {} };
    this.transport = new T3Transport({ rpc, environmentId });
    this.source = { ...createT3ReaderFactory({ environmentId }), remember: false, allowUnsupported: true,
      locate: async id => ({ threadId: id, cwd: this.cwd(id) }),
      create: ({ threadId }) => this.reader(threadId),
      restoring: () => this.connecting ? 1 : 0, status: () => this.status(), describe: (id, snapshot, settings) => this.describe(id, snapshot, settings),
      close: () => this.close() };
  }
  observed(id) {
    const shell = this.shells.get(id);
    return ['codex', 'claudeAgent'].includes(this.providers.get(shell?.providerInstanceId))
      && shell?.lineage?.relationshipToParent !== 'subagent';
  }
  cwd(id) {
    const shell = this.shells.get(id);
    return shell?.worktreePath ?? this.projects.get(shell?.projectId)?.workspaceRoot;
  }
  reader(id) {
    const subscription = new ThreadObservation(this, id); this.observers.set(id, subscription);
    return new T3Reader({ threadId: id, environmentId: this.environmentId, subscription });
  }
  async start(daemon) { this.daemon = daemon; await this.connect(); }
  async connect() {
    if (this.closed) return;
    this.connecting = true;
    try {
      const origin = this.runtimeFile ? JSON.parse(await readFile(this.runtimeFile, 'utf8')).origin : this.origin;
      this.rpc = this.rpcFactory({ origin, token: this.token });
      this.origin = this.rpc.origin ?? origin;
      const config = await this.rpc.request('server.getConfig', {});
      if (config.environment?.environmentId !== this.environmentId) throw Object.assign(Error(), { code: 't3-environment-mismatch' });
      this.guarded = config.guardedMaintenance === 1;
      this.activePause = config.guardedMaintenanceActivePause === true;
      this.transport.activePause = this.activePause;
      this.providers = new Map(config.providers.map(provider => [provider.instanceId, provider.driver ?? provider.kind ?? provider.instanceId]));
      this.connected = true; this.error = null;
      await this.rpc.subscribe('orchestration.subscribeShell', { requestCompletionMarker: true,
        omitIdleSubagents: false, omitOlderSettled: false }, {
        onFrame: frame => { this.work = this.work.then(() => this.frame(frame)).catch(error => this.disconnected(error)); },
        onDisconnect: error => this.disconnected(error),
      });
      await this.work; this.failures = 0;
    } catch (error) { await this.disconnected(error); }
    finally { this.connecting = false; }
  }
  async frame(frame) {
    if (this.closed || !this.connected) return;
    if (frame.kind === 'snapshot' && frame.resolvedRepositoryIdentityRoots !== undefined) {
      for (const project of frame.snapshot.projects) this.projects.set(project.id, project);
      return;
    }
    this.sequence = frame.sequence ?? frame.snapshot?.snapshotSequence ?? this.sequence;
    if (frame.kind === 'snapshot') {
      await this.loadSnapshot(frame.snapshot);
    } else if (frame.kind === 'thread.updated') {
      if (frame.location === 'archive' || !visible(frame.thread)) await this.remove(frame.thread.id);
      else { this.shells.set(frame.thread.id, frame.thread); await this.attach(frame.thread.id); }
    } else if (frame.kind === 'thread.removed') await this.remove(frame.threadId);
    else if (frame.kind === 'project.updated') this.projects.set(frame.project.id, frame.project);
    else if (frame.kind === 'project.removed') {
      this.projects.delete(frame.projectId);
      for (const shell of [...this.shells.values()]) if (shell.projectId === frame.projectId) await this.remove(shell.id);
    }
  }
  async loadSnapshot(snapshot) {
    this.projects = new Map(snapshot.projects.map(project => [project.id, project]));
    const next = new Map(snapshot.threads.filter(visible).map(shell => [shell.id, shell]));
    for (const id of this.shells.keys()) if (!next.has(id)) await this.daemon.detach(id);
    this.shells = next;
    for (const id of next.keys()) await this.attach(id);
  }
  async attach(id) {
    const entry = this.daemon.getThread(id);
    if (!entry) await this.daemon.attach(id, undefined, { allowWrites: this.allowWrites && this.guarded && this.connected && this.observed(id) });
    if (busy(this.shells.get(id)) && this.observed(id)) await this.observers.get(id)?.resume();
    else this.quiescent(id);
  }
  async remove(id) { this.shells.delete(id); await this.daemon.detach(id); }
  quiescent(id) {
    const entry = this.daemon?.getThread(id);
    if (!busy(this.shells.get(id)) && entry && !entry.controller.pending && !entry.controller.busy
      && entry.reader.snapshot().turnStatus === 'idle') this.observers.get(id)?.suspend();
  }
  async disconnected(error) {
    if (this.closed || this.disconnecting) return;
    this.disconnecting = true; this.connected = false; this.error = error.code ?? 't3-connection-failed';
    for (const binding of this.transport.readers.values()) binding.allowWrites = false;
    this.rpc?.close();
    for (const id of this.shells.keys()) await this.daemon?.detach(id);
    if (!this.closed) {
      // Match T3's connection supervisor: 1s base, 5min ceiling, half-to-full jitter.
      const ceiling = Math.min(300000, 1000 * 2 ** (++this.failures));
      this.retry = this.schedule(() => { this.retry = null; this.disconnecting = false; this.connect(); }, Math.round(ceiling / 2 * (1 + Math.random())));
    }
  }
  status() {
    return { kind: 't3', origin: this.origin, environmentId: this.environmentId, connected: this.connected,
      writeOptIn: this.allowWrites, guardedMaintenance: this.guarded === true, activePause: this.activePause === true,
      discoveredThreads: this.shells.size, detailedSubscriptions: [...this.observers.values()].filter(o => o.unsubscribe || o.opening).length,
      reason: this.reason(), error: this.error ?? null };
  }
  reason() {
    if (!this.connected) return this.error === 't3-environment-mismatch' ? 'Disconnected: the server environment does not match setup.' : 'Disconnected from T3; automatic maintenance is paused.';
    if (!this.allowWrites) return 'Read-only: writes were not enabled during T3 setup.';
    if (!this.guarded) return 'Read-only: this T3 server does not support guarded maintenance. Update the server to enable writes.';
    return 'Connected; guarded automatic maintenance is enabled.';
  }
  describe(id, snapshot, settings) {
    let reason = this.reason();
    if (settings.mode === 'off') reason = 'Disabled by the settings for this thread or project.';
    else if (!this.observed(id)) reason = 'Automatic policy is ineligible: this provider or subagent thread is not managed independently.';
    else if (this.connected && this.allowWrites && this.guarded) reason = settings.mode === 'observe'
      ? 'Read-only: the settings for this thread or project select observe mode.' : this.eligibility(id, snapshot, settings);
    const controller = this.daemon?.getThread(id)?.controller;
    if (controller?.state === 'recovery-required') reason = this.recoveryReason(controller.pending?.failure);
    return { title: this.shells.get(id)?.title ?? id, configurationThreadId: this.source.configThreadId(id), statusReason: reason,
      requestCountSupported: snapshot.requestCountSupported, modelRequestIdentityAvailable: snapshot.modelRequestIdentityAvailable, detailedObservation: !!this.observers.get(id)?.unsubscribe };
  }
  recoveryReason(failure) {
    const inspect = ' Inspect the thread before continuing.';
    if (failure?.ambiguous) return 'Automatic maintenance stopped because delivery could not be confirmed.' + inspect;
    if (failure?.reason === 't3-authorization-failed') return 'The T3 credential does not permit maintenance writes.' + inspect;
    if (failure?.reason === 'maintenance-busy') return 'T3 refused maintenance because this thread is still busy.' + inspect;
    if (['maintenance-stale-target', 'maintenance-direction-changed'].includes(failure?.reason))
      return 'The thread changed before maintenance could be delivered.' + inspect;
    if (failure?.stage === 'pause-readiness') return 'Automatic maintenance stopped because its pause assessment could not be completed.' + inspect;
    return 'Automatic maintenance needs recovery before it can continue.' + inspect;
  }
  eligibility(id, snapshot, settings = {}) {
    if (!snapshot.supported) return 'Automatic policy is ineligible: this provider or observation format is unsupported.';
    if (snapshot.providerTurnId && (!snapshot.requestCountSupported || snapshot.modelRequestIdentityAvailable === false)) return 'Automatic policy is ineligible: T3 has not supplied a native ID for the latest model request.';
    if (!this.observers.get(id)?.unsubscribe) return 'Idle; attached and awaiting native context and request IDs from new work.';
    if (!snapshot.requestCountSupported) return 'Automatic policy is ineligible: T3 has not supplied a native ID for the latest model request.';
    if (!snapshot.inputTokens || !snapshot.modelContextWindow) return 'Automatic policy is ineligible: current model context usage is unavailable.';
    return this.activityReason(snapshot) ?? this.cadenceReason(snapshot, settings);
  }
  activityReason(snapshot) {
    if (!this.activePause && snapshot.turnStatus === 'active') return 'Automatic policy is ineligible while active: this server cannot deliver a guarded pause.';
    if (snapshot.goalStatus === 'active') return 'Automatic policy is ineligible while a native goal is active.';
    if (snapshot.threadUnavailable) return 'Automatic policy is ineligible: this thread is settled, snoozed, or otherwise unavailable.';
    if (snapshot.userStopped) return 'Automatic policy is ineligible: the user stopped this assignment.';
    return null;
  }
  cadenceReason(snapshot, settings) {
    if (snapshot.inputTokens < settings.minInputTokens) return 'Automatic policy is ineligible: context usage is below the configured minimum.';
    if (snapshot.requestsSinceCompaction < settings.minRequests) return 'Automatic policy is ineligible: not enough model requests have completed since compaction.';
    if (snapshot.inputTokens - snapshot.baselineInputTokens < settings.minGrowthTokens) return 'Automatic policy is ineligible: context has not grown enough since compaction.';
    return 'Automatic policy is observing the current work and request cadence.';
  }
  async close() { this.closed = true; this.connected = false; this.cancel(this.retry); this.rpc?.close(); }
}
