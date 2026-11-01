import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConfig } from './config.mjs';
import { getWalletId, normalizeWalletConfig, resolveWallet } from './wallet-model.mjs';
import { markWalletBlocked, withWalletExecution } from './wallet-executor.mjs';

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
  for (let current = path; ; current = dirname(current)) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error('Wallet session storage cannot contain symbolic links');
    if (current === ROOT || current === dirname(current)) break;
  }
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

function startRaw(args, { walletIndex = 0, timeout = 60000, signal } = {}, override) {
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

function commandKind(args) {
  const [group, command] = args || [];
  if (group === 'auth') return 'auth';
  if (['contract-call', 'sign-message', 'x402-payment', 'defi'].includes(group) && command === 'preview') return 'preview';
  const reads = {
    wallet: ['status', 'address', 'settings', 'balance', 'chains', 'tx-history', 'tx-lock', 'gas-price', 'agent-id', 'left-quota'],
    'market-order': ['quote', 'list'], 'limit-order': ['list'],
    'sign-message': ['result', 'history'], approvals: ['list', 'detail'],
    prediction: ['category', 'market', 'position', 'order'],
    defi: ['protocol-list', 'protocol-info', 'investment-list', 'investment-info', 'position'],
  };
  if (reads[group]?.includes(command) || ['cli-check', 'skill-check'].includes(group)) return 'read';
  return 'transaction';
}

function configuredProfile(options, override) {
  const config = normalizeWalletConfig(readConfig());
  if (override) {
    const index = options.walletIndex ?? 0;
    return { profile: normalizeWalletConfig({ ...config, wallets: [{ ...override, bawDir: override.bawDir || `data/wallets/wallet-${index + 1}` }] }).wallets[0], index };
  }
  if (config.wallets?.length) {
    const { wallet, index } = resolveWallet(config, options.walletId ?? options.walletIndex ?? 0);
    if (options.expectedAddress !== undefined && String(wallet.address || '').toLowerCase() !== String(options.expectedAddress || '').toLowerCase()) throw new Error('钱包地址已变化，旧操作已失效');
    return { profile: wallet, index };
  }
  if (options.walletId || options.walletIndex && options.walletIndex !== 0) throw new Error('钱包不存在，请先添加钱包');
  return { profile: { id: 'unconfigured-0', address: '', bawDir: 'data/wallets/wallet-1' }, index: 0 };
}

function assertProfileBinding(profile, index) {
  const config = normalizeWalletConfig(readConfig()), configured = (config.wallets || []).find(wallet => wallet.id === getWalletId(profile, index));
  if (!configured && profile.id === 'unconfigured-0' && !config.wallets?.length) return;
  if (!configured) throw new Error('钱包已移除或身份已变化，请刷新页面');
  for (const field of ['id', 'address', 'bawDir', 'instanceId']) {
    const expected = field === 'address' ? String(profile[field] || '').toLowerCase() : profile[field];
    const actual = field === 'address' ? String(configured[field] || '').toLowerCase() : configured[field];
    if (expected !== actual) throw new Error('钱包地址或会话已变化，旧操作已失效');
  }
}

/** Keep the connected BSC account and the write in the same execution lock.
 * This helper is independently injectable without invoking a real CLI. */
export async function runBoundWalletTransaction(args, profile, { runRaw, beforeSend } = {}) {
  if (profile?.draft || !/^0x[0-9a-fA-F]{40}$/.test(profile?.address || '') || /^0x0{40}$/i.test(profile.address)) return failure('CONFIG_ERROR', '请先绑定并核验钱包的 BSC 地址');
  let checked;
  try { checked = await runRaw(['wallet', 'address']); }
  catch { return failure('CONFIG_ERROR', '发送前无法核验实际登录钱包，未提交交易'); }
  if (!checked?.success) return failure(checked?.error?.name === 'NOT_LOGGED_IN' ? 'NOT_LOGGED_IN' : 'CONFIG_ERROR', '发送前地址核验失败：' + (checked?.error?.message || '未取得钱包地址'));
  const addresses = Array.isArray(checked.data?.addresses) ? checked.data.addresses.filter(item => item && String(item.binanceChainId) === '56') : [];
  if (addresses?.length !== 1 || String(addresses[0].address || '').toLowerCase() !== profile.address.toLowerCase()) return failure('CONFIG_ERROR', '实际登录的 BSC 钱包与已绑定地址不一致，未提交交易');
  try {
    const guard = beforeSend?.();
    if (guard && typeof guard.then === 'function') { void Promise.resolve(guard).catch(() => {}); return failure('CONFIG_ERROR', '发送前检查必须同步完成，未提交交易'); }
    if (guard === false || typeof guard === 'string') return failure('CONFIG_ERROR', typeof guard === 'string' ? guard : '发送前检查未通过，未提交交易');
  } catch (error) { return failure('CONFIG_ERROR', error.message || '钱包配置已改变，未提交交易'); }
  return runRaw(args);
}

function start(args, options = {}, override) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) controller.abort();
  let raw;
  const promise = (async () => {
    if (!Array.isArray(args) || !args.length) throw new Error('Wallet command arguments must be strings');
    const { profile, index } = configuredProfile(options, override), kind = commandKind(args);
    const work = async () => {
      if (kind !== 'read') assertProfileBinding(profile, index);
      const runRaw = async command => { raw = startRaw(command, { ...options, timeout: command[0] === 'wallet' && command[1] === 'address' ? Math.min(options.timeout || 60000, 30000) : options.timeout, walletIndex: index, signal: controller.signal }, profile); return raw.promise; };
      const result = kind === 'transaction' ? await runBoundWalletTransaction(args, profile, { runRaw, beforeSend: () => { assertProfileBinding(profile, index); if (controller.signal.aborted) throw new Error('钱包任务已取消，未提交交易'); return options.beforeSend?.(); } }) : await runRaw(args);
      if (kind === 'transaction') {
        const data = result.data || {}, status = String(data.status || '').toUpperCase();
        const details = { source: 'cli', ...(typeof data.orderId === 'string' || typeof data.orderId === 'number' && Number.isSafeInteger(data.orderId) ? { orderId: String(data.orderId) } : {}), ...(typeof data.txHash === 'string' ? { txHash: data.txHash } : {}) };
        const signing = args[0] === 'sign-message';
        const pending = result.success && (/PENDING|SUBMIT/.test(status) || !signing && (details.orderId || details.txHash));
        const rejected = ['INVALID_PARAMS', 'INVALID_AMOUNT', 'INVALID_ADDRESS', 'NOT_LOGGED_IN', 'UNCONNECTED', 'INSUFFICIENT_BALANCE', 'CONFIG_ERROR', 'CLI_NOT_READY', 'AUTH_REJECTED'];
        const uncertain = !result.success && !rejected.includes(result.error?.name) && raw.child;
        if (pending || uncertain) await markWalletBlocked(profile, pending ? '钱包请求已提交，等待核对最终结果' : '钱包请求未返回明确结果，请先核对订单或交易', { root: ROOT, details });
      }
      return result;
    };
    return kind === 'read' ? work() : withWalletExecution(profile, work, { root: ROOT, kind, allowBlocked: kind === 'auth', timeoutMs: options.timeout ?? 60000, signal: controller.signal });
  })().catch(error => failure('WALLET_BLOCKED', error.message)).finally(() => options.signal?.removeEventListener('abort', abort));
  return { get child() { return raw?.child || null; }, promise, cancel: abort };
}

export function startWalletCommand(args, options) { return start(args, options); }
export async function runWallet(args, options) { return start(args, options).promise; }
export function makeWatchBaw(wc, index = 0) {
  return async (args, timeout = 180000, options = {}) => {
    const j = await start(args, { ...options, walletIndex: index, timeout }, wc).promise;
    return { t: JSON.stringify(j), j };
  };
}
