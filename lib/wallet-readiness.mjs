import { normalizeWalletConfig, walletCanAutomate } from './wallet-model.mjs';

export const WALLET_READINESS_TTL_MS = 60000;
const expiryTime = value => typeof value === 'number' || /^\d+$/.test(String(value)) ? Number(value) * (Number(value) < 1e12 ? 1000 : 1) : Date.parse(value || '');
export const readinessConfigKey = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
export const walletHasAutomaticWork = (config, wallet) => ['mint', 'token-sell', 'nft-sell'].some(kind => walletCanAutomate(config, wallet, kind));
export function currentWalletReadiness(record, { now = Date.now() } = {}) {
  if (!record?.ready) return record;
  if (!Number.isFinite(record.expiresAt) || record.expiresAt <= now) return { ...record, ready: false, code: 'DEV_MODE_EXPIRED', reason: '开发者模式已过期，已跳过' };
  if (!Number.isFinite(record.checkedAt) || record.checkedAt > now || now - record.checkedAt > WALLET_READINESS_TTL_MS) return { ...record, ready: false, code: 'CHECK_EXPIRED', reason: '钱包连接核验已过期，等待重新检查' };
  return record;
}
export function publicWalletAvailability(value, { now = Date.now() } = {}) {
  if (!value || typeof value.ready !== 'boolean') return null;
  const record = currentWalletReadiness(value, { now });
  const reasons = { READY: '连接、地址与操作权限已核验', OFFLINE: '钱包未连接，已跳过；重新登录后自动复查', CHECK_FAILED: '无法核验钱包连接状态，已跳过', ADDRESS_MISMATCH: '登录地址与配置不一致，已跳过；请核对钱包绑定', PERMISSION_UNAVAILABLE: '无法完整核验钱包地址或权限，已跳过', DEV_MODE_DISABLED: '开发者模式未开启，已跳过', DEV_MODE_EXPIRED: '开发者模式已过期，已跳过', CHECK_EXPIRED: '钱包连接核验已过期，等待重新检查', CONFIG_CHANGED: '钱包或策略配置已改变，等待重新核验', CONFIG_DISABLED: '此钱包已暂停或未启用自动操作' };
  reasons.CHECKING = '正在核验钱包连接与操作权限';
  const code = Object.hasOwn(reasons, record.code) ? record.code : 'CHECK_FAILED';
  return { ready: code === 'READY' && record.ready === true, code, reason: reasons[code], checkedAt: Number.isFinite(record.checkedAt) ? record.checkedAt : 0 };
}

/** Only public, fixed reasons leave this boundary; CLI output and settings are
 * never copied into a startup report or scanner state. */
export function assessWalletReadiness(wallet, session, { now = Date.now() } = {}) {
  const base = { walletId: wallet.id, name: wallet.name, address: wallet.address?.toLowerCase() || '', checkedAt: now };
  const reject = (code, reason) => ({ ...base, ready: false, code, reason });
  if (session?.status !== 'CONNECTED') return reject(session?.status && session.status !== 'ERROR' ? 'OFFLINE' : 'CHECK_FAILED', session?.status && session.status !== 'ERROR' ? '钱包未连接，已跳过；重新登录后自动复查' : '无法核验钱包连接状态，已跳过');
  if (session.error) return reject('PERMISSION_UNAVAILABLE', '无法完整核验钱包地址或权限，已跳过');
  if (session.addresses !== undefined) {
    const addresses = Array.isArray(session.addresses) ? session.addresses.filter(entry => entry && String(entry.binanceChainId) === '56') : [];
    if (addresses.length !== 1 || String(addresses[0].address || '').toLowerCase() !== base.address) return reject('ADDRESS_MISMATCH', '无法确认唯一的 BSC 钱包地址，已跳过；请核对钱包绑定');
  }
  if (!/^0x[0-9a-f]{40}$/i.test(session.address || '') || session.address.toLowerCase() !== base.address) return reject('ADDRESS_MISMATCH', '登录地址与配置不一致，已跳过；请核对钱包绑定');
  if (session.settings?.devMode?.enabled === false) return reject('DEV_MODE_DISABLED', '开发者模式未开启，已跳过');
  const expiresAt = expiryTime(session.settings?.devMode?.expiresAt);
  if (session.settings?.devMode?.enabled !== true || !Number.isFinite(expiresAt)) return reject('PERMISSION_UNAVAILABLE', '无法核验开发者模式有效期，已跳过');
  if (expiresAt <= now) return reject('DEV_MODE_EXPIRED', '开发者模式已过期，已跳过');
  return { ...base, ready: true, code: 'READY', reason: '连接、地址与操作权限已核验', expiresAt };
}

export async function readWalletReadinessSession(wallet, index, runWallet) {
  const options = { walletIndex: index, walletId: wallet.id, expectedAddress: wallet.address, timeout: 30000 };
  const status = await runWallet(['wallet', 'status'], options);
  if (!status?.success || status.data?.status !== 'CONNECTED') return { status: status?.success ? status.data?.status : 'ERROR', error: !status?.success };
  const [addresses, settings] = await Promise.all([runWallet(['wallet', 'address'], options), runWallet(['wallet', 'settings'], options)]);
  const list = addresses?.success && Array.isArray(addresses.data?.addresses) ? addresses.data.addresses : [];
  return { status: 'CONNECTED', addresses: list, address: list.find(entry => entry && String(entry.binanceChainId) === '56')?.address || null, settings: settings?.success ? settings.data : null, error: !addresses?.success || !settings?.success };
}

export async function collectWalletReadiness({ config: input, readWallet, now = Date.now, concurrency = 3 }) {
  const config = normalizeWalletConfig(input), report = { mode: config.monitorOnly ? 'monitor' : 'auto', checkedAt: now(), ready: [], skipped: [] };
  if (config.monitorOnly) return report;
  const rows = new Array((config.wallets || []).length); let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, async () => {
    while (cursor < rows.length) {
      const index = cursor++, wallet = config.wallets[index];
      if (!walletHasAutomaticWork(config, wallet)) {
        rows[index] = { walletId: wallet.id, name: wallet.name, address: wallet.address, ready: false, code: 'CONFIG_DISABLED', reason: wallet.archived ? '钱包已归档' : wallet.paused ? '此钱包已暂停' : wallet.draft ? '此钱包尚未完成绑定' : '此钱包未启用自动操作', checkedAt: now() };
        continue;
      }
      try { rows[index] = assessWalletReadiness(wallet, await readWallet(wallet, index), { now: now() }); }
      catch { rows[index] = assessWalletReadiness(wallet, { status: 'ERROR' }, { now: now() }); }
    }
  }));
  for (const value of rows) { const row = currentWalletReadiness(value, { now: now() }); (row.ready ? report.ready : report.skipped).push(row); }
  report.checkedAt = now(); return report;
}

export function assertAnyWalletReady(report) {
  if (report.mode === 'monitor' || report.ready.length) return;
  const reasons = report.skipped.map(wallet => `${wallet.name || wallet.walletId}：${wallet.reason}`).join('；');
  throw Object.assign(new Error('没有可运行的钱包，未启动自动交易。' + (reasons || '请先配置并连接至少一个已授权自动操作的钱包')), { status: 409, code: 'NO_READY_WALLETS', details: { walletReadiness: report } });
}
