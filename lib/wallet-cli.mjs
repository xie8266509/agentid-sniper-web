import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const REAL_ROOT = realpathSync(ROOT);
const PACKAGE_DIR = join(ROOT, 'data', 'wallet-cli', 'node_modules', '@binance', 'agentic-wallet');
const CLI_PATH = join(PACKAGE_DIR, 'dist', 'index.js');
const STORAGE_HOOK = join(ROOT, 'lib', 'wallet-storage.mjs');
const SECRET_KEYS = /^(?:clientid|sessionid|agentsessionid|sessiontoken|accesstoken|refreshtoken|apikey|privatekey|seedphrase|mnemonic|password|secret|cookie|authorization)$/i;

function safeText(value) {
  return String(value || '')
    .replace(/\b(agentSessionId|clientId|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|session[_ -]?(?:id|token)|password|private[_ -]?key|seed[_ -]?phrase|mnemonic|secret)\s*[:=]\s*["']?[^\s,;"']+/gi, '$1=[REDACTED]')
    .replace(/\bBearer\s+[^\s,;"']+/gi, 'Bearer [REDACTED]');
}

function sanitize(value) {
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, SECRET_KEYS.test(key.replace(/[-_\s]/g, '')) ? '[REDACTED]' : sanitize(item)]));
  }
  return typeof value === 'string' ? safeText(value) : value;
}

function failure(name, message, code = 50003002) {
  return { success: false, error: { code, name, message: safeText(message) } };
}

export function getCliInfo() {
  let version = null;
  try { version = JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8')).version || null; } catch {}
  return { version, ready: Boolean(version && existsSync(CLI_PATH) && existsSync(STORAGE_HOOK)), path: CLI_PATH };
}

function assertWithinProject(path) {
  let ancestor = path;
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) throw new Error('Wallet storage must stay inside the project');
    ancestor = parent;
  }
  const actual = realpathSync(ancestor);
  if (actual !== REAL_ROOT && !actual.startsWith(REAL_ROOT + sep)) throw new Error('Wallet storage must stay inside the project');
}

function walletEnvironment(walletIndex, override) {
  if (!Number.isInteger(walletIndex) || walletIndex < 0 || walletIndex > 99) throw new Error('walletIndex must be an integer from 0 to 99');
  let config = {};
  const configPath = join(ROOT, 'config.json');
  if (!override && existsSync(configPath)) config = JSON.parse(readFileSync(configPath, 'utf8'));
  const wc = override || config.wallets?.[walletIndex] || {};
  const storage = wc.bawDir || join('data', 'wallets', 'wallet-' + (walletIndex + 1));
  if (typeof storage !== 'string' || isAbsolute(storage) || /^[a-z]:[\\/]/i.test(storage) || storage.startsWith('\\\\') || storage.split(/[\\/]/).includes('..')) {
    throw new Error('bawDir must be a relative project path without ..');
  }
  const scope = resolve(ROOT, storage);
  const rel = relative(ROOT, scope);
  if (!rel || rel.startsWith('..' + sep) || isAbsolute(rel)) throw new Error('bawDir must name a directory inside the project');
  assertWithinProject(scope);
  mkdirSync(scope, { recursive: true, mode: 0o700 });
  assertWithinProject(scope);
  const instance = wc.instanceId || 'agentid-sniper-' + createHash('sha256').update(rel).digest('hex').slice(0, 24);
  if (typeof instance !== 'string' || instance.length > 200 || /[\r\n\0]/.test(instance)) throw new Error('Invalid wallet instanceId');
  return { ...process.env, BINANCE_BAW_DIR: scope, BINANCE_INSTANCE_ID: instance };
}

function parseResult(stdout) {
  try {
    const text = String(stdout || '');
    const start = text.indexOf('{');
    const result = JSON.parse(text.slice(start));
    if (typeof result.success !== 'boolean') return null;
    if (result.success) return { success: true, data: sanitize(result.data) };
    return failure(result.error?.name || 'CLI_ERROR', result.error?.message || 'Wallet command failed', result.error?.code || 50003001);
  } catch { return null; }
}

function start(args, { walletIndex = 0, timeout = 60000, signal } = {}, override) {
  let env;
  try {
    if (!Array.isArray(args) || !args.length || args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) throw new Error('Wallet command arguments must be strings');
    if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 600000) throw new Error('Wallet command timeout must be between 1 and 600000 milliseconds');
    if (signal?.aborted) return { child: null, promise: Promise.resolve(failure('CANCELLED', 'Wallet command cancelled')), cancel() {} };
    if (!getCliInfo().ready) return { child: null, promise: Promise.resolve(failure('CLI_NOT_READY', 'Run node scripts/setup-wallet.mjs to install the project wallet CLI')), cancel() {} };
    env = walletEnvironment(walletIndex, override);
  } catch (error) {
    return { child: null, promise: Promise.resolve(failure('CONFIG_ERROR', error.message)), cancel() {} };
  }
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  let child = null;
  const promise = new Promise(settle => {
    try {
      child = execFile(process.execPath, ['--import', STORAGE_HOOK, CLI_PATH, ...args.filter(arg => arg !== '--json'), '--json'], {
        cwd: ROOT, env, shell: false, windowsHide: true, timeout, maxBuffer: 4 << 20, signal: controller.signal,
      }, (error, stdout) => {
        signal?.removeEventListener('abort', cancel);
        if (controller.signal.aborted) { settle(failure('CANCELLED', 'Wallet command cancelled')); return; }
        const result = parseResult(stdout);
        if (result) { settle(result); return; }
        if (error?.killed) { settle(failure('TIMEOUT', 'Wallet command timed out', 50001002)); return; }
        // Never expose raw stdout/stderr or child-process error messages.
        settle(failure(error ? 'CLI_PROCESS_ERROR' : 'CLI_INVALID_OUTPUT', error ? 'Wallet CLI process could not complete' : 'Wallet CLI returned invalid JSON', 50003001));
      });
    } catch {
      signal?.removeEventListener('abort', cancel);
      settle(failure('CLI_PROCESS_ERROR', 'Wallet CLI process could not start', 50003001));
    }
  });
  return { child, promise, cancel };
}

export function startWalletCommand(args, options) { return start(args, options); }
export async function runWallet(args, options) { return start(args, options).promise; }
export function makeWatchBaw(wc, index = 0) {
  return async (args, timeout = 180000) => {
    const j = await start(args, { walletIndex: index, timeout }, wc).promise;
    return { t: JSON.stringify(j), j };
  };
}
