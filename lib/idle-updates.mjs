import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { atomicWalletJson, walletExecutionView, acquireWalletFileLock } from './wallet-executor.mjs';

const SHA = /^[a-f0-9]{40}$/;
const fail = message => Object.assign(new Error(message), { status: 409, idleDeferred: true });
const safeReason = error => error?.idleDeferred ? String(error.message).slice(0, 240) : '自动安装未完成，请查看更新任务并手动核对';
export function assertIdleData(root, wallets = [], { now = Date.now, idleMs = 60000 } = {}) {
  root = realpathSync(root);
  const read = name => {
    const file = join(realpathSync(root), name);
    for (let p = file; p.startsWith(root + sep); p = dirname(p)) { try { if (lstatSync(p).isSymbolicLink()) throw fail('运行状态路径含符号链接，自动安装暂缓'); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
    if (!existsSync(file)) return null;
    const stat = lstatSync(file); if (!stat.isFile() || stat.size > 16 * 1024 * 1024) throw fail('运行状态无法核对，自动安装暂缓');
    try { const value = JSON.parse(readFileSync(file, 'utf8')); if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error(); return value; }
    catch { throw fail('运行状态文件损坏，自动安装暂缓'); }
  };
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  for (const wallet of wallets) { const execution = walletExecutionView(wallet, { root }); if (execution.busy || execution.blocked) throw fail('钱包仍有运行中或待核对操作，自动安装暂缓'); if (idleMs > 0 && Number.isFinite(execution.updatedAt) && now() - execution.updatedAt < idleMs) throw fail('钱包最近有操作，等待连续空闲 60 秒'); }
  for (const name of ['data/watch_state.json', 'data/watch_heartbeat.txt']) { const file = join(root, name); if (idleMs > 0 && existsSync(file) && now() - lstatSync(file).mtimeMs < idleMs) throw fail('扫描器最近仍有活动，等待连续空闲 60 秒'); }
  const watch = read('data/watch_state.json');
  if (watch && (!object(watch.walletPending || {}) || !object(watch.tokens || {}) || Object.values(watch.tokens || {}).some(token => !object(token)))) throw fail('扫描器状态格式无法核对');
  if (Object.keys(watch?.walletPending || {}).length || Object.values(watch?.tokens || {}).some(token => token && (token.pendingSell || token.submissionIntent || token.sellReviewRequired))) throw fail('扫描器仍有待核对铸造或卖出，自动安装暂缓');
  const budget = read('data/wallet_runtime/budget.json');
  if (budget && (!object(budget.reservations) || Object.values(budget.reservations).some(r => !r || !['reserved', 'settled', 'released'].includes(r.status)))) throw fail('预算预占状态无法核对');
  if (Object.values(budget?.reservations || {}).some(r => r.status === 'reserved')) throw fail('仍有未结算预算预占，自动安装暂缓');
  const nft = read('data/nft_trading_state.json');
  if (nft && !object(nft.states)) throw fail('NFT 状态格式无法核对');
  const terminal = new Set(['idle', 'disabled', 'blocked', 'waiting-trigger', 'awaiting-approval', 'awaiting-confirmation', 'filled', 'cancelled', 'expired']);
  if (Object.values(nft?.states || {}).some(st => !object(st) || st.effectIntent || !terminal.has(st.phase))) throw fail('NFT 仍有活动挂单或待核对操作，自动安装暂缓');
}

export function createIdleUpdates({ root, now = Date.now, getUpdateView, assertIdle, install, intervalMs = 60000, idleMs = 60000 } = {}) {
  root = realpathSync(root);
  const file = join(root, 'data', 'local_updates', 'idle-settings.json');
  let state = 'disabled', reason = '闲时自动更新未开启', idleSince = null, idleTarget = null, lastCheckedAt = null, timer, flight, stopped = false;
  function assertPath() {
    for (let path = file; path.startsWith(root + sep); path = dirname(path)) { try { if (lstatSync(path).isSymbolicLink()) throw fail('自动更新设置不能使用符号链接'); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  }
  function load() {
    assertPath();
    if (!existsSync(file)) return { version: 1, enabled: false, lastAttempt: null };
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.size > 16384 || process.platform !== 'win32' && (stat.mode & 0o077)) throw fail('自动更新设置文件权限或格式无效，请先核对');
    let value; try { value = JSON.parse(readFileSync(file, 'utf8')); } catch { throw fail('自动更新设置损坏，已停止自动安装'); }
    const a = value?.lastAttempt;
    if (value?.version !== 1 || typeof value.enabled !== 'boolean' || a != null && (!a || typeof a !== 'object' || !SHA.test(a.targetCommit || '') || !['installing', 'succeeded', 'failed'].includes(a.phase) || !Number.isFinite(a.startedAt))) throw fail('自动更新设置无效，已停止自动安装');
    return { version: 1, enabled: value.enabled, lastAttempt: a ? { targetCommit: a.targetCommit, phase: a.phase, startedAt: a.startedAt, ...(Number.isFinite(a.completedAt) ? { completedAt: a.completedAt } : {}) } : null };
  }
  function save(value) { assertPath(); mkdirSync(dirname(file), { recursive: true, mode: 0o700 }); atomicWalletJson(file, value); }
  function view() {
    try { const value = load(); return { enabled: value.enabled, state: value.enabled ? state : 'disabled', reason: value.enabled ? reason : '闲时自动更新未开启', idleSince, lastCheckedAt, lastAttempt: value.lastAttempt, intervalMs, idleMs }; }
    catch (error) { return { enabled: false, state: 'manual-review', reason: error.message, idleSince: null, lastCheckedAt, lastAttempt: null, intervalMs, idleMs }; }
  }
  function configure(input) {
    if (!input || typeof input.enabled !== 'boolean' || Object.keys(input).some(key => key !== 'enabled')) throw fail('仅接受 enabled 布尔值');
    const saved = load(); save({ ...saved, enabled: input.enabled }); idleSince = null; idleTarget = null;
    state = input.enabled ? 'waiting' : 'disabled'; reason = input.enabled ? '已开启，等待正式新版和连续空闲' : '闲时自动更新未开启';
    return view();
  }
  async function tick() {
    if (flight) return flight;
    flight = (async () => {
      let previousAttempt, attemptedTarget;
      try {
        const preferences = load(); lastCheckedAt = now();
        if (stopped || !preferences.enabled) { idleSince = null; idleTarget = null; state = 'disabled'; reason = '闲时自动更新未开启'; return view(); }
        const update = await getUpdateView();
        if (!load().enabled || stopped) { idleSince = null; idleTarget = null; return view(); }
        const targetCommit = update?.latest?.commit;
        if (update?.busy || update?.error || ['failed', 'manual-review', 'conflict', 'blocked', 'restarting'].includes(update?.phase)) throw fail('更新任务需要先核对，自动安装暂缓');
        if (!update?.available || !SHA.test(targetCommit || '') || update.current?.commit === targetCommit) { state = 'current'; reason = '等待增强版正式新版'; idleSince = null; idleTarget = null; return view(); }
        if (preferences.lastAttempt?.targetCommit === targetCommit) { state = 'paused'; reason = preferences.lastAttempt.phase === 'succeeded' ? '此版本已处理，等待服务状态核验' : '此版本已自动尝试，请手动核对后更新'; idleSince = null; idleTarget = null; return view(); }
        await assertIdle({ targetCommit });
        if (!load().enabled || stopped) { idleSince = null; idleTarget = null; return view(); }
        if (idleTarget !== targetCommit || idleSince === null) { idleTarget = targetCommit; idleSince = now(); }
        if (now() - idleSince < idleMs) { state = 'waiting'; reason = '已空闲，等待连续 60 秒后安装'; return view(); }
        let releaseClaim;
        try { releaseClaim = await acquireWalletFileLock(join(dirname(file), 'idle-attempt.lock'), { timeoutMs: 0 }); } catch (error) { throw Object.assign(error, { idleDeferred: true }); }
        let lastAttempt;
        try {
          const latest = load();
          if (!latest.enabled || stopped) { idleSince = null; idleTarget = null; return view(); }
          if (latest.lastAttempt?.targetCommit === targetCommit) { state = 'paused'; reason = '此版本已有自动尝试，请查看更新任务'; idleSince = null; idleTarget = null; return view(); }
          previousAttempt = latest.lastAttempt; attemptedTarget = targetCommit;
          lastAttempt = { targetCommit, phase: 'installing', startedAt: now() };
          save({ ...latest, lastAttempt }); state = 'installing'; reason = '正在通过统一更新入口安装';
        } finally { releaseClaim(); }
        await install({ targetCommit });
        save({ ...load(), lastAttempt: { ...lastAttempt, phase: 'succeeded', completedAt: now() } }); state = 'succeeded'; reason = '自动安装已完成，等待 Web 健康检查';
      } catch (error) {
        idleSince = null; idleTarget = null; state = error?.idleDeferred ? 'waiting' : 'failed'; reason = safeReason(error);
        if (attemptedTarget) {
          try { const saved = load(); if (saved.lastAttempt?.targetCommit === attemptedTarget) save({ ...saved, lastAttempt: error?.idleDeferred ? previousAttempt : { ...saved.lastAttempt, phase: 'failed', completedAt: now() } }); } catch { state = 'manual-review'; reason = '无法保存自动更新状态，请手动核对'; }
        }
      }
      return view();
    })().finally(() => { flight = null; });
    return flight;
  }
  return { view, configure, tick, canInstall() { return !stopped && load().enabled; }, start() { stopped = false; if (!timer) { timer = setInterval(() => { void tick(); }, Math.max(1000, intervalMs)); timer.unref?.(); void tick(); } }, stop() { stopped = true; clearInterval(timer); timer = null; idleSince = null; idleTarget = null; } };
}
