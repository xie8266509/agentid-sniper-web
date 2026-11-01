import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import { decodeAbiUint } from '../lib/nft-codec.mjs';

const source = readFileSync(new URL('../watch.mjs', import.meta.url), 'utf8');
const section = (from, to) => { const start = source.indexOf(from), end = source.indexOf(to, start); assert.ok(start >= 0 && end > start); return source.slice(start, end); };
function mintFixture(rpc) {
  const sandbox = { rpc, S: { mintBlock: 100, seenMints: {} }, MINTS: new Map(), mintChecked: new Map(), T_TRANSFER: 'transfer', ZERO32: 'zero', log() {} };
  vm.runInNewContext(section('async function mintLogs(', 'async function fullCode(') + section('async function mintScan(', 'const CLAIM =') + '\nglobalThis.api = { mintLogs, mintScan };', sandbox);
  return sandbox;
}

test('small block batches keep response positions and stop at the first missing block', async () => {
  const calls = [], sandbox = { S: { lastBlock: 100 }, countHot() {}, DEPLOYERS: [], REGISTRY: '', log() {}, _hsBusy: true, _msBusy: true, _proxyPause: Infinity,
    RPC_CLIENT: { async batch(requests) {
      calls.push(requests);
      return requests.map((_request, index) => calls.length === 1 && index === 1 ? undefined : { transactions: [] });
    } },
  };
  vm.runInNewContext(section('async function scanNew(', '// ---------- 工厂合约') + '\nglobalThis.run = scanNew;', sandbox);
  await sandbox.run(116);
  assert.equal(sandbox.S.lastBlock, 101); assert.equal(calls.length, 2);
  assert.ok(calls.every(requests => requests.length === 4 && requests.every(request => request.method === 'eth_getBlockByNumber')));
});

test('a healthy scanner follows sixteen empty blocks with four bounded HTTP batches', async () => {
  let calls = 0;
  const sandbox = { S: { lastBlock: 100 }, countHot() {}, DEPLOYERS: [], REGISTRY: '', log() {}, _hsBusy: true, _msBusy: true, _proxyPause: Infinity,
    RPC_CLIENT: { async batch(requests) { calls++; assert.ok(requests.length <= 4); return requests.map(() => ({ transactions: [] })); } },
  };
  vm.runInNewContext(section('async function scanNew(', '// ---------- 工厂合约') + '\nglobalThis.run = scanNew;', sandbox);
  await sandbox.run(116); assert.equal(sandbox.S.lastBlock, 116); assert.equal(calls, 4);
});

test('a deployment receipt or code failure preserves the block for a later classification retry', async () => {
  for (const failure of ['missing-receipt', 'receipt-rate-limit', 'code-rate-limit']) {
    const sandbox = { S: { lastBlock: 100, seenMints: {} }, countHot() {}, DEPLOYERS: [], REGISTRY: '', log() {}, _hsBusy: true, _msBusy: true, _proxyPause: Infinity,
      RPC_CLIENT: { async batch() { return [{ transactions: [{ to: null, hash: 'creation' }] }]; } },
      async rpc(method) {
        if (failure === 'missing-receipt') return null;
        if (failure === 'receipt-rate-limit' || method === 'eth_getCode') throw Object.assign(new Error('cooldown'), { retryAfterMs: 30000 });
        return { contractAddress: '0x' + '11'.repeat(20) };
      },
    };
    vm.runInNewContext(section('async function scanNew(', '// ---------- 工厂合约') + '\nglobalThis.run = scanNew;', sandbox);
    await sandbox.run(101); assert.equal(sandbox.S.lastBlock, 100, failure); assert.equal(Object.keys(sandbox.S.seenMints).length, 0);
  }
});

test('rate limited mint event reads do not fan out into block receipts or advance the cursor', async () => {
  const calls = [], h = mintFixture(async method => { calls.push(method); throw Object.assign(new Error('cooldown'), { retryAfterMs: 30000 }); });
  await assert.rejects(h.api.mintScan(102), /cooldown/);
  assert.equal(h.S.mintBlock, 100); assert.deepEqual(calls, ['eth_getLogs']);
});

test('a long provider outage resumes the failed range instead of skipping to the latest blocks', async () => {
  const ranges = [];
  const h = mintFixture(async (_method, params) => { ranges.push([params[0].fromBlock, params[0].toBlock]); return []; });
  await h.api.mintScan(500);
  assert.deepEqual(ranges, [['0x65', '0xa0']]); assert.equal(h.S.mintBlock, 160);
});

test('a failed block receipt leaves the complete mint range uncommitted', async () => {
  const h = mintFixture(async (method, params) => {
    if (method === 'eth_getLogs') throw new Error('address filter required');
    if (params[0] === '0x66') throw new Error('unavailable receipt');
    return [{ logs: [] }];
  });
  await assert.rejects(h.api.mintScan(102), /unavailable receipt/);
  assert.equal(h.S.mintBlock, 100); assert.equal(h.MINTS.size, 0);
});

test('malformed receipts are unknown; only a fully verified empty range advances the mint cursor', async () => {
  for (const invalid of [null, {}, [{ status: '0x1' }]]) {
    const h = mintFixture(async method => { if (method === 'eth_getLogs') throw new Error('address required'); return invalid; });
    await assert.rejects(h.api.mintScan(102), /不完整/); assert.equal(h.S.mintBlock, 100);
  }
  const h = mintFixture(async method => { if (method === 'eth_getLogs') throw new Error('address required'); return [{ logs: [] }]; });
  await h.api.mintScan(102); assert.equal(h.S.mintBlock, 102);
});

test('a failed receipt drains active workers before rejecting and never allocates later blocks', async () => {
  let release, settled = false;
  const gate = new Promise(resolve => { release = resolve; }), calls = [];
  const h = mintFixture(async (method, params) => {
    if (method === 'eth_getLogs') throw new Error('address required');
    calls.push(params[0]);
    if (params[0] === '0x65') throw new Error('rate limited');
    await gate; return [{ logs: [] }];
  });
  const result = h.api.mintScan(105).finally(() => { settled = true; });
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(settled, false); assert.deepEqual(calls, ['0x65', '0x66', '0x67']);
  release(); await assert.rejects(result, /rate limited/);
  assert.deepEqual(calls, ['0x65', '0x66', '0x67']); assert.equal(h.S.mintBlock, 100);
});

test('NFT activity preserves previous statistics when provider reads fail', async () => {
  const col = '0x' + '11'.repeat(20);
  for (const failed of ['logs', 'balance']) {
    const previous = { f: 5, t: 10, held: 3, at: 'earlier' };
    const sandbox = { S: { nftCols: { [col]: 1 }, nftVol: { [col]: previous }, nftColsBackfilled: true },
      rpc: async method => { if (method !== 'eth_blockNumber') throw Object.assign(new Error('rate limited'), { retryAfterMs: 30000 }); return '0x20000'; }, logsRpc: async () => { if (failed === 'logs') throw Object.assign(new Error('rate limited'), { retryAfterMs: 30000 }); return []; },
      decodeAbiUint, WALLETS: [{ addr: col }], wa: () => '', ELEMENT_EX: col, T_721_FILLED: 'filled', T_TRANSFER: 'transfer', sleep: async () => {}, log() {},
    };
    vm.runInNewContext(section('async function nftVolWatch(', 'function validateFileJob(') + '\nglobalThis.run = nftVolWatch;', sandbox);
    await assert.rejects(sandbox.run()); assert.deepEqual(sandbox.S.nftVol[col], previous);
  }
});

test('an incompatible NFT collection keeps its old count without starving subsequent collections', async () => {
  const a = '0x' + '11'.repeat(20), b = '0x' + '22'.repeat(20), previous = { f: 1, t: 2, held: 3 }, logs = [];
  const sandbox = { S: { nftCols: { [a]: 1, [b]: 1 }, nftVol: { [a]: previous }, nftColsBackfilled: true },
    rpc: async (method, params) => method === 'eth_blockNumber' ? '0x20000' : params[0].to === a ? '0x' : '0x' + '0'.repeat(64),
    logsRpc: async () => [], decodeAbiUint, WALLETS: [{ addr: a }], wa: () => '', ELEMENT_EX: a, T_721_FILLED: 'filled', T_TRANSFER: 'transfer', sleep: async () => {}, log: message => logs.push(message), ts: () => 'now',
  };
  vm.runInNewContext(section('async function nftVolWatch(', 'function validateFileJob(') + '\nglobalThis.run = nftVolWatch;', sandbox);
  await sandbox.run(); assert.deepEqual(sandbox.S.nftVol[a], previous); assert.equal(sandbox.S.nftVol[b].held, 0); assert.ok(logs.some(message => message.includes('暂不可用')));
});
