import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { serve } from '../src/daemon.js';
import { Transcript } from '../src/transcript.js';
import { call } from '../src/rpc.js';
import { History } from '../src/history.js';
import { emptyConfig, writeConfig } from '../src/config.js';
import { createT3ReaderFactory } from '../src/t3-reader.js';

const id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

async function fixture(t, { statusGate, openGate, onDecision, persistent = false, legacyWatchList = false,
  readerFactory, onlyThreadId = id } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jp-'));
  // This test process gets its own short socket path. Never contact or stop
  // the user's controller, including while a live journey is running.
  t.mock.method(os, 'tmpdir', () => directory);
  t.mock.method(os, 'homedir', () => directory);
  const transcript = path.join(directory, 'rollout.jsonl');
  await writeFile(transcript, JSON.stringify({ type: 'session_meta', payload: { id, cli_version: '0.155.0-alpha.9.2' } }) + '\n');
  if (legacyWatchList) {
    const legacy = path.join(directory, `jevpact-${process.getuid()}`);
    await mkdir(legacy);
    await writeFile(path.join(legacy, 'watched-threads.json'), JSON.stringify([id]));
  }
  const opened = deferred();
  const readers = [];
  const originalOpen = Transcript.prototype.open;
  t.mock.method(Transcript.prototype, 'open', async function (file) {
    readers.push(this);
    await originalOpen.call(this, file);
    opened.resolve(this);
    if (openGate) await openGate.promise;
    return this.snapshot();
  });
  const transport = {
    capabilities: { atomicIdleMutation: false },
    closed: false,
    readers: new Map(),
    async locate() { if (statusGate) await statusGate.promise; return { rolloutPath: transcript }; },
    bindReader(id, reader) { this.readers.set(id, reader); },
    unbindReader(id, reader) { if (this.readers.get(id) === reader) this.readers.delete(id); },
    close() { this.closed = true; },
  };
  const daemon = await serve({ apiKey: 'unit-test-placeholder', transport, readerFactory, onlyThreads: persistent ? [] : [onlyThreadId], onDecision });
  assert.equal(daemon.alreadyRunning, undefined, 'Do not replace another running controller');
  t.after(async () => {
    statusGate?.resolve();
    openGate?.resolve();
    await daemon.close();
    await rm(directory, { recursive: true, force: true });
  });
  const hook = hook_event_name => daemon.dispatch({ method: 'hook', event: { session_id: id, transcript_path: transcript, hook_event_name } });
  return { daemon, hook, readers, opened, transport, directory };
}

test('SessionEnd cancels hook-started attachment while native status is pending', async t => {
  const statusGate = deferred();
  const { daemon, hook, readers } = await fixture(t, { statusGate });
  await hook('SessionStart');
  const joined = daemon.dispatch({ method: 'attach', threadId: id });
  await hook('SessionEnd');
  statusGate.resolve();
  assert.deepEqual(await joined, { attached: false });
  assert.deepEqual((await daemon.dispatch({ method: 'status' })).threads, []);
  assert.equal(readers.length, 0, 'A cancelled status result must not allocate a reader/watcher');
});

test('SessionEnd closes a real reader opened by an unpublished attachment', async t => {
  const openGate = deferred();
  const { daemon, hook, opened } = await fixture(t, { openGate });
  await hook('SessionStart');
  const reader = await opened.promise;
  const joined = daemon.dispatch({ method: 'attach', threadId: id });
  await hook('SessionEnd');
  openGate.resolve();
  assert.deepEqual(await joined, { attached: false });
  assert.deepEqual((await daemon.dispatch({ method: 'status' })).threads, []);
  assert.equal(reader.closed, true);
  assert.equal(reader.handle, null);
  assert.equal(reader.watcher, null);
});

test('daemon close drains pending hydration and refuses later attachment', async t => {
  const openGate = deferred();
  const { daemon, hook, opened, transport } = await fixture(t, { openGate });
  await hook('SessionStart');
  const reader = await opened.promise;
  const joined = daemon.dispatch({ method: 'attach', threadId: id });
  const closing = daemon.close();
  openGate.resolve();
  await closing;
  assert.deepEqual(await joined, { attached: false });
  assert.equal(reader.closed, true);
  assert.equal(reader.handle, null);
  assert.equal(reader.watcher, null);
  assert.equal(transport.closed, true);
  assert.equal(daemon.server.listening, false);
  assert.deepEqual(await daemon.dispatch({ method: 'attach', threadId: id }), { attached: false });
});

test('ordinary controller reports automatic operation without a transport opt-in', async t => {
  const { daemon } = await fixture(t);
  assert.equal((await daemon.dispatch({ method: 'status' })).mode, 'automatic');
});

test('reloading a task override changes its controller without replacing the watcher', async t => {
  const { daemon, readers } = await fixture(t);
  assert.equal((await daemon.dispatch({ method: 'attach', threadId: id })).attached, true);
  const before = await daemon.dispatch({ method: 'status' });
  const document = emptyConfig();
  document.threads[id] = { settings: { mode: 'observe', minInputTokens: 250000,
    pauseMessage: 'Finish the current check.', recordDiagnostics: false } };
  await writeConfig(document, before.configPath);
  const result = await daemon.dispatch({ method: 'reload-config' });
  assert.equal(result.reloaded, true);
  assert.deepEqual(result.restartRequired, []);
  assert.deepEqual(result.threads, [{ threadId: id, reattachRequired: [], deferred: false }]);
  const after = await daemon.dispatch({ method: 'status' });
  assert.equal(after.threads[0].mode, 'observe');
  assert.equal(readers.length, 1);
  document.threads[id].settings.watchTranscript = false;
  await writeConfig(document, before.configPath);
  assert.deepEqual((await daemon.dispatch({ method: 'reload-config' })).threads[0].reattachRequired, ['watchTranscript']);
  assert.deepEqual((await daemon.dispatch({ method: 'reload-config' })).threads[0].reattachRequired, ['watchTranscript']);
  assert.equal((await daemon.dispatch({ method: 'reattach', threadId: id })).attached, true);
  assert.equal(readers.length, 2);
  assert.equal(readers[1].options.watch, false);
  assert.deepEqual((await daemon.dispatch({ method: 'reload-config' })).threads[0].reattachRequired, []);
});

test('optional collector receives actual controller decisions with their thread identity', async t => {
  const decisions = [];
  const { daemon, hook } = await fixture(t, { onDecision: (threadId, decision) => decisions.push({ threadId, decision }) });
  assert.equal((await daemon.dispatch({ method: 'attach', threadId: id })).attached, true);
  await hook('Interrupt');
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].threadId, id);
  assert.equal(decisions[0].decision.event, 'cancelled');
  assert.equal(decisions[0].decision.reason, 'user interrupt');
});

test('ordinary decisions are queryable from durable history, without putting payloads in status', async t => {
  const { daemon, hook } = await fixture(t);
  await daemon.dispatch({ method: 'attach', threadId: id });
  await hook('Interrupt');
  const status = await daemon.dispatch({ method: 'status' });
  assert.equal(status.history.maxBytes, 5_000_000_000);
  assert.equal(status.history.retentionDays, 30);
  assert.equal(status.history.failure, null);
  const history = new History({ directory: status.history.directory, readOnly: true });
  try {
    const events = [...history.read({ threadId: id })];
    assert.ok(events.some(e => e.event === 'attached' && e.runtimeVersion === status.runtime.version));
    assert.ok(events.some(e => e.event === 'cancelled' && e.reason === 'user interrupt'));
  } finally { history.close(); }
});

test('a diagnostic write failure is visible without preventing task attachment', async t => {
  const { daemon } = await fixture(t);
  t.mock.method(History.prototype, 'append', () => { throw Object.assign(new Error('private failure body'), { code: 'ENOSPC' }); });
  assert.equal((await daemon.dispatch({ method: 'attach', threadId: id })).attached, true);
  const status = await daemon.dispatch({ method: 'status' });
  assert.equal(status.history.failure.reason, 'ENOSPC');
  assert.ok(!JSON.stringify(status).includes('private failure body'));
});

test('a failed asynchronous hook attachment remains visible and clears after successful attachment', async t => {
  const { daemon, hook, transport } = await fixture(t);
  const locate = transport.locate;
  transport.locate = async () => { throw Object.assign(new Error('Private diagnostic body'), { code: 'snapshot-timeout' }); };
  await hook('SessionStart');
  await assert.rejects(daemon.dispatch({ method: 'attach', threadId: id }), { code: 'snapshot-timeout' });
  const failed = await daemon.dispatch({ method: 'status' });
  assert.deepEqual(failed.threads, []);
  assert.equal(failed.lastAttachmentFailure.threadId, id);
  assert.equal(failed.lastAttachmentFailure.reason, 'snapshot-timeout');
  assert.ok(!JSON.stringify(failed).includes('Private diagnostic body'));
  transport.locate = locate;
  assert.equal((await daemon.dispatch({ method: 'attach', threadId: id })).attached, true);
  assert.equal((await daemon.dispatch({ method: 'status' })).lastAttachmentFailure, null);
});

test('hook attachment shares its reader with command state and releases it on SessionEnd', async t => {
  const { daemon, hook, transport, readers } = await fixture(t);
  transport.status = async () => { throw new Error('Attachment must not request full task status'); };
  await hook('SessionStart');
  assert.equal((await daemon.dispatch({ method: 'attach', threadId: id })).attached, true);
  assert.equal(transport.readers.get(id), readers[0]);
  await hook('SessionEnd');
  assert.equal(transport.readers.size, 0);
  assert.equal(readers[0].closed, true);
});

test('only a hook matching the current rollout can replace an attached reader', async t => {
  const { daemon, transport, readers } = await fixture(t);
  await daemon.dispatch({ method: 'attach', threadId: id });
  const oldReader = readers[0];
  const nextPath = oldReader.path + '.next';
  await writeFile(nextPath, JSON.stringify({ type: 'session_meta', payload: { id, cli_version: '0.155.0-alpha.9.2' } }) + '\n');
  const event = { session_id: id, transcript_path: nextPath, hook_event_name: 'SessionStart' };
  await daemon.dispatch({ method: 'hook', event });
  assert.equal(transport.readers.get(id), oldReader, 'A different transcript cannot redirect an existing task');
  transport.locate = async () => ({ rolloutPath: nextPath });
  await daemon.dispatch({ method: 'hook', event });
  assert.equal((await daemon.dispatch({ method: 'attach', threadId: id })).attached, true);
  assert.equal(oldReader.closed, true);
  assert.equal(transport.readers.get(id).path, nextPath);
  assert.equal(readers.length, 2);
});

test('ordinary runtime and attached watchers survive the former thirty-minute idle cutoff', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { daemon } = await fixture(t);
  await daemon.dispatch({ method: 'attach', threadId: id });
  t.mock.timers.tick(30 * 60 * 1000 + 1);
  assert.equal(daemon.server.listening, true);
  assert.equal((await daemon.dispatch({ method: 'status' })).threads.length, 1);
});

test('ordinary startup restores remembered tasks without a hook or manual attach', async t => {
  const { daemon, transport } = await fixture(t, { persistent: true });
  await daemon.restored;
  await daemon.dispatch({ method: 'attach', threadId: id });
  await daemon.close();
  const restarted = await serve({ apiKey: 'unit-test-placeholder', transport: { ...transport, closed: false, readers: new Map() } });
  try {
    await restarted.restored;
    const status = await restarted.dispatch({ method: 'status' });
    assert.equal(status.restoring, 0);
    assert.equal(status.threads.length, 1);
    assert.equal(status.threads[0].sessionId, id);
  } finally { await restarted.close(); }
});

test('ordinary startup migrates the temporary remembered task list to persistent state', async t => {
  const { daemon, directory } = await fixture(t, { persistent: true, legacyWatchList: true });
  await daemon.restored;
  const status = await daemon.dispatch({ method: 'status' });
  assert.equal(status.threads[0]?.sessionId, id);
  const durable = path.join(directory, 'Library', 'Application Support', 'Jevpact', 'watched-threads.json');
  assert.deepEqual(JSON.parse(await readFile(durable, 'utf8')), [id]);
});

test('SessionEnd removes a task from startup restoration', async t => {
  const { daemon, hook, transport } = await fixture(t, { persistent: true });
  await daemon.restored;
  await daemon.dispatch({ method: 'attach', threadId: id });
  await hook('SessionEnd');
  await daemon.close();
  const restarted = await serve({ apiKey: 'unit-test-placeholder', transport: { ...transport, closed: false, readers: new Map() } });
  try {
    await restarted.restored;
    assert.deepEqual((await restarted.dispatch({ method: 'status' })).threads, []);
  } finally { await restarted.close(); }
});

test('a child SessionEnd carrying the parent ID cannot detach or forget the parent', async t => {
  const { daemon, transport, readers } = await fixture(t, { persistent: true });
  await daemon.restored;
  await daemon.dispatch({ method: 'attach', threadId: id });
  await daemon.dispatch({ method: 'hook', event: { session_id: id, transcript_path: readers[0].path + '.child', hook_event_name: 'SessionEnd' } });
  assert.equal((await daemon.dispatch({ method: 'status' })).threads.length, 1);
  await daemon.close();
  const restarted = await serve({ apiKey: 'unit-test-placeholder', transport: { ...transport, closed: false, readers: new Map() } });
  try {
    await restarted.restored;
    assert.equal((await restarted.dispatch({ method: 'status' })).threads.length, 1);
  } finally { await restarted.close(); }
});

test('a valid attachment is not cut off by the former three-second request timeout', async t => {
  const statusGate = deferred();
  const entered = deferred();
  const { transport } = await fixture(t, { statusGate });
  const locate = transport.locate;
  transport.locate = async (...args) => { entered.resolve(); return locate(...args); };
  const pending = call({ method: 'attach', threadId: id }, { timeout: 20000 })
    .then(value => ({ value }), error => ({ error }));
  await entered.promise;
  await new Promise(resolve => setTimeout(resolve, 3001));
  statusGate.resolve();
  const result = await pending;
  assert.equal(result.error, undefined);
  assert.equal(result.value.attached, true);
});

test('T3 attachment accepts host IDs without a rollout and remains observation-only after configuration reload', async t => {
  const threadId = 'mcp:launch:disposable-daemon-test';
  let readerClosed = false;
  const readerFactory = createT3ReaderFactory({ environmentId: 'environment-test', projectRoot: '/project',
    subscription: {
      async open({ onFrame }) {
        onFrame({ kind: 'snapshot', snapshotSequence: 1, projection: { thread: { id: threadId },
          runs: [], messages: [], turnItems: [], providerThreads: [], providerTurns: [], subagents: [] } });
        onFrame({ kind: 'synchronized' });
      },
      close() { readerClosed = true; },
    },
  });
  const { daemon, transport } = await fixture(t, { readerFactory, onlyThreadId: threadId });
  transport.locate = async () => { throw new Error('T3 must not consult the native Codex index'); };
  transport.bindReader = () => { throw new Error('T3 must not bind to the native Codex transport'); };
  const attached = await daemon.dispatch({ method: 'attach', threadId });
  assert.equal(attached.attached, true);
  assert.equal(attached.thread.mode, 'observe');
  const document = emptyConfig(); document.global.settings.mode = 'automatic';
  await writeConfig(document);
  await daemon.dispatch({ method: 'reload-config' });
  const status = await daemon.dispatch({ method: 'status' });
  assert.equal(status.mode, 'observe');
  assert.equal(status.threads[0].mode, 'observe');
  assert.equal(status.threads[0].observationMode, 't3-subscription');
  await daemon.close();
  assert.equal(readerClosed, true);
});

test('daemon shutdown closes an injected reader whose initial subscription is still pending', async t => {
  const threadId = 'mcp:launch:pending-subscription';
  const entered = deferred();
  let rejectOpen;
  let closed = false;
  const readerFactory = createT3ReaderFactory({ environmentId: 'environment-test', subscription: {
    open() { entered.resolve(); return new Promise((_resolve, reject) => { rejectOpen = reject; }); },
    close() { closed = true; rejectOpen?.(Object.assign(new Error('closed'), { code: 't3-subscription-closed' })); },
  } });
  const { daemon } = await fixture(t, { readerFactory, onlyThreadId: threadId });
  const attachment = daemon.dispatch({ method: 'attach', threadId });
  await entered.promise;
  await daemon.close();
  assert.equal(closed, true);
  assert.deepEqual(await attachment, { attached: false });
});
