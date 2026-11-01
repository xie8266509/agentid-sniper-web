// Exercise the actual paidLoop with isolated RPC/CLI doubles; no wallet process or
// external network can be started by this harness.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { getPaidConfig, withinPaidBudget } from '../lib/config.mjs';
import { marketOrderRecord, marketOrderState } from '../lib/sell-rules.mjs';
import { scannerRuntimeDouble } from './watch-runtime-fixture.mjs';
import { createMintRisk, effectiveEntryPolicy, entryGate } from '../lib/mint-policy.mjs';
import { decodeAbiUint } from '../lib/nft-codec.mjs';
import { id as signatureHash } from 'ethers';

const raw = readFileSync(new URL('../watch.mjs', import.meta.url), 'utf8');
const extract = (start, end) => { const a = raw.indexOf(start), b = raw.indexOf(end, a); assert.ok(a >= 0 && b > a, `missing scanner markers: ${start}`); return raw.slice(a, b); };
const usdtSource = extract('async function executeUsdtMint(W,', '// 鑄造進度：');
const loopSource = extract('let SCANNER_BUDGET;', 'function prepareUsdtReplay(') + extract('function entryFor(', '// ---------- 持倉') + extract('const heatTier =', '\nasync function loginCheck()');
const target = '0x2222222222222222222222222222222222222222';
const addr = '0x1111111111111111111111111111111111111111';
const word = (value) => BigInt(value).toString(16).padStart(64, '0');
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
const limitSelector = signatureHash('maxPerWallet()').slice(0, 10);

function isolatedLoop(kind, { maxUsd = 20, maxBnbPerDay = 0.05, spent = 0, topUpNeverArrives = false } = {}) {
  const seen = { previews: [], swaps: 0, saves: 0, logs: [] };
  const P = { at: Date.now(), name: 'TEST', done: {}, agents: 175, old: false };
  if (kind === 'replay') P.replay = { value: (10n ** 16n).toString(), data: '0x12345678', sampleValue: (10n ** 16n).toString(), sampleData: '0x12345678' };
  if (kind === 'recv') P.recvValue = (10n ** 16n).toString();
  const codes = { replay: '0x', recv: '0x', gen: '0xa0712d688d859f3e', bnb: '0xe38fd34968bce8cd', usdt: '0x725c405894bf804d' };
  const W = { id: 'test-wallet', name: 'test-wallet', profile: { id: 'test-wallet', address: addr }, addr, async baw(args) {
    assert.equal(args[0], 'market-order'); assert.equal(args[1], 'swap');
    seen.swaps++;
    return { j: { success: true, data: { txHash: '0x' + 'ab'.repeat(32) } } };
  } };
  const S = { paid: { [target]: P }, agentsV: 2, mintPolicy: { wallets: {} }, dyn: [], migrated2: 1, paidSpend: { day: today(), [W.name]: spent } };
  const sandbox = {
    DIR: '/isolated', MONITOR_ONLY: false, CONFIG: { timeZone: 'Asia/Shanghai' }, S,
    PAID: getPaidConfig({ paid: { maxUsd, maxBnbPerDay, keepBnb: 0.006 } }),
    ENTRY_POLICY: { version: 3, goPct: 0.65, minAgents: 115 }, effectiveEntryPolicy, entryGate, decodeAbiUint,
    WALLETS: [W], FORCE: new Set([target]), HOT: new Map(),
    INFRA: new Set(), CLAIM: new Set(), REGISTRY: '60b9262456de011f7d15a54cdd8c48baaa8b022f',
    memoC: new Map(), fpCache: new Map(),
    trackFromSim() {}, noteFree() {},
    async serialDev() { return ''; }, async fullCode(_c, code) { return code + '63590e1ae3' + limitSelector.slice(2); }, REFUND_SELS: ['590e1ae3'],
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
    USDT: '0x55d398326f99059ff775485246999027b3197955', WBNB: target, NATIVE_BNB: 'native', FACTORY: target,
    getPaidConfig, marketOrderRecord, marketOrderState, withinPaidBudget, w: word, wa: (value) => value.slice(2).padStart(64, '0'),
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
    async rpc(method, params) {
      if (method === 'eth_getTransactionReceipt') return { status: '0x1', blockNumber: '0x10', gasUsed: '0x5208', effectiveGasPrice: '0x3b9aca00' };
      if (method === 'eth_getBalance') return '0x' + word(10n ** 18n);
      if (method === 'eth_estimateGas') return '0x5208';
      if (method === 'eth_gasPrice') return '0x3b9aca00';
      if (method === 'eth_getStorageAt') return '0x' + word(0);
      if (method === 'eth_getCode') return '0x6000';
      if (method === 'eth_call' && params?.[0]?.data?.startsWith('0x70a08231')) return '0x' + word(1000n * 10n ** 18n);
      if (method === 'eth_call' && params?.[0]?.data === limitSelector) return '0x' + word(10);
      if (method === 'eth_call') return '0x';
      throw new Error('Unexpected isolated RPC ' + method);
    },
    async previewExec(wallet, to, data, value) { seen.previews.push({ to, data, value }); return { tx: 'mock-transaction' }; },
    async tg() {}, async groupProgress() {}, log(text) { seen.logs.push(text); }, ts: () => 'mock-time', save() { seen.saves++; }, async sleep() {},
  };
  sandbox.cc = async (c, data) => sandbox.call(c, data);
  Object.assign(sandbox, scannerRuntimeDouble({ sandbox, wallet: W, state: S, events: seen }));
  sandbox.MINT_RISK = createMintRisk({ state: S, rpc: (...args) => sandbox.rpc(...args), fullCode: (...args) => sandbox.fullCode(...args), save: (...args) => sandbox.save(...args), timeZone: 'Asia/Shanghai' });
  sandbox.mintUint = value => BigInt(value || 0); sandbox.validMintAddress = value => /^0x[0-9a-f]{40}$/i.test(value); sandbox.validMintCalldata = value => /^0x[0-9a-f]+$/i.test(value);
  vm.runInNewContext(extract('function mintTrackingPlan(', 'function positionFor(') + extract('function mintQuantity(', 'async function previewExec(') + loopSource + usdtSource + '\nglobalThis.run = paidLoop;', sandbox);
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
    assert.ok(isolated.seen.previews.length > 0, JSON.stringify(isolated.seen.logs));
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
