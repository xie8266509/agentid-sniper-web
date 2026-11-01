import assert from 'node:assert/strict';
import { test } from 'node:test';
import { id } from 'ethers';
import { createMintRisk } from '../lib/mint-policy.mjs';

const C = '0x2222222222222222222222222222222222222222', T = '0x3333333333333333333333333333333333333333';
const U = '0x55d398326f99059ff775485246999027b3197955', W = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
const B = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', F = '0xca143ce32fe78f1f7019d7d551a6402fc5350c73';
const limit = id('maxPerWallet()').slice(0, 10), uint = n => '0x' + BigInt(n).toString(16).padStart(64, '0');
function fixture({ token = T, native = {}, wrapped = {}, usdt = {}, price = 600, bad = null } = {}) {
  const reads = []; let prices = 0;
  const rpc = async (method, args) => {
    reads.push({ method, args });
    if (method === 'eth_getCode') return '0x63' + limit.slice(2);
    if (method === 'eth_getStorageAt') return uint(0);
    if (method === 'eth_getBalance') { if (bad === 'native') return null; return uint(native[args[0].toLowerCase()] || 0); }
    if (method === 'eth_call') {
      const { to, data } = args[0], at = to.toLowerCase();
      if (at === C && data === limit) return uint(10);
      if (at === C && data === '0xfc0c546a') return uint(BigInt(token));
      if (data.startsWith('0x70a08231')) {
        const owner = '0x' + data.slice(-40).toLowerCase();
        if (at === W) return bad === 'wrapped' ? '0x' : uint(wrapped[owner] || 0);
        if (at === U) return bad === 'usdt' ? '0x' : uint(usdt[owner] || 0);
      }
      if (at === F && data.startsWith('0xe6a43905')) return uint(0);
    }
    throw Error('Unexpected mock read: ' + method);
  };
  const api = createMintRisk({ state: {}, rpc, bnbUsd: async () => { prices++; return price; } });
  return { api, reads, prices: () => prices, check: options => api.projectCheck(C, { paying: true, paymentToken: B, paymentWei: 1n, quantity: 1, ...options }) };
}

test('retained BNB and official WBNB count once per contract even when token getter returns itself', async () => {
  const h = fixture({ token: C, wrapped: { [C]: 5n * 10n ** 15n } });
  await assert.rejects(h.check(), /资金留存|流动性不足/);
  assert.equal(h.reads.filter(x => x.method === 'eth_getBalance' && x.args[0] === C).length, 1);
  assert.equal(h.reads.filter(x => x.method === 'eth_call' && x.args[0].to.toLowerCase() === W).length, 1);
  const enough = fixture({ native: { [C]: 4n * 10n ** 15n }, wrapped: { [T]: 6n * 10n ** 15n } });
  await enough.check(); assert.equal(enough.prices(), 0, 'BNB plus WBNB needs no guessed USD price');
});

test('official USDT may prove native-equivalent retention only at a verified conservative quote', async () => {
  await fixture({ usdt: { [C]: 6n * 10n ** 18n }, price: 600 }).check();
  await assert.rejects(fixture({ usdt: { [C]: 6n * 10n ** 18n }, price: 600.0000001 }).check(), /资金留存|流动性不足/);
  for (const price of [0, -1, NaN, Infinity, Number.MAX_VALUE]) {
    await assert.rejects(fixture({ usdt: { [C]: 6n * 10n ** 18n }, price }).check(), /价格|报价|资金|无法核验/);
  }
});

test('USDT-funded mint keeps its original payment-sized threshold when counting BNB and WBNB', async () => {
  const paymentWei = 6n * 10n ** 18n + 10000000000n;
  const h = fixture({ wrapped: { [C]: 10n ** 16n }, price: 600.0000009 });
  await assert.rejects(h.check({ paymentToken: U, paymentWei }), /资金留存|流动性不足/);
  const enough = fixture({ wrapped: { [C]: 10n ** 16n }, usdt: { [T]: 10n ** 18n }, price: 600 });
  await enough.check({ paymentToken: U, paymentWei });
});

test('a missing native or known-token balance is not interpreted as an empty but safe treasury', async () => {
  for (const bad of ['native', 'wrapped', 'usdt']) {
    const h = fixture({ bad, usdt: { [T]: 10n ** 18n } });
    await assert.rejects(h.check(), /无法核验|结果|留存/);
  }
});

// Discovery uses in-memory HTTP/chain doubles and cannot access private groups.
test('a format-valid unrelated address cannot hide a real project in bounded deployment metadata', async () => {
  const { processSocialCandidates } = await import('../lib/social-candidates.mjs');
  const when = Date.parse('2026-11-01T13:00:00Z'), fake = '0x1234567890123456789012345678901234567890', real = '0x9012345678901234567890123456789012345678';
  const reads = [], checks = [];
  const result = await processSocialCandidates({ now: () => when, discoveryState: {}, snapshot: { version: 1, updatedAt: when, candidates: [{ kind: 'url', value: 'https://mock-project.test/', groupCount: 3, senderCount: 3, observedAt: when }] },
    fetchBytes: async url => { reads.push(url); return { body: Buffer.from(url.endsWith('/deployment.json') ? JSON.stringify({ contract: real }) : `<html><p>Unrelated address ${fake}</p></html>`) }; },
    verifyContract: async address => { checks.push(address); return address === real; } });
  assert.ok(reads.some(url => url.endsWith('/deployment.json')), 'unverified page addresses must not suppress later bounded metadata sources');
  assert.deepEqual(result.map(item => item.address), [real]);
  assert.equal(checks.filter(address => address === fake).length, 1, 'rejected addresses are still deduplicated within the pass');
  assert.ok(reads.length <= 6); assert.ok(checks.length <= 24);
});

test('manual completion binds the wallet and does not call other unknown wallets successfully finished', async () => {
  const vm = await import('node:vm'), { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../watch.mjs', import.meta.url), 'utf8'), start = source.indexOf('function applyManualMintCompletion('), end = source.indexOf('async function previewExec(', start);
  assert.ok(start >= 0 && end > start);
  const owner = '0x1111111111111111111111111111111111111111', wallet = { id: 'fixture-a', addr: owner }, writes = [];
  const S = { paid: { [C]: { done: { 'fixture-b': 'unknown' } } } };
  const sandbox = { S, MINT_PARTICIPATION: { markUnknown() {} }, FORCE: new Set([C]), WALLETS: [wallet, { id: 'fixture-b' }], validMintAddress: address => /^0x[0-9a-f]{40}$/.test(address), validMintCalldata: data => /^0x(?:[0-9a-f]{2})*$/.test(data), badSel: () => false, save: strict => writes.push(strict) };
  vm.runInNewContext(source.slice(start, end) + '\nglobalThis.complete = applyManualMintCompletion;', sandbox);
  const pending = { kind: 'contract', walletId: wallet.id, walletAddress: owner, manualMintProject: C, expected: { to: C, inputData: '0x12345678' } }, tx = '0x' + 'a'.repeat(64);
  assert.throws(() => sandbox.complete(wallet, { ...pending, walletId: 'fixture-b' }, tx), /无法绑定/);
  assert.equal(S.paid[C].done[wallet.id], undefined);
  sandbox.complete(wallet, pending, tx); assert.equal(S.paid[C].done[wallet.id], 'minted'); assert.equal(S.forceDone?.[C], undefined, 'another unknown submission is not evidence of success');
  S.paid[C].done['fixture-b'] = 'minted'; sandbox.complete(wallet, pending, tx); assert.equal(S.forceDone[C], 1); assert.ok(writes.every(value => value === true));
});

test('legacy unverified URL cache is discarded and cannot permanently suppress metadata retry', async () => {
  const { createHash } = await import('node:crypto'), { processSocialCandidates } = await import('../lib/social-candidates.mjs');
  let clock = Date.parse('2026-11-01T13:00:00Z');
  const fake = '0x1234567890123456789012345678901234567890', real = '0x9012345678901234567890123456789012345678', url = 'https://mock-project.test/';
  const key = createHash('sha256').update('url:' + url).digest('hex');
  const discoveryState = { scope: 'undefined:', entries: { [key]: { firstAt: clock - 1000, lastAttemptAt: clock - 1000, touchedAt: clock - 1000, foundAddresses: [fake, '0x' + 'a'.repeat(64)] } } };
  const reads = [], checks = [];
  const options = () => ({ now: () => clock, discoveryState, snapshot: { version: 1, updatedAt: clock, candidates: [{ kind: 'url', value: url, groupCount: 3, senderCount: 3, observedAt: clock }] }, fetchBytes: async value => { reads.push(value); return { body: Buffer.from(value.endsWith('/deployment.json') ? real : `<p>${fake}</p>`) }; }, verifyContract: async value => { checks.push(value); return value === real; } });
  assert.deepEqual(await processSocialCandidates(options()), []); assert.equal(reads.length, 0, 'recent retries keep the existing two-minute rate limit');
  assert.equal(discoveryState.entries[key].foundAddresses, undefined, 'legacy false success must be removed before the retry gate');
  clock += 120001;
  assert.deepEqual((await processSocialCandidates(options())).map(item => item.address), [real]);
  assert.deepEqual(discoveryState.entries[key].foundAddresses, [real]);
  assert.equal(checks.includes('0x' + 'a'.repeat(64)), false, 'legacy 64-digit values never reach contract verification');
  const before = reads.length; clock += 1000;
  assert.deepEqual((await processSocialCandidates(options())).map(item => item.address), [real]); assert.equal(reads.length, before, 'only the newly verified cache can skip HTTP reads');
});

test('the scanner price reader requires fresh complete official-pair evidence and never returns its saved price', async () => {
  const vm = await import('node:vm'), { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../watch.mjs', import.meta.url), 'utf8'), start = source.indexOf('async function bnbUsd('), end = source.indexOf('const tokStr =', start);
  assert.ok(start >= 0 && end > start);
  const word = value => uint(value).slice(2), reserves = '0x' + word(10n ** 18n) + word(600n * 10n ** 18n) + word(1), pair = '0x' + word(BigInt(C));
  const cases = [{ price: 600 }, { price: 600, reverse: true }, { token0: '0x' }, { token0: uint(BigInt(T)) }, { token0: uint(BigInt(W) + (1n << 160n)) }, { pair: '0x' }, { pair: uint(0) }, { pair: uint(BigInt(C) + (1n << 160n)) }, { reserves: null }, { reserves: uint(1) }, { reserves: '0x' + 'z'.repeat(192) }, { reserves: '0x' + word(0) + word(600n * 10n ** 18n) + word(1) }, { reserves: '0x' + word(1n << 112n) + word(600n * 10n ** 18n) + word(1) }, { reserves: '0x' + word(10n ** 18n) + word(600n * 10n ** 18n) + word(1n << 32n) }, { rpcThrows: true }];
  for (const options of cases) {
    const previous = { lastBnbUsd: 987, lastBnbUsdAt: 123 }, S = { ...previous }, reads = [];
    const sandbox = { S, FACTORY: F, WBNB: W, USDT: U, wa: address => address.slice(2).padStart(64, '0'), call: async (to, data) => {
      reads.push({ to, data });
      if (options.rpcThrows) throw Error('mock unreadable RPC');
      if (to === F) return Object.hasOwn(options, 'pair') ? options.pair : pair;
      if (data === '0x0902f1ac') return Object.hasOwn(options, 'reserves') ? options.reserves : options.reverse ? '0x' + word(600n * 10n ** 18n) + word(10n ** 18n) + word(1) : reserves;
      if (data === '0x0dfe1681') return Object.hasOwn(options, 'token0') ? options.token0 : uint(BigInt(options.reverse ? U : W));
      throw Error('Unexpected price read');
    } };
    vm.runInNewContext(source.slice(start, end) + '\nglobalThis.price = bnbUsd;', sandbox);
    assert.equal(await sandbox.price(), options.price || 0, JSON.stringify(options));
    if (!options.price) assert.deepEqual(S, previous, 'failed fresh evidence cannot renew the saved price timestamp');
    else { assert.equal(S.lastBnbUsd, 600); assert.ok(S.lastBnbUsdAt > previous.lastBnbUsdAt); }
    assert.ok(reads.length <= 3);
  }
});

test('an expired legacy false-success URL cache gets one bounded discovery opportunity after migration', async () => {
  const { createHash } = await import('node:crypto'), { processSocialCandidates } = await import('../lib/social-candidates.mjs');
  const clock = Date.parse('2026-11-01T13:00:00Z'), url = 'https://mock-project.test/', fake = '0x1234567890123456789012345678901234567890', real = '0x9012345678901234567890123456789012345678';
  const key = createHash('sha256').update('url:' + url).digest('hex');
  const discoveryState = { scope: 'undefined:', entries: { [key]: { firstAt: clock - 10800000, lastAttemptAt: clock - 10800000, touchedAt: clock - 10800000, foundAddresses: [fake] } } }, reads = [];
  const result = await processSocialCandidates({ now: () => clock, discoveryState, snapshot: { version: 1, updatedAt: clock, candidates: [{ kind: 'url', value: url, groupCount: 3, senderCount: 3, observedAt: clock }] }, fetchBytes: async value => { reads.push(value); return { body: Buffer.from(value.endsWith('/deployment.json') ? real : fake) }; }, verifyContract: async value => value === real });
  assert.deepEqual(result.map(item => item.address), [real], 'the stale legacy false-success record must not suppress every future metadata read');
  assert.ok(reads.length > 0 && reads.length <= 6); assert.deepEqual(discoveryState.entries[key].foundAddresses, [real]);
});
