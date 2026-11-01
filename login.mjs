// node login.mjs 1 — uses the same isolated session as the local web console.
import { readConfig } from './lib/config.mjs';
import { runWallet } from './lib/wallet-cli.mjs';
const index = Number(process.argv[2] || 1) - 1;
if (!Number.isInteger(index) || index < 0 || index >= Math.max(readConfig().wallets.length, 1)) throw new Error('找不到这个钱包');
const signin = await runWallet(['auth', 'signin'], { walletIndex: index });
if (!signin.success) { console.error(signin.error.message); process.exit(1); }
if (signin.data?.status !== 'ALREADY_CONNECTED') {
  const { urlForWeb, pairingCode, qrCodeId } = signin.data || {};
  if (!urlForWeb || !pairingCode || !qrCodeId) throw new Error('登录响应缺少配对信息');
  console.log(`用币安 App 打开以下链接确认登录：\n${urlForWeb}\n配对码：${pairingCode}\n等待手机确认…`);
  const verified = await runWallet(['auth', 'verify', '--qrCodeId', qrCodeId], { walletIndex: index, timeout: 330000 });
  if (!verified.success) { console.error(verified.error.message); process.exit(1); }
}
const status = await runWallet(['wallet', 'status'], { walletIndex: index });
if (status.data?.status !== 'CONNECTED') { console.error(status.error?.message || '本地会话尚未连接，请重新登录'); process.exit(1); }
console.log('登录成功。可在 Web 控制台导入钱包地址。');
