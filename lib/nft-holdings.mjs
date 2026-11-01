// Read-only NFT inventory. It never changes scanner state or trading rules.
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { decodeAbiUint, decodeAbiString, decodeNftTransfers } from './nft-codec.mjs';

const ADDRESS = /^0x[a-fA-F0-9]{40}$/;
const word = (value) => BigInt(value).toString(16).padStart(64, '0');
const addressWord = (value) => value.slice(2).toLowerCase().padStart(64, '0');
const interfaceCall = (value) => '0x01ffc9a7' + value.padEnd(64, '0');
const RPCS = ['https://bsc.publicnode.com', 'https://bsc-rpc.publicnode.com', 'https://bsc-dataseed.bnbchain.org'];
const keyFor = (address, wallet) => `${address.toLowerCase()}:${wallet.toLowerCase()}`;

export async function nftRpc(method, params) {
  let last;
  for (const url of RPCS) {
    try {
      const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(6000) });
      if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
      const data = await response.json();
      if (data.error) {
        const error = new Error(data.error.message || 'RPC 查询失败');
        if (/revert|invalid opcode|out of gas/i.test(error.message)) { error.contract = true; throw error; }
        throw error;
      }
      if (data.result === undefined) throw new Error('RPC 未返回查询结果');
      return data.result;
    } catch (error) { if (error.contract) throw error; last = error; }
  }
  throw last || new Error('RPC 无法连接');
}

export function createNftInventory({ rpc = nftRpc, now = Date.now, cacheFile = null, ttlMs = 90000, concurrency = 4, logLines = () => [] } = {}) {
  const records = new Map(), metadata = new Map(), receipts = new Map(), evidence = new Map();
  let flight = null, updatedAt = null;
  if (cacheFile) {
    try {
      const data = JSON.parse(readFileSync(cacheFile, 'utf8'));
      if (data.version === 1 && Array.isArray(data.rows)) {
        for (const row of data.rows.slice(0, 2000)) if (ADDRESS.test(row.addr) && ADDRESS.test(row.walletAddress)) records.set(keyFor(row.addr, row.walletAddress), row);
        updatedAt = data.updatedAt || null;
      }
    } catch {}
  }
  const call = (to, data) => rpc('eth_call', [{ to, data }, 'latest']);
  const optional = (promise) => promise.catch(() => null);
  function save() {
    if (!cacheFile) return;
    try {
      mkdirSync(dirname(cacheFile), { recursive: true });
      const temporary = `${cacheFile}.${process.pid}.tmp`;
      writeFileSync(temporary, JSON.stringify({ version: 1, updatedAt, rows: [...records.values()].slice(-2000) }), { mode: 0o600 });
      renameSync(temporary, cacheFile);
    } catch {}
  }
  async function collectionInfo(address) {
    if (metadata.has(address)) return metadata.get(address);
    const pending = (async () => {
      const erc721 = decodeAbiUint(await optional(call(address, interfaceCall('80ac58cd'))));
      const erc1155 = erc721 === 1n ? 0n : decodeAbiUint(await optional(call(address, interfaceCall('d9b67a26'))));
      if (erc721 === null && erc1155 === null) throw new Error('NFT 标准接口未返回有效数据，请稍后重试');
      const standard = erc721 === 1n ? 'ERC721' : erc1155 === 1n ? 'ERC1155' : 'unknown';
      const name = decodeAbiString(await optional(call(address, '0x06fdde03'))).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 120);
      const sym = decodeAbiString(await optional(call(address, '0x95d89b41'))).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 40);
      return { standard, name: name || sym || '未命名 NFT', sym };
    })();
    metadata.set(address, pending);
    let result;
    try { result = await pending; } catch (error) { metadata.delete(address); throw error; }
    // Do not permanently cache transient interface-query failures.
    if (result.standard === 'unknown') metadata.delete(address);
    return result;
  }
  function recentReceipts(address, limit = 20) {
    const hashes = new Set();
    for (const line of logLines().slice().reverse()) {
      if (!/已自動鑄造|已自动铸造/.test(line)) continue;
      if (address && !line.toLowerCase().includes(address.toLowerCase())) continue;
      for (const hash of line.match(/0x[a-fA-F0-9]{64}\b/g) || []) hashes.add(hash.toLowerCase());
      if (hashes.size >= limit) break;
    }
    return [...hashes];
  }
  async function receipt(hash) {
    if (!receipts.has(hash)) receipts.set(hash, rpc('eth_getTransactionReceipt', [hash]).catch((error) => { receipts.delete(hash); throw error; }));
    const result = await receipts.get(hash);
    if (!result) receipts.delete(hash);
    return result;
  }
  async function knownIds(row) {
    const ids = new Set((records.get(keyFor(row.addr, row.walletAddress))?.tokenIds || []).filter((id) => /^\d+$/.test(id)));
    const hashes = recentReceipts(row.addr);
    for (const hash of hashes) {
      const result = await optional(receipt(hash));
      if (!result || result.status !== '0x1') continue;
      for (const change of decodeNftTransfers(result.logs || [], row.walletAddress)) if (change.addr.toLowerCase() === row.addr) ids.add(change.tokenId);
    }
    // Factory mints may target a different contract. Match receipt emitters in a
    // bounded, shared index rather than guessing NFT IDs.
    {
      const allHashes = recentReceipts(null, 160);
      const evidenceKey = row.walletAddress + ':' + allHashes.join(',');
      if (!evidence.has(evidenceKey)) evidence.set(evidenceKey, (async () => {
        const byAddress = new Map(); let cursor = 0;
        await Promise.all(Array.from({ length: Math.min(4, allHashes.length) }, async () => {
          while (cursor < allHashes.length) {
            const result = await optional(receipt(allHashes[cursor++]));
            if (!result || result.status !== '0x1') continue;
            for (const change of decodeNftTransfers(result.logs || [], row.walletAddress)) {
              const found = byAddress.get(change.addr) || new Set();
              found.add(change.tokenId); byAddress.set(change.addr, found);
            }
          }
        }));
        return byAddress;
      })());
      const found = await evidence.get(evidenceKey);
      for (const id of found.get(row.addr) || []) ids.add(id);
      if (evidence.size > 8) evidence.delete(evidence.keys().next().value);
    }
    return [...ids].slice(0, 256);
  }
  async function legacy721Info(row) {
    // Some contracts implement ERC721 ownership methods but omit ERC165.
    // Require a real receipt and current ownerOf proof before using that path.
    const sources = [...new Set([...(records.get(keyFor(row.addr, row.walletAddress))?.sourceTransactions || []), ...recentReceipts(row.addr), ...recentReceipts(null, 160)])].slice(0, 180);
    for (const hash of sources) {
      const result = await optional(receipt(hash));
      if (!result || result.status !== '0x1') continue;
      for (const transfer of decodeNftTransfers(result.logs || [], row.walletAddress)) {
        if (transfer.addr !== row.addr || transfer.standard !== 'ERC721') continue;
        const owner = decodeAbiUint(await optional(call(row.addr, '0x6352211e' + word(transfer.tokenId))));
        if (owner === null || owner.toString(16).padStart(40, '0') !== row.walletAddress.slice(2)) continue;
        const name = decodeAbiString(await optional(call(row.addr, '0x06fdde03'))).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 120);
        const sym = decodeAbiString(await optional(call(row.addr, '0x95d89b41'))).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 40);
        const info = { standard: 'ERC721', standardInferred: true, name: name || sym || '未命名 NFT', sym };
        metadata.set(row.addr, Promise.resolve(info));
        return { ...info, knownTokenIds: [transfer.tokenId], sourceTransactions: [hash] };
      }
    }
    return null;
  }
  async function verify(row) {
    const key = keyFor(row.addr, row.walletAddress), old = records.get(key) || row;
    try {
      let info;
      try { info = await collectionInfo(row.addr); }
      catch (error) { info = await legacy721Info(row); if (!info) throw error; }
      if (info.standard === 'unknown') info = await legacy721Info(row) || info;
      let quantity = null, ownedTokenId = null, tokenIds = info.knownTokenIds || old.tokenIds || [], idsComplete = info.standard === 'ERC721' && !info.standardInferred;
      if (info.standard === 'ERC721') {
        const count = decodeAbiUint(await call(row.addr, '0x70a08231' + addressWord(row.walletAddress)));
        if (count === null) throw new Error('NFT 余额返回格式无效');
        quantity = count.toString();
        if (count > 0n) {
          tokenIds = [...new Set([...tokenIds, ...await knownIds(row)])];
          const candidates = [...new Set([old.ownedTokenId, ...tokenIds].filter((id) => typeof id === 'string' && /^\d+$/.test(id)))];
          for (const id of candidates.slice(0, 64)) {
            const owner = decodeAbiUint(await optional(call(row.addr, '0x6352211e' + word(id))));
            if (owner !== null && owner.toString(16).padStart(40, '0') === row.walletAddress.slice(2)) { ownedTokenId = id; break; }
          }
        }
      } else if (info.standard === 'ERC1155') {
        tokenIds = await knownIds(row);
        if (tokenIds.length) {
          let sum = 0n;
          for (const id of tokenIds) {
            const count = decodeAbiUint(await call(row.addr, '0x00fdd58e' + addressWord(row.walletAddress) + word(id)));
            if (count === null) throw new Error('ERC1155 余额返回格式无效');
            if (count > 0n && ownedTokenId === null) ownedTokenId = id;
            sum += count;
          }
          // A positive amount proves ownership. Zero known IDs cannot rule out
          // other IDs, so an incomplete ERC1155 inventory stays unverified.
          if (sum > 0n) quantity = sum.toString();
        }
      }
      records.set(key, { ...row, ...info, quantity, tokenIds, ownedTokenId, idsComplete, status: quantity === null ? 'unverified' : quantity === '0' ? 'zero' : 'held', verifiedAt: new Date(now()).toISOString(), checkedAt: now(), error: quantity === null ? (info.standard === 'ERC1155' ? '尚未找到可确认当前持有量的完整 Token ID，未将未知数量记为零' : '合约未确认支持 ERC721 或 ERC1155，未将未知数量记为零') : undefined });
    } catch (error) {
      records.set(key, { ...row, ...old, status: 'error', checkedAt: now(), error: String(error.message || 'NFT 链上核验失败').slice(0, 240) });
    }
  }
  function rowsFor(state, config) {
    const addresses = Object.keys(state.nftCols || {}).filter((address) => ADDRESS.test(address)).map((address) => address.toLowerCase());
    const result = [];
    for (const addr of [...new Set(addresses)]) for (const wallet of config.wallets || []) {
      if (!ADDRESS.test(wallet.address)) continue;
      const walletAddress = wallet.address.toLowerCase();
      const row = records.get(keyFor(addr, walletAddress));
      result.push({ addr, walletAddress, wallet: wallet.name, name: '待核验 NFT', sym: '', standard: 'unknown', quantity: null, tokenIds: [], idsComplete: false, verifiedAt: null, status: 'unverified', ...row, wallet: wallet.name });
      if (result.length >= 2000) return result;
    }
    return result;
  }
  function sync(rows) {
    if (flight || !rows.length) return;
    let cursor = 0;
    flight = (async () => {
      await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, 8, rows.length)) }, async () => {
        while (cursor < rows.length) await verify(rows[cursor++]);
      }));
      updatedAt = new Date(now()).toISOString(); save();
    })().catch(() => {}).finally(() => { flight = null; });
  }
  function snapshot({ state, config, force = false }) {
    const rows = rowsFor(state, config);
    sync(rows.filter((row) => force || !row.checkedAt || now() - row.checkedAt >= ttlMs));
    const current = rowsFor(state, config);
    return {
      nfts: current,
      nftSync: { loading: Boolean(flight), updatedAt, total: current.length, verified: current.filter((row) => row.status === 'held' || row.status === 'zero').length, errors: current.filter((row) => row.status === 'error').length },
    };
  }
  return { snapshot, whenIdle: async () => { if (flight) await flight; } };
}
