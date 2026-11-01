import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { getPaidConfig, withinPaidBudget } from '../lib/config.mjs';
import { decodeAbiUint } from '../lib/nft-codec.mjs';

// Evaluate the real balance-call boundary and USDT orchestration with in-memory
// doubles. No fetch, wallet process, filesystem writer or real timer is exposed.
const source = readFileSync(new URL('../watch.mjs', import.meta.url), 'utf8');
const extract = (start, end) => {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a, `scanner extraction markers must exist: ${start}`);
  return source.slice(a, b);
};
const body = extract('const call =', 'const big =') + extract('async function executeUsdtMintInner(', '// 鑄造進度：');
const ADDRESS = '0x' + '1'.repeat(40), TARGET = '0x' + '2'.repeat(40);
const USDT = '0x55d398326f99059ff775485246999027b3197955';
const word = value => BigInt(value).toString(16).padStart(64, '0');
const abi = value => '0x' + word(value), unit = 10n ** 18n;

function fixture(balanceResults) {
  const responses = [...balanceResults], seen = { balanceReads: 0, swaps: [], previews: [], reserves: [], settles: [], blocks: [], releases: [], saves: [], sleeps: 0 };
  const W = { id: 'wallet-a', addr: ADDRESS, profile: { id: 'wallet-a', address: ADDRESS } };
  const S = { paidSpend: { day: 'mock-day', [W.id]: 0.005 }, walletPending: {} };
  const reservations = new Map();
  const budget = {
    async reserve(request) {
      const reservation = { id: 'original-reservation', amountWei: String(request.amountWei), amountUsdMicros: request.amountUsdMicros };
      seen.reserves.push(reservation); reservations.set(reservation.id, reservation); return reservation;
    },
    async settle(id, value) { seen.settles.push({ id, ...value }); reservations.delete(id); },
  };
  const sandbox = {
    S, USDT, NATIVE_BNB: '0x' + 'e'.repeat(40), DIR: '/isolated', decodeAbiUint, withinPaidBudget,
    paidFor: () => getPaidConfig({ paid: { maxUsd: 20, maxBnbPerDay: 1, keepBnb: .006 } }),
    validMintAddress: value => /^0x[0-9a-f]{40}$/i.test(value), validMintCalldata: value => /^0x[0-9a-f]{8}$/i.test(value), badSel: () => false,
    mintUint: BigInt, bnbUsd: async () => 1000, resetPaidBudgetDay: () => S.paidSpend,
    async rpc(method, params) {
      if (method === 'eth_getBalance') return '0xde0b6b3a7640000';
      assert.equal(method, 'eth_call'); assert.equal(params[0].to, USDT); assert.equal(params[0].data, '0x70a08231' + word(BigInt(ADDRESS)));
      seen.balanceReads++;
      assert.ok(responses.length, 'an extra balance poll must not escape the supplied responses');
      const result = responses.shift(); if (result instanceof Error) throw result; return result;
    },
    safeAddrs: async (_wallet, _to, data) => data, MINT_RISK: { projectCheck: async () => ({ nft: false }) }, mintQuantity: () => 1,
    quoteAutomaticParticipation: async () => ({ project: TARGET }),
    MINT_PARTICIPATION: { reserve: () => 'original-participation', release: id => { seen.releases.push(id); } },
    scannerBudget: () => budget, currentRuntimeConfig: () => ({}),
    bnbBudgetWei: value => BigInt(Math.round(value * 1e9)) * 1000000000n, usdBudgetMicros: value => String(Math.ceil(value * 1e6)),
    wa: value => value.slice(2).padStart(64, '0'), w: word,
    async runPaidCommand(wallet, args, amountWei) {
      assert.equal(args[0], 'market-order'); assert.equal(args[1], 'swap');
      const scope = wallet.paidReservation; seen.scope = scope; seen.swaps.push({ args, amountWei });
      scope.spentWei += amountWei; scope.spentUsdMicros += BigInt(sandbox.usdBudgetMicros(Number(amountWei) / 1e18 * scope.price));
      S.walletPending[wallet.id] = { reservationId: scope.reservation.id, participationId: scope.participationId, phase: 'verified', kind: 'market-order', orderId: 'original-swap-order' };
      return { j: { success: true, data: { orderId: 'original-swap-order' } } };
    },
    save(force) { seen.saves.push({ force, state: structuredClone(S) }); }, async sleep() { seen.sleeps++; },
    async markWalletBlocked(wallet, reason, options) { seen.blocks.push({ walletId: wallet.id, reason, ...options }); },
    async previewExec(_wallet, to, data) { seen.previews.push({ to, data }); return { tx: 'mock-mint' }; },
    approvalSimulationCheck: () => null, mintSimulationCheck: () => null, revokeOnFail: async (_wallet, _token, _spender, work) => work(),
  };
  vm.runInNewContext(body + '\nglobalThis.run = executeUsdtMintInner;', sandbox);
  return { W, S, seen, reservations, run: () => sandbox.run(W, { to: TARGET, data: '0x12345678', need: 10n * unit }) };
}

for (const [name, result] of [['RPC failure', new Error('mock rate limit')], ['missing result', undefined], ['null', null], ['empty data', '0x'], ['short word', '0x00'], ['oversized data', abi(1) + word(0)]]) {
  test(`unknown initial USDT balance (${name}) stops before reserving or performing any wallet action`, async () => {
    const h = fixture([result]);
    await assert.rejects(h.run(), /无法核验 USDT 余额.*未执行/);
    assert.equal(h.seen.balanceReads, 1); assert.equal(h.seen.reserves.length, 0); assert.equal(h.seen.swaps.length, 0); assert.equal(h.seen.previews.length, 0);
    assert.equal(h.seen.blocks.length, 0); assert.equal(h.seen.settles.length, 0); assert.equal(h.S.paidSpend[h.W.id], .005); assert.deepEqual(h.S.walletPending, {});
  });
}

for (const [name, result] of [['RPC failure', new Error('mock rate limit')], ['null', null], ['empty data', '0x'], ['short word', '0x01']]) {
  test(`unknown USDT balance after a confirmed swap (${name}) retains the original reservation and blocks further actions`, async () => {
    const h = fixture([abi(4n * unit), result]);
    await assert.rejects(h.run(), /結果不明.*换币后无法核验 USDT 余额/);
    assert.equal(h.seen.swaps.length, 1); assert.equal(h.seen.balanceReads, 2); assert.equal(h.seen.sleeps, 1); assert.equal(h.seen.previews.length, 0);
    assert.equal(h.seen.scope.unknown, true); assert.equal(h.seen.scope.spentWei, h.seen.swaps[0].amountWei);
    assert.ok(h.reservations.has('original-reservation')); assert.equal(h.seen.settles.length, 0); assert.equal(h.seen.releases.length, 0);
    assert.equal(h.S.walletPending[h.W.id].orderId, 'original-swap-order'); assert.equal(h.S.walletPending[h.W.id].reservationId, 'original-reservation');
    assert.equal(h.seen.blocks.length, 1); assert.equal(h.seen.blocks[0].details.reservationId, 'original-reservation');
    assert.ok(h.S.paidSpend[h.W.id] >= .005 + Number(h.seen.swaps[0].amountWei) / 1e18); assert.equal(h.seen.saves.at(-1).force, true);
    assert.equal(h.W.paidReservation, undefined, 'only the transient execution context is removed');
  });
}

test('a genuine zero balance still allows exactly one swap, then approval and mint after a valid balance arrives', async () => {
  const h = fixture([abi(0), abi(10n * unit)]); await h.run();
  assert.equal(h.seen.swaps.length, 1); assert.equal(h.seen.balanceReads, 2); assert.equal(h.seen.previews.length, 2);
  assert.equal(h.seen.settles.length, 1); assert.equal(h.reservations.size, 0); assert.equal(h.seen.blocks.length, 0); assert.deepEqual(h.S.walletPending, {});
});

test('a sufficient valid USDT balance preserves the existing no-recharge path', async () => {
  const h = fixture([abi(10n * unit)]); await h.run();
  assert.equal(h.seen.swaps.length, 0); assert.equal(h.seen.previews.length, 2); assert.equal(h.seen.settles.length, 1); assert.equal(h.seen.blocks.length, 0);
});
