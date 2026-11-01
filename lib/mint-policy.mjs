import { randomUUID } from 'node:crypto';

export const MINT_RISK_LIMITS = Object.freeze({ dayFeeBnb: 0.01, gasBnb: 0.0003, paidGasBnb: 0.001, reverts: 2 });
const ADDRESS = /^0x[0-9a-f]{40}$/i;
const UINT = /^0x[0-9a-f]+$/i;
const SLOTS = ['0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc', '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50', '0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3'];
const word = n => BigInt(n).toString(16).padStart(64, '0');
const addrWord = address => address.slice(2).toLowerCase().padStart(64, '0');
const asUint = value => typeof value === 'string' && UINT.test(value) ? BigInt(value) : null;
const abiUint = value => typeof value === 'string' && /^0x[0-9a-f]{64,}$/i.test(value) ? BigInt(value.slice(0, 66)) : null;
const fail = text => { throw new Error(text); };

export function ensureEntryPolicy(state, random = Math.random) {
  const valid = p => p && Number.isFinite(p.goPct) && p.goPct >= 0.8 && p.goPct <= 0.9 && Number.isInteger(p.minAgents) && p.minAgents >= 150 && p.minAgents <= 200;
  if (!valid(state.entryPolicy)) {
    // Read an existing upstream installation without silently lowering its floor.
    state.entryPolicy = valid({ goPct: state.thr?.go, minAgents: state.thr?.ag }) ? { goPct: state.thr.go, minAgents: state.thr.ag } : { goPct: +(0.8 + Math.min(1, Math.max(0, random())) * 0.1).toFixed(3), minAgents: 150 + Math.floor(Math.min(0.999999999, Math.max(0, random())) * 51) };
  }
  return { ...state.entryPolicy };
}
export function effectiveEntryPolicy(policy, configuredPct = 0.8) {
  return { goPct: Math.max(0.8, policy.goPct, Number.isFinite(configuredPct) ? configuredPct : 0.8), minAgents: policy.minAgents };
}
export function entryGate({ progress, agents = 0, configuredPct, policy, poolOpen = false }) {
  const effective = effectiveEntryPolicy(policy, configuredPct);
  if (!Number.isInteger(agents) || agents < effective.minAgents) return { ...effective, allowed: false, reason: `只有 ${Number.isFinite(agents) ? agents : 0} 个 Agent ID 交易钱包，要 ${effective.minAgents} 个以上` };
  const known = typeof progress === 'number' && Number.isFinite(progress) && progress >= 0;
  if (known && progress < effective.goPct) return { ...effective, allowed: false, reason: `进度 ${Math.floor(progress * 100)}%，未到 ${Math.round(effective.goPct * 1000) / 10}%` };
  if (!known && poolOpen) return { ...effective, allowed: false, reason: '读不到进度且已开池，不自动铸造' };
  return { ...effective, allowed: true, reason: known ? '进度与参与钱包均达标' : '进度未知，参与钱包达标' };
}
export function validNftUri(uri) {
  return typeof uri === 'string' && (/^data:[^,]+,.+/is.test(uri) || /^https?:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)+\/.+/i.test(uri) || /^ar:\/\/[A-Za-z0-9_-]{30,}/.test(uri) || /^ipfs:\/\/(?:ipfs\/)?(?:Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{50,})(?:\/|$)/.test(uri));
}

// These checks use only chain reads. URI validation does not fetch remote media
// or claim that the image, project, refund selector or liquidity is authentic.
export function createMintRisk({ state, rpc, call, fullCode = async (_c, code) => code, save = () => {}, now = Date.now, timeZone = 'Asia/Shanghai', usdt = '0x55d398326f99059ff775485246999027b3197955', wrappedBnb = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', factory = '0xca143ce32fe78f1f7019d7d551a6402fc5350c73' }) {
  state.mintRisk ||= { spent: {}, reservations: {}, reverts: {} };
  const ledger = state.mintRisk;
  ledger.spent ||= {}; ledger.reservations ||= {}; ledger.reverts ||= {};
  const day = () => new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date(now()));
  const key = wallet => wallet.id || wallet.walletId;
  const native = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
  async function rawCall(to, data) {
    const result = await rpc('eth_call', [{ to, data }, 'latest']);
    if (typeof result !== 'string' || !/^0x[0-9a-f]*$/i.test(result)) fail('无法核验合约只读结果');
    return result;
  }
  async function nftCheck(contract) {
    const raw = await rpc('eth_getCode', [contract, 'latest']);
    if (typeof raw !== 'string' || !/^0x[0-9a-f]*$/i.test(raw)) fail('无法核验 NFT 合约代码');
    const resolved = await fullCode(contract, raw);
    // The scanner resolver concatenates separately prefixed implementation
    // bytecodes. Validate every segment before normalizing internal prefixes.
    const segments = typeof resolved === 'string' ? resolved.split(/0x/i) : [];
    if (segments.length < 2 || segments[0] !== '' || segments.slice(1).some(segment => !/^(?:[0-9a-f]{2})*$/i.test(segment))) fail('无法核验 NFT 实现代码');
    const code = '0x' + segments.slice(1).join('').toLowerCase();
    if (!code.includes('c87b56dd')) return '';
    let uri = null;
    for (const id of [1n, 0n]) {
      let encoded;
      try { encoded = await rawCall(contract, '0xc87b56dd' + word(id)); }
      catch (error) { if (/revert|invalid token|nonexistent/i.test(String(error.message))) continue; throw error; }
      if (encoded === '0x') continue;
      try {
        const bytes = Buffer.from(encoded.slice(2), 'hex');
        const offset = Number(BigInt('0x' + bytes.subarray(0, 32).toString('hex')));
        const length = Number(BigInt('0x' + bytes.subarray(offset, offset + 32).toString('hex')));
        if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset !== 32 || length < 0 || length > 65536 || offset + 32 + length > bytes.length) fail('NFT 元数据格式无效');
        uri = bytes.subarray(offset + 32, offset + 32 + length).toString('utf8').trim(); break;
      } catch { fail('NFT 元数据格式无效'); }
    }
    if (uri === null) return ''; // Unminted token IDs are not proof of junk.
    return validNftUri(uri) ? '' : 'NFT 元数据 URI 为空或格式无效';
  }
  async function upgradeable(contract) {
    for (const slot of SLOTS) {
      const value = await rpc('eth_getStorageAt', [contract, slot, 'latest']);
      if (typeof value !== 'string' || !/^0x[0-9a-f]{64}$/i.test(value)) fail('无法核验代理合约存储槽');
      if (BigInt(value) > 0n) return true;
    }
    return false;
  }
  async function projectCheck(contract, { paying = true, paymentToken = native, paymentWei = 0n, manual = false } = {}) {
    if (!ADDRESS.test(contract)) fail('铸造合约地址无效');
    const junk = await nftCheck(contract); if (junk) fail(junk);
    if (!paying || manual) return;
    if (await upgradeable(contract)) fail('可升级代理合约的退款机制可能被替换，不自动付费铸造');
    let tokenResult = '0x';
    try { tokenResult = await rawCall(contract, '0xfc0c546a'); }
    catch (error) { if (!/revert|not supported|unknown selector/i.test(String(error.message))) throw error; }
    const tokenValue = abiUint(tokenResult), token = tokenValue && tokenValue < (1n << 160n) ? '0x' + tokenResult.slice(26, 66) : '';
    const assets = [contract, ...(ADDRESS.test(token) && token.toLowerCase() !== contract.toLowerCase() ? [token] : [])];
    let balance = 0n;
    if (paymentToken.toLowerCase() === native) {
      for (const address of assets) { const amount = asUint(await rpc('eth_getBalance', [address, 'latest'])); if (amount === null) fail('无法核验合约 BNB 留存'); balance += amount; }
    } else {
      if (paymentToken.toLowerCase() !== usdt.toLowerCase()) fail('无法核验此付费资产的资金留存');
      for (const address of assets) { const amount = abiUint(await rawCall(usdt, '0x70a08231' + addrWord(address))); if (amount === null) fail('无法核验合约 USDT 留存'); balance += amount; }
    }
    const minimum = paymentToken.toLowerCase() === native ? 10n ** 16n : BigInt(paymentWei || 0n);
    if (balance >= minimum && balance > 0n) return;
    const pairResult = await rawCall(factory, '0xe6a43905' + addrWord(token || contract) + addrWord(wrappedBnb));
    const pairValue = abiUint(pairResult);
    if (pairValue === null) fail('无法核验合约资金或流动性池');
    if (pairValue > 0n && pairValue < (1n << 160n)) {
      const pair = '0x' + pairResult.slice(26, 66), reserves = await rawCall(pair, '0x0902f1ac');
      if (/^0x[0-9a-f]{192,}$/i.test(reserves) && BigInt(reserves.slice(0, 66)) > 0n && BigInt('0x' + reserves.slice(66, 130)) > 0n) return;
    }
    fail('付费合约的资金留存或有效流动性不足，不自动铸造');
  }
  async function quoteTransaction(wallet, { to, data = '0x', valueWei = 0n, keepBnb = 0.006, paid = true, feeLike = false, manual = false, project = false, paymentToken = native, paymentWei = valueWei } = {}) {
    const id = key(wallet), address = wallet.addr || wallet.address;
    if (!id || !ADDRESS.test(address || '') || !ADDRESS.test(to || '') || !/^0x(?:[0-9a-f]{2})*$/i.test(data)) fail('风控交易参数无效');
    valueWei = BigInt(valueWei);
    if (project) await projectCheck(to, { paying: paid, paymentToken, paymentWei, manual });
    if (!manual && (ledger.reverts[id + ':' + to.toLowerCase()] || 0) >= MINT_RISK_LIMITS.reverts) fail('此钱包在该合约已上链失败两次，停止自动重试');
    const [gasResult, priceResult, balanceResult] = await Promise.all([rpc('eth_estimateGas', [{ from: address, to, data, value: '0x' + valueWei.toString(16) }]), rpc('eth_gasPrice', []), rpc('eth_getBalance', [address, 'latest'])]);
    const gas = asUint(gasResult), price = asUint(priceResult), balance = asUint(balanceResult);
    if (gas === null || price === null || balance === null || gas <= 0n || price <= 0n) fail('无法核验本笔交易的 gas 或余额');
    const gasWei = (gas * price * 120n + 99n) / 100n;
    const gasCap = BigInt(paid ? 10n ** 15n : 3n * 10n ** 14n);
    if (gasWei > gasCap) fail('本笔交易预估 gas 超过自动铸造上限');
    const reserveWei = gasWei + (feeLike ? valueWei : 0n);
    const spent = BigInt(ledger.spent[day() + ':' + id] || 0);
    const pending = Object.values(ledger.reservations).filter(r => r.walletId === id).reduce((sum, r) => sum + BigInt(r.amountWei), 0n);
    if (!manual && spent + pending + reserveWei > 10n ** 16n) fail('此钱包今日手续费与 gas 已达 0.01 BNB 预估额度');
    const keepWei = BigInt(Math.ceil(keepBnb * 1e9)) * 1000000000n;
    if (balance < valueWei + gasWei + keepWei) fail('扣除本笔付款与预估 gas 后低于 BNB 保留额');
    return { walletId: id, contract: to.toLowerCase(), day: day(), gasWei: gasWei.toString(), feeWei: feeLike ? valueWei.toString() : '0', amountWei: reserveWei.toString(), manual };
  }
  function reserve(quote) {
    const spent = BigInt(ledger.spent[day() + ':' + quote.walletId] || 0), pending = Object.values(ledger.reservations).filter(r => r.walletId === quote.walletId).reduce((sum, r) => sum + BigInt(r.amountWei), 0n);
    if (quote.day !== day()) fail('风控预估已跨日，请重新预演');
    if (!quote.manual && spent + pending + BigInt(quote.amountWei) > 10n ** 16n) fail('此钱包今日手续费与 gas 已达 0.01 BNB 预估额度');
    const id = randomUUID(); ledger.reservations[id] = { ...quote, createdAt: now() }; save(true); return id;
  }
  function settle(id, { receipt = null, rejected = false } = {}) {
    const reservation = ledger.reservations[id]; if (!reservation) return;
    if (rejected) { delete ledger.reservations[id]; save(true); return; }
    if (!['0x1', '0x0', '0x01', '0x00'].includes(receipt?.status)) return;
    const succeeded = BigInt(receipt.status) === 1n;
    if (!succeeded && !reservation.revertedCounted) {
      const failureKey = reservation.walletId + ':' + reservation.contract;
      ledger.reverts[failureKey] = (ledger.reverts[failureKey] || 0) + 1;
      reservation.revertedCounted = true; save(true);
    }
    const used = asUint(receipt?.gasUsed), price = asUint(receipt?.effectiveGasPrice);
    if (used === null || price === null) return; // Unknown fees remain reserved.
    const amount = used * price + (succeeded ? BigInt(reservation.feeWei) : 0n), spentKey = reservation.day + ':' + reservation.walletId;
    ledger.spent[spentKey] = (BigInt(ledger.spent[spentKey] || 0) + amount).toString();
    delete ledger.reservations[id]; save(true);
  }
  return { nftCheck, upgradeable, projectCheck, quoteTransaction, reserve, settle, view: () => ({ ...MINT_RISK_LIMITS, accounting: 'receipt-gas-and-fee', estimated: true }) };
}
