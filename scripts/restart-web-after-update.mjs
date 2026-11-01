import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { runWebRestart } from '../lib/update-runtime.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const directory = join(root, 'data', 'local_updates'), lock = join(directory, 'restart-worker.lock');
mkdirSync(directory, { recursive: true, mode: 0o700 });
if (existsSync(lock)) {
  const pid = Number(readFileSync(lock, 'utf8'));
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error('Web 重启锁无效');
  let alive = true; try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
  if (alive) throw new Error('另一个 Web 恢复任务正在运行');
  rmSync(lock);
}
writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600, flush: true });
try {
  const request = JSON.parse(process.argv[2] || '{}');
  await runWebRestart({ ...request, root });
} catch {
  console.error('Web 更新恢复失败，请检查 data/local_updates/status.json 和 restart-health.json');
  process.exitCode = 1;
} finally {
  if (Number(readFileSync(lock, 'utf8')) === process.pid) rmSync(lock, { force: true });
}
