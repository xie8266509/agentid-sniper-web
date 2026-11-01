import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { test } from 'node:test';
import { createApp } from '../server.mjs';
import { DEFAULT_CONFIG, sanitizeConfig, validateConfig } from '../lib/config.mjs';
import { redact } from '../lib/control.mjs';
import { buildStrategyStatus, positionState } from '../lib/strategy-status.mjs';
import { normalizeWalletConfig } from '../lib/wallet-model.mjs';

const A = '0x1111111111111111111111111111111111111111';
const B = '0x2222222222222222222222222222222222222222';
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));

async function app(t, custom = {}) {
  let current = structuredClone(DEFAULT_CONFIG);
  current.wallets = [{ name: 'wallet-A', address: A }];
  const calls = [], verifications = [];
  const defaultRun = async (args, opts) => {
    calls.push({ args, opts });
    if (args[0] === 'auth' && args[1] === 'signin') return { success: true, data: { qrCodeId: 'mock-qr', urlForWeb: 'https://web3.binance.com/en/agent-login?mock=1', pairingCode: '123456', expireAt: Date.now() + 300000 } };
    if (args[0] === 'auth' && args[1] === 'verify') {
      const d = deferred(); verifications.push(d);
      opts.signal?.addEventListener('abort', () => d.resolve({ success: false, error: { name: 'CANCELLED', message: 'Cancelled' } }), { once: true });
      return d.promise;
    }
    if (args[0] === 'wallet' && args[1] === 'status') return { success: true, data: { status: 'CONNECTED' } };
    if (args[0] === 'wallet' && args[1] === 'address') return { success: true, data: { addresses: [{ binanceChainId: '56', address: A }] } };
    if (args[0] === 'wallet' && args[1] === 'settings') return { success: true, data: { devMode: { enabled: true, expiresAt: Date.now() + 3600000 } } };
    if (args[0] === 'wallet' && args[1] === 'tx-lock') return { success: true, data: { status: 'UNLOCKED' } };
    if (args[0] === 'wallet' && args[1] === 'agent-id') return { success: true, data: { claimed: false } };
    if (args[0] === 'contract-call' && args[1] === 'preview') return { success: true, data: { requestId: 'mock-request', parsedTx: { to: B }, simulationResult: { authorityChanges: [] }, risks: [] } };
    if (args[0] === 'contract-call' && args[1] === 'execute') return { success: true, data: { txHash: 'mock-tx' } };
    return { success: true, data: {} };
  };
  const deps = {
    readConfig: () => structuredClone(current), sanitizeConfig,
    saveConfig(input) { current = validateConfig({ ...current, ...input }); return sanitizeConfig(current); },
    runWallet: (args, opts) => custom.runWallet ? custom.runWallet(args, opts, defaultRun) : defaultRun(args, opts),
    getCliInfo: () => ({ version: 'mock', ready: true, path: '/mock/cli' }),
    dashboardStatus: custom.dashboardStatus || (async () => ({ service: { running: false } })),
    controlService: async () => ({ running: true }), holdingsData: () => ({}), readLogs: () => ({ lines: [] }),
  };
  const server = createApp(deps);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { for (const v of verifications) v.resolve({success:false,error:{message:'Test cleanup'}}); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = 'http://127.0.0.1:' + server.address().port;
  async function session() {
    const r = await fetch(base + '/api/bootstrap');
    return { cookie: r.headers.get('set-cookie').split(';')[0], csrf: (await r.json()).data.csrfToken };
  }
  async function request(session, method, path, body, extra = {}) {
    const r = await fetch(base + path, { method, headers: { cookie: session.cookie, 'x-csrf-token': session.csrf, 'content-type': 'application/json', ...extra }, ...(method === 'POST' ? { body: JSON.stringify(body || {}) } : {}) });
    return { status: r.status, body: await r.json() };
  }
  return { base, session, request, calls, verifications, getConfig: () => current, setConfig: c => { current = c; } };
}

test('localhost server rejects hostile origins and missing CSRF tokens', async t => {
  const a = await app(t), s = await a.session();
  assert.equal((await a.request(s, 'POST', '/api/config', { config: {} }, { origin: 'https://untrusted.example' })).status, 403);
  assert.equal((await a.request(s, 'POST', '/api/config', { config: {} }, { 'x-csrf-token': '' })).status, 403);
  const hostStatus = await new Promise((resolve, reject) => {
    const req = httpRequest(a.base + '/api/status', { headers: { host: 'untrusted.example', cookie: s.cookie } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(hostStatus, 403);
});

test('preview ownership and one-time execution are enforced', async t => {
  const a = await app(t), s = await a.session(), other = await a.session();
  const preview = await a.request(s, 'POST', '/api/contract/preview', { to: B, inputData: '0x', value: '0' });
  assert.equal(preview.status, 200);
  const id = preview.body.data.id;
  assert.equal((await a.request(other, 'POST', '/api/contract/execute', { id, confirmed: true })).status, 409);
  assert.equal((await a.request(s, 'POST', '/api/contract/execute', { id, confirmed: true })).status, 200);
  assert.equal((await a.request(s, 'POST', '/api/contract/execute', { id, confirmed: true })).status, 409);
  assert.equal(a.calls.filter(c => c.args[0] === 'contract-call' && c.args[1] === 'execute').length, 1);
});

test('manual preview rejects a logged-in address that differs from the selected configured wallet', async t => {
  const a = await app(t, { async runWallet(args, opts, next) {
    if(args[0]==='wallet'&&args[1]==='address') return {success:true,data:{addresses:[{binanceChainId:'56',address:B}]}};
    return next(args,opts);
  } });
  const s=await a.session();
  assert.equal((await a.request(s,'POST','/api/contract/preview',{to:B,value:'0'})).status,409);
  assert.equal(a.calls.filter(c=>c.args[0]==='contract-call'&&c.args[1]==='preview').length,0);
});

test('pending login is not handed to another browser session', async t => {
  const a = await app(t), s = await a.session(), other = await a.session();
  assert.equal((await a.request(s, 'POST', '/api/wallet/login', {})).status, 200);
  assert.equal((await a.request(other, 'POST', '/api/wallet/login', {})).status, 409);
});

test('wallet import locks configuration mapping until it finishes', async t => {
  const started = deferred(), proceed = deferred(); let gated = false;
  const a = await app(t, { async runWallet(args, opts, next) {
    if (!gated && args[0] === 'wallet' && args[1] === 'status') { gated = true; started.resolve(); await proceed.promise; }
    return next(args, opts);
  } });
  const s = await a.session();
  const importing = a.request(s, 'POST', '/api/wallet/import', {});
  await started.promise;
  let saving;
  try { saving = await a.request(s, 'POST', '/api/config', { config: { timeZone: 'UTC' } }); }
  finally { proceed.resolve(); }
  assert.equal((await importing).status, 200);
  assert.equal(saving.status, 409);
});

test('wallet import invalidates previous contract previews', async t => {
  const a = await app(t), s = await a.session();
  const preview = await a.request(s, 'POST', '/api/contract/preview', { to: B, value: '0' });
  assert.equal((await a.request(s, 'POST', '/api/wallet/import', {})).status, 200);
  assert.equal((await a.request(s, 'POST', '/api/contract/execute', { id: preview.body.data.id, confirmed: true })).status, 409);
  assert.equal(a.calls.filter(c => c.args[0] === 'contract-call' && c.args[1] === 'execute').length, 0);
});

test('wallet logout acquires its lock before asynchronous service checks', async t => {
  const checking = deferred(), proceed = deferred();
  const a = await app(t, { async dashboardStatus() { checking.resolve(); await proceed.promise; return {service:{running:false}}; } });
  const s = await a.session(), logout = a.request(s, 'POST', '/api/wallet/logout', {confirmed:true});
  await checking.promise;
  let saving;
  try { saving = await a.request(s, 'POST', '/api/config', {config:{timeZone:'UTC'}}); }
  finally { proceed.resolve(); }
  assert.equal((await logout).status, 200);
  assert.equal(saving.status, 409);
});

test('execute rechecks preview expiry after asynchronous wallet validation', async t => {
  const checking = deferred(), proceed = deferred(); let executing = false;
  const a = await app(t, { async runWallet(args, opts, next) {
    if (executing && args[0] === 'wallet' && args[1] === 'status') { checking.resolve(); await proceed.promise; }
    const result = await next(args,opts);
    if (args[0] === 'contract-call' && args[1] === 'preview') result.data.expiresAt = Date.now()+250;
    return result;
  } });
  const s = await a.session(), preview = await a.request(s,'POST','/api/contract/preview',{to:B,value:'0'});
  executing = true;
  const execution = a.request(s,'POST','/api/contract/execute',{id:preview.body.data.id,confirmed:true});
  await checking.promise;
  await new Promise(resolve => setTimeout(resolve,300));
  proceed.resolve();
  assert.equal((await execution).status,409);
  assert.equal(a.calls.filter(c=>c.args[0]==='contract-call'&&c.args[1]==='execute').length,0);
});

test('cancelling login during final status check cannot turn it into success', async t => {
  const checking = deferred(), proceed = deferred();
  const a = await app(t, { async runWallet(args, opts, next) {
    if (args[0] === 'wallet' && args[1] === 'status') { checking.resolve(); await proceed.promise; }
    return next(args, opts);
  } });
  const s = await a.session(), login = await a.request(s, 'POST', '/api/wallet/login', {}), id = login.body.data.id;
  a.verifications[0].resolve({ success: true, data: { status: 'SUCCESS' } });
  await checking.promise;
  const cancelling = a.request(s, 'POST', '/api/wallet/login/' + id + '/cancel', {});
  for (let i = 0; i < 10; i++) {
    if ((await a.request(s, 'GET', '/api/wallet/login/' + id)).body.data.status === 'CANCELLED') break;
    await tick();
  }
  proceed.resolve();
  assert.equal((await cancelling).body.data.status, 'CANCELLED');
  await tick(); await tick();
  assert.equal((await a.request(s, 'GET', '/api/wallet/login/' + id)).body.data.status, 'CANCELLED');
});

test('automatic service preflight prevents concurrent wallet/config changes', async t => {
  const started = deferred(), proceed = deferred(); let gated = false;
  const a = await app(t, { async runWallet(args, opts, next) {
    if (!gated && args[0] === 'wallet' && args[1] === 'status') { gated = true; started.resolve(); await proceed.promise; }
    return next(args, opts);
  } });
  a.setConfig({ ...a.getConfig(), monitorOnly: false });
  const s = await a.session(), starting = a.request(s, 'POST', '/api/service/start', { confirmAutoTrading: true });
  await started.promise;
  let saving;
  try { saving = await a.request(s, 'POST', '/api/config', { config: { timeZone: 'UTC' }, confirmAutoTrading: true }); }
  finally { proceed.resolve(); }
  assert.equal((await starting).status, 200);
  assert.equal(saving.status, 409);
});

test('redaction removes session tokens, seed phrases, and inline credentials', () => {
  const fixture = { sessionToken: 'FAKE_SESSION_TOKEN', seedPhrase: 'FAKE_SEED_PHRASE', nested: ['privateKey=FAKE_PRIVATE_KEY', 'Bearer FAKE_ACCESS_TOKEN'] };
  assert.ok(!JSON.stringify(redact(fixture)).includes('FAKE_'));
});

test('holdings of a secondary-wallet-only token use that wallet state', async () => {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const source = readFileSync(join(root, 'lib', 'control.mjs'), 'utf8').replace(/^import .*;\n/gm, '').replace(/^export /gm, '').replaceAll('import.meta.url', JSON.stringify('file:///mock/lib/control.mjs')) + '\nserviceInfo = async () => ({running:false}); globalThis.getHoldings = holdingsData;';
  const config = { wallets: [{ name: 'first', address: A }, { name: 'second', address: B }], tokens: [{ sym: 'SAME', addr: A, only: B }] };
  const state = { tokens: { SAME: { lastBal: '111', last: { v: 11 } }, 'second:SAME': { lastBal: '222', last: { v: 22 } } } };
  const sandbox = { dirname, join, fileURLToPath, normalizeWalletConfig, buildStrategyStatus, positionState, createNftMarket: () => ({ snapshot: () => ({ markets: {}, marketSync: {} }) }), execFile() { throw new Error('Unexpected process'); }, promisify() { return () => { throw new Error('Unexpected process'); }; }, readConfig: () => config, readFileSync: () => JSON.stringify(state) };
  vm.runInNewContext(source, sandbox);
  const holding = (await sandbox.getHoldings()).tokens[0];
  assert.equal(holding.wallet, 'second'); assert.equal(holding.quantity, '222'); assert.equal(holding.value, 22);
});
