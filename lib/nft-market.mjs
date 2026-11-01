// Read-only public marketplace reference data. A listing floor is never a bid.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

const MAX_HTML_BYTES = 4 * 1024 * 1024;
const ADDRESS = /^0x[a-fA-F0-9]{40}$/;
const SLUG = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/;
const STATUSES = new Set(['available', 'no_data', 'error']);
const ORIGIN = 'https://element.market';

function addressOf(value) {
  return typeof value === 'string' && ADDRESS.test(value) && !/^0x0{40}$/i.test(value) ? value.toLowerCase() : null;
}
function idOf(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) return null;
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value);
  if (!/^\d{1,78}$/.test(text)) return null;
  const id = BigInt(text);
  return id < 1n << 256n ? id.toString() : null;
}
function amountOf(value, positive = false) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const text = String(value);
  if (text.length > 120 || !/^\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(text)) return null;
  const amount = Number(text);
  return Number.isFinite(amount) && (positive ? amount > 0 : amount >= 0) ? text : null;
}
function currencyOf(coin) {
  if (!coin || typeof coin !== 'object' || Array.isArray(coin)) return null;
  if (coin.chain !== undefined && coin.chain !== 'bsc') return null;
  if (coin.chainId !== undefined && !isBscId(coin.chainId)) return null;
  const name = coin.name;
  return typeof name === 'string' && name.length > 0 && name.length <= 40 && !/[\u0000-\u001f\u007f<>]/.test(name) ? name : null;
}
function isBscId(value) { return value === 56 || value === '56' || value === '0x38'; }
const assetUrlFor = (address, tokenId) => `${ORIGIN}/assets/bsc/${address}/${tokenId}`;
const collectionUrlFor = slug => typeof slug === 'string' && SLUG.test(slug) ? `${ORIGIN}/collections/${slug}` : null;

function publicRecord(record, selected) {
  return {
    floor: record.floor || null, lastSale: null, bestBid: null, source: 'Element',
    updatedAt: record.updatedAt || null, status: record.status,
    url: record.url || null,
    sellUrl: selected.owned && selected.tokenId ? assetUrlFor(selected.addr, selected.tokenId) : null,
    assetUrl: selected.tokenId ? assetUrlFor(selected.addr, selected.tokenId) : null,
    reason: record.reason,
    ...(record.volume ? { volume: record.volume } : {}), tokenId: selected.tokenId,
  };
}

function apolloJson(html) {
  if (typeof html !== 'string' || Buffer.byteLength(html, 'utf8') > MAX_HTML_BYTES) throw new Error('Element 页面超过读取上限');
  const assignment = /\bwindow\.__APOLLO_STATE__\s*=\s*/g.exec(html);
  if (!assignment) throw new Error('Element 页面数据结构已变化，未找到公开报价数据');
  let index = assignment.index + assignment[0].length;
  if (html[index] !== '{') throw new Error('Element 页面数据不是可验证的 JSON');
  const start = index, stack = [];
  let quoted = false, escaped = false;
  for (; index < html.length; index++) {
    const char = html[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === '{' || char === '[') stack.push(char);
    else if (char === '}' || char === ']') {
      if (stack.pop() !== (char === '}' ? '{' : '[')) throw new Error('Element 页面 JSON 不完整');
      if (!stack.length) {
        try { return JSON.parse(html.slice(start, index + 1)); }
        catch { throw new Error('Element 页面数据不是有效 JSON'); }
      }
    }
  }
  throw new Error('Element 页面 JSON 不完整');
}

export function parseElementMarketHtml(html, { address, tokenId } = {}) {
  const addr = addressOf(address), id = idOf(tokenId);
  if (!addr || id === null) throw new Error('NFT 合约地址或 Token ID 无效');
  const root = apolloJson(html)?.ROOT_QUERY;
  if (!root || typeof root !== 'object' || Array.isArray(root)) throw new Error('Element 页面数据结构已变化');
  let asset = null;
  for (const [key, value] of Object.entries(root).slice(0, 5000)) {
    if (!key.startsWith('asset(') || !key.endsWith(')')) continue;
    let query;
    try { query = JSON.parse(key.slice(6, -1)); } catch { continue; }
    const identity = query?.identity;
    if (identity?.blockChain?.chain !== 'bsc' || !isBscId(identity.blockChain.chainId) || addressOf(identity.contractAddress) !== addr || idOf(identity.tokenId) !== id) continue;
    if (!value || value.chain !== 'bsc' || !isBscId(value.chainId) || addressOf(value.contractAddress) !== addr || idOf(value.tokenId) !== id) continue;
    asset = value; break;
  }
  if (!asset) throw new Error('Element 页面资产与请求不一致，未使用报价');
  const collection = asset.collection, stats = collection?.stats;
  const quote = stats?.collectionFloorPrice;
  const amount = amountOf(quote?.floorPriceSource, true), currency = currencyOf(quote?.coin);
  let floor = null;
  if (amount !== null && currency) {
    const usd = amountOf(quote.floorPriceUsd, true);
    floor = { amount, currency, usd: usd === null ? null : Number(usd) };
  }
  const volumeAmount = amountOf(stats?.totalVolume), volumeCurrency = currencyOf(stats?.coin);
  return {
    floor, lastSale: null, bestBid: null, source: 'Element', updatedAt: null,
    status: floor ? 'available' : 'no_data', url: collectionUrlFor(collection?.slug),
    sellUrl: null, assetUrl: assetUrlFor(addr, id), tokenId: id,
    reason: floor ? '最低挂牌参考价，不代表即时可成交的买价' : '暂无可验证的市场挂牌报价',
    ...(volumeAmount !== null && volumeCurrency ? { volume: { amount: volumeAmount, currency: volumeCurrency } } : {}),
  };
}

async function boundedHtml(response) {
  const length = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(length) && length > MAX_HTML_BYTES) throw new Error('Element 页面超过读取上限');
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_HTML_BYTES) throw new Error('Element 页面超过读取上限');
    return text;
  }
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_HTML_BYTES) { reader.cancel().catch(() => {}); throw new Error('Element 页面超过读取上限'); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, size).toString('utf8');
}

export function createNftMarket({ fetchImpl = fetch, now = Date.now, cacheFile = null, ttlMs = 300000, concurrency = 3 } = {}) {
  const records = new Map();
  let flight = null, updatedAt = null;
  if (cacheFile) {
    try {
      const cached = JSON.parse(readFileSync(cacheFile, 'utf8'));
      if (cached.version === 1 && Array.isArray(cached.rows)) {
        for (const row of cached.rows.slice(-2000)) {
          const addr = addressOf(row.addr), tokenId = idOf(row.tokenId);
          if (!addr || tokenId === null || !STATUSES.has(row.status) || !Number.isFinite(row.checkedAt)) continue;
          const floorAmount = amountOf(row.floor?.amount, true), floorCurrency = currencyOf({ name: row.floor?.currency });
          const floorUsd = amountOf(row.floor?.usd, true);
          const floor = floorAmount !== null && floorCurrency ? { amount: floorAmount, currency: floorCurrency, usd: floorUsd === null ? null : Number(floorUsd) } : null;
          const slug = typeof row.url === 'string' && row.url.startsWith(ORIGIN + '/collections/') ? row.url.slice((ORIGIN + '/collections/').length) : null;
          const status = row.status === 'available' && !floor ? 'no_data' : row.status;
          const volumeAmount = amountOf(row.volume?.amount), volumeCurrency = currencyOf({ name: row.volume?.currency });
          records.set(addr, {
            addr, tokenId, checkedAt: row.checkedAt, updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : null,
            status, floor: status === 'available' ? floor : null, url: collectionUrlFor(slug),
            reason: status === 'error' ? '上次市场报价读取失败，可刷新重试' : status === 'available' ? '最低挂牌参考价，不代表即时可成交的买价' : '暂无可验证的市场挂牌报价',
            ...(volumeAmount !== null && volumeCurrency ? { volume: { amount: volumeAmount, currency: volumeCurrency } } : {}),
          });
        }
        updatedAt = typeof cached.updatedAt === 'string' ? cached.updatedAt : null;
      }
    } catch {}
  }
  function save() {
    if (!cacheFile) return;
    const temporary = `${cacheFile}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      mkdirSync(dirname(cacheFile), { recursive: true, mode: 0o700 });
      writeFileSync(temporary, JSON.stringify({ version: 1, updatedAt, rows: [...records.values()].slice(-2000) }), { mode: 0o600, flag: 'wx' });
      renameSync(temporary, cacheFile);
    } catch {} finally { try { rmSync(temporary, { force: true }); } catch {} }
  }
  function selectRows(nfts) {
    const selected = new Map();
    for (const row of (Array.isArray(nfts) ? nfts : []).slice(0, 2000)) {
      const addr = addressOf(row?.addr);
      if (!addr) continue;
      const ownedId = idOf(row.ownedTokenId), fallback = idOf(row.tokenIds?.[0]);
      const candidate = { addr, tokenId: ownedId ?? fallback, owned: ownedId !== null };
      const previous = selected.get(addr);
      if (!previous || candidate.owned && !previous.owned || previous.tokenId === null && candidate.tokenId !== null) selected.set(addr, candidate);
    }
    return [...selected.values()];
  }
  async function verify(row) {
    try {
      const expectedUrl = assetUrlFor(row.addr, row.tokenId);
      const response = await fetchImpl(expectedUrl, { method: 'GET', credentials: 'omit', redirect: 'error', headers: { accept: 'text/html' }, signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error(`Element HTTP ${response.status}`);
      if (response.url && response.url !== expectedUrl) throw new Error('Element 页面发生未允许的跳转');
      const parsed = parseElementMarketHtml(await boundedHtml(response), { address: row.addr, tokenId: row.tokenId });
      records.set(row.addr, { addr: row.addr, ...parsed, checkedAt: now(), updatedAt: new Date(now()).toISOString() });
    } catch (error) {
      const knownReason = /^(?:Element|NFT)/.test(String(error?.message || '')) ? error.message : 'Element 市场数据暂时无法读取';
      records.set(row.addr, { addr: row.addr, tokenId: row.tokenId, status: 'error', floor: null, url: null, checkedAt: now(), updatedAt: new Date(now()).toISOString(), reason: knownReason.slice(0, 240) });
    }
  }
  function sync(rows) {
    if (flight || !rows.length) return;
    let cursor = 0;
    const workers = Math.max(1, Math.min(Number.isFinite(concurrency) ? Math.floor(concurrency) : 3, 8, rows.length));
    flight = (async () => {
      await Promise.all(Array.from({ length: workers }, async () => { while (cursor < rows.length) await verify(rows[cursor++]); }));
      updatedAt = new Date(now()).toISOString(); save();
    })().catch(() => {}).finally(() => { flight = null; });
  }
  function snapshot(nfts, { force = false } = {}) {
    const rows = selectRows(nfts);
    sync(rows.filter(row => row.tokenId !== null && (force || records.get(row.addr)?.tokenId !== row.tokenId || !records.has(row.addr) || now() - records.get(row.addr).checkedAt >= ttlMs)));
    const markets = Object.fromEntries(rows.map(row => {
      const record = row.tokenId === null
        ? { status: 'pending_id', floor: null, reason: '先核验 Token ID，再查询市场报价' }
        : records.get(row.addr)?.tokenId === row.tokenId ? records.get(row.addr)
          : { status: 'no_data', floor: null, reason: '正在读取公开市场参考价' };
      return [row.addr, publicRecord(record, row)];
    }));
    const current = Object.values(markets);
    return { markets, marketSync: { loading: Boolean(flight), updatedAt, total: current.length, verified: current.filter(row => row.status === 'available' || row.status === 'no_data' && row.updatedAt).length, errors: current.filter(row => row.status === 'error').length } };
  }
  return { snapshot, whenIdle: async () => { if (flight) await flight; } };
}
