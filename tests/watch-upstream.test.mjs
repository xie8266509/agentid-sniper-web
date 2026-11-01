import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { getPaidConfig, withinPaidBudget } from '../lib/config.mjs';

// Only evaluate the reviewed function bodies. Every RPC, CLI, file, and Telegram
// dependency is an isolated double; no real wallet or network can be reached.
const source = readFileSync(new URL('../watch.mjs', import.meta.url), 'utf8');
const extract = (start, end) => {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a, `scanner test extraction markers must exist: ${start} → ${end}`);
  return source.slice(a, b);
};
const helpers = extract('const validMintAddress =', '// 鑄造進度：');
const addressSafety = extract('async function readLimit(', 'async function previewExec(');
const autoMint = extract('async function autoMint(c,', '// ---------- AIDROP');
const learner = extract('async function learnReplay(', 'async function repeatDevOk(');
const paid = extract('const heatTier =', '\nasync function loginCheck()');
const manual = extract('function validateFileJob(', '// ── TG 指令');
const walletAddress = '0x1111111111111111111111111111111111111111';
const target = '0x2222222222222222222222222222222222222222';
const reward = '0x3333333333333333333333333333333333333333';
const USDT = '0x55d398326f99059ff775485246999027b3197955';
const BNB = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const word = (value) => BigInt(value).toString(16).padStart(64, '0');
const transferTopic = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const bad = new Set(['0xa9059cbb', '0x095ea7b3', '0x23b872dd', '0x42842e0e', '0xb88d4fde', '0xa22cb465', '0x39509351', '0xd505accf', '0xf242432a', '0x2eb2c2d6']);

function harness(options = {}) {
  let clock = Date.now();
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [clock])); } static now() { return clock; } }
  const events = { previews: [], swaps: [], writes: [], logs: [], reads: 0, learned: 0 };
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Clock());
  const P = { at: clock, name: 'TEST', done: {}, old: false, wallets: 20, ph: [], replay: { data: '0x12345678', value: '0', payTok: USDT, payAmt: String(10n * 10n ** 18n), hot: 15, learned: 1, learnedAt: clock } };
  const S = { paid: { [target]: P }, dyn: [], migrated2: 1, paidSpend: { day, test: options.spent || 0 }, seenMints: {} };
  const W = { name: 'test', addr: walletAddress, async baw(args) { events.swaps.push(args); return { j: { success: true } }; } };
  const balanceChanges = options.noReward ? [] : [{ owner: walletAddress, contractAddress: reward, change: '1', tokenType: 'Erc20' }];
  const sandbox = {
    Date: Clock, MONITOR_ONLY: options.monitorOnly === true, FILE_COMMANDS_ENABLED: options.fileEnabled === true, MONITOR_NOTE: '仅监控',
    CONFIG: { timeZone: 'Asia/Shanghai' }, PAID: getPaidConfig({ paid: { maxUsd: options.maxUsd ?? 20, maxBnbPerDay: options.maxBnbPerDay ?? 0.05, keepBnb: 0.006 } }),
    S, WALLETS: [W], FORCE: new Set(options.hotGo ? [] : [target]), HOT: new Map(),
    USDT, NATIVE_BNB: BNB, WBNB: reward, FACTORY: reward, T_TRANSFER: transferTopic,
    CANDS: [['mint-test', '0x12345678']], INFRA: new Set(), CLAIM: new Set(), REGISTRY: '60b9262456de011f7d15a54cdd8c48baaa8b022f',
    withinPaidBudget, w: word, wa: (a) => a.slice(2).padStart(64, '0'), big: (value) => value && value !== '0x' ? BigInt(value) : 0n,
    badSel: (data) => bad.has(String(data || '').slice(0, 10).toLowerCase()), tokStr: () => '',
    async bnbUsd() { if (options.hotGo) clock += 240000; return 1000; },
    async codeOf() { return '0x'; }, async findFree() { return null; },
    fpCache: new Map(),
    async freeProgress() { return options.freeProgress === undefined ? 0.9 : options.freeProgress; },
    async serialDev() { return options.serialReason || ''; },
    async fullCode() { return options.refund === false ? '0x' : '0x63590e1ae3'; },
    async poolOpen() { return options.poolOpen === true; },
    trackFromSim() {}, noteFree() {}, MQ: new Map(),
    async autoMintMax(c, name, wallet, value) { return sandbox.api.autoMint(c, name, wallet, value); },
    async progressOf() { return { progress: 0 }; }, async deployerOf() { return ''; }, isRepeatDev() { return false; }, isSerial() { return false; },
    async logsRpc(params) { return sandbox.rpc('eth_getLogs', params); },
    async poolOut() { return 0n; }, async groupProgress() {}, async tg() {}, async tgSay() {}, async sleep() {},
    ts: () => 'mock-time',
    log(text) { events.logs.push(text); }, save() { events.writes.push('state'); },
    async rpc(method) {
      if (options.rpc) return options.rpc(method, events);
      if (method === 'eth_getBalance') return '0x' + word(10n ** 18n);
      if (method === 'eth_getBlockNumber' || method === 'eth_blockNumber') return '0x1000';
      if (method === 'eth_call') return '0x';
      if (method === 'eth_getLogs') return [];
      throw new Error('Unmocked RPC ' + method);
    },
    async call(contract, data) {
      if (options.contractCall) { const result = await options.contractCall(contract, data); if (result !== undefined) return result; }
      if (data.startsWith('0x70a08231')) {
        const toppedUp = options.usdtArrives && events.swaps.length;
        return '0x' + word(toppedUp ? 1000n * 10n ** 18n : options.usdtBalance ?? 1000n * 10n ** 18n);
      }
      if (options.hotGo) return '0x' + word(0);
      if (data === '0x192fc516') return '0x' + word(90);
      if (data === '0xd8f93498') return '0x' + word(100);
      return '0x';
    },
    async previewExec(wallet, to, data, value, check) {
      events.previews.push({ to, data, value });
      const sim = to === USDT ? { balanceChanges: [], allowanceChanges: [{ spender: target, owner: walletAddress, contractAddress: USDT }], authorityChanges: [] } : { balanceChanges, allowanceChanges: [], authorityChanges: [] };
      const reason = check(sim); if (reason) throw new Error(reason);
      return { tx: 'mock-transaction', sim };
    },
    DIR: '/isolated', join: (...args) => args.join('/'),
    existsSync: () => true,
    readFileSync() { events.reads++; return JSON.stringify(options.jobs ?? []); },
    writeFileSync(path, data) { events.writes.push({ path, data }); },
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(helpers + addressSafety + learner + paid + manual + autoMint + (options.realPreview ? extract('async function previewExec(', 'async function poolOut(') : '') + (options.withQueue ? extract('const MQK =', '// 每個錢包可以打多份的') : '') + '\nglobalThis.api = { executeUsdtMint, prepareUsdtReplay, mintSimulationCheck, approvalSimulationCheck, validateFileJob, manualMints, paidLoop, learnReplay, safeAddrs, revokeOnFail, hasPositiveMintGain, autoMint, previewExec, queueMint: typeof queueMint === \'function\' ? queueMint : null };', context);
  return { api: sandbox.api, context, sandbox, events, P, S, W };
}

test('USDT replay: zero/daily/project budgets block before approve or swap', async () => {
  for (const options of [{ maxBnbPerDay: 0 }, { maxUsd: 0 }, { spent: 0.05 }]) {
    const h = harness(options);
    await assert.rejects(h.api.executeUsdtMint(h.W, { to: target, data: '0x12345678', need: 10n ** 18n }), /预算/);
    assert.equal(h.events.previews.length, 0); assert.equal(h.events.swaps.length, 0);
  }
  const h = harness();
  await assert.rejects(h.api.executeUsdtMint(h.W, { to: target, data: '0x12345678', need: 10n ** 18n, value: 2n * 10n ** 16n }), /单笔预算/);
  assert.equal(h.events.previews.length, 0);
});

test('existing USDT consumes daily acquisition quota without requiring its value in native BNB', async () => {
  const h = harness({ spent: 0.005 });
  await h.api.executeUsdtMint(h.W, { to: target, data: '0x12345678', need: 10n * 10n ** 18n });
  assert.ok(Math.abs(h.S.paidSpend.test - 0.015) < 1e-12);
  assert.equal(h.events.swaps.length, 0); assert.equal(h.events.previews.length, 2);
});

test('the learned-USDT paidLoop branch uses the checked mint helper', async () => {
  const h = harness();
  await h.api.paidLoop();
  assert.equal(h.P.done.test, 'minted');
  assert.equal(h.events.previews.length, 2);
  assert.ok(Math.abs(h.S.paidSpend.test - 0.01) < 1e-12);
});

test('USDT recharge is persisted when funds never arrive or mint simulation fails', async () => {
  for (const options of [{ usdtBalance: 0n }, { usdtBalance: 0n, usdtArrives: true, noReward: true }]) {
    const h = harness(options);
    await assert.rejects(h.api.executeUsdtMint(h.W, { to: target, data: '0x12345678', need: 10n * 10n ** 18n }), /未到账|没有获得/);
    assert.equal(h.events.swaps.length, 1);
    assert.ok(Math.abs(h.S.paidSpend.test - 0.0104) < 1e-12);
    assert.ok(h.events.writes.includes('state'));
  }
});

test('replay quantity scaling includes 5% allowance and native BNB in the strict project cap', () => {
  const h = harness();
  const replay = { data: '0x12345678' + word(1) + word(0) + word(2n * 10n ** 18n), payAmt: String(2n * 10n ** 18n), value: String(2n * 10n ** 15n) };
  const result = h.api.prepareUsdtReplay(replay, 20, 1000);
  assert.ok(result); assert.ok(Number(result.need) / 1e18 + Number(result.value) / 1e18 * 1000 <= 20);
  assert.ok(BigInt('0x' + result.data.slice(10, 74)) <= 10n);
  assert.equal(h.api.prepareUsdtReplay({ ...replay, data: '0xa9059cbb' + word(0) }, 20, 1000), null);
});

test('new mint simulation rejects missing gains, unexpected assets, excess BNB/USDT and authorization changes', () => {
  const h = harness(), gain = { owner: walletAddress, contractAddress: reward, change: '1' };
  const check = (changes, extra = {}) => h.api.mintSimulationCheck({ balanceChanges: changes, ...extra }, h.W, { bnbWei: 10n, usdtWei: 20n });
  assert.equal(check([gain]), '');
  assert.match(check([]), /没有获得/);
  assert.match(check([gain], { allowanceChanges: [{}] }), /授权/);
  assert.match(check([gain], { authorityChanges: [{}] }), /权限/);
  assert.match(check([gain, { owner: walletAddress, contractAddress: reward, change: '-1' }]), /预期以外/);
  assert.match(check([gain, { owner: walletAddress, contractAddress: BNB, change: '-11' }]), /超过/);
  assert.match(check([gain, { owner: walletAddress, contractAddress: USDT, change: '-21' }]), /超过/);
  assert.match(h.api.approvalSimulationCheck({ balanceChanges: [], allowanceChanges: [{ spender: reward }] }, h.W, target), /对象不符/);
});

test('file queues remain unread and unconsumed when disabled or in monitor mode', async () => {
  for (const options of [{ fileEnabled: false }, { monitorOnly: true, fileEnabled: true }]) {
    const h = harness({ ...options, jobs: [{ c: target, data: '0x12345678' }] });
    await h.api.manualMints();
    assert.equal(h.events.reads, 0); assert.equal(h.events.writes.length, 0);
    assert.equal(h.events.previews.length, 0); assert.equal(h.events.swaps.length, 0);
  }
});

test('file queues reject legacy schemas, unknown fields, unsafe calldata and quantities over ten without clearing', async () => {
  const template = { schemaVersion: 1, c: target, data: '0x12345678', n: 1 };
  for (const job of [{ c: target, data: '0x12345678' }, { ...template, arbitrary: true }, { ...template, n: 11 }, { ...template, c: '0x123' }, { ...template, data: '0xa9059cbb' + word(0) }]) {
    const h = harness({ fileEnabled: true, jobs: [job] });
    await h.api.manualMints();
    assert.equal(h.events.writes.length, 0); assert.equal(h.events.previews.length, 0); assert.equal(h.events.swaps.length, 0);
  }
});

test('unlearned replay records refresh, and hot fallback without a usable history base does not throw', async () => {
  const h = harness({ hotGo: true });
  h.P.replay = { data: '0x12345678', value: String(10n ** 16n) }; h.P.ph = [];
  h.P.agents = 100; h.P.burst = 15; // unreadable progress requires 100 verified Agent ID wallets
  h.sandbox.learnReplay = async () => { h.events.learned++; return { data: '0x12345678', value: String(10n ** 16n), hot: 15, learned: 1, learnedAt: h.sandbox.Date.now() }; };
  await h.api.paidLoop();
  assert.equal(h.events.learned, 1);
  assert.equal(h.P.done.test, 'minted');
  assert.ok(h.events.logs.some((line) => /很熱|進場|超熱|熱/.test(line)));
});

test('learning ignores transfer/approval selectors and unsuccessful transaction receipts', async () => {
  const from = '0x4444444444444444444444444444444444444444';
  const h = harness({ rpc(method) {
    if (method === 'eth_blockNumber') return '0x1000';
    if (method === 'eth_getLogs') return [{ transactionHash: 'approve' }, { transactionHash: 'transfer' }, { transactionHash: 'failed' }, { transactionHash: 'mint' }];
    throw new Error('Use custom transaction fixture');
  } });
  h.sandbox.rpc = async (method, params) => {
    if (method === 'eth_blockNumber') return '0x1000';
    if (method === 'eth_getLogs') return ['approve', 'transfer', 'failed', 'mint'].map((transactionHash) => ({ transactionHash }));
    if (method === 'eth_getTransactionByHash') return { hash: params[0], from, to: target, input: params[0] === 'approve' ? '0x095ea7b3' + word(0) : params[0] === 'transfer' ? '0xa9059cbb' + word(0) : '0x12345678' + word(1), value: '0x0', blockNumber: '0x1000' };
    if (method === 'eth_getTransactionReceipt') return { status: params[0] === 'failed' ? '0x0' : '0x1', logs: [] };
    throw new Error('Unmocked learner RPC');
  };
  const learned = await h.api.learnReplay(target);
  assert.ok(learned); assert.equal(learned.data.slice(0, 10), '0x12345678');
});

test('foreign calldata addresses are replaced with this wallet or zero, preserving trailing bytes', async () => {
  const foreign = '0x4444444444444444444444444444444444444444';
  const data = '0x12345678' + foreign.slice(2).padStart(64, '0') + 'abcd';
  for (const rejectSelf of [false, true]) {
    const h = harness(), attempts = [];
    h.sandbox.rpc = async (method, params) => { assert.equal(method, 'eth_call'); attempts.push(params[0].data); if (rejectSelf && attempts.length === 1) throw new Error('self unsupported'); return '0x'; };
    const rewritten = await h.api.safeAddrs(h.W, target, data, 0n);
    const expected = rejectSelf ? '0'.repeat(64) : walletAddress.slice(2).padStart(64, '0');
    assert.equal(rewritten, '0x12345678' + expected + 'abcd');
    assert.equal(attempts.length, rejectSelf ? 2 : 1);
  }
  const h = harness(); h.sandbox.rpc = async () => { throw new Error('unsupported'); };
  await assert.rejects(h.api.safeAddrs(h.W, target, data, 0n), /都无法执行/);
});

test('a failed mint revokes only the intended approval and keeps the original failure', async () => {
  const h = harness(), original = new Error('mint failed');
  await assert.rejects(h.api.revokeOnFail(h.W, USDT, target, async () => { throw original; }), (error) => error === original);
  assert.equal(h.events.previews.length, 1);
  assert.equal(h.events.previews[0].to, USDT);
  assert.equal(h.events.previews[0].data, '0x095ea7b3' + target.slice(2).padStart(64, '0') + word(0));
  assert.ok(h.events.logs.some((line) => line.includes('已撤销')));
  let unsafeRevokeExecuted = false;
  h.sandbox.previewExec = async (_wallet, _to, _data, _value, check) => {
    const reason = check({ balanceChanges: [], allowanceChanges: [{ spender: reward }] });
    if (reason) throw new Error(reason);
    unsafeRevokeExecuted = true;
  };
  await assert.rejects(h.api.revokeOnFail(h.W, USDT, target, async () => { throw original; }), (error) => error === original);
  assert.equal(unsafeRevokeExecuted, false);
});

test('free mint does not execute for zero net gains or assets received by another wallet; positive NFT passes', async () => {
  const seedHot = (h) => { h.sandbox.HOT.set(target, { from: new Set(Array.from({ length: 15 }, (_, i) => '0x' + String(i).padStart(40, '0'))) }); };
  for (const changes of [[], [{ owner: walletAddress, contractAddress: reward, change: '0', tokenType: 'Erc20' }], [{ owner: walletAddress, contractAddress: reward, change: '0', tokenType: 'Erc721' }], [{ owner: target, contractAddress: reward, change: '1', tokenType: 'Erc721' }]]) {
    const h = harness(); seedHot(h); let executes = 0;
    h.W.baw = async (args) => {
      if (args[1] === 'execute') { executes++; return { j: { success: true, data: {} } }; }
      return { j: { success: true, data: { requestId: 'mock-preview', simulationResult: { balanceChanges: changes, allowanceChanges: [], authorityChanges: [] } } } };
    };
    const result = await h.api.autoMint(target, 'mint-test', h.W, 0n);
    assert.equal(executes, 0); assert.match(result, /没有铸|沒有鑄/);
  }
  const h = harness(); seedHot(h); let executes = 0;
  h.W.baw = async (args) => {
    if (args[1] === 'execute') { executes++; return { j: { success: true, data: { txHash: 'mock' } } }; }
    return { j: { success: true, data: { requestId: 'mock-preview', simulationResult: { balanceChanges: [{ owner: walletAddress, contractAddress: reward, change: '1', tokenType: 'Erc721' }], allowanceChanges: [], authorityChanges: [] } } } };
  };
  assert.match(await h.api.autoMint(target, 'mint-test', h.W, 0n), /^🤖/);
  assert.equal(executes, 1);
});

function attachMintWallet(h, { executeResult } = {}) {
  const calls = [];
  h.W.baw = async (args) => {
    calls.push(args);
    if (args[1] === 'execute') return executeResult || { j: { success: true, data: { txHash: 'mock-fee-mint' } } };
    return { j: { success: true, data: { requestId: 'mock-mint-preview', simulationResult: {
      balanceChanges: [{ owner: walletAddress, contractAddress: reward, change: '1', tokenType: 'Erc721' }],
      allowanceChanges: [], authorityChanges: [],
    } } } };
  };
  return calls;
}

test('fee-bearing free mint requires refund code and full paid budgets before wallet preview', async () => {
  for (const options of [{ refund: false }, { maxUsd: 0 }, { maxBnbPerDay: 0 }, { spent: 0.05 }, { maxUsd: 0.01 }]) {
    const h = harness(options), calls = attachMintWallet(h);
    const result = await h.api.autoMint(target, 'mint-test', h.W, 10n ** 14n);
    assert.match(result, /^⏸/);
    assert.equal(calls.length, 0, JSON.stringify(options));
    assert.equal(h.P.done.test, undefined);
  }
});

test('fee-bearing free mint accounts native payment in the same saved daily paid budget', async () => {
  const h = harness({ spent: 0.005 }), calls = attachMintWallet(h);
  assert.match(await h.api.autoMint(target, 'mint-test', h.W, 10n ** 14n), /^🤖/);
  assert.equal(calls.filter(args => args[1] === 'execute').length, 1);
  assert.ok(Math.abs(h.S.paidSpend.test - 0.0051) < 1e-12);
  assert.ok(h.events.writes.length > 0, 'fee cost must be persisted rather than only accumulated in memory');
});

test('only-gas free mint remains available when paid mint budgets are zero', async () => {
  const h = harness({ maxUsd: 0, maxBnbPerDay: 0, refund: false }), calls = attachMintWallet(h);
  assert.match(await h.api.autoMint(target, 'mint-test', h.W, 0n), /^🤖/);
  assert.equal(calls.filter(args => args[1] === 'execute').length, 1);
  assert.equal(h.S.paidSpend.test, 0);
});

test('known mint progress below 60% cannot be bypassed by crowd heat; 60% can proceed', async () => {
  for (const progress of [0.01, 0.59, 0.6]) {
    const h = harness({ freeProgress: progress }), calls = attachMintWallet(h);
    h.P.agents = 1000;
    const result = await h.api.autoMint(target, 'mint-test', h.W, 0n);
    assert.equal(calls.filter(args => args[1] === 'execute').length, progress >= 0.6 ? 1 : 0);
    assert.match(result, progress >= 0.6 ? /^🤖/ : /60%/);
  }
});

test('unreadable progress requires 100 Agent ID wallets and no existing pool', async () => {
  for (const [agents, poolOpen, expected] of [[99, false, false], [100, false, true], [100, true, false]]) {
    const h = harness({ freeProgress: null, poolOpen }), calls = attachMintWallet(h);
    h.P.agents = agents;
    h.sandbox.HOT.set(target, { from: new Set(Array.from({ length: 300 }, (_, i) => 'hot-' + i)) });
    const result = await h.api.autoMint(target, 'mint-test', h.W, 0n);
    assert.equal(calls.filter(args => args[1] === 'execute').length, expected ? 1 : 0);
    assert.match(result, expected ? /^🤖/ : /^⏸/);
  }
});

test('serial deployment block applies to free and fee-bearing mint before wallet access', async () => {
  for (const value of [0n, 10n ** 14n]) {
    const h = harness({ serialReason: '同一個部署者 24 小時內部署了 10 個項目' }), calls = attachMintWallet(h);
    assert.match(await h.api.autoMint(target, 'mint-test', h.W, value), /10 個項目/);
    assert.equal(calls.length, 0);
  }
});

test('sold/cap progress reads the launchpad cap and clamps over-sold supply to full', async () => {
  for (const [sold, expected] of [[9200n, 0.92], [10246n, 1]]) {
    const h = harness({ maxUsd: 0, contractCall(_contract, data) {
      if (data === '0x192fc516') return '0x' + word(sold);
      if (data === '0xa0e23ebd') return '0x' + word(10000);
    } });
    await h.api.paidLoop();
    assert.equal(h.P.progress, expected);
    assert.equal(h.events.previews.length, 0);
  }
});

test('concurrent fee mints for one wallet serialize preview and cannot overspend the daily cap', async () => {
  const h = harness({ maxBnbPerDay: 0.0001 });
  let release, previewCount = 0, executes = 0;
  const waiting = new Promise(resolve => { release = resolve; });
  h.W.baw = async (args) => {
    if (args[1] === 'execute') { executes++; return { j: { success: true, data: { txHash: 'mock-concurrent' } } }; }
    previewCount++;
    await waiting;
    return { j: { success: true, data: { requestId: 'mock-preview', simulationResult: {
      balanceChanges: [{ owner: walletAddress, contractAddress: reward, change: '1', tokenType: 'Erc721' }],
      allowanceChanges: [], authorityChanges: [],
    } } } };
  };
  const operations = [h.api.autoMint(target, 'mint-test', h.W, 10n ** 14n), h.api.autoMint(target, 'mint-test', h.W, 10n ** 14n)];
  for (let i = 0; i < 40; i++) await Promise.resolve();
  assert.equal(previewCount, 1, 'second operation must wait for the first wallet operation before preview');
  release();
  const results = await Promise.all(operations);
  assert.equal(executes, 1);
  assert.equal(results.filter(result => result.startsWith('🤖')).length, 1);
  assert.ok(h.S.paidSpend.test <= 0.0001);
  assert.ok(Math.abs(h.S.paidSpend.test - 0.0001) < 1e-12);
});

test('ambiguous fee mint response retains its pre-send daily budget reservation', async () => {
  const h = harness(), calls = attachMintWallet(h, { executeResult: { t: 'ETIMEDOUT', j: null } });
  assert.match(await h.api.autoMint(target, 'mint-test', h.W, 10n ** 14n), /結果不明/);
  assert.equal(calls.filter(args => args[1] === 'execute').length, 1);
  assert.ok(Math.abs(h.S.paidSpend.test - 0.0001) < 1e-12);
  assert.ok(h.events.writes.length > 0);
});

for (const errorName of ['TIMEOUT', 'CANCELLED', 'CLI_PROCESS_ERROR', 'CLI_INVALID_OUTPUT']) {
  test(`${errorName}: fee mint marks the queue unknown and never automatically resubmits`, async () => {
    const h = harness({ withQueue: true }), calls = attachMintWallet(h, { executeResult: { t: '', j: { success: false, error: { name: errorName, message: 'mock interrupted execution' } } } });
    assert.match(h.api.queueMint(target, 'mint-test', h.W, 10n ** 14n), /^⏳/);
    await Promise.all([...h.sandbox.MQ.values()]);
    assert.equal(h.P.done.test, 'unknown');
    assert.ok(Math.abs(h.S.paidSpend.test - 0.0001) < 1e-12);
    assert.match(h.api.queueMint(target, 'mint-test', h.W, 10n ** 14n), /^✅/);
    await Promise.all([...h.sandbox.MQ.values()]);
    assert.equal(calls.filter(args => args[1] === 'execute').length, 1);
  });

  test(`${errorName}: paid native mint keeps its budget and terminal unknown state across loop retries`, async () => {
    const h = harness({ realPreview: true });
    h.P.replay = { data: '0x12345678', value: String(10n ** 15n), learned: 1, learnedAt: h.sandbox.Date.now() };
    const calls = attachMintWallet(h, { executeResult: { t: '', j: { success: false, error: { name: errorName, message: 'mock interrupted execution' } } } });
    await h.api.paidLoop();
    assert.equal(h.P.done.test, 'unknown');
    assert.ok(h.S.paidSpend.test >= 0.001);
    await h.api.paidLoop();
    assert.equal(calls.filter(args => args[1] === 'execute').length, 1);
  });
}

for (const feeFirst of [true, false]) {
  test(`manual mint and fee mint share the wallet queue and daily cap (${feeFirst ? 'fee first' : 'manual first'})`, async () => {
    const h = harness({ realPreview: true, fileEnabled: true, maxBnbPerDay: 0.0001, jobs: [{ schemaVersion: 1, c: target, data: '0x12345678', value: String(10n ** 14n), n: 1 }] });
    let release, previews = 0, executes = 0;
    const waiting = new Promise(resolve => { release = resolve; });
    h.W.baw = async args => {
      if (args[1] === 'execute') { executes++; return { j: { success: true, data: { txHash: 'mock-shared-wallet-lock' } } }; }
      previews++;
      await waiting;
      return { j: { success: true, data: { requestId: 'shared-wallet-preview', simulationResult: {
        balanceChanges: [{ owner: walletAddress, contractAddress: reward, change: '1', tokenType: 'Erc721' }],
        allowanceChanges: [], authorityChanges: [],
      } } } };
    };
    const operations = feeFirst
      ? [h.api.autoMint(target, 'mint-test', h.W, 10n ** 14n), h.api.manualMints()]
      : [h.api.manualMints(), h.api.autoMint(target, 'mint-test', h.W, 10n ** 14n)];
    for (let i = 0; i < 40; i++) await Promise.resolve();
    assert.equal(previews, 1, 'only the wallet queue head may preview while the first operation waits');
    release();
    await Promise.all(operations);
    assert.equal(previews, 1);
    assert.equal(executes, 1);
    assert.ok(Math.abs(h.S.paidSpend.test - 0.0001) < 1e-12);
  });
}

test('USDT recharge TIMEOUT keeps reserved BNB and blocks swap/approval retries on later paid loops', async () => {
  const h = harness({ usdtBalance: 0n, realPreview: true }), calls = [];
  h.W.baw = async args => {
    calls.push(args);
    assert.equal(args[0], 'market-order'); assert.equal(args[1], 'swap');
    return { t: '', j: { success: false, error: { name: 'TIMEOUT', message: 'mock recharge result unknown' } } };
  };
  await h.api.paidLoop();
  assert.equal(h.P.done.test, 'unknown');
  assert.ok(Math.abs(h.S.paidSpend.test - 0.0104) < 1e-12);
  assert.ok(h.events.writes.length > 0);
  await h.api.paidLoop();
  assert.equal(calls.length, 1);
  assert.equal(calls.filter(args => args[0] === 'contract-call').length, 0);
  assert.equal(h.events.previews.length, 0);
  assert.ok(Math.abs(h.S.paidSpend.test - 0.0104) < 1e-12);
});
