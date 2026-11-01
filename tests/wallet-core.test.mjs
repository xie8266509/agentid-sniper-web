import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG, readConfig, saveConfig, validateConfig } from '../lib/config.mjs';
import { effectiveWalletConfig, normalizeWalletConfig, resolveWallet, walletCanAutomate } from '../lib/wallet-model.mjs';
import { clearWalletBlocked, markWalletBlocked, walletExecutionView, withWalletExecution } from '../lib/wallet-executor.mjs';
import { bnbToWei, createWalletBudget } from '../lib/wallet-budget.mjs';
import { runBoundWalletTransaction } from '../lib/wallet-cli.mjs';

const address = n => '0x' + String(n).repeat(40);
const legacy = () => ({ ...structuredClone(DEFAULT_CONFIG), monitorOnly: false, paid: { ...DEFAULT_CONFIG.paid, maxBnbPerDay: 1 }, wallets: [{ name: 'alpha.ai', address: address(1) }, { name: 'beta.ai', address: address(2) }] });
const temp = () => mkdtempSync(join(tmpdir(), 'agentid-wallet-core-'));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const executorUrl = new URL('../lib/wallet-executor.mjs', import.meta.url).href;
const budgetUrl = new URL('../lib/wallet-budget.mjs', import.meta.url).href;

function child(script, values = {}) {
  const process = spawn(globalThis.process.execPath, ['--input-type=module', '-e', script], { env: { ...globalThis.process.env, ...values }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', errors = '';
  process.stdout.on('data', data => { output += data; });
  process.stderr.on('data', data => { errors += data; });
  const done = new Promise((resolve, reject) => {
    process.on('error', reject);
    process.on('exit', (code, signal) => resolve({ code, signal, output, errors }));
  });
  return { process, done, async ready() {
    const started = Date.now();
    while (!output.includes('READY')) { if (Date.now() - started > 5000) throw new Error('Child did not become ready: ' + errors); await delay(10); }
  } };
}

test('legacy wallet identity and encrypted session scope survive rename and reordering', () => {
  const root = temp(), path = join(root, 'config.json'), original = legacy();
  try {
    writeFileSync(path, JSON.stringify(original));
    const config = readConfig({ path });
    assert.equal(readFileSync(path, 'utf8'), JSON.stringify(original), 'read normalization never changes live files');
    assert.equal(config.wallets[1].bawDir, 'data/wallets/wallet-2');
    assert.equal(config.wallets[1].instanceId, 'agentid-sniper-' + createHash('sha256').update('data/wallets/wallet-2').digest('hex').slice(0, 24));
    const renamed = [...config.wallets].reverse(); renamed[1] = { ...renamed[1], name: '显示别名' };
    saveConfig({ wallets: renamed }, { path });
    const next = readConfig({ path });
    assert.equal(resolveWallet(next, config.wallets[0].id).index, 1);
    assert.equal(next.wallets[1].agentId, 'alpha.ai');
    assert.equal(next.wallets[1].bawDir, config.wallets[0].bawDir);
    assert.equal(next.wallets[1].instanceId, config.wallets[0].instanceId);
    for (const change of [{ address: address(3) }, { instanceId: 'another' }, { bawDir: 'data/another' }, { agentId: 'another.ai' }]) {
      assert.throws(() => saveConfig({ wallets: next.wallets.map((wallet, index) => index ? { ...wallet, ...change } : wallet) }, { path }), /已绑定/);
    }
    assert.throws(() => saveConfig({ wallets: next.wallets.slice(0, 1) }, { path }), /归档/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('new draft wallets cannot transact and bind address once through the controlled import', () => {
  const root = temp(), path = join(root, 'config.json');
  try {
    const config = structuredClone(DEFAULT_CONFIG);
    config.wallets = [{ id: 'draft-1', name: '新钱包', address: '', draft: true, paused: true, mode: 'monitor' }];
    const validated = validateConfig(config);
    assert.equal(validated.wallets[0].bawDir, 'data/wallets/draft-1');
    assert.equal(walletCanAutomate({ ...validated, monitorOnly: false }, validated.wallets[0]), false);
    writeFileSync(path, JSON.stringify(validated));
    const bound = { ...validated.wallets[0], address: address(1), agentId: 'new.ai', draft: false };
    assert.throws(() => saveConfig({ wallets: [bound] }, { path }), /已绑定/);
    saveConfig({ wallets: [bound] }, { path, allowWalletBinding: true });
    assert.equal(readConfig({ path }).wallets[0].id, 'draft-1');
    assert.throws(() => saveConfig({ wallets: [{ ...readConfig({ path }).wallets[0], address: address(2) }] }, { path, allowWalletBinding: true }), /已绑定/);
    assert.throws(() => validateConfig({ ...config, wallets: [{ ...config.wallets[0], paused: false }] }), /必须暂停/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a later Agent ID claim can bind an empty identity only through a verified import', () => {
  const root = temp(), path = join(root, 'config.json');
  try {
    const current = normalizeWalletConfig(legacy()); current.wallets[0].agentId = '';
    writeFileSync(path, JSON.stringify(current));
    const next = current.wallets.map((wallet, index) => index ? wallet : { ...wallet, agentId: 'claimed-later' });
    assert.throws(() => saveConfig({ wallets: next }, { path }), /已绑定/);
    saveConfig({ wallets: next }, { path, allowWalletBinding: true });
    assert.equal(readConfig({ path }).wallets[0].agentId, 'claimed-later');
    assert.equal(readConfig({ path }).wallets[0].agentIdVerified, true);
    assert.throws(() => saveConfig({ wallets: readConfig({ path }).wallets.map((wallet, index) => index ? wallet : { ...wallet, agentId: 'replaced' }) }, { path, allowWalletBinding: true }), /已绑定/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a legacy display alias can be corrected by official import without forging verification', () => {
  const root = temp(), path = join(root, 'config.json'), original = legacy();
  original.wallets[0].name = '钱包 1';
  try {
    writeFileSync(path, JSON.stringify(original));
    const current = readConfig({ path }), wallet = current.wallets[0];
    assert.equal(wallet.agentId, '钱包 1'); assert.equal(wallet.agentIdVerified, false);
    const changed = patch => current.wallets.map((entry, index) => index ? entry : { ...entry, ...patch });
    assert.throws(() => saveConfig({ wallets: changed({ agentId: 'official-handle', agentIdVerified: true }) }, { path }), /核验标记|已绑定/);
    assert.throws(() => saveConfig({ wallets: changed({ agentIdVerified: true }) }, { path }), /核验标记/);
    saveConfig({ wallets: changed({ name: '主钱包' }) }, { path });
    assert.equal(readConfig({ path }).wallets[0].agentIdVerified, false);
    saveConfig({ wallets: changed({ agentId: 'official-handle', agentIdVerified: true }) }, { path, allowWalletBinding: true });
    const verified = readConfig({ path });
    assert.equal(verified.wallets[0].agentId, 'official-handle'); assert.equal(verified.wallets[0].agentIdVerified, true);
    assert.equal(verified.wallets[0].bawDir, wallet.bawDir); assert.equal(verified.wallets[0].instanceId, wallet.instanceId);
    for (const patch of [{ agentId: 'replacement' }, { agentIdVerified: false }]) {
      const wallets = verified.wallets.map((entry, index) => index ? entry : { ...entry, ...patch });
      assert.throws(() => saveConfig({ wallets }, { path }), /已绑定|核验标记/);
      assert.throws(() => saveConfig({ wallets }, { path, allowWalletBinding: true }), /已绑定|核验标记/);
    }
    saveConfig({ wallets: verified.wallets.map((entry, index) => index ? entry : { ...entry, name: '新的显示名' }) }, { path });
    assert.equal(readConfig({ path }).wallets[0].agentId, 'official-handle'); assert.equal(readConfig({ path }).wallets[0].agentIdVerified, true);
    const newDraft = { id: 'draft-forgery', name: '新钱包', address: '', mode: 'monitor', paused: true, draft: true, agentIdVerified: true };
    assert.throws(() => saveConfig({ wallets: [...verified.wallets, newDraft] }, { path }), /核验标记/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('original aliases survive rename and official verification while a new same-named draft inherits no spend', async () => {
  const root = temp(), path = join(root, 'config.json'), original = legacy();
  original.wallets[0].name = '钱包 1'; original.wallets[0].agentId = 'old-handle';
  try {
    writeFileSync(path, JSON.stringify(original));
    const first = readConfig({ path });
    assert.deepEqual(first.wallets[0].legacyNames, ['钱包 1', 'old-handle']);
    saveConfig({ wallets: first.wallets.map(({ legacyNames, ...wallet }, index) => index ? wallet : { ...wallet, name: '主钱包' }) }, { path });
    const renamed = readConfig({ path });
    saveConfig({ wallets: renamed.wallets.map((wallet, index) => index ? wallet : { ...wallet, agentId: 'official-handle', agentIdVerified: true }) }, { path, allowWalletBinding: true });
    const verified = readConfig({ path });
    assert.deepEqual(verified.wallets[0].legacyNames, ['钱包 1', 'old-handle']);
    for (const options of [{ path }, { path, allowWalletBinding: true }]) assert.throws(() => saveConfig({ wallets: verified.wallets.map((wallet, index) => index ? wallet : { ...wallet, legacyNames: ['forged'] }) }, options), /历史钱包别名/);
    const draft = { id: 'new-same-name', name: '钱包 1', address: '', agentId: '', draft: true, mode: 'monitor', paused: true };
    saveConfig({ wallets: [...verified.wallets, draft] }, { path });
    const config = readConfig({ path });
    assert.deepEqual(config.wallets[2].legacyNames, []);
    assert.throws(() => saveConfig({ wallets: [...config.wallets, { ...draft, id: 'forged-alias', name: '另一个', legacyNames: ['钱包 1'] }] }, { path }), /不能伪造/);
    mkdirSync(join(root, 'data'), { recursive: true });
    writeFileSync(join(root, 'data', 'watch_state.json'), JSON.stringify({ paidSpend: { day: '2026-11-01', '钱包 1': .3, 'old-handle': .2, '主钱包': .8, 'official-handle': .9 } }));
    const budget = createWalletBudget({ root, now: () => Date.parse('2026-11-01T10:00:00Z') });
    const view = await budget.view(config);
    assert.equal(view.wallets[config.wallets[0].id].spentWei, bnbToWei(.3));
    assert.equal(view.wallets[draft.id].spentWei, '0');
    assert.deepEqual(readConfig({ path }).wallets[0].legacyNames, ['钱包 1', 'old-handle']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a transaction never reaches execute for another session or a mismatched BSC account', async () => {
  const wallet = normalizeWalletConfig(legacy()).wallets[0], execute = ['contract-call', 'execute', '--requestId', 'test-request'];
  for (const addresses of [[{ binanceChainId: '56', address: address(2) }], [{ binanceChainId: '1', address: wallet.address }, { binanceChainId: '56', address: address(2) }], [], [{ binanceChainId: '1', address: wallet.address }]]) {
    const calls = [];
    const result = await runBoundWalletTransaction(execute, wallet, { runRaw: async args => { calls.push(args); return { success: true, data: { addresses } }; } });
    assert.equal(result.success, false); assert.equal(result.error.name, 'CONFIG_ERROR');
    assert.deepEqual(calls, [['wallet', 'address']]);
  }
  const calls = [];
  const result = await runBoundWalletTransaction(execute, wallet, { runRaw: async args => { calls.push(args); return args[0] === 'wallet' ? { success: true, data: { addresses: [{ binanceChainId: 56, address: wallet.address }] } } : { success: true, data: { txHash: 'test-result' } }; } });
  assert.equal(result.success, true); assert.deepEqual(calls, [['wallet', 'address'], execute]);
  const rejected = await runBoundWalletTransaction(execute, { ...wallet, draft: true }, { runRaw: async () => assert.fail('draft must not call CLI') });
  assert.equal(rejected.error.name, 'CONFIG_ERROR');
});

test('the final synchronous permission guard runs after the async connected-account check', async () => {
  const wallet = normalizeWalletConfig(legacy()).wallets[0], calls = [];
  let paused = false;
  const result = await runBoundWalletTransaction(['market-order', 'swap'], wallet, {
    runRaw: async args => { calls.push(args); await delay(1); paused = true; return { success: true, data: { addresses: [{ binanceChainId: '56', address: wallet.address }] } }; },
    beforeSend: () => { if (paused) throw new Error('自动任务已暂停'); },
  });
  assert.equal(result.success, false); assert.equal(result.error.name, 'CONFIG_ERROR'); assert.match(result.error.message, /暂停/);
  assert.deepEqual(calls, [['wallet', 'address']]);
});

test('wallet strategy overrides and independent modes obey the global stop', () => {
  const config = normalizeWalletConfig(legacy()), wallet = { ...config.wallets[0], mode: 'sell-only', paid: { maxBnbPerDay: .2 }, rules: { backX: 4 } };
  assert.equal(effectiveWalletConfig(config, wallet).paid.maxBnbPerDay, .2);
  assert.equal(effectiveWalletConfig(config, wallet).rules.backX, 4);
  assert.equal(walletCanAutomate(config, wallet, 'mint'), false);
  assert.equal(walletCanAutomate(config, wallet, 'token-sell'), true);
  assert.equal(walletCanAutomate(config, { ...wallet, autoSellNfts: false }, 'nft-sell'), false);
  assert.equal(walletCanAutomate(config, { ...wallet, paused: true }, 'token-sell'), false);
  assert.equal(walletCanAutomate({ ...config, monitorOnly: true }, wallet, 'token-sell'), false);
  assert.equal(walletCanAutomate(config, config.wallets[1], 'mint'), true);
});

test('legacy token costs stay with the original bound wallet before scanner startup', () => {
  const root = temp(), path = join(root, 'config.json'), original = legacy();
  original.tokens = [{ sym: 'COST', addr: address(3), cost: 12 }, { sym: 'OWN', addr: address(4), cost: 7, only: address(2) }, { sym: 'BOTH', addr: address(5), cost: 4, both: true }];
  try {
    writeFileSync(path, JSON.stringify(original));
    const current = readConfig({ path });
    assert.equal(current.tokens[0].costWalletAddress, address(1));
    assert.equal(current.tokens[1].costWalletAddress, undefined);
    assert.equal(current.tokens[2].costWalletAddress, undefined);
    saveConfig({ wallets: [...current.wallets].reverse(), tokens: original.tokens }, { path });
    assert.equal(readConfig({ path }).tokens[0].costWalletAddress, address(1));
    assert.equal(JSON.parse(readFileSync(path)).tokens[0].costWalletAddress, address(1));
    const changed = readConfig({ path });
    saveConfig({ tokens: changed.tokens.map(({ costWalletAddress, ...token }) => ({ ...token, cost: token.cost + 1 })) }, { path });
    assert.equal(readConfig({ path }).tokens[0].costWalletAddress, address(1));
    assert.throws(() => validateConfig({ ...changed, tokens: [{ ...changed.tokens[0], costWalletAddress: '0x123' }] }), /有效的 BSC 地址/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('wallet queue is reentrant, preserves pending evidence, and blocks only its wallet', async () => {
  const root = temp(), [a, b] = normalizeWalletConfig(legacy()).wallets;
  try {
    const events = [];
    await Promise.all([
      withWalletExecution(a, async () => { events.push('a1'); await withWalletExecution(a, async () => events.push('nested'), { root }); await delay(35); events.push('a2'); }, { root }),
      withWalletExecution(a, async () => events.push('a3'), { root }),
      withWalletExecution(b, async () => events.push('b'), { root }),
    ]);
    assert(events.indexOf('a3') > events.indexOf('a2'));
    assert(events.indexOf('b') < events.indexOf('a2'), 'another wallet is not blocked by wallet A');
    await markWalletBlocked(a, '待核对', { root, details: { source: 'manual', reservationId: 'reservation-1' } });
    await markWalletBlocked(a, '待回执', { root, details: { orderId: 'order-1', sessionToken: 'test-only-do-not-persist' } });
    const view = walletExecutionView(a, { root });
    assert.equal(view.details.reservationId, 'reservation-1');
    assert.equal(view.details.orderId, 'order-1');
    assert.equal(view.details.sessionToken, undefined);
    assert.equal(view.busy, false);
    await assert.rejects(withWalletExecution(a, async () => {}, { root }), /先核对/);
    await withWalletExecution(b, async () => {}, { root });
    await assert.rejects(clearWalletBlocked(a, { root, reference: 'another-order' }), /凭证/);
    await clearWalletBlocked(a, { root, reference: 'order-1' });
    assert.equal(walletExecutionView(a, { root }).blocked, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('separate processes serialize the same wallet and bound concurrent wallets to two', async () => {
  const root = temp(), path = join(root, 'events.jsonl');
  const script = `import {withWalletExecution} from ${JSON.stringify(executorUrl)}; import {appendFileSync} from 'node:fs';
const wallet=JSON.parse(process.env.TASK_WALLET); await withWalletExecution(wallet,async()=>{appendFileSync(process.env.TASK_EVENTS,JSON.stringify({id:wallet.id,type:'start'})+'\\n');await new Promise(r=>setTimeout(r,160));appendFileSync(process.env.TASK_EVENTS,JSON.stringify({id:wallet.id,type:'end'})+'\\n');},{root:process.env.TASK_ROOT});`;
  try {
    const wallets = normalizeWalletConfig({ ...legacy(), wallets: [...legacy().wallets, { name: 'gamma.ai', address: address(3) }] }).wallets;
    const jobs = [wallets[0], wallets[0], wallets[1], wallets[2]].map(wallet => child(script, { TASK_ROOT: root, TASK_EVENTS: path, TASK_WALLET: JSON.stringify(wallet) }));
    const results = await Promise.all(jobs.map(job => job.done));
    assert(results.every(result => result.code === 0), JSON.stringify(results));
    const active = new Set(); let peak = 0;
    for (const event of readFileSync(path, 'utf8').trim().split('\n').map(JSON.parse)) {
      if (event.type === 'start') { assert(!active.has(event.id), 'same wallet overlapped'); active.add(event.id); peak = Math.max(peak, active.size); }
      else assert(active.delete(event.id));
    }
    assert.equal(active.size, 0); assert.equal(peak, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a delayed callback cannot reuse a wallet lock after its owner has finished', async () => {
  const root = temp(), wallet = normalizeWalletConfig(legacy()).wallets[0], events = [];
  let finished, failed;
  const background = new Promise((resolve, reject) => { finished = resolve; failed = reject; });
  try {
    await withWalletExecution(wallet, async () => {
      setTimeout(() => { withWalletExecution(wallet, async () => events.push('late'), { root }).then(finished, failed); }, 35);
    }, { root });
    await Promise.all([
      withWalletExecution(wallet, async () => { events.push('start'); await delay(70); events.push('end'); }, { root }), background,
    ]);
    assert.deepEqual(events, ['start', 'end', 'late']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('wallet coordination refuses runtime directories redirected outside the project', async () => {
  const root = temp(), outside = temp(), wallet = normalizeWalletConfig(legacy()).wallets[0];
  try {
    symlinkSync(outside, join(root, 'data'));
    await assert.rejects(withWalletExecution(wallet, async () => assert.fail('must not run'), { root }), /符号链接/);
    assert.throws(() => createWalletBudget({ root }), /符号链接/);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test('a killed executor is surfaced as unknown and competing reapers cannot overlap', async () => {
  const root = temp(), wallet = normalizeWalletConfig(legacy()).wallets[0];
  const crash = child(`import {withWalletExecution} from ${JSON.stringify(executorUrl)}; await withWalletExecution(JSON.parse(process.env.TASK_WALLET),async()=>{console.log('READY');await new Promise(()=>{});},{root:process.env.TASK_ROOT});`, { TASK_ROOT: root, TASK_WALLET: JSON.stringify(wallet) });
  try {
    await crash.ready(); crash.process.kill('SIGKILL'); await crash.done;
    assert.equal(walletExecutionView(wallet, { root }).blocked, true);
    const path = join(root, 'recovery.jsonl');
    const script = `import {withWalletExecution} from ${JSON.stringify(executorUrl)};import {appendFileSync} from 'node:fs';await withWalletExecution(JSON.parse(process.env.TASK_WALLET),async()=>{appendFileSync(process.env.TASK_EVENTS,'start\\n');await new Promise(r=>setTimeout(r,35));appendFileSync(process.env.TASK_EVENTS,'end\\n');},{root:process.env.TASK_ROOT,kind:'reconcile',allowBlocked:true});`;
    const jobs = Array.from({ length: 4 }, () => child(script, { TASK_ROOT: root, TASK_WALLET: JSON.stringify(wallet), TASK_EVENTS: path }));
    const results = await Promise.all(jobs.map(job => job.done));
    assert(results.every(result => result.code === 0), JSON.stringify(results));
    assert.deepEqual(readFileSync(path, 'utf8').trim().split('\n'), ['start', 'end', 'start', 'end', 'start', 'end', 'start', 'end']);
    assert.equal(walletExecutionView(wallet, { root }).blocked, true, 'reconciliation reads never clear unknown transactions');
    await assert.rejects(withWalletExecution(wallet, async () => {}, { root }), /先核对/);
  } finally { crash.process.kill('SIGKILL'); await crash.done; rmSync(root, { recursive: true, force: true }); }
});

test('PID reuse does not make a stale transaction appear active', async () => {
  const root = temp(), wallet = normalizeWalletConfig(legacy()).wallets[0];
  try {
    const directory = join(root, 'data', 'wallet_runtime'), key = createHash('sha256').update('56:' + wallet.address.toLowerCase()).digest('hex');
    mkdirSync(join(directory, key + '.lock'), { recursive: true });
    writeFileSync(join(directory, key + '.lock', 'owner.json'), JSON.stringify({ pid: process.pid, processStart: 'a different process start', token: 'previous-owner' }));
    writeFileSync(join(directory, key + '.json'), JSON.stringify({ pid: process.pid, processStart: 'a different process start', phase: 'running', kind: 'transaction' }));
    assert.equal(walletExecutionView(wallet, { root }).busy, false);
    assert.equal(walletExecutionView(wallet, { root }).blocked, true);
    await withWalletExecution(wallet, async () => {}, { root, kind: 'reconcile', allowBlocked: true });
    assert.equal(walletExecutionView(wallet, { root }).blocked, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('budget reservations atomically enforce wallet and portfolio caps across processes', async () => {
  const root = temp(), config = normalizeWalletConfig(legacy()); config.portfolioBudget.maxBnbPerDay = .015;
  const script = `import {createWalletBudget,bnbToWei} from ${JSON.stringify(budgetUrl)};try{const config=JSON.parse(process.env.TASK_CONFIG);await createWalletBudget({root:process.env.TASK_ROOT}).reserve({config,wallet:config.wallets[Number(process.env.TASK_INDEX)],amountWei:bnbToWei(.01)});console.log('reserved');}catch(error){console.log('blocked');}`;
  try {
    const results = await Promise.all([0, 1].map(index => child(script, { TASK_ROOT: root, TASK_CONFIG: JSON.stringify(config), TASK_INDEX: String(index) }).done));
    assert.deepEqual(results.map(result => result.output.trim()).sort(), ['blocked', 'reserved']);
    const view = await createWalletBudget({ root }).view(config);
    assert.equal(view.portfolio.reservedWei, bnbToWei(.01));
    assert.equal(view.portfolio.remainingWei, bnbToWei(.005));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('budget migration, settlement, restart and midnight retain the correct wallet allowance', async () => {
  const root = temp(), config = normalizeWalletConfig(legacy());
  let time = Date.parse('2026-11-01T10:00:00Z');
  const budget = createWalletBudget({ root, now: () => time }), [a, b] = config.wallets;
  try {
    mkdirSync(join(root, 'data'), { recursive: true });
    writeFileSync(join(root, 'data', 'watch_state.json'), JSON.stringify({ paidSpend: { day: '2026-11-01', 'alpha.ai': .2, 'beta.ai': .1 } }));
    const initial = await budget.view(config);
    assert.equal(initial.wallets[a.id].spentWei, bnbToWei(.2));
    a.name = '新别名'; config.wallets.reverse();
    assert.equal((await budget.view(config)).wallets[a.id].spentWei, bnbToWei(.2));
    const pending = await budget.reserve({ wallet: a, config, id: 'pending-1', amountWei: bnbToWei(.3) });
    await budget.reserve({ wallet: a, config, id: 'pending-1', amountWei: bnbToWei(.3) });
    await assert.rejects(budget.reserve({ wallet: a, config, amountWei: bnbToWei(.6) }), /每日/);
    const known = await budget.reserve({ wallet: b, config, amountWei: bnbToWei(.2) });
    await budget.settle(known.id); await budget.settle(known.id);
    assert.equal((await budget.view(config)).wallets[b.id].spentWei, bnbToWei(.3));
    await assert.rejects(budget.release(known.id), /已花费/);
    time = Date.parse('2026-11-02T10:00:00Z');
    const restarted = createWalletBudget({ root, now: () => time });
    const tomorrow = await restarted.view(config);
    assert.equal(tomorrow.wallets[a.id].spentWei, '0');
    assert.equal(tomorrow.wallets[a.id].reservedWei, bnbToWei(.3));
    await restarted.release(pending.id);
    assert.equal((await restarted.view(config)).wallets[a.id].reservedWei, '0');
    config.portfolioBudget.maxBnbPerDay = 0;
    await assert.rejects(restarted.reserve({ wallet: b, config, amountWei: '1' }), /总额度/);
    assert.equal(bnbToWei(.0000001), '100000000000');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
