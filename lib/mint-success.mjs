import * as nodeFs from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { decodeAbiUint, decodeNftTransfers, NFT_EVENT_TOPICS, NFT_CODEC_LIMITS } from './nft-codec.mjs';

const ADDRESS = /^0x[0-9a-f]{40}$/i, HASH = /^0x[0-9a-f]{64}$/i, ID = /^[a-zA-Z0-9_-]{1,80}$/;
const ZERO = '0x' + '0'.repeat(40), WORD_ZERO = '0x' + '0'.repeat(64), UINT_MAX = 2n ** 256n - 1n;
const PAYMENT_ASSETS = new Set(['0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', '0x55d398326f99059ff775485246999027b3197955', '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c']);
const NON_MINT_SELECTORS = new Set([
  '095ea7b3', '39509351', 'a457c2d7', 'a22cb465', '87517c45', 'cc53287f', // approvals
  'a9059cbb', '23b872dd', '42842e0e', 'b88d4fde', 'f242432a', '2eb2c2d6', // asset transfers / sells
  '38ed1739', '8803dbee', '7ff36ab5', '4a25d94a', '18cbafe5', 'fb3bdb41', '5c11d795', 'b6f9de95', '791ac947',
  '414bf389', '04e45aaf', 'c04b8d59', 'b858183f', 'db3e2198', '5023b4df', 'f28c0498', '09b81346', '3593564c', '24856bc3', // swaps
]);
const lower = value => typeof value === 'string' ? value.toLowerCase() : '';
const address = value => ADDRESS.test(value || '') && lower(value) !== ZERO;
const hash = value => HASH.test(value || '') && lower(value) !== WORD_ZERO;
const uint = value => { try { if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null; if (typeof value !== 'string' || !/^(?:0x[0-9a-f]{1,64}|\d{1,78})$/i.test(value)) return null; const number = BigInt(value); return number <= UINT_MAX ? number : null; } catch { return null; } };
const time = value => Number.isSafeInteger(value) && value >= 0;
const walletId = value => typeof value === 'string' && ID.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value);
const identity = wallet => walletId(wallet?.id) && address(wallet?.address) ? { walletId: wallet.id, walletAddress: lower(wallet.address) } : null;
const topicAddress = value => typeof value === 'string' && /^0x0{24}[0-9a-f]{40}$/i.test(value) ? '0x' + value.slice(-40).toLowerCase() : null;
const skipped = reason => ({ recorded: false, duplicate: false, event: null, reason });
const storageError = () => Object.assign(new Error('铸造成功记录暂时无法保存，请保留交易凭证后重试'), { code: 'MINT_SUCCESS_STORAGE_ERROR' });
const cleanName = value => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 120) : '';

function receivedAssets(logs, owner, transaction, receipt, paymentTokens = []) {
  if (!Array.isArray(logs) || logs.length > NFT_CODEC_LIMITS.maxLogs || !Array.isArray(paymentTokens) || paymentTokens.length > 16 || paymentTokens.some(token => !address(token))) return null;
  const excluded = new Set([...PAYMENT_ASSETS, ...paymentTokens.map(lower)]), amounts = new Map(), indices = new Set(), missingIndices = new Set();
  let bytes = 0;
  const add = (asset, amount) => {
    const key = `${asset.address}:${asset.standard}:${asset.tokenId ?? ''}`;
    if (!amounts.has(key)) amounts.set(key, { ...asset, amount: 0n });
    amounts.get(key).amount += amount;
  };
  for (const log of logs) {
    if (!log || typeof log !== 'object' || log.removed === true || !address(log.address) || !Array.isArray(log.topics) || typeof log.data !== 'string' || !/^0x(?:[0-9a-f]{2})*$/i.test(log.data)) return null;
    if (log.transactionHash !== undefined && lower(log.transactionHash) !== lower(transaction.hash) || log.blockHash !== undefined && lower(log.blockHash) !== lower(receipt.blockHash) || log.blockNumber !== undefined && uint(log.blockNumber) !== uint(receipt.blockNumber)) return null;
    if (log.logIndex !== undefined) {
      const index = uint(log.logIndex); if (index === null || indices.has(index.toString())) return null; indices.add(index.toString());
    } else {
      const key = JSON.stringify([lower(log.address), log.topics.map(lower), lower(log.data)]);
      if (missingIndices.has(key)) return null; missingIndices.add(key);
    }
    bytes += (log.data.length - 2) / 2;
    if (bytes > NFT_CODEC_LIMITS.maxTotalDataBytes || log.data.length > 2 + NFT_CODEC_LIMITS.maxAbiBytes * 2) return null;
    const contract = lower(log.address), topic = lower(log.topics[0]);
    if (excluded.has(contract)) continue;
    if (topic === NFT_EVENT_TOPICS.ERC721_TRANSFER && log.topics.length === 3) {
      const from = topicAddress(log.topics[1]), to = topicAddress(log.topics[2]), amount = decodeAbiUint(log.data);
      if (from === null || to === null || amount === null) return null;
      if (from === owner || to === owner) add({ address: contract, standard: 'ERC20' }, (to === owner ? amount : 0n) - (from === owner ? amount : 0n));
    } else if ([NFT_EVENT_TOPICS.ERC721_TRANSFER, NFT_EVENT_TOPICS.ERC1155_TRANSFER_SINGLE, NFT_EVENT_TOPICS.ERC1155_TRANSFER_BATCH].includes(topic)) {
      const nft = decodeNftTransfers([log], owner);
      const from = topicAddress(log.topics[topic === NFT_EVENT_TOPICS.ERC721_TRANSFER ? 1 : 2]), to = topicAddress(log.topics[topic === NFT_EVENT_TOPICS.ERC721_TRANSFER ? 2 : 3]);
      if (from === null || to === null || log.topics.length !== 4 || (from === owner || to === owner) && !nft.length) return null;
      for (const change of nft) add({ address: change.addr, standard: change.standard, tokenId: change.tokenId }, BigInt(change.delta));
    }
    if (amounts.size > NFT_CODEC_LIMITS.maxChanges) return null;
  }
  const assets = [];
  for (const asset of amounts.values()) {
    if (asset.amount <= 0n) continue;
    if (asset.amount > UINT_MAX || asset.standard === 'ERC721' && asset.amount !== 1n) return null;
    const { amount, ...fields } = asset; assets.push({ ...fields, amountBaseUnits: amount.toString() });
  }
  return assets.sort((a, b) => `${a.address}:${a.standard}:${a.tokenId ?? ''}`.localeCompare(`${b.address}:${b.standard}:${b.tokenId ?? ''}`));
}

function verify({ wallet, pending, transaction: tx, receipt, source = 'live' } = {}) {
  const owner = identity(wallet), context = pending?.mintContext, expected = pending?.expected;
  if (!owner || pending?.version !== 1 || pending.walletId !== owner.walletId || lower(pending.walletAddress) !== owner.walletAddress) return { reason: 'wallet-mismatch' };
  if (pending.kind !== 'contract' || context?.version !== 1 || context.final !== true || !address(context.project) || context.simulated === true || pending.previewOnly === true) return { reason: 'not-final-mint' };
  if (!['live', 'backfill'].includes(source)) return { reason: 'invalid-source' };
  if (!hash(pending.txHash) || !hash(tx?.hash) || lower(tx.hash) !== lower(pending.txHash) || lower(receipt?.transactionHash) !== lower(tx.hash) || uint(tx.chainId) !== 56n || receipt?.chainId !== undefined && uint(receipt.chainId) !== 56n || pending.chainId !== undefined && uint(pending.chainId) !== 56n || uint(receipt?.status) !== 1n) return { reason: 'not-confirmed' };
  const blockNumber = uint(tx.blockNumber);
  if (blockNumber === null || blockNumber <= 0n || blockNumber !== uint(receipt.blockNumber) || !hash(tx.blockHash) || lower(tx.blockHash) !== lower(receipt.blockHash) || lower(tx.from) !== owner.walletAddress || receipt.from !== undefined && lower(receipt.from) !== owner.walletAddress) return { reason: 'receipt-mismatch' };
  const input = expected?.inputData, actualInput = tx.input ?? tx.data;
  if (!address(expected?.to) || lower(context.project) !== lower(expected.to) || lower(expected.from) !== owner.walletAddress || lower(tx.to) !== lower(expected.to) || receipt.to !== undefined && lower(receipt.to) !== lower(expected.to) || uint(expected.value) === null || uint(expected.value) !== uint(tx.value) || typeof input !== 'string' || input.length > 2 + 1024 * 1024 * 2 || !/^0x(?:[0-9a-f]{2})*$/i.test(input) || lower(actualInput) !== lower(input) || tx.input !== undefined && tx.data !== undefined && lower(tx.input) !== lower(tx.data)) return { reason: 'call-mismatch' };
  if (NON_MINT_SELECTORS.has(lower(input).slice(2, 10))) return { reason: 'non-mint-call' };
  const assets = receivedAssets(receipt.logs, owner.walletAddress, tx, receipt, context.paymentTokens);
  if (assets === null) return { reason: 'invalid-asset-evidence' };
  if (!assets.length) return { reason: 'no-asset-gain' };
  return { fields: { ...owner, chainId: 56, txHash: lower(tx.hash), project: lower(context.project), name: cleanName(context.name), blockNumber: blockNumber.toString(), blockHash: lower(tx.blockHash), assets, source } };
}

/** This store only records verified receipts. It never reads a wallet session,
 * uses simulation quantities, calls RPC, or changes scanner/wallet state. */
export function createMintSuccessStore({ root, now = Date.now, fs } = {}) {
  if (typeof root !== 'string' || !root.trim() || typeof now !== 'function') throw new TypeError('铸造成功记录配置无效');
  const io = fs ? { ...nodeFs, ...fs } : nodeFs, projectRoot = resolve(root), base = join(projectRoot, 'data', 'mint_success'), events = join(base, 'events'), temporary = join(base, '.tmp');
  const clock = () => { const value = now(); if (!time(value)) throw storageError(); return value; };
  function readJson(path, limit) {
    let fd;
    try {
      const before = io.lstatSync(path); if (!before.isFile() || before.isSymbolicLink() || before.size > limit) throw storageError();
      fd = io.openSync(path, io.constants.O_RDONLY | (io.constants.O_NOFOLLOW || 0));
      const stat = io.fstatSync(fd); if (!stat.isFile() || stat.size > limit) throw storageError();
      return JSON.parse(io.readFileSync(fd, 'utf8'));
    } finally { if (fd !== undefined) io.closeSync(fd); }
  }
  function atomicCreate(path, value) {
    const tmp = join(temporary, randomBytes(16).toString('hex') + '.json');
    try {
      io.writeFileSync(tmp, JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600, flush: true });
      try { io.linkSync(tmp, path); return true; } catch (error) { if (error.code === 'EEXIST') return false; throw error; }
    } finally { try { io.unlinkSync(tmp); } catch {} }
  }
  function layout() {
    if (!io.statSync(projectRoot).isDirectory()) throw storageError();
    for (const path of [join(projectRoot, 'data'), base, events, temporary]) {
      try { io.mkdirSync(path, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      const stat = io.lstatSync(path); if (!stat.isDirectory() || stat.isSymbolicLink()) throw storageError();
    }
    const path = join(base, 'tracking.json');
    let tracking;
    try { tracking = readJson(path, 4096); }
    catch (error) { if (error.code !== 'ENOENT') throw error; atomicCreate(path, { version: 1, coverage: 'since-enabled', trackingSince: clock() }); tracking = readJson(path, 4096); }
    if (tracking?.version !== 1 || tracking.coverage !== 'since-enabled' || !time(tracking.trackingSince)) throw storageError();
    return tracking;
  }
  function readEvent(path, fileHash) {
    const event = readJson(path, 4 * 1024 * 1024), owner = identity({ id: event?.walletId, address: event?.walletAddress });
    if (event?.version !== 1 || event.chainId !== 56 || !owner || event.walletAddress !== owner.walletAddress || !hash(event.txHash) || event.txHash !== lower(fileHash) || event.id !== '56:' + event.txHash || !address(event.project) || event.project !== lower(event.project) || event.name !== cleanName(event.name) || !time(event.recordedAt) || !['live', 'backfill'].includes(event.source) || !hash(event.blockHash) || uint(event.blockNumber) === null || uint(event.blockNumber) <= 0n || !Array.isArray(event.assets) || !event.assets.length || event.assets.length > NFT_CODEC_LIMITS.maxChanges) throw storageError();
    if (event.source === 'live' ? event.timeBasis !== 'verified-at' || event.confirmedAt !== event.recordedAt : event.confirmedAt === null ? event.timeBasis !== 'unknown' : event.timeBasis !== 'historical' || !time(event.confirmedAt) || event.confirmedAt > event.recordedAt) throw storageError();
    const keys = new Set(), assets = event.assets.map(asset => {
      const amount = uint(asset?.amountBaseUnits), tokenId = uint(asset?.tokenId);
      if (!address(asset?.address) || asset.address !== lower(asset.address) || PAYMENT_ASSETS.has(asset.address) || !['ERC20', 'ERC721', 'ERC1155'].includes(asset.standard) || typeof asset.amountBaseUnits !== 'string' || amount === null || amount <= 0n) throw storageError();
      if (asset.standard === 'ERC20' ? asset.tokenId !== undefined : typeof asset.tokenId !== 'string' || tokenId === null || asset.standard === 'ERC721' && amount !== 1n) throw storageError();
      const key = `${asset.address}:${asset.standard}:${asset.tokenId ?? ''}`; if (keys.has(key)) throw storageError(); keys.add(key);
      return { address: asset.address, standard: asset.standard, ...(asset.standard !== 'ERC20' ? { tokenId: tokenId.toString() } : {}), amountBaseUnits: amount.toString() };
    });
    return { version: 1, id: event.id, ...owner, chainId: 56, txHash: event.txHash, project: event.project, name: event.name, confirmedAt: event.confirmedAt, recordedAt: event.recordedAt, timeBasis: event.timeBasis, blockNumber: uint(event.blockNumber).toString(), blockHash: lower(event.blockHash), assets, source: event.source };
  }
  const recordConfirmed = (proof = {}) => {
    let verified;
    try { verified = verify(proof); } catch { return skipped('invalid-proof'); }
    if (!verified.fields) return skipped(verified.reason);
    try {
      layout(); const recordedAt = clock(), source = verified.fields.source;
      const historical = source === 'backfill' && time(proof.confirmedAt) && proof.confirmedAt <= recordedAt;
      const event = { version: 1, id: '56:' + verified.fields.txHash, ...verified.fields, confirmedAt: source === 'live' ? recordedAt : historical ? proof.confirmedAt : null, recordedAt, timeBasis: source === 'live' ? 'verified-at' : historical ? 'historical' : 'unknown' };
      const path = join(events, event.txHash + '.json'), recorded = atomicCreate(path, event);
      if (recorded) return { recorded: true, duplicate: false, event };
      const existing = readEvent(path, event.txHash);
      for (const key of ['walletId', 'walletAddress', 'project', 'blockNumber', 'blockHash']) if (existing[key] !== event[key]) throw storageError();
      if (JSON.stringify(existing.assets) !== JSON.stringify(event.assets)) throw storageError();
      return { recorded: false, duplicate: true, event: existing };
    } catch { throw storageError(); }
  };
  function readSummary({ wallets = [], timeZone = 'Asia/Shanghai' } = {}) {
    let asOf, trackingSince = null;
    const rows = (Array.isArray(wallets) ? wallets : []).map(wallet => ({ walletId: wallet?.id ?? null, walletAddress: lower(wallet?.address), total: null, today: null }));
    try {
      asOf = clock(); trackingSince = layout().trackingSince; asOf = clock();
      const formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
      const day = value => formatter.format(new Date(value)), today = day(asOf), records = [];
      for (const name of io.readdirSync(events)) {
        if (name === '.DS_Store') continue;
        if (!/^0x[0-9a-f]{64}\.json$/.test(name)) throw storageError();
        records.push(readEvent(join(events, name), name.slice(0, -5)));
      }
      const selected = new Set();
      for (const row of rows) {
        if (!identity({ id: row.walletId, address: row.walletAddress })) continue;
        const owned = records.filter(event => event.walletId === row.walletId && event.walletAddress === row.walletAddress);
        row.total = owned.length; row.today = owned.some(event => event.confirmedAt === null) ? null : owned.filter(event => day(event.confirmedAt) === today).length;
        selected.add(row.walletId + ':' + row.walletAddress);
      }
      return { version: 1, coverage: 'since-enabled', trackingSince, asOf, available: true, wallets: rows, recent: records.filter(event => selected.has(event.walletId + ':' + event.walletAddress)).sort((a, b) => b.recordedAt - a.recordedAt || a.txHash.localeCompare(b.txHash)).slice(0, 50) };
    } catch {
      return { version: 1, coverage: 'since-enabled', trackingSince, asOf: asOf ?? null, available: false, error: '铸造成功记录暂时无法读取', wallets: rows.map(row => ({ ...row, total: null, today: null })), recent: [] };
    }
  }
  return { recordConfirmed, append: recordConfirmed, readSummary };
}
