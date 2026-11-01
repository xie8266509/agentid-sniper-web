import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';
import { DEFAULT_CONFIG, readConfig, saveConfig, validateConfig, sanitizeConfig } from '../lib/config.mjs';
import { buildStrategyStatus } from '../lib/strategy-status.mjs';

const A = '0x' + '1'.repeat(40), B = '0x' + '2'.repeat(40), C = '0x' + '3'.repeat(40), TARGET = '0x' + '4'.repeat(40), HASH = '0x' + 'a'.repeat(64);
async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'agentid-wallet-api-')), path = join(root, 'config.json');
  writeFileSync(path, JSON.stringify(validateConfig({ ...structuredClone(DEFAULT_CONFIG), monitorOnly: false, paid: { ...DEFAULT_CONFIG.paid, maxBnbPerDay: 1 }, portfolioBudget: { maxBnbPerDay: 0.5 }, wallets: [{ id: 'wallet-a', name: 'A', agentId: 'a', address: A, mode: 'auto' }, { id: 'wallet-b', name: 'B', agentId: 'b', address: B, mode: 'auto', paused: true }] })));
  const identities = new Map([['wallet-a', A], ['wallet-b', B]]), disconnected = new Set(), calls = [], controls = [];
  let receipt = null, transaction = null, executeResult = { orderId: 'test-order', status: 'BROADCASTED', txHash: HASH };
  const server = createApp({ root, readConfig: () => readConfig({ path }), saveConfig: (input, options) => saveConfig(input, { ...options, path }), sanitizeConfig,
    getCliInfo: () => ({ ready: true, version: 'test' }), dashboardStatus: async () => ({ service: { running: true }, mode: 'auto' }), controlService: async action => { controls.push(action); return { running: action !== 'stop' }; },
    readLogs: () => ({ lines: [] }), holdingsData: async () => ({ tokens: [], nfts: [], trades: [] }),
    nftTrading: { view: async () => ({ rules: [], states: {}, settings: {}, capabilities: {} }), hasInFlight: () => false, stop() {} },
    rpc: async method => method === 'eth_chainId' ? '0x38' : method === 'eth_getTransactionReceipt' ? receipt : transaction,
    runWallet: async (args, options) => {
      calls.push({ args, options });
      const id = options.walletId || readConfig({ path }).wallets[options.walletIndex || 0]?.id, address = identities.get(id), command = args.slice(0, 2).join(' ');
      if (command === 'wallet status') return { success: true, data: { status: disconnected.has(id) ? 'UNCONNECTED' : 'CONNECTED' } };
      if (command === 'wallet address') return { success: true, data: { addresses: [{ binanceChainId: '56', address }] } };
      if (command === 'wallet settings') return { success: true, data: { devMode: { enabled: true, expiresAt: Date.now() + 3600000 } } };
      if (command === 'wallet agent-id') return { success: true, data: { claimed: true, handle: 'claimedname', agentId: 'claimedname.ai' } };
      if (command === 'wallet tx-lock') return { success: true, data: { status: 'UNLOCKED' } };
      if (command === 'auth signin') { disconnected.delete(id); return { success: true, data: { status: 'ALREADY_CONNECTED' } }; }
      if (command === 'auth signout') { disconnected.add(id); return { success: true, data: { status: 'LOGGED_OUT' } }; }
      if (command === 'contract-call preview') return { success: true, data: { requestId: 'test-preview', parsedTx: { from: address, to: TARGET }, simulationResult: { authorityChanges: [] }, risks: {} } };
      if (command === 'contract-call execute') return { success: true, data: executeResult };
      throw new Error('Unexpected test command: ' + command);
    },
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); rmSync(root, { recursive: true, force: true }); });
  const base = 'http://127.0.0.1:' + server.address().port, b = await fetch(base + '/api/bootstrap'), cookie = b.headers.get('set-cookie').split(';')[0], csrf = (await b.json()).data.csrfToken;
  async function request(url, body) {
    const r = await fetch(base + url, { method: body === undefined ? 'GET' : 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: r.status, ...await r.json() };
  }
  return { root, request, calls, controls, disconnected, config: () => readConfig({ path }), bind: (id, address) => identities.set(id, address), setProof: (tx, r) => { transaction = tx; receipt = r; }, setExecuteResult: value => { executeResult = value; } };
}

test('new wallet is independently paired and bound without enabling automatic execution or forcing pause', async t => {
  const f = await fixture(t), created = await f.request('/api/wallets', { name: '第三个钱包' });
  assert.equal(created.status, 200);
  const wallet = created.data.wallet;
  assert.equal(wallet.draft, true); assert.equal(wallet.paused, false); assert.equal(wallet.mode, 'monitor'); assert.equal(wallet.address, '');
  assert.equal((await f.request('/api/wallets/' + wallet.id + '/settings', { patch: { mode: 'auto', paused: false }, confirmed: true })).status, 409);
  f.bind(wallet.id, C);
  assert.equal((await f.request('/api/wallet/login', { walletId: wallet.id })).data.walletId, wallet.id);
  const imported = await f.request('/api/wallet/import', { walletId: wallet.id });
  assert.equal(imported.status, 200);
  const bound = imported.data.config.wallets.find(w => w.id === wallet.id);
  assert.equal(bound.address, C); assert.equal(bound.agentId, 'claimedname'); assert.equal(bound.agentIdVerified, true); assert.equal(bound.mode, 'monitor'); assert.equal(bound.paused, false); assert.equal(bound.draft, false);
  assert.equal(f.config().wallets.find(w => w.id === wallet.id).paused, false);
  assert.equal((await f.request('/api/wallets/' + wallet.id + '/settings', { patch: { address: A } })).status, 400);
  assert.equal((await f.request('/api/wallets/' + wallet.id + '/settings', { patch: { mode: 'auto', paused: false } })).status, 409);
  assert.equal((await f.request('/api/wallets/' + wallet.id + '/settings', { patch: { mode: 'sell-only', paused: false }, confirmed: true })).status, 200);
  assert.equal(f.calls.some(call => call.args[0] === 'contract-call'), false);
});

test('a pause explicitly chosen before first binding survives import and later verification', async t => {
  const f = await fixture(t), created = await f.request('/api/wallets', { name: '手动暂停的钱包' }), { id } = created.data.wallet;
  assert.equal((await f.request('/api/wallets/' + id + '/settings', { patch: { paused: true } })).status, 200);
  f.bind(id, C);
  for (let i = 0; i < 2; i++) {
    const imported = await f.request('/api/wallet/import', { walletId: id });
    assert.equal(imported.status, 200);
    const wallet = imported.data.config.wallets.find(wallet => wallet.id === id);
    assert.equal(wallet.paused, true); assert.equal(wallet.mode, 'monitor'); assert.equal(wallet.draft, false);
  }
  assert.equal(f.config().wallets.find(wallet => wallet.id === id).paused, true);
  assert.equal(f.calls.some(call => call.args[0] === 'contract-call'), false);
});

test('saving an unchecked pause persists false with wallet budgets and rules after reload and binding', async t => {
  const f = await fixture(t), created = await f.request('/api/wallets', { name: '保留设置的钱包' }), { id } = created.data.wallet;
  const siblings = structuredClone(f.config().wallets.filter(wallet => wallet.id !== id));
  assert.equal((await f.request('/api/wallets/' + id + '/settings', { patch: { paused: true, paid: { maxUsd: 7, maxBnbPerDay: 0.02 }, rules: { backX: 3 } } })).status, 200);
  const saved = await f.request('/api/wallets/' + id + '/settings', { patch: { paused: false } });
  assert.equal(saved.status, 200); assert.equal(saved.data.wallet.paused, false);
  const assertSaved = wallet => {
    assert.equal(wallet.paused, false); assert.equal(wallet.mode, 'monitor');
    assert.equal(wallet.paid.maxUsd, 7); assert.equal(wallet.paid.maxBnbPerDay, 0.02); assert.equal(wallet.rules.backX, 3);
  };
  assertSaved(f.config().wallets.find(wallet => wallet.id === id));
  assertSaved((await f.request('/api/config')).data.config.wallets.find(wallet => wallet.id === id));
  assertSaved((await f.request('/api/wallets')).data.wallets.find(wallet => wallet.id === id));
  f.bind(id, C);
  const imported = await f.request('/api/wallet/import', { walletId: id }); assert.equal(imported.status, 200);
  assertSaved(imported.data.config.wallets.find(wallet => wallet.id === id));
  assertSaved(f.config().wallets.find(wallet => wallet.id === id));
  assert.deepEqual(f.config().wallets.filter(wallet => wallet.id !== id), siblings);
  assert.equal(f.calls.some(call => call.args[0] === 'contract-call'), false);
});

test('unpaused monitor wallets still require explicit automatic authorization and valid connection', async t => {
  const f = await fixture(t), created = await f.request('/api/wallets', { name: '监控钱包' }), { id } = created.data.wallet;
  f.bind(id, C); assert.equal((await f.request('/api/wallet/import', { walletId: id })).status, 200);
  assert.equal((await f.request('/api/wallets/' + id + '/settings', { patch: { mode: 'auto' } })).status, 409);
  f.disconnected.add(id);
  assert.equal((await f.request('/api/wallets/' + id + '/settings', { patch: { mode: 'auto' }, confirmed: true })).status, 409);
  const current = f.config().wallets.find(wallet => wallet.id === id);
  assert.equal(current.paused, false); assert.equal(current.mode, 'monitor');
  assert.equal(f.calls.some(call => call.args[0] === 'contract-call'), false);
});

test('logging out one wallet pauses itself and leaves other wallets and scanner running', async t => {
  const f = await fixture(t);
  const logout = await f.request('/api/wallet/logout', { walletId: 'wallet-a', confirmed: true });
  assert.equal(logout.status, 200); assert.equal(f.config().wallets[0].paused, true);
  assert.equal(f.config().wallets[1].paused, true); assert.equal(f.disconnected.has('wallet-b'), false);
  assert.equal((await f.request('/api/wallet/status?walletId=wallet-b&refresh=1')).data.status, 'CONNECTED');
  assert.deepEqual(f.controls, []);
});

test('an already-connected session for another BSC address is signed out instead of accepted', async t => {
  const f = await fixture(t); f.bind('wallet-a', B);
  const login = await f.request('/api/wallet/login', { walletId: 'wallet-a' });
  assert.equal(login.status, 409); assert.equal(f.disconnected.has('wallet-a'), true);
  assert.equal(f.config().wallets[0].address, A);
  assert.equal(f.calls.some(c => c.args[0] === 'contract-call'), false);
});

test('paused disconnected wallets do not prevent automatic scanner preflight for active wallets', async t => {
  const f = await fixture(t); f.disconnected.add('wallet-b');
  assert.equal((await f.request('/api/service/start', { confirmAutoTrading: true })).status, 200);
  assert.equal(f.calls.filter(c => c.args[0] === 'wallet' && c.args[1] === 'status').some(c => c.options.walletId === 'wallet-b'), false);
});

test('previews bind the immutable wallet and settings revision instead of the current selection', async t => {
  const f = await fixture(t), p = await f.request('/api/contract/preview', { walletId: 'wallet-a', to: TARGET, inputData: '0x1234', value: '0' });
  assert.equal(p.status, 200); assert.deepEqual(p.data.wallet, { id: 'wallet-a', name: 'A', address: A, chainId: 56 });
  assert.equal((await f.request('/api/contract/execute', { id: p.data.id, walletId: 'wallet-b', confirmed: true })).status, 409);
  assert.equal((await f.request('/api/wallets/wallet-a/settings', { patch: { name: '改名后的 A' } })).status, 200);
  assert.equal((await f.request('/api/contract/execute', { id: p.data.id, walletId: 'wallet-a', confirmed: true })).status, 409);
  assert.equal(f.calls.some(c => c.args[0] === 'contract-call' && c.args[1] === 'execute'), false);
});

test('editing another wallet does not invalidate a prepared manual preview', async t => {
  const f = await fixture(t), p = await f.request('/api/contract/preview', { walletId: 'wallet-a', to: TARGET, value: '0' });
  assert.equal((await f.request('/api/wallets/wallet-b/settings', { patch: { name: 'B 独立改名' } })).status, 200);
  assert.equal((await f.request('/api/contract/execute', { id: p.data.id, walletId: 'wallet-a', confirmed: true })).status, 200);
  assert.equal(f.calls.filter(c => c.args[0] === 'contract-call' && c.args[1] === 'execute').length, 1);
});

test('a broadcast keeps its reservation and blocks only its wallet until matching onchain evidence', async t => {
  const f = await fixture(t), p = await f.request('/api/contract/preview', { walletId: 'wallet-a', to: TARGET, inputData: '0x1234', value: '0.01' });
  const result = await f.request('/api/contract/execute', { id: p.data.id, walletId: 'wallet-a', confirmed: true });
  assert.equal(result.status, 200);
  let wallets = (await f.request('/api/wallets')).data.wallets;
  assert.equal(wallets[0].runtime.blocked, true); assert.equal(wallets[1].runtime.blocked, false);
  assert.equal((await f.request('/api/wallets/wallet-a/settings', { patch: { archived: true } })).status, 409);
  assert.equal((await f.request('/api/wallets/wallet-b/settings', { patch: { archived: true } })).status, 200);
  assert.equal(wallets[0].budget.reservedBnb, '0.01'); assert.equal(wallets[0].budget.spentBnb, '0');
  assert.equal((await f.request('/api/wallets/wallet-a/reconcile', {})).data.resolved, false);
  const proof = { hash: HASH, blockHash: '0x' + 'b'.repeat(64), blockNumber: '0x100', from: B, to: TARGET, input: '0x1234', value: '0x2386f26fc10000' }, receipt = { transactionHash: HASH, blockHash: proof.blockHash, blockNumber: proof.blockNumber, status: '0x1' };
  f.setProof(proof, receipt);
  assert.equal((await f.request('/api/wallets/wallet-a/reconcile', {})).status, 409);
  f.setProof({ ...proof, from: A }, receipt);
  assert.equal((await f.request('/api/wallets/wallet-a/reconcile', {})).data.resolved, true);
  wallets = (await f.request('/api/wallets')).data.wallets;
  assert.equal(wallets[0].runtime.blocked, false); assert.equal(wallets[0].budget.reservedBnb, '0'); assert.equal(wallets[0].budget.spentBnb, '0.01');
});

test('an unknown submission cannot be unlocked with an unrelated historical transaction hash', async t => {
  const f = await fixture(t); f.setExecuteResult({ orderId: 'unknown-order', status: 'PENDING_CONFIRMATION' });
  const p = await f.request('/api/contract/preview', { walletId: 'wallet-a', to: TARGET, inputData: '0x1234', value: '0.01' });
  assert.equal((await f.request('/api/contract/execute', { id: p.data.id, confirmed: true })).status, 200);
  f.setProof({ hash: HASH, from: A, to: TARGET, value: '0x2386f26fc10000', input: '0x1234' }, { transactionHash: HASH, status: '0x1' });
  const result = await f.request('/api/wallets/wallet-a/reconcile', { txHash: HASH });
  assert.equal(result.data.resolved, false);
  assert.equal((await f.request('/api/wallets')).data.wallets[0].runtime.blocked, true);
});

test('bulk pause does not discard wallet records or overwrite another wallet strategy', async t => {
  const f = await fixture(t);
  const stale = structuredClone(f.config());
  assert.equal((await f.request('/api/wallets/wallet-b/settings', { patch: { rules: { backX: 3 } } })).status, 200);
  assert.equal((await f.request('/api/wallets/pause', {})).status, 200);
  assert.equal(f.config().wallets.every(w => w.paused), true); assert.equal(f.config().wallets[1].rules.backX, 3);
  assert.equal((await f.request('/api/config', { config: { ...stale, timeZone: 'UTC' }, confirmAutoTrading: true })).status, 409);
  assert.equal(f.config().wallets.every(w => w.paused), true);
  assert.equal((await f.request('/api/config', { config: { wallets: [f.config().wallets[1]] }, confirmAutoTrading: true })).status, 409);
});

test('each wallet status reports its own configured and effective selling rules', () => {
  const config = validateConfig({ ...structuredClone(DEFAULT_CONFIG), monitorOnly: false, wallets: [{ id: 'a', name: 'A', address: A, mode: 'auto', rules: { backX: 3 } }, { id: 'b', name: 'B', address: B, mode: 'sell-only', rules: { backX: 4 } }] });
  const result = buildStrategyStatus({ runtimeMode: 'auto', effectiveWalletRules: { a: { ...DEFAULT_CONFIG.rules, backX: 3 }, b: { ...DEFAULT_CONFIG.rules, backX: 4 } } }, config, [], { running: true });
  assert.deepEqual(result.wallets.map(w => [w.walletId, w.configuredRules.backX, w.effectiveRules.backX]), [['a', 3, 3], ['b', 4, 4]]);
});
