import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildStrategyStatus, positionState } from '../lib/strategy-status.mjs';
import { DEFAULT_RULES, getRuleConfig } from '../lib/config.mjs';
import { normalizeWalletConfig } from '../lib/wallet-model.mjs';
import { isolatedWatch } from './watch-scanner-fixture.mjs';
const A = '0x' + 'a'.repeat(40), B = '0x' + 'b'.repeat(40), C = '0x' + 'c'.repeat(40);
const wallet = { address: A, name: 'primary' }, token = { addr: B, sym: 'SAME', cost: 0 };

test('canonical position state wins and ambiguous symbols are not mixed', () => {
  const state = { tokens: { SAME: { lastBal: '111' }, [`${A}:${B}`]: { lastBal: '222' } } };
  assert.equal(positionState(state, token, wallet, 0, [token]).lastBal, '222');
  assert.deepEqual(positionState({ tokens: { SAME: { lastBal: '111' } } }, token, wallet, 0, [token, { ...token, addr: C }]), {});
});
test('renamed legacy wallets retain their positions and a new namesake cannot claim them', () => {
  const state = { tokens: { 'old-name:SAME': { lastBal: '222' } } };
  assert.equal(positionState(state, token, { ...wallet, name: 'new-name', legacyNames: ['old-name'] }, 1, [token]).lastBal, '222');
  assert.deepEqual(positionState(state, token, { ...wallet, name: 'old-name', legacyNames: [] }, 1, [token]), {});
});
test('unknown effective rules stay unknown and stopped mode never promises execution', () => {
  const result = buildStrategyStatus({}, { rules: { drop: 0.4 }, monitorOnly: false }, [{ token, wallet, st: { last: { v: 2 } } }]);
  assert.equal(result.effectiveRules, null);
  assert.equal(result.configuredRules.drop, 0.4);
  assert.equal(result.tokens[0].eligible, false);
  assert.match(result.tokens[0].reason, /已停止/);
  assert.equal(result.scope.nft, false);
});
test('free token below minimum explains why no sell occurred', () => {
  const result = buildStrategyStatus({ runtimeMode: 'auto', effectiveRules: DEFAULT_RULES }, { monitorOnly: false }, [{ token, wallet, st: { last: { v: 0.013 }, openAt: 1 } }], { running: true, now: 1000000 });
  assert.match(result.tokens[0].reason, /低于.*0.30/);
  assert.match(result.tokens[0].nextTrigger, /50%/);
  assert.equal(result.tokens[0].eligible, false);
});
test('monitor mode and pending orders override sell eligibility', () => {
  const p = [{ token, wallet, st: { eligibility: 'ready', pendingSell: { orderId: '123' } } }];
  const result = buildStrategyStatus({ runtimeMode: 'auto' }, {}, p, { running: true });
  assert.match(result.tokens[0].reason, /等待成交/); assert.equal(result.tokens[0].eligible, false);
  assert.match(buildStrategyStatus({ runtimeMode: 'monitor' }, {}, p, { running: true }).tokens[0].reason, /只读/);
});

test('uncertain submissions and partial-fill review stay blocked in the UI', () => {
  for (const st of [{ submissionIntent: { createdAt: 1 } }, { sellReviewRequired: true, reason: '部分成交，需人工核对' }]) {
    const result = buildStrategyStatus({ runtimeMode: 'auto', effectiveRules: DEFAULT_RULES }, {}, [{ token, wallet, st: { ...st, eligibility: 'ready', last: { v: 1 } } }], { running: true });
    assert.equal(result.tokens[0].eligible, false);
    assert.match(result.tokens[0].reason, /核对/);
    assert.match(result.tokens[0].nextTrigger, /核对/);
  }
});

test('step rules show remaining percentages, post-recovery drawdown and moon boundaries', () => {
  const paid = { ...token, cost: 10 };
  const result = buildStrategyStatus({ runtimeMode: 'auto', effectiveRules: DEFAULT_RULES }, {}, [{ token: paid, wallet, st: { done2: ['back', 's10'], moon: '100', openAt: 1, last: { v: 100 } } }], { running: true, now: 1000000 });
  assert.match(result.tokens[0].nextTrigger, /20 倍卖可卖仓位 50%/);
  assert.doesNotMatch(result.tokens[0].nextTrigger, /10 倍卖|分钟未达/);
  assert.match(result.tokens[0].nextTrigger, /60%.*连续两次.*长抱以外/);
  const moon = buildStrategyStatus({ runtimeMode: 'auto', effectiveRules: DEFAULT_RULES }, {}, [{ token: paid, wallet, st: { moonOnly: true, done2: ['back'], moon: '100' } }], { running: true });
  assert.equal(moon.tokens[0].eligible, false); assert.match(moon.tokens[0].reason, /长抱.*不自动卖/); assert.match(moon.tokens[0].nextTrigger, /50 \/ 100.*仅通知/);
});

test('status preserves old rules instead of displaying new defaults over legacy settings', () => {
  const rules = { halfX: [5, 10], backX: 3, crash: 0.6, fastCrash: 0.35, fastMin: 30, noPumpMin: 20, noPumpX: 2 };
  const result = buildStrategyStatus({ runtimeMode: 'auto', effectiveRules: rules }, { rules }, [{ token: { ...token, cost: 10 }, wallet, st: { done2: [], openAt: 900000 } }], { running: true, now: 1000000 });
  assert.equal(result.configuredRules.strategy, 'legacy'); assert.equal(result.configuredRules.backX, 3); assert.equal(result.configuredRules.moonPct, 0);
  assert.match(result.tokens[0].nextTrigger, /35%/); assert.match(result.tokens[0].nextTrigger, /20 分钟未达 2 倍/);
});

function reportedFixture() {
  const now = 1800000000000, startedAt = now - 100000, pid = 4242;
  const config = normalizeWalletConfig({ monitorOnly: false, rules: DEFAULT_RULES, wallets: [{ id: 'wallet-a', name: 'A', address: A, mode: 'auto' }] }), wallet = config.wallets[0];
  const rules = getRuleConfig(config), state = { runtimeMode: 'auto', configLoadedAt: startedAt, effectiveRules: rules, strategyRuntime: { runId: 'worker-a', pid, startedAt },
    effectiveWalletRules: { [wallet.id]: { ...rules, backX: 6 } },
    walletRuleReports: { [wallet.id]: { walletId: wallet.id, walletAddress: A, runId: 'worker-a', runStartedAt: startedAt, checkedAt: startedAt + 1, trackedERC20: 0,
      binding: [wallet.bawDir, wallet.instanceId, wallet.agentId, wallet.agentIdVerified, wallet.legacyNames], rules } },
    walletRuntime: { [wallet.id]: { availability: { walletId: wallet.id, address: A, ready: true, code: 'READY', checkedAt: now, expiresAt: now + 3600000 } } },
  };
  return { now, pid, config, state, row: (options = {}) => buildStrategyStatus(state, config, [], { running: true, workerPid: pid, now, ...options }).wallets[0] };
}

test('a real wallet worker reports distinct rules with zero ERC20 and replaces snapshots from previous runs', async () => {
  const h = isolatedWatch({ monitorOnly: false, wallets: [{ id: 'wallet-a', name: 'A', address: A, mode: 'auto', rules: { backX: 3 } }, { id: 'wallet-b', name: 'B', address: C, mode: 'auto', rules: { backX: 4 } }],
    state: { configLoadedAt: 1, strategyRuntime: { runId: 'old', pid: 1, startedAt: 1 }, effectiveWalletRules: { 'wallet-a': { backX: 9 } }, walletRuleReports: { 'wallet-a': { rules: { backX: 9 } } } },
  });
  const state = h.api.getState(); assert.equal(Object.keys(state.walletRuleReports).length, 0); assert.equal(Object.keys(state.effectiveWalletRules).length, 0);
  for (const W of h.api.getWallets()) await h.api.holdW(W, 100, false);
  for (const [index, W] of h.api.getWallets().entries()) {
    const report = state.walletRuleReports[W.id];
    assert.equal(report.runId, state.strategyRuntime.runId); assert.equal(report.runStartedAt, state.configLoadedAt); assert.equal(report.walletAddress, W.addr);
    assert.equal(report.trackedERC20, 0); assert.equal(report.rules.backX, index + 3); assert.ok(report.checkedAt >= state.configLoadedAt);
    state.walletRuntime[W.id] = { availability: { walletId: W.id, address: W.addr, ready: true, code: 'READY', checkedAt: Date.now(), expiresAt: Date.now() + 3600000 } };
  }
  const status = buildStrategyStatus(state, h.config, [], { running: true, workerPid: 4242 });
  assert.deepEqual(status.wallets.map(row => [row.effectiveRules.backX, row.reportStatus, row.trackedERC20]), [[3, 'no-erc20', 0], [4, 'no-erc20', 0]]);
  assert.match(status.wallets[0].reason, /暂无追踪 ERC20.*NFT/);
  assert.equal(JSON.parse(h.file('data/watch_state.json')).walletRuleReports['wallet-b'].rules.backX, 4);
  h.config.wallets[0].rules.backX = 4; await h.api.holdW(h.api.getWallets()[0], 101, false);
  assert.equal(buildStrategyStatus(state, h.config, [], { running: true, workerPid: 4242, needsRestart: true }).wallets[0].effectiveRules.backX, 4);
  assert.equal(h.seen.cliCalls.length, 0); assert.equal(h.seen.network.length, 0);
});

test('runtime reports remain valid through long scan rounds without a rule freshness TTL', () => {
  const f = reportedFixture(), row = f.row({ needsRestart: true });
  assert.equal(row.reportStatus, 'no-erc20'); assert.equal(row.effectiveRules.backX, DEFAULT_RULES.backX); assert.equal(row.rulesCheckedAt, f.state.configLoadedAt + 1);
  f.state.walletRuleReports['wallet-a'].trackedERC20 = 7;
  assert.equal(f.row().reportStatus, 'loaded');
});

for (const [name, change, expected] of [
  ['worker PID', f => { f.pid = 7000; }, 'stale'],
  ['missing child PID', f => { f.pid = null; }, 'stale'],
  ['worker run', f => { f.state.walletRuleReports['wallet-a'].runId = 'old-worker'; }, 'stale'],
  ['worker start', f => { f.state.walletRuleReports['wallet-a'].runStartedAt--; }, 'stale'],
  ['old report time', f => { f.state.walletRuleReports['wallet-a'].checkedAt = f.state.configLoadedAt - 1; }, 'stale'],
  ['future report time', f => { f.state.walletRuleReports['wallet-a'].checkedAt = f.now + 1; }, 'stale'],
  ['wallet ID', f => { f.state.walletRuleReports['wallet-a'].walletId = 'another'; }, 'identity-changed'],
  ['wallet address', f => { f.state.walletRuleReports['wallet-a'].walletAddress = C; }, 'identity-changed'],
  ['session binding', f => { f.config.wallets[0].instanceId = 'replacement'; }, 'identity-changed'],
  ['saved rules', f => { f.config.wallets[0].rules = { ...DEFAULT_RULES, backX: 3 }; }, 'config-changed'],
  ['missing report', f => { delete f.state.walletRuleReports['wallet-a']; }, 'waiting'],
]) test(`current strategy refuses ${name} mismatches instead of borrowing old snapshots`, () => {
  const f = reportedFixture(); change(f);
  const row = buildStrategyStatus(f.state, f.config, [], { running: true, workerPid: f.pid, now: f.now }).wallets[0];
  assert.equal(row.effectiveRules, null); assert.equal(row.reportStatus, expected); assert.ok(row.reason);
});

test('stopped, paused, offline and monitor states explain that loaded rules do not promise execution', () => {
  const f = reportedFixture();
  f.config.wallets[0].paused = true; assert.equal(f.row().reportStatus, 'paused'); assert.match(f.row().reason, /暂停/); assert.ok(f.row().effectiveRules);
  f.config.wallets[0].paused = false; f.state.walletRuntime['wallet-a'].availability = { walletId: 'wallet-a', address: A, ready: false, code: 'OFFLINE', checkedAt: f.now };
  assert.equal(f.row().reportStatus, 'offline'); assert.match(f.row().reason, /未连接.*暂无追踪 ERC20/); assert.ok(f.row().effectiveRules);
  f.config.wallets[0].mode = 'monitor'; assert.equal(f.row().reportStatus, 'monitor'); assert.match(f.row().reason, /只监控/);
  assert.equal(f.row({ running: false }).reportStatus, 'stopped'); assert.equal(f.row({ running: false }).effectiveRules, null);
});

for (const status of ['offline', 'stale']) test(`known submission and order recovery reasons stay visible with ${status} rule evidence`, () => {
  const f = reportedFixture();
  if (status === 'offline') f.state.walletRuntime['wallet-a'].availability = { walletId: 'wallet-a', address: A, ready: false, code: 'OFFLINE', checkedAt: f.now };
  else f.state.walletRuleReports['wallet-a'].runId = 'previous-worker';
  for (const [pending, reason, next] of [
    [{ submissionIntent: { createdAt: f.now - 1000 } }, /需核对结果.*阻止自动重发/, /核对钱包订单/],
    [{ sellReviewRequired: true, reason: '部分成交，需人工核对' }, /部分成交.*人工核对/, /核对钱包订单/],
    [{ pendingSell: { orderId: 'existing-order' } }, /卖单已提交.*等待成交/, /订单 existing-order/],
  ]) {
    const result = buildStrategyStatus(f.state, f.config, [{ wallet: f.config.wallets[0], token, st: { eligibility: 'ready', ...pending } }], { running: true, workerPid: f.pid, now: f.now });
    assert.equal(result.wallets[0].reportStatus, status);
    assert.equal(result.tokens[0].eligible, false); assert.match(result.tokens[0].reason, reason); assert.match(result.tokens[0].nextTrigger, next);
  }
});
