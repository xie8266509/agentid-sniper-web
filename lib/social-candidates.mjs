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
    ingest({ groupId, senderId, messageId, text, priority = false, at = now() }) {
      if (!groupId || !senderId || !Number.isSafeInteger(messageId) || messageId <= 0 || !Number.isFinite(at) || at > now() + 60000 || at < now() - 86400000) return;
      const key = hash(salt + ':' + groupId + ':' + messageId); if (seen.has(key)) return;
      seen.set(key, at); const found = extractSocialCandidates(text);
      for (const [kind, values] of [['contract', found.addresses], ['url', found.urls]]) for (const value of values) {
        const key = kind + ':' + value, item = entries.get(key) || { kind, value, groups: new Map(), senders: new Map(), at, firstAt: at };
        item.groups.set(hash(salt + ':' + groupId), at); item.senders.set(hash(salt + ':' + senderId), at); item.at = Math.max(item.at, at); if (priority === true) item.priorityAt = at; entries.set(key, item);
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
        candidates.push({ kind: item.kind, value: item.value, groupCount: item.groups.size, senderCount: item.senders.size, observedAt: item.at, firstObservedAt: item.firstAt, ...(item.priorityAt >= cutoff ? { priority: true } : {}) });
      }
      return { version: 1, updatedAt: now(), candidates: candidates.slice(-200) };
    },
  };
}

// Social messages are untrusted discovery hints. Only the injected chain check
// may admit a contract; this function cannot send a transaction or sign anything.
export async function processSocialCandidates({ snapshot, verifyContract, fetchBytes, allowedGroupIds, vipGroupIds = [], discoveryState = {}, findNameHints, onNameHints, isCurrent = () => true, now = Date.now } = {}) {
  const clock = now();
  const active = () => { try { return isCurrent() === true; } catch { return false; } };
  if (!active()) return [];
  if (snapshot?.version !== 1 || !Number.isFinite(snapshot.updatedAt) || snapshot.updatedAt > clock + 60000 || snapshot.updatedAt < clock - 300000 || !Array.isArray(snapshot.candidates) || typeof verifyContract !== 'function') return [];
  if (Array.isArray(allowedGroupIds) && snapshot.selectionHash !== socialSelectionHash(allowedGroupIds)) return [];
  const priorityAllowed = Array.isArray(allowedGroupIds) && vipGroupIds.length > 0 && vipGroupIds.every(id => allowedGroupIds.includes(id)) && snapshot.vipSelectionHash === socialSelectionHash(vipGroupIds);
  const scope = snapshot.selectionHash + ':' + (snapshot.vipSelectionHash || '');
  if (discoveryState.scope !== scope || !discoveryState.entries || typeof discoveryState.entries !== 'object' || Array.isArray(discoveryState.entries)) { discoveryState.scope = scope; discoveryState.entries = {}; }
  const entries = discoveryState.entries;
  const hour = Math.floor(clock / 3600000);
  if (!discoveryState.vipHour || discoveryState.vipHour.hour !== hour) discoveryState.vipHour = { hour, keys: [] };
  const quota = discoveryState.vipHour;
  if (!Array.isArray(quota.keys) || quota.keys.length > 30 || quota.keys.some(k => typeof k !== 'string' || !/^[a-f0-9]{64}$/.test(k))) quota.keys = Array(30).fill('blocked');
  const vipPermit = key => { if (quota.keys.includes(key)) return true; if (quota.keys.length >= 30) return false; quota.keys.push(key); return true; };
  const accepted = new Map(), seenAddresses = new Set(); let urlReads = 0, verifyAttempts = 0;
  const verify = async (address, item, hintOnly = false) => {
    if (!active() || !ADDRESS.test(address) || seenAddresses.has(address) || verifyAttempts >= 24 || !hintOnly && accepted.size >= 24) return false;
    seenAddresses.add(address);
    const key = hash('contract:' + address), previous = entries[key];
    let verified = false;
    if (previous && Number.isFinite(previous.checkedAt) && previous.checkedAt <= clock && clock - previous.checkedAt < 120000) verified = previous.verified === true;
    else {
      verifyAttempts++;
      try { verified = await verifyContract(address) === true && active(); } catch { verified = false; }
      entries[key] = { checkedAt: clock, verified, touchedAt: clock };
    }
    if (verified && !hintOnly) accepted.set(address, { address, source: item.kind === 'url' ? 'telegram-url' : 'telegram-contract', groupCount: item.groupCount, senderCount: item.senderCount, observedAt: item.observedAt, priority: item.priority === true && priorityAllowed });
    return verified;
  };
  for (const item of snapshot.candidates.slice(0, 200)) {
    if (!active() || verifyAttempts >= 24 || accepted.size >= 24) break;
    if (!item || !Number.isInteger(item.groupCount) || !Number.isInteger(item.senderCount) || item.groupCount < 1 || item.groupCount > 1000 || item.senderCount < 1 || item.senderCount > 20000 || !Number.isFinite(item.observedAt) || item.observedAt < clock - 86400000 || item.observedAt > clock + 60000) continue;
    const normal = item.kind === 'contract' ? item.groupCount >= 3 : item.kind === 'url' && (item.groupCount >= 2 || item.senderCount >= 3);
    const value = item.kind === 'url' ? candidateUrl(item.value) : typeof item.value === 'string' && ADDRESS.test(item.value) ? item.value.toLowerCase() : null;
    if (!value || !['contract', 'url'].includes(item.kind)) continue;
    const key = hash(item.kind + ':' + value);
    if (!normal && !(priorityAllowed && item.priority === true && vipPermit(key))) continue;
    if (item.kind === 'contract') { await verify(value, item); continue; }
    if (typeof fetchBytes !== 'function') continue;
    let record = entries[key];
    if (record?.foundAddresses?.length) { for (const address of record.foundAddresses.slice(0, 24)) await verify(address, item); continue; }
    if (!record || !Number.isFinite(record.firstAt)) record = entries[key] = { firstAt: clock, touchedAt: clock };
    if (clock < record.firstAt || clock - record.firstAt >= 7200000 || Number.isFinite(record.lastAttemptAt) && clock - record.lastAttemptAt < 120000 || urlReads >= 6) continue;
    record.lastAttemptAt = clock; record.touchedAt = clock; urlReads++;
    try {
      const response = await fetchBytes(value, { kind: 'text', maxBytes: 262144, timeoutMs: 8000, maxRedirects: 2 });
      if (!active()) break;
      const text = response.body.toString('utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>|<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ');
      let addresses = extractSocialCandidates(text).addresses;
      // Probe a small fixed set of read-only, same-origin metadata routes. All
      // requests share the six-read pass budget and the safe network adapter.
      if (!addresses.length) for (const path of ['/api/stats', '/api/config', '/deployment.json']) {
        if (!active() || urlReads >= 6) break; urlReads++;
        try { const metadata = await fetchBytes(new URL(path, value).href, { kind: 'text', maxBytes: 262144, timeoutMs: 8000, maxRedirects: 2 }); addresses = extractSocialCandidates(metadata.body.toString('utf8')).addresses; } catch {}
        if (addresses.length) break;
      }
      if (!active()) break;
      if (addresses.length) { record.foundAddresses = addresses; for (const address of addresses) await verify(address, item); }
      else if (typeof findNameHints === 'function' && typeof onNameHints === 'function') {
        const title = (text.match(/<title[^>]*>([^<]{1,100})/i)?.[1] || '').trim();
        const guesses = await findNameHints({ title, host: new URL(value).hostname });
        const hints = [];
        for (const address of Array.isArray(guesses) ? guesses.slice(0, 3) : []) if (typeof address === 'string' && await verify(address.toLowerCase(), item, true)) hints.push(address.toLowerCase());
        // A matching name is not proof that the website owns this contract.
        // These candidates are notification-only and never enter accepted.
        const fresh = hints.filter(address => !record.hintedAddresses?.includes(address));
        if (fresh.length && active()) { await onNameHints({ host: new URL(value).hostname, addresses: fresh }); record.hintedAddresses = [...new Set([...(record.hintedAddresses || []), ...fresh])].slice(0, 3); }
      }
    } catch { /* Failed, private or oversized sites never become candidates. */ }
  }
  for (const [key, entry] of Object.entries(entries)) if (!entry || !Number.isFinite(entry.touchedAt) || entry.touchedAt < clock - 86400000) delete entries[key];
  const names = Object.keys(entries); for (const key of names.slice(0, Math.max(0, names.length - 600))) delete entries[key];
  return active() ? [...accepted.values()] : [];
}
