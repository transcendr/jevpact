#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { call } from '../src/rpc.js';

const args = process.argv.slice(2);
const command = args.shift();
try {
  if (command === 't3') {
    if (!args.length || ['help','--help','-h'].includes(args[0]) || args[1] === '--help') {
      console.log((await import('../src/t3-cli.js')).T3_HELP);
    } else {
      const at = args.indexOf('--profile');
      if (at < 0 || !args[at + 1]) throw new Error('T3 commands require --profile NAME');
      process.env.JEVPACT_T3_PROFILE = args[at + 1]; args.splice(at, 2);
      delete process.env.JEVPACT_CONFIG_HOME; delete process.env.JEVPACT_HISTORY_DIR;
      const { t3Command } = await import('../src/t3-cli.js'); await t3Command(args);
    }
  } else if (command === 'hook') {
    let input = '';
    for await (const chunk of process.stdin) {
      input += chunk;
      if (input.length > 32 * 1024 * 1024) process.exit(0);
    }
    const { runHook } = await import('../src/hook.js');
    process.stdout.write(JSON.stringify(await runHook(JSON.parse(input))) + '\n');
  } else if (command === 'serve') {
    const { serve } = await import('../src/daemon.js');
    const onlyThreads = [];
    let config = {};
    while (args.length) {
      const flag = args.shift();
      if (flag === '--thread') onlyThreads.push(args.shift());
      else if (flag === '--config') {
        const { readFile } = await import('node:fs/promises');
        config = JSON.parse(await readFile(args.shift(), 'utf8'));
      } else throw new Error(`Unknown option ${flag}`);
    }
    await serve({ config, onlyThreads });
  } else if (command === 'start') {
    try { const s = await call({ method: 'status' }); console.log(`Jevpact already running (${s.threads.length} threads).`); }
    catch (error) {
      if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error;
      if (process.platform === 'darwin') {
        const { serviceStatus } = await import('../src/service.js');
        if ((await serviceStatus()).controllerLoaded) throw new Error('The managed service is installed; use jevpact service status.');
      }
      const { resolveKey } = await import('../src/credentials.js');
      const key = await resolveKey();
      if (!key) throw new Error('Set JEV_TEST_KEY or JEV_API_KEY before starting Jevpact.');
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'serve', ...args], {
        detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: { ...process.env, JEV_TEST_KEY: key },
      });
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { child.disconnect(); reject(new Error('Jevpact startup timed out')); }, 15000);
        child.once('message', m => { clearTimeout(timer); child.disconnect(); m.ready ? resolve() : reject(new Error('Jevpact startup failed')); });
        child.once('exit', () => { clearTimeout(timer); reject(new Error('Jevpact startup failed; run jevpact serve for the error')); });
        child.once('error', e => { clearTimeout(timer); reject(e); });
      });
      child.unref();
      console.log(`Jevpact running (process ${child.pid}).`);
    }
  } else if (command === 'status') {
    const result = await call({ method: 'status' });
    if (args.includes('--json')) console.log(JSON.stringify(result));
    else {
      console.log(`Jevpact running in ${result.mode ?? 'unknown'} mode; ${result.threads.length} attached threads.`);
      if (result.restoring) console.log(`Restoring ${result.restoring} remembered tasks.`);
      for (const s of result.threads) console.log(`${s.sessionId}: ${s.state}; ${s.usage.inputTokens ?? '?'} input tokens`);
      if (result.lastAttachmentFailure) console.log(`Attachment failed for ${result.lastAttachmentFailure.threadId}: ${result.lastAttachmentFailure.reason}`);
      if (result.history?.failure) console.log(`Diagnostic history error: ${result.history.failure.reason}`);
    }
  } else if (command === 'config') {
    const { configCommand } = await import('../src/config-cli.js');
    console.log(await configCommand(args));
  } else if (command === 'service') {
    const { installService, serviceStatus, uninstallService } = await import('../src/service.js');
    const action = args.shift();
    if (action === 'install' || action === 'update') {
      let expectedThreads;
      let nodePath;
      while (args.length) {
        const flag = args.shift();
        if (flag === '--expect-thread') (expectedThreads ??= []).push(args.shift());
        else if (flag === '--clear-expected') expectedThreads = [];
        else if (flag === '--node') nodePath = args.shift();
        else throw new Error(`Unknown service option ${flag}`);
      }
      const result = await installService({ sourceRoot: fileURLToPath(new URL('../', import.meta.url)),
        expectedThreads, nodePath });
      console.log(`Managed Jevpact ${result.version} is running (process ${result.pid}).`);
      if (result.expectedThreads.length) console.log(`Expected watched tasks: ${result.expectedThreads.join(', ')}`);
    } else if (action === 'status') {
      const result = await serviceStatus({ sourceRoot: fileURLToPath(new URL('../', import.meta.url)) });
      if (args.includes('--json')) console.log(JSON.stringify(result));
      else console.log(`Managed service: ${result.installed ? 'installed' : 'not installed'}; controller: ${result.runtime?.version ?? 'not responding'}; health check: ${result.healthLoaded ? 'scheduled' : 'not scheduled'}; expected tasks watched: ${result.runtime?.expectedWatched ?? false}; update required: ${result.updateRequired}.`);
    } else if (action === 'uninstall') {
      const result = await uninstallService();
      console.log(`Managed Jevpact service and stored credential removed. Diagnostic history remains in ${result.retainedData}.`);
    } else throw new Error('Usage: jevpact service install|update [--expect-thread ID | --clear-expected] [--node ABSOLUTE_PATH] | status [--json] | uninstall');
  } else if (command === 'history') {
    const { History } = await import('../src/history.js');
    const { historyDir } = await import('../src/paths.js');
    const { once } = await import('node:events');
    const query = {};
    let json = false, stats = false, all = false, directory = historyDir();
    while (args.length) {
      const flag = args.shift();
      if (flag === '--json') json = true;
      else if (flag === '--stats') stats = true;
      else if (flag === '--all') all = true;
      else if (flag === '--directory') directory = args.shift();
      else if (flag === '--event') query.event = args.shift();
      else if (flag === '--since') {
        query.since = Date.parse(args.shift());
        if (!Number.isFinite(query.since)) throw new Error('--since requires an ISO date or timestamp');
      } else if (flag === '--after' || flag === '--limit') {
        const value = Number(args.shift());
        if (!Number.isSafeInteger(value) || value < (flag === '--limit' ? 1 : 0)) throw new Error(`${flag} requires a positive integer`);
        query[flag.slice(2)] = value;
      } else if (!flag.startsWith('-') && !query.threadId) query.threadId = flag;
      else throw new Error(`Unknown history option ${flag}`);
    }
    if (!query.threadId && !all && !stats) throw new Error('Specify a task ID, --all, or --stats');
    const history = new History({ directory, readOnly: true });
    try {
      if (stats) console.log(JSON.stringify(history.stats(), null, json ? 0 : 2));
      else for (const item of history.read(query)) {
        const line = json ? JSON.stringify(item) : [item.id, new Date(item.time).toISOString(),
          ...(all ? [item.threadId] : []), item.event, item.action, item.reason,
          item.context?.usage?.inputTokens != null ? `${item.context.usage.inputTokens} tokens` : '',
          item.evaluationId ? `evaluation=${item.evaluationId}` : ''].filter(value => value != null && value !== '').join(' ');
        if (!process.stdout.write(line + '\n')) await once(process.stdout, 'drain');
      }
    } finally { history.close(); }
  } else if (command === 'attach') {
    const result = await call({ method: 'attach', threadId: args[0] }, { timeout: 20000 });
    if (!result.attached) throw new Error('Thread is unsupported or unavailable in the owning Codex app.');
    console.log(`Attached ${args[0]}.`);
  } else if (command === 'stop') {
    if (process.platform === 'darwin') {
      const { serviceStatus } = await import('../src/service.js');
      if ((await serviceStatus()).controllerLoaded) throw new Error('The managed service would restart; use jevpact service uninstall.');
    }
    await call({ method: 'stop' });
    console.log('Jevpact stopped. Native Codex compaction remains available.');
  } else {
    console.log('Usage: jevpact t3 install|start|stop|status|uninstall --profile NAME\n       jevpact start [--thread ID] [--config FILE] | status [--json] | attach ID | stop\n       jevpact config help | list | show | set | reset | clear | reattach | profile\n       jevpact service install|update [--expect-thread ID | --clear-expected] [--node ABSOLUTE_PATH] | status [--json] | uninstall\n       jevpact history TASK_ID [--since ISO] [--event EVENT] [--after ID] [--limit N] [--json]\n       jevpact history --stats | --all [--json]\nHistory: rolling 30 days, 5 GB total; --json streams full records as JSONL. --directory selects a custom history store.\nSet JEV_TEST_KEY or JEV_API_KEY. Managed service installation stores the key in a private user file.\nPlugin hooks must be trusted using Codex /hooks.');
    if (command && !['help', '--help', '-h'].includes(command)) process.exitCode = 1;
  }
} catch (error) {
  if (command !== 'hook') { console.error(error.message); process.exitCode = 1; }
}
