import { fileURLToPath } from 'node:url';
import { call } from './rpc.js';
import { configureT3, readT3Setup, t3TokenPath, requireT3Profile, removeT3Setup } from './t3-setup.js';
import { readStoredKey } from './credentials.js';
import { t3ConfigThreadId, validConfigThreadId } from './config.js';

export const T3_HELP = `Usage:
  jevpact t3 install --profile NAME --runtime-file FILE|--origin URL --token-file FILE [--jev-key-file FILE] [--allow-writes]
  jevpact t3 update --profile NAME [--read-only|--allow-writes] [--token-file FILE] [--jev-key-file FILE]
  jevpact t3 start|stop|status|uninstall --profile NAME [--json]
  jevpact t3 config set|reset|clear|show ... --profile NAME
Credentials must be in private files. Read-only is the setup default.
Each named T3 profile is separate from the Codex Desktop controller.`;

function options(args) {
  const result = {};
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--allow-writes') result.allowWrites = true;
    else if (flag === '--read-only') result.allowWrites = false;
    else if (flag === '--json') result.json = true;
    else if (['--origin', '--runtime-file', '--token-file', '--environment', '--node', '--jev-key-file'].includes(flag)) {
      const key = {'--runtime-file':'runtimeFile','--token-file':'tokenFile','--environment':'environmentId','--node':'nodePath','--jev-key-file':'apiKeyFile'}[flag] ?? flag.slice(2);
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`${flag} requires a value`);
      result[key] = args[++i];
    } else throw new Error(`Unknown T3 option ${flag}`);
  }
  return result;
}
export async function serveT3() {
  const { serve } = await import('./daemon.js');
  const { T3Fleet } = await import('./t3-fleet.js');
  const setup = await readT3Setup();
  const apiKey = await readStoredKey();
  if (!apiKey) throw new Error('Install a private Jev credential before starting this T3 profile');
  const fleet = new T3Fleet({ ...setup, token: () => readStoredKey(t3TokenPath()) });
  const daemon = await serve({ apiKey, transport: fleet.transport, readerFactory: fleet.source,
    onQuiescent: id => fleet.quiescent(id) });
  if (daemon.alreadyRunning) throw new Error('This T3 profile is already running');
  fleet.start(daemon);
  return daemon;
}
function printStatus(status) {
  console.log(status.source?.reason ?? 'T3 connection is starting.');
  console.log(`${status.threads.length} attached threads; ${status.source?.detailedSubscriptions ?? 0} detailed subscriptions.`);
  for (const thread of status.threads) console.log(`${thread.title ?? thread.sessionId}: ${thread.statusReason}`);
}
async function scopeThread(args) {
  const index = args.indexOf('--thread');
  if (index < 0 || !args[index + 1]) return;
  const setup = await readT3Setup();
  const id = args[index + 1];
  if (id.startsWith('t3:') && validConfigThreadId(id)) {
    if (!id.startsWith(t3ConfigThreadId(setup.environmentId, ''))) throw new Error('The thread configuration key belongs to another T3 environment');
  } else args[index + 1] = t3ConfigThreadId(setup.environmentId, id);
}
async function configurePolicy(args) {
  const current = ['--thread', '--project'].some(flag => args.includes(flag) && args[args.indexOf(flag) + 1] === 'current');
  if (current || args.includes('--current-thread') || args[0] === 'reattach')
    throw new Error('T3 settings require an explicit thread ID or project path; attachment is automatic');
  await scopeThread(args);
  const { configCommand } = await import('./config-cli.js');
  console.log(await configCommand(args));
}
export async function t3Command(args) {
  requireT3Profile();
  const action = args.shift();
  if (action === 'config') { await configurePolicy(args); return; }
  const input = options(args);
  if (action === 'serve') { await serveT3(); return; }
  const { installService, startService, stopService, serviceStatus, uninstallService, runtimeFingerprint } = await import('./service.js');
  if (action === 'install' || action === 'update') {
    const setup = await configureT3(input);
    const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
    const result = await installService({ sourceRoot, nodePath: input.nodePath, apiKeyFile: input.apiKeyFile, preferStoredKey: true, serveArgs: ['t3', 'serve', '--profile', process.env.JEVPACT_T3_PROFILE],
      environment: { JEVPACT_T3_PROFILE: process.env.JEVPACT_T3_PROFILE }, runtimeSuffix: `-t3-${await runtimeFingerprint(sourceRoot)}` });
    console.log(`T3 Jevpact installed and running (process ${result.pid}). Writes ${setup.allowWrites ? 'enabled, subject to server capability' : 'disabled'}.`);
  } else if (action === 'start') { await startService(); console.log('T3 Jevpact started.'); }
  else if (action === 'stop') { await stopService(); console.log('T3 Jevpact stopped.'); }
  else if (action === 'uninstall') { await uninstallService(); await removeT3Setup(); console.log('T3 service and stored credentials removed.'); }
  else if (action === 'status') {
    const service = await serviceStatus();
    const status = await call({method:'status'}).catch(() => null);
    if (input.json) console.log(JSON.stringify({ service, ...(status ?? { running: false }) }));
    else if (status) printStatus(status); else console.log(`T3 Jevpact is stopped; service ${service.installed ? 'installed' : 'not installed'}.`);
  } else throw new Error('Usage: jevpact t3 install|update|start|stop|status|uninstall --profile NAME; jevpact t3 config ... --profile NAME');
}
