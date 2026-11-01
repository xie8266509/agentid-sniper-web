import { execFile, spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const HEALTH_PHASES = new Set(['restarting', 'verified', 'rolled-back', 'failed']);

export function readRestartHealth(root) {
  try {
    const value = JSON.parse(readFileSync(join(root, 'data', 'local_updates', 'restart-health.json'), 'utf8'));
    if (!HEALTH_PHASES.has(value.phase) || !/^[a-f0-9]{40}$/.test(value.targetCommit || '')) return null;
    return value;
  } catch { return null; }
}

function writeRestartHealth(root, value) {
  const dir = join(root, 'data', 'local_updates'); mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, 'restart-health.json'), temp = path + '.' + process.pid + '.tmp';
  writeFileSync(temp, JSON.stringify(value) + '\n', { mode: 0o600, flush: true }); renameSync(temp, path);
}

export async function scannerIsActive(root, reported = false, run = exec) {
  if (reported) return true;
  const lock = join(root, 'data', 'watch.lock');
  if (existsSync(lock)) {
    const pid = Number(readFileSync(lock, 'utf8'));
    if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error('扫描器锁文件无效，请先核对扫描进程');
    try { process.kill(pid, 0); return true; } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  const { stdout } = await run('/bin/ps', ['-ax', '-o', 'pid=,command='], { timeout: 5000, maxBuffer: 4 << 20 });
  for (const line of stdout.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(.+)$/);
    if (!match || !/^(?:\S*\/)?node(?:\s|$)/.test(match[2])) continue;
    if (match[2].includes(join(resolve(root), 'watch.mjs'))) return true;
    if (!/(?:^|\s)(?:\.\/)?watch\.mjs(?:\s|$)/.test(match[2])) continue;
    // Direct `node watch.mjs` runs do not have the local supervisor PID file.
    try {
      const result = await run('/usr/sbin/lsof', ['-a', '-p', match[1], '-d', 'cwd', '-Fn'], { timeout: 3000 });
      if (result.stdout.split('\n').includes('n' + resolve(root))) return true;
    } catch { throw new Error('无法核对直启扫描器的工作目录，请先停止扫描进程'); }
  }
  return false;
}

export async function spawnWebRestart({ root, targetCommit, backupId, action = 'update', port = 4317 }) {
  if (!/^[a-f0-9]{40}$/i.test(targetCommit || '') || !['update', 'rollback'].includes(action)) throw new Error('重启目标无效');
  const dir = join(root, 'data', 'local_updates');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const fd = openSync(join(dir, 'restart-worker.log'), 'a', 0o600);
  try {
    const child = spawn(process.execPath, [join(root, 'scripts', 'restart-web-after-update.mjs'), JSON.stringify({ targetCommit, backupId, action, port })], {
      cwd: root, detached: true, stdio: ['ignore', fd, fd],
    });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
  } finally { closeSync(fd); }
}

export async function runWebRestart({ root, targetCommit, backupId, action = 'update', port = 4317 }, injected = {}) {
  if (!/^[a-f0-9]{40}$/.test(targetCommit || '') || !['update', 'rollback'].includes(action) || !Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Web 重启参数无效');
  const record = value => (injected.record || (v => writeRestartHealth(root, v)))({ targetCommit, backupId, action, workerPid: process.pid, ...value });
  const control = injected.control || (async command => exec(process.execPath, [join(root, 'local-service.mjs'), command, 'web'], { cwd: root, timeout: 20000, env: { ...process.env, PORT: String(port) } }));
  const wait = injected.wait || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const isScannerActive = injected.isScannerActive || (() => scannerIsActive(root));
  const healthy = injected.healthy || (async expected => {
    const response = await fetch(`http://127.0.0.1:${port}/api/bootstrap`, { signal: AbortSignal.timeout(2000) });
    if (!response.ok) return false;
    const cookie = response.headers.get('set-cookie')?.split(';')[0];
    const status = await fetch(`http://127.0.0.1:${port}/api/status`, { headers: { cookie: cookie || '' }, signal: AbortSignal.timeout(2000) });
    const value = await status.json(), commit = value.data?.release?.commit;
    return status.ok && typeof commit === 'string' && commit.length >= 7 && expected.startsWith(commit);
  });
  const verify = async expected => {
    for (let i = 0; i < 25; i++) { try { if (await healthy(expected)) return true; } catch {} await wait(1000); }
    return false;
  };
  record({ phase: 'restarting', startedAt: Date.now(), message: '正在重启 Web 并核验目标版本' });
  if (await isScannerActive()) { record({ phase: 'failed', completedAt: Date.now(), error: '扫描器正在运行，Web 更新恢复已暂停' }); throw new Error('扫描器正在运行，Web 更新恢复已暂停'); }
  try {
    await wait(300);
    await control('stop'); await control('start');
    if (!await verify(targetCommit)) throw new Error('新版 Web 未通过启动与版本检查');
    record({ phase: action === 'rollback' ? 'rolled-back' : 'verified', completedAt: Date.now(), message: action === 'rollback' ? '回退版本已启动，配置与持仓数据保持不变' : '更新版本已启动，Web、钱包及 NFT 模块加载正常' });
    return { success: true, rolledBack: action === 'rollback' };
  } catch (failure) {
    if (action !== 'update' || !backupId) { record({ phase: 'failed', completedAt: Date.now(), error: 'Web 重启失败，请检查本地服务日志', message: '自动恢复未完成' }); throw failure; }
    try {
      if (await isScannerActive()) throw new Error('扫描器已启动，停止自动回退');
      await control('stop');
      const rollback = injected.rollback || (async id => {
        const { createLocalUpdater } = await import('./local-updater.mjs');
        return createLocalUpdater({ root, beforeApply: async () => { if (await scannerIsActive(root)) throw new Error('请先停止扫描器'); } }).rollback({ backupId: id });
      });
      const restored = await rollback(backupId), commit = restored.targetCommit || restored.current?.commit;
      if (!/^[a-f0-9]{40}$/.test(commit || '')) throw new Error('回退版本信息无效');
      record({ phase: 'restarting', targetCommit: commit, startedAt: Date.now(), message: '新版启动失败，已恢复旧代码，正在重启 Web' });
      await control('start');
      if (!await verify(commit)) throw new Error('回退 Web 尚未恢复');
      record({ phase: 'rolled-back', targetCommit: commit, completedAt: Date.now(), message: '新版启动失败，已自动恢复更新前版本；配置与持仓数据保持不变' });
      return { success: false, rolledBack: true };
    } catch (rollbackFailure) {
      record({ phase: 'failed', completedAt: Date.now(), error: 'Web 自动回退未完成，请检查备份和本地服务日志', message: '需要手动恢复 Web' });
      throw rollbackFailure;
    }
  }
}
