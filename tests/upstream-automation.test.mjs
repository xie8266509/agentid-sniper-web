import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { UPSTREAM, validateTarget, changedPaths, reviewDocument, mergeAnalysis, prepareUpstreamReview, submitUpstreamReview, createGithubApi } from '../scripts/upstream-automation.mjs';

const main = 'a'.repeat(40), next = 'b'.repeat(40), repository = 'example/fixture-web';
const baseline = { repository: UPSTREAM, version: '2.7.4', commit: 'c'.repeat(40) };
const target = { repository, mainCommit: main, upstreamCommit: next, version: '2.7.6', baseline };
function plan() {
  const doc = reviewDocument({ ...target, paths: [{ path: 'watch.mjs', status: 'M' }], merge: { status: '存在冲突' }, patch: 'diff --git a/watch.mjs b/watch.mjs\n-fixture\n+fixture-next\n' });
  return { ...target, changed: true, branch: 'codex/upstream-2.7.6-' + next.slice(0, 12), path: 'docs/upstream-reviews/v2.7.6-' + next.slice(0, 12) + '.md', doc, manifest: '{"mock":true}\n', risk: { reason: '需人工适配审核' }, merge: { status: '存在冲突' } };
}

test('upstream monitor pins version and SHA and sees same-version source revisions', () => {
  assert.equal(validateTarget(target).changed, true);
  assert.equal(validateTarget({ ...target, upstreamCommit: baseline.commit }).changed, false);
  assert.equal(validateTarget({ ...target, version: baseline.version }).changed, true);
  assert.throws(() => validateTarget({ ...target, version: '2.7.3' }), /moved backwards/);
  assert.throws(() => validateTarget({ ...target, upstreamCommit: 'main; fixture' }), /Invalid/);
  assert.throws(() => validateTarget({ ...target, version: '2.7.6\nmock' }), /Invalid/);
});

test('upstream change parsing refuses traversal, rename ambiguity and oversized packets', () => {
  assert.deepEqual(changedPaths('M\0watch.mjs\0A\0README.md\0'), [{ status: 'M', path: 'watch.mjs' }, { status: 'A', path: 'README.md' }]);
  for (const value of ['M\0../config.json\0', 'M\0/fixture\0', 'R100\0watch.mjs\0', 'M\0fixture\npath\0', 'M\0fixture/../file\0', 'M\0watch.mjs']) assert.throws(() => changedPaths(value), /Invalid|Unsafe/);
  assert.throws(() => changedPaths('M\0fixture\0'.repeat(65)), /oversized/);
});

test('review packet keeps a complete inert patch and explicitly requires compatibility work', () => {
  const patch = '```\n# fixture attacker heading\n```\n';
  const doc = reviewDocument({ ...target, paths: [{ path: 'watch.mjs', status: 'M' }], merge: { status: '存在冲突' }, patch });
  assert.ok(doc.includes('````diff\n' + patch));
  assert.ok(doc.includes('未改变交易代码或上游基线'));
  assert.ok(doc.includes('不代表策略语义已兼容'));
  assert.throws(() => reviewDocument({ ...target, paths: [], merge: {}, patch: 'x'.repeat(1024 * 1024 + 1) }), /limit/);
});

test('three-way analysis uses real Git while leaving local scanner and index unchanged', t => {
  const root = mkdtempSync(join(tmpdir(), 'mock-upstream-analysis-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['--no-optional-locks', ...args], { cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(root, 'watch.mjs'), 'const fixture = 1;\n'); git('add', 'watch.mjs'); git('commit', '-m', 'fixture base'); const base = git('rev-parse', 'HEAD');
  writeFileSync(join(root, 'watch.mjs'), 'const fixture = 2;\n'); git('commit', '-am', 'fixture upstream'); const remote = git('rev-parse', 'HEAD');
  git('checkout', '--detach', base); writeFileSync(join(root, 'watch.mjs'), 'const fixture = 3;\n'); git('commit', '-am', 'fixture local');
  const before = readFileSync(join(root, 'watch.mjs')), index = readFileSync(join(root, '.git/index'));
  assert.equal(mergeAnalysis(root, base, remote).clean, false);
  assert.deepEqual(readFileSync(join(root, 'watch.mjs')), before); assert.deepEqual(readFileSync(join(root, '.git/index')), index);
});

test('an existing upstream PR is deduplicated without writes or branch resets', async () => {
  const p = plan(), calls = [];
  const result = await submitUpstreamReview(p, { api: async (path, options = {}) => { calls.push({ path, ...options }); return [{ head: { ref: p.branch, repo: { full_name: repository } }, html_url: 'https://github.com/example/fixture-web/pull/1' }]; } });
  assert.equal(result.deduplicated, true); assert.equal(calls.length, 1); assert.equal(calls[0].method, undefined);
});

test('review submission writes only inert documentation and its manifest then opens a draft', async () => {
  const p = plan(), calls = [];
  const api = async (path, options = {}) => {
    calls.push({ path, ...options });
    if (path.includes('/pulls?')) return [];
    if (path.endsWith('/git/ref/heads/main')) return { object: { sha: main } };
    if (path.includes('/git/ref/heads/')) return null;
    if (path.endsWith('/git/commits/' + main)) return { tree: { sha: 'd'.repeat(40) } };
    if (path.endsWith('/git/trees')) return { sha: 'e'.repeat(40) };
    if (path.endsWith('/git/commits')) return { sha: 'f'.repeat(40) };
    if (path.endsWith('/git/refs')) return { object: { sha: 'f'.repeat(40) } };
    if (path.endsWith('/pulls')) return { html_url: 'https://github.com/example/fixture-web/pull/2' };
    throw new Error('Unexpected fixture API');
  };
  const result = await submitUpstreamReview(p, { api });
  assert.equal(result.commit, 'f'.repeat(40));
  const tree = calls.find(x => x.path.endsWith('/git/trees')).body.tree;
  assert.deepEqual(tree.map(x => x.path), [p.path, 'release.json']);
  assert.ok(tree.every(x => x.mode === '100644' && x.type === 'blob'));
  assert.equal(calls.find(x => x.path.endsWith('/pulls')).body.draft, true);
  assert.ok(calls.every(x => x.method !== 'PATCH' && x.method !== 'DELETE'));
});

test('main lease loss and unrelated existing branches stop submission without mutation', async () => {
  const p = plan(); let writes = 0;
  await assert.rejects(submitUpstreamReview(p, { api: async path => path.includes('/pulls?') ? [] : { object: { sha: next } } }), /Main advanced/);
  await assert.rejects(submitUpstreamReview(p, { api: async (path, options = {}) => {
    if (options.method) writes++;
    if (path.includes('/pulls?')) return [];
    if (path.endsWith('/main')) return { object: { sha: main } };
    if (path.includes('/git/ref/heads/')) return { object: { sha: next } };
    return { encoding: 'base64', content: Buffer.from('mock human work').toString('base64') };
  } }), /not this review/);
  assert.equal(writes, 0);
  await assert.rejects(submitUpstreamReview({ ...p, branch: 'main' }, { api: async () => { throw new Error('must not call'); } }), /Invalid review branch/);
});

test('GitHub API transport does not redirect tokens or print remote error bodies', async () => {
  const calls = [];
  const api = createGithubApi({ token: 'mock-ephemeral-token', fetchImpl: async (url, options) => { calls.push({ url, options }); return { ok: false, status: 403, async text() { return 'mock-private-error-body'; } }; } });
  await assert.rejects(api('/repos/example/fixture-web/pulls'), error => error.message === 'GitHub API failed (403)' && !error.message.includes('private'));
  assert.equal(calls[0].options.redirect, 'error'); assert.equal(calls[0].options.headers.authorization, 'Bearer mock-ephemeral-token');
  await assert.rejects(api('https://mock.invalid/'), /Unsupported/); assert.equal(calls.length, 1);
});

test('prepare binds exact Git objects and metadata while leaving baseline configuration unchanged', async t => {
  const root = mkdtempSync(join(tmpdir(), 'mock-upstream-prepare-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = JSON.stringify({ repository, channel: 'stable', upstream: baseline }), manifest = JSON.stringify({ upstreamCommit: baseline.commit, files: { 'LICENSE': 'mock-license-hash', 'lib/fixture.mjs': 'mock-source-hash' } });
  writeFileSync(join(root, 'release-config.json'), config); writeFileSync(join(root, 'release.json'), manifest);
  const scanner = Buffer.from('const mock = true;\n'), scannerHash = createHash('sha256').update(scanner).digest('hex'), commands = [];
  let badHash = false;
  const runGit = (_root, args) => {
    commands.push(args);
    if (args[0] === 'rev-parse') return main + '\n';
    if (args[0] === 'fetch' || args[0] === 'merge-base') return '';
    if (args[0] === 'show' && args[1].endsWith(':version.json')) return JSON.stringify({ version: '2.7.6', sha256: badHash ? '0'.repeat(64) : scannerHash });
    if (args[0] === 'show' && args[1].endsWith(':watch.mjs')) return scanner;
    if (args[0] === 'diff' && args.includes('--name-status')) return 'M\0watch.mjs\0';
    if (args[0] === 'diff') return 'diff --git a/watch.mjs b/watch.mjs\n-fixture\n+mock\n';
    throw new Error('Unexpected fixture Git');
  };
  const options = { root, repository, api: async path => path.endsWith('/heads/main') ? { object: { sha: main } } : { sha: next }, runGit, analyzeMerge: () => ({ status: '无文本冲突，仍需语义审核', clean: true }) };
  const prepared = await prepareUpstreamReview(options); assert.equal(prepared.changed, true);
  const candidate = JSON.parse(prepared.manifest);
  assert.deepEqual(Object.keys(candidate.files), ['LICENSE', prepared.path, 'lib/fixture.mjs']);
  assert.equal(candidate.upstreamCommit, baseline.commit, 'a review packet cannot pretend the code is integrated');
  assert.equal(candidate.files[prepared.path], createHash('sha256').update(prepared.doc).digest('hex'));
  assert.deepEqual(commands.find(args => args[0] === 'fetch').slice(-3), ['https://github.com/' + UPSTREAM + '.git', next, baseline.commit]);
  assert.equal(readFileSync(join(root, 'release-config.json'), 'utf8'), config); assert.equal(readFileSync(join(root, 'release.json'), 'utf8'), manifest);
  badHash = true; await assert.rejects(prepareUpstreamReview(options), /scanner hash/);
});
