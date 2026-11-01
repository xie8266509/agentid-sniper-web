import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, symlinkSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireWalletFileLock, acquireWalletMaintenance, assertWalletMaintenanceIdle, markWalletBlocked, walletRuntimeDirectory, withWalletExecution } from '../lib/wallet-executor.mjs';

const A = { id: 'fixture-a', address: '0x' + '1'.repeat(40) }, B = { id: 'fixture-b', address: '0x' + '2'.repeat(40) };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const key = wallet => createHash('sha256').update('56:' + wallet.address.toLowerCase()).digest('hex');
function fixture(t) { const root = mkdtempSync(join(tmpdir(), 'fixture-maintenance-')); t.after(() => rmSync(root, { recursive: true, force: true })); const directory = walletRuntimeDirectory(root); return { root, directory, file: join(directory, 'maintenance.json') }; }
function put(path, value) { writeFileSync(path, JSON.stringify(value), { mode: 0o600 }); }
function child(code) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'pipe'] }); let output = '', error = '';
  child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { error += data; });
  return new Promise((resolve, reject) => { child.once('error', reject); child.once('close', status => resolve({ status, output, error })); });
}

test('maintenance holds every configured wallet lock and blocks independent local wallet processes', async t => {
  const h = fixture(t), release = await acquireWalletMaintenance([A, B, A], { root: h.root, idleMs: 0 });
  try {
    assert.throws(() => assertWalletMaintenanceIdle(h.root), /维护更新/);
    for (const wallet of [A, B]) await assert.rejects(acquireWalletFileLock(join(h.directory, key(wallet) + '.lock'), { timeoutMs: 0 }), /其他任务/);
    await assert.rejects(withWalletExecution(A, () => { throw new Error('must not run'); }, { root: h.root }), /维护更新/);
    const url = new URL('../lib/wallet-executor.mjs', import.meta.url).href;
    const result = await child(`import {withWalletExecution} from ${JSON.stringify(url)}; try { await withWalletExecution(${JSON.stringify(B)},()=>console.log('BROADCAST'),{root:${JSON.stringify(h.root)}}); process.exitCode=9; } catch(e) { console.log(e.status); }`);
    assert.equal(result.status, 0); assert.equal(result.output.trim(), '409'); assert.equal(result.error, '');
    if (process.platform !== 'win32') assert.equal((await import('node:fs')).statSync(h.file).mode & 0o777, 0o600);
  } finally { release(); release(); }
  assert.equal(JSON.parse(readFileSync(h.file)).owner, null);
  await withWalletExecution(A, () => {}, { root: h.root });
});

test('busy wallet defers maintenance without waiting or interrupting the current operation', async t => {
  const h = fixture(t), entered = deferred(), done = deferred(); let finished = false;
  const running = withWalletExecution(B, async () => { entered.resolve(); await done.promise; finished = true; }, { root: h.root });
  await entered.promise;
  const before = Date.now(); await assert.rejects(acquireWalletMaintenance([A, B], { root: h.root, idleMs: 0 }), /其他任务|尚未核对/);
  assert.ok(Date.now() - before < 1500); assert.equal(finished, false); assert.doesNotThrow(() => assertWalletMaintenanceIdle(h.root));
  const unlock = await acquireWalletFileLock(join(h.directory, key(A) + '.lock'), { timeoutMs: 0 }); unlock();
  done.resolve(); await running; assert.equal(finished, true);
});

test('blocked, interrupted and malformed wallet journals prevent maintenance', async t => {
  const h = fixture(t); await markWalletBlocked(A, 'mock unresolved submission', { root: h.root });
  await assert.rejects(acquireWalletMaintenance([A], { root: h.root, idleMs: 0 }), /尚未核对/);
  const journal = join(h.directory, key(A) + '.json');
  put(journal, { phase: 'running', kind: 'manual', pid: 2147483647 });
  await assert.rejects(acquireWalletMaintenance([A], { root: h.root, idleMs: 0 }), /尚未核对/);
  writeFileSync(journal, 'mock malformed json');
  await assert.rejects(acquireWalletMaintenance([A], { root: h.root, idleMs: 0 }), /记录损坏/);
  assert.doesNotThrow(() => assertWalletMaintenanceIdle(h.root));
});

test('a maintenance epoch rejects queued pre-update work while new explicit work can run', async t => {
  const h = fixture(t), entered = deferred(), finish = deferred(); let queuedRan = false;
  const first = withWalletExecution(A, async () => { entered.resolve(); await finish.promise; }, { root: h.root }); await entered.promise;
  const queued = withWalletExecution(A, () => { queuedRan = true; }, { root: h.root });
  // A deferred maintenance attempt still changes its barrier generation. Old
  // queued callbacks must re-enter explicitly instead of crossing that attempt.
  await assert.rejects(acquireWalletMaintenance([A], { root: h.root, idleMs: 0 }), /其他任务/); finish.resolve(); await first;
  await assert.rejects(queued, /版本已变化/); assert.equal(queuedRan, false);
  await withWalletExecution(A, () => { queuedRan = true; }, { root: h.root }); assert.equal(queuedRan, true);
});

test('stale barrier owners are reclaimed exclusively and do not block future wallet work forever', async t => {
  const h = fixture(t); put(h.file, { version: 1, epoch: 'a'.repeat(36), owner: { pid: 2147483647, processStart: null, token: 'b'.repeat(36), startedAt: 1 } });
  mkdirSync(join(h.directory, 'maintenance.lock')); put(join(h.directory, 'maintenance.lock', 'owner.json'), { pid: 2147483647, token: 'fixture-dead-owner' });
  assert.doesNotThrow(() => assertWalletMaintenanceIdle(h.root));
  const release = await acquireWalletMaintenance([A], { root: h.root, idleMs: 0 }); assert.throws(() => assertWalletMaintenanceIdle(h.root), /维护更新/);
  await assert.rejects(acquireWalletMaintenance([B], { root: h.root, idleMs: 0 }), /其他任务/); release();
  assert.notEqual(JSON.parse(readFileSync(h.file)).epoch, 'a'.repeat(36));
});

test('unsafe maintenance files fail closed without overwriting an outside file', async t => {
  const h = fixture(t), outside = join(h.root, 'fixture-outside.json'); writeFileSync(outside, 'mock sentinel'); symlinkSync(outside, h.file);
  assert.throws(() => assertWalletMaintenanceIdle(h.root), /不安全/); await assert.rejects(acquireWalletMaintenance([A], { root: h.root, idleMs: 0 }), /不安全/); assert.equal(readFileSync(outside, 'utf8'), 'mock sentinel');
  rmSync(h.file); put(h.file, { version: 1, epoch: 'invalid', owner: null }); assert.throws(() => assertWalletMaintenanceIdle(h.root), /格式无效/);
  writeFileSync(h.file, 'fixture invalid json'); assert.throws(() => assertWalletMaintenanceIdle(h.root), /损坏/);
  put(h.file, { version: 1, epoch: 'a'.repeat(36), owner: null });
  if (process.platform !== 'win32') { chmodSync(h.file, 0o644); assert.throws(() => assertWalletMaintenanceIdle(h.root), /不安全/); }
});

test('failed partial acquisition releases its own barrier and prior wallet locks', async t => {
  const h = fixture(t), sorted = [A, B].sort((a, b) => key(a).localeCompare(key(b))), locked = sorted[1];
  const unlock = await acquireWalletFileLock(join(h.directory, key(locked) + '.lock'), { timeoutMs: 0 });
  try { await assert.rejects(acquireWalletMaintenance(sorted, { root: h.root, idleMs: 0 }), /其他任务/); } finally { unlock(); }
  const release = await acquireWalletMaintenance(sorted, { root: h.root, idleMs: 0 }); release();
  assert.equal(existsSync(join(h.directory, 'maintenance.lock')), false); assert.doesNotThrow(() => assertWalletMaintenanceIdle(h.root));
});


test('maintenance also protects removed-wallet journals and lock owners absent from current config', async t => {
  const h = fixture(t), orphan = 'c'.repeat(64), journal = join(h.directory, orphan + '.json'), lock = join(h.directory, orphan + '.lock');
  put(journal, { phase: 'blocked', blocked: { reason: 'mock unresolved old wallet' } });
  await assert.rejects(acquireWalletMaintenance([], { root: h.root, idleMs: 0 }), /尚未核对/);
  put(journal, { phase: 'idle' });
  const release = await acquireWalletMaintenance([], { root: h.root, idleMs: 0 });
  await assert.rejects(acquireWalletFileLock(lock, { timeoutMs: 0 }), /其他任务/); release();
  rmSync(journal);
  const unlock = await acquireWalletFileLock(lock, { timeoutMs: 0 });
  try { await assert.rejects(acquireWalletMaintenance([], { root: h.root, idleMs: 0 }), /其他任务/); } finally { unlock(); }
  writeFileSync(journal, 'mock corrupt orphan'); await assert.rejects(acquireWalletMaintenance([], { root: h.root, idleMs: 0 }), /记录损坏/);
});


test('restarting or failed health blocks all processes even if the restart worker has died', async t => {
  const h = fixture(t), health = join(h.root, 'data/local_updates/restart-health.json'); mkdirSync(join(health, '..'), { recursive: true });
  const url = new URL('../lib/wallet-executor.mjs', import.meta.url).href;
  for (const phase of ['restarting', 'failed']) for (const workerPid of [process.pid, 2147483647]) {
    put(health, { phase, targetCommit: 'a'.repeat(40), workerPid });
    assert.throws(() => assertWalletMaintenanceIdle(h.root), /恢复尚未完成/);
    await assert.rejects(acquireWalletMaintenance([A], { root: h.root, idleMs: 0 }), /恢复尚未完成/);
    const result = await child(`import {withWalletExecution} from ${JSON.stringify(url)}; try {await withWalletExecution(${JSON.stringify(A)},()=>console.log('BROADCAST'),{root:${JSON.stringify(h.root)}});process.exitCode=9;}catch(e){console.log(e.status);}`);
    assert.equal(result.status, 0); assert.equal(result.output.trim(), '409');
  }
  for (const phase of ['verified', 'rolled-back']) { put(health, { phase, targetCommit: 'a'.repeat(40) }); assert.doesNotThrow(() => assertWalletMaintenanceIdle(h.root)); await withWalletExecution(A, () => {}, { root: h.root }); }
  writeFileSync(health, 'mock corrupted health'); assert.throws(() => assertWalletMaintenanceIdle(h.root), /状态损坏/);
  put(health, { phase: 'unknown', targetCommit: 'a'.repeat(40) }); assert.throws(() => assertWalletMaintenanceIdle(h.root), /格式无效/);
  rmSync(health); const outside = join(h.root, 'fixture-health.json'); put(outside, { phase: 'verified', targetCommit: 'a'.repeat(40) }); symlinkSync(outside, health); assert.throws(() => assertWalletMaintenanceIdle(h.root), /路径不安全/);
});


test('interrupted source replacement blocks wallet execution until updater recovery completes', async t => {
  const h = fixture(t), status = join(h.root, 'data/local_updates/status.json'); mkdirSync(join(status, '..'), { recursive: true });
  for (const value of [{ phase: 'applying' }, { phase: 'rolling-back' }, { phase: 'failed', interrupted: true }]) {
    put(status, value); assert.throws(() => assertWalletMaintenanceIdle(h.root), /尚未恢复/); await assert.rejects(withWalletExecution(A, () => {}, { root: h.root }), /尚未恢复/);
  }
  for (const phase of ['checking', 'preparing', 'testing', 'succeeded', 'rolled-back']) { put(status, { phase }); assert.doesNotThrow(() => assertWalletMaintenanceIdle(h.root)); }
  writeFileSync(status, 'mock corrupted update state'); assert.throws(() => assertWalletMaintenanceIdle(h.root), /任务状态损坏/);
});

test('maintenance waits for recent external wallet journals including removed profiles', async t => {
  const h = fixture(t), journal = join(h.directory, 'e'.repeat(64) + '.json');
  put(journal, { phase: 'idle', updatedAt: 100000 });
  await assert.rejects(acquireWalletMaintenance([], { root: h.root, now: () => 159999 }), /近期仍有活动/);
  const release = await acquireWalletMaintenance([], { root: h.root, now: () => 160000 }); release();
  put(journal, { phase: 'idle', updatedAt: 999999 }); await assert.rejects(acquireWalletMaintenance([], { root: h.root, now: () => 160000 }), /近期仍有活动/);
});

test('a deferred maintenance probe never interrupts nested calls inside an admitted wallet operation', async t => {
  const h = fixture(t), entered = deferred(), proceed = deferred(); let nested = 0;
  const sorted = [A, B].sort((a, b) => key(a).localeCompare(key(b))), active = sorted[1];
  const task = withWalletExecution(active, async () => {
    entered.resolve(); await proceed.promise;
    for (let i = 0; i < 20; i++) { await withWalletExecution(active, () => { nested++; }, { root: h.root }); await Promise.resolve(); }
  }, { root: h.root });
  await entered.promise;
  const maintenance = acquireWalletMaintenance(sorted, { root: h.root, idleMs: 0 });
  proceed.resolve(); await assert.rejects(maintenance, /其他任务|尚未核对/); await task;
  assert.equal(nested, 20); assert.doesNotThrow(() => assertWalletMaintenanceIdle(h.root));
});

test('a wallet callback waiting for a portfolio slot cannot cross a maintenance generation', async t => {
  const h = fixture(t), unlockSlot = await acquireWalletFileLock(join(h.directory, 'slots/0.lock'), { timeoutMs: 0 }); let invoked = false;
  const task = withWalletExecution(A, () => { invoked = true; }, { root: h.root, maxConcurrent: 1 });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(existsSync(join(h.directory, key(A) + '.lock')), true);
  await assert.rejects(acquireWalletMaintenance([A], { root: h.root, idleMs: 0 }), /其他任务/);
  unlockSlot(); await assert.rejects(task, /版本已变化/); assert.equal(invoked, false);
});
