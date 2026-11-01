import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createWalletBudget, bnbToWei } from '../lib/wallet-budget.mjs';
import { normalizeWalletConfig } from '../lib/wallet-model.mjs';

const when = Date.parse('2026-11-01T10:00:00Z');
const day = '2026-11-01';
const configForTest = () => normalizeWalletConfig({ monitorOnly: false, timeZone: 'Asia/Shanghai', paid: { maxUsd: 20, maxBnbPerDay: 1, dayUsd: 60 }, portfolioBudget: { maxBnbPerDay: null }, wallets: [{ name: 'mock-alpha.ai', address: '0x1111111111111111111111111111111111111111' }, { name: 'mock-beta.ai', address: '0x2222222222222222222222222222222222222222' }] });
function fixture(t) { const root = mkdtempSync(join(tmpdir(), 'mock-wallet-usd-')); t.after(() => rmSync(root, { recursive: true, force: true })); return { root, config: configForTest(), budget: createWalletBudget({ root, now: () => when }) }; }
const usdView = async (budget, config, wallet) => (await budget.view(config)).wallets[wallet.id];
const reserve = (budget, config, wallet, amountUsdMicros, extra = {}) => budget.reserve({ wallet, config, amountWei: '1', amountUsdMicros, legacySpent: {}, ...extra });
function processRun(script, values) { return new Promise((resolve, reject) => { const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, ...values }, stdio: ['ignore', 'pipe', 'pipe'] }); let out = '', err = ''; child.stdout.on('data', bytes => { out += bytes; }); child.stderr.on('data', bytes => { err += bytes; }); child.on('error', reject); child.on('close', code => resolve({ code, out: out.trim(), err })); }); }

test('separate processes atomically reserve the same wallet USD allowance', async t => {
  const { root, config } = fixture(t);
  const url = new URL('../lib/wallet-budget.mjs', import.meta.url).href;
  const script = `import {createWalletBudget} from ${JSON.stringify(url)};const config=JSON.parse(process.env.TASK_CONFIG);try{await createWalletBudget({root:process.env.TASK_ROOT,now:()=>${when}}).reserve({wallet:config.wallets[0],config,amountWei:'1',amountUsdMicros:'31000000',legacySpent:{}});console.log('reserved');}catch(error){console.log('blocked');}`;
  const result = await Promise.all([0, 1].map(() => processRun(script, { TASK_ROOT: root, TASK_CONFIG: JSON.stringify(config) })));
  assert.ok(result.every(value => value.code === 0), JSON.stringify(result));
  assert.deepEqual(result.map(value => value.out).sort(), ['blocked', 'reserved']);
  const view = await usdView(createWalletBudget({ root, now: () => when }), config, config.wallets[0]);
  assert.equal(view.reservedUsdMicros, '31000000'); assert.equal(view.remainingUsdMicros, '29000000'); assert.equal(view.reservedWei, '1');
});

test('USD limits follow immutable wallet IDs through rename, reorder and restart', async t => {
  const { root, config, budget } = fixture(t), [a, b] = config.wallets;
  const first = await reserve(budget, config, a, '45000000');
  await budget.settle(first.id, { spentWei: '1', spentUsdMicros: '30000000' });
  await reserve(budget, config, b, '50000000');
  a.name = 'mock-renamed.ai'; config.wallets.reverse();
  const restarted = createWalletBudget({ root, now: () => when });
  const own = await usdView(restarted, config, a), other = await usdView(restarted, config, b);
  assert.equal(own.spentUsdMicros, '30000000'); assert.equal(own.remainingUsdMicros, '30000000');
  assert.equal(other.reservedUsdMicros, '50000000'); assert.equal(other.remainingUsdMicros, '10000000');
});

test('a stricter wallet USD cap and an explicit zero cap block before any amount is reserved', async t => {
  const { config, budget } = fixture(t), [a, b] = config.wallets;
  a.paid = { dayUsd: 5 }; b.paid = { dayUsd: 0 };
  await assert.rejects(reserve(budget, config, a, '5000001'), /USD|美元|60|每日|额度/);
  await assert.rejects(reserve(budget, config, b, '1'), /USD|美元|每日|额度/);
  const own = await usdView(budget, config, a), other = await usdView(budget, config, b);
  assert.equal(own.limitUsdMicros, '5000000'); assert.equal(own.reservedUsdMicros, '0');
  assert.equal(other.limitUsdMicros, '0'); assert.equal(other.reservedUsdMicros, '0');
});

test('USD availability never bypasses the original BNB wallet or portfolio caps', async t => {
  const { config, budget } = fixture(t), [a, b] = config.wallets;
  config.portfolioBudget.maxBnbPerDay = 0.015;
  await reserve(budget, config, a, '10000000', { amountWei: bnbToWei(0.01) });
  await assert.rejects(reserve(budget, config, b, '10000000', { amountWei: bnbToWei(0.01) }), /总额度/);
  assert.equal((await usdView(budget, config, b)).reservedUsdMicros, '0', 'a rejected BNB reservation cannot consume a partial USD reservation');
  b.paid = { maxBnbPerDay: 0 };
  await assert.rejects(reserve(budget, config, b, '1'), /每日|额度/);
});

test('USD reservation identity and settlement are idempotent and include the whole actual payment', async t => {
  const { config, budget } = fixture(t), [wallet] = config.wallets;
  const original = await reserve(budget, config, wallet, '24000000', { id: 'mock-intent-1' });
  const again = await reserve(budget, config, wallet, '24000000', { id: 'mock-intent-1' });
  assert.equal(again.id, original.id);
  await assert.rejects(reserve(budget, config, wallet, '21000000', { id: original.id }), /参数|重复|变化/);
  await budget.settle(original.id, { spentWei: '1', spentUsdMicros: '24000000' });
  await budget.settle(original.id, { spentWei: '1', spentUsdMicros: '24000000' });
  const view = await usdView(budget, config, wallet);
  assert.equal(view.spentUsdMicros, '24000000', 'a 20% increased replay payment must be counted in full');
  assert.equal(view.reservedUsdMicros, '0'); assert.equal(view.remainingUsdMicros, '36000000');
  await assert.rejects(budget.release(original.id), /已花费/);
});

test('unexpected confirmed cost above its USD reservation is recorded in full and reduces the next allowance', async t => {
  const { config, budget } = fixture(t), [wallet] = config.wallets;
  const pending = await reserve(budget, config, wallet, '20000000');
  await budget.settle(pending.id, { spentWei: '1', spentUsdMicros: '24000000' });
  const view = await usdView(budget, config, wallet);
  assert.equal(view.reservedUsdMicros, '0'); assert.equal(view.spentUsdMicros, '24000000'); assert.equal(view.remainingUsdMicros, '36000000');
  await assert.rejects(reserve(budget, config, wallet, '36000001'), /USD/);
});

const mockProject = '0x3333333333333333333333333333333333333333';
const mockOtherProject = '0x4444444444444444444444444444444444444444';
const project = (projectId = mockProject) => ({ projectId, projectLimitUsdMicros: '10000000' });

test('separate processes cannot reserve two six-dollar entries into the same NFT project', async t => {
  const { root, config } = fixture(t);
  const script = `import {createWalletBudget} from ${JSON.stringify(new URL('../lib/wallet-budget.mjs', import.meta.url).href)};const config=JSON.parse(process.env.TASK_CONFIG);try{await createWalletBudget({root:process.env.TASK_ROOT,now:()=>${when}}).reserve({wallet:config.wallets[0],config,amountWei:'1',amountUsdMicros:'6000000',projectId:${JSON.stringify(mockProject)},projectLimitUsdMicros:'10000000',legacySpent:{}});console.log('reserved');}catch(error){console.log('blocked');}`;
  const results = await Promise.all([0, 1].map(() => processRun(script, { TASK_ROOT: root, TASK_CONFIG: JSON.stringify(config) })));
  assert.ok(results.every(value => value.code === 0), JSON.stringify(results)); assert.deepEqual(results.map(value => value.out).sort(), ['blocked', 'reserved']);
  assert.equal((await usdView(createWalletBudget({ root, now: () => when }), config, config.wallets[0])).reservedUsdMicros, '6000000');
});

test('NFT project caps aggregate settled and unknown costs across days while other wallets and contracts remain independent', async t => {
  const { root, config } = fixture(t), [a, b] = config.wallets;
  let clock = when; const budget = createWalletBudget({ root, now: () => clock });
  const first = await reserve(budget, config, a, '6000000', project()); await budget.settle(first.id, { spentWei: '1', spentUsdMicros: '6000000' });
  clock += 86400000;
  const second = createWalletBudget({ root, now: () => clock });
  await assert.rejects(reserve(second, config, a, '6000000', project()), /NFT|项目/);
  await reserve(second, config, a, '4000000', project());
  await assert.rejects(reserve(budget, config, a, '1', project()), /NFT|项目/);
  await reserve(second, config, b, '10000000', project());
  await reserve(second, config, a, '10000000', project(mockOtherProject));
});

test('explicit project rejection and release return only that intent quota and preserve other confirmed purchases', async t => {
  const { config, budget } = fixture(t), [wallet] = config.wallets;
  const first = await reserve(budget, config, wallet, '6000000', project());
  await budget.settle(first.id, { spentWei: '0', spentUsdMicros: '0' });
  const confirmed = await reserve(budget, config, wallet, '6000000', project()); await budget.settle(confirmed.id, { spentWei: '1', spentUsdMicros: '6000000' });
  const rest = await reserve(budget, config, wallet, '4000000', project()); await budget.release(rest.id);
  await reserve(budget, config, wallet, '4000000', project());
  await assert.rejects(reserve(budget, config, wallet, '1', project()), /NFT|项目/);
});

test('a saved five-dollar project maximum stays stricter than the NFT ten-dollar ceiling across repeated entries', async t => {
  const { config, budget } = fixture(t), [wallet] = config.wallets; wallet.paid = { maxUsd: 5 };
  const first = await reserve(budget, config, wallet, '3000000', project()); await budget.settle(first.id, { spentWei: '1', spentUsdMicros: '3000000' });
  await assert.rejects(reserve(budget, config, wallet, '3000000', project()), /NFT|项目/);
  await reserve(budget, config, wallet, '2000000', project());
  await assert.rejects(reserve(budget, config, wallet, '1', project()), /NFT|项目/);
});

test('NFT project budget metadata cannot be incomplete, malformed or exceed ten dollars', async t => {
  const { config, budget } = fixture(t), [wallet] = config.wallets;
  for (const extra of [{ projectId: mockProject }, { projectLimitUsdMicros: '10000000' }, project('mock-not-a-contract'), { ...project(), projectLimitUsdMicros: '10000001' }, { ...project(), projectLimitUsdMicros: '0' }]) await assert.rejects(reserve(budget, config, wallet, '1000000', extra), /NFT|项目/);
  assert.equal((await usdView(budget, config, wallet)).reservedUsdMicros, '0');
});

test('missing USD settlement fields retain the full reserved USD cost rather than silently clearing it', async t => {
  const { config, budget } = fixture(t), [wallet] = config.wallets;
  const original = await reserve(budget, config, wallet, '20000000');
  await budget.settle(original.id, { spentWei: '1' });
  assert.equal((await usdView(budget, config, wallet)).spentUsdMicros, '20000000');
});

test('unresolved USD reservations survive midnight while verified rejection explicitly releases only its own cost', async t => {
  const { root, config } = fixture(t), [wallet] = config.wallets;
  let clock = when;
  const budget = createWalletBudget({ root, now: () => clock });
  const pending = await reserve(budget, config, wallet, '55000000');
  clock += 86400000;
  const restarted = createWalletBudget({ root, now: () => clock });
  const next = await usdView(restarted, config, wallet);
  assert.equal(next.spentUsdMicros, '0'); assert.equal(next.reservedUsdMicros, '55000000');
  await assert.rejects(reserve(restarted, config, wallet, '6000000'), /USD|美元|每日|额度/);
  await restarted.settle(pending.id, { spentWei: '0', spentUsdMicros: '0' });
  assert.equal((await usdView(restarted, config, wallet)).reservedUsdMicros, '0');
  await reserve(restarted, config, wallet, '60000000');
});

test('unknown legacy BNB spending and unresolved reservations conservatively exhaust USD allowance', async t => {
  const { root, config, budget } = fixture(t), [wallet] = config.wallets;
  mkdirSync(join(root, 'data'), { recursive: true });
  writeFileSync(join(root, 'data/watch_state.json'), JSON.stringify({ paidSpend: { day, [wallet.id]: 0.01 } }));
  const migrated = await usdView(budget, config, wallet);
  assert.equal(migrated.spentUsdMicros, '60000000'); assert.equal(migrated.remainingUsdMicros, '0');
  await assert.rejects(reserve(budget, config, wallet, '1', { legacySpent: undefined }), /USD|美元|每日|额度/);
  const { root: oldRoot, config: oldConfig } = fixture(t), oldWallet = oldConfig.wallets[0];
  const old = createWalletBudget({ root: oldRoot, now: () => when });
  await old.reserve({ wallet: oldWallet, config: oldConfig, amountWei: '1', legacySpent: {} });
  const oldView = await usdView(createWalletBudget({ root: oldRoot, now: () => when + 86400000 }), oldConfig, oldWallet);
  assert.equal(oldView.reservedUsdMicros, '60000000'); assert.equal(oldView.usdReviewRequired, true);
});

test('confirming an old reservation after its USD migration view cannot restore a fresh daily allowance', async t => {
  const { config, budget } = fixture(t), [paidWallet, rejectedWallet] = config.wallets;
  const paid = await budget.reserve({ wallet: paidWallet, config, amountWei: '1', legacySpent: {} });
  const rejected = await budget.reserve({ wallet: rejectedWallet, config, amountWei: '1', legacySpent: {} });
  for (const wallet of [paidWallet, rejectedWallet]) { const before = await usdView(budget, config, wallet); assert.equal(before.remainingUsdMicros, '0'); assert.equal(before.usdReviewRequired, true); }
  await budget.settle(paid.id, { spentWei: '1' }); await budget.settle(rejected.id, { spentWei: '0' });
  const confirmed = await usdView(budget, config, paidWallet), failed = await usdView(budget, config, rejectedWallet);
  assert.equal(confirmed.reservedUsdMicros, '0'); assert.equal(confirmed.spentUsdMicros, '60000000'); assert.equal(confirmed.remainingUsdMicros, '0');
  await assert.rejects(reserve(budget, config, paidWallet, '1'), /USD/);
  assert.equal(failed.reservedUsdMicros, '0'); assert.equal(failed.spentUsdMicros, '0'); assert.equal(failed.remainingUsdMicros, '60000000');
});

test('malformed micro-USD cannot create a reservation or change the original ledger balance', async t => {
  const { root, config, budget } = fixture(t), [wallet] = config.wallets;
  for (const amountUsdMicros of ['-1', '1.5', '1e6', 'NaN', '', null, {}, 1000000]) await assert.rejects(reserve(budget, config, wallet, amountUsdMicros), /USD|金额|整数|预算/);
  const view = await usdView(budget, config, wallet);
  assert.equal(view.reservedUsdMicros, '0'); assert.equal(view.reservedWei, '0');
});
