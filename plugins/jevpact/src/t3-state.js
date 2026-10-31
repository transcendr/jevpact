import { buildPacket } from './transcript.js';
import { buildTimingPacket, sourceRequest, finalReport } from './timing-context.js';

const ACTIVE = new Set(['preparing', 'starting', 'running', 'waiting']);
const TOOLS = new Set(['command_execution', 'dynamic_tool', 'file_change', 'file_search', 'web_search']);
const STOP = /^(?:please\s+)?(?:stop|pause|cancel|abort)(?:\s+(?:now|this|the task|the work|working|the current task))?[.!\s]*$/i;
const COLLECTION = { 'run.created': 'runs', 'run.updated': 'runs', 'message.updated': 'messages',
  'turn-item.updated': 'turnItems', 'provider-thread.updated': 'providerThreads',
  'provider-turn.updated': 'providerTurns', 'subagent.updated': 'subagents' };
const list = map => [...map.values()];
const time = value => new Date(value ?? 0).getTime() || 0;
const validNumber = value => Number.isSafeInteger(value) && value >= 0;
const text = value => typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value);
const maintenance = message => message?.role === 'user' && message.text?.trim().toLowerCase() === '/compact'
  && !(message.attachments?.length);
const bySequence = (a, b) => a.sequence - b.sequence;

/** Translate T3 records without treating agent-authored user-role messages as human direction. */
export class T3State {
  constructor({ threadId, environmentId, maxChars = 12000, maxMessages = 10 }) {
    Object.assign(this, { threadId, environmentId, maxChars, maxMessages });
    this.sequence = 0;
    this.revision = 0;
    this.userEpoch = 0;
    this.userStopped = false;
    this.directions = new Map();
    this.stops = new Set();
    this.afterSequence = null;
    this.disabledReason = 'not-open';
    this.measurements = new Map();
    this.collections = Object.fromEntries([...new Set(Object.values(COLLECTION))].map(key => [key, new Map()]));
  }

  accept(frame) {
    if (frame.kind === 'synchronized') return;
    this.lastEventType = frame.event?.type ?? frame.kind;
    if (frame.kind === 'snapshot') this.hydrate(frame);
    else if (frame.kind === 'event') this.event(frame);
    else this.disable('t3-unsupported-frame');
    this.revision++;
  }

  disable(reason) { this.disabledReason = reason; this.revision++; }

  hydrate({ projection, snapshotSequence }) {
    if (projection?.thread?.id !== this.threadId || !validNumber(snapshotSequence)) {
      this.disable('t3-thread-identity-mismatch'); return;
    }
    this.thread = projection.thread;
    const entries = [];
    for (const [name, records] of Object.entries(this.collections)) {
      records.clear();
      for (const record of projection[name] ?? []) entries.push({ name, record });
    }
    const observedAt = ({ name, record }) => name === 'messages' ? record.createdAt
      : record.tokenUsage?.updatedAt ?? record.completedAt ?? record.updatedAt ?? record.startedAt;
    entries.sort((a, b) => time(observedAt(a)) - time(observedAt(b)));
    this.measurements.clear();
    this.disabledReason = null;
    for (const { name, record } of entries) this.store(name, record);
    this.afterSequence = snapshotSequence;
  }

  event({ event, sequence }) {
    if (event?.threadId !== this.threadId || !validNumber(sequence)) {
      this.disable('t3-thread-identity-mismatch'); return;
    }
    if (this.afterSequence == null) { this.disable('t3-missing-snapshot'); return; }
    if (sequence <= this.afterSequence) return;
    this.afterSequence = sequence;
    if (event.type === 'thread.deleted') { this.disable('t3-thread-deleted'); return; }
    if (COLLECTION[event.type]) this.store(COLLECTION[event.type], event.payload);
    else if (event.type.startsWith('thread.') && event.payload?.id === this.threadId) this.thread = event.payload;
  }

  store(name, record) {
    if (!record?.id || (record.threadId != null && record.threadId !== this.threadId)
      || (name === 'providerThreads' && record.appThreadId != null && record.appThreadId !== this.threadId)) {
      this.disable('t3-record-identity-mismatch'); return;
    }
    const records = this.collections[name];
    const previous = records.get(record.id);
    const changed = !previous || previous.text !== record.text;
    const human = name === 'messages' && record.role === 'user' && record.createdBy === 'user' && !maintenance(record);
    const stop = name === 'turnItems' && record.type === 'run_interrupt_request';
    if (human && this.directions.get(record.id) !== record.text) {
      this.directions.set(record.id, record.text);
      this.userEpoch++;
      this.userStopped = STOP.test(record.text.trim());
    }
    if (stop && !this.stops.has(record.id)) {
      this.stops.add(record.id); this.userEpoch++; this.userStopped = true;
    }
    const sequence = (name === 'messages' && !changed) ? previous.sequence : ++this.sequence;
    const usage = record.tokenUsage ?? record.contextUsage;
    const previousUsage = previous?.tokenUsage ?? previous?.contextUsage;
    const completed = name === 'turnItems' && record.type === 'compaction' && record.status === 'completed';
    const firstCompletion = completed && previous?.completionSequence == null;
    if (firstCompletion) this.measurements.delete(record.providerThreadId);
    if (usage != null && JSON.stringify(usage) !== JSON.stringify(previousUsage)) {
      this.measure(record.providerThreadId ?? record.id, usage);
    }
    records.set(record.id, { ...record, sequence,
      completionSequence: firstCompletion ? sequence : previous?.completionSequence,
      usageSequence: usage != null && JSON.stringify(usage) !== JSON.stringify(previousUsage) ? sequence : previous?.usageSequence });
  }

  measure(providerThreadId, usage) {
    const input = usage.lastInputTokens ?? usage.inputTokens;
    if (!validNumber(input)) return;
    const previous = this.measurements.get(providerThreadId);
    this.measurements.set(providerThreadId, { input, baseline: previous?.baseline ?? input,
      growth: previous?.input === input ? previous.growth : Math.max(0, input - (previous?.input ?? input)) });
  }

  lifecycle() {
    const { runs, providerThreads, providerTurns, messages } = this.collections;
    const ordered = list(runs).sort((a, b) => a.ordinal - b.ordinal);
    const run = ordered.findLast(item => ACTIVE.has(item.status))
      ?? ordered.findLast(item => item.status !== 'queued') ?? ordered.at(-1);
    const provider = providerThreads.get(run?.providerThreadId ?? this.thread?.activeProviderThreadId);
    const turns = list(providerTurns).filter(item => item.providerThreadId === provider?.id);
    const turn = turns.sort((a, b) => a.ordinal - b.ordinal).at(-1);
    const work = ordered.findLast(item => !maintenance(messages.get(item.userMessageId)));
    return { run, provider, turn, work,
      isMaintenance: !!run && maintenance(messages.get(run.userMessageId)) };
  }

  visibleMessages() {
    const all = list(this.collections.messages).sort(bySequence).filter(item => item.role !== 'system' && !maintenance(item));
    const human = all.filter(item => item.role === 'user' && item.createdBy === 'user');
    const assistant = all.filter(item => item.role === 'assistant').map(item => ({ id: item.id, role: item.role,
      text: item.text.slice(-Math.min(6000, this.maxChars)), turnId: item.runId, sequence: item.sequence,
      phase: item.streaming ? 'commentary' : null, timestamp: item.createdAt, prompted: false }));
    let chars = assistant.reduce((sum, item) => sum + item.text.length, 0);
    const omissions = { messages: 0,
      chars: all.filter(item => item.role === 'assistant').reduce((sum, item) => sum + item.text.length, 0) - chars,
      opaqueContent: 0 };
    while (assistant.length > this.maxMessages || chars > this.maxChars) {
      const removed = assistant.shift(); chars -= removed.text.length;
      omissions.messages++; omissions.chars += removed.text.length;
    }
    const direction = human.at(-1);
    const normalized = item => item && ({ id: item.id, role: 'user', text: item.text.slice(-Math.min(6000, this.maxChars)),
      turnId: item.runId, sequence: item.sequence, timestamp: item.createdAt, provenance: { kind: 't3-user' } });
    return { messages: assistant, latestUserDirection: normalized(direction) ?? null,
      objective: normalized(human.findLast(item => !STOP.test(item.text.trim()))) ?? null,
      userStopped: this.userStopped, omissions,
      agentMessages: all.filter(item => item.role === 'user' && item.createdBy !== 'user').slice(-this.maxMessages)
        .map(item => ({ id: item.id, role: 'user', createdBy: item.createdBy, turnId: item.runId,
          text: item.text.slice(-Math.min(6000, this.maxChars)), sequence: item.sequence })),
      recentUserRequests: human.slice(-this.maxMessages).map(item => ({ turnId: item.runId,
        sequence: item.sequence, ...sourceRequest(item.text) })), recentFinalReports: [] };
  }

  tools() {
    const items = list(this.collections.turnItems).filter(item => TOOLS.has(item.type)).sort(bySequence);
    const calls = items.slice(-20).map(item => ({ callId: item.id, name: item.toolName ?? item.type,
      input: text(item.input ?? item.pattern).slice(0, 1200), sequence: item.sequence,
      timestamp: item.startedAt, resultObserved: item.status === 'completed' || item.status === 'failed',
      status: item.status, inputTruncated: text(item.input ?? item.pattern).length > 1200 }));
    const result = items.findLast(item => item.output != null);
    return { toolCalls: calls, lastToolResult: result ? { name: result.toolName ?? result.type,
      text: text(result.output).slice(0, 4000), truncated: text(result.output).length > 4000,
      sequence: result.sequence, timestamp: result.completedAt } : null,
    latestOmittedActivity: items.length ? { kind: 'tool-content-omitted', sequence: items.at(-1).sequence,
      timestamp: items.at(-1).updatedAt, turnId: items.at(-1).runId, interpretation: 'unknown' } : null };
  }

  snapshot() {
    const { run, provider, turn, work, isMaintenance } = this.lifecycle();
    const usageRecord = (turn?.usageSequence ?? -1) > (provider?.usageSequence ?? -1) ? turn : provider;
    const usage = usageRecord?.tokenUsage ?? usageRecord?.contextUsage;
    const rootIds = new Set(list(this.collections.providerThreads).filter(item => item.ownerNodeId == null).map(item => item.id));
    const compactions = list(this.collections.turnItems).filter(item => item.type === 'compaction'
      && item.completionSequence != null && rootIds.has(item.providerThreadId));
    const latestCompaction = compactions.filter(item => item.providerThreadId === provider?.id)
      .sort((a, b) => a.completionSequence - b.completionSequence).at(-1);
    const usageIsCurrent = !latestCompaction || usageRecord?.usageSequence > latestCompaction.completionSequence;
    const inputTokens = usageIsCurrent && validNumber(usage?.lastInputTokens ?? usage?.inputTokens)
      ? usage.lastInputTokens ?? usage.inputTokens : null;
    const visible = this.visibleMessages();
    for (const completed of list(this.collections.runs).filter(item => item.status === 'completed')) {
      const report = visible.messages.findLast(item => item.turnId === completed.id);
      if (report) { report.phase = 'final'; visible.recentFinalReports.push({ turnId: completed.id,
        sequence: report.sequence, prompted: false, ...finalReport(this.collections.messages.get(report.id).text) }); }
    }
    visible.recentFinalReports = visible.recentFinalReports.sort(bySequence).slice(-6);
    const driver = provider?.driver ?? this.thread?.defaultProvider ?? null;
    const reason = this.disabledReason ?? (driver && !['codex', 'claudeAgent'].includes(driver) ? 't3-unsupported-provider' : null);
    const snapshot = { ...visible, ...this.tools(), supported: reason == null, disabledReason: reason,
      source: 't3-visible-transcript', timingSource: 't3-visible-source-linked-timing',
      sessionId: this.threadId, threadId: this.threadId, environmentId: this.environmentId,
      eventSequence: this.afterSequence, lastEventType: this.lastEventType ?? null,
      revision: this.revision, observationMode: 't3-subscription', observationOnly: true, watchError: null,
      provider: driver, providerInstanceId: provider?.providerInstanceId ?? this.thread?.providerInstanceId ?? null,
      providerThreadId: provider?.id ?? null, providerSessionId: provider?.providerSessionId ?? null,
      nativeSessionId: provider?.nativeThreadRef?.nativeId ?? null,
      nativeSessionRefStrength: provider?.nativeThreadRef?.strength ?? null,
      providerTurnId: turn?.id ?? null, nativeTurnId: turn?.nativeTurnRef?.nativeId ?? null,
      nativeTurnRefStrength: turn?.nativeTurnRef?.strength ?? null,
      runId: run?.id ?? null, workRunId: work?.id ?? null, maintenanceRunId: isMaintenance ? run.id : null,
      turnId: run?.id ?? null, turnStatus: reason ? 'unknown' : run && ACTIVE.has(run.status) ? 'active' : this.thread ? 'idle' : 'unknown',
      lastTurnStatus: run?.status ?? null, userEpoch: this.userEpoch,
      goalStatus: provider?.goal?.status ?? null, goalStatusObserved: !!provider,
      compactionGeneration: compactions.length, compactionItemId: latestCompaction?.id ?? null,
      compactionCompletedAt: latestCompaction?.completedAt ?? null,
      requests: null, requestsSinceCompaction: null, requestCountSupported: false,
      inputTokens, modelContextWindow: validNumber(usage?.maxTokens) && usage.maxTokens > 0 ? usage.maxTokens : null,
      contextUsedTokens: usageIsCurrent && validNumber(usage?.usedTokens) ? usage.usedTokens : null,
      baselineInputTokens: inputTokens == null ? null : this.measurements.get(provider?.id)?.baseline ?? null,
      recentGrowthTokens: inputTokens == null ? 0 : this.measurements.get(provider?.id)?.growth ?? 0,
      pendingBackgroundTasks: structuredClone(provider?.pendingBackgroundTasks ?? []),
      pendingSubagents: list(this.collections.subagents).filter(item => ['pending', 'running', 'waiting'].includes(item.status))
        .map(item => ({ id: item.id, status: item.status })),
    };
    snapshot.usage = { inputTokens, contextWindow: snapshot.modelContextWindow, recentGrowthTokens: snapshot.recentGrowthTokens };
    snapshot.packet = buildPacket(snapshot, { maxChars: this.maxChars });
    const timing = buildTimingPacket(snapshot);
    snapshot.timingPacket = timing.packet; snapshot.timingMetadata = timing.metadata;
    return structuredClone(snapshot);
  }
}
