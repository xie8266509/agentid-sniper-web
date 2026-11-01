import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ensureEntryPolicy, effectiveEntryPolicy, entryGate, validNftUri, createMintRisk } from '../lib/mint-policy.mjs';

test('installation entry thresholds are generated once and remain stable across restarts', () => {
  const state = {};
  const values = [0.5, 0.5];
  const initial = ensureEntryPolicy(state, () => values.shift());
  assert.ok(initial.goPct >= 0.8 && initial.goPct <= 0.9);
  assert.ok(Number.isInteger(initial.minAgents) && initial.minAgents >= 150 && initial.minAgents <= 200);
  assert.deepEqual(state.entryPolicy, initial);
  assert.deepEqual(ensureEntryPolicy(state, () => { throw new Error('valid persisted thresholds must not be regenerated'); }), initial);
  assert.deepEqual(ensureEntryPolicy(JSON.parse(JSON.stringify(state)), () => { throw new Error('restart must reuse the persisted thresholds'); }), initial);
});

test('invalid old thresholds cannot weaken the new minimum entry policy', () => {
  for (const entryPolicy of [null, {}, { goPct: 0.6, minAgents: 100 }, { goPct: NaN, minAgents: 150 }, { goPct: 0.85, minAgents: 149 }]) {
    const state = { entryPolicy };
    const policy = ensureEntryPolicy(state, () => 0);
    assert.ok(policy.goPct >= 0.8 && policy.goPct <= 0.9);
    assert.ok(policy.minAgents >= 150 && policy.minAgents <= 200);
  }
});

test('each wallet can raise its progress threshold but cannot lower the installation gate', () => {
  const policy = { goPct: 0.85, minAgents: 175 };
  assert.deepEqual(effectiveEntryPolicy(policy, 0.6), policy);
  assert.deepEqual(effectiveEntryPolicy(policy, 0.95), { goPct: 0.95, minAgents: 175 });
  assert.equal(entryGate({ progress: 0.9, agents: 175, configuredPct: 0.95, policy }).allowed, false);
  assert.equal(entryGate({ progress: 0.96, agents: 175, configuredPct: 0.95, policy }).allowed, true);
});

test('known progress and verified sender count must both pass, without the old 20-wallet fallback', () => {
  const policy = { goPct: 0.85, minAgents: 175 };
  for (const [progress, agents] of [[0, 1000], [0.01, 1000], [0.84, 1000], [0.9, 20], [1, 174]]) {
    assert.equal(entryGate({ progress, agents, policy }).allowed, false, JSON.stringify({ progress, agents }));
  }
  assert.equal(entryGate({ progress: 0.85, agents: 175, policy }).allowed, true);
});

test('unreadable progress permits only enough verified senders before a pool opens', () => {
  const policy = { goPct: 0.85, minAgents: 175 };
  assert.equal(entryGate({ progress: null, agents: 174, policy }).allowed, false);
  assert.equal(entryGate({ progress: null, agents: 175, policy }).allowed, true);
  assert.equal(entryGate({ progress: null, agents: 175, policy, poolOpen: true }).allowed, false);
});

test('NFT metadata checks accept recognized URI formats without claiming image authenticity', () => {
  for (const uri of ['https://example.org/metadata/1.json', 'data:application/json;base64,e30=', 'ipfs://Qm' + 'a'.repeat(44), 'ar://' + 'a'.repeat(43)]) assert.equal(validNftUri(uri), true, uri);
  for (const uri of ['', 'ipfs://sniper-test-nft/1', 'https://', 'file:///tmp/metadata.json', 'javascript:alert(1)']) assert.equal(validNftUri(uri), false, uri);
});

const wallet = { id: 'wallet-a', name: 'Original display name', addr: '0x1111111111111111111111111111111111111111' };
const contract = '0x2222222222222222222222222222222222222222';
const usdt = '0x55d398326f99059ff775485246999027b3197955';
const pair = '0x3333333333333333333333333333333333333333';
const word = value => BigInt(value).toString(16).padStart(64, '0');
const addressWord = address => address.slice(2).padStart(64, '0');
const when = Date.parse('2026-11-01T08:00:00Z');
const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date(when));
const encodedString = text => { const b = Buffer.from(text); return '0x' + word(32) + word(b.length) + b.toString('hex').padEnd(Math.ceil(b.length / 32) * 64, '0'); };

function riskHarness(options = {}) {
  const state = options.state || {}, requests = [], writes = [];
  const rpc = async (method, params) => {
    requests.push({ method, params });
    if (options.rpc) { const response = await options.rpc(method, params); if (response !== undefined) return response; }
    if (method === 'eth_getCode') return options.nft ? '0x63c87b56dd' : '0x6000';
    if (method === 'eth_getStorageAt') return '0x' + word(0);
    if (method === 'eth_getBalance') return '0x' + (10n ** 18n).toString(16);
    if (method === 'eth_estimateGas') return '0x5208';
    if (method === 'eth_gasPrice') return '0x3b9aca00';
    if (method === 'eth_call') {
      const { to, data } = params[0];
      if (data.startsWith('0xc87b56dd')) return encodedString(options.uri ?? 'https://example.org/metadata/1.json');
      if (data === '0xfc0c546a') return '0x';
      if (to.toLowerCase() === usdt && data.startsWith('0x70a08231')) return '0x' + word(100n * 10n ** 18n);
      if (data.startsWith('0xe6a43905')) return '0x' + word(0);
    }
    throw new Error('Unexpected mocked RPC ' + method);
  };
  const api = createMintRisk({ state, rpc, fullCode: options.fullCode, now: options.now || (() => when), save: strict => writes.push({ strict, state: structuredClone(state) }), usdt });
  return { api, state, requests, writes };
}

test('gas and retained-BNB checks quote the exact from, target, calldata and payment', async () => {
  const h = riskHarness();
  const quote = await h.api.quoteTransaction(wallet, { to: contract, data: '0x12345678' + word(7), valueWei: 10n ** 15n, keepBnb: 0.006 });
  const request = h.requests.find(request => request.method === 'eth_estimateGas');
  assert.deepEqual(request.params[0], { from: wallet.addr, to: contract, data: '0x12345678' + word(7), value: '0x' + (10n ** 15n).toString(16) });
  assert.equal(quote.walletId, wallet.id);
  assert.equal(BigInt(quote.gasWei), 25200000000000n, 'reserve a 20% buffer over this transaction gas estimate');
  assert.equal(h.requests.some(request => request.method === 'eth_getBalance' && request.params[0] === wallet.addr), true);
});

test('unavailable gas, gas price, or balance cannot turn a failed risk read into permission to send', async () => {
  for (const failed of ['eth_estimateGas', 'eth_gasPrice', 'eth_getBalance']) {
    const h = riskHarness({ rpc(method) { if (method === failed) throw new Error('mock RPC unavailable'); } });
    await assert.rejects(h.api.quoteTransaction(wallet, { to: contract, data: '0x12345678' }), /unavailable/);
    assert.equal(Object.keys(h.state.mintRisk.reservations).length, 0);
  }
  for (const result of [null, '0x', 'malformed', '0x0']) {
    const h = riskHarness({ rpc(method) { if (method === 'eth_estimateGas') return result; } });
    await assert.rejects(h.api.quoteTransaction(wallet, { to: contract, data: '0x12345678' }), /gas|余额/);
  }
});

test('actual high gas and a balance below payment plus gas plus retained funds block the trade', async () => {
  const gas = riskHarness({ rpc(method) { if (method === 'eth_estimateGas') return '0xf4240'; } });
  await assert.rejects(gas.api.quoteTransaction(wallet, { to: contract, data: '0x12345678' }), /gas.*上限/);
  const low = riskHarness({ rpc(method) { if (method === 'eth_getBalance') return '0x' + (7n * 10n ** 15n).toString(16); } });
  await assert.rejects(low.api.quoteTransaction(wallet, { to: contract, data: '0x12345678', valueWei: 10n ** 15n, keepBnb: 0.006 }), /保留额/);
});

test('paid transaction gas also observes the wallet daily fee cap', async () => {
  const h = riskHarness({ state: { mintRisk: { spent: { [day + ':' + wallet.id]: '9990000000000000' } } } });
  await assert.rejects(h.api.quoteTransaction(wallet, { to: contract, data: '0x12345678', paid: true }), /0\.01 BNB/);
});

test('risk reservations survive restarts and wallet renames without consuming another wallet allowance', async () => {
  const h = riskHarness();
  const first = await h.api.quoteTransaction(wallet, { to: contract, data: '0x12345678', valueWei: 9n * 10n ** 15n, feeLike: true });
  const reservation = h.api.reserve(first);
  assert.ok(h.writes.some(write => write.strict && write.state.mintRisk.reservations[reservation]));
  const restarted = riskHarness({ state: JSON.parse(JSON.stringify(h.state)) });
  await assert.rejects(restarted.api.quoteTransaction({ ...wallet, name: 'Renamed wallet' }, { to: contract, data: '0x12345678', valueWei: 10n ** 15n, feeLike: true }), /0\.01 BNB/);
  const secondWallet = { ...wallet, id: 'wallet-b', addr: '0x4444444444444444444444444444444444444444' };
  const second = await restarted.api.quoteTransaction(secondWallet, { to: contract, data: '0x12345678', valueWei: 10n ** 15n, feeLike: true });
  assert.equal(second.walletId, 'wallet-b');
  assert.equal(Object.keys(restarted.state.mintRisk.reservations).length, 1);
});

test('two stale quotes cannot reserve more than the same wallet daily fee cap', async () => {
  const h = riskHarness();
  const quote = await h.api.quoteTransaction(wallet, { to: contract, data: '0x12345678', valueWei: 6n * 10n ** 15n, feeLike: true });
  h.api.reserve(quote);
  assert.throws(() => h.api.reserve(quote), /0\.01 BNB/);
  assert.equal(Object.keys(h.state.mintRisk.reservations).length, 1);
});

test('crossing midnight does not release unresolved transaction fee reservations', async () => {
  let clock = when;
  const h = riskHarness({ now: () => clock });
  const quote = await h.api.quoteTransaction(wallet, { to: contract, data: '0x12345678', valueWei: 9n * 10n ** 15n, feeLike: true });
  h.api.reserve(quote);
  clock += 86400000;
  await assert.rejects(h.api.quoteTransaction(wallet, { to: contract, data: '0x12345678', valueWei: 10n ** 15n, feeLike: true }), /0\.01 BNB/);
  assert.equal(Object.keys(h.state.mintRisk.reservations).length, 1);
});

test('unknown fees remain reserved until an exact receipt settles once; definite rejection releases without fees', async () => {
  const h = riskHarness();
  const quote = await h.api.quoteTransaction(wallet, { to: contract, data: '0x12345678', valueWei: 10n ** 15n, feeLike: true });
  const id = h.api.reserve(quote);
  for (const receipt of [null, { status: '0x1' }, { status: 'PENDING', gasUsed: '0x5208', effectiveGasPrice: '0x3b9aca00' }]) {
    h.api.settle(id, { receipt });
    assert.ok(h.state.mintRisk.reservations[id]);
  }
  h.api.settle(id, { receipt: { status: '0x1', gasUsed: '0x5208', effectiveGasPrice: '0x3b9aca00' } });
  assert.equal(h.state.mintRisk.reservations[id], undefined);
  assert.equal(h.state.mintRisk.spent[day + ':' + wallet.id], '1021000000000000');
  h.api.settle(id, { receipt: { status: '0x1', gasUsed: '0x5208', effectiveGasPrice: '0x3b9aca00' } });
  assert.equal(h.state.mintRisk.spent[day + ':' + wallet.id], '1021000000000000');
  const rejected = h.api.reserve(quote);
  h.api.settle(rejected, { rejected: true });
  assert.equal(h.state.mintRisk.reservations[rejected], undefined);
  assert.equal(h.state.mintRisk.spent[day + ':' + wallet.id], '1021000000000000');
});

test('two mined reverts stop this wallet on this contract without blocking another wallet or sells', async () => {
  const h = riskHarness();
  for (let attempt = 0; attempt < 2; attempt++) {
    const quote = await h.api.quoteTransaction(wallet, { to: contract, data: '0x12345678' });
    const id = h.api.reserve(quote);
    h.api.settle(id, { receipt: { status: '0x0', gasUsed: '0x5208', effectiveGasPrice: '0x3b9aca00' } });
  }
  await assert.rejects(h.api.quoteTransaction(wallet, { to: contract, data: '0x12345678' }), /失败两次/);
  assert.equal(h.state.mintRisk.spent[day + ':' + wallet.id], '42000000000000');
  assert.equal((await h.api.quoteTransaction({ ...wallet, id: 'wallet-b' }, { to: contract, data: '0x12345678' })).walletId, 'wallet-b');
});

test('a verified revert counts once before gas fields arrive, while the original fee reservation stays held', async () => {
  const h = riskHarness();
  const quote = await h.api.quoteTransaction(wallet, { to: contract, data: '0x12345678' });
  const first = h.api.reserve(quote), key = wallet.id + ':' + contract;
  h.api.settle(first, { receipt: { status: '0x0' } });
  assert.equal(h.state.mintRisk.reverts[key], 1);
  assert.ok(h.state.mintRisk.reservations[first]);
  h.api.settle(first, { receipt: { status: '0x0' } });
  assert.equal(h.state.mintRisk.reverts[key], 1, 'the same failed transaction must not count twice');
  h.api.settle(first, { receipt: { status: '0x0', gasUsed: '0x5208', effectiveGasPrice: '0x3b9aca00' } });
  assert.equal(h.state.mintRisk.reservations[first], undefined);
  assert.equal(h.state.mintRisk.reverts[key], 1, 'late gas accounting must not add another failure');
  const second = h.api.reserve(await h.api.quoteTransaction(wallet, { to: contract, data: '0x12345678' }));
  h.api.settle(second, { receipt: { status: '0x0' } });
  assert.equal(h.state.mintRisk.reverts[key], 2);
  assert.ok(h.state.mintRisk.reservations[second]);
  await assert.rejects(h.api.quoteTransaction(wallet, { to: contract, data: '0x12345678' }), /失败两次/);
});

test('proxy storage failure and a nonzero implementation slot reject automatic paid acquisition', async () => {
  const failed = riskHarness({ rpc(method) { if (method === 'eth_getStorageAt') throw new Error('storage RPC offline'); } });
  await assert.rejects(failed.api.projectCheck(contract), /offline/);
  const malformed = riskHarness({ rpc(method) { if (method === 'eth_getStorageAt') return '0x'; } });
  await assert.rejects(malformed.api.projectCheck(contract), /存储槽/);
  const proxy = riskHarness({ rpc(method) { if (method === 'eth_getStorageAt') return '0x' + addressWord(pair); } });
  await assert.rejects(proxy.api.projectCheck(contract), /可升级/);
});

for (const [name, slot] of [
  ['EIP-1967 implementation', '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'],
  ['EIP-1967 beacon', '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50'],
  ['legacy Zeppelin implementation', '0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3'],
]) test(`automatic payment detects the exact ${name} storage slot`, async () => {
  const h = riskHarness({ rpc(method, params) {
    if (method === 'eth_getStorageAt') return '0x' + (params[1] === slot ? addressWord(pair) : word(0));
  } });
  await assert.rejects(h.api.projectCheck(contract), /可升级/);
  assert.ok(h.requests.some(request => request.method === 'eth_getStorageAt' && request.params[1] === slot));
});

test('USDT acquisition checks contract token funds even though its native value is zero', async () => {
  const h = riskHarness({ rpc(method, params) {
    if (method === 'eth_call' && params[0].to.toLowerCase() === usdt && params[0].data.startsWith('0x70a08231')) return '0x' + word(0);
  } });
  await assert.rejects(h.api.projectCheck(contract, { paymentToken: usdt, paymentWei: 10n ** 18n }), /资金留存|流动性不足/);
  assert.ok(h.requests.some(request => request.method === 'eth_call' && request.params[0].to.toLowerCase() === usdt && request.params[0].data === '0x70a08231' + addressWord(contract)));
});

test('a pair address alone is insufficient when reserves are empty or cannot be read', async () => {
  for (const reserves of ['0x' + word(0) + word(0) + word(0), '0x']) {
    const h = riskHarness({ rpc(method, params) {
      if (method === 'eth_getBalance') return '0x0';
      if (method === 'eth_call' && params[0].data.startsWith('0xe6a43905')) return '0x' + addressWord(pair);
      if (method === 'eth_call' && params[0].data === '0x0902f1ac') return reserves;
    } });
    await assert.rejects(h.api.projectCheck(contract), /资金留存|流动性不足/);
  }
});

test('NFT URI rejection is distinct from missing token IDs, and network failure cannot silently pass', async () => {
  for (const uri of ['', 'ipfs://sniper-test-nft/1']) assert.match(await riskHarness({ nft: true, uri }).api.nftCheck(contract), /URI/);
  assert.equal(await riskHarness({ nft: true }).api.nftCheck(contract), '');
  const nonexistent = riskHarness({ nft: true, rpc(method) { if (method === 'eth_call') throw new Error('execution reverted: nonexistent token'); } });
  assert.equal(await nonexistent.api.nftCheck(contract), '');
  const unavailable = riskHarness({ nft: true, rpc(method) { if (method === 'eth_call') throw new Error('network timeout'); } });
  await assert.rejects(unavailable.api.nftCheck(contract), /timeout/);
});

test('the scanner concatenated proxy bytecode still checks NFT URI while malformed code is rejected', async () => {
  const joined = riskHarness({ uri: 'ipfs://sniper-test-nft/1', fullCode: async () => '0x6000' + '0xc87b56dd' });
  assert.match(await joined.api.nftCheck(contract), /URI/);
  assert.ok(joined.requests.some(request => request.method === 'eth_call' && request.params[0].data.startsWith('0xc87b56dd')));
  const invalid = riskHarness({ fullCode: async () => '0x6000' + '0xnot-hex' });
  await assert.rejects(invalid.api.nftCheck(contract), /实现代码/);
});
