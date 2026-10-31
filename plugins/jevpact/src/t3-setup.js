import path from 'node:path';
import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { ensureState, stateDir } from './paths.js';
import { readStoredKey } from './credentials.js';
import { T3Rpc } from './t3-rpc.js';

export const t3SetupPath = () => path.join(stateDir(), 't3.json');
export const t3TokenPath = () => path.join(stateDir(), 't3-credential');
export function requireT3Profile() {
  if (!process.env.JEVPACT_T3_PROFILE) throw new Error('T3 commands require --profile NAME; the Desktop profile is never used');
}
async function readJson(file, description) {
  const contents = await readFile(file, 'utf8');
  try { return JSON.parse(contents); }
  catch { throw new Error(`${description} is not valid JSON`); }
}
export async function readT3Setup() {
  requireT3Profile();
  const setup = await readJson(t3SetupPath(), 'T3 setup');
  if (typeof setup.environmentId !== 'string' || typeof setup.origin !== 'string' || typeof setup.allowWrites !== 'boolean') throw new Error('Invalid T3 setup');
  return setup;
}
async function save(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, value, { flag: 'wx', mode: 0o600 }); await rename(temporary, file);
}
export async function configureT3({ origin, runtimeFile, tokenFile, allowWrites, environmentId }) {
  requireT3Profile();
  const prior = await readT3Setup().catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  runtimeFile ??= prior?.runtimeFile;
  if (runtimeFile) origin = (await readJson(runtimeFile, 'T3 runtime metadata')).origin;
  origin ??= prior?.origin;
  const token = tokenFile ? await readStoredKey(path.resolve(tokenFile)) : await readStoredKey(t3TokenPath());
  if (!token) throw new Error('Provide a private T3 bearer credential with --token-file PATH');
  const rpc = new T3Rpc({ origin, token });
  let config;
  try { config = await rpc.request('server.getConfig', {}); } finally { rpc.close(); }
  const actual = config.environment?.environmentId;
  if (!actual || environmentId && actual !== environmentId || prior && prior.environmentId !== actual) throw new Error('The T3 environment does not match setup; use a separate profile for another environment');
  const setup = { ...(runtimeFile ? {runtimeFile:path.resolve(runtimeFile)} : {}), origin: rpc.origin, environmentId: actual, allowWrites: allowWrites ?? prior?.allowWrites ?? false };
  await ensureState(); await save(t3TokenPath(), token + '\n'); await save(t3SetupPath(), JSON.stringify(setup) + '\n');
  return setup;
}
export async function removeT3Setup() {
  for (const file of [t3SetupPath(), t3TokenPath()]) await unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
}
