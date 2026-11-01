import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { decodeAbiUint } from '../lib/nft-codec.mjs';

const A = '0x1111111111111111111111111111111111111111', PAIR = '0x9999999999999999999999999999999999999999';
const addr = number => '0x' + number.toString(16).padStart(40, '0'), uint = number => '0x' + BigInt(number).toString(16).padStart(64, '0');
const flush = async () => { for (let index = 0; index < 80; index++) await Promise.resolve(); };
function fixture({ blockedSell = false, badFastQuote = false, lateFast = false } = {}) {
  const source = readFileSync(new URL('../watch.mjs', import.meta.url), 'utf8'), from = source.indexOf('const HOLDINGS_WALLET_JOBS ='), to = source.indexOf('// ---------- 新的 Agent ID', from);
  let clock = 1800000000000, release;
  const gate = new Promise(resolve => { release = resolve; }), fast = addr(2), born = addr(5), fastAddresses = new Set([fast]), old = [addr(1), addr(3), addr(4)], wallet = { id: 'review-wallet', addr: A };
  const tokens = [old[0], fast, ...old.slice(1)].map(address => ({ addr: address, only: A, sym: 'T' + address.slice(-2), cost: 1 })), states = new Map();
  for (const token of tokens) states.set(token.addr, { pair: PAIR, verified: true, openAt: token.addr === fast ? clock - 1000 : clock - 31 * 60000, stage: 0, done: false, lastBal: '10', referenceBalance: '10', decimals: 18, hist: [], done2: [], notified: [] });
  const events = [], S = { tokens: Object.fromEntries([...states].map(([address, state]) => [A + ':' + address, state])), dyn: [] };
  class Clock extends Date { static now() { return clock; } }
  const rules = { fastMin: 30, notifyX: [], moonNotifyX: [], halfX: [], backX: 2, drop: .5, crash: .5 };
  const sandbox = { S, TOKENS: tokens, WALLETS: [wallet], Date: Clock, structuredClone, MONITOR_ONLY: false, FREE_PEAK_DELAY_MS: 120000, FREE_SELL_MIN_USD: 1,
    positionStateKey: (owner, token) => owner + ':' + token, positionFor: (_wallet, token) => states.get(token.addr), syncWalletProfiles() {},
    recoverScannerWallet: async () => { events.push({ type: 'wallet-recovery', at: clock }); }, rulesFor: () => rules, canWallet: () => true, tokenCostFor: () => 1,
    decodeAbiUint, wa: address => address.slice(2).padStart(64, '0'), call: async (address, data) => { assert.equal(data.slice(0, 10), '0x70a08231'); events.push({ type: 'balance', address, at: clock }); return uint(10); },
    valueUsd: async token => { events.push({ type: 'quote', address: token.addr, at: clock }); if (!fastAddresses.has(token.addr)) { clock += 2000; if (lateFast && token.addr === old[0]) { const state = { ...states.get(fast), openAt: clock, pendingSell: undefined, done2: [], notified: [] }; states.set(born, state); S.tokens[A + ':' + born] = state; S.dyn.push({ addr: born, only: A, sym: 'NEW', cost: 1 }); fastAddresses.add(born); } return null; } if (badFastQuote) throw Error('mock fast quote unavailable'); return 3; },
    normalizedPositionValue: value => value, samplePositionDrawdown: () => ({}), planPositionSell: ({ token, state }) => token.addr === fast && !state.pendingSell ? { id: 'review-half', amount: 5n, reason: 'review partial', full: false } : null,
    sell: async (token, state, amount) => { if (state.pendingSell) { events.push({ type: 'order-recovery', address: token.addr, at: clock }); return false; } events.push({ type: 'submit', address: token.addr, at: clock }); state.pendingSell = { orderId: 'mock-pending' }; if (blockedSell) await gate; return false; },
    save() {}, logWallet(_wallet, message) { events.push({ type: 'error', message }); }, log(message) { events.push({ type: 'error', message }); }, sleep: async () => {}, ts: () => 'mock-time', tg: async () => {},
  };
  vm.runInNewContext(source.slice(from, to) + '\nglobalThis.api = { holdW, holdings };', sandbox);
  return { api: sandbox.api, wallet, old, fast, born, states, events, S, release, advance: ms => { clock += ms; } };
}

test('a long full pass refreshes due fast positions between old positions and eventually covers every old position', async () => {
  const h = fixture(); await h.api.holdW(h.wallet, 1000000, false);
  const balances = h.events.filter(event => event.type === 'balance');
  assert.equal(balances[0].address, h.fast, 'fast positions get their first price before a backlog of old holdings');
  assert.deepEqual(balances.filter(event => h.old.includes(event.address)).map(event => event.address), h.old);
  const fastChecks = h.events.filter(event => event.address === h.fast && ['balance', 'order-recovery'].includes(event.type));
  assert.ok(fastChecks.length >= 3, 'each slow old holding must give due fast work another opportunity');
  assert.equal(h.events.filter(event => event.type === 'submit').length, 1, 'a still-pending partial order is never reissued during fast refresh');
});

test('a blocked partial sell keeps full and fast entrypoints on one wallet worker and preserves its unknown-order recovery', async () => {
  const h = fixture({ blockedSell: true });
  await h.api.holdings(1000000, false); await flush();
  assert.equal(h.events.filter(event => event.type === 'submit').length, 1);
  await h.api.holdings(1000001, true); await flush();
  assert.equal(h.events.filter(event => event.type === 'submit').length, 1);
  assert.equal(h.events.filter(event => event.type === 'wallet-recovery').length, 1, 'no second wallet worker may enter while the first order awaits a result');
  h.release(); await flush();
  assert.equal(h.states.get(h.fast).pendingSell.orderId, 'mock-pending');
  assert.ok(h.events.some(event => event.type === 'order-recovery')); assert.equal(h.events.filter(event => event.type === 'submit').length, 1);
  assert.deepEqual(h.events.filter(event => event.type === 'balance' && h.old.includes(event.address)).map(event => event.address), h.old);
});

test('an unavailable fast quote cannot permanently prevent the remaining full-pass holdings from being visited', async () => {
  const h = fixture({ badFastQuote: true });
  await h.api.holdW(h.wallet, 1000000, false).catch(() => {});
  assert.deepEqual(h.events.filter(event => event.type === 'balance' && h.old.includes(event.address)).map(event => event.address), h.old);
  assert.equal(h.events.filter(event => event.type === 'submit').length, 0); assert.equal(h.states.get(h.fast).lastBal, '10');
});

test('a newly added fast holding joins an already running full pass before its old-position backlog finishes', async () => {
  const h = fixture({ lateFast: true }); await h.api.holdW(h.wallet, 1000000, false);
  const balances = h.events.filter(event => event.type === 'balance').map(event => event.address);
  assert.ok(balances.includes(h.born), 'a captured startup token list cannot hide a fast position added during the ongoing full pass');
  assert.ok(balances.indexOf(h.born) < balances.indexOf(h.old.at(-1)), 'the new fast holding gets a turn before the entire old backlog completes');
  assert.deepEqual(balances.filter(address => h.old.includes(address)), h.old);
});
