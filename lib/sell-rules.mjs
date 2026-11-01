// Pure ERC20 position/sell helpers. NFT listing and NFT prices are outside these
// rules; a separate inventory view does not enable automated NFT sales.
import { decodeAbiUint } from './nft-codec.mjs';
export const FREE_SELL_MIN_USD = 0.3;
export const FREE_PEAK_DELAY_MS = 180000;
const MAX_UINT = (1n << 256n) - 1n;
const finite = (value) => typeof value === 'number' && Number.isFinite(value);

export function positionStateKey(walletAddress, tokenAddress) {
  for (const address of [walletAddress, tokenAddress]) if (typeof address !== 'string' || !/^0x[0-9a-f]{40}$/i.test(address)) throw new Error('Invalid position address');
  return `${walletAddress.toLowerCase()}:${tokenAddress.toLowerCase()}`;
}

export function formatTokenAmount(amount, decimals) {
  if (typeof amount !== 'bigint' || amount < 0n || amount > MAX_UINT || !Number.isInteger(decimals) || decimals < 0 || decimals > 255) throw new Error('Invalid token amount or decimals');
  if (decimals === 0) return amount.toString();
  const digits = amount.toString().padStart(decimals + 1, '0'), fraction = digits.slice(-decimals).replace(/0+$/, '');
  return digits.slice(0, -decimals) + (fraction ? '.' + fraction : '');
}

export function parseTokenAmount(amount, decimals) {
  if (typeof amount !== 'string' || amount.length > 400 || !Number.isInteger(decimals) || decimals < 0 || decimals > 255 || !/^\d+(?:\.\d+)?$/.test(amount)) return null;
  const [integer, rawFraction = ''] = amount.split('.'), fraction = rawFraction.replace(/0+$/, '');
  if (fraction.length > decimals) return null;
  const value = BigInt(integer + fraction.padEnd(decimals, '0'));
  return value <= MAX_UINT ? value : null;
}

/** Normalize USD value to the initial token quantity, so selling half does not
 * itself look like a 50% price crash or move the next take-profit threshold. */
export function normalizedPositionValue(value, balance, referenceBalance) {
  if (!finite(value) || value < 0 || typeof balance !== 'bigint' || balance <= 0n || typeof referenceBalance !== 'bigint' || referenceBalance <= 0n) return null;
  const result = value * (Number(referenceBalance) / Number(balance));
  return finite(result) && result >= 0 ? result : null;
}

function numberFraction(value) {
  const [coefficient, exponentText = '0'] = value.toString().toLowerCase().split('e');
  const [integer, fraction = ''] = coefficient.split('.');
  const exponent = Number(exponentText) - fraction.length;
  const numerator = BigInt(integer + fraction);
  return exponent >= 0 ? [numerator * 10n ** BigInt(exponent), 1n] : [numerator, 10n ** BigInt(-exponent)];
}
export function recoverySellAmount(balance, costUsd, valueUsd) {
  if (typeof balance !== 'bigint' || balance <= 0n || !finite(costUsd) || costUsd <= 0 || !finite(valueUsd) || valueUsd <= 0) return 0n;
  const [costN, costD] = numberFraction(costUsd), [valueN, valueD] = numberFraction(valueUsd);
  const numerator = balance * costN * valueD * 103n, denominator = costD * valueN * 100n;
  const amount = (numerator + denominator - 1n) / denominator;
  return amount < balance ? amount : balance;
}

function dropped(value, peak, ratio) {
  if (!finite(peak) || peak <= 0 || !finite(ratio) || ratio < 0 || ratio > 1) return false;
  return ratio === 0 ? value < peak : value <= peak * (1 - ratio);
}

export const isStepStrategy = (rules = {}) => rules.strategy ? rules.strategy === 'steps' : Array.isArray(rules.steps);

function drawdownRule({ token, state, now, rules }) {
  const free = !(token.cost > 0), modern = isStepStrategy(rules), back = (state.done2 || []).includes('back');
  const fast = !free && !modern && state.openAt && now - state.openAt < rules.fastMin * 60000;
  const ratio = free ? rules.drop : modern && back ? (rules.crashAfterBack ?? rules.crash) : fast ? rules.fastCrash : rules.crash;
  return { free, fast, ratio, peak: free ? state.freePricePeak : state.pricePeak };
}

/** Record only a fresh valid price observation. Planning and submitting orders
 * do not count as new samples, and restarting cannot manufacture a second hit. */
export function samplePositionDrawdown({ token, state, value, referenceValue, now, rules }) {
  if (!finite(value) || value < 0 || !finite(referenceValue) || referenceValue < 0 || !finite(now) || now <= (state.drawdownSampleAt || 0)) return {};
  const { free, fast, ratio, peak } = drawdownRule({ token, state, now, rules });
  const key = `${free ? 'free' : 'paid'}:${isStepStrategy(rules) ? 'steps' : 'legacy'}:${ratio}:${fast ? 'fast' : 'normal'}`;
  const valid = !free || (state.openAt && now - state.openAt >= FREE_PEAK_DELAY_MS && value >= FREE_SELL_MIN_USD);
  const hit = valid && dropped(referenceValue, peak, ratio);
  return { drawdownSampleAt: now, drawdownRule: key, drawdownHits: hit ? (state.drawdownRule === key ? state.drawdownHits || 0 : 0) + 1 : 0 };
}

function reservedMoon(state, balance) {
  if (!(state.done2 || []).includes('back') || !state.moon) return 0n;
  if (typeof state.moon !== 'string' || !/^\d+$/.test(state.moon)) return null;
  const amount = BigInt(state.moon);
  return amount > balance ? balance : amount;
}

/** Return at most one action; this never changes a position or marks a trade. */
export function planPositionSell({ token, state, balance, value, referenceValue, now, rules, monitorOnly = false }) {
  if (monitorOnly || typeof balance !== 'bigint' || balance <= 0n || !finite(value) || value < 0 || !finite(referenceValue) || referenceValue < 0 || !finite(now)) return null;
  if (state.stage >= 9 || state.done || state.pendingSell || state.submissionIntent || state.sellReviewRequired) return null;
  const full = (id, reason) => ({ id, amount: balance, full: true, reason });
  if (token.sellNow && !state.sellNowDone) return full('sellNow', '你指示全部卖出');
  if (token.hold) return null;
  const cost = finite(token.cost) && token.cost > 0 ? token.cost : 0;
  if (!cost) {
    if (!state.openAt || now - state.openAt < FREE_PEAK_DELAY_MS || !dropped(referenceValue, state.freePricePeak, rules.drop) || state.drawdownHits < 2 || !Number.isInteger(state.drawdownHits) || value < FREE_SELL_MIN_USD || (state.freeFail || 0) >= 3 || now - (state.freeFailAt || 0) <= 600000) return null;
    return full('freeDrop', `免费币从最高点回落 ${Math.round(rules.drop * 100)}%，全部卖出`);
  }
  const completed = Array.isArray(state.done2) ? state.done2 : [];
  const age = state.openAt ? Math.max(0, now - state.openAt) : null;
  const modern = isStepStrategy(rules), { fast, ratio: crash } = drawdownRule({ token, state, now, rules });
  const moon = modern ? reservedMoon(state, balance) : 0n;
  if (moon === null) return null;
  const available = balance - moon;
  if (available <= 0n) return null;
  if (dropped(referenceValue, state.pricePeak, crash)) {
    // Do not allow take-profit steps to bypass the first drawdown sample.
    if (!Number.isInteger(state.drawdownHits) || state.drawdownHits < 2) return null;
    return { id: 'crash', amount: available, full: available === balance, moonOnlyAfter: moon > 0n, reason: `${fast ? '速战模式：' : ''}从最高点回落 ${Math.round(crash * 100)}%，连续两次确认，${moon > 0n ? '卖出长抱以外的仓位' : '全部卖出'}` };
  }
  if (!modern && rules.noPumpMin > 0 && rules.noPumpX > 0 && age !== null && age >= rules.noPumpMin * 60000 && state.pricePeak < cost * rules.noPumpX && !completed.includes('back')) return full('noPump', `开池 ${rules.noPumpMin} 分钟还没到 ${rules.noPumpX} 倍，全部卖出`);
  if (!completed.includes('back') && referenceValue >= cost * rules.backX && value > 0) {
    const amount = recoverySellAmount(balance, cost, value);
    const reserve = modern && rules.moonPct > 0 ? ((balance - amount) * BigInt(rules.moonPct)) / 100n : 0n;
    return amount > 0n ? { id: 'back', amount, full: amount === balance, moonReserveUnits: reserve.toString(), reason: `到 ${rules.backX} 倍，按当前报价卖出收回本金约 ${cost}U` } : null;
  }
  if (modern) {
    for (const [multiple, percent] of rules.steps || []) {
      const id = 's' + multiple;
      if (completed.includes(id) || completed.includes('h' + multiple) || referenceValue < cost * multiple) continue;
      const amount = (available * BigInt(percent)) / 100n;
      if (amount > 0n) return { id, amount, full: amount === balance, moonOnlyAfter: moon > 0n && amount === available, reason: `到 ${multiple} 倍，卖出可卖仓位的 ${percent}%${moon > 0n ? '，保留长抱仓位' : ''}` };
    }
    return null;
  }
  for (const multiple of rules.halfX || []) {
    const id = 'h' + multiple;
    if (!completed.includes(id) && !completed.includes('s' + multiple) && referenceValue >= cost * multiple && balance / 2n > 0n) return { id, amount: balance / 2n, full: false, reason: `到 ${multiple} 倍，卖出剩余仓位一半` };
  }
  return null;
}

export function applyConfirmedSell(state, action) {
  const result = { ...state, done2: [...(state.done2 || [])] };
  if (action.id === 'back' || /^[hs]\d/.test(action.id)) { if (!result.done2.includes(action.id)) result.done2.push(action.id); }
  if (action.id === 'back' && !action.full && typeof action.moonReserveUnits === 'string' && /^\d+$/.test(action.moonReserveUnits)) result.moon = action.moonReserveUnits;
  if (action.moonOnlyAfter === true) result.moonOnly = true;
  result.drawdownHits = 0;
  if (action.full) { result.stage = 9; result.done = true; }
  if (action.id === 'sellNow') result.sellNowDone = true;
  return result;
}

export function marketOrderRecord(data, orderId) {
  if (!data || !Array.isArray(data.list)) return null;
  return data.list.find((order) => order && String(order.orderId) === String(orderId)) || null;
}

export function marketOrderState(order) {
  const status = typeof order?.status === 'string' ? order.status.toUpperCase() : '';
  return status === 'FINISHED' ? 'finished' : status === 'FAILED' ? 'failed' : 'pending';
}

/** null means the API did not provide valid refund information, not zero. */
export function refundedTokenUnits(order, tokenAddress, decimals) {
  if (!Array.isArray(order?.refund) || !order.refund.length) return null;
  let total = 0n, found = false;
  for (const item of order.refund) {
    if (typeof item?.tokenAddress !== 'string' || item.tokenAddress.toLowerCase() !== tokenAddress.toLowerCase()) continue;
    const amount = parseTokenAmount(item.amount, decimals);
    if (amount === null) return null;
    total += amount; found = true;
  }
  return found ? total : null;
}

/** Net token outflow in this transaction only. null means no reliable ERC20
 * transfer proof; unrelated deposits in other transactions cannot change it. */
export function receiptTokenOutflow(receipt, tokenAddress, walletAddress) {
  if (!receipt || receipt.status !== '0x1' || !Array.isArray(receipt.logs) || receipt.logs.length > 10000) return null;
  const token = tokenAddress.toLowerCase(), wallet = walletAddress.toLowerCase();
  let out = 0n, found = false;
  for (const log of receipt.logs) {
    if (typeof log?.address !== 'string' || log.address.toLowerCase() !== token || !Array.isArray(log.topics) || log.topics.length !== 3 || String(log.topics[0]).toLowerCase() !== '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef') continue;
    const addresses = log.topics.slice(1).map((topic) => typeof topic === 'string' && /^0x0{24}[0-9a-f]{40}$/i.test(topic) ? '0x' + topic.slice(-40).toLowerCase() : null);
    if (addresses.some((address) => address === null)) return null;
    if (!addresses.includes(wallet)) continue;
    const amount = decodeAbiUint(log.data); if (amount === null) return null;
    if (addresses[0] === wallet) out += amount;
    if (addresses[1] === wallet) out -= amount;
    found = true;
  }
  return found && out >= 0n ? out : null;
}
