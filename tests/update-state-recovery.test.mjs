import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createLocalUpdater } from '../lib/local-updater.mjs';
import { assertWalletMaintenanceIdle } from '../lib/wallet-executor.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'fixture-update-state-recovery-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['--no-optional-locks', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'main'); git('config', 'user.name', 'Fixture Recovery'); git('config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(root, '.gitignore'), 'data/\n');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '0.4.0' }));
  writeFileSync(join(root, 'release-config.json'), JSON.stringify({ schemaVersion: 1, repository: 'xie8266509/agentid-sniper-web', channel: 'stable', upstream: { repository: 'nancyc0813-maker/agentid-sniper', version: '2.7.6', commit: 'a'.repeat(40) } }));
  git('add', '.'); git('commit', '-m', 'fixture recovery baseline'); git('remote', 'add', 'origin', 'https://github.com/xie8266509/agentid-sniper-web.git');
  const directory = join(root, 'data/local_updates'), status = join(directory, 'status.json'); mkdirSync(directory, { recursive: true, mode: 0o700 });
  let networkReads = 0;
  return { root, directory, status, put(value) { writeFileSync(status, value, { mode: 0o600 }); }, updater(options = {}) { return createLocalUpdater({ root, fetchLatest: async () => { networkReads++; return null; }, ...options }); }, networkReads: () => networkReads };
}
async function checkWithoutClearing(updater) {
  try { await updater.check(); } catch { /* A rejected check may not replace uncertain state. */ }
  const view = await updater.view();
  assert.equal(view.available, false);
  assert.ok(['manual-review', 'failed'].includes(view.phase));
  assert.ok(view.error || view.blockedReason, 'uncertain persisted state needs an actionable review reason');
}

test('a missing update state is initialized normally, but corrupt or non-object state is never guessed empty', async t => {
  const healthy = fixture(t), first = healthy.updater(); t.after(() => first.stop());
  assert.equal((await first.check()).phase, 'idle'); assert.doesNotThrow(() => assertWalletMaintenanceIdle(healthy.root));
  for (const body of ['mock crash truncated json', '[]', 'null', 'true']) {
    const h = fixture(t); h.put(body); const updater = h.updater(); t.after(() => updater.stop());
    assert.throws(() => assertWalletMaintenanceIdle(h.root));
    await checkWithoutClearing(updater);
    assert.equal(readFileSync(h.status, 'utf8'), body, 'automatic checking must preserve the original uncertain evidence');
    assert.equal(h.networkReads(), 0, 'a corrupt status cannot be replaced by a successful latest response');
    assert.throws(() => assertWalletMaintenanceIdle(h.root));
  }
});

test('uncertain state appearing after updater creation survives view, check, update and health persistence', async t => {
  const h = fixture(t), updater = h.updater(); t.after(() => updater.stop());
  await updater.check(); assert.equal(h.networkReads(), 1);
  const body = 'mock late interrupted write'; h.put(body);
  await checkWithoutClearing(updater);
  await assert.rejects(updater.update({ targetCommit: 'b'.repeat(40) }));
  try { updater.markRestartResult({ success: true }); } catch { /* Refusing the write is safe. */ }
  assert.equal(readFileSync(h.status, 'utf8'), body);
  assert.equal(h.networkReads(), 1); assert.throws(() => assertWalletMaintenanceIdle(h.root));
});

test('an update-state symlink is preserved and cannot turn into a fresh successful status', async t => {
  const h = fixture(t), outside = join(h.root, 'fixture-outside-status.json'), body = 'mock private recovery evidence';
  writeFileSync(outside, body, { mode: 0o600 }); symlinkSync(outside, h.status);
  const updater = h.updater(); t.after(() => updater.stop());
  await checkWithoutClearing(updater);
  try { updater.markRestartResult({ success: true }); } catch {}
  assert.equal(readFileSync(outside, 'utf8'), body); assert.equal(lstatSync(h.status).isSymbolicLink(), true);
  assert.equal(h.networkReads(), 0); assert.throws(() => assertWalletMaintenanceIdle(h.root));
});

test('late symlink replacement cannot be overwritten by a previously healthy updater instance', async t => {
  const h = fixture(t), updater = h.updater(); t.after(() => updater.stop()); await updater.check();
  const outside = join(h.root, 'fixture-outside-late-status.json'), body = 'mock late recovery evidence'; writeFileSync(outside, body, { mode: 0o600 }); rmSync(h.status); symlinkSync(outside, h.status);
  await checkWithoutClearing(updater);
  try { updater.markRestartResult({ success: false, error: 'mock restart failure' }); } catch {}
  assert.equal(readFileSync(outside, 'utf8'), body); assert.equal(lstatSync(h.status).isSymbolicLink(), true); assert.equal(h.networkReads(), 1);
  assert.throws(() => assertWalletMaintenanceIdle(h.root));
});

test('a dangling update-state symlink is not mistaken for an absent status file', async t => {
  const h = fixture(t), missing = join(h.root, 'fixture-missing-status.json'); symlinkSync(missing, h.status);
  const updater = h.updater(); t.after(() => updater.stop());
  await checkWithoutClearing(updater);
  assert.equal(lstatSync(h.status).isSymbolicLink(), true); assert.equal(h.networkReads(), 0); assert.throws(() => assertWalletMaintenanceIdle(h.root));
});

test('state corrupted during an awaited latest read cannot be overwritten by final persistence', async t => {
  const h = fixture(t), body = 'mock interruption during network await'; let fetches = 0;
  const updater = h.updater({ fetchLatest: async () => { fetches++; await Promise.resolve(); h.put(body); return null; } }); t.after(() => updater.stop());
  await checkWithoutClearing(updater);
  assert.equal(fetches, 1); assert.equal(readFileSync(h.status, 'utf8'), body); assert.throws(() => assertWalletMaintenanceIdle(h.root));
});
