import os from 'node:os';
import path from 'node:path';
import { lstatSync, readFileSync } from 'node:fs';
import { lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { DEFAULT_POLICY } from './policy.js';
import { PAUSE_PREFIX, PAUSE_TEXT, RESUME_PREFIX, RESUME_TEXT, DEFER_TEXT } from './controller.js';
import { validateMessageTemplate } from './message-template.js';
import { profileSuffix } from './paths.js';

const body = (text, prefix) => text.slice(prefix.length).trimStart();
const integer = (defaultValue, min, max, description, common = false, globalOnly = false) =>
  ({ type: 'integer', default: defaultValue, min, max, description, common, globalOnly });
const boolean = (defaultValue, description, common = false) =>
  ({ type: 'boolean', default: defaultValue, description, common, globalOnly: false });
const message = (defaultValue, description) =>
  ({ type: 'message', default: defaultValue, maxLength: 4000,
    description: `${description} Supports dynamic tokens listed by config tokens.`, common: true, globalOnly: false });

export const SETTINGS = Object.freeze({
  mode: { type: 'choice', values: ['automatic', 'observe', 'off'], default: 'automatic',
    description: 'Automatic action, observation without action, or no Jevpact action.', common: true, globalOnly: false },
  minInputTokens: integer(DEFAULT_POLICY.minInputTokens, 0, 10_000_000, 'Minimum observed input tokens before eligibility.', true),
  minGrowthTokens: integer(DEFAULT_POLICY.minGrowthTokens, 0, 10_000_000, 'Minimum growth since the last compaction.', true),
  minRequests: integer(DEFAULT_POLICY.minRequests, 0, 1_000_000, 'Minimum model requests since the last compaction.', true),
  nativeLimitTokens: integer(DEFAULT_POLICY.nativeLimitTokens, 0, 10_000_000, 'Jevpact pressure ceiling; zero uses the reported context window.', true),
  reserveTokens: integer(DEFAULT_POLICY.reserveTokens, 0, 10_000_000, 'Absolute headroom reserve.', true),
  reserveRatio: { type: 'number', default: DEFAULT_POLICY.reserveRatio, min: 0, max: 1,
    description: 'Headroom reserve as a fraction of the effective ceiling.', common: false, globalOnly: false },
  growthReserveMultiplier: { type: 'number', default: DEFAULT_POLICY.growthReserveMultiplier, min: 0, max: 100,
    description: 'Headroom reserve multiplier for recent context growth.', common: false, globalOnly: false },
  pauseMessage: message(body(PAUSE_TEXT, PAUSE_PREFIX), 'Message body sent when an active task is asked to pause.'),
  resumeMessage: message(body(RESUME_TEXT, RESUME_PREFIX), 'Message body sent after native compaction when work can continue.'),
  deferMessage: message(body(DEFER_TEXT, PAUSE_PREFIX), 'Message body sent when a pause is withdrawn and work can continue.'),
  compactionTimeoutMs: integer(300_000, 1_000, 3_600_000, 'Deadline for observing native compaction completion.'),
  debounceMs: integer(80, 0, 60_000, 'Delay before processing changed task state.'),
  watchTranscript: boolean(true, 'Watch the rollout file for changes; disabling it makes expected-task health checks report unwatched.'),
  allowHookFallback: boolean(true, 'Use lifecycle hooks if the file watcher fails.'),
  maxLineBytes: integer(16 * 1024 * 1024, 1024, 64 * 1024 * 1024, 'Maximum accepted rollout record size.'),
  restoreAttached: boolean(true, 'Restore this task watcher after a controller restart.'),
  recordDiagnostics: boolean(true, 'Retain diagnostic events for this task.'),
  historyRetentionDays: integer(30, 1, 3650, 'Diagnostic history retention in days.', false, true),
  historyMaxBytes: integer(5_000_000_000, 200_000, Number.MAX_SAFE_INTEGER, 'Shared diagnostic history byte ceiling.', false, true),
  historyDirectory: { type: 'directory', default: null, description: 'Shared diagnostic history directory; null uses the OS default.',
    common: false, globalOnly: true },
});

export const DEFAULT_SETTINGS = Object.freeze(Object.fromEntries(
  Object.entries(SETTINGS).map(([key, definition]) => [key, definition.default])));
export const DEFAULT_GLOBAL_PROFILE = 'default';
export const CONFIG_RESTART_KEYS = Object.freeze(['historyRetentionDays', 'historyMaxBytes', 'historyDirectory']);
export const CONFIG_REATTACH_KEYS = Object.freeze(['watchTranscript', 'allowHookFallback', 'maxLineBytes']);

export const configDirectory = () => process.env.JEVPACT_CONFIG_HOME || path.join(os.homedir(), `.jevpact${profileSuffix()}`);
export const configPath = () => path.join(configDirectory(), 'config.json');
const sourceFallbackConfig = () => ({ version: 1, global: { settings: {} }, projects: {}, threads: {}, profiles: {} });
export const emptyConfig = () => ({ version: 1, global: { profile: DEFAULT_GLOBAL_PROFILE, settings: {} },
  projects: {}, threads: {}, profiles: { [DEFAULT_GLOBAL_PROFILE]: { ...DEFAULT_SETTINGS } } });

function plain(value) { return value != null && typeof value === 'object' && !Array.isArray(value); }
function own(value, key) { return Object.hasOwn(value, key); }
export const t3ConfigThreadId = (environmentId, threadId) =>
  `t3:${Buffer.from(environmentId).toString('base64url')}:${Buffer.from(threadId).toString('base64url')}`;
export const validConfigThreadId = id => typeof id === 'string' &&
  (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)
    || /^t3:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/.test(id));

function invalid(reason) { throw Object.assign(new Error(`Invalid Jevpact configuration: ${reason}`), { code: 'invalid-config' }); }
function assertKeys(value, allowed, location) {
  if (!plain(value)) invalid(`${location} must be an object`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) invalid(`unknown ${location} field ${key}`);
}

export function validateSetting(key, value, { scoped = false } = {}) {
  const definition = SETTINGS[key];
  if (!definition) invalid(`unknown setting ${key}`);
  if (scoped && definition.globalOnly) invalid(`${key} is global only`);
  if (definition.type === 'integer' && (!Number.isSafeInteger(value) || value < definition.min || value > definition.max)) invalid(`${key} must be an integer from ${definition.min} to ${definition.max}`);
  if (definition.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value) || value < definition.min || value > definition.max)) invalid(`${key} must be a number from ${definition.min} to ${definition.max}`);
  if (definition.type === 'boolean' && typeof value !== 'boolean') invalid(`${key} must be true or false`);
  if (definition.type === 'choice' && !definition.values.includes(value)) invalid(`${key} must be one of ${definition.values.join(', ')}`);
  if (definition.type === 'message') {
    if (typeof value !== 'string' || !value.trim() || value.length > definition.maxLength) invalid(`${key} must be nonempty text of at most ${definition.maxLength} characters`);
    try { validateMessageTemplate(value); }
    catch (error) { invalid(`${key}: ${error.message}`); }
  }
  if (definition.type === 'directory' && value !== null && (typeof value !== 'string' || !path.isAbsolute(value))) invalid(`${key} must be an absolute path or null`);
  return value;
}

function validateSettings(settings, location, scoped) {
  if (!plain(settings)) invalid(`${location}.settings must be an object`);
  for (const [key, value] of Object.entries(settings)) validateSetting(key, value, { scoped });
}

function validateEntry(entry, location, scoped) {
  assertKeys(entry, ['profile', 'settings'], location);
  if (own(entry, 'profile') && (typeof entry.profile !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(entry.profile))) invalid(`${location}.profile is invalid`);
  validateSettings(entry.settings ?? {}, location, scoped);
}

export function validateConfig(document) {
  assertKeys(document, ['version', 'global', 'projects', 'threads', 'profiles'], 'root');
  if (document.version !== 1) invalid('unsupported version');
  for (const name of ['global', 'projects', 'threads', 'profiles']) if (!own(document, name)) invalid(`missing ${name}`);
  for (const name of ['projects', 'threads', 'profiles']) if (!plain(document[name])) invalid(`${name} must be an object`);
  validateEntry(document.global, 'global', false);
  for (const [name, settings] of Object.entries(document.profiles)) {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name)) invalid(`invalid profile name ${name}`);
    validateSettings(settings, `profiles.${name}`, false);
  }
  const checkProfile = (entry, location, scoped) => {
    if (!entry.profile) return;
    if (!own(document.profiles, entry.profile)) {
      if (location === 'global') return;
      invalid(`${location} references missing profile ${entry.profile}`);
    }
    if (scoped) validateSettings(document.profiles[entry.profile], `profiles.${entry.profile}`, true);
  };
  checkProfile(document.global, 'global', false);
  for (const [project, entry] of Object.entries(document.projects)) {
    if (!path.isAbsolute(project) || path.normalize(project) !== project) invalid(`invalid project path ${project}`);
    validateEntry(entry, `projects.${project}`, true);
    checkProfile(entry, `projects.${project}`, true);
  }
  for (const [thread, entry] of Object.entries(document.threads)) {
    if (!validConfigThreadId(thread)) invalid(`invalid thread ID ${thread}`);
    validateEntry(entry, `threads.${thread}`, true);
    checkProfile(entry, `threads.${thread}`, true);
  }
  return document;
}

async function verifyDirectory(directory, create) {
  if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
  let info;
  try { info = await lstat(directory); }
  catch (error) { if (!create && error.code === 'ENOENT') return false; throw error; }
  if (!info.isDirectory() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid())) invalid('unsafe config directory');
  return true;
}

export async function readConfig(file = configPath()) {
  const createDefault = async () => {
    const document = emptyConfig();
    try { await writeConfig(document, file); return document; }
    catch (error) { if (error.code === 'invalid-config') throw error; return sourceFallbackConfig(); }
  };
  if (!await verifyDirectory(path.dirname(file), false)) return createDefault();
  let info;
  try { info = await lstat(file); }
  catch (error) { if (error.code === 'ENOENT') return createDefault(); throw error; }
  if (!info.isFile() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid())) invalid('unsafe config file');
  if (info.size > 1_000_000) invalid('config file exceeds 1 MB');
  let document;
  try { document = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { invalid(error instanceof SyntaxError ? 'invalid JSON' : error.message); }
  validateConfig(document);
  if (own(document.profiles, DEFAULT_GLOBAL_PROFILE) && document.global.profile
    && own(document.profiles, document.global.profile)) return document;
  const repaired = structuredClone(document);
  repaired.profiles[DEFAULT_GLOBAL_PROFILE] ??= { ...DEFAULT_SETTINGS };
  if (!repaired.global.profile || !own(repaired.profiles, repaired.global.profile)) {
    repaired.global.profile = DEFAULT_GLOBAL_PROFILE;
  }
  validateConfig(repaired);
  try { await writeConfig(repaired, file); return repaired; }
  catch (error) { if (error.code === 'invalid-config') throw error; return document; }
}

export async function writeConfig(document, file = configPath()) {
  validateConfig(document);
  const contents = JSON.stringify(document, null, 2) + '\n';
  if (Buffer.byteLength(contents) > 1_000_000) invalid('config file exceeds 1 MB');
  const directory = path.dirname(file);
  await verifyDirectory(directory, true);
  const temporary = path.join(directory, `.config.${randomUUID()}.tmp`);
  await writeFile(temporary, contents, { flag: 'wx', mode: 0o600 });
  try { await rename(temporary, file); }
  catch (error) { await unlink(temporary).catch(() => {}); throw error; }
}

export function projectIdentity(cwd) {
  if (!cwd) return null;
  let directory = path.resolve(cwd);
  while (true) {
    try {
      const marker = path.join(directory, '.git');
      const info = lstatSync(marker);
      if (info.isDirectory()) return directory;
      if (info.isFile()) {
        const match = readFileSync(marker, 'utf8').match(/^gitdir:\s*(.+)\s*$/m);
        if (match) {
          const gitDirectory = path.resolve(directory, match[1].trim());
          const common = path.resolve(gitDirectory, readFileSync(path.join(gitDirectory, 'commondir'), 'utf8').trim());
          if (path.basename(common) === '.git') return path.dirname(common);
        }
        return directory;
      }
    } catch { /* This directory is not a readable Git checkout. */ }
    const parent = path.dirname(directory);
    if (parent === directory) return path.resolve(cwd);
    directory = parent;
  }
}

export function matchingProject(document, cwd) {
  if (!cwd) return null;
  const match = directory => Object.keys(document.projects)
    .filter(project => directory === project || directory.startsWith(project + path.sep))
    .sort((a, b) => b.length - a.length)[0] ?? null;
  const resolved = path.resolve(cwd);
  return [match(resolved), match(projectIdentity(resolved))].filter(Boolean)
    .sort((a, b) => b.length - a.length)[0] ?? null;
}

export function resolveConfig(document, { threadId = null, cwd = null, base = {} } = {}) {
  validateConfig(document);
  const settings = { ...DEFAULT_SETTINGS, ...base };
  const sources = Object.fromEntries(Object.keys(settings).map(key => [key, own(base, key) ? 'legacy' : 'default']));
  let profileName = null;
  const apply = (values, source) => {
    for (const [key, value] of Object.entries(values ?? {})) { settings[key] = value; sources[key] = source; }
  };
  const applyEntry = (entry, source) => {
    if (!entry) return;
    if (entry.profile && own(document.profiles, entry.profile)) {
      profileName = entry.profile;
      apply(document.profiles[entry.profile], `${source}:profile:${entry.profile}`);
    }
    apply(entry.settings, source);
  };
  applyEntry(document.global, 'global');
  const project = matchingProject(document, cwd);
  if (project) applyEntry(document.projects[project], `project:${project}`);
  if (threadId) applyEntry(document.threads[threadId], `thread:${threadId}`);
  return { settings, sources, matchedProject: project, profileName };
}

export function parseSetting(key, raw) {
  const definition = SETTINGS[key];
  if (!definition) invalid(`unknown setting ${key}`);
  let value = raw;
  if (definition.type === 'integer' || definition.type === 'number') value = Number(raw);
  else if (definition.type === 'boolean') value = raw === 'true' ? true : raw === 'false' ? false : raw;
  else if (definition.type === 'directory' && raw === 'null') value = null;
  return validateSetting(key, value);
}
