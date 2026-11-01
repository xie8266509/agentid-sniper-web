import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { decodeAbiUint, decodeAbiString, decodeNftTransfers, NFT_EVENT_TOPICS, NFT_CODEC_LIMITS } from '../lib/nft-codec.mjs';

const wallet = '0x1111111111111111111111111111111111111111';
const other = '0x2222222222222222222222222222222222222222';
const contract = '0x3333333333333333333333333333333333333333';
const zero = '0x' + '0'.repeat(40);
const maxUint = (1n << 256n) - 1n;
const word = (value) => BigInt(value).toString(16).padStart(64, '0');
const addressWord = (value) => '0x' + value.slice(2).padStart(64, '0');
const signatures = {
  ERC721_TRANSFER: 'Transfer(address,address,uint256)',
  ERC1155_TRANSFER_SINGLE: 'TransferSingle(address,address,address,uint256,uint256)',
  ERC1155_TRANSFER_BATCH: 'TransferBatch(address,address,address,uint256[],uint256[])',
};
const change = (standard, tokenId, delta) => ({ addr: contract, standard, tokenId: String(tokenId), delta: String(delta) });
const erc721 = (from, to, id, extra = {}) => ({ address: contract, topics: [NFT_EVENT_TOPICS.ERC721_TRANSFER, addressWord(from), addressWord(to), '0x' + word(id)], data: '0x', ...extra });
const single = (from, to, id, value, extra = {}) => ({ address: contract, topics: [NFT_EVENT_TOPICS.ERC1155_TRANSFER_SINGLE, addressWord(other), addressWord(from), addressWord(to)], data: '0x' + word(id) + word(value), ...extra });
function batch(from, to, ids, values, { reversed = false, ...extra } = {}) {
  const idArray = word(ids.length) + ids.map(word).join(''), valueArray = word(values.length) + values.map(word).join('');
  const data = reversed ? word(64 + valueArray.length / 2) + word(64) + valueArray + idArray : word(64) + word(64 + idArray.length / 2) + idArray + valueArray;
  return { address: contract, topics: [NFT_EVENT_TOPICS.ERC1155_TRANSFER_BATCH, addressWord(other), addressWord(from), addressWord(to)], data: '0x' + data, ...extra };
}
function abiStringFromHex(hex) { return '0x' + word(32) + word(hex.length / 2) + hex.padEnd(Math.ceil(hex.length / 64) * 64, '0'); }
const abiString = (value) => abiStringFromHex(Buffer.from(value, 'utf8').toString('hex'));

test('frozen event topics match the official ERC signatures through the existing pure keccak implementation', () => {
  // This independently hashes the event signatures without importing data's
  // optional @noble/hashes installation or executing watch.mjs/main().
  const watch = readFileSync(new URL('../watch.mjs', import.meta.url), 'utf8');
  const keccakSource = watch.slice(watch.indexOf('const KRC ='), watch.indexOf('const DEPLOYERS ='));
  const keccakHex = vm.runInNewContext(keccakSource + '\nkeccakHex;', { Buffer }, { timeout: 1000 });
  for (const [key, signature] of Object.entries(signatures)) assert.equal(NFT_EVENT_TOPICS[key], '0x' + keccakHex(Buffer.from(signature, 'utf8').toString('hex')));
  assert.equal(Object.isFrozen(NFT_EVENT_TOPICS), true);
});

test('ABI uint decoding preserves exact zero and uint256 maximum and rejects incomplete words', () => {
  assert.equal(decodeAbiUint('0x' + word(0)), 0n);
  assert.equal(decodeAbiUint('0x' + word(maxUint)), maxUint);
  assert.equal(decodeAbiUint('0x' + word(123456789012345678901234567890n)), 123456789012345678901234567890n);
  for (const invalid of [undefined, null, 0, {}, '', '0x', '0x0', '0x' + 'f'.repeat(63), '0x' + 'f'.repeat(65), '0x' + 'z'.repeat(64), '0x' + word(1) + word(2)]) assert.equal(decodeAbiUint(invalid), null);
});

test('ABI strings decode dynamic UTF-8 and bytes32 metadata without replacement characters', () => {
  for (const value of ['', 'Agent NFT', '链上身份 🪪', '<script>literal metadata</script>']) assert.equal(decodeAbiString(abiString(value)), value);
  assert.equal(decodeAbiString('0x' + Buffer.from('AGENT', 'utf8').toString('hex').padEnd(64, '0')), 'AGENT');
  assert.equal(decodeAbiString('0x' + Buffer.from('身份', 'utf8').toString('hex').padEnd(64, '0')), '身份');
  assert.equal(decodeAbiString('0x' + '41'.repeat(32)), 'A'.repeat(32));
  assert.equal(decodeAbiString('0x' + '00'.repeat(32)), '');
});

test('ABI strings reject invalid UTF-8, offsets, lengths, padding and oversized input', () => {
  const invalid = [undefined, null, 1, {}, '', '0x', '0x0', '0xzz', '0x' + word(0) + word(0), '0x' + word(33) + word(0), '0x' + word(maxUint) + word(0), '0x' + word(32) + word(maxUint), abiStringFromHex('c328'), '0x' + 'c0af'.padEnd(64, '0'), '0x' + '410042'.padEnd(64, '0'), '0x' + word(32) + word(1) + '61' + '01'.repeat(31), abiString('truncated').slice(0, -2), abiString('x'.repeat(NFT_CODEC_LIMITS.maxStringBytes + 1)), '0x' + '00'.repeat(NFT_CODEC_LIMITS.maxAbiBytes + 1)];
  for (const value of invalid) assert.equal(decodeAbiString(value), '');
});

test('ERC721 transfers aggregate incoming/outgoing deltas and retain zero-net and self-transfer IDs', () => {
  const logs = [erc721(zero, wallet, 7), erc721(wallet, other, 7), erc721(wallet, wallet, 9), erc721(other, wallet, maxUint), erc721(other, zero, 100), erc721(wallet, zero, 12)];
  const before = structuredClone(logs);
  assert.deepEqual(decodeNftTransfers(logs, wallet.toUpperCase().replace('0X', '0x')), [change('ERC721', 7, 0), change('ERC721', 9, 0), change('ERC721', maxUint, 1), change('ERC721', 12, -1)]);
  assert.deepEqual(logs, before);
});

test('ERC20-like Transfer logs, removed events and malformed indexed addresses do not become NFTs', () => {
  const valid = erc721(zero, wallet, 5);
  const logs = [null, {}, { ...valid, topics: valid.topics.slice(0, 3), data: '0x' + word(5) }, { ...valid, removed: true }, { ...valid, topics: [valid.topics[0], '0x' + '1'.repeat(24) + other.slice(2), valid.topics[2], valid.topics[3]] }, { ...valid, topics: [...valid.topics, '0x' + word(1)] }, { ...valid, topics: [...valid.topics.slice(0, 3), '0x1234'] }, { ...valid, data: '0x' + word(0) }, { ...valid, address: 'not-an-address' }, valid];
  assert.deepEqual(decodeNftTransfers(logs, wallet), [change('ERC721', 5, 1)]);
});

test('ERC1155 TransferSingle supports mint, burn, zero amounts and self transfer', () => {
  const logs = [single(zero, wallet, 4, 10), single(wallet, zero, 4, 3), single(wallet, wallet, 8, maxUint), single(other, wallet, 9, 0), single(other, zero, 10, 3)];
  assert.deepEqual(decodeNftTransfers(logs, wallet), [change('ERC1155', 4, 7), change('ERC1155', 8, 0), change('ERC1155', 9, 0)]);
});

test('ERC1155 TransferBatch resolves dynamic offsets, aggregates duplicates and preserves zero-net IDs', () => {
  const logs = [batch(zero, wallet, [1, 1, maxUint], [2, 3, 7]), batch(wallet, other, [1, maxUint], [5, 1], { reversed: true }), batch(wallet, wallet, [99], [100]), batch(other, wallet, [17], [0])];
  assert.deepEqual(decodeNftTransfers(logs, wallet), [change('ERC1155', 1, 0), change('ERC1155', maxUint, 6), change('ERC1155', 99, 0), change('ERC1155', 17, 0)]);
  assert.deepEqual(decodeNftTransfers([batch(other, wallet, [], [])], wallet), []);
});

test('malformed ERC1155 arrays are rejected atomically and do not hide later valid logs', () => {
  const valid = batch(other, wallet, [1, 2], [3, 4]);
  const replaceWord = (data, index, value) => data.slice(0, 2 + index * 64) + word(value) + data.slice(2 + (index + 1) * 64);
  const badLogs = [
    { ...valid, data: replaceWord(valid.data, 0, 0) },
    { ...valid, data: replaceWord(valid.data, 0, 65) },
    { ...valid, data: replaceWord(valid.data, 0, maxUint) },
    { ...valid, data: replaceWord(valid.data, 1, 64) },
    { ...valid, data: valid.data.slice(0, -64) },
    batch(other, wallet, [1, 2], [3]),
    { ...valid, data: replaceWord(valid.data, 2, NFT_CODEC_LIMITS.maxBatchItems + 1) },
    single(other, wallet, 1, 5, { data: '0x' + word(1) }),
    { ...valid, data: '0x' + '00'.repeat(NFT_CODEC_LIMITS.maxAbiBytes + 1) },
  ];
  assert.deepEqual(decodeNftTransfers(badLogs, wallet), []);
  assert.deepEqual(decodeNftTransfers([...badLogs, valid], wallet), [change('ERC1155', 1, 3), change('ERC1155', 2, 4)]);
});

test('standards are kept separate and output contract addresses are normalized', () => {
  const mixed = [erc721(zero, wallet, 7, { address: contract.toUpperCase().replace('0X', '0x') }), single(zero, wallet, 7, 5)];
  assert.deepEqual(decodeNftTransfers(mixed, wallet), [change('ERC721', 7, 1), change('ERC1155', 7, 5)]);
  for (const invalid of [null, {}, 'not-an-array']) assert.deepEqual(decodeNftTransfers(invalid, wallet), []);
  for (const invalid of [null, '', '0x123', zero]) assert.deepEqual(decodeNftTransfers(mixed, invalid), []);
});

test('batch, log and total decoded-item limits bound hostile histories', () => {
  const ids = Array.from({ length: NFT_CODEC_LIMITS.maxBatchItems }, (_, index) => index);
  const atLimit = batch(other, wallet, ids, ids.map(() => 1));
  assert.equal(decodeNftTransfers([atLimit], wallet).length, NFT_CODEC_LIMITS.maxBatchItems);
  assert.deepEqual(decodeNftTransfers([batch(other, wallet, [...ids, 10000], [...ids.map(() => 1), 1])], wallet), []);
  const logLimit = Array.from({ length: NFT_CODEC_LIMITS.maxLogs }, () => erc721(zero, wallet, 1));
  assert.deepEqual(decodeNftTransfers([...logLimit, erc721(zero, wallet, 2)], wallet), [change('ERC721', 1, NFT_CODEC_LIMITS.maxLogs)]);
  const repeated = Array.from({ length: Math.ceil(NFT_CODEC_LIMITS.maxChanges / ids.length) + 1 }, () => atLimit);
  const changes = decodeNftTransfers(repeated, wallet);
  assert.equal(changes.length, ids.length);
  assert.equal(changes[0].delta, String(Math.floor(NFT_CODEC_LIMITS.maxChanges / ids.length)));
});
