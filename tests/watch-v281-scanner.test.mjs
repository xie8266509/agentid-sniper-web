import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { decodeAbiUint } from '../lib/nft-codec.mjs';

const source = readFileSync(new URL('../watch.mjs', import.meta.url), 'utf8');
const section = (start, end) => { const a = source.indexOf(start), b = source.indexOf(end, a); assert.ok(a >= 0 && b > a); return source.slice(a, b); };
const A = '0x1111111111111111111111111111111111111111', C = '0x2222222222222222222222222222222222222222';

test('batch evidence rejects duplicate, nonnumeric, and out-of-slice response IDs before returning any proof', async () => {
  for (const bad of [[{ id: 0, result: '0x8' }, { id: 0, result: '0x9' }], [{ id: '0', result: '0x8' }], [{ id: 2, result: '0x8' }], [{ id: -1, result: '0x8' }], [{ id: '__proto__', result: '0x8' }]]) {
    let attempts = 0;
    const sandbox = { AbortSignal: { timeout: () => ({}) }, fetch: async () => { attempts++; return { json: async () => bad }; } };
    vm.runInNewContext(section('async function rpcBatch(', 'async function heatOf(') + '\nglobalThis.run = rpcBatch;', sandbox);
    const result = await sandbox.run([{ method: 'eth_getTransactionCount', params: [A, 'latest'] }]);
    assert.deepEqual(Array.from(result), []); assert.equal(attempts, 3);
  }
});

test('an invalid batch may fall back to a clean endpoint, but missing results remain absent rather than fabricated', async () => {
  let attempts = 0;
  const sandbox = { AbortSignal: { timeout: () => ({}) }, fetch: async (_url, options) => {
    attempts++; const requests = JSON.parse(options.body);
    assert.deepEqual(requests.map(item => item.id), [0, 1]);
    return { json: async () => attempts === 1 ? [{ id: 0, result: '0x8' }, { id: 0, result: '0x9' }] : [{ id: 1, result: '0x8' }] };
  } };
  vm.runInNewContext(section('async function rpcBatch(', 'async function heatOf(') + '\nglobalThis.run = rpcBatch;', sandbox);
  const result = await sandbox.run([{ method: 'eth_getTransactionCount', params: [A, 'latest'] }, { method: 'eth_getTransactionCount', params: [C, 'latest'] }]);
  assert.equal(result[0], undefined); assert.equal(result[1], '0x8'); assert.equal(attempts, 2);
});

test('a verified zero balance cools for thirty minutes while failed reads never renew the cooldown', async () => {
  let clock = 1800000000000, result = '0x' + '0'.repeat(64), reads = 0, recoveries = 0;
  class Clock extends Date { static now() { return clock; } }
  const st = { lastBal: '2', hist: [], done2: [], notified: [] };
  const sandbox = { Date: Clock, S: { tokens: {}, dyn: [{ addr: C, sym: 'TEST', cost: 1, only: A }] }, TOKENS: [], MONITOR_ONLY: true, structuredClone,
    positionStateKey: (wallet, token) => wallet + ':' + token, positionFor: () => st, recoverScannerWallet: async () => { recoveries++; }, rulesFor: () => ({}), canWallet: () => false, tokenCostFor: () => 1,
    decodeAbiUint, call: async () => { reads++; return result; }, wa: value => value.slice(2).padStart(64, '0'), ts: () => String(clock), save() {},
  };
  vm.runInNewContext(section('async function holdW(', '// ---------- 新的 Agent ID') + '\nglobalThis.run = holdW;', sandbox);
  const run = () => sandbox.run({ id: 'wallet-a', addr: A }, 1000, false);
  await run(); assert.equal(st.doneAt, clock); assert.equal(st.lastBal, '0'); assert.equal(reads, 1);
  clock += 30 * 60000 - 1; await run(); assert.equal(reads, 1); assert.equal(recoveries, 2);
  clock++; result = '0x'; await run(); assert.equal(reads, 2); assert.equal(st.doneAt, clock - 30 * 60000); assert.equal(st.eligibility, 'read-error');
  clock++; await run(); assert.equal(reads, 3, 'an unknown balance cannot delay the next attempt for another thirty minutes');
});
