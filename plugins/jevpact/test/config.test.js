import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_GLOBAL_PROFILE, configDirectory, emptyConfig, readConfig, writeConfig, resolveConfig, validateConfig, projectIdentity, t3ConfigThreadId } from '../src/config.js';
import { configCommand } from '../src/config-cli.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jevpact-config-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, file: path.join(root, '.jevpact', 'config.json') };
}

test('default configuration directory follows the Codex home, while an explicit override wins', () => {
  const previous = { codexHome: process.env.CODEX_HOME, configHome: process.env.JEVPACT_CONFIG_HOME };
  try {
    delete process.env.JEVPACT_CONFIG_HOME;
    process.env.CODEX_HOME = path.join(os.homedir(), '.codex');
    assert.equal(configDirectory(), path.join(os.homedir(), '.jevpact'));
    process.env.CODEX_HOME = path.join(os.homedir(), '.codex-strada');
    assert.match(configDirectory(), /^.*\/\.jevpact-[0-9a-f]{12}$/);
    process.env.JEVPACT_CONFIG_HOME = '/tmp/jevpact-explicit-config';
    assert.equal(configDirectory(), '/tmp/jevpact-explicit-config');
  } finally {
    for (const [name, value] of [['CODEX_HOME', previous.codexHome], ['JEVPACT_CONFIG_HOME', previous.configHome]]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('the default global profile is created on first read and scoped overrides resolve above it', async t => {
  const { root, file } = await fixture(t);
  assert.deepEqual(await readConfig(file), emptyConfig());
  assert.equal((await stat(path.dirname(file))).mode & 0o777, 0o700);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const document = emptyConfig();
  const project = path.join(root, 'project');
  const thread = '11111111-1111-1111-1111-111111111111';
  document.profiles.deep = { minInputTokens: 300000, pauseMessage: 'Finish this connected step.' };
  document.global.settings.minInputTokens = 210000;
  document.projects[project] = { profile: 'deep', settings: { minGrowthTokens: 50000 } };
  document.threads[thread] = { settings: { minInputTokens: 350000 } };
  await writeConfig(document, file);
  assert.equal((await stat(path.dirname(file))).mode & 0o777, 0o700);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(await readConfig(file), document);
  const effective = resolveConfig(document, { threadId: thread, cwd: path.join(project, 'nested') });
  assert.equal(effective.settings.minInputTokens, 350000);
  assert.equal(effective.settings.minGrowthTokens, 50000);
  assert.equal(effective.settings.pauseMessage, 'Finish this connected step.');
  assert.equal(effective.sources.minInputTokens, `thread:${thread}`);
  assert.equal(effective.matchedProject, project);
  assert.equal(effective.profileName, 'deep');
});

test('a missing default global profile falls back to source values and is recreated without losing overrides', async t => {
  const { file } = await fixture(t);
  const document = emptyConfig();
  document.global.settings.minGrowthTokens = 50000;
  delete document.profiles[DEFAULT_GLOBAL_PROFILE];
  assert.equal(resolveConfig(document).settings.minInputTokens, 200000);
  assert.equal(resolveConfig(document).sources.minInputTokens, 'default');
  await writeConfig(document, file);
  const repaired = await readConfig(file);
  assert.deepEqual(repaired.profiles[DEFAULT_GLOBAL_PROFILE], emptyConfig().profiles[DEFAULT_GLOBAL_PROFILE]);
  assert.equal(repaired.global.settings.minGrowthTokens, 50000);
  assert.deepEqual(await readConfig(file), repaired);
  delete repaired.global.profile;
  await writeConfig(repaired, file);
  assert.equal((await readConfig(file)).global.profile, DEFAULT_GLOBAL_PROFILE);
  repaired.global.profile = 'missing-custom';
  await writeConfig(repaired, file);
  assert.equal(resolveConfig(repaired).sources.minInputTokens, 'default');
  assert.equal((await readConfig(file)).global.profile, DEFAULT_GLOBAL_PROFILE);
});

test('source defaults remain usable when a missing profile cannot be saved', async t => {
  const { file } = await fixture(t);
  const directory = path.dirname(file);
  await mkdir(directory, { mode: 0o500 });
  try {
    const fallback = await readConfig(file);
    assert.equal(fallback.global.profile, undefined);
    assert.equal(resolveConfig(fallback).settings.minInputTokens, 200000);
    await assert.rejects(stat(file), { code: 'ENOENT' });
  } finally { await chmod(directory, 0o700); }
});

test('invalid settings, missing profiles, and global-only settings in a project fail validation', () => {
  const document = emptyConfig();
  document.projects['/tmp/example'] = { settings: { historyMaxBytes: 1_000_000 } };
  assert.throws(() => validateConfig(document), /historyMaxBytes is global only/);
  delete document.projects['/tmp/example'].settings.historyMaxBytes;
  document.projects['/tmp/example'].profile = 'missing';
  assert.throws(() => validateConfig(document), /missing profile/);
  delete document.projects['/tmp/example'].profile;
  document.global.settings.reserveRatio = 2;
  assert.throws(() => validateConfig(document), /reserveRatio/);
});

test('a managed Git worktree inherits its main checkout project settings', async t => {
  const { root } = await fixture(t);
  const main = path.join(root, 'main');
  const worktree = path.join(root, 'worktree');
  const gitDirectory = path.join(main, '.git', 'worktrees', 'one');
  await mkdir(gitDirectory, { recursive: true });
  await mkdir(path.join(worktree, 'nested'), { recursive: true });
  await writeFile(path.join(gitDirectory, 'commondir'), '../..\n');
  await writeFile(path.join(worktree, '.git'), `gitdir: ${gitDirectory}\n`);
  const document = emptyConfig();
  document.projects[root] = { settings: { mode: 'off' } };
  document.projects[main] = { settings: { mode: 'observe' } };
  assert.equal(projectIdentity(path.join(worktree, 'nested')), main);
  assert.equal(resolveConfig(document, { cwd: path.join(worktree, 'nested') }).settings.mode, 'observe');
});

test('an oversized write is rejected before creating a config directory', async t => {
  const { file } = await fixture(t);
  const document = emptyConfig();
  for (let i = 0; i < 300; i++) document.profiles[`p${i}`] = { pauseMessage: 'a'.repeat(4000) };
  await assert.rejects(writeConfig(document, file), /exceeds 1 MB/);
  await assert.rejects(stat(path.dirname(file)), { code: 'ENOENT' });
});

test('CLI saves scoped changes and reusable profiles, and reports the runtime reload separately', async t => {
  const { root, file } = await fixture(t);
  const project = path.join(root, 'project');
  const cli = args => configCommand(args, { file, reload: async () => ({ state: 'not-running' }) });
  const saved = JSON.parse(await cli(['set', 'minInputTokens', '250000', '--project', project, '--json']));
  assert.equal(saved.saved, true);
  assert.equal(saved.runtime.state, 'not-running');
  await cli(['set', 'pauseMessage', 'Finish the current check.', '--project', project]);
  await cli(['profile', 'save', 'deep-work', '--project', project]);
  const other = path.join(root, 'other');
  await cli(['profile', 'apply', 'deep-work', '--project', other]);
  const shown = JSON.parse(await cli(['show', '--project', other, '--json']));
  assert.equal(shown.effective.minInputTokens, 250000);
  assert.equal(shown.effective.pauseMessage, 'Finish the current check.');
  assert.equal(shown.sources.minInputTokens, `project:${other}:profile:deep-work`);
  await cli(['set', 'minInputTokens', '260000', '--project', other]);
  assert.equal(JSON.parse(await cli(['show', '--project', other, '--json'])).effective.minInputTokens, 260000);
  await cli(['reset', 'minInputTokens', '--project', other]);
  assert.equal(JSON.parse(await cli(['show', '--project', other, '--json'])).effective.minInputTokens, 250000);
  await assert.rejects(cli(['profile', 'delete', 'deep-work']), /still applied/);
  await cli(['clear', '--project', other]);
  assert.equal(JSON.parse(await cli(['show', '--project', other, '--json'])).profile, null);
  assert.equal(JSON.parse(await cli(['show', '--project', other, '--json'])).effective.minInputTokens, 200000);
});

test('the editable global profile supplies task defaults and can hold global-only values', async t => {
  const { file } = await fixture(t);
  const cli = args => configCommand(args, { file, reload: async () => ({ state: 'not-running' }) });
  await cli(['profile', 'set', 'default', 'minInputTokens', '275000']);
  const thread = '22222222-2222-2222-2222-222222222222';
  const shown = JSON.parse(await cli(['show', '--thread', thread, '--json']));
  assert.equal(shown.effective.minInputTokens, 275000);
  assert.equal(shown.sources.minInputTokens, 'global:profile:default');
  assert.equal(resolveConfig(await readConfig(file), { threadId: thread }).profileName, 'default');
  await cli(['profile', 'set', 'default', 'historyRetentionDays', '45']);
  assert.equal(JSON.parse(await cli(['show', '--global', '--json'])).effective.historyRetentionDays, 45);
  await assert.rejects(cli(['profile', 'apply', 'default', '--project', '/tmp/jevpact-profile-test']), /historyRetentionDays is global only/);
  await cli(['profile', 'save', 'saved-global', '--global']);
  assert.equal(JSON.parse(await cli(['profile', 'show', 'saved-global', '--json'])).settings.historyRetentionDays, 45);
  await cli(['profile', 'apply', 'saved-global', '--global']);
  assert.equal(JSON.parse(await cli(['show', '--global', '--json'])).profile, 'saved-global');
  await cli(['profile', 'clear', '--global']);
  assert.equal(JSON.parse(await cli(['show', '--global', '--json'])).profile, DEFAULT_GLOBAL_PROFILE);
  await cli(['profile', 'unset', 'default', 'minInputTokens']);
  assert.equal(JSON.parse(await cli(['show', '--thread', thread, '--json'])).effective.minInputTokens, 200000);
  await assert.rejects(cli(['profile', 'delete', 'default']), /recreated when missing/);
});

test('message templates validate at save time and the CLI lists supported tokens', async t => {
  const { file } = await fixture(t);
  const cli = args => configCommand(args, { file, reload: async () => ({ state: 'not-running' }) });
  const tokens = JSON.parse(await cli(['tokens', '--json']));
  assert.ok(tokens.some(item => item.token === 'assistant.lastBeforeCompaction'));
  await cli(['set', 'resumeMessage', 'Continue from {{assistant.lastBeforeCompaction}}.', '--global']);
  assert.equal(JSON.parse(await cli(['show', '--global', '--json'])).effective.resumeMessage,
    'Continue from {{assistant.lastBeforeCompaction}}.');
  await assert.rejects(cli(['set', 'resumeMessage', '{{compaction.recordText}}', '--global']), /native compaction content is encrypted/);
  await assert.rejects(cli(['set', 'pauseMessage', '{{unknown.token}}', '--global']), /unknown message token/);
});


test('T3 per-thread overrides round-trip through saved configuration and isolate environments', async t => {
  const { file } = await fixture(t);
  const key = t3ConfigThreadId('environment-a', 'mcp:launch:disposable');
  const document = emptyConfig(); document.threads[key] = { settings: { minInputTokens: 12345 } };
  await writeConfig(document, file);
  const loaded = await readConfig(file);
  assert.equal(resolveConfig(loaded, {threadId: key}).settings.minInputTokens, 12345);
  assert.notEqual(resolveConfig(loaded, {threadId: t3ConfigThreadId('environment-b', 'mcp:launch:disposable')}).settings.minInputTokens, 12345);
  await configCommand(['set', 'minGrowthTokens', '0', '--thread', key], { file, reload: async () => ({ reloaded: true }) });
  assert.equal(resolveConfig(await readConfig(file), {threadId: key}).settings.minGrowthTokens, 0);
});
