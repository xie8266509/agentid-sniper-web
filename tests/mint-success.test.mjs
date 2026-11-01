import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createMintSuccessStore } from '../lib/mint-success.mjs';
import { NFT_EVENT_TOPICS } from '../lib/nft-codec.mjs';

const A = '0x' + '1'.repeat(40), B = '0x' + '2'.repeat(40), PROJECT = '0x' + '3'.repeat(40), TOKEN = '0x' + '4'.repeat(40), NFT = '0x' + '5'.repeat(40), MULTI = '0x' + '6'.repeat(40), ZERO = '0x' + '0'.repeat(40);
const HASH = '0x' + 'a'.repeat(64), BLOCK = '0x' + 'b'.repeat(64), USDT = '0x55d398326f99059ff775485246999027b3197955', WBNB = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
const word = value => BigInt(value).toString(16).padStart(64, '0'), topic = address => '0x' + address.slice(2).padStart(64, '0');
const erc20 = (amount, from = ZERO, to = A, address = TOKEN) => ({ address, topics: [NFT_EVENT_TOPICS.ERC721_TRANSFER, topic(from), topic(to)], data: '0x' + word(amount) });
const erc721 = (id, from = ZERO, to = A) => ({ address: NFT, topics: [NFT_EVENT_TOPICS.ERC721_TRANSFER, topic(from), topic(to), '0x' + word(id)], data: '0x' });
const erc1155 = (id, amount, from = ZERO, to = A) => ({ address: MULTI, topics: [NFT_EVENT_TOPICS.ERC1155_TRANSFER_SINGLE, topic(PROJECT), topic(from), topic(to)], data: '0x' + word(id) + word(amount) });
function batch(ids, amounts) {
  return { address: MULTI, topics: [NFT_EVENT_TOPICS.ERC1155_TRANSFER_BATCH, topic(PROJECT), topic(ZERO), topic(A)], data: '0x' + [word(64), word(96 + 32 * ids.length), word(ids.length), ...ids.map(word), word(amounts.length), ...amounts.map(word)].join('') };
}
function proof(logs = [erc20(7)]) {
  return { wallet: { id: 'wallet-a', address: A },
    pending: { version: 1, walletId: 'wallet-a', walletAddress: A, kind: 'contract', txHash: HASH, mintContext: { version: 1, final: true, project: PROJECT, name: '真实项目' }, expected: { from: A, to: PROJECT, value: '0', inputData: '0x1249c58b' } },
    transaction: { hash: HASH, from: A, to: PROJECT, value: '0x0', input: '0x1249c58b', chainId: '0x38', blockHash: BLOCK, blockNumber: '0x100' },
    receipt: { transactionHash: HASH, from: A, to: PROJECT, status: '0x1', blockHash: BLOCK, blockNumber: '0x100', logs },
  };
}
function fixture(t, options = {}) {
  const root = fs.mkdtempSync(join(tmpdir(), 'agentid-mint-success-')); let now = Date.parse('2026-11-02T02:00:00Z');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createMintSuccessStore({ root, now: () => now, ...options });
  return { root, store, base: join(root, 'data', 'mint_success'), events: join(root, 'data', 'mint_success', 'events'), now: () => now, advance: ms => { now += ms; } };
}

test('constructor is read-only and the first summary atomically enables explicit since-enabled coverage', t => {
  const f = fixture(t); assert.equal(fs.existsSync(join(f.root, 'data')), false);
  const first = f.store.readSummary({ wallets: [proof().wallet] });
  assert.equal(first.available, true); assert.equal(first.coverage, 'since-enabled'); assert.equal(first.trackingSince, f.now());
  assert.deepEqual(first.wallets, [{ walletId: 'wallet-a', walletAddress: A, total: 0, today: 0 }]);
  f.advance(1000); assert.equal(createMintSuccessStore({ root: f.root, now: f.now }).readSummary({ wallets: [] }).trackingSince, first.trackingSince);
});

test('a verified mint counts one transaction and uses exact receipt asset gains rather than planned quantities', t => {
  const f = fixture(t), p = proof([erc20(10), erc20(3, A, B), erc721(0), erc1155(8, 3), batch([9, 10], [2, 4])]);
  p.pending.mintContext.quantity = 99999; p.pending.mintTracking = { receivedTokens: [B], quantity: 99999 };
  const record = f.store.recordConfirmed, result = record(p);
  assert.equal(result.recorded, true); assert.equal(result.event.id, '56:' + HASH); assert.equal(result.event.timeBasis, 'verified-at');
  assert.equal(result.event.confirmedAt, f.now()); assert.equal(result.event.blockNumber, '256');
  assert.deepEqual(result.event.assets, [
    { address: TOKEN, standard: 'ERC20', amountBaseUnits: '7' }, { address: NFT, standard: 'ERC721', tokenId: '0', amountBaseUnits: '1' },
    { address: MULTI, standard: 'ERC1155', tokenId: '10', amountBaseUnits: '4' }, { address: MULTI, standard: 'ERC1155', tokenId: '8', amountBaseUnits: '3' }, { address: MULTI, standard: 'ERC1155', tokenId: '9', amountBaseUnits: '2' },
  ]);
  const summary = f.store.readSummary({ wallets: [p.wallet] });
  assert.equal(summary.available, true); assert.equal(summary.wallets[0].total, 1); assert.equal(summary.wallets[0].today, 1); assert.equal(summary.recent.length, 1);
});

test('pre-minted inventory transfers into the minting wallet are valid positive net receipt evidence', t => {
  const f = fixture(t), p = proof([erc20(5, B), erc721(42, B), erc1155(12, 2, B)]);
  assert.equal(f.store.append(p).event.assets.length, 3);
});

for (const [label, mutate] of [
  ['another wallet ID', p => { p.pending.walletId = 'wallet-b'; }], ['another wallet address', p => { p.pending.walletAddress = B; }],
  ['another transaction hash', p => { p.transaction.hash = '0x' + 'c'.repeat(64); }], ['another receipt hash', p => { p.receipt.transactionHash = '0x' + 'c'.repeat(64); }],
  ['another chain', p => { p.transaction.chainId = '0x1'; }], ['missing chain', p => { delete p.transaction.chainId; }],
  ['failed receipt', p => { p.receipt.status = '0x0'; }], ['pending receipt', p => { delete p.receipt.blockNumber; }],
  ['another block hash', p => { p.receipt.blockHash = '0x' + 'c'.repeat(64); }], ['another block number', p => { p.receipt.blockNumber = '0x101'; }],
  ['another sender', p => { p.transaction.from = B; }], ['another expected sender', p => { p.pending.expected.from = B; }],
  ['another target', p => { p.transaction.to = B; }], ['another value', p => { p.transaction.value = '0x1'; }],
  ['another calldata', p => { p.transaction.input = '0xaaaaaaaa'; }], ['missing expected data', p => { delete p.pending.expected.inputData; }],
  ['unmarked contract', p => { delete p.pending.mintContext; }], ['nonfinal commit', p => { p.pending.mintContext.final = false; }],
  ['another context project', p => { p.pending.mintContext.project = B; }], ['a simulation', p => { p.pending.previewOnly = true; }],
  ['a swap job', p => { p.pending.kind = 'market-order'; }], ['an approval job', p => { p.pending.kind = 'approval'; }],
]) test(`${label} is never recorded as successful mint evidence`, t => {
  const f = fixture(t), p = proof(); mutate(p);
  assert.equal(f.store.recordConfirmed(p).recorded, false); assert.equal(fs.existsSync(f.base), false);
});

for (const selector of ['095ea7b3', 'a22cb465', 'a9059cbb', '23b872dd', '7ff36ab5', '38ed1739', '414bf389']) test(`non-mint selector ${selector} cannot be relabeled by a final descriptor`, t => {
  const f = fixture(t), p = proof(); p.pending.expected.inputData = p.transaction.input = '0x' + selector;
  assert.equal(f.store.recordConfirmed(p).reason, 'non-mint-call');
});

for (const [name, logs] of [
  ['no receipt gains', []], ['zero transfer', [erc20(0)]], ['self transfer', [erc20(5, A, A)]],
  ['net-zero token flow', [erc20(5), erc20(5, A, B)]], ['outgoing flow only', [erc20(5, A, B)]],
  ['minted NFT transferred away', [erc721(1), erc721(1, A, B)]],
  ['USDT refund', [erc20(5, ZERO, A, USDT)]], ['wrapped BNB refund', [erc20(5, ZERO, A, WBNB)]],
]) test(`${name} does not become a fabricated successful mint or zero quantity`, t => {
  const f = fixture(t), result = f.store.recordConfirmed(proof(logs)); assert.equal(result.recorded, false); assert.equal(result.reason, 'no-asset-gain');
});

test('custom payment assets, removed logs and malformed net-flow evidence cannot become mint income', t => {
  const f = fixture(t), p = proof(); p.pending.mintContext.paymentTokens = [TOKEN]; assert.equal(f.store.recordConfirmed(p).recorded, false);
  for (const logs of [[{ ...erc20(7), removed: true }], [erc20(7), { ...erc20(1, A, B), data: '0x' }], [{ ...erc20(7), transactionHash: '0x' + 'c'.repeat(64) }], [erc20(7), erc20(7)]]) assert.equal(f.store.recordConfirmed(proof(logs)).reason, 'invalid-asset-evidence');
});

test('same-hash duplicate confirmations remain one immutable event across store instances', t => {
  const f = fixture(t), p = proof(), first = f.store.recordConfirmed(p); f.advance(1000);
  const again = createMintSuccessStore({ root: f.root, now: f.now }).recordConfirmed(p);
  assert.equal(again.duplicate, true); assert.equal(again.recorded, false); assert.equal(again.event.recordedAt, first.event.recordedAt);
  assert.equal(fs.readdirSync(f.events).length, 1); assert.equal(f.store.readSummary({ wallets: [p.wallet] }).wallets[0].total, 1);
});

test('one transaction cannot be moved to a replacement wallet ID or changed address history', t => {
  const f = fixture(t), p = proof(); f.store.recordConfirmed(p);
  const summary = f.store.readSummary({ wallets: [{ id: 'replacement', address: A }, { id: p.wallet.id, address: B }] });
  assert.deepEqual(summary.wallets.map(row => [row.total, row.today]), [[0, 0], [0, 0]]); assert.equal(summary.recent.length, 0);
  p.wallet.id = p.pending.walletId = 'replacement';
  assert.throws(() => f.store.recordConfirmed(p), error => error.code === 'MINT_SUCCESS_STORAGE_ERROR');
  assert.equal(f.store.readSummary({ wallets: [{ id: 'wallet-a', address: A }] }).wallets[0].total, 1);
});

test('today uses explicit verification time and the requested timezone across a day boundary', t => {
  const f = fixture(t), p = proof(); f.store.recordConfirmed(p); f.advance(15 * 3600000);
  assert.equal(f.store.readSummary({ wallets: [p.wallet], timeZone: 'Asia/Shanghai' }).wallets[0].today, 0);
  assert.equal(f.store.readSummary({ wallets: [p.wallet], timeZone: 'UTC' }).wallets[0].today, 1);
});

test('future backfill without known historical confirmation time never fabricates today as zero', t => {
  const f = fixture(t), p = { ...proof(), source: 'backfill' }; const result = f.store.recordConfirmed(p);
  assert.equal(result.event.confirmedAt, null); assert.equal(result.event.timeBasis, 'unknown');
  const summary = f.store.readSummary({ wallets: [p.wallet] }); assert.equal(summary.wallets[0].total, 1); assert.equal(summary.wallets[0].today, null);
});

test('corrupt events or metadata and unreadable files yield unknown rather than a false zero', t => {
  const f = fixture(t), p = proof(); f.store.recordConfirmed(p);
  fs.writeFileSync(join(f.events, HASH + '.json'), '{bad-json');
  let summary = f.store.readSummary({ wallets: [p.wallet] }); assert.equal(summary.available, false); assert.equal(summary.wallets[0].total, null); assert.equal(summary.wallets[0].today, null);
  fs.unlinkSync(join(f.events, HASH + '.json')); fs.writeFileSync(join(f.base, 'tracking.json'), '{}');
  summary = f.store.readSummary({ wallets: [p.wallet] }); assert.equal(summary.available, false); assert.equal(summary.wallets[0].total, null);
  const unreadable = createMintSuccessStore({ root: f.root, fs: { openSync() { throw Error('https://PRIVATE?token=SECRET'); } } });
  const output = unreadable.readSummary({ wallets: [p.wallet] }); assert.equal(output.available, false); assert.doesNotMatch(JSON.stringify(output), /PRIVATE|SECRET/);
});

test('interrupted event writes expose no partial event and fixed storage errors disclose no paths', t => {
  const f = fixture(t), broken = createMintSuccessStore({ root: f.root, now: f.now, fs: { writeFileSync(path, data, options) {
    if (data.includes('"txHash"')) { fs.writeFileSync(path, '{partial', options); throw Error('SECRET path ' + path); }
    return fs.writeFileSync(path, data, options);
  } } });
  assert.throws(() => broken.recordConfirmed(proof()), error => error.code === 'MINT_SUCCESS_STORAGE_ERROR' && !/SECRET|agentid-mint-success/.test(error.message));
  const summary = f.store.readSummary({ wallets: [proof().wallet] }); assert.equal(summary.available, true); assert.equal(summary.wallets[0].total, 0); assert.equal(fs.readdirSync(f.events).length, 0);
});

test('event directories redirected through symlinks are refused before writing outside the store', t => {
  const f = fixture(t), outside = fs.mkdtempSync(join(tmpdir(), 'agentid-mint-outside-')); t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  f.store.readSummary({ wallets: [] }); fs.rmdirSync(f.events); fs.symlinkSync(outside, f.events);
  assert.throws(() => f.store.recordConfirmed(proof()), error => error.code === 'MINT_SUCCESS_STORAGE_ERROR');
  assert.equal(f.store.readSummary({ wallets: [proof().wallet] }).available, false); assert.deepEqual(fs.readdirSync(outside), []);
});

test('independent processes atomically deduplicate the same confirmed transaction', async t => {
  const f = fixture(t), moduleUrl = new URL('../lib/mint-success.mjs', import.meta.url).href, serialized = JSON.stringify(proof());
  const script = `import {createMintSuccessStore} from ${JSON.stringify(moduleUrl)}; const result=createMintSuccessStore({root:process.env.MINT_TEST_ROOT}).recordConfirmed(JSON.parse(process.env.MINT_TEST_PROOF)); process.stdout.write(JSON.stringify({recorded:result.recorded,duplicate:result.duplicate}));`;
  const runs = Array.from({ length: 6 }, () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, MINT_TEST_ROOT: f.root, MINT_TEST_PROOF: serialized }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errors = ''; child.stdout.on('data', part => { output += part; }); child.stderr.on('data', part => { errors += part; }); child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve(JSON.parse(output)) : reject(Error(errors)));
  }));
  const results = await Promise.all(runs); assert.equal(results.filter(result => result.recorded).length, 1); assert.equal(results.filter(result => result.duplicate).length, 5);
  assert.equal(fs.readdirSync(f.events).length, 1); assert.equal(f.store.readSummary({ wallets: [proof().wallet] }).wallets[0].total, 1);
});

test('summary returns at most the latest 50 verified events without changing transaction counts', t => {
  const f = fixture(t);
  for (let index = 1; index <= 55; index++) { const p = proof(); const hash = '0x' + word(index); p.pending.txHash = p.transaction.hash = p.receipt.transactionHash = hash; f.advance(1); assert.equal(f.store.recordConfirmed(p).recorded, true); }
  const summary = f.store.readSummary({ wallets: [proof().wallet] }); assert.equal(summary.wallets[0].total, 55); assert.equal(summary.recent.length, 50); assert.equal(summary.recent[0].txHash, '0x' + word(55));
});
