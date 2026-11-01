import assert from 'node:assert/strict';
import { test } from 'node:test';
import { candidateUrl, extractSocialCandidates, createSocialAccumulator, processSocialCandidates, socialSelectionHash } from '../lib/social-candidates.mjs';

const when = 1793534400000;
const contract = '0x1111111111111111111111111111111111111111';
const other = '0x2222222222222222222222222222222222222222';
const snapshot = candidates => ({ version: 1, updatedAt: when, candidates });
const item = (kind, value, extra = {}) => ({ kind, value, groupCount: 3, senderCount: 3, observedAt: when, ...extra });

test('social URL normalization rejects transaction sites, credentials and unsafe schemes', () => {
  for (const value of ['http://mock-project.test', 'https://user:secret@mock-project.test', 'https://mock-project.test:444', 'https://bscscan.com/address/' + contract, 'https://fake.dexscreener.com/token/' + contract, 'https://t.me/mock_group']) assert.equal(candidateUrl(value), null, value);
  assert.equal(candidateUrl('https://mock-project.test/launch?mock=secret#fragment'), 'https://mock-project.test/launch');
  const found = extractSocialCandidates(`mock fixture ${contract} ${contract.toUpperCase().replace('0X', '0x')} https://mock-project.test/launch?mock=secret. https://flap.sh/test`);
  assert.deepEqual(found.addresses, [contract]); assert.deepEqual(found.urls, ['https://mock-project.test/launch']);
});

test('social accumulator counts distinct groups and senders once without retaining private message fields', () => {
  const accumulator = createSocialAccumulator({ now: () => when, salt: 'mock-test-salt' });
  for (const [groupId, senderId, messageId] of [['-11', '501', 1], ['-11', '501', 1], ['-22', '502', 1], ['-33', '503', 1]]) accumulator.ingest({ groupId, senderId, messageId, text: `mock-private-fixture-body ${contract} https://mock-project.test` });
  const feed = accumulator.snapshot(), serialized = JSON.stringify(feed);
  assert.equal(feed.candidates.length, 2);
  for (const record of feed.candidates) { assert.equal(record.groupCount, 3); assert.equal(record.senderCount, 3); }
  for (const privateValue of ['mock-private-fixture-body', 'groupId', 'senderId', 'messageId', '-11', '501']) assert.ok(!serialized.includes(privateValue), privateValue);
});

test('candidate observations expire and invalid or future messages cannot build a threshold', () => {
  let clock = when;
  const accumulator = createSocialAccumulator({ now: () => clock, salt: 'mock-fixture-salt' });
  accumulator.ingest({ groupId: '-11', senderId: '501', messageId: 1, text: contract });
  accumulator.ingest({ groupId: '-22', senderId: '502', messageId: 2, text: contract, at: when + 60001 });
  accumulator.ingest({ groupId: '-33', senderId: '503', messageId: -1, text: contract });
  assert.equal(accumulator.snapshot().candidates[0].groupCount, 1);
  clock += 86400001; assert.equal(accumulator.snapshot().candidates.length, 0);
});

test('social contract admission requires three groups plus an explicit successful Agent ID check', async () => {
  const calls = [];
  const accepted = await processSocialCandidates({ snapshot: snapshot([item('contract', contract), item('contract', other), item('contract', contract, { groupCount: 2 })]), now: () => when, verifyContract: async address => { calls.push(address); return address === contract; } });
  assert.deepEqual(accepted.map(record => record.address), [contract]); assert.deepEqual(calls, [contract, other]);
  for (const verdict of [false, null, undefined, 1, 'true', { verified: true }]) assert.deepEqual(await processSocialCandidates({ snapshot: snapshot([item('contract', contract)]), now: () => when, verifyContract: async () => verdict }), []);
});

test('social URL text is only a discovery hint and every extracted contract still requires chain verification', async () => {
  const requests = [], verifies = [];
  const accepted = await processSocialCandidates({ snapshot: snapshot([item('url', 'https://mock-project.test'), item('url', 'https://bscscan.com'), item('url', 'https://too-quiet.test', { groupCount: 1, senderCount: 2 })]), now: () => when,
    fetchBytes: async (url, options) => { requests.push({ url, options }); return { body: Buffer.from(`<script>${other}</script><p>mock fixture ${contract} ${other}</p>`) }; },
    verifyContract: async address => { verifies.push(address); return address === contract; } });
  assert.deepEqual(accepted.map(record => record.address), [contract]); assert.deepEqual(verifies, [other, contract]);
  assert.equal(requests.length, 1); assert.equal(requests[0].options.maxBytes, 262144); assert.equal(requests[0].options.kind, 'text');
});

test('stale feeds and failed or unsafe project URLs never trigger a contract check', async () => {
  let checks = 0;
  const verifyContract = async () => { checks++; return true; };
  assert.deepEqual(await processSocialCandidates({ snapshot: { ...snapshot([item('contract', contract)]), updatedAt: when - 300001 }, now: () => when, verifyContract }), []);
  assert.deepEqual(await processSocialCandidates({ snapshot: snapshot([item('url', 'https://mock-project.test')]), now: () => when, verifyContract, fetchBytes: async () => { throw new Error('mock SSRF / timeout / byte limit refusal'); } }), []);
  assert.equal(checks, 0);
});

test('a feed from revoked Telegram groups is rejected before any website or chain read', async () => {
  let reads = 0;
  const feed = { ...snapshot([item('contract', contract), item('url', 'https://mock-project.test')]), selectionHash: socialSelectionHash(['-11', '-22', '-33']) };
  const blocked = await processSocialCandidates({ snapshot: feed, allowedGroupIds: ['-11'], now: () => when, verifyContract: async () => { reads++; return true; }, fetchBytes: async () => { reads++; throw new Error('unexpected revoked URL fetch'); } });
  assert.deepEqual(blocked, []); assert.equal(reads, 0);
  const accepted = await processSocialCandidates({ snapshot: feed, allowedGroupIds: ['-33', '-11', '-22'], now: () => when, verifyContract: async () => true });
  assert.deepEqual(accepted.map(record => record.address), [contract]);
});

test('a hostile social feed cannot trigger more than twenty-four chain verification attempts per pass', async () => {
  let checks = 0;
  const candidates = Array.from({ length: 100 }, (_, i) => item('contract', '0x' + (i + 100).toString(16).padStart(40, '0')));
  const accepted = await processSocialCandidates({ snapshot: snapshot(candidates), now: () => when, verifyContract: async () => { checks++; return false; } });
  assert.deepEqual(accepted, []); assert.equal(checks, 24);
});

test('a rejected social contract is checked once even when repeated in messages and webpage text', async () => {
  let checks = 0;
  const candidates = [item('contract', contract), item('contract', contract.toUpperCase().replace('0X', '0x')), item('url', 'https://mock-project.test')];
  const accepted = await processSocialCandidates({ snapshot: snapshot(candidates), now: () => when, verifyContract: async () => { checks++; return false; }, fetchBytes: async () => ({ body: Buffer.from(`mock repeated fixture ${contract} ${contract}`) }) });
  assert.deepEqual(accepted, []); assert.equal(checks, 1);
});

test('priority discovery requires an explicit current selected-group scope and still needs chain proof', async () => {
  const groups = ['-11'], vipGroupIds = ['-11']; let checks = 0;
  const feed = { ...snapshot([item('contract', contract, { groupCount: 1, senderCount: 1, priority: true })]), selectionHash: socialSelectionHash(groups), vipSelectionHash: socialSelectionHash(vipGroupIds) };
  const options = { snapshot: feed, allowedGroupIds: groups, vipGroupIds, now: () => when, verifyContract: async () => { checks++; return false; } };
  assert.deepEqual(await processSocialCandidates(options), []); assert.equal(checks, 1);
  assert.deepEqual(await processSocialCandidates({ ...options, vipGroupIds: [] }), []);
  assert.deepEqual(await processSocialCandidates({ ...options, vipGroupIds: ['-22'] }), []);
  assert.deepEqual(await processSocialCandidates({ ...options, snapshot: { ...feed, vipSelectionHash: socialSelectionHash([]) } }), []);
  assert.equal(checks, 1);
  const admitted = await processSocialCandidates({ ...options, verifyContract: async () => true });
  assert.equal(admitted[0].priority, true); assert.equal(admitted[0].address, contract);
});

test('priority hourly quota survives persisted discovery state and does not reset on scope changes', async () => {
  const state = {}, groups = ['-11']; let checks = 0, clock = when;
  const candidates = Array.from({ length: 40 }, (_, i) => item('contract', '0x' + (100 + i).toString(16).padStart(40, '0'), { groupCount: 1, senderCount: 1, priority: true }));
  const feed = () => ({ version: 1, updatedAt: clock, candidates: candidates.map(x => ({ ...x, observedAt: clock })), selectionHash: socialSelectionHash(groups), vipSelectionHash: socialSelectionHash(groups) });
  const options = () => ({ snapshot: feed(), allowedGroupIds: groups, vipGroupIds: groups, discoveryState: state, now: () => clock, verifyContract: async () => { checks++; return false; } });
  await processSocialCandidates(options()); assert.equal(checks, 24);
  const persisted = JSON.parse(JSON.stringify(state)); await processSocialCandidates({ ...options(), discoveryState: persisted }); assert.equal(checks, 30);
  await processSocialCandidates({ ...options(), discoveryState: persisted }); assert.equal(checks, 30);
  persisted.scope = 'mock-forced-scope-change'; await processSocialCandidates({ ...options(), discoveryState: persisted }); assert.equal(persisted.vipHour.keys.length, 30);
  // Rechecking the same admitted thirty names after a scope change cannot admit
  // the extra ten distinct addresses into this hour's priority allowance.
  assert.ok(persisted.vipHour.keys.length <= 30);
  clock += 3600000; await processSocialCandidates({ ...options(), discoveryState: persisted }); assert.equal(persisted.vipHour.keys.length, 24);
});

test('missing-contract URLs retry at two-minute intervals for at most two hours', async () => {
  const state = {}; let clock = when, reads = 0;
  const run = () => processSocialCandidates({ snapshot: { version: 1, updatedAt: clock, candidates: [item('url', 'https://mock-retry.test', { observedAt: clock })] }, now: () => clock, discoveryState: state, verifyContract: async () => { throw new Error('No address exists'); }, fetchBytes: async () => { reads++; return { body: Buffer.from('<title>Mock Novel Project</title><p>No contract yet</p>') }; } });
  await run(); assert.equal(reads, 4);
  clock += 119999; await run(); assert.equal(reads, 4);
  clock += 1; await run(); assert.equal(reads, 8);
  clock = when + 7200000; await run(); assert.equal(reads, 8);
  assert.ok(!JSON.stringify(state).includes('Mock Novel Project'), 'no webpage title is persisted');
});

test('bounded same-origin metadata probing can discover a contract hidden in a public stats response', async () => {
  const reads = [];
  const accepted = await processSocialCandidates({ snapshot: snapshot([item('url', 'https://mock-hidden.test/start')]), now: () => when, verifyContract: async address => address === contract,
    fetchBytes: async (url, options) => { reads.push({ url, options }); return { body: Buffer.from(url.endsWith('/api/stats') ? JSON.stringify({ contract }) : '<p>Mock website</p>') }; } });
  assert.deepEqual(reads.map(x => x.url), ['https://mock-hidden.test/start', 'https://mock-hidden.test/api/stats']); assert.equal(accepted[0].address, contract);
  assert.ok(reads.every(x => x.options.maxBytes === 262144 && x.options.timeoutMs === 8000));
});

test('a verified matching name only emits a manual hint and never authorizes automatic tracking', async () => {
  const hints = [];
  const accepted = await processSocialCandidates({ snapshot: snapshot([item('url', 'https://mock-name.test')]), now: () => when, discoveryState: {}, fetchBytes: async () => ({ body: Buffer.from('<title>Mock Unique Token</title>') }), findNameHints: async () => [contract], verifyContract: async () => true, onNameHints: async hint => hints.push(hint) });
  assert.deepEqual(accepted, []); assert.deepEqual(hints, [{ host: 'mock-name.test', addresses: [contract] }]);
  const rejectedHints = [];
  await processSocialCandidates({ snapshot: snapshot([item('url', 'https://mock-name.test')]), now: () => when, fetchBytes: async () => ({ body: Buffer.from('mock page') }), findNameHints: async () => [contract], verifyContract: async () => false, onNameHints: async hint => rejectedHints.push(hint) });
  assert.deepEqual(rejectedHints, []);
});

test('revoking a social scope during an awaited website read stops further reads, hints and admission', async () => {
  let current = true, reads = 0, checks = 0;
  const result = await processSocialCandidates({ snapshot: snapshot([item('url', 'https://mock-revoked.test')]), now: () => when, isCurrent: () => current,
    fetchBytes: async () => { reads++; current = false; return { body: Buffer.from(contract) }; }, verifyContract: async () => { checks++; return true; } });
  assert.deepEqual(result, []); assert.equal(reads, 1); assert.equal(checks, 0);
});

test('a hot verification cache still admits at most twenty-four candidates per scanner pass', async () => {
  const { createHash } = await import('node:crypto');
  const addresses = Array.from({ length: 200 }, (_, i) => '0x' + (i + 1000).toString(16).padStart(40, '0'));
  const state = { entries: Object.fromEntries(addresses.map(address => [createHash('sha256').update('contract:' + address).digest('hex'), { checkedAt: when, touchedAt: when, verified: true }])), scope: 'undefined:', vipHour: { hour: Math.floor(when / 3600000), keys: [] } }; let checks = 0;
  const accepted = await processSocialCandidates({ snapshot: snapshot(addresses.map(address => item('contract', address))), now: () => when, discoveryState: state, verifyContract: async () => { checks++; return true; } });
  assert.equal(checks, 0); assert.equal(accepted.length, 24);
});


test('address extraction ignores hashes and known infrastructure without truncating a hash into an address', () => {
  const generic = ['0xca11bde05977b3631167028862be2a173976ca11', '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', '0xffffffffffffffffffffffffffffffffffffffff', '0x000000000022d473030f116ddee9f6b43ac78ba3', '0x0000000000000000000000000000000000000000', '0x55d398326f99059ff775485246999027b3197955', '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c'];
  assert.deepEqual(extractSocialCandidates([...generic, '0x' + 'ab'.repeat(32), '0x' + 'cd'.repeat(21), contract].join(' ')).addresses, [contract]);
});

test('hidden addresses in observed same-origin JSON or script text are read without execution', async () => {
  for (const path of ['/assets/config.json', '/assets/main.js']) {
    const requests = [], checks = [];
    const accepted = await processSocialCandidates({ snapshot: snapshot([item('url', 'https://mock-project.test')]), now: () => when,
      fetchBytes: async (url, options) => { requests.push({ url, options }); return { body: Buffer.from(new URL(url).pathname === path ? `globalThis.mustNeverRun(); const contractAddress = '${contract}';` : `<script src="https://unrelated.test/outside.js"></script><script src="${path}"></script>`) }; },
      verifyContract: async address => { checks.push(address); return address === contract; } });
    assert.deepEqual(accepted.map(record => record.address), [contract]); assert.deepEqual(checks, [contract]);
    assert.deepEqual(requests.map(request => request.url), ['https://mock-project.test/', 'https://mock-project.test' + path]);
    assert.equal(requests[1].options.maxRedirects, 0); assert.equal(requests[1].options.maxBytes, 262144);
  }
});

test('linked website resources and fixed metadata share the six-read limit and reject cross-origin results', async () => {
  const requests = [], accepted = await processSocialCandidates({ snapshot: snapshot([item('url', 'https://mock-project.test')]), now: () => when,
    fetchBytes: async url => { requests.push(url); return requests.length === 1 ? { body: Buffer.from('<script src="/a.js"></script><script src="/b.js"></script><script src="/c.js"></script>') } : { url: 'https://unrelated.test/result', body: Buffer.from(contract) }; },
    verifyContract: async () => { throw Error('cross-origin content must be discarded'); } });
  assert.deepEqual(accepted, []); assert.equal(requests.length, 6); assert.equal(requests.some(url => url.endsWith('/c.js')), false);
});
