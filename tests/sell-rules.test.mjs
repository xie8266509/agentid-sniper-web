import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { decodeAbiUint } from '../lib/nft-codec.mjs';
import * as sellRules from '../lib/sell-rules.mjs';
import { DEFAULT_RULES } from '../lib/config.mjs';
import { applyConfirmedSell, formatTokenAmount, marketOrderRecord, marketOrderState, normalizedPositionValue, parseTokenAmount, planPositionSell, positionStateKey, refundedTokenUnits } from '../lib/sell-rules.mjs';

const wallet = '0x1111111111111111111111111111111111111111', tokenAddress = '0x2222222222222222222222222222222222222222';
const another = '0x3333333333333333333333333333333333333333';
const rules = { backX: 3, halfX: [5, 10], crash: 0.6, fastMin: 30, fastCrash: 0.35, noPumpMin: 20, noPumpX: 2, drop: 0.5 };
const now = 1800000000000;
function plan(overrides = {}) {
  return planPositionSell({ token: { cost: 10 }, state: { pricePeak: 30, openAt: now - 60000, done2: [] }, balance: 100n * 10n ** 18n, value: 30, referenceValue: 30, now, rules, ...overrides });
}

test('token quantities preserve decimals and very small amounts without float rounding', () => {
  assert.equal(formatTokenAmount(1234500n, 6), '1.2345');
  assert.equal(formatTokenAmount(1234567891n, 9), '1.234567891');
  assert.equal(formatTokenAmount(1n, 18), '0.000000000000000001');
  assert.equal(formatTokenAmount(17n, 0), '17');
  const maximum = (1n << 256n) - 1n;
  assert.equal(parseTokenAmount(formatTokenAmount(maximum, 18), 18), maximum);
  assert.equal(parseTokenAmount('1.234500000', 6), 1234500n);
  for (const invalid of ['1e-18', '-1', '0.0000001', 'NaN', '1.2.3']) assert.equal(parseTokenAmount(invalid, 6), null);
  assert.throws(() => formatTokenAmount(1n, -1));
});

test('position identities separate contracts sharing a symbol and separate wallets', () => {
  assert.notEqual(positionStateKey(wallet, tokenAddress), positionStateKey(wallet, another));
  assert.notEqual(positionStateKey(wallet, tokenAddress), positionStateKey(another, tokenAddress));
  assert.equal(positionStateKey(wallet.toUpperCase().replace('0X', '0x'), tokenAddress), positionStateKey(wallet, tokenAddress));
});

test('backX and halfX use configured price multiples while amounts use the remaining balance', () => {
  const back = plan();
  assert.equal(back.id, 'back'); assert.equal(back.amount, 34333333333333333334n);
  assert.equal(plan({ rules: { ...rules, backX: 4 } }), null);
  const half = plan({ state: { pricePeak: 50, openAt: now - 60000, done2: ['back'] }, balance: 65n * 10n ** 18n, value: 32.5, referenceValue: 50 });
  assert.equal(half.id, 'h5'); assert.equal(half.amount, 325n * 10n ** 17n);
  assert.equal(plan({ rules: { ...rules, halfX: [6, 12] }, state: { pricePeak: 50, openAt: now - 60000, done2: ['back'] }, referenceValue: 50 }), null);
});

test('a completed partial sale does not itself trigger a price crash or inflate the next target', () => {
  const original = 100n * 10n ** 18n, remaining = 325n * 10n ** 17n;
  const normalized = normalizedPositionValue(16.25, remaining, original);
  assert.equal(normalized, 50);
  assert.equal(plan({ state: { pricePeak: 50, openAt: now - 60000, done2: ['back', 'h5'] }, balance: remaining, value: 16.25, referenceValue: normalized }), null);
  assert.equal(normalizedPositionValue(1, 0n, original), null);
});

test('recovery sizing at a large price jump sells only the precise principal fraction', () => {
  assert.equal(sellRules.recoverySellAmount(100n * 10n ** 18n, 1, 10000), 10300000000000000n);
  assert.equal(formatTokenAmount(sellRules.recoverySellAmount(100n * 10n ** 18n, 1, 10000), 18), '0.0103');
});

test('fastCrash applies only during fastMin and ordinary crash applies afterwards', () => {
  const state = { pricePeak: 100, openAt: now - 60000, done2: ['back', 'h5', 'h10'], drawdownHits: 2 };
  assert.equal(plan({ state, value: 65, referenceValue: 65 }).id, 'crash');
  assert.equal(plan({ state: { ...state, openAt: now - 31 * 60000 }, value: 65, referenceValue: 65 }), null);
  assert.equal(plan({ state: { ...state, openAt: now - 31 * 60000 }, value: 40, referenceValue: 40 }).id, 'crash');
  assert.equal(plan({ state, value: 65, referenceValue: 65, rules: { ...rules, fastCrash: 0.5 } }), null);
});

test('noPumpMin/noPumpX use the historical normalized price peak and stop after recovery', () => {
  const state = { pricePeak: 15, openAt: now - 21 * 60000, done2: [] };
  assert.equal(plan({ state, value: 15, referenceValue: 15 }).id, 'noPump');
  assert.equal(plan({ state, value: 15, referenceValue: 15, rules: { ...rules, noPumpX: 1.4 } }), null);
  assert.equal(plan({ state, value: 15, referenceValue: 15, rules: { ...rules, noPumpMin: 0 } }), null);
  assert.equal(plan({ state: { ...state, done2: ['back'] }, value: 15, referenceValue: 15 }), null);
  assert.equal(plan({ state: { ...state, pricePeak: 20 }, value: 19, referenceValue: 19 }), null);
});

test('free drop honors configuration, the three-minute delay and the existing dust floor', () => {
  const state = { freePricePeak: 1, openAt: now - 600000, drawdownHits: 2 };
  assert.equal(plan({ token: { cost: 0 }, state, value: 0.79, referenceValue: 0.79, rules: { ...rules, drop: 0.2 } }).id, 'freeDrop');
  assert.equal(plan({ token: { cost: 0 }, state, value: 0.79, referenceValue: 0.79, rules: { ...rules, drop: 0.8 } }), null);
  assert.equal(plan({ token: { cost: 0 }, state: { ...state, openAt: now - 1000 }, value: 0.4, referenceValue: 0.4 }), null);
  assert.equal(plan({ token: { cost: 0 }, state: { ...state, freePricePeak: 0.013 }, value: 0.004, referenceValue: 0.004 }), null);
  assert.equal(plan({ token: { cost: 0 }, state: { ...state, freeFail: 3 }, value: 0.4, referenceValue: 0.4 }), null);
});

test('drawdowns need two fresh valid observations and recoveries reset confirmation', () => {
  const input = { token: { cost: 10 }, state: { pricePeak: 100, openAt: now - 60000, done2: ['back', 'h5', 'h10'] }, value: 65, referenceValue: 65, now, rules };
  const first = { ...input.state, ...sellRules.samplePositionDrawdown(input) };
  assert.equal(first.drawdownHits, 1); assert.equal(plan({ state: first, value: 65, referenceValue: 65 }), null);
  assert.deepEqual(sellRules.samplePositionDrawdown({ ...input, state: first }), {});
  assert.deepEqual(sellRules.samplePositionDrawdown({ ...input, state: first, now: now + 1, value: null }), {});
  const second = { ...first, ...sellRules.samplePositionDrawdown({ ...input, state: first, now: now + 1 }) };
  assert.equal(second.drawdownHits, 2); assert.equal(plan({ state: second, value: 65, referenceValue: 65, now: now + 1 }).id, 'crash');
  const recovery = { ...second, ...sellRules.samplePositionDrawdown({ ...input, state: second, value: 100, referenceValue: 100, now: now + 2 }) };
  assert.equal(recovery.drawdownHits, 0);
  const changed = sellRules.samplePositionDrawdown({ ...input, state: second, now: now + 3, rules: { ...rules, fastCrash: 0.3 } });
  assert.equal(changed.drawdownHits, 1);
});

test('modern steps reserve moon units only after confirmed recovery and never sell them automatically', () => {
  const modern = { ...DEFAULT_RULES }, token = { cost: 10 };
  const state = { pricePeak: 20, openAt: now - 60000, done2: [] };
  const back = plan({ token, state, balance: 10000n, value: 20, referenceValue: 20, rules: modern });
  assert.equal(back.amount, 5150n); assert.equal(back.moonReserveUnits, '970'); assert.equal(state.moon, undefined);
  const confirmed = applyConfirmedSell(state, back);
  assert.equal(confirmed.moon, '970'); assert.deepEqual(confirmed.done2, ['back']);
  const step = plan({ token, state: { ...confirmed, pricePeak: 100 }, balance: 4850n, value: 48.5, referenceValue: 100, rules: modern });
  assert.equal(step.id, 's10'); assert.equal(step.amount, 1164n); assert.equal(step.full, false);
  const afterStep = applyConfirmedSell(confirmed, step);
  assert.equal(afterStep.moon, '970'); assert.deepEqual(afterStep.done2, ['back', 's10']);
  const next = plan({ token, state: { ...afterStep, pricePeak: 200 }, balance: 3686n, value: 73.72, referenceValue: 200, rules: modern });
  assert.equal(next.id, 's20'); assert.equal(next.amount, 1358n);
  const crash = plan({ token, state: { ...confirmed, pricePeak: 20, drawdownHits: 2 }, balance: 4850n, value: 3.88, referenceValue: 8, rules: modern });
  assert.equal(crash.amount, 3880n); assert.equal(crash.full, false); assert.equal(crash.moonOnlyAfter, true);
  const moonOnly = applyConfirmedSell(confirmed, crash); assert.equal(moonOnly.moonOnly, true); assert.equal(moonOnly.done, undefined);
  assert.equal(plan({ token, state: moonOnly, balance: 970n, value: 1, referenceValue: 8, rules: modern }), null);
  assert.equal(plan({ token: { ...token, sellNow: true }, state: moonOnly, balance: 970n, value: 1, referenceValue: 8, rules: modern }).amount, 970n);
});

test('modern steps remove legacy no-pump and fast-crash exits and retain explicit zero moon settings', () => {
  const state = { pricePeak: 100, openAt: now - 60000, done2: ['back'], drawdownHits: 2 };
  assert.equal(plan({ state, value: 50, referenceValue: 50, rules: { ...DEFAULT_RULES, steps: [] } }), null);
  assert.equal(plan({ state: { pricePeak: 15, openAt: now - 6000000, done2: [] }, value: 15, referenceValue: 15, rules: DEFAULT_RULES }), null);
  const crash = plan({ state, value: 100, referenceValue: 100, rules: { ...DEFAULT_RULES, crashAfterBack: 0, steps: [] } });
  assert.equal(crash, null);
  const back = plan({ state: { pricePeak: 30, openAt: now - 60000, done2: [] }, rules: { ...DEFAULT_RULES, moonPct: 0 } });
  assert.equal(back.moonReserveUnits, '0');
});

test('switching strategies never repeats a previously confirmed multiple under a new action ID', () => {
  const state = { pricePeak: 100, openAt: now - 60000, done2: ['back', 'h10'] };
  assert.equal(plan({ state, value: 100, referenceValue: 100, rules: { ...DEFAULT_RULES, steps: [[10, 30]] } }), null);
  assert.equal(plan({ state: { ...state, done2: ['back', 's10'] }, value: 100, referenceValue: 100, rules: { ...rules, halfX: [10] } }), null);
});

test('hold and monitor modes suppress automation while explicit sellNow only overrides hold', () => {
  assert.equal(plan({ token: { cost: 10, hold: true } }), null);
  assert.equal(plan({ token: { cost: 10, hold: true, sellNow: true } }).id, 'sellNow');
  assert.equal(plan({ token: { cost: 10, hold: true, sellNow: true }, monitorOnly: true }), null);
  assert.equal(plan({ state: { done: true, stage: 9 } }), null);
});

test('only a separately confirmed action advances stages; rule evaluation is pure', () => {
  const state = { stage: 0, done2: [] }, before = structuredClone(state);
  const action = plan({ state: { ...state, pricePeak: 30, openAt: now - 60000 } });
  assert.deepEqual(state, before);
  const confirmed = applyConfirmedSell(state, action);
  assert.deepEqual(confirmed.done2, ['back']); assert.equal(confirmed.done, undefined);
  assert.deepEqual(state, before);
  const sold = applyConfirmedSell(state, { id: 'sellNow', full: true });
  assert.equal(sold.stage, 9); assert.equal(sold.done, true); assert.equal(sold.sellNowDone, true);
  assert.deepEqual(sold.done2, []);
});

test('submitted, pending and failed market orders cannot be mistaken for completed fills', () => {
  assert.equal(marketOrderState({ orderId: '1' }), 'pending');
  assert.equal(marketOrderState({ status: 'PENDING' }), 'pending');
  assert.equal(marketOrderState({ status: 'FAILED' }), 'failed');
  const finished = { orderId: '1', status: 'FINISHED' };
  assert.equal(marketOrderState(marketOrderRecord({ list: [{ orderId: 'other' }, finished] }, '1')), 'finished');
  assert.equal(marketOrderRecord({ list: [] }, '1'), null);
});

test('refund parsing preserves precision and distinguishes absent or malformed information', () => {
  assert.equal(refundedTokenUnits({}, tokenAddress, 6), null);
  assert.equal(refundedTokenUnits({ refund: [] }, tokenAddress, 6), null);
  assert.equal(refundedTokenUnits({ refund: [{ tokenAddress, amount: '1.000001' }] }, tokenAddress, 6), 1000001n);
  assert.equal(refundedTokenUnits({ refund: [{ tokenAddress, amount: 'unknown' }] }, tokenAddress, 6), null);
});

const watch = readFileSync(new URL('../watch.mjs', import.meta.url), 'utf8');
const executionSource = watch.slice(watch.indexOf('function positionFor('), watch.indexOf('// ---------- 新的 Agent ID'));
const word = (value) => BigInt(value).toString(16).padStart(64, '0');
function executionHarness({ decimals = 6, status = 'PENDING', after, submit, refund, receiptOut, missingReceipt = false, storageFail = false, missingDecimals = false, ruleOverrides = {}, cost = 10, value = 30, seed = {} } = {}) {
  let balance = 100n * 10n ** BigInt(decimals), statusValue = status;
  const seen = { swaps: [], lists: [], saved: [], messages: [] };
  const token = { sym: 'TEST', addr: tokenAddress, cost };
  const S = { tokens: {}, trades: [], dyn: [] };
  const W = { addr: wallet, name: 'test', async baw(args) {
    if (args[1] === 'swap') {
      seen.swaps.push(args);
      if (submit) return submit(args);
      return { t: 'submitted', j: { success: true, data: { orderId: 'order-' + seen.swaps.length } } };
    }
    assert.equal(args[1], 'list'); seen.lists.push(args);
    if (statusValue === 'FINISHED' && after !== undefined) balance = after;
    return { t: 'status', j: { success: true, data: { list: [{ orderId: args.at(-1), status: statusValue, toTokenActualQty: '0.01', txHash: '0x' + '4'.repeat(64), refund }] } } };
  } };
  const context = vm.createContext({
    ...sellRules, decodeAbiUint, MONITOR_ONLY: false, S, TOKENS: [token], ME: wallet,
    WALLETS: [W], RULE: { ...rules, notifyX: [5, 10], ...ruleOverrides },
    NATIVE_BNB: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    wa: (a) => a.slice(2).padStart(64, '0'),
    async call(_addr, data) {
      if (data === '0x313ce567') return missingDecimals ? null : '0x' + word(decimals);
      if (data.startsWith('0x70a08231')) return '0x' + word(balance);
      if (data === '0x0902f1ac') return '0x' + word(1) + word(1);
      throw new Error('Unexpected mocked call ' + data);
    },
    async bnbUsd() { return 1000; }, async tg(message) { seen.messages.push(message); }, ts: () => 'mock-time',
    async rpc(method) {
      assert.equal(method, 'eth_getTransactionReceipt');
      if (missingReceipt) return null;
      const last = seen.swaps.at(-1), amount = receiptOut ?? parseTokenAmount(last[last.indexOf('--fromTokenQty') + 1], decimals);
      return { status: '0x1', logs: [{ address: tokenAddress, topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', '0x' + wallet.slice(2).padStart(64, '0'), '0x' + another.slice(2).padStart(64, '0')], data: '0x' + word(amount) }] };
    },
    save(strict) { if (strict && storageFail) throw new Error('disk full'); seen.saved.push(structuredClone(S)); }, log() {}, blacklist() {},
    async findPair() { return { pair: tokenAddress }; }, async valueUsd() { return value; },
  });
  vm.runInContext(executionSource + '\nglobalThis.api = { sell, reconcileSell, holdW, positionFor };', context);
  const st = { hist: [], stage: 0, done2: [], peak: value, pricePeak: value, openAt: Date.now() - 60000, pair: tokenAddress, ...seed };
  S.tokens[positionStateKey(wallet, tokenAddress)] = st;
  return { api: context.api, context, token, W, st, S, seen, balance: () => balance, setBalance(value) { balance = value; }, setStatus(value) { statusValue = value; } };
}

test('actual sell persists an intent before swap and never resubmits a pending order', async () => {
  const h = executionHarness();
  assert.equal(await h.api.sell(h.token, h.st, 40_000_000n, 'test', h.W, { id: 'back', full: false }), false);
  assert.equal(h.seen.swaps.length, 1);
  assert.ok(h.seen.saved.some((snapshot) => snapshot.tokens[positionStateKey(wallet, tokenAddress)].submissionIntent));
  assert.equal(h.st.pendingSell.orderId, 'order-1'); assert.deepEqual(h.st.done2, []); assert.equal(h.S.trades.length, 0);
  await h.api.sell(h.token, h.st, 40_000_000n, 'test', h.W, { id: 'back', full: false });
  assert.equal(h.seen.swaps.length, 1); assert.equal(h.seen.lists.length, 2);
});

test('actual sell confirms only FINISHED plus token balance reduction, once', async () => {
  const h = executionHarness({ status: 'FINISHED' });
  await h.api.sell(h.token, h.st, 40_000_000n, 'test', h.W, { id: 'back', full: false });
  assert.equal(h.st.pendingSell.status, 'finished-awaiting-balance'); assert.equal(h.S.trades.length, 0);
  h.setBalance(60_000_000n);
  assert.equal(await h.api.reconcileSell(h.token, h.st, h.W), true);
  assert.equal(h.st.pendingSell, undefined); assert.equal(h.st.done2[0], 'back'); assert.equal(h.S.trades.length, 1);
  await h.api.reconcileSell(h.token, h.st, h.W); assert.equal(h.S.trades.length, 1);
});

test('actual pending recovery and residual sell persist moon metadata without applying it before receipts', async () => {
  let h = executionHarness();
  await h.api.sell(h.token, h.st, 40_000_000n, 'back', h.W, { id: 'back', full: false, moonReserveUnits: '12000000' });
  assert.equal(h.st.pendingSell.action.moonReserveUnits, '12000000'); assert.equal(h.st.moon, undefined); assert.deepEqual(h.st.done2, []);
  h = executionHarness({ status: 'FINISHED', after: 60_000_000n, receiptOut: 40_000_000n, seed: structuredClone(h.st) });
  await h.api.reconcileSell(h.token, h.st, h.W);
  assert.equal(h.st.moon, '12000000'); assert.equal(h.st.done2[0], 'back'); assert.equal(h.seen.swaps.length, 0);
  h.setStatus('PENDING');
  await h.api.sell(h.token, h.st, 48_000_000n, 'crash', h.W, { id: 'crash', full: false, moonOnlyAfter: true });
  assert.equal(h.st.pendingSell.action.moonOnlyAfter, true); assert.equal(h.st.moonOnly, undefined);
  h = executionHarness({ status: 'FINISHED', after: 12_000_000n, receiptOut: 48_000_000n, seed: structuredClone(h.st) });
  await h.api.reconcileSell(h.token, h.st, h.W);
  assert.equal(h.st.moonOnly, true); assert.equal(h.st.moon, '12000000'); assert.notEqual(h.st.stage, 9); assert.notEqual(h.st.done, true); assert.equal(h.seen.swaps.length, 0);
});

test('actual automatic sell rechecks reduced balance against moon units while explicit manual sales may override', async () => {
  const seed = { done2: ['back'], moon: '970', pricePeak: 20, drawdownHits: 2 };
  const planned = plan({ state: seed, balance: 4850n, value: 3.88, referenceValue: 8, rules: DEFAULT_RULES });
  assert.equal(planned.id, 'crash'); assert.equal(planned.amount, 3880n);
  // The second case still has enough total units, but would spend reserved units.
  for (const reducedBalance of [1000n, 4000n]) {
    const h = executionHarness({ decimals: 0, seed });
    h.setBalance(reducedBalance);
    assert.equal(await h.api.sell(h.token, h.st, planned.amount, planned.reason, h.W, planned), false);
    assert.equal(h.seen.swaps.length, 0); assert.equal(h.st.submissionIntent, undefined); assert.equal(h.st.pendingSell, undefined);
    assert.equal(h.st.moon, '970'); assert.match(h.st.reason, /余额已变化/);
  }
  for (const id of ['manualFull', 'sellNow']) {
    const h = executionHarness({ decimals: 0, seed }); h.setBalance(1000n);
    await h.api.sell(h.token, h.st, 3880n, 'explicit user sale', h.W, { id, full: true });
    assert.equal(h.seen.swaps.length, 1);
    assert.equal(h.seen.swaps[0][h.seen.swaps[0].indexOf('--fromTokenQty') + 1], '1000');
    assert.equal(h.st.pendingSell.action.id, id);
  }
});

test('actual FAILED or ambiguous submissions never advance stages; unknown intent blocks retries', async () => {
  const failed = executionHarness({ status: 'FAILED' });
  await failed.api.sell(failed.token, failed.st, 40_000_000n, 'test', failed.W, { id: 'back', full: false });
  assert.equal(failed.st.pendingSell, undefined); assert.deepEqual(failed.st.done2, []); assert.equal(failed.S.trades.length, 0);
  for (const submit of [async () => ({ t: 'timeout', j: { success: false, error: { name: 'TIMEOUT' } } }), async () => { throw new Error('response interrupted'); }, async () => ({ t: 'missing order', j: { success: true, data: {} } })]) {
    const h = executionHarness({ submit });
    await h.api.sell(h.token, h.st, 40_000_000n, 'test', h.W, { id: 'back', full: false });
    assert.ok(h.st.submissionIntent); assert.equal(h.st.eligibility, 'blocked');
    await h.api.sell(h.token, h.st, 40_000_000n, 'test', h.W, { id: 'back', full: false });
    assert.equal(h.seen.swaps.length, 1); assert.deepEqual(h.st.done2, []);
  }
});

test('partial fills and concurrent deposits require manual review and cannot trigger an oversized retry', async () => {
  for (const after of [80_000_000n, 100_000_000n]) {
    const h = executionHarness({ status: 'FINISHED', after, receiptOut: 30_000_000n, refund: [{ tokenAddress, amount: '20' }] });
    assert.equal(await h.api.sell(h.token, h.st, 50_000_000n, 'test', h.W, { id: 'back', full: false }), false);
    assert.equal(h.st.sellReviewRequired, true); assert.deepEqual(h.st.done2, []); assert.equal(h.S.trades.length, 0);
    assert.equal(h.st.sellReview.receiptOutUnits, '30000000');
    await h.api.sell(h.token, h.st, 50_000_000n, 'test', h.W, { id: 'back', full: false });
    assert.equal(h.seen.swaps.length, 1);
  }
});

test('a missing receipt cannot confirm a sale from a coincidental wallet balance decrease', async () => {
  const h = executionHarness({ status: 'FINISHED', after: 50_000_000n, missingReceipt: true });
  await h.api.sell(h.token, h.st, 50_000_000n, 'test', h.W, { id: 'back', full: false });
  assert.equal(h.st.pendingSell.status, 'finished-awaiting-receipt'); assert.deepEqual(h.st.done2, []); assert.equal(h.S.trades.length, 0);
});

test('a failed durable intent write prevents the swap request', async () => {
  const h = executionHarness({ storageFail: true });
  await h.api.sell(h.token, h.st, 50_000_000n, 'test', h.W, { id: 'back', full: false });
  assert.equal(h.seen.swaps.length, 0); assert.deepEqual(h.st.done2, []);
});

test('actual sell uses 6/9/18 decimals exactly and refuses unknown precision', async () => {
  for (const decimals of [6, 9, 18]) {
    const h = executionHarness({ decimals });
    await h.api.sell(h.token, h.st, 1n, 'test', h.W);
    assert.equal(h.seen.swaps[0][h.seen.swaps[0].indexOf('--fromTokenQty') + 1], formatTokenAmount(1n, decimals));
  }
  const h = executionHarness({ missingDecimals: true });
  await h.api.sell(h.token, h.st, 1n, 'test', h.W);
  assert.equal(h.seen.swaps.length, 0); assert.equal(h.st.sellStatus, 'unknown-decimals');
});

test('actual holdW honors modified thresholds and describes free dust without submitting', async () => {
  const h = executionHarness({ ruleOverrides: { backX: 4 } });
  await h.api.holdW(h.W, 1000, false); assert.equal(h.seen.swaps.length, 0);
  h.context.RULE.backX = 3;
  await h.api.holdW(h.W, 1000, false); assert.equal(h.seen.swaps.length, 1); assert.equal(h.st.pendingSell.action.id, 'back');
  const dust = executionHarness({ cost: 0, value: 0.004, seed: { pricePeak: 0.013, fpeak: 0.013, freePricePeak: 0.013, openAt: Date.now() - 600000 } });
  await dust.api.holdW(dust.W, 1000, false);
  assert.equal(dust.seen.swaps.length, 0); assert.equal(dust.st.eligibility, 'below-free-minimum');
});
