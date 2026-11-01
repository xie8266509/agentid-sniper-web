import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, symlinkSync, chmodSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createIdleUpdates, assertIdleData } from '../lib/idle-updates.mjs';
import { createLocalUpdater } from '../lib/local-updater.mjs';

const target = 'b'.repeat(40), current = 'a'.repeat(40), another = 'c'.repeat(40);
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const blocked = message => Object.assign(new Error(message), { status: 409, idleDeferred: true });
function fixture(t, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'fixture-idle-updates-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  let now = 1000, idleError = null, update = { available: true, latest: { commit: target }, current: { commit: current }, phase: 'ready' };
  const calls = { view: 0, idle: [], install: [] }, file = join(root, 'data/local_updates/idle-settings.json');
  const options = { root, now: () => now, getUpdateView: async () => { calls.view++; return structuredClone(update); }, assertIdle: async input => { calls.idle.push(input); if (idleError) throw idleError; }, install: async input => { calls.install.push(input); }, ...overrides };
  const worker = createIdleUpdates(options);
  return { root, file, calls, worker, options, setTime: v => { now = v; }, setError: v => { idleError = v; }, setUpdate: v => { update = { ...update, ...v }; } };
}
const put = (root, name, value) => { const file = join(root, name); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 }); return file; };

test('idle install defaults off and saving preference never starts an update or touches trading config', async t => {
  const h = fixture(t); put(h.root, 'config.json', 'mock config sentinel');
  assert.equal(h.worker.view().enabled, false); assert.equal(existsSync(h.file), false);
  await h.worker.tick(); assert.equal(h.calls.view, 0); assert.deepEqual(h.calls.install, []);
  h.worker.configure({ enabled: true }); assert.equal(h.worker.view().enabled, true); assert.deepEqual(h.calls.install, []); assert.equal(h.calls.view, 0);
  assert.equal(readFileSync(join(h.root, 'config.json'), 'utf8'), 'mock config sentinel');
  if (process.platform !== 'win32') assert.equal(statSync(h.file).mode & 0o777, 0o600);
  for (const invalid of [{ enabled: 'true' }, { enabled: 1 }, {}, { enabled: true, targetCommit: target }]) assert.throws(() => h.worker.configure(invalid), /enabled/);
});

test('a stable exact release installs only after sixty seconds of verified idle time', async t => {
  const h = fixture(t); h.worker.configure({ enabled: true }); await h.worker.tick();
  h.setTime(60999); await h.worker.tick(); assert.equal(h.calls.install.length, 0);
  h.setTime(61000); await h.worker.tick(); assert.deepEqual(h.calls.install, [{ targetCommit: target }]); assert.equal(h.calls.idle.length, 3);
  assert.equal(h.worker.view().lastAttempt.phase, 'succeeded');
  h.setTime(121000); await h.worker.tick(); assert.equal(h.calls.install.length, 1);
});

test('a busy interval or a changed release resets the continuous-idle countdown', async t => {
  const h = fixture(t); h.worker.configure({ enabled: true }); await h.worker.tick();
  h.setTime(60000); h.setError(blocked('mock wallet busy')); await h.worker.tick(); assert.equal(h.worker.view().lastAttempt, null);
  h.setTime(61000); h.setError(null); await h.worker.tick(); h.setTime(120999); await h.worker.tick(); assert.equal(h.calls.install.length, 0);
  h.setUpdate({ latest: { commit: another } }); h.setTime(121000); await h.worker.tick(); assert.equal(h.calls.install.length, 0);
  h.setTime(181000); await h.worker.tick(); assert.deepEqual(h.calls.install, [{ targetCommit: another }]);
});

test('busy, failed, invalid or already-current release views cannot reach installation', async t => {
  const h = fixture(t); h.worker.configure({ enabled: true });
  for (const update of [{ busy: true }, { error: 'mock failed check' }, { phase: 'manual-review' }, { phase: 'restarting' }, { latest: { commit: 'main' } }, { available: false }, { latest: { commit: current } }]) {
    h.setUpdate({ available: true, latest: { commit: target }, current: { commit: current }, phase: 'ready', busy: false, error: null, ...update });
    await h.worker.tick(); h.setTime(200000); await h.worker.tick(); assert.equal(h.calls.install.length, 0);
  }
});

test('one failed target remains paused across process recreation and preference toggles', async t => {
  const h = fixture(t, { install: async () => { throw new Error('mock install failure'); } }); h.worker.configure({ enabled: true }); await h.worker.tick(); h.setTime(61000); await h.worker.tick();
  assert.equal(h.worker.view().lastAttempt.targetCommit, target); assert.equal(h.worker.view().lastAttempt.phase, 'failed');
  const again = createIdleUpdates(h.options); again.configure({ enabled: false }); again.configure({ enabled: true });
  h.setTime(500000); await again.tick(); h.setTime(600000); await again.tick(); assert.equal(again.view().lastAttempt.phase, 'failed'); assert.equal(again.view().lastAttempt.targetCommit, target);
  let installed = 0; const next = createIdleUpdates({ ...h.options, install: async () => { installed++; } }); h.setUpdate({ latest: { commit: another } }); await next.tick(); h.setTime(660000); await next.tick(); assert.equal(installed, 1);
});

test('a temporary admission race does not consume a target or erase a previous failed attempt', async t => {
  let defer = true;
  const h = fixture(t, { install: async input => { h.calls.install.push(input); if (defer) throw blocked('mock wallet claimed lock'); } });
  h.worker.configure({ enabled: true });
  const previous = { targetCommit: another, phase: 'failed', startedAt: 0 }; writeFileSync(h.file, JSON.stringify({ version: 1, enabled: true, lastAttempt: previous }));
  await h.worker.tick(); h.setTime(61000); await h.worker.tick(); assert.deepEqual(h.worker.view().lastAttempt, previous);
  defer = false; h.setTime(121000); await h.worker.tick(); h.setTime(181000); await h.worker.tick(); assert.equal(h.calls.install.length, 2); assert.equal(h.worker.view().lastAttempt.phase, 'succeeded');
});

test('overlapping ticks join one installation and durable installing intent blocks a second worker', async t => {
  const gate = deferred(), entered = deferred(); let installs = 0;
  const h = fixture(t, { install: async () => { installs++; entered.resolve(); await gate.promise; } }); h.worker.configure({ enabled: true }); await h.worker.tick(); h.setTime(61000);
  const first = h.worker.tick(); await entered.promise; const second = h.worker.tick();
  assert.equal(h.worker.view().lastAttempt.phase, 'installing'); const anotherWorker = createIdleUpdates(h.options); await anotherWorker.tick(); assert.equal(installs, 1);
  gate.resolve(); await Promise.all([first, second]); assert.equal(installs, 1); assert.equal(h.worker.view().lastAttempt.phase, 'succeeded');
});

test('disabling while readiness is awaiting prevents the update from being admitted', async t => {
  const gate = deferred(), entered = deferred(); let wait = false;
  const h = fixture(t, { assertIdle: async () => { if (wait) { entered.resolve(); await gate.promise; } } }); h.worker.configure({ enabled: true }); await h.worker.tick(); h.setTime(61000); wait = true;
  const tick = h.worker.tick(); await entered.promise; h.worker.configure({ enabled: false }); gate.resolve(); await tick;
  assert.equal(h.calls.install.length, 0); assert.equal(h.worker.view().lastAttempt, null); assert.equal(h.worker.view().enabled, false);
});

test('malformed, permissive or symlinked settings cannot enable installation or overwrite an outside file', async t => {
  const h = fixture(t); h.worker.configure({ enabled: true });
  for (const invalid of ['mock broken json', JSON.stringify({ version: 1, enabled: true, lastAttempt: { targetCommit: 'main', phase: 'failed', startedAt: 1 } })]) {
    writeFileSync(h.file, invalid); await h.worker.tick(); assert.equal(h.worker.view().enabled, false); assert.equal(h.calls.install.length, 0); assert.throws(() => h.worker.configure({ enabled: true }));
  }
  writeFileSync(h.file, JSON.stringify({ version: 1, enabled: true, lastAttempt: null }));
  if (process.platform !== 'win32') { chmodSync(h.file, 0o644); await h.worker.tick(); assert.equal(h.worker.view().enabled, false); }
  rmSync(h.file); const outside = put(h.root, 'fixture-outside.json', 'mock private sentinel'); symlinkSync(outside, h.file); await h.worker.tick(); assert.equal(h.worker.view().enabled, false); assert.throws(() => h.worker.configure({ enabled: true })); assert.equal(readFileSync(outside, 'utf8'), 'mock private sentinel');
});

test('durable mint, ERC20 sell, budget reservation and NFT orders each block idle installation', t => {
  const h = fixture(t); assert.doesNotThrow(() => assertIdleData(h.root, [], { idleMs: 0 }));
  const cases = [
    ['data/watch_state.json', { walletPending: { fixture: { phase: 'pending' } } }],
    ...['pendingSell', 'submissionIntent', 'sellReviewRequired'].map(flag => ['data/watch_state.json', { tokens: { fixture: { [flag]: true } } }]),
    ['data/wallet_runtime/budget.json', { version: 1, reservations: { fixture: { status: 'reserved' } } }],
    ...['intent', 'signing', 'signature-pending', 'publishing', 'listed', 'submitting', 'pending', 'review'].map(phase => ['data/nft_trading_state.json', { version: 1, states: { fixture: { phase } } }]),
    ['data/nft_trading_state.json', { version: 1, states: { fixture: { phase: 'idle', effectIntent: {} } } }],
  ];
  for (const [name, value] of cases) { const file = put(h.root, name, value); assert.throws(() => assertIdleData(h.root, [], { idleMs: 0 }), error => error.status === 409 && error.idleDeferred === true, name); rmSync(file); }
  put(h.root, 'data/watch_state.json', { tokens: { fixture: { cost: 1, stage: 0 } } }); put(h.root, 'data/wallet_runtime/budget.json', { version: 1, reservations: { fixture: { status: 'settled' } } }); put(h.root, 'data/nft_trading_state.json', { version: 1, states: { fixture: { phase: 'filled' } } }); assert.doesNotThrow(() => assertIdleData(h.root, [], { idleMs: 0 }));
});

test('unreadable or corrupt durable state defers installation without a guessed empty state', t => {
  const h = fixture(t);
  for (const name of ['data/watch_state.json', 'data/wallet_runtime/budget.json', 'data/nft_trading_state.json']) { const file = put(h.root, name, 'mock broken state'); assert.throws(() => assertIdleData(h.root, [], { idleMs: 0 }), /损坏/); rmSync(file); }
  const outside = put(h.root, 'fixture-outside.json', '{}'); const file = put(h.root, 'data/watch_state.json', '{}'); rmSync(file); symlinkSync(outside, file); assert.throws(() => assertIdleData(h.root, [], { idleMs: 0 }), /符号链接/);
});

test('source idleness includes cached index changes even when the working file equals HEAD', async t => {
  const h = fixture(t), git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: h.root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-b', 'main'); git('config', 'user.name', 'Fixture Idle'); git('config', 'user.email', 'fixture@example.invalid');
  put(h.root, '.gitignore', 'data/\n'); put(h.root, 'watch.mjs', 'export const fixture = 1;\n'); git('add', '.'); git('commit', '-m', 'fixture baseline');
  const updater = createLocalUpdater({ root: h.root }); await updater.assertSourceClean();
  put(h.root, 'watch.mjs', 'export const fixture = 2;\n'); git('add', 'watch.mjs'); put(h.root, 'watch.mjs', 'export const fixture = 1;\n'); assert.equal(git('diff', '--name-only', 'HEAD').trim(), '');
  await assert.rejects(updater.assertSourceClean(), error => error.idleDeferred === true);
  git('reset', '--mixed', 'HEAD'); put(h.root, 'lib/fixture-untracked.mjs', 'export const fixture = true;'); await assert.rejects(updater.assertSourceClean(), /源码|暂存区/);
});


test('recent and future scanner heartbeat timestamps postpone installation after scanner exit', t => {
  const h = fixture(t), clock = Date.now(), file = put(h.root, 'data/watch_heartbeat.txt', 'mock stopped scanner heartbeat');
  utimesSync(file, new Date(clock - 30000), new Date(clock - 30000)); assert.throws(() => assertIdleData(h.root, [], { now: () => clock }), /最近仍有活动/);
  utimesSync(file, new Date(clock - 60001), new Date(clock - 60001)); assert.doesNotThrow(() => assertIdleData(h.root, [], { now: () => clock }));
  utimesSync(file, new Date(clock + 60000), new Date(clock + 60000)); assert.throws(() => assertIdleData(h.root, [], { now: () => clock }), /最近仍有活动/);
});

test('two workers released from readiness simultaneously claim one durable target intent', async t => {
  const readiness = deferred(), bothReady = deferred(), installed = deferred(), finishInstall = deferred(); let gated = false, readyCount = 0, installs = 0;
  const h = fixture(t, { assertIdle: async () => { if (gated) { readyCount++; if (readyCount === 2) bothReady.resolve(); await readiness.promise; } }, install: async () => { installs++; installed.resolve(); await finishInstall.promise; } });
  h.worker.configure({ enabled: true }); const other = createIdleUpdates(h.options);
  await Promise.all([h.worker.tick(), other.tick()]); h.setTime(61000); gated = true;
  const first = h.worker.tick(), second = other.tick(); await bothReady.promise; readiness.resolve(); await installed.promise;
  assert.equal(h.worker.view().lastAttempt.phase, 'installing'); finishInstall.resolve(); await Promise.all([first, second]);
  assert.equal(installs, 1); assert.equal(h.worker.view().lastAttempt.targetCommit, target); assert.equal(h.worker.view().lastAttempt.phase, 'succeeded');
});
