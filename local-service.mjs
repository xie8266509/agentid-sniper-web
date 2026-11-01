// macOS background runner. Usage: node local-service.mjs start|stop|status [web]
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const DIR = dirname(SELF), DATA = join(DIR, 'data');
const WEB = process.argv[3] === 'web';
const WORKER = join(DIR, WEB ? 'server.mjs' : 'watch.mjs');
const STOP = join(DIR, WEB ? 'WEB_STOP' : 'WATCH_STOP'), PID_FILE = join(DATA, WEB ? 'web_service.json' : 'local_service.json');
const RUN_ARGS = [SELF, 'run', ...(WEB ? ['web'] : [])];
const command = process.argv[2] || 'status';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
mkdirSync(DATA, { recursive: true });

function servicePid() {
  try {
    const { pid } = JSON.parse(readFileSync(PID_FILE, 'utf8'));
    if (!Number.isSafeInteger(pid) || pid <= 1) return null;
    process.kill(pid, 0);
    const ps = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
    return ps.status === 0 && ps.stdout.includes(RUN_ARGS.join(' ')) ? pid : null;
  } catch { return null; }
}

function status() {
  const pid = servicePid();
  console.log(`服务：${pid ? '后台运行中（监控进程退出后自动重启）' : '已停止'}`);
  if (pid) console.log(`管理进程 PID：${pid}`);
  if (WEB) { console.log(`控制台：http://127.0.0.1:${process.env.PORT || 4317}`); return Boolean(pid); }
  const config = JSON.parse(readFileSync(join(DIR, 'config.json'), 'utf8'));
  console.log(`模式：${config.monitorOnly === true ? '只读监控' : '自动交易'}`);
  const heartbeat = join(DATA, 'watch_heartbeat.txt');
  if (existsSync(heartbeat)) {
    console.log(`心跳：${readFileSync(heartbeat, 'utf8').trim()}`);
    console.log(`心跳距今：${Math.round((Date.now() - statSync(heartbeat).mtimeMs) / 1000)} 秒`);
  }
  console.log(`日志：${join(DATA, 'watch.log')}`);
  return Boolean(pid);
}

if (command === 'start') {
  const config = JSON.parse(readFileSync(join(DIR, 'config.json'), 'utf8'));
  if (config.monitorOnly !== true && !config.wallets?.length) throw new Error('交易模式需要先配置 wallets');
  const check = spawnSync(process.execPath, ['--check', WORKER], { encoding: 'utf8' });
  if (check.status !== 0) throw new Error(check.stderr || '程序语法检查失败');
  if (servicePid()) {
    console.log('服务已在运行；修改配置后请先 stop 再 start。');
    status();
  } else {
    rmSync(STOP, { force: true });
    const fd = openSync(join(DATA, WEB ? 'web_console.log' : 'watch_console.log'), 'a', 0o600);
    let child;
    try {
      child = spawn(process.execPath, RUN_ARGS, { cwd: DIR, detached: true, stdio: ['ignore', fd, fd] });
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      writeFileSync(PID_FILE, JSON.stringify({ pid: child.pid, startedAt: new Date().toISOString() }) + '\n', { mode: 0o600 });
      child.unref();
    } finally { closeSync(fd); }
    await delay(300);
    if (!servicePid()) throw new Error('后台进程启动失败，请检查 data/watch_console.log');
    console.log(`后台服务已启动，PID：${child.pid}`);
  }
} else if (command === 'stop') {
  writeFileSync(STOP, '');
  const pid = servicePid();
  if (pid) {
    // A detached supervisor owns its process group; terminate its worker as well.
    try { process.kill(-pid, 'SIGTERM'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
    for (let i = 0; i < 80 && servicePid(); i++) await delay(100);
    if (servicePid()) { process.kill(-pid, 'SIGKILL'); await delay(200); }
  }
  rmSync(PID_FILE, { force: true });
  console.log('后台服务已停止。');
} else if (command === 'status') {
  process.exitCode = status() ? 0 : 1;
} else if (command === 'run') {
  let child, stopping = false;
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
    stopping = true;
    child?.kill(signal);
  });
  while (!stopping && !existsSync(STOP)) {
    const result = await new Promise((resolve) => {
      child = spawn(process.execPath, [WORKER], { cwd: DIR, stdio: 'inherit' });
      child.once('error', (e) => { console.error(e.message); resolve('spawn error'); });
      child.once('exit', (code, signal) => resolve(signal || code));
    });
    child = undefined;
    if (stopping || existsSync(STOP)) break;
    console.log(`${new Date().toISOString()} ${WEB ? 'Web' : 'watch.mjs'} 退出（${result}），5 秒后重启`);
    await delay(5000);
  }
} else {
  throw new Error('用法：node local-service.mjs start|stop|status');
}
