import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

/** Codex persists the app-server initialize client name as session_meta.originator. */
export async function isT3OwnedRollout(file, threadId) {
  if (typeof file !== 'string' || !file) return false;
  const stream = createReadStream(file);
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      const record = JSON.parse(line);
      return record.type === 'session_meta' && record.payload?.id === threadId
        && record.payload.originator === 'T3 Code';
    }
    return false;
  } catch { return false; }
  finally { lines.close(); stream.destroy(); }
}
