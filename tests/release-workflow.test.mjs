import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const workflow = readFileSync(new URL('../.github/workflows/publish-release.yml', import.meta.url), 'utf8');
const scripts = [...workflow.matchAll(/node --input-type=module <<'JS'\n([\s\S]*?)\n          JS/g)].map(match => match[1].split('\n').map(line => line.startsWith('          ') ? line.slice(10) : line).join('\n'));
const publish = scripts.at(-1), AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const commit = 'a'.repeat(40), repo = 'xie8266509/agentid-sniper-web';
function fixture({ env = {}, failedVerify = false, mainMoved = false, lateMove = false, tagCommit, existing = false } = {}) {
  const calls = []; let mainReads = 0;
  const values = { 'package.json': { version: '0.4.0' }, 'release.json': { appVersion: '0.4.0', upstreamVersion: '2.7.6', upstreamCommit: 'b'.repeat(40) }, 'release-config.json': { repository: repo, channel: 'stable', upstream: { repository: 'nancyc0813-maker/agentid-sniper', version: '2.7.6', commit: 'b'.repeat(40) } }, 'CHANGELOG.md': '# Fixture\n\n## v0.4.0 — fixture\n\nA fixture release.\n\n## v0.3.0\nOld fixture.' };
  const fakeFetch = async (url, options) => {
    const path = new URL(url).pathname + new URL(url).search; calls.push({ path, ...options }); let data, status = 200;
    if (path.endsWith('/actions/runs/123')) data = { event: 'workflow_dispatch', head_sha: commit, path: '.github/workflows/publish-release.yml' };
    else if (path.endsWith('/jobs?per_page=100')) data = { jobs: [{ name: 'Verify reviewed commit', status: 'completed', conclusion: failedVerify ? 'failure' : 'success' }] };
    else if (path.endsWith('/git/ref/heads/main')) data = { object: { sha: mainMoved || lateMove && ++mainReads > 1 ? 'c'.repeat(40) : commit } };
    else if (path.includes('/contents/')) { const name = path.split('/contents/')[1].split('?')[0], text = typeof values[name] === 'string' ? values[name] : JSON.stringify(values[name]); data = { encoding: 'base64', content: Buffer.from(text).toString('base64') }; }
    else if (path.endsWith('/git/ref/tags/v0.4.0')) { if (tagCommit || existing) data = { object: { type: 'commit', sha: tagCommit || commit } }; else status = 404; }
    else if (path.endsWith('/releases/tags/v0.4.0')) { if (existing) data = { draft: false, prerelease: false, tag_name: 'v0.4.0', html_url: 'https://github.com/' + repo + '/releases/tag/v0.4.0' }; else status = 404; }
    else if (path.endsWith('/releases/latest')) data = { tag_name: 'v0.3.0' };
    else if (path.endsWith('/git/refs') && options.method === 'POST') data = { object: { sha: commit } };
    else if (path.endsWith('/releases') && options.method === 'POST') data = { html_url: 'https://github.com/' + repo + '/releases/tag/v0.4.0' };
    else throw new Error('Unexpected mock request ' + path);
    return { ok: status === 200, status, async text() { return JSON.stringify(data || {}); } };
  };
  const process = { env: { RELEASE_VERSION: '0.4.0', RELEASE_COMMIT: commit, GITHUB_REPOSITORY: repo, GITHUB_REF: 'refs/heads/main', GITHUB_SHA: commit, GITHUB_RUN_ID: '123', REVIEWED: 'true', GH_TOKEN: 'mock-job-token', ...env } };
  return { calls, run: () => new AsyncFunction('process', 'fetch', 'Buffer', 'console', publish)(process, fakeFetch, Buffer, { log() {} }) };
}

test('release write job has no checkout, candidate scripts, npm or downloaded artifacts', () => {
  assert.equal(scripts.length, 3); const writeJob = workflow.split('\n  publish:\n')[1];
  assert.ok(writeJob.includes('contents: write')); assert.ok(writeJob.includes('needs: verify'));
  assert.ok(!/uses:\s*actions\/(?:checkout|download-artifact)|run:\s*(?:npm|node scripts\/)/.test(writeJob));
  const upstream = readFileSync(new URL('../.github/workflows/upstream-review.yml', import.meta.url), 'utf8');
  assert.ok(upstream.includes("cron: '7,22,37,52 * * * *'"));
  assert.ok(upstream.includes('needs: prepare') && upstream.includes('contents: read') && upstream.includes('pull-requests: write'));
});

test('actual workflow publisher creates only the exact reviewed tag and stable Latest release', async () => {
  const f = fixture(); await f.run(); const writes = f.calls.filter(x => x.method === 'POST');
  assert.equal(writes.length, 2);
  assert.deepEqual(JSON.parse(writes[0].body), { ref: 'refs/tags/v0.4.0', sha: commit });
  const release = JSON.parse(writes[1].body);
  assert.equal(release.target_commitish, commit); assert.equal(release.draft, false); assert.equal(release.prerelease, false); assert.equal(release.make_latest, 'true');
  assert.ok(release.body.includes('A fixture release.') && !release.body.includes('Old fixture.'));
  assert.ok(f.calls.every(x => x.redirect === 'error'));
});

test('publisher refuses missing approval, branch dispatch and unbound version or SHA before any request', async () => {
  for (const env of [{ REVIEWED: 'false' }, { GITHUB_REF: 'refs/heads/mock' }, { RELEASE_VERSION: '0.4.0; mock' }, { RELEASE_COMMIT: 'main' }, { GITHUB_SHA: 'b'.repeat(40) }, { GITHUB_REPOSITORY: 'example/fixture' }]) {
    const f = fixture({ env }); await assert.rejects(f.run(), /reviewed release approval/); assert.equal(f.calls.length, 0);
  }
});

test('failed exact-commit verification, advanced main or moved tag cannot publish', async () => {
  for (const settings of [{ failedVerify: true }, { mainMoved: true }, { lateMove: true }, { tagCommit: 'c'.repeat(40) }]) {
    const f = fixture(settings); await assert.rejects(f.run(), /verification|Main|tag/); assert.equal(f.calls.filter(x => x.method === 'POST').length, 0);
  }
});

test('stable release retries are idempotent and never move existing tags', async () => {
  const f = fixture({ existing: true }); await f.run(); assert.equal(f.calls.filter(x => x.method === 'POST').length, 0);
});
