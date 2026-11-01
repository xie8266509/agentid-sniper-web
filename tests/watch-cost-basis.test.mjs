import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { deriveMintCost } from '../lib/mint-policy.mjs';

const source = readFileSync(new URL('../watch.mjs', import.meta.url), 'utf8');
const start = source.indexOf('function trackFromSim('), end = source.indexOf('function positionFor(', start);
assert.ok(start >= 0 && end > start);
const wallet = '0x1111111111111111111111111111111111111111', token = '0x2222222222222222222222222222222222222222', otherWallet = '0x3333333333333333333333333333333333333333';
const USDT = '0x55d398326f99059ff775485246999027b3197955', BNB = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const hash = number => '0x' + number.toString(16).padStart(64, '0');
function fixture() {
  const S = { dyn: [] }, sandbox = { S, USDT, WBNB: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', NATIVE_BNB: BNB, deriveMintCost };
  vm.runInNewContext(source.slice(start, end) + '\nglobalThis.track = trackFromSim;', sandbox);
  return { S, track: (sim, usd, transactionId = null, address = wallet) => sandbox.track({ addr: address }, sim, 'mock-token', usd, transactionId) };
}
const sim = ({ address = wallet, bnb = 0n, usdt = 0n } = {}) => ({ balanceChanges: [{ owner: address, contractAddress: token, tokenType: 'Erc20', change: '1' }, ...(bnb > 0n ? [{ owner: address, contractAddress: BNB, change: (-bnb).toString() }] : []), ...(usdt > 0n ? [{ owner: address, contractAddress: USDT, change: (-usdt).toString() }] : [])] });

test('a paid acquisition of an already tracked free token replaces its free cost basis', () => {
  const h = fixture(); h.track(sim(), 0, hash(1)); h.track(sim({ usdt: 3n * 10n ** 18n }), 3, hash(2));
  assert.equal(h.S.dyn.length, 1); assert.equal(h.S.dyn[0].cost, 3); assert.equal(h.S.dyn[0].costUnknown, false);
});

test('unknown paid acquisition of a previously free token retains explicit payment evidence and blocks the free classification', () => {
  const h = fixture(); h.track(sim(), 0, hash(1)); h.track(sim({ bnb: 10n ** 16n }), 0, hash(2));
  const record = h.S.dyn[0]; assert.equal(record.costUnknown, true); assert.equal(record.paidBnbWei, (10n ** 16n).toString()); assert.notEqual(record.costSource, 'free');
});

test('confirmed paid costs accumulate once per transaction and remain separated by wallet', () => {
  const h = fixture(); h.track(sim({ usdt: 3n * 10n ** 18n }), 3, hash(1)); h.track(sim({ usdt: 4n * 10n ** 18n }), 4, hash(2)); h.track(sim({ usdt: 4n * 10n ** 18n }), 4, hash(2));
  assert.equal(h.S.dyn[0].cost, 7, 're-reading a confirmed transaction must not double its cost');
  h.track(sim({ address: otherWallet, usdt: 9n * 10n ** 18n }), 9, hash(1), otherWallet);
  assert.equal(h.S.dyn.length, 2); assert.equal(h.S.dyn[0].cost, 7); assert.equal(h.S.dyn[1].cost, 9); assert.equal(h.S.dyn[1].only, otherWallet);
});

test('an unpriced new payment cannot discard prior confirmed USD basis', () => {
  const h = fixture(); h.track(sim({ usdt: 3n * 10n ** 18n }), 3, hash(1)); h.track(sim({ bnb: 10n ** 16n }), 0, hash(2));
  assert.equal(h.S.dyn[0].costUnknown, true); assert.equal(h.S.dyn[0].knownCostUsd, 3); assert.equal(h.S.dyn[0].unpricedPaidBnbWei, (10n ** 16n).toString());
});
