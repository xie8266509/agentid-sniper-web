import { existsSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { Signature, TypedDataEncoder, recoverAddress } from 'ethers';
import { validateNftRule, hashRule, planNftAction, applyNftEvent, parseBnbWei, formatBnbWei } from './nft-rules.mjs';
import { writePrivateJson } from './nft-trading-store.mjs';
import { decodeNftTransfers, decodeAbiUint } from './nft-codec.mjs';

const TX_HASH = /^0x[0-9a-f]{64}$/i;
const WBNB = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
const ACTIVE = new Set(['intent', 'signing', 'signature-pending', 'publishing', 'listed', 'submitting', 'pending', 'review']);
const id = () => randomBytes(18).toString('hex');
const fail = (message, status = 409) => Object.assign(new Error(message), { status });
const clone = value => structuredClone(value);
const cleanRule = ({ policyHash, consent, updatedAt, authorizedAt, ...rule }) => rule;
const expiryMs = value => typeof value === 'number' ? value < 1e12 ? value * 1000 : value : /^\d+$/.test(value || '') ? expiryMs(Number(value)) : Date.parse(value || '');
const reasonText = reason => ({
  disabled: '规则已停用', cooldown: '等待冷却结束', ready: '已达到规则条件',
  'executable-offer-unknown': '暂无可执行买单，等待有效报价', 'listing-fees-unknown': '无法确认挂牌费用',
  'take-profit-not-reached': '可执行买价尚未达到目标净收入', 'trailing-not-armed': '可执行买价尚未达到跟踪止盈启动价',
  'trailing-not-triggered': '已跟踪买价峰值，尚未达到回撤比例', 'below-min-net': '净收入低于保底价格',
  'fee-limit-exceeded': '市场费及 Gas 超过设定上限', 'ownership-unverified': '尚未确认当前 NFT 归属',
  'insufficient-owned-quantity': '该 Token ID 当前数量不足', 'quote-expired-or-invalid': '报价已过期，等待重新查询',
  'quote-asset-mismatch': '报价资产不匹配，已阻止执行', 'nonpositive-net-proceeds': '扣费后无正净收入',
}[reason] || reason);

export function normalizeWalletSignature(data, expectedHash, walletAddress) {
  let signature = String(data?.signature || '').replace(/^0x/, '');
  if (/^[0-9a-f]{128}$/i.test(signature)) {
    const recovery = String(data.signatureRecovery ?? '');
    let v = ['27', '28'].includes(recovery) ? Number(recovery) : /^[0-9a-f]{2}$/i.test(recovery) ? Number.parseInt(recovery, 16) : Number(recovery);
    if (v === 0 || v === 1) v += 27;
    if (v !== 27 && v !== 28) throw fail('钱包签名缺少有效 recovery');
    signature += v.toString(16).padStart(2, '0');
  }
  if (!/^[0-9a-f]{130}$/i.test(signature)) throw fail('钱包未返回可验证的 ECDSA 签名');
  const result = Signature.from('0x' + signature).serialized;
  if (recoverAddress(expectedHash, result).toLowerCase() !== walletAddress.toLowerCase()) throw fail('签名钱包与 NFT 规则不一致');
  return result;
}

export function checkNftSaleSimulation(rule, operation, simulation) {
  if (!simulation || !Array.isArray(simulation.balanceChanges) || !Array.isArray(simulation.allowanceChanges) || !Array.isArray(simulation.authorityChanges)) return '缺少完整资产与权限变化预演，需单独确认';
  if (simulation.allowanceChanges.length || simulation.authorityChanges.length) return '卖出预演包含额外授权或权限变化';
  if (simulation.simulationCode && !/^0+$/.test(String(simulation.simulationCode))) return '卖出模拟未通过';
  if (simulation.balanceChanges.length > 500) return '资产变化数量超出可核验范围';
  let nft = 0n, native = 0n, wrapped = 0n;
  for (const change of simulation.balanceChanges) {
    if (!/^0x[0-9a-f]{40}$/i.test(change.owner || '')) return '资产变化缺少有效归属地址';
    if (change.owner.toLowerCase() !== rule.walletAddress) continue;
    if (!/^-?\d{1,79}$/.test(String(change.change))) return '资产变化金额格式无法核验';
    const value = BigInt(change.change), address = String(change.contractAddress).toLowerCase();
    if (address === rule.addr && /erc721|erc1155/i.test(change.tokenType || '')) {
      if (String(change.tokenType).toLowerCase() !== rule.standard.toLowerCase() || !/^\d+$/.test(String(change.tokenId)) || BigInt(change.tokenId).toString() !== rule.tokenId) return '预演会操作其他 NFT 或 Token ID';
      nft += value;
    } else if (address === WBNB && /erc20/i.test(change.tokenType || '')) wrapped += value;
    else if (['0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', '0x0000000000000000000000000000000000000000'].includes(address)) native += value;
    else if (value !== 0n) return '预演包含规则之外的资产变化';
  }
  if (nft !== -BigInt(rule.quantity)) return '预演 NFT 转出数量与规则不符';
  if (wrapped < 0n) return '预演会扣除已有 WBNB';
  const gasBudget = parseBnbWei(rule.maxFeesBnb) - BigInt(operation.quote?.marketFeesWei || '0');
  if (gasBudget < 0n || native < 0n && -native > gasBudget) return '预演 BNB 扣款超过费用上限';
  const received = native + wrapped;
  if (received < parseBnbWei(rule.minNetBnb) || received < BigInt(operation.action?.netWei || '0')) return '预演净收入低于已授权价格';
  return null;
}

/** Independent background worker; no rule is enabled merely by saving it.
 * All broadcasts and published signatures have a durable intent first. */
export function createNftAutomation({ store, market, runWallet, rpc, readConfig, serviceInfo, stateFile, now = Date.now, write = writePrivateJson, withWalletLock: externalWalletLock = async (_index, work) => work() }) {
  let states = {}, loadError = null, busy = false, timer = null;
  const actions = new Map();
  const walletLocks = new Set();
  const withWalletLock = async (index, work) => {
    if (walletLocks.has(index)) throw fail('这个钱包已有 NFT 操作，请稍后重试');
    walletLocks.add(index); try { return await externalWalletLock(index, work); } finally { walletLocks.delete(index); }
  };
  if (existsSync(stateFile)) {
    try {
      const data = JSON.parse(readFileSync(stateFile, 'utf8'));
      if (data.version !== 1 || !data.states || Array.isArray(data.states)) throw new Error();
      states = data.states;
    } catch { loadError = 'NFT 交易状态文件损坏，已禁止自动执行，请先恢复备份'; }
  }
  const persist = () => { if (loadError) throw fail(loadError); write(stateFile, { version: 1, states }); };
  const getRule = key => { const rule = store.readRules().find(rule => rule.key === key); if (!rule) throw fail('NFT 规则不存在，请先保存', 404); return rule; };
  const indexFor = rule => {
    const index = (readConfig().wallets || []).findIndex(wallet => wallet.address.toLowerCase() === rule.walletAddress);
    if (index < 0) throw fail('规则钱包已不在当前配置中，已停止 NFT 自动操作');
    return index;
  };
  const stateFor = key => states[key] ||= { phase: 'idle', reason: '尚未启用', lastCheckedAt: null };
  async function walletCall(index, args) {
    const result = await runWallet(args, { walletIndex: index, timeout: 180000 });
    if (!result?.success) throw fail(result?.error?.message || '钱包请求未返回有效结果', 502);
    return result.data;
  }
  async function preflight(rule, { sending = false } = {}) {
    const index = indexFor(rule);
    const status = await walletCall(index, ['wallet', 'status']);
    if (status.status !== 'CONNECTED') throw fail('钱包未连接，请先登录');
    // Check Developer Mode before building calldata or typed data.
    const settings = await walletCall(index, ['wallet', 'settings']);
    const expiresAt = expiryMs(settings.devMode?.expiresAt);
    if (settings.devMode?.enabled !== true || Number.isFinite(expiresAt) && expiresAt <= now()) throw fail('请在币安 App → Agentic Wallet → 设置中开启开发者模式');
    const addresses = await walletCall(index, ['wallet', 'address']);
    const address = addresses.addresses?.find(value => String(value.binanceChainId) === '56')?.address;
    if (address?.toLowerCase() !== rule.walletAddress) throw fail('登录钱包与规则钱包不一致，已停止 NFT 操作');
    if (sending) {
      const lock = await walletCall(index, ['wallet', 'tx-lock', '--binanceChainId', '56']);
      if (lock.status !== 'UNLOCKED') throw fail('钱包有待确认或待上链交易，请先在币安 App 处理');
    }
    return index;
  }
  async function requireAuto(rule) {
    const service = await serviceInfo(), current = getRule(rule.key), cfg = readConfig();
    if (!current.enabled || !current.consent || current.consent.policyHash !== hashRule(cleanRule(current)) || current.policyHash !== rule.policyHash) throw fail('NFT 规则已停用或授权已改变');
    if (cfg.monitorOnly || !service.running) throw fail('当前未运行自动交易监控，NFT 自动操作已暂停');
    if (!store.getApiKey()) throw fail('请先配置 Element API Key');
    return current;
  }
  function publicState(st) {
    const safe = {};
    for (const key of ['phase', 'reason', 'lastCheckedAt', 'orderId', 'txHash', 'netBnb', 'quoteCurrency', 'listedAt', 'filledAt', 'expiresAt', 'walletOrderId', 'approvalScope']) if (st[key] !== undefined) safe[key] = st[key];
    if (st.ruleState?.peakNetWei) safe.peakNetBnb = formatBnbWei(st.ruleState.peakNetWei);
    if (st.ruleState) safe.trailingArmed = Boolean(st.ruleState.trailingArmed);
    return safe;
  }
  async function view() {
    const saved = store.view(), cfg = readConfig(), service = await serviceInfo();
    const ready = saved.settings.apiKeyConfigured && !loadError;
    return { ...saved, states: Object.fromEntries(Object.entries(states).map(([key, st]) => [key, publicState(st)])), capabilities: { provider: 'Element', apiKeyConfigured: saved.settings.apiKeyConfigured, ready, reason: loadError || (!ready ? '请填写 Element API Key；保存草稿不会自动卖出' : cfg.monitorOnly || !service.running ? '自动交易监控未运行，NFT 规则暂不执行' : '按已授权的 NFT 规则检查可执行报价'), docsUrl: 'https://element.market/naas' }, runtime: { running: Boolean(timer) && service.running && !cfg.monitorOnly, enabledRules: saved.rules.filter(rule => rule.enabled).length, monitorOnly: Boolean(cfg.monitorOnly) } };
  }
  function rejectReview(st, message) {
    st.phase = 'review'; st.reason = message;
    if (st.ruleState && ['intent', 'pending'].includes(st.ruleState.phase)) st.ruleState = applyNftEvent(st.ruleState, { type: 'submission-unknown', key: st.ruleState.key, intentId: st.ruleState.intentId, now: now() });
    persist();
  }
  async function buildOperation(rule, kind = null) {
    if (loadError) throw fail(loadError);
    if (kind !== 'cancel') validateNftRule({ ...cleanRule(rule), enabled: true });
    const index = await preflight(rule);
    if (kind !== 'cancel' && typeof market.checkApiKey === 'function') await market.checkApiKey();
    const st = stateFor(rule.key), policyHash = rule.policyHash;
    const position = kind === 'cancel' ? null : await market.position(cleanRule(rule));
    if (kind !== 'cancel' && (!position.verifiedOwnership || BigInt(position.quantity || '0') < BigInt(rule.quantity))) throw fail('当前钱包未持有足够的该 NFT，不能准备卖出');
    let operation, quote = null, summary;
    if (kind === 'cancel') {
      if (!st.plan || !['listed', 'review', 'signature-pending', 'publishing', 'pending'].includes(st.phase)) throw fail('没有可撤销的 NFT 签名订单');
      operation = { kind: 'cancel', transaction: await market.cancelTransaction(st, cleanRule(rule)) };
      summary = '撤销此 NFT 签名订单，并停用该规则';
    } else if (!position.approved) {
      if (!position.approval?.to || !position.approval?.data) throw fail('无法生成有效 NFT 授权预演');
      operation = { kind: 'approval', transaction: position.approval };
      summary = position.approval.scope === 'collection' ? 'ERC1155 系列授权：此市场将可操作该系列全部 NFT；必须单独确认' : '仅授权此 Token ID 给 Element 市场';
    } else {
      if (ACTIVE.has(st.phase)) throw fail('已有待处理 NFT 订单，不能重复创建');
      quote = await market.quote(cleanRule(rule), position);
      const simulated = validateNftRule({ ...cleanRule(rule), enabled: true });
      const planned = planNftAction({ rule: simulated, state: st.ruleState, position, quote, now: now() });
      st.ruleState = planned.nextState; st.reason = reasonText(planned.reason); st.lastCheckedAt = now();
      if (quote) { st.netBnb = BigInt(quote.grossWei || '0') >= BigInt(quote.feesWei || '0') ? formatBnbWei(BigInt(quote.grossWei || '0') - BigInt(quote.feesWei || '0')) : null; st.quoteCurrency = quote.currency; }
      if (!planned.action) { st.phase = 'waiting-trigger'; persist(); return { status: st.phase, reason: st.reason, position, quote: safeQuote(quote), summary: st.reason }; }
      operation = planned.action.type === 'list'
        ? { kind: 'listing', plan: await market.buildListing(cleanRule(rule), quote), action: planned.action }
        : { kind: 'accept', transaction: quote.context?.transaction, action: planned.action };
      if (operation.kind === 'accept' && !operation.transaction?.data) throw fail('缺少已核验的卖出交易数据');
      operation.quote = quote;
      summary = operation.kind === 'listing' ? `按每件 ${rule.listingUnitPriceBnb} BNB 签名挂牌 ${rule.quantity} 件；挂牌不等于成交` : `接受买单，预计扣费后收入 ${st.netBnb} ${quote.currency}`;
    }
    const estimatedGasWei = await transactionBudget(rule, operation);
    const previewArgs = operation.kind === 'listing'
      ? ['sign-message', 'preview', '--binanceChainId', '56', '--signType', 'EIP712', '--message', JSON.stringify({ method: 'eth_signTypedData_v4', params: [rule.walletAddress, JSON.stringify(TypedDataEncoder.getPayload(operation.plan.typedData.domain, operation.plan.typedData.types, operation.plan.typedData.message))] })]
      : ['contract-call', 'preview', '--binanceChainId', '56', '--from', rule.walletAddress, '--to', operation.transaction.to, '--value', String(operation.transaction.value || '0'), '--inputData', operation.transaction.data];
    const preview = await walletCall(index, previewArgs);
    if (!preview.requestId) throw fail('钱包预演未返回可执行的 requestId');
    const expiresAt = Math.min(expiryMs(preview.expiresAt) || now() + 300000, now() + 300000, quote?.expiresAt || Infinity);
    if (expiresAt <= now()) throw fail('NFT 报价或预演已过期');
    return { status: 'preview', summary, position, quote: safeQuote(quote), estimatedGasBnb: estimatedGasWei === null ? null : formatBnbWei(estimatedGasWei), approval: operation.kind === 'approval' ? position.approval : null, parsedTx: preview.parsedTx, parsedMessage: preview.parsedMessage, simulationResult: preview.simulationResult, authorityChanges: preview.simulationResult?.authorityChanges || [], risks: preview.risks || {}, requireConfirmation: preview.requireConfirmation === true, expiresAt, privateOperation: { ...operation, key: rule.key, policyHash, walletIndex: index, requestId: preview.requestId, expiresAt, previewRisks: preview.risks || {}, simulationResult: preview.simulationResult, authorityChanges: preview.simulationResult?.authorityChanges || [], requireConfirmation: preview.requireConfirmation === true } };
  }
  function safeQuote(quote) { if (!quote) return null; const { context, ...safe } = quote; return safe; }
  function hasRisk(operation) {
    const risks = operation.previewRisks;
    if (!risks || !Array.isArray(risks.riskDetails) || !Array.isArray(risks.riskBehaviors) || !risks.addresses || typeof risks.addresses !== 'object' || Array.isArray(risks.addresses)) return true;
    if (typeof risks !== 'object' || Array.isArray(risks) || Object.keys(risks).some(key => !['riskDetails', 'riskBehaviors', 'addresses'].includes(key))) return true;
    if (risks.riskDetails && !Array.isArray(risks.riskDetails) || risks.riskBehaviors && !Array.isArray(risks.riskBehaviors) || risks.addresses && (typeof risks.addresses !== 'object' || Array.isArray(risks.addresses))) return true;
    return risks.riskDetails.length > 0 || risks.riskBehaviors.length > 0 || Object.values(risks.addresses).some(value => !value || typeof value !== 'object' || !Array.isArray(value.riskDetails) || ![0, '0'].includes(value.riskLevel) || value.riskDetails.length > 0) || operation.authorityChanges?.length > 0;
  }
  function automaticBlock(rule, operation) {
    if (operation.requireConfirmation) return '钱包要求本次单独确认，请在前端核对预演后继续';
    if (hasRisk(operation)) return '钱包预演包含风险或权限变化，请在前端核对并确认';
    return operation.kind === 'accept' ? checkNftSaleSimulation(rule, operation, operation.simulationResult) : null;
  }
  async function transactionBudget(rule, operation) {
    if (!operation.transaction) return null;
    const tx = { from: rule.walletAddress, to: operation.transaction.to, data: operation.transaction.data, value: '0x' + BigInt(operation.transaction.value || '0').toString(16) };
    const [gasRaw, priceRaw] = await Promise.all([rpc('eth_estimateGas', [tx]), rpc('eth_gasPrice', [])]);
    if (!/^0x[0-9a-f]+$/i.test(gasRaw || '') || !/^0x[0-9a-f]+$/i.test(priceRaw || '')) throw fail('无法核验当前 Gas，未提交 NFT 操作');
    const gas = (BigInt(gasRaw) * 120n + 99n) / 100n * BigInt(priceRaw), marketFees = BigInt(operation.quote?.marketFeesWei || '0');
    if (BigInt(gasRaw) <= 0n || BigInt(priceRaw) <= 0n) throw fail('Gas 估算无效，未提交 NFT 操作');
    // Cancellation is a separate, manually confirmed operation. Its current
    // estimate is shown in the preview rather than changing a signed sale.
    if (operation.kind !== 'cancel' && gas + marketFees > parseBnbWei(rule.maxFeesBnb)) throw fail('当前市场费及预估 Gas 已超过规则上限');
    if (operation.kind === 'accept') {
      const net = BigInt(operation.quote.grossWei) - marketFees - gas;
      if (net < parseBnbWei(rule.minNetBnb) || rule.mode === 'take-profit-offer' && net < parseBnbWei(rule.takeProfitNetBnb)) throw fail('当前 Gas 变化使净收入低于卖出目标');
    }
    return gas.toString();
  }
  async function executeOperation(operation, { automatic = false } = {}) {
    const rule = getRule(operation.key), st = stateFor(rule.key);
    if (rule.policyHash !== operation.policyHash || operation.expiresAt <= now()) throw fail('NFT 规则、报价或预演已改变，请重新预演');
    if (automatic) { await requireAuto(rule); if (operation.kind === 'approval' || operation.kind === 'cancel' || automaticBlock(rule, operation)) throw fail('NFT 授权、撤单或预演变化必须单独确认'); }
    const index = await preflight(rule, { sending: operation.kind !== 'listing' });
    const position = operation.kind === 'cancel' ? null : await market.position(cleanRule(rule));
    if (operation.kind !== 'cancel' && (!position.verifiedOwnership || BigInt(position.quantity || '0') < BigInt(rule.quantity))) throw fail('NFT 归属或数量已改变，请重新预演');
    if (!['approval', 'cancel'].includes(operation.kind) && !position.approved) throw fail('NFT 授权已改变，请重新预演');
    if (operation.kind === 'accept') {
      const unsafe = checkNftSaleSimulation(rule, operation, operation.simulationResult);
      if (unsafe) throw fail('卖出预演无法满足规则，未执行：' + unsafe);
    }
    await transactionBudget(rule, operation);
    if ((st.effectIntent || ACTIVE.has(st.phase)) && operation.kind !== 'cancel') throw fail('已有 NFT 操作待核对，禁止重复提交');
    if (operation.kind === 'cancel' && st.operation?.kind === 'cancel' && st.effectIntent) throw fail('撤单已提交，禁止重复撤单');
    const submittedBlock = Number.parseInt(await rpc('eth_blockNumber', []), 16);
    if (!Number.isSafeInteger(submittedBlock)) throw fail('无法确认提交前区块高度');
    // Check consent after every asynchronous preflight step, immediately before
    // persisting an intent and invoking execute. Disable wins that race.
    if (automatic) await requireAuto(rule);
    const latest = getRule(rule.key);
    if (latest.policyHash !== operation.policyHash || operation.expiresAt <= now()) throw fail('NFT 规则或报价在检查期间已改变，请重新预演');
    const intentId = id();
    if (operation.action) st.ruleState = applyNftEvent(st.ruleState, { type: 'intent-created', key: rule.key, intentId, action: operation.action, now: now() });
    st.effectIntent = { id: intentId, kind: operation.kind, stage: 'submitting', createdAt: now(), policyHash: rule.policyHash, automatic };
    st.operation = operation; if (operation.plan) st.plan = operation.plan;
    st.phase = operation.kind === 'listing' ? 'signing' : 'submitting'; st.reason = '正在提交，未确认前不会重复执行';
    st.submittedBlock = submittedBlock; delete st.searchBlock;
    persist(); // A failed durable write MUST prevent signing/broadcast.
    if (operation.kind === 'cancel') store.setEnabled(rule.key, false);
    try {
      const result = await walletCall(index, [operation.kind === 'listing' ? 'sign-message' : 'contract-call', 'execute', '--requestId', operation.requestId]);
      st.walletOrderId = result.orderId || null;
      if (operation.kind === 'listing') {
        if (result.signature) await publishSignature(rule, st, result);
        else if (result.status === 'PENDING_CONFIRMATION' && result.orderId) { st.phase = 'signature-pending'; st.effectIntent.stage = 'awaiting-signature'; st.reason = '请在币安 App 确认 NFT 挂牌签名'; persist(); }
        else rejectReview(st, '挂牌签名结果不明，已阻止重发；请核对钱包签名记录');
      } else {
        if (result.txHash && !TX_HASH.test(result.txHash)) throw fail('钱包返回了无效的交易哈希');
        st.txHash = result.txHash || null; st.phase = 'pending'; st.effectIntent.stage = 'awaiting-receipt';
        st.reason = result.status === 'PENDING_CONFIRMATION' ? '请在币安 App 确认交易；等待链上凭证' : '交易已提交，等待链上凭证';
        if (operation.action) st.ruleState = applyNftEvent(st.ruleState, { type: 'submitted', key: rule.key, intentId, orderId: result.orderId || result.txHash || intentId, now: now() });
        persist();
      }
    } catch (error) {
      rejectReview(st, '提交结果需要核对，已阻止自动重发：' + String(error.message).slice(0, 180));
    }
    return publicState(st);
  }
  async function publishSignature(rule, st, result) {
    if (!['signing', 'signature-pending'].includes(st.phase) || st.operation?.kind !== 'listing' || st.effectIntent?.kind !== 'listing') throw fail('挂牌操作已改变，未发布旧签名');
    st.signature = normalizeWalletSignature(result, st.plan.hash, rule.walletAddress);
    const current = getRule(rule.key);
    if (current.policyHash !== st.effectIntent.policyHash || st.effectIntent.automatic && !current.enabled) { rejectReview(st, '签名已完成，但规则已停用或改变，未发布市场订单；可核对后撤销此签名订单'); return; }
    if (st.effectIntent.automatic) {
      try { await requireAuto(current); } catch { rejectReview(st, '签名已完成，但自动交易已暂停，未发布市场订单；可核对后撤销此签名订单'); return; }
    }
    st.phase = 'publishing'; st.effectIntent.stage = 'publishing'; st.reason = '签名已确认，正在发布同一笔市场订单'; persist();
    const published = await market.publishListing(st.plan, st.signature);
    if (!published?.verified || !published.orderId || published.hash?.toLowerCase() !== st.plan.hash.toLowerCase()) { rejectReview(st, '市场发布结果或经济字段未能核验，已阻止重复挂牌；可核对订单或链上撤单'); return; }
    st.orderId = String(published.orderId); st.phase = 'listed'; st.listedAt = now(); st.expiresAt = st.plan.expirationTime * 1000; st.reason = '市场挂单已核验，等待买家成交';
    st.ruleState = applyNftEvent(st.ruleState, { type: 'submitted', key: rule.key, intentId: st.ruleState.intentId, orderId: st.orderId, now: now() });
    st.ruleState = applyNftEvent(st.ruleState, { type: 'listed-confirmed', key: rule.key, intentId: st.ruleState.intentId, orderId: st.orderId, confirmed: true, now: now() });
    delete st.signature; delete st.effectIntent; delete st.operation; persist();
  }
  async function findSubmittedTransaction(rule, st) {
    const head = Number.parseInt(await rpc('eth_blockNumber', []), 16), start = st.searchBlock ?? st.submittedBlock;
    if (!Number.isSafeInteger(head) || !Number.isSafeInteger(start) || start > head) return null;
    const end = Math.min(head, start + 999);
    const address = st.operation.kind === 'cancel' ? st.operation.transaction.to : rule.addr;
    const logs = await rpc('eth_getLogs', [{ address, fromBlock: '0x' + start.toString(16), toBlock: '0x' + end.toString(16) }]);
    for (const hash of [...new Set((logs || []).slice(0, 1000).map(log => log.transactionHash).filter(hash => TX_HASH.test(hash)))]) {
      const transaction = await rpc('eth_getTransactionByHash', [hash]);
      if (transaction?.from?.toLowerCase() === rule.walletAddress && transaction.to?.toLowerCase() === st.operation.transaction.to.toLowerCase() && transaction.input?.toLowerCase() === st.operation.transaction.data.toLowerCase() && BigInt(transaction.value || '0') === BigInt(st.operation.transaction.value || '0')) return hash;
    }
    st.searchBlock = end + 1; return null;
  }
  async function verifyFill(rule, st, receipt) {
    const changes = decodeNftTransfers(receipt.logs || [], rule.walletAddress).filter(change => change.addr === rule.addr && change.tokenId === rule.tokenId);
    const out = -changes.reduce((total, change) => total + BigInt(change.delta), 0n);
    if (out !== BigInt(rule.quantity)) return { confirmed: false, reason: 'NFT 转出数量与规则不一致，需人工核对' };
    if (typeof market.verifyFill === 'function') return market.verifyFill(cleanRule(rule), st, receipt);
    // WBNB receipts are independently verifiable even when native internal
    // transfers cannot be read from a public RPC. Unknown proceeds stay review.
    let received = 0n;
    for (const log of receipt.logs || []) {
      if (log.address?.toLowerCase() !== WBNB || log.topics?.length !== 3 || log.topics[0]?.toLowerCase() !== '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef') continue;
      const amount = decodeAbiUint(log.data); if (amount === null) return { confirmed: false };
      if (log.topics[2].slice(-40).toLowerCase() === rule.walletAddress.slice(2)) received += amount;
      if (log.topics[1].slice(-40).toLowerCase() === rule.walletAddress.slice(2)) received -= amount;
    }
    const gas = BigInt(receipt.gasUsed || '0') * BigInt(receipt.effectiveGasPrice || '0');
    const net = received - gas;
    return { confirmed: net >= parseBnbWei(rule.minNetBnb), filledQuantity: out.toString(), netWei: net > 0n ? net.toString() : '0', currency: 'WBNB', reason: '无法从本笔凭证确认足够净收入，需人工核对' };
  }
  async function reconcile(rule, st) {
    if (st.phase === 'signature-pending') {
      const result = await walletCall(indexFor(rule), ['sign-message', 'result', '--order-id', st.walletOrderId]);
      if (result.status === 'COMPLETED' && result.signature) await publishSignature(rule, st, result);
      else if (['REJECTED', 'EXPIRED'].includes(result.status)) rejectReview(st, '挂牌签名已拒绝或过期，请核对后重新配置');
      return;
    }
    if (st.phase === 'listed') {
      const result = await market.orderStatus(st, cleanRule(rule));
      if (Number.isSafeInteger(result?.searchBlock)) st.marketSearchBlock = result.searchBlock;
      if (result?.status === 'listed' && result.remainingQuantity !== undefined && BigInt(result.remainingQuantity) < BigInt(rule.quantity)) { rejectReview(st, 'ERC1155 挂单已部分成交，请核对收益和剩余挂单；不会自动补卖'); return; }
      if (result?.status === 'expired' || result?.status === 'cancelled') {
        st.ruleState = applyNftEvent(st.ruleState, { type: result.status === 'expired' ? 'expired-confirmed' : 'cancel-confirmed', key: rule.key, intentId: st.ruleState.intentId, orderId: st.orderId, confirmed: result.confirmed === true, now: now() });
        st.phase = result.status; st.reason = result.status === 'expired' ? '挂单已确认过期' : '挂单已确认撤销'; persist();
      } else if (result?.status === 'filled' && TX_HASH.test(result.txHash || '')) { st.txHash = result.txHash; st.phase = 'pending'; st.reason = '市场报告已成交，等待本笔链上凭证核验'; persist(); }
      else if (result?.status === 'filled') rejectReview(st, '市场报告已成交，但尚无可核验的成交交易哈希，请核对订单');
      else if (result?.status === 'unavailable') { st.reason = '订单当前不可成交，正在核对成交或撤单凭证；不会重复挂牌'; persist(); }
      return;
    }
    if (st.phase !== 'pending') return;
    if (!st.txHash && st.operation?.transaction) st.txHash = await findSubmittedTransaction(rule, st);
    if (!st.txHash) { persist(); return; }
    const [receipt, transaction] = await Promise.all([rpc('eth_getTransactionReceipt', [st.txHash]), rpc('eth_getTransactionByHash', [st.txHash])]);
    if (!receipt) return;
    if (receipt.status !== '0x1') { rejectReview(st, '交易未成功；已停止自动重发，请核对 Gas 与资产状态'); return; }
    if (st.operation?.transaction && (transaction?.from?.toLowerCase() !== rule.walletAddress || transaction.to?.toLowerCase() !== st.operation.transaction.to.toLowerCase() || transaction.input?.toLowerCase() !== st.operation.transaction.data.toLowerCase() || BigInt(transaction.value || '0') !== BigInt(st.operation.transaction.value || '0'))) { rejectReview(st, '链上交易与预演内容不匹配，需人工核对'); return; }
    if (st.operation?.kind === 'approval') {
      const current = await market.position(cleanRule(rule));
      if (!current.approved) { rejectReview(st, '授权交易已确认，但授权状态尚未核验'); return; }
      st.phase = 'idle'; st.reason = 'NFT 授权已确认，可按规则准备订单'; delete st.effectIntent; delete st.operation;
    } else if (st.operation?.kind === 'cancel') {
      const result = await market.orderStatus(st, cleanRule(rule));
      if (result?.confirmed !== true || !['cancelled', 'expired', 'unavailable'].includes(result.status)) { rejectReview(st, '撤单交易已确认，但订单失效状态尚未核验'); return; }
      st.phase = 'cancelled'; st.reason = '订单已撤销，规则已停用'; delete st.effectIntent; delete st.operation; delete st.signature;
      if (st.ruleState?.orderId) st.ruleState = applyNftEvent(st.ruleState, { type: 'cancel-confirmed', key: rule.key, intentId: st.ruleState.intentId, orderId: st.ruleState.orderId, confirmed: true, now: now() });
    } else {
      const fill = await verifyFill(rule, st, receipt);
      if (fill.confirmed !== true) { rejectReview(st, fill.reason || '成交凭证或净收入无法完整核验，需人工核对'); return; }
      st.ruleState = applyNftEvent(st.ruleState, { type: 'fill-confirmed', key: rule.key, intentId: st.ruleState.intentId, orderId: st.ruleState.orderId, confirmed: true, txHash: st.txHash, filledQuantity: fill.filledQuantity, now: now() });
      st.phase = 'filled'; st.filledAt = now(); st.reason = 'NFT 成交数量及收入已核验'; st.netBnb = formatBnbWei(fill.netWei); st.quoteCurrency = fill.currency; delete st.effectIntent; delete st.operation;
    }
    persist();
  }
  async function tick() {
    if (busy || loadError) return;
    busy = true;
    try {
      for (const rule of store.readRules()) {
        const st = stateFor(rule.key);
        if (st.phase === 'filled') continue;
        if (now() - (st.lastCheckedAt || 0) < 15000) continue;
        st.lastCheckedAt = now();
        try {
          if (['signature-pending', 'listed', 'pending'].includes(st.phase)) { await withWalletLock(indexFor(rule), () => reconcile(rule, st)); continue; }
          if (st.effectIntent || ACTIVE.has(st.phase)) { if (!['review', 'filled'].includes(st.phase)) rejectReview(st, '上次 NFT 操作结果未核对，已禁止自动重发'); continue; }
          if (!rule.enabled) { st.phase = 'disabled'; st.reason = '规则已停用；关闭规则不会撤销已有市场挂单'; continue; }
          await requireAuto(rule);
          await withWalletLock(indexFor(rule), async () => {
            const currentPosition = await market.position(cleanRule(rule));
            if (!currentPosition.approved) { st.phase = 'awaiting-approval'; st.approvalScope = currentPosition.approval?.scope; st.reason = '需要先在前端单独预演并确认 NFT 授权'; return; }
            const prepared = await buildOperation(rule);
            if (!prepared.privateOperation) return;
            if (prepared.privateOperation.kind === 'approval') { st.phase = 'awaiting-approval'; st.approvalScope = prepared.approval?.scope; st.reason = '需要先在前端单独预演并确认 NFT 授权'; return; }
            const blocked = automaticBlock(rule, prepared.privateOperation);
            if (blocked) { st.phase = 'awaiting-confirmation'; st.reason = blocked; return; }
            await executeOperation(prepared.privateOperation, { automatic: true });
          });
        } catch (error) { if (!st.effectIntent && !ACTIVE.has(st.phase)) { st.phase = 'blocked'; st.reason = String(error.message || 'NFT 规则检查失败').slice(0, 240); } }
      }
      if (Object.keys(states).length) persist();
    } finally { busy = false; }
  }
  async function preview(key, owner, cancel = false) {
    const rule = getRule(key);
    return withWalletLock(indexFor(rule), async () => {
      const prepared = await buildOperation(rule, cancel ? 'cancel' : null);
      const { privateOperation, ...safe } = prepared;
      if (!privateOperation) return safe;
      const actionId = id(); actions.set(actionId, { owner, operation: privateOperation });
      return { ...safe, actionId };
    });
  }
  async function confirm(actionId, owner, confirmed) {
    const saved = actions.get(actionId);
    if (!saved || saved.owner !== owner || saved.operation.expiresAt <= now()) throw fail('预演已过期或不属于此页面，请重新预演');
    if (confirmed !== true) throw fail('请核对价格、授权和风险后明确确认');
    actions.delete(actionId);
    return withWalletLock(saved.operation.walletIndex, () => executeOperation(saved.operation));
  }
  async function saveRule(raw) {
    const normalized = validateNftRule({ ...cleanRule(raw), enabled: false }), st = states[normalized.key];
    indexFor(normalized);
    if (st && (ACTIVE.has(st.phase) || st.effectIntent)) throw fail('此 NFT 尚有活动或待核对订单，请先撤单并核对结果，再修改价格');
    const saved = store.saveRule(raw);
    states[saved.key] = { phase: 'disabled', reason: '草稿已保存，尚未启用', lastCheckedAt: null }; persist();
    return saved;
  }
  async function enable(key, policyHash, confirmed) {
    if (confirmed !== true) throw fail('启用前请明确授权此 NFT 的价格、数量及自动执行范围');
    if (!store.getApiKey()) throw fail('请先在 NFT 自动卖出设置中填写 Element API Key');
    const rule = getRule(key);
    if (policyHash !== rule.policyHash) throw fail('规则已改变，请重新核对');
    validateNftRule({ ...cleanRule(rule), enabled: true });
    if (loadError) throw fail(loadError);
    await withWalletLock(indexFor(rule), async () => {
      await preflight(rule);
      if (typeof market.checkApiKey === 'function') await market.checkApiKey();
      const position = await market.position(cleanRule(rule));
      if (!position.verifiedOwnership || BigInt(position.quantity || '0') < BigInt(rule.quantity)) throw fail('当前 NFT 归属或数量核验失败');
    });
    return store.setEnabled(key, true, policyHash);
  }
  return {
    view, tick, preview, confirm, saveRule, enable,
    saveSettings: input => store.saveSettings(input),
    disable: key => store.setEnabled(key, false),
    start() { if (!timer) { timer = setInterval(() => { void tick().catch(() => {}); }, 15000); timer.unref?.(); void tick().catch(() => {}); } },
    stop() { clearInterval(timer); timer = null; },
    hasInFlight: () => busy,
  };
}
