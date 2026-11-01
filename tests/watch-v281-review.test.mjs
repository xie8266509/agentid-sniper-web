import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { decodeAbiUint } from '../lib/nft-codec.mjs';

const REGISTRY = '0x60b9262456de011f7d15a54cdd8c48baaa8b022f';
const A = '0x1111111111111111111111111111111111111111', B = '0x2222222222222222222222222222222222222222', C = '0x3333333333333333333333333333333333333333';
const hex = value => '0x' + BigInt(value).toString(16), word = value => '0x' + BigInt(value).toString(16).padStart(64, '0');
async function maturityFixture({ historical = {}, current = {}, nonces = {} } = {}) {
  const { createAgentMaturity } = await import('../lib/agent-maturity.mjs');
  let clock = 1700500000000, head = 1000000, unavailable = false;
  const headTime = 1700500000, reads = [];
  const timestamp = block => headTime + Math.floor((block - 1000000) / 2);
  const rpc = async (method, params = []) => {
    reads.push({ method, params });
    if (unavailable) throw Error('mock RPC unavailable');
    if (method === 'eth_chainId') return '0x38';
    if (method === 'eth_blockNumber') return hex(head);
    if (method === 'eth_getBlockByNumber') {
      const block = params[0] === 'latest' ? head : Number(BigInt(params[0]));
      return { number: hex(block), timestamp: hex(timestamp(block)), hash: '0x' + 'ab'.repeat(32) };
    }
    if (method === 'eth_call') {
      assert.equal(params[0].to.toLowerCase(), REGISTRY);
      const address = '0x' + params[0].data.slice(-40).toLowerCase();
      const map = params[1] === 'latest' || Number(BigInt(params[1])) === head ? current : historical;
      const value = Object.hasOwn(map, address) ? map[address] : 1;
      return value === null ? undefined : word(value);
    }
    if (method === 'eth_getTransactionCount') return Object.hasOwn(nonces, params[0]) ? nonces[params[0]] : '0x8';
    throw Error('Unexpected mock RPC: ' + method);
  };
  const rpcBatch = async requests => Promise.all(requests.map(async request => { try { return await rpc(request.method, request.params); } catch { return undefined; } }));
  const api = createAgentMaturity({ rpc, rpcBatch, registry: REGISTRY, now: () => clock });
  return { api, reads, timestamp, get head() { return head; }, advance(ms) { clock += ms; head += Math.floor(ms / 500); }, fail() { unavailable = true; } };
}

test('Agent maturity proves a real full day at historical block time rather than a fixed block estimate', async () => {
  const h = await maturityFixture({ historical: { [B]: 0 }, nonces: { [B]: '0x64' } });
  const qualified = await h.api.qualify([A, B]);
  assert.deepEqual([...qualified], [A], 'a new registrant remains excluded despite a high current nonce');
  const tags = h.reads.filter(read => read.method === 'eth_call' && read.params[1] !== 'latest').map(read => Number(BigInt(read.params[1]))).filter(block => block < h.head);
  assert.ok(tags.length > 0, 'a latest-only balance cannot establish registration age');
  for (const block of tags) assert.ok(h.timestamp(h.head) - h.timestamp(block) >= 86400, 'the historical proof must cover all 24 hours');
  assert.ok(tags.some(block => h.head - block >= 172799), 'a half-second chain needs more than the upstream 115200-block guess');
});

test('unknown historical or current Agent ownership and malformed or low nonce never qualify', async () => {
  for (const options of [{ historical: { [A]: null } }, { current: { [A]: null } }, { current: { [A]: 0 } }, ...[undefined, null, '0x7', '0x8junk', '8junk', '-1', ''].map(nonce => ({ nonces: { [A]: nonce } }))]) {
    const h = await maturityFixture(options);
    assert.deepEqual([...await h.api.qualify([A])], [], JSON.stringify(options));
  }
});

test('expired Agent proofs cannot preserve a qualifying count when fresh RPC evidence is unavailable', async () => {
  const h = await maturityFixture();
  assert.deepEqual([...await h.api.qualify([A, B, C])], [A, B, C]);
  h.advance(16 * 60000); h.fail();
  assert.deepEqual([...await h.api.qualify([A, B, C]).catch(() => new Set())], [], 'RPC failure must not reuse an expired positive set');
});

function holdingsFixture({ pending = false } = {}) {
  const source = readFileSync(new URL('../watch.mjs', import.meta.url), 'utf8'), start = source.indexOf('async function holdW('), end = source.indexOf('// ---------- 新的 Agent ID', start);
  assert.ok(start >= 0 && end > start);
  const st = { done: true, doneAt: Date.now(), lastBal: '9', checked: true, hist: [], done2: [], notified: [], ...(pending ? { pendingSell: { orderId: 'mock-pending' } } : {}) }, events = [];
  const sandbox = { S: { tokens: {}, dyn: [{ addr: C, sym: 'TEST', cost: 1, only: A }] }, TOKENS: [], MONITOR_ONLY: false, structuredClone, positionStateKey: (wallet, token) => wallet + ':' + token,
    recoverScannerWallet: async () => { events.push('recover-wallet'); }, rulesFor: () => ({}), canWallet: () => false, tokenCostFor: () => 1,
    positionFor: () => st, decodeAbiUint, call: async () => { events.push('balance'); return '0x'; }, wa: address => address.slice(2).padStart(64, '0'),
    sell: async () => { events.push('reconcile-sell'); return false; }, save() {},
  };
  vm.runInNewContext(source.slice(start, end) + '\nglobalThis.run = holdW;', sandbox);
  return { st, events, run: () => sandbox.run({ id: 'review-wallet', addr: A }, 1000000, false) };
}

test('a recent done marker cannot postpone an unresolved order or wallet recovery for thirty minutes', async () => {
  const h = holdingsFixture({ pending: true }); await h.run();
  assert.deepEqual(h.events, ['recover-wallet', 'reconcile-sell']);
  assert.equal(h.st.pendingSell.orderId, 'mock-pending'); assert.equal(h.st.lastBal, '9');
});

test('unknown holdings balance preserves the last real balance and cannot establish a zero-balance cooldown', async () => {
  const h = holdingsFixture(), before = h.st.doneAt; await h.run();
  assert.deepEqual(h.events, ['recover-wallet', 'balance']); assert.equal(h.st.lastBal, '9'); assert.equal(h.st.doneAt, before);
  assert.equal(h.st.eligibility, 'read-error');
});

async function participationFixture() {
  const { createMintParticipation } = await import('../lib/mint-participation.mjs');
  const state = {}, writes = []; let clock = 1700500000000;
  const options = { state, now: () => clock, save: strict => writes.push(strict) }, api = createMintParticipation(options);
  const quote = (quantity, overrides = {}) => api.quote({ project: C, cap: '1000', sold: '500', unitBnbWei: '10000000000000000', quantity: String(quantity), amountBnbWei: String(BigInt(quantity) * 10000000000000000n), ...overrides });
  return { api, state, writes, quote, advanceDay() { clock += 86400000; }, reload: () => createMintParticipation(options) };
}

test('two-percent participation is one persistent aggregate across four wallets, confirmations, and restarts', async () => {
  const h = await participationFixture();
  const ids = ['a', 'b', 'c', 'd'].map(wallet => h.api.reserve(h.quote(5), wallet));
  assert.throws(() => h.quote(1), /2%|2％|份额|上限|额度|占比/);
  h.api.settle(ids[0], { status: 'confirmed', txHash: '0x' + 'ab'.repeat(32) });
  h.api.settle(ids[0], { status: 'confirmed', txHash: '0x' + 'ab'.repeat(32) });
  assert.throws(() => h.quote(1), /2%|2％|份额|上限|额度|占比/, 'confirmation is not a release of the project allowance');
  h.advanceDay();
  assert.throws(() => h.reload().quote({ project: C, cap: '1000', sold: '500', unitBnbWei: '10000000000000000', quantity: '1', amountBnbWei: '10000000000000000' }), /2%|2％|份额|上限|额度|占比/, 'neither date rollover nor process restart resets mint shares');
  h.api.settle(ids[1], { status: 'reverted' });
  h.api.reserve(h.quote(5), 'e');
  assert.throws(() => h.quote(1), /2%|2％|份额|上限|额度|占比/);
  assert.ok(h.writes.length > 0 && h.writes.every(value => value === true));
});

test('a second wallet cannot reserve a stale preflight quote after another wallet consumes its headroom', async () => {
  const h = await participationFixture(), first = h.quote(12), second = h.quote(12);
  h.api.reserve(first, 'wallet-a');
  assert.throws(() => h.api.reserve(second, 'wallet-b'), /2%|2％|份额|上限|额度|占比/);
});

test('unknown legacy mints block additions, both quantity and payment caps apply, and a larger later cap cannot reset history', async () => {
  const h = await participationFixture();
  assert.throws(() => h.quote(1, { legacyUnknown: true }), /历史|旧|数量|核验|未知/);
  const clean = await participationFixture();
  assert.throws(() => clean.quote(1, { amountBnbWei: '200000000000000001' }), /2%|2％|份额|上限|额度|占比/);
  const id = clean.api.reserve(clean.quote(5), 'wallet-a');
  clean.api.settle(id, { status: 'confirmed', txHash: '0x' + 'cd'.repeat(32) });
  assert.throws(() => clean.quote(16, { cap: '2000' }), /2%|2％|份额|上限|额度|占比/);
  assert.throws(() => clean.quote(6, { cap: '500', unitBnbWei: '20000000000000000', amountBnbWei: '60000000000000000' }), /2%|2％|份额|上限|额度|占比/);
});

test('newly discovered unknown mint history is not ignored merely because a project ledger already exists', async () => {
  const h = await participationFixture(); h.api.reserve(h.quote(5), 'wallet-a');
  assert.throws(() => h.quote(1, { legacyUnknown: true }), /历史|旧|数量|核验|未知/);
});

test('failed durable reservation cannot return an executable plan or reopen its in-memory headroom', async () => {
  const { createMintParticipation } = await import('../lib/mint-participation.mjs');
  const state = {}, api = createMintParticipation({ state, save: () => { throw Error('mock durable save failed'); } });
  const plan = api.quote({ project: C, cap: '1000', sold: '500', unitBnbWei: '10000000000000000', quantity: '20', amountBnbWei: '200000000000000000' });
  assert.throws(() => api.reserve(plan, 'wallet-a'), /durable save failed/);
  assert.throws(() => api.quote({ ...plan, quantity: '1', amountBnbWei: '10000000000000000' }), /2%|2％|份额|上限|额度|占比/, 'the unresolved in-memory reservation stays occupied after the failed save');
});

test('USDT project size rounds down while the actual payment allowance rounds up', async () => {
  const source = readFileSync(new URL('../watch.mjs', import.meta.url), 'utf8'), start = source.indexOf('function legacyParticipationUnknown('), end = source.indexOf('function settleMintParticipation(', start);
  assert.ok(start >= 0 && end > start);
  const USDT = '0x55d398326f99059ff775485246999027b3197955', NATIVE_BNB = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
  const sandbox = { S: {}, USDT, NATIVE_BNB, decodeAbiUint, MINT_PARTICIPATION: { quote: plan => plan }, mintQuantity: () => 1,
    codeOf: async () => '0x63725c4058', fullCode: async (_project, code) => code, progressOf: async () => ({ cap: 1000, sold: 500 }),
    call: async () => word(6n * 10n ** 18n), w: value => BigInt(value).toString(16).padStart(64, '0'), bnbUsd: async () => 600.0000001,
  };
  vm.runInNewContext(source.slice(start, end) + '\nglobalThis.quote = quoteAutomaticParticipation;', sandbox);
  const result = await sandbox.quote({ id: 'wallet-a', addr: A }, C, '0xa0712d68' + '0'.repeat(63) + '1', 0n, { paymentToken: USDT, paymentWei: 6n * 10n ** 18n });
  assert.ok(BigInt(result.unitBnbWei) < 10n ** 16n, 'an almost-ten-BNB project must not be rounded upward into passing');
  assert.ok(BigInt(result.amountBnbWei) >= 10n ** 16n, 'payment preallocation must not round the charged amount downward');
});

for (const stage of ['approval', 'mint']) test(`a verified USDT ${stage} revert releases shares and completes budget cleanup without a conflicting terminal status`, async () => {
  const h = await participationFixture(), source = readFileSync(new URL('../watch.mjs', import.meta.url), 'utf8');
  const from = source.indexOf('async function executeUsdtMintInner('), to = source.indexOf('// 鑄造進度：', from), settleFrom = source.indexOf('function settleMintParticipation('), settleTo = source.indexOf('function applyManualMintCompletion(', settleFrom);
  assert.ok(from >= 0 && to > from && settleFrom >= 0 && settleTo > settleFrom);
  const USDT = '0x55d398326f99059ff775485246999027b3197955', W = { id: 'wallet-a', addr: A }, S = { paidSpend: { day: 'mock-day' }, walletPending: {} }, settled = [];
  const sandbox = { S, USDT, NATIVE_BNB: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', MONITOR_ONLY: false, MINT_PARTICIPATION: h.api, decodeAbiUint,
    paidFor: () => ({ maxUsd: 20, maxBnbPerDay: 1, keepBnb: .006 }), validMintAddress: () => true, validMintCalldata: () => true, badSel: () => false,
    mintUint: BigInt, bnbUsd: async () => 1000, resetPaidBudgetDay: () => S.paidSpend, rpc: async () => hex(10n ** 18n), call: async () => word(10n * 10n ** 18n), big: BigInt,
    withinPaidBudget: () => true, safeAddrs: async (_wallet, _to, data) => data, MINT_RISK: { projectCheck: async () => ({}) }, mintQuantity: () => 1,
    quoteAutomaticParticipation: async () => h.quote(1), bnbBudgetWei: value => BigInt(Math.round(value * 1e9)) * 1000000000n, usdBudgetMicros: value => String(Math.ceil(value * 1e6)),
    currentRuntimeConfig: () => ({}), scannerBudget: () => ({ reserve: async () => ({ id: 'mock-budget' }), settle: async (...args) => { settled.push(args); } }),
    wa: address => address.slice(2).padStart(64, '0'), w: value => BigInt(value).toString(16).padStart(64, '0'), save() {},
    revokeOnFail: async (_wallet, _token, _spender, operation) => operation(), markWalletBlocked: async () => { throw Error('a known revert cannot become unknown'); },
  };
  sandbox.previewExec = async (wallet, target) => {
    const final = target === C, scope = wallet.paidReservation, pending = { participationId: scope.participationId, participationFinal: final, reservationId: scope.reservation.id, phase: 'verified' };
    S.walletPending[wallet.id] = pending;
    const reverted = stage === 'approval' ? !final : final;
    sandbox.settle(pending, { resolved: true, status: reverted ? 'reverted' : 'confirmed', txHash: '0x' + 'ab'.repeat(32) }, scope);
    if (reverted) throw Error('mock ' + stage + ' reverted');
    return { tx: '0x' + 'ab'.repeat(32), sim: {} };
  };
  vm.runInNewContext(source.slice(settleFrom, settleTo) + source.slice(from, to) + '\nglobalThis.run = executeUsdtMintInner; globalThis.settle = settleMintParticipation;', sandbox);
  await assert.rejects(sandbox.run(W, { to: C, data: '0xa0712d68' + '0'.repeat(63) + '1', need: 10n * 10n ** 18n }), new RegExp('mock ' + stage + ' reverted'));
  assert.equal(settled.length, 1, 'budget cleanup runs after the verified release'); assert.equal(S.walletPending[W.id], undefined); assert.equal(W.paidReservation, undefined);
  assert.doesNotThrow(() => h.quote(20), 'the failed mint does not consume confirmed shares');
});

test('a later manual mint cannot hide behind the same wallet already covered by an automatic ledger entry', async () => {
  const h = await participationFixture(), id = h.api.reserve(h.quote(1), 'wallet-a'); h.api.settle(id, { status: 'confirmed', txHash: '0x' + 'cd'.repeat(32) });
  const source = readFileSync(new URL('../watch.mjs', import.meta.url), 'utf8'), start = source.indexOf('function applyManualMintCompletion('), end = source.indexOf('async function previewExec(', start);
  const wallet = { id: 'wallet-a', addr: A }, sandbox = { S: h.state, MINT_PARTICIPATION: h.api, FORCE: new Set(), WALLETS: [wallet], validMintAddress: () => true, validMintCalldata: () => true, badSel: () => false, save() {} };
  vm.runInNewContext(source.slice(start, end) + '\nglobalThis.run = applyManualMintCompletion;', sandbox);
  sandbox.run(wallet, { kind: 'contract', walletId: wallet.id, walletAddress: wallet.addr, manualMintProject: C, expected: { to: C, inputData: '0x12345678' } }, '0x' + 'ab'.repeat(32));
  assert.throws(() => h.quote(1), /历史|旧|数量|核验|未知/);
  delete h.state.paid;
  assert.throws(() => h.reload().quote({ project: C, cap: '1000', sold: '500', unitBnbWei: '10000000000000000', quantity: '1', amountBnbWei: '10000000000000000' }), /历史|旧|数量|核验|未知/, 'removing the transient project row cannot erase the unknown quantity evidence');
});

test('opening discovery and ordinary holdings reuse the same per-wallet worker rather than writing concurrently', async () => {
  const source = readFileSync(new URL('../watch.mjs', import.meta.url), 'utf8'), from = source.indexOf('const HOLDINGS_WALLET_JOBS ='), to = source.indexOf('async function holdW(', from);
  const calls = []; let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const sandbox = { S: {}, WALLETS: [{ id: 'wallet-a', addr: A }], syncWalletProfiles() {}, save() {}, logWallet() {}, sleep: async () => {},
    holdW: async (_wallet, _head, mode) => { calls.push(mode); if (calls.length === 1) await blocked; },
  };
  vm.runInNewContext(source.slice(from, to) + '\nglobalThis.run = holdings;', sandbox);
  await sandbox.run(1000000, false); await sandbox.run(1000001, 'open');
  assert.deepEqual(calls, [false], 'a quick opening check cannot overlap a still-running regular holdings job');
  release(); for (let index = 0; index < 20; index++) await Promise.resolve();
  await sandbox.run(1000002, 'open'); assert.deepEqual(calls, [false, 'open']);
});

test('opening discovery remains read-only in monitor mode and never fabricates a zero balance from an unknown read', async () => {
  const source = readFileSync(new URL('../watch.mjs', import.meta.url), 'utf8'), from = source.indexOf('async function holdW('), to = source.indexOf('// ---------- 新的 Agent ID', from);
  for (const balance of [null, 5n]) {
    const st = { lastBal: '9', checked: true }, events = [], sandbox = { S: { tokens: {}, dyn: [{ addr: C, sym: 'TEST', only: A, boughtAt: Date.now() }] }, TOKENS: [], MONITOR_ONLY: true, structuredClone,
      positionStateKey: (wallet, token) => wallet + ':' + token, positionFor: () => st, recoverScannerWallet: async () => {}, rulesFor: () => ({}), canWallet: () => false,
      call: async () => balance === null ? '0x' : word(balance), decodeAbiUint, wa: address => address.slice(2).padStart(64, '0'), findPair: async () => { events.push('pair'); return { pair: B }; }, tg: async () => { events.push('notify'); },
      sell: async () => { throw Error('opening detection cannot sell in monitor mode'); }, honeypotCheck: async () => { events.push('simulate'); },
    };
    vm.runInNewContext(source.slice(from, to) + '\nglobalThis.run = holdW;', sandbox); await sandbox.run({ id: 'wallet-a', addr: A }, 1000000, 'open');
    assert.equal(st.lastBal, '9'); assert.equal(st.doneAt, undefined); assert.equal(st.done, undefined);
    assert.deepEqual(events, balance === null ? [] : ['pair', 'simulate', 'notify']); assert.equal(st.pair, balance === null ? undefined : B);
  }
});

test('pending participation survives unknown outcomes and approval confirmation, then only releases or confirms at a verified recovery boundary', async () => {
  const h = await participationFixture(), source = readFileSync(new URL('../watch.mjs', import.meta.url), 'utf8'), from = source.indexOf('function settleMintParticipation('), to = source.indexOf('function applyManualMintCompletion(', from);
  const sandbox = { MINT_PARTICIPATION: h.api }; vm.runInNewContext(source.slice(from, to) + '\nglobalThis.run = settleMintParticipation;', sandbox);
  const id = h.api.reserve(h.quote(20), 'wallet-a'), pending = { participationId: id, participationFinal: false }, txHash = '0x' + 'ab'.repeat(32);
  sandbox.run(pending, { resolved: false, status: 'unknown' });
  assert.throws(() => h.quote(1), /2%|2％|份额|上限|额度|占比/, 'unknown submission remains reserved');
  sandbox.run(pending, { resolved: true, status: 'confirmed', txHash }, {});
  assert.throws(() => h.quote(1), /2%|2％|份额|上限|额度|占比/, 'an approval confirmed inside its ongoing scope does not release the final mint allocation');
  sandbox.run(pending, { resolved: true, status: 'confirmed', txHash });
  assert.doesNotThrow(() => h.quote(20), 'a recovered approval cannot resume minting and may release its unspent final mint shares');
  const final = { participationId: h.api.reserve(h.quote(20), 'wallet-a'), participationFinal: true };
  sandbox.run(final, { resolved: true, status: 'confirmed', txHash }); sandbox.run(final, { resolved: true, status: 'confirmed', txHash });
  assert.throws(() => h.quote(1), /2%|2％|份额|上限|额度|占比/, 'a confirmed final mint consumes the allocation exactly once');
});

test('the retained opening honeypot check only simulates a transfer and cannot call the wallet CLI', async () => {
  const source = readFileSync(new URL('../watch.mjs', import.meta.url), 'utf8'), from = source.indexOf('async function honeypotCheck('), to = source.indexOf('async function revokeWalletApproval(', from), requests = [];
  const sandbox = { MONITOR_ONLY: true, rpc: async (...args) => { requests.push(args); return '0x'; }, wa: address => address.slice(2).padStart(64, '0'), w: value => BigInt(value).toString(16).padStart(64, '0'), tg: async () => {} };
  vm.runInNewContext(source.slice(from, to) + '\nglobalThis.run = honeypotCheck;', sandbox);
  await sandbox.run({ addr: A, baw() { throw Error('no wallet CLI for read-only opening simulation'); } }, { addr: C }, { pair: B }, 100n);
  assert.equal(requests.length, 1); assert.equal(requests[0][0], 'eth_call'); assert.equal(requests[0][1][0].from, A); assert.equal(requests[0][1][0].to, C);
});

test('the normal BNB safety margin is allowed as a full payment while every extra wei remains under the two-percent cap', async () => {
  const h = await participationFixture(), source = readFileSync(new URL('../watch.mjs', import.meta.url), 'utf8'), from = source.indexOf('function legacyParticipationUnknown('), to = source.indexOf('function settleMintParticipation(', from);
  let quantity = 2;
  const sandbox = { S: {}, NATIVE_BNB: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', USDT: '0x55d398326f99059ff775485246999027b3197955', decodeAbiUint, MINT_PARTICIPATION: h.api,
    codeOf: async () => '0x6368bce8cd', fullCode: async (_project, code) => code, progressOf: async () => ({ cap: 1000, sold: 500 }), mintQuantity: () => quantity,
    call: async (_project, data) => word(BigInt('0x' + data.slice(-64)) * 10000000000000000n), w: value => BigInt(value).toString(16).padStart(64, '0'),
  };
  vm.runInNewContext(source.slice(from, to) + '\nglobalThis.run = quoteAutomaticParticipation;', sandbox);
  const value = 20100000000000000n, result = await sandbox.run({ id: 'wallet-a', addr: A }, C, '0xa0712d68' + '0'.repeat(63) + '2', value);
  assert.equal(String(result.quantity), '2'); assert.equal(BigInt(result.amountBnbWei), value); assert.equal(BigInt(result.unitBnbWei), 10000000000000000n);
  quantity = 20;
  await assert.rejects(sandbox.run({ id: 'wallet-a', addr: A }, C, '0xa0712d68' + BigInt(quantity).toString(16).padStart(64, '0'), 201000000000000000n), /2%|2％|份额|上限|额度|占比/, 'the 0.5% margin cannot be excluded from the actual project payment');
});
