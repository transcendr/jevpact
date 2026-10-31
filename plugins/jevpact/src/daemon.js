import net from 'node:net';
import { chmod, lstat, unlink, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Transcript } from './transcript.js';
import { Codex } from './codex.js';
import { evaluate } from './jev.js';
import { decide } from './policy.js';
import { Controller, PAUSE_PREFIX, RESUME_PREFIX } from './controller.js';
import { ensureRuntime, ensureState, socketPath, historyDir } from './paths.js';
import { History } from './history.js';
import { call } from './rpc.js';
import { resolveKey } from './credentials.js';
import { readConfig, resolveConfig, projectIdentity, configPath, CONFIG_REATTACH_KEYS, CONFIG_RESTART_KEYS } from './config.js';

export async function serve({ apiKey, config = {}, onlyThreads = [], idleMs = 0, transport, readerFactory, onDecision, decisionPolicy = decide } = {}) {
  apiKey ||= await resolveKey();
  if (!apiKey) throw Object.assign(new Error('Set JEV_TEST_KEY or JEV_API_KEY before starting Jevpact'), { code: 'missing-key' });
  const directory = await ensureRuntime();
  try { await call({ method: 'status' }); return { alreadyRunning: true }; }
  catch (e) { if (!['ENOENT', 'ECONNREFUSED'].includes(e.code)) throw e; }
  try {
    const info = await lstat(socketPath());
    if (!info.isSocket() || (process.getuid && info.uid !== process.getuid())) throw new Error('Unsafe socket');
    await unlink(socketPath());
  } catch (e) { if (e.code !== 'ENOENT') throw e; }

  const codex = transport ?? new Codex();
  const source = readerFactory ?? {
    validateThreadId: id => /^[0-9a-f-]{36}$/.test(id ?? ''),
    locate: id => codex.locate(id),
    create({ threadId, location, settings, requestedPath }) {
      if (!location.rolloutPath) throw Object.assign(new Error('Transcript unavailable'), { code: 'transcript-unavailable' });
      if (requestedPath && requestedPath !== location.rolloutPath) throw Object.assign(new Error('Transcript identity mismatch'), { code: 'transcript-identity-mismatch' });
      return new Transcript({ sessionId: threadId, controlPrefixes: [PAUSE_PREFIX, RESUME_PREFIX],
        watch: settings.watchTranscript, allowHookFallback: settings.allowHookFallback, maxLineBytes: settings.maxLineBytes });
    },
  };
  if (readerFactory && source.observationOnly !== true) throw new Error('Injected readers must be observation-only');
  let savedConfig = await readConfig();
  const effectiveFor = state => {
    const resolved = resolveConfig(savedConfig, { threadId: state.threadId, cwd: state.cwd, base: config });
    if (source.observationOnly) resolved.settings = { ...resolved.settings, mode: 'observe' };
    return resolved;
  };
  const globalSettings = resolveConfig(savedConfig, { base: config }).settings;
  const runtime = { root: fileURLToPath(new URL('../', import.meta.url)),
    version: JSON.parse(await readFile(new URL('../.codex-plugin/plugin.json', import.meta.url), 'utf8')).version };
  const historyOptions = { directory: globalSettings.historyDirectory ?? (onlyThreads.length ? path.join(directory, 'history') : historyDir()),
    retentionDays: globalSettings.historyRetentionDays, maxBytes: globalSettings.historyMaxBytes };
  let history = null;
  let historyFailure = null;
  let historyExpiry;
  const historyError = error => { historyFailure = { at: new Date().toISOString(), reason: error.code ?? error.name ?? 'Error' }; };
  try { history = new History(historyOptions); } catch (error) { historyError(error); }
  const scheduleExpiry = () => {
    if (!history || historyExpiry) return;
    const { oldestAt } = history.stats();
    if (oldestAt == null) return;
    // Wake at expiry, not on a polling cadence. Node's timer maximum is 2^31-1.
    const delay = Math.min(2 ** 31 - 1, Math.max(1, oldestAt + historyOptions.retentionDays * 86400000 - Date.now() + 1));
    historyExpiry = setTimeout(() => {
      historyExpiry = null;
      try { history.prune(); scheduleExpiry(); } catch (error) { historyError(error); }
    }, delay);
    historyExpiry.unref();
  };
  try { scheduleExpiry(); } catch (error) { historyError(error); }
  const retain = (id, event) => {
    if (!history || threads.get(id)?.settings.recordDiagnostics === false) return;
    try {
      // Optional diagnostic metadata follows JSON's usual omission semantics.
      // Request/response bodies themselves have already been serialized by Jev.
      history.append(id, JSON.parse(JSON.stringify({ ...event, runtimeVersion: runtime.version })));
      scheduleExpiry();
    }
    catch (error) { historyError(error); }
  };
  const threads = new Map();
  const attaching = new Map();
  const remember = onlyThreads.length === 0;
  if (readerFactory && !/^[a-zA-Z0-9_-]+$/.test(source.namespace ?? '')) throw new Error('Injected reader namespace is required');
  const watchListName = readerFactory ? `watched-threads.${source.namespace}.json` : 'watched-threads.json';
  const watchListPath = path.join(remember ? await ensureState() : directory, watchListName);
  const legacyWatchListPath = path.join(directory, watchListName);
  let remembered = new Set();
  let migratedWatchList = false;
  if (remember) {
    try {
      let contents;
      try { contents = await readFile(watchListPath, 'utf8'); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        contents = await readFile(legacyWatchListPath, 'utf8');
        migratedWatchList = true;
      }
      const ids = JSON.parse(contents);
      if (!Array.isArray(ids) || ids.some(id => !source.validateThreadId(id))) throw new Error('Invalid remembered task list');
      remembered = new Set(ids);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  let registryWrite = Promise.resolve();
  let restoringCount = remembered.size;
  const saveWatchList = () => {
    if (!remember) return Promise.resolve();
    registryWrite = registryWrite.catch(() => {}).then(async () => {
      const temporary = `${watchListPath}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify([...remembered]) + '\n', { mode: 0o600 });
      await rename(temporary, watchListPath);
    });
    return registryWrite;
  };
  if (migratedWatchList) await saveWatchList();
  let lastAttachmentFailure = null;
  let closing = false;
  let timer;
  // Production stays available until explicitly stopped. Only an explicitly
  // bounded experiment may request an idle shutdown.
  const touch = () => { if (!closing && idleMs > 0) { clearTimeout(timer); timer = setTimeout(() => close(), idleMs); } };
  const closeThread = async id => {
    const attempt = attaching.get(id);
    if (attempt) { attempt.cancelled = true; if (readerFactory) await attempt.reader?.close(); }
    const entry = threads.get(id);
    if (!entry) return;
    retain(id, { time: Date.now(), event: 'detached', reason: closing ? 'controller-stopped' : 'session-ended-or-replaced' });
    threads.delete(id);
    entry.controller.close();
    if (!readerFactory) codex.unbindReader(id, entry.reader);
    await entry.reader.close();
  };
  const attach = async (id, requestedPath) => {
    if (closing) return null;
    if (threads.has(id)) return threads.get(id);
    if (attaching.has(id)) return attaching.get(id).promise;
    if (onlyThreads.length && !onlyThreads.includes(id)) return null;
    const attempt = { cancelled: false, promise: null, path: requestedPath ?? null };
    attempt.promise = (async () => {
      let reader;
      let published = false;
      try {
        const state = await source.locate(id);
        if (closing || attempt.cancelled) return null;
        attempt.path = state.rolloutPath;
        const resolved = effectiveFor({ threadId: id, cwd: state.cwd });
        const settings = resolved.settings;
        reader = source.create({ threadId: id, location: state, settings, requestedPath });
        attempt.reader = reader;
        await reader.open(state.rolloutPath);
        if (closing || attempt.cancelled) return null;
        if (!reader.snapshot().supported) throw Object.assign(new Error('Unsupported transcript'), { code: reader.snapshot().disabledReason });
        if (reader.snapshot().sessionId !== id) throw Object.assign(new Error('Reader identity mismatch'), { code: 'reader-identity-mismatch' });
        if (!readerFactory) codex.bindReader(id, reader);
        const controller = new Controller({ reader, codex, config: settings,
          templateContext: { projectRoot: projectIdentity(state.cwd), profileName: resolved.profileName },
          evaluate: (packet, { signal, purpose, onRequest }) => evaluate(packet, { apiKey, signal, purpose, onRequest }), decide: decisionPolicy });
        controller.on('diagnostic', event => retain(id, event));
        if (onDecision) controller.on('decision', decision => onDecision(id, decision));
        const entry = { id, cwd: state.cwd, reader, controller, settings, resolved, configState: null,
          hookCounts: {}, lastHook: null };
        threads.set(id, entry);
        retain(id, { time: Date.now(), event: 'attached', rolloutPath: state.rolloutPath,
          config: settings, scope: onlyThreads.length ? 'scoped' : 'global' });
        if (lastAttachmentFailure?.threadId === id) lastAttachmentFailure = null;
        published = true;
        reader.on('change', touch);
        if (remember && settings.restoreAttached && !remembered.has(id)) {
          remembered.add(id);
          await saveWatchList();
          if (closing || attempt.cancelled) return null;
        }
        controller.wake();
        return entry;
      } catch (error) {
        if (closing || attempt.cancelled) return null;
        // Hooks return immediately; retain the cause of an asynchronous refusal
        // so an empty attachment list cannot silently hide failed supervision.
        lastAttachmentFailure = { threadId: id, reason: error.code ?? error.name ?? 'Error', at: new Date().toISOString() };
        retain(id, { time: Date.now(), event: 'attachment-failed', reason: lastAttachmentFailure.reason });
        throw error;
      } finally {
        if (reader && !published) {
          if (!readerFactory) codex.unbindReader(id, reader);
          await reader.close();
        }
      }
    })();
    attaching.set(id, attempt);
    try { return await attempt.promise; }
    finally { if (attaching.get(id) === attempt) attaching.delete(id); }
  };
  const dispatch = async request => {
    touch();
    if (request.method === 'status') return { running: true, pid: process.pid, runtime, lastAttachmentFailure,
      configPath: configPath(),
      history: { ...historyOptions, available: !!history, failure: historyFailure },
      restoring: restoringCount,
      mode: source.observationOnly ? 'observe' : 'automatic',
      threads: [...threads.values()].map(e => ({ ...e.controller.view(),
        configState: e.configState && { ...e.configState, deferred: !!e.controller.nextConfig },
        matchedProject: e.resolved.matchedProject,
        observationMode: e.reader.snapshot().observationMode, watchError: e.reader.snapshot().watchError,
        hookCounts: e.hookCounts, lastHook: e.lastHook })) };
    if (request.method === 'reload-config') {
      const updated = await readConfig();
      const updatedGlobal = resolveConfig(updated, { base: config }).settings;
      const restartRequired = CONFIG_RESTART_KEYS.filter(key =>
        (key === 'historyDirectory' ? updatedGlobal[key] ?? (onlyThreads.length ? path.join(directory, 'history') : historyDir()) : updatedGlobal[key])
          !== (key === 'historyDirectory' ? historyOptions.directory : historyOptions[key === 'historyRetentionDays' ? 'retentionDays' : 'maxBytes']));
      savedConfig = updated;
      const changed = [];
      let registryChanged = false;
      for (const entry of threads.values()) {
        const resolved = effectiveFor({ threadId: entry.id, cwd: entry.cwd });
        const reattachRequired = readerFactory ? [] : CONFIG_REATTACH_KEYS.filter(key => {
          const readerKey = key === 'watchTranscript' ? 'watch' : key;
          return entry.reader.options[readerKey] !== resolved.settings[key];
        });
        const changedSettings = Object.keys(resolved.settings).some(key => entry.settings[key] !== resolved.settings[key]);
        const result = changedSettings ? entry.controller.reconfigure(resolved.settings)
          : { deferred: !!entry.controller.nextConfig };
        entry.controller.templateContext = { projectRoot: projectIdentity(entry.cwd), profileName: resolved.profileName };
        entry.settings = resolved.settings;
        entry.resolved = resolved;
        entry.configState = { reattachRequired, deferred: result.deferred };
        if (remember && resolved.settings.restoreAttached !== remembered.has(entry.id)) {
          if (resolved.settings.restoreAttached) remembered.add(entry.id);
          else remembered.delete(entry.id);
          registryChanged = true;
        }
        changed.push({ threadId: entry.id, ...entry.configState });
      }
      if (registryChanged) await saveWatchList();
      return { reloaded: true, restartRequired, threads: changed };
    }
    if (request.method === 'stop') { setTimeout(close, 20); return { stopped: true }; }
    if (request.method === 'reattach') {
      if (!source.validateThreadId(request.threadId)) throw new Error('Invalid thread ID');
      const current = threads.get(request.threadId);
      if (current?.controller.pending) throw Object.assign(new Error('A controller action is in progress'), { code: 'action-in-progress' });
      if (current) await closeThread(request.threadId);
      const replacement = await attach(request.threadId);
      return { attached: !!replacement, ...(replacement ? { thread: replacement.controller.view() } : {}) };
    }
    if (request.method === 'attach') {
      if (!source.validateThreadId(request.threadId)) throw new Error('Invalid thread ID');
      const entry = await attach(request.threadId);
      return { attached: !!entry, ...(entry ? { thread: entry.controller.view() } : {}) };
    }
    if (request.method !== 'hook') throw new Error('Unknown request');
    if (readerFactory) return {};
    const event = request.event;
    if (!event || !/^[0-9a-f-]{36}$/.test(event.session_id ?? '')) return {};
    if (event.hook_event_name === 'SessionEnd') {
      const expectedPath = threads.get(event.session_id)?.reader.path ?? attaching.get(event.session_id)?.path;
      if (event.transcript_path && expectedPath && event.transcript_path !== expectedPath) return {};
      await closeThread(event.session_id);
      if (remembered.delete(event.session_id)) await saveWatchList();
      return {};
    }
    let entry = threads.get(event.session_id);
    if (!entry) {
      // Hooks remain fast: initial transcript hydration is asynchronous and never blocks the model.
      attach(event.session_id, event.transcript_path).catch(() => {});
      return {};
    }
    if (event.transcript_path && event.transcript_path !== entry.reader.path) {
      // A subagent hook can carry its parent's ID. Never attach it to the parent's controller.
      const status = await codex.locate(event.session_id);
      if (event.transcript_path !== status.rolloutPath) return {};
      // Codex moved the same task to a new current rollout. Replace the reader
      // rather than continuing to observe the now-obsolete file.
      await closeThread(event.session_id);
      attach(event.session_id, event.transcript_path).catch(() => {});
      return {};
    }
    await entry.reader.refresh();
    entry.hookCounts[event.hook_event_name] = (entry.hookCounts[event.hook_event_name] ?? 0) + 1;
    entry.lastHook = { event: event.hook_event_name, turnId: event.turn_id ?? null, at: new Date().toISOString() };
    const response = entry.controller.hook(event);
    entry.controller.wake();
    return response;
  };

  const server = net.createServer(socket => {
    let data = '';
    socket.setTimeout(3000, () => socket.destroy());
    socket.on('error', () => {});
    socket.on('data', async chunk => {
      data += chunk.toString();
      if (data.length > 16384) return socket.destroy();
      if (!data.includes('\n') || socket.handled) return;
      socket.handled = true;
      // The timeout protects receipt of a request, not a valid attachment that
      // is still reading its rollout. The requesting client owns that deadline.
      socket.setTimeout(0);
      try { socket.end(JSON.stringify(await dispatch(JSON.parse(data.split('\n')[0]))) + '\n'); }
      catch (e) { socket.end(JSON.stringify({ error: e.code ?? e.name ?? 'Error' }) + '\n'); }
    });
  });
  async function close() {
    if (closing) return;
    closing = true;
    clearTimeout(timer);
    for (const attempt of attaching.values()) {
      attempt.cancelled = true;
      if (readerFactory) await attempt.reader?.close();
    }
    for (const id of threads.keys()) await closeThread(id);
    codex.close();
    await Promise.allSettled([...attaching.values()].map(attempt => attempt.promise));
    await registryWrite.catch(() => {});
    clearTimeout(historyExpiry);
    history?.close();
    await new Promise(resolve => server.close(resolve));
    try { await unlink(socketPath()); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    process.removeListener('SIGINT', close);
    process.removeListener('SIGTERM', close);
  }
  server.on('error', error => { throw error; });
  await new Promise(resolve => server.listen(socketPath(), resolve));
  await chmod(socketPath(), 0o600);
  const restored = (async () => {
    for (const id of [...remembered]) {
      try { if (!closing && remembered.has(id)) await attach(id); }
      catch { /* The attachment failure is exposed by status. */ }
      finally { restoringCount--; }
    }
  })();
  touch();
  process.send?.({ ready: true });
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
  return { server, close, dispatch, restored };
}
