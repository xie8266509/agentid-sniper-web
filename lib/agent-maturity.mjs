const address = /^0x[0-9a-f]{40}$/;
const uint = value => typeof value === 'string' && /^0x[0-9a-f]+$/i.test(value) ? BigInt(value) : null;
const abi = value => typeof value === 'string' && /^0x[0-9a-f]{64}$/i.test(value) ? BigInt(value) : null;
const tag = value => '0x' + value.toString(16);

// A wallet must already hold an Agent ID at a real block at least 24 hours old.
// Archive-node errors never become proof of age. This deliberately also excludes
// recently transferred IDs, for which registration logs alone prove less.
export function createAgentMaturity({ rpc, rpcBatch, registry, now = Date.now } = {}) {
  const contract = registry?.startsWith('0x') ? registry.toLowerCase() : '0x' + registry;
  if (!address.test(contract || '')) throw new Error('Agent ID 注册合约无效');
  let anchor = null, anchorJob = null;
  async function oldBlock() {
    if (anchor && now() >= anchor.checkedAt && now() - anchor.checkedAt < 15 * 60000) return anchor;
    if (anchorJob) return anchorJob;
    anchorJob = (async () => {
      const latest = await rpc('eth_getBlockByNumber', ['latest', false]);
      const height = uint(latest?.number), timestamp = uint(latest?.timestamp), seconds = BigInt(Math.floor(now() / 1000));
      if (height === null || timestamp === null || timestamp < 86400n || timestamp > seconds + 60n || timestamp < seconds - 300n) throw new Error('无法核验 Agent ID 账龄的当前区块时间');
      const cutoff = timestamp - 86400n;
      let lo = 0n, hi = height, selected = null;
      for (let attempt = 0; lo <= hi && attempt < 64; attempt++) {
        const middle = (lo + hi) / 2n, block = await rpc('eth_getBlockByNumber', [tag(middle), false]);
        const number = uint(block?.number), time = uint(block?.timestamp);
        if (number !== middle || time === null || time > timestamp) throw new Error('无法核验 Agent ID 历史区块');
        if (time <= cutoff) { selected = { number: middle, timestamp: time }; lo = middle + 1n; } else hi = middle - 1n;
      }
      if (!selected || selected.timestamp > cutoff || lo <= hi) throw new Error('无法找到完整 24 小时前的 Agent ID 记录');
      anchor = { ...selected, checkedAt: now() }; return anchor;
    })().finally(() => { anchorJob = null; });
    return anchorJob;
  }
  return {
    async qualify(values) {
      const addresses = [...new Set(values.filter(value => typeof value === 'string' && address.test(value)).map(value => value.toLowerCase()))].slice(0, 800);
      if (!addresses.length) return new Set();
      const historical = await oldBlock();
      const requests = addresses.flatMap(owner => [
        { method: 'eth_call', params: [{ to: contract, data: '0x70a08231' + owner.slice(2).padStart(64, '0') }, tag(historical.number)] },
        { method: 'eth_call', params: [{ to: contract, data: '0x70a08231' + owner.slice(2).padStart(64, '0') }, 'latest'] },
        { method: 'eth_getTransactionCount', params: [owner, 'latest'] },
      ]);
      const results = await rpcBatch(requests), qualified = new Set();
      addresses.forEach((owner, index) => { const old = abi(results?.[index * 3]), current = abi(results?.[index * 3 + 1]), nonce = uint(results?.[index * 3 + 2]); if (old !== null && old > 0n && current !== null && current > 0n && nonce !== null && nonce >= 8n) qualified.add(owner); });
      return qualified;
    },
  };
}
