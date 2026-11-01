import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { createApp } from '../server.mjs';
import { DEFAULT_CONFIG, sanitizeConfig } from '../lib/config.mjs';

const A = '0x' + '1'.repeat(40), B = '0x' + '2'.repeat(40);
const abi = value => '0x' + BigInt(value).toString(16).padStart(64, '0');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function fixture(t, overrideRpc) {
  let config = { ...structuredClone(DEFAULT_CONFIG), wallets: [{ id: 'wallet-a', name: 'A', address: A }, { id: 'wallet-b', name: 'B', address: B, archived: true }, { id: 'draft', name: 'Draft', address: '', draft: true }] };
  const cli = [], rpc = [];
  const server = createApp({ readConfig: () => structuredClone(config), sanitizeConfig, saveConfig: input => { config = input; return input; },
    getCliInfo: () => ({ ready: true, version: 'test' }), dashboardStatus: async () => ({ service: { running: false } }),
    rpc: async (method, params) => { rpc.push({ method, params }); if (overrideRpc) return overrideRpc(method, params); return method === 'eth_chainId' ? '0x38' : method === 'eth_getBalance' ? '0x0' : abi(10n ** 18n); },
    runWallet: async args => { cli.push(args); const command = args.slice(0, 2).join(' ');
      if (command === 'wallet status') return { success: true, data: { status: 'CONNECTED' } };
      if (command === 'wallet address') return { success: true, data: { addresses: [{ binanceChainId: '56', address: A }] } };
      if (command === 'wallet settings') return { success: true, data: {} };
      if (command === 'wallet balance') return { success: true, data: [{ symbol: 'CUSTOM', balance: '2', value: 3 }] };
      throw new Error('Unexpected CLI call');
    },
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(done => server.close(done)); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const bootstrap = await fetch(base + '/api/bootstrap'), cookie = bootstrap.headers.get('set-cookie').split(';')[0];
  const request = async (path, headers = { cookie }) => { const response = await fetch(base + path, { headers }); return { status: response.status, ...await response.json() }; };
  return { request, cli, rpc, setWallets: wallets => { config = { ...config, wallets }; } };
}

test('balance summary requires local session, reads bound offline and archived addresses without CLI', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/wallet/balance-summary?walletId=wallet-a', {})).status, 401); assert.equal(f.rpc.length, 0);
  assert.equal((await f.request('/api/wallet/balance-summary?walletId=wallet-a', { origin: 'https://attacker.invalid' })).status, 403); assert.equal(f.rpc.length, 0);
  for (const [id, address] of [['wallet-a', A], ['wallet-b', B]]) {
    const response = await f.request('/api/wallet/balance-summary?walletId=' + id);
    assert.equal(response.status, 200); assert.equal(response.data.walletId, id); assert.equal(response.data.walletAddress, address); assert.equal(response.data.status, 'ready'); assert.deepEqual(response.data.assets.map(asset => asset.balance), ['0', '1']);
  }
  assert.equal(f.cli.length, 0);
});

test('unbound and bootstrap wallets return an unknown summary without CLI or RPC', async t => {
  const f = await fixture(t);
  const draft = await f.request('/api/wallet/balance-summary?walletId=draft');
  assert.equal(draft.status, 200); assert.equal(draft.data.status, 'unbound'); assert.deepEqual(draft.data.assets.map(asset => asset.balance), [null, null]);
  f.setWallets([]);
  const bootstrap = await f.request('/api/wallet/balance-summary');
  assert.equal(bootstrap.status, 200); assert.equal(bootstrap.data.walletId, 'bootstrap-wallet'); assert.equal(bootstrap.data.status, 'unbound');
  assert.equal(f.cli.length, 0); assert.equal(f.rpc.length, 0);
});

test('summary honors cache and refresh while the previous full-asset CLI route retains its response', async t => {
  const f = await fixture(t);
  await f.request('/api/wallet/balance-summary?walletId=wallet-a'); await f.request('/api/wallet/balance-summary?walletId=wallet-a'); assert.equal(f.rpc.length, 3);
  await f.request('/api/wallet/balance-summary?walletId=wallet-a&refresh=1'); assert.equal(f.rpc.length, 6); assert.equal(f.cli.length, 0);
  const full = await f.request('/api/wallet/balance?walletId=wallet-a');
  assert.equal(full.status, 200); assert.deepEqual(full.data, { balances: [{ symbol: 'CUSTOM', balance: '2', value: 3 }] }); assert.equal(f.rpc.length, 6);
  assert.deepEqual(f.cli.map(args => args.slice(0, 2).join(' ')), ['wallet status', 'wallet address', 'wallet settings', 'wallet balance']);
});

test('stable wallet IDs survive reorder and independent failures remain unknown instead of zero', async t => {
  const f = await fixture(t, async (method, params) => {
    if (method === 'eth_chainId') return '0x38';
    const address = method === 'eth_getBalance' ? params[0] : '0x' + params[0].data.slice(-40);
    if (address === A) throw new Error('PRIVATE API KEY https://secret-rpc.invalid');
    return method === 'eth_getBalance' ? '0x0' : abi(0);
  });
  f.setWallets([{ id: 'wallet-b', address: B }, { id: 'wallet-a', address: A }]);
  const [failed, good] = await Promise.all([f.request('/api/wallet/balance-summary?walletId=wallet-a'), f.request('/api/wallet/balance-summary?walletId=wallet-b')]);
  assert.equal(failed.status, 200); assert.equal(failed.data.walletAddress, A); assert.equal(failed.data.status, 'error'); assert.deepEqual(failed.data.assets.map(asset => asset.balance), [null, null]); assert.equal(JSON.stringify(failed).includes('PRIVATE'), false);
  assert.equal(good.data.status, 'ready'); assert.equal(good.data.walletAddress, B); assert.deepEqual(good.data.assets.map(asset => asset.balance), ['0', '0']); assert.equal(f.cli.length, 0);
});

test('an API response for a rebound or deleted wallet is rejected after the RPC completes', async t => {
  for (const removed of [false, true]) {
    const gate = deferred(), started = deferred();
    const f = await fixture(t, async method => { if (method === 'eth_chainId') { started.resolve(); await gate.promise; return '0x38'; } return method === 'eth_getBalance' ? '0x0' : abi(0); });
    const pending = f.request('/api/wallet/balance-summary?walletId=wallet-a'); await started.promise;
    f.setWallets(removed ? [] : [{ id: 'wallet-a', address: B }]); gate.resolve();
    const result = await pending;
    assert.equal(result.status, 409); assert.equal(result.ok, false); assert.equal('data' in result, false); assert.equal(f.cli.length, 0);
  }
});
