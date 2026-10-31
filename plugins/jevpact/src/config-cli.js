import path from 'node:path';
import { LocalState } from './local-state.js';
import { call } from './rpc.js';
import { SETTINGS, DEFAULT_GLOBAL_PROFILE, configPath, readConfig, writeConfig, resolveConfig, parseSetting, validateSetting, projectIdentity, validConfigThreadId } from './config.js';
import { MESSAGE_TOKENS } from './message-template.js';

const profilePattern = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const fail = text => { throw new Error(text); };
const own = (object, key) => Object.hasOwn(object, key);

function currentThread() {
  const id = process.env.CODEX_THREAD_ID;
  if (!validConfigThreadId(id)) fail('The current native task ID is unavailable; use --thread NATIVE_TASK_ID.');
  const state = new LocalState().locate(id);
  if (state.threadId !== id) fail('The current native task ID could not be verified.');
  return id;
}

function scopeArgs(args, { required = false } = {}) {
  let scope = null;
  let json = false;
  const rest = [];
  const select = next => { if (scope) fail('Choose exactly one of --global, --project, or --thread.'); scope = next; };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--json') json = true;
    else if (flag === '--global') select({ kind: 'global' });
    else if (flag === '--current-thread') select({ kind: 'thread', id: currentThread() });
    else if (flag === '--thread') {
      const id = args[++i] === 'current' ? currentThread() : args[i];
      if (!validConfigThreadId(id)) fail('--thread requires a native task ID, a T3 configuration key, or current.');
      select({ kind: 'thread', id });
    } else if (flag === '--project') {
      const requested = args[++i];
      if (!requested) fail('--project requires a path or current.');
      const project = requested === 'current' ? projectIdentity(new LocalState().locate(currentThread()).cwd) : path.resolve(requested);
      select({ kind: 'project', id: path.normalize(project) });
    } else rest.push(flag);
  }
  if (!scope && required) fail('Choose --global, --project PATH, or --thread NATIVE_TASK_ID.');
  if (!scope) scope = process.env.CODEX_THREAD_ID ? { kind: 'thread', id: currentThread() } : { kind: 'global' };
  return { scope, json, rest };
}

function scopeContext(scope) {
  if (scope.kind === 'global') return {};
  if (scope.kind === 'project') return { cwd: scope.id };
  try { return { threadId: scope.id, cwd: new LocalState().locate(scope.id).cwd }; }
  catch { return { threadId: scope.id }; }
}

function entry(document, scope, create = false) {
  if (scope.kind === 'global') return document.global;
  const collection = scope.kind === 'project' ? document.projects : document.threads;
  if (create && !own(collection, scope.id)) collection[scope.id] = { settings: {} };
  return collection[scope.id] ?? null;
}

function show(document, scope, file) {
  const selected = entry(document, scope);
  const result = resolveConfig(document, scopeContext(scope));
  return { path: file, scope, profile: selected?.profile ?? null, overrides: selected?.settings ?? {},
    matchedProject: result.matchedProject, effective: result.settings, sources: result.sources };
}

async function notifyRuntime(file) {
  try {
    const status = await call({ method: 'status' }, { timeout: 5000 });
    if (status.configPath && path.resolve(status.configPath) !== path.resolve(file)) {
      return { state: 'different-config-path', runningPath: status.configPath };
    }
    return { state: 'running', ...(await call({ method: 'reload-config' }, { timeout: 5000 })) };
  }
  catch (error) {
    if (['ENOENT', 'ECONNREFUSED'].includes(error.code)) return { state: 'not-running' };
    return { state: 'reload-unconfirmed', reason: error.code ?? error.message };
  }
}

function render(value, json) {
  if (json) return JSON.stringify(value);
  if (Array.isArray(value)) return value.map(item => typeof item === 'string' ? item : JSON.stringify(item)).join('\n');
  return JSON.stringify(value, null, 2);
}

function profileName(value) {
  if (!profilePattern.test(value ?? '')) fail('Profile names use lowercase letters, digits, underscores, or hyphens.');
  return value;
}

export async function configCommand(argv, { file = configPath(), reload = notifyRuntime } = {}) {
  const read = () => readConfig(file);
  const save = async document => {
    await writeConfig(document, file);
    return { saved: true, path: file, runtime: await reload(file) };
  };
  const args = [...argv];
  const action = args.shift() ?? 'help';
  if (action === 'help') return `Jevpact configuration: ${file}\n`+
    'config list [--json]\nconfig tokens [--json]\nconfig show [--global | --project PATH | --thread ID | --current-thread] [--json]\n'+
    'config set KEY VALUE --global|--project PATH|--thread ID\nconfig reset KEY --global|--project PATH|--thread ID\n'+
    'config clear --global|--project PATH|--thread ID\nconfig reattach --thread ID\n'+
    'config profile list|show NAME|save NAME [--global|--project PATH|--thread ID] [--replace]|set NAME KEY VALUE|unset NAME KEY|apply NAME --scope|clear --scope|delete NAME\n'+
    'Use --thread current or --project current in a Codex task. Changes are saved before the controller reload is attempted.';
  if (action === 'list') {
    const json = args.includes('--json');
    const items = Object.entries(SETTINGS).map(([key, definition]) => ({ key, ...definition }));
    if (json) return render(items, true);
    const line = item => `  ${item.key}: ${item.description} (default ${item.type === 'message' ? 'built-in text' : JSON.stringify(item.default)}${item.globalOnly ? ', global only' : ''})`;
    return ['Common:', ...items.filter(item => item.common).map(line),
      'Advanced:', ...items.filter(item => !item.common).map(line)].join('\n');
  }
  if (action === 'tokens') {
    if (args.some(value => value !== '--json')) fail('Usage: config tokens [--json]');
    return render(MESSAGE_TOKENS, args.includes('--json'));
  }
  if (action === 'show') {
    const { scope, json, rest } = scopeArgs(args);
    if (rest.length) fail(`Unknown config option ${rest[0]}`);
    return render(show(await read(), scope, file), json);
  }
  if (action === 'set' || action === 'reset') {
    const { scope, json, rest } = scopeArgs(args, { required: true });
    if (rest.length !== (action === 'set' ? 2 : 1)) fail(`Usage: config ${action} KEY${action === 'set' ? ' VALUE' : ''} --global|--project PATH|--thread ID`);
    const [key, raw] = rest;
    const document = await read();
    const selected = entry(document, scope, true);
    if (action === 'set') selected.settings[key] = validateSetting(key, parseSetting(key, raw), { scoped: scope.kind !== 'global' });
    else { if (!SETTINGS[key]) fail(`Unknown setting ${key}`); delete selected.settings[key]; }
    return render({ action, scope, key, ...(action === 'set' ? { value: selected.settings[key] } : {}), ...await save(document) }, json);
  }
  if (action === 'clear') {
    const { scope, json, rest } = scopeArgs(args, { required: true });
    if (rest.length) fail(`Unknown config option ${rest[0]}`);
    const document = await read();
    if (scope.kind === 'global') document.global = { profile: DEFAULT_GLOBAL_PROFILE, settings: {} };
    else delete document[scope.kind === 'project' ? 'projects' : 'threads'][scope.id];
    return render({ action, scope, ...await save(document) }, json);
  }
  if (action === 'reattach') {
    const { scope, json, rest } = scopeArgs(args, { required: true });
    if (rest.length || scope.kind !== 'thread') fail('Usage: config reattach --thread NATIVE_TASK_ID');
    return render({ action, scope, ...(await call({ method: 'reattach', threadId: scope.id }, { timeout: 20000 })) }, json);
  }
  if (action !== 'profile') fail(`Unknown config command ${action}`);
  const operation = args.shift() ?? 'list';
  if (operation === 'list') {
    const document = await read();
    return render(Object.keys(document.profiles).sort(), args.includes('--json'));
  }
  if (operation === 'show') {
    const name = profileName(args.shift());
    const document = await read();
    if (!own(document.profiles, name)) fail(`Profile ${name} does not exist.`);
    return render({ name, settings: document.profiles[name] }, args.includes('--json'));
  }
  if (operation === 'set' || operation === 'unset') {
    const json = args.includes('--json');
    const values = args.filter(value => value !== '--json');
    const [name, key, raw] = values;
    profileName(name);
    if (values.length !== (operation === 'set' ? 3 : 2)) fail(`Usage: config profile ${operation} NAME KEY${operation === 'set' ? ' VALUE' : ''}`);
    const document = await read();
    const settings = document.profiles[name] ??= {};
    if (operation === 'set') settings[key] = parseSetting(key, raw);
    else { if (!SETTINGS[key]) fail(`Unknown setting ${key}`); delete settings[key]; }
    return render({ operation, profile: name, key, ...await save(document) }, json);
  }
  if (operation === 'save') {
    const name = profileName(args.shift());
    const replace = args.includes('--replace');
    const from = args.filter(value => value !== '--from' && value !== '--replace');
    const { scope, json, rest } = scopeArgs(from);
    if (rest.length) fail(`Unknown profile option ${rest[0]}`);
    const document = await read();
    if (own(document.profiles, name) && !replace) fail(`Profile ${name} exists; pass --replace to overwrite it.`);
    const effective = resolveConfig(document, scopeContext(scope)).settings;
    document.profiles[name] = Object.fromEntries(Object.keys(SETTINGS)
      .filter(key => scope.kind === 'global' || !SETTINGS[key].globalOnly).map(key => [key, effective[key]]));
    return render({ operation, profile: name, from: scope, ...await save(document) }, json);
  }
  if (operation === 'apply' || operation === 'clear') {
    const name = operation === 'apply' ? profileName(args.shift()) : null;
    const { scope, json, rest } = scopeArgs(args, { required: true });
    if (rest.length) fail(`Unknown profile option ${rest[0]}`);
    const document = await read();
    if (name && !own(document.profiles, name)) fail(`Profile ${name} does not exist.`);
    const selected = entry(document, scope, true);
    if (name) selected.profile = name;
    else if (scope.kind === 'global') selected.profile = DEFAULT_GLOBAL_PROFILE;
    else delete selected.profile;
    return render({ operation, profile: name, scope, ...await save(document) }, json);
  }
  if (operation === 'delete') {
    const name = profileName(args.shift());
    if (name === DEFAULT_GLOBAL_PROFILE) fail('The default global profile is recreated when missing; use profile unset to restore individual source defaults.');
    const document = await read();
    if (!own(document.profiles, name)) fail(`Profile ${name} does not exist.`);
    const users = [document.global, ...Object.values(document.projects), ...Object.values(document.threads)]
      .filter(item => item.profile === name);
    if (users.length) fail(`Profile ${name} is still applied to ${users.length} scope(s).`);
    delete document.profiles[name];
    return render({ operation, profile: name, ...await save(document) }, args.includes('--json'));
  }
  fail(`Unknown profile command ${operation}`);
}
