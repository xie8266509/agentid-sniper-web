import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { createSafeWeb } from '../lib/safe-web.mjs';

const publicAddress = { address: '93.184.216.34', family: 4 };
function transport(routes = {}, { lookup = async () => [publicAddress], slow = false } = {}) {
  const seen = { requests: [], lookups: [], pinned: [], destroyed: 0 };
  const api = createSafeWeb({
    lookup: async (host, options) => { seen.lookups.push({ host, options }); return lookup(host, options); },
    request(url, options, onResponse) {
      const target = String(url), req = new EventEmitter();
      seen.requests.push({ target, options });
      req.end = () => {
        if (slow) return;
        queueMicrotask(() => {
          if (req.destroyed) return;
          options.lookup(new URL(target).hostname, {}, (error, address, family) => {
            if (error) { req.emit('error', error); return; }
            seen.pinned.push({ address, family });
            const route = routes[target] || {}, chunks = route.chunks || [Buffer.from(route.body ?? 'mock public text')];
            const response = Readable.from(chunks);
            response.statusCode = route.status ?? 200;
            response.headers = { 'content-type': route.contentType ?? 'text/plain', ...(route.headers || {}) };
            response.setTimeout = () => response;
            onResponse(response);
          });
        });
      };
      req.setTimeout = () => req;
      req.destroy = error => { if (req.destroyed) return; req.destroyed = true; seen.destroyed++; if (error) queueMicrotask(() => req.emit('error', error)); };
      return req;
    },
  });
  return { fetchBytes: api, seen };
}

test('safe text retrieval connects only to its checked public DNS address', async () => {
  let originalLookups = 0;
  const h = transport({ 'https://example.org/project': { body: 'mock project' } }, { lookup: async () => ++originalLookups === 1 ? [publicAddress] : [{ address: '127.0.0.1', family: 4 }] });
  const value = await h.fetchBytes('https://example.org/project', { kind: 'text' });
  assert.equal(value.body.toString(), 'mock project');
  assert.equal(originalLookups, 1, 'the transport must use a fixed checked DNS result rather than re-resolving it');
  assert.deepEqual(h.seen.pinned, [publicAddress]);
  assert.equal(h.seen.requests[0].options.headers['accept-encoding'], 'identity');
});

test('local addresses, unusual URL credentials, insecure schemes and unsupported ports stop before any connection', async () => {
  const h = transport();
  for (const url of [
    'http://example.org/', 'https://localhost/', 'https://127.0.0.1/', 'https://127.1/', 'https://2130706433/',
    'https://0x7f000001/', 'https://10.0.0.1/', 'https://169.254.169.254/', 'https://192.168.1.1/',
    'https://[::1]/', 'https://[::ffff:127.0.0.1]/', 'https://[fc00::1]/', 'https://[fe80::1]/', 'https://[3ffe::1]/', 'https://[fe80::1%25eth0]/',
    'https://mock-user:mock-password@example.org/', 'https://example.org:8443/', 'file:///tmp/mock-image.png', 'data:text/plain,mock',
  ]) await assert.rejects(h.fetchBytes(url, { kind: 'text' }), /地址|公网|私网|URL|HTTPS|协议|端口|凭据|安全|禁止|拒绝|invalid|unsupported/i, url);
  assert.equal(h.seen.requests.length, 0);
});

test('all resolved addresses must be public, including mixed and IPv4-mapped IPv6 DNS answers', async () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.2', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '3ffe::1', 'fe80::1%eth0']) {
    const family = address.includes(':') ? 6 : 4;
    const h = transport({}, { lookup: async () => [publicAddress, { address, family }] });
    await assert.rejects(h.fetchBytes('https://example.org/project', { kind: 'text' }));
    assert.equal(h.seen.requests.length, 0, address);
  }
  const failed = transport({}, { lookup: async () => { throw new Error('mock DNS failure'); } });
  await assert.rejects(failed.fetchBytes('https://example.org/project', { kind: 'text' }), /DNS|failure/);
  assert.equal(failed.seen.requests.length, 0);
});

test('redirects are revalidated and cannot reach local services or downgrade HTTPS', async () => {
  const local = transport({ 'https://example.org/project': { status: 302, headers: { location: 'https://private.example/mock' } } }, { lookup: async host => host === 'private.example' ? [{ address: '127.0.0.1', family: 4 }] : [publicAddress] });
  await assert.rejects(local.fetchBytes('https://example.org/project', { kind: 'text' }));
  assert.equal(local.seen.requests.length, 1);
  const downgrade = transport({ 'https://example.org/project': { status: 302, headers: { location: 'http://example.org/mock' } } });
  await assert.rejects(downgrade.fetchBytes('https://example.org/project', { kind: 'text' }));
  assert.equal(downgrade.seen.requests.length, 1);
  const relative = transport({ 'https://example.org/project': { status: 302, headers: { location: '/next' } }, 'https://example.org/next': { body: 'mock redirected text' } });
  assert.equal((await relative.fetchBytes('https://example.org/project', { kind: 'text' })).body.toString(), 'mock redirected text');
  assert.equal(relative.seen.lookups.length, 2);
});

test('redirect loops, oversized lengths, streamed bodies and compressed payloads are rejected', async () => {
  const loop = transport({ 'https://example.org/project': { status: 302, headers: { location: '/project' } } });
  await assert.rejects(loop.fetchBytes('https://example.org/project', { kind: 'text', maxRedirects: 1 }));
  assert.ok(loop.seen.requests.length <= 2);
  const length = transport({ 'https://example.org/project': { headers: { 'content-length': '101' }, body: 'mock' } });
  await assert.rejects(length.fetchBytes('https://example.org/project', { kind: 'text', maxBytes: 100 }));
  const stream = transport({ 'https://example.org/project': { chunks: [Buffer.alloc(60), Buffer.alloc(60)] } });
  await assert.rejects(stream.fetchBytes('https://example.org/project', { kind: 'text', maxBytes: 100 }));
  const compressed = transport({ 'https://example.org/project': { headers: { 'content-encoding': 'gzip' }, body: 'mock' } });
  await assert.rejects(compressed.fetchBytes('https://example.org/project', { kind: 'text' }));
});

test('the shared deadline also bounds a stalled response and DNS resolution', async () => {
  const stalled = transport({}, { slow: true });
  await assert.rejects(stalled.fetchBytes('https://example.org/project', { kind: 'text', timeoutMs: 15 }), /超时|timeout|期限/i);
  assert.equal(stalled.seen.destroyed, 1);
  const dns = transport({}, { lookup: async () => new Promise(() => {}) });
  await assert.rejects(dns.fetchBytes('https://example.org/project', { kind: 'text', timeoutMs: 15 }), /超时|timeout|期限/i);
  assert.equal(dns.seen.requests.length, 0);
});
