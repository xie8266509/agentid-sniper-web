import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { decodeAbiUint } from '../lib/nft-codec.mjs';

const raw = readFileSync(new URL('../watch.mjs', import.meta.url), 'utf8');
const section = (start, end) => { const a = raw.indexOf(start), b = raw.indexOf(end, a); assert.ok(a >= 0 && b > a); return raw.slice(a, b); };
const word = value => BigInt(value).toString(16).padStart(64, '0');
const target = '0x1111111111111111111111111111111111111111';
function fixture({ registered = 12, unknown = false } = {}) {
  let clock = 1793534400000; class Clock extends Date { static now() { return clock; } }
  const seen = { notifications: [], reads: 0 }, S = {};
  const sandbox = { S, Date: Clock, Buffer, SMART: new Set(), decodeAbiUint, REGISTRY: '60b9262456de011f7d15a54cdd8c48baaa8b022f', wa: address => address.slice(2).padStart(64, '0'),
    async call(to, data) { assert.equal(to, '0x' + sandbox.REGISTRY); assert.ok(data.startsWith('0x70a08231')); seen.reads++; return unknown ? null : '0x' + word(seen.reads <= registered ? 1 : 0); }, async tg(text) { seen.notifications.push(text); } };
  vm.runInNewContext(section('const noLink =', 'function trackFromSim(') + section('const HOT =', '// ---------- 第三道保險：') + '\nglobalThis.api={countHot,inscScan,hot:HOT,inscriptions:INSC};', sandbox);
  return { api: sandbox.api, S, seen, advance: ms => { clock += ms; } };
}
const transactions = count => Array.from({ length: count }, (_, i) => ({ from: '0x' + (i + 1).toString(16).padStart(40, '0'), to: target, value: '0x0', input: '0x' + Buffer.from('data:,{"p":"mock-fixture","tick":"https://malicious.example/mock"}').toString('hex') }));

test('inscription data is a notification source and never enters the automatic contract mint queue', async () => {
  const h = fixture(), txs = transactions(12); h.api.countHot([...txs, ...txs]);
  assert.equal(h.api.hot.size, 0); assert.equal(h.api.inscriptions.size, 1);
  await h.api.inscScan(); await h.api.inscScan();
  assert.equal(h.seen.notifications.length, 1); assert.match(h.seen.notifications[0], /仅通知/); assert.ok(!h.seen.notifications[0].includes('https://malicious.example'));
});

test('inscription notifications require twelve distinct senders plus enough confirmed Agent ID holders', async () => {
  for (const options of [{ registered: 7 }, { unknown: true }]) { const h = fixture(options); h.api.countHot(transactions(12)); await h.api.inscScan(); assert.equal(h.seen.notifications.length, 0); }
  const low = fixture(); low.api.countHot(transactions(11)); await low.api.inscScan(); assert.equal(low.seen.notifications.length, 0); assert.equal(low.seen.reads, 0);
});

test('expired inscription observations cannot be used to authorize a later notification', async () => {
  const h = fixture(); h.api.countHot(transactions(12)); h.advance(180001); await h.api.inscScan(); assert.equal(h.api.inscriptions.size, 0); assert.equal(h.seen.reads, 0); assert.equal(h.seen.notifications.length, 0);
});
