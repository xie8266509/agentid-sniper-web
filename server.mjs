import http from 'node:http';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readConfig, sanitizeConfig, saveConfig } from './lib/config.mjs';
import { runWallet, getCliInfo } from './lib/wallet-cli.mjs';
import { ROOT, dashboardStatus, controlService, holdingsData, readLogs, redact } from './lib/control.mjs';
import { createLocalNftTrading } from './lib/nft-local.mjs';
import { createLocalUpdater } from './lib/local-updater.mjs';
import { createTelegramMonitor } from './lib/telegram-monitor.mjs';
import { readRestartHealth, scannerIsActive, spawnWebRestart } from './lib/update-runtime.mjs';
import { normalizeWalletConfig, getWalletId, resolveWallet, effectiveWalletConfig, walletCanAutomate } from './lib/wallet-model.mjs';
import { withWalletExecution, walletExecutionView, markWalletBlocked, clearWalletBlocked } from './lib/wallet-executor.mjs';
import { createWalletBudget } from './lib/wallet-budget.mjs';
import { nftRpc } from './lib/nft-holdings.mjs';
import { reconcileScannerPending } from './lib/scanner-recovery.mjs';

const MAX_BODY = 128 * 1024;
const addressPattern = /^0x[a-fA-F0-9]{40}$/;
export function toWei(value) {
  const text = String(value ?? '0');
  if (!/^(0|[1-9]\d{0,11})(\.\d{1,18})?$/.test(text)) throw failure(400, 'BNB 数量必须为非负十进制数，最多 18 位小数');
  const [whole, fraction = ''] = text.split('.');
  return (BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, '0'))).toString();
}
function failure(status, message, details) { return Object.assign(new Error(message), { status, details }); }
function mustOk(result) {
  if (!result?.success) throw failure(502, result?.error?.message || '钱包 CLI 没有返回有效结果', { code: result?.error?.code, name: result?.error?.name });
  return result.data;
}
function expiryTime(value) {
  if (typeof value === 'number' || /^\d+$/.test(String(value))) return Number(value) < 1e12 ? Number(value) * 1000 : Number(value);
  return Date.parse(value || '');
}
const canonical = value => JSON.stringify(value, (_key, entry) => entry && typeof entry === 'object' && !Array.isArray(entry) ? Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]])) : entry);
function assertDevMode(settings) {
  const expiry = expiryTime(settings?.devMode?.expiresAt);
  if (settings?.devMode?.enabled !== true || Number.isFinite(expiry) && expiry <= Date.now()) {
    throw failure(409, '请在币安 App 的 Agentic Wallet → 设置中开启开发者模式，并确认签名后重试');
  }
}

export function createApp(overrides = {}) {
  const deps = { readConfig, sanitizeConfig, saveConfig, runWallet, getCliInfo, dashboardStatus, controlService, holdingsData, readLogs, ...overrides };
  const sessions = new Map(), logins = new Map(), previews = new Map(), walletCache = new Map(), busy = new Set();
  const appRoot = overrides.root || ROOT;
  // An injected CLI without a root is an in-memory test adapter. Production
  // and explicit-root integration tests always use the durable coordinator.
  const durableRuntime = !overrides.runWallet || Boolean(overrides.root);
  const budget = durableRuntime ? createWalletBudget({ root: appRoot }) : null;
  const sessionVersions = new Map();
  const config = () => normalizeWalletConfig(deps.readConfig());
  const walletAt = index => config().wallets[index] || { id: 'bootstrap-wallet', name: '钱包 1', address: '', bawDir: 'data/wallets/wallet-1' };
  const keyAt = index => getWalletId(walletAt(index), index);
  const executor = (wallet, work, options = {}) => durableRuntime ? withWalletExecution(wallet, work, { root: appRoot, ...options }) : work();
  const walletRevision = wallet => createHash('sha256').update(canonical({ wallet, monitorOnly: config().monitorOnly, portfolioBudget: config().portfolioBudget, paid: effectiveWalletConfig(config(), wallet).paid, rules: effectiveWalletConfig(config(), wallet).rules, session: sessionVersions.get(wallet.id) || 0 })).digest('hex');
  const walletIdentity = wallet => ({ id: wallet.id, name: wallet.name, address: wallet.address, chainId: 56 });
  const invalidateWallet = id => {
    walletCache.delete(id);
    sessionVersions.set(id, (sessionVersions.get(id) || 0) + 1);
    for (const [key, preview] of previews) if (preview.walletId === id) previews.delete(key);
  };
  let serviceBusy = false, updateBusy = false, activeWalletCalls = 0, updatePhase = null, updateError = null;
  let restartGate = readRestartHealth(ROOT)?.phase === 'restarting';
  let restartSince = restartGate ? readRestartHealth(ROOT)?.startedAt || 0 : 0;
  if (restartGate && overrides.startUpdateChecker === true) { serviceBusy = true; updateBusy = true; updatePhase = 'restarting'; }
  const walletRunner = deps.runWallet;
  deps.runWallet = async (args, options = {}) => {
    if (updateBusy) throw failure(409, '正在更新本地程序，请等待 Web 恢复后操作钱包');
    activeWalletCalls++;
    const beforeSend = options.beforeSend;
    try { return await walletRunner(args, { ...options, beforeSend: () => {
      if (updateBusy || options.automatic && (serviceBusy || existsSync(join(appRoot, 'WATCH_STOP')))) throw failure(409, '自动任务已停止，本次未发送');
      return beforeSend?.();
    } }); } finally { activeWalletCalls--; }
  };
  let localUpdater = overrides.localUpdater;
  const getUpdater = () => localUpdater ||= createLocalUpdater({ root: ROOT, beforeApply: assertUpdateReady });
  let telegramMonitor;
  const getTelegramMonitor = () => telegramMonitor ||= createTelegramMonitor({ root: appRoot, readConfig: deps.readConfig });
  let nftTrading = overrides.nftTrading;
  const getNftTrading = () => nftTrading ||= createLocalNftTrading({
    root: appRoot, readConfig: config, runWallet: deps.runWallet,
    onWalletResolved: async (rule, reference) => {
      const wallet = config().wallets.find(wallet => wallet.address.toLowerCase() === rule.walletAddress);
      if (!durableRuntime || !wallet || !reference) return;
      const state = await walletExecutionView(wallet, { root: appRoot });
      if (state.blocked && ['orderId', 'txHash'].some(key => state.details?.[key] === reference)) await clearWalletBlocked(wallet, { root: appRoot, reference });
    },
    serviceInfo: async () => { const service = (await deps.dashboardStatus()).service; return { ...service, running: !serviceBusy && service.running }; },
    withWalletLock: async (index, work, options = {}) => {
      const wallet = walletAt(index), key = wallet.id;
      if (serviceBusy || busy.has(key) || [...logins.values()].some(job => job.walletId === key && job.status === 'WAITING')) throw failure(409, '钱包或服务正在处理其他操作，请稍后重试');
      busy.add(key); try { return await executor(wallet, work, { kind: options.allowBlocked ? 'reconcile' : options.preview ? 'preview' : 'nft', allowBlocked: options.allowBlocked === true || options.preview === true }); } finally { busy.delete(key); walletCache.delete(key); }
    },
  });
  function releaseUpdateGate() {
    updateBusy = false; serviceBusy = false; updatePhase = null; restartGate = false;
    if (overrides.startNftWorker === true) nftTrading?.start?.();
  }
  function reconcileRestart() {
    if (!(restartGate || updatePhase === 'restarting')) return;
    const health = readRestartHealth(ROOT);
    if (!health) return;
    if (Math.max(health.startedAt || 0, health.completedAt || 0) < restartSince) return;
    let alive = false; try { if (Number.isSafeInteger(health.workerPid)) { process.kill(health.workerPid, 0); alive = true; } } catch {}
    if (health.phase === 'restarting' && alive) return;
    if (health.phase === 'failed' || health.phase === 'restarting') updateError = health.error || 'Web 恢复任务已中断，请核对服务与备份';
    releaseUpdateGate();
  }
  const restartPoll = setInterval(reconcileRestart, 1000).unref();
  async function assertUpdateReady() {
    if (activeWalletCalls || busy.size || [...logins.values()].some(job => job.status === 'WAITING') || nftTrading?.hasInFlight?.()) throw failure(409, '钱包或 NFT 正在处理操作，请完成后再更新');
    const reported = Boolean((await deps.dashboardStatus()).service?.running);
    const active = reported || await (overrides.isScannerActive ? overrides.isScannerActive() : scannerIsActive(ROOT));
    if (active) throw failure(409, '请先停止扫描器，再更新本地程序；更新后不会自动开启交易');
    // Recheck after the asynchronous process probe; updateBusy prevents new CLI work.
    if (activeWalletCalls || busy.size || nftTrading?.hasInFlight?.()) throw failure(409, '钱包操作尚未结束，请稍后更新');
  }
  async function updateView() {
    reconcileRestart();
    const view = await getUpdater().view();
    const restart = readRestartHealth(ROOT);
    const healthMatches = restart?.targetCommit === view.current?.commit;
    const showHealth = healthMatches && restart.completedAt > (view.checkedAt || 0);
    let blockedReason = view.blockedReason || '';
    let rollbackBlockedReason = '';
    if (!updateBusy) {
      if (serviceBusy || activeWalletCalls || busy.size || [...logins.values()].some(job => job.status === 'WAITING') || nftTrading?.hasInFlight?.()) rollbackBlockedReason = '钱包或服务正在操作，请完成后再更新';
      else if ((await deps.dashboardStatus()).service?.running) rollbackBlockedReason = '请先停止扫描器再更新';
      if (!blockedReason) blockedReason = rollbackBlockedReason;
    }
    const occupied = updateBusy || Boolean(view.busy);
    return { ...view, ...(showHealth ? { phase: restart.phase === 'verified' ? 'succeeded' : restart.phase, message: restart.message, ...(restart.error ? { error: restart.error } : {}) } : {}), ...(updatePhase ? { phase: updatePhase } : {}), ...(updateError ? { error: updateError } : {}), restartResult: restart || view.restartResult, busy: occupied, walletBusy: Boolean(activeWalletCalls || busy.size), blockedReason, rollbackBlockedReason,
      canUpdate: !occupied && !blockedReason && Boolean(view.available ?? view.updateAvailable),
      canRollback: !occupied && !rollbackBlockedReason && Boolean(view.rollback?.available ?? view.rollbackAvailable ?? view.canRollback),
    };
  }
  async function admitUpdate(action, body, res, port) {
    if (body.confirmed !== true) throw failure(409, '请确认本次软件更新或版本回退');
    if (action === 'update' && !/^[a-f0-9]{40}$/i.test(body.targetCommit || '')) throw failure(400, '缺少有效的目标提交，请先检查更新');
    if (serviceBusy || updateBusy || getUpdater().isBusy?.()) throw failure(409, '更新或服务操作正在进行，请稍后');
    updateBusy = true; serviceBusy = true; updatePhase = 'preparing'; updateError = null;
    try { await assertUpdateReady(); } catch (error) { updateBusy = false; serviceBusy = false; updatePhase = null; throw error; }
    nftTrading?.stop?.();
    previews.clear();
    let accepted;
    try { accepted = await updateView(); } catch (error) { releaseUpdateGate(); throw error; }
    let responseFinished = false;
    res.once('close', () => { if (!responseFinished) releaseUpdateGate(); });
    // Send an accepted response before the long operation or any Web restart.
    res.once('finish', () => {
      responseFinished = true;
      if (res.statusCode !== 202) { releaseUpdateGate(); return; }
      setImmediate(() => {
      void (async () => {
        let restarting = false;
        try {
          updatePhase = null;
          const result = action === 'update' ? await getUpdater().update({ targetCommit: body.targetCommit }) : await getUpdater().rollback();
          if (result?.restartRequired || result?.needsWebRestart) {
            updatePhase = 'restarting';
            restartSince = Date.now();
            const restart = overrides.restartWeb || ((input) => spawnWebRestart({ root: ROOT, port, ...input }));
            await restart({ targetCommit: result.targetCommit || result.current?.commit, backupId: result.backupId, action });
            restarting = true;
          }
        } catch (error) {
          updateError = redact(error.message || '本地更新失败');
        } finally {
          if (!restarting) releaseUpdateGate();
        }
      })();
      });
    });
    return accepted;
  }
  const indexOf = (input) => {
    if (typeof input === 'string' && input && !/^\d+$/.test(input)) {
      try { return resolveWallet(config(), input).index; } catch { throw failure(404, '钱包不存在或已移除'); }
    }
    const index = Number(input ?? 0);
    if (!Number.isInteger(index) || index < 0 || index >= Math.max(config().wallets.length, 1)) throw failure(400, '钱包序号无效');
    return index;
  };
  const selector = (body, url) => body?.walletId ?? body?.walletIndex ?? url?.searchParams.get('walletId') ?? url?.searchParams.get('wallet');
  const walletCall = async (index, args, options = {}) => {
    const wallet = walletAt(index);
    return mustOk(await deps.runWallet(args, { walletIndex: index, ...(config().wallets[index] ? { walletId: wallet.id, expectedAddress: wallet.address } : {}), ...options }));
  };
  async function walletStatus(index, force = false) {
    const identity = walletAt(index), key = identity.id;
    const cached = walletCache.get(key);
    if (!force && cached && Date.now() - cached.at < 15000) return cached.data;
    const options = { walletIndex: index, ...(config().wallets[index] ? { walletId: key, expectedAddress: identity.address } : {}), timeout: 30000 };
    const result = await deps.runWallet(['wallet', 'status'], options);
    let data = { walletId: key, status: result.data?.status || 'ERROR', address: null, addresses: [], settings: null, cliVersion: deps.getCliInfo().version };
    if (!result.success) data.error = result.error?.message || '钱包状态获取失败';
    else if (result.data?.status === 'CONNECTED') {
      const [addresses, settings] = await Promise.all([
        deps.runWallet(['wallet', 'address'], options),
        deps.runWallet(['wallet', 'settings'], options),
      ]);
      data.addresses = addresses.success ? addresses.data?.addresses || [] : [];
      data.address = data.addresses.find((a) => String(a.binanceChainId) === '56')?.address || null;
      data.settings = settings.success ? settings.data : null;
      if (!addresses.success || !settings.success) data.error = addresses.error?.message || settings.error?.message;
    }
    data = redact(data);
    if (keyAt(index) !== key) throw failure(409, '钱包配置已改变，请刷新重试');
    walletCache.set(key, { at: Date.now(), data });
    return data;
  }
  async function requireConnected(index) {
    const wallet = await walletStatus(index, true);
    if (wallet.status !== 'CONNECTED') throw failure(409, wallet.error || '钱包尚未连接，请先登录');
    if (wallet.error) throw failure(502, wallet.error);
    if (!addressPattern.test(wallet.address || '')) throw failure(409, '当前钱包没有 BSC 地址');
    return wallet;
  }
  function assertWalletBinding(index, wallet, { allowArchived = false } = {}) {
    const selected = config().wallets[index];
    if (selected?.archived && !allowArchived || selected?.draft) throw failure(409, '请先导入钱包地址并恢复钱包，再进行操作');
    if (selected && selected.address.toLowerCase() !== wallet.address.toLowerCase()) throw failure(409, '登录钱包与所选配置地址不一致，请先在钱包管理中导入真实地址');
  }
  function loginView(job) {
    return { id: job.id, walletId: job.walletId, status: job.status, urlForWeb: job.urlForWeb, pairingCode: job.pairingCode, expireAt: job.expireAt, error: job.error };
  }
  async function startLogin(index, owner) {
    const key = keyAt(index), selected = walletAt(index);
    if (selected.archived) throw failure(409, '请先恢复已归档的钱包');
    if (serviceBusy) throw failure(409, '请等待服务操作完成，再登录钱包');
    for (const job of logins.values()) if (job.walletId === key && job.status === 'WAITING') {
      if (job.owner !== owner) throw failure(409, '这个钱包正在其他页面登录，请先完成或取消登录');
      return loginView(job);
    }
    if (busy.has(key)) throw failure(409, '这个钱包正在处理其他操作，请稍后重试');
    busy.add(key);
    invalidateWallet(key);
    try {
      const data = await walletCall(index, ['auth', 'signin'], { timeout: 60000 });
      walletCache.delete(key);
      if (data.status === 'ALREADY_CONNECTED') {
        if (selected.address) {
          const connected = await walletStatus(index, true);
          if (connected.address?.toLowerCase() !== selected.address.toLowerCase()) {
            await walletCall(index, ['auth', 'signout']);
            invalidateWallet(key);
            throw failure(409, '当前登录地址与已绑定钱包不一致，已退出错误会话，请使用正确钱包重新配对');
          }
        }
        const job = { id: randomBytes(18).toString('hex'), owner, walletIndex: index, walletId: key, status: 'SUCCESS' };
        logins.set(job.id, job); return loginView(job);
      }
      if (!data.qrCodeId || !data.urlForWeb || !data.pairingCode) throw failure(502, '登录响应缺少配对码或链接');
      let url; try { url = new URL(data.urlForWeb); } catch { throw failure(502, '登录链接无效'); }
      if (url.protocol !== 'https:' || !(url.hostname === 'binance.com' || url.hostname.endsWith('.binance.com'))) throw failure(502, '登录链接不属于币安官方域名');
      const controller = new AbortController();
      const job = { id: randomBytes(18).toString('hex'), owner, walletIndex: index, walletId: key, status: 'WAITING', urlForWeb: data.urlForWeb, pairingCode: data.pairingCode, expireAt: data.expireAt, controller };
      logins.set(job.id, job);
      // Keep verify alive in the server until App confirmation, cancellation, or timeout.
      job.promise = deps.runWallet(['auth', 'verify', '--qrCodeId', data.qrCodeId], { walletIndex: index, ...(config().wallets[index] ? { walletId: key } : {}), timeout: 330000, signal: controller.signal }).then(async (result) => {
        if (job.status !== 'WAITING') return;
        if (result.success && result.data?.status === 'SUCCESS') {
          walletCache.delete(key);
          const currentIndex = config().wallets.findIndex(wallet => wallet.id === key);
          const checked = await walletStatus(currentIndex < 0 && key === 'bootstrap-wallet' ? 0 : indexOf(key), true);
          if (job.status !== 'WAITING') return;
          job.status = checked.status === 'CONNECTED' ? 'SUCCESS' : 'FAILED';
          if (job.status === 'FAILED') job.error = checked.error || '币安 App 已确认，但本地会话尚未连接，请重新登录';
          else if (selected.address && checked.address?.toLowerCase() !== selected.address.toLowerCase()) {
            job.status = 'FAILED'; job.error = '配对地址与已绑定钱包不一致，已退出错误会话，请使用正确钱包重新配对';
            await walletCall(indexOf(key), ['auth', 'signout']); invalidateWallet(key);
          }
        } else {
          job.error = result.error?.message || '登录未完成';
          job.status = /expir|timeout|超时|过期/i.test(job.error) ? 'EXPIRED' : 'FAILED';
        }
      }).catch((e) => { if (job.status === 'WAITING') { job.status = 'FAILED'; job.error = e.message; } }).finally(() => busy.delete(key));
      return loginView(job);
    } finally {
      if (![...logins.values()].some((job) => job.walletId === key && job.status === 'WAITING')) busy.delete(key);
    }
  }
  function checkWalletIdentity(previous, next, { binding = false } = {}) {
    for (const old of previous.wallets) {
      const fresh = next.wallets.find(wallet => wallet.id === old.id);
      if (!fresh) throw failure(409, '请在钱包管理中归档钱包，不能删除历史身份');
      if (canonical(fresh.legacyNames) !== canonical(old.legacyNames)) throw failure(409, '钱包历史归属标识不能修改');
      for (const field of ['bawDir', 'instanceId', 'agentId', 'agentIdVerified']) if (fresh[field] !== old[field] && !(binding && ['agentId', 'agentIdVerified'].includes(field) && (!old.agentIdVerified || !old.agentId) && (old.draft || old.address?.toLowerCase() === fresh.address?.toLowerCase()) && (field !== 'agentIdVerified' || fresh.agentIdVerified === true))) throw failure(409, '钱包会话与 Agent ID 身份不能随配置修改');
      if (fresh.address?.toLowerCase() !== old.address?.toLowerCase() && !(binding && old.draft && !old.address && addressPattern.test(fresh.address || ''))) throw failure(409, '钱包地址不能替换，请添加新的钱包');
    }
  }
  const saveWallets = (next, options) => {
    const previous = config(), normalized = normalizeWalletConfig(next);
    checkWalletIdentity(previous, normalized, { binding: options?.allowWalletBinding });
    const changed = new Set(normalized.wallets.filter(wallet => canonical(wallet) !== canonical(previous.wallets.find(old => old.id === wallet.id))).map(wallet => wallet.id));
    const globalChange = ['monitorOnly', 'paid', 'rules', 'portfolioBudget', 'timeZone'].some(key => canonical(previous[key]) !== canonical(normalized[key]));
    const saved = deps.saveConfig(next, options);
    if (globalChange) { walletCache.clear(); previews.clear(); }
    else {
      for (const id of changed) walletCache.delete(id);
      for (const [id, preview] of previews) if (changed.has(preview.walletId)) previews.delete(id);
    }
    return saved;
  };
  function hasPendingScannerOperation(wallet) {
    try {
      const state = JSON.parse(readFileSync(join(appRoot, 'data', 'watch_state.json'), 'utf8'));
      return Object.entries(state.tokens || {}).some(([key, state]) => (key.startsWith(wallet.address.toLowerCase() + ':') || state.walletAddress?.toLowerCase() === wallet.address.toLowerCase()) && (state.pendingSell || state.submissionIntent || state.sellReviewRequired));
    } catch (error) { if (error.code !== 'ENOENT') throw failure(409, '无法核验钱包待处理订单，暂不能归档'); return false; }
  }
  async function assertArchivable(wallet, { locked = false } = {}) {
    if (hasPendingScannerOperation(wallet)) throw failure(409, '此钱包还有待确认或待核对的代币订单');
    const nft = await getNftTrading().view();
    const active = new Set(['intent', 'signing', 'signature-pending', 'publishing', 'listed', 'submitting', 'pending', 'review']);
    if (Object.entries(nft.states || {}).some(([key, state]) => key.startsWith(wallet.address.toLowerCase() + ':') && active.has(state.phase))) throw failure(409, '此钱包还有 NFT 挂单或待处理订单，请先核对或撤单');
    if (durableRuntime) {
      const execution = await walletExecutionView(wallet, { root: appRoot });
      if (execution.busy && !locked || execution.blocked) throw failure(409, '此钱包还有执行中或待核对的操作');
    }
  }
  function bnb(wei) {
    if (wei === null || wei === undefined) return null;
    const amount = BigInt(wei), whole = amount / 10n ** 18n, fraction = (amount % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '');
    return whole + (fraction ? '.' + fraction : '');
  }
  const budgetRow = row => ({ spentBnb: bnb(row?.spentWei ?? '0'), reservedBnb: bnb(row?.reservedWei ?? '0'), remainingBnb: bnb(row?.remainingWei ?? null) });
  function scannerPending(wallet) {
    try { return JSON.parse(readFileSync(join(appRoot, 'data', 'watch_state.json'), 'utf8')).walletPending?.[wallet.id] || null; }
    catch (error) { if (error.code === 'ENOENT') return null; throw failure(409, '扫描器状态无法读取，请先恢复状态文件'); }
  }
  async function walletsView() {
    const current = config(), ledger = budget ? await budget.view(current) : null;
    const wallets = await Promise.all(current.wallets.map(async (wallet, index) => ({
      ...wallet, index,
      runtime: await (async () => { const execution = durableRuntime ? await walletExecutionView(wallet, { root: appRoot }) : {}; return { ...execution, canReconcile: Boolean(execution.blocked && (execution.details?.source === 'manual' || scannerPending(wallet))), busy: busy.has(wallet.id) || Boolean(execution.busy), globalMonitorOnly: current.monitorOnly, sessionVersion: sessionVersions.get(wallet.id) || 0 }; })(),
      budget: budgetRow(ledger?.wallets?.[wallet.id]),
    })));
    return { wallets, portfolioBudget: { ...budgetRow(ledger?.portfolio), maxBnbPerDay: current.portfolioBudget?.maxBnbPerDay ?? null } };
  }
  async function reconcileManual(wallet, suppliedHash) {
    if (!durableRuntime) throw failure(409, '此运行环境没有持久交易记录');
    return executor(wallet, async () => {
      const state = await walletExecutionView(wallet, { root: appRoot }), details = state.details || {};
      if (!state.blocked) return { resolved: true, message: '此钱包没有待核对的交易' };
      if (details.source !== 'manual') {
        const pending = scannerPending(wallet);
        if (!pending) throw failure(409, '请在原代币或 NFT 订单中核对；不能跳过订单状态直接解锁');
        if (suppliedHash && suppliedHash.toLowerCase() !== pending.txHash?.toLowerCase()) throw failure(409, '只能核验原提交记录或官方订单关联的交易哈希');
        const outcome = await reconcileScannerPending({ wallet, pending, runWallet: (args, options = {}) => deps.runWallet(args, { ...options, walletId: wallet.id, walletIndex: indexOf(wallet.id) }), rpc: overrides.rpc || nftRpc, budget, root: appRoot });
        return { ...outcome, message: outcome.reason || (outcome.resolved ? '原订单凭证已核验，不会重复发送' : '原订单仍待核验，继续保留额度') };
      }
      if (!/^0x[0-9a-f]{64}$/i.test(details.txHash || '')) return { resolved: false, message: '缺少与原提交关联的交易凭证，保持待核对；不能用同参数的历史交易解除等待' };
      const txHash = suppliedHash || details.txHash;
      if (!/^0x[0-9a-f]{64}$/i.test(txHash || '')) return { resolved: false, message: '尚无可核验的交易哈希，请先在币安 App 查找这笔交易' };
      if (details.txHash && txHash.toLowerCase() !== details.txHash.toLowerCase()) throw failure(409, '交易哈希与上笔提交记录不一致');
      const rpc = overrides.rpc || nftRpc;
      let transaction, receipt, chain;
      try { [transaction, receipt, chain] = await Promise.all([rpc('eth_getTransactionByHash', [txHash]), rpc('eth_getTransactionReceipt', [txHash]), rpc('eth_chainId', [])]); }
      catch { throw failure(502, '暂时无法取得链上凭证，继续保留待核对状态'); }
      if (!transaction || !receipt) return { resolved: false, message: '尚未找到已上链收据，继续等待；不会重复发送' };
      const inputHash = createHash('sha256').update((transaction.input || '0x').toLowerCase()).digest('hex');
      if (BigInt(chain) !== 56n || !details.to || !details.value || !details.inputDataHash || transaction.hash?.toLowerCase() !== txHash.toLowerCase() || transaction.from?.toLowerCase() !== wallet.address.toLowerCase() || transaction.to?.toLowerCase() !== details.to.toLowerCase() || BigInt(transaction.value || '0') !== BigInt(details.value) || inputHash !== details.inputDataHash || receipt.transactionHash?.toLowerCase() !== txHash.toLowerCase() || !transaction.blockHash || transaction.blockHash !== receipt.blockHash || !transaction.blockNumber || transaction.blockNumber !== receipt.blockNumber || !['0x0', '0x1'].includes(receipt.status)) throw failure(409, '交易凭证与原钱包或预演内容不匹配，保持待核对状态');
      if (details.reservationId) await budget.settle(details.reservationId, { spentWei: receipt.status === '0x1' ? details.value : '0' });
      await clearWalletBlocked(wallet, { root: appRoot, reference: details.orderId || details.txHash || details.reservationId, confirmed: true });
      return { resolved: true, txHash, success: receipt.status === '0x1', message: receipt.status === '0x1' ? '交易凭证已核验，可继续操作' : '链上交易失败，已核对并解除等待；不会自动重发' };
    }, { kind: 'recovery', allowBlocked: true });
  }
  const clean = setInterval(() => {
    for (const [key, session] of sessions) if (session.expires < Date.now()) sessions.delete(key);
    for (const [key, preview] of previews) if (preview.expiresAt < Date.now()) previews.delete(key);
    for (const [key, job] of logins) if (job.status !== 'WAITING' && (expiryTime(job.expireAt) || 0) < Date.now() - 3600000) logins.delete(key);
  }, 60000).unref();

  const server = http.createServer(async (req, res) => {
    const port = req.socket.localPort;
    const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    const origin = `http://${req.headers.host}`;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const send = (status, payload) => {
      if (res.writableEnded) return;
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      let secrets = [process.env.TG_BOT_TOKEN];
      try { secrets.push(config().telegram?.botToken); } catch {}
      try { if (nftTrading?.getApiKey) secrets.push(nftTrading.getApiKey()); } catch {}
      res.end(JSON.stringify(redact(payload, secrets)));
    };
    try {
      if (!allowedHosts.includes(req.headers.host)) throw failure(403, '仅允许本机访问');
      if (req.headers.origin && req.headers.origin !== origin) throw failure(403, '不允许跨站请求');
      const url = new URL(req.url, origin), path = url.pathname;
      const sid = req.headers.cookie?.match(/(?:^|;\s*)sniper_session=([a-f0-9]{48})(?:;|$)/)?.[1];
      let session = sessions.get(sid);
      if (session?.expires < Date.now()) { sessions.delete(sid); session = null; }
      if (req.method === 'GET' && path === '/api/bootstrap') {
        let id = sid;
        if (!session) {
          id = randomBytes(24).toString('hex');
          session = { csrf: randomBytes(24).toString('hex'), expires: Date.now() + 6 * 3600000 };
          sessions.set(id, session);
          res.setHeader('Set-Cookie', `sniper_session=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=21600`);
        }
      send(200, { ok: true, data: { csrfToken: session.csrf } }); return;
      }
      if (path.startsWith('/api/')) {
        if (!session) throw failure(401, '页面会话已失效，请刷新页面');
        session.expires = Date.now() + 6 * 3600000;
        if (updateBusy && !(req.method === 'GET' && ['/api/status', '/api/updates', '/api/logs'].includes(path))) throw failure(409, '本地程序正在更新，请等待 Web 恢复后操作');
        let body = {};
        if (req.method === 'POST') {
          if (req.headers['x-csrf-token'] !== session.csrf) throw failure(403, '请求校验失败，请刷新页面');
          if (!/^application\/json\b/.test(req.headers['content-type'] || '')) throw failure(415, '请求必须为 JSON');
          const chunks = []; let length = 0;
          for await (const part of req) {
            length += part.length;
            if (length > MAX_BODY) throw failure(413, '请求内容过大');
            chunks.push(part);
          }
          const content = Buffer.concat(chunks).toString('utf8');
          try { body = content ? JSON.parse(content) : {}; } catch { throw failure(400, 'JSON 格式错误'); }
          if (!body || typeof body !== 'object' || Array.isArray(body)) throw failure(400, '请求内容必须为对象');
        }
        let data;
        if (req.method === 'GET' && path === '/api/wallets') data = await walletsView();
        else if (req.method === 'POST' && path === '/api/wallets') {
          if (serviceBusy) throw failure(409, '请等待服务操作完成');
          const current = config();
          if (current.wallets.length >= 16) throw failure(400, '最多配置 16 个钱包');
          const id = 'wallet-' + randomUUID();
          const wallet = { id, name: typeof body.name === 'string' ? body.name.trim() : `钱包 ${current.wallets.length + 1}`, address: '', agentId: '', bawDir: 'data/wallets/' + id, instanceId: id, mode: 'monitor', paused: true, archived: false, draft: true, autoMint: true, autoSellTokens: true, autoSellNfts: true, paid: { maxBnbPerDay: 0 } };
          const saved = saveWallets({ ...current, wallets: [...current.wallets, wallet] });
          data = { wallet: saved.wallets.find(entry => entry.id === id), config: saved };
        } else if (req.method === 'POST' && path === '/api/wallets/pause') {
          if (serviceBusy) throw failure(409, '请等待服务操作完成');
          const current = config(), ids = body.walletIds;
          if (ids !== undefined && (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !current.wallets.some(wallet => wallet.id === id)))) throw failure(400, '钱包列表无效');
          const selected = new Set(ids?.length ? ids : current.wallets.map(wallet => wallet.id));
          data = { config: saveWallets({ ...current, wallets: current.wallets.map(wallet => selected.has(wallet.id) ? { ...wallet, paused: true } : wallet) }) };
        } else if (req.method === 'POST' && /^\/api\/wallets\/[a-zA-Z0-9_-]+\/reconcile$/.test(path)) {
          const wallet = walletAt(indexOf(path.split('/')[3]));
          if (busy.has(wallet.id)) throw failure(409, '此钱包正在操作，请稍后核对');
          busy.add(wallet.id); try { data = await reconcileManual(wallet, body.txHash); } finally { busy.delete(wallet.id); }
        } else if (req.method === 'POST' && /^\/api\/wallets\/[a-zA-Z0-9_-]+\/settings$/.test(path)) {
          if (serviceBusy) throw failure(409, '请等待服务操作完成');
          const current = config(), index = indexOf(path.split('/')[3]), wallet = current.wallets[index], patch = body.patch;
          if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).some(key => !['name', 'mode', 'paused', 'archived', 'paid', 'rules', 'autoMint', 'autoSellTokens', 'autoSellNfts'].includes(key))) throw failure(400, '钱包设置字段无效');
          if (busy.has(wallet.id)) throw failure(409, '此钱包正在操作，请完成后再修改');
          const updated = { ...wallet, ...patch };
          for (const key of ['paid', 'rules']) if (patch[key] !== undefined) updated[key] = { ...(wallet[key] || {}), ...patch[key] };
          const enabling = (!updated.paused && !updated.archived && updated.mode !== 'monitor') && (wallet.paused || wallet.archived || wallet.mode === 'monitor' || patch.mode !== undefined || patch.paid !== undefined || patch.rules !== undefined || ['autoMint', 'autoSellTokens', 'autoSellNfts'].some(key => patch[key] === true && wallet[key] !== true));
          if (enabling && body.confirmed !== true) throw failure(409, '请确认此钱包的交易模式、额度及最终策略');
          if (enabling && wallet.draft) throw failure(409, '请先登录并导入钱包地址');
          const revision = walletRevision(wallet);
          busy.add(wallet.id);
          try {
            const apply = async () => {
              if (patch.archived === true && !wallet.archived) { await assertArchivable(wallet, { locked: true }); updated.paused = true; }
              if (enabling && !current.monitorOnly) {
                const connected = await requireConnected(index); assertWalletBinding(index, connected); assertDevMode(connected.settings);
              }
              const latest = config(), latestIndex = latest.wallets.findIndex(entry => entry.id === wallet.id);
              if (latestIndex < 0 || walletRevision(latest.wallets[latestIndex]) !== revision) throw failure(409, '钱包设置已改变，请刷新后重试');
              latest.wallets[latestIndex] = updated;
              return { config: saveWallets(latest), wallet: updated };
            };
            data = patch.archived === true && !wallet.archived ? await executor(wallet, apply, { kind: 'status', allowBlocked: true }) : await apply();
          } finally { busy.delete(wallet.id); }
        } else if (req.method === 'GET' && path === '/api/updates') data = await updateView();
        else if (req.method === 'GET' && path === '/api/telegram/status') data = getTelegramMonitor().view();
        else if (req.method === 'POST' && path === '/api/updates/check') { await getUpdater().check(); data = await updateView(); }
        else if (req.method === 'POST' && ['/api/updates/apply', '/api/updates/rollback'].includes(path)) {
          data = await admitUpdate(path.endsWith('/apply') ? 'update' : 'rollback', body, res, port);
          send(202, { ok: true, data }); return;
        }
        else if (req.method === 'GET' && path === '/api/status') data = { ...(await deps.dashboardStatus()), walletCli: deps.getCliInfo() };
        else if (req.method === 'GET' && path === '/api/config') data = { config: deps.sanitizeConfig(config()) };
        else if (req.method === 'POST' && path === '/api/config') {
          if (serviceBusy) throw failure(409, '服务操作正在进行，请稍后保存配置');
          const input = body.config;
          if (!input || typeof input !== 'object') throw failure(400, '缺少 config 配置');
          if ((input.monitorOnly ?? config().monitorOnly) === false && body.confirmAutoTrading !== true) throw failure(409, '启用自动交易需要明确确认预算及规则');
          if ([...logins.values()].some((job) => job.status === 'WAITING')) throw failure(409, '请先完成或取消钱包登录，再修改配置');
          if (busy.size) throw failure(409, '钱包操作正在进行，请稍后保存配置');
          const current = config();
          if (current.wallets.length && input.wallets !== undefined && canonical(normalizeWalletConfig({ ...current, wallets: input.wallets }).wallets) !== canonical(current.wallets)) throw failure(409, '钱包设置已变化，请刷新；钱包模式、暂停和策略须通过钱包管理单独修改');
          data = { config: saveWallets({ ...config(), ...input }) }; walletCache.clear(); previews.clear();
        } else if (req.method === 'GET' && path === '/api/logs') {
          data = deps.readLogs(url.searchParams.get('limit'), (url.searchParams.get('search') || '').slice(0, 200));
          const requested = url.searchParams.get('walletId');
          if (requested) {
            const current = config(), selected = current.wallets[indexOf(requested)];
            const mentions = (line, wallet) => [wallet.id, wallet.address, `[${wallet.name}]`, wallet.agentId && `[${wallet.agentId}]`].filter(Boolean).some(label => String(line).toLowerCase().includes(label.toLowerCase()));
            data = { ...data, walletId: selected.id, lines: (data.lines || []).filter(line => mentions(line, selected) || !current.wallets.some(wallet => mentions(line, wallet))) };
          }
        }
        else if (req.method === 'GET' && path === '/api/holdings') data = { ...await deps.holdingsData({ force: url.searchParams.get('refresh') === '1' }), nftTrading: await getNftTrading().view() };
        else if (req.method === 'GET' && path === '/api/nft/trading') data = await getNftTrading().view();
        else if (req.method === 'POST' && path.startsWith('/api/nft/trading/')) {
          if (serviceBusy) throw failure(409, '请等待服务操作完成，再修改 NFT 自动卖出');
          const nft = getNftTrading();
          if (path === '/api/nft/trading/settings') {
            if (busy.size || nft.hasInFlight?.()) throw failure(409, '钱包正在操作，请稍后保存市场设置');
            data = await nft.saveSettings(body);
          } else if (path === '/api/nft/trading/rules') data = await nft.saveRule(body.rule);
          else if (path === '/api/nft/trading/enable') data = await nft.enable(body.key, body.policyHash, body.confirmed);
          else if (path === '/api/nft/trading/disable') data = await nft.disable(body.key);
          else if (path === '/api/nft/trading/preview') data = await nft.preview(body.key, sid);
          else if (path === '/api/nft/trading/cancel-preview') data = await nft.preview(body.key, sid, true);
          else if (path === '/api/nft/trading/confirm') data = await nft.confirm(body.actionId, sid, body.confirmed);
          else throw failure(404, 'NFT 接口不存在');
        }
        else if (req.method === 'POST' && /^\/api\/service\/(start|stop|restart)$/.test(path)) {
          if (serviceBusy) throw failure(409, '服务操作正在执行，请稍后');
          const action = path.split('/').at(-1);
          serviceBusy = true;
          try {
            if (action !== 'stop' && !config().monitorOnly && busy.size) throw failure(409, '请先完成当前钱包操作，再启动自动交易');
            if (action !== 'stop' && !config().monitorOnly) {
              if (body.confirmAutoTrading !== true) throw failure(409, '自动交易启动需要确认');
              if (!config().wallets.length) throw failure(409, '请先配置钱包');
              for (let i = 0; i < config().wallets.length; i++) {
                const entry = config().wallets[i];
                if (!['mint', 'token-sell', 'nft-sell'].some(kind => walletCanAutomate(config(), entry, kind))) continue;
                const wallet = await requireConnected(i); assertDevMode(wallet.settings);
                if (wallet.address.toLowerCase() !== config().wallets[i].address.toLowerCase()) throw failure(409, `钱包 ${i + 1} 登录地址与配置不一致，请重新导入地址`);
              }
            }
            data = await deps.controlService(action);
          } finally { serviceBusy = false; }
        } else if (req.method === 'GET' && path === '/api/wallet/status') data = await walletStatus(indexOf(selector(null, url)), url.searchParams.get('refresh') === '1');
        else if (req.method === 'GET' && path === '/api/wallet/balance') {
          const index = indexOf(selector(null, url)); const wallet = await requireConnected(index); assertWalletBinding(index, wallet, { allowArchived: true });
          data = { balances: await walletCall(index, ['wallet', 'balance', '--binanceChainId', '56', '--hideLowValue', 'false']) };
        } else if (req.method === 'POST' && path === '/api/wallet/login') data = await startLogin(indexOf(selector(body)), sid);
        else if (/^\/api\/wallet\/login\/[a-f0-9]+(?:\/cancel)?$/.test(path)) {
          const id = path.split('/')[4], job = logins.get(id);
          if (!job || job.owner !== sid) throw failure(404, '登录会话不存在，请重新登录');
          if (req.method === 'POST' && path.endsWith('/cancel')) {
            if (job.status === 'WAITING') { job.status = 'CANCELLED'; job.controller.abort(); await job.promise; }
          } else if (req.method !== 'GET' || path.endsWith('/cancel')) throw failure(405, '不支持的请求方式');
          data = loginView(job);
        } else if (req.method === 'POST' && path === '/api/wallet/import') {
          const index = indexOf(selector(body)), identity = walletAt(index), key = identity.id;
          if (serviceBusy) throw failure(409, '请等待服务操作完成，再导入地址');
          if (busy.size) throw failure(409, '请先完成当前钱包操作，再导入地址');
          busy.add(key);
          try {
            const wallet = await requireConnected(index);
            if (identity.address && identity.address.toLowerCase() !== wallet.address.toLowerCase()) throw failure(409, '实际登录地址与此钱包不一致，请重新配对正确的钱包');
            let agentId = identity.agentId || '';
            if (identity.draft || !identity.agentIdVerified || !identity.agentId) {
              const claimed = await walletCall(index, ['wallet', 'agent-id']);
              if (typeof claimed.claimed !== 'boolean') throw failure(502, '无法确认官方 Agent ID 状态，请稍后重新核验');
              agentId = '';
              if (claimed.claimed === true) {
                if (typeof claimed.handle !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(claimed.handle)) throw failure(502, 'Agent ID 响应格式无效，请重新核验');
                agentId = claimed.handle;
              }
            }
            if (budget) await budget.view(config());
            const next = structuredClone(config()), currentIndex = identity.id === 'bootstrap-wallet' ? 0 : indexOf(identity.id);
            next.wallets[currentIndex] = { ...next.wallets[currentIndex], name: next.wallets[currentIndex]?.name || `钱包 ${currentIndex + 1}`, address: identity.address || wallet.address, agentId, agentIdVerified: true, ...(identity.draft || identity.id === 'bootstrap-wallet' ? { draft: false, paused: true, mode: 'monitor', bawDir: identity.bawDir } : {}) };
            data = { config: saveWallets(next, { allowWalletBinding: true }), wallet }; invalidateWallet(key);
          } finally { busy.delete(key); }
        } else if (req.method === 'POST' && path === '/api/wallet/logout') {
          const index = indexOf(selector(body)), identity = walletAt(index), key = identity.id;
          if (serviceBusy) throw failure(409, '请等待服务操作完成，再退出钱包');
          if (body.confirmed !== true) throw failure(409, '请确认退出登录');
          if (busy.has(key)) throw failure(409, '请先完成或取消当前钱包操作');
          busy.add(key);
          try {
            const liveStatus = await deps.dashboardStatus();
            const current = config();
            if (current.wallets[index]) { current.wallets[index].paused = true; saveWallets(current); }
            data = await executor(identity, () => walletCall(index, ['auth', 'signout']), { kind: 'auth', allowBlocked: true }); invalidateWallet(key);
          } finally { busy.delete(key); }
        } else if (req.method === 'POST' && path === '/api/contract/preview') {
          const index = indexOf(selector(body)), identity = walletAt(index), key = identity.id;
          if (serviceBusy) throw failure(409, '请等待服务操作完成，再预演交易');
          if (!addressPattern.test(body.to || '')) throw failure(400, '目标合约地址无效');
          const inputData = body.inputData || '0x';
          if (!/^0x(?:[a-fA-F0-9]{2})*$/.test(inputData) || inputData.length > 32770) throw failure(400, '调用数据必须为 0x 开头的完整十六进制字节');
          const value = toWei(body.value);
          if (busy.has(key)) throw failure(409, '钱包正在处理其他操作');
          busy.add(key);
          try {
            data = await executor(identity, async () => {
              const wallet = await requireConnected(index); assertWalletBinding(index, wallet); assertDevMode(wallet.settings);
              const revision = walletRevision(walletAt(index));
              const result = await walletCall(index, ['contract-call', 'preview', '--binanceChainId', '56', '--from', wallet.address, '--to', body.to, '--value', value, '--inputData', inputData], { timeout: 180000 });
              if (keyAt(index) !== key || walletRevision(walletAt(index)) !== revision) throw failure(409, '钱包设置已改变，请重新预演');
              if (!result.requestId) throw failure(502, '预演未返回可执行的 requestId');
              const expiresAt = Math.min(expiryTime(result.expiresAt) || Date.now() + 300000, Date.now() + 300000);
              const id = randomBytes(24).toString('hex'), snapshot = { ...walletIdentity(identity), address: wallet.address };
              previews.set(id, { owner: sid, walletIndex: index, walletId: key, revision, address: wallet.address, to: body.to, inputDataHash: createHash('sha256').update(inputData.toLowerCase()).digest('hex'), value, requestId: result.requestId, expiresAt });
              return { ...result, id, expiresAt, wallet: snapshot, authorityChanges: result.simulationResult?.authorityChanges || [] };
            }, { kind: 'preview', allowBlocked: true });
          } finally { busy.delete(key); }
        } else if (req.method === 'POST' && path === '/api/contract/execute') {
          if (serviceBusy) throw failure(409, '请等待服务操作完成，再执行交易');
          const preview = previews.get(body.id);
          if (!preview || preview.owner !== sid || preview.expiresAt <= Date.now()) throw failure(409, '预演已过期或不存在，请重新预演');
          if (body.confirmed !== true) throw failure(409, '请先阅读预演结果并明确确认执行');
          if (body.walletId && body.walletId !== preview.walletId) throw failure(409, '确认的钱包与预演钱包不一致，请重新预演');
          const index = preview.walletId === 'bootstrap-wallet' && !config().wallets.length ? 0 : indexOf(preview.walletId), identity = walletAt(index);
          if (walletRevision(identity) !== preview.revision) throw failure(409, '钱包或策略配置已改变，请重新预演');
          if (busy.has(identity.id)) throw failure(409, '钱包正在处理其他操作');
          busy.add(identity.id);
          // Consume before invoking the CLI: a retry cannot broadcast the same preview twice.
          previews.delete(body.id);
          try {
            data = await executor(identity, async () => {
              const currentIndex = identity.id === 'bootstrap-wallet' ? 0 : indexOf(identity.id);
              const wallet = await requireConnected(currentIndex); assertWalletBinding(currentIndex, wallet); assertDevMode(wallet.settings);
              if (wallet.address.toLowerCase() !== preview.address.toLowerCase() || walletRevision(walletAt(currentIndex)) !== preview.revision) throw failure(409, '登录钱包或配置已改变，请重新预演');
              if (preview.expiresAt <= Date.now()) throw failure(409, '预演已过期，请重新预演');
              const txLock = await walletCall(currentIndex, ['wallet', 'tx-lock', '--binanceChainId', '56']);
              if (txLock.status !== 'UNLOCKED') throw failure(409, '此钱包有待确认交易或状态未知，请先在币安 App 核对');
              let reservation;
              if (budget && identity.address && BigInt(preview.value) > 0n) reservation = await budget.reserve({ wallet: identity, config: config(), amountWei: preview.value, id: 'manual-' + body.id });
              try {
                const result = await walletCall(currentIndex, ['contract-call', 'execute', '--requestId', preview.requestId], { timeout: 180000, beforeSend: () => {
                  if (walletRevision(walletAt(currentIndex)) !== preview.revision || preview.expiresAt <= Date.now()) throw failure(409, '预演或钱包设置已改变，本次未发送');
                } });
                // Broadcast/pending responses are never interpreted as final receipt.
                if (durableRuntime) await markWalletBlocked(identity, '手动交易已提交，等待核验结果', { root: appRoot, details: { source: 'manual', orderId: result.orderId || null, txHash: result.txHash || null, reservationId: reservation?.id || null, to: preview.to, value: preview.value, inputDataHash: preview.inputDataHash } });
                return { ...result, wallet: walletIdentity(identity) };
              } catch (error) {
                const rejected = ['INVALID_PARAMS', 'INVALID_AMOUNT', 'INVALID_ADDRESS', 'NOT_LOGGED_IN', 'INSUFFICIENT_BALANCE', 'CONFIG_ERROR', 'CLI_NOT_READY'].includes(error.details?.name);
                if (reservation && rejected) await budget.release(reservation.id);
                if (durableRuntime && !rejected) await markWalletBlocked(identity, '手动交易结果不明，请先核对钱包订单', { root: appRoot, details: { source: 'manual', reservationId: reservation?.id || null, to: preview.to, value: preview.value, inputDataHash: preview.inputDataHash } });
                throw error;
              }
            }, { kind: 'manual' });
          } finally { busy.delete(identity.id); walletCache.delete(identity.id); }
        } else throw failure(404, '接口不存在');
        send(200, { ok: true, data }); return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw failure(405, '不支持的请求方式');
      const assets = { '/': ['index.html', 'text/html'], '/index.html': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/styles.css': ['styles.css', 'text/css'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'] };
      const asset = assets[path];
      if (!asset) throw failure(404, '页面不存在');
      const content = readFileSync(join(ROOT, 'web', asset[0]));
      res.writeHead(200, { 'Content-Type': `${asset[1]}; charset=utf-8` }); res.end(req.method === 'HEAD' ? undefined : content);
    } catch (error) {
      overrides.onError?.(error);
      send(error.status || 500, { ok: false, error: { message: error.status ? error.message : '服务处理失败，请检查本地配置或重试', details: error.details || error.errors } });
    }
  });
  server.on('close', () => { clearInterval(clean); clearInterval(restartPoll); nftTrading?.stop?.(); localUpdater?.stop?.(); void telegramMonitor?.stop?.(); for (const job of logins.values()) job.controller?.abort(); });
  if (overrides.startNftWorker === true) server.once('listening', () => getNftTrading().start());
  if (overrides.startUpdateChecker === true) server.once('listening', () => getUpdater().start());
  if (overrides.startTelegramMonitor === true) server.once('listening', () => getTelegramMonitor().start());
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || 4317);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT 必须介于 1024 与 65535');
  const server = createApp({ startNftWorker: true, startUpdateChecker: true, startTelegramMonitor: true });
  server.listen(port, '127.0.0.1', () => console.log(`Agent ID Sniper 控制台：http://127.0.0.1:${port}`));
  server.on('error', (e) => { console.error(e.code === 'EADDRINUSE' ? `端口 ${port} 已占用` : e.message); process.exitCode = 1; });
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(() => process.exit(0)));
}
