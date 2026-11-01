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
  assert.deepEqual(accepted.map(record => record.address), [contract]); assert.deepEqual(verifies, [contract, other]);
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
