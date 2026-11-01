import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG, DEFAULT_RULES, getPaidConfig, getRuleConfig, readConfig, sanitizeConfig, saveConfig, validateConfig, withinPaidBudget } from '../lib/config.mjs';

const example = () => structuredClone(DEFAULT_CONFIG);
const wallet = () => ({ name: '测试钱包', address: '0x1111111111111111111111111111111111111111' });

test('monitor configuration supports an empty wallet list; trading does not', () => {
  assert.equal(validateConfig(example()).monitorOnly, true);
  assert.equal(validateConfig(example()).enableFileCommands, false);
  assert.throws(() => validateConfig({ ...example(), enableFileCommands: 'true' }), /布尔值/);
  assert.throws(() => validateConfig({ ...example(), monitorOnly: false }), /至少一个钱包/);
  assert.throws(() => validateConfig({ ...example(), monitorOnly: 'true' }), /布尔值/);
  const input = example(); input.monitorOnly = false; input.wallets = [wallet()];
  assert.equal(validateConfig(input).wallets.length, 1);
});

test('paid settings honor explicit values and zero budgets', () => {
  const paid = getPaidConfig({ paid: { goPct: 0.8, earlyPct: 0.65, riseDelta: 0, maxUsd: 0, maxBnbPerDay: 0, keepBnb: 0 } });
  assert.deepEqual([paid.goPct, paid.earlyPct, paid.riseDelta, paid.maxUsd, paid.maxBnbPerDay, paid.keepBnb], [0.8, 0.65, 0, 0, 0, 0]);
  assert.equal(getPaidConfig({ paid: { goPct: 0 } }).goPct, 0);
  assert.equal(getPaidConfig({}).maxBnbPerDay, 0);
  assert.equal(getPaidConfig({}).goPct, 0.8);
  assert.equal(getPaidConfig({ paid: { goPct: 0.8 } }).goPct, 0.8);
  for (const invalid of [-1, Infinity, NaN, '20', null]) assert.throws(() => getPaidConfig({ paid: { maxUsd: invalid } }), /数值/);
  assert.throws(() => getPaidConfig({ paid: { goPct: 0.5, earlyPct: 0.6 } }), /不能大于/);
});

test('all paid cost checks enforce project, daily, and retained BNB budgets', () => {
  const paid = getPaidConfig({ paid: { maxUsd: 20, maxBnbPerDay: 0.05, keepBnb: 0.006 } });
  const cost = { spentBnb: 0.02, costBnb: 0.01, costUsd: 15, balanceBnb: 0.03 };
  assert.equal(withinPaidBudget(paid, cost), true);
  assert.equal(withinPaidBudget(paid, { ...cost, costUsd: 20.01 }), false);
  assert.equal(withinPaidBudget(paid, { ...cost, spentBnb: 0.045 }), false);
  assert.equal(withinPaidBudget(paid, { ...cost, balanceBnb: 0.015 }), false);
  assert.equal(withinPaidBudget({ ...paid, maxUsd: 0 }, cost), false);
  assert.equal(withinPaidBudget({ ...paid, maxBnbPerDay: 0 }, cost), false);
  assert.equal(withinPaidBudget(paid, { ...cost, costBnb: NaN }), false);
  assert.equal(withinPaidBudget(paid, { ...cost, costBnb: -1 }), false);
});

test('wallet profile paths reject traversal and absolute paths', () => {
  for (const path of ['../outside', '/tmp/outside', 'data/../../outside', 'data\\outside', 'C:\\outside', './baw2']) {
    for (const field of ['bawDir', 'bawPkg']) {
      const input = example(); input.wallets = [{ ...wallet(), [field]: path }];
      assert.throws(() => validateConfig(input), /相对目录/);
    }
  }
  const input = example(); input.wallets = [{ ...wallet(), bawDir: 'data/wallet-2', bawPkg: 'baw2pkg', instanceId: 'wallet-2' }];
  assert.equal(validateConfig(input).wallets[0].bawDir, 'data/wallet-2');
  input.wallets.push(wallet());
  assert.throws(() => validateConfig(input), /不能重复/);
});

test('wallets cannot share a session directory, including another wallet default', () => {
  const second = { name: '测试钱包 2', address: '0x2222222222222222222222222222222222222222' };
  for (const wallets of [
    [{ ...wallet(), bawDir: 'data/shared-wallet' }, { ...second, bawDir: 'data/shared-wallet' }],
    [wallet(), { ...second, bawDir: 'data/wallets/wallet-1' }],
    [{ ...wallet(), bawDir: 'data/wallets/wallet-2' }, second],
  ]) assert.throws(() => validateConfig({ ...example(), wallets }), /会话目录不能重复/);
  if (process.platform === 'darwin') {
    assert.throws(() => validateConfig({ ...example(), wallets: [wallet(), { ...second, bawDir: 'DATA/WALLETS/WALLET-1' }] }), /会话目录不能重复/);
  }
  assert.equal(validateConfig({ ...example(), wallets: [wallet(), second] }).wallets.length, 2);
  assert.equal(validateConfig({ ...example(), wallets: [{ ...wallet(), bawDir: 'data/one', instanceId: 'same-id' }, { ...second, bawDir: 'data/two', instanceId: 'same-id' }] }).wallets.length, 2);
});

test('address and strategy boundaries are checked and unknown fields are removed', () => {
  const input = example(); input.wallets = [{ ...wallet(), arbitraryCommand: 'bad' }]; input.arbitraryCommand = 'bad';
  const output = validateConfig(input);
  assert.equal(output.arbitraryCommand, undefined);
  assert.equal(output.wallets[0].arbitraryCommand, undefined);
  for (const address of ['0x123', '0x' + '0'.repeat(40)]) {
    assert.throws(() => validateConfig({ ...input, forceMint: [address] }), /有效的 BSC 地址/);
  }
  assert.throws(() => validateConfig({ ...input, rules: { crash: 1.1 } }), /数值/);
  assert.throws(() => validateConfig({ ...input, rules: { halfX: [10, 5] } }), /严格递增/);
  assert.throws(() => validateConfig({ ...input, rules: { backX: 6, halfX: [5, 10] } }), /大于/);
  assert.throws(() => validateConfig({ ...input, tokens: [{ sym: 'T', addr: wallet().address, cost: -1 }] }), /数值/);
  assert.throws(() => validateConfig({ ...input, timeZone: 'Invalid/Zone' }), /时区/);
});

test('v2.5.8 step defaults and explicitly configured empty targets are preserved', () => {
  const rules = getRuleConfig();
  assert.deepEqual(rules, DEFAULT_RULES);
  assert.deepEqual([rules.backX, rules.crash, rules.crashAfterBack, rules.moonPct], [2, 0.4, 0.6, 20]);
  const empty = getRuleConfig({ rules: { strategy: 'steps', steps: [], moonNotifyX: [], moonPct: 0, crashAfterBack: 0 } });
  assert.deepEqual(empty.steps, []); assert.deepEqual(empty.moonNotifyX, []); assert.equal(empty.moonPct, 0); assert.equal(empty.crashAfterBack, 0);
  for (const steps of [[[10, 0]], [[10, 100.5]], [[10, 101]], [[10]], [[10, 20], [5, 50]], [[2, 30]]]) assert.throws(() => getRuleConfig({ rules: { steps } }));
  assert.throws(() => getRuleConfig({ rules: { moonPct: 20.5 } }));
  assert.throws(() => getRuleConfig({ rules: { crashAfterBack: -0.1 } }));
});

test('old half-sale configurations retain legacy recovery, fast and no-pump semantics', () => {
  const old = { backX: 3, halfX: [5, 10], crash: 0.6, fastMin: 30, fastCrash: 0.35, noPumpMin: 20, noPumpX: 2 };
  const before = structuredClone(old), normalized = getRuleConfig({ rules: old });
  assert.equal(normalized.strategy, 'legacy'); assert.equal(normalized.moonPct, 0); assert.equal(normalized.crashAfterBack, 0.6);
  for (const [key, value] of Object.entries(old)) assert.deepEqual(normalized[key], value);
  assert.deepEqual(sanitizeConfig({ rules: old }).rules, normalized); assert.deepEqual(old, before);
  assert.equal(getRuleConfig({ rules: { strategy: 'legacy', halfX: [], steps: [[10, 30]] } }).strategy, 'legacy');
  assert.equal(getRuleConfig({ rules: { strategy: 'steps', halfX: [5, 10], steps: [] } }).strategy, 'steps');
  const minimalOld = getRuleConfig({ rules: { drop: 0.4 } });
  assert.equal(minimalOld.strategy, 'legacy'); assert.equal(minimalOld.backX, 3); assert.deepEqual(minimalOld.halfX, [5, 10]);
});

test('strategy selection survives merged saves and custom RPC settings survive validation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentid-config-migration-')), path = join(dir, 'config.json');
  try {
    writeFileSync(path, JSON.stringify({ ...example(), rules: { halfX: [5, 10] }, rpcs: ['https://bsc.example.test/rpc'] }));
    const first = saveConfig({ paid: { maxUsd: 5 } }, { path });
    assert.equal(first.rules.strategy, 'legacy'); assert.deepEqual(first.rules.halfX, [5, 10]);
    saveConfig({ rules: { strategy: 'steps', steps: [[10, 30]], moonPct: 20 } }, { path });
    assert.equal(readConfig({ path }).rules.strategy, 'steps'); assert.deepEqual(readConfig({ path }).rules.steps, [[10, 30]]);
    const legacy = saveConfig({ rules: { strategy: 'legacy', halfX: [6, 12] } }, { path });
    assert.equal(legacy.rules.strategy, 'legacy'); assert.deepEqual(legacy.rpcs, ['https://bsc.example.test/rpc']);
    for (const rpcs of [['file:///tmp/steal'], ['https://user:pass@example.test/rpc'], ['not-a-url']]) assert.throws(() => validateConfig({ ...example(), rpcs }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('configuration save preserves write-only tokens, validates before write, and can clear tokens', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentid-config-test-'));
  const path = join(dir, 'config.json');
  const fakeToken = '12345:fake_token_for_tests_only';
  try {
    const initial = example(); initial.telegram.botToken = fakeToken;
    writeFileSync(path, JSON.stringify(initial));
    const sanitized = saveConfig({ paid: { maxUsd: 5 }, telegram: { botToken: '' } }, { path });
    assert.equal(readConfig({ path }).telegram.botToken, fakeToken);
    assert.equal(readConfig({ path }).paid.maxUsd, 5);
    assert.equal(sanitized.telegram.botToken, '');
    assert.equal(sanitized.telegram.botTokenConfigured, true);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const before = readFileSync(path, 'utf8');
    assert.throws(() => saveConfig({ paid: { maxUsd: -1 } }, { path }), /数值/);
    assert.equal(readFileSync(path, 'utf8'), before);
    saveConfig({ telegram: { clearBotToken: true } }, { path });
    assert.equal(readConfig({ path }).telegram.botToken, '');
    assert.equal(sanitizeConfig(initial).telegram.botToken, '');
    assert.equal(sanitizeConfig({ ...initial, apiKey: 'sensitive', paid: { ...initial.paid, sessionToken: 'sensitive' }, wallets: [{ ...wallet(), clientId: 'sensitive' }] }).apiKey, undefined);
    assert.equal(sanitizeConfig({ ...initial, paid: { ...initial.paid, sessionToken: 'sensitive' } }).paid.sessionToken, undefined);
    assert.equal(sanitizeConfig({ ...initial, wallets: [{ ...wallet(), clientId: 'sensitive' }] }).wallets[0].clientId, undefined);
    assert.equal(initial.telegram.botToken, fakeToken);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
