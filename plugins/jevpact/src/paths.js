import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdir, lstat, chmod } from 'node:fs/promises';

export const codexHome = () => path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
const defaultCodexHome = () => path.join(os.homedir(), '.codex');
export const profileSuffix = () => {
  const profile = process.env.JEVPACT_T3_PROFILE;
  if (profile !== undefined) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(profile)) throw new Error('A T3 profile must contain lowercase letters, digits and hyphen-separated words');
    return `-t3-${profile}`;
  }
  return codexHome() === defaultCodexHome() ? ''
    : `-${createHash('sha256').update(codexHome()).digest('hex').slice(0, 12)}`;
};
export const runtimeDir = () => {
  const suffix = profileSuffix();
  // Keep named profiles within macOS's 104-byte Unix socket path limit.
  const runtimeSuffix = process.env.JEVPACT_T3_PROFILE
    ? `-t3-${createHash('sha256').update(suffix).digest('hex').slice(0, 12)}` : suffix;
  return path.join(os.tmpdir(), `jevpact-${process.getuid?.() ?? os.userInfo().username}${runtimeSuffix}`);
};
export const socketPath = () => path.join(runtimeDir(), 'controller.sock');
export const stateDir = () => process.platform === 'darwin'
  ? path.join(os.homedir(), 'Library', 'Application Support', `Jevpact${profileSuffix()}`)
  : process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA || os.homedir(), `Jevpact${profileSuffix()}`)
    : path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), `jevpact${profileSuffix()}`);
// Persistent state survives OS temporary cleanup and plugin upgrades.
export const historyDir = () => process.env.JEVPACT_HISTORY_DIR || stateDir();
export const storedKeyPath = () => path.join(stateDir(), 'credential');
export async function ensureState() {
  const dir = stateDir();
  await mkdir(dir, { mode: 0o700, recursive: true });
  const info = await lstat(dir);
  if (!info.isDirectory() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid())) {
    throw new Error('Unsafe Jevpact state directory');
  }
  await chmod(dir, 0o700);
  return dir;
}
export async function ensureRuntime() {
  const dir = runtimeDir();
  await mkdir(dir, { mode: 0o700, recursive: true });
  const info = await lstat(dir);
  if (!info.isDirectory() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid())) {
    throw new Error('Unsafe Jevpact runtime directory');
  }
  await chmod(dir, 0o700);
  return dir;
}
