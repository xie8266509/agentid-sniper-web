import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { getPaidConfig, withinPaidBudget } from '../lib/config.mjs';
import { marketOrderRecord, marketOrderState } from '../lib/sell-rules.mjs';
import { scannerRuntimeDouble } from './watch-runtime-fixture.mjs';
import { createMintRisk, effectiveEntryPolicy, entryGate, deriveMintCost } from '../lib/mint-policy.mjs';
import { id as signatureHash } from 'ethers';
import { createMintParticipation } from '../lib/mint-participation.mjs';
import { decodeAbiUint } from '../lib/nft-codec.mjs';

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
const policyHelpers = extract('function entryFor(', '// ---------- 持倉');
const walletAddress = '0x1111111111111111111111111111111111111111';
const target = '0x2222222222222222222222222222222222222222';
const reward = '0x3333333333333333333333333333333333333333';
const USDT = '0x55d398326f99059ff775485246999027b3197955';
const BNB = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const word = (value) => BigInt(value).toString(16).padStart(64, '0');
const transferTopic = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const bad = new Set(['0xa9059cbb', '0x095ea7b3', '0x23b872dd', '0x42842e0e', '0xb88d4fde', '0xa22cb465', '0x39509351', '0xd505accf', '0xf242432a', '0x2eb2c2d6']);
const limitSelector = signatureHash('maxPerWallet()').slice(0, 10);

export function harness(options = {}) {
  let clock = Date.now();
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [clock])); } static now() { return clock; } }
  const events = { previews: [], swaps: [], writes: [], logs: [], notifications: [], reads: 0, learned: 0 };
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Clock());
  const P = { at: clock, name: 'TEST', done: {}, old: false, wallets: 20, agents: 175, heatAt: clock, ph: [], replay: { data: '0x12345678', value: '0', payTok: USDT, payAmt: String(10n * 10n ** 18n), hot: 15, learned: 1, learnedAt: clock } };
  const S = { paid: { [target]: P }, agentsV: 3, mintPolicy: { wallets: {} }, dyn: [], migrated2: 1, paidSpend: { day, test: options.spent || 0 }, seenMints: {} };
  const W = { id: 'test', name: 'test', profile: { id: 'test', address: walletAddress }, addr: walletAddress, async baw(args) { events.swaps.push(args); return { j: { success: true, data: { txHash: '0x' + 'ab'.repeat(32) } } }; } };
  const balanceChanges = options.noReward ? [] : [{ owner: walletAddress, contractAddress: reward, change: '1', tokenType: 'Erc20' }];
  const sandbox = {
    Date: Clock, MONITOR_ONLY: options.monitorOnly === true, FILE_COMMANDS_ENABLED: options.fileEnabled === true, MONITOR_NOTE: '仅监控',
    CONFIG: { timeZone: 'Asia/Shanghai' }, PAID: getPaidConfig({ paid: { goPct: options.goPct ?? 0.8, maxUsd: options.maxUsd ?? 20, maxBnbPerDay: options.maxBnbPerDay ?? 0.05, dayUsd: options.dayUsd ?? 60, keepBnb: 0.006 } }),
    ENTRY_POLICY: { version: 3, goPct: 0.65, minAgents: 115 }, effectiveEntryPolicy, entryGate, decodeAbiUint, deriveMintCost,
    S, WALLETS: [W], FORCE: new Set(options.hotGo || options.forced === false ? [] : [target]), HOT: new Map(),
    USDT, NATIVE_BNB: BNB, WBNB: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', FACTORY: reward, T_TRANSFER: transferTopic,
    CANDS: [['mint-test', '0x12345678']], INFRA: new Set(), CLAIM: new Set(), REGISTRY: '60b9262456de011f7d15a54cdd8c48baaa8b022f',
    getPaidConfig, marketOrderRecord, marketOrderState, withinPaidBudget, w: word, wa: (a) => a.slice(2).padStart(64, '0'), big: (value) => value && value !== '0x' ? BigInt(value) : 0n,
    badSel: (data) => bad.has(String(data || '').slice(0, 10).toLowerCase()), tokStr: () => '',
    async bnbUsd() { if (options.hotGo) clock += 240000; return 1000; },
    async codeOf() { return '0x'; }, async findFree() { return null; },
    fpCache: new Map(),
    async freeProgress() { return options.freeProgress === undefined ? 0.9 : options.freeProgress; },
    async serialDev() { return options.serialReason || ''; },
    async fullCode() { if (options.actualScale) return '0x68bce8cd725c4058' + limitSelector.slice(2); return '0x' + (options.refund === false ? '' : '63590e1ae3') + (options.noLimit ? '' : limitSelector.slice(2)) + (options.nft ? 'c87b56dd' : ''); },
    async poolOpen() { return options.poolOpen === true; },
    trackFromSim() {}, noteFree() {}, MQ: new Map(),
    async autoMintMax(c, name, wallet, value) { return sandbox.api.autoMint(c, name, wallet, value); },
    async progressOf() { return options.actualScale ? { progress: .9, cap: options.scaleCap ?? 10000, sold: options.scaleSold ?? 9000 } : { progress: 0 }; }, async deployerOf() { return ''; }, isRepeatDev() { return false; }, isSerial() { return false; },
    async logsRpc(params) { return sandbox.rpc('eth_getLogs', params); },
    async poolOut() { return 0n; }, async groupProgress() {}, async tg(message) { events.notifications.push(message); }, async tgSay() {}, async sleep() {},
    ts: () => 'mock-time',
    log(text) { events.logs.push(text); }, save() { events.writes.push('state'); },
    async rpc(method, params) {
      if (options.rpc) { const result = await options.rpc(method, events, params); if (result !== undefined) return result; }
      if (method === 'eth_getTransactionReceipt') return { status: '0x1', blockNumber: '0x10', gasUsed: '0x5208', effectiveGasPrice: '0x3b9aca00' };
      if (method === 'eth_getBalance') return '0x' + word(10n ** 18n);
      if (method === 'eth_estimateGas') return '0x5208';
      if (method === 'eth_gasPrice') return '0x3b9aca00';
      if (method === 'eth_getStorageAt') return '0x' + word(0);
      if (method === 'eth_getCode') return '0x6000';
      if (method === 'eth_getBlockNumber' || method === 'eth_blockNumber') return '0x1000';
      if (method === 'eth_call' && params?.[0]?.data?.startsWith('0x70a08231')) return '0x' + word(1000n * 10n ** 18n);
      if (method === 'eth_call' && params?.[0]?.data === limitSelector) return '0x' + word(options.limitValue ?? 10);
      if (method === 'eth_call' && params?.[0]?.data?.startsWith('0xc87b56dd')) { const bytes = Buffer.from('https://mock-nft.test/1.json'); return '0x' + word(32) + word(bytes.length) + bytes.toString('hex').padEnd(Math.ceil(bytes.length / 32) * 64, '0'); }
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
      if (options.actualScale && data.startsWith('0x68bce8cd')) return '0x' + word(BigInt('0x' + data.slice(10)) * BigInt(options.nativeUnit ?? 10n ** 15n));
      if (options.actualScale && data.startsWith('0x725c4058')) return '0x' + word(BigInt('0x' + data.slice(10)) * BigInt(options.usdtUnit ?? 10n ** 18n));
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
  Object.assign(sandbox, scannerRuntimeDouble({ sandbox, wallet: W, state: S, events }));
  sandbox.MINT_RISK = createMintRisk({ state: S, rpc: (...args) => sandbox.rpc(...args), fullCode: (...args) => sandbox.fullCode(...args), nftMediaCheck: async () => ({ verified: true }), save: (...args) => sandbox.save(...args), now: () => clock, timeZone: 'Asia/Shanghai', usdt: USDT });
  sandbox.MINT_PARTICIPATION = createMintParticipation({ state: S, save: (...args) => sandbox.save(...args), now: () => clock });
  const context = vm.createContext(sandbox);
  vm.runInContext((options.trackBasis ? extract('function trackFromSim(', 'function positionFor(') : extract('function mintTrackingPlan(', 'function positionFor(')) + helpers + addressSafety + policyHelpers + learner + paid + manual + autoMint + (options.realPreview ? extract('async function previewExec(', 'async function poolOut(') : '') + (options.withQueue ? extract('const MQK =', '// 每個錢包可以打多份的') : '') + '\nglobalThis.api = { executeUsdtMint, prepareUsdtReplay, mintSimulationCheck, approvalSimulationCheck, validateFileJob, manualMints, paidLoop, learnReplay, safeAddrs, revokeOnFail, hasPositiveMintGain, autoMint, previewExec, settleConfirmedMintRisk, recoverScannerWallet, applyManualMintCompletion, othersPay, verifyAgentProject, queuePaidPhase, queueMint: typeof queueMint === \'function\' ? queueMint : null };', context);
  if (!options.actualScale) sandbox.quoteAutomaticParticipation = async (_W, project, _data, value, opts = {}) => {
    const amount = BigInt(opts.amountBnbWei ?? (BigInt(value) + (opts.paymentToken === USDT ? BigInt(opts.paymentWei || 0) / 1000n : 0n)));
    return sandbox.MINT_PARTICIPATION.quote({ project, cap: '1000000000000000000000', sold: '1000', quantity: '1', unitBnbWei: amount || 1n, amountBnbWei: amount || 1n, excludeId: _W.paidReservation?.participationId });
  };
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

test('an unknown USDT balance after a confirmed recharge keeps its original evidence and blocks the next recharge attempt', async () => {
  let balanceReads = 0;
  const h = harness({ contractCall: (contract, data) => contract === USDT && data.startsWith('0x70a08231') ? ++balanceReads === 1 ? '0x' + word(0) : null : undefined });
  const run = () => h.api.executeUsdtMint(h.W, { to: target, data: '0x12345678', need: 10n * 10n ** 18n });
  await assert.rejects(run(), /結果不明.*换币后无法核验 USDT 余额/);
  const pending = structuredClone(h.S.walletPending.test);
  assert.equal(pending.kind, 'market-order'); assert.equal(pending.phase, 'verified'); assert.match(pending.txHash, /^0x[a-f0-9]{64}$/);
  assert.ok(h.events.reservations.has(pending.reservationId)); assert.equal(h.events.previews.length, 0);
  await assert.rejects(run(), /結果不明.*待核对交易/);
  assert.equal(h.events.swaps.length, 1); assert.equal(h.events.reservationCalls.length, 1); assert.equal(balanceReads, 2);
  assert.deepEqual(structuredClone(h.S.walletPending.test), pending); assert.ok(h.events.reservations.has(pending.reservationId));
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
  const h = harness({ hotGo: true }); h.sandbox.refreshMatureHeat = async () => {}; // This fixture advances the clock to exercise learning, not Agent-age RPC.
  h.sandbox.progressOf = async () => ({ progress: null });
  h.P.replay = { data: '0x12345678', value: String(10n ** 16n) }; h.P.ph = [];
  h.P.agents = 175; h.P.burst = 15; // unreadable progress still requires the verified-sender threshold
  h.sandbox.learnReplay = async () => { h.events.learned++; return { data: '0x12345678', value: String(10n ** 16n), sampleData: '0x12345678', sampleValue: String(10n ** 16n), hot: 15, learned: 1, learnedAt: h.sandbox.Date.now() }; };
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

test('fee-bearing mint does not execute for zero net gains or assets received by another wallet; positive NFT passes', async () => {
  const seedHot = (h) => { h.sandbox.HOT.set(target, { from: new Set(Array.from({ length: 15 }, (_, i) => '0x' + String(i).padStart(40, '0'))) }); };
  for (const changes of [[], [{ owner: walletAddress, contractAddress: reward, change: '0', tokenType: 'Erc20' }], [{ owner: walletAddress, contractAddress: reward, change: '0', tokenType: 'Erc721' }], [{ owner: target, contractAddress: reward, change: '1', tokenType: 'Erc721' }]]) {
    const h = harness(); seedHot(h); let executes = 0;
    h.W.baw = async (args) => {
      if (args[1] === 'execute') { executes++; return { j: { success: true, data: {} } }; }
      return { j: { success: true, data: { requestId: 'mock-preview', simulationResult: { balanceChanges: changes, allowanceChanges: [], authorityChanges: [] } } } };
    };
    const result = await h.api.autoMint(target, 'mint-test', h.W, 10n ** 14n);
    assert.equal(executes, 0); assert.match(result, /没有铸|沒有鑄/);
  }
  const h = harness({ nft: true }); seedHot(h); let executes = 0;
  h.W.baw = async (args) => {
    if (args[1] === 'execute') { executes++; return { j: { success: true, data: { txHash: '0x' + 'ab'.repeat(32) } } }; }
    return { j: { success: true, data: { requestId: 'mock-preview', simulationResult: { balanceChanges: [{ owner: walletAddress, contractAddress: reward, change: '1', tokenType: 'Erc721' }], allowanceChanges: [], authorityChanges: [] } } } };
  };
  assert.match(await h.api.autoMint(target, 'mint-test', h.W, 10n ** 14n), /^🤖/);
  assert.equal(executes, 1);
});

test('fee-bearing mint rejects even one wei of excess native debit and malformed wei amounts', async () => {
  const fee = 10n ** 14n;
  for (const debit of ['-' + (fee + 1n), '-100000000000000.5', 'NaN']) {
    const h = harness(); let executes = 0;
    h.W.baw = async args => {
      if (args[1] === 'execute') { executes++; throw new Error('unsafe mint must never submit'); }
      return { j: { success: true, data: { requestId: 'unsafe-preview', simulationResult: {
        balanceChanges: [
          { owner: walletAddress, contractAddress: reward, change: '1', tokenType: 'Erc721' },
          { owner: walletAddress, contractAddress: BNB, change: debit },
        ], allowanceChanges: [], authorityChanges: [],
      } } } };
    };
    const result = await h.api.autoMint(target, 'mint-test', h.W, fee);
    assert.equal(executes, 0, debit);
    assert.match(result, /没有铸|沒有鑄/);
    assert.equal(h.S.walletPending.test, undefined);
  }
});

test('the common contract preview refuses malformed native changes even with a permissive caller check', async () => {
  const h = harness({ realPreview: true }); let executes = 0;
  h.W.baw = async args => {
    if (args[1] === 'execute') { executes++; throw new Error('invalid native amount must never submit'); }
    return { j: { success: true, data: { requestId: 'bad-amount', simulationResult: {
      balanceChanges: [{ owner: walletAddress, contractAddress: BNB, change: '-1.5' }], allowanceChanges: [], authorityChanges: [],
    } } } };
  };
  await assert.rejects(h.api.previewExec(h.W, target, '0x12345678', 10n ** 14n, () => ''), /金额无效/);
  assert.equal(executes, 0);
});

function attachMintWallet(h, { executeResult, rewardType = 'Erc20' } = {}) {
  const calls = [];
  h.W.baw = async (args) => {
    calls.push(args);
    if (args[1] === 'execute') return executeResult || { j: { success: true, data: { txHash: '0x' + 'ab'.repeat(32) } } };
    return { j: { success: true, data: { requestId: 'mock-mint-preview', simulationResult: {
      balanceChanges: [{ owner: walletAddress, contractAddress: reward, change: '1', tokenType: rewardType }],
      allowanceChanges: [], authorityChanges: [],
    } } } };
  };
  return calls;
}

test('fee-bearing mint enforces full paid budgets before wallet preview', async () => {
  for (const options of [{ maxUsd: 0 }, { maxBnbPerDay: 0 }, { spent: 0.05 }, { maxUsd: 0.01 }]) {
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

test('only-gas free projects notify once without wallet preview, even when paid budgets are zero', async () => {
  const h = harness({ maxUsd: 0, maxBnbPerDay: 0, refund: false }), calls = attachMintWallet(h);
  assert.match(await h.api.autoMint(target, 'mint-test', h.W, 0n), /^🔔/);
  assert.match(await h.api.autoMint(target, 'mint-test', h.W, 0n), /^✅/);
  assert.equal(calls.length, 0, 'free notifications must not preview or submit a transaction');
  assert.equal(h.events.notifications.filter(message => /只通知/.test(message)).length, 1);
  assert.equal(h.S.paidSpend.test, 0);
});

test('the background free-mint queue never spends gas or marks a completed mint', async () => {
  const h = harness({ withQueue: true }), calls = attachMintWallet(h);
  assert.match(h.api.queueMint(target, 'mint-test', h.W, 0n), /^⏳/);
  await Promise.all([...h.sandbox.MQ.values()]);
  assert.equal(calls.length, 0);
  assert.equal(h.P.done.test, undefined);
  assert.equal(h.S.mintCount, undefined);
  assert.ok(h.events.notifications.some(message => /只通知/.test(message)));
});

test('an explicitly enabled manual free mint remains possible after automatic free minting is disabled', async () => {
  const h = harness({ realPreview: true, fileEnabled: true, jobs: [{ schemaVersion: 1, c: target, data: '0x12345678', value: '0', n: 1 }] });
  const calls = attachMintWallet(h);
  await h.api.manualMints();
  assert.equal(calls.filter(args => args[1] === 'execute').length, 1);
  assert.equal(h.S.paidSpend.test, 0);
  assert.equal(h.P.done.test, 'minted'); assert.equal(h.S.forceDone[target], 1);
});

test('USDT project risk failures occur before recharge, approval, or any mint preview', async () => {
  for (const failure of ['storage', 'funds']) {
    const h = harness({ usdtBalance: 0n, rpc(method, _events, params) {
      if (failure === 'storage' && method === 'eth_getStorageAt') throw new Error('mock storage unavailable');
      if (failure === 'funds' && method === 'eth_call' && (params[0].data?.startsWith('0x70a08231') || params[0].data?.startsWith('0xe6a43905'))) return '0x' + word(0);
    } });
    await assert.rejects(h.api.executeUsdtMint(h.W, { to: target, data: '0x12345678', need: 10n ** 18n }), /unavailable|资金留存|流动性不足/);
    assert.equal(h.events.swaps.length, 0);
    assert.equal(h.events.previews.length, 0);
    assert.equal(h.events.reservations.size, 0);
  }
});

test('known low mint progress cannot be bypassed by crowd heat; the installation threshold can proceed', async () => {
  for (const progress of [0, 0.01, 0.64, 0.799, 0.8]) {
    const h = harness({ freeProgress: progress }), calls = attachMintWallet(h);
    h.P.agents = 1000;
    const result = await h.api.autoMint(target, 'mint-test', h.W, 10n ** 14n);
    assert.equal(calls.filter(args => args[1] === 'execute').length, progress >= 0.8 ? 1 : 0);
    assert.match(result, progress >= 0.8 ? /^🤖/ : /80%/);
  }
});

test('unreadable progress requires verified transaction senders and no existing pool', async () => {
  for (const [agents, poolOpen, expected] of [[114, false, false], [115, false, true], [115, true, false]]) {
    const h = harness({ freeProgress: null, poolOpen }), calls = attachMintWallet(h);
    h.P.agents = agents;
    h.sandbox.HOT.set(target, { from: new Set(Array.from({ length: 300 }, (_, i) => 'hot-' + i)) });
    const result = await h.api.autoMint(target, 'mint-test', h.W, 10n ** 14n);
    assert.equal(calls.filter(args => args[1] === 'execute').length, expected ? 1 : 0);
    assert.match(result, expected ? /^🤖/ : /^⏸/);
  }
});

test('paidLoop cannot use old 20-wallet rules when progress passes but verified senders do not', async () => {
  const h = harness({ forced: false });
  h.P.agents = 114; h.P.wallets = 1000;
  await h.api.paidLoop();
  assert.equal(h.events.previews.length, 0);
  assert.equal(h.events.swaps.length, 0);
  assert.equal(h.P.done.test, undefined);
});

test('paidLoop preserves the configured stricter per-wallet progress threshold', async () => {
  const h = harness({ forced: false, goPct: 0.95 });
  await h.api.paidLoop();
  assert.equal(h.P.progress, 0.9);
  assert.equal(h.events.previews.length, 0);
  assert.equal(h.P.done.test, undefined);
  h.sandbox.call = async (_contract, data) => {
    if (data === '0x192fc516') return '0x' + word(96);
    if (data === '0xd8f93498') return '0x' + word(100);
    if (data.startsWith('0x70a08231')) return '0x' + word(1000n * 10n ** 18n);
    return '0x';
  };
  await h.api.paidLoop();
  assert.equal(h.P.progress, 0.96);
  assert.equal(h.P.done.test, 'minted');
  assert.equal(h.events.previews.length, 2);
});

test('paidLoop cannot let a large crowd override known low progress', async () => {
  const h = harness({ forced: false, contractCall(_contract, data) {
    if (data === '0x192fc516') return '0x' + word(20);
    if (data === '0xd8f93498') return '0x' + word(100);
  } });
  h.P.agents = 1000;
  await h.api.paidLoop();
  assert.equal(h.P.progress, 0.2);
  assert.equal(h.events.previews.length, 0);
  assert.equal(h.events.swaps.length, 0);
});

test('free replay in paidLoop never approves or submits even when force-tracked', async () => {
  for (const forced of [false, true]) {
    const h = harness({ forced });
    h.P.replay = { data: '0x12345678', value: '0', learned: 1, learnedAt: h.sandbox.Date.now() };
    await h.api.paidLoop();
    assert.equal(h.events.previews.length, 0, 'force-tracking is not an instruction to spend gas on a free mint');
    assert.equal(h.events.swaps.length, 0);
    assert.ok(h.events.notifications.some(message => /只通知/.test(message)));
  }
});

test('serial deployment block applies to fee-bearing mint before wallet access', async () => {
  for (const value of [10n ** 14n]) {
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
    if (args[1] === 'execute') { executes++; return { j: { success: true, data: { txHash: '0x' + 'ab'.repeat(32) } } }; }
    previewCount++;
    await waiting;
    return { j: { success: true, data: { requestId: 'mock-preview', simulationResult: {
      balanceChanges: [{ owner: walletAddress, contractAddress: reward, change: '1', tokenType: 'Erc20' }],
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
  const pending = h.S.walletPending.test;
  assert.ok(pending?.mintRiskReservation);
  assert.equal(h.S.mintRisk.reservations[pending.mintRiskReservation]?.walletId, 'test');
  assert.ok(BigInt(h.S.mintRisk.reservations[pending.mintRiskReservation].amountWei) > 10n ** 14n, 'unknown gas and fee remain reserved together');
});

test('fee recovery cannot settle a reservation with an unrelated transaction receipt', async () => {
  const h = harness(), expected = '0x' + 'ab'.repeat(32), unrelated = '0x' + 'cd'.repeat(32);
  const quote = await h.sandbox.MINT_RISK.quoteTransaction(h.W, { to: target, data: '0x12345678', valueWei: 10n ** 14n, feeLike: true });
  const id = h.sandbox.MINT_RISK.reserve(quote), pending = { mintRiskReservation: id };
  h.sandbox.rpc = async (method, params) => {
    assert.equal(method, 'eth_getTransactionReceipt'); assert.equal(params[0], expected);
    return { transactionHash: unrelated, status: '0x1', gasUsed: '0x5208', effectiveGasPrice: '0x3b9aca00' };
  };
  await h.api.settleConfirmedMintRisk(pending, { resolved: true, status: 'confirmed', txHash: expected });
  assert.ok(h.S.mintRisk.reservations[id]);
  assert.equal(Object.keys(h.S.mintRisk.spent).length, 0);
  h.sandbox.rpc = async () => ({ transactionHash: expected, status: '0x1', gasUsed: '0x5208', effectiveGasPrice: '0x3b9aca00' });
  await h.api.settleConfirmedMintRisk(pending, { resolved: true, status: 'confirmed', txHash: expected });
  assert.equal(h.S.mintRisk.reservations[id], undefined);
  assert.equal(Object.values(h.S.mintRisk.spent)[0], '121000000000000');
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
    h.P.replay = { data: '0x12345678', value: String(10n ** 15n), sampleData: '0x12345678', sampleValue: String(10n ** 15n), learned: 1, learnedAt: h.sandbox.Date.now() };
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
      if (args[1] === 'execute') { executes++; return { j: { success: true, data: { txHash: '0x' + 'ab'.repeat(32) } } }; }
      previews++;
      await waiting;
      return { j: { success: true, data: { requestId: 'shared-wallet-preview', simulationResult: {
        balanceChanges: [{ owner: walletAddress, contractAddress: reward, change: '1', tokenType: 'Erc20' }],
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

function mockPaidHistory(h, { paid = 3, usdtPaid = 0, duplicateSender = false, broken = '', reverted = false, wrongTarget = false } = {}) {
  const hashes = Array.from({ length: 5 }, (_, i) => '0x' + (i + 1).toString(16).padStart(64, '0'));
  const senders = hashes.map((_, i) => '0x' + (i + 100).toString(16).padStart(40, '0'));
  const baseRpc = h.sandbox.rpc;
  h.context.rpc = h.sandbox.rpc = async (method, params) => {
    if (method === 'eth_getLogs') { if (broken === 'logs') throw new Error('mock RPC logs unavailable'); return hashes.map(transactionHash => ({ address: target, transactionHash })); }
    if (method === 'eth_getTransactionReceipt') {
      const index = hashes.indexOf(params[0]), from = duplicateSender ? senders[0] : senders[index];
      if (broken === 'receipt') return null;
      return { transactionHash: broken === 'hash' ? '0x' + 'ff'.repeat(32) : params[0], status: reverted ? '0x0' : '0x1', logs: index < usdtPaid ? [{ address: USDT, topics: [transferTopic, '0x' + from.slice(2).padStart(64, '0'), '0x' + target.slice(2).padStart(64, '0')], data: '0x' + word(10n ** 18n) }] : [] };
    }
    return baseRpc(method, params);
  };
  h.context.rpcBatch = async () => broken === 'batch' ? [] : hashes.map((hash, i) => broken === 'transaction' && i === 2 ? undefined : ({ hash, to: wrongTarget ? reward : target, from: duplicateSender ? senders[0] : senders[i], value: i < paid ? '0x1' : '0x0', input: '0x12345678' }));
}

test('mixed mint phases require successful same-contract paid BNB or USDT evidence from distinct senders', async () => {
  for (const [options, expected] of [[{ paid: 3 }, true], [{ paid: 0, usdtPaid: 3 }, true], [{ paid: 2 }, false], [{ paid: 0 }, false], [{ duplicateSender: true }, false], [{ reverted: true }, false], [{ wrongTarget: true }, false]]) {
    const h = harness(); mockPaidHistory(h, options);
    assert.equal(await h.api.othersPay(target), expected, JSON.stringify(options));
    assert.equal(h.events.swaps.length, 0); assert.equal(h.events.previews.length, 0);
  }
});

test('unreadable mixed-phase transaction or receipt data remains unknown and cannot become a free notification', async () => {
  for (const broken of ['logs', 'batch', 'transaction', 'receipt', 'hash']) {
    const h = harness(); mockPaidHistory(h, { broken }); const calls = attachMintWallet(h);
    assert.equal(await h.api.othersPay(target), null, broken);
    assert.match(await h.api.autoMint(target, 'mint-test', h.W), /无法核验/);
    assert.equal(h.events.notifications.length, 0); assert.equal(calls.length, 0); assert.equal(h.S.freeNote?.[target], undefined);
  }
});

test('a first-free later-paid project leaves the free notification queue and re-enters checked paid discovery without sending', async () => {
  const h = harness(); mockPaidHistory(h); const calls = attachMintWallet(h);
  h.P.replay = { data: '0x12345678', value: '0' }; h.P.done.test = 'free-notify'; h.S.freeNote = { [target]: true };
  assert.match(await h.api.autoMint(target, 'mint-test', h.W), /转入付费/);
  assert.equal(h.P.needLearn, 1); assert.equal(h.P.freePhase, true); assert.equal(h.P.replay, undefined); assert.equal(h.P.done.test, undefined);
  assert.equal(h.S.freeNote[target], undefined); assert.equal(calls.length, 0); assert.equal(h.events.notifications.length, 0);
});

test('the daily USD cap blocks both native fee and held-USDT mint paths with no transaction submission', async () => {
  const native = harness({ dayUsd: 0 }), calls = attachMintWallet(native);
  await assert.rejects(native.api.autoMint(target, 'mint-test', native.W, 10n ** 14n), /USD/);
  assert.equal(calls.filter(args => args[1] === 'execute').length, 0);
  const usdt = harness({ dayUsd: 0 });
  await assert.rejects(usdt.api.executeUsdtMint(usdt.W, { to: target, data: '0x12345678', need: 10n ** 18n }), /USD/);
  assert.equal(usdt.events.previews.length, 0); assert.equal(usdt.events.swaps.length, 0);
});

test('paid mint succeeds without a refund selector while quantity and all spend limits stay enforced', async () => {
  const h = harness({ refund: false }), calls = attachMintWallet(h);
  assert.match(await h.api.autoMint(target, 'mint-test', h.W, 10n ** 14n), /^🤖/);
  assert.equal(calls.filter(args => args[1] === 'execute').length, 1);
  assert.ok(h.events.reservationCalls.every(record => BigInt(record.amountUsdMicros) > 0n));
});

test('native and held-USDT NFT mints reserve the shared ten-dollar project identity before submitting', async () => {
  const native = harness({ nft: true }), calls = attachMintWallet(native, { rewardType: 'Erc721' });
  assert.match(await native.api.autoMint(target, 'mint-test', native.W, 10n ** 14n), /^🤖/);
  const usdt = harness({ nft: true }); await usdt.api.executeUsdtMint(usdt.W, { to: target, data: '0xa0712d68' + word(1), need: 10n ** 18n });
  for (const h of [native, usdt]) { assert.equal(h.events.reservationCalls.length, 1); assert.equal(h.events.reservationCalls[0].projectId, target); assert.equal(h.events.reservationCalls[0].projectLimitUsdMicros, '10000000'); assert.ok(BigInt(h.events.reservationCalls[0].amountUsdMicros) > 0n); }
  assert.equal(calls.filter(args => args[1] === 'execute').length, 1);
});

test('NFT paid recharge refuses unknown quantity before a swap, approval or preview', async () => {
  const h = harness({ nft: true, usdtBalance: 0n });
  await assert.rejects(h.api.executeUsdtMint(h.W, { to: target, data: '0x12345678', need: 10n ** 18n }), /数量未知/);
  assert.equal(h.events.previews.length, 0); assert.equal(h.events.swaps.length, 0); assert.equal(h.events.reservationCalls?.length || 0, 0);
});

test('a social project cannot prove Agent ID eligibility just by embedding its registry address in bytecode', async () => {
  const h = harness(); h.context.fullCode = async () => '0x' + h.sandbox.REGISTRY;
  assert.equal(await h.api.verifyAgentProject(target), false);
  assert.equal(h.events.previews.length, 0); assert.equal(h.events.swaps.length, 0);
});

test('social project admission verifies five successful transaction senders and at least sixty percent Agent ID holders', async () => {
  for (const [registered, expected] of [[2, false], [3, true], [5, true]]) {
    const h = harness(); mockPaidHistory(h); let index = 0;
    h.context.call = async (address, data) => { assert.equal(address, '0x' + h.sandbox.REGISTRY); assert.ok(data.startsWith('0x70a08231')); return '0x' + word(index++ < registered ? 1 : 0); };
    assert.equal(await h.api.verifyAgentProject(target), expected, String(registered));
  }
});

test('social project admission refuses short RPC results, unrelated targets, duplicate senders and missing receipt or registry evidence', async () => {
  for (const options of [{ broken: 'batch' }, { broken: 'transaction' }, { broken: 'receipt' }, { broken: 'hash' }, { reverted: true }, { wrongTarget: true }, { duplicateSender: true }, { registryUnknown: true }, { wrongTransactionHash: true }]) {
    const h = harness(); mockPaidHistory(h, options);
    h.context.call = async () => options.registryUnknown ? null : '0x' + word(1);
    if (options.wrongTransactionHash) { const base = h.context.rpcBatch; h.context.rpcBatch = async requests => (await base(requests)).map(tx => ({ ...tx, hash: '0x' + 'ff'.repeat(32) })); }
    assert.equal(await h.api.verifyAgentProject(target), false, JSON.stringify(options));
    assert.equal(h.events.previews.length, 0); assert.equal(h.events.swaps.length, 0);
  }
});

test('an interrupted paid mint persists its free-token cost correction and applies it once after confirmed recovery', async () => {
  const h = harness({ trackBasis: true }), hash = '0x' + 'ab'.repeat(32);
  h.S.dyn.push({ sym: 'mock-existing-free', addr: reward, only: walletAddress, cost: 0 });
  const calls = attachMintWallet(h, { rewardType: 'Erc20', executeResult: { j: { success: false, data: { txHash: hash }, error: { name: 'TIMEOUT', message: 'mock confirmed response interrupted' } } } });
  assert.match(await h.api.autoMint(target, 'mint-test', h.W, 10n ** 14n), /不明/);
  const pending = structuredClone(h.S.walletPending.test);
  assert.equal(pending.mintTracking.version, 1); assert.equal(pending.mintTracking.walletAddress, walletAddress); assert.equal(pending.mintTracking.costUsdMicros, '100000'); assert.deepEqual(Array.from(pending.mintTracking.receivedTokens), [reward]);
  assert.equal(h.S.dyn[0].cost, 0, 'unconfirmed outcome cannot prematurely record a completed purchase');
  assert.equal((await h.api.recoverScannerWallet(h.W)).status, 'confirmed');
  assert.equal(h.S.dyn[0].cost, 0.1); assert.equal(h.S.dyn[0].costUnknown, false); assert.equal(h.S.walletPending.test, undefined);
  h.S.walletPending.test = pending; await h.api.recoverScannerWallet(h.W);
  assert.equal(h.S.dyn[0].cost, 0.1, 'recovery after a second restart must not double-count the same tx hash');
  assert.equal(calls.filter(args => args[1] === 'execute').length, 1);
});

test('replay price retries reserve the entire increase and never compound above the original twenty-percent ceiling', async () => {
  const original = 10n ** 15n, attempts = []; let minimum = original * 110n / 100n;
  const h = harness({ realPreview: true, rpc(method, _events, params) {
    if (method === 'eth_call' && params?.[0]?.to === target && params[0].value) { const value = BigInt(params[0].value); attempts.push(value); if (value < minimum) throw new Error('mock MAX_COST requires a refreshed price'); return '0x'; }
  } });
  h.P.replay = { data: '0x12345678' + word(original), value: original.toString(), sampleData: '0x12345678' + word(original), sampleValue: original.toString(), learned: 1, learnedAt: h.sandbox.Date.now() };
  const calls = attachMintWallet(h); await h.api.paidLoop();
  assert.equal(h.P.done.test, 'minted'); assert.equal(calls.filter(args => args[1] === 'execute').length, 1);
  assert.equal(h.events.reservationCalls.length, 1); assert.ok(BigInt(h.events.reservationCalls[0].amountUsdMicros) >= 1100000n); assert.ok(Math.abs(h.S.paidSpend.test - 0.0011) < 1e-12);
  minimum = original * 121n / 100n; h.P.done = {}; attempts.length = 0;
  await h.api.paidLoop();
  assert.equal(calls.filter(args => args[1] === 'execute').length, 1, 'a later scan cannot compound a previous price increase');
  assert.ok(attempts.every(value => value <= original * 120n / 100n));
});

test('a replay price increase cannot escape the saved project spend cap', async () => {
  const original = 10n ** 15n;
  const h = harness({ realPreview: true, maxUsd: 1.05, rpc(method, _events, params) {
    if (method === 'eth_call' && params?.[0]?.to === target && params[0].value) { if (BigInt(params[0].value) < original * 110n / 100n) throw new Error('mock MAX_COST'); return '0x'; }
  } });
  h.P.replay = { data: '0x12345678' + word(original), value: original.toString(), sampleData: '0x12345678' + word(original), sampleValue: original.toString(), learned: 1, learnedAt: h.sandbox.Date.now() };
  const calls = attachMintWallet(h); await h.api.paidLoop();
  assert.equal(calls.length, 0); assert.equal(h.events.reservationCalls?.length || 0, 0); assert.equal(h.P.done.test, undefined);
});


for (const value of ['0', '100000000000000']) test(`a confirmed manual mint persists completion by wallet ID after unknown-result recovery (${value} wei)`, async () => {
  const h = harness({ realPreview: true, fileEnabled: true, jobs: [{ schemaVersion: 1, c: target, data: '0x12345678', value, n: 1 }] }), hash = '0x' + 'ab'.repeat(32);
  const calls = attachMintWallet(h, { executeResult: { j: { success: false, data: { txHash: hash }, error: { name: 'TIMEOUT', message: 'mock response interrupted' } } } });
  await h.api.manualMints();
  const pending = structuredClone(h.S.walletPending.test);
  assert.equal(pending.manualMintProject, target); assert.equal(h.P.done.test, undefined); assert.equal(h.S.forceDone?.[target], undefined);
  h.W.name = 'renamed-wallet'; h.W.profile.name = 'renamed-wallet';
  assert.equal((await h.api.recoverScannerWallet(h.W)).status, 'confirmed');
  assert.equal(h.P.done.test, 'minted'); assert.equal(h.P.done['renamed-wallet'], undefined); assert.equal(h.S.forceDone[target], 1); assert.equal(h.S.walletPending.test, undefined);
  h.S.walletPending.test = pending; await h.api.recoverScannerWallet(h.W);
  assert.equal(h.P.done.test, 'minted'); assert.equal(calls.filter(args => args[1] === 'execute').length, 1);
});

test('manual completion requires a bound mint intent and never counts another wallet unknown state as success', () => {
  const h = harness(), hash = '0x' + 'ab'.repeat(32);
  const pending = { manualMintProject: target, kind: 'contract', walletId: h.W.id, walletAddress, expected: { to: target, inputData: '0x12345678' } };
  h.sandbox.WALLETS.push({ id: 'second-wallet', addr: reward }); h.P.done['second-wallet'] = 'unknown';
  h.api.applyManualMintCompletion(h.W, pending, hash);
  assert.equal(h.P.done.test, 'minted'); assert.equal(h.S.forceDone?.[target], undefined);
  for (const invalid of [{ kind: 'approval' }, { walletId: 'other-wallet' }, { walletAddress: reward }, { expected: { to: reward, inputData: '0x12345678' } }, { expected: { to: target, inputData: '0x095ea7b3' + word(1) } }]) {
    h.P.done.test = undefined;
    assert.throws(() => h.api.applyManualMintCompletion(h.W, { ...pending, ...invalid }, hash), /无法绑定/); assert.equal(h.P.done.test, undefined);
  }
  h.P.done['second-wallet'] = 'minted'; h.api.applyManualMintCompletion(h.W, pending, hash); assert.equal(h.S.forceDone[target], 1);
});

for (const status of ['unknown', 'reverted']) test(`manual pending ${status} outcome never marks the project completed`, async () => {
  const h = harness({ realPreview: true, fileEnabled: true, jobs: [{ schemaVersion: 1, c: target, data: '0x12345678', value: '0', n: 1 }] });
  attachMintWallet(h, { executeResult: { j: { success: false, data: { txHash: '0x' + 'ab'.repeat(32) }, error: { name: 'TIMEOUT', message: 'mock response interrupted' } } } });
  await h.api.manualMints();
  h.context.reconcileScannerPending = async () => ({ resolved: status === 'reverted', status, txHash: h.S.walletPending.test.txHash, spentWei: '0' });
  await h.api.recoverScannerWallet(h.W); assert.equal(h.P.done.test, undefined); assert.equal(h.S.forceDone?.[target], undefined);
  assert.equal(Boolean(h.S.walletPending.test), status === 'unknown');
});


test('forceMint priority never bypasses serial-deployer or configured progress gates', async () => {
  for (const options of [{ serialReason: 'mock serial deployer' }, { freeProgress: 0.1, contractCall: async (_c, data) => data === '0x192fc516' ? '0x' + word(10) : undefined }]) {
    const h = harness(options); h.P.serialLog = options.serialReason ? 1 : undefined;
    await h.api.paidLoop('hot');
    assert.equal(h.events.previews.length, 0); assert.equal(h.events.swaps.length, 0); assert.equal(h.P.done.test, undefined);
  }
});

test('manual USDT approval cannot complete the project, but the bound final mint recovers exactly once', async () => {
  const h = harness({ realPreview: true, fileEnabled: true, jobs: [{ schemaVersion: 1, c: target, data: '0x12345678', value: '0', usdt: 1 }] }), submissions = [];
  h.W.baw = async args => {
    if (args[1] === 'preview') {
      const to = args[args.indexOf('--to') + 1], approval = to === USDT;
      if (!approval) assert.equal(h.P.done.test, undefined, 'verified allowance must not mark project minted');
      return { j: { success: true, data: { requestId: approval ? 'approve' : 'mint', simulationResult: {
        balanceChanges: approval ? [] : [{ owner: walletAddress, contractAddress: reward, change: '1', tokenType: 'Erc20' }],
        allowanceChanges: approval ? [{ owner: walletAddress, contractAddress: USDT, spender: target }] : [], authorityChanges: [],
      } } } };
    }
    const requestId = args[args.indexOf('--requestId') + 1]; submissions.push(requestId);
    assert.equal(h.P.done.test, undefined);
    if (requestId === 'approve') { assert.equal(h.S.walletPending.test.manualMintProject, undefined); assert.equal(h.S.walletPending.test.mintContext, undefined); return { j: { success: true, data: { txHash: '0x' + 'aa'.repeat(32) } } }; }
    assert.equal(h.S.walletPending.test.manualMintProject, target);
    assert.equal(h.S.walletPending.test.mintContext?.final, true); assert.equal(h.S.walletPending.test.mintContext?.project, target);
    return { j: { success: false, data: { txHash: '0x' + 'ab'.repeat(32) }, error: { name: 'TIMEOUT', message: 'mock interrupted mint' } } };
  };
  await h.api.manualMints();
  assert.deepEqual(submissions, ['approve', 'mint']); assert.equal(h.P.done.test, undefined); assert.equal(h.S.walletPending.test.manualMintProject, target);
  assert.equal((await h.api.recoverScannerWallet(h.W)).status, 'confirmed'); assert.equal(h.P.done.test, 'minted'); assert.equal(h.S.walletPending.test, undefined);
  await h.api.recoverScannerWallet(h.W); assert.deepEqual(submissions, ['approve', 'mint']);
});


test('a full remaining USDT project allocation is reserved once before approval and survives final revalidation', async () => {
  const h = harness({ actualScale: true, realPreview: true, maxUsd: 30, limitValue: 20 });
  const held = h.sandbox.MINT_PARTICIPATION.quote({ project: target, cap: '10000', sold: '9000', unitBnbWei: '1000000000000000', quantity: '180', amountBnbWei: '180000000000000000' });
  const other = h.sandbox.MINT_PARTICIPATION.reserve(held, 'other-wallet'); h.sandbox.MINT_PARTICIPATION.settle(other, { status: 'confirmed', txHash: '0x' + 'cd'.repeat(32) });
  const submissions = [];
  h.W.baw = async args => {
    if (args[1] === 'preview') { const to = args[args.indexOf('--to') + 1]; return { j: { success: true, data: { requestId: to === USDT ? 'approve' : 'mint', simulationResult: { balanceChanges: to === USDT ? [] : [{ owner: walletAddress, contractAddress: reward, change: '1', tokenType: 'Erc20' }], allowanceChanges: to === USDT ? [{ owner: walletAddress, contractAddress: USDT, spender: target }] : [], authorityChanges: [] } } } }; }
    submissions.push(args[args.indexOf('--requestId') + 1]); return { j: { success: true, data: { txHash: '0x' + 'ab'.repeat(32) } } };
  };
  await h.api.executeUsdtMint(h.W, { to: target, data: '0xe38fd349' + word(20), need: 20n * 10n ** 18n });
  assert.deepEqual(submissions, ['approve', 'mint']);
  const entries = Object.values(h.S.mintParticipation.projects[target].reservations); assert.equal(entries.length, 2); assert.ok(entries.every(entry => entry.status === 'confirmed')); assert.equal(entries.reduce((sum, entry) => sum + BigInt(entry.quantity), 0n), 200n);
});

test('BNB mint quote allows the existing 0.5 percent fee buffer while charging every wei to the collective cap', async () => {
  const h = harness({ actualScale: true, realPreview: true }), calls = attachMintWallet(h);
  const value = 1005000000000000n;
  await h.api.previewExec(h.W, target, '0xe38fd349' + word(1), value, sim => h.api.mintSimulationCheck(sim, h.W, { bnbWei: value }));
  assert.equal(calls.filter(args => args[1] === 'execute').length, 1);
  const [entry] = Object.values(h.S.mintParticipation.projects[target].reservations); assert.equal(entry.quantity, '1'); assert.equal(entry.amountBnbWei, value.toString()); assert.equal(entry.status, 'confirmed');
});

test('a scale failure before a USDT recharge produces no swap, approval, or execution', async () => {
  const h = harness({ actualScale: true, realPreview: true, usdtBalance: 0n, scaleCap: 9999 });
  const calls = attachMintWallet(h);
  await assert.rejects(h.api.executeUsdtMint(h.W, { to: target, data: '0xe38fd349' + word(1), need: 10n ** 18n }), error => error.code === 'MINT_POLICY_DEFERRED');
  assert.equal(calls.length, 0); assert.equal(h.events.reservationCalls?.length || 0, 0);
});

test('scale limits and missing project pricing stay deferred across repeated paid rounds without permanent failure counts', async () => {
  const h = harness({ actualScale: true, realPreview: true, scaleCap: 9999 }), calls = attachMintWallet(h);
  for (let attempt = 0; attempt < 8; attempt++) await h.api.paidLoop();
  assert.equal(h.P.done.test, undefined); assert.equal(h.P.failW?.test, undefined); assert.equal(h.P.unmintable, undefined); assert.ok(h.P.policyDeferredAt); assert.equal(calls.filter(args => args[1] === 'execute').length, 0);
});


test('stale mature-wallet counts cannot authorize a fee mint when fresh qualification is unavailable', async () => {
  const h = harness({ actualScale: true, realPreview: true }), calls = attachMintWallet(h);
  h.P.heatAt = h.sandbox.Date.now() - 120001;
  h.context.AGENT_MATURITY = { qualify: async () => { throw Error('mock historical proof unavailable'); } };
  assert.match(await h.api.autoMint(target, 'mint-test', h.W, 10n ** 15n), /无法重新核验/);
  assert.equal(h.P.agents, 0); assert.equal(h.P.heatAt, 0); assert.equal(calls.length, 0);
});
