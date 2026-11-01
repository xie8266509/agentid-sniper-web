import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWebRpc } from '../lib/nft-holdings.mjs';
import { createRpcClient } from '../lib/rpc-client.mjs';

function fixture({ maxClients = 4 } = {}) {
  let config = {};
  const created = [], calls = [], fetchImpl = () => { throw Error('Unexpected network access'); };
  const request = createWebRpc({ readConfig: () => config, fetchImpl, maxClients, createClient: options => {
    const id = created.length + 1; created.push({ id, ...options });
    return { request: async (method, params) => { calls.push({ id, method, params }); return { clientId: id, call: calls.length }; }, getStatus: () => ({ clientId: id, cooling: true }) };
  } });
  return { request, created, calls, fetchImpl, config: value => { config = value; } };
}

test('Web defaults prefer BNB Chain and one PublicNode endpoint with bounded BSC-only reads', async () => {
  const f = fixture(); await f.request('eth_blockNumber', []);
  assert.deepEqual(f.created[0].urls, ['https://bsc-dataseed.bnbchain.org/', 'https://bsc-rpc.publicnode.com/']);
  assert.equal(f.created[0].maxConcurrent, 2); assert.equal(f.created[0].minIntervalMs, 500); assert.equal(f.created[0].expectedChainId, 56); assert.equal(f.created[0].fetchImpl, f.fetchImpl);
  await f.request('eth_getBalance', ['0x' + '1'.repeat(40), 'latest']); assert.equal(f.created.length, 1); assert.equal(f.calls.length, 2, 'successful results are not cached by this adapter');
});

test('custom nodes do not add public fallbacks, and dynamic configurations reuse their client and cooldown', async () => {
  const f = fixture(); f.config({ rpcs: ['https://private.example/rpc?key=secret', 'https://private.example/rpc?key=secret'] });
  const first = await f.request('eth_blockNumber', []); assert.deepEqual(f.created[0].urls, ['https://private.example/rpc?key=secret']);
  f.config({ rpcs: ['https://second.example/rpc'] }); const second = await f.request('eth_blockNumber', []); assert.notEqual(first.clientId, second.clientId);
  f.config({ rpcs: ['https://private.example/rpc?key=secret'] }); const returned = await f.request('eth_blockNumber', []);
  assert.equal(returned.clientId, first.clientId); assert.equal(f.created.length, 2); assert.equal(f.request.getStatus().clientId, first.clientId);
});

test('client retention is bounded and repeated equivalent URL configuration does not reset the pool', async () => {
  const f = fixture({ maxClients: 2 });
  f.config({ rpcs: ['https://ONE.example'] }); const first = await f.request('eth_blockNumber', []);
  f.config({ rpcs: ['https://one.example/'] }); assert.equal((await f.request('eth_blockNumber', [])).clientId, first.clientId);
  for (const host of ['two', 'three']) { f.config({ rpcs: [`https://${host}.example`] }); await f.request('eth_blockNumber', []); }
  f.config({ rpcs: ['https://one.example/'] }); assert.notEqual((await f.request('eth_blockNumber', [])).clientId, first.clientId); assert.equal(f.created.length, 4);
});

test('invalid custom RPC configuration fails closed with a fixed message and never falls back to public nodes', async () => {
  for (const rpcs of ['https://private.example', ['file:///private/key'], ['https://user:secret@private.example/rpc'], ['https://private.example/#secret'], ['not-a-url']]) {
    const f = fixture(); f.config({ rpcs });
    await assert.rejects(f.request('eth_blockNumber', []), error => error.message === 'RPC 配置无效'); assert.equal(f.created.length, 0);
  }
});

test('separate app config readers cannot change each other’s selected RPC client', async () => {
  const first = fixture(), second = fixture(); first.config({ rpcs: ['https://one.example/rpc'] }); second.config({ rpcs: ['https://two.example/rpc'] });
  await Promise.all([first.request('eth_blockNumber', []), second.request('eth_blockNumber', [])]);
  assert.deepEqual(first.created[0].urls, ['https://one.example/rpc']); assert.deepEqual(second.created[0].urls, ['https://two.example/rpc']);
  second.config({ rpcs: [] }); await second.request('eth_blockNumber', []); await first.request('eth_blockNumber', []); assert.equal(first.created.length, 1);
});

test('dynamic configured clients use the injected fetch exclusively, including per-provider chain checks', async t => {
  const originalFetch = globalThis.fetch; let forbidden = 0, created = 0;
  globalThis.fetch = async () => { forbidden++; throw Error('Default fetch must not be used'); };
  t.after(() => { globalThis.fetch = originalFetch; });
  let config = { rpcs: ['https://one.example/rpc?key=private'] }; const calls = [];
  const request = createWebRpc({ readConfig: () => config,
    fetchImpl: async (url, options) => { const body = JSON.parse(options.body); calls.push({ url, method: body.method }); return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: body.id, result: body.method === 'eth_chainId' ? '0x38' : '0x2' }) }; },
    createClient: options => { created++; return createRpcClient({ ...options, minIntervalMs: 0 }); },
  });
  assert.equal(await request('eth_blockNumber', []), '0x2');
  config = { rpcs: ['https://two.example/rpc'] }; assert.equal(await request('eth_blockNumber', []), '0x2');
  config = { rpcs: ['https://one.example/rpc?key=private'] }; assert.equal(await request('eth_blockNumber', []), '0x2');
  assert.equal(created, 2); assert.equal(forbidden, 0); assert.equal(calls.filter(call => call.method === 'eth_chainId').length, 2);
  assert.ok(calls.every(call => ['one.example', 'two.example'].includes(new URL(call.url).hostname)));
});
