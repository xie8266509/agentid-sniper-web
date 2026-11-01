// New upstream scanner paths, evaluated only inside isolated in-memory VMs.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../watch.mjs', import.meta.url), 'utf8');
function extract(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a, `scanner test markers missing: ${start} → ${end}`);
  return source.slice(a, b);
}
const target = '0x2222222222222222222222222222222222222222';
const impl = '0x3333333333333333333333333333333333333333';
const beacon = '0x4444444444444444444444444444444444444444';
const registry = '60b9262456de011f7d15a54cdd8c48baaa8b022f';
const word = value => BigInt(value).toString(16).padStart(64, '0');

function freeProgressHarness({ decimals, supply, cap, fallback = 0 } = {}) {
  const seen = [];
  const sandbox = {
    Date,
    async call(_to, data) {
      seen.push(data);
      if (data === '0x313ce567') return decimals === undefined ? '0x' : '0x' + word(decimals);
      if (data === '0x18160ddd') return supply === undefined ? '0x' : '0x' + word(supply);
      if (data === '0xd5abeb01') return cap === undefined ? '0x' : '0x' + word(cap);
      return '0x';
    },
    async rpc(method) { assert.equal(method, 'eth_getCode'); return '0x'; },
    async progressOf() { return { progress: fallback }; },
  };
  vm.runInNewContext(extract('const fpCache =', 'async function progressSweep(') + '\nglobalThis.read = freeProgress;', sandbox);
  return { read: sandbox.read, seen };
}

test('free NFT progress uses minted supply/cap and caches the result', async () => {
  const h = freeProgressHarness({ supply: 6000, cap: 10000 });
  assert.equal(await h.read(target), 0.6);
  const count = h.seen.length;
  assert.equal(await h.read(target), 0.6);
  assert.equal(h.seen.length, count, 'cached progress must not repeat contract calls');
});

test('pre-issued ERC20 total supply never becomes a false 100% mint progress', async () => {
  const h = freeProgressHarness({ decimals: 18, supply: 10000, cap: 10000, fallback: 0.42 });
  assert.equal(await h.read(target), 0.42);
  assert.equal(h.seen.includes('0x18160ddd'), false);
});

test('missing free progress remains unknown instead of becoming zero or full', async () => {
  const h = freeProgressHarness();
  assert.equal(await h.read(target), null);
});

function proxyHarness({ storageImpl = false, storageBeacon = false } = {}) {
  const reads = [];
  const sandbox = {
    REGISTRY: registry,
    async rpc(method, params) {
      reads.push({ method, params });
      if (method === 'eth_getStorageAt') {
        if (params[1].startsWith('0x360894') && storageImpl) return '0x' + impl.slice(2).padStart(64, '0');
        if (params[1].startsWith('0xa3f0ad') && storageBeacon) return '0x' + beacon.slice(2).padStart(64, '0');
        return '0x' + word(0);
      }
      assert.equal(method, 'eth_getCode');
      assert.equal(params[0], impl);
      return '0x63590e1ae3' + registry;
    },
    async call(to, data) {
      assert.equal(data, '0x5c60da1b');
      if (to === beacon) return '0x' + impl.slice(2).padStart(64, '0');
      return '0x';
    },
  };
  vm.runInNewContext(extract('async function fullCode(', 'async function mintScan(') + '\nglobalThis.read = fullCode;', sandbox);
  return { read: sandbox.read, reads };
}

for (const [name, options, code] of [
  ['EIP-1967 implementation', { storageImpl: true }, '0x60006000'],
  ['Beacon implementation', { storageBeacon: true }, '0x60006000'],
  ['EIP-1167 minimal proxy', {}, '0x363d3d373d3d3d363d73' + impl.slice(2) + '5af43d82803e903d91602b57fd5bf3'],
]) {
  test(`proxy resolution follows ${name} to its real refund/Agent ID code`, async () => {
    const h = proxyHarness(options), codeResult = await h.read(target, code);
    assert.ok(codeResult.includes(registry));
    assert.ok(codeResult.includes('590e1ae3'));
    assert.ok(h.reads.some(x => x.method === 'eth_getCode' && x.params[0] === impl));
  });
}

test('bytecode proxy scan skips PUSH data instead of extracting an odd-offset fake address', async () => {
  const h = proxyHarness();
  const code = '0x7f' + ('73' + '12'.repeat(20)).padEnd(64, '0') + '6000';
  await h.read(target, code);
  assert.equal(h.reads.some(x => x.method === 'eth_getCode'), false);
});

test('serial deployer block counts distinct deployment-sender projects in the last 24h only', async () => {
  const now = Date.now(), dep = '0x5555555555555555555555555555555555555555';
  const S = { depFrom: { [target]: dep }, devs: { [dep]: [] } };
  const sandbox = { S, Date };
  vm.runInNewContext(extract('const DEV_MAX =', 'function isRepeatDev(') + '\nglobalThis.read = serialDev;', sandbox);
  for (let i = 0; i < 9; i++) S.devs[dep].push({ c: '0x' + String(i).padStart(40, '0'), t: now });
  S.devs[dep].push({ c: S.devs[dep][0].c, t: now });
  S.devs[dep].push({ c: 'old', t: now - 86400001 });
  assert.equal(await sandbox.read(target), '');
  S.devs[dep].push({ c: '0x9999999999999999999999999999999999999999', t: now });
  assert.match(await sandbox.read(target), /10 個項目/);
  delete S.depFrom[target];
  assert.equal(await sandbox.read(target), '', 'shared platform owner must not be guessed as deployment sender');
});

test('local customized updater never downloads or overwrites scanner code', async () => {
  const effects = [];
  const sandbox = { UPD: { on: true, ver: '2.5.8', latest: { version: '999.0.0' } } };
  for (const name of ['fetch', 'writeFileSync', 'copyFileSync', 'renameSync', 'unlinkSync', 'execFile']) sandbox[name] = () => { effects.push(name); throw new Error('Unexpected updater side effect'); };
  vm.runInNewContext(extract('async function doUpdate()', 'async function groupInvite(') + '\nglobalThis.run = doUpdate;', sandbox);
  const message = await sandbox.run();
  assert.match(message, /本地|本機|定制|客製/);
  assert.equal(effects.length, 0);
});
