import { getRuleConfig } from './config.mjs';
import { FREE_SELL_MIN_USD, FREE_PEAK_DELAY_MS, isStepStrategy } from './sell-rules.mjs';
import { normalizeWalletConfig, getWalletId, effectiveWalletConfig, walletCanAutomate } from './wallet-model.mjs';
import { publicWalletAvailability } from './wallet-readiness.mjs';

function currentStrategyWorker(state, workerPid, now) {
  const worker = state.strategyRuntime;
  return Boolean(worker && typeof worker.runId === 'string' && worker.runId && Number.isSafeInteger(worker.pid) && worker.pid > 1 && Number.isFinite(worker.startedAt) && worker.startedAt > 0 && worker.startedAt <= now && state.configLoadedAt === worker.startedAt && (workerPid === undefined || workerPid === worker.pid));
}
function walletRuleStatus(state, config, wallet, { running, workerPid, now, mode }) {
  const configuredRules = getRuleConfig(effectiveWalletConfig(config, wallet)), strict = workerPid !== undefined || Boolean(state.strategyRuntime || state.walletRuleReports);
  const row = { walletId: wallet.id, walletAddress: wallet.address, name: wallet.name, mode: config.monitorOnly || mode === 'monitor' ? 'monitor' : wallet.mode, paused: wallet.paused, archived: wallet.archived, configuredRules, effectiveRules: null, reportStatus: 'waiting', reason: '等待当前监控进程上报此钱包的规则', rulesCheckedAt: null, trackedERC20: null };
  const status = (reportStatus, reason) => Object.assign(row, { reportStatus, reason });
  if (!running) return status('stopped', '监控已停止；启动后由持仓检查重新上报规则');
  if (wallet.draft || !wallet.address) return status('unbound', '钱包尚未绑定地址，不执行自动操作');
  const currentWorker = currentStrategyWorker(state, workerPid, now), report = state.walletRuleReports?.[wallet.id];
  if (strict && !currentWorker) status('stale', '等待当前监控进程上报规则；旧进程快照不作为当前状态');
  else if (strict && report) {
    const worker = state.strategyRuntime;
    const binding = [wallet.bawDir, wallet.instanceId, wallet.agentId, wallet.agentIdVerified, wallet.legacyNames];
    if (report.walletId !== wallet.id || report.walletAddress?.toLowerCase() !== wallet.address.toLowerCase() || JSON.stringify(report.binding) !== JSON.stringify(binding)) status('identity-changed', '钱包身份或绑定已改变，等待对应进程重新核验和上报');
    else if (report.runId !== worker.runId || report.runStartedAt !== worker.startedAt || !Number.isFinite(report.checkedAt) || report.checkedAt < worker.startedAt || report.checkedAt > now) status('stale', '当前钱包尚无本次监控进程的有效规则报告');
    else {
      row.rulesCheckedAt = report.checkedAt;
      row.trackedERC20 = Number.isSafeInteger(report.trackedERC20) && report.trackedERC20 >= 0 ? report.trackedERC20 : null;
      try {
        const rules = getRuleConfig({ rules: report.rules });
        if (!report.rules || JSON.stringify(rules) !== JSON.stringify(configuredRules)) status('config-changed', '已保存的规则已改变，等待持仓检查重新载入并上报');
        else { row.effectiveRules = rules; status('loaded', '规则已由当前监控进程载入；仅在条件满足时执行'); }
      } catch { status('stale', '当前规则报告无效，等待持仓检查重新上报'); }
    }
  } else if (!strict) row.effectiveRules = state.effectiveWalletRules?.[wallet.id] || null;
  const unloaded = row.effectiveRules ? '' : '；尚无匹配当前配置的规则报告';
  if (wallet.archived) return status('archived', '钱包已归档，不执行新自动操作' + unloaded);
  if (wallet.paused) return status('paused', '钱包已暂停新自动操作，已提交订单继续核对' + unloaded);
  if (row.mode === 'monitor') return status('monitor', '此钱包当前只监控，不自动卖出' + unloaded);
  if (wallet.autoSellTokens === false) return status('disabled', '此钱包未开启代币自动卖出' + unloaded);
  if (!row.effectiveRules) return row;
  if (strict) {
    const evidence = state.walletRuntime?.[wallet.id]?.availability;
    const availability = evidence?.walletId === wallet.id && evidence.address?.toLowerCase() === wallet.address.toLowerCase() && evidence.checkedAt >= state.strategyRuntime.startedAt ? publicWalletAvailability(evidence, { now }) : null;
    if (!availability) return status('waiting', '规则已载入，等待钱包连接与权限核验' + (row.trackedERC20 === 0 ? '；暂无追踪 ERC20' : ''));
    if (!availability.ready) return status(availability.code === 'OFFLINE' ? 'offline' : 'unavailable', availability.reason + (row.trackedERC20 === 0 ? '；暂无追踪 ERC20' : ''));
  }
  return row.trackedERC20 === 0 ? status('no-erc20', '规则已载入，暂无追踪 ERC20；NFT 规则在持仓页单独配置') : status('loaded', '规则已由当前监控进程载入；仅在条件满足时执行');
}

export function positionState(state, token, wallet, index, allTokens) {
  const key = `${wallet.address.toLowerCase()}:${token.addr.toLowerCase()}`;
  if (state.tokens?.[key]) return state.tokens[key];
  // A symbol alone cannot identify two contracts. Never borrow that state.
  const sameSymbol = new Set(allTokens.filter(t => t.sym === token.sym).map(t => t.addr.toLowerCase()));
  if (sameSymbol.size !== 1) return {};
  const aliases = wallet.legacyNames ?? [wallet.name];
  const primary = token.costWalletAddress ? token.costWalletAddress.toLowerCase() === wallet.address.toLowerCase() : state.costWalletAddress ? state.costWalletAddress.toLowerCase() === wallet.address.toLowerCase() : index === 0;
  const candidates = (primary ? [token.sym] : aliases.map(alias => `${alias}:${token.sym}`)).map(key => state.tokens?.[key]).filter(legacy => legacy && (!legacy.addr || legacy.addr.toLowerCase() === token.addr.toLowerCase()) && (!legacy.walletAddress || legacy.walletAddress.toLowerCase() === wallet.address.toLowerCase()));
  if (new Set(candidates.map(value => JSON.stringify(value))).size > 1) return {};
  return candidates[0] || {};
}

export function buildStrategyStatus(state, config, positions, { running = false, needsRestart = false, workerPid, now = Date.now() } = {}) {
  config = normalizeWalletConfig(config);
  const mode = running ? state.runtimeMode || (config.monitorOnly ? 'monitor' : 'auto') : config.monitorOnly ? 'monitor' : 'auto';
  const wallets = (config.wallets || []).map(wallet => walletRuleStatus(state, config, wallet, { running, workerPid, now, mode }));
  const tokens = positions.map(({ token, wallet, st }) => {
    const configuredWallet = config.wallets?.find(entry => entry.address?.toLowerCase() === wallet.address?.toLowerCase());
    wallet = configuredWallet || wallet;
    const report = configuredWallet && wallets.find(row => row.walletId === getWalletId(wallet));
    const rules = report ? report.effectiveRules : state.effectiveWalletRules?.[getWalletId(wallet)] || (!state.effectiveWalletRules ? state.effectiveRules : null) || null;
    let reason = st.reason || '等待下一次持仓检查', eligible = st.eligibility === 'ready', nextTrigger = null;
    if (!running) { reason = '监控已停止'; eligible = false; nextTrigger = '启动监控后重新检查'; }
    else if (mode === 'monitor') { reason = '当前为只读监控，不自动卖出'; eligible = false; }
    else if (wallet.archived) { reason = '钱包已归档，不自动卖出'; eligible = false; }
    else if (wallet.paused) { reason = '此钱包已暂停新交易，已有订单继续核对'; eligible = false; }
    else if (configuredWallet && !walletCanAutomate(config, wallet, 'token-sell')) { reason = '此钱包未开启代币自动卖出'; eligible = false; }
    else if (st.submissionIntent || st.sellReviewRequired) { reason = st.reason || '上笔卖出需核对结果，已阻止自动重发'; eligible = false; nextTrigger = '核对钱包订单后处理'; }
    else if (st.pendingSell) { reason = '卖单已提交，等待成交与余额确认'; eligible = false; nextTrigger = `订单 ${st.pendingSell.orderId}`; }
    else if (report && !['loaded', 'no-erc20'].includes(report.reportStatus)) { reason = report.reason; eligible = false; }
    else if (token.costUnknown || st.eligibility === 'unknown-cost') { reason = '已有付款凭证，成本价格待核验；暂不自动卖出'; eligible = false; nextTrigger = '核验实际付款与 BNB 价格后恢复付费持仓规则'; }
    else if (token.hold) { reason = '此代币设置为仅持有'; eligible = false; }
    else if (st.done || st.stage >= 9) { reason = '此轮卖出已结束'; eligible = false; }
    else if (st.moonOnly && rules && isStepStrategy(rules)) { reason = '仅剩回本后保留的长抱仓位，不自动卖出'; eligible = false; nextTrigger = `到 ${(rules.moonNotifyX || []).join(' / ') || '未配置'} 倍仅通知`; }
    else if (!(token.cost > 0)) {
      const value = st.last?.v;
      if (typeof value !== 'number' || !Number.isFinite(value)) { reason = st.reason || '暂无有效持仓估值'; eligible = false; }
      else if (value < FREE_SELL_MIN_USD) { reason = `当前估值 $${value.toFixed(4)}，低于免费币卖出门槛 $0.30`; eligible = false; }
      else if (!st.openAt || now - st.openAt < FREE_PEAK_DELAY_MS) { reason = '等待开池满 3 分钟后采样峰值'; eligible = false; }
      else if (st.freeFail >= 3) { reason = '连续卖出失败已达 3 次，需检查订单与钱包'; eligible = false; }
      else if (st.freeFailAt && now - st.freeFailAt <= 600000) { reason = '卖出失败后的 10 分钟冷却中'; eligible = false; }
      if (rules) nextTrigger = `估值至少 $0.30，且从开池 3 分钟后采样峰值回撤 ${Math.round(rules.drop * 100)}%，连续两次有效采样确认`;
    } else if (rules) {
      const completed = st.done2 || [];
      const modern = isStepStrategy(rules), back = completed.includes('back');
      const targets = [!back && `${rules.backX} 倍回本`, ...(modern ? rules.steps || [] : (rules.halfX || []).map(x => [x, 50])).filter(([x]) => !completed.includes('s' + x) && !completed.includes('h' + x)).map(([x, percent]) => `${x} 倍卖可卖仓位 ${percent}%`)].filter(Boolean);
      const fast = !modern && st.openAt && now - st.openAt < rules.fastMin * 60000;
      const ratio = modern && back ? (rules.crashAfterBack ?? rules.crash) : fast ? rules.fastCrash : rules.crash;
      targets.push(`峰值回撤 ${Math.round(ratio * 100)}%，连续两次确认后卖出${modern && back && st.moon ? '长抱以外的部分' : '全部'}`);
      if (!modern && !back && rules.noPumpMin > 0 && rules.noPumpX > 0) targets.push(`${rules.noPumpMin} 分钟未达 ${rules.noPumpX} 倍清仓`);
      if (modern && rules.moonPct > 0) targets.push(`回本成交后保留剩余仓位 ${rules.moonPct}% 长抱`);
      nextTrigger = targets.join('；');
    }
    return { addr: token.addr, walletId: getWalletId(wallet), walletAddress: wallet.address, stage: st.stage ?? 0, done: Boolean(st.done), hold: Boolean(token.hold), eligible, reason, nextTrigger };
  });
  const strict = workerPid !== undefined || Boolean(state.strategyRuntime || state.walletRuleReports);
  return { mode, scannerRunning: running, needsRestart: Boolean(needsRestart), checkedAt: state.holdingsUpdatedAt || null, configuredRules: getRuleConfig(config), effectiveRules: running && (!strict || currentStrategyWorker(state, workerPid, now)) ? state.effectiveRules || null : null, wallets, scope: { erc20: true, nft: false }, tokens };
}
