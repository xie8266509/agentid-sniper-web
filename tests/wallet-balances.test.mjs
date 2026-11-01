import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWalletBalanceReader, BALANCE_ASSETS } from '../lib/wallet-balances.mjs';

const A = '0x' + 'a'.repeat(40), B = '0x' + 'b'.repeat(40);
const wallet = { id: 'wallet-a', address: A }, other = { id: 'wallet-b', address: B };
const abi = amount => '0x' + BigInt(amount).toString(16).padStart(64, '0');
const qty = amount => '0x' + BigInt(amount).toString(16);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('public BSC summary uses exact BNB and official USDT reads without floating-point rounding', async () => {
  const calls = [], amount = 123456789012345678901234567890n;
  const reader = createWalletBalanceReader({ now: () => 123, rpc: async (method, params) => { calls.push({ method, params }); return method === 'eth_chainId' ? '0x38' : method === 'eth_getBalance' ? qty(amount) : abi(1n); } });
  const value = await reader.read({ ...wallet, address: A.toUpperCase().replace('0X', '0x') });
  assert.equal(value.walletId, wallet.id); assert.equal(value.walletAddress, A); assert.equal(value.chainId, 56); assert.equal(value.source, 'rpc');
  assert.equal(value.status, 'ready'); assert.equal(value.stale, false); assert.equal(value.updatedAt, 123);
  assert.deepEqual(value.assets.map(row => row.balance), ['123456789012.34567890123456789', '0.000000000000000001']);
  assert.deepEqual(value.assets.map(row => row.address), BALANCE_ASSETS.map(row => row.address));
  assert.deepEqual(calls, [{ method: 'eth_chainId', params: [] }, { method: 'eth_getBalance', params: [A, 'latest'] }, { method: 'eth_call', params: [{ to: BALANCE_ASSETS[1].address, data: '0x70a08231' + A.slice(2).padStart(64, '0') }, 'latest'] }]);
});

test('missing, draft, malformed and zero addresses are unbound and never query RPC', async () => {
  const reader = createWalletBalanceReader({ rpc: () => { assert.fail('unbound wallet must not query'); } });
  for (const entry of [{ id: 'empty', address: '' }, { ...wallet, draft: true }, { ...wallet, address: 'invalid' }, { ...wallet, address: '0x' + '0'.repeat(40) }]) {
    const value = await reader.read(entry);
    assert.equal(value.status, 'unbound'); assert.equal(value.updatedAt, null); assert.equal(value.stale, false);
    assert.deepEqual(value.assets.map(row => row.balance), [null, null]);
  }
});

test('genuine zero remains zero while invalid native quantities are unknown', async () => {
  const zeros = createWalletBalanceReader({ rpc: async method => method === 'eth_chainId' ? '0x38' : method === 'eth_getBalance' ? '0x0' : abi(0) });
  assert.deepEqual((await zeros.read(wallet)).assets.map(row => row.balance), ['0', '0']);
  for (const invalid of [null, undefined, '', '0x', '0x00', '0x01', '0x-1', '0xgg', 0, '0x' + '1'.repeat(65)]) {
    const reader = createWalletBalanceReader({ rpc: async method => method === 'eth_chainId' ? '0x38' : method === 'eth_getBalance' ? invalid : abi(0) });
    const value = await reader.read(wallet);
    assert.equal(value.status, 'partial'); assert.equal(value.assets[0].balance, null, String(invalid)); assert.ok(value.assets[0].error); assert.equal(value.assets[1].balance, '0');
  }
});

test('USDT requires exactly one ABI uint256 word and cannot erase a valid native balance', async () => {
  for (const invalid of [null, undefined, '0x', '0x0', '0x' + '0'.repeat(62), abi(0) + '00', '0x' + 'z'.repeat(64)]) {
    const reader = createWalletBalanceReader({ rpc: async method => method === 'eth_chainId' ? '0x38' : method === 'eth_getBalance' ? '0x1' : invalid });
    const value = await reader.read(wallet);
    assert.equal(value.status, 'partial'); assert.equal(value.assets[0].balance, '0.000000000000000001'); assert.equal(value.assets[1].balance, null); assert.ok(value.assets[1].error);
  }
});

test('wrong or invalid BSC chain proof stops before balance reads and returns unknown, sanitized errors', async () => {
  for (const chain of ['0x1', '0x038', null, '', 56]) {
    const calls = [], reader = createWalletBalanceReader({ rpc: async method => { calls.push(method); return chain; } });
    const value = await reader.read(wallet);
    assert.equal(value.status, 'error'); assert.equal(value.updatedAt, null); assert.deepEqual(value.assets.map(row => row.balance), [null, null]); assert.deepEqual(calls, ['eth_chainId']);
  }
  const reader = createWalletBalanceReader({ rpc: async () => { throw new Error('https://secret-rpc.local?token=PRIVATE'); } });
  assert.equal(JSON.stringify(await reader.read(wallet)).includes('PRIVATE'), false);
});

test('one synchronously failing asset does not suppress the other asset or another wallet', async () => {
  const reader = createWalletBalanceReader({ rpc: (method, params) => {
    if (method === 'eth_chainId') return '0x38';
    if (method === 'eth_getBalance') { if (params[0] === A) throw new Error('private RPC content'); return '0x2'; }
    return abi(3);
  } });
  const [first, second] = await Promise.all([reader.read(wallet), reader.read(other)]);
  assert.equal(first.status, 'partial'); assert.deepEqual(first.assets.map(row => row.balance), [null, '0.000000000000000003']);
  assert.equal(second.status, 'ready'); assert.equal(second.assets[0].balance, '0.000000000000000002');
  assert.equal(JSON.stringify(first).includes('private RPC content'), false);
});

test('cache expires after 30 seconds, explicit refresh bypasses it and returned objects are isolated', async () => {
  let clock = 0, reads = 0;
  const reader = createWalletBalanceReader({ now: () => clock, rpc: async method => { reads++; return method === 'eth_chainId' ? '0x38' : method === 'eth_getBalance' ? '0x1' : abi(2); } });
  const first = await reader.read(wallet); first.assets[0].balance = '999';
  clock = 29999; assert.equal((await reader.read(wallet)).assets[0].balance, '0.000000000000000001'); assert.equal(reads, 3);
  clock = 30000; await reader.read(wallet); assert.equal(reads, 6);
  await reader.read(wallet, { force: true }); assert.equal(reads, 9);
});

test('refresh failures preserve only this address previous successful values with an explicit stale marker', async () => {
  let clock = 100, failure = false;
  const reader = createWalletBalanceReader({ now: () => clock, rpc: async method => { if (failure && method !== 'eth_chainId') throw new Error('private'); return method === 'eth_chainId' ? '0x38' : method === 'eth_getBalance' ? qty(10n ** 18n) : abi(2n * 10n ** 18n); } });
  await reader.read(wallet); clock = 200; failure = true;
  const value = await reader.read(wallet, { force: true });
  assert.equal(value.status, 'error'); assert.equal(value.stale, true); assert.equal(value.updatedAt, 100); assert.deepEqual(value.assets.map(row => row.balance), ['1', '2']); assert.ok(value.assets.every(row => row.error));
  const different = await reader.read({ ...wallet, address: B });
  assert.deepEqual(different.assets.map(row => row.balance), [null, null]); assert.equal(different.stale, false); assert.equal(different.updatedAt, null);
});

test('wallet identity and address both participate in cache and singleflight keys', async () => {
  const counts = new Map(), reader = createWalletBalanceReader({ rpc: async (method, params) => { const address = method === 'eth_getBalance' ? params[0] : ''; if (address) counts.set(address, (counts.get(address) || 0) + 1); return method === 'eth_chainId' ? '0x38' : method === 'eth_getBalance' ? '0x0' : abi(0); } });
  await reader.read(wallet); await reader.read({ ...wallet, address: B }); await reader.read({ ...wallet, id: 'another-id' });
  assert.equal(counts.get(A), 2); assert.equal(counts.get(B), 1);
});

test('concurrent manual refreshes share a flight and total queued identities are bounded', async () => {
  const gate = deferred(), started = deferred(); let calls = 0;
  const reader = createWalletBalanceReader({ maxConcurrent: 1, maxPending: 2, rpc: async method => { calls++; if (method === 'eth_chainId') { started.resolve(); await gate.promise; return '0x38'; } return method === 'eth_getBalance' ? '0x0' : abi(0); } });
  const first = reader.read(wallet, { force: true }); await started.promise;
  const shared = reader.read(wallet, { force: true }), second = reader.read(other);
  const rejected = await reader.read({ id: 'third', address: '0x' + 'c'.repeat(40) });
  assert.equal(rejected.status, 'error'); assert.deepEqual(rejected.assets.map(row => row.balance), [null, null]); assert.equal(calls, 1);
  gate.resolve(); assert.deepEqual(await shared, await first); assert.equal((await second).status, 'ready'); assert.equal(calls, 6);
});

test('an in-flight response is discarded when a wallet is deleted or rebound and cannot seed its cache', async () => {
  const gate = deferred(), started = deferred(); let current = wallet, reads = 0;
  const reader = createWalletBalanceReader({ isCurrent: identity => current?.id === identity.id && current?.address === identity.address, rpc: async method => { reads++; if (method === 'eth_chainId') { started.resolve(); await gate.promise; return '0x38'; } return method === 'eth_getBalance' ? '0x0' : abi(0); } });
  const pending = reader.read(wallet); await started.promise; current = { ...wallet, address: B }; gate.resolve();
  await assert.rejects(pending, error => error.status === 409);
  current = null; await assert.rejects(reader.read(wallet), error => error.status === 409);
  current = wallet; assert.equal((await reader.read(wallet)).status, 'ready'); assert.equal(reads, 6, 'discarded response was not cached');
});
