import { execFileSync } from 'node:child_process';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { atomicWalletJson } from '../lib/wallet-executor.mjs';
import { assertPrivateTelegramPath, loadTelegramLibrary, telegramPaths } from '../lib/telegram-monitor.mjs';

function prompt(label, hidden = false) {
  return new Promise(resolve => {
    let muted = false;
    const output = new Writable({ write(chunk, _encoding, done) { if (!muted) process.stdout.write(chunk); done(); } });
    const rl = createInterface({ input: process.stdin, output, terminal: true });
    rl.question(label, value => { muted = false; if (hidden) process.stdout.write('\n'); rl.close(); resolve(value.trim()); });
    muted = hidden;
  });
}
export async function setupTelegram(root, mode) {
  const paths = telegramPaths(root);
  if (mode === '--install') {
    assertPrivateTelegramPath(paths.root, paths.runtime); mkdirSync(paths.runtime, { recursive: true, mode: 0o700 });
    execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--prefix', paths.runtime, '--ignore-scripts', '--no-audit', '--no-fund', 'telegram@2.26.22'], { stdio: 'inherit', shell: false });
    console.log('可选依赖已安装在 data/telegram_runtime，不修改主程序依赖。下一步：node scripts/setup-telegram.mjs --login'); return;
  }
  if (mode !== '--login') { console.log('手动安装：node scripts/setup-telegram.mjs --install\n手动登录已有账号并选择群：node scripts/setup-telegram.mjs --login'); return; }
  if (!process.stdin.isTTY) throw new Error('请在本机交互终端登录 TG，勿通过聊天传递验证码或会话');
  const { TelegramClient, StringSession } = loadTelegramLibrary(paths.root);
  console.log('个人号只读监听默认关闭。请在 my.telegram.org 获取自己的 api_id / api_hash。登录后只保存你明确选择的群，不发送消息。');
  const apiId = Number(await prompt('api_id：')), apiHash = await prompt('api_hash（不回显）：', true);
  if (!Number.isInteger(apiId) || apiId < 1 || apiId > 2147483647 || !/^[0-9a-f]{32}$/i.test(apiHash)) throw new Error('API 参数格式不正确');
  const client = new TelegramClient(new StringSession(''), apiId, apiHash, { connectionRetries: 1, floodSleepThreshold: 0 }); client.setLogLevel('none');
  try {
    await client.start({ phoneNumber: () => prompt('已有 TG 账号手机号（含国家码，不回显）：', true), phoneCode: () => prompt('TG App 验证码（不回显）：', true), password: () => prompt('两步验证密码（不回显）：', true), onError: () => { console.error('TG 登录未完成，请在本机核对输入。'); } });
    console.log('现在仅为选择监听范围读取群列表，列表不写磁盘。');
    const groups = (await client.getDialogs({ limit: 100 })).filter(dialog => dialog.isGroup || dialog.isChannel);
    for (const dialog of groups) console.log(`${client.getPeerId(dialog.entity)}  ${String(dialog.title || '').replace(/[\r\n\x00-\x1f]/g, '').slice(0, 80)}`);
    const ids = [...new Set((await prompt('允许监听的群 ID（逗号分隔，最多12个；留空取消）：')).split(/[,，\s]+/).filter(Boolean))];
    if (!ids.length) return;
    if (ids.length > 12 || ids.some(id => !/^-?\d{1,16}$/.test(id))) throw new Error('群 ID 格式不正确');
    const peers = {};
    for (const id of ids) {
      const dialog = groups.find(group => client.getPeerId(group.entity) === id); if (!dialog) throw new Error('只能选择本次列表中已加入的群');
      const peer = await client.getInputEntity(dialog.entity);
      if (peer.className === 'InputPeerChannel') peers[id] = { className: peer.className, channelId: peer.channelId.toString(), accessHash: peer.accessHash.toString() };
      else if (peer.className === 'InputPeerChat') peers[id] = { className: peer.className, chatId: peer.chatId.toString() };
      else throw new Error('只支持群和频道');
    }
    assertPrivateTelegramPath(paths.root, paths.session); mkdirSync(dirname(paths.session), { recursive: true, mode: 0o700 }); chmodSync(dirname(paths.session), 0o700);
    atomicWalletJson(paths.session, { version: 1, apiId, apiHash, session: client.session.save(), peers });
    console.log('登录已保存，不输出会话凭据。到 Web「策略 → TG 群监控」填写所选 ID 并单独启用：\n' + ids.join(', '));
  } finally { await client.disconnect(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  setupTelegram(root, process.argv[2]).catch(() => { console.error('TG 设置未完成。请检查可选依赖、输入和网络；不要分享会话文件。'); process.exitCode = 1; });
}
