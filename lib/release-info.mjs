import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const RELEASE_SCHEMA_VERSION = 1;
export const UPSTREAM_REPOSITORY = 'nancyc0813-maker/agentid-sniper';
export const DEFAULT_RELEASE_REPOSITORY = 'xie8266509/agentid-sniper-web';
export const STABLE_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
export const RELEASE_REPOSITORY = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,99})$/;
const HASH = /^[a-f0-9]{64}$/, COMMIT = /^[a-f0-9]{40}$/;
const ROOT_FILES = new Set(['.gitignore', 'LICENSE', 'NOTICE', 'CONTRIBUTING.md', 'SECURITY.md', 'CHANGELOG.md', 'CODE_OF_CONDUCT.md', 'config.example.json', 'release-config.json', 'package.json', 'package-lock.json', 'version.json', 'watch.mjs', 'server.mjs', 'local-service.mjs', 'login.mjs', 'setup.mjs', 'setup_wallet2.bat', 'start_hidden.vbs', 'start_loop.bat', '一键安装.bat']);
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));

export function isReleaseSourcePath(name, { allowManifest = false } = {}) {
  if (typeof name !== 'string' || name.length > 240 || name.includes('\\') || /[\u0000-\u001f\u007f]/.test(name) || name.startsWith('/') || name.split('/').some(part => !part || part === '.' || part === '..')) return false;
  if (name === 'release.json') return allowManifest;
  const parts = name.split('/');
  if (parts.some(part => /^(?:\.env(?:\..*)?|config\.json|data|node_modules|baw2|baw2pkg|\.git|wallets?|credentials?|secrets?)$/i.test(part) || /\.(?:pem|key|p12|pfx|keystore|log|sqlite|db|bak|backup)$/i.test(part))) return false;
  if (ROOT_FILES.has(name) || /^README(?:[._-][^/]*)?\.md$/.test(name)) return true;
  if (/^\.github\/(?:workflows\/[^/]+\.ya?ml|ISSUE_TEMPLATE\/[^/]+\.(?:md|ya?ml)|PULL_REQUEST_TEMPLATE(?:\.md)?|dependabot\.ya?ml)$/.test(name)) return true;
  if (/^(?:lib|scripts|tests)\/[A-Za-z0-9_.\/-]+$/.test(name)) return /\.(?:mjs|js|json|md)$/.test(name) || /(?:^|\/)[A-Za-z0-9_.-]*LICENSE(?:\.[A-Za-z]+)?$/.test(name);
  if (/^web\/[A-Za-z0-9_.\/-]+\.(?:html|css|js|mjs|svg|png|jpg|jpeg|webp|ico)$/.test(name)) return true;
  return /^docs\/[A-Za-z0-9_.\/-]+\.(?:md|txt|svg|png|jpg|jpeg|webp)$/.test(name);
}

export function validateReleaseManifest(raw, { expectedVersion } = {}) {
  const input = typeof raw === 'string' || Buffer.isBuffer(raw) ? JSON.parse(String(raw)) : raw;
  if (!plain(input) || input.schemaVersion !== RELEASE_SCHEMA_VERSION || !STABLE_VERSION.test(input.appVersion || '') || !STABLE_VERSION.test(input.upstreamVersion || '') || !COMMIT.test(input.upstreamCommit || '') || !plain(input.files)) throw new Error('发行清单格式无效');
  if (expectedVersion && input.appVersion !== expectedVersion.replace(/^v/, '')) throw new Error('发行标签与版本清单不一致');
  const entries = Object.entries(input.files);
  if (!entries.length || entries.length > 2000 || entries.some(([name, hash]) => !isReleaseSourcePath(name) || typeof hash !== 'string' || !HASH.test(hash))) throw new Error('发行清单包含无效路径或校验值');
  for (const required of ['package.json', 'release-config.json', 'watch.mjs', 'server.mjs', 'web/index.html']) if (!Object.hasOwn(input.files, required)) throw new Error('发行清单缺少核心文件：' + required);
  return { schemaVersion: 1, appVersion: input.appVersion, upstreamVersion: input.upstreamVersion, upstreamCommit: input.upstreamCommit, files: Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b))) };
}

export function readReleaseConfig(root) {
  const path = join(root, 'release-config.json');
  if (!existsSync(path)) return { schemaVersion: 1, repository: null, channel: 'stable', upstream: null, disabledReason: '尚未配置增强版发行仓库' };
  let value; try { value = JSON.parse(readFileSync(path, 'utf8')); } catch { return { repository: null, channel: 'stable', disabledReason: '发行渠道配置无效，请核对 release-config.json' }; }
  if (!plain(value) || value.schemaVersion !== 1 || value.channel !== 'stable' || value.repository !== null && !RELEASE_REPOSITORY.test(value.repository || '') || value.repository === UPSTREAM_REPOSITORY) return { repository: null, channel: 'stable', disabledReason: '发行渠道配置无效；原作者仓库仅供维护者同步' };
  const upstream = plain(value.upstream) ? value.upstream : null;
  if (upstream && (upstream.repository !== UPSTREAM_REPOSITORY || !STABLE_VERSION.test(upstream.version || '') || !COMMIT.test(upstream.commit || ''))) return { repository: null, channel: 'stable', disabledReason: '上游基线信息无效' };
  return { schemaVersion: 1, repository: value.repository, channel: 'stable', upstream, disabledReason: value.repository ? null : '尚未配置增强版发行仓库' };
}

export function readAppReleaseInfo(root, { commit = null } = {}) {
  let version = 'local';
  try { const value = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version; if (STABLE_VERSION.test(value || '')) version = 'v' + value; } catch {}
  const config = readReleaseConfig(root);
  return { version, appVersion: version, commit: typeof commit === 'string' && COMMIT.test(commit) ? commit : null, upstreamVersion: config.upstream?.version ? 'v' + config.upstream.version : null, upstreamCommit: config.upstream?.commit || null, repository: config.repository, channel: config.channel, disabledReason: config.disabledReason };
}

export function compareReleaseVersions(a, b) {
  const left = String(a).replace(/^v/, ''), right = String(b).replace(/^v/, '');
  if (!STABLE_VERSION.test(left) || !STABLE_VERSION.test(right)) throw new Error('稳定版本号无效');
  const aa = left.split('.').map(BigInt), bb = right.split('.').map(BigInt);
  for (let i = 0; i < 3; i++) if (aa[i] !== bb[i]) return aa[i] > bb[i] ? 1 : -1;
  return 0;
}
