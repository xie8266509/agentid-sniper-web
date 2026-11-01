import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import { createApp, toWei } from '../server.mjs';
import { DEFAULT_CONFIG, sanitizeConfig, validateConfig } from '../lib/config.mjs';

const walletAddress = '0x1111111111111111111111111111111111111111';
const target = '0x2222222222222222222222222222222222222222';
async function fixture(t, options = {}) {
  let config = structuredClone(DEFAULT_CONFIG), connected = false, devMode = true;
  const calls = [], controls = [];
  const server = createApp({
    readConfig: () => structuredClone(config), sanitizeConfig,
    saveConfig: (input) => { config = validateConfig({ ...config, ...input }); return sanitizeConfig(config); },
    getCliInfo: () => ({ ready: true, version: 'test' }),
    dashboardStatus: async () => ({ service: { running: false }, mode: config.monitorOnly ? 'monitor' : 'auto', scan: {} }),
    controlService: async (action) => { controls.push(action); return { running: action !== 'stop' }; },
    readLogs: () => ({ lines: ['sessionId=secret-to-hide'] }), holdingsData: () => ({ tokens: [], trades: [] }),
    runWallet: async (args) => {
      calls.push(args);
      const command = args.slice(0, 2).join(' ');
      if (command === 'wallet status') return { success: true, data: { status: connected ? 'CONNECTED' : 'UNCONNECTED' } };
      if (command === 'wallet address') return { success: true, data: { addresses: [{ binanceChainId: '56', address: walletAddress }] } };
      if (command === 'wallet settings') return { success: true, data: { devMode: { enabled: devMode, expiresAt: Math.floor(Date.now() / 1000) + 3600 }, sessionId: 'secret-to-hide' } };
      if (command === 'auth signin') return { success: true, data: { qrCodeId: 'mock-only', urlForWeb: 'https://web3.binance.com/en/agent-login?mock=1', pairingCode: '012345', expireAt: Date.now() + 300000 } };
      if (command === 'auth verify') { connected = true; return { success: true, data: { status: 'SUCCESS' } }; }
      if (command === 'wallet balance') return { success: true, data: [{ symbol: 'BNB', address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', balance: '1.00' }] };
      if (command === 'contract-call preview') return { success: true, data: { requestId: 'mock-preview', parsedTx: { recipient: target }, risks: { riskDetails: [{ title: 'Test warning', description: 'Mock only' }] }, simulationResult: { authorityChanges: [{ type: 'Test permission' }] } } };
      if (command === 'contract-call execute') return { success: true, data: { txHash: 'mock-only-never-broadcasted' } };
      throw new Error('Unexpected mock call ' + command);
    },
    ...options,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function session() {
    const res = await fetch(base + '/api/bootstrap');
    const cookie = res.headers.get('set-cookie').split(';')[0];
    const csrfToken = (await res.json()).data.csrfToken;
    return async function call(path, body, headers = {}) {
      const res = await fetch(base + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json', 'x-csrf-token': csrfToken }), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, ...(await res.json()) };
    };
  }
  return { base, session, calls, controls, setConnected: (value) => { connected = value; }, setDevMode: (value) => { devMode = value; }, getConfig: () => config };
}

test('BNB input converts to wei without floating-point rounding', () => {
  assert.equal(toWei('0.000000000000000001'), '1');
  assert.equal(toWei('1.234567890123456789'), '1234567890123456789');
  for (const invalid of ['-1', '1e-3', '0.1234567890123456789', 'NaN', ' 1']) assert.throws(() => toWei(invalid));
});

test('holdings exposes NFT rows and forwards explicit refresh without touching trading', async (t) => {
  const requests = [];
  const f = await fixture(t, { holdingsData(options) { requests.push(options); return { tokens: [], trades: [], nfts: [{ addr: target, quantity: '2', status: 'held' }], nftSync: { loading: false, verified: 1, total: 1 } }; } });
  const call = await f.session();
  const response = await call('/api/holdings?refresh=1');
  assert.equal(response.data.nfts[0].quantity, '2');
  assert.equal(requests[0].force, true);
  await call('/api/holdings');
  assert.equal(requests[1].force, false);
  assert.equal(f.calls.length, 0);
  assert.equal(f.controls.length, 0);
});

test('localhost API rejects missing sessions, cross-origin access, and missing CSRF', async (t) => {
  const f = await fixture(t), call = await f.session();
  assert.equal((await fetch(f.base + '/api/config')).status, 401);
  const hostileHost = await new Promise((resolve) => {
    http.get(f.base + '/api/bootstrap', { headers: { host: 'attacker.invalid' } }, (res) => { res.resume(); resolve(res.statusCode); });
  });
  assert.equal(hostileHost, 403);
  assert.equal((await call('/api/config', undefined, { origin: 'https://attacker.invalid' })).status, 403);
  assert.equal((await call('/api/config', { config: {} }, { 'x-csrf-token': '' })).status, 403);
  const logs = await call('/api/logs');
  assert.equal(JSON.stringify(logs).includes('secret-to-hide'), false);
});

test('UI login verifies local connection and imports the actual BSC wallet address', async (t) => {
  const f = await fixture(t), call = await f.session();
  assert.equal((await call('/api/wallet/status')).data.status, 'UNCONNECTED');
  const login = await call('/api/wallet/login', { walletIndex: 0 });
  assert.equal(login.data.pairingCode, '012345');
  assert.equal(login.data.urlForWeb, 'https://web3.binance.com/en/agent-login?mock=1');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal((await call('/api/wallet/login/' + login.data.id)).data.status, 'SUCCESS');
  const imported = await call('/api/wallet/import', { walletIndex: 0 });
  assert.equal(imported.data.config.wallets[0].address, walletAddress);
  assert.equal(JSON.stringify(imported).includes('secret-to-hide'), false);
  assert.equal((await call('/api/wallet/balance')).data.balances[0].balance, '1.00');
  assert.equal(f.calls.some((a) => a[0] === 'contract-call'), false);
});

test('contract calls require connection, developer mode, and a matching one-time preview', async (t) => {
  const f = await fixture(t), call = await f.session(), other = await f.session();
  const input = { walletIndex: 0, to: target, inputData: '0x1249c58b', value: '0.001' };
  assert.equal((await call('/api/contract/preview', input)).status, 409);
  f.setConnected(true); f.setDevMode(false);
  assert.equal((await call('/api/contract/preview', input)).status, 409);
  assert.equal(f.calls.some((a) => a[0] === 'contract-call'), false);
  f.setDevMode(true);
  const preview = await call('/api/contract/preview', input);
  assert.equal(preview.status, 200);
  assert.equal(preview.data.authorityChanges.length, 1);
  assert.equal(preview.data.risks.riskDetails[0].title, 'Test warning');
  const args = f.calls.find((a) => a[0] === 'contract-call');
  assert.equal(args[args.indexOf('--value') + 1], '1000000000000000');
  assert.equal((await other('/api/contract/execute', { id: preview.data.id, confirmed: true })).status, 409);
  assert.equal((await call('/api/contract/execute', { id: preview.data.id })).status, 409);
  assert.equal((await call('/api/contract/execute', { id: preview.data.id, confirmed: true })).status, 200);
  assert.equal((await call('/api/contract/execute', { id: preview.data.id, confirmed: true })).status, 409);
  assert.equal(f.calls.filter((a) => a[0] === 'contract-call' && a[1] === 'execute').length, 1);
});

test('auto-trading configuration and startup require an explicit confirmation', async (t) => {
  const f = await fixture(t), call = await f.session();
  const config = { ...structuredClone(DEFAULT_CONFIG), monitorOnly: false, wallets: [{ name: 'Test', address: walletAddress }] };
  assert.equal((await call('/api/config', { config })).status, 409);
  assert.equal((await call('/api/config', { config, confirmAutoTrading: true })).status, 200);
  assert.equal((await call('/api/service/start', {})).status, 409);
  assert.equal((await call('/api/service/start', { confirmAutoTrading: true })).status, 409);
  assert.equal(f.controls.length, 0);
  f.setConnected(true);
  assert.equal((await call('/api/service/start', { confirmAutoTrading: true })).status, 200);
  assert.deepEqual(f.controls, ['start']);
});
