import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { DEFAULT_CONFIG } from '../lib/config.mjs';
import { checkRelease, findSecretKinds } from '../scripts/check-release.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'release-screening-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const files = {
    'package.json': JSON.stringify({ name: 'agentid-sniper-web', version: '0.1.0', license: 'MIT' }),
    'release-config.json': JSON.stringify({ schemaVersion: 1, repository: 'example/agentid-sniper-web', channel: 'stable', upstream: { repository: 'nancyc0813-maker/agentid-sniper', version: '2.5.8', commit: 'a'.repeat(40) } }),
    'watch.mjs': '// Fixture only; never started.\n',
    'server.mjs': '// Fixture only; never started.\n',
    'web/index.html': '<h1>Fixture</h1>\n',
    'LICENSE': 'MIT License\n',
    'NOTICE': 'Upstream and local contributors\n',
    'lib/vendor/element-sdk-LICENSE': 'MIT License\n',
    'config.example.json': JSON.stringify(structuredClone(DEFAULT_CONFIG)),
    'package-lock.json': '{"lockfileVersion":3}\n',
  };
  const put = (path, value) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), value); };
  for (const [path, value] of Object.entries(files)) put(path, value);
  put('release.json', JSON.stringify({ schemaVersion: 1, appVersion: '0.1.0', upstreamVersion: '2.5.8', upstreamCommit: 'a'.repeat(40), files: Object.fromEntries(Object.entries(files).map(([path, value]) => [path, hash(value)])) }));
  git('init', '-b', 'main'); git('config', 'user.name', 'Release Test'); git('config', 'user.email', 'test@example.invalid'); git('add', '.'); git('commit', '-m', 'fixture');
  return { root, git, put };
}

test('release screening allows obvious fake test credentials but detects concrete token patterns', () => {
  assert.deepEqual(findSecretKinds("apiKey: 'TEST_ONLY_FAKE_MARKET_KEY'", 'tests/fixture.mjs'), []);
  const token = 'ghp_' + 'Ab12'.repeat(10);
  assert.ok(findSecretKinds(token, 'tests/fixture.mjs').includes('github-token'));
  assert.ok(findSecretKinds('-----BEGIN ' + 'PRIVATE KEY-----').includes('private-key'));
  assert.ok(findSecretKinds("apiKey: '" + 'aB3zQ7kP9nR2sU6tV4wX' + "'").includes('literal-credential'));
  assert.deepEqual(findSecretKinds("secret: 'new-config-after-update'", 'tests/history.mjs'), []);
  assert.ok(findSecretKinds("secret: 'new-config-after-update'", 'lib/runtime.mjs').includes('literal-credential'));
});

test('safe manifest files and history pass without reading runtime data', t => {
  const f = fixture(t); f.put('data/wallets/session.json', 'local secret outside publication');
  const result = checkRelease({ root: f.root });
  assert.equal(result.ok, true); assert.equal(result.releaseFiles, 10); assert.ok(result.historicalTextObjects > 0);
});

test('manifest mismatch and a staged local configuration are rejected without content output', t => {
  const f = fixture(t); f.put('watch.mjs', '// Edited after manifest\n');
  const secret = 'local-private-value'; f.put('config.json', JSON.stringify({ secret })); f.git('add', 'config.json');
  const result = checkRelease({ root: f.root });
  assert.equal(result.ok, false); assert.ok(result.issues.some(x => x.category === 'manifest-hash-mismatch'));
  assert.ok(result.issues.some(x => x.path === 'config.json' && x.scope === 'index'));
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test('a credential removed from current source is still found in Git history', t => {
  const f = fixture(t), token = 'ghp_' + 'Cd34'.repeat(10);
  f.put('legacy.mjs', `const retired = '${token}';\n`); f.git('add', 'legacy.mjs'); f.git('commit', '-m', 'retired fixture');
  rmSync(join(f.root, 'legacy.mjs')); f.git('add', '-u'); f.git('commit', '-m', 'remove retired fixture');
  const result = checkRelease({ root: f.root });
  assert.equal(result.ok, false); assert.ok(result.issues.some(x => x.scope === 'history' && x.category === 'github-token'));
  assert.equal(JSON.stringify(result).includes(token), false);
  assert.equal(readFileSync(join(f.root, 'watch.mjs'), 'utf8'), '// Fixture only; never started.\n');
});
