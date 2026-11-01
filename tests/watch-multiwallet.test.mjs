import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runBoundWalletTransaction } from '../lib/wallet-cli.mjs';
import { isolatedWatch, target } from './watch-scanner-fixture.mjs';

const addressA = '0x1111111111111111111111111111111111111111';
const addressB = '0x2222222222222222222222222222222222222222';
const addressC = '0x3333333333333333333333333333333333333333';
const profiles = () => [
  { id: 'wallet-a', name: '主要钱包', agentId: 'first.ai', agentIdVerified: true, address: addressA, mode: 'auto', paid: { maxBnbPerDay: 0.1 }, rules: { backX: 2 } },
  { id: 'wallet-b', name: '观察钱包', agentId: '', address: addressB, mode: 'monitor', paid: { maxBnbPerDay: 0.02 }, rules: { backX: 3 } },
  { id: 'wallet-c', name: '退出钱包', agentId: '', address: addressC, mode: 'sell-only' },
];
const flush = async () => { for (let index = 0; index < 25; index++) await Promise.resolve(); };

test('wallet policies and paid/sell rules are independent and pause closes the live gate', () => {
  const h = isolatedWatch({ monitorOnly: false, wallets: profiles() });
  const [a, b, c] = h.api.getWallets();
  assert.equal(h.api.canWallet(a, 'mint'), true);
  assert.equal(h.api.canWallet(b, 'mint'), false);
  assert.equal(h.api.canWallet(b, 'token-sell'), false);
  assert.equal(h.api.canWallet(c, 'mint'), false);
  assert.equal(h.api.canWallet(c, 'token-sell'), true);
  assert.equal(h.api.paidFor(a).maxBnbPerDay, 0.1);
  assert.equal(h.api.paidFor(b).maxBnbPerDay, 0.02);
  assert.equal(h.api.rulesFor(a).backX, 2);
  assert.equal(h.api.rulesFor(b).backX, 3);
  h.config.wallets[0].paused = true;
  assert.equal(h.api.canWallet(a, 'mint'), false);
  assert.equal(h.api.canWallet(c, 'token-sell'), true);
  h.config.monitorOnly = true;
  assert.equal(h.api.canWallet(c, 'token-sell'), false);
});

test('legacy names migrate once while reordering and renaming keep session, identity and cost ownership', async () => {
  const h = isolatedWatch({ monitorOnly: false, wallets: [{ name: 'old-a.ai', address: addressA }, { name: 'old-b.ai', address: addressB }], state: {
    paidSpend: { day: '2026-11-01', 'old-a.ai': 0.04, 'old-b.ai': 0.02 },
    paid: { [target]: { done: { 'old-a.ai': 'minted' }, qAt: { 'old-b.ai': 123 } } },
  } });
  const [a, b] = h.api.getWallets(), state = h.api.getState();
  assert.equal(state.paidSpend[a.id], 0.04);
  assert.equal(state.paidSpend[b.id], 0.02);
  assert.equal(state.paid[target].done[a.id], 'minted');
  assert.equal(state.paid[target].qAt[b.id], 123);
  const aSession = a.profile.bawDir, aInstance = a.profile.instanceId, agentId = a.agentId;
  h.config.wallets = [{ ...b.profile, name: 'changed-b' }, { ...a.profile, name: 'changed-a' }];
  const [reorderedB, reorderedA] = h.api.syncWalletProfiles();
  assert.equal(reorderedA, a); assert.equal(reorderedB, b);
  assert.equal(reorderedA.profile.bawDir, aSession);
  assert.equal(reorderedA.profile.instanceId, aInstance);
  assert.equal(reorderedA.agentId, agentId);
  assert.equal(reorderedA.name, 'changed-a');
  assert.equal(state.paidSpend[a.id], 0.04);
  assert.equal(h.api.tokenCostFor(a, { cost: 10 }), 10);
  assert.equal(h.api.tokenCostFor(b, { cost: 10 }), 0);
  await a.baw(['wallet', 'status']);
  assert.equal(h.seen.cliFactories.length, 2, 'renaming must not create a new session adapter');
  assert.equal(h.seen.cliFactories[0].profile.bawDir, aSession);
});

test('unbound Agent ID stays empty and replacing storage or removing a profile closes its gate', async () => {
  const h = isolatedWatch({ monitorOnly: false, wallets: profiles() });
  const [a, b] = h.api.getWallets();
  assert.equal(b.agentId, '', 'display names cannot become signing identities');
  h.config.wallets[0].bawDir = 'data/wallets/unrelated';
  assert.equal(h.api.canWallet(a, 'mint'), false);
  assert.equal((await a.baw(['contract-call', 'execute', '--requestId', 'preview'])).j.success, false);
  assert.equal(h.seen.cliCalls.length, 0);
  h.config.wallets = h.config.wallets.filter(wallet => wallet.id !== a.id);
  assert.equal(h.api.canWallet(a, 'token-sell'), false);
});

test('a paused wallet reconciles its existing sell but cannot create another sell', async () => {
  const calls = [];
  const h = isolatedWatch({ monitorOnly: false, wallets: [{ ...profiles()[0], paused: true }], cliFactory() {
    return async args => { calls.push(args); return { j: { success: true, data: { list: [{ orderId: 'existing-order', status: 'PENDING' }] } } }; };
  } });
  const [wallet] = h.api.getWallets();
  const st = { pendingSell: { orderId: 'existing-order', submittedAt: Date.now() }, hist: [] };
  await h.api.sell({ addr: target }, st, 0n, '', wallet);
  assert.equal(calls.length, 1); assert.deepEqual(Array.from(calls[0]).slice(0, 2), ['market-order', 'list']);
  assert.equal(st.sellStatus, 'pending'); assert.ok(st.pendingSell.checkedAt);
  assert.equal(await h.api.sell({ addr: target }, {}, 1n, 'new sell', wallet), false);
  assert.equal(calls.length, 1);
});

test('a slow wallet keeps one job while another wallet enters its next holdings round', async () => {
  const h = isolatedWatch({ monitorOnly: false, wallets: profiles().slice(0, 2) });
  const calls = new Map(); let release;
  const waiting = new Promise(resolve => { release = resolve; });
  h.api.setHoldingsWorker(async wallet => { calls.set(wallet.id, (calls.get(wallet.id) || 0) + 1); if (wallet.id === 'wallet-a') await waiting; });
  const first = h.api.holdings(100); await flush();
  h.timers.find(timer => timer.ms === 1000).callback();
  assert.equal((await first).pending, true);
  assert.equal(calls.get('wallet-a'), 1); assert.equal(calls.get('wallet-b'), 1);
  const second = h.api.holdings(101); await flush();
  h.timers.filter(timer => timer.ms === 1000).at(-1).callback();
  assert.equal((await second).pending, true);
  assert.equal(calls.get('wallet-a'), 1, 'slow wallet must never overlap itself');
  assert.equal(calls.get('wallet-b'), 2, 'completed peer must keep refreshing');
  release(); await flush();
  assert.equal(h.api.getState().walletRuntime['wallet-a'].checking, false);
});

for (const [label, change] of [
  ['wallet paused', h => { h.config.wallets[0].paused = true; }],
  ['wallet strategy changed', h => { h.config.wallets[0].rules.backX = 4; }],
  ['wallet budget changed', h => { h.config.wallets[0].paid.maxBnbPerDay = 0; }],
  ['Agent ID verification revoked', h => { h.config.wallets[0].agentIdVerified = false; }],
  ['Agent ID binding changed', h => { h.config.wallets[0].agentId = 'different.ai'; }],
  ['global monitor gate enabled', h => { h.config.monitorOnly = true; }],
  ['scanner stopped', h => { h.setFile('WATCH_STOP', ''); }],
]) test(`address-preflight await cannot bypass a late ${label}`, async () => {
  let release, addresses = 0, executes = 0;
  const waiting = new Promise(resolve => { release = resolve; });
  const h = isolatedWatch({ monitorOnly: false, wallets: profiles(), cliFactory(profile) {
    return async (args, _timeout, options) => {
      const j = await runBoundWalletTransaction(args, profile, { beforeSend: options?.beforeSend, runRaw: async command => {
        if (command[0] === 'wallet' && command[1] === 'address') { addresses++; await waiting; return { success: true, data: { addresses: [{ binanceChainId: '56', address: profile.address }] } }; }
        executes++; return { success: true, data: { txHash: '0x' + 'ab'.repeat(32) } };
      } });
      return { j, t: JSON.stringify(j) };
    };
  } });
  const [wallet] = h.api.getWallets(), sent = wallet.baw(['contract-call', 'execute', '--requestId', 'reviewed-preview']);
  await flush(); assert.equal(addresses, 1); assert.equal(executes, 0);
  change(h); release();
  const result = await sent;
  assert.equal(result.j.success, false); assert.equal(result.j.error.name, 'CONFIG_ERROR');
  assert.equal(executes, 0, 'the write must never be issued after a policy change during address lookup');
});

test('pausing a different wallet during address preflight does not cancel this wallet command', async () => {
  let release, executes = 0;
  const waiting = new Promise(resolve => { release = resolve; });
  const h = isolatedWatch({ monitorOnly: false, wallets: profiles(), cliFactory(profile) {
    return async (args, _timeout, options) => {
      const j = await runBoundWalletTransaction(args, profile, { beforeSend: options?.beforeSend, runRaw: async command => {
        if (command[0] === 'wallet') { await waiting; return { success: true, data: { addresses: [{ binanceChainId: '56', address: profile.address }] } }; }
        executes++; return { success: true, data: {} };
      } }); return { j, t: JSON.stringify(j) };
    };
  } });
  const sent = h.api.getWallets()[0].baw(['contract-call', 'execute', '--requestId', 'reviewed-preview']);
  await flush(); h.config.wallets[1].paused = true; release();
  assert.equal((await sent).j.success, true); assert.equal(executes, 1);
});


test('a legacy display alias never becomes a contract Agent ID until officially verified and rebuilt', () => {
  const h = isolatedWatch({ monitorOnly: false, wallets: [{ name: 'looks-like-a-handle.ai', address: addressA }], state: { paid: { [target]: { done: { 'looks-like-a-handle.ai': 'minted' } } } } });
  const [legacy] = h.api.getWallets();
  assert.equal(legacy.agentId, '');
  assert.equal(legacy.legacyName, 'looks-like-a-handle.ai');
  assert.equal(h.api.getState().paid[target].done[legacy.id], 'minted', 'identity hardening must preserve the legacy mint deduplication record');
  h.config.wallets[0].agentIdVerified = true;
  assert.equal(h.api.canWallet(legacy, 'mint'), false, 'verification changes require rebuilding the pinned profile');
  assert.equal(legacy.agentId, '', 'an existing worker must not silently replace its contract identity');
  const rebuilt = isolatedWatch({ monitorOnly: false, wallets: [{ ...legacy.profile, agentId: 'official.ai', agentIdVerified: true }] }).api.getWallets()[0];
  assert.match(rebuilt.agentId, /^[0-9a-f]{64}$/);
});


test('frozen legacy aliases preserve mint deduplication and daily spending across rename then official handle correction', () => {
  const token = { sym: 'TEST', addr: target, cost: 10 };
  const previous = { id: 'stable-wallet', name: 'new-display', agentId: 'official.ai', agentIdVerified: true, legacyNames: ['original-display'], address: addressA, mode: 'auto' };
  const oldPosition = { hist: [], done2: ['back'], walletAddress: addressA, addr: target, lastBal: '100', pendingSell: { orderId: 'old-pending' } };
  const h = isolatedWatch({ monitorOnly: false, wallets: [previous], tokens: [token], state: {
    paidSpend: { day: '2026-11-01', 'original-display': 0.04 },
    paid: { [target]: { done: { 'original-display': 'minted' } } },
    tokens: { 'original-display:TEST': oldPosition },
  } });
  const [w] = h.api.getWallets(), state = h.api.getState();
  assert.equal(state.paidSpend[w.id], 0.04);
  assert.equal(state.paid[target].done[w.id], 'minted');
  const migrated = h.api.positionFor(w, token);
  assert.equal(migrated.pendingSell.orderId, 'old-pending'); assert.equal(migrated.done2[0], 'back');
  assert.equal(state.tokens['original-display:TEST'], undefined);
});

test('new wallets with explicit empty aliases cannot claim another wallet old same-name budget, mint or position records', () => {
  const token = { sym: 'TEST', addr: target, cost: 10 }, oldPosition = { hist: [], done2: ['back'], walletAddress: addressA, addr: target, lastBal: '100' };
  const h = isolatedWatch({ monitorOnly: false, wallets: [{ id: 'new-profile', name: 'reused-name', agentId: 'reused-name', agentIdVerified: true, legacyNames: [], address: addressA, mode: 'auto' }], tokens: [token], state: {
    paidSpend: { day: '2026-11-01', 'reused-name': 0.05 },
    paid: { [target]: { done: { 'reused-name': 'minted' } } },
    tokens: { TEST: oldPosition, 'reused-name:TEST': oldPosition },
  } });
  const [w] = h.api.getWallets(), state = h.api.getState();
  assert.equal(state.paidSpend[w.id], undefined); assert.equal(state.paid[target].done[w.id], undefined);
  const fresh = h.api.positionFor(w, token);
  assert.equal(fresh.pendingSell, undefined); assert.equal(fresh.done2.length, 0);
  assert.equal(state.tokens.TEST.done2[0], 'back'); assert.equal(state.tokens['reused-name:TEST'].done2[0], 'back');
});

test('conflicting legacy position versions are preserved and block automation instead of guessing', () => {
  const token = { sym: 'TEST', addr: target, cost: 10 };
  const h = isolatedWatch({ monitorOnly: false, wallets: [{ ...profiles()[0], legacyNames: ['old-one', 'old-two'] }], tokens: [token], state: { tokens: {
    'old-one:TEST': { hist: [], done2: ['back'], walletAddress: addressA, addr: target },
    'old-two:TEST': { hist: [], done2: [], pendingSell: { orderId: 'unresolved' }, walletAddress: addressA, addr: target },
  } } });
  const st = h.api.positionFor(h.api.getWallets()[0], token);
  assert.equal(st.sellReviewRequired, true); assert.equal(st.eligibility, 'blocked');
  assert.match(st.reason, /冲突/);
  assert.ok(h.api.getState().tokens['old-one:TEST']); assert.ok(h.api.getState().tokens['old-two:TEST']);
});

test('legacy alias lookup still refuses a position explicitly bound to another wallet or contract', () => {
  for (const identity of [{ walletAddress: addressB, addr: target }, { walletAddress: addressA, addr: addressC }]) {
    const token = { sym: 'TEST', addr: target, cost: 10 };
    const h = isolatedWatch({ monitorOnly: false, wallets: [{ ...profiles()[0], legacyNames: ['old-name'] }], tokens: [token], state: { tokens: { 'old-name:TEST': { ...identity, hist: [], done2: ['back'] } } } });
    const st = h.api.positionFor(h.api.getWallets()[0], token);
    assert.equal(st.done2.length, 0); assert.ok(h.api.getState().tokens['old-name:TEST']);
  }
});


test('legacy aliases and token symbols never treat inherited object properties as historical wallet records', () => {
  const token = { sym: '__proto__', addr: target, cost: 10 };
  const h = isolatedWatch({ monitorOnly: false, wallets: [{ ...profiles()[0], legacyNames: ['constructor'] }], tokens: [token], state: { paid: { [target]: { done: {} } }, tokens: {} } });
  const [w] = h.api.getWallets();
  assert.equal(h.api.getState().paid[target].done[w.id], undefined);
  const st = h.api.positionFor(w, token);
  assert.equal(st.done2.length, 0);
  assert.equal(Object.getPrototypeOf(h.api.getState().tokens).walletId, undefined);
});
