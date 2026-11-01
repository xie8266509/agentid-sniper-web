// Evaluate scanner functions against explicit RPC doubles. No wallet, external
// metadata fetch, local session, or network side effect is available here.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { isolatedWatch } from './watch-scanner-fixture.mjs';
import { decodeAbiUint } from '../lib/nft-codec.mjs';

const source = readFileSync(new URL('../watch.mjs', import.meta.url), 'utf8');
function extract(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a, `scanner markers must exist: ${start} → ${end}`);
  return source.slice(a, b);
}
const target = '0x2222222222222222222222222222222222222222';
const senderA = '0x3333333333333333333333333333333333333333';
const senderB = '0x4444444444444444444444444444444444444444';
const recipient = '0x5555555555555555555555555555555555555555';
const registry = '60b9262456de011f7d15a54cdd8c48baaa8b022f';
const word = value => BigInt(value).toString(16).padStart(64, '0');
const topicAddress = address => '0x' + address.slice(2).padStart(64, '0');

function heatHarness({ logs, transactions, registered = [], unavailable = false }) {
  const batches = [], head = 65536;
  const sandbox = {
    Date, REGISTRY: registry,
    validMintAddress: value => /^0x[0-9a-f]{40}$/i.test(value),
    agentCache: new Map(),
    wa: address => address.slice(2).padStart(64, '0'),
    async call() { return '0x'; },
    async rpc(method) {
      if (method === 'eth_blockNumber') return '0x' + head.toString(16);
      if (method === 'eth_getLogs') return logs;
      throw new Error('Unexpected RPC ' + method);
    },
    async logsRpc() { return logs; },
    async rpcBatch(requests) {
      batches.push(requests);
      return requests.map(request => {
        if (request.method === 'eth_getTransactionByHash') return unavailable ? undefined : transactions[request.params[0]];
        assert.equal(request.method, 'eth_call');
        const address = '0x' + request.params[0].data.slice(-40);
        return '0x' + word(registered.includes(address) ? 1 : 0);
      });
    },
  };
  vm.runInNewContext(extract('async function heatOf(', 'const hk =') + '\nglobalThis.run = heatOf;', sandbox);
  return { run: sandbox.run, batches };
}

test('airdrop recipients cannot inflate Agent ID participation unless they sent a transaction', async () => {
  const h = heatHarness({
    logs: [{ transactionHash: 'airdrop', blockNumber: '0x10000', topics: ['transfer', topicAddress(target), topicAddress(recipient)] }],
    transactions: { airdrop: { from: senderA } }, registered: [recipient],
  });
  const project = {};
  await h.run(target, project);
  assert.equal(project.agents, 0);
  assert.equal(project.burst, 0);
  assert.ok(h.batches.some(batch => batch.some(request => request.method === 'eth_getTransactionByHash')));
});

test('verified transaction senders are deduplicated while recent burst excludes old sends', async () => {
  const h = heatHarness({
    logs: [
      { transactionHash: 'old', blockNumber: '0xfc00', topics: ['transfer', topicAddress(recipient)] },
      { transactionHash: 'new-a', blockNumber: '0x10000', topics: ['transfer', topicAddress(recipient)] },
      { transactionHash: 'new-a', blockNumber: '0x10000', topics: ['other', topicAddress(recipient)] },
      { transactionHash: 'new-b', blockNumber: '0x10000', topics: ['transfer', topicAddress(target)] },
    ],
    transactions: { old: { from: senderB }, 'new-a': { from: senderA }, 'new-b': { from: senderA } },
    registered: [senderA, senderB, recipient],
  });
  const project = {};
  await h.run(target, project);
  assert.equal(project.agents, 2);
  assert.equal(project.burst, 1);
  const transactions = h.batches.flat().filter(request => request.method === 'eth_getTransactionByHash');
  assert.equal(transactions.length, 3, 'repeated events from one transaction must not cause repeated sender queries');
});

test('missing transaction data cannot fall back to counting registered event recipients', async () => {
  const h = heatHarness({
    logs: [{ transactionHash: 'missing', blockNumber: '0x10000', topics: ['transfer', topicAddress(recipient)] }],
    transactions: {}, registered: [recipient], unavailable: true,
  });
  const project = {};
  await h.run(target, project);
  assert.equal(project.agents, 0);
  assert.equal(project.burst, 0);
});

test('old recipient-based participation caches clear once without changing completed or unknown mint records', () => {
  const state = {
    entryPolicy: { goPct: 0.85, minAgents: 175 },
    paid: { [target]: { agents: 999, burst: 200, heatAt: Date.now(), done: { 'wallet-a': 'minted', 'wallet-b': 'unknown' } } },
    walletPending: { 'wallet-b': { version: 1, txHash: '0x' + 'ab'.repeat(32), expected: { to: target } } },
  };
  const first = isolatedWatch({ state });
  const migrated = first.api.getState();
  assert.equal(migrated.agentsV, 2);
  assert.equal(migrated.paid[target].agents, undefined);
  assert.equal(migrated.paid[target].burst, undefined);
  assert.equal(migrated.paid[target].heatAt, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(migrated.paid[target].done)), state.paid[target].done);
  assert.deepEqual(JSON.parse(JSON.stringify(migrated.walletPending)), state.walletPending);
  migrated.paid[target].agents = 175;
  const restarted = isolatedWatch({ state: JSON.parse(JSON.stringify(migrated)) });
  assert.equal(restarted.api.getState().paid[target].agents, 175, 'the new sender-derived count must survive later startups');
  assert.equal(first.seen.cliCalls.length, 0);
  assert.equal(first.seen.network.length, 0);
});

test('an unreadable mint-inventory balance cannot become a false 100% sold progress', async () => {
  for (const [balance, expected] of [[null, null], ['0x', null], ['malformed', null], ['0x' + word(1000), 0], ['0x' + word(0), 1]]) {
    const sandbox = {
      S: { prog: { [target]: { init: '1000', tok: target } } }, decodeAbiUint,
      wa: address => address.slice(2).padStart(64, '0'),
      async call(to, data) { assert.equal(to, target); assert.equal(data, '0x70a08231' + topicAddress(target).slice(2)); return balance; },
      async rpc() { throw new Error('pre-recorded mint inventory must not query deployment history'); },
    };
    vm.runInNewContext(extract('const SOLD_SELS =', '// ---------- 防「連續發盤釣魚」') + '\nglobalThis.run = progressOf;', sandbox);
    const result = await sandbox.run(target, '', '');
    assert.equal(result.progress, expected, String(balance));
  }
});
