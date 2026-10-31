import { EventEmitter } from 'node:events';
import { watch as watchFile } from 'node:fs';
import { open as openFile, stat } from 'node:fs/promises';
import { buildTimingPacket, finalReport, sourceRequest } from './timing-context.js';

const DEFAULT_PREFIXES = ['Jevpact context maintenance:', 'Jevpact compaction complete:'];
const TOP_LEVEL = new Set(['session_meta', 'turn_context', 'event_msg', 'response_item', 'token_usage_record', 'compacted', 'world_state', 'inter_agent_communication_metadata']);
// Item completion is not turn completion. Settings and duplicated message events
// do not replace the canonical lifecycle/response records consumed below.
const PASSIVE_EVENTS = new Set(['item_completed', 'thread_settings_applied', 'agent_message', 'agent_reasoning', 'user_message']);
const GOAL_STATUSES = new Set(['active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete']);
const STOP = /^(?:please\s+)?(?:stop|pause|cancel|abort)(?:\s+(?:now|this|the task|the work|working|the current task))?[.!\s]*$/i;
const CONTINUE = /^(?:please\s+)?(?:continue|resume|go on|proceed|yes|ok|okay|carry on|do it)[.!\s]*$/i;
const DELEGATION = /^\s*<codex_delegation>\s*<source_thread_id>([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})<\/source_thread_id>\s*<input>([\s\S]*)<\/input>\s*<\/codex_delegation>\s*$/;
const number = n => Number.isSafeInteger(n) && n >= 0;
const object = value => value != null && typeof value === 'object' && !Array.isArray(value);
const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim() === value;
const textLimit = (text, limit) => text.length <= limit ? text : `[earlier text omitted]\n${text.slice(-Math.max(0, limit - 23))}`;

/** A bounded, chronological excerpt. Tool outputs and private reasoning are never included. */
export function buildPacket(snapshot, { maxChars = 12000, maxBytes = 22000 } = {}) {
  const direction = value => value ? { text: value.text, sequence: value.sequence, timestamp: value.timestamp, provenance: value.provenance } : null;
  const state = {
    source: snapshot.source ?? 'codex-visible-transcript',
    objective: direction(snapshot.objective),
    latestUserDirection: direction(snapshot.latestUserDirection),
    messages: (snapshot.messages ?? []).map(({ role, text, sequence, timestamp, prompted }) => ({ role, text, sequence, timestamp, prompted })),
    latestOmittedActivity: snapshot.latestOmittedActivity ?? null,
    omissions: { ...(snapshot.omissions ?? {}) },
    visibility: 'Only visible text is included. Tool results and opaque incoming messages may be omitted; later chronology does not establish that a result was interpreted.',
  };
  let result = JSON.stringify(state);
  while ((result.length > maxChars || Buffer.byteLength(result) > maxBytes) && state.messages.length > 1) {
    const removed = state.messages.shift();
    state.omissions.messages = (state.omissions.messages ?? 0) + 1;
    state.omissions.chars = (state.omissions.chars ?? 0) + removed.text.length;
    result = JSON.stringify(state);
  }
  // Shrink each retained field proportionally, preserving its most recent text.
  while (result.length > maxChars || Buffer.byteLength(result) > maxBytes) {
    const fields = [state.objective?.text, state.latestUserDirection?.text, ...state.messages.map(m => m.text)];
    const largest = Math.max(...fields.map(s => s?.length ?? 0));
    if (largest < 100) return JSON.stringify({ source: state.source, omitted: true, reason: 'packet-budget-too-small' });
    const limit = Math.floor(largest * 0.75);
    if (state.objective?.text.length === largest) state.objective.text = textLimit(state.objective.text, limit);
    else if (state.latestUserDirection?.text.length === largest) state.latestUserDirection.text = textLimit(state.latestUserDirection.text, limit);
    else {
      const message = state.messages.find(m => m.text.length === largest);
      message.text = textLimit(message.text, limit);
    }
    state.omissions.chars = (state.omissions.chars ?? 0) + largest - limit;
    result = JSON.stringify(state);
  }
  return result;
}

/** Reads one hook-bound rollout incrementally; no transcript search and no polling. */
export class Transcript extends EventEmitter {
  constructor({ sessionId = null, controlPrefixes = DEFAULT_PREFIXES, watch = true,
    allowHookFallback = false, watchFactory = watchFile,
    maxLineBytes = 16 * 1024 * 1024, maxChars = 12000, maxMessages = 10 } = {}) {
    super();
    this.options = { sessionId, controlPrefixes, watch, allowHookFallback, watchFactory, maxLineBytes, maxChars, maxMessages };
    this.path = null;
    this.handle = null;
    this.watcher = null;
    this.offset = 0;
    this.partial = Buffer.alloc(0);
    this.tail = Buffer.alloc(0);
    this.refreshing = null;
    this.refreshAgain = false;
    this.closed = false;
    this.sequence = 0;
    this.promptedTurn = null;
    this.lastResponseId = null;
    this.state = {
      supported: false, disabledReason: 'not-open', sessionId: null, cliVersion: null,
      revision: 0, turnId: null, turnStatus: 'unknown', userEpoch: 0, userStopped: false,
      goalStatus: null, goalStatusObserved: false,
      compactionGeneration: 0, requests: 0, requestsSinceCompaction: 0,
      inputTokens: null, modelContextWindow: null, baselineInputTokens: null, recentGrowthTokens: 0,
      latestUserDirection: null, objective: null, messages: [], latestOmittedActivity: null,
      recentUserRequests: [], recentFinalReports: [],
      toolCalls: [], lastToolResult: null,
      assignmentSourceThreadId: null,
      omissions: { messages: 0, chars: 0, opaqueContent: 0 },
      observationMode: watch ? 'watch' : 'manual', watchError: null,
    };
  }

  async open(path) {
    if (this.path) throw new Error('Transcript is already open');
    this.path = path;
    try {
      this.handle = await openFile(path, 'r');
      const info = await this.handle.stat();
      if (!info.isFile()) throw Object.assign(new Error('Not a file'), { code: 'not-file' });
      this.identity = { dev: info.dev, ino: info.ino };
      this.state.disabledReason = 'missing-session-meta';
      if (this.options.watch) {
        try {
          this.watcher = this.options.watchFactory(path, () => { this.refresh().catch(() => {}); });
          this.watcher.on('error', e => this.watchFailed(e));
        } catch (e) { this.watchFailed(e); }
      }
      await this.refresh();
    } catch (e) { this.disable(`read-${e.code ?? 'failed'}`); }
    return this.snapshot();
  }

  watchFailed(error) {
    this.watcher?.close();
    this.watcher = null;
    this.state.watchError = error.code ?? 'watch-failed';
    this.state.observationMode = this.options.allowHookFallback ? 'hooks' : 'unavailable';
    if (!this.options.allowHookFallback) this.disable(`watch-${this.state.watchError}`);
    else { this.state.revision++; this.emit('change', this.snapshot()); }
  }

  disable(reason) {
    if (this.state.disabledReason === reason) return;
    this.state.supported = false;
    this.state.disabledReason = reason;
    this.state.turnStatus = 'unknown';
    this.state.revision++;
    this.watcher?.close();
    this.watcher = null;
    this.emit('change', this.snapshot());
  }

  refresh() {
    if (this.closed || !this.handle) return Promise.resolve(this.snapshot());
    if (this.refreshing) { this.refreshAgain = true; return this.refreshing; }
    this.refreshing = (async () => {
      do {
        this.refreshAgain = false;
        await this.readAvailable();
      } while (this.refreshAgain && !this.closed && this.state.supported);
      return this.snapshot();
    })().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  async readAvailable() {
    if (this.state.disabledReason && this.state.disabledReason !== 'missing-session-meta') return;
    const revision = this.state.revision;
    try {
      const current = await stat(this.path);
      if (current.dev !== this.identity.dev || current.ino !== this.identity.ino) return this.disable('transcript-replaced');
      if (current.size < this.offset) return this.disable('transcript-truncated');
      // Detect same-inode truncate-and-regrow before consuming newly appended bytes.
      if (this.tail.length) {
        const check = Buffer.alloc(this.tail.length);
        const { bytesRead } = await this.handle.read(check, 0, check.length, this.offset - check.length);
        if (bytesRead !== check.length || !check.equals(this.tail)) return this.disable('transcript-rewritten');
      }
      const target = current.size;
      const chunk = Buffer.alloc(64 * 1024);
      while (this.offset < target && !this.closed) {
        const { bytesRead } = await this.handle.read(chunk, 0, Math.min(chunk.length, target - this.offset), this.offset);
        if (!bytesRead) return this.disable('transcript-truncated');
        this.offset += bytesRead;
        const bytes = chunk.subarray(0, bytesRead);
        this.tail = Buffer.from(Buffer.concat([this.tail, bytes]).subarray(-256));
        const buffer = this.partial.length ? Buffer.concat([this.partial, bytes]) : bytes;
        let begin = 0;
        let end;
        while ((end = buffer.indexOf(10, begin)) !== -1) {
          if (end - begin > this.options.maxLineBytes) return this.disable('record-too-large');
          const line = buffer.subarray(begin, end).toString('utf8');
          begin = end + 1;
          if (!line.trim()) continue;
          let record;
          try { record = JSON.parse(line); } catch { return this.disable('invalid-jsonl'); }
          this.accept(record);
          if (!this.state.supported) return;
        }
        this.partial = Buffer.from(buffer.subarray(begin));
        if (this.partial.length > this.options.maxLineBytes) return this.disable('record-too-large');
      }
      if (this.state.revision !== revision) this.emit('change', this.snapshot());
    } catch (e) { this.disable(`read-${e.code ?? 'failed'}`); }
  }

  accept(record) {
    const p = record?.payload;
    if (!object(record) || !object(p) || !TOP_LEVEL.has(record.type)) return this.disable('unsupported-record');
    this.sequence++;
    if (record.type === 'session_meta') {
      const id = p.session_id ?? p.id;
      if (!identifier(id) || ['id', 'session_id'].some(key => key in p && p[key] !== id)
        || (this.options.sessionId && this.options.sessionId !== id)
        || (this.state.sessionId && this.state.sessionId !== id)) return this.disable('session-identity-mismatch');
      this.state.sessionId = id;
      // This is the historical session creator, not necessarily the current writer.
      // Compatibility is established from the fields consumed in each record.
      this.state.cliVersion = typeof p.cli_version === 'string' ? p.cli_version : null;
      this.state.supported = true;
      this.state.disabledReason = null;
      this.state.revision++;
      return;
    }
    if (!this.state.sessionId) return this.disable('missing-session-meta');
    if (['thread_id', 'threadId', 'session_id'].some(key => key in p && p[key] !== this.state.sessionId)) {
      return this.disable('thread-identity-mismatch');
    }
    if (record.type === 'event_msg') return this.event(p, record);
    if (record.type === 'response_item') return this.response(p, record);
    if (record.type === 'token_usage_record') return this.usage(p);
    if (record.type === 'compacted') {
      if (typeof p.message !== 'string' || ('replacement_history' in p && !Array.isArray(p.replacement_history))) return this.disable('invalid-compaction');
      this.state.compactionGeneration++;
      this.state.requestsSinceCompaction = 0;
      this.state.inputTokens = null;
      this.state.baselineInputTokens = null;
      this.state.recentGrowthTokens = 0;
      this.state.revision++;
      return;
    }
    // Context metadata may report the current context allowance, but is not an external user instruction.
    if (record.type === 'turn_context') this.setWindow(p.model_context_window);
  }

  setWindow(window) {
    if (window == null) return;
    if (!number(window) || window === 0) return this.disable('invalid-context-window');
    if (window !== this.state.modelContextWindow) {
      this.state.modelContextWindow = window;
      this.state.revision++;
    }
  }

  event(p, record) {
    if (p.type === 'task_started') {
      if (!identifier(p.turn_id)) return this.disable('invalid-turn');
      this.setWindow(p.model_context_window);
      if (!this.state.supported) return;
      this.state.turnId = p.turn_id;
      this.state.turnStatus = 'active';
      this.state.revision++;
    } else if (p.type === 'task_complete' || p.type === 'turn_aborted') {
      if (!identifier(p.turn_id)) return this.disable('invalid-turn');
      // A late completion of an older turn cannot make the current turn idle.
      // A resumed rollout can begin with an abort of a turn started in prior history.
      if (this.state.turnId !== null && p.turn_id !== this.state.turnId) return;
      this.state.turnId = p.turn_id;
      this.state.turnStatus = 'idle';
      if (p.type === 'turn_aborted') { this.state.userStopped = true; this.state.userEpoch++; }
      this.state.revision++;
    } else if (p.type === 'token_count') {
      if (p.info != null && !object(p.info)) return this.disable('invalid-token-count');
      this.setWindow(p.info?.model_context_window);
      if (!this.state.supported) return;
      if (p.info?.last_token_usage != null && !object(p.info.last_token_usage)) return this.disable('invalid-token-count');
      const input = p.info?.last_token_usage?.input_tokens;
      if (input != null && !number(input)) return this.disable('invalid-token-count');
      // Canonical token_usage_record counts requests, avoiding the duplicate token_count event.
      // After compaction wait for a new canonical usage record before accepting context size.
      if (number(input) && (this.state.compactionGeneration === 0 || this.state.requestsSinceCompaction > 0)) this.setInput(input);
    } else if (p.type === 'thread_goal_updated' || p.type === 'thread_goal_cleared') {
      if (!identifier(p.threadId)) return this.disable('invalid-goal');
      if (p.type === 'thread_goal_updated') {
        if (!object(p.goal) || !identifier(p.goal.threadId)) return this.disable('invalid-goal');
        if (p.goal.threadId !== this.state.sessionId) return this.disable('goal-identity-mismatch');
        if (!GOAL_STATUSES.has(p.goal.status)) return this.disable('unsupported-goal-status');
        this.state.goalStatus = p.goal.status;
      } else this.state.goalStatus = null;
      this.state.goalStatusObserved = true;
      this.state.revision++;
    } else if (!PASSIVE_EVENTS.has(p.type)) {
      this.disable('unsupported-event');
    }
  }

  setInput(input) {
    if (input !== this.state.inputTokens) {
      this.state.recentGrowthTokens = this.state.inputTokens == null ? 0 : Math.max(0, input - this.state.inputTokens);
      this.state.inputTokens = input;
      this.state.revision++;
    }
  }

  usage(p) {
    if ((p.thread_id && p.thread_id !== this.state.sessionId) || (p.session_id && p.session_id !== this.state.sessionId)) return this.disable('usage-identity-mismatch');
    if (!object(p.usage) || !number(p.usage.input_tokens) || !identifier(p.response_id)) return this.disable('invalid-token-usage');
    if (p.response_id === this.lastResponseId) return;
    this.lastResponseId = p.response_id;
    this.state.requests++;
    this.state.requestsSinceCompaction++;
    this.setInput(p.usage.input_tokens);
    if (this.state.baselineInputTokens == null) this.state.baselineInputTokens = p.usage.input_tokens;
    this.state.revision++;
  }

  omitted(kind, record) {
    this.state.latestOmittedActivity = { kind, sequence: this.sequence, timestamp: record.timestamp ?? null, turnId: this.state.turnId, interpretation: 'unknown' };
    this.state.omissions.opaqueContent++;
    this.state.revision++;
  }

  toolCall(p, record) {
    if (typeof p.name !== 'string' || !p.name.trim()) return;
    const input = typeof p.arguments === 'string' ? p.arguments : typeof p.input === 'string' ? p.input : null;
    this.state.toolCalls.push({ callId: typeof p.call_id === 'string' ? p.call_id : null,
      name: p.name.slice(0, 128), namespace: typeof p.namespace === 'string' ? p.namespace.slice(0, 128) : null,
      input: input?.slice(0, 1_200) ?? null, inputTruncated: input != null && input.length > 1_200,
      sequence: this.sequence,
      timestamp: record.timestamp ?? null, resultObserved: false });
    if (this.state.toolCalls.length > 20) this.state.toolCalls.shift();
    this.state.revision++;
  }

  toolResult(p, record, { captureText = true } = {}) {
    const call = this.state.toolCalls.findLast(item => item.callId && item.callId === p.call_id);
    if (call) call.resultObserved = true;
    const output = !captureText ? '' : typeof p.output === 'string' ? p.output : Array.isArray(p.output)
      ? p.output.filter(item => ['input_text', 'output_text', 'text'].includes(item?.type) && typeof item.text === 'string')
        .map(item => item.text).join('\n') : '';
    if (output) this.state.lastToolResult = { name: call?.name ?? (typeof p.name === 'string' ? p.name.slice(0, 128) : null),
      text: output.slice(0, 4_000), truncated: output.length > 4_000,
      sequence: this.sequence, timestamp: record.timestamp ?? null };
    this.state.revision++;
  }

  response(p, record) {
    // A session's tool catalogue (written at session start since Codex 0.163) carries no conversation.
    if (p.type === 'reasoning' || p.type === 'additional_tools') return;
    if (['function_call', 'custom_tool_call'].includes(p.type)) {
      this.toolCall(p, record);
      return this.omitted('tool-started-content-omitted', record);
    }
    if (['function_call_output', 'custom_tool_call_output'].includes(p.type)) {
      if (this.nativeDelegation(p, record)) { this.toolResult(p, record, { captureText: false }); return; }
      this.toolResult(p, record);
      return this.omitted('tool-result-content-omitted', record);
    }
    if (p.type === 'agent_message') return this.omitted('incoming-agent-message-content-omitted', record);
    if (p.type !== 'message') return this.disable('unsupported-response-item');
    if (!['user', 'assistant'].includes(p.role)) return;
    if (p.role === 'assistant' && [p.phase, p.channel].some(value => !['commentary', 'final', 'final_answer', undefined, null].includes(value))) return;
    this.message(p, record);
  }

  nativeDelegation(p, record) {
    if (p.type !== 'function_call_output' || p.namespace !== 'codex_app'
      || !['create_thread', 'send_message_to_thread'].includes(p.name) || typeof p.output !== 'string') return false;
    const match = DELEGATION.exec(p.output);
    if (!match || !match[2].trim()) return false;
    const [, sourceThreadId, input] = match;
    if (p.name === 'create_thread' && this.state.assignmentSourceThreadId == null) this.state.assignmentSourceThreadId = sourceThreadId;
    if (sourceThreadId !== this.state.assignmentSourceThreadId) {
      // Child results and unrelated incoming messages cannot overwrite the user's direction or clear a stop.
      this.omitted('incoming-agent-message-content-omitted', record);
      return true;
    }
    this.message({ type: 'message', id: p.id, role: 'user', content: [{ type: 'input_text', text: input }],
      internal_chat_message_metadata_passthrough: { ...p.internal_chat_message_metadata_passthrough, content_item_kinds: ['user.text'] } },
    record, { kind: 'native-delegation', sourceThreadId, method: p.name });
    return true;
  }

  message(p, record, provenance = null) {
    const metadata = p.internal_chat_message_metadata_passthrough;
    const kinds = metadata?.content_item_kinds;
    if (p.role === 'user' && Array.isArray(kinds) && !kinds.includes('user.text')) return;
    if (!Array.isArray(p.content)) return this.disable('invalid-message-content');
    const content = p.role === 'user' && Array.isArray(kinds) ? p.content.filter((_c, i) => kinds[i] === 'user.text') : p.content;
    const visible = content.filter(c => ['input_text', 'output_text', 'text'].includes(c.type) && typeof c.text === 'string').map(c => c.text).join('\n');
    if (content.some(c => !['input_text', 'output_text', 'text'].includes(c.type))) this.omitted(`${p.role}-nontext-content-omitted`, record);
    if (!visible.trim()) return;
    const turnId = metadata?.turn_id ?? this.state.turnId;
    if (this.options.controlPrefixes.some(prefix => visible.trimStart().startsWith(prefix))) {
      if (p.role === 'user' && visible.trimStart().startsWith(this.options.controlPrefixes[0])) this.markPrompted(turnId);
      return;
    }
    // Legacy untagged instruction wrappers are never treated as external directions.
    if (p.role === 'user' && /^(?:# AGENTS\.md instructions|<environment_context>|<INSTRUCTIONS>)/.test(visible.trimStart())) return;
    const text = textLimit(visible, Math.min(6000, this.options.maxChars));
    this.state.omissions.chars += visible.length - text.length;
    const phase = p.phase ?? p.channel ?? null;
    const message = { id: p.id ?? null, role: p.role, text, turnId, phase, timestamp: record.timestamp ?? null,
      sequence: this.sequence, prompted: p.role === 'assistant' && this.promptedTurn === turnId,
      ...(provenance ? { provenance } : {}) };
    if (p.role === 'user') {
      const request = sourceRequest(visible, provenance);
      if (request) {
        this.state.recentUserRequests.push({ turnId, sequence: this.sequence, ...request });
        if (this.state.recentUserRequests.length > 10) this.state.recentUserRequests.shift();
      }
      this.state.userEpoch++;
      this.state.userStopped = STOP.test(visible.trim()) || (provenance?.kind === 'native-delegation' && this.state.userStopped);
      this.state.latestUserDirection = message;
      if (!CONTINUE.test(visible.trim()) && !this.state.userStopped) this.state.objective = message;
      this.promptedTurn = null;
    } else {
      if (phase === 'final' || phase === 'final_answer') {
        const report = finalReport(visible);
        if (report) {
          this.state.recentFinalReports.push({ turnId, sequence: this.sequence, prompted: message.prompted, ...report });
          if (this.state.recentFinalReports.length > 6) this.state.recentFinalReports.shift();
        }
      }
      this.state.messages.push(message);
      let chars = this.state.messages.reduce((sum, m) => sum + m.text.length, 0);
      while (this.state.messages.length > this.options.maxMessages || chars > this.options.maxChars) {
        const removed = this.state.messages.shift();
        chars -= removed.text.length;
        this.state.omissions.messages++;
        this.state.omissions.chars += removed.text.length;
      }
    }
    this.state.revision++;
  }

  markPrompted(turnId) {
    if (typeof turnId !== 'string' || turnId !== this.state.turnId || this.promptedTurn === turnId) return false;
    this.promptedTurn = turnId;
    this.state.revision++;
    this.emit('change', this.snapshot());
    return true;
  }

  snapshot() {
    const snapshot = structuredClone(this.state);
    snapshot.usage = { inputTokens: snapshot.inputTokens, contextWindow: snapshot.modelContextWindow, recentGrowthTokens: snapshot.recentGrowthTokens };
    snapshot.packet = buildPacket(snapshot, { maxChars: this.options.maxChars });
    const timing = buildTimingPacket(snapshot);
    snapshot.timingPacket = timing.packet;
    snapshot.timingMetadata = timing.metadata;
    return snapshot;
  }

  async close() {
    this.closed = true;
    this.watcher?.close();
    this.watcher = null;
    if (this.refreshing) await this.refreshing;
    await this.handle?.close();
    this.handle = null;
    this.partial = Buffer.alloc(0);
    this.tail = Buffer.alloc(0);
  }
}
