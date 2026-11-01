import { execFile } from 'node:child_process';
import { openSync, closeSync, readSync, statSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { readConfig } from './config.mjs';
import { createNftInventory } from './nft-holdings.mjs';
import { createNftMarket } from './nft-market.mjs';
import { buildStrategyStatus, positionState } from './strategy-status.mjs';
import { readAppReleaseInfo } from './release-info.mjs';
import { normalizeWalletConfig, getWalletId, effectiveWalletConfig } from './wallet-model.mjs';

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DATA = join(ROOT, 'data'), exec = promisify(execFile);
let lastState = {};
let nftInventory;
let nftMarket;
let releasePromise;
async function releaseInfo() {
  releasePromise ||= exec('git', ['rev-parse', 'HEAD'], { cwd: ROOT, timeout: 3000 }).then(({ stdout }) => {
    const info = readAppReleaseInfo(ROOT, { commit: stdout.trim() });
    return { ...info, commit: info.commit?.slice(0, 7) || null };
  }).catch(() => readAppReleaseInfo(ROOT));
  return releasePromise;
}
export function readState() {
  try { lastState = JSON.parse(readFileSync(join(DATA, 'watch_state.json'), 'utf8')); } catch {}
  return lastState;
}
export function redact(value, secrets = []) {
  if (typeof value === 'string') {
    for (const secret of secrets.filter(Boolean)) value = value.split(secret).join('[已隐藏]');
    return value.replace(/(https:\/\/api\.telegram\.org\/bot)[^/\s]+/g, '$1[已隐藏]')
      .replace(/((?:clientId|sessionId|agentSessionId|sessionToken|accessToken|refreshToken|botToken|apiKey|privateKey|seedPhrase|mnemonic|password|secret|authorization|cookie)["']?\s*[:=]\s*["']?)[^\s,"'};]+/gi, '$1[已隐藏]')
      .replace(/\bBearer\s+[^\s,;"']+/gi, 'Bearer [已隐藏]');
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([k]) => !/^(clientId|sessionId|agentSessionId|sessionToken|accessToken|refreshToken|apiKey|privateKey|seedPhrase|mnemonic|password|secret|authorization|cookie)$/i.test(k.replace(/[-_\s]/g, ''))).map(([k, v]) => [k, redact(v, secrets)]));
  return value;
}
function logTail() {
  let lines = [];
  const path = join(DATA, 'watch.log');
  try {
    const size = statSync(path).size, length = Math.min(size, 2 * 1024 * 1024), buffer = Buffer.alloc(length);
    const fd = openSync(path, 'r');
    try { readSync(fd, buffer, 0, length, size - length); } finally { closeSync(fd); }
    lines = buffer.toString('utf8').split('\n').filter(Boolean);
    if (size > length) lines.shift();
  } catch {}
  return lines;
}
export function readLogs(limit = 150, search = '') {
  let lines = logTail();
  if (search) lines = lines.filter((line) => line.toLowerCase().includes(search.toLowerCase()));
  return { lines: redact(lines.slice(-Math.max(1, Math.min(500, Number(limit) || 150))), [readConfig().telegram?.botToken, process.env.TG_BOT_TOKEN]), updatedAt: new Date().toISOString() };
}
function configNeedsRestart(state, config, running) {
  if (!running) return false;
  let changed = false;
  try { changed = Boolean(state.configLoadedAt && statSync(join(ROOT, 'config.json')).mtimeMs > state.configLoadedAt); } catch {}
  return changed || Boolean(state.runtimeMode && state.runtimeMode !== (config.monitorOnly ? 'monitor' : 'auto'));
}
export async function serviceInfo() {
  let pid = null, workerPid = null;
  try {
    const stored = JSON.parse(readFileSync(join(DATA, 'local_service.json'), 'utf8'));
    if (Number.isSafeInteger(stored.pid) && stored.pid > 1) {
      process.kill(stored.pid, 0);
      const result = await exec('/bin/ps', ['-p', String(stored.pid), '-o', 'command='], { timeout: 3000 });
      if (result.stdout.includes(join(ROOT, 'local-service.mjs') + ' run')) pid = stored.pid;
      if (pid) {
        try { workerPid = Number((await exec('/usr/bin/pgrep', ['-P', String(pid)], { timeout: 3000 })).stdout.trim().split('\n')[0]) || null; } catch {}
      }
    }
  } catch {}
  const heart = join(DATA, 'watch_heartbeat.txt');
  return {
    running: Boolean(pid), pid, workerPid,
    heartbeat: existsSync(heart) ? readFileSync(heart, 'utf8').trim() : null,
    heartbeatAgeSec: existsSync(heart) ? Math.round((Date.now() - statSync(heart).mtimeMs) / 1000) : null,
  };
}
export async function controlService(action) {
  if (!['start', 'stop', 'restart'].includes(action)) throw new Error('无效的服务操作');
  if (action === 'restart') await exec(process.execPath, [join(ROOT, 'local-service.mjs'), 'stop'], { cwd: ROOT, timeout: 15000 });
  const { stdout } = await exec(process.execPath, [join(ROOT, 'local-service.mjs'), action === 'restart' ? 'start' : action], { cwd: ROOT, timeout: 15000 });
  return { ...(await serviceInfo()), message: stdout.trim() };
}
export async function dashboardStatus() {
  const state = readState(), config = normalizeWalletConfig(readConfig()), service = await serviceInfo();
  const policy = state.mintPolicy;
  const mintPolicy = policy?.version === '2.7.4' && Number.isFinite(policy.goPct) && policy.goPct >= 0.6 && policy.goPct <= 0.7 && Number.isInteger(policy.minAgents) && policy.minAgents >= 100 && policy.minAgents <= 130
    ? { version: policy.version, goPct: policy.goPct, minAgents: policy.minAgents, nftGoPct: Math.max(0.7, policy.goPct), nftMinAgents: 150, freeMode: 'notify-only', participants: 'transaction-senders' } : null;
  const discoveries = readLogs(500).lines.filter((l) => /發現|发现/.test(l));
  const seen = new Set(), recentProjects = [];
  for (const line of discoveries.reverse()) {
    const address = line.match(/0x[a-fA-F0-9]{40}/)?.[0];
    if (!address || seen.has(address)) continue;
    seen.add(address);
    recentProjects.push({ address, name: line.match(/(?:項目|项目|合約|合约)[：:]([^（|\n]+)/)?.[1]?.trim() || 'Agent ID 合约', at: line.match(/^\[([^\]]+)\]/)?.[1] || '', source: /被鑄造|被铸造/.test(line) ? '铸造事件' : /搶打|抢打/.test(line) ? '活跃钱包' : '新区块' });
    if (recentProjects.length >= 12) break;
  }
  const desiredMode = config.monitorOnly ? 'monitor' : 'auto';
  return {
    release: await releaseInfo(),
    service: { ...service, needsRestart: configNeedsRestart(state, config, service.running) },
    mode: service.running ? state.runtimeMode || desiredMode : desiredMode, configuredMode: desiredMode,
    scan: { lastBlock: state.lastBlock || 0, head: state.chainHead || null, lag: state.scanLag ?? null, seenCount: Object.keys(state.seenMints || {}).length, updatedAt: state.scanUpdatedAt || null, loopDurationMs: state.loopDurationMs || null, mintPolicy },
    stats: { trackedTokens: (config.tokens || []).length + (state.dyn || []).length + Object.keys(state.nftCols || {}).length, trackedERC20: (config.tokens || []).length + (state.dyn || []).length, trackedNFTCollections: Object.keys(state.nftCols || {}).length, tradeCount: (state.trades || []).length },
    recentProjects,
    wallets: config.wallets.map(wallet => ({ id: wallet.id, name: wallet.name, address: wallet.address, mode: wallet.mode, paused: wallet.paused, archived: wallet.archived })),
  };
}
export async function holdingsData({ force = false } = {}) {
  const state = readState(), config = normalizeWalletConfig(readConfig());
  const costWalletAddress = state.costWalletAddress || config.wallets.find(wallet => wallet.address && !wallet.draft)?.address;
  const allTokens = (config.tokens || []).concat(state.dyn || []), positions = [];
  const tokens = allTokens.flatMap((t) => {
    const wallets = config.wallets.map((w, index) => ({ ...w, index })).filter(w => w.address && !w.draft).filter((w) => !t.only || w.address.toLowerCase() === t.only.toLowerCase());
    if (!wallets.length) return [{ ...t, wallet: '未配置钱包', quantity: null, value: null }];
    return wallets.map((w) => {
      const st = positionState(state, t, w, w.index, allTokens);
      const token = { ...t, cost: w.address.toLowerCase() === (t.costWalletAddress || costWalletAddress)?.toLowerCase() || t.only || t.both ? t.cost : 0 };
      positions.push({ token, wallet: w, st });
      return { ...token, costUnknown: Boolean(token.costUnknown || st.eligibility === 'unknown-cost'), walletId: w.id, wallet: w.name, walletAddress: w.address, quantity: st.lastBal ?? null, value: st.last?.v ?? null, peak: st.pricePeak ?? st.peak ?? null, done: Boolean(st.done), stage: st.stage ?? 0 };
    });
  });
  let nftData = { nfts: [], nftSync: { loading: false, updatedAt: null, total: 0, verified: 0, errors: 0 } };
  if (Object.keys(state.nftCols || {}).length && config.wallets?.length) {
    nftInventory ||= createNftInventory({ cacheFile: join(DATA, 'nft_holdings_cache.json'), logLines: () => logTail().filter(line => /已自動鑄造|已自动铸造/.test(line)) });
    nftData = nftInventory.snapshot({ state, config: { ...config, wallets: config.wallets.filter(wallet => wallet.address && !wallet.draft) }, force });
  }
  nftMarket ||= createNftMarket({ cacheFile: join(DATA, 'nft_market_cache.json') });
  const { markets, marketSync } = nftMarket.snapshot(nftData.nfts, { force });
  const walletIdFor = address => config.wallets.find(wallet => wallet.address?.toLowerCase() === address?.toLowerCase())?.id || null;
  const nfts = nftData.nfts.map(nft => ({ ...nft, walletId: walletIdFor(nft.walletAddress), market: { ...markets[nft.addr], sellUrl: nft.status === 'held' && typeof nft.ownedTokenId === 'string' && /^\d+$/.test(nft.ownedTokenId) ? `https://element.market/assets/bsc/${nft.addr}/${nft.ownedTokenId}` : null } }));
  const service = await serviceInfo();
  return { tokens, trades: (state.trades || []).slice(-100).reverse().map(trade => ({ ...trade, walletId: trade.walletId || walletIdFor(trade.walletAddress) })), ...nftData, nfts, marketSync, strategy: buildStrategyStatus(state, config, positions, { running: service.running, needsRestart: configNeedsRestart(state, config, service.running) }) };
}
