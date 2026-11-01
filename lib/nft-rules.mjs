import { createHash } from 'node:crypto';

const MAX_UINT = (1n << 256n) - 1n;
const WEI = 10n ** 18n;
const MODES = new Set(['fixed-listing', 'take-profit-offer', 'trailing-offer']);
const LOCKED_PHASES = new Set(['intent', 'pending', 'listed', 'filled', 'review']);
const ADDRESS = /^0x[0-9a-f]{40}$/i;
export const NFT_RULE_LIMITS = Object.freeze({ minExpirySec: 300, maxExpirySec: 604800, minCooldownSec: 5, maxCooldownSec: 3600, ownershipMaxAgeMs: 120000 });
const RULE_FIELDS = new Set(['key', 'name', 'enabled', 'walletAddress', 'addr', 'standard', 'tokenId', 'quantity', 'mode', 'listingUnitPriceBnb', 'takeProfitNetBnb', 'trailingArmNetBnb', 'trailingDropBps', 'minNetBnb', 'maxFeesBnb', 'expirySec', 'cooldownSec']);
const PRICE_FIELDS = ['listingUnitPriceBnb', 'takeProfitNetBnb', 'trailingArmNetBnb'];
const MODE_PRICE = { 'fixed-listing': 'listingUnitPriceBnb', 'take-profit-offer': 'takeProfitNetBnb', 'trailing-offer': 'trailingArmNetBnb' };

function record(value, name) { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`); return value; }
function address(value, name) { if (typeof value !== 'string' || !ADDRESS.test(value) || /^0x0{40}$/i.test(value)) throw new Error(`${name} must be a nonzero EVM address`); return value.toLowerCase(); }
function text(value, name, max = 160, optional = false) { if (optional && value === undefined) return ''; if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f\u007f]/.test(value) || (!optional && !value.trim())) throw new Error(`${name} is invalid`); return value.trim(); }
function uint(value, name, positive = false) { if (typeof value !== 'string' || value.length > 78 || !/^\d+$/.test(value)) throw new Error(`${name} must be a decimal integer string`); const n = BigInt(value); if (n > MAX_UINT || positive && n === 0n) throw new Error(`${name} is out of range`); return n; }
function integer(value, name, min, max, fallback) { const number = value === undefined ? fallback : value; if (!Number.isSafeInteger(number) || number < min || number > max) throw new Error(`${name} is out of range`); return number; }
function time(value, name) { return integer(value, name, 0, Number.MAX_SAFE_INTEGER); }
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
const sha256 = (value) => createHash('sha256').update(canonical(value)).digest('hex');

/** BNB inputs are exact decimal strings, never floats or scientific notation. */
export function parseBnbWei(value) {
  if (typeof value !== 'string' || value.length > 100 || !/^\d+(?:\.\d{1,18})?$/.test(value)) throw new Error('BNB amount must be an exact decimal string with at most 18 decimal places');
  const [whole, fraction = ''] = value.split('.');
  const amount = BigInt(whole) * WEI + BigInt(fraction.padEnd(18, '0'));
  if (amount > MAX_UINT) throw new Error('BNB amount is out of range');
  return amount;
}
export function formatBnbWei(value) {
  const amount = typeof value === 'bigint' ? value : uint(value, 'wei');
  if (amount < 0n || amount > MAX_UINT) throw new Error('wei is out of range');
  const fraction = (amount % WEI).toString().padStart(18, '0').replace(/0+$/, '');
  return (amount / WEI).toString() + (fraction ? '.' + fraction : '');
}
function bnbField(value, name, { positive = false, required = false } = {}) {
  if (value === undefined || value === '') { if (required) throw new Error(`${name} is required before enabling`); return ''; }
  const amount = parseBnbWei(value);
  if (positive && amount === 0n) throw new Error(`${name} must be positive`);
  return formatBnbWei(amount);
}

export function validateNftRule(raw, { allowEnabled = true } = {}) {
  record(raw, 'rule');
  for (const field of Object.keys(raw)) if (!RULE_FIELDS.has(field)) throw new Error(`Unknown NFT rule field: ${field}`);
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') throw new Error('enabled must be boolean');
  const enabled = raw.enabled === true;
  if (enabled && !allowEnabled) throw new Error('NFT selling requires the dedicated enable confirmation');
  const walletAddress = address(raw.walletAddress, 'walletAddress'), addr = address(raw.addr, 'addr');
  if (!['ERC721', 'ERC1155'].includes(raw.standard)) throw new Error('standard must be ERC721 or ERC1155');
  const tokenId = uint(raw.tokenId, 'tokenId').toString(), quantity = uint(raw.quantity === undefined ? '1' : raw.quantity, 'quantity', true).toString();
  if (raw.standard === 'ERC721' && quantity !== '1') throw new Error('ERC721 quantity must be 1');
  if (!MODES.has(raw.mode)) throw new Error('Unsupported NFT sell mode');
  const key = `${walletAddress}:${addr}:${tokenId}`;
  if (raw.key !== undefined && raw.key !== key) throw new Error('NFT rule key does not match its asset');
  const rule = { key, name: text(raw.name, 'name', 80, true), enabled, walletAddress, addr, standard: raw.standard, tokenId, quantity, mode: raw.mode };
  for (const field of PRICE_FIELDS) rule[field] = bnbField(raw[field], field, { positive: true, required: enabled && MODE_PRICE[rule.mode] === field });
  rule.minNetBnb = bnbField(raw.minNetBnb, 'minNetBnb', { positive: true, required: enabled });
  rule.maxFeesBnb = bnbField(raw.maxFeesBnb, 'maxFeesBnb', { required: enabled });
  rule.trailingDropBps = integer(raw.trailingDropBps, 'trailingDropBps', 1, 10000, 2000);
  rule.expirySec = integer(raw.expirySec, 'expirySec', NFT_RULE_LIMITS.minExpirySec, NFT_RULE_LIMITS.maxExpirySec, 86400);
  rule.cooldownSec = integer(raw.cooldownSec, 'cooldownSec', NFT_RULE_LIMITS.minCooldownSec, NFT_RULE_LIMITS.maxCooldownSec, 60);
  if (rule.listingUnitPriceBnb && parseBnbWei(rule.listingUnitPriceBnb) * BigInt(quantity) > MAX_UINT) throw new Error('Total NFT listing value is out of range');
  const target = rule.mode === 'take-profit-offer' ? rule.takeProfitNetBnb : rule.mode === 'trailing-offer' ? rule.trailingArmNetBnb : '';
  if (enabled && target && parseBnbWei(target) < parseBnbWei(rule.minNetBnb)) throw new Error('Offer target must not be below minNetBnb');
  return rule;
}

/** Consent/runtime enablement and cosmetic labels are not execution policy. */
export function hashRule(value) {
  const { enabled, name, ...policy } = validateNftRule(value);
  return sha256(policy);
}

function initialState(rule, policyHash) {
  return { key: rule.key, policyHash, phase: 'idle', peakNetWei: '0', trailingArmed: false, filledQuantity: '0', cooldownUntil: 0, cooldownSec: rule.cooldownSec };
}
function matchingAsset(value, rule, exactQuantity) {
  return value && typeof value.walletAddress === 'string' && value.walletAddress.toLowerCase() === rule.walletAddress && typeof value.addr === 'string' && value.addr.toLowerCase() === rule.addr && value.standard === rule.standard && typeof value.tokenId === 'string' && /^\d+$/.test(value.tokenId) && value.tokenId.length <= 78 && BigInt(value.tokenId).toString() === rule.tokenId && (!exactQuantity || value.quantity === rule.quantity);
}

/** Pure proposal only. Action/state contain decimal wei strings and can be JSON
 * persisted; no signature, approval, listing or transfer occurs in this module. */
export function planNftAction({ rule: input, state, position, quote, now }) {
  const rule = validateNftRule(input), policyHash = hashRule(rule); time(now, 'now');
  let nextState = state === undefined || state === null ? initialState(rule, policyHash) : { ...record(state, 'state') };
  if (nextState.key !== rule.key) throw new Error('NFT state belongs to a different asset');
  const finish = (reason, action = null) => { if (!action) delete nextState.plannedActionHash; return { action, nextState, reason }; };
  if (!rule.enabled) return finish('disabled');
  if (nextState.policyHash !== policyHash) {
    if (LOCKED_PHASES.has(nextState.phase)) return finish('active-policy-changed');
    nextState = initialState(rule, policyHash);
  }
  if (!['idle', 'intent', 'pending', 'listed', 'filled', 'review', 'failed', 'cancelled', 'expired'].includes(nextState.phase)) throw new Error('Invalid NFT state phase');
  if (LOCKED_PHASES.has(nextState.phase)) return finish(nextState.phase === 'review' ? 'manual-review-required' : `already-${nextState.phase}`);
  try { if (uint(nextState.filledQuantity || '0', 'state.filledQuantity') > 0n) return finish('partial-fill-manual-reset-required'); }
  catch { return finish('invalid-fill-state'); }
  if ((nextState.cooldownUntil || 0) > now) return finish('cooldown');
  if (!matchingAsset(position, rule, false) || position.verifiedOwnership !== true || !Number.isSafeInteger(position.verifiedAt) || position.verifiedAt > now || now - position.verifiedAt > NFT_RULE_LIMITS.ownershipMaxAgeMs) return finish('ownership-unverified');
  let owned;
  try { owned = uint(position.quantity, 'position.quantity'); } catch { return finish('ownership-unverified'); }
  if (owned < BigInt(rule.quantity)) return finish('insufficient-owned-quantity');
  const expectedSource = rule.mode === 'fixed-listing' ? 'listing-fees' : 'executable-offer';
  if (!quote || quote.source !== expectedSource) return finish(rule.mode === 'fixed-listing' ? 'listing-fees-unknown' : 'executable-offer-unknown');
  if (rule.mode !== 'fixed-listing' && quote.executable === false) return finish('executable-offer-unknown');
  if (!matchingAsset(quote, rule, true)) return finish('quote-asset-mismatch');
  if (!['BNB', 'WBNB'].includes(quote.currency)) return finish('unsupported-quote-currency');
  if (typeof quote.quoteId !== 'string' || !quote.quoteId.trim() || quote.quoteId.length > 200 || /[\r\n\0]/.test(quote.quoteId) || !Number.isSafeInteger(quote.expiresAt) || quote.expiresAt <= now) return finish('quote-expired-or-invalid');
  let grossWei, feesWei;
  try {
    feesWei = uint(quote.feesWei, 'quote.feesWei');
    grossWei = rule.mode === 'fixed-listing' ? parseBnbWei(rule.listingUnitPriceBnb) * BigInt(rule.quantity) : uint(quote.grossWei, 'quote.grossWei', true);
    if (quote.grossWei !== undefined && uint(quote.grossWei, 'quote.grossWei') !== grossWei) return finish('quote-price-mismatch');
  } catch { return finish('quote-price-or-fees-unknown'); }
  if (feesWei > parseBnbWei(rule.maxFeesBnb)) return finish('fee-limit-exceeded');
  if (feesWei >= grossWei) return finish('nonpositive-net-proceeds');
  const netWei = grossWei - feesWei;
  if (rule.mode === 'trailing-offer') {
    let peak;
    try { peak = uint(nextState.peakNetWei || '0', 'state.peakNetWei'); } catch { return finish('invalid-trailing-state'); }
    if (netWei > peak) { peak = netWei; nextState.peakNetWei = peak.toString(); nextState.peakUpdatedAt = now; }
    if (netWei >= parseBnbWei(rule.trailingArmNetBnb)) nextState.trailingArmed = true;
    if (!nextState.trailingArmed) return finish('trailing-not-armed');
    if (netWei > peak * BigInt(10000 - rule.trailingDropBps) / 10000n) return finish('trailing-not-triggered');
  } else if (rule.mode === 'take-profit-offer' && netWei < parseBnbWei(rule.takeProfitNetBnb)) return finish('take-profit-not-reached');
  if (netWei < parseBnbWei(rule.minNetBnb)) return finish('below-min-net');
  const expiresAt = rule.mode === 'fixed-listing' ? now + rule.expirySec * 1000 : Math.min(quote.expiresAt, now + rule.expirySec * 1000);
  if (!Number.isSafeInteger(expiresAt)) return finish('invalid-clock');
  const action = {
    type: rule.mode === 'fixed-listing' ? 'list' : 'accept-offer', key: rule.key, policyHash,
    walletAddress: rule.walletAddress, addr: rule.addr, standard: rule.standard, tokenId: rule.tokenId, quantity: rule.quantity,
    currency: quote.currency, grossWei: grossWei.toString(), feesWei: feesWei.toString(), netWei: netWei.toString(),
    ...(rule.mode === 'fixed-listing' ? { unitPriceWei: parseBnbWei(rule.listingUnitPriceBnb).toString() } : {}),
    quoteId: quote.quoteId, quoteExpiresAt: quote.expiresAt, expiresAt,
  };
  action.planHash = sha256(action);
  nextState.plannedActionHash = action.planHash;
  nextState.cooldownSec = rule.cooldownSec;
  return finish('ready', action);
}

function matchEvent(state, event, { requireOrder = false } = {}) {
  if (event.key !== state.key || event.intentId !== state.intentId) throw new Error('NFT event does not match the active intent');
  if (requireOrder && (!state.orderId || event.orderId !== state.orderId)) throw new Error('NFT event does not match the active order');
}
function confirmed(event) { if (event.confirmed !== true) throw new Error('NFT event requires confirmed evidence'); }

/** Internal trusted-engine events only. Persist intent-created BEFORE any
 * submission; unknown results never expire/unlock themselves. Fill quantities
 * are cumulative for this order, making duplicate confirmations idempotent. */
export function applyNftEvent(input, event) {
  const state = { ...record(input, 'state') }; record(event, 'event'); time(event.now, 'event.now');
  if (event.type === 'intent-created') {
    if (!['idle', 'failed', 'cancelled', 'expired'].includes(state.phase) || (state.cooldownUntil || 0) > event.now) throw new Error('NFT position already has an active action or cooldown');
    const action = record(event.action, 'event.action'), { planHash, ...payload } = action;
    if (action.key !== state.key || action.policyHash !== state.policyHash || planHash !== state.plannedActionHash || sha256(payload) !== planHash || action.quoteExpiresAt <= event.now || action.expiresAt <= event.now) throw new Error('NFT action is changed, expired or was not planned');
    state.intentId = text(event.intentId, 'intentId'); state.action = { ...action }; state.phase = 'intent'; state.intentCreatedAt = event.now;
    delete state.plannedActionHash; delete state.orderId;
    return state;
  }
  matchEvent(state, event);
  if (event.type === 'submitted') {
    if (state.phase !== 'intent') throw new Error('NFT action was already submitted');
    state.orderId = text(event.orderId, 'orderId', 200); state.phase = 'pending'; state.submittedAt = event.now; return state;
  }
  if (event.type === 'submission-unknown') { if (!['intent', 'pending'].includes(state.phase)) throw new Error('No NFT submission to reconcile'); state.phase = 'review'; state.reviewReason = 'submission-unknown'; return state; }
  if (event.type === 'listed-confirmed') {
    matchEvent(state, event, { requireOrder: true }); confirmed(event);
    if (state.phase !== 'pending' || state.action?.type !== 'list') throw new Error('No pending NFT listing');
    state.phase = 'listed'; state.listedAt = event.now; return state;
  }
  if (event.type === 'fill-confirmed') {
    matchEvent(state, event, { requireOrder: true }); confirmed(event);
    if (!/^0x[0-9a-f]{64}$/i.test(event.txHash || '')) throw new Error('NFT fill requires a confirmed transaction hash');
    const filled = uint(event.filledQuantity, 'filledQuantity', true), current = uint(state.filledQuantity || '0', 'state.filledQuantity'), target = uint(state.action?.quantity, 'action.quantity', true);
    if (filled > target) throw new Error('NFT confirmed fill exceeds requested quantity');
    if (filled <= current) return state;
    if (!['pending', 'listed', 'review'].includes(state.phase)) throw new Error('No NFT order can accept this fill');
    state.filledQuantity = filled.toString(); state.lastFillTxHash = event.txHash.toLowerCase(); state.confirmedAt = event.now;
    state.phase = filled === target ? 'filled' : 'review';
    if (filled < target) state.reviewReason = 'partial-fill'; else delete state.reviewReason;
    return state;
  }
  if (event.type === 'rejected') {
    if (!['intent', 'pending'].includes(state.phase)) throw new Error('No NFT action can be rejected');
    if (state.phase === 'pending') matchEvent(state, event, { requireOrder: true });
    if (event.definitive !== true) { state.phase = 'review'; state.reviewReason = 'rejection-not-definitive'; return state; }
    state.phase = 'failed'; state.failedAt = event.now;
  } else if (event.type === 'cancel-confirmed' || event.type === 'expired-confirmed') {
    matchEvent(state, event, { requireOrder: true }); confirmed(event);
    if (!['pending', 'listed', 'review'].includes(state.phase)) throw new Error('No active NFT order to close');
    if (event.type === 'expired-confirmed' && event.now < state.action.expiresAt) throw new Error('NFT order has not reached its expiry');
    state.phase = event.type === 'cancel-confirmed' ? 'cancelled' : 'expired'; state.closedAt = event.now;
  } else throw new Error('Unsupported NFT event type');
  state.cooldownUntil = event.now + integer(state.cooldownSec, 'state.cooldownSec', NFT_RULE_LIMITS.minCooldownSec, NFT_RULE_LIMITS.maxCooldownSec) * 1000;
  delete state.plannedActionHash;
  return state;
}
