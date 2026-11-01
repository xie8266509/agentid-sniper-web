import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { createMintMedia } from '../lib/mint-media.mjs';

const a = '0x1111111111111111111111111111111111111111', b = '0x2222222222222222222222222222222222222222';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9YL8C7sAAAAASUVORK5CYII=', 'base64');
const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const jsonData = value => 'data:application/json;base64,' + Buffer.from(JSON.stringify(value)).toString('base64');
const imageData = (bytes = png, kind = 'image/png') => `data:${kind};base64,` + bytes.toString('base64');
function fixture({ state = {}, respond } = {}) {
  let time = 1800000000000;
  const reads = [], writes = [];
  const api = createMintMedia({ state, now: () => time, save: strict => writes.push(strict), fetchBytes: async (url, options) => {
    reads.push({ url, options });
    if (respond) return respond(url, options);
    if (options.kind === 'json') return { body: Buffer.from(JSON.stringify({ image: 'https://example.org/mock.png' })), contentType: 'application/json', url, status: 200 };
    return { body: png, contentType: 'image/png', url, status: 200 };
  } });
  return { api, state, reads, writes, advance(ms) { time += ms; } };
}

test('NFT metadata and image are read with separate caps and checked by complete image bytes', async () => {
  const h = fixture();
  const checked = await h.api.check(a, 'https://example.org/mock.json');
  assert.equal(checked.verified, true);
  assert.equal(checked.imageHash, createHash('sha256').update(png).digest('hex'));
  assert.deepEqual(h.reads.map(read => read.options.kind), ['json', 'image']);
  assert.ok(h.reads[0].options.maxBytes <= 262144); assert.ok(h.reads[1].options.maxBytes <= 2097152);
  assert.ok(h.reads.every(read => read.options.timeoutMs <= 10000));
  assert.ok(h.writes.length > 0);
});

test('valid inline metadata and a genuine inline PNG do not need a network request', async () => {
  const h = fixture({ respond() { throw new Error('mock inline metadata must not fetch a URL'); } });
  const checked = await h.api.check(a, jsonData({ image: imageData() }));
  assert.equal(checked.verified, true); assert.equal(h.reads.length, 0);
});

test('fake image content, missing image metadata, videos and oversized inline metadata fail closed', async () => {
  for (const metadata of [
    {}, { name: 'mock only name' }, { animation_url: 'https://example.org/mock.mp4' },
    { image: imageData(Buffer.from('<html>mock phishing page</html>')) },
    { image: 'javascript:mock()' }, { image: 'file:///tmp/mock-image.png' },
  ]) {
    const h = fixture({ respond() { throw new Error('mock invalid inline image must not reach arbitrary URLs'); } });
    await assert.rejects(h.api.check(a, jsonData(metadata)));
  }
  const oversized = fixture();
  await assert.rejects(oversized.api.check(a, 'data:application/json;base64,' + Buffer.alloc(262145).toString('base64')), /上限|过大|大小|limit|bytes/i);
  assert.equal(oversized.reads.length, 0);
  const remoteHtml = fixture({ respond(url, options) { return options.kind === 'json' ? { body: Buffer.from('{"image":"https://example.org/mock.png"}'), contentType: 'application/json', url, status: 200 } : { body: Buffer.from('<html>mock</html>'), contentType: 'text/html', url, status: 200 }; } });
  await assert.rejects(remoteHtml.api.check(a, 'https://example.org/mock.json'));
});

test('the same image hash in another contract is refused even after restarting the verifier', async () => {
  const first = fixture();
  await first.api.check(a, jsonData({ image: imageData() }));
  const restart = fixture({ state: JSON.parse(JSON.stringify(first.state)) });
  await assert.rejects(restart.api.check(b, jsonData({ image: imageData() })), /重复|其他合约|别的合约|duplicate/i);
});

test('positive metadata results expire and changing the URI forces another verification immediately', async () => {
  const h = fixture({ respond(url, options) {
    if (options.kind === 'json') return { body: Buffer.from(JSON.stringify({ image: url.endsWith('two.json') ? 'https://example.org/mock.gif' : 'https://example.org/mock.png' })), contentType: 'application/json', url, status: 200 };
    return url.endsWith('.gif') ? { body: gif, contentType: 'image/gif', url, status: 200 } : { body: png, contentType: 'image/png', url, status: 200 };
  } });
  const first = await h.api.check(a, 'https://example.org/one.json');
  assert.equal(h.reads.length, 2);
  h.advance(1000); await h.api.check(a, 'https://example.org/one.json'); assert.equal(h.reads.length, 2);
  const changed = await h.api.check(a, 'https://example.org/two.json');
  assert.equal(h.reads.length, 4); assert.notEqual(changed.imageHash, first.imageHash);
  h.advance(300001); await h.api.check(a, 'https://example.org/two.json'); assert.equal(h.reads.length, 6);
});

test('ERC1155 URI placeholders use the exact padded lower-case token ID without reading animation URLs', async () => {
  const h = fixture();
  await h.api.check(a, 'https://example.org/{id}.json', { tokenId: '26' });
  assert.equal(h.reads[0].url, 'https://example.org/' + '1a'.padStart(64, '0') + '.json');
  for (const tokenId of ['-1', 'not-a-token', (1n << 256n).toString()]) await assert.rejects(h.api.check(a, 'https://example.org/{id}.json', { tokenId }));
});

test('metadata transport errors never leave a positive acceptance record', async () => {
  const state = {}, failed = fixture({ state, respond() { throw new Error('mock public read timeout'); } });
  await assert.rejects(failed.api.check(a, 'https://example.org/mock.json'), /timeout/);
  const retry = fixture({ state });
  assert.equal((await retry.api.check(a, 'https://example.org/mock.json')).verified, true);
  assert.equal(retry.reads.length, 2);
});
