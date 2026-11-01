import { execFile } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCliInfo, runWallet } from '../lib/wallet-cli.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PREFIX = join(ROOT, 'data', 'wallet-cli');
const PACKAGE = '@binance/agentic-wallet';
const VERSION = '1.12.0';
function npm(args, timeout = 180000) {
  return new Promise((resolve, reject) => execFile('npm', args, { cwd: ROOT, shell: false, timeout, maxBuffer: 4 << 20 }, (error, stdout) => {
    if (error) reject(new Error('npm command failed; no wallet sessions were changed'));
    else resolve(stdout);
  }));
}

try {
  const metadata = JSON.parse(await npm(['view', PACKAGE + '@' + VERSION, 'name', 'version', 'dist.integrity', 'dist.tarball', '--json'], 30000));
  const tarball = new URL(metadata['dist.tarball']);
  if (metadata.name !== PACKAGE || metadata.version !== VERSION || tarball.hostname !== 'registry.npmjs.org' || !metadata['dist.integrity']?.startsWith('sha512-')) throw new Error('Official npm package metadata verification failed');
  mkdirSync(PREFIX, { recursive: true, mode: 0o700 });
  await npm(['install', '--prefix', PREFIX, '--ignore-scripts', '--no-audit', '--no-fund', '--save-exact', PACKAGE + '@' + VERSION]);
  const info = getCliInfo();
  if (!info.ready || info.version !== VERSION) throw new Error('Project wallet CLI installation verification failed');
  const check = await runWallet(['cli-check', '--required-version', VERSION]);
  if (!check.success) throw new Error(check.error.message);
  console.log(JSON.stringify({ success: true, version: info.version, path: info.path, storage: 'Isolated encrypted files; system keychain disabled' }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ success: false, error: { name: 'SETUP_ERROR', message: error.message } }));
  process.exitCode = 1;
}
