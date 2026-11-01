import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { buildReleaseManifest, prepareRelease } from '../scripts/prepare-release.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'release-manifest-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-b', 'main'], { cwd: root, stdio: 'ignore' });
  const put = (path, value) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), value); };
  put('.gitignore', 'config.json\ndata/\n.env\nnode_modules/\n');
  put('package.json', JSON.stringify({ name: 'release-test-only', version: '0.1.0' }));
  put('release-config.json', JSON.stringify({ schemaVersion: 1, repository: 'example/fixture-web', channel: 'stable', upstream: { repository: 'nancyc0813-maker/agentid-sniper', version: '2.5.8', commit: 'a'.repeat(40) } }));
  for (const path of ['watch.mjs', 'server.mjs', 'lib/feature.mjs']) put(path, 'export const fixture = true;\n');
  put('web/index.html', '<h1>fixture</h1>');
  return { root, put };
}

test('release generation covers untracked source while excluding local runtime files', t => {
  const f = fixture(t); f.put('config.json', '{"fixture":true}'); f.put('data/session.json', 'mock-only'); f.put('.env', 'FIXTURE_ONLY=true');
  const manifest = buildReleaseManifest(f.root);
  assert.ok(manifest.files['lib/feature.mjs']); assert.ok(manifest.files['web/index.html']);
  for (const path of ['config.json', 'data/session.json', '.env', 'release.json']) assert.equal(Object.hasOwn(manifest.files, path), false);
  prepareRelease(f.root); assert.deepEqual(prepareRelease(f.root, { check: true }), manifest);
  assert.equal(JSON.parse(readFileSync(join(f.root, 'release.json'), 'utf8')).appVersion, '0.1.0');
});

test('a source edit invalidates the previously generated release manifest', t => {
  const f = fixture(t); prepareRelease(f.root); f.put('lib/feature.mjs', 'export const fixture = false;\n');
  assert.throws(() => prepareRelease(f.root, { check: true }), /不一致/);
});

test('release preparation refuses source symlinks', t => {
  const f = fixture(t); symlinkSync(join(f.root, 'watch.mjs'), join(f.root, 'lib/linked.mjs'));
  assert.throws(() => buildReleaseManifest(f.root), /不是普通源码/);
});
