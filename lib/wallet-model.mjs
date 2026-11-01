import { createHash } from 'node:crypto';
import { getPaidConfig, getRuleConfig } from './config.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
export const WALLET_MODES = Object.freeze(['monitor', 'sell-only', 'auto']);

/** Identity and storage defaults are materialized before any reordering or rename. */
export function getWalletId(wallet, index = 0) {
  return wallet?.id || 'wallet_' + hash(String(wallet?.address || `legacy:${index}:${wallet?.name || ''}`).toLowerCase()).slice(0, 24);
}

export function normalizeWalletConfig(config = {}) {
  if (!Array.isArray(config.wallets)) return { ...config, portfolioBudget: config.portfolioBudget || { maxBnbPerDay: null } };
  const costWallet = config.wallets.find(wallet => wallet && /^0x[0-9a-fA-F]{40}$/.test(wallet.address || '') && !/^0x0{40}$/i.test(wallet.address) && wallet.draft !== true)?.address;
  return {
    ...config,
    portfolioBudget: config.portfolioBudget || { maxBnbPerDay: null },
    ...(Array.isArray(config.tokens) ? { tokens: config.tokens.map(token => token && typeof token === 'object' && !Array.isArray(token) && token.costWalletAddress === undefined && !token.only && !token.both && Number(token.cost) > 0 && costWallet ? { ...token, costWalletAddress: costWallet } : token) } : {}),
    wallets: config.wallets.map((wallet, index) => {
      if (!wallet || typeof wallet !== 'object' || Array.isArray(wallet)) return wallet;
      const id = getWalletId(wallet, index);
      // Legacy CLI keys derive from the relative directory. Keep this exact path
      // and instance string when a profile receives its new immutable identity.
      const bawDir = wallet.bawDir || (wallet.id ? `data/wallets/${id}` : `data/wallets/wallet-${index + 1}`);
      const instanceId = wallet.instanceId || 'agentid-sniper-' + hash(bawDir).slice(0, 24);
      return {
        ...wallet, id, bawDir, instanceId,
        agentId: wallet.agentId ?? (wallet.draft ? '' : wallet.name || ''),
        agentIdVerified: wallet.agentIdVerified ?? false,
        legacyNames: Object.hasOwn(wallet, 'legacyNames') ? wallet.legacyNames : wallet.draft ? [] : [...new Set([wallet.name, wallet.agentId].filter(value => typeof value === 'string' && value.trim()))],
        mode: wallet.mode ?? (config.monitorOnly === false ? 'auto' : 'monitor'),
        paused: wallet.paused ?? false,
        archived: wallet.archived ?? false,
        draft: wallet.draft ?? false,
        autoMint: wallet.autoMint ?? true,
        autoSellTokens: wallet.autoSellTokens ?? true,
        autoSellNfts: wallet.autoSellNfts ?? true,
      };
    }),
  };
}

/** Index selectors are accepted only for the previous API's compatibility. */
export function resolveWallet(config, selector) {
  const wallets = normalizeWalletConfig(config).wallets || [];
  const index = typeof selector === 'string' && !/^\d+$/.test(selector)
    ? wallets.findIndex(wallet => wallet.id === selector)
    : Number(selector ?? 0);
  if (!Number.isInteger(index) || index < 0 || index >= wallets.length) {
    throw Object.assign(new Error('钱包不存在，请刷新钱包列表'), { status: 404 });
  }
  return { wallet: wallets[index], index };
}

export function effectiveWalletConfig(config, wallet) {
  const result = {
    ...config,
    paid: { ...(config.paid || {}), ...(wallet.paid || {}) },
    rules: { ...(config.rules || {}), ...(wallet.rules || {}) },
  };
  result.paid = getPaidConfig(result);
  result.rules = getRuleConfig(result);
  result.monitorOnly = config.monitorOnly !== false || wallet.paused === true || wallet.archived === true || wallet.draft === true || (wallet.mode ?? (config.monitorOnly ? 'monitor' : 'auto')) === 'monitor';
  return result;
}

export function walletCanAutomate(config, wallet, kind = 'mint') {
  if (!wallet || !/^0x[0-9a-fA-F]{40}$/.test(wallet.address || '') || /^0x0{40}$/i.test(wallet.address) || effectiveWalletConfig(config, wallet).monitorOnly) return false;
  const mode = wallet.mode ?? (config.monitorOnly ? 'monitor' : 'auto');
  if (kind === 'mint') return mode === 'auto' && wallet.autoMint !== false;
  if (kind === 'token-sell') return wallet.autoSellTokens !== false;
  if (kind === 'nft-sell') return wallet.autoSellNfts !== false;
  throw new Error('未知的钱包自动操作类型');
}
