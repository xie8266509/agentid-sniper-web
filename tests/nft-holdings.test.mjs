import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createNftInventory } from '../lib/nft-holdings.mjs';
import { NFT_EVENT_TOPICS } from '../lib/nft-codec.mjs';

const A = '0x1111111111111111111111111111111111111111';
const B = '0x2222222222222222222222222222222222222222';
const C = '0x3333333333333333333333333333333333333333';
const HASH = '0x' + 'a'.repeat(64);
const word = (n) => BigInt(n).toString(16).padStart(64, '0');
const uint = (n) => '0x' + word(n);
const addressTopic = (a) => '0x' + a.slice(2).padStart(64, '0');
function abiString(text) {
  const hex = Buffer.from(text).toString('hex');
  return '0x' + word(32) + word(hex.length / 2) + hex.padEnd(Math.ceil(hex.length / 64) * 64, '0');
}
const input = (wallets = [{ name: '主钱包', address: A }]) => ({ state: { nftCols: { [C]: 1 } }, config: { wallets } });
function mockRpc({ standard = 'ERC721', balances = { [A]: 2n }, receipt, failBalance = () => false } = {}) {
  const seen = [];
  const rpc = async (method, params) => {
    seen.push({ method, params });
    if (method === 'eth_getTransactionReceipt') return receipt || null;
    assert.equal(method, 'eth_call');
    const data = params[0].data;
    if (data.startsWith('0x01ffc9a7')) return uint(data.slice(10, 18) === (standard === 'ERC721' ? '80ac58cd' : 'd9b67a26') ? 1 : 0);
    if (data === '0x06fdde03') return abiString('实际 NFT');
    if (data === '0x95d89b41') return abiString('NFT');
    if (data.startsWith('0x70a08231') || data.startsWith('0x00fdd58e')) {
      if (failBalance()) throw new Error('RPC unavailable');
      const address = '0x' + data.slice(34, 74);
      return uint(balances[address] || 0n);
    }
    throw new Error('Unexpected mocked selector ' + data);
  };
  return { rpc, seen };
}

test('NFT registry is shown immediately and ERC721 ownership is verified per wallet', async () => {
  const mock = mockRpc({ balances: { [A]: 2n, [B]: 0n } });
  const inventory = createNftInventory({ rpc: mock.rpc });
  const args = input([{ name: '主钱包', address: A }, { name: '次钱包', address: B }]);
  const first = inventory.snapshot(args);
  assert.equal(first.nfts.length, 2);
  assert.equal(first.nftSync.loading, true);
  assert.equal(first.nfts[0].quantity, null);
  await inventory.whenIdle();
  const result = inventory.snapshot(args);
  assert.equal(result.nftSync.verified, 2);
  assert.equal(result.nfts[0].quantity, '2');
  assert.equal(result.nfts[0].name, '实际 NFT');
  assert.equal(result.nfts[1].quantity, '0');
  assert.equal(result.nfts[1].status, 'zero');
  assert.equal(mock.seen.filter((r) => r.method === 'eth_call' && r.params[0].data.startsWith('0x01ffc9a7')).length, 1);
});

test('automatic polling uses cached balances and manual refresh actually rechecks', async () => {
  let timestamp = 1000;
  const mock = mockRpc(), inventory = createNftInventory({ rpc: mock.rpc, now: () => timestamp });
  inventory.snapshot(input()); await inventory.whenIdle();
  const count = mock.seen.length;
  for (let i = 0; i < 5; i++) inventory.snapshot(input());
  assert.equal(mock.seen.length, count);
  inventory.snapshot({ ...input(), force: true }); await inventory.whenIdle();
  assert.ok(mock.seen.length > count);
  const nextCount = mock.seen.length;
  timestamp += 91000;
  inventory.snapshot(input()); await inventory.whenIdle();
  assert.ok(mock.seen.length > nextCount);
});

test('RPC failure is not reported as a zero NFT balance and recovery clears the error', async () => {
  let failing = true, timestamp = 1000;
  const mock = mockRpc({ failBalance: () => failing });
  const inventory = createNftInventory({ rpc: mock.rpc, now: () => timestamp });
  inventory.snapshot(input()); await inventory.whenIdle();
  const bad = inventory.snapshot(input());
  assert.equal(bad.nfts[0].status, 'error');
  assert.equal(bad.nfts[0].quantity, null);
  failing = false; timestamp += 1;
  inventory.snapshot({ ...input(), force: true }); await inventory.whenIdle();
  const recovered = inventory.snapshot(input());
  assert.equal(recovered.nfts[0].status, 'held');
  assert.equal(recovered.nfts[0].error, undefined);
});

test('ERC1155 IDs come from a successful receipt and balances use the two-argument method', async () => {
  const receipt = { status: '0x1', logs: [{ address: C, topics: [NFT_EVENT_TOPICS.ERC1155_TRANSFER_SINGLE, addressTopic(A), addressTopic('0x' + '0'.repeat(40)), addressTopic(A)], data: uint(7) + word(3) }] };
  const mock = mockRpc({ standard: 'ERC1155', balances: { [A]: 3n }, receipt });
  const inventory = createNftInventory({ rpc: mock.rpc, logLines: () => [`[主钱包] ${C} 已自動鑄造 mint() 交易 ${HASH}`] });
  inventory.snapshot(input()); await inventory.whenIdle();
  const nft = inventory.snapshot(input()).nfts[0];
  assert.equal(nft.standard, 'ERC1155');
  assert.equal(nft.quantity, '3');
  assert.deepEqual(nft.tokenIds, ['7']);
  assert.equal(nft.ownedTokenId, '7');
  assert.equal(nft.idsComplete, false);
  assert.ok(mock.seen.some((r) => r.method === 'eth_call' && r.params[0].data.endsWith(word(7))));
});

test('ERC1155 without known IDs stays unverified instead of inventing an ID or a zero', async () => {
  const mock = mockRpc({ standard: 'ERC1155' });
  const inventory = createNftInventory({ rpc: mock.rpc });
  inventory.snapshot(input()); await inventory.whenIdle();
  const nft = inventory.snapshot(input()).nfts[0];
  assert.equal(nft.status, 'unverified');
  assert.equal(nft.quantity, null);
  assert.equal(mock.seen.some((r) => r.method === 'eth_call' && r.params[0].data.startsWith('0x00fdd58e')), false);
});

test('nonstandard ERC721 requires both a receipt event and current ownerOf proof', async () => {
  const receipt = { status: '0x1', logs: [{ address: C, topics: [NFT_EVENT_TOPICS.ERC721_TRANSFER, addressTopic('0x' + '0'.repeat(40)), addressTopic(A), uint(1367)], data: '0x' }] };
  const base = mockRpc({ receipt });
  let ownerMatches = true;
  const rpc = async (method, params) => {
    if (method === 'eth_call' && params[0].data.startsWith('0x01ffc9a7')) throw new Error('execution reverted');
    if (method === 'eth_call' && params[0].data.startsWith('0x6352211e')) return addressTopic(ownerMatches ? A : B);
    return base.rpc(method, params);
  };
  const logLines = () => [`${C} 已自動鑄造 mint() 交易 ${HASH}`];
  const inventory = createNftInventory({ rpc, logLines });
  inventory.snapshot(input()); await inventory.whenIdle();
  const nft = inventory.snapshot(input()).nfts[0];
  assert.equal(nft.quantity, '2');
  assert.equal(nft.standard, 'ERC721');
  assert.equal(nft.standardInferred, true);
  assert.deepEqual(nft.tokenIds, ['1367']);
  assert.equal(nft.ownedTokenId, '1367');
  assert.deepEqual(nft.sourceTransactions, [HASH]);
  ownerMatches = false;
  const unmatched = createNftInventory({ rpc, logLines });
  unmatched.snapshot(input()); await unmatched.whenIdle();
  assert.equal(unmatched.snapshot(input()).nfts[0].quantity, null);
  assert.equal(unmatched.snapshot(input()).nfts[0].status, 'error');
});

test('ERC721 listing ID is verified with ownerOf, and cleared after transfer', async () => {
  let held = true;
  const receipt = { status: '0x1', logs: [{ address: C, topics: [NFT_EVENT_TOPICS.ERC721_TRANSFER, addressTopic(B), addressTopic(A), uint(0)], data: '0x' }] };
  const base = mockRpc({ receipt, balances: { [A]: 1n } });
  const rpc = async (method, params) => {
    if (method === 'eth_call' && params[0].data.startsWith('0x6352211e')) return addressTopic(held ? A : B);
    return base.rpc(method, params);
  };
  // The transaction target is a factory, but receipt emitter is the NFT.
  const inventory = createNftInventory({ rpc, logLines: () => [`${B} 已自動鑄造 mint() ${HASH}`] });
  inventory.snapshot(input()); await inventory.whenIdle();
  assert.equal(inventory.snapshot(input()).nfts[0].ownedTokenId, '0');
  held = false;
  inventory.snapshot({ ...input(), force: true }); await inventory.whenIdle();
  const result = inventory.snapshot(input()).nfts[0];
  assert.equal(result.ownedTokenId, null);
  assert.equal(result.quantity, '1');
});

test('a later factory mint discovers the new owned ID even when a transferred ID was cached', async () => {
  let generation = 1;
  const secondHash = '0x' + 'b'.repeat(64), base = mockRpc({ balances: { [A]: 1n } });
  const rpc = async (method, params) => {
    if (method === 'eth_getTransactionReceipt') return { status: '0x1', logs: [{ address: C, topics: [NFT_EVENT_TOPICS.ERC721_TRANSFER, addressTopic(B), addressTopic(A), uint(params[0] === HASH ? 1 : 2)], data: '0x' }] };
    if (method === 'eth_call' && params[0].data.startsWith('0x6352211e')) return addressTopic(BigInt('0x' + params[0].data.slice(10)) === BigInt(generation) ? A : B);
    return base.rpc(method, params);
  };
  const inventory = createNftInventory({ rpc, logLines: () => generation === 1 ? [`${C} 已自動鑄造 ${HASH}`] : [`${C} 已自動鑄造 ${HASH}`, `${B} 已自動鑄造 ${secondHash}`] });
  inventory.snapshot(input()); await inventory.whenIdle();
  assert.equal(inventory.snapshot(input()).nfts[0].ownedTokenId, '1');
  generation = 2;
  inventory.snapshot({ ...input(), force: true }); await inventory.whenIdle();
  assert.equal(inventory.snapshot(input()).nfts[0].ownedTokenId, '2');
});

test('legacy ERC721 factory receipt still requires current ownership proof', async () => {
  const base = mockRpc();
  const rpc = async (method, params) => {
    if (method === 'eth_getTransactionReceipt') return { status: '0x1', logs: [{ address: C, topics: [NFT_EVENT_TOPICS.ERC721_TRANSFER, addressTopic(B), addressTopic(A), uint(12)], data: '0x' }] };
    if (method === 'eth_call' && params[0].data.startsWith('0x01ffc9a7')) throw new Error('execution reverted');
    if (method === 'eth_call' && params[0].data.startsWith('0x6352211e')) return addressTopic(A);
    return base.rpc(method, params);
  };
  const inventory = createNftInventory({ rpc, logLines: () => [`${B} 已自動鑄造 ${HASH}`] });
  inventory.snapshot(input()); await inventory.whenIdle();
  const nft = inventory.snapshot(input()).nfts[0];
  assert.equal(nft.standardInferred, true); assert.equal(nft.ownedTokenId, '12');
});

test('renaming a configured wallet changes its label without mixing balances or refetching', async () => {
  const mock = mockRpc(), inventory = createNftInventory({ rpc: mock.rpc });
  inventory.snapshot(input()); await inventory.whenIdle();
  const count = mock.seen.length;
  const renamed = inventory.snapshot(input([{ name: '新名字', address: A }]));
  assert.equal(renamed.nfts[0].wallet, '新名字');
  assert.equal(renamed.nfts[0].quantity, '2');
  assert.equal(mock.seen.length, count);
});

test('registry entries are not fabricated when no wallet is configured', async () => {
  const mock = mockRpc(), inventory = createNftInventory({ rpc: mock.rpc });
  assert.deepEqual(inventory.snapshot(input([])).nfts, []);
  assert.equal(mock.seen.length, 0);
});
