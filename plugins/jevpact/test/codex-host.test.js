import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isT3OwnedRollout } from '../src/codex-host.js';

const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
test('only the exact T3 session marker excludes a native Codex session', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'jp-host-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'rollout.jsonl');
  for (const originator of ['T3 Code', 'Codex Desktop', 'codex_cli_rs', undefined]) {
    await writeFile(file, JSON.stringify({ type: 'session_meta', payload: { id, originator } }) + '\n');
    assert.equal(await isT3OwnedRollout(file, id), originator === 'T3 Code');
    assert.equal(await isT3OwnedRollout(file, 'another-session'), false);
  }
  await writeFile(file, '{unfinished');
  assert.equal(await isT3OwnedRollout(file, id), false);
  assert.equal(await isT3OwnedRollout(path.join(dir, 'missing'), id), false);
});
