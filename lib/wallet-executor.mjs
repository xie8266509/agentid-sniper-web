import { AsyncLocalStorage } from 'node:async_hooks';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

const context = new AsyncLocalStorage();
const queues = new Map();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = message => Object.assign(new Error(message), { status: 409 });
const read = path => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };
const processStart = pid => {
  if (!Number.isSafeInteger(pid) || pid <= 1) return null;
  try { const result = spawnSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 2000 }); return result.status === 0 ? result.stdout.trim() || null : null; } catch { return null; }
};
const ownProcessStart = processStart(process.pid);
const alive = (pid, expectedStart) => {
  try {
    if (!Number.isSafeInteger(pid) || pid <= 1) return false;
    process.kill(pid, 0);
    const current = pid === process.pid ? ownProcessStart : expectedStart ? processStart(pid) : null;
    return !expectedStart || !current || current === expectedStart;
  } catch (error) { return error.code !== 'ESRCH'; }
};
const safeReason = value => String(value || '执行结果尚未核对').replace(/((?:token|password|secret|authorization|cookie|sessionId|apiKey)\s*[:=]\s*)[^\s,;]+/gi, '$1[已隐藏]').slice(0, 300);

export function walletRuntimeDirectory(root) {
  const base = realpathSync(root), directory = join(base, 'data', 'wallet_runtime');
  for (let parent = directory; parent !== dirname(parent); parent = dirname(parent)) {
    if (existsSync(parent) && lstatSync(parent).isSymbolicLink()) throw fail('钱包运行目录不能包含符号链接');
    if (parent === base) break;
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!realpathSync(directory).startsWith(base + sep)) throw fail('钱包运行目录必须位于项目内');
  return directory;
}

export function atomicWalletJson(path, value) {
  const temp = `${path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  try { writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx', flush: true }); renameSync(temp, path); }
  finally { rmSync(temp, { force: true }); }
}

function readMaintenance(root) {
  const file = join(walletRuntimeDirectory(root), 'maintenance.json');
  let stat;
  try { stat = lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return { file, epoch: null, owner: null }; throw fail('无法核对维护状态文件'); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384 || process.platform !== 'win32' && (stat.mode & 0o077)) throw fail('维护状态文件不安全，已停止钱包操作');
  let record;
  try { record = JSON.parse(readFileSync(file, 'utf8')); } catch { throw fail('维护状态文件损坏，已停止钱包操作'); }
  if (!record || record.version !== 1 || !/^[a-f0-9]{36}$/.test(record.epoch || '') || record.owner !== null && (!record.owner || !Number.isSafeInteger(record.owner.pid) || record.owner.pid <= 1 || !/^[a-f0-9]{36}$/.test(record.owner.token || '') || !Number.isFinite(record.owner.startedAt) || record.owner.processStart !== null && typeof record.owner.processStart !== 'string')) throw fail('维护状态文件格式无效，已停止钱包操作');
  return { file, epoch: record.epoch, owner: record.owner };
}

function assertRestartBarrier(root) {
  const base = realpathSync(root), file = join(base, 'data', 'local_updates', 'restart-health.json');
  for (let path = file; path !== base && path.startsWith(base + sep); path = dirname(path)) {
    try { if (lstatSync(path).isSymbolicLink()) throw fail('更新恢复状态路径不安全，已停止钱包操作'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  let stat;
  try { stat = lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return; throw fail('无法核对更新恢复状态'); }
  if (!stat.isFile() || stat.size > 16384) throw fail('更新恢复状态文件不安全，已停止钱包操作');
  let record;
  try { record = JSON.parse(readFileSync(file, 'utf8')); } catch { throw fail('更新恢复状态损坏，已停止钱包操作'); }
  if (!record || !['restarting', 'verified', 'rolled-back', 'failed'].includes(record.phase) || !/^[a-f0-9]{40}$/.test(record.targetCommit || '')) throw fail('更新恢复状态格式无效，已停止钱包操作');
  // A dead restart worker does not prove that loading the new code succeeded.
  if (['restarting', 'failed'].includes(record.phase)) throw fail('Web 更新恢复尚未完成，请核对健康检查后再操作钱包');
}

function assertInterruptedUpdateBarrier(root) {
  const base = realpathSync(root), file = join(base, 'data', 'local_updates', 'status.json');
  for (let path = file; path !== base && path.startsWith(base + sep); path = dirname(path)) {
    try { if (lstatSync(path).isSymbolicLink()) throw fail('更新任务状态路径不安全，已停止钱包操作'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  let stat;
  try { stat = lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return; throw fail('无法核对更新任务状态'); }
  if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw fail('更新任务状态文件不安全，已停止钱包操作');
  let record;
  try { record = JSON.parse(readFileSync(file, 'utf8')); } catch { throw fail('更新任务状态损坏，已停止钱包操作'); }
  if (!record || typeof record !== 'object' || Array.isArray(record) || record.phase !== undefined && typeof record.phase !== 'string') throw fail('更新任务状态格式无效，已停止钱包操作');
  if (record.interrupted === true || ['applying', 'rolling-back'].includes(record.phase)) throw fail('上次程序源码更新尚未恢复，请先核对并回退');
}

/** Shared by the scanner startup and wallet execution paths. This is a local
 * maintenance barrier, never an authorization to send a transaction. */
export function assertWalletMaintenanceIdle(root) {
  assertRestartBarrier(root);
  assertInterruptedUpdateBarrier(root);
  const state = readMaintenance(root);
  if (state.owner && alive(state.owner.pid, state.owner.processStart)) throw fail('程序正在维护更新，请等待 Web 恢复后操作钱包');
  return state.epoch;
}

/** Nonblocking acquisition: callers defer an update instead of stopping work.
 * Hold the barrier and every configured wallet's ordinary execution lock until
 * release, so independently started local wallet processes see the same gate. */
export async function acquireWalletMaintenance(wallets, { root, now = Date.now, idleMs = 60000 } = {}) {
  if (!Array.isArray(wallets)) throw fail('维护钱包列表无效');
  if (typeof now !== 'function' || !Number.isFinite(idleMs) || idleMs < 0) throw fail('维护空闲时间参数无效');
  const directory = walletRuntimeDirectory(root);
  const releaseElection = await acquireWalletFileLock(join(directory, 'maintenance.lock'), { timeoutMs: 0 });
  const releases = [], token = randomBytes(18).toString('hex');
  let barrier, ended = false;
  const release = () => {
    if (ended) return;
    ended = true;
    try {
      for (const unlock of releases.reverse()) unlock();
      if (barrier) {
        const latest = readMaintenance(root);
        if (latest.owner?.token === token) atomicWalletJson(latest.file, { version: 1, epoch: latest.epoch, owner: null });
      }
    } finally { releaseElection(); }
  };
  try {
    assertRestartBarrier(root);
    assertInterruptedUpdateBarrier(root);
    const previous = readMaintenance(root);
    if (previous.owner && alive(previous.owner.pid, previous.owner.processStart)) throw fail('另一个维护任务正在执行');
    barrier = { version: 1, epoch: randomBytes(18).toString('hex'), owner: { pid: process.pid, processStart: ownProcessStart, token, startedAt: Date.now() } };
    atomicWalletJson(previous.file, barrier);
    const entries = new Map(wallets.map(wallet => { const path = paths(wallet, root); return [path.key, path]; }));
    // Include removed/archived profiles and an operation that has taken its
    // ordinary lock but has not written its journal yet.
    for (const name of readdirSync(directory)) {
      const match = name.match(/^([a-f0-9]{64})\.(?:json|lock)$/);
      if (match && !entries.has(match[1])) entries.set(match[1], { key: match[1], lock: join(directory, match[1] + '.lock'), journal: join(directory, match[1] + '.json') });
    }
    for (const path of [...entries.values()].sort((a, b) => a.key.localeCompare(b.key))) {
      releases.push(await acquireWalletFileLock(path.lock, { timeoutMs: 0 }));
      let stat;
      try { stat = lstatSync(path.journal); } catch (error) { if (error.code !== 'ENOENT') throw fail('无法核对钱包执行记录'); }
      if (stat) {
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 131072) throw fail('钱包执行记录不安全，已停止维护');
        let record;
        try { record = JSON.parse(readFileSync(path.journal, 'utf8')); } catch { throw fail('钱包执行记录损坏，已停止维护'); }
        if (!record || typeof record !== 'object' || Array.isArray(record) || !['idle', 'running', 'failed', 'blocked'].includes(record.phase)) throw fail('钱包执行记录格式无效，已停止维护');
        const state = effectiveView(record);
        if (state.busy || state.blocked) throw fail('钱包操作尚未核对，暂不维护更新');
        if (record.updatedAt !== undefined && (!Number.isFinite(record.updatedAt) || record.updatedAt < 0)) throw fail('钱包执行记录时间无效，已停止维护');
        if (record.updatedAt > now() - idleMs) throw fail('钱包近期仍有活动，等待连续空闲后再维护');
      }
    }
    return release;
  } catch (error) { release(); throw error; }
}

// Lamport ticket election is only used while reclaiming a dead owner's directory.
// Each contender has a unique filename, including after a reaper itself crashes;
// no contender can accidentally unlink a replacement reaper's token.
async function claimReaper(directory, signal) {
  const token = randomBytes(18).toString('hex'), filename = `reaper-${token}.json`, path = join(directory, filename);
  const candidate = { pid: process.pid, processStart: ownProcessStart, token, ticket: 0 };
  const contenders = () => readdirSync(directory).filter(name => /^reaper-[a-f0-9]+\.json$/.test(name)).flatMap(name => {
    const file = join(directory, name), value = read(file);
    if (!value) return [];
    if (!alive(value.pid, value.processStart)) { rmSync(file, { force: true }); return []; }
    return [{ ...value, name }];
  });
  try {
    atomicWalletJson(path, candidate);
    candidate.ticket = 1 + Math.max(0, ...contenders().map(peer => Number(peer.ticket) || 0));
    atomicWalletJson(path, candidate);
    while (!signal?.aborted) {
      if (read(path)?.token !== token) return null;
      const waiting = contenders().some(peer => peer.token !== token && (peer.ticket === 0 || peer.ticket < candidate.ticket || peer.ticket === candidate.ticket && peer.name < filename));
      if (!waiting) return () => { if (read(path)?.token === token) rmSync(path, { force: true }); };
      await delay(10);
    }
    throw fail('钱包任务已取消');
  } catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
  finally { if (signal?.aborted && read(path)?.token === token) rmSync(path, { force: true }); }
}

/** A mkdir lock shared by every local process. Stale reclaim is itself exclusive
 * inside the old lock directory, so two reapers cannot unlink a fresh owner's lock. */
export async function acquireWalletFileLock(path, { timeoutMs = 120000, signal, pollMs = 25 } = {}) {
  const started = Date.now(), token = randomBytes(18).toString('hex');
  for (let parent = resolve(path); ; parent = dirname(parent)) {
    // A competing reaper may retire the target lock while preflight walks its
    // parents. Inspect once: absence is normal here, but other errors and even
    // dangling symlinks must still stop acquisition.
    let info;
    try { info = lstatSync(parent); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (info?.isSymbolicLink()) throw fail('钱包锁目录不能包含符号链接');
    if (parent === dirname(parent)) break;
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  while (true) {
    if (signal?.aborted) throw fail('钱包任务已取消');
    try {
      mkdirSync(path, { mode: 0o700 });
      atomicWalletJson(join(path, 'owner.json'), { pid: process.pid, processStart: ownProcessStart, token, startedAt: Date.now() });
      return () => {
        if (read(join(path, 'owner.json'))?.token === token) rmSync(path, { recursive: true, force: true });
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let generation;
      try { const info = statSync(path); generation = `${info.dev}:${info.ino}:${info.birthtimeMs}`; } catch { continue; }
      let owner = read(join(path, 'owner.json'));
      let oldEnough = false;
      try { oldEnough = Date.now() - statSync(path).mtimeMs > 2000; } catch {}
      if ((owner && !alive(owner.pid, owner.processStart)) || (!owner && oldEnough)) {
        let releaseReaper;
        try {
          releaseReaper = await claimReaper(path, signal);
          if (!releaseReaper) continue;
          const info = statSync(path);
          if (`${info.dev}:${info.ino}:${info.birthtimeMs}` !== generation) continue;
          owner = read(join(path, 'owner.json'));
          if (owner ? !alive(owner.pid, owner.processStart) : oldEnough) {
            const tombstone = `${path}.stale-${token}`;
            renameSync(path, tombstone);
            rmSync(tombstone, { recursive: true, force: true });
            continue;
          }
        } catch (error) { if (!['EEXIST', 'ENOENT'].includes(error.code)) throw error; }
        finally { releaseReaper?.(); }
      }
      if (Date.now() - started >= timeoutMs) throw fail('这个钱包仍有其他任务，请稍后重试');
      await delay(pollMs);
    }
  }
}

function identity(wallet) {
  if (!wallet || typeof wallet !== 'object' || !wallet.id && !wallet.address) throw fail('缺少固定的钱包身份');
  return wallet.address && /^0x[0-9a-fA-F]{40}$/.test(wallet.address)
    ? `56:${wallet.address.toLowerCase()}` : `profile:${wallet.id}`;
}
function paths(wallet, root) {
  const directory = walletRuntimeDirectory(root), key = hash(identity(wallet));
  return { directory, key, lock: join(directory, `${key}.lock`), journal: join(directory, `${key}.json`) };
}
function effectiveView(record) {
  const busy = record?.phase === 'running' && alive(record.pid, record.processStart);
  const interrupted = record?.phase === 'running' && !busy && effectful(record.kind);
  const blocked = Boolean(record?.blocked || interrupted);
  return { phase: blocked ? 'blocked' : busy ? 'running' : record?.phase === 'running' ? 'idle' : record?.phase || 'idle', busy, blocked, reason: record?.blocked?.reason || (interrupted ? '上次钱包任务中断，执行结果尚未核对' : null), details: record?.blocked?.details || null, updatedAt: record?.updatedAt || null, kind: record?.kind || null };
}
export function walletExecutionView(wallet, { root } = {}) { return effectiveView(read(paths(wallet, root).journal)); }
function assertNotBlocked(record, allowBlocked) {
  if (record?.blocked && !allowBlocked) throw fail(`此钱包需要先核对上次交易：${record.blocked.reason}`);
}
const effectful = kind => !['auth', 'preview', 'read', 'reconcile', 'recovery', 'status', 'budget'].includes(kind);

async function acquireSlot(directory, { signal, timeoutMs, maxConcurrent = 2 }) {
  const started = Date.now(), limit = Math.max(1, Math.min(16, Number(maxConcurrent) || 2));
  while (true) {
    for (let index = 0; index < limit; index++) {
      try { return await acquireWalletFileLock(join(directory, 'slots', `${index}.lock`), { signal, timeoutMs: 0 }); }
      catch (error) { if (signal?.aborted || error.status !== 409) throw error; }
    }
    if (Date.now() - started >= timeoutMs) throw fail('其他钱包正在执行，等待队列超时');
    await delay(25);
  }
}

export async function withWalletExecution(wallet, work, { root, kind = 'transaction', allowBlocked = false, timeoutMs = 120000, signal, maxConcurrent = 2 } = {}) {
  if (typeof work !== 'function') throw new TypeError('Wallet work must be a function');
  const path = paths(wallet, root), scope = `${path.directory}:${path.key}`;
  const active = context.getStore();
  if (active?.live && active.scope === scope) { assertNotBlocked(read(path.journal), allowBlocked); return work(); }
  if (active?.live) throw fail('钱包任务中不能切换到另一个钱包');
  const maintenanceEpoch = assertWalletMaintenanceIdle(root);
  const previous = queues.get(scope) || Promise.resolve();
  const running = previous.catch(() => {}).then(async () => {
    const release = await acquireWalletFileLock(path.lock, { timeoutMs, signal });
    let releaseSlot;
    try {
      if (assertWalletMaintenanceIdle(root) !== maintenanceEpoch) throw fail('程序维护版本已变化，请重新发起钱包操作');
      let record = read(path.journal) || {};
      if (record.phase === 'running' && effectful(record.kind) && !alive(record.pid, record.processStart) && !record.blocked) {
        record.blocked = { reason: '上次钱包任务中断，执行结果尚未核对', at: Date.now(), details: {} };
        atomicWalletJson(path.journal, record);
      }
      assertNotBlocked(record, allowBlocked);
      if (!['auth', 'read', 'reconcile', 'status', 'budget', 'recovery'].includes(kind)) releaseSlot = await acquireSlot(path.directory, { timeoutMs, signal, maxConcurrent });
      if (assertWalletMaintenanceIdle(root) !== maintenanceEpoch) throw fail('程序维护版本已变化，请重新发起钱包操作');
      record = { ...record, walletId: wallet.id || null, walletAddress: wallet.address?.toLowerCase() || null, phase: 'running', kind, pid: process.pid, processStart: ownProcessStart, updatedAt: Date.now() };
      atomicWalletJson(path.journal, record);
      const execution = { scope, live: true };
      try {
        const result = await context.run(execution, work);
        record = read(path.journal) || record;
        atomicWalletJson(path.journal, { ...record, phase: record.blocked ? 'blocked' : 'idle', updatedAt: Date.now() });
        return result;
      } catch (error) {
        record = read(path.journal) || record;
        atomicWalletJson(path.journal, { ...record, phase: record.blocked ? 'blocked' : 'failed', updatedAt: Date.now() });
        throw error;
      } finally { execution.live = false; }
    } finally { releaseSlot?.(); release(); }
  });
  queues.set(scope, running);
  try { return await running; } finally { if (queues.get(scope) === running) queues.delete(scope); }
}

export async function markWalletBlocked(wallet, reason, { root, details = {} } = {}) {
  return withWalletExecution(wallet, async () => {
    const path = paths(wallet, root), record = read(path.journal) || {};
    const combined = { ...(record.blocked?.details || {}), ...details };
    if (typeof combined.orderId === 'number' && Number.isSafeInteger(combined.orderId) && combined.orderId >= 0 || typeof combined.orderId === 'bigint' && combined.orderId >= 0n) combined.orderId = String(combined.orderId);
    const safeDetails = Object.fromEntries(['source', 'orderId', 'txHash', 'reservationId', 'to', 'value', 'inputDataHash'].filter(key => typeof combined[key] === 'string').map(key => [key, combined[key].slice(0, 200)]));
    atomicWalletJson(path.journal, { ...record, blocked: { reason: safeReason(reason), details: safeDetails, at: Date.now() }, updatedAt: Date.now() });
    return walletExecutionView(wallet, { root });
  }, { root, kind: 'status', allowBlocked: true });
}

export async function clearWalletBlocked(wallet, { root, reference, confirmed = false } = {}) {
  return withWalletExecution(wallet, async () => {
    const path = paths(wallet, root), record = read(path.journal) || {};
    if (record.blocked && !confirmed && (!reference || !['orderId', 'txHash', 'reservationId'].some(key => record.blocked.details?.[key] === reference))) throw fail('解除待核对状态需要匹配的订单凭证或人工确认');
    delete record.blocked;
    atomicWalletJson(path.journal, { ...record, phase: 'running', updatedAt: Date.now() });
    return walletExecutionView(wallet, { root });
  }, { root, kind: 'recovery', allowBlocked: true });
}
