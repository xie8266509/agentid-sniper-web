import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildStrategyStatus, positionState } from '../lib/strategy-status.mjs';
import { DEFAULT_RULES } from '../lib/config.mjs';
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
