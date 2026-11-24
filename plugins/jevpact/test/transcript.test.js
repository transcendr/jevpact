import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, appendFile, rm, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter, once } from 'node:events';
import { Transcript, buildPacket } from '../src/transcript.js';

const session = 'test-session';
const record = (type, payload) => ({ timestamp: '2026-09-21T19:00:00.000Z', type, payload });
const meta = (overrides = {}) => record('session_meta', { id: session, session_id: session, cli_version: '0.155.0-alpha.9.2', ...overrides });
const event = (type, extra = {}) => record('event_msg', { type, turn_id: 'turn-1', ...extra });
const message = (role, text, extra = {}) => record('response_item', {
  type: 'message', role, phase: role === 'assistant' ? 'commentary' : undefined,
  content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }],
  internal_chat_message_metadata_passthrough: { turn_id: 'turn-1', content_item_kinds: [role === 'user' ? 'user.text' : 'unknown'] }, ...extra,
});
const usage = (id, input) => record('token_usage_record', { session_id: session, thread_id: session, turn_id: 'turn-1', response_id: id, usage: { input_tokens: input } });
const assignmentSource = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const delegation = (name, text, source = assignmentSource, extra = {}) => record('response_item', {
  type: 'function_call_output', id: 'delegation-message', name, namespace: 'codex_app',
  output: `<codex_delegation>\n  <source_thread_id>${source}</source_thread_id>\n  <input>${text}</input>\n</codex_delegation>`,
  internal_chat_message_metadata_passthrough: { turn_id: 'turn-1' }, ...extra,
});
const lines = records => records.map(r => JSON.stringify(r)).join('\n') + '\n';
async function fixture(t, records = [meta()], options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'jevpact-transcript-test-'));
  const path = join(dir, 'rollout.jsonl');
  await writeFile(path, lines(records));
  const reader = new Transcript({ sessionId: session, watch: false, ...options });
  t.after(async () => { await reader.close(); await rm(dir, { recursive: true, force: true }); });
  await reader.open(path);
  return { reader, path, append: async records => { await appendFile(path, lines(records)); return reader.refresh(); } };
}

test('partial append including split UTF-8 is buffered until the complete line', async t => {
  const { reader, path } = await fixture(t);
  const line = Buffer.from(lines([message('user', 'Investigate café safely.')]));
  const split = line.indexOf(Buffer.from('é')) + 1;
  const before = reader.snapshot().revision;
  await appendFile(path, line.subarray(0, split));
  await reader.refresh();
  assert.equal(reader.snapshot().userEpoch, 0);
  assert.equal(reader.snapshot().revision, before);
  await appendFile(path, line.subarray(split));
  await reader.refresh();
  assert.equal(reader.snapshot().latestUserDirection.text, 'Investigate café safely.');
  assert.equal(reader.snapshot().userEpoch, 1);
  const after = reader.snapshot().revision;
  await reader.refresh();
  assert.equal(reader.snapshot().revision, after);
});

test('actual turn events establish idle; final text and stale completions cannot', async t => {
  const { reader, append } = await fixture(t, [meta(), event('task_started'), message('assistant', 'I am done.', { phase: 'final' })]);
  assert.equal(reader.snapshot().turnStatus, 'active');
  await append([event('task_complete', { turn_id: 'older-turn' })]);
  assert.equal(reader.snapshot().turnStatus, 'active');
  await append([event('task_complete')]);
  assert.equal(reader.snapshot().turnStatus, 'idle');
  assert.equal(reader.snapshot().turnId, 'turn-1');
  await append([event('task_started', { turn_id: 'turn-2' })]);
  assert.equal(reader.snapshot().turnStatus, 'active');
  assert.equal(reader.snapshot().turnId, 'turn-2');
});

test('GUI final_answer is visible after opaque tool activity and only task_complete establishes idle', async t => {
  const finalText = 'The review found one parser defect; the fix preserves the existing stop behavior.';
  const { reader, append } = await fixture(t, [meta(), event('task_started'),
    message('assistant', 'I will inspect the review result.'),
    record('response_item', { type: 'custom_tool_call_output', call_id: 'review-call', output: 'RAW_REVIEW_LOG' }),
  ]);
  await append([message('assistant', finalText, { phase: 'final_answer' }),
    usage('review-response', 94000),
    event('token_count', { info: { last_token_usage: { input_tokens: 94000 }, model_context_window: 498750 } }),
  ]);
  const active = reader.snapshot();
  const packet = JSON.parse(active.packet);
  assert.equal(active.turnStatus, 'active');
  assert.equal(packet.messages.at(-1).text, finalText);
  assert.ok(packet.messages.at(-2).sequence < packet.latestOmittedActivity.sequence);
  assert.ok(packet.latestOmittedActivity.sequence < packet.messages.at(-1).sequence);
  assert.equal(packet.latestOmittedActivity.interpretation, 'unknown');
  assert.ok(!active.packet.includes('RAW_REVIEW_LOG'));
  await append([event('task_complete', { last_agent_message: finalText })]);
  const idle = reader.snapshot();
  assert.equal(idle.turnStatus, 'idle');
  assert.equal(idle.messages.filter(m => m.text === finalText).length, 1);
  assert.equal(idle.requests, 1);
});

test('tool template data is bounded and remains outside Jev evidence packets', async t => {
  const { reader, append } = await fixture(t, [meta(), event('task_started'),
    record('response_item', { type: 'function_call', call_id: 'call-1', namespace: 'functions',
      name: 'exec', arguments: JSON.stringify({ cmd: 'rg parser src' }) }),
    record('response_item', { type: 'function_call_output', call_id: 'call-1', output: 'Result {{thread.id}}' }),
    record('response_item', { type: 'custom_tool_call', call_id: 'call-2', name: 'inspect', input: 'Check current state.' }),
  ]);
  let snapshot = reader.snapshot();
  assert.equal(snapshot.toolCalls.length, 2);
  assert.equal(snapshot.toolCalls[0].resultObserved, true);
  assert.equal(snapshot.toolCalls[1].resultObserved, false);
  assert.equal(snapshot.lastToolResult.text, 'Result {{thread.id}}');
  assert.ok(!snapshot.packet.includes('Result {{thread.id}}'));
  assert.ok(!snapshot.timingPacket?.includes('Result {{thread.id}}'));
  await append([record('response_item', { type: 'custom_tool_call_output', call_id: 'call-2',
    output: [{ type: 'input_text', text: 'Z'.repeat(5000) }, { type: 'image', data: 'PRIVATE_IMAGE' }] })]);
  snapshot = reader.snapshot();
  assert.equal(snapshot.toolCalls[1].resultObserved, true);
  assert.equal(snapshot.lastToolResult.name, 'inspect');
  assert.equal(snapshot.lastToolResult.text.length, 4000);
  assert.equal(snapshot.lastToolResult.truncated, true);
  assert.ok(!snapshot.packet.includes('PRIVATE_IMAGE'));
  assert.ok(!snapshot.packet.includes('Z'.repeat(100)));
});

test('user stop survives task starts and controller resume until genuine external input', async t => {
  const { reader, append } = await fixture(t, [meta(), event('task_started'), message('user', 'Implement the parser.'), event('turn_aborted', { reason: 'interrupted' })]);
  assert.equal(reader.snapshot().userStopped, true);
  const epoch = reader.snapshot().userEpoch;
  await append([event('task_started'), message('user', 'Jevpact compaction complete: continue the existing task.')]);
  assert.equal(reader.snapshot().userStopped, true);
  assert.equal(reader.snapshot().userEpoch, epoch);
  await append([message('user', 'Resume the parser work.')]);
  assert.equal(reader.snapshot().userStopped, false);
  assert.equal(reader.snapshot().userEpoch, epoch + 1);
  await append([message('user', 'Please stop.')]);
  assert.equal(reader.snapshot().userStopped, true);
});

test('native compaction resets observed usage and counts requests exactly once', async t => {
  const { reader, append } = await fixture(t, [meta(), event('task_started', { model_context_window: 498750 }),
    event('token_count', { info: { last_token_usage: { input_tokens: 220000 }, model_context_window: 498750 } }), usage('response-1', 220000)]);
  assert.equal(reader.snapshot().requests, 1);
  assert.equal(reader.snapshot().inputTokens, 220000);
  assert.deepEqual(reader.snapshot().usage, { inputTokens: 220000, contextWindow: 498750, recentGrowthTokens: 0 });
  await append([usage('response-1', 220000), record('compacted', { message: 'private summary', replacement_history: [], window_number: 2 })]);
  assert.equal(reader.snapshot().requests, 1);
  assert.equal(reader.snapshot().requestsSinceCompaction, 0);
  assert.equal(reader.snapshot().compactionGeneration, 1);
  assert.equal(reader.snapshot().inputTokens, null);
  assert.equal(reader.snapshot().baselineInputTokens, null);
  await append([event('token_count', { info: { last_token_usage: { input_tokens: 220000 } } })]);
  assert.equal(reader.snapshot().inputTokens, null);
  await append([usage('response-2', 42000), usage('response-3', 45000)]);
  assert.equal(reader.snapshot().requestsSinceCompaction, 2);
  assert.equal(reader.snapshot().baselineInputTokens, 42000);
  assert.equal(reader.snapshot().usage.recentGrowthTokens, 3000);
  assert.ok(!reader.snapshot().packet.includes('private summary'));
});

test('control messages are excluded and only subsequent wrap-up is prompted', async t => {
  const { reader, append } = await fixture(t, [meta(), event('task_started'), message('user', 'Find the cause of the failure.'), message('assistant', 'I am comparing traces.')]);
  const epoch = reader.snapshot().userEpoch;
  assert.equal(reader.markPrompted('wrong-turn'), false);
  assert.equal(reader.markPrompted('turn-1'), true);
  await append([message('user', 'Jevpact context maintenance: finish this step.'), message('assistant', 'The cause is the stale timestamp.'), message('user', 'Jevpact compaction complete: resume.')]);
  assert.equal(reader.snapshot().userEpoch, epoch);
  assert.deepEqual(reader.snapshot().messages.map(m => m.prompted), [false, true]);
  assert.ok(!reader.snapshot().packet.includes('Jevpact context maintenance:'));
  assert.equal(reader.snapshot().latestUserDirection.text, 'Find the cause of the failure.');
  await append([message('user', 'Continue')]);
  assert.equal(reader.snapshot().objective.text, 'Find the cause of the failure.');
  assert.equal(reader.snapshot().latestUserDirection.text, 'Continue');
});

test('hidden reasoning, instructions, tool logs, and opaque child content never enter the packet', async t => {
  const { reader } = await fixture(t, [meta(), event('task_started'),
    record('response_item', { type: 'reasoning', summary: [{ text: 'HIDDEN_A' }] }),
    message('assistant', 'HIDDEN_B', { phase: 'analysis' }),
    message('assistant', 'HIDDEN_C', { phase: 'final', channel: 'analysis' }),
    message('assistant', 'HIDDEN_D', { phase: 'final_answer', channel: 'analysis' }),
    message('developer', 'INSTRUCTIONS_A'),
    message('user', 'INSTRUCTIONS_B', { internal_chat_message_metadata_passthrough: { content_item_kinds: ['agents_md.instructions'] } }),
    record('response_item', { type: 'custom_tool_call_output', output: 'SECRET_LOG' }),
    record('response_item', { type: 'agent_message', content: [{ type: 'encrypted_content', encrypted_content: 'SECRET_CHILD' }] }),
    message('assistant', 'I will inspect the result.'),
  ]);
  const s = reader.snapshot();
  assert.equal(s.supported, true);
  assert.equal(s.userEpoch, 0);
  for (const hidden of ['HIDDEN_A', 'HIDDEN_B', 'HIDDEN_C', 'HIDDEN_D', 'INSTRUCTIONS_A', 'INSTRUCTIONS_B', 'SECRET_LOG', 'SECRET_CHILD']) assert.ok(!s.packet.includes(hidden));
  assert.equal(s.omissions.opaqueContent, 2);
  assert.equal(s.latestOmittedActivity.interpretation, 'unknown');
  assert.match(s.packet, /does not establish that a result was interpreted/);
});

test('packet chronology places a new user direction after an older assistant conclusion', async t => {
  const { reader } = await fixture(t, [meta(), event('task_started'), message('user', 'Implement the parser.'),
    message('assistant', 'The parser is complete.'), message('user', 'It still fails on the attached input.')]);
  const packet = JSON.parse(reader.snapshot().packet);
  assert.ok(packet.latestUserDirection.sequence > packet.messages.at(-1).sequence);
  assert.equal(packet.latestUserDirection.text, 'It still fails on the attached input.');
});

test('native create_thread assignment and same-source followups retain bounded direction and provenance', async t => {
  const { reader, append } = await fixture(t, [meta(), event('task_started'), delegation('create_thread', 'Review the current Jevpact CLI.')]);
  const initial = reader.snapshot();
  assert.equal(initial.objective.text, 'Review the current Jevpact CLI.');
  assert.equal(initial.latestUserDirection.text, initial.objective.text);
  assert.equal(initial.userEpoch, 1);
  assert.deepEqual(JSON.parse(initial.packet).objective.provenance, {
    kind: 'native-delegation', sourceThreadId: assignmentSource, method: 'create_thread',
  });
  await append([message('assistant', 'The CLI review is complete.'), delegation('send_message_to_thread', 'Also check the usage flags.')]);
  const followup = reader.snapshot();
  assert.equal(followup.latestUserDirection.text, 'Also check the usage flags.');
  assert.equal(followup.latestUserDirection.provenance.method, 'send_message_to_thread');
  assert.ok(followup.latestUserDirection.sequence > followup.messages.at(-1).sequence);
  assert.equal(followup.userEpoch, 2);
  await append([delegation('send_message_to_thread', `Review this large input: ${'bounded text '.repeat(2000)}`)]);
  assert.ok(reader.snapshot().objective.text.length <= 6000);
  assert.ok(reader.snapshot().omissions.chars > 0);
  assert.ok(Buffer.byteLength(reader.snapshot().packet) <= 22000);
});

test('delegation needs exact tool provenance and envelope; other tool output stays opaque', async t => {
  const candidates = [
    delegation('create_thread', 'PRIVATE_TASK', assignmentSource, { namespace: 'untrusted_tool' }),
    delegation('create_thread', 'PRIVATE_TASK', assignmentSource, { type: 'custom_tool_call_output' }),
    delegation('read_file', 'PRIVATE_TASK'),
    delegation('create_thread', 'PRIVATE_TASK', 'invalid-source'),
    delegation('create_thread', 'PRIVATE_TASK', assignmentSource, { output: 'PRIVATE_TASK' }),
    delegation('create_thread', 'PRIVATE_TASK', assignmentSource, { output: '<codex_delegation><input>PRIVATE_TASK</input></codex_delegation>' }),
  ];
  const { reader } = await fixture(t, [meta(), event('task_started'), ...candidates]);
  const s = reader.snapshot();
  assert.equal(s.supported, true);
  assert.equal(s.objective, null);
  assert.equal(s.latestUserDirection, null);
  assert.equal(s.userEpoch, 0);
  assert.equal(s.omissions.opaqueContent, candidates.length);
  assert.ok(!s.packet.includes('PRIVATE_TASK'));
});

test('child returns cannot replace direction or clear a user stop, and native followups preserve the stop', async t => {
  const childSource = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const { reader, append } = await fixture(t, [meta(), event('task_started'), delegation('create_thread', 'Review the parser.'), event('turn_aborted')]);
  const epoch = reader.snapshot().userEpoch;
  await append([delegation('send_message_to_thread', 'PRIVATE_CHILD_RETURN', childSource)]);
  assert.equal(reader.snapshot().objective.text, 'Review the parser.');
  assert.equal(reader.snapshot().userEpoch, epoch);
  assert.equal(reader.snapshot().userStopped, true);
  assert.equal(reader.snapshot().latestOmittedActivity.kind, 'incoming-agent-message-content-omitted');
  assert.ok(!reader.snapshot().packet.includes('PRIVATE_CHILD_RETURN'));
  await append([delegation('send_message_to_thread', 'Continue')]);
  assert.equal(reader.snapshot().userStopped, true);
  await append([message('user', 'Continue')]);
  assert.equal(reader.snapshot().userStopped, false);
});

test('mixed user content selects only matching user.text parts by index', async t => {
  const { reader } = await fixture(t, [meta(), event('task_started'), message('user', '', {
    content: [
      { type: 'input_text', text: '<INSTRUCTIONS>PRIVATE_INSTRUCTIONS</INSTRUCTIONS>' },
      { type: 'input_text', text: 'Review the parser.' },
      { type: 'input_text', text: 'PRIVATE_ENVIRONMENT' },
      { type: 'input_text', text: 'Preserve user stops.' },
    ],
    internal_chat_message_metadata_passthrough: {
      turn_id: 'turn-1', content_item_kinds: ['agents_md.instructions', 'user.text', 'environment_context', 'user.text'],
    },
  })]);
  const s = reader.snapshot();
  assert.equal(s.userEpoch, 1);
  assert.equal(s.latestUserDirection.text, 'Review the parser.\nPreserve user stops.');
  assert.ok(!s.packet.includes('PRIVATE_INSTRUCTIONS'));
  assert.ok(!s.packet.includes('PRIVATE_ENVIRONMENT'));
});

test('historical CLI versions are diagnostic while consumed record shapes establish compatibility', async t => {
  for (const version of ['0.154.0-alpha.6.2', '0.155.0-alpha.9.2', '0.999.0', undefined]) {
    const { reader } = await fixture(t, [meta({ cli_version: version }), event('task_started', { model_context_window: 498750 }),
      usage('current-response', 95000), message('assistant', 'The current writer completed the step.', { phase: 'final_answer' }),
      event('task_complete', { additionalFutureMetadata: true }),
    ]);
    const s = reader.snapshot();
    assert.equal(s.supported, true);
    assert.equal(s.cliVersion, version ?? null);
    assert.equal(s.turnStatus, 'idle');
    assert.equal(s.inputTokens, 95000);
    assert.equal(s.requests, 1);
    assert.equal(s.messages.at(-1).text, 'The current writer completed the step.');
  }
});

test('native goal updates and clearing retain status without exposing objectives or deciding turn state', async t => {
  const { reader, append } = await fixture(t, [meta(), event('task_started')]);
  assert.equal(reader.snapshot().goalStatus, null);
  assert.equal(reader.snapshot().goalStatusObserved, false);
  for (const status of ['active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete']) {
    const revision = reader.snapshot().revision;
    await append([record('event_msg', { type: 'thread_goal_updated', threadId: session, goal: {
      threadId: session, objective: 'PRIVATE_GOAL_OBJECTIVE', status, tokensUsed: 150, timeUsedSeconds: 12,
      createdAt: 1790018117, updatedAt: 1790018129,
    } })]);
    const s = reader.snapshot();
    assert.equal(s.supported, true);
    assert.equal(s.goalStatus, status);
    assert.equal(s.goalStatusObserved, true);
    assert.equal(s.turnStatus, 'active');
    assert.equal(s.turnId, 'turn-1');
    assert.equal(s.userEpoch, 0);
    assert.ok(s.revision > revision);
    assert.ok(!JSON.stringify(s).includes('PRIVATE_GOAL_OBJECTIVE'));
  }
  await append([record('event_msg', { type: 'thread_goal_cleared', threadId: session })]);
  assert.equal(reader.snapshot().goalStatus, null);
  assert.equal(reader.snapshot().goalStatusObserved, true);
  assert.equal(reader.snapshot().turnStatus, 'active');
});

test('resumed initial abort and explicit stop survive goal lifecycle and stale turn completion', async t => {
  const { reader, append } = await fixture(t, [meta({ cli_version: '0.154.0-alpha.6.2' }), event('turn_aborted', { started_at: 1, reason: 'interrupted' })]);
  assert.equal(reader.snapshot().turnId, 'turn-1');
  assert.equal(reader.snapshot().turnStatus, 'idle');
  assert.equal(reader.snapshot().userStopped, true);
  const epoch = reader.snapshot().userEpoch;
  await append([event('task_started', { turn_id: 'turn-2' }),
    record('event_msg', { type: 'thread_goal_updated', threadId: session, goal: { threadId: session, status: 'active' } }),
    event('task_complete', { turn_id: 'turn-1' }), record('event_msg', { type: 'thread_goal_cleared', threadId: session }),
  ]);
  assert.equal(reader.snapshot().turnId, 'turn-2');
  assert.equal(reader.snapshot().turnStatus, 'active');
  assert.equal(reader.snapshot().userStopped, true);
  assert.equal(reader.snapshot().userEpoch, epoch);
});

test('observed item/settings and metadata records do not close a healthy watcher or complete its turn', async t => {
  const watcher = new EventEmitter();
  let closed = false;
  watcher.close = () => { closed = true; };
  const { reader, append } = await fixture(t, [meta(), event('task_started')], { watch: true, watchFactory: () => watcher });
  await append([
    record('event_msg', { type: 'thread_settings_applied', thread_id: session, thread_settings: { model: 'current-model' } }),
    record('event_msg', { type: 'item_completed', thread_id: session, turn_id: 'turn-1', item: { type: 'ContextCompaction' }, started_at_ms: 10, completed_at_ms: 20 }),
    record('world_state', { full: false, state: { private: 'PRIVATE_WORLD_STATE' } }),
    record('inter_agent_communication_metadata', { trigger_turn: true }),
  ]);
  assert.equal(reader.snapshot().supported, true);
  assert.equal(reader.snapshot().turnStatus, 'active');
  assert.equal(reader.snapshot().compactionGeneration, 0);
  assert.equal(reader.snapshot().observationMode, 'watch');
  assert.equal(closed, false);
  assert.ok(!reader.snapshot().packet.includes('PRIVATE_WORLD_STATE'));
  await append([event('task_complete')]);
  assert.equal(reader.snapshot().turnStatus, 'idle');
});

test('malformed consumed lifecycle fields and goal identities fail closed', async t => {
  for (const [bad, reason] of [
    [event('task_started', { turn_id: '' }), 'invalid-turn'],
    [event('task_complete', { turn_id: [] }), 'invalid-turn'],
    [event('task_started', { model_context_window: '498750' }), 'invalid-context-window'],
    [event('token_count', { info: [] }), 'invalid-token-count'],
    [event('token_count', { info: { last_token_usage: { input_tokens: -1 } } }), 'invalid-token-count'],
    [record('compacted', {}), 'invalid-compaction'],
    [record('event_msg', { type: 'thread_goal_updated', threadId: 'other-thread', goal: { threadId: session, status: 'active' } }), 'thread-identity-mismatch'],
    [record('event_msg', { type: 'thread_goal_updated', threadId: session, goal: { threadId: 'other-thread', status: 'active' } }), 'goal-identity-mismatch'],
    [record('event_msg', { type: 'thread_goal_updated', threadId: session, goal: { threadId: session, status: 'unrecognized-state' } }), 'unsupported-goal-status'],
    [record('event_msg', { type: 'thread_goal_updated', threadId: session, goal: [] }), 'invalid-goal'],
    [record('event_msg', { type: 'thread_goal_cleared' }), 'invalid-goal'],
  ]) {
    const { reader } = await fixture(t, [meta(), event('task_started'), bad]);
    assert.equal(reader.snapshot().supported, false);
    assert.equal(reader.snapshot().disabledReason, reason);
    assert.equal(reader.snapshot().turnStatus, 'unknown');
  }
});

test('identity mismatch and malformed complete lines fail closed', async t => {
  for (const [records, reason] of [
    [[meta({ id: 'other', session_id: 'other' })], 'session-identity-mismatch'],
    [[meta({ id: '', session_id: undefined })], 'session-identity-mismatch'],
  ]) {
    const { reader } = await fixture(t, records);
    assert.equal(reader.snapshot().supported, false);
    assert.equal(reader.snapshot().disabledReason, reason);
  }
  const { reader, path } = await fixture(t);
  await appendFile(path, '{broken}\n');
  await reader.refresh();
  assert.equal(reader.snapshot().disabledReason, 'invalid-jsonl');
});

test('truncation, same-inode overwrite, and file replacement fail closed without replaying history', async t => {
  const a = await fixture(t, [meta(), message('user', 'Original direction')]);
  await writeFile(a.path, '');
  await a.reader.refresh();
  assert.equal(a.reader.snapshot().disabledReason, 'transcript-truncated');
  const b = await fixture(t, [meta(), message('user', 'Original direction')]);
  await writeFile(b.path, lines([meta(), message('user', 'Changed direction with more text')]));
  await b.reader.refresh();
  assert.equal(b.reader.snapshot().disabledReason, 'transcript-rewritten');
  assert.equal(b.reader.snapshot().userEpoch, 1);
  const c = await fixture(t);
  await rename(c.path, `${c.path}.old`);
  await writeFile(c.path, lines([meta()]));
  await c.reader.refresh();
  assert.equal(c.reader.snapshot().disabledReason, 'transcript-replaced');
});

test('large hydration keeps only ten recent assistant messages and a bounded Unicode packet', async t => {
  const records = [meta(), event('task_started'), message('user', 'Investigate this objective.')];
  for (let i = 0; i < 1800; i++) records.push(message('assistant', `Message ${i}: ${'🙂'.repeat(600)}`));
  const { reader } = await fixture(t, records);
  const s = reader.snapshot();
  assert.equal(s.supported, true);
  assert.ok(s.messages.length <= 10);
  assert.match(s.messages.at(-1).text, /^Message 1799:/);
  assert.ok(s.omissions.messages > 1700);
  assert.ok(s.packet.length <= 12000);
  assert.ok(Buffer.byteLength(s.packet) <= 22000);
  assert.ok(JSON.stringify(s).length < 45000);
  assert.equal(reader.partial.length, 0);
  assert.ok(reader.tail.length <= 256);
  assert.deepEqual(JSON.parse(buildPacket(s)).source, 'codex-visible-transcript');
});

test('watch error is nonfatal and hook fallback requires explicit opt-in', async t => {
  const brokenWatch = () => { throw Object.assign(new Error('watch failed'), { code: 'EMFILE' }); };
  const strict = await fixture(t, [meta()], { watch: true, watchFactory: brokenWatch });
  assert.equal(strict.reader.snapshot().supported, false);
  assert.equal(strict.reader.snapshot().disabledReason, 'watch-EMFILE');
  const fallback = await fixture(t, [meta()], { watch: true, watchFactory: brokenWatch, allowHookFallback: true });
  assert.equal(fallback.reader.snapshot().supported, true);
  assert.equal(fallback.reader.snapshot().observationMode, 'hooks');
  assert.equal(fallback.reader.snapshot().watchError, 'EMFILE');
  await fallback.append([event('task_started')]);
  assert.equal(fallback.reader.snapshot().turnStatus, 'active');
});

test('watch callback incrementally refreshes and late watcher errors do not crash', async t => {
  let notify;
  const watcher = new EventEmitter();
  watcher.close = () => {};
  const { reader, path } = await fixture(t, [meta()], { watch: true, allowHookFallback: true,
    watchFactory: (_path, callback) => { notify = callback; return watcher; } });
  const changed = once(reader, 'change');
  await appendFile(path, lines([event('task_started')]));
  notify('change');
  await changed;
  assert.equal(reader.snapshot().turnStatus, 'active');
  watcher.emit('error', Object.assign(new Error('out of handles'), { code: 'EMFILE' }));
  assert.equal(reader.snapshot().observationMode, 'hooks');
  assert.equal(reader.snapshot().supported, true);
});

test('unknown record, event and response item types are skipped and recorded, not disabling supervision', async t => {
  const { reader } = await fixture(t, [meta(),
    record('response_item', { type: 'additional_tools', tools: [] }),
    record('response_item', { type: 'configuration_update', settings: {} }),
    record('response_item', { type: 'future_item' }),
    event('new-lifecycle-event'),
    record('future_record', {}),
    message('user', 'Continue the assignment.')]);
  const s = reader.snapshot();
  assert.equal(s.supported, true);
  assert.equal(s.disabledReason, null);
  assert.equal(s.latestUserDirection.text, 'Continue the assignment.');
  assert.deepEqual(s.unrecognized, { 'response-item:configuration_update': 1, 'response-item:future_item': 1,
    'event:new-lifecycle-event': 1, 'record:future_record': 1 });
});
