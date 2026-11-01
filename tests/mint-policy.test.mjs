import assert from 'node:assert/strict';
import { test } from 'node:test';
import { id as signatureHash } from 'ethers';
import { ensureEntryPolicy, effectiveEntryPolicy, entryGate, validNftUri, createMintRisk, deriveMintCost } from '../lib/mint-policy.mjs';

test('installation entry thresholds are generated once and remain stable across restarts', () => {
  const state = {};
  const values = [0.5, 0.5];
  const initial = ensureEntryPolicy(state, () => values.shift());
  assert.ok(initial.goPct >= 0.6 && initial.goPct <= 0.7);
  assert.ok(Number.isInteger(initial.minAgents) && initial.minAgents >= 100 && initial.minAgents <= 130);
  assert.deepEqual(state.entryPolicy, initial);
  assert.deepEqual(ensureEntryPolicy(state, () => { throw new Error('valid persisted thresholds must not be regenerated'); }), initial);
  assert.deepEqual(ensureEntryPolicy(JSON.parse(JSON.stringify(state)), () => { throw new Error('restart must reuse the persisted thresholds'); }), initial);
});

test('invalid old thresholds cannot weaken the new minimum entry policy', () => {
  for (const entryPolicy of [null, {}, { goPct: 0.59, minAgents: 100 }, { goPct: NaN, minAgents: 150 }, { goPct: 0.65, minAgents: 99 }, { goPct: 0.85, minAgents: 175 }]) {
    const state = { entryPolicy };
    const policy = ensureEntryPolicy(state, () => 0);
    assert.ok(policy.goPct >= 0.6 && policy.goPct <= 0.7);
    assert.ok(policy.minAgents >= 100 && policy.minAgents <= 130);
  }
});

test('each wallet can raise its progress threshold but cannot lower the installation gate', () => {
  const policy = { goPct: 0.65, minAgents: 115 };
  assert.deepEqual(effectiveEntryPolicy(policy, 0.4), policy);
  assert.deepEqual(effectiveEntryPolicy(policy, 0.95), { goPct: 0.95, minAgents: 115 });
  assert.equal(entryGate({ progress: 0.9, agents: 115, configuredPct: 0.95, policy }).allowed, false);
  assert.equal(entryGate({ progress: 0.96, agents: 115, configuredPct: 0.95, policy }).allowed, true);
});

test('known progress and verified sender count must both pass, without the old 20-wallet fallback', () => {
  const policy = { goPct: 0.65, minAgents: 115 };
  for (const [progress, agents] of [[0, 1000], [0.01, 1000], [0.64, 1000], [0.9, 20], [1, 114]]) {
    assert.equal(entryGate({ progress, agents, policy }).allowed, false, JSON.stringify({ progress, agents }));
  }
  assert.equal(entryGate({ progress: 0.65, agents: 115, policy }).allowed, true);
});

test('unreadable non-NFT progress permits only enough verified senders before a pool opens', () => {
  const policy = { goPct: 0.65, minAgents: 115 };
  assert.equal(entryGate({ progress: null, agents: 114, policy }).allowed, false);
  assert.equal(entryGate({ progress: null, agents: 115, policy }).allowed, true);
  assert.equal(entryGate({ progress: null, agents: 115, policy, poolOpen: true }).allowed, false);
});

test('NFT entry requires known 70% progress and 150 verified senders even when the regular policy is lower', () => {
  const policy = { goPct: 0.6, minAgents: 100 };
  assert.deepEqual(effectiveEntryPolicy(policy, 0.6, { nft: true }), { goPct: 0.7, minAgents: 150 });
  for (const [progress, agents] of [[null, 500], [0, 500], [0.699, 500], [0.9, 149]]) {
    assert.equal(entryGate({ progress, agents, policy, nft: true }).allowed, false);
  }
  assert.equal(entryGate({ progress: 0.7, agents: 150, policy, nft: true }).allowed, true);
  assert.equal(entryGate({ progress: 0.8, agents: 150, configuredPct: 0.9, policy, nft: true }).allowed, false);
});

test('the v2.6.5 randomized installation policy migrates once without changing wallet configured thresholds', () => {
  const state = { entryPolicy: { goPct: 0.85, minAgents: 175 }, wallets: { 'wallet-a': { goPct: 0.95 } } };
  const before = structuredClone(state.wallets);
  const migrated = ensureEntryPolicy(state, () => 0.5);
  assert.ok(migrated.goPct >= 0.6 && migrated.goPct <= 0.7);
  assert.ok(migrated.minAgents >= 100 && migrated.minAgents <= 130);
  assert.deepEqual(state.wallets, before);
  assert.equal(effectiveEntryPolicy(migrated, state.wallets['wallet-a'].goPct).goPct, 0.95);
  assert.deepEqual(ensureEntryPolicy(state, () => { throw new Error('migration must only happen once'); }), migrated);
});

test('NFT metadata checks accept recognized URI formats without claiming image authenticity', () => {
  for (const uri of ['https://example.org/metadata/1.json', 'data:application/json;base64,e30=', 'ipfs://Qm' + 'a'.repeat(44), 'ar://' + 'a'.repeat(43)]) assert.equal(validNftUri(uri), true, uri);
  for (const uri of ['', 'ipfs://sniper-test-nft/1', 'https://', 'file:///tmp/metadata.json', 'javascript:alert(1)']) assert.equal(validNftUri(uri), false, uri);
});

const walletLimitSelector = signatureHash('maxPerWallet()').slice(0, 10);
const transactionLimitSelector = signatureHash('maxPerTx()').slice(0, 10);
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
    if (method === 'eth_getCode') return (options.nft ? '0x63c87b56dd' : '0x6000') + (options.noLimit ? '' : '63' + (options.limitKind === 'transaction' ? transactionLimitSelector : walletLimitSelector).slice(2));
    if (method === 'eth_getStorageAt') return '0x' + word(0);
    if (method === 'eth_getBalance') return '0x' + (10n ** 18n).toString(16);
    if (method === 'eth_estimateGas') return '0x5208';
    if (method === 'eth_gasPrice') return '0x3b9aca00';
    if (method === 'eth_call') {
      const { to, data } = params[0];
      if (data === walletLimitSelector || data === transactionLimitSelector) return '0x' + word(options.limitValue ?? 10);
      if (data.startsWith('0xc87b56dd')) return encodedString(options.uri ?? 'https://example.org/metadata/1.json');
      if (data === '0xfc0c546a') return '0x';
      if (to.toLowerCase() === '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c' && data.startsWith('0x70a08231')) return '0x' + word(0);
      if (to.toLowerCase() === usdt && data.startsWith('0x70a08231')) return '0x' + word(100n * 10n ** 18n);
      if (data.startsWith('0xe6a43905')) return '0x' + word(0);
    }
    throw new Error('Unexpected mocked RPC ' + method);
  };
  const api = createMintRisk({ state, rpc, bnbUsd: options.bnbUsd, fullCode: options.fullCode, nftMediaCheck: options.nftMediaCheck, now: options.now || (() => when), save: strict => writes.push({ strict, state: structuredClone(state) }), usdt });
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
    if (method === 'eth_getBalance') return '0x0';
    if (method === 'eth_call' && params[0].to.toLowerCase() === usdt && params[0].data.startsWith('0x70a08231')) return '0x' + word(0);
  } });
  await assert.rejects(h.api.projectCheck(contract, { paymentToken: usdt, paymentWei: 10n ** 18n }), /资金留存|流动性不足/);
  assert.ok(h.requests.some(request => request.method === 'eth_call' && request.params[0].to.toLowerCase() === usdt && request.params[0].data === '0x70a08231' + addressWord(contract)));
});

test('a pair address alone is insufficient when reserves are empty or cannot be read', async () => {
  for (const reserves of ['0x' + word(0) + word(0) + word(0), '0x']) {
    const h = riskHarness({ rpc(method, params) {
      if (method === 'eth_getBalance') return '0x0';
      if (method === 'eth_call' && params[0].to.toLowerCase() === usdt && params[0].data.startsWith('0x70a08231')) return '0x' + word(0);
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


test('paid projects require a readable quantity limit and distinguish wallet from per-transaction proof', async () => {
  const walletLimited = riskHarness();
  const proof = await walletLimited.api.walletLimitProof(contract);
  assert.equal(proof.kind, 'wallet'); assert.equal(proof.value, 10);
  const txLimited = riskHarness({ limitKind: 'transaction' });
  assert.equal((await txLimited.api.walletLimitProof(contract)).kind, 'transaction');
  await txLimited.api.projectCheck(contract, { quantity: 10 });
  await assert.rejects(txLimited.api.projectCheck(contract, { quantity: 11 }), /数量|上限/);
  assert.equal(await riskHarness({ noLimit: true }).api.walletLimitProof(contract), null);
  await assert.rejects(riskHarness({ noLimit: true }).api.projectCheck(contract), /数量上限/);
  for (const limitValue of [0, 10001]) assert.equal(await riskHarness({ limitValue }).api.walletLimitProof(contract), null);
  const failed = riskHarness({ rpc(method, params) { if (method === 'eth_call' && params[0].data === walletLimitSelector) throw new Error('mock limit RPC unavailable'); } });
  await assert.rejects(failed.api.walletLimitProof(contract), /unavailable/);
});

test('NFT acquisition rejects per-transaction limits and unknown or excessive USD costs before media access', async () => {
  let mediaReads = 0;
  const nftMediaCheck = async () => { mediaReads++; return { verified: true }; };
  const txLimited = riskHarness({ nft: true, limitKind: 'transaction', nftMediaCheck });
  assert.equal((await txLimited.api.contractInfo(contract)).nft, true);
  assert.equal(await txLimited.api.walletLimitProof(contract, { nft: true }), null);
  await assert.rejects(txLimited.api.projectCheck(contract, { paymentUsd: 5 }), /每钱包/);
  for (const paymentUsd of [null, 0, NaN, Infinity, 10.000001]) await assert.rejects(riskHarness({ nft: true, nftMediaCheck }).api.projectCheck(contract, { paymentUsd }), /10 USD|成本/);
  assert.equal(mediaReads, 0);
  const valid = riskHarness({ nft: true, nftMediaCheck });
  await valid.api.projectCheck(contract, { paymentUsd: 10, quantity: 10 });
  assert.equal(mediaReads, 1);
  await assert.rejects(valid.api.projectCheck(contract, { paymentUsd: 10, quantity: 11 }), /数量|上限/);
  assert.equal(mediaReads, 1, 'quantity failure must stop before another external metadata read');
});

test('NFT media checks fail closed and are performed again for a later acquisition', async () => {
  const missing = riskHarness({ nft: true });
  await assert.rejects(missing.api.projectCheck(contract, { paymentUsd: 1 }), /图片检查/);
  let reads = 0;
  const dynamic = riskHarness({ nft: true, nftMediaCheck: async () => { if (++reads !== 1) throw new Error('mock metadata changed to unsafe media'); return { verified: true }; } });
  await dynamic.api.projectCheck(contract, { paymentUsd: 1 });
  await assert.rejects(dynamic.api.projectCheck(contract, { paymentUsd: 1 }), /metadata changed/);
  assert.equal(reads, 2, 'a positive metadata result cannot permanently allow future minting');
  const unavailable = riskHarness({ nft: true, nftMediaCheck: async () => { throw new Error('mock image read timeout'); } });
  await assert.rejects(unavailable.api.projectCheck(contract, { paymentUsd: 1 }), /timeout/);
});


test('paid mint cost is reconstructed from explicit USDT and a valid cached BNB rate, never a made-up rate', () => {
  const native = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
  const bnb = { owner: wallet.addr, contractAddress: native, change: '-10000000000000000' };
  const dollar = { owner: wallet.addr, contractAddress: usdt, change: '-7000000000000000000' };
  const sim = { balanceChanges: [bnb, dollar] };
  const known = deriveMintCost(sim, wallet.addr, { costUsd: 0, bnbUsd: 600, usdt });
  assert.equal(known.cost, 13); assert.equal(known.costUnknown, false);
  assert.equal(known.paidBnbWei, '10000000000000000'); assert.equal(known.paidUsdtWei, '7000000000000000000');
  for (const bnbUsd of [undefined, 0, NaN, Infinity]) {
    const unknown = deriveMintCost(sim, wallet.addr, { costUsd: 0, bnbUsd, usdt });
    assert.equal(unknown.costUnknown, true, 'BNB with no verified exchange rate cannot be declared free');
    assert.notEqual(unknown.costSource, 'free');
  }
  const usdtOnly = deriveMintCost({ balanceChanges: [dollar] }, wallet.addr, { costUsd: 0, bnbUsd: 0, usdt });
  assert.equal(usdtOnly.cost, 7); assert.equal(usdtOnly.costUnknown, false);
});

test('cost attribution excludes another wallet and does not round a real paid acquisition down to free', () => {
  const native = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
  const other = { owner: '0x4444444444444444444444444444444444444444', contractAddress: native, change: '-1000000000000000000' };
  const free = deriveMintCost({ balanceChanges: [other] }, wallet.addr, { costUsd: 0, bnbUsd: 600, usdt });
  assert.equal(free.costUnknown, false); assert.equal(free.cost, 0);
  const tiny = deriveMintCost({ balanceChanges: [{ owner: wallet.addr, contractAddress: native, change: '-1' }] }, wallet.addr, { costUsd: 0, bnbUsd: 600, usdt });
  assert.ok(tiny.cost > 0); assert.equal(tiny.costUnknown, false);
});
