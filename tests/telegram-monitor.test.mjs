import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTelegramMonitor, telegramPaths, readTelegramSession } from '../lib/telegram-monitor.mjs';

const when = 1793534400000, contract = '0x1111111111111111111111111111111111111111';
function fixture(t, { groups = ['-11'], settings, messages } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mock-tg-readonly-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = settings || { telegramUser: { enabled: true, groupIds: groups } }, paths = telegramPaths(root), calls = [];
  const monitor = createTelegramMonitor({ root, now: () => when, readConfig: () => config, clientFactory(_root, credentials) {
    calls.push({ kind: 'factory', session: credentials.session });
    return { toPeer: peer => peer, client: {
      async connect() { calls.push({ kind: 'connect' }); }, async disconnect() { calls.push({ kind: 'disconnect' }); }, async isUserAuthorized() { return true; },
      async getMessages(peer, options) { calls.push({ kind: 'messages', peer, options }); return messages ? messages(peer, options) : [{ id: options.minId ? options.minId + 1 : 10, senderId: 'mock-sender', date: when / 1000, message: `mock-private-text ${contract}` }]; },
      getDialogs() { throw new Error('must not enumerate private chats'); }, sendMessage() { throw new Error('must not send Telegram messages'); },
    } };
  } });
  t.after(() => monitor.stop());
  const session = () => { mkdirSync(join(root, 'data/tg_user'), { recursive: true, mode: 0o700 }); writeFileSync(paths.session, JSON.stringify({ version: 1, apiId: 1, apiHash: 'a'.repeat(32), session: 'mock-session', peers: Object.fromEntries(groups.map(chatId => [chatId, { className: 'InputPeerChat', chatId }])) }), { mode: 0o600 }); };
  return { root, paths, config, calls, monitor, session };
}

test('disabled Telegram monitoring never reads session credentials or constructs a client', async t => {
  const h = fixture(t, { settings: { telegramUser: { enabled: false, groupIds: ['-11'] } } });
  mkdirSync(join(h.root, 'data/tg_user'), { recursive: true }); writeFileSync(h.paths.session, 'deliberately invalid mock fixture');
  assert.equal((await h.monitor.poll()).state, 'disabled'); assert.equal(h.calls.length, 0); assert.equal(existsSync(h.paths.feed), false);
});

test('an unreadable Telegram configuration is contained without rejection or client construction', async t => {
  const h = fixture(t, { settings: { telegramUser: { enabled: false, groupIds: [] } } }); let clients = 0;
  const monitor = createTelegramMonitor({ root: h.root, readConfig() { throw new Error('mock config is temporarily incomplete'); }, clientFactory() { clients++; throw new Error('must remain inactive'); } });
  t.after(() => monitor.stop());
  assert.doesNotThrow(() => monitor.view()); assert.equal(monitor.view().enabled, false);
  await assert.doesNotReject(monitor.poll()); assert.equal(clients, 0); assert.equal(existsSync(h.paths.feed), false);
  await assert.doesNotReject(monitor.stop());
});

test('Telegram requires explicit groups and private session permissions before connecting', async t => {
  const h = fixture(t, { groups: [] }); h.session();
  assert.equal((await h.monitor.poll()).state, 'setup-required'); assert.equal(h.calls.length, 0);
  h.config.telegramUser.groupIds = ['-11']; chmodSync(h.paths.session, 0o644);
  assert.equal((await h.monitor.poll()).state, 'setup-required'); assert.equal(h.calls.length, 0);
  assert.throws(() => readTelegramSession(h.root), /本人可读/);
});

test('Telegram reads only allowlisted peers, skips first-poll history and stores no message text or names', async t => {
  const h = fixture(t, { groups: ['-11', '-22'] }); h.session();
  await h.monitor.poll();
  assert.equal(JSON.parse(readFileSync(h.paths.feed)).candidates.length, 0);
  await h.monitor.poll();
  const requests = h.calls.filter(call => call.kind === 'messages'), feed = readFileSync(h.paths.feed, 'utf8');
  assert.equal(requests.length, 4); assert.deepEqual(requests.map(call => call.peer.chatId), ['-11', '-22', '-11', '-22']);
  assert.deepEqual(requests[0].options, { limit: 1 }); assert.deepEqual(requests[2].options, { limit: 20, minId: 10, reverse: true });
  assert.equal(JSON.parse(feed).candidates[0].groupCount, 2);
  assert.ok(!feed.includes('mock-private-text')); assert.ok(!feed.includes('mock-sender')); assert.ok(!feed.includes('-11'));
});

test('late disabling during an awaited Telegram read discards messages and cannot write a candidate feed', async t => {
  let h;
  h = fixture(t, { messages: async () => { h.config.telegramUser.enabled = false; return [{ id: 99, senderId: 'mock-sender', date: when / 1000, message: contract }]; } }); h.session();
  await h.monitor.poll();
  assert.equal(existsSync(h.paths.feed), false);
});

test('changing the Telegram allowlist or disabling it removes the previous private group contribution', async t => {
  const h = fixture(t, { groups: ['-11', '-22', '-33'] }); h.session();
  await h.monitor.poll(); await h.monitor.poll();
  assert.equal(JSON.parse(readFileSync(h.paths.feed)).candidates[0].groupCount, 3);
  h.config.telegramUser.groupIds = ['-11']; await h.monitor.poll();
  const selected = JSON.parse(readFileSync(h.paths.feed)).candidates;
  assert.ok(selected.every(candidate => candidate.groupCount <= 1), 'unselected groups must not contribute to current trading discovery');
  h.config.telegramUser.enabled = false; await h.monitor.poll();
  assert.ok(!existsSync(h.paths.feed) || JSON.parse(readFileSync(h.paths.feed)).candidates.length === 0, 'disabled monitor must not leave an active old candidate feed');
});

test('unknown selected groups and symlinked sessions cannot connect or read other Telegram dialogs', async t => {
  const h = fixture(t); h.session(); h.config.telegramUser.groupIds = ['-999'];
  await h.monitor.poll(); assert.equal(h.calls.filter(call => call.kind === 'messages').length, 0); assert.equal(existsSync(h.paths.feed), false);
  rmSync(h.paths.session); writeFileSync(join(h.root, 'mock-target.json'), '{}', { mode: 0o600 }); symlinkSync(join(h.root, 'mock-target.json'), h.paths.session);
  assert.throws(() => readTelegramSession(h.root), /符号链接/);
});

test('Telegram priority uses only selected IDs, polls them first and records no private group identity', async t => {
  const h = fixture(t, { groups: ['-11', '-22'] }); h.config.telegramUser.vipGroupIds = ['-22']; h.session();
  await h.monitor.poll(); await h.monitor.poll();
  const requests = h.calls.filter(call => call.kind === 'messages'); assert.deepEqual(requests.map(x => x.peer.chatId), ['-22', '-11', '-22', '-11']);
  const feed = JSON.parse(readFileSync(h.paths.feed)); assert.equal(feed.candidates[0].priority, true); assert.equal(h.monitor.view().priorityGroups, 1);
  assert.ok(!JSON.stringify(feed).includes('-22')); assert.ok(!JSON.stringify(feed).includes('mock-private-text'));
  h.config.telegramUser.vipGroupIds = ['-999']; await h.monitor.poll(); assert.equal(h.monitor.view().state, 'setup-required');
});

test('revoking priority status during an awaited read discards the old priority contribution', async t => {
  let h, change = false;
  h = fixture(t, { messages: async (_peer, options) => { if (change) h.config.telegramUser.vipGroupIds = []; return [{ id: options.minId ? options.minId + 1 : 10, senderId: 'mock-sender', date: when / 1000, message: contract }]; } });
  h.config.telegramUser.vipGroupIds = ['-11']; h.session(); await h.monitor.poll(); change = true; await h.monitor.poll();
  const feed = JSON.parse(readFileSync(h.paths.feed)); assert.equal(feed.candidates.length, 0); assert.equal(h.monitor.view().state, 'reloading');
});
