import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { decodeAbiUint } from '../lib/nft-codec.mjs';
import { getRuleConfig } from '../lib/config.mjs';
import * as sellRules from '../lib/sell-rules.mjs';

const source = readFileSync(new URL('../watch.mjs', import.meta.url), 'utf8');
const start = source.indexOf('async function holdW('), end = source.indexOf('// ---------- 新的 Agent ID', start);
const A = '0x1111111111111111111111111111111111111111', F = '0x2222222222222222222222222222222222222222', O = '0x3333333333333333333333333333333333333333';
const abi = n => '0x' + BigInt(n).toString(16).padStart(64, '0');
function fixture({ unknown = false, monitorOnly = false } = {}) {
  let clock = 1800000000000, balance = 100n;
  class Clock extends Date { static now() { return clock; } }
  const events = [], st = { addr: F, pair: O, openAt: clock - 1000, decimals: 0, verified: true, referenceBalance: '100', hist: [], done2: [], notified: [] }, old = { hist: [], done2: [], notified: [] };
  const state = { tokens: { [A + ':' + F]: st, [A + ':' + O]: old }, dyn: [] }, positions = { [F]: st, [O]: old };
  const rules = getRuleConfig({ rules: { strategy: 'legacy', backX: 2, halfX: [3, 5], fastMin: 30, notifyX: [] } });
  const sandbox = { Date: Clock, S: state, TOKENS: [{ addr: O, sym: 'OLD', cost: 1 }, { addr: F, sym: 'FAST', cost: 10 }], MONITOR_ONLY: monitorOnly, structuredClone,
    ...sellRules, decodeAbiUint, positionStateKey: (wallet, token) => wallet + ':' + token, positionFor: (_wallet, token) => positions[token.addr],
    rulesFor: () => rules, canWallet: () => !monitorOnly, tokenCostFor: (_wallet, token) => token.cost,
    recoverScannerWallet: async () => { events.push('recover'); }, wa: value => value.slice(2).padStart(64, '0'),
    call: async (to, data) => { assert.ok(data.startsWith('0x70a08231')); if (to === O) { events.push('old'); clock += 2000; return abi(0); } events.push('fast-balance'); return abi(balance); },
    valueUsd: async (_token, amount) => Number(amount) / 5,
    tg: async () => {}, ts: () => String(clock), save() {}, logWallet() {},
    sell: async (token, position, amount, _why, _wallet, action) => {
      assert.equal(token.addr, F);
      if (position.pendingSell) { assert.equal(amount, 0n); events.push('reconcile'); return false; }
      events.push('submit:' + action.id);
      if (unknown) { position.pendingSell = { orderId: 'unknown-order' }; return false; }
      balance -= amount; Object.assign(position, sellRules.applyConfirmedSell(position, action)); position.lastBal = balance.toString(); return true;
    },
  };
  vm.runInNewContext(source.slice(start, end) + '\nglobalThis.run = holdW;', sandbox);
  return { st, events, run: mode => sandbox.run({ id: 'wallet-a', addr: A }, 1000000, mode), advance: ms => { clock += ms; } };
}

test('cooperative full and fast checks share the actual profit planner without repeating a confirmed partial sale', async () => {
  const h = fixture(); await h.run(false);
  assert.deepEqual(h.events.filter(event => event.startsWith('submit:')), ['submit:back']);
  assert.ok(h.events.indexOf('fast-balance') < h.events.indexOf('old'));
  assert.equal(h.events.filter(event => event === 'fast-balance').length, 2, 'the due fast position is checked after the slow old position');
  h.advance(1000); await h.run(true);
  assert.deepEqual(h.events.filter(event => event.startsWith('submit:')), ['submit:back']); assert.deepEqual(Array.from(h.st.done2), ['back']);
});

test('an unknown partial sale is only reconciled when a due fast check interrupts a full round', async () => {
  const h = fixture({ unknown: true }); await h.run(false); h.advance(1000); await h.run(true);
  assert.deepEqual(h.events.filter(event => event.startsWith('submit:')), ['submit:back']); assert.ok(h.events.includes('reconcile'));
  assert.equal(h.st.pendingSell.orderId, 'unknown-order'); assert.deepEqual(Array.from(h.st.done2), []);
});

test('cooperative fast checks cannot sell a monitor wallet even while a full round advances the clock', async () => {
  const h = fixture({ monitorOnly: true }); await h.run(false);
  assert.equal(h.events.some(event => event.startsWith('submit:')), false); assert.equal(h.st.pendingSell, undefined); assert.deepEqual(Array.from(h.st.done2), []);
});

test('an explicit full refresh rechecks fast evidence in the same second without repeating a completed partial sale', async () => {
  const h = fixture(); await h.run(false);
  const reads = h.events.filter(event => event === 'fast-balance').length;
  await h.run(false);
  assert.equal(h.events.filter(event => event === 'fast-balance').length, reads + 1, 'full refresh applies changed runtime evidence without waiting for the fast timer');
  assert.deepEqual(h.events.filter(event => event.startsWith('submit:')), ['submit:back']);
  const afterFull = h.events.filter(event => event === 'fast-balance').length;
  await h.run(true); assert.equal(h.events.filter(event => event === 'fast-balance').length, afterFull, 'ordinary timed fast checks retain the one-second limit');
});
