import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../watch.mjs', import.meta.url), 'utf8');
const when = 1793534400000, target = '0x' + '1'.repeat(40);
const extract = (start, end) => { const a = source.indexOf(start), b = source.indexOf(end, a); assert.ok(a >= 0 && b > a); return source.slice(a, b); };
const DateStub = class extends Date { static now() { return when; } };
function broadcast({ serial = '', proof = true, agents = 120, heatError = false, blacklisted = false } = {}) {
  const sent = [], S = { paid: { [target]: { agents, heatAt: when } }, black: blacklisted ? { 'mock-deployer': true } : {} };
  const sandbox = { S, Date: DateStub, TG: { a: 'mock-bot' }, GROUP_ID: 'mock-group', ENTRY_POLICY: { minAgents: 115 }, deployerOf: async () => 'mock-deployer', serialDev: async () => serial, verifyAgentProject: async () => proof, heatOf: async (_c, P) => { if (heatError) throw Error('mock network'); P.heatAt = when; P.agents = agents; }, sleep: async () => {}, ts: () => 'mock-time', log() {}, AbortSignal: { timeout: () => ({}) }, fetch: async (_url, opts) => sent.push(JSON.parse(opts.body)) };
  vm.runInNewContext(extract('async function groupProgress(', 'async function riskNote(') + '\nglobalThis.run = groupProgress;', sandbox);
  return { sandbox, S, sent };
}

test('group progress broadcast requires chain identity, sufficient participants and deployment checks', async () => {
  for (const options of [{ serial: 'mock bulk deployer' }, { proof: false }, { agents: 114 }, { blacklisted: true }]) {
    const h = broadcast(options); await h.sandbox.run(target, 'mock-project', .8); assert.equal(h.sent.length, 0, JSON.stringify(options));
  }
  const h = broadcast(); await h.sandbox.run(target, 'mock-project', .8); await h.sandbox.run(target, 'mock-project', .9);
  assert.equal(h.sent.length, 1); assert.equal(h.S.grpOnce[target], 1);
});

test('a failed fresh participation read never sends a stale group progress announcement', async () => {
  const h = broadcast({ heatError: true }); h.S.paid[target].heatAt = when - 120001;
  await h.sandbox.run(target, 'mock-project', .8); assert.equal(h.sent.length, 0); assert.equal(h.S.g70[target], undefined);
});

test('background discovery heat ignores prior-day projects and checks new verified group signals first', async () => {
  const checked = [], learned = [], paid = {};
  for (let i = 0; i < 20; i++) paid['old-' + i] = { at: when - 86400001, progress: .2, done: {} };
  paid['recent-earlier'] = { at: when - 10000, progress: .2, done: {} };
  paid['recent-newer'] = { at: when - 5000, progress: .2, done: {} };
  paid['social-priority'] = { at: when - 15000, progress: .1, groupSignalAt: when, done: {} };
  const sandbox = { S: { paid }, WALLETS: [{ id: 'stable-wallet', name: 'renamed' }], INFRA: new Set(), Date: DateStub, hk: P => P.heatAt || 0, heatTier: () => 0, heatOf: async (c, P) => { checked.push(c); P.heatAt = when; }, learnReplay: async c => { learned.push(c); return null; }, observeFreeMint: async () => {}, log() {} };
  vm.runInNewContext(extract('async function heatWatch(', 'function freshDeadline(') + '\nglobalThis.run = heatWatch;', sandbox);
  await sandbox.run(); assert.deepEqual(checked, ['social-priority', 'recent-newer', 'recent-earlier']); assert.deepEqual(learned, ['social-priority']);
});

test('lightweight progress sweep excludes prior-day and completed wallet identities', async () => {
  const checked = [], paid = { old: { at: when - 86400001, done: {} }, recent: { at: when - 1000, done: {} }, completed: { at: when - 1000, done: { 'stable-wallet': true } } };
  const sandbox = { S: { paid }, Date: DateStub, WALLETS: [{ id: 'stable-wallet', name: 'renamed' }], freeProgress: async c => { checked.push(c); return .3; }, call: async () => null, log() {} };
  vm.runInNewContext(extract('async function progressSweep(', 'async function autoMint(') + '\nglobalThis.run = progressSweep;', sandbox);
  await sandbox.run(); assert.deepEqual(checked, ['recent']); assert.equal(paid.old.progress, undefined);
});

test('normal paid project queue excludes prior-day projects and prioritizes newer never-checked projects', async () => {
  const paid = {};
  for (let i = 0; i < 20; i++) paid['old-' + i] = { at: when - 86400001, done: {} };
  for (let i = 0; i < 20; i++) paid['recent-' + i] = { at: when - (20 - i) * 1000, done: {}, progress: .2 };
  const sandbox = { S: { paid, umReset: 3, refundReset: 1, progressFixV: 2, forceDone: {}, migrated2: 1, mixedPhaseV: 1 }, Date: DateStub, MONITOR_ONLY: false, WALLETS: [{ id: 'stable-wallet' }], CONFIG: {}, FORCE: new Set(), HOT: new Map(), fpCache: new Map(), syncWalletProfiles() {}, recoverScannerWallet: async () => {}, canWallet: () => true, paidFor: () => ({ goPct: .6, maxAgeH: 168 }), getPaidConfig: () => ({}), resetPaidBudgetDay() {} };
  const head = extract('async function paidLoop(', '  for (const [c, P] of ents) {');
  vm.runInNewContext(head + 'return ents.map(([c]) => c); }\nglobalThis.run = paidLoop;', sandbox);
  const ids = Array.from(await sandbox.run('rest'));
  assert.equal(ids.length, 16); assert.equal(ids[0], 'recent-19'); assert.equal(ids.at(-1), 'recent-4'); assert.ok(ids.every(id => !id.startsWith('old-')));
});

test('scanner discards awaited social results and name notifications after groups, priority or enablement are revoked', async () => {
  const { socialSelectionHash } = await import('../lib/social-candidates.mjs');
  for (const revoke of [settings => { settings.enabled = false; }, settings => { settings.groupIds = ['-22']; }, settings => { settings.vipGroupIds = []; }]) {
    const settings = { enabled: true, groupIds: ['-11'], vipGroupIds: ['-11'] }, S = {}, sent = [], writes = [];
    const sandbox = { S, Date: DateStub, DIR: '/fixture-scanner', currentRuntimeConfig: () => ({ telegramUser: settings }), socialSelectionHash,
      join: (...parts) => parts.join('/'), existsSync: () => true, statSync: () => ({ size: 100 }), readFileSync: () => '{}',
      verifyAgentProject: async () => true, SAFE_WEB: async () => {}, findSocialNameHints: async () => [], validMintAddress: value => /^0x[a-f0-9]{40}$/.test(value), INFRA: new Set(), noLink: value => value,
      log: text => sent.push(text), tg: async text => sent.push(text), save: () => writes.push(true),
      processSocialCandidates: async options => { await Promise.resolve(); revoke(settings); await options.onNameHints({ host: 'mock-project.test', addresses: [target] }); return [{ address: target, observedAt: when, groupCount: 1, senderCount: 1, priority: true }]; } };
    vm.runInNewContext(extract('function socialConfigScope(', 'async function notifyFreeMint(') + '\nglobalThis.run = socialCandidateWatch;', sandbox);
    await sandbox.run(); assert.equal(S.paid, undefined); assert.deepEqual(sent, []); assert.deepEqual(writes, []);
  }
});

test('unknown or malformed participation counts cannot authorize a group progress announcement', async () => {
  for (const agents of [undefined, null, NaN, '120', 120.5]) {
    const h = broadcast(); h.S.paid[target].agents = agents;
    await h.sandbox.run(target, 'mock-project', .8); assert.equal(h.sent.length, 0, String(agents));
  }
  for (const heatAt of [when + 1, '1793534400000', NaN]) {
    const h = broadcast({ heatError: true }); h.S.paid[target].heatAt = heatAt;
    await h.sandbox.run(target, 'mock-project', .8); assert.equal(h.sent.length, 0, String(heatAt));
  }
});
