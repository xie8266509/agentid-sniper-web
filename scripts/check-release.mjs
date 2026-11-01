import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isReleaseSourcePath, readReleaseConfig, validateReleaseManifest } from '../lib/release-info.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const digest = value => createHash('sha256').update(value).digest('hex');
const forbiddenPath = name => /(?:^|\/)(?:config\.json|data|node_modules|baw2|baw2pkg|wallets?|credentials?|secrets?|\.git|\.npmrc|\.env(?:\..*)?|data_wallets\.txt|WATCH_STOP|WEB_STOP)(?:\/|$)/i.test(name) || /\.(?:pem|key|p12|pfx|keystore|log|sqlite3?|db|bak|backup)$/i.test(name);
const placeholder = value => /(?:test[_ -]?only|fake|fixture|example|dummy|mock|redacted|sensitive|keep[_ -]?private|secret[_ -]?to[_ -]?hide|your[_ -]|change[_ -]?me)/i.test(value) || /^([x0*])\1{7,}$/i.test(value);
// Retained historical fixtures use these exact plain-English sentinel values.
// They are exempt only inside test sources; concrete token formats stay blocked.
const historicalTestSentinels = new Set(['new-config-after-update', 'local-private-value']);

/** Pattern screening, not a claim that arbitrary unknown credentials can be identified. */
export function findSecretKinds(text, path = '') {
  const kinds = new Set();
  const patterns = [
    ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/],
    ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/],
    ['aws-access-key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
    ['telegram-token', /\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/],
  ];
  for (const [kind, pattern] of patterns) if (pattern.test(text)) kinds.add(kind);
  const assignments = /\b(?:api[_ -]?key|botToken|accessToken|refreshToken|sessionToken|agentSessionId|clientId|privateKey|mnemonic|seedPhrase|password|secret)["']?\s*[:=]\s*["']([^"'\r\n]{16,})["']/gi;
  for (const match of text.matchAll(assignments)) if (!placeholder(match[1]) && !(path.startsWith('tests/') && historicalTestSentinels.has(match[1])) && !/^(?:\$\{|process\.env\.|\.\.\.)/.test(match[1])) kinds.add('literal-credential');
  if (!path.startsWith('tests/') && /\/(?:Users|home)\/(?!runner(?:\/|\b)|<|\$)[A-Za-z0-9._-]+\/(?:[^\s"'`]+\/)?/.test(text)) kinds.add('personal-absolute-path');
  return [...kinds];
}

function git(root, args, input) {
  try { return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.quotePath=false', ...args], { cwd: root, input, maxBuffer: 128 << 20, stdio: ['pipe', 'pipe', 'pipe'] }); }
  catch { throw new Error('无法完成 Git 发行历史检查'); }
}

function historyIssues(root) {
  const issues = [];
  const oldNames = new Set(git(root, ['log', '--all', '--pretty=format:', '--name-only', '-z']).toString('utf8').split('\0').map(name => name.trim()).filter(Boolean));
  for (const path of oldNames) if (forbiddenPath(path)) issues.push({ scope: 'history', path, category: 'private-runtime-path' });
  const objects = git(root, ['rev-list', '--objects', '--all']).toString('utf8').trim().split('\n').filter(Boolean).map(line => {
    const space = line.indexOf(' '); return { oid: space === -1 ? line : line.slice(0, space), path: space === -1 ? '' : line.slice(space + 1) };
  });
  if (objects.some(item => !/^[a-f0-9]{40}$/.test(item.oid))) throw new Error('Git 历史对象列表无效');
  const source = git(root, ['cat-file', '--batch'], objects.map(item => item.oid).join('\n') + '\n');
  let offset = 0, scanned = 0;
  for (const item of objects) {
    const end = source.indexOf(10, offset); if (end === -1) throw new Error('Git 历史对象读取不完整');
    const header = source.subarray(offset, end).toString('ascii').match(/^([a-f0-9]{40}) (blob|commit|tree|tag) (\d+)$/);
    if (!header || header[1] !== item.oid) throw new Error('Git 历史对象读取不完整');
    const size = Number(header[3]), begin = end + 1; if (!Number.isSafeInteger(size) || begin + size >= source.length) throw new Error('Git 历史对象读取不完整');
    const bytes = source.subarray(begin, begin + size); offset = begin + size + 1;
    if (header[2] === 'tree') continue;
    if (size > 8 << 20) { issues.push({ scope: 'history', path: item.path || item.oid.slice(0, 12), category: 'oversized-history-object' }); continue; }
    if (bytes.includes(0)) continue;
    scanned++;
    for (const category of findSecretKinds(bytes.toString('utf8'), item.path)) issues.push({ scope: 'history', path: item.path || item.oid.slice(0, 12), category });
  }
  return { issues, scanned };
}

export function checkRelease({ root = ROOT, history = true } = {}) {
  root = resolve(root);
  const issues = [], pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  let manifest;
  try { manifest = validateReleaseManifest(readFileSync(join(root, 'release.json'), 'utf8'), { expectedVersion: pkg.version }); }
  catch { throw new Error('发行清单缺失或无效，请先运行 npm run release:prepare'); }
  const channel = readReleaseConfig(root);
  if (!channel.repository || channel.disabledReason) issues.push({ scope: 'release', path: 'release-config.json', category: 'unconfigured-release-channel' });
  if (pkg.license !== 'MIT') issues.push({ scope: 'release', path: 'package.json', category: 'missing-mit-metadata' });
  for (const path of ['LICENSE', 'lib/vendor/element-sdk-LICENSE', 'NOTICE', 'config.example.json', 'package-lock.json']) if (!Object.hasOwn(manifest.files, path)) issues.push({ scope: 'release', path, category: 'required-release-file-missing' });
  for (const [path, hash] of Object.entries(manifest.files)) {
    if (!isReleaseSourcePath(path) || forbiddenPath(path)) { issues.push({ scope: 'release', path, category: 'private-runtime-path' }); continue; }
    const full = join(root, path);
    if (!existsSync(full)) { issues.push({ scope: 'release', path, category: 'file-missing' }); continue; }
    const stat = lstatSync(full);
    if (!stat.isFile() || stat.isSymbolicLink()) { issues.push({ scope: 'release', path, category: 'non-regular-file' }); continue; }
    const bytes = readFileSync(full);
    if (digest(bytes) !== hash) issues.push({ scope: 'release', path, category: 'manifest-hash-mismatch' });
    if (!bytes.includes(0)) for (const category of findSecretKinds(bytes.toString('utf8'), path)) issues.push({ scope: 'release', path, category });
  }
  const example = JSON.parse(readFileSync(join(root, 'config.example.json'), 'utf8'));
  if (example.monitorOnly !== true || example.enableFileCommands !== false || !Array.isArray(example.wallets) || example.wallets.length || example.paid?.maxBnbPerDay !== 0 || Object.values(example.telegram || {}).some(Boolean)) issues.push({ scope: 'release', path: 'config.example.json', category: 'unsafe-install-defaults' });
  const tracked = git(root, ['ls-files', '-z']).toString('utf8').split('\0').filter(Boolean);
  for (const path of tracked) {
    if (forbiddenPath(path)) issues.push({ scope: 'index', path, category: 'private-runtime-path' });
    else if (isReleaseSourcePath(path) && path !== 'release.json' && !Object.hasOwn(manifest.files, path)) issues.push({ scope: 'index', path, category: 'tracked-source-missing-from-manifest' });
  }
  const past = history ? historyIssues(root) : { issues: [], scanned: 0 };
  issues.push(...past.issues);
  const unique = [...new Map(issues.map(item => [JSON.stringify(item), item])).values()];
  return { ok: unique.length === 0, appVersion: manifest.appVersion, releaseFiles: Object.keys(manifest.files).length, historicalTextObjects: past.scanned, issues: unique, screening: 'Known credential patterns and private paths; no credential values are printed.' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { const result = checkRelease(); console.log(JSON.stringify(result, null, 2)); if (!result.ok) process.exitCode = 1; }
  catch { console.error(JSON.stringify({ ok: false, error: '发行检查未完成，请核对发行清单、Git 仓库和示例配置；未输出文件内容。' })); process.exitCode = 1; }
}
