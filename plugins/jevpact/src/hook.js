import { isT3OwnedRollout } from './codex-host.js';
import { call } from './rpc.js';
import { PAUSE_PREFIX, RESUME_PREFIX } from './controller.js';

export function reduceHook(input) {
  return {
    session_id: input.session_id,
    transcript_path: input.transcript_path,
    hook_event_name: input.hook_event_name,
    turn_id: input.turn_id,
    // Never forward tool inputs, outputs, credentials, source dumps, or user prompt text.
    controllerMessage: typeof input.prompt === 'string' && [PAUSE_PREFIX, RESUME_PREFIX].some(p => input.prompt.startsWith(p)),
  };
}

export async function runHook(input) {
  if (await isT3OwnedRollout(input.transcript_path, input.session_id)) return {};
  try { return await call({ method: 'hook', event: reduceHook(input) }, { timeout: 800 }); }
  catch { return {}; } // Native behavior continues when Jevpact is unavailable.
}
