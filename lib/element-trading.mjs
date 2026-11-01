// Restricted Element v3 planner. This module never signs or sends transactions.
import { Interface, TypedDataEncoder, Signature, verifyTypedData, getAddress, parseEther } from 'ethers';
import { randomUUID } from 'node:crypto';
import { nftRpc } from './nft-holdings.mjs';
import { ELEMENT_ABI } from './vendor/element-v3-abi.mjs';

export { ELEMENT_ABI };
export const ELEMENT_EX = '0xb3e3dfcb2d9f3dde16d78b9e6eb3538eb32b5ae1';
export const WBNB = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
export const ELEMENT_HELPER = '0xb54ee46dace4ecac1dbc2488b61094b4b3174139';
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
export const NATIVE_TOKEN = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
export const ELEMENT_API = 'https://api.element.market/openapi/v1';
export const ELEMENT_DOMAIN = Object.freeze({ name: 'ElementEx', version: '1.0.0', chainId: 56, verifyingContract: ELEMENT_EX });
export const ELEMENT_INTERFACE = new Interface(ELEMENT_ABI);
export const NFT_INTERFACE = new Interface([
  'function ownerOf(uint256) view returns(address)', 'function getApproved(uint256) view returns(address)',
  'function isApprovedForAll(address,address) view returns(bool)', 'function approve(address,uint256)',
  'function setApprovalForAll(address,bool)', 'function balanceOf(address,uint256) view returns(uint256)',
]);
const TOKEN_INTERFACE = new Interface(['function balanceOf(address) view returns(uint256)', 'function allowance(address,address) view returns(uint256)']);
const MAX_UINT = (1n << 256n) - 1n, MAX_128 = (1n << 128n) - 1n;
const MAX_RESPONSE = 4 * 1024 * 1024;
const fail = (code, message) => { const e = new Error(message); e.code = code; throw e; };
const equalAddress = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const address = (value) => { try { return getAddress(value).toLowerCase(); } catch { return fail('INVALID_ADDRESS', 'NFT 地址或钱包地址无效'); } };
function uint(value, name = '数量', max = MAX_UINT) {
  if (!/^(0|[1-9]\d*)$/.test(String(value)) || String(value).length > 78) fail('INVALID_AMOUNT', `${name}无效`);
  const result = BigInt(value); if (result > max) fail('INVALID_AMOUNT', `${name}超出范围`); return result;
}
function rpcUint(value, name) {
  if (typeof value !== 'string' || !/^0x[0-9a-f]+$/i.test(value)) fail('INVALID_RPC_RESULT', `${name}返回格式无效`);
  return uint(BigInt(value), name);
}
function bnb(value, name, { positive = false } = {}) {
  if (typeof value !== 'string' || value.length > 100 || !/^\d+(?:\.\d{1,18})?$/.test(value)) fail('INVALID_AMOUNT', `${name}格式无效`);
  let n; try { n = parseEther(value); } catch { fail('INVALID_AMOUNT', `${name}格式无效`); }
  if (n > MAX_UINT || (positive && n <= 0n)) fail('INVALID_AMOUNT', `${name}必须大于零`); return n;
}
function binding(rule) {
  const standard = rule?.standard;
  if (!['ERC721', 'ERC1155'].includes(standard)) fail('UNSUPPORTED_STANDARD', '仅支持已核验 ERC721 或 ERC1155');
  const quantity = uint(rule.quantity ?? '1', 'NFT 数量', standard === 'ERC1155' ? MAX_128 : MAX_UINT);
  if (!quantity || (standard === 'ERC721' && quantity !== 1n)) fail('INVALID_QUANTITY', 'NFT 数量无效');
  return { walletAddress: address(rule.walletAddress), addr: address(rule.addr), standard, tokenId: uint(rule.tokenId, 'Token ID').toString(), quantity: quantity.toString() };
}
function assertBinding(rule, other) {
  const current = binding(rule);
  if (!other || Object.keys(current).some(k => current[k] !== other[k])) fail('BINDING_MISMATCH', 'NFT 报价与当前钱包、资产或数量不一致');
  return current;
}
const canonical = value => JSON.stringify(value, (_k,v) => typeof v === 'bigint' ? v.toString() : v && !Array.isArray(v) && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])) : v);
function listingRequest(b, order, hash, times, gross) {
  return { chain:'bsc',exchange:ELEMENT_EX,maker:b.walletAddress,taker:ZERO_ADDRESS,side:1,saleKind:0,paymentToken:ZERO_ADDRESS,quantity:b.quantity,basePrice:gross,extra:'0',listingTime:String(times.listingTime),expirationTime:String(times.expirationTime),metadata:{asset:{id:b.tokenId,address:b.addr},schema:b.standard},fees:order.fees,nonce:String(order.nonce),hashNonce:String(order.hashNonce),hash,signatureType:0,oracleSignature:1 };
}
/** Recompute the allowed signature and POST body; persisted plans are never an
 * arbitrary sign-message or publish bridge. Safe to use after order expiry. */
export function validateElementListingPlan(plan) {
  try {
    const b=binding(plan),o=plan.order;
    if (!o || !equalAddress(o.maker,b.walletAddress) || !equalAddress(o.taker,ZERO_ADDRESS) || !equalAddress(o.erc20Token,NATIVE_TOKEN) || !Array.isArray(o.fees) || o.fees.length>10 || o.fees.some(f=>f.feeData!=='0x'||equalAddress(f.recipient,ZERO_ADDRESS)||address(f.recipient)!==f.recipient)) throw Error();
    const times=unpackElementExpiry(o.expiry);
    if(times.oracleSignature!==1 || times.listingTime!==plan.listingTime || times.expirationTime!==plan.expirationTime || String(o.nonce)!==String(plan.nonce) || String(o.expiry)!==String(plan.expiry)) throw Error();
    if(b.standard==='ERC721' ? !equalAddress(o.nft,b.addr)||String(o.nftId)!==b.tokenId||o.nftProperties!==undefined : !equalAddress(o.erc1155Token,b.addr)||String(o.erc1155TokenId)!==b.tokenId||String(o.erc1155TokenAmount)!==b.quantity||o.erc1155TokenProperties!==undefined) throw Error();
    const net=uint(o.erc20TokenAmount),fees=o.fees.reduce((s,f)=>s+uint(f.amount),0n),gross=net+fees;
    if(!net || gross>MAX_UINT || gross.toString()!==plan.grossWei || fees.toString()!==plan.feesWei || net.toString()!==plan.netWei) throw Error();
    uint(o.nonce);uint(o.hashNonce);
    const typedData=elementTypedData(o,b.standard),hash=TypedDataEncoder.hash(typedData.domain,typedData.types,typedData.message);
    const request=listingRequest(b,o,hash,times,gross.toString());
    if(hash!==plan.hash || canonical(typedData)!==canonical(plan.typedData) || canonical(request)!==canonical(plan.request)) throw Error();
    return {binding:b,typedData,request,hash};
  } catch { fail('INVALID_PLAN','挂单计划、签名内容或发布字段不一致'); }
}
function plainOrder(result) {
  const resultOrder = {};
  for (const component of result.toObject ? Object.keys(result.toObject()) : Object.keys(result)) {
    const v = result[component];
    resultOrder[component] = typeof v === 'bigint' ? v.toString() : v;
  }
  resultOrder.fees = [...result.fees].map(f => ({ recipient: address(f.recipient), amount: uint(f.amount).toString(), feeData: f.feeData }));
  if (result.nftProperties) resultOrder.nftProperties = [...result.nftProperties].map(p => ({ propertyValidator: address(p.propertyValidator), propertyData: p.propertyData }));
  if (result.erc1155TokenProperties) resultOrder.erc1155TokenProperties = [...result.erc1155TokenProperties].map(p => ({ propertyValidator: address(p.propertyValidator), propertyData: p.propertyData }));
  return resultOrder;
}
const feeType = [{ name: 'recipient', type: 'address' }, { name: 'amount', type: 'uint256' }, { name: 'feeData', type: 'bytes' }];
const propertyType = [{ name: 'propertyValidator', type: 'address' }, { name: 'propertyData', type: 'bytes' }];
export function elementTypedData(order, standard, side = 'sell') {
  const buy = side === 'buy';
  const fields = [ ['maker','address'], ['taker','address'], ['expiry','uint256'], ['nonce','uint256'], ['erc20Token','address'], ['erc20TokenAmount','uint256'], ['fees','Fee[]'] ];
  if (standard === 'ERC721') {
    fields.push(['nft','address'], ['nftId','uint256']);
    if (buy) fields.push(['nftProperties','Property[]']);
  } else if (standard === 'ERC1155') {
    fields.push(['erc1155Token','address'], ['erc1155TokenId','uint256']);
    if (buy) fields.push(['erc1155TokenProperties','Property[]']);
    fields.push(['erc1155TokenAmount','uint128']);
  } else fail('UNSUPPORTED_STANDARD', '不支持的 NFT 标准');
  fields.push(['hashNonce','uint256']);
  const primaryType = standard === 'ERC721' ? `NFT${buy ? 'Buy' : 'Sell'}Order` : `ERC1155${buy ? 'Buy' : 'Sell'}Order`;
  return { domain: { ...ELEMENT_DOMAIN }, primaryType, types: { [primaryType]: fields.map(([name,type]) => ({ name,type })), Fee: feeType, ...(buy ? { Property: propertyType } : {}) }, message: order };
}
export function packElementExpiry(listingTime, expirationTime, oracleSignature = 1) {
  const listing = uint(listingTime, '挂单时间', 0xffffffffn), expiry = uint(expirationTime, '到期时间', 0xffffffffn);
  if (![0, 1].includes(oracleSignature) || expiry <= listing) fail('INVALID_EXPIRY', '挂单到期参数无效');
  return ((BigInt(oracleSignature) << 248n) | (listing << 32n) | expiry).toString();
}
export function unpackElementExpiry(value) {
  const n = uint(value, '订单到期参数');
  if ((n >> 252n) !== 0n || ((n >> 64n) & ((1n << 184n) - 1n)) !== 0n) fail('UNSUPPORTED_ORDER', '不支持的拍卖或扩展订单');
  const oracleSignature = Number((n >> 248n) & 15n);
  if (![0,1].includes(oracleSignature)) fail('UNSUPPORTED_ORDER', '未知 oracle 验证模式');
  return { listingTime: Number((n >> 32n) & 0xffffffffn), expirationTime: Number(n & 0xffffffffn), oracleSignature };
}

/** Decode the entire canonical single-order call. Unknown trailers, aggregators,
 * callbacks and collection/trait validators are deliberately not executable. */
export function decodeElementOfferTransaction(transaction, position, { now = Date.now() } = {}) {
  if (!transaction || !equalAddress(transaction.to, ELEMENT_EX) || uint(transaction.value ?? '0') !== 0n || !/^0x[0-9a-f]+$/i.test(transaction.data ?? '') || transaction.data.length > 100000) fail('UNSUPPORTED_TRANSACTION', '仅允许 ElementEx 的单笔零付款卖出');
  let decoded; try { decoded = ELEMENT_INTERFACE.parseTransaction({ data: transaction.data, value: 0n }); } catch { fail('UNSUPPORTED_TRANSACTION', '无法识别 Element 成交编码'); }
  const expected = position.standard === 'ERC721' ? 'sellERC721' : 'sellERC1155';
  if (!decoded || decoded.name !== expected) fail('UNSUPPORTED_TRANSACTION', '不支持聚合交易或其他合约操作');
  const canonical = ELEMENT_INTERFACE.encodeFunctionData(decoded.fragment, decoded.args);
  if (canonical.toLowerCase() !== transaction.data.toLowerCase()) fail('UNSUPPORTED_ENCODING', '成交数据包含未验证的扩展编码');
  const order = plainOrder(decoded.args[0]), sig = decoded.args[1];
  const standard = position.standard, nft = standard === 'ERC721' ? order.nft : order.erc1155Token;
  const tokenId = standard === 'ERC721' ? order.nftId : order.erc1155TokenId;
  const properties = standard === 'ERC721' ? order.nftProperties : order.erc1155TokenProperties;
  const actualId = decoded.args[2].toString(), quantity = standard === 'ERC721' ? '1' : decoded.args[3].toString();
  const unwrap = standard === 'ERC721' ? decoded.args[3] : decoded.args[4];
  const callback = standard === 'ERC721' ? decoded.args[4] : decoded.args[5];
  if (callback !== '0x' || properties?.length !== 0) fail('UNSUPPORTED_ORDER', '暂不支持回调、系列买单或属性买单');
  if (!equalAddress(nft, position.addr) || String(tokenId) !== position.tokenId || actualId !== position.tokenId || quantity !== position.quantity) fail('BINDING_MISMATCH', '成交 NFT 或数量与规则不一致');
  if (equalAddress(order.maker, ZERO_ADDRESS) || equalAddress(order.maker, position.walletAddress) || (!equalAddress(order.taker, ZERO_ADDRESS) && !equalAddress(order.taker, position.walletAddress)) || !equalAddress(order.erc20Token, WBNB)) fail('UNSUPPORTED_ORDER', '仅允许向有效 WBNB 买单出售当前 NFT');
  if (standard === 'ERC1155' && String(order.erc1155TokenAmount) !== quantity) fail('UNSUPPORTED_ORDER', '暂不支持 ERC1155 部分成交');
  if (Number(sig.signatureType) !== 0) fail('UNSUPPORTED_SIGNATURE', '暂不支持批量签名或合约钱包买单');
  const expiry = unpackElementExpiry(order.expiry), seconds = Math.floor(now / 1000);
  if (expiry.listingTime > seconds || expiry.expirationTime <= seconds) fail('EXPIRED_QUOTE', '买单尚未生效或已过期');
  if (!Array.isArray(order.fees) || order.fees.length > 10 || order.fees.some(f => f.feeData !== '0x' || equalAddress(f.recipient, ZERO_ADDRESS))) fail('UNSUPPORTED_FEES', '买单费用包含未知回调或收款地址');
  const net = uint(order.erc20TokenAmount, '净收入');
  if (!net) fail('INVALID_AMOUNT', '买单净收入必须大于零');
  const fees = order.fees.reduce((sum, f) => sum + uint(f.amount, '市场费用'), 0n);
  const signature = Signature.from({ v: Number(sig.v), r: sig.r, s: sig.s }).serialized;
  return { order, signature, expiry, unwrap, currency: unwrap ? 'BNB' : 'WBNB', netWei: net.toString(), marketFeesWei: fees.toString(), grossWei: (net + fees).toString(), transaction: { to: ELEMENT_EX, data: transaction.data, value: '0' } };
}

export function createElementTrading({ getApiKey = () => '', fetchImpl = fetch, rpc = nftRpc, now = Date.now } = {}) {
  const statusCursors=new Map();
  const call = async (to, iface, name, args = []) => {
    const data = await rpc('eth_call', [{ to, data: iface.encodeFunctionData(name, args) }, 'latest']);
    try { return iface.decodeFunctionResult(name, data); } catch { fail('INVALID_RPC_RESULT', '链上核验返回无效数据'); }
  };
  const chain = async () => { if (BigInt(await rpc('eth_chainId', [])) !== 56n) fail('CHAIN_MISMATCH', 'NFT 交易仅支持 BSC 主网'); };
  const key = async () => { const value = await getApiKey(); if (typeof value !== 'string' || !value.trim()) fail('ELEMENT_API_KEY_REQUIRED', '需要配置 Element API Key 才能获取可执行买单或发布挂单'); return value.trim(); };
  async function api(path, body, suppliedKey) {
    const apiKey = suppliedKey ?? await key(); let response;
    try {
      response = await fetchImpl(ELEMENT_API + path, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', 'X-Api-Key': apiKey }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10000), redirect: 'error', credentials: 'omit' });
      if (!response.ok) fail('ELEMENT_HTTP_ERROR', `Element API 请求失败（HTTP ${response.status}）`);
      const length = Number(response.headers?.get?.('content-length') || 0); if (length > MAX_RESPONSE) fail('ELEMENT_RESPONSE_TOO_LARGE', 'Element API 响应过大');
      let raw = '';
      if (response.body?.getReader) {
        const reader = response.body.getReader(), decoder = new TextDecoder(); let bytes = 0;
        try { while (true) { const { done, value } = await reader.read(); if (done) break; bytes += value.byteLength; if (bytes > MAX_RESPONSE) { await reader.cancel(); fail('ELEMENT_RESPONSE_TOO_LARGE', 'Element API 响应过大'); } raw += decoder.decode(value, { stream: true }); } raw += decoder.decode(); }
        finally { reader.releaseLock(); }
      } else raw = await response.text();
      if (Buffer.byteLength(raw) > MAX_RESPONSE) fail('ELEMENT_RESPONSE_TOO_LARGE', 'Element API 响应过大');
      let json; try { json = JSON.parse(raw); } catch { fail('ELEMENT_INVALID_RESPONSE', 'Element API 返回格式无效'); }
      if (json?.code !== 0 || !json.data || typeof json.data !== 'object') fail('ELEMENT_API_ERROR', 'Element API 未返回有效结果');
      return json.data;
    } catch (error) { if (error.code?.startsWith('ELEMENT_')) throw error; fail('ELEMENT_UNAVAILABLE', 'Element API 无法连接或请求超时'); }
  }
  async function checkApiKey() {
    // This proves authenticated configuration access only. It neither reserves
    // an order nonce nor claims that a paid listing plan has been subscribed.
    const data = await api('/orders/confData?chain=bsc');
    if (Array.isArray(data) || !Object.hasOwn(data, 'oracleSignature') || data.oracleSignature !== 1) fail('ELEMENT_INVALID_CONFIGURATION', 'Element API Key 未通过当前 BSC 交易配置核验');
    return { valid: true, capabilities: { readConfiguration: true, oracleVerification: true } };
  }
  async function position(rule) {
    const p = binding(rule); await chain();
    const all = async () => { try { return Boolean((await call(p.addr, NFT_INTERFACE, 'isApprovedForAll', [p.walletAddress, ELEMENT_EX]))[0]); } catch { return false; } };
    let owned, approved;
    if (p.standard === 'ERC721') {
      const [owner] = await call(p.addr, NFT_INTERFACE, 'ownerOf', [p.tokenId]); owned = equalAddress(owner, p.walletAddress);
      let approvedOne = false; try { approvedOne = equalAddress((await call(p.addr, NFT_INTERFACE, 'getApproved', [p.tokenId]))[0], ELEMENT_EX); } catch {}
      approved = approvedOne || await all();
    } else { const [balance] = await call(p.addr, NFT_INTERFACE, 'balanceOf', [p.walletAddress, p.tokenId]); owned = balance >= BigInt(p.quantity); approved = await all(); }
    const approval = p.standard === 'ERC721'
      ? { to: p.addr, data: NFT_INTERFACE.encodeFunctionData('approve', [ELEMENT_EX, p.tokenId]), value: '0', scope: 'token', spender: ELEMENT_EX, tokenId: p.tokenId }
      : { to: p.addr, data: NFT_INTERFACE.encodeFunctionData('setApprovalForAll', [ELEMENT_EX, true]), value: '0', scope: 'collection', spender: ELEMENT_EX, requiresManualConfirmation: true };
    return { ...p, verifiedOwnership: owned, verifiedAt: now(), approved, approval };
  }
  function budget(rule, marketFees, gas) {
    const max = bnb(rule.maxFeesBnb, '费用上限');
    if (marketFees + gas > max) fail('FEES_EXCEEDED', '市场费用与预估 Gas 超出规则上限');
  }
  function validPosition(rule, p) {
    const b = assertBinding(rule, p);
    if (p.verifiedOwnership !== true || !Number.isFinite(p.verifiedAt) || now() - p.verifiedAt > 60000 || p.verifiedAt > now() + 1000) fail('OWNERSHIP_UNVERIFIED', 'NFT 归属未核验或核验已过期');
    return b;
  }
  async function feeQuote(rule, p) {
    const apiKey = await key(), b = validPosition(rule, p);
    const gross = bnb(rule.listingUnitPriceBnb, '挂单单价', { positive: true }) * BigInt(b.quantity);
    if (gross > MAX_UINT) fail('INVALID_AMOUNT', '挂单总价超出范围');
    const data = await api('/collection/fee', { chain: 'bsc', data: [{ contractAddress: b.addr }] }, apiKey);
    const rows = data.feeList?.filter(row => equalAddress(row.contractAddress, b.addr));
    if (!Array.isArray(rows) || rows.length !== 1) fail('FEES_UNVERIFIED', 'Element 未返回此系列唯一有效的费用');
    const item = rows[0], fees = [];
    if (item.market !== undefined && item.market !== 'element' || item.standard !== undefined && item.standard !== 'element-ex-v3') fail('FEES_UNVERIFIED','费用并非当前 Element v3 市场');
    for (const prefix of ['protocol', 'royalty']) {
      const points = item[`${prefix}FeePoints`], recipient = item[`${prefix}FeeAddress`];
      if (!Number.isInteger(points) || points < 0 || points > 10000 || !/^0x[0-9a-f]{40}$/i.test(recipient ?? '') || (points > 0 && equalAddress(recipient, ZERO_ADDRESS))) fail('FEES_UNVERIFIED', 'Element 系列费用不完整或无效');
      if (points > 0) fees.push({ recipient: address(recipient), amount: (gross * BigInt(points) / 10000n).toString(), feeData: '0x' });
    }
    const total = fees.reduce((sum, f) => sum + BigInt(f.amount), 0n);
    if (total >= gross) fail('INVALID_FEES', '费用不能达到或超过挂单收入'); budget(rule, total, 0n);
    return { ...b, source: 'listing-fees', currency: 'BNB', quoteId: randomUUID(), verifiedOwnership: true, verifiedAt: p.verifiedAt, grossWei: gross.toString(), feesWei: total.toString(), marketFeesWei: total.toString(), gasWei: '0', netWei: (gross - total).toString(), expiresAt: now() + 60000, context: { fees, approved: p.approved, basePriceConvention: 'official-sdk-gross', apiDocumentationConflict: true } };
  }
  async function offerQuote(rule, p) {
    const apiKey = await key(), b = validPosition(rule, p); await chain();
    const params = new URLSearchParams({ chain: 'bsc', asset_contract_address: b.addr, token_ids: b.tokenId, side: '0', sale_kind: '0', payment_token: WBNB, order_by: 'base_price', direction: 'desc', limit: '50' });
    const data = await api('/orders/list?' + params, undefined, apiKey);
    if (!Array.isArray(data.orders)) fail('ELEMENT_INVALID_RESPONSE', 'Element 买单列表格式无效');
    if (!data.orders.length) fail('NO_EXECUTABLE_OFFER', '当前没有可执行的 WBNB 单品买单');
    const candidates = [];
    // Bound API work; invalid or stale top orders never become executable quotes.
    for (const row of data.orders.slice(0, 5)) {
      try {
        if (!row || String(row.side) !== '0' || String(row.saleKind) !== '0' || !equalAddress(row.exchange, ELEMENT_EX) || !equalAddress(row.assetContract, b.addr) || String(row.assetTokenId) !== b.tokenId || row.schema !== b.standard || !equalAddress(row.paymentToken, WBNB) || !/^[a-zA-Z0-9_-]{1,128}$/.test(row.orderId ?? '')) continue;
        if (!Number.isSafeInteger(Number(b.quantity))) continue;
        const encoded = await api('/orders/encodeTradeDataByOrderId', { chain: 'bsc', taker: b.walletAddress, orderIdList: [{ orderId: String(row.orderId), takeCount: Number(b.quantity), tokenId: b.tokenId }] }, apiKey);
        if (!Array.isArray(encoded.flags) || encoded.flags.length !== 1 || encoded.flags[0] !== true) fail('UNENCODED_ORDER', 'Element 未成功编码此买单');
        const offer = decodeElementOfferTransaction(encoded, b, { now: now() });
        const hashNonce = (await call(ELEMENT_EX, ELEMENT_INTERFACE, 'getHashNonce', [offer.order.maker]))[0].toString();
        const typedData = elementTypedData({ ...offer.order, hashNonce }, b.standard, 'buy');
        const hash = TypedDataEncoder.hash(typedData.domain, typedData.types, typedData.message);
        if (!/^0x[0-9a-f]{64}$/i.test(row.hash ?? '') || hash.toLowerCase() !== row.hash.toLowerCase() || !equalAddress(verifyTypedData(typedData.domain, typedData.types, typedData.message, offer.signature), offer.order.maker)) fail('INVALID_ORDER_SIGNATURE', '买单签名或订单哈希不匹配');
        const hashName = b.standard === 'ERC721' ? 'getERC721BuyOrderHash' : 'getERC1155BuyOrderHash';
        const [chainHash] = await call(ELEMENT_EX, ELEMENT_INTERFACE, hashName, [offer.order]);
        if (String(chainHash).toLowerCase() !== hash.toLowerCase()) fail('INVALID_ORDER_HASH', '链上买单哈希不匹配');
        const amount = BigInt(offer.grossWei), fee = BigInt(offer.marketFeesWei);
        if (!equalAddress(row.maker, offer.order.maker) || String(row.nonce) !== offer.order.nonce || String(row.hashNonce) !== hashNonce || (String(row.basePrice) !== amount.toString() && String(row.basePrice) !== offer.netWei) || String(row.quantity) !== b.quantity || Number(row.listingTime) !== offer.expiry.listingTime || Number(row.expirationTime) !== offer.expiry.expirationTime) fail('ORDER_MISMATCH', '订单详情与实际成交编码不一致');
        const [balance] = await call(WBNB, TOKEN_INTERFACE, 'balanceOf', [offer.order.maker]);
        const [allowance] = await call(WBNB, TOKEN_INTERFACE, 'allowance', [offer.order.maker, ELEMENT_EX]);
        if (balance < amount || allowance < amount) fail('INSUFFICIENT_BID', '买方余额或授权不足');
        // Current nonce/order status and full eth_call are independent checks.
        const statusName = b.standard === 'ERC721' ? 'getERC721BuyOrderStatus' : 'getERC1155BuyOrderInfo';
        const status = await call(ELEMENT_EX, ELEMENT_INTERFACE, statusName, [offer.order]);
        const statusCode = b.standard === 'ERC721' ? Number(status[0]) : Number(status[0].status);
        if (statusCode !== 1 || (b.standard === 'ERC1155' && BigInt(status[0].remainingAmount) < BigInt(b.quantity))) fail('ORDER_UNAVAILABLE', '买单已成交、取消或不可执行');
        const tx = { from: b.walletAddress, ...offer.transaction };
        await rpc('eth_call', [tx, 'latest']);
        const gasLimit = rpcUint(await rpc('eth_estimateGas', [tx]), 'Gas');
        const gasPrice = rpcUint(await rpc('eth_gasPrice', []), 'Gas 价格');
        const gas = (gasLimit * gasPrice * 120n + 99n) / 100n;
        budget(rule, fee, gas);
        const net = BigInt(offer.netWei) - gas;
        if (net <= 0n) fail('NO_NET_PROCEEDS', '扣除 Gas 后没有正净收入');
        candidates.push({ ...b, source: 'executable-offer', currency: offer.currency, quoteId: randomUUID(), orderId: String(row.orderId), hash, verifiedOwnership: true, verifiedAt: p.verifiedAt, grossWei: offer.grossWei, marketFeesWei: fee.toString(), gasWei: gas.toString(), feesWei: (fee + gas).toString(), netWei: net.toString(), expiresAt: Math.min(now() + 30000, offer.expiry.expirationTime * 1000), context: { transaction: offer.transaction, order: offer.order, typedData, hash, signature: offer.signature, gasLimit: gasLimit.toString(), gasPrice: gasPrice.toString(), proceedsWei: offer.netWei, unwrap: offer.unwrap } });
      } catch (error) { if (error.code === 'ELEMENT_API_KEY_REQUIRED') throw error; }
    }
    if (!candidates.length) fail('NO_EXECUTABLE_OFFER', '没有通过签名、资产、资金、费用和链上模拟核验的单品买单；聚合及扩展编码暂不支持');
    candidates.sort((a,b) => BigInt(a.netWei) > BigInt(b.netWei) ? -1 : BigInt(a.netWei) < BigInt(b.netWei) ? 1 : 0);
    return candidates[0];
  }
  async function quote(rule, p) { return rule.mode === 'fixed-listing' ? feeQuote(rule, p) : ['take-profit-offer','trailing-offer'].includes(rule.mode) ? offerQuote(rule, p) : fail('INVALID_MODE', '未知 NFT 卖出规则'); }
  async function buildListing(rule, quote) {
    const b = assertBinding(rule, quote), apiKey = await key();
    if (rule.mode !== 'fixed-listing' || quote.source !== 'listing-fees' || !quote.context || !Array.isArray(quote.context.fees) || quote.expiresAt <= now()) fail('EXPIRED_QUOTE', '挂单费用报价无效或已过期');
    const p = await position(rule); if (!p.verifiedOwnership || !p.approved) fail('APPROVAL_REQUIRED', '挂单前必须确认当前 NFT 归属及 Element 授权');
    const gross = bnb(rule.listingUnitPriceBnb, '挂单单价', { positive: true }) * BigInt(b.quantity);
    if (gross.toString() !== quote.grossWei) fail('BINDING_MISMATCH', '挂单价格已变更，请重新报价');
    const fees = quote.context.fees.map(f => ({ recipient: address(f.recipient), amount: uint(f.amount).toString(), feeData: f.feeData }));
    if (fees.length > 10 || fees.some(f => f.feeData !== '0x' || equalAddress(f.recipient, ZERO_ADDRESS))) fail('INVALID_FEES', '挂单费用无效');
    const total = fees.reduce((s,f) => s+BigInt(f.amount),0n); if (total >= gross || total.toString() !== quote.feesWei) fail('INVALID_FEES', '挂单费用报价不一致'); budget(rule,total,0n);
    const seconds = Math.floor(now()/1000), duration = Number(rule.expirySec);
    if (!Number.isSafeInteger(duration) || duration < 60 || duration > 7890047) fail('INVALID_EXPIRY', '挂单有效期必须在 1 分钟至 3 个月内');
    const listingTime = seconds-60, expirationTime = seconds+duration;
    const params = new URLSearchParams({ chain:'bsc',maker:b.walletAddress,schema:b.standard.toLowerCase(),count:'1' });
    const nonceData = await api('/orders/nonce?'+params, undefined, apiKey), config = await api('/orders/confData?chain=bsc', undefined, apiKey);
    if (config.oracleSignature !== 1) fail('ORACLE_CONFIGURATION', 'Element 未返回当前支持的 oracle 验证模式');
    const nonce = uint(nonceData.nonce, '订单 nonce').toString(), expiry = packElementExpiry(listingTime,expirationTime,1);
    const hashNonce = (await call(ELEMENT_EX,ELEMENT_INTERFACE,'getHashNonce',[b.walletAddress]))[0].toString();
    const order = { maker:b.walletAddress,taker:ZERO_ADDRESS,expiry,nonce,erc20Token:NATIVE_TOKEN,erc20TokenAmount:(gross-total).toString(),fees,...(b.standard==='ERC721'?{nft:b.addr,nftId:b.tokenId}:{erc1155Token:b.addr,erc1155TokenId:b.tokenId,erc1155TokenAmount:b.quantity}),hashNonce };
    const typedData = elementTypedData(order,b.standard),hash = TypedDataEncoder.hash(typedData.domain,typedData.types,typedData.message);
    const [chainHash] = await call(ELEMENT_EX,ELEMENT_INTERFACE,b.standard==='ERC721'?'getERC721SellOrderHash':'getERC1155SellOrderHash',[order]);
    if (String(chainHash).toLowerCase() !== hash.toLowerCase()) fail('INVALID_ORDER_HASH', '挂单签名结构未通过当前链上哈希核验');
    const request = listingRequest(b,order,hash,{listingTime,expirationTime},gross.toString());
    return { ...b,typedData,hash,order,request,nonce,expiry,listingTime,expirationTime,grossWei:gross.toString(),feesWei:total.toString(),netWei:(gross-total).toString(),expiresAt:quote.expiresAt,basePriceConvention:'official-sdk-gross',apiDocumentationConflict:true };
  }
  async function publishListing(plan, signature) {
    const apiKey = await key();
    validateElementListingPlan(plan);
    if (!Number.isFinite(plan.expiresAt) || plan.expiresAt <= now()) fail('INVALID_PLAN', '挂单计划已过期或被修改');
    let sig; try { sig = Signature.from(signature); if (!equalAddress(verifyTypedData(plan.typedData.domain,plan.typedData.types,plan.typedData.message,sig.serialized),plan.walletAddress)) fail('INVALID_SIGNATURE','挂单签名钱包不匹配'); } catch { fail('INVALID_SIGNATURE','挂单签名无效或钱包不匹配'); }
    const request = { ...plan.request,v:sig.v,r:sig.r,s:sig.s };
    let result;
    try { result = await api('/orders/post',request,apiKey); }
    catch (error) { return { status:'unverified',verified:false,submissionUnknown:true,hash:plan.hash,nonce:plan.nonce,reason:error.message }; }
    const equalFees = Array.isArray(result.fees) && JSON.stringify(result.fees.map(f=>({recipient:String(f.recipient).toLowerCase(),amount:String(f.amount),feeData:f.feeData})))===JSON.stringify(request.fees);
    const verified = /^[a-zA-Z0-9_-]{1,128}$/.test(result.orderId??'') && String(result.hash).toLowerCase()===plan.hash.toLowerCase() && equalAddress(result.exchange,ELEMENT_EX) && equalAddress(result.maker,plan.walletAddress) && equalAddress(result.taker,ZERO_ADDRESS) && String(result.side)==='1' && String(result.saleKind)==='0' && equalAddress(result.paymentToken,ZERO_ADDRESS) && String(result.basePrice)===request.basePrice && String(result.quantity)===plan.quantity && String(result.nonce)===plan.nonce && String(result.hashNonce)===request.hashNonce && equalAddress(result.assetContract,plan.addr) && String(result.assetTokenId)===plan.tokenId && result.schema===plan.standard && Number(result.listingTime)===plan.listingTime && Number(result.expirationTime)===plan.expirationTime && equalFees;
    return { status:verified?'listed':'unverified',verified,submissionUnknown:!verified,orderId:/^[a-zA-Z0-9_-]{1,128}$/.test(result.orderId??'')?String(result.orderId):null,hash:plan.hash,nonce:plan.nonce,...(!verified?{reason:'Element 已接收请求，但返回订单未完整匹配签名与经济字段；请人工核对，禁止自动重发'}:{}) };
  }
  async function orderStatus(state, rule) {
    const b = binding(rule), plan = state?.plan ?? state;
    if (!plan?.order || !plan.hash) return { status:'unknown',verified:false,reason:'缺少原始签名订单，不能确认成交或取消' };
    assertBinding(rule,plan); validateElementListingPlan(plan); await chain();
    const currentHashNonce = (await call(ELEMENT_EX,ELEMENT_INTERFACE,'getHashNonce',[b.walletAddress]))[0].toString();
    if (BigInt(currentHashNonce) > BigInt(plan.order.hashNonce)) return { status:'cancelled',verified:true,confirmed:true,hash:plan.hash,reason:'钱包订单 hashNonce 已更新' };
    if (currentHashNonce !== String(plan.order.hashNonce)) return { status:'unknown',verified:false,confirmed:false,hash:plan.hash,reason:'RPC hashNonce 落后于订单，请稍后重试' };
    const method=b.standard==='ERC721'?'getERC721SellOrderStatus':'getERC1155SellOrderInfo';
    const result=await call(ELEMENT_EX,ELEMENT_INTERFACE,method,[plan.order]);
    const code=b.standard==='ERC721'?Number(result[0]):Number(result[0].status);
    // Element OrderStatus: INVALID=0, FILLABLE=1, UNFILLABLE=2, EXPIRED=3.
    // UNFILLABLE conflates filled/cancelled: never invent a sale from this state.
    if (code===1) return {status:'listed',verified:true,confirmed:true,hash:plan.hash,...(b.standard==='ERC1155'?{remainingQuantity:result[0].remainingAmount.toString()}:{})};
    if (code===3) return {status:'expired',verified:true,confirmed:true,hash:plan.hash};
    // All event fields are unindexed in Element v3. Scan bounded ranges and
    // compare the decoded order hash; a transfer or deposit is not a fill.
    const filledName=b.standard==='ERC721'?'ERC721SellOrderFilled':'ERC1155SellOrderFilled',cancelName=b.standard==='ERC721'?'ERC721OrderCancelled':'ERC1155OrderCancelled';
    const head=Number(rpcUint(await rpc('eth_blockNumber',[]),'区块高度'));
    if(!Number.isSafeInteger(head)||head<0)fail('INVALID_RPC_RESULT','区块高度无效');
    const earliest=Number.isSafeInteger(state?.submittedBlock)&&state.submittedBlock>=0?state.submittedBlock:Math.max(0,head-2000);
    const saved=Number.isSafeInteger(state?.marketSearchBlock)&&state.marketSearchBlock>=0?state.marketSearchBlock:earliest;
    const start=Math.max(earliest,statusCursors.get(plan.hash)??saved),end=Math.min(head,start+999);
    if(start<=end){
      const logs=await rpc('eth_getLogs',[{address:ELEMENT_EX,fromBlock:'0x'+start.toString(16),toBlock:'0x'+end.toString(16),topics:[[ELEMENT_INTERFACE.getEvent(filledName).topicHash,ELEMENT_INTERFACE.getEvent(cancelName).topicHash]]}]);
      if(!Array.isArray(logs)||logs.length>10000)fail('INVALID_RPC_RESULT','订单事件查询结果过大或无效');
      for(const log of logs){
        if(log.removed || !equalAddress(log.address,ELEMENT_EX))continue;
        let e;try{e=ELEMENT_INTERFACE.parseLog(log);}catch{continue;}
        if(e?.name===cancelName && equalAddress(e.args.maker,b.walletAddress) && e.args.nonce.toString()===plan.nonce)return{status:'cancelled',confirmed:true,verified:true,hash:plan.hash,txHash:log.transactionHash};
        if(e?.name===filledName && String(e.args.orderHash).toLowerCase()===plan.hash.toLowerCase() && equalAddress(e.args.maker,b.walletAddress) && e.args.nonce.toString()===plan.nonce && /^0x[0-9a-f]{64}$/i.test(log.transactionHash??''))return{status:'filled',confirmed:false,hash:plan.hash,txHash:log.transactionHash};
      }
      statusCursors.set(plan.hash,end+1);
      if(statusCursors.size>2000)statusCursors.delete(statusCursors.keys().next().value);
    }
    return {status:'unavailable',verified:true,confirmed:false,hash:plan.hash,searchBlock:Math.max(start,end+1),proofCancelNonce:plan.nonce,reason:'订单不可成交；正在查找此订单的成交或取消事件'};
  }
  function cancelTransaction(state,rule) {
    const b=binding(rule),plan=state?.plan??state; assertBinding(rule,plan);
    validateElementListingPlan(plan);
    if (!plan.hash || !plan.order || plan.order.maker!==b.walletAddress || String(plan.order.nonce)!==String(plan.nonce)) fail('INVALID_PLAN','缺少已绑定的原始挂单，无法撤销');
    return {to:ELEMENT_EX,data:ELEMENT_INTERFACE.encodeFunctionData(b.standard==='ERC721'?'cancelERC721Order':'cancelERC1155Order',[uint(plan.nonce)]),value:'0',nonce:String(plan.nonce),hash:plan.hash};
  }
  function verifyFill(rule,state,receipt){
    try{
      const b=binding(rule),accept=state?.operation?.kind==='accept',q=state?.operation?.quote,plan=state?.plan;
      if(receipt?.status!=='0x1'||!Array.isArray(receipt.logs)||receipt.logs.length>10000||!/^0x[0-9a-f]{40}$/i.test(receipt.from??''))throw Error('交易凭证缺少成功状态或付款方');
      if(state?.txHash && !equalAddress(receipt.transactionHash,state.txHash))throw Error('成交凭证交易哈希不匹配');
      let o,hash,currency,side;
      if(accept){assertBinding(rule,q);o=q?.context?.order;hash=q?.context?.hash;currency=q.currency;side='Buy';if(!o||!hash)throw Error('缺少已绑定的买单');}
      else{assertBinding(rule,plan);validateElementListingPlan(plan);o=plan.order;hash=plan.hash;currency='BNB';side='Sell';}
      const expectedName=(b.standard==='ERC721'?'ERC721':'ERC1155')+side+'OrderFilled';
      const matches=[];
      for(const log of receipt.logs){if(log.removed||!equalAddress(log.address,ELEMENT_EX))continue;let e;try{e=ELEMENT_INTERFACE.parseLog(log);}catch{continue;}if(e?.name===expectedName&&String(e.args.orderHash).toLowerCase()===String(hash).toLowerCase())matches.push(e.args);}
      if(matches.length!==1)throw Error('缺少唯一匹配订单的 Element 成交事件');
      const e=matches[0],nft=b.standard==='ERC721'?e.erc721Token:e.erc1155Token,id=b.standard==='ERC721'?e.erc721TokenId:e.erc1155TokenId,quantity=b.standard==='ERC721'?'1':e.erc1155FillAmount.toString();
      if(!equalAddress(e.maker,o.maker)||e.nonce.toString()!==String(o.nonce)||!equalAddress(nft,b.addr)||id.toString()!==b.tokenId||quantity!==b.quantity||!equalAddress(e.erc20Token,o.erc20Token))throw Error('成交事件与订单资产、数量或支付币种不一致');
      if(accept?!equalAddress(e.taker,b.walletAddress):!equalAddress(e.maker,b.walletAddress)||equalAddress(e.taker,ZERO_ADDRESS)||equalAddress(e.taker,b.walletAddress))throw Error('成交事件买卖双方与钱包不一致');
      if(!equalAddress(o.taker,ZERO_ADDRESS)&&!equalAddress(e.taker,o.taker))throw Error('成交对手不符合指定订单');
      const fees=[...e.fees].map(f=>({recipient:address(f.recipient),amount:f.amount.toString()})),expectedFees=o.fees.map(f=>({recipient:address(f.recipient),amount:uint(f.amount).toString()}));
      if(canonical(fees)!==canonical(expectedFees))throw Error('实际市场费用与授权订单不一致');
      const marketFees=fees.reduce((s,f)=>s+BigInt(f.amount),0n),gross=b.standard==='ERC721'?e.erc20TokenAmount:e.erc20FillAmount,proceeds=uint(o.erc20TokenAmount);
      if(gross!==proceeds+marketFees)throw Error('成交付款金额与签名订单不一致');
      if(accept){
        if(!equalAddress(o.erc20Token,WBNB)||!['BNB','WBNB'].includes(currency)||Boolean(q.context.unwrap)!==(currency==='BNB'))throw Error('买单收入币种无法核验');
        // Revalidate the exact planned call to bind unwrap/callback semantics.
        const decoded=decodeElementOfferTransaction(q.context.transaction,b,{now:Math.min(now(),unpackElementExpiry(o.expiry).expirationTime*1000-1)});
        if(canonical(decoded.order)!==canonical(o))throw Error('买单成交编码与订单不一致');
      }else if(!equalAddress(o.erc20Token,NATIVE_TOKEN))throw Error('未知挂牌支付币种');
      if(receipt.gasUsed===undefined||receipt.effectiveGasPrice===undefined)throw Error('缺少实际 Gas 成本');
      const receiptUint=v=>typeof v==='string'&&/^0x[0-9a-f]+$/i.test(v)?rpcUint(v,'Gas'):uint(v,'Gas');
      const gas=equalAddress(receipt.from,b.walletAddress)?receiptUint(receipt.gasUsed)*receiptUint(receipt.effectiveGasPrice):0n;
      if(accept&&!equalAddress(receipt.from,b.walletAddress))throw Error('接买单交易发送钱包不匹配');
      if(proceeds<=gas)throw Error('成交扣除 Gas 后没有正净收入');
      const net=proceeds-gas;budget(rule,marketFees,gas);
      if(net<bnb(rule.minNetBnb,'保底净收入'))throw Error('实际成交净收入低于保底金额');
      return{confirmed:true,filledQuantity:quantity,netWei:net.toString(),currency,grossWei:gross.toString(),marketFeesWei:marketFees.toString(),gasWei:gas.toString()};
    }catch(error){return{confirmed:false,reason:error.code==='FEES_EXCEEDED'?error.message:String(error.message||'成交事件无法核验').slice(0,180)};}
  }
  return {checkApiKey,position,quote,buildListing,publishListing,orderStatus,cancelTransaction,verifyFill};
}
