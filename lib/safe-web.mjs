import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpRequest, Agent as HttpAgent } from 'node:http';
import { request as httpsRequest, Agent as HttpsAgent } from 'node:https';
import { isIP } from 'node:net';

const fail = message => Object.assign(new Error(message), { code: 'SAFE_WEB_REJECTED' });
const ipv4Number = address => address.split('.').reduce((value, part) => value * 256 + Number(part), 0);
const v4Prefix = (value, address, bits) => Math.floor(value / 2 ** (32 - bits)) === Math.floor(ipv4Number(address) / 2 ** (32 - bits));
function ipv6Number(address) {
  let text = address.toLowerCase();
  if (text.includes('.')) { const index = text.lastIndexOf(':'); const value = ipv4Number(text.slice(index + 1)); text = text.slice(0, index + 1) + (value >>> 16).toString(16) + ':' + (value & 65535).toString(16); }
  const [left, right] = text.split('::'), a = left ? left.split(':') : [], b = right ? right.split(':') : [];
  const words = right === undefined ? a : [...a, ...Array(8 - a.length - b.length).fill('0'), ...b];
  return words.reduce((value, word) => (value << 16n) + BigInt('0x' + word), 0n);
}
const v6Prefix = (value, address, bits) => value >> BigInt(128 - bits) === ipv6Number(address) >> BigInt(128 - bits);

// Be conservative about special-use/transition networks. No private or mapped
// address is allowed merely because the same DNS answer also contains a public IP.
export function isPublicAddress(address) {
  if (typeof address !== 'string' || address.includes('%')) return false;
  const family = isIP(address);
  if (family === 4) {
    const value = ipv4Number(address);
    if (address === '168.63.129.16') return false; // Cloud platform metadata/service address.
    return ![['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]].some(([base, bits]) => v4Prefix(value, base, bits));
  }
  if (family !== 6) return false;
  const value = ipv6Number(address);
  if (!v6Prefix(value, '2000::', 3)) return false;
  return ![['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3ffe::', 16], ['3fff::', 20]].some(([base, bits]) => v6Prefix(value, base, bits));
}

export function normalizeWebUrl(input, { allowHttp = false } = {}) {
  if (typeof input !== 'string' || !input || input.length > 8192 || /[\u0000-\u0020\u007f]/.test(input)) throw fail('网页地址格式无效');
  let url; try { url = new URL(input); } catch { throw fail('网页地址格式无效'); }
  if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) throw fail('只允许已批准的 HTTPS 网页地址');
  if (url.username || url.password) throw fail('网页地址不允许携带凭据');
  if (url.port && url.port !== (url.protocol === 'https:' ? '443' : '80')) throw fail('不允许非标准网页端口');
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (!host || /(?:^|\.)(?:localhost|local|internal|lan|home|invalid|test)$/.test(host) || host === 'metadata.google.internal') throw fail('不允许访问本机或内部网页地址');
  if (isIP(host)) { if (!isPublicAddress(host)) throw fail('不允许访问私网、保留或元数据地址'); }
  else if (host.length > 253 || !host.includes('.') || !host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) throw fail('网页域名无效');
  url.hash = '';
  if (!isIP(host)) url.hostname = host;
  return url;
}

function bounded(promise, milliseconds) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(fail('网页读取超时')), Math.max(1, milliseconds));
    Promise.resolve(promise).then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}
const MIME = {
  json: type => type === 'application/json' || /^application\/[a-z0-9.+-]+\+json$/.test(type) || type === 'text/json',
  image: type => /^image\/(?:png|jpeg|gif|webp|avif|svg\+xml)$/.test(type),
  text: type => ['text/html', 'text/plain', 'application/json', 'application/javascript', 'text/javascript'].includes(type) || /^application\/[a-z0-9.+-]+\+json$/.test(type),
};

/** Bounded GETs for untrusted project content. Custom agents never inherit proxy
 * environment settings. The original hostname remains the TLS/HTTP identity;
 * every connection's lookup callback is pinned to an already checked address.
 * Inject both lookup and request in tests; no browser, cookies or wallet exists. */
export function createSafeWeb({ lookup = dnsLookup, request: requestImpl, allowHttp = false } = {}) {
  if (typeof lookup !== 'function' || requestImpl !== undefined && typeof requestImpl !== 'function') throw new TypeError('Invalid safe web dependencies');
  return async function fetchBytes(input, { kind = 'text', maxBytes = 262144, timeoutMs = 10000, maxRedirects = 2 } = {}) {
    if (!Object.hasOwn(MIME, kind) || !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 8 * 1024 * 1024 || !Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000 || !Number.isInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 3) throw fail('网页读取边界无效');
    const deadline = Date.now() + timeoutMs;
    let url = normalizeWebUrl(input, { allowHttp });
    for (let redirect = 0; ; redirect++) {
      if (Date.now() >= deadline) throw fail('网页读取超时');
      const host = url.hostname.replace(/^\[|\]$/g, '');
      const records = isIP(host) ? [{ address: host, family: isIP(host) }] : await bounded(Promise.resolve().then(() => lookup(host, { all: true, verbatim: true })), deadline - Date.now());
      if (!Array.isArray(records) || !records.length || records.some(record => !record || record.family !== isIP(record.address) || !isPublicAddress(record.address))) throw fail('网页域名解析到不允许的网络地址');
      if (Date.now() >= deadline) throw fail('网页读取超时');
      const selected = records.find(record => record.family === 4) || records[0];
      const pinnedLookup = (_hostname, options, callback) => {
        if (typeof options === 'function') { callback = options; options = {}; }
        if (options?.all) callback(null, [{ address: selected.address, family: selected.family }]);
        else callback(null, selected.address, selected.family);
      };
      const result = await new Promise((resolve, reject) => {
        const secure = url.protocol === 'https:', Agent = secure ? HttpsAgent : HttpAgent;
        const agent = new Agent({ keepAlive: false, proxyEnv: {}, lookup: pinnedLookup, family: selected.family, autoSelectFamily: false });
        let req, res, settled = false;
        const timer = setTimeout(() => finish(fail('网页读取超时')), Math.max(1, deadline - Date.now()));
        const finish = (error, value) => {
          if (settled) return; settled = true; clearTimeout(timer);
          if (error) { res?.destroy?.(); req?.destroy?.(); }
          agent.destroy(); error ? reject(error) : resolve(value);
        };
        try {
          const request = requestImpl || (secure ? httpsRequest : httpRequest);
          req = request(url, { method: 'GET', agent, lookup: pinnedLookup, family: selected.family, autoSelectFamily: false, rejectUnauthorized: true, maxHeaderSize: 16384, headers: { 'user-agent': 'agentid-sniper-web', accept: kind === 'image' ? 'image/*' : kind === 'json' ? 'application/json' : 'text/html,text/plain,application/json,application/javascript', 'accept-encoding': 'identity' } }, response => {
            res = response;
            if (settled) { res.destroy?.(); return; }
            const status = Number(res.statusCode);
            if (status >= 300 && status < 400) {
              const location = res.headers?.location;
              res.destroy?.();
              if (typeof location !== 'string' || redirect >= maxRedirects) { finish(fail('网页重定向被拒绝')); return; }
              finish(null, { redirect: location }); return;
            }
            if (status !== 200) { finish(fail('网页内容暂不可用')); return; }
            const encoding = String(res.headers?.['content-encoding'] || 'identity').toLowerCase();
            if (encoding !== 'identity') { finish(fail('网页内容编码不受支持')); return; }
            const contentType = String(res.headers?.['content-type'] || '').split(';')[0].trim().toLowerCase();
            if (!MIME[kind](contentType)) { finish(fail('网页内容类型不符合用途')); return; }
            const length = res.headers?.['content-length'];
            if (length !== undefined && (!/^\d+$/.test(String(length)) || Number(length) > maxBytes)) { finish(fail('网页内容超过读取上限')); return; }
            const chunks = []; let size = 0;
            res.on('data', chunk => {
              if (settled) return;
              const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
              size += bytes.length;
              if (size > maxBytes) { finish(fail('网页内容超过读取上限')); return; }
              chunks.push(bytes);
            });
            res.on('end', () => { if (!size || length !== undefined && Number(length) !== size) finish(fail('网页内容为空或读取不完整')); else finish(null, { status, contentType, url: url.href, body: Buffer.concat(chunks, size) }); });
            res.on('aborted', () => finish(fail('网页读取中断')));
            res.on('error', () => finish(fail('网页读取失败')));
          });
          req.on('error', () => finish(fail('网页连接失败')));
          req.end();
        } catch { finish(fail('网页连接失败')); }
      });
      if (!result.redirect) return result;
      let next; try { next = normalizeWebUrl(new URL(result.redirect, url).href, { allowHttp }); } catch { throw fail('网页重定向地址不受允许'); }
      if (url.protocol === 'https:' && next.protocol !== 'https:') throw fail('不允许网页重定向降低传输保护');
      if (Date.now() >= deadline) throw fail('网页读取超时');
      url = next;
    }
  };
}
