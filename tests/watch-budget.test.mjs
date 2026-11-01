// Exercise the actual paidLoop with isolated RPC/CLI doubles; no wallet process or
// external network can be started by this harness.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { getPaidConfig, withinPaidBudget } from '../lib/config.mjs';

const raw = readFileSync(new URL('../watch.mjs', import.meta.url), 'utf8');
const extract = (start, end) => { const a = raw.indexOf(start), b = raw.indexOf(end, a); assert.ok(a >= 0 && b > a, `missing scanner markers: ${start}`); return raw.slice(a, b); };
const loopSource = extract('const MINT_WALLET_QUEUE =', 'function prepareUsdtReplay(') + extract('const heatTier =', '\nasync function loginCheck()');
const target = '0x2222222222222222222222222222222222222222';
const addr = '0x1111111111111111111111111111111111111111';
const word = (value) => BigInt(value).toString(16).padStart(64, '0');
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());

function isolatedLoop(kind, { maxUsd = 20, maxBnbPerDay = 0.05, spent = 0, topUpNeverArrives = false } = {}) {
  const seen = { previews: [], swaps: 0, saves: 0 };
  const P = { at: Date.now(), name: 'TEST', done: {} };
  if (kind === 'replay') P.replay = { value: (10n ** 16n).toString(), data: '0x12345678' };
  if (kind === 'recv') P.recvValue = (10n ** 16n).toString();
  const codes = { replay: '0x', recv: '0x', gen: '0xa0712d688d859f3e', bnb: '0xe38fd34968bce8cd', usdt: '0x725c405894bf804d' };
  const W = { name: 'test-wallet', addr, async baw(args) {
    assert.equal(args[0], 'market-order'); assert.equal(args[1], 'swap');
    seen.swaps++;
    return { j: { success: true, data: {} } };
  } };
  const S = { paid: { [target]: P }, dyn: [], migrated2: 1, paidSpend: { day: today(), [W.name]: spent } };
  const sandbox = {
    MONITOR_ONLY: false, CONFIG: { timeZone: 'Asia/Shanghai' }, S,
    PAID: getPaidConfig({ paid: { maxUsd, maxBnbPerDay, keepBnb: 0.006 } }),
    WALLETS: [W], FORCE: new Set([target]), HOT: new Map(),
    INFRA: new Set(), CLAIM: new Set(), REGISTRY: '60b9262456de011f7d15a54cdd8c48baaa8b022f',
    memoC: new Map(), fpCache: new Map(),
    trackFromSim() {}, noteFree() {},
    async serialDev() { return ''; }, async fullCode(_c, code) { return code; }, REFUND_SELS: ['590e1ae3'],
    scaleV(_d0, _d1, value) { return value; },
    async progressOf() { return { progress: 0.9 }; }, async deployerOf() { return ''; },
    isRepeatDev() { return false; }, isSerial() { return false; }, async freshWallet() { return false; },
    async repeatDevOk() { return false; }, noteDev() {},
    freshDeadline: (d) => d, async fitShares(W, c, data) { return data; },
    markUnmintable() {}, queueMint() {},
    async executeUsdtMint(W, opts) { seen.previews.push({ to: opts?.to || 'usdt' }); return { tx: 'mock-usdt' }; },
    async prepareUsdtReplay() { return null; },
    mintSimulationCheck: () => null, approvalSimulationCheck: () => null,
    async honeypotCheck() { return null; },
    USDT: '0x55d398326f99059ff775485246999027b3197955', WBNB: 'wrapped', NATIVE_BNB: 'native',
    withinPaidBudget, w: word, wa: (value) => value.slice(2).padStart(64, '0'),
    badSel: () => false, async learnReplay() { return null; },
    async safeAddrs(W, c, data) { return data; }, async revokeOnFail(W, token, spender, fn) { return fn(); },
    big: (value) => value && value !== '0x' ? BigInt(value) : 0n,
    tokStr: () => '', async codeOf() { return codes[kind]; }, async findFree() { return null; },
    async bnbUsd() { return 1000; }, async poolOut() { return 0n; },
    async call(contract, data) {
      if (data === '0xa2309ff8' || data === '0x18160ddd' || data === '0x192fc516') return '0x' + word(90);
      if (data === '0xd8f93498') return '0x' + word(100);
      if (data === '0x8d859f3e') return '0x' + word(10n ** 16n);
      if (data.startsWith('0x68bce8cd')) return '0x' + word(BigInt('0x' + data.slice(10)) * 10n ** 16n);
      if (data.startsWith('0x725c4058')) return '0x' + word(BigInt('0x' + data.slice(10)) * 10n ** 18n);
      if (data.startsWith('0x70a08231')) return '0x' + word(topUpNeverArrives ? 0n : 1000n * 10n ** 18n);
      return '0x';
    },
    async rpc(method) {
      if (method === 'eth_getBalance') return '0x' + word(10n ** 18n);
      if (method === 'eth_call') return '0x';
      throw new Error('Unexpected isolated RPC ' + method);
    },
    async previewExec(wallet, to, data, value) { seen.previews.push({ to, data, value }); return { tx: 'mock-transaction' }; },
    async tg() {}, async groupProgress() {}, log() {}, ts: () => 'mock-time', save() { seen.saves++; }, async sleep() {},
  };
  sandbox.cc = async (c, data) => sandbox.call(c, data);
  vm.runInNewContext(loopSource + '\nglobalThis.run = paidLoop;', sandbox);
  return { run: sandbox.run, S, seen, P, W };
}

for (const kind of ['replay', 'recv', 'gen', 'bnb', 'usdt']) {
  test(`${kind}: zero and exhausted daily/project budgets prevent all transaction previews`, async () => {
    for (const settings of [{ maxBnbPerDay: 0 }, { spent: 0.05 }, { maxUsd: 0 }]) {
      const isolated = isolatedLoop(kind, settings);
      await isolated.run();
      assert.equal(isolated.seen.previews.length, 0);
      assert.equal(isolated.seen.swaps, 0);
      assert.equal(isolated.P.done[isolated.W.name], undefined);
    }
  });
  test(`${kind}: allowed acquisition consumes per-wallet daily budget`, async () => {
    const isolated = isolatedLoop(kind);
    await isolated.run();
    assert.ok(isolated.seen.previews.length > 0);
    assert.equal(isolated.P.done[isolated.W.name], 'minted');
    assert.ok(isolated.S.paidSpend[isolated.W.name] > 0);
    assert.ok(isolated.S.paidSpend[isolated.W.name] <= 0.05);
  });
}

test('successful USDT top-up remains counted when the later acquisition cannot complete', async () => {
  const isolated = isolatedLoop('usdt', { topUpNeverArrives: true });
  await isolated.run();
  assert.equal(isolated.seen.swaps, 1);
  assert.equal(isolated.seen.previews.length, 0);
  assert.equal(isolated.P.done[isolated.W.name], undefined);
  assert.ok(isolated.S.paidSpend[isolated.W.name] > 0);
  assert.ok(isolated.seen.saves > 0);
});
