import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNftMarket, parseElementMarketHtml } from '../lib/nft-market.mjs';

const A = '0x1111111111111111111111111111111111111111';
const B = '0x2222222222222222222222222222222222222222';
const options = { address: A, tokenId: '940' };
const row = (extra = {}) => ({ addr: A, ownedTokenId: '940', tokenIds: [], ...extra });
function page({ address = A, tokenId = '940', chain = 'bsc', chainId = '0x38', assetOverride = {}, identityOverride = {}, floor = 0.000215, floorUsd = 0.150113, coin = { name: 'BNB', chain: 'bsc', chainId: '0x38' }, slug = 'wuse-pass', statsOverride = {} } = {}) {
  const identity = { blockChain: { chain, chainId }, contractAddress: address, tokenId, ...identityOverride };
  const asset = { chain, chainId, contractAddress: address, tokenId, name: 'NFT with braces { } and escaped "quote"', collection: { slug, stats: { collectionFloorPrice: { floorPriceSource: floor, floorPriceUsd: floorUsd, coin }, totalVolume: 0.00789, coin: { name: 'BNB' }, ...statsOverride } }, ...assetOverride };
  const state = { ROOT_QUERY: { __typename: 'Query', ['asset(' + JSON.stringify({ identity }) + ')']: asset } };
  return '<html><script>window.__APOLLO_STATE__ = ' + JSON.stringify(state) + '; window.afterState = "ignored";</script></html>';
}
const response = html => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });

test('public Element HTML supplies a reference floor and currency without any API key', () => {
  const result = parseElementMarketHtml(page(), options);
  assert.deepEqual(result.floor, { amount: '0.000215', currency: 'BNB', usd: 0.150113 });
  assert.deepEqual(result.volume, { amount: '0.00789', currency: 'BNB' });
  assert.equal(result.status, 'available');
  assert.equal(result.url, 'https://element.market/collections/wuse-pass');
  assert.equal(result.assetUrl, `https://element.market/assets/bsc/${A}/940`);
  assert.equal(result.lastSale, null); assert.equal(result.bestBid, null); assert.equal(result.sellUrl, null);
});

test('unknown or invalid prices remain null and volume uses its own actual currency', () => {
  for (const settings of [{ floor: -1 }, { floor: null }, { floor: 0 }, { coin: null }, { coin: { name: '' } }, { coin: { name: 'ETH', chain: 'ethereum' } }]) {
    const result = parseElementMarketHtml(page(settings), options);
    assert.equal(result.floor, null); assert.equal(result.status, 'no_data');
  }
  const result = parseElementMarketHtml(page({ floorUsd: null, coin: { name: 'WBNB' }, statsOverride: { totalVolume: 0, coin: { name: 'USDT' } } }), options);
  assert.equal(result.floor.currency, 'WBNB'); assert.equal(result.floor.usd, null);
  assert.deepEqual(result.volume, { amount: '0', currency: 'USDT' });
});

test('asset and query identity must both match the requested BSC NFT', () => {
  for (const settings of [
    { address: B }, { tokenId: '941' }, { chain: 'ethereum', chainId: '0x1' },
    { assetOverride: { contractAddress: B } }, { assetOverride: { tokenId: '941' } },
    { assetOverride: { chainId: '0x1' } }, { identityOverride: { contractAddress: B } },
  ]) assert.throws(() => parseElementMarketHtml(page(settings), options), /资产与请求不一致/);
});

test('parser rejects changed/invalid JSON layouts without evaluating page scripts', () => {
  assert.throws(() => parseElementMarketHtml('<html>no state</html>', options), /数据结构/);
  assert.throws(() => parseElementMarketHtml('<script>window.__APOLLO_STATE__ = (() => { throw new Error("MUST_NOT_EVALUATE"); })();</script>', options), /JSON/);
  assert.throws(() => parseElementMarketHtml('<script>window.__APOLLO_STATE__ = {"ROOT_QUERY":', options), /JSON/);
  const result = parseElementMarketHtml(page({ assetOverride: { collection: { slug: 'still-valid' } } }), options);
  assert.equal(result.status, 'no_data'); assert.equal(result.floor, null);
  assert.equal(parseElementMarketHtml(page({ slug: '../../untrusted.example' }), options).url, null);
  assert.throws(() => parseElementMarketHtml('x'.repeat(4 * 1024 * 1024 + 1), options), /上限/);
});

test('snapshot prefers owned IDs, performs only fixed public GETs, and caches references', async () => {
  let timestamp = 1000; const calls = [];
  const market = createNftMarket({ now: () => timestamp, fetchImpl: async (url, init) => { calls.push({ url, init }); return response(page({ tokenId: '7' })); } });
  const rows = [row({ addr: A.toUpperCase().replace('0X', '0x'), ownedTokenId: null, tokenIds: ['8'] }), row({ ownedTokenId: '7' })];
  const first = market.snapshot(rows);
  assert.equal(first.marketSync.loading, true); assert.equal(first.marketSync.total, 1);
  await market.whenIdle();
  const result = market.snapshot(rows);
  assert.equal(result.markets[A].tokenId, '7');
  assert.equal(result.markets[A].sellUrl, `https://element.market/assets/bsc/${A}/7`);
  assert.equal(result.marketSync.verified, 1); assert.equal(result.marketSync.errors, 0);
  assert.equal(calls.length, 1); assert.equal(calls[0].url, `https://element.market/assets/bsc/${A}/7`);
  assert.equal(calls[0].init.method, 'GET'); assert.equal(calls[0].init.redirect, 'error');
  assert.equal(calls[0].init.credentials, 'omit');
  assert.deepEqual(Object.keys(calls[0].init.headers), ['accept']);
  assert.equal(calls[0].init.signal.aborted, false);
  timestamp += 300001; market.snapshot(rows); await market.whenIdle(); assert.equal(calls.length, 2);
  market.snapshot(rows, { force: true }); await market.whenIdle(); assert.equal(calls.length, 3);
});

test('fallback IDs permit reference prices but do not claim verified ownership or invent ID 1', async () => {
  let calls = 0;
  const market = createNftMarket({ fetchImpl: async () => { calls++; return response(page()); } });
  const missing = market.snapshot([row({ ownedTokenId: null, tokenIds: [] })]);
  assert.equal(missing.markets[A].status, 'pending_id'); assert.equal(missing.markets[A].floor, null);
  assert.equal(missing.markets[A].assetUrl, null); assert.equal(missing.markets[A].sellUrl, null); assert.equal(calls, 0);
  market.snapshot([row({ ownedTokenId: null, tokenIds: ['940'] })]); await market.whenIdle();
  const found = market.snapshot([row({ ownedTokenId: null, tokenIds: ['940'] })]).markets[A];
  assert.equal(found.status, 'available'); assert.equal(found.sellUrl, null); assert.equal(calls, 1);
});

test('network errors, wrong assets, redirects, and oversized pages do not become zero prices', async () => {
  const cases = [
    async () => { throw new Error('untrusted server text'); },
    async () => new Response('blocked', { status: 403 }),
    async () => response(page({ address: B })),
    async () => new Response('x', { status: 200, headers: { 'content-length': String(4 * 1024 * 1024 + 1) } }),
    async () => response('x'.repeat(4 * 1024 * 1024 + 1)),
    async () => ({ ok: true, url: 'https://untrusted.example/', text: async () => page() }),
  ];
  for (const fetchImpl of cases) {
    const market = createNftMarket({ fetchImpl }); market.snapshot([row()]); await market.whenIdle();
    const result = market.snapshot([row()]);
    assert.equal(result.markets[A].status, 'error'); assert.equal(result.markets[A].floor, null);
    assert.equal(result.markets[A].bestBid, null); assert.equal(result.marketSync.errors, 1);
    assert.ok(!result.markets[A].reason.includes('untrusted server text'));
  }
});

test('background requests respect concurrency and cache persistence stays private', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'nft-market-test-')), cacheFile = join(directory, 'cache.json');
  const ids = [A, B, '0x3333333333333333333333333333333333333333', '0x4444444444444444444444444444444444444444'];
  let active = 0, maximum = 0, calls = 0;
  const fetchImpl = async url => {
    active++; maximum = Math.max(maximum, active); calls++;
    await new Promise(resolve => setImmediate(resolve));
    active--; const address = new URL(url).pathname.split('/')[3]; return response(page({ address }));
  };
  try {
    const market = createNftMarket({ cacheFile, fetchImpl, now: () => 1000, concurrency: 2 });
    const rows = ids.map(addr => row({ addr }));
    market.snapshot(rows); await market.whenIdle();
    assert.equal(maximum, 2); assert.equal(calls, 4);
    assert.equal(statSync(cacheFile).mode & 0o777, 0o600);
    const saved = JSON.parse(readFileSync(cacheFile, 'utf8'));
    saved.rows[0].url = 'https://untrusted.example/'; saved.rows[0].sellUrl = 'https://untrusted.example/';
    writeFileSync(cacheFile, JSON.stringify(saved));
    const cached = createNftMarket({ cacheFile, now: () => 1001, fetchImpl: async () => { throw new Error('must use cache'); } });
    const result = cached.snapshot(rows);
    assert.equal(result.marketSync.loading, false); assert.equal(result.marketSync.verified, 4);
    assert.equal(result.markets[A].url, null);
    assert.equal(result.markets[A].sellUrl, `https://element.market/assets/bsc/${A}/940`);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
