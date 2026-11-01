import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isReleaseSourcePath, validateReleaseManifest, readReleaseConfig } from '../lib/release-info.mjs';

export function buildReleaseManifest(root) {
  root = realpathSync(root);
  const git = args => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: root, encoding: 'utf8', maxBuffer: 8 << 20 });
  if (realpathSync(git(['rev-parse', '--show-toplevel']).trim()) !== root) throw new Error('请在发布仓库根目录生成清单');
  const config = readReleaseConfig(root), pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  if (!config.repository) throw new Error('请先确定正式发行仓库');
  const names = [...new Set(git(['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0'))]
    .filter(name => name && name !== 'release.json' && isReleaseSourcePath(name)).sort();
  const files = {};
  for (const name of names) {
    const path = join(root, name);
    if (!existsSync(path)) continue;
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024) throw new Error('发布文件不是普通源码或过大：' + name);
    if (!realpathSync(path).startsWith(root + '/')) throw new Error('发布文件必须在仓库内：' + name);
    files[name] = createHash('sha256').update(readFileSync(path)).digest('hex');
  }
  const manifest = { schemaVersion: 1, appVersion: pkg.version, upstreamVersion: config.upstream.version, upstreamCommit: config.upstream.commit, files };
  validateReleaseManifest(manifest, { expectedVersion: pkg.version });
  return manifest;
}

export function prepareRelease(root, { check = false } = {}) {
  const manifest = buildReleaseManifest(root), path = join(root, 'release.json'), content = JSON.stringify(manifest, null, 2) + '\n';
  if (check) {
    if (!existsSync(path) || readFileSync(path, 'utf8') !== content) throw new Error('release.json 与发布源码不一致，请运行 npm run release:prepare');
  } else {
    const temporary = path + '.' + process.pid + '.tmp';
    try { writeFileSync(temporary, content, { flag: 'wx', mode: 0o644 }); renameSync(temporary, path); }
    finally { rmSync(temporary, { force: true }); }
  }
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const manifest = prepareRelease(dirname(dirname(fileURLToPath(import.meta.url))), { check: process.argv.includes('--check') });
    console.log(`发行清单 v${manifest.appVersion}：${Object.keys(manifest.files).length} 个文件，${process.argv.includes('--check') ? '校验通过' : '已生成'}`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
