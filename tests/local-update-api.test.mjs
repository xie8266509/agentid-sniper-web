// Local HTTP integration only: updater, service, NFT worker and wallet are all
// isolated doubles. These tests never contact GitHub or execute a real wallet.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { createApp } from '../server.mjs';
import { DEFAULT_CONFIG, sanitizeConfig } from '../lib/config.mjs';

const walletAddress = '0x1111111111111111111111111111111111111111';
const target = '0x2222222222222222222222222222222222222222';
const targetCommit = 'b'.repeat(40), currentCommit = 'a'.repeat(40);
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };

async function fixture(t, options = {}) {
  const calls = { events: [], checkerStarts: 0, checkerStops: 0, checks: 0, updates: [], rollbacks: 0, restarts: [], wallet: [], service: [], nft: [], saves: 0 };
  const cfg = structuredClone(DEFAULT_CONFIG); cfg.wallets = [{ name: 'test-wallet', address: walletAddress }];
  const beforeConfig = JSON.stringify(cfg);
  const job = deferred(), login = deferred(), walletRead = deferred(), enteredRead = deferred();
  let failView = Boolean(options.failView), phase = 'available', nftBusy = false, scannerActive = Boolean(options.scannerActive);
  const localUpdater = {
    view() { if (failView) { failView = false; throw new Error('Mock status unavailable'); } return { phase, current: { version: 'v2.5.8', commit: currentCommit }, latest: { version: 'v2.5.9', commit: targetCommit }, updateAvailable: true, available: true, rollbackAvailable: true, canRollback: true, checkedAt: Date.now(), intervalMs: 1800000 }; },
    async check() { calls.checks++; return this.view(); },
    async update(input) { calls.events.push('update'); calls.updates.push(input); phase = 'updating'; await job.promise; phase = options.fail ? 'failed' : 'succeeded'; if (options.fail) throw Object.assign(new Error('Mock merge conflict'), { status: 409 }); return { ...this.view(), targetCommit, backupId: 'test-backup', restartRequired: true }; },
    async rollback() { calls.rollbacks++; phase = 'updating'; await job.promise; phase = 'rolled-back'; return { ...this.view(), targetCommit: currentCommit, backupId: 'test-backup', restartRequired: true }; },
    isBusy() { return ['updating'].includes(phase); }, start() { calls.checkerStarts++; }, stop() { calls.checkerStops++; },
  };
  const nftTrading = { view: async () => ({ rules: [], states: {} }), start() { calls.nft.push('start'); }, stop() { calls.nft.push('stop'); }, hasInFlight: () => nftBusy, getApiKey: () => '', saveRule() { calls.nft.push('save'); return {}; } };
  const runWallet = async (args, opts) => {
    calls.wallet.push(args);
    if (options.deferWalletRead && args[0] === 'wallet' && args[1] === 'status') { enteredRead.resolve(); await walletRead.promise; }
    if (args[0] === 'auth' && args[1] === 'signin') return { success: true, data: { qrCodeId: 'test-qr', urlForWeb: 'https://web3.binance.com/en/agent-login?mock=1', pairingCode: '123456', expireAt: Date.now() + 300000 } };
    if (args[0] === 'auth' && args[1] === 'verify') { opts.signal?.addEventListener('abort', () => login.resolve({ success: false, error: { message: 'cancelled' } }), { once: true }); return login.promise; }
    if (args[0] === 'wallet' && args[1] === 'status') return { success: true, data: { status: 'CONNECTED' } };
    if (args[0] === 'wallet' && args[1] === 'address') return { success: true, data: { addresses: [{ binanceChainId: '56', address: walletAddress }] } };
    if (args[0] === 'wallet' && args[1] === 'settings') return { success: true, data: { devMode: { enabled: true, expiresAt: Date.now() + 300000 } } };
    return { success: true, data: {} };
  };
  const app = createApp({
    localUpdater, nftTrading, runWallet, startUpdateChecker: options.startUpdateChecker,
    readConfig: () => structuredClone(cfg), sanitizeConfig, saveConfig() { calls.saves++; throw new Error('Update must not save config'); },
    getCliInfo: () => ({ ready: true, version: 'mock' }),
    dashboardStatus: async () => ({ service: { running: scannerActive }, mode: cfg.monitorOnly ? 'monitor' : 'auto' }),
    isScannerActive: async () => scannerActive,
    controlService: async action => { calls.service.push(action); return { running: action !== 'stop' }; },
    holdingsData: async () => ({}), readLogs: () => ({ lines: [] }),
    restartWeb: async input => { calls.restarts.push(input); },
  });
  app.on('request', (req, res) => { if (req.url === '/api/updates/apply') res.once('finish', () => calls.events.push('response-finished')); });
  app.listen(0, '127.0.0.1'); await once(app, 'listening');
  t.after(async () => { job.resolve(); walletRead.resolve(); login.resolve({ success: false, error: { message: 'test cleanup' } }); await flush(); app.closeAllConnections(); await new Promise(resolve => app.close(resolve)); });
  const base = 'http://127.0.0.1:' + app.address().port;
  async function session() { const r = await fetch(base + '/api/bootstrap'); return { cookie: r.headers.get('set-cookie').split(';')[0], csrf: (await r.json()).data.csrfToken }; }
  async function request(s, method, path, body, extra = {}) { const r = await fetch(base + path, { method, headers: { cookie: s.cookie, 'content-type': 'application/json', 'x-csrf-token': s.csrf, ...extra }, ...(method === 'POST' ? { body: JSON.stringify(body || {}) } : {}) }); return { status: r.status, body: await r.json() }; }
  return { base, session, request, calls, job, walletRead, enteredRead, setNftBusy: value => { nftBusy = value; }, setScannerActive: value => { scannerActive = value; }, configUnchanged: () => JSON.stringify(cfg) === beforeConfig };
}

test('updates retain localhost session, origin and CSRF boundaries', async t => {
  const f = await fixture(t), s = await f.session();
  assert.equal((await fetch(f.base + '/api/updates')).status, 401);
  assert.equal((await f.request(s, 'POST', '/api/updates/check', {}, { 'x-csrf-token': '' })).status, 403);
  assert.equal((await f.request(s, 'POST', '/api/updates/apply', { targetCommit, confirmed: true }, { origin: 'https://untrusted.example' })).status, 403);
  assert.equal((await f.request(s, 'GET', '/api/updates')).status, 200);
  const checked = await f.request(s, 'POST', '/api/updates/check', {});
  assert.equal(checked.status, 200); assert.equal(f.calls.checks, 1); assert.deepEqual(f.calls.wallet, []);
  assert.deepEqual(f.calls.updates, []); assert.deepEqual(f.calls.service, []);
});

test('apply requires a confirmed immutable target and a stopped scanner', async t => {
  const f = await fixture(t, { scannerActive: true }), s = await f.session();
  assert.equal((await f.request(s, 'POST', '/api/updates/apply', { targetCommit })).status, 409);
  assert.equal((await f.request(s, 'POST', '/api/updates/apply', { confirmed: true })).status, 400);
  assert.equal((await f.request(s, 'POST', '/api/updates/apply', { targetCommit, confirmed: true })).status, 409);
  assert.deepEqual(f.calls.updates, []); assert.deepEqual(f.calls.service, []); assert.deepEqual(f.calls.wallet, []);
  assert.equal(f.configUnchanged(), true);
});

test('waiting wallet login and an active NFT tick each prevent an update', async t => {
  const f = await fixture(t), s = await f.session();
  f.setNftBusy(true);
  assert.equal((await f.request(s, 'POST', '/api/updates/apply', { targetCommit, confirmed: true })).status, 409);
  f.setNftBusy(false);
  assert.equal((await f.request(s, 'POST', '/api/wallet/login', { walletIndex: 0 })).status, 200);
  assert.equal((await f.request(s, 'POST', '/api/updates/apply', { targetCommit, confirmed: true })).status, 409);
  assert.deepEqual(f.calls.updates, []);
});

test('an already running wallet read blocks update admission too', async t => {
  const f = await fixture(t, { deferWalletRead: true }), s = await f.session();
  const pending = f.request(s, 'GET', '/api/wallet/status?refresh=1');
  await f.enteredRead.promise;
  assert.equal((await f.request(s, 'POST', '/api/updates/apply', { targetCommit, confirmed: true })).status, 409);
  f.walletRead.resolve(); assert.equal((await pending).status, 200); assert.deepEqual(f.calls.updates, []);
});

test('accepted update blocks concurrent mutations and wallet reads without duplicate submission', async t => {
  const f = await fixture(t), s = await f.session();
  const accepted = await f.request(s, 'POST', '/api/updates/apply', { targetCommit, confirmed: true });
  assert.equal(accepted.status, 202); await flush(); assert.deepEqual(f.calls.updates, [{ targetCommit }]);
  assert.deepEqual(f.calls.events.slice(0, 2), ['response-finished', 'update']);
  const blocked = [
    ['POST', '/api/updates/apply', { targetCommit, confirmed: true }],
    ['POST', '/api/updates/rollback', { confirmed: true }],
    ['POST', '/api/config', { config: structuredClone(DEFAULT_CONFIG) }],
    ['POST', '/api/service/start', {}],
    ['POST', '/api/wallet/login', { walletIndex: 0 }],
    ['GET', '/api/wallet/status'], ['GET', '/api/wallet/balance'],
    ['POST', '/api/contract/preview', { to: target }],
    ['POST', '/api/contract/execute', { id: 'old-preview', confirmed: true }],
    ['POST', '/api/nft/trading/rules', { rule: {} }],
    ['POST', '/api/nft/trading/confirm', { actionId: 'old-preview', confirmed: true }],
  ];
  for (const [method, path, body] of blocked) assert.equal((await f.request(s, method, path, body)).status, 409, path);
  assert.equal((await f.request(s, 'GET', '/api/updates')).status, 200);
  assert.equal((await f.request(s, 'GET', '/api/status')).status, 200);
  assert.equal(f.calls.updates.length, 1); assert.deepEqual(f.calls.wallet, []); assert.deepEqual(f.calls.service, []); assert.equal(f.calls.saves, 0);
  assert.deepEqual(f.calls.restarts, []);
  f.job.resolve(); await flush();
  assert.equal(f.calls.restarts.length, 1); assert.equal(f.configUnchanged(), true); assert.deepEqual(f.calls.service, []);
});

test('failed merge releases the update gate without restarting or changing configuration', async t => {
  const f = await fixture(t, { fail: true }), s = await f.session();
  assert.equal((await f.request(s, 'POST', '/api/updates/apply', { targetCommit, confirmed: true })).status, 202);
  f.job.resolve(); await flush();
  assert.deepEqual(f.calls.restarts, []); assert.equal(f.configUnchanged(), true);
  assert.equal((await f.request(s, 'GET', '/api/config')).status, 200);
  assert.deepEqual(f.calls.service, []); assert.equal(f.calls.saves, 0);
});

test('rollback is explicit, preserves settings and does not start the scanner', async t => {
  const f = await fixture(t), s = await f.session();
  assert.equal((await f.request(s, 'POST', '/api/updates/rollback', {})).status, 409);
  assert.equal((await f.request(s, 'POST', '/api/updates/rollback', { confirmed: true })).status, 202);
  await flush(); assert.equal(f.calls.rollbacks, 1); assert.deepEqual(f.calls.service, []);
  f.job.resolve(); await flush();
  assert.equal(f.calls.restarts.length, 1); assert.equal(f.configUnchanged(), true); assert.equal(f.calls.saves, 0); assert.deepEqual(f.calls.service, []);
});


test('an admission response failure cannot launch an update behind an HTTP error', async t => {
  const f = await fixture(t, { failView: true }), s = await f.session();
  assert.equal((await f.request(s, 'POST', '/api/updates/apply', { targetCommit, confirmed: true })).status, 500);
  await flush(); assert.deepEqual(f.calls.updates, []); assert.deepEqual(f.calls.restarts, []);
  assert.equal((await f.request(s, 'GET', '/api/config')).status, 200);
});


test('the Web update checker starts independently of the stopped scanner', async t => {
  const f = await fixture(t, { startUpdateChecker: true }), s = await f.session();
  assert.equal(f.calls.checkerStarts, 1);
  assert.equal((await f.request(s, 'GET', '/api/updates')).status, 200);
  assert.deepEqual(f.calls.wallet, []); assert.deepEqual(f.calls.service, []); assert.deepEqual(f.calls.updates, []);
});
