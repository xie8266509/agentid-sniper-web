const READ_METHODS = new Set([
  'eth_blockNumber', 'eth_chainId', 'eth_call', 'eth_estimateGas', 'eth_gasPrice', 'eth_maxPriorityFeePerGas', 'eth_feeHistory',
  'eth_getBalance', 'eth_getCode', 'eth_getStorageAt', 'eth_getProof', 'eth_getTransactionCount', 'eth_getTransactionByHash',
  'eth_getTransactionByBlockHashAndIndex', 'eth_getTransactionByBlockNumberAndIndex', 'eth_getTransactionReceipt',
  'eth_getBlockByNumber', 'eth_getBlockByHash', 'eth_getBlockReceipts', 'eth_getBlockTransactionCountByHash', 'eth_getBlockTransactionCountByNumber',
  'eth_getUncleByBlockHashAndIndex', 'eth_getUncleByBlockNumberAndIndex', 'eth_getUncleCountByBlockHash', 'eth_getUncleCountByBlockNumber',
  'eth_getLogs', 'eth_syncing', 'eth_accounts', 'net_version', 'net_listening', 'net_peerCount', 'web3_clientVersion', 'web3_sha3',
]);
const own = (value, key) => Object.hasOwn(value, key);
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const defaultSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export class RpcUnavailableError extends Error {
  constructor(message = 'RPC 暂时不可用，请稍后重试', { retryAfterMs = 0, nextRetryAt = null, reason = 'unavailable' } = {}) {
    super(message); this.name = 'RpcUnavailableError'; this.code = 'RPC_UNAVAILABLE';
    this.retryAfterMs = retryAfterMs; this.nextRetryAt = nextRetryAt; this.reason = reason;
  }
}

function checkedCalls(calls) {
  return calls.map(call => {
    if (!record(call) || !READ_METHODS.has(call.method)) throw Object.assign(new Error('仅允许已支持的只读 RPC 方法'), { code: 'RPC_METHOD_NOT_ALLOWED' });
    const params = call.params ?? [];
    if (!Array.isArray(params)) throw new TypeError('RPC params 必须为数组');
    // Snapshot inputs before queueing; object key order does not split a flight.
    let serialized;
    try { serialized = JSON.stringify(params, (_key, value) => {
      if (typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'undefined' || typeof value === 'number' && !Number.isFinite(value)) throw new TypeError();
      return record(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value;
    }); } catch { throw new TypeError('RPC params 必须是有效 JSON'); }
    return { method: call.method, params: JSON.parse(serialized) };
  });
}

export function createRpcClient({ urls, fetchImpl = globalThis.fetch, now = Date.now, sleep = defaultSleep, random = Math.random,
  maxConcurrent = 3, maxPending = 256, minIntervalMs = 250, timeoutMs = 12000, cooldownBaseMs = 10000, cooldownMaxMs = 120000,
  networkCooldownMs = 3000, expectedChainId, chainCheckTtlMs = 300000 } = {}) {
  if (!Array.isArray(urls) || !urls.length || typeof fetchImpl !== 'function' || typeof now !== 'function' || typeof sleep !== 'function' || typeof random !== 'function') throw new TypeError('RPC 客户端配置无效');
  for (const value of [maxConcurrent, maxPending]) if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('RPC 队列限制无效');
  for (const value of [minIntervalMs, cooldownBaseMs, cooldownMaxMs, networkCooldownMs, chainCheckTtlMs]) if (!Number.isFinite(value) || value < 0) throw new TypeError('RPC 时间设置无效');
  if (cooldownMaxMs < cooldownBaseMs) throw new TypeError('RPC 冷却设置无效');
  const checkTimeout = value => { if (!Number.isSafeInteger(value) || value < 1 || value > 300000) throw new TypeError('RPC 超时时间无效'); return value; };
  checkTimeout(timeoutMs);
  let chain;
  try { if (expectedChainId !== undefined) { if (!['number', 'string', 'bigint'].includes(typeof expectedChainId) || typeof expectedChainId === 'number' && !Number.isSafeInteger(expectedChainId)) throw new Error(); chain = BigInt(expectedChainId); if (chain < 1n) throw new Error(); } } catch { throw new TypeError('RPC 链 ID 无效'); }
  const endpoints = [], groups = new Map(), seenUrls = new Set(), secrets = new Set();
  for (const value of urls) {
    let url;
    try { url = new URL(value); if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error(); } catch { throw new TypeError('RPC 节点配置无效'); }
    if (seenUrls.has(url.href)) continue;
    seenUrls.add(url.href);
    for (const secret of [url.username, url.password, ...url.searchParams.values(), ...url.pathname.split('/').filter(part => part.length >= 16)]) if (secret) secrets.add(secret);
    const index = endpoints.length, publicNode = ['bsc.publicnode.com', 'bsc-rpc.publicnode.com'].includes(url.hostname.toLowerCase());
    const group = publicNode ? 'publicnode' : `node-${index + 1}`, label = publicNode ? 'PublicNode' : `node ${index + 1}`;
    if (!groups.has(group)) groups.set(group, { until: 0, failures: 0, reason: null });
    endpoints.push({ url: url.href, id: `node-${index + 1}`, group, label });
  }
  const flights = new Map(), queue = [], proofs = new Map(), proofFlights = new Map();
  let active = 0, networkActive = 0, cursor = 0, nextAttemptAt = 0, attemptTail = Promise.resolve();
  const clean = value => {
    let text = String(value || '合约执行失败');
    for (const endpoint of endpoints) text = text.split(endpoint.url).join(`[${endpoint.label}]`);
    for (const secret of secrets) text = text.split(secret).join('[已隐藏]');
    return text.replace(/https?:\/\/[^\s"'<>]+/gi, '[RPC endpoint]').replace(/\bBearer\s+[^\s,;"']+/gi, 'Bearer [已隐藏]')
      .replace(/((?:api[-_]?key|token|secret|password|authorization|cookie|clientId|sessionId)["']?\s*[=:]\s*["']?)[^\s,;"'}]+/gi, '$1[已隐藏]')
      .replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 320);
  };
  const remoteError = (endpoint, error) => {
    const code = Number.isFinite(error?.code) ? error.code : null, message = String(error?.message || '');
    const contract = code === 3 || /revert|invalid opcode|out of gas/i.test(message);
    const capability = !contract && ([-32601, -32602].includes(code) || /address.{0,30}(?:required|mandatory)|(?:require|specify).{0,30}address|block.{0,20}range|range.{0,30}(?:large|restrict|limit)|method.{0,30}(?:not found|not available|not supported|unsupported)/i.test(message));
    const limited = !contract && !capability && (code === -32005 || /limit|quota|too many requests/i.test(message));
    const result = Object.assign(new Error(contract ? `${endpoint.label} 合约调用失败：${clean(message)}` : `${endpoint.label} ${capability ? '不支持此 RPC 查询范围或方法' : limited ? '请求受限，稍后重试' : 'RPC 查询失败'}`), { rpcCode: code, provider: endpoint.label, retryAfterMs: 0 });
    if (contract) { result.contract = true; result.code = 'RPC_CONTRACT_REVERT'; }
    if (capability) result.capability = true;
    return { kind: contract ? 'contract' : limited ? 'limited' : 'remote', error: result };
  };
  const retryAfter = response => {
    const value = response?.headers?.get?.('retry-after');
    if (value == null || String(value).trim() === '') return 0;
    if (/^\d+(?:\.\d+)?$/.test(String(value).trim())) return Math.ceil(Number(value) * 1000);
    const date = Date.parse(value); return Number.isFinite(date) ? Math.max(0, date - now()) : 0;
  };
  const cool = (endpoint, kind, retryMs = 0) => {
    const group = groups.get(endpoint.group);
    let duration = networkCooldownMs;
    if (kind === 'limited') {
      group.failures++;
      const backoff = Math.min(cooldownMaxMs, cooldownBaseMs * 2 ** Math.min(30, group.failures - 1));
      const jitter = Math.max(0, Math.min(1, Number(random()) || 0));
      duration = Math.min(cooldownMaxMs, Math.ceil(backoff * (1 + jitter * 0.1)));
    } else if (kind === 'wrong-chain') duration = cooldownMaxMs;
    group.until = Math.max(group.until, now() + Math.max(duration, retryMs)); group.reason = kind;
    for (const node of endpoints) if (node.group === endpoint.group) proofs.delete(node.id);
  };
  const unavailable = (reason = 'cooldown') => {
    const future = [...groups.values()].map(group => group.until).filter(until => until > now());
    const wait = future.length ? Math.max(1, Math.ceil(Math.min(...future) - now())) : Math.max(1, minIntervalMs);
    return new RpcUnavailableError(reason === 'queue-full' ? 'RPC 查询排队已满，请稍后重试' : 'RPC 节点暂时不可用，请稍后重试', { retryAfterMs: wait, nextRetryAt: now() + wait, reason });
  };
  const available = () => endpoints.some(endpoint => groups.get(endpoint.group).until <= now());
  async function attempt(endpoint, payload, batch, attemptTimeout) {
    const previous = attemptTail; let release;
    attemptTail = new Promise(resolve => { release = resolve; });
    let unlocked = false, started = false;
    const unlock = () => { if (!unlocked) { unlocked = true; release(); } };
    let response, data, timer;
    const controller = new AbortController();
    try {
      await previous;
      const wait = nextAttemptAt - now(); if (wait > 0) await sleep(wait);
      if (groups.get(endpoint.group).until > now()) return { kind: 'cooling' };
      nextAttemptAt = now() + minIntervalMs;
      networkActive++; started = true;
      const timedOut = new Promise((_resolve, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('RPC timeout')); }, attemptTimeout); });
      const work = async () => {
        response = await fetchImpl(endpoint.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: controller.signal });
        if (response?.status === 429) return;
        if (response?.ok === false || response?.status >= 400 || typeof response?.json !== 'function') throw new Error('RPC HTTP failure');
        data = await response.json();
      };
      const pending = Promise.race([work(), timedOut]);
      unlock(); await pending;
    } catch {
      cool(endpoint, 'network', retryAfter(response)); return { kind: 'network' };
    } finally { unlock(); clearTimeout(timer); if (started) networkActive--; }
    if (response.status === 429) { cool(endpoint, 'limited', retryAfter(response)); return { kind: 'limited' }; }
    const invalid = () => { cool(endpoint, 'invalid-response'); return { kind: 'network' }; };
    const parse = (entry, id) => {
      if (!record(entry) || own(entry, 'jsonrpc') && entry.jsonrpc !== '2.0' || own(entry, 'id') && entry.id !== id || own(entry, 'error') === own(entry, 'result')) return null;
      if (own(entry, 'error')) return record(entry.error) ? remoteError(endpoint, entry.error) : null;
      return entry.result === undefined ? null : { kind: 'success', result: entry.result };
    };
    if (!batch) {
      const parsed = parse(data, payload.id); if (!parsed) return invalid();
      if (parsed.kind === 'limited') cool(endpoint, 'limited', retryAfter(response));
      if (parsed.kind === 'success') { const group = groups.get(endpoint.group); group.failures = 0; }
      return parsed;
    }
    if (!Array.isArray(data) || !data.length) return invalid();
    const ids = new Set(), result = new Array(payload.length), errors = [];
    let successes = 0, limited = false;
    for (const entry of data) {
      if (!record(entry) || !Number.isSafeInteger(entry.id) || entry.id < 0 || entry.id >= payload.length || ids.has(entry.id)) return invalid();
      ids.add(entry.id);
      const parsed = parse(entry, entry.id); if (!parsed) return invalid();
      if (parsed.kind === 'success') { result[entry.id] = parsed.result; successes++; }
      else { errors.push(parsed); if (parsed.kind === 'limited') limited = true; }
    }
    if (limited) cool(endpoint, 'limited', retryAfter(response));
    if (successes) { if (!limited) groups.get(endpoint.group).failures = 0; return { kind: 'success', result }; }
    if (errors.length === payload.length && errors.every(error => error.kind === 'contract')) return errors[0];
    if (limited) return { kind: 'limited' };
    return errors.find(error => error.error?.capability) || errors.find(error => error.kind === 'remote') || invalid();
  }
  const matchesChain = value => { try { return typeof value === 'string' && value.length <= 66 && /^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value) && BigInt(value) === chain; } catch { return false; } };
  async function ensureChain(endpoint, attemptTimeout, force = false) {
    if (chain === undefined || !force && proofs.get(endpoint.id) > now()) return { kind: 'success' };
    if (proofFlights.has(endpoint.id)) return proofFlights.get(endpoint.id);
    const flight = (async () => {
      const result = await attempt(endpoint, { jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }, false, attemptTimeout);
      if (result.kind !== 'success') return result;
      if (!matchesChain(result.result)) { cool(endpoint, 'wrong-chain'); return { kind: 'wrong-chain' }; }
      proofs.set(endpoint.id, now() + chainCheckTtlMs); return result;
    })();
    proofFlights.set(endpoint.id, flight);
    try { return await flight; } finally { if (proofFlights.get(endpoint.id) === flight) proofFlights.delete(endpoint.id); }
  }
  async function execute(calls, batch, attemptTimeout, order) {
    const payload = batch ? calls.map((call, id) => ({ jsonrpc: '2.0', id, ...call })) : { jsonrpc: '2.0', id: 1, ...calls[0] };
    const tried = new Set(), errors = [];
    for (const endpoint of order) {
      if (tried.has(endpoint.group) || groups.get(endpoint.group).until > now()) continue;
      tried.add(endpoint.group);
      const chainRequest = !batch && calls[0].method === 'eth_chainId';
      const checkedChainRequest = chainRequest && chain !== undefined;
      let result = await ensureChain(endpoint, attemptTimeout, checkedChainRequest);
      if (result.kind === 'success' && !checkedChainRequest) result = await attempt(endpoint, payload, batch, attemptTimeout);
      if (result.kind === 'success' && chainRequest && chain !== undefined) {
        if (!matchesChain(result.result)) { cool(endpoint, 'wrong-chain'); result = { kind: 'wrong-chain' }; }
        else proofs.set(endpoint.id, now() + chainCheckTtlMs);
      }
      if (result.kind === 'success') return result.result;
      if (result.kind === 'contract') throw result.error;
      if (result.error) errors.push(result.error);
    }
    // Capability failures leave the endpoint available for another read method.
    if (available() && errors.length) throw errors.find(error => error.capability) || errors.at(-1);
    throw unavailable(available() ? 'unavailable' : 'cooldown');
  }
  function enqueue(calls, batch, attemptTimeout) {
    const key = JSON.stringify([batch ? 'batch' : 'request', calls]);
    if (flights.has(key)) return flights.get(key);
    if (!available()) return Promise.reject(unavailable());
    if (active >= maxConcurrent && queue.length >= maxPending) return Promise.reject(unavailable('queue-full'));
    const order = endpoints.slice(cursor).concat(endpoints.slice(0, cursor)); cursor = (cursor + 1) % endpoints.length;
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    flights.set(key, promise);
    const run = async () => {
      active++;
      try { resolve(await execute(calls, batch, attemptTimeout, order)); } catch (error) { reject(error); }
      finally { active--; if (flights.get(key) === promise) flights.delete(key); queue.shift()?.(); }
    };
    if (active < maxConcurrent) void run(); else queue.push(run);
    return promise;
  }
  return {
    request(method, params = [], options = {}) {
      try { return enqueue(checkedCalls([{ method, params }]), false, checkTimeout(options.timeoutMs ?? timeoutMs)); } catch (error) { return Promise.reject(error); }
    },
    batch(calls, options = {}) {
      try { if (!Array.isArray(calls)) throw new TypeError('RPC batch 必须为数组'); const checked = checkedCalls(calls); return checked.length ? enqueue(checked, true, checkTimeout(options.timeoutMs ?? timeoutMs)) : Promise.resolve([]); } catch (error) { return Promise.reject(error); }
    },
    getStatus() {
      return { active, networkActive, queued: queue.length, inFlight: flights.size, providers: endpoints.map(endpoint => {
        const group = groups.get(endpoint.group), cooldownMs = Math.max(0, group.until - now());
        return { id: endpoint.id, provider: endpoint.label, group: endpoint.group, cooldownMs, nextRetryAt: cooldownMs ? group.until : null, failures: group.failures, reason: cooldownMs ? group.reason : null, chainVerified: chain !== undefined && proofs.get(endpoint.id) > now() };
      }) };
    },
  };
}
