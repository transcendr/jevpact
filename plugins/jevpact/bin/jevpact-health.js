#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, mkdir, rename, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const taskIdPattern = /^[0-9a-f-]{36}$/;

export const defaultStatePath = () => process.env.JEVPACT_HEALTH_STATE_PATH
  || path.join(os.homedir(), 'Library', 'Application Support', 'Jevpact', 'health-state.json');
export const defaultSocketPath = () => process.env.JEVPACT_SOCKET_PATH
  || path.join(os.tmpdir(), `jevpact-${process.getuid?.() ?? os.userInfo().username}`, 'controller.sock');

export function healthFailure(status, expectedVersion, expectedThreads) {
  if (!expectedVersion) return 'Installed Jevpact package is unavailable';
  if (!status?.running || status.source?.kind !== 't3' && status.mode !== 'automatic') return 'Jevpact controller is not responding';
  if (status.runtime?.version !== expectedVersion) return 'Jevpact is running a different installed version';
  for (const id of expectedThreads) {
    const thread = status.threads?.find(item => item.sessionId === id);
    if (!thread) return `Task ${id} is not attached`;
    if (!thread.supported || thread.observationMode !== 'watch' || thread.watchError) {
      return `Task ${id} is not being watched`;
    }
  }
  return null;
}

export function readStatus(socketPath = defaultSocketPath(), expectedThreads = []) {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(socketPath);
    let data = '';
    const timer = setTimeout(() => client.destroy(new Error('Jevpact status timed out')), 3000);
    client.once('connect', () => client.write(JSON.stringify({ method: 'health-status', expectedThreads }) + '\n'));
    client.on('data', chunk => {
      data += chunk.toString();
      if (data.length > 128000) return client.destroy(new Error('Oversized status reply'));
      if (!data.includes('\n')) return;
      clearTimeout(timer);
      client.end();
      try { resolve(JSON.parse(data.split('\n')[0])); } catch (error) { reject(error); }
    });
    client.once('error', error => { clearTimeout(timer); reject(error); });
    client.once('end', () => { clearTimeout(timer); if (!data.includes('\n')) reject(new Error('Incomplete status reply')); });
  });
}

async function saveState(statePath, state) {
  await mkdir(path.dirname(statePath), { recursive: true, mode: 0o700 });
  const temporary = `${statePath}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(state) + '\n', { mode: 0o600, flag: 'wx' });
  await rename(temporary, statePath);
}

export async function notifyUser(kind, reason) {
  const title = kind === 'failure' ? 'Jevpact needs attention' : 'Jevpact recovered';
  const message = kind === 'failure' ? reason : 'The controller and expected task are being watched again.';
  await exec('/usr/bin/osascript', ['-e', `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)} sound name "Basso"`], { timeout: 5000 });
}

export async function probe({ expectedVersion, expectedThreads = [], statePath = defaultStatePath(),
  getStatus = () => readStatus(defaultSocketPath(), expectedThreads), notify = notifyUser } = {}) {
  let previous = { failures: 0, alerted: false };
  try {
    const stored = JSON.parse(await readFile(statePath, 'utf8'));
    if (stored && Number.isSafeInteger(stored.failures) && stored.failures >= 0 && typeof stored.alerted === 'boolean') previous = stored;
  } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }

  let status;
  try { status = await getStatus(); } catch { status = null; }
  const failure = healthFailure(status, expectedVersion, expectedThreads);
  const state = { failures: failure ? previous.failures + 1 : 0, alerted: previous.alerted,
    reason: failure, checkedAt: new Date().toISOString() };
  await saveState(statePath, state);
  if (failure && state.failures >= 2 && !state.alerted) {
    await notify('failure', failure);
    state.alerted = true;
    await saveState(statePath, state);
  } else if (!failure && state.alerted) {
    await notify('recovery');
    state.alerted = false;
    await saveState(statePath, state);
  }
  return { healthy: !failure, ...state };
}

async function main(args) {
  let pluginPath;
  const expectedThreads = [];
  while (args.length) {
    const flag = args.shift();
    if (flag === '--plugin') pluginPath = args.shift();
    else if (flag === '--expect-thread') expectedThreads.push(args.shift());
    else throw new Error(`Unknown health option ${flag}`);
  }
  if (!pluginPath || !path.isAbsolute(pluginPath) || expectedThreads.some(id => !taskIdPattern.test(id ?? ''))) {
    throw new Error('Usage: jevpact-health --plugin ABSOLUTE_PATH [--expect-thread TASK_ID]');
  }
  let expectedVersion = null;
  try { expectedVersion = JSON.parse(await readFile(path.join(pluginPath, '.codex-plugin', 'plugin.json'), 'utf8')).version; }
  catch { /* A missing installed package is itself an unhealthy state. */ }
  const result = await probe({ expectedVersion, expectedThreads });
  if (!result.healthy) {
    if (result.failures === 2) console.error(result.reason);
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
