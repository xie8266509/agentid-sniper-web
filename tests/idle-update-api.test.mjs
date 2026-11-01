// Isolated HTTP integration: no GitHub, wallet, scanner or real restart runs.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createApp } from '../server.mjs';
import { DEFAULT_CONFIG, sanitizeConfig, validateConfig } from '../lib/config.mjs';
import { assertWalletMaintenanceIdle } from '../lib/wallet-executor.mjs';

const target = 'b'.repeat(40), current = 'a'.repeat(40), address = '0x' + '1'.repeat(40);
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };
async function fixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'fixture-idle-api-')); let clock = 1000, scanner = false, dirty = false, nftBusy = false;
  const calls = { updates: [], restarts: [], wallet: [], service: [], saves: 0, checks: 0, sourceChecks: 0 }, job = deferred(), entered = deferred();
  const cfg = validateConfig({ ...structuredClone(DEFAULT_CONFIG), wallets: [{ id: 'fixture-wallet', name: 'Fixture Wallet', address, mode: 'monitor', paused: true }] });
  const configBytes = JSON.stringify(cfg); writeFileSync(join(root, 'config.json'), configBytes, { mode: 0o600 });
  let beforeApply;
  const updater = { view: () => ({ phase: 'ready', available: true, current: { commit: current }, latest: { commit: target } }), check: async () => { calls.checks++; }, isBusy: () => false, start() {}, stop() {},
    assertSourceClean: async () => { calls.sourceChecks++; if (dirty) throw new Error('mock source dirty'); },
    update: async input => { calls.updates.push(input); if (options.update) return options.update({ input, beforeApply, job, entered }); entered.resolve(); await job.promise; if (options.fail) throw new Error('mock install failure'); return { phase: 'succeeded', targetCommit: target, ...(options.restart ? { needsWebRestart: true, backupId: 'fixture-backup' } : {}) }; }, rollback: async () => { throw new Error('must not rollback implicitly'); } };
  const app = createApp({ root, ...(options.exerciseAdmission ? { createUpdater: input => { beforeApply = input.beforeApply; return updater; } } : { localUpdater: updater }), idleNow: () => clock,
    readConfig: () => structuredClone(cfg), sanitizeConfig, saveConfig: () => { calls.saves++; throw new Error('must not save trading config'); },
    dashboardStatus: async () => ({ service: { running: scanner }, release: { commit: current } }), isScannerActive: async () => scanner,
    runWallet: async args => { calls.wallet.push(args); return { success: true, data: { status: 'UNCONNECTED' } }; }, getCliInfo: () => ({ ready: true, version: 'mock' }),
    controlService: async action => { calls.service.push(action); return {}; }, holdingsData: () => ({}), readLogs: () => ({ lines: [] }),
    nftTrading: { view: () => ({ states: {}, rules: [] }), hasInFlight: () => nftBusy, stop() {}, start() {} },
    restartWeb: async input => { calls.restarts.push(input); },
  });
  app.listen(0, '127.0.0.1'); await once(app, 'listening');
  t.after(async () => { job.resolve(); await flush(); app.closeAllConnections(); await new Promise(resolve => app.close(resolve)); rmSync(root, { recursive: true, force: true }); });
  const base = 'http://127.0.0.1:' + app.address().port, bootstrap = await fetch(base + '/api/bootstrap'), cookie = bootstrap.headers.get('set-cookie').split(';')[0], csrf = (await bootstrap.json()).data.csrfToken;
  const call = async (path, body, headers = {}) => { const r = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf, ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: r.status, ...(await r.json()) }; };
  const put = (name, value) => { const file = join(root, name); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(value), { mode: 0o600 }); return file; };
  return { root, app, base, call, calls, job, entered, put, setClock: value => { clock = value; }, setScanner: value => { scanner = value; }, setDirty: value => { dirty = value; }, setNftBusy: value => { nftBusy = value; }, assertConfigUnchanged: () => assert.equal(readFileSync(join(root, 'config.json'), 'utf8'), configBytes), tick: () => app.checkIdleUpdates() };
}
async function waitIdle(h, first = 61000) { h.setClock(first); await h.tick(); h.setClock(first + 60000); return h.tick(); }

test('idle preferences use existing session/origin/CSRF boundaries and never enable trading', async t => {
  const h = await fixture(t);
  assert.equal((await fetch(h.base + '/api/updates')).status, 401);
  const initial = await h.call('/api/updates'); assert.equal(initial.data.idleUpdates.enabled, false);
  assert.equal(existsSync(join(h.root, 'data/local_updates/idle-settings.json')), false);
  assert.equal((await h.call('/api/updates/settings', { enabled: true }, { 'x-csrf-token': '' })).status, 403);
  assert.equal((await h.call('/api/updates/settings', { enabled: true }, { origin: 'https://hostile.invalid' })).status, 403);
  assert.equal((await h.call('/api/updates/settings', { enabled: 'true' })).status, 409);
  const enabled = await h.call('/api/updates/settings', { enabled: true }); assert.equal(enabled.status, 200); assert.equal(enabled.data.idleUpdates.enabled, true);
  await flush(); assert.deepEqual(h.calls.updates, []); assert.equal(h.calls.checks, 0); assert.deepEqual(h.calls.wallet, []); assert.deepEqual(h.calls.service, []); assert.equal(h.calls.saves, 0); h.assertConfigUnchanged();
});

test('scanner, active NFT work and dirty source defer idle updates without stopping any service', async t => {
  const h = await fixture(t); await h.call('/api/updates/settings', { enabled: true }); h.setClock(61000);
  for (const kind of ['scanner', 'nft', 'source']) {
    h.setScanner(kind === 'scanner'); h.setNftBusy(kind === 'nft'); h.setDirty(kind === 'source'); await h.tick(); h.setClock(500000); await h.tick();
    assert.deepEqual(h.calls.updates, []); assert.equal((await h.call('/api/updates')).data.idleUpdates.lastAttempt, null);
  }
  assert.deepEqual(h.calls.service, []); assert.deepEqual(h.calls.wallet, []); h.assertConfigUnchanged();
});

test('durable pending payment defers an idle update until its state is reconciled', async t => {
  const h = await fixture(t); await h.call('/api/updates/settings', { enabled: true });
  const pending = h.put('data/wallet_runtime/budget.json', { version: 1, reservations: { fixture: { status: 'reserved' } } });
  await waitIdle(h); assert.deepEqual(h.calls.updates, []); assert.equal((await h.call('/api/updates')).data.idleUpdates.lastAttempt, null);
  rmSync(pending); h.setClock(181000); await h.tick(); h.setClock(241000); const task = h.tick(); await h.entered.promise;
  assert.deepEqual(h.calls.updates, [{ targetCommit: target }]); h.job.resolve(); await task; h.assertConfigUnchanged(); assert.deepEqual(h.calls.service, []);
});

test('automatic installation uses the shared admission gate and real maintenance barrier', async t => {
  const h = await fixture(t, { restart: true }); await h.call('/api/updates/settings', { enabled: true });
  h.setClock(61000); await h.tick(); h.setClock(121000); const task = h.tick(); await h.entered.promise;
  assert.throws(() => assertWalletMaintenanceIdle(h.root), /维护更新/);
  for (const [path, body] of [['/api/config', undefined], ['/api/wallet/status', undefined], ['/api/service/start', {}], ['/api/updates/apply', { targetCommit: target, confirmed: true }]]) assert.equal((await h.call(path, body)).status, 409, path);
  assert.equal((await h.call('/api/updates')).status, 200); assert.equal((await h.call('/api/status')).status, 200);
  const disabled = await h.call('/api/updates/settings', { enabled: false }); assert.equal(disabled.status, 200); assert.equal(disabled.data.idleUpdates.enabled, false);
  assert.deepEqual(h.calls.wallet, []); assert.deepEqual(h.calls.service, []); assert.equal(h.calls.updates.length, 1);
  h.job.resolve(); await task; assert.equal(h.calls.restarts.length, 1); assert.equal(h.calls.restarts[0].targetCommit, target); assert.doesNotThrow(() => assertWalletMaintenanceIdle(h.root)); h.assertConfigUnchanged();
});

test('a completed wallet read between polls restarts the idle window', async t => {
  const h = await fixture(t); await h.call('/api/updates/settings', { enabled: true }); h.setClock(61000); await h.tick();
  h.setClock(90000); assert.equal((await h.call('/api/wallet/status?refresh=1')).status, 200);
  h.setClock(121000); await h.tick(); assert.deepEqual(h.calls.updates, []);
  h.setClock(150000); await h.tick(); assert.deepEqual(h.calls.updates, []);
  h.setClock(210000); const task = h.tick(); await h.entered.promise; h.job.resolve(); await task; assert.equal(h.calls.updates.length, 1); assert.equal(h.calls.wallet.length, 1); assert.deepEqual(h.calls.service, []);
});

test('automatic install failure releases the gate and preserves the failed-target marker', async t => {
  const h = await fixture(t, { fail: true }); await h.call('/api/updates/settings', { enabled: true });
  h.setClock(61000); await h.tick(); h.setClock(121000); const task = h.tick(); await h.entered.promise; h.job.resolve(); await task;
  assert.equal((await h.call('/api/config')).status, 200); assert.doesNotThrow(() => assertWalletMaintenanceIdle(h.root));
  const status = await h.call('/api/updates'); assert.equal(status.data.idleUpdates.lastAttempt.phase, 'failed');
  h.setClock(999999); await h.tick(); assert.equal(h.calls.updates.length, 1); assert.equal(h.calls.restarts.length, 0); h.assertConfigUnchanged();
});


test('disabling before source application cancels the actual automatic beforeApply gate', async t => {
  let wroteSource = false;
  const h = await fixture(t, { exerciseAdmission: true, update: async ({ beforeApply, job, entered }) => {
    await beforeApply({ kind: 'prepare', targetCommit: target }); entered.resolve(); await job.promise;
    await beforeApply({ kind: 'apply', targetCommit: target }); wroteSource = true; return {};
  } });
  await h.call('/api/updates/settings', { enabled: true }); h.setClock(61000); await h.tick(); h.setClock(121000); const tick = h.tick(); await h.entered.promise;
  assert.equal((await h.call('/api/updates/settings', { enabled: false })).status, 200); h.job.resolve(); await tick;
  assert.equal(wroteSource, false); const status = await h.call('/api/updates'); assert.equal(status.data.idleUpdates.enabled, false); assert.equal(status.data.idleUpdates.lastAttempt, null);
  assert.equal((await h.call('/api/config')).status, 200); assert.doesNotThrow(() => assertWalletMaintenanceIdle(h.root)); h.assertConfigUnchanged();
});

test('automatic restore is admitted after cancellation and dirty partial source without rechecking install conditions', async t => {
  let restored = false, checksBeforeRollback, h;
  h = await fixture(t, { exerciseAdmission: true, update: async ({ beforeApply, job, entered }) => {
    await beforeApply({ kind: 'prepare', targetCommit: target }); await beforeApply({ kind: 'apply', targetCommit: target }); entered.resolve(); await job.promise;
    checksBeforeRollback = h.calls.sourceChecks; await beforeApply({ kind: 'rollback', targetCommit: current }); restored = true;
    assert.equal(h.calls.sourceChecks, checksBeforeRollback, 'recovery must not require the partially applied source to be clean');
    throw new Error('mock update failed after complete source restoration');
  } });
  await h.call('/api/updates/settings', { enabled: true }); h.setClock(61000); await h.tick(); h.setClock(121000); const tick = h.tick(); await h.entered.promise;
  h.setDirty(true); assert.equal((await h.call('/api/updates/settings', { enabled: false })).status, 200); h.job.resolve(); await tick;
  assert.equal(restored, true); const status = await h.call('/api/updates'); assert.equal(status.data.idleUpdates.enabled, false); assert.equal(status.data.idleUpdates.lastAttempt.phase, 'failed');
  assert.equal((await h.call('/api/config')).status, 200); assert.doesNotThrow(() => assertWalletMaintenanceIdle(h.root)); assert.deepEqual(h.calls.restarts, []); h.assertConfigUnchanged();
});
