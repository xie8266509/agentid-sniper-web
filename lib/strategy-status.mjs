import { getRuleConfig } from './config.mjs';
import { FREE_SELL_MIN_USD, FREE_PEAK_DELAY_MS, isStepStrategy } from './sell-rules.mjs';

export function positionState(state, token, wallet, index, allTokens) {
  const key = `${wallet.address.toLowerCase()}:${token.addr.toLowerCase()}`;
  if (state.tokens?.[key]) return state.tokens[key];
  // A symbol alone cannot identify two contracts. Never borrow that state.
  const sameSymbol = new Set(allTokens.filter(t => t.sym === token.sym).map(t => t.addr.toLowerCase()));
  if (sameSymbol.size !== 1) return {};
  const legacy = state.tokens?.[index === 0 ? token.sym : `${wallet.name}:${token.sym}`];
  if (legacy?.addr && legacy.addr.toLowerCase() !== token.addr.toLowerCase()) return {};
  if (legacy?.walletAddress && legacy.walletAddress.toLowerCase() !== wallet.address.toLowerCase()) return {};
  return legacy || {};
}

export function buildStrategyStatus(state, config, positions, { running = false, needsRestart = false, now = Date.now() } = {}) {
  const mode = running ? state.runtimeMode || (config.monitorOnly ? 'monitor' : 'auto') : config.monitorOnly ? 'monitor' : 'auto';
  const rules = state.effectiveRules || null;
  const tokens = positions.map(({ token, wallet, st }) => {
    let reason = st.reason || '等待下一次持仓检查', eligible = st.eligibility === 'ready', nextTrigger = null;
    if (!running) { reason = '监控已停止'; eligible = false; nextTrigger = '启动监控后重新检查'; }
    else if (mode === 'monitor') { reason = '当前为只读监控，不自动卖出'; eligible = false; }
    else if (st.submissionIntent || st.sellReviewRequired) { reason = st.reason || '上笔卖出需核对结果，已阻止自动重发'; eligible = false; nextTrigger = '核对钱包订单后处理'; }
    else if (st.pendingSell) { reason = '卖单已提交，等待成交与余额确认'; eligible = false; nextTrigger = `订单 ${st.pendingSell.orderId}`; }
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
    return { addr: token.addr, walletAddress: wallet.address, stage: st.stage ?? 0, done: Boolean(st.done), hold: Boolean(token.hold), eligible, reason, nextTrigger };
  });
  return { mode, scannerRunning: running, needsRestart: Boolean(needsRestart), checkedAt: state.holdingsUpdatedAt || null, configuredRules: getRuleConfig(config), effectiveRules: running ? rules : null, scope: { erc20: true, nft: false }, tokens };
}
