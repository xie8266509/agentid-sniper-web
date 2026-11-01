// Public BSC balances do not require opening an Agentic Wallet session.
import { nftRpc } from './nft-holdings.mjs';
import { decodeAbiUint } from './nft-codec.mjs';

export const BALANCE_ASSETS = Object.freeze([
  Object.freeze({ symbol: 'BNB', address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', decimals: 18 }),
  Object.freeze({ symbol: 'USDT', address: '0x55d398326f99059ff775485246999027b3197955', decimals: 18 }),
]);
const ADDRESS = /^0x[0-9a-f]{40}$/i;
const ZERO_ADDRESS = /^0x0{40}$/i;
const assetError = asset => `暂时无法读取 ${asset.symbol} 余额，请稍后重试`;
const changed = () => Object.assign(new Error('钱包配置已改变，请刷新重试'), { status: 409 });
function quantity(value) {
  if (typeof value !== 'string' || value.length > 66 || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value)) throw new Error('Invalid RPC quantity');
  return BigInt(value);
}
function decimal(units) {
  const whole = units / 10n ** 18n, fraction = (units % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '');
  return whole.toString() + (fraction ? '.' + fraction : '');
}

export function createWalletBalanceReader({ rpc = nftRpc, now = Date.now, ttlMs = 30000, maxConcurrent = 2, maxPending = 32, maxCacheEntries = 128, isCurrent = () => true } = {}) {
  if (![maxConcurrent, maxPending, maxCacheEntries].every(value => Number.isSafeInteger(value) && value > 0) || !Number.isFinite(ttlMs) || ttlMs < 0) throw new Error('Invalid balance cache limits');
  const cache = new Map(), flights = new Map(), queue = [];
  let active = 0;
  const current = identity => { if (!isCurrent(identity)) throw changed(); };
  const view = (identity, assets, status, updatedAt = null, stale = false) => ({ walletId: identity.id, walletAddress: identity.address, chainId: 56, source: 'rpc', assets, updatedAt, status, stale });
  const unknown = () => BALANCE_ASSETS.map(asset => ({ ...asset, balance: null, error: null }));
  function schedule(work) {
    return new Promise((resolve, reject) => {
      const run = () => { active++; Promise.resolve().then(work).then(resolve, reject).finally(() => { active--; queue.shift()?.(); }); };
      if (active < maxConcurrent) run(); else queue.push(run);
    });
  }
  async function query(identity, previous) {
    current(identity);
    let results;
    try {
      if (quantity(await rpc('eth_chainId', [])) !== 56n) throw new Error('Wrong chain');
      results = await Promise.allSettled([
        Promise.resolve().then(() => rpc('eth_getBalance', [identity.address, 'latest'])).then(quantity),
        Promise.resolve().then(() => rpc('eth_call', [{ to: BALANCE_ASSETS[1].address, data: '0x70a08231' + identity.address.slice(2).padStart(64, '0') }, 'latest'])).then(result => {
          const units = decodeAbiUint(result);
          if (units === null) throw new Error('Invalid ABI balance');
          return units;
        }),
      ]);
    } catch {
      results = BALANCE_ASSETS.map(() => ({ status: 'rejected' }));
    }
    current(identity);
    let fresh = 0, stale = false;
    const assets = BALANCE_ASSETS.map((asset, index) => {
      if (results[index].status === 'fulfilled') { fresh++; return { ...asset, balance: decimal(results[index].value), error: null }; }
      const balance = previous?.assets[index]?.balance ?? null;
      if (balance !== null) stale = true;
      return { ...asset, balance, error: assetError(asset) };
    });
    return view(identity, assets, fresh === 2 ? 'ready' : fresh ? 'partial' : 'error', fresh ? now() : previous?.updatedAt ?? null, stale);
  }
  async function read(wallet, { force = false } = {}) {
    const identity = { id: String(wallet?.id || ''), address: String(wallet?.address || '').toLowerCase(), draft: wallet?.draft === true };
    current(identity);
    if (identity.draft || !ADDRESS.test(identity.address) || ZERO_ADDRESS.test(identity.address)) return view(identity, unknown(), 'unbound');
    const key = `56:${identity.id}:${identity.address}`, old = cache.get(key);
    if (flights.has(key)) { const result = await flights.get(key); current(identity); return structuredClone(result); }
    if (!force && old && now() - old.at < ttlMs) return structuredClone(old.data);
    if (flights.size >= maxPending) {
      return view(identity, BALANCE_ASSETS.map((asset, index) => ({ ...asset, balance: old?.data.assets[index]?.balance ?? null, error: '余额查询繁忙，请稍后重试' })), 'error', old?.data.updatedAt ?? null, Boolean(old?.data.assets.some(asset => asset.balance !== null)));
    }
    const flight = schedule(async () => {
      const data = await query(identity, old?.data);
      current(identity);
      cache.delete(key);
      cache.set(key, { at: now(), data });
      while (cache.size > maxCacheEntries) cache.delete(cache.keys().next().value);
      return data;
    });
    flights.set(key, flight);
    try { const data = await flight; current(identity); return structuredClone(data); }
    finally { if (flights.get(key) === flight) flights.delete(key); }
  }
  return { read };
}
