import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { healthFailure, probe, readStatus } from '../bin/jevpact-health.js';

const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const version = '0.1.0-dev.1+codex.test';
const watched = { sessionId: id, supported: true, observationMode: 'watch', watchError: null };
const healthy = { running: true, mode: 'automatic', runtime: { version }, threads: [watched] };

test('health check distinguishes a live installed controller from missing supervision', () => {
  assert.equal(healthFailure(healthy, version, [id]), null);
  assert.match(healthFailure(null, version, [id]), /not responding/);
  assert.match(healthFailure(healthy, 'another-version', [id]), /different installed version/);
  assert.match(healthFailure({ ...healthy, threads: [] }, version, [id]), /not attached/);
  assert.match(healthFailure({ ...healthy, threads: [{ ...watched, watchError: 'closed' }] }, version, [id]), /not being watched/);
});

test('probe alerts once after two failures and once on recovery', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jp-health-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const statePath = path.join(directory, 'state.json');
  const notifications = [];
  let current = healthy;
  const run = () => probe({ expectedVersion: version, expectedThreads: [id], statePath,
    getStatus: async () => current, notify: async (...args) => notifications.push(args) });

  assert.equal((await run()).healthy, true);
  current = null;
  assert.equal((await run()).failures, 1);
  assert.deepEqual(notifications, []);
  assert.equal((await run()).failures, 2);
  assert.deepEqual(notifications.map(item => item[0]), ['failure']);
  await run();
  assert.equal(notifications.length, 1);
  current = healthy;
  assert.equal((await run()).healthy, true);
  assert.deepEqual(notifications.map(item => item[0]), ['failure', 'recovery']);
  await run();
  assert.equal(notifications.length, 2);
  current = { ...healthy, threads: [] };
  await run();
  await run();
  assert.deepEqual(notifications.map(item => item[0]), ['failure', 'recovery', 'failure']);
  assert.match(notifications[2][1], /not attached/);
});

// The audited live reply was 142,620 bytes. Keep the probe's existing cap.
test('probe reads compact health from a controller whose full status is 142620 bytes', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jp-health-'));
  const socket = path.join(directory, 'probe.sock');
  const full = { ...healthy, decisions: '' };
  full.decisions = 'x'.repeat(142620 - Buffer.byteLength(JSON.stringify(full) + '\n'));
  assert.equal(Buffer.byteLength(JSON.stringify(full) + '\n'), 142620);
  const server = net.createServer(client => client.once('data', chunk => {
    const request = JSON.parse(String(chunk));
    client.end(JSON.stringify(request.method === 'health-status' ? healthy : full) + '\n');
  }));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  await new Promise(resolve => server.listen(socket, resolve));
  assert.equal(healthFailure(await readStatus(socket, [id]), version, [id]), null);
});
