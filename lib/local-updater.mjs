import { execFile } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { builtinModules, createRequire } from 'node:module';
import { DEFAULT_RELEASE_REPOSITORY, STABLE_VERSION, UPSTREAM_REPOSITORY, compareReleaseVersions, isReleaseSourcePath, readAppReleaseInfo, readReleaseConfig, validateReleaseManifest } from './release-info.mjs';

const exec = promisify(execFile);
export const UPDATE_REPOSITORY = 'https://github.com/' + DEFAULT_RELEASE_REPOSITORY + '.git';
export const UPDATE_INTERVAL_MS = 30 * 60 * 1000;
const SHA = /^[0-9a-f]{40}$/;
const REQUIRED = new Set(['watch.mjs', 'server.mjs', 'web/index.html', 'web/app.js', 'lib/wallet-cli.mjs', 'lib/nft-automation.mjs', 'lib/local-updater.mjs', 'package.json', 'package-lock.json', 'release-config.json', 'release.json', 'LICENSE']);
const sha = (data) => createHash('sha256').update(data).digest('hex');
const error = (message, phase = 'failed', status = 409) => Object.assign(new Error(message), { phase, status });
const safeMessage = (message) => String(message || '').replace(/\b(?:https?:\/\/)[^\s/]*:[^\s@]*@/gi, 'https://[已隐藏]@').replace(/((?:api[_ -]?key|token|password|secret|authorization|cookie|session[_ -]?id)\s*[=:]\s*)[^\s,;]+/gi, '$1[已隐藏]').slice(0, 400);

function privateJson(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${randomBytes(5).toString('hex')}.tmp`;
  try { writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx', flush: true }); renameSync(temp, path); chmodSync(path, 0o600); }
  finally { rmSync(temp, { force: true }); }
}
function readJson(path, fallback) { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; } }
function allowedSource(name) { return isReleaseSourcePath(name, { allowManifest: true }); }
function assertSourceParents(path) {
  for (let parent = dirname(path); ; parent = dirname(parent)) {
    if (existsSync(parent) && lstatSync(parent).isSymbolicLink()) throw error('源码父目录含符号链接，需手动处理', 'manual-review');
    if (dirname(parent) === parent) break;
  }
}

function fileInfo(path) {
  assertSourceParents(path);
  if (!existsSync(path)) return { exists: false, hash: null, mode: null };
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw error('源码含有符号链接或非普通文件，需手动处理', 'manual-review');
  if (stat.size > 8 * 1024 * 1024) throw error('源码文件过大，需手动处理', 'manual-review');
  return { exists: true, hash: sha(readFileSync(path)), mode: stat.mode & 0o777 };
}
function atomicSource(path, bytes, mode = 0o644) {
  assertSourceParents(path);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.update-${randomBytes(5).toString('hex')}.tmp`;
  try { writeFileSync(temp, bytes, { mode, flag: 'wx', flush: true }); renameSync(temp, path); chmodSync(path, mode); }
  finally { rmSync(temp, { force: true }); }
}

/** Local merge updater. Network checks never install code. Only the caller's
 * explicit update()/rollback() may mutate source, after beforeApply guards. */
export function createLocalUpdater({ root, now = Date.now, intervalMs = UPDATE_INTERVAL_MS, fetchLatest, fetchImpl = fetch, validateCandidate, beforeApply = async () => {}, runCommand, onProgress } = {}) {
  if (!root) throw new Error('Updater root is required');
  root = realpathSync(root);
  const storage = join(root, 'data', 'local_updates'), stateFile = join(storage, 'status.json'), lockFile = join(storage, 'update.lock');
  mkdirSync(storage, { recursive: true, mode: 0o700 }); chmodSync(storage, 0o700);
  if (!realpathSync(storage).startsWith(root + sep)) throw new Error('Updater storage must stay inside project');
  let state = readJson(stateFile, {}), timer, operation, checkFlight, stopped = true;
  if (!state || typeof state !== 'object' || Array.isArray(state)) state = {};
  if (['applying', 'rolling-back'].includes(state.phase)) state.interrupted = true;
  let current;
  const channel = readReleaseConfig(root), repository = channel.repository;
  const repositoryUrl = repository ? 'https://github.com/' + repository + '.git' : null;
  const command = runCommand || (async (file, args, options = {}) => {
    try { const result = await exec(file, args, { cwd: root, encoding: 'utf8', timeout: 60000, maxBuffer: 8 << 20, ...options, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...options.env } }); return { ...result, code: 0 }; }
    catch (e) { return { code: Number.isInteger(e.code) ? e.code : -1, stdout: String(e.stdout || ''), stderr: String(e.stderr || ''), killed: Boolean(e.killed) }; }
  });
  const git = (args, options) => command('git', ['-c', 'core.hooksPath=/dev/null', ...args], options);
  async function gitOk(args, options) { const result = await git(args, options); if (result.code !== 0) throw error('Git 操作失败，请检查本地仓库或网络后重试'); return result.stdout; }
  const persist = () => {
    const saved = readJson(stateFile, {});
    if ((saved.restartResult?.checkedAt || 0) > (state.restartResult?.checkedAt || 0)) state.restartResult = saved.restartResult;
    if ((saved.lastResult?.completedAt || 0) > (state.lastResult?.completedAt || 0)) state.lastResult = saved.lastResult;
    privateJson(stateFile, state); onProgress?.(structuredClone(state));
  };
  function progress(phase, message, completed = 0, extra = {}) {
    state = { ...state, phase, message, progress: { stage: message, completed, total: 5, ...extra }, logs: [...(state.logs || []), safeMessage(message)].slice(-12) }; persist();
  }
  async function currentInfo() {
    const result = await git(['rev-parse', 'HEAD']);
    const commit = result.code === 0 && SHA.test(String(result.stdout).trim()) ? String(result.stdout).trim() : null;
    current = readAppReleaseInfo(root, { commit });
    return current;
  }

  function acquireLock(kind) {
    const token = randomBytes(12).toString('hex');
    if (existsSync(lockFile)) {
      const lock = readJson(lockFile, null);
      if (!lock || !Number.isInteger(lock.pid) || lock.pid <= 1) throw error('更新锁文件无效，需手动核对', 'manual-review');
      let alive = true;
      try { process.kill(lock.pid, 0); } catch (e) { if (e.code === 'ESRCH') alive = false; }
      if (alive) throw error('另一个更新任务正在执行');
      rmSync(lockFile);
    }
    try { writeFileSync(lockFile, JSON.stringify({ pid: process.pid, token, kind, startedAt: now() }), { flag: 'wx', mode: 0o600, flush: true }); }
    catch { throw error('另一个更新任务正在执行'); }
    return () => { if (readJson(lockFile, null)?.token === token) rmSync(lockFile, { force: true }); };
  }
  async function verifyOrigin() {
    if (!repository || readReleaseConfig(root).repository !== repository) throw error(channel.disabledReason || '发行渠道已变化，请重启 Web 后核对', 'disabled');
    const origin = (await gitOk(['remote', 'get-url', 'origin'])).trim().replace(/\/$/, '').replace(/\.git$/, '');
    if (![repositoryUrl.replace(/\.git$/, ''), 'git@github.com:' + repository].includes(origin)) throw error('origin 与增强版发行仓库不一致，已停止更新', 'manual-review');
  }
  async function fetchHead() {
    await verifyOrigin();
    let published;
    if (fetchLatest) published = await fetchLatest();
    else {
      let response;
      try { response = await fetchImpl('https://api.github.com/repos/' + repository + '/releases/latest', { headers: { accept: 'application/vnd.github+json', 'user-agent': 'agentid-sniper-web-updater' }, redirect: 'error', signal: AbortSignal.timeout(15000) }); }
      catch { throw error('检查增强版发行失败，请稍后重试；当前版本不受影响'); }
      if (response.status === 404) return null;
      if (!response.ok) throw error('GitHub 发行检查失败，请稍后重试；当前版本不受影响');
      const text = await response.text(); if (text.length > 2 * 1024 * 1024) throw error('发行信息过大，已停止检查', 'manual-review');
      try { published = JSON.parse(text); } catch { throw error('增强版发行信息无效', 'manual-review'); }
    }
    if (!published) return null;
    const tag = published.tag_name;
    if (published.draft !== false || published.prerelease !== false || !/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(tag || '') || !Number.isFinite(Date.parse(published.published_at)) || Date.parse(published.published_at) > now() + 300000 || published.html_url && published.html_url !== 'https://github.com/' + repository + '/releases/tag/' + tag) throw error('仅支持本仓库已发布的稳定版本标签', 'manual-review');
    let target;
    if (fetchLatest) {
      target = (await gitOk(['rev-parse', 'refs/tags/' + tag + '^{commit}'])).trim();
      if (published.commit && published.commit !== target) throw error('发行标签与目标提交不一致', 'manual-review');
    } else {
      const result = await git(['fetch', '--no-tags', '--no-recurse-submodules', repositoryUrl, 'refs/tags/' + tag], { timeout: 60000 });
      if (result.code !== 0) throw error('获取增强版发行标签失败，当前版本保持不变');
      target = (await gitOk(['rev-parse', 'FETCH_HEAD^{commit}'])).trim();
    }
    if (!SHA.test(target)) throw error('发行提交编号无效', 'manual-review');
    return { tag, commit: target, releaseId: published.id || null, publishedAt: published.published_at, notes: typeof published.body === 'string' ? published.body.split('\n').filter(Boolean).slice(0, 20).map(s => s.slice(0, 600)) : [] };
  }
  async function blob(commit, name) {
    const result = await git(['show', commit + ':' + name], { encoding: 'buffer' });
    if (result.code !== 0) throw error('发行文件缺失：' + name, 'manual-review');
    return Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout);
  }
  async function remoteInfo(selected) {
    const { commit, tag } = selected;
    let manifest;
    try { manifest = validateReleaseManifest(await blob(commit, 'release.json'), { expectedVersion: tag }); }
    catch (e) { throw error(safeMessage(e.message), 'manual-review'); }
    const entries = (await gitOk(['ls-tree', '-r', '--full-tree', '-z', commit])).split('\0').filter(Boolean).map(entry => {
      const match = entry.match(/^(100644|100755) blob [a-f0-9]{40}\t(.+)$/);
      if (!match || !allowedSource(match[2])) throw error('发行包含不允许的路径、符号链接或子模块', 'manual-review');
      return match[2];
    });
    if (JSON.stringify(entries.filter(name => name !== 'release.json').sort()) !== JSON.stringify(Object.keys(manifest.files).sort())) throw error('发行清单未完整覆盖版本源码', 'manual-review');
    for (const [name, expected] of Object.entries(manifest.files)) if (sha(await blob(commit, name)) !== expected) throw error('发行文件校验不一致：' + name, 'manual-review');
    let pack, config;
    try { pack = JSON.parse(await blob(commit, 'package.json')); config = JSON.parse(await blob(commit, 'release-config.json')); } catch { throw error('发行版本或渠道配置无效', 'manual-review'); }
    if (pack.version !== manifest.appVersion || config.schemaVersion !== 1 || config.repository !== repository || config.channel !== 'stable' || config.upstream?.repository !== UPSTREAM_REPOSITORY || config.upstream?.version !== manifest.upstreamVersion || config.upstream?.commit !== manifest.upstreamCommit) throw error('发行版本、来源或上游基线不一致', 'manual-review');
    return { ...selected, version: 'v' + manifest.appVersion, upstreamVersion: 'v' + manifest.upstreamVersion, upstreamCommit: manifest.upstreamCommit };
  }

  async function view() {
    if (!operation && !checkFlight) state = readJson(stateFile, state);
    if (!operation && ['applying', 'rolling-back'].includes(state.phase)) state.interrupted = true;
    const local = await currentInfo();
    const rollback = state.rollback || { available: false };
    const interrupted = Boolean(state.interrupted || (!operation && ['applying', 'rolling-back'].includes(state.phase)));
    const disabledReason = channel.disabledReason || (!repository ? '尚未配置增强版发行仓库' : null);
    const sourceMatches = state.repository === repository;
    const latest = sourceMatches ? state.latest || null : null;
    const available = Boolean(!disabledReason && latest && local.commit && STABLE_VERSION.test(String(local.version).replace(/^v/, '')) && compareReleaseVersions(latest.version, local.version) > 0);
    return { repository: repositoryUrl?.replace(/\.git$/, '') || null, channel: 'stable', intervalMs, automaticCheck: !disabledReason, current: local, latest, available, checkedAt: sourceMatches ? state.checkedAt || null : null, nextCheckAt: sourceMatches ? state.nextCheckAt || null : null, phase: disabledReason ? 'disabled' : interrupted ? 'failed' : state.phase || 'idle', busy: Boolean(operation || checkFlight), message: disabledReason || (interrupted ? '上次更新被中断，请使用回退恢复后重试' : state.message || '每 30 分钟检查增强版稳定发行，安装更新由你触发'), error: disabledReason ? null : state.error || null, blockedReason: disabledReason || state.blockedReason || (interrupted ? '上次更新被中断' : null), progress: state.progress || null, logs: state.logs || [], rollback, lastResult: state.lastResult || null, restartResult: state.restartResult || null };

  }
  async function check() {
    if (channel.disabledReason || !repository) return view();
    if (operation) return view();
    if (checkFlight) return checkFlight;
    checkFlight = (async () => {
      // Ensure the single-flight promise is assigned even when an immediate
      // lock/interrupted-state guard throws before the first Git command.
      await Promise.resolve();
      let release;
      try {
        release = acquireLock('check');
        if (state.interrupted) throw error('上次更新在应用期间中断，请先使用回退恢复');
        progress('checking', '正在检查增强版稳定发行');
        const local = await currentInfo(), selected = await fetchHead(), latest = selected ? await remoteInfo(selected) : null;
        state = { ...state, repository, latest, checkedAt: now(), nextCheckAt: now() + intervalMs, error: null, blockedReason: null };
        const available = latest && STABLE_VERSION.test(String(local.version).replace(/^v/, '')) && compareReleaseVersions(latest.version, local.version) > 0;
        progress(available ? 'ready' : 'idle', !latest ? '尚无已发布稳定版本，当前版本保持不变' : available ? `发现增强版 ${latest.version}，可验证后更新` : '当前已是最新增强版');
      } catch (e) { if (!release) throw e; state = { ...state, error: safeMessage(e.message), blockedReason: e.phase === 'manual-review' || state.interrupted ? safeMessage(e.message) : null, nextCheckAt: now() + intervalMs }; progress(e.phase || 'failed', safeMessage(e.message)); }
      finally { release?.(); checkFlight = null; }
      return view();
    })();
    return checkFlight;
  }
  async function sourceNames() {
    return [...new Set((await gitOk(['ls-files', '--cached', '--others', '--exclude-standard', '-z'])).split('\0').filter(allowedSource))].sort();
  }
  async function snapshotSources(directory) {
    const files = {};
    for (const name of await sourceNames()) {
      const info = fileInfo(join(root, name)); files[name] = info;
      if (info.exists) { mkdirSync(dirname(join(directory, name)), { recursive: true, mode: 0o700 }); copyFileSync(join(root, name), join(directory, name)); chmodSync(join(directory, name), 0o600); }
    }
    return files;
  }
  async function assertUnchanged(files, base, indexPath, indexHash) {
    if ((await gitOk(['rev-parse', 'HEAD'])).trim() !== base) throw error('准备更新期间 Git 版本已变化，已取消');
    if (sha(existsSync(indexPath) ? readFileSync(indexPath) : '') !== indexHash) throw error('准备更新期间 Git 暂存区已变化，已取消');
    const names = await sourceNames();
    if (JSON.stringify(names) !== JSON.stringify(Object.keys(files).sort())) throw error('准备更新期间源码文件列表已变化，已取消');
    for (const [name, info] of Object.entries(files)) { const present = fileInfo(join(root, name)); if (present.hash !== info.hash || present.exists !== info.exists || present.mode !== info.mode) throw error(`准备更新期间 ${name} 已变化，已取消`); }
  }
  async function changedFiles(base, target) {
    const parts = (await gitOk(['diff', '--name-status', '--no-renames', '-z', base, target])).split('\0');
    const files = [];
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const status = parts[i], name = parts[i + 1];
      if (!allowedSource(name) || !['A', 'M', 'D'].includes(status)) throw error(`发行改动了需人工整合的文件：${name || '未知路径'}`, 'manual-review');
      if (status === 'D' && REQUIRED.has(name)) throw error(`发行删除了核心文件 ${name}，需人工整合`, 'manual-review');
      files.push({ status, name });
    }
    return files;
  }
  async function validate(directory, localTests) {
    // Reusing old dependencies cannot validate a changed dependency graph.
    const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value ?? null;
    const stable = value => JSON.stringify(canonical(value));
    const readPackage = base => JSON.parse(readFileSync(join(base, 'package.json'), 'utf8'));
    const oldPackage = readPackage(root), newPackage = readPackage(directory);
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'engines', 'os', 'cpu', 'type']) if (stable(oldPackage[field]) !== stable(newPackage[field])) throw error('发行依赖已变化，请手动安装并验证后更新', 'manual-review');
    const normalizedLock = base => {
      if (!existsSync(join(base, 'package-lock.json'))) return null;
      const value = JSON.parse(readFileSync(join(base, 'package-lock.json'), 'utf8'));
      delete value.name; delete value.version;
      if (value.packages?.['']) { delete value.packages[''].name; delete value.packages[''].version; }
      return value;
    };
    if (stable(normalizedLock(root)) !== stable(normalizedLock(directory))) throw error('发行依赖锁已变化，请手动安装并验证后更新', 'manual-review');

    // node --check alone does not resolve imports. Resolve the scanner's static
    // dependencies without importing it (which would start the real scanner).
    const scanner = readFileSync(join(directory, 'watch.mjs'), 'utf8');
    const imports = [...scanner.matchAll(/\b(?:import|export)\s+(?:[^;'"\n]*?\s+from\s*)?['"]([^'"\n]+)['"]/g), ...scanner.matchAll(/\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g)].map((match) => match[1]);
    const require = createRequire(join(directory, 'watch.mjs'));
    for (const dependency of imports) {
      if (dependency.startsWith('node:')) { if (!builtinModules.includes(dependency.slice(5))) throw error(`上游引入了不可用的运行依赖：${dependency}`, 'manual-review'); continue; }
      if (dependency.startsWith('http:') || dependency.startsWith('https:') || dependency.startsWith('file:') || dependency.startsWith('/')) throw error('上游引入了需人工审查的外部运行依赖', 'manual-review');
      try { require.resolve(dependency); } catch { throw error(`上游运行依赖不可用：${dependency}，需人工整合`, 'manual-review'); }
    }
    if (validateCandidate) return validateCandidate({ directory, localTests });
    const names = [];
    const walk = (path) => { for (const item of readdirSync(path, { withFileTypes: true })) { if (item.name === 'node_modules') continue; const full = join(path, item.name); if (item.isDirectory()) walk(full); else if (/\.m?js$/.test(item.name)) names.push(full); } };
    walk(directory);
    for (const path of names) { const result = await command(process.execPath, ['--check', path], { cwd: directory, timeout: 30000 }); if (result.code !== 0) throw error(`候选代码语法检查失败：${relative(directory, path)}`); }
    if (!localTests.length) throw error('缺少本地回归测试，不能自动更新', 'manual-review');
    const result = await command(process.execPath, ['--test', ...localTests], { cwd: directory, timeout: 120000 });
    writeFileSync(join(dirname(directory), 'validation.log'), (result.stdout || '') + (result.stderr || ''), { mode: 0o600 });
    if (result.code !== 0) throw error('候选版本未通过本地回归测试，原版本保持不变');
    return { testsPassed: true, testSummary: (result.stdout || '').split('\n').filter((line) => /(?:tests|pass|fail) \d/.test(line)).slice(-4) };
  }
  async function indexLocation() { const path = (await gitOk(['rev-parse', '--git-path', 'index'])).trim(); return isAbsolute(path) ? path : resolve(root, path); }
  async function restoreBackup(backup, { interrupted = false } = {}) {
    const manifest = readJson(join(backup, 'manifest.json'), null);
    if (!manifest || !SHA.test(manifest.base || '') || !SHA.test(manifest.target || '') || !Array.isArray(manifest.actions)) throw error('回退备份无效，需手动核对', 'manual-review');
    const head = (await gitOk(['rev-parse', 'HEAD'])).trim();
    if (head !== manifest.target && !(interrupted && head === manifest.base)) throw error('当前 Git 版本已变化，不能覆盖式回退', 'manual-review');
    for (const action of manifest.actions) {
      if (!allowedSource(action.name)) throw error('回退路径无效', 'manual-review');
      const present = fileInfo(join(root, action.name));
      if (present.hash !== action.after.hash && !(interrupted && present.hash === action.before.hash)) throw error(`更新后 ${action.name} 已被修改，回退已停止以保留改动`, 'manual-review');
    }
    const indexPath = await indexLocation();
    const indexHash = sha(existsSync(indexPath) ? readFileSync(indexPath) : '');
    if (![manifest.indexBeforeHash, manifest.indexAfterHash].includes(indexHash)) throw error('Git 暂存区在更新后已变化，回退已停止', 'manual-review');
    await beforeApply({ kind: 'rollback', targetCommit: manifest.base });
    if ((await gitOk(['rev-parse', 'HEAD'])).trim() !== head || sha(existsSync(indexPath) ? readFileSync(indexPath) : '') !== indexHash) throw error('准备回退期间 Git 状态已变化，已取消', 'manual-review');
    for (const action of manifest.actions) {
      const present = fileInfo(join(root, action.name));
      if (present.hash !== action.after.hash && !(interrupted && present.hash === action.before.hash)) throw error('准备回退期间源码已变化，已取消', 'manual-review');
    }
    const indexLock = indexPath + '.lock';
    if (interrupted && existsSync(indexLock) && sha(readFileSync(indexLock)) === manifest.indexAfterHash) rmSync(indexLock);
    let locked = false;
    try {
      try { writeFileSync(indexLock, readFileSync(join(backup, 'index.before')), { flag: 'wx', mode: 0o644, flush: true }); locked = true; }
      catch { throw error('Git 暂存区正被其他操作使用，回退已停止'); }
      for (const action of manifest.actions) {
        const path = join(root, action.name);
        if (action.before.exists) atomicSource(path, readFileSync(join(backup, 'source', action.name)), action.before.mode);
        else rmSync(path, { force: true });
      }
      renameSync(indexLock, indexPath); locked = false;
      if (head !== manifest.base) await gitOk(['update-ref', 'HEAD', manifest.base, head]);
    } finally { if (locked) rmSync(indexLock, { force: true }); }
    return manifest;
  }
  async function update({ targetCommit } = {}) {
    if (operation || checkFlight) throw error('已有更新检查或更新任务正在执行');
    operation = 'update'; let release, backup, applied = false, indexLock;
    const previousRollback = structuredClone(state.rollback || { available: false });
    try {
      release = acquireLock('update');
      if (state.interrupted) throw error('上次更新在应用期间中断，请先使用回退恢复');
      await beforeApply({ kind: 'prepare', targetCommit });
      const local = await currentInfo();
      if (!SHA.test(targetCommit || '') || targetCommit !== state.latest?.commit) throw error('请先检查更新并选择已核验的目标版本');
      progress('preparing', '正在准备隔离候选版本', 0);
      const selected = await fetchHead(), target = selected?.commit;
      if (!selected || target !== targetCommit || selected.tag !== state.latest?.tag || state.repository !== repository) throw error('已发布版本已变化，请重新检查后更新');
      const latest = await remoteInfo(selected);
      if (!local.commit) throw error('一键更新需要 Git 克隆安装', 'manual-review');
      if (target !== local.commit && compareReleaseVersions(latest.version, local.version) <= 0) throw error('不能安装相同版本或较旧版本，请使用回退功能');
      if (target === local.commit) { progress('idle', '当前已是最新增强版', 5); return { ...await view(), needsWebRestart: false, restartRequired: false, targetCommit: local.commit }; }
      if ((await git(['merge-base', '--is-ancestor', local.commit, target])).code !== 0) throw error('发行版本与本地提交不是快进关系，需人工整合', 'manual-review');
      if ((await gitOk(['diff', '--cached', '--name-only'])).trim() || (await gitOk(['diff', '--name-only', '--diff-filter=U'])).trim()) throw error('暂存区或冲突尚未处理，不能自动更新', 'manual-review');
      const changes = await changedFiles(local.commit, target);
      const id = `${now()}-${randomBytes(6).toString('hex')}`;
      backup = join(storage, 'backups', id); mkdirSync(backup, { recursive: true, mode: 0o700 });
      const indexPath = await indexLocation(), indexBefore = existsSync(indexPath) ? readFileSync(indexPath) : Buffer.alloc(0), indexHash = sha(indexBefore);
      writeFileSync(join(backup, 'index.before'), indexBefore, { mode: 0o600 });
      const files = await snapshotSources(join(backup, 'source'));
      const candidate = join(backup, 'candidate'); mkdirSync(candidate, { mode: 0o700 });
      for (const [name, info] of Object.entries(files)) if (info.exists) { mkdirSync(dirname(join(candidate, name)), { recursive: true, mode: 0o700 }); copyFileSync(join(backup, 'source', name), join(candidate, name)); chmodSync(join(candidate, name), info.mode); }
      // Existing dependencies are reused; no installer or upstream setup script runs.
      if (existsSync(join(root, 'node_modules'))) {
        const { symlinkSync } = await import('node:fs'); symlinkSync(join(root, 'node_modules'), join(candidate, 'node_modules'), 'dir');
      }
      const actions = [], conflicts = [];
      for (const change of changes) {
        const { name, status } = change, before = fileInfo(join(root, name));
        if (status === 'A' && before.exists) throw error(`发行新文件与本地文件冲突：${name}`, 'manual-review');
        const base = status === 'A' ? Buffer.alloc(0) : await blob(local.commit, name);
        const remote = status === 'D' ? Buffer.alloc(0) : await blob(target, name);
        if (status !== 'A' && !before.exists && status !== 'D') { conflicts.push(name); continue; }
        let result = remote;
        if (status === 'D' && before.exists && sha(base) !== before.hash) { conflicts.push(name); continue; }
        if (status === 'M' && sha(base) !== before.hash) {
          const temp = join(backup, 'merge'); mkdirSync(temp, { mode: 0o700 });
          const paths = ['local', 'base', 'upstream'].map((part) => join(temp, part));
          [readFileSync(join(root, name)), base, remote].forEach((text, i) => writeFileSync(paths[i], text, { mode: 0o600 }));
          const merge = await git(['merge-file', '-p', '--diff3', ...paths]);
          if (merge.code !== 0) { conflicts.push(name); continue; } result = merge.stdout;
        }
        if (status === 'D') rmSync(join(candidate, name), { force: true });
        else atomicSource(join(candidate, name), result, before.mode || 0o644);
        const after = fileInfo(join(candidate, name)); actions.push({ name, before, after });
      }
      if (conflicts.length) { progress('conflict', '发行版本与本地修改存在冲突，原版本保持不变', 1, { conflicts }); throw error('合并冲突：' + conflicts.join('、'), 'conflict'); }
      progress('testing', '正在验证发行候选代码与本地 Web、钱包、NFT 回归测试', 2, { files: changes.map((x) => x.name) });
      const validation = await validate(candidate, Object.keys(files).filter((name) => /^tests\/[^/]+\.test\.mjs$/.test(name)));
      const newIndex = join(backup, 'index.after');
      await gitOk(['read-tree', target], { env: { GIT_INDEX_FILE: newIndex } }); chmodSync(newIndex, 0o600);
      const manifest = { id, createdAt: now(), base: local.commit, target, fromVersion: local.version, toVersion: state.latest.version, files, actions, indexBeforeHash: indexHash, indexAfterHash: sha(readFileSync(newIndex)) };
      privateJson(join(backup, 'manifest.json'), manifest);
      await beforeApply({ kind: 'apply', targetCommit: target });
      await assertUnchanged(files, local.commit, indexPath, indexHash);
      state.rollback = { available: true, backupId: id, fromVersion: local.version, toVersion: state.latest.version, fromCommit: local.commit, toCommit: target, createdAt: manifest.createdAt };
      progress('applying', '验证通过，正在原子替换已合并的上游文件', 4, { files: actions.map((x) => x.name) });
      // Hold Git's normal index lock while writing files, so another Git
      // command cannot stage changes between the final fingerprint and switch.
      indexLock = indexPath + '.lock';
      try { writeFileSync(indexLock, readFileSync(newIndex), { flag: 'wx', mode: 0o644, flush: true }); }
      catch { indexLock = null; throw error('Git 暂存区正被其他操作使用，更新已取消'); }
      await assertUnchanged(files, local.commit, indexPath, indexHash);
      applied = true;
      for (const action of actions) { const path = join(root, action.name); if (action.after.exists) atomicSource(path, readFileSync(join(candidate, action.name)), action.after.mode); else rmSync(path, { force: true }); }
      renameSync(indexLock, indexPath); indexLock = null;
      await gitOk(['update-ref', 'HEAD', target, local.commit]);
      state = { ...state, error: null, blockedReason: null, completedAt: now(), validation };
      state.lastResult = { phase: 'succeeded', version: state.latest.version, commit: target, backupId: id, completedAt: now(), message: '本地回归测试已通过，更新已应用' };
      state.restartResult = null;
      progress('succeeded', '更新成功，现有本地修改、配置和数据已保留，等待 Web 重启检查', 5);
      return { ...await view(), needsWebRestart: true, restartRequired: true, targetCommit: target, backupId: id };
    } catch (e) {
      if (!release) throw e;
      if (!applied) state.rollback = previousRollback;
      if (applied && backup) {
        try { progress('rolling-back', '更新失败，正在恢复本次修改的源码', 4); await restoreBackup(backup, { interrupted: true }); state.rollback = { ...state.rollback, available: false }; }
        catch (rollbackError) { state = { ...state, error: safeMessage(rollbackError.message), blockedReason: '自动回退未完成，请停止交易并核对备份' }; progress('failed', '更新失败且自动回退未完成，需人工核对'); throw error(state.blockedReason, 'failed', 500); }
      }
      state = { ...state, error: safeMessage(e.message), blockedReason: ['conflict', 'manual-review'].includes(e.phase) ? safeMessage(e.message) : null };
      progress(e.phase || 'failed', safeMessage(e.message)); throw e;
    } finally { if (indexLock) rmSync(indexLock, { force: true }); release?.(); operation = null; }
  }
  async function rollback({ backupId = state.rollback?.backupId } = {}) {
    if (operation || checkFlight) throw error('已有更新检查或更新任务正在执行');
    if (typeof backupId !== 'string' || !/^\d+-[0-9a-f]{12}$/.test(backupId) || backupId !== state.rollback?.backupId) throw error('没有可用的本次更新备份');
    operation = 'rollback'; let release;
    try {
      release = acquireLock('rollback'); progress('rolling-back', '正在回退到更新前的本地源码', 1);
      const manifest = await restoreBackup(join(storage, 'backups', backupId), { interrupted: state.interrupted === true });
      state = { ...state, interrupted: false, error: null, blockedReason: null, rollback: { ...state.rollback, available: false }, completedAt: now() };
      state.lastResult = { phase: 'rolled-back', version: manifest.fromVersion, commit: manifest.base, backupId, completedAt: now(), message: '已恢复本次更新前的本地源码' };
      state.restartResult = null;
      progress('rolled-back', `已回退到 ${manifest.fromVersion}，本地配置和数据保持不变`, 5);
      return { ...await view(), needsWebRestart: true, restartRequired: true, targetCommit: manifest.base, backupId };
    } catch (e) { if (!release) throw e; state = { ...state, error: safeMessage(e.message), blockedReason: safeMessage(e.message) }; progress(e.phase || 'failed', safeMessage(e.message)); throw e; }
    finally { release?.(); operation = null; }
  }
  function start() {
    if (!stopped || channel.disabledReason || !repository) return; stopped = false;
    timer = setInterval(() => { if (!operation && !checkFlight) void check().catch(() => {}); }, intervalMs); timer.unref?.();
    void check().catch(() => {});
  }
  function stop() { stopped = true; if (timer) clearInterval(timer); timer = null; }
  function markRestartResult({ success, error: restartError, rolledBack = false } = {}) {
    state = readJson(stateFile, state);
    state.restartResult = { success: success === true, error: restartError ? safeMessage(restartError) : null, rolledBack: rolledBack === true, checkedAt: now() };
    if (!success) { state.error = safeMessage(restartError || 'Web 重启验证失败'); state.message = rolledBack ? '新版 Web 启动失败，已回退旧版' : 'Web 重启验证失败，请核对本地服务'; }
    else if (state.lastResult?.phase === 'rolled-back' || rolledBack) state.message = '已回退旧版，Web 健康检查通过';
    else state.message = '更新成功，Web 健康检查通过';
    persist(); return state.restartResult;
  }
  return { view, check, update, rollback, start, stop, markRestartResult, isBusy: () => Boolean(operation || checkFlight) };
}
