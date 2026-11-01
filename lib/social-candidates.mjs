import { createHash, randomBytes } from 'node:crypto';

const ADDRESS = /^0x[0-9a-f]{40}$/i;
const EXCLUDED = ['pump.fun', 'flap.sh', 'bscscan.com', 'etherscan.io', 'dexscreener.com', 'dextools.io', 't.me', 'telegram.me'];
const hash = value => createHash('sha256').update(value).digest('hex');
export const socialSelectionHash = groupIds => hash([...new Set(groupIds)].sort().join(','));
export function candidateUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443' || EXCLUDED.some(host => url.hostname === host || url.hostname.endsWith('.' + host))) return null;
    url.hash = ''; url.search = '';
    return url.href.length <= 2048 ? url.href : null;
  } catch { return null; }
}
export function extractSocialCandidates(text) {
  text = String(text || '').slice(0, 65536);
  return { addresses: [...new Set((text.match(/0x[0-9a-f]{40}\b/gi) || []).map(x => x.toLowerCase()))].slice(0, 24), urls: [...new Set((text.match(/https:\/\/[^\s<>"']+/gi) || []).map(value => candidateUrl(value.replace(/[),.;!?，。]+$/, ''))).filter(Boolean))].slice(0, 12) };
}
export function createSocialAccumulator({ now = Date.now, salt = randomBytes(24).toString('hex') } = {}) {
  const entries = new Map(), seen = new Map();
  return {
    ingest({ groupId, senderId, messageId, text, at = now() }) {
      if (!groupId || !senderId || !Number.isSafeInteger(messageId) || messageId <= 0 || !Number.isFinite(at) || at > now() + 60000 || at < now() - 86400000) return;
      const key = hash(salt + ':' + groupId + ':' + messageId); if (seen.has(key)) return;
      seen.set(key, at); const found = extractSocialCandidates(text);
      for (const [kind, values] of [['contract', found.addresses], ['url', found.urls]]) for (const value of values) {
        const key = kind + ':' + value, item = entries.get(key) || { kind, value, groups: new Map(), senders: new Map(), at };
        item.groups.set(hash(salt + ':' + groupId), at); item.senders.set(hash(salt + ':' + senderId), at); item.at = Math.max(item.at, at); entries.set(key, item);
      }
      for (const [id, at] of seen) if (at < now() - 86400000 || seen.size > 20000) seen.delete(id);
      while (entries.size > 1000) entries.delete(entries.keys().next().value);
    },
    snapshot() {
      const cutoff = now() - 86400000, candidates = [];
      for (const [key, item] of entries) {
        for (const [id, at] of item.groups) if (at < cutoff) item.groups.delete(id);
        for (const [id, at] of item.senders) if (at < cutoff) item.senders.delete(id);
        if (item.at < cutoff || !item.groups.size) { entries.delete(key); continue; }
        candidates.push({ kind: item.kind, value: item.value, groupCount: item.groups.size, senderCount: item.senders.size, observedAt: item.at });
      }
      return { version: 1, updatedAt: now(), candidates: candidates.slice(-200) };
    },
  };
}

// Social messages are untrusted discovery hints. Only the injected chain check
// may admit a contract; this function cannot send a transaction or sign anything.
export async function processSocialCandidates({ snapshot, verifyContract, fetchBytes, allowedGroupIds, now = Date.now } = {}) {
  if (snapshot?.version !== 1 || !Number.isFinite(snapshot.updatedAt) || snapshot.updatedAt > now() + 60000 || snapshot.updatedAt < now() - 300000 || !Array.isArray(snapshot.candidates) || typeof verifyContract !== 'function') return [];
  if (Array.isArray(allowedGroupIds) && snapshot.selectionHash !== socialSelectionHash(allowedGroupIds)) return [];
  const accepted = new Map(), seenAddresses = new Set(); let urlReads = 0, verifyAttempts = 0;
  const verify = async (address, item) => {
    if (!ADDRESS.test(address) || seenAddresses.has(address) || verifyAttempts >= 24) return;
    seenAddresses.add(address); verifyAttempts++;
    if (await verifyContract(address) === true) accepted.set(address, { address, source: item.kind === 'url' ? 'telegram-url' : 'telegram-contract', groupCount: item.groupCount, senderCount: item.senderCount, observedAt: item.observedAt });
  };
  for (const item of snapshot.candidates.slice(0, 200)) {
    if (verifyAttempts >= 24) break;
    if (!item || !Number.isInteger(item.groupCount) || !Number.isInteger(item.senderCount) || item.groupCount < 1 || item.groupCount > 1000 || item.senderCount < 1 || item.senderCount > 20000 || !Number.isFinite(item.observedAt) || item.observedAt < now() - 86400000 || item.observedAt > now() + 60000) continue;
    if (item.kind === 'contract' && item.groupCount >= 3 && typeof item.value === 'string') await verify(item.value.toLowerCase(), item);
    if (item.kind === 'url' && (item.groupCount >= 2 || item.senderCount >= 3) && urlReads < 6 && typeof fetchBytes === 'function') {
      const url = candidateUrl(item.value); if (!url) continue; urlReads++;
      try {
        const response = await fetchBytes(url, { kind: 'text', maxBytes: 262144, timeoutMs: 8000, maxRedirects: 2 });
        const text = response.body.toString('utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>|<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ');
        for (const address of extractSocialCandidates(text).addresses) await verify(address, item);
      } catch { /* Failed, private or oversized sites never become candidates. */ }
    }
  }
  return [...accepted.values()];
}
