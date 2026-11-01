import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createLocalUpdater, UPDATE_REPOSITORY } from '../lib/local-updater.mjs';
import { assertWalletMaintenanceIdle } from '../lib/wallet-executor.mjs';
import { DEFAULT_RELEASE_REPOSITORY, isReleaseSourcePath } from '../lib/release-info.mjs';

const hash = (s) => createHash('sha256').update(s).digest('hex');
function fixture(t, { upstream = '// upstream one\nexport const n = 1;\n// stable middle\n// stable other\n// tail\n', local, version = '0.1.0', change, validateCandidate, beforeApply, invalidManifest = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'agentid-updater-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'main'); git('config', 'user.name', 'Updater Test'); git('config', 'user.email', 'test@example.invalid'); git('remote', 'add', 'origin', UPDATE_REPOSITORY);
  const put = (name, data) => { mkdirSync(join(root, name, '..'), { recursive: true }); writeFileSync(join(root, name), data); };
  const baseline = 'a'.repeat(40);
  put('release-config.json', JSON.stringify({ schemaVersion: 1, repository: DEFAULT_RELEASE_REPOSITORY, channel: 'stable', upstream: { repository: 'nancyc0813-maker/agentid-sniper', version: '2.5.8', commit: baseline } }));
  const release = (v, source) => { put('watch.mjs', source); put('package.json', JSON.stringify({ name: 'agentid-sniper-web', version: v, type: 'module' })); };
  const sealManifest = () => {
    const files = {};
    const walk = path => { for (const entry of readdirSync(join(root, path), { withFileTypes: true })) {
      if (['.git', 'data', 'node_modules'].includes(entry.name)) continue;
      const name = path ? path + '/' + entry.name : entry.name;
      if (entry.isDirectory()) walk(name); else if (isReleaseSourcePath(name)) files[name] = hash(readFileSync(join(root, name)));
    } };
    walk(''); const appVersion = JSON.parse(readFileSync(join(root, 'package.json'))).version;
    put('release.json', JSON.stringify({ schemaVersion: 1, appVersion, upstreamVersion: '2.5.8', upstreamCommit: baseline, files }));
  };
  put('.gitignore', 'data/\nconfig.json\nnode_modules/\n'); put('login.mjs', 'export const login = true;\n'); put('server.mjs', 'export const server = true;\n'); put('web/index.html', '<h1>local web</h1>');
  release(version, upstream); sealManifest(); git('add', '.'); git('commit', '-m', `v${version}`); const base = git('rev-parse', 'HEAD'); git('tag', 'v' + version);
  if (change) change({ put, release, git, root, upstream });
  else release('0.1.1', upstream.replace('n = 1', 'n = 2'));
  sealManifest();
  if (invalidManifest) { const info = JSON.parse(readFileSync(join(root, 'release.json'))); info.files[typeof invalidManifest === 'string' ? invalidManifest : 'watch.mjs'] = '0'.repeat(64); put('release.json', JSON.stringify(info)); }
  git('add', '.'); git('commit', '-m', 'v0.1.1'); const target = git('rev-parse', 'HEAD'); git('tag', 'v0.1.1'); git('reset', '--hard', base);
  put('watch.mjs', local ?? upstream + '// local wallet and NFT patch\n'); put('lib/local-feature.mjs', 'export const nft = true;\n'); put('tests/local.test.mjs', 'import { test } from "node:test"; test("local", () => {});');
  put('config.json', '{"secret":"keep-private"}'); put('data/wallets/session.json', 'private-session');
  const published = { id: 1, tag_name: 'v0.1.1', draft: false, prerelease: false, published_at: new Date(Date.now() - 1000).toISOString(), commit: target, html_url: 'https://github.com/' + DEFAULT_RELEASE_REPOSITORY + '/releases/tag/v0.1.1', body: 'fixture release' };
  const updater = createLocalUpdater({ root, fetchLatest: async () => published, validateCandidate: validateCandidate || (async ({ directory, localTests }) => { assert.equal(existsSync(join(directory, 'config.json')), false); assert.equal(existsSync(join(directory, 'data')), false); assert.ok(localTests.includes('tests/local.test.mjs')); assert.equal(readFileSync(join(directory, 'web/index.html'), 'utf8'), '<h1>local web</h1>'); return { testsPassed: true }; }), beforeApply });
  return { root, git, put, updater, base, target, upstream, published, sealManifest };
}

// Exercise the production Release discovery branch without reaching GitHub.
// The fixture already contains the tagged objects; only network transport and
// that tag fetch are doubled. Validation, merge, source writes and rollback run.
function publicReleaseUpdater(f, { now, published = () => f.published } = {}) {
  const calls = [], requests = [];
  const updater = createLocalUpdater({ root: f.root, ...(now ? { now } : {}),
    fetchImpl: async (url, options) => { requests.push({ url, options }); return { ok: true, status: 200, text: async () => JSON.stringify(published()) }; },
    runCommand: async (file, args, options = {}) => {
      calls.push(args);
      if (args.includes('fetch')) return { code: 0, stdout: '', stderr: '' };
      if (args.includes('FETCH_HEAD^{commit}')) return { code: 0, stdout: f.target + '\n', stderr: '' };
      try { return { code: 0, stdout: execFileSync(file, args, { cwd: options.cwd || f.root, env: { ...process.env, ...options.env }, encoding: options.encoding || 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), stderr: '' }; }
      catch (e) { return { code: e.status || 1, stdout: String(e.stdout || ''), stderr: String(e.stderr || '') }; }
    },
  });
  return { updater, calls, requests };
}

test('check discovers update without changing tracked or local source, config, session or HEAD', async (t) => {
  const f = fixture(t), before = readFileSync(join(f.root, 'watch.mjs'), 'utf8');
  const view = await f.updater.check();
  assert.equal(view.phase, 'ready'); assert.equal(view.available, true); assert.equal(view.latest.version, 'v0.1.1');
  assert.equal(f.git('rev-parse', 'HEAD'), f.base); assert.equal(readFileSync(join(f.root, 'watch.mjs'), 'utf8'), before);
  assert.equal(readFileSync(join(f.root, 'config.json'), 'utf8'), '{"secret":"keep-private"}'); assert.equal(readFileSync(join(f.root, 'data/wallets/session.json'), 'utf8'), 'private-session');
});

test('three-way update preserves local wallet/NFT edits and untracked Web, then rollback restores only source', async (t) => {
  const f = fixture(t), before = readFileSync(join(f.root, 'watch.mjs'), 'utf8');
  await f.updater.check(); const updated = await f.updater.update({ targetCommit: f.target });
  assert.equal(updated.phase, 'succeeded'); assert.equal(f.git('rev-parse', 'HEAD'), f.target);
  assert.match(readFileSync(join(f.root, 'watch.mjs'), 'utf8'), /n = 2/); assert.match(readFileSync(join(f.root, 'watch.mjs'), 'utf8'), /local wallet and NFT patch/);
  assert.equal(readFileSync(join(f.root, 'web/index.html'), 'utf8'), '<h1>local web</h1>');
  f.put('config.json', '{"secret":"new-config-after-update"}'); f.put('data/wallets/session.json', 'new-session'); f.put('lib/after-update.mjs', 'new local file');
  const rolled = await f.updater.rollback({ backupId: updated.backupId });
  assert.equal(rolled.phase, 'rolled-back'); assert.equal(f.git('rev-parse', 'HEAD'), f.base); assert.equal(readFileSync(join(f.root, 'watch.mjs'), 'utf8'), before);
  assert.equal(readFileSync(join(f.root, 'config.json'), 'utf8'), '{"secret":"new-config-after-update"}'); assert.equal(readFileSync(join(f.root, 'data/wallets/session.json'), 'utf8'), 'new-session'); assert.equal(readFileSync(join(f.root, 'lib/after-update.mjs'), 'utf8'), 'new local file');
});

test('merge conflict keeps current code and Git HEAD untouched', async (t) => {
  const f = fixture(t, { local: '// upstream one\nexport const n = 500;\n// stable middle\n// stable other\n// tail\n' });
  const before = readFileSync(join(f.root, 'watch.mjs'), 'utf8'); await f.updater.check();
  await assert.rejects(f.updater.update({ targetCommit: f.target }), /合并冲突/);
  assert.equal(f.git('rev-parse', 'HEAD'), f.base); assert.equal(readFileSync(join(f.root, 'watch.mjs'), 'utf8'), before); assert.equal((await f.updater.view()).phase, 'conflict');
});

test('unknown upstream files cannot replace local modules or introduce dependencies', async (t) => {
  const f = fixture(t, { change({ put, release, upstream }) { release('0.1.1', upstream); put('lib/local-feature.mjs', 'bad replacement'); } });
  await f.updater.check(); await assert.rejects(f.updater.update({ targetCommit: f.target }), /本地文件冲突/);
  assert.equal(f.git('rev-parse', 'HEAD'), f.base); assert.equal(readFileSync(join(f.root, 'lib/local-feature.mjs'), 'utf8'), 'export const nft = true;\n');
});

test('invalid upstream hash and changed origin fail checks without installing', async (t) => {
  const f = fixture(t, { invalidManifest: true });
  let view = await f.updater.check(); assert.equal(view.phase, 'manual-review'); assert.match(view.error, /校验不一致/);
  f.git('remote', 'set-url', 'origin', 'https://attacker.invalid/repo'); view = await f.updater.check(); assert.match(view.error, /发行仓库/); assert.equal(f.git('rev-parse', 'HEAD'), f.base);
});

test('validation failure never mutates live source', async (t) => {
  const f = fixture(t, { validateCandidate: async () => { throw new Error('candidate regression test failed'); } });
  const before = readFileSync(join(f.root, 'watch.mjs'), 'utf8'); await f.updater.check();
  await assert.rejects(f.updater.update({ targetCommit: f.target }), /regression/);
  assert.equal(f.git('rev-parse', 'HEAD'), f.base); assert.equal(readFileSync(join(f.root, 'watch.mjs'), 'utf8'), before);
});

test('edits arriving while candidate tests run cancel before replacing any source', async (t) => {
  let f;
  f = fixture(t, { validateCandidate: async () => { f.put('web/index.html', 'user changed web during update'); return {}; } });
  await f.updater.check(); await assert.rejects(f.updater.update({ targetCommit: f.target }), /已变化/);
  assert.equal(f.git('rev-parse', 'HEAD'), f.base); assert.equal(readFileSync(join(f.root, 'web/index.html'), 'utf8'), 'user changed web during update');
});

test('staged user changes block update and source edits after update block rollback', async (t) => {
  const f = fixture(t); await f.updater.check(); f.git('add', 'watch.mjs');
  await assert.rejects(f.updater.update({ targetCommit: f.target }), /暂存区/); f.git('reset', '--', 'watch.mjs');
  const updated = await f.updater.update({ targetCommit: f.target }); f.put('watch.mjs', 'new user edit');
  await assert.rejects(f.updater.rollback({ backupId: updated.backupId }), /已被修改/); assert.equal(readFileSync(join(f.root, 'watch.mjs'), 'utf8'), 'new user edit');
});

test('wallet/service guard failure prevents source changes, and a new process can read persisted progress', async (t) => {
  const f = fixture(t, { beforeApply: async () => { throw new Error('scanner still running'); } }); await f.updater.check();
  await assert.rejects(f.updater.update({ targetCommit: f.target }), /scanner still running/); assert.equal(f.git('rev-parse', 'HEAD'), f.base);
  const again = createLocalUpdater({ root: f.root, fetchLatest: async () => f.published }); assert.match((await again.view()).error, /scanner still running/);
});

test('default validator syntax-checks source and executes only copied local tests', async (t) => {
  const f = fixture(t); const updater = createLocalUpdater({ root: f.root, fetchLatest: async () => f.published });
  await updater.check(); const result = await updater.update({ targetCommit: f.target }); assert.equal(result.phase, 'succeeded'); assert.equal(f.git('rev-parse', 'HEAD'), f.target);
});

test('staging during candidate validation is rejected rather than absorbed into the update index', async (t) => {
  let f; f = fixture(t, { validateCandidate: async () => { f.git('add', 'watch.mjs'); return {}; } });
  await f.updater.check(); await assert.rejects(f.updater.update({ targetCommit: f.target }), /暂存区已变化/);
  assert.equal(f.git('rev-parse', 'HEAD'), f.base); assert.equal(f.git('diff', '--cached', '--name-only'), 'watch.mjs');
});

test('unavailable scanner import dependency requires manual integration without running candidate code', async (t) => {
  let validated = false;
  const f = fixture(t, { change({ release, upstream }) { release('0.1.1', "import missing from 'updater-unknown-package';\n" + upstream); }, validateCandidate: async () => { validated = true; } });
  await f.updater.check(); await assert.rejects(f.updater.update({ targetCommit: f.target }), /运行依赖不可用/);
  assert.equal(validated, false); assert.equal(f.git('rev-parse', 'HEAD'), f.base);
});

test('a failed final ref switch rolls source and index back, without changing local data', async (t) => {
  const f = fixture(t), before = readFileSync(join(f.root, 'watch.mjs'), 'utf8'); let failed = false;
  const updater = createLocalUpdater({ root: f.root, fetchLatest: async () => f.published, validateCandidate: async () => ({}), runCommand: async (file, args, options = {}) => {
    if (file === 'git' && args.includes('update-ref') && !failed) { failed = true; f.put('lib/arrived-during-apply.mjs', 'new file'); return { code: 1, stdout: '', stderr: 'mock failure' }; }
    try { return { code: 0, stdout: execFileSync(file, args, { cwd: options.cwd || f.root, env: { ...process.env, ...options.env }, encoding: options.encoding || 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), stderr: '' }; }
    catch (e) { return { code: e.status || 1, stdout: String(e.stdout || ''), stderr: String(e.stderr || '') }; }
  } });
  await updater.check(); await assert.rejects(updater.update({ targetCommit: f.target }), /Git 操作失败/);
  assert.equal(f.git('rev-parse', 'HEAD'), f.base); assert.equal(readFileSync(join(f.root, 'watch.mjs'), 'utf8'), before); assert.equal(f.git('diff', '--cached', '--name-only'), '');
  assert.equal(readFileSync(join(f.root, 'lib/arrived-during-apply.mjs'), 'utf8'), 'new file'); assert.equal(readFileSync(join(f.root, 'config.json'), 'utf8'), '{"secret":"keep-private"}');
});

test('a live interprocess lock cannot be stolen and does not overwrite another job progress', async (t) => {
  const f = fixture(t); await f.updater.check();
  const stateFile = join(f.root, 'data/local_updates/status.json'), original = readFileSync(stateFile, 'utf8');
  f.put('data/local_updates/update.lock', JSON.stringify({ pid: process.pid, token: 'other-test-process' }));
  await assert.rejects(f.updater.check(), /另一个更新任务/); assert.equal(readFileSync(stateFile, 'utf8'), original);
});

test('restart health and last update survive subsequent checks and a new updater instance', async (t) => {
  const f = fixture(t); await f.updater.check(); const result = await f.updater.update({ targetCommit: f.target });
  assert.equal(result.restartRequired, true); assert.equal(result.targetCommit, f.target);
  f.updater.markRestartResult({ success: true }); await f.updater.check();
  const again = createLocalUpdater({ root: f.root, fetchLatest: async () => f.published }), view = await again.view();
  assert.equal(view.lastResult.phase, 'succeeded'); assert.equal(view.restartResult.success, true); assert.equal(view.rollback.backupId, result.backupId);
});

test('interrupted apply is not cleared by automatic checking and can recover known pre-apply files', async (t) => {
  const f = fixture(t); await f.updater.check(); const result = await f.updater.update({ targetCommit: f.target });
  const statusFile = join(f.root, 'data/local_updates/status.json'), state = JSON.parse(readFileSync(statusFile)); state.phase = 'applying'; writeFileSync(statusFile, JSON.stringify(state));
  const updater = createLocalUpdater({ root: f.root, fetchLatest: async () => { throw new Error('should not fetch during interrupted apply'); } });
  assert.match((await updater.view()).blockedReason, /中断/); const checked = await updater.check(); assert.match(checked.error, /中断/);
  const rolled = await updater.rollback({ backupId: result.backupId }); assert.equal(rolled.phase, 'rolled-back'); assert.equal(f.git('rev-parse', 'HEAD'), f.base);
});

test('only a published stable Release tag can be selected, never main or a prerelease', async t => {
  const f = fixture(t);
  for (const patch of [{ tag_name: 'main' }, { tag_name: 'v0.1.2-rc.1' }, { draft: true }, { prerelease: true }, { published_at: null }, { html_url: 'https://github.com/attacker/repo/releases/tag/v0.1.1' }]) {
    const updater = createLocalUpdater({ root: f.root, fetchLatest: async () => ({ ...f.published, ...patch }) });
    const checked = await updater.check(); assert.equal(checked.phase, 'manual-review'); assert.match(checked.error, /稳定版本标签/); assert.equal(f.git('rev-parse', 'HEAD'), f.base);
  }
});

test('a just-published Release an hour ahead of the default clock checks, updates and rolls back immediately', async t => {
  const f = fixture(t), before = readFileSync(join(f.root, 'watch.mjs'), 'utf8');
  f.published.published_at = new Date(Date.now() + 3600000).toISOString();
  f.put('data/local_updates/status.json', JSON.stringify({ phase: 'manual-review', error: '旧的本机时钟拒绝', blockedReason: '旧的本机时钟拒绝' }));
  const { updater, requests, calls } = publicReleaseUpdater(f); // No injected now or clock compensation.
  for (let i = 0; i < 2; i++) {
    const checked = await updater.check();
    assert.equal(checked.phase, 'ready'); assert.equal(checked.available, true);
    assert.equal(checked.error, null); assert.equal(checked.blockedReason, null);
    assert.equal(checked.latest.publishedAt, f.published.published_at);
    assert.equal(checked.latest.commit, f.target);
    assert.equal(f.git('rev-parse', 'HEAD'), f.base);
    assert.equal(readFileSync(join(f.root, 'watch.mjs'), 'utf8'), before);
  }
  const updated = await updater.update({ targetCommit: f.target });
  assert.equal(updated.phase, 'succeeded'); assert.equal(f.git('rev-parse', 'HEAD'), f.target);
  assert.equal(requests.length, 3, 'update must re-read and validate the Release after both checks');
  for (const { url, options } of requests) {
    assert.equal(url, 'https://api.github.com/repos/' + DEFAULT_RELEASE_REPOSITORY + '/releases/latest');
    assert.equal(options.redirect, 'error');
  }
  assert.deepEqual(calls.filter(args => args.includes('fetch')).map(args => args.at(-1)), Array(3).fill('refs/tags/v0.1.1'));
  assert.match(readFileSync(join(f.root, 'watch.mjs'), 'utf8'), /n = 2/);
  assert.match(readFileSync(join(f.root, 'watch.mjs'), 'utf8'), /local wallet and NFT patch/);
  assert.equal(readFileSync(join(f.root, 'config.json'), 'utf8'), '{"secret":"keep-private"}');
  assert.equal(readFileSync(join(f.root, 'data/wallets/session.json'), 'utf8'), 'private-session');
  f.put('config.json', '{"secret":"mock-written-after-update"}'); f.put('data/wallets/session.json', 'session-after-update');
  const rolled = await updater.rollback({ backupId: updated.backupId });
  assert.equal(rolled.phase, 'rolled-back'); assert.equal(f.git('rev-parse', 'HEAD'), f.base);
  assert.equal(readFileSync(join(f.root, 'watch.mjs'), 'utf8'), before);
  assert.equal(readFileSync(join(f.root, 'config.json'), 'utf8'), '{"secret":"mock-written-after-update"}');
  assert.equal(readFileSync(join(f.root, 'data/wallets/session.json'), 'utf8'), 'session-after-update');
});

test('Release selection is independent of a client clock a day slow or fast and an equivalent timezone timestamp', async t => {
  const f = fixture(t), publishedAt = '2032-03-15T13:30:00+05:30', timestamp = Date.parse(publishedAt);
  f.published.published_at = publishedAt;
  for (const offset of [-86400000, 86400000]) {
    const { updater } = publicReleaseUpdater(f, { now: () => timestamp + offset });
    const checked = await updater.check();
    assert.equal(checked.phase, 'ready'); assert.equal(checked.available, true);
    assert.equal(checked.latest.publishedAt, publishedAt); assert.equal(checked.latest.commit, f.target);
    assert.equal(f.git('rev-parse', 'HEAD'), f.base);
  }
});

test('missing or malformed publication timestamps remain rejected without source changes', async t => {
  const f = fixture(t), before = readFileSync(join(f.root, 'watch.mjs'), 'utf8');
  for (const publishedAt of [undefined, null, '', '   ', 'not-a-timestamp', '2032-03-15', '2032-03-15T08:00:00', 'March 15, 2032', 0, 1, true, false, {}, []]) {
    const { updater, calls } = publicReleaseUpdater(f, { published: () => ({ ...f.published, published_at: publishedAt }) });
    const checked = await updater.check();
    assert.equal(checked.phase, 'manual-review'); assert.match(checked.error, /稳定版本标签/);
    assert.equal(calls.filter(args => args.includes('fetch')).length, 0, 'invalid release metadata must stop before a tag fetch');
    assert.equal(f.git('rev-parse', 'HEAD'), f.base); assert.equal(readFileSync(join(f.root, 'watch.mjs'), 'utf8'), before);
  }
});

test('future timestamps never bypass published stable tags, repository identity or complete source hashes', async t => {
  const f = fixture(t), before = readFileSync(join(f.root, 'watch.mjs'), 'utf8');
  f.published.published_at = new Date(Date.now() + 3600000).toISOString();
  for (const patch of [{ tag_name: 'main' }, { tag_name: 'v0.1.2-rc.1' }, { draft: true }, { prerelease: true }, { html_url: 'https://github.com/attacker/repo/releases/tag/v0.1.1' }, { tag_name: 'v0.1.2' }]) {
    const { updater } = publicReleaseUpdater(f, { published: () => ({ ...f.published, ...patch }) });
    const checked = await updater.check();
    assert.equal(checked.phase, 'manual-review'); assert.equal(checked.available, false);
    assert.equal(f.git('rev-parse', 'HEAD'), f.base); assert.equal(readFileSync(join(f.root, 'watch.mjs'), 'utf8'), before);
  }
  const tampered = fixture(t, { invalidManifest: 'web/index.html' });
  tampered.published.published_at = f.published.published_at;
  const checked = await publicReleaseUpdater(tampered).updater.check();
  assert.equal(checked.phase, 'manual-review'); assert.match(checked.error, /校验不一致.*web\/index\.html/);
  assert.equal(tampered.git('rev-parse', 'HEAD'), tampered.base);
  f.git('remote', 'set-url', 'origin', 'https://attacker.invalid/repo');
  const { updater, requests } = publicReleaseUpdater(f);
  assert.match((await updater.check()).error, /发行仓库/); assert.equal(requests.length, 0);
  assert.equal(f.git('rev-parse', 'HEAD'), f.base);
});

test('a missing release channel is disabled without fetching or changing source', async t => {
  const f = fixture(t); f.put('release-config.json', JSON.stringify({ schemaVersion: 1, repository: null, channel: 'stable' }));
  let fetched = false; const updater = createLocalUpdater({ root: f.root, fetchLatest: async () => { fetched = true; throw new Error('must not fetch'); } });
  const checked = await updater.check(); assert.equal(checked.phase, 'disabled'); assert.equal(checked.automaticCheck, false); assert.equal(checked.available, false); assert.equal(fetched, false);
  assert.equal(checked.current.version, 'v0.1.0'); assert.equal(f.git('rev-parse', 'HEAD'), f.base);
});

test('complete manifest verification protects Web files as well as the scanner', async t => {
  const f = fixture(t, { invalidManifest: 'web/index.html' });
  const checked = await f.updater.check(); assert.equal(checked.phase, 'manual-review'); assert.match(checked.error, /web\/index\.html/); assert.equal(f.git('rev-parse', 'HEAD'), f.base);
});

test('a released private config path is rejected even when omitted from its manifest', async t => {
  const f = fixture(t, { change({ release, put, git, upstream }) { release('0.1.1', upstream); put('config.json', '{"mock":"not-a-secret"}'); git('add', '-f', 'config.json'); } });
  const checked = await f.updater.check(); assert.equal(checked.phase, 'manual-review'); assert.match(checked.error, /不允许的路径/); assert.equal(f.git('rev-parse', 'HEAD'), f.base);
});

test('binary documentation assets retain exact bytes through update and rollback', async t => {
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0xff, 0xfe, 0x80, 0]);
  const f = fixture(t, { change({ release, put, upstream }) { release('0.1.1', upstream.replace('n = 1', 'n = 2')); put('docs/pixel.png', bytes); } });
  await f.updater.check(); const result = await f.updater.update({ targetCommit: f.target });
  assert.deepEqual(readFileSync(join(f.root, 'docs/pixel.png')), bytes);
  await f.updater.rollback({ backupId: result.backupId }); assert.equal(existsSync(join(f.root, 'docs/pixel.png')), false);
});

test('changed dependency graphs stop before executing candidate tests or installing anything', async t => {
  let validated = false;
  const f = fixture(t, { change({ release, put, upstream }) { release('0.1.1', upstream); put('package.json', JSON.stringify({ name: 'agentid-sniper-web', version: '0.1.1', type: 'module', dependencies: { 'new-package': '1.0.0' } })); }, validateCandidate: async () => { validated = true; } });
  await f.updater.check(); await assert.rejects(f.updater.update({ targetCommit: f.target }), /依赖已变化/); assert.equal(validated, false); assert.equal(f.git('rev-parse', 'HEAD'), f.base);
});

test('released source cannot redirect the configured update channel', async t => {
  const f = fixture(t, { change({ release, put, root, upstream }) { release('0.1.1', upstream); const config = JSON.parse(readFileSync(join(root, 'release-config.json'))); config.repository = 'other-owner/other-project'; put('release-config.json', JSON.stringify(config)); } });
  const checked = await f.updater.check(); assert.equal(checked.phase, 'manual-review'); assert.match(checked.error, /来源/); assert.equal(f.git('rev-parse', 'HEAD'), f.base);
});

test('public Release discovery fetches only its validated tag, not the repository main branch', async t => {
  const f = fixture(t), calls = [], requests = [];
  const updater = createLocalUpdater({ root: f.root,
    fetchImpl: async (url, options) => { requests.push({ url, options }); return { ok: true, status: 200, text: async () => JSON.stringify(f.published) }; },
    runCommand: async (file, args, options = {}) => {
      calls.push(args);
      if (args.includes('fetch')) return { code: 0, stdout: '', stderr: '' };
      if (args.includes('FETCH_HEAD^{commit}')) return { code: 0, stdout: f.target + '\n', stderr: '' };
      try { return { code: 0, stdout: execFileSync(file, args, { cwd: options.cwd || f.root, env: { ...process.env, ...options.env }, encoding: options.encoding || 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), stderr: '' }; }
      catch (e) { return { code: e.status || 1, stdout: String(e.stdout || ''), stderr: String(e.stderr || '') }; }
    },
  });
  const checked = await updater.check(); assert.equal(checked.phase, 'ready');
  assert.equal(requests[0].url, 'https://api.github.com/repos/' + DEFAULT_RELEASE_REPOSITORY + '/releases/latest');
  assert.equal(requests[0].options.redirect, 'error');
  const fetches = calls.filter(args => args.includes('fetch')); assert.equal(fetches.length, 1); assert.equal(fetches[0].at(-1), 'refs/tags/v0.1.1'); assert.equal(fetches[0].includes('main'), false);
});

test('a repository without a published Release never falls back to main', async t => {
  const f = fixture(t); let requests = 0;
  const updater = createLocalUpdater({ root: f.root, fetchImpl: async () => { requests++; return { status: 404, ok: false }; } });
  const checked = await updater.check(); assert.equal(checked.phase, 'idle'); assert.equal(checked.available, false); assert.equal(checked.latest, null); assert.match(checked.message, /尚无/); assert.equal(requests, 1); assert.equal(f.git('rev-parse', 'HEAD'), f.base);
});

test('a source directory symlink cannot redirect update writes outside the project', async t => {
  const f = fixture(t), outside = mkdtempSync(join(tmpdir(), 'updater-outside-')); t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(join(outside, 'index.html'), '<h1>outside file</h1>'); rmSync(join(f.root, 'web'), { recursive: true }); symlinkSync(outside, join(f.root, 'web'), 'dir');
  await f.updater.check(); await assert.rejects(f.updater.update({ targetCommit: f.target }), /符号链接/);
  assert.equal(readFileSync(join(outside, 'index.html'), 'utf8'), '<h1>outside file</h1>'); assert.equal(f.git('rev-parse', 'HEAD'), f.base);
});


function fixtureCommand(f, intercept) {
  return async (file, args, options = {}) => {
    const intercepted = await intercept?.(file, args, options); if (intercepted) return intercepted;
    try { return { code: 0, stdout: execFileSync(file, args, { cwd: options.cwd || f.root, env: { ...process.env, ...options.env }, encoding: options.encoding || 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), stderr: '' }; }
    catch (e) { return { code: e.status || 1, stdout: String(e.stdout || ''), stderr: String(e.stderr || '') }; }
  };
}
const storedUpdate = f => JSON.parse(readFileSync(join(f.root, 'data/local_updates/status.json'), 'utf8'));

test('candidate rejection and pre-write cancellation never persist an interrupted source replacement', async t => {
  for (const cancel of [false, true]) {
    const kinds = [], f = fixture(t, { validateCandidate: async () => { if (!cancel) throw new Error('mock candidate regression'); }, beforeApply: async ({ kind }) => { kinds.push(kind); if (cancel && kind === 'apply') throw Object.assign(new Error('mock auto preference disabled'), { idleDeferred: true }); } });
    const before = readFileSync(join(f.root, 'watch.mjs'), 'utf8'); await f.updater.check();
    await assert.rejects(f.updater.update({ targetCommit: f.target }), cancel ? /preference disabled/ : /candidate regression/);
    assert.notEqual(storedUpdate(f).interrupted, true); assert.equal(readFileSync(join(f.root, 'watch.mjs'), 'utf8'), before); assert.equal(f.git('rev-parse', 'HEAD'), f.base);
    assert.doesNotThrow(() => assertWalletMaintenanceIdle(f.root)); assert.deepEqual(kinds, cancel ? ['prepare', 'apply'] : ['prepare']);
  }
});

test('successful update and complete automatic restore clear the persistent interrupted barrier', async t => {
  for (const failRef of [false, true]) {
    const f = fixture(t), before = readFileSync(join(f.root, 'watch.mjs'), 'utf8'), kinds = []; let injected = false;
    const updater = createLocalUpdater({ root: f.root, fetchLatest: async () => f.published, validateCandidate: async () => ({}), beforeApply: async ({ kind }) => { kinds.push(kind); },
      runCommand: fixtureCommand(f, async (file, args) => { if (file === 'git' && args.includes('update-ref')) { assert.equal(storedUpdate(f).interrupted, true, 'source writes must have a durable barrier'); if (failRef && !injected) { injected = true; return { code: 1, stdout: '', stderr: 'mock ref switch failure' }; } } }),
    });
    await updater.check();
    if (failRef) { await assert.rejects(updater.update({ targetCommit: f.target }), /Git 操作失败/); assert.equal(readFileSync(join(f.root, 'watch.mjs'), 'utf8'), before); assert.equal(f.git('rev-parse', 'HEAD'), f.base); assert.deepEqual(kinds, ['prepare', 'apply', 'rollback']); }
    else { await updater.update({ targetCommit: f.target }); assert.equal(f.git('rev-parse', 'HEAD'), f.target); assert.deepEqual(kinds, ['prepare', 'apply']); }
    assert.equal(storedUpdate(f).interrupted, false); assert.doesNotThrow(() => assertWalletMaintenanceIdle(f.root));
  }
});

test('failed restore after source writes retains the interrupted barrier even when phase becomes failed', async t => {
  const f = fixture(t); let injected = false;
  const updater = createLocalUpdater({ root: f.root, fetchLatest: async () => f.published, validateCandidate: async () => ({}), runCommand: fixtureCommand(f, async (file, args) => {
    if (file === 'git' && args.includes('update-ref') && !injected) {
      injected = true; assert.equal(storedUpdate(f).interrupted, true);
      const storage = join(f.root, 'data/local_updates/backups'), id = readdirSync(storage)[0]; rmSync(join(storage, id, 'source/watch.mjs'));
      return { code: 1, stdout: '', stderr: 'mock switch failure followed by missing backup source' };
    }
  }) });
  await updater.check(); await assert.rejects(updater.update({ targetCommit: f.target }), /自动回退未完成/);
  assert.equal(storedUpdate(f).phase, 'failed'); assert.equal(storedUpdate(f).interrupted, true); assert.equal(f.git('rev-parse', 'HEAD'), f.base);
  assert.match(readFileSync(join(f.root, 'watch.mjs'), 'utf8'), /n = 2/); assert.throws(() => assertWalletMaintenanceIdle(f.root), /尚未恢复/);
  const fresh = createLocalUpdater({ root: f.root, fetchLatest: async () => { throw new Error('must not fetch interrupted source'); } }); await fresh.check(); assert.equal(storedUpdate(f).interrupted, true); assert.throws(() => assertWalletMaintenanceIdle(f.root), /尚未恢复/);
});

test('a manual rollback interrupted after restoring source remains blocked until a complete retry', async t => {
  const f = fixture(t); await f.updater.check(); const updated = await f.updater.update({ targetCommit: f.target }); let failed = false;
  const updater = createLocalUpdater({ root: f.root, fetchLatest: async () => f.published, runCommand: fixtureCommand(f, async (file, args) => {
    if (file === 'git' && args.includes('update-ref') && !failed) { failed = true; assert.equal(storedUpdate(f).interrupted, true); return { code: 1, stdout: '', stderr: 'mock rollback ref switch failure' }; }
  }) });
  await assert.rejects(updater.rollback({ backupId: updated.backupId }), /Git 操作失败/);
  assert.equal(storedUpdate(f).phase, 'failed'); assert.equal(storedUpdate(f).interrupted, true); assert.equal(f.git('rev-parse', 'HEAD'), f.target); assert.throws(() => assertWalletMaintenanceIdle(f.root), /尚未恢复/);
  const recovered = createLocalUpdater({ root: f.root, fetchLatest: async () => f.published }); await recovered.rollback({ backupId: updated.backupId });
  assert.equal(f.git('rev-parse', 'HEAD'), f.base); assert.equal(storedUpdate(f).interrupted, false); assert.doesNotThrow(() => assertWalletMaintenanceIdle(f.root));
});
