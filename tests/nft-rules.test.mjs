import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyNftEvent, formatBnbWei, hashRule, NFT_RULE_LIMITS, parseBnbWei, planNftAction, validateNftRule } from '../lib/nft-rules.mjs';

const walletAddress = '0x1111111111111111111111111111111111111111';
const addr = '0x2222222222222222222222222222222222222222';
const other = '0x3333333333333333333333333333333333333333';
const now = 1800000000000;
const hash = '0x' + 'a'.repeat(64);
const wei = (value) => parseBnbWei(value).toString();
function fixture(overrides = {}) {
  return validateNftRule({ enabled: true, walletAddress, addr, standard: 'ERC721', tokenId: '7', quantity: '1', mode: 'fixed-listing', listingUnitPriceBnb: '0.5', takeProfitNetBnb: '0.6', trailingArmNetBnb: '1', trailingDropBps: 2000, minNetBnb: '0.4', maxFeesBnb: '0.02', expirySec: 86400, cooldownSec: 60, ...overrides });
}
function position(rule, extra = {}) { return { walletAddress: rule.walletAddress, addr: rule.addr, standard: rule.standard, tokenId: rule.tokenId, quantity: rule.quantity, verifiedOwnership: true, verifiedAt: now, ...extra }; }
function quote(rule, extra = {}) { return { source: rule.mode === 'fixed-listing' ? 'listing-fees' : 'executable-offer', currency: 'BNB', walletAddress: rule.walletAddress, addr: rule.addr, standard: rule.standard, tokenId: rule.tokenId, quantity: rule.quantity, quoteId: 'quote-1', feesWei: wei('0.01'), ...(rule.mode === 'fixed-listing' ? {} : { grossWei: wei('1.01') }), expiresAt: now + 60000, ...extra }; }
function plan(rule, extra = {}) { return planNftAction({ rule, position: position(rule), quote: quote(rule), now, ...extra }); }
function intent(rule) {
  const proposal = plan(rule);
  assert.ok(proposal.action);
  const state = applyNftEvent(proposal.nextState, { type: 'intent-created', key: rule.key, intentId: 'intent-1', action: proposal.action, now });
  return { proposal, state };
}
function submitted(rule) { const { state } = intent(rule); return applyNftEvent(state, { type: 'submitted', key: rule.key, intentId: 'intent-1', orderId: 'order-1', now: now + 1 }); }
const event = (state, type, extra = {}) => ({ type, key: state.key, intentId: state.intentId, orderId: state.orderId, now: now + 2, ...extra });

test('BNB conversion uses exact wei strings, with no floats or exponent rounding', () => {
  assert.equal(parseBnbWei('0.000000000000000001'), 1n);
  assert.equal(parseBnbWei('1.234567890123456789'), 1234567890123456789n);
  assert.equal(formatBnbWei(1234567890123456789n), '1.234567890123456789');
  assert.equal(formatBnbWei(0n), '0');
  assert.equal(formatBnbWei(parseBnbWei('0001.230000')), '1.23');
  for (const value of [1, 0.1, null, '', '-1', '+1', '1e-18', '0.0000000000000000001', 'Infinity', '1.2.3']) assert.throws(() => parseBnbWei(value));
  assert.throws(() => formatBnbWei(-1n));
});

test('rules default disabled and cannot enable with missing explicit prices, net minimum or fee cap', () => {
  const raw = { walletAddress, addr, standard: 'ERC721', tokenId: '7', mode: 'fixed-listing' };
  const rule = validateNftRule(raw);
  assert.equal(rule.enabled, false); assert.equal(plan(rule).action, null);
  assert.throws(() => validateNftRule({ ...raw, enabled: true }), /required/);
  assert.throws(() => fixture({ listingUnitPriceBnb: '' }), /required/);
  assert.throws(() => fixture({ minNetBnb: '' }), /required/);
  assert.throws(() => fixture({ maxFeesBnb: '' }), /required/);
  assert.throws(() => validateNftRule(fixture(), { allowEnabled: false }), /confirmation/);
  assert.equal(fixture({ maxFeesBnb: '0' }).maxFeesBnb, '0');
});

test('rule schema validates identity, quantity, fields and timer boundaries', () => {
  assert.equal(fixture({ tokenId: '0007', quantity: '01' }).key, `${walletAddress}:${addr}:7`);
  assert.equal(fixture({ standard: 'ERC1155', quantity: '3' }).key, fixture().key);
  for (const patch of [{ arbitrary: true }, { enabled: 'yes' }, { addr: other.slice(0, 10) }, { walletAddress: '0x' + '0'.repeat(40) }, { standard: 'ERC20' }, { tokenId: '0x7' }, { quantity: '0' }, { quantity: '2' }, { mode: 'floor-price' }, { minNetBnb: '0' }, { expirySec: 299 }, { expirySec: 604801 }, { cooldownSec: 4 }, { cooldownSec: 3601 }, { trailingDropBps: 0 }, { key: 'forged' }]) assert.throws(() => fixture(patch));
  assert.equal(fixture({ expirySec: 300, cooldownSec: 5 }).expirySec, 300);
  assert.equal(fixture({ expirySec: 604800, cooldownSec: 3600 }).cooldownSec, 3600);
});

test('policy hash ignores enabled/label metadata and includes every execution boundary', () => {
  const rule = fixture(), digest = hashRule(rule);
  assert.equal(digest.length, 64);
  assert.equal(hashRule({ ...rule, enabled: false, name: 'new label' }), digest);
  for (const patch of [{ listingUnitPriceBnb: '0.51' }, { minNetBnb: '0.41' }, { maxFeesBnb: '0.021' }, { expirySec: 500 }, { cooldownSec: 5 }, { trailingDropBps: 2100 }, { mode: 'take-profit-offer' }]) assert.notEqual(hashRule({ ...rule, ...patch }), digest);
  assert.notEqual(hashRule(fixture({ standard: 'ERC1155', quantity: '2' })), digest);
  assert.notEqual(hashRule(fixture({ walletAddress: other })), digest);
  assert.equal(hashRule({ ...rule, listingUnitPriceBnb: '00.5000000' }), digest);
});

test('fixed listing uses the explicit unit price and bound fee estimate, not a floor or invented bid', () => {
  const rule = fixture({ standard: 'ERC1155', quantity: '3' });
  const result = plan(rule);
  assert.equal(result.action.type, 'list'); assert.equal(result.action.grossWei, wei('1.5')); assert.equal(result.action.netWei, wei('1.49'));
  assert.equal(result.action.unitPriceWei, wei('0.5')); assert.equal(result.action.quantity, '3');
  assert.equal(result.action.expiresAt, now + rule.expirySec * 1000);
  assert.equal(result.nextState.phase, 'idle'); assert.equal(result.nextState.plannedActionHash, result.action.planHash);
  assert.doesNotThrow(() => JSON.stringify(result));
  assert.equal(plan(rule, { quote: { ...quote(rule), source: 'floor', price: '2' } }).action, null);
  assert.equal(plan(rule, { quote: undefined }).action, null);
});

test('unverified/stale ownership and mismatched quotes cannot generate actions', () => {
  const rule = fixture();
  for (const patch of [{ verifiedOwnership: false }, { verifiedAt: now - NFT_RULE_LIMITS.ownershipMaxAgeMs - 1 }, { verifiedAt: now + 1 }, { walletAddress: other }, { tokenId: '8' }, { standard: 'ERC1155' }, { quantity: '0' }]) assert.equal(plan(rule, { position: position(rule, patch) }).action, null);
  for (const patch of [{ walletAddress: other }, { addr: other }, { tokenId: '8' }, { quantity: '2' }, { standard: 'ERC1155' }, { currency: 'USDT' }, { expiresAt: now }, { feesWei: undefined }, { quoteId: '' }, { grossWei: wei('100') }]) assert.equal(plan(rule, { quote: quote(rule, patch) }).action, null);
});

test('fee caps and net minimums apply to the entire quantity without floats', () => {
  const rule = fixture();
  assert.equal(plan(rule, { quote: quote(rule, { feesWei: wei('0.020000000000000001') }) }).reason, 'fee-limit-exceeded');
  const minimum = fixture({ maxFeesBnb: '0.2' });
  assert.equal(plan(minimum, { quote: quote(minimum, { feesWei: wei('0.11') }) }).reason, 'below-min-net');
  const exact = fixture({ mode: 'take-profit-offer', takeProfitNetBnb: '0.600000000000000001' });
  assert.equal(plan(exact, { quote: quote(exact, { grossWei: wei('0.61') }) }).action, null);
  assert.ok(plan(exact, { quote: quote(exact, { grossWei: wei('0.610000000000000001') }) }).action);
  const wrapped = plan(rule, { quote: quote(rule, { currency: 'WBNB' }) });
  assert.equal(wrapped.action.currency, 'WBNB'); assert.equal(wrapped.action.netWei, wei('0.49'));
});

test('offer take-profit requires a current executable bid, never a reference floor', () => {
  const rule = fixture({ mode: 'take-profit-offer' });
  assert.equal(plan(rule, { quote: quote(rule, { grossWei: wei('0.6') }) }).reason, 'take-profit-not-reached');
  assert.equal(plan(rule).action.type, 'accept-offer');
  for (const invalid of [{ ...quote(rule), source: 'floor' }, { ...quote(rule), executable: false }, { ...quote(rule), grossWei: undefined }, { ...quote(rule), expiresAt: now - 1 }, { source: 'reference-price', floorBnb: '1000' }]) assert.equal(plan(rule, { quote: invalid }).action, null);
});

test('trailing arms on executable net proceeds and triggers the configured peak drawdown', () => {
  const rule = fixture({ mode: 'trailing-offer', minNetBnb: '0.5' });
  const armed = plan(rule); assert.equal(armed.action, null); assert.equal(armed.nextState.trailingArmed, true); assert.equal(armed.nextState.peakNetWei, wei('1'));
  const peak = plan(rule, { state: armed.nextState, quote: quote(rule, { grossWei: wei('1.41') }) });
  assert.equal(peak.nextState.peakNetWei, wei('1.4')); assert.equal(peak.action, null);
  const floor = plan(rule, { state: peak.nextState, quote: quote(rule, { source: 'floor', grossWei: wei('10') }) });
  assert.equal(floor.nextState.peakNetWei, wei('1.4')); assert.equal(floor.action, null);
  const triggered = plan(rule, { state: peak.nextState, quote: quote(rule, { grossWei: wei('1.13') }) });
  assert.equal(triggered.action.netWei, wei('1.12')); assert.equal(triggered.action.type, 'accept-offer');
  const tooLow = plan(rule, { state: peak.nextState, quote: quote(rule, { grossWei: wei('0.41') }) });
  assert.equal(tooLow.action, null); assert.equal(tooLow.reason, 'below-min-net');
  assert.equal(plan(rule, { quote: quote(rule, { grossWei: wei('0.91') }) }).reason, 'trailing-not-armed');
});

test('planning is immutable and a stale ready proposal is invalidated by a disabled/no-action round', () => {
  const rule = fixture(), positionInput = position(rule), quoteInput = quote(rule), before = structuredClone({ rule, positionInput, quoteInput });
  const ready = planNftAction({ rule, position: positionInput, quote: quoteInput, now });
  assert.deepEqual({ rule, positionInput, quoteInput }, before);
  const disabled = plan({ ...rule, enabled: false }, { state: ready.nextState });
  assert.equal(disabled.nextState.plannedActionHash, undefined);
  assert.throws(() => applyNftEvent(disabled.nextState, { type: 'intent-created', key: rule.key, intentId: 'late', action: ready.action, now }));
  assert.equal(ready.nextState.plannedActionHash, ready.action.planHash);
});

test('intent and pending state block duplicates and do not automatically unlock after timeout', () => {
  const rule = fixture(), created = intent(rule);
  assert.equal(plan(rule, { state: created.state }).reason, 'already-intent');
  assert.throws(() => applyNftEvent(created.state, { type: 'intent-created', key: rule.key, intentId: 'duplicate', action: created.proposal.action, now }));
  const pending = submitted(rule);
  assert.equal(plan(rule, { state: pending, now: now + 100000000 }).reason, 'already-pending');
  const unknown = applyNftEvent(pending, event(pending, 'submission-unknown'));
  assert.equal(unknown.phase, 'review'); assert.equal(plan(rule, { state: unknown }).action, null);
});

test('intent creation rejects modified or expired actions even when a proposal hash is supplied', () => {
  const rule = fixture(), ready = plan(rule);
  assert.throws(() => applyNftEvent(ready.nextState, { type: 'intent-created', key: rule.key, intentId: '1', action: { ...ready.action, grossWei: '1' }, now }));
  assert.throws(() => applyNftEvent(ready.nextState, { type: 'intent-created', key: rule.key, intentId: '1', action: ready.action, now: ready.action.quoteExpiresAt }));
});

test('listing acknowledgement is not a fill; only matched confirmed chain evidence advances filled', () => {
  const rule = fixture(), pending = submitted(rule);
  assert.throws(() => applyNftEvent(pending, event(pending, 'listed-confirmed')));
  const listed = applyNftEvent(pending, event(pending, 'listed-confirmed', { confirmed: true }));
  assert.equal(listed.phase, 'listed'); assert.equal(listed.filledQuantity, '0'); assert.equal(plan(rule, { state: listed }).action, null);
  for (const patch of [{ confirmed: false }, { orderId: 'wrong' }, { intentId: 'wrong' }, { key: 'wrong' }, { txHash: '' }]) assert.throws(() => applyNftEvent(listed, event(listed, 'fill-confirmed', { confirmed: true, filledQuantity: '1', txHash: hash, ...patch })));
  const filled = applyNftEvent(listed, event(listed, 'fill-confirmed', { confirmed: true, filledQuantity: '1', txHash: hash }));
  assert.equal(filled.phase, 'filled'); assert.equal(filled.filledQuantity, '1'); assert.equal(plan(rule, { state: filled }).action, null);
  assert.deepEqual(applyNftEvent(filled, event(filled, 'fill-confirmed', { confirmed: true, filledQuantity: '1', txHash: hash })), filled);
});

test('ERC1155 partial confirmations enter review and never silently sell another whole configured lot', () => {
  const rule = fixture({ standard: 'ERC1155', quantity: '3' }), pending = submitted(rule);
  const partial = applyNftEvent(pending, event(pending, 'fill-confirmed', { confirmed: true, filledQuantity: '1', txHash: hash }));
  assert.equal(partial.phase, 'review'); assert.equal(partial.filledQuantity, '1'); assert.equal(plan(rule, { state: partial }).action, null);
  const cancelled = applyNftEvent(partial, event(partial, 'cancel-confirmed', { confirmed: true }));
  const retryTime = cancelled.cooldownUntil;
  assert.equal(plan(rule, { state: cancelled, now: retryTime, position: position(rule, { verifiedAt: retryTime, quantity: '9' }), quote: quote(rule, { expiresAt: retryTime + 60000 }) }).reason, 'partial-fill-manual-reset-required');
  assert.throws(() => applyNftEvent(partial, event(partial, 'fill-confirmed', { confirmed: true, filledQuantity: '4', txHash: hash })));
});

test('only definitive rejection/confirmed close unlock an order, and cooldown is enforced', () => {
  const rule = fixture(), created = intent(rule).state;
  const unknown = applyNftEvent(created, event(created, 'rejected'));
  assert.equal(unknown.phase, 'review');
  const failed = applyNftEvent(created, event(created, 'rejected', { definitive: true }));
  assert.equal(failed.phase, 'failed'); assert.equal(plan(rule, { state: failed }).reason, 'cooldown');
  const later = failed.cooldownUntil;
  assert.ok(plan(rule, { state: failed, now: later, position: position(rule, { verifiedAt: later }), quote: quote(rule, { expiresAt: later + 60000 }) }).action);
  const pending = submitted(rule);
  assert.throws(() => applyNftEvent(pending, event(pending, 'rejected', { definitive: true, orderId: 'wrong' })));
  assert.throws(() => applyNftEvent(pending, event(pending, 'expired-confirmed', { confirmed: true })));
  const expired = applyNftEvent(pending, event(pending, 'expired-confirmed', { confirmed: true, now: pending.action.expiresAt }));
  assert.equal(expired.phase, 'expired'); assert.equal(expired.cooldownUntil, pending.action.expiresAt + 60000);
});

test('execution-policy changes cannot erase an already active NFT intent', () => {
  const rule = fixture(), state = submitted(rule), changed = { ...rule, maxFeesBnb: '0.03' };
  const result = plan(changed, { state });
  assert.equal(result.action, null); assert.equal(result.reason, 'active-policy-changed'); assert.equal(result.nextState.intentId, state.intentId);
  assert.throws(() => plan(rule, { state: { ...state, key: 'another asset' } }));
});
