import { clearWalletBlocked } from './wallet-executor.mjs';
import { createWalletBudget } from './wallet-budget.mjs';
import { marketOrderRecord, marketOrderState, parseTokenAmount } from './sell-rules.mjs';

const ADDRESS = /^0x[0-9a-f]{40}$/i, HASH = /^0x[0-9a-f]{64}$/i;
const NATIVE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const WBNB = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
const USDT = '0x55d398326f99059ff775485246999027b3197955';
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const lower = value => typeof value === 'string' ? value.toLowerCase() : '';
const integer = value => { try { return typeof value === 'string' && /^(?:0x[0-9a-f]+|\d+)$/i.test(value) ? BigInt(value) : null; } catch { return null; } };
const review = reason => ({ resolved: false, status: 'review', reason });
const waiting = reason => ({ resolved: false, status: 'pending', reason });

/** Reconcile one persisted scanner intent. Callers own the wallet execution lock.
 * The helper never sends a transaction or edits scanner state. Budget settlement
 * and exact-reference unblock are idempotent across process/browser restarts. */
export async function reconcileScannerPending({ wallet, pending, runWallet, rpc, budget, root, clearBlocked = clearWalletBlocked } = {}) {
  if (!wallet?.id || !ADDRESS.test(wallet.address || '') || pending?.version !== 1 || pending.walletId !== wallet.id || lower(pending.walletAddress) !== lower(wallet.address)) return review('待核对任务与当前钱包身份不一致');
  if (!['contract', 'market-order', 'approval'].includes(pending.kind) || !pending.expected || integer(pending.amountWei) === null) return review('缺少完整的原始交易意图');
  const successSpent = integer(pending.settlement?.successSpentWei), failureSpent = integer(pending.settlement?.failureSpentWei);
  const reservedAmount = integer(pending.reservedAmountWei || '0');
  if (successSpent === null || failureSpent === null || successSpent < failureSpent || pending.reservationId && (reservedAmount === null || successSpent > reservedAmount)) return review('预算预占与待核对支出不一致');
  const hasUsd = pending.settlement?.successSpentUsdMicros !== undefined || pending.settlement?.failureSpentUsdMicros !== undefined || pending.reservedAmountUsdMicros !== undefined;
  const successUsd = hasUsd ? integer(pending.settlement?.successSpentUsdMicros) : null, failureUsd = hasUsd ? integer(pending.settlement?.failureSpentUsdMicros) : null;
  const reservedUsd = hasUsd ? integer(pending.reservedAmountUsdMicros) : null;
  if (hasUsd && (successUsd === null || failureUsd === null || reservedUsd === null || successUsd < failureUsd || successUsd > reservedUsd)) return review('USD 预算预占与待核对支出不一致');
  if (typeof rpc !== 'function') return review('没有可用的链上核验服务');
  let chain;
  try { chain = integer(await rpc('eth_chainId', [])); } catch { return waiting('暂时无法读取链 ID'); }
  if (chain !== 56n) return review('链上核验服务不是 BSC');
  let txHash = pending.txHash, order;
  if (pending.kind === 'market-order') {
    if (!pending.orderId || typeof runWallet !== 'function') return review('未取得官方订单号，请先核对钱包订单');
    let result;
    try { result = await runWallet(['market-order', 'list', '--orderId', String(pending.orderId)], { walletId: wallet.id, walletIndex: pending.walletIndex, timeout: 30000 }); }
    catch { return waiting('暂时无法取得钱包订单'); }
    order = result?.success ? marketOrderRecord(result.data, String(pending.orderId)) : null;
    if (!order) return waiting('钱包未返回此订单');
    const expected = pending.expected;
    const sourceAmount = parseTokenAmount(order.fromTokenQty, 18), plannedAmount = parseTokenAmount(expected.fromTokenQty, 18);
    if (String(order.chain ?? order.binanceChainId) !== '56' || lower(order.fromToken) !== lower(expected.fromToken) || lower(order.toToken) !== lower(expected.toToken) || plannedAmount === null || sourceAmount !== plannedAmount) return review('官方订单的链、资产或数量与原任务不一致');
    if (order.walletAddress && lower(order.walletAddress) !== lower(wallet.address)) return review('官方订单的钱包归属不一致');
    if (marketOrderState(order) === 'pending') return waiting('订单仍在等待最终结果');
    if (txHash && order.txHash && lower(txHash) !== lower(order.txHash)) return review('订单交易哈希与本地记录不一致');
    txHash = order.txHash || txHash;
    if (marketOrderState(order) === 'failed' && !txHash) return finish(false, String(pending.orderId));
  }
  if (!HASH.test(txHash || '')) return review('未取得有效交易哈希，需要核对钱包订单后补充凭证');
  let tx, receipt;
  try { [tx, receipt] = await Promise.all([rpc('eth_getTransactionByHash', [txHash]), rpc('eth_getTransactionReceipt', [txHash])]); }
  catch { return waiting('暂时无法取得链上交易与回执'); }
  if (!tx || !receipt?.blockNumber || ![0n, 1n].includes(integer(receipt.status))) return waiting('交易尚未获得可核验的链上回执');
  if (lower(tx.hash) !== lower(txHash) || lower(receipt.transactionHash) !== lower(txHash) || lower(tx.from) !== lower(wallet.address) || integer(tx.chainId) !== 56n || !HASH.test(tx.blockHash || '') || lower(tx.blockHash) !== lower(receipt.blockHash) || integer(tx.blockNumber) === null || integer(tx.blockNumber) !== integer(receipt.blockNumber)) return review('链上交易的钱包、链或区块归属不一致');
  const expected = pending.expected, succeeded = integer(receipt.status) === 1n;
  if (pending.kind === 'contract') {
    if (!ADDRESS.test(expected.to || '') || lower(expected.from) !== lower(wallet.address) || lower(tx.to) !== lower(expected.to) || integer(expected.value) === null || integer(tx.value) === null || integer(tx.value) !== integer(expected.value) || !/^0x(?:[a-f0-9]{2})*$/i.test(expected.inputData || '') || lower(tx.input ?? tx.data) !== lower(expected.inputData)) return review('链上合约、金额或调用数据与原预演不一致');
  } else if (pending.kind === 'approval') {
    if (!verifiedRevokeCall(tx, expected)) return review('链上授权撤销的合约、对象或零额度与原任务不一致');
  } else {
    if (!ADDRESS.test(tx.to || '') || lower(expected.fromToken) !== NATIVE || lower(expected.toToken) !== USDT) return review('该兑换需要额外的资产流核验，未自动解除');
    const amount = parseTokenAmount(expected.fromTokenQty, 18);
    if (amount === null || integer(tx.value) !== amount) return review('链上 BNB 支出与原兑换数量不一致');
    if (succeeded) {
      if (marketOrderState(order) !== 'finished') return waiting('链上交易已确认，仍等待订单终态');
      const flow = verifyNativeUsdtFlow(receipt, wallet.address, amount);
      if (!flow.ok) return review(flow.reason);
    }
  }
  return finish(succeeded, pending.orderId ? String(pending.orderId) : txHash, txHash);

  async function finish(succeeded, reference, hash) {
    const spentWei = succeeded ? successSpent : failureSpent;
    const spentUsdMicros = hasUsd ? (succeeded ? successUsd : failureUsd).toString() : undefined;
    if (pending.reservationId) await (budget || createWalletBudget({ root })).settle(pending.reservationId, { spentWei, ...(hasUsd ? { spentUsdMicros } : {}) });
    await clearBlocked(wallet, { root, reference });
    return { resolved: true, status: succeeded ? 'confirmed' : 'reverted', ...(hash ? { txHash: hash } : {}), ...(pending.orderId ? { orderId: String(pending.orderId) } : {}), spentWei: spentWei.toString(), ...(hasUsd ? { spentUsdMicros } : {}) };
  }
}

function verifyNativeUsdtFlow(receipt, walletAddress, maximum) {
  if (!Array.isArray(receipt.logs)) return { ok: false, reason: '缺少兑换资产流凭证' };
  const owner = lower(walletAddress).slice(2).padStart(64, '0');
  let received = 0n, wrappedOut = 0n;
  for (const log of receipt.logs) {
    if (!Array.isArray(log.topics) || lower(log.topics[0]) !== TRANSFER || log.topics.length !== 3) continue;
    const from = lower(log.topics[1]).replace(/^0x/, ''), to = lower(log.topics[2]).replace(/^0x/, ''), amount = integer(log.data);
    if (amount === null) return { ok: false, reason: '兑换资产流金额无效' };
    if (to === owner && lower(log.address) === USDT) received += amount;
    if (from === owner && amount > 0n) {
      if (lower(log.address) !== WBNB) return { ok: false, reason: '兑换还扣除了预期外的代币' };
      wrappedOut += amount;
    }
  }
  if (wrappedOut > maximum) return { ok: false, reason: '包装 BNB 支出超过原兑换金额' };
  return received > 0n ? { ok: true } : { ok: false, reason: '尚未核验兑换所得 USDT 确实转入此钱包' };
}

function verifiedRevokeCall(tx, expected) {
  if (!ADDRESS.test(expected.token || '') || !ADDRESS.test(expected.spender || '') || integer(tx.value) !== 0n) return false;
  const word = address => lower(address).slice(2).padStart(64, '0');
  const input = lower(tx.input ?? tx.data);
  if (expected.type === 'approve') return lower(tx.to) === lower(expected.token) && input === '0x095ea7b3' + word(expected.spender) + '0'.repeat(64);
  if (expected.type !== 'permit2' || !ADDRESS.test(expected.permit2ContractAddress || '') || lower(tx.to) !== lower(expected.permit2ContractAddress)) return false;
  const pair = word(expected.token) + word(expected.spender);
  // Permit2's two supported revocation forms; no additional asset/spender pairs.
  if (input === '0xcc53287f' + BigInt(32).toString(16).padStart(64, '0') + '1'.padStart(64, '0') + pair) return true;
  if (input.length !== 266 || !input.startsWith('0x87517c45' + pair + '0'.repeat(64))) return false;
  const expiration = integer('0x' + input.slice(-64));
  return expiration !== null && expiration < (1n << 48n);
}
