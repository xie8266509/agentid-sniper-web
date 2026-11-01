import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readConfig, sanitizeConfig, saveConfig } from './lib/config.mjs';
import { runWallet, getCliInfo } from './lib/wallet-cli.mjs';
import { ROOT, dashboardStatus, controlService, holdingsData, readLogs, redact } from './lib/control.mjs';
import { createLocalNftTrading } from './lib/nft-local.mjs';
import { createLocalUpdater } from './lib/local-updater.mjs';
import { readRestartHealth, scannerIsActive, spawnWebRestart } from './lib/update-runtime.mjs';

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
function assertDevMode(settings) {
  const expiry = expiryTime(settings?.devMode?.expiresAt);
  if (settings?.devMode?.enabled !== true || Number.isFinite(expiry) && expiry <= Date.now()) {
    throw failure(409, '请在币安 App 的 Agentic Wallet → 设置中开启开发者模式，并确认签名后重试');
  }
}

export function createApp(overrides = {}) {
  const deps = { readConfig, sanitizeConfig, saveConfig, runWallet, getCliInfo, dashboardStatus, controlService, holdingsData, readLogs, ...overrides };
  const sessions = new Map(), logins = new Map(), previews = new Map(), walletCache = new Map(), busy = new Set();
  let serviceBusy = false, updateBusy = false, activeWalletCalls = 0, updatePhase = null, updateError = null;
  let restartGate = readRestartHealth(ROOT)?.phase === 'restarting';
  let restartSince = restartGate ? readRestartHealth(ROOT)?.startedAt || 0 : 0;
  if (restartGate && overrides.startUpdateChecker === true) { serviceBusy = true; updateBusy = true; updatePhase = 'restarting'; }
  const walletRunner = deps.runWallet;
  deps.runWallet = async (...args) => {
    if (updateBusy) throw failure(409, '正在更新本地程序，请等待 Web 恢复后操作钱包');
    activeWalletCalls++;
    try { return await walletRunner(...args); } finally { activeWalletCalls--; }
  };
  let localUpdater = overrides.localUpdater;
  const getUpdater = () => localUpdater ||= createLocalUpdater({ root: ROOT, beforeApply: assertUpdateReady });
  let nftTrading = overrides.nftTrading;
  const getNftTrading = () => nftTrading ||= createLocalNftTrading({
    root: ROOT, readConfig: deps.readConfig, runWallet: deps.runWallet,
    serviceInfo: async () => { const service = (await deps.dashboardStatus()).service; return { ...service, running: !serviceBusy && service.running }; },
    withWalletLock: async (index, work) => {
      if (serviceBusy || busy.has(index) || [...logins.values()].some(job => job.walletIndex === index && job.status === 'WAITING')) throw failure(409, '钱包或服务正在处理其他操作，请稍后重试');
      busy.add(index); try { return await work(); } finally { busy.delete(index); walletCache.delete(index); }
    },
  });
  const config = () => deps.readConfig();
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
    const index = Number(input ?? 0);
    if (!Number.isInteger(index) || index < 0 || index >= Math.max(config().wallets.length, 1)) throw failure(400, '钱包序号无效');
    return index;
  };
  const walletCall = async (index, args, options = {}) => mustOk(await deps.runWallet(args, { walletIndex: index, ...options }));
  async function walletStatus(index, force = false) {
    const cached = walletCache.get(index);
    if (!force && cached && Date.now() - cached.at < 15000) return cached.data;
    const result = await deps.runWallet(['wallet', 'status'], { walletIndex: index, timeout: 30000 });
    let data = { status: result.data?.status || 'ERROR', address: null, addresses: [], settings: null, cliVersion: deps.getCliInfo().version };
    if (!result.success) data.error = result.error?.message || '钱包状态获取失败';
    else if (result.data?.status === 'CONNECTED') {
      const [addresses, settings] = await Promise.all([
        deps.runWallet(['wallet', 'address'], { walletIndex: index, timeout: 30000 }),
        deps.runWallet(['wallet', 'settings'], { walletIndex: index, timeout: 30000 }),
      ]);
      data.addresses = addresses.success ? addresses.data?.addresses || [] : [];
      data.address = data.addresses.find((a) => String(a.binanceChainId) === '56')?.address || null;
      data.settings = settings.success ? settings.data : null;
      if (!addresses.success || !settings.success) data.error = addresses.error?.message || settings.error?.message;
    }
    data = redact(data);
    walletCache.set(index, { at: Date.now(), data });
    return data;
  }
  async function requireConnected(index) {
    const wallet = await walletStatus(index, true);
    if (wallet.status !== 'CONNECTED') throw failure(409, wallet.error || '钱包尚未连接，请先登录');
    if (wallet.error) throw failure(502, wallet.error);
    if (!addressPattern.test(wallet.address || '')) throw failure(409, '当前钱包没有 BSC 地址');
    return wallet;
  }
  function assertWalletBinding(index, wallet) {
    const selected = config().wallets[index];
    if (selected && selected.address.toLowerCase() !== wallet.address.toLowerCase()) throw failure(409, '登录钱包与所选配置地址不一致，请先在钱包管理中导入真实地址');
  }
  function loginView(job) {
    return { id: job.id, status: job.status, urlForWeb: job.urlForWeb, pairingCode: job.pairingCode, expireAt: job.expireAt, error: job.error };
  }
  async function startLogin(index, owner) {
    if (serviceBusy) throw failure(409, '请等待服务操作完成，再登录钱包');
    for (const job of logins.values()) if (job.walletIndex === index && job.status === 'WAITING') {
      if (job.owner !== owner) throw failure(409, '这个钱包正在其他页面登录，请先完成或取消登录');
      return loginView(job);
    }
    if (busy.has(index)) throw failure(409, '这个钱包正在处理其他操作，请稍后重试');
    busy.add(index);
    previews.clear();
    try {
      const data = await walletCall(index, ['auth', 'signin'], { timeout: 60000 });
      walletCache.delete(index);
      if (data.status === 'ALREADY_CONNECTED') {
        const job = { id: randomBytes(18).toString('hex'), owner, walletIndex: index, status: 'SUCCESS' };
        logins.set(job.id, job); return loginView(job);
      }
      if (!data.qrCodeId || !data.urlForWeb || !data.pairingCode) throw failure(502, '登录响应缺少配对码或链接');
      let url; try { url = new URL(data.urlForWeb); } catch { throw failure(502, '登录链接无效'); }
      if (url.protocol !== 'https:' || !(url.hostname === 'binance.com' || url.hostname.endsWith('.binance.com'))) throw failure(502, '登录链接不属于币安官方域名');
      const controller = new AbortController();
      const job = { id: randomBytes(18).toString('hex'), owner, walletIndex: index, status: 'WAITING', urlForWeb: data.urlForWeb, pairingCode: data.pairingCode, expireAt: data.expireAt, controller };
      logins.set(job.id, job);
      // Keep verify alive in the server until App confirmation, cancellation, or timeout.
      job.promise = deps.runWallet(['auth', 'verify', '--qrCodeId', data.qrCodeId], { walletIndex: index, timeout: 330000, signal: controller.signal }).then(async (result) => {
        if (job.status !== 'WAITING') return;
        if (result.success && result.data?.status === 'SUCCESS') {
          walletCache.delete(index);
          const checked = await walletStatus(index, true);
          if (job.status !== 'WAITING') return;
          job.status = checked.status === 'CONNECTED' ? 'SUCCESS' : 'FAILED';
          if (job.status === 'FAILED') job.error = checked.error || '币安 App 已确认，但本地会话尚未连接，请重新登录';
        } else {
          job.error = result.error?.message || '登录未完成';
          job.status = /expir|timeout|超时|过期/i.test(job.error) ? 'EXPIRED' : 'FAILED';
        }
      }).catch((e) => { if (job.status === 'WAITING') { job.status = 'FAILED'; job.error = e.message; } }).finally(() => busy.delete(index));
      return loginView(job);
    } finally {
      if (![...logins.values()].some((job) => job.walletIndex === index && job.status === 'WAITING')) busy.delete(index);
    }
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
        if (req.method === 'GET' && path === '/api/updates') data = await updateView();
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
          data = { config: deps.saveConfig(input) }; walletCache.clear(); previews.clear();
        } else if (req.method === 'GET' && path === '/api/logs') data = deps.readLogs(url.searchParams.get('limit'), (url.searchParams.get('search') || '').slice(0, 200));
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
                const wallet = await requireConnected(i); assertDevMode(wallet.settings);
                if (wallet.address.toLowerCase() !== config().wallets[i].address.toLowerCase()) throw failure(409, `钱包 ${i + 1} 登录地址与配置不一致，请重新导入地址`);
              }
            }
            data = await deps.controlService(action);
          } finally { serviceBusy = false; }
        } else if (req.method === 'GET' && path === '/api/wallet/status') data = await walletStatus(indexOf(url.searchParams.get('wallet')), url.searchParams.get('refresh') === '1');
        else if (req.method === 'GET' && path === '/api/wallet/balance') {
          const index = indexOf(url.searchParams.get('wallet')); const wallet = await requireConnected(index); assertWalletBinding(index, wallet);
          data = { balances: await walletCall(index, ['wallet', 'balance', '--binanceChainId', '56', '--hideLowValue', 'false']) };
        } else if (req.method === 'POST' && path === '/api/wallet/login') data = await startLogin(indexOf(body.walletIndex), sid);
        else if (/^\/api\/wallet\/login\/[a-f0-9]+(?:\/cancel)?$/.test(path)) {
          const id = path.split('/')[4], job = logins.get(id);
          if (!job || job.owner !== sid) throw failure(404, '登录会话不存在，请重新登录');
          if (req.method === 'POST' && path.endsWith('/cancel')) {
            if (job.status === 'WAITING') { job.status = 'CANCELLED'; job.controller.abort(); await job.promise; }
          } else if (req.method !== 'GET' || path.endsWith('/cancel')) throw failure(405, '不支持的请求方式');
          data = loginView(job);
        } else if (req.method === 'POST' && path === '/api/wallet/import') {
          const index = indexOf(body.walletIndex);
          if (serviceBusy) throw failure(409, '请等待服务操作完成，再导入地址');
          if (busy.size) throw failure(409, '请先完成当前钱包操作，再导入地址');
          busy.add(index);
          try {
            const wallet = await requireConnected(index), next = structuredClone(config());
            next.wallets[index] = { ...next.wallets[index], name: next.wallets[index]?.name || `钱包 ${index + 1}`, address: wallet.address };
            data = { config: deps.saveConfig(next), wallet }; previews.clear(); walletCache.clear();
          } finally { busy.delete(index); }
        } else if (req.method === 'POST' && path === '/api/wallet/logout') {
          const index = indexOf(body.walletIndex);
          if (serviceBusy) throw failure(409, '请等待服务操作完成，再退出钱包');
          if (body.confirmed !== true) throw failure(409, '请确认退出登录');
          if (busy.has(index)) throw failure(409, '请先完成或取消当前钱包操作');
          busy.add(index);
          try {
            const liveStatus = await deps.dashboardStatus();
            if (liveStatus.service.running && (liveStatus.mode === 'auto' || !config().monitorOnly)) throw failure(409, '请先停止自动交易，再退出钱包');
            data = await walletCall(index, ['auth', 'signout']); walletCache.delete(index); previews.clear();
          } finally { busy.delete(index); }
        } else if (req.method === 'POST' && path === '/api/contract/preview') {
          const index = indexOf(body.walletIndex);
          if (serviceBusy) throw failure(409, '请等待服务操作完成，再预演交易');
          if (!addressPattern.test(body.to || '')) throw failure(400, '目标合约地址无效');
          const inputData = body.inputData || '0x';
          if (!/^0x(?:[a-fA-F0-9]{2})*$/.test(inputData) || inputData.length > 32770) throw failure(400, '调用数据必须为 0x 开头的完整十六进制字节');
          const value = toWei(body.value);
          if (busy.has(index)) throw failure(409, '钱包正在处理其他操作');
          busy.add(index);
          try {
            const wallet = await requireConnected(index); assertWalletBinding(index, wallet); assertDevMode(wallet.settings);
            const result = await walletCall(index, ['contract-call', 'preview', '--binanceChainId', '56', '--from', wallet.address, '--to', body.to, '--value', value, '--inputData', inputData], { timeout: 180000 });
            if (!result.requestId) throw failure(502, '预演未返回可执行的 requestId');
            const expiresAt = Math.min(expiryTime(result.expiresAt) || Date.now() + 300000, Date.now() + 300000);
            const id = randomBytes(24).toString('hex');
            previews.set(id, { owner: sid, walletIndex: index, address: wallet.address, requestId: result.requestId, expiresAt });
            data = { ...result, id, expiresAt, authorityChanges: result.simulationResult?.authorityChanges || [] };
          } finally { busy.delete(index); }
        } else if (req.method === 'POST' && path === '/api/contract/execute') {
          if (serviceBusy) throw failure(409, '请等待服务操作完成，再执行交易');
          const preview = previews.get(body.id);
          if (!preview || preview.owner !== sid || preview.expiresAt <= Date.now()) throw failure(409, '预演已过期或不存在，请重新预演');
          if (body.confirmed !== true) throw failure(409, '请先阅读预演结果并明确确认执行');
          if (busy.has(preview.walletIndex)) throw failure(409, '钱包正在处理其他操作');
          busy.add(preview.walletIndex);
          // Consume before invoking the CLI: a retry cannot broadcast the same preview twice.
          previews.delete(body.id);
          try {
            const wallet = await requireConnected(preview.walletIndex); assertWalletBinding(preview.walletIndex, wallet); assertDevMode(wallet.settings);
            if (wallet.address !== preview.address) throw failure(409, '登录钱包已改变，请重新预演');
            if (preview.expiresAt <= Date.now()) throw failure(409, '预演已过期，请重新预演');
            data = await walletCall(preview.walletIndex, ['contract-call', 'execute', '--requestId', preview.requestId], { timeout: 180000 });
          } finally { busy.delete(preview.walletIndex); walletCache.delete(preview.walletIndex); }
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
      send(error.status || 500, { ok: false, error: { message: error.status ? error.message : '服务处理失败，请检查本地配置或重试', details: error.details || error.errors } });
    }
  });
  server.on('close', () => { clearInterval(clean); clearInterval(restartPoll); nftTrading?.stop?.(); localUpdater?.stop?.(); for (const job of logins.values()) job.controller?.abort(); });
  if (overrides.startNftWorker === true) getNftTrading().start();
  if (overrides.startUpdateChecker === true) server.once('listening', () => getUpdater().start());
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || 4317);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT 必须介于 1024 与 65535');
  const server = createApp({ startNftWorker: true, startUpdateChecker: true });
  server.listen(port, '127.0.0.1', () => console.log(`Agent ID Sniper 控制台：http://127.0.0.1:${port}`));
  server.on('error', (e) => { console.error(e.code === 'EADDRINUSE' ? `端口 ${port} 已占用` : e.message); process.exitCode = 1; });
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(() => process.exit(0)));
}
