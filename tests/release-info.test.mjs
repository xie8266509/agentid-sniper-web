import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEFAULT_RELEASE_REPOSITORY, compareReleaseVersions, isReleaseSourcePath, readAppReleaseInfo, readReleaseConfig, validateReleaseManifest } from '../lib/release-info.mjs';

const manifest = () => ({ schemaVersion: 1, appVersion: '0.1.0', upstreamVersion: '2.5.8', upstreamCommit: 'a'.repeat(40), files: Object.fromEntries(['package.json', 'release-config.json', 'watch.mjs', 'server.mjs', 'web/index.html'].map(name => [name, 'b'.repeat(64)])) });

test('release paths include the application, CI, licenses and documentation but exclude local credentials', () => {
  for (const name of ['lib/local-updater.mjs', 'lib/vendor/element-sdk-LICENSE', 'web/favicon.svg', 'scripts/check-release.mjs', 'tests/local-updater.test.mjs', '.github/workflows/ci.yml', 'docs/legacy/windows-install.txt', 'README.local.md']) assert.equal(isReleaseSourcePath(name), true, name);
  for (const name of ['config.json', 'data/wallets/session.json', '.env', '.env.example', 'docs/.env.md', 'docs/key.pem', 'scripts/../config.json', '/server.mjs', 'web\\secret.js', 'node_modules/a.js', 'baw2/index.js', 'release.json']) assert.equal(isReleaseSourcePath(name), false, name);
  assert.equal(isReleaseSourcePath('release.json', { allowManifest: true }), true);
});

test('release manifest is stable-versioned, excludes itself and requires core application files', () => {
  assert.equal(validateReleaseManifest(manifest(), { expectedVersion: 'v0.1.0' }).appVersion, '0.1.0');
  assert.throws(() => validateReleaseManifest(manifest(), { expectedVersion: 'v0.2.0' }), /标签/);
  const self = manifest(); self.files['release.json'] = 'a'.repeat(64); assert.throws(() => validateReleaseManifest(self), /路径/);
  const missing = manifest(); delete missing.files['server.mjs']; assert.throws(() => validateReleaseManifest(missing), /核心文件/);
  const prerelease = manifest(); prerelease.appVersion = '0.1.0-rc.1'; assert.throws(() => validateReleaseManifest(prerelease), /格式/);
});

test('application and upstream versions remain separate without a Git checkout', t => {
  const root = mkdtempSync(join(tmpdir(), 'release-info-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '0.1.0' }));
  writeFileSync(join(root, 'release-config.json'), JSON.stringify({ schemaVersion: 1, repository: DEFAULT_RELEASE_REPOSITORY, channel: 'stable', upstream: { repository: 'nancyc0813-maker/agentid-sniper', version: '2.5.8', commit: 'a'.repeat(40) } }));
  const info = readAppReleaseInfo(root); assert.equal(info.version, 'v0.1.0'); assert.equal(info.upstreamVersion, 'v2.5.8'); assert.equal(info.commit, null);
  writeFileSync(join(root, 'release-config.json'), JSON.stringify({ schemaVersion: 1, repository: 'nancyc0813-maker/agentid-sniper', channel: 'stable' }));
  assert.equal(readReleaseConfig(root).repository, null); assert.match(readReleaseConfig(root).disabledReason, /原作者仓库/);
});

test('version ordering is numeric and never accepts prerelease or branch names', () => {
  assert.equal(compareReleaseVersions('v0.10.0', 'v0.9.99'), 1);
  assert.equal(compareReleaseVersions('0.1.0', 'v0.1.0'), 0);
  assert.equal(compareReleaseVersions('0.1.0', '0.2.0'), -1);
  assert.throws(() => compareReleaseVersions('main', '0.1.0'));
});
