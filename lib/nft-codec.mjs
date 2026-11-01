// Pure ABI/event decoding. Event signatures follow the normative declarations:
// https://eips.ethereum.org/EIPS/eip-721
// https://eips.ethereum.org/EIPS/eip-1155
// Topics were verified with @noble/hashes keccak_256 against those signatures;
// this module deliberately has no package/runtime dependency on that install.
export const NFT_EVENT_TOPICS = Object.freeze({
  ERC721_TRANSFER: '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
  ERC1155_TRANSFER_SINGLE: '0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62',
  ERC1155_TRANSFER_BATCH: '0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb',
});
export const NFT_CODEC_LIMITS = Object.freeze({ maxAbiBytes: 65536, maxStringBytes: 16384, maxBatchItems: 512, maxLogs: 10000, maxChanges: 20000, maxTotalDataBytes: 4 * 1024 * 1024 });
const ADDRESS = /^0x[0-9a-f]{40}$/i;
const ZERO_ADDRESS = /^0x0{40}$/i;
const decoder = new TextDecoder('utf-8', { fatal: true });

function hexBody(value, maximum = NFT_CODEC_LIMITS.maxAbiBytes) {
  if (typeof value !== 'string' || value.length < 2 || value.length > 2 + maximum * 2 || (value.length - 2) % 2 !== 0 || !/^0x[0-9a-f]*$/i.test(value)) return null;
  return value.slice(2);
}
function uintAt(body, byteOffset) {
  if (!Number.isSafeInteger(byteOffset) || byteOffset < 0 || byteOffset + 32 > body.length / 2) return null;
  return BigInt('0x' + body.slice(byteOffset * 2, byteOffset * 2 + 64));
}
function boundedOffset(value, totalBytes, minimum) {
  return value !== null && value >= BigInt(minimum) && value <= BigInt(totalBytes - 32) && value % 32n === 0n ? Number(value) : null;
}
function topicAddress(topic) {
  const body = hexBody(topic, 32);
  return body?.length === 64 && /^0{24}/i.test(body) ? '0x' + body.slice(24).toLowerCase() : null;
}
function utf8(hex) {
  try {
    const bytes = new Uint8Array(hex.length / 2);
    for (let index = 0; index < bytes.length; index++) bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
    return decoder.decode(bytes);
  } catch { return ''; }
}

/** Decode exactly one ABI uint256 word. Empty/truncated/oversized data is null. */
export function decodeAbiUint(result) {
  const body = hexBody(result, 32);
  return body?.length === 64 ? uintAt(body, 0) : null;
}

/** Decode a dynamic ABI string or a right-zero-padded bytes32 name/symbol. */
export function decodeAbiString(result) {
  const body = hexBody(result);
  if (body === null) return '';
  if (body.length === 64) {
    let end = body.length;
    while (end >= 2 && body.slice(end - 2, end) === '00') end -= 2;
    const text = body.slice(0, end);
    // bytes32 metadata is left aligned. Embedded zero followed by nonzero bytes
    // is not valid right padding and must not become a misleading partial name.
    for (let index = 0; index < text.length; index += 2) if (text.slice(index, index + 2) === '00') return '';
    return utf8(text);
  }
  if (body.length < 128 || body.length % 64 !== 0) return '';
  const offset = boundedOffset(uintAt(body, 0), body.length / 2, 32);
  if (offset === null) return '';
  const size = uintAt(body, offset);
  if (size === null || size > BigInt(NFT_CODEC_LIMITS.maxStringBytes)) return '';
  const length = Number(size), start = offset + 32, end = start + length, paddedEnd = start + Math.ceil(length / 32) * 32;
  if (paddedEnd !== body.length / 2 || !/^0*$/.test(body.slice(end * 2, paddedEnd * 2))) return '';
  return utf8(body.slice(start * 2, end * 2));
}

function uintArray(body, offset) {
  const size = uintAt(body, offset);
  if (size === null || size > BigInt(NFT_CODEC_LIMITS.maxBatchItems)) return null;
  const count = Number(size), end = offset + 32 + count * 32;
  if (end > body.length / 2) return null;
  const values = [];
  for (let index = 0; index < count; index++) values.push(uintAt(body, offset + 32 + index * 32));
  return { values, start: offset, end };
}

/**
 * Aggregate event deltas by contract + standard + tokenId in first-seen order.
 * Zero-net and self-transfer IDs are retained for the caller's on-chain balance
 * verification. Malformed/removed/unrelated logs are skipped. Input and work are
 * bounded by NFT_CODEC_LIMITS; call in chunks for larger histories.
 */
export function decodeNftTransfers(logs, walletAddress) {
  if (!Array.isArray(logs) || typeof walletAddress !== 'string' || !ADDRESS.test(walletAddress) || ZERO_ADDRESS.test(walletAddress)) return [];
  const wallet = walletAddress.toLowerCase(), changes = new Map();
  let decoded = 0, bytesRead = 0;
  for (let index = 0; index < Math.min(logs.length, NFT_CODEC_LIMITS.maxLogs); index++) {
    try {
      const log = logs[index];
      if (!log || typeof log !== 'object' || log.removed === true || typeof log.address !== 'string' || !ADDRESS.test(log.address) || ZERO_ADDRESS.test(log.address) || !Array.isArray(log.topics) || log.topics.length !== 4) continue;
      const topic = typeof log.topics[0] === 'string' && log.topics[0].length === 66 ? log.topics[0].toLowerCase() : '';
      const erc721 = topic === NFT_EVENT_TOPICS.ERC721_TRANSFER;
      if (!erc721 && topic !== NFT_EVENT_TOPICS.ERC1155_TRANSFER_SINGLE && topic !== NFT_EVENT_TOPICS.ERC1155_TRANSFER_BATCH) continue;
      const from = topicAddress(log.topics[erc721 ? 1 : 2]), to = topicAddress(log.topics[erc721 ? 2 : 3]);
      if (from === null || to === null || (!erc721 && topicAddress(log.topics[1]) === null) || (from !== wallet && to !== wallet)) continue;
      if (typeof log.data !== 'string' || log.data.length > 2 + NFT_CODEC_LIMITS.maxAbiBytes * 2) continue;
      bytesRead += Math.max(0, (log.data.length - 2) / 2);
      if (bytesRead > NFT_CODEC_LIMITS.maxTotalDataBytes) break;
      const body = hexBody(log.data);
      if (body === null) continue;
      let ids, values;
      if (erc721) {
        const id = decodeAbiUint(log.topics[3]);
        if (body !== '' || id === null) continue;
        ids = [id]; values = [1n];
      } else if (topic === NFT_EVENT_TOPICS.ERC1155_TRANSFER_SINGLE) {
        if (body.length !== 128) continue;
        ids = [uintAt(body, 0)]; values = [uintAt(body, 32)];
      } else {
        if (body.length < 256 || body.length % 64 !== 0) continue;
        const idOffset = boundedOffset(uintAt(body, 0), body.length / 2, 64), valueOffset = boundedOffset(uintAt(body, 32), body.length / 2, 64);
        if (idOffset === null || valueOffset === null) continue;
        const idArray = uintArray(body, idOffset), valueArray = uintArray(body, valueOffset);
        if (!idArray || !valueArray || idArray.values.length !== valueArray.values.length || (idArray.start < valueArray.end && valueArray.start < idArray.end)) continue;
        ids = idArray.values; values = valueArray.values;
      }
      if (decoded + ids.length > NFT_CODEC_LIMITS.maxChanges) break;
      decoded += ids.length;
      const addr = log.address.toLowerCase(), standard = erc721 ? 'ERC721' : 'ERC1155', sign = (to === wallet ? 1n : 0n) - (from === wallet ? 1n : 0n);
      for (let item = 0; item < ids.length; item++) {
        const tokenId = ids[item].toString(), key = `${addr}:${standard}:${tokenId}`;
        let change = changes.get(key);
        if (!change) { change = { addr, standard, tokenId, delta: 0n }; changes.set(key, change); }
        change.delta += sign * values[item];
      }
    } catch { /* A malformed log never prevents decoding the remaining history. */ }
  }
  return [...changes.values()].map((change) => ({ ...change, delta: change.delta.toString() }));
}
