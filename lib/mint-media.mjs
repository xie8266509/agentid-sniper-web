import { createHash } from 'node:crypto';
import { createSafeWeb } from './safe-web.mjs';

const ADDRESS = /^0x[0-9a-f]{40}$/i;
const META_LIMIT = 262144, IMAGE_LIMIT = 2097152, CACHE_MS = 300000;
const fail = message => Object.assign(new Error(message), { code: 'MINT_MEDIA_REJECTED' });

export function mediaWebUrl(input, tokenId = '1') {
  if (typeof input !== 'string' || !input || input.length > (/^data:/i.test(input) ? IMAGE_LIMIT * 4 + 256 : 8192)) throw fail('NFT 资源地址无效');
  if (typeof tokenId !== 'bigint' && !(typeof tokenId === 'string' && /^\d+$/.test(tokenId)) && !(typeof tokenId === 'number' && Number.isSafeInteger(tokenId))) throw fail('NFT ID 无效');
  let id; try { id = BigInt(tokenId); } catch { throw fail('NFT ID 无效'); }
  if (id < 0n || id >= 1n << 256n) throw fail('NFT ID 无效');
  let uri = input.trim().replaceAll('{id}', id.toString(16).padStart(64, '0'));
  if (/^ipfs:\/\//i.test(uri)) {
    const path = uri.replace(/^ipfs:\/\/(?:ipfs\/)?/i, '');
    if (!/^(?:Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{50,})(?:\/[^?#]*)?(?:\?[^#]*)?$/.test(path) || /(?:^|\/)\.{1,2}(?:\/|$)/.test(path)) throw fail('NFT IPFS 地址无效');
    uri = 'https://ipfs.io/ipfs/' + path;
  } else if (/^ar:\/\//i.test(uri)) {
    const path = uri.slice(5);
    if (!/^[A-Za-z0-9_-]{43}(?:\/[^?#]*)?(?:\?[^#]*)?$/.test(path)) throw fail('NFT Arweave 地址无效');
    uri = 'https://arweave.net/' + path;
  }
  return uri;
}

function dataBytes(uri, kind, maximum) {
  if (typeof uri !== 'string' || uri.length > maximum * 4 + 256) throw fail('NFT 内嵌资源超过读取上限');
  const match = /^data:([^,]*),(.*)$/is.exec(uri);
  if (!match) throw fail('NFT 内嵌资源格式无效');
  const header = match[1].split(';'), contentType = header.shift().toLowerCase();
  const base64 = header.at(-1)?.toLowerCase() === 'base64';
  if (header.some((value, index) => !(base64 && index === header.length - 1 && value.toLowerCase() === 'base64') && !/^charset=utf-8$/i.test(value))) throw fail('NFT 内嵌资源编码不受支持');
  if (kind === 'json' ? contentType !== 'application/json' : !/^image\/(?:png|jpeg|gif|webp|avif|svg\+xml)$/.test(contentType)) throw fail('NFT 内嵌资源类型无效');
  let bytes;
  try {
    if (base64) { if (!/^(?:[a-z0-9+/]{4})*(?:[a-z0-9+/]{2}==|[a-z0-9+/]{3}=)?$/i.test(match[2])) throw fail('NFT Base64 数据无效'); bytes = Buffer.from(match[2], 'base64'); }
    else bytes = Buffer.from(decodeURIComponent(match[2]), 'utf8');
  } catch { throw fail('NFT 内嵌资源无法解码'); }
  if (!bytes.length || bytes.length > maximum) throw fail('NFT 内嵌资源超过读取上限');
  return { body: bytes, contentType };
}

function imageType(bytes) {
  if (bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.toString('ascii', 12, 16) === 'IHDR' && bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0 && bytes.includes(Buffer.from('IEND'))) return 'image/png';
  if (bytes.length >= 8 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 && bytes.at(-2) === 255 && bytes.at(-1) === 217) return 'image/jpeg';
  if (bytes.length >= 14 && /^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6)) && bytes.at(-1) === 59) return 'image/gif';
  if (bytes.length >= 20 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' && bytes.readUInt32LE(4) + 8 === bytes.length) return 'image/webp';
  if (bytes.length >= 24 && bytes.toString('ascii', 4, 8) === 'ftyp' && /^(?:avif|avis)$/.test(bytes.toString('ascii', 8, 12))) return 'image/avif';
  const text = bytes.toString('utf8').replace(/^\uFEFF/, '').trim();
  if (/^(?:<\?xml[^?]*\?>\s*)?<svg(?:\s|>)/i.test(text) && (/<\/svg\s*>\s*$/i.test(text) || /<svg\b[^>]*\/\s*>\s*$/i.test(text))) return 'image/svg+xml';
  return null;
}

/** Reads only bounded bytes; it never renders images, executes SVG/script, or
 * follows resources referenced inside an image. Fingerprints describe equality
 * among locally observed bytes, not project legitimacy or visual originality. */
export function createMintMedia({ state = {}, fetchBytes = createSafeWeb(), now = Date.now, save = () => {}, cacheMs = CACHE_MS } = {}) {
  if (typeof fetchBytes !== 'function' || !Number.isFinite(cacheMs) || cacheMs < 0 || cacheMs > CACHE_MS) throw new TypeError('Invalid mint media dependencies');
  state.nftMedia ||= { version: 1, checks: {}, images: {} };
  if (state.nftMedia.version !== 1 || !state.nftMedia.checks || typeof state.nftMedia.checks !== 'object' || Array.isArray(state.nftMedia.checks) || !state.nftMedia.images || typeof state.nftMedia.images !== 'object' || Array.isArray(state.nftMedia.images)) throw fail('NFT 图片检查记录无效');
  const ledger = state.nftMedia;
  async function resource(uri, kind, maximum, tokenId) {
    const url = mediaWebUrl(uri, tokenId);
    if (/^data:/i.test(url)) return dataBytes(url, kind, maximum);
    const result = await fetchBytes(url, { kind, maxBytes: maximum, timeoutMs: 10000, maxRedirects: 2 });
    if (!result || !Buffer.isBuffer(result.body) || !result.body.length || result.body.length > maximum) throw fail('NFT 资源读取不完整或超过上限');
    return result;
  }
  return {
    async check(contract, metadataUri, { tokenId = '1' } = {}) {
      if (!ADDRESS.test(contract || '')) throw fail('NFT 合约地址无效');
      const address = contract.toLowerCase();
      const key = createHash('sha256').update(address + ':' + String(tokenId) + ':' + String(metadataUri)).digest('hex');
      const cached = ledger.checks[key];
      if (cached?.verified === true && typeof cached.imageHash === 'string' && /^[a-f0-9]{64}$/.test(cached.imageHash) && Number.isFinite(cached.checkedAt) && now() >= cached.checkedAt && now() - cached.checkedAt < cacheMs) return { ...cached };
      const metadata = await resource(metadataUri, 'json', META_LIMIT, tokenId);
      let value; try { value = JSON.parse(metadata.body.toString('utf8')); } catch { throw fail('NFT 元数据不是有效 JSON'); }
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('NFT 元数据格式无效');
      const imageUri = Object.hasOwn(value, 'image') ? value.image : Object.hasOwn(value, 'image_url') ? value.image_url : null;
      if (typeof imageUri !== 'string' || !imageUri.trim()) throw fail('NFT 元数据没有可核验的静态图片');
      const image = await resource(imageUri, 'image', IMAGE_LIMIT, tokenId), contentType = imageType(image.body);
      if (!contentType || String(image.contentType).toLowerCase().split(';')[0] !== contentType) throw fail('NFT 图片类型或格式无法核验');
      const imageHash = createHash('sha256').update(image.body).digest('hex'), first = ledger.images[imageHash];
      if (first && first.contract !== address) throw fail('NFT 图片字节与本机已见的另一合约重复');
      const result = { verified: true, imageHash, contentType, checkedAt: now() };
      ledger.images[imageHash] = { contract: address, at: now() }; ledger.checks[key] = result;
      for (const [collection, maximum] of [[ledger.checks, 3000], [ledger.images, 20000]]) {
        const keys = Object.keys(collection);
        if (keys.length > maximum) for (const old of keys.sort((a, b) => (collection[a].checkedAt ?? collection[a].at ?? 0) - (collection[b].checkedAt ?? collection[b].at ?? 0)).slice(0, keys.length - maximum)) delete collection[old];
      }
      save(true); return { ...result };
    },
  };
}
