import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRpcClient, RpcUnavailableError } from '../lib/rpc-client.mjs';

const A = 'https://node-a.test/rpc', B = 'https://node-b.test/rpc', C = 'https://node-c.test/rpc';
const P = 'https://bsc.publicnode.com', P2 = 'https://bsc-rpc.publicnode.com';
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const reply = (data, { status = 200, retryAfter } = {}) => ({ ok: status < 400, status, headers: { get: key => key.toLowerCase() === 'retry-after' ? retryAfter ?? null : null }, json: async () => data });
const value = result => reply({ jsonrpc: '2.0', id: 1, result });
function fixture(handler = () => value('0x1'), options = {}) {
  let clock = 1000000;
  const calls = [], waits = [];
  const client = createRpcClient({ urls: [A, B, C], now: () => clock, sleep: async ms => { waits.push(ms); clock += ms; }, random: () => 0, minIntervalMs: 0,
    fetchImpl: async (url, init) => { const request = JSON.parse(init.body), call = { url, request, at: clock, signal: init.signal }; calls.push(call); return handler(call, calls.length); }, ...options });
  return { client, calls, waits, now: () => clock, advance: ms => { clock += ms; } };
}

test('read requests snapshot params, share one flight by semantic inputs and do not retain a result cache', async () => {
  const gate = deferred(), started = deferred();
  const f = fixture(async () => { started.resolve(); await gate.promise; return value({ balance: '7' }); }, { urls: [A] });
  const params = [{ to: 'one', data: 'two' }, 'latest'];
  const first = f.client.request('eth_call', params), same = f.client.request('eth_call', [{ data: 'two', to: 'one' }, 'latest']);
  assert.equal(first, same); params[0].to = 'changed'; await started.promise;
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].request.params[0].to, 'one');
  gate.resolve(); assert.deepEqual(await first, { balance: '7' }); await same;
  await f.client.request('eth_call', [{ to: 'one', data: 'two' }, 'latest']); assert.equal(f.calls.length, 2);
});

test('concurrent requests and queued identities are bounded while duplicates still join a full queue', async () => {
  const gates = [], started = deferred(); let networks = 0, peak = 0;
  const f = fixture(async () => { const gate = deferred(); gates.push(gate); peak = Math.max(peak, ++networks); if (gates.length === 2) started.resolve(); await gate.promise; networks--; return value('ok'); }, { urls: [A], maxConcurrent: 2, maxPending: 1 });
  const one = f.client.request('eth_getBalance', ['one']), two = f.client.request('eth_getBalance', ['two']); await started.promise;
  const three = f.client.request('eth_getBalance', ['three']); assert.equal(three, f.client.request('eth_getBalance', ['three']));
  await assert.rejects(f.client.request('eth_getBalance', ['four']), error => error instanceof RpcUnavailableError && error.reason === 'queue-full');
  assert.equal(f.client.getStatus().active, 2); assert.equal(f.client.getStatus().queued, 1);
  gates[0].resolve(); await one;
  await new Promise(resolve => setImmediate(resolve)); assert.equal(gates.length, 3);
  gates[1].resolve(); gates[2].resolve(); await Promise.all([two, three]);
  assert.equal(peak, 2); assert.equal(f.client.getStatus().inFlight, 0); assert.equal(f.client.getStatus().queued, 0);
});

test('rate spacing applies to every endpoint attempt including failover', async () => {
  const f = fixture(({ url }) => url === A ? reply(null, { status: 503 }) : value('ok'), { minIntervalMs: 250 });
  await f.client.request('eth_blockNumber'); await f.client.request('eth_getBalance', ['address']);
  assert.deepEqual(f.calls.map(call => call.at), [1000000, 1000250, 1000500]);
  assert.deepEqual(f.waits, [250, 250]);
});

test('a concurrent request cannot mutate another request endpoint snapshot order', async () => {
  const gate = deferred(), started = deferred();
  const f = fixture(async ({ url, request }) => {
    if (request.params[0] === 'first' && url === A) { started.resolve(); await gate.promise; return reply(null, { status: 503 }); }
    return value('ok');
  });
  const first = f.client.request('eth_getBalance', ['first']); await started.promise;
  await f.client.request('eth_getBalance', ['second']); gate.resolve(); await first;
  assert.deepEqual(f.calls.filter(call => call.request.params[0] === 'first').map(call => call.url), [A, B]);
});

test('PublicNode aliases share cooldown and failover never immediately repeats the throttled provider', async () => {
  const f = fixture(({ url }) => url.startsWith(P) ? reply(null, { status: 429 }) : value('ok'), { urls: [P, P2, A] });
  await f.client.request('eth_blockNumber'); await f.client.request('eth_chainId');
  assert.deepEqual(f.calls.map(call => call.url), [P + '/', A, A]);
  const status = f.client.getStatus(); assert.equal(status.providers[0].group, status.providers[1].group);
  assert.equal(status.providers[0].cooldownMs, 10000); assert.equal(status.providers[1].cooldownMs, 10000);
});

test('all-cooling requests reject immediately, and repeated throttles back off from 10 to 120 seconds', async () => {
  const f = fixture(() => reply(null, { status: 429 }), { urls: [P, P2] });
  for (const delay of [10000, 20000, 40000, 80000, 120000, 120000]) {
    await assert.rejects(f.client.request('eth_blockNumber'), error => error instanceof RpcUnavailableError && error.retryAfterMs === delay && error.nextRetryAt === f.now() + delay);
    const calls = f.calls.length, waits = f.waits.length;
    await assert.rejects(f.client.request('eth_getBalance', ['different']), error => error instanceof RpcUnavailableError && error.retryAfterMs === delay);
    assert.equal(f.calls.length, calls); assert.equal(f.waits.length, waits); f.advance(delay);
  }
});

for (const [name, header, delay] of [['seconds', '45', 45000], ['date', new Date(1060000).toUTCString(), 60000]]) test(`Retry-After ${name} is honored without exposing its endpoint`, async () => {
  const f = fixture(() => reply(null, { status: 429, retryAfter: header }), { urls: ['https://private.test/long-secret-credential?token=QUERY_SECRET'] });
  await assert.rejects(f.client.request('eth_blockNumber'), error => error instanceof RpcUnavailableError && error.retryAfterMs === delay && !/private|QUERY_SECRET|https/.test(error.message));
  assert.equal(f.client.getStatus().providers[0].cooldownMs, delay);
  assert.doesNotMatch(JSON.stringify(f.client.getStatus()), /QUERY_SECRET|private|long-secret/);
});

for (const error of [{ code: -32005, message: 'request exceeded' }, { code: -32000, message: 'quota exhausted' }]) test(`JSON RPC rate error ${error.code}/${error.message} cools a provider`, async () => {
  const f = fixture(({ url }) => url === A ? reply({ id: 1, error }) : value('ok'), { urls: [A, B] });
  assert.equal(await f.client.request('eth_blockNumber'), 'ok'); assert.equal(f.client.getStatus().providers[0].cooldownMs, 10000);
});

test('network and HTTP 503 failures use short cooldown and do not leak fetch errors', async () => {
  const f = fixture(({ url }) => { if (url === A) throw Error('https://secret.test?token=SECRET'); return reply(null, { status: 503 }); }, { urls: [A, B] });
  await assert.rejects(f.client.request('eth_blockNumber'), error => error instanceof RpcUnavailableError && error.retryAfterMs === 3000 && !/SECRET|secret.test/.test(error.message));
  assert.deepEqual(f.client.getStatus().providers.map(provider => provider.cooldownMs), [3000, 3000]);
});

test('unsupported getLogs capability permits another method without provider-wide cooldown', async () => {
  const f = fixture(({ request }) => request.method === 'eth_getLogs' ? reply({ id: 1, error: { code: -32602, message: 'address is required; https://bad.test?token=secret' } }) : value(['receipts']), { urls: [A, B] });
  await assert.rejects(f.client.request('eth_getLogs', [{}]), error => error.capability === true && error.rpcCode === -32602 && error.retryAfterMs === 0 && !/https|secret|bad.test/.test(error.message));
  assert.ok(f.client.getStatus().providers.every(provider => provider.cooldownMs === 0));
  assert.deepEqual(await f.client.request('eth_getBlockReceipts', ['latest']), ['receipts']);
});

test('range restrictions are capability errors rather than rate limits', async () => {
  const f = fixture(() => reply({ id: 1, error: { code: -32000, message: 'block range limit 5000' } }), { urls: [A] });
  await assert.rejects(f.client.request('eth_getLogs', [{}]), error => error.capability === true && error.retryAfterMs === 0);
  assert.equal(f.client.getStatus().providers[0].failures, 0);
});

test('contract reverts retain sanitized contract reasons, never fail over and never cool providers', async () => {
  const url = 'https://private.test/long-path-api-token?apiKey=QUERY_SECRET';
  const f = fixture(() => reply({ id: 1, error: { code: 3, message: `execution reverted: already minted; refund pending ${url} token=OTHER_SECRET {"apiKey":"JSON_SECRET"}` } }), { urls: [url, B] });
  await assert.rejects(f.client.request('eth_call', [{}]), error => error.contract === true && /already minted.*refund pending/.test(error.message) && !/https|QUERY_SECRET|OTHER_SECRET|JSON_SECRET|long-path-api-token/.test(error.message));
  assert.equal(f.calls.length, 1); assert.equal(f.client.getStatus().providers[0].cooldownMs, 0);
});

test('batches preserve original indices, missing replies and item errors as holes', async () => {
  const f = fixture(() => reply([{ id: 2, result: 'third' }, { id: 0, error: { code: -32000, message: 'unavailable item' } }]), { urls: [A] });
  const result = await f.client.batch([{}, {}, {}].map((_, index) => ({ method: 'eth_getBalance', params: [index] })));
  assert.equal(result.length, 3); assert.equal(0 in result, false); assert.equal(1 in result, false); assert.equal(result[2], 'third');
});

test('successful batch items survive rate-limited peers while the provider still enters cooldown', async () => {
  const f = fixture(() => reply([{ id: 1, result: '0x0' }, { id: 0, error: { code: -32005, message: 'limited' } }]), { urls: [A] });
  const result = await f.client.batch([{ method: 'eth_blockNumber' }, { method: 'eth_getBalance' }]);
  assert.equal(0 in result, false); assert.equal(result[1], '0x0'); assert.equal(f.client.getStatus().providers[0].cooldownMs, 10000);
});

for (const [name, data] of [
  ['duplicate IDs', [{ id: 0, result: 'bad' }, { id: 0, result: 'bad' }]],
  ['string IDs', [{ id: '0', result: 'bad' }]], ['out-of-range IDs', [{ id: 2, result: 'bad' }]],
  ['negative IDs', [{ id: -1, result: 'bad' }]], ['missing IDs', [{ result: 'bad' }]],
  ['missing result', [{ id: 0 }]], ['both error and result', [{ id: 0, result: 'bad', error: { code: 3, message: 'reverted' } }]],
]) test(`a malformed batch with ${name} fails over without fabricating values`, async () => {
  const f = fixture(({ url }) => reply(url === A ? data : [{ id: 1, result: 'second' }, { id: 0, result: 'first' }]), { urls: [A, B] });
  assert.deepEqual(await f.client.batch([{ method: 'eth_blockNumber' }, { method: 'eth_chainId' }]), ['first', 'second']);
  assert.equal(f.client.getStatus().providers[0].cooldownMs, 3000);
});

test('all-contract batches throw a contract error rather than returning zero or an empty success', async () => {
  const f = fixture(() => reply([0, 1].map(id => ({ id, error: { code: 3, message: 'execution reverted: already claimed' } }))), { urls: [A, B] });
  await assert.rejects(f.client.batch([{ method: 'eth_call' }, { method: 'eth_call', params: [{}] }]), error => error.contract === true && /already claimed/.test(error.message));
  assert.equal(f.calls.length, 1);
});

test('a fully failed transport batch throws a typed error while a genuine null remains a result', async () => {
  const f = fixture(() => reply(null, { status: 503 }), { urls: [A] });
  await assert.rejects(f.client.batch([{ method: 'eth_call' }]), RpcUnavailableError);
  const good = fixture(() => value(null), { urls: [A] }); assert.equal(await good.client.request('eth_getTransactionReceipt', ['pending']), null);
});

test('unknown and mutating methods are rejected before fetch, and an empty batch stays local', async () => {
  const f = fixture();
  for (const method of ['eth_sendRawTransaction', 'eth_sendTransaction', 'eth_sign', 'personal_sign', 'wallet_sendCalls', 'eth_signTypedData_v4', 'debug_setHead', 'unknown']) await assert.rejects(f.client.request(method, []), error => error.code === 'RPC_METHOD_NOT_ALLOWED');
  await assert.rejects(f.client.batch([{ method: 'eth_call' }, { method: 'eth_sendTransaction' }]), error => error.code === 'RPC_METHOD_NOT_ALLOWED');
  assert.deepEqual(await f.client.batch([]), []); assert.equal(f.calls.length, 0);
  await assert.rejects(f.client.request('eth_call', [NaN]), /有效 JSON/); await assert.rejects(f.client.request('eth_call', {}, {}), /数组/);
});

test('RPC endpoint userinfo is rejected with a fixed credential-free message', () => {
  for (const url of ['https://example-user:EXAMPLE_PASSWORD@node.test/rpc', 'https://example-user@node.test/rpc']) assert.throws(() => createRpcClient({ urls: [url] }), error => error instanceof TypeError && error.message === 'RPC 节点配置无效');
});

test('RPC endpoint fragments are rejected with a fixed address-free message', () => {
  assert.throws(() => createRpcClient({ urls: ['https://node.test/rpc#EXAMPLE_FRAGMENT'] }), error => error instanceof TypeError && error.message === 'RPC 节点配置无效');
});

test('per-attempt timeouts abort even a fetch adapter that ignores its signal', async () => {
  const f = fixture(() => new Promise(() => {}), { urls: [A], timeoutMs: 2 });
  await assert.rejects(f.client.request('eth_blockNumber'), error => error instanceof RpcUnavailableError && error.retryAfterMs === 3000);
  assert.equal(f.calls[0].signal.aborted, true);
});

test('chain validation is per endpoint and a wrong chain never receives the requested balance read', async () => {
  const f = fixture(({ url, request }) => value(request.method === 'eth_chainId' ? url === A ? '0x1' : '0x38' : 'balance'), { urls: [A, B], expectedChainId: 56 });
  assert.equal(await f.client.request('eth_getBalance', ['wallet']), 'balance');
  assert.deepEqual(f.calls.map(call => [call.url, call.request.method]), [[A, 'eth_chainId'], [B, 'eth_chainId'], [B, 'eth_getBalance']]);
  assert.equal(f.client.getStatus().providers[0].cooldownMs, 120000);
  await f.client.request('eth_getBalance', ['another']); assert.equal(f.calls.filter(call => call.request.method === 'eth_chainId').length, 2);
});

test('concurrent endpoint chain checks are single-flight and share the attempt rate limiter', async () => {
  const gate = deferred(), started = deferred();
  const f = fixture(async ({ request }) => { if (request.method === 'eth_chainId') { started.resolve(); await gate.promise; return value('0x38'); } return value('balance'); }, { urls: [A], expectedChainId: 56, minIntervalMs: 250 });
  const one = f.client.request('eth_getBalance', ['one']), two = f.client.request('eth_getBalance', ['two']); await started.promise;
  assert.equal(f.calls.length, 1); gate.resolve(); await Promise.all([one, two]);
  assert.equal(f.calls.filter(call => call.request.method === 'eth_chainId').length, 1);
  assert.deepEqual(f.calls.map(call => call.at), [1000000, 1000250, 1000500]);
});

test('an explicit chainId read joins an in-flight endpoint check without caching future explicit reads', async () => {
  const gate = deferred(), started = deferred();
  const f = fixture(async ({ request }) => { if (request.method === 'eth_chainId') { started.resolve(); await gate.promise; return value('0x38'); } return value('balance'); }, { urls: [A], expectedChainId: 56 });
  const balance = f.client.request('eth_getBalance', ['one']); await started.promise;
  const chain = f.client.request('eth_chainId'); gate.resolve();
  assert.equal(await chain, '0x38'); await balance;
  assert.equal(f.calls.filter(call => call.request.method === 'eth_chainId').length, 1);
  await f.client.request('eth_chainId'); assert.equal(f.calls.filter(call => call.request.method === 'eth_chainId').length, 2);
});

test('a switched PublicNode alias requires its own chain proof and cannot reuse another alias proof', async () => {
  const f = fixture(({ url, request }) => value(request.method === 'eth_chainId' ? url === P2 + '/' ? '0x1' : '0x38' : 'balance'), { urls: [P, P2, A], expectedChainId: 56 });
  await f.client.request('eth_getBalance', ['one']); await f.client.request('eth_getBalance', ['two']);
  assert.deepEqual(f.calls.map(call => [call.url, call.request.method]), [[P + '/', 'eth_chainId'], [P + '/', 'eth_getBalance'], [P2 + '/', 'eth_chainId'], [A, 'eth_chainId'], [A, 'eth_getBalance']]);
  assert.equal(f.client.getStatus().providers[0].cooldownMs, 120000); assert.equal(f.client.getStatus().providers[1].cooldownMs, 120000);
});

test('chain proof expiry rechecks the endpoint and direct chainId requests do not double query', async () => {
  const f = fixture(() => value('0x38'), { urls: [A], expectedChainId: 56, chainCheckTtlMs: 1000 });
  assert.equal(await f.client.request('eth_chainId'), '0x38'); assert.equal(f.calls.length, 1);
  await f.client.request('eth_blockNumber'); assert.equal(f.calls.length, 2);
  f.advance(1000); await f.client.request('eth_blockNumber'); assert.equal(f.calls.length, 4);
});
