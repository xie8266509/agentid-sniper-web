import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../watch.mjs', import.meta.url), 'utf8');
const schedulerSource = source.slice(source.indexOf('let HOLDINGS_SCHEDULER ='), source.indexOf('let lastLoopAt ='));
const mainSource = source.slice(source.indexOf('async function main()'), source.indexOf("process.on('uncaughtException'"));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
async function flush() { for (let index = 0; index < 12; index++) await Promise.resolve(); }

function harness({ fast = false, hold, rpc, scan } = {}) {
  let clock = 1800000000000, stopFile = false;
  class Clock extends Date { static now() { return clock; } }
  const seen = { calls: [], saves: [], logs: [], unrefs: 0, listeners: new Map(), scanCalls: 0, updateChecks: 0 };
  const intervals = new Set();
  const S = { tokens: fast ? { position: { openAt: clock - 1000, stage: 0, done: false } } : {}, holdingsUpdatedAt: 123 };
  const sandbox = {
    Date: Clock, S, RULE: { fastMin: 30 }, DIR: '/isolated', SELF: '/isolated/watch.mjs', SELF_MT: 1, MONITOR_ONLY: true,
    ENTRY_POLICY: { goPct: 0.85, minAgents: 175 },
    join: (...parts) => parts.join('/'), existsSync: path => path === '/isolated/WATCH_STOP' && stopFile, statSync: () => ({ mtimeMs: 1 }),
    async rpc(...args) { return rpc ? rpc(...args) : '0x64'; },
    async holdings(head, onlyFast) { seen.calls.push({ head, onlyFast, at: clock }); return hold?.(head, onlyFast); },
    setInterval(callback) { const timer = { callback, unref() { seen.unrefs++; } }; intervals.add(timer); return timer; },
    clearInterval(timer) { intervals.delete(timer); },
    save() { seen.saves.push(structuredClone(S)); }, log(message) { seen.logs.push(message); },
    process: { on(event, listener) { seen.listeners.set(event, listener); }, exit() {} },
    UPD: { on: true }, async updCheck() { seen.updateChecks++; return null; },
    async doUpdate() { throw new Error('no update command file was supplied'); },
    tgCmdLoop: async () => {}, async scanNew() { seen.scanCalls++; return scan?.(); },
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(schedulerSource + mainSource + '\nglobalThis.api = { startHoldingsScheduler, main };', context);
  return {
    api: sandbox.api, S, seen, context, intervals,
    async advance(ms) { clock += ms; for (const timer of [...intervals]) timer.callback(); await flush(); },
    setStopFile() { stopFile = true; },
    now: () => clock,
  };
}

test('normal holdings run immediately and every five seconds, using unref timers', async () => {
  const h = harness(), scheduler = h.api.startHoldingsScheduler(); await flush();
  assert.equal(h.seen.calls.length, 1); assert.equal(h.seen.calls[0].head, 100); assert.equal(h.seen.calls[0].onlyFast, false);
  assert.equal(h.S.holdingsUpdatedAt, h.now()); assert.equal(h.seen.unrefs, 1);
  for (let index = 0; index < 4; index++) await h.advance(1000);
  assert.equal(h.seen.calls.length, 1);
  await h.advance(1000); assert.equal(h.seen.calls.length, 2);
  assert.equal(h.api.startHoldingsScheduler(), scheduler); assert.equal(h.intervals.size, 1);
  scheduler.stop(); await h.advance(10000); assert.equal(h.seen.calls.length, 2); assert.equal(h.intervals.size, 0);
});

test('fast positions are checked every second without starving the five-second full round', async () => {
  const h = harness({ fast: true }), scheduler = h.api.startHoldingsScheduler(); await flush();
  await h.advance(1000); assert.equal(h.seen.calls.length, 2); assert.equal(h.seen.calls[1].onlyFast, true);
  for (let index = 0; index < 4; index++) await h.advance(1000);
  assert.equal(h.seen.calls.length, 6); assert.equal(h.seen.calls.at(-1).onlyFast, false);
  assert.equal(h.S.holdingsFullUpdatedAt, h.now()); scheduler.stop();
});

test('a busy holdings check never overlaps and records completion time after it resolves', async () => {
  const gate = deferred(), h = harness({ fast: true, hold: () => gate.promise });
  const scheduler = h.api.startHoldingsScheduler(); await flush();
  for (let index = 0; index < 8; index++) await h.advance(1000);
  assert.equal(h.seen.calls.length, 1); assert.equal(h.S.holdingsInFlight, true); assert.equal(h.S.holdingsUpdatedAt, 123);
  gate.resolve(); await flush();
  assert.equal(h.S.holdingsUpdatedAt, h.now()); assert.equal(h.S.holdingsInFlight, false);
  await h.advance(1000); assert.equal(h.seen.calls.length, 2); scheduler.stop();
});

test('head or holdings failures preserve the last successful timestamp and expose the error', async () => {
  for (const options of [{ rpc: async () => { throw new Error('RPC unavailable'); } }, { hold: async () => { throw new Error('wallet read failed'); } }, { rpc: async () => 'invalid' }]) {
    const h = harness(options), scheduler = h.api.startHoldingsScheduler(); await flush();
    assert.equal(h.S.holdingsUpdatedAt, 123); assert.ok(h.S.holdingsError); assert.equal(h.S.holdingsErrorAt, h.now());
    assert.equal(h.S.holdingsInFlight, false); assert.ok(h.seen.saves.length > 0); scheduler.stop();
  }
});

test('stopping during an in-flight round prevents reentry and does not claim a fresh completion', async () => {
  const gate = deferred(), h = harness({ hold: () => gate.promise });
  const scheduler = h.api.startHoldingsScheduler(); await flush(); scheduler.stop();
  gate.resolve(); await flush(); await h.advance(10000);
  assert.equal(h.seen.calls.length, 1); assert.equal(h.S.holdingsUpdatedAt, 123); assert.equal(h.intervals.size, 0);
  const stopped = harness(); stopped.setStopFile(); stopped.api.startHoldingsScheduler(); await flush();
  assert.equal(stopped.seen.calls.length, 0); assert.equal(stopped.intervals.size, 0);
});

test('the actual main starts independent holdings even while scanNew remains pending', async () => {
  const blockedScan = deferred(), h = harness({ scan: () => blockedScan.promise });
  void h.api.main(); await flush();
  assert.equal(h.seen.updateChecks, 1, 'upstream update check remains nonblocking');
  assert.equal(h.seen.scanCalls, 1); assert.equal(h.seen.calls.length, 1);
  await h.advance(5000); assert.equal(h.seen.calls.length, 2); assert.equal(h.seen.scanCalls, 1);
  assert.equal(h.S.holdingsUpdatedAt, h.now());
  h.seen.listeners.get('exit')(); assert.equal(h.intervals.size, 0);
});
