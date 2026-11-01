import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';
import { DEFAULT_CONFIG, readConfig, saveConfig, validateConfig, sanitizeConfig } from '../lib/config.mjs';
import { isolatedWatch } from './watch-scanner-fixture.mjs';
import { runBoundWalletTransaction } from '../lib/wallet-cli.mjs';

const A = '0x1111111111111111111111111111111111111111', B = '0x2222222222222222222222222222222222222222', C = '0x3333333333333333333333333333333333333333';
async function fixture(t, { monitorOnly = false, offline = [], mismatched = [], permission = {}, beforeRead = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'agentid-readiness-review-')), path = join(root, 'config.json');
  writeFileSync(path, JSON.stringify(validateConfig({ ...structuredClone(DEFAULT_CONFIG), monitorOnly, wallets: [
    { id: 'wallet-a', name: 'Review A', address: A, agentId: 'review-a', agentIdVerified: true, mode: 'auto' },
    { id: 'wallet-b', name: 'Review B', address: B, agentId: 'review-b', agentIdVerified: true, mode: 'auto' },
  ] })));
  const calls = [], controls = [];
  const current = () => readConfig({ path });
  const server = createApp({ root, readConfig: current, saveConfig: (value, options) => saveConfig(value, { ...options, path }), sanitizeConfig,
    getCliInfo: () => ({ ready: true, version: 'review-fixture' }), dashboardStatus: async () => ({ service: { running: false }, mode: monitorOnly ? 'monitor' : 'auto' }),
    controlService: async action => { controls.push(action); return { running: action !== 'stop' }; },
    readLogs: () => ({ lines: [] }), holdingsData: async () => ({ tokens: [], nfts: [], trades: [] }),
    nftTrading: { view: async () => ({ rules: [], states: {}, settings: {}, capabilities: {} }), hasInFlight: () => false, stop() {} },
    runWallet: async (args, options) => {
      const walletId = options.walletId || current().wallets[options.walletIndex || 0]?.id, command = args.slice(0, 2).join(' '); calls.push({ walletId, command, options });
      await beforeRead?.({ walletId, command });
      if (command === 'wallet status') return { success: true, data: { status: offline.includes(walletId) ? 'UNCONNECTED' : 'CONNECTED' } };
      if (command === 'wallet address') return { success: true, data: { addresses: [{ binanceChainId: '56', address: mismatched.includes(walletId) ? C : walletId === 'wallet-a' ? A : B }] } };
      if (command === 'wallet settings') return permission[walletId] === 'failed' ? { success: false, error: { name: 'OFFLINE', message: 'mock permission unavailable' } } : { success: true, data: { devMode: { enabled: permission[walletId] !== 'disabled', expiresAt: Date.now() + (permission[walletId] === 'expired' ? -60000 : 3600000) } } };
      if (command === 'wallet balance') return { success: true, data: { balances: [] } };
      throw Error('Unexpected fixture command ' + command);
    },
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); rmSync(root, { recursive: true, force: true }); });
  const base = 'http://127.0.0.1:' + server.address().port, bootstrap = await fetch(base + '/api/bootstrap'), cookie = bootstrap.headers.get('set-cookie').split(';')[0], csrf = (await bootstrap.json()).data.csrfToken;
  const request = async (route, body) => { const result = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: result.status, ...await result.json() }; };
  return { request, calls, controls, current, change: mutate => { const next = current(); mutate(next); writeFileSync(path, JSON.stringify(next)); } };
}

test('one verified active wallet starts while a second active offline wallet is explicitly skipped', async t => {
  const f = await fixture(t, { offline: ['wallet-b'] }), result = await f.request('/api/service/start', { confirmAutoTrading: true });
  assert.equal(result.status, 200); assert.deepEqual(f.controls, ['start']);
  assert.deepEqual(result.data.walletReadiness.ready.map(wallet => wallet.walletId), ['wallet-a']);
  assert.equal(result.data.walletReadiness.skipped.find(wallet => wallet.walletId === 'wallet-b').code, 'OFFLINE');
  assert.ok(f.current().wallets.every(wallet => wallet.mode === 'auto' && wallet.paused === false), 'preflight never changes the user mode or pause configuration');
});

test('a connected session for another BSC address is never admitted to the ready set', async t => {
  const f = await fixture(t, { mismatched: ['wallet-a'] }), result = await f.request('/api/service/start', { confirmAutoTrading: true });
  assert.equal(result.status, 200); assert.deepEqual(result.data.walletReadiness.ready.map(wallet => wallet.walletId), ['wallet-b']);
  assert.equal(result.data.walletReadiness.skipped.find(wallet => wallet.walletId === 'wallet-a').code, 'ADDRESS_MISMATCH');
  assert.equal(f.current().wallets[0].address, A);
});

test('all active wallets offline cannot launch an automatic scanner', async t => {
  const f = await fixture(t, { offline: ['wallet-a', 'wallet-b'] }), result = await f.request('/api/service/start', { confirmAutoTrading: true });
  assert.equal(result.status, 409); assert.deepEqual(f.controls, []);
  assert.deepEqual(result.error.details.walletReadiness.ready, []); assert.equal(result.error.details.walletReadiness.skipped.length, 2);
});

test('monitor startup does not inspect sessions or invoke any wallet CLI command', async t => {
  const f = await fixture(t, { monitorOnly: true, offline: ['wallet-a', 'wallet-b'] }), result = await f.request('/api/service/start', {});
  assert.equal(result.status, 200); assert.deepEqual(f.controls, ['start']); assert.deepEqual(f.calls, []);
  assert.equal(result.data.walletReadiness.mode, 'monitor');
});

for (const [permission, code] of [['disabled', 'DEV_MODE_DISABLED'], ['expired', 'DEV_MODE_EXPIRED'], ['failed', 'PERMISSION_UNAVAILABLE']]) test(`a ${permission} permission check isolates only the affected active wallet`, async t => {
  const f = await fixture(t, { permission: { 'wallet-a': permission } }), result = await f.request('/api/service/start', { confirmAutoTrading: true });
  assert.equal(result.status, 200); assert.deepEqual(result.data.walletReadiness.ready.map(wallet => wallet.walletId), ['wallet-b']);
  assert.equal(result.data.walletReadiness.skipped.find(wallet => wallet.walletId === 'wallet-a').code, code);
});

for (const [label, mutate] of [
  ['global monitor switch', config => { config.monitorOnly = true; }],
  ['wallet pause', config => { config.wallets[0].paused = true; }],
  ['wallet reorder', config => { config.wallets.reverse(); }],
  ['session replacement', config => { config.wallets[0].bawDir = 'data/wallets/replaced-review-session'; }],
]) test(`preflight cannot start from a stale configuration after a late ${label}`, async t => {
  let release, entered;
  const blocked = new Promise(resolve => { release = resolve; }), reached = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, { beforeRead: async ({ walletId, command }) => { if (walletId === 'wallet-a' && command === 'wallet address') { entered(); await blocked; } } });
  const starting = f.request('/api/service/start', { confirmAutoTrading: true }); await reached;
  f.change(mutate); release(); const result = await starting;
  assert.equal(result.status, 409); assert.deepEqual(f.controls, []);
});

test('a permission that expires while slower wallets are checked cannot survive in the final ready set', async () => {
  const { collectWalletReadiness } = await import('../lib/wallet-readiness.mjs');
  let clock = 1800000000000; const expiresAt = clock + 5000;
  const report = await collectWalletReadiness({ concurrency: 1, now: () => clock, config: { monitorOnly: false, wallets: [{ id: 'wallet-a', name: 'A', address: A, mode: 'auto' }, { id: 'wallet-b', name: 'B', address: B, mode: 'auto' }] },
    readWallet: async wallet => { if (wallet.id === 'wallet-b') { clock += 6000; return { status: 'UNCONNECTED' }; } return { status: 'CONNECTED', address: A, settings: { devMode: { enabled: true, expiresAt } } }; },
  });
  assert.deepEqual(report.ready, []); assert.equal(report.skipped.find(wallet => wallet.walletId === 'wallet-a').code, 'DEV_MODE_EXPIRED');
});

test('a long preflight cannot relabel an old session proof as freshly checked without reading it again', async () => {
  const { collectWalletReadiness, WALLET_READINESS_TTL_MS } = await import('../lib/wallet-readiness.mjs');
  let clock = 1800000000000, readsA = 0;
  const report = await collectWalletReadiness({ concurrency: 1, now: () => clock, config: { monitorOnly: false, wallets: [{ id: 'wallet-a', name: 'A', address: A, mode: 'auto' }, { id: 'wallet-b', name: 'B', address: B, mode: 'auto' }] },
    readWallet: async wallet => { if (wallet.id === 'wallet-b') { clock += WALLET_READINESS_TTL_MS + 1; return { status: 'UNCONNECTED' }; } readsA++; return { status: 'CONNECTED', address: A, settings: { devMode: { enabled: true, expiresAt: clock + 3600000 } } }; },
  });
  assert.ok(report.ready.length === 0 || readsA > 1 && report.ready.every(wallet => clock - wallet.checkedAt < WALLET_READINESS_TTL_MS), 'expired proof must be excluded or genuinely refreshed');
});

function runtimeFixture({ monitorOnly = false, offline = ['wallet-b'], mismatch = [] } = {}) {
  const disconnected = new Set(offline), mismatched = new Set(mismatch), calls = []; let addressHook = null;
  const wallets = [{ id: 'wallet-a', name: 'Runtime A', address: A, agentId: 'runtime-a', agentIdVerified: true, mode: 'auto' }, { id: 'wallet-b', name: 'Runtime B', address: B, agentId: 'runtime-b', agentIdVerified: true, mode: 'auto' }];
  const h = isolatedWatch({ monitorOnly, wallets, cliFactory(profile) {
    const raw = async args => {
      const command = args.slice(0, 2).join(' '); calls.push({ walletId: profile.id, command });
      if (command === 'wallet status') return { success: true, data: { status: disconnected.has(profile.id) ? 'UNCONNECTED' : 'CONNECTED' } };
      if (command === 'wallet address') { await addressHook?.(profile.id); return { success: true, data: { addresses: [{ binanceChainId: '56', address: mismatched.has(profile.id) ? C : profile.address }] } }; }
      if (command === 'wallet settings') return { success: true, data: { devMode: { enabled: true, expiresAt: Date.now() + 48 * 3600000 } } };
      if (command === 'market-order list') return { success: true, data: { list: [{ orderId: 'existing-review-order', status: 'PENDING' }] } };
      if (command === 'contract-call preview') return { success: true, data: { requestId: 'review-preview', simulationResult: {} } };
      if (command === 'contract-call execute') return { success: true, data: { txHash: '0x' + 'ab'.repeat(32) } };
      throw Error('Unexpected runtime fixture command ' + command);
    };
    return async (args, _timeout, options) => {
      const j = args[0] === 'contract-call' && args[1] === 'execute' ? await runBoundWalletTransaction(args, profile, { beforeSend: options?.beforeSend, runRaw: raw }) : await raw(args);
      return { j, t: JSON.stringify(j) };
    };
  } });
  return { h, calls, disconnected, mismatched, hook: value => { addressHook = value; } };
}

test('runtime isolation prevents new work for an offline wallet while retaining read-only order recovery', async () => {
  const f = runtimeFixture(); await f.h.api.loginCheck(); const [a, b] = f.h.api.getWallets();
  assert.equal(f.h.api.canWallet(a, 'mint'), true); assert.equal(f.h.api.canWallet(b, 'mint'), false);
  assert.equal(f.h.api.getState().walletRuntime[b.id].availability.code, 'OFFLINE');
  const result = await b.baw(['contract-call', 'preview', '--to', C]); assert.equal(result.j.success, false);
  await b.baw(['contract-call', 'execute', '--requestId', 'never-execute']);
  assert.equal(f.calls.filter(call => call.walletId === b.id && ['contract-call preview', 'contract-call execute'].includes(call.command)).length, 0);
  assert.equal((await b.baw(['market-order', 'list', '--orderId', 'existing-review-order'])).j.success, true);
});

test('runtime reconnection never changes sell-only, pause, or per-operation configuration', async () => {
  const f = runtimeFixture(); await f.h.api.loginCheck(); const b = f.h.api.getWallets()[1]; f.disconnected.delete(b.id);
  f.h.config.wallets[1].mode = 'sell-only'; f.h.config.wallets[1].autoMint = false; f.h.config.wallets[1].autoSellNfts = false;
  await f.h.api.loginCheck();
  assert.equal(f.h.api.canWallet(b, 'mint'), false); assert.equal(f.h.api.canWallet(b, 'token-sell'), true); assert.equal(f.h.api.canWallet(b, 'nft-sell'), false);
  f.h.config.wallets[1].paused = true; const before = f.calls.length; await f.h.api.checkWatchWallet(b);
  assert.equal(f.calls.length, before); assert.equal(f.h.api.canWallet(b, 'token-sell'), false); assert.equal(f.h.config.wallets[1].paused, true);
});

test('runtime connected-address mismatch closes only its own wallet and never submits an operation', async () => {
  const f = runtimeFixture({ offline: [], mismatch: ['wallet-a'] }); await f.h.api.loginCheck(); const [a, b] = f.h.api.getWallets();
  assert.equal(f.h.api.canWallet(a, 'mint'), false); assert.equal(f.h.api.canWallet(b, 'mint'), true);
  assert.equal(f.h.api.getState().walletRuntime[a.id].availability.code, 'ADDRESS_MISMATCH');
  assert.equal((await a.baw(['contract-call', 'execute', '--requestId', 'wrong-session'])).j.success, false);
  assert.equal(f.calls.some(call => call.command === 'contract-call execute'), false);
});

test('a scanner started in monitor mode never creates a wallet adapter or probes session readiness', async () => {
  const f = runtimeFixture({ monitorOnly: true }); await f.h.api.loginCheck();
  for (const wallet of f.h.api.getWallets()) { await f.h.api.checkWatchWallet(wallet); await wallet.baw(['wallet', 'status']); assert.equal(f.h.api.canWallet(wallet, 'mint'), false); }
  assert.deepEqual(f.calls, []); assert.equal(f.h.seen.cliFactories.length, 0);
});

for (const [label, mutate] of [
  ['pause', config => { config.wallets[0].paused = true; }],
  ['monitor mode', config => { config.wallets[0].mode = 'monitor'; }],
  ['mint permission', config => { config.wallets[0].autoMint = false; }],
  ['global monitor mode', config => { config.monitorOnly = true; }],
]) test(`runtime async session checking cannot bypass a late ${label}`, async () => {
  const f = runtimeFixture({ offline: [] }); await f.h.api.loginCheck(); const a = f.h.api.getWallets()[0];
  let release, reached;
  const blocked = new Promise(resolve => { release = resolve; }), checking = new Promise(resolve => { reached = resolve; });
  f.hook(async id => { if (id === a.id) { reached(); await blocked; } });
  const sending = a.baw(['contract-call', 'execute', '--requestId', 'late-policy']); await checking; mutate(f.h.config); release();
  assert.equal((await sending).j.success, false); assert.equal(f.calls.some(call => call.command === 'contract-call execute'), false);
});

for (const [label, expire] of [
  ['developer permission', wallet => { wallet.readiness.expiresAt = Date.now() - 1; }],
  ['session proof', wallet => { wallet.readiness.checkedAt = Date.now() - 60001; }],
]) test(`the final bound-address await cannot send after its ${label} expires`, async () => {
  const f = runtimeFixture({ offline: [] }); await f.h.api.loginCheck(); const a = f.h.api.getWallets()[0];
  let release, reached, addresses = 0;
  const blocked = new Promise(resolve => { release = resolve; }), finalAddress = new Promise(resolve => { reached = resolve; });
  f.hook(async id => { if (id === a.id && ++addresses === 2) { reached(); await blocked; } });
  const sending = a.baw(['contract-call', 'execute', '--requestId', 'expires-during-address']); await finalAddress; expire(a); release();
  assert.equal((await sending).j.success, false); assert.equal(f.h.api.watchWalletReady(a), false);
  assert.equal(f.calls.some(call => call.command === 'contract-call execute'), false);
});

test('an offline runtime wallet retains its existing pending sell while performing only order-status recovery', async () => {
  const f = runtimeFixture(); await f.h.api.loginCheck(); const b = f.h.api.getWallets()[1], state = f.h.api.getState(), key = B + ':' + C;
  state.dyn ||= []; state.tokens ||= {}; state.dyn.push({ addr: C, only: B, sym: 'PENDING', cost: 1 });
  state.tokens[key] = { addr: C, walletAddress: B, hist: [], pendingSell: { orderId: 'existing-review-order', submittedAt: Date.now() } };
  await f.h.api.holdW(b, 1000000, false);
  assert.equal(state.tokens[key].pendingSell.orderId, 'existing-review-order'); assert.equal(state.tokens[key].sellStatus, 'pending');
  assert.equal(f.calls.filter(call => call.walletId === b.id && call.command === 'market-order list').length, 1);
  assert.equal(f.calls.some(call => call.command === 'contract-call execute'), false); assert.notEqual(f.h.config.wallets[1].paused, true);
});
