import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reconcileScannerPending } from '../lib/scanner-recovery.mjs';
import { createWalletBudget } from '../lib/wallet-budget.mjs';
import { markWalletBlocked, walletExecutionView } from '../lib/wallet-executor.mjs';

const wallet = { id: 'wallet-verified', address: '0x1111111111111111111111111111111111111111' };
const target = '0x2222222222222222222222222222222222222222';
const txHash = '0x' + 'ab'.repeat(32), blockHash = '0x' + 'cd'.repeat(32);
const native = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const usdt = '0x55d398326f99059ff775485246999027b3197955';
const transfer = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const word = value => BigInt(value).toString(16).padStart(64, '0');
const topic = address => '0x' + address.slice(2).padStart(64, '0');

function harness({ tx = {}, receipt = {}, order, pending = {} } = {}) {
  const expected = { from: wallet.address, to: target, value: '100', inputData: '0x12345678' };
  const intent = { version: 1, walletId: wallet.id, walletAddress: wallet.address, kind: 'contract', txHash, amountWei: '100', expected, reservationId: 'saved-reservation', reservedAmountWei: '100', settlement: { successSpentWei: '100', failureSpentWei: '0' }, ...pending };
  const transaction = { hash: txHash, from: wallet.address, to: target, value: '0x64', input: '0x12345678', chainId: '0x38', blockNumber: '0x10', blockHash, ...tx };
  const proof = { transactionHash: txHash, blockHash, blockNumber: '0x10', status: '0x1', logs: [], ...receipt };
  const seen = { settled: [], cleared: [], commands: [] };
  const rpc = async method => method === 'eth_chainId' ? '0x38' : method === 'eth_getTransactionByHash' ? transaction : method === 'eth_getTransactionReceipt' ? proof : Promise.reject(new Error('Unexpected RPC'));
  const args = { wallet, pending: intent, root: '/never-used', rpc,
    budget: { async settle(id, result) { seen.settled.push({ id, spentWei: result.spentWei.toString(), ...(result.spentUsdMicros === undefined ? {} : { spentUsdMicros: result.spentUsdMicros.toString() }) }); } },
    async clearBlocked(profile, options) { seen.cleared.push({ walletId: profile.id, ...options }); },
    async runWallet(command, options) { seen.commands.push({ command, options }); return { success: true, data: { list: order ? [order] : [] } }; },
  };
  return { args, seen, intent, transaction, proof };
}

test('a confirmed contract settles its exact saved reservation before unblocking the same wallet reference', async () => {
  const h = harness(), result = await reconcileScannerPending(h.args);
  assert.equal(result.resolved, true); assert.equal(result.status, 'confirmed');
  assert.deepEqual(h.seen.settled, [{ id: 'saved-reservation', spentWei: '100' }]);
  assert.equal(h.seen.cleared[0].reference, txHash);
});

for (const [name, options] of [
  ['different sender', { tx: { from: target } }],
  ['different contract', { tx: { to: wallet.address } }],
  ['different native value', { tx: { value: '0x65' } }],
  ['different calldata', { tx: { input: '0x12345679' } }],
  ['different transaction hash', { tx: { hash: '0x' + 'ef'.repeat(32) } }],
  ['different receipt hash', { receipt: { transactionHash: '0x' + 'ef'.repeat(32) } }],
  ['different mined block', { receipt: { blockHash: '0x' + 'ef'.repeat(32) } }],
  ['different block number', { receipt: { blockNumber: '0x11' } }],
  ['different transaction chain', { tx: { chainId: '0x1' } }],
]) test(`${name} never releases an unresolved wallet or reserved funds`, async () => {
  const h = harness(options), result = await reconcileScannerPending(h.args);
  assert.equal(result.status, 'review'); assert.equal(result.resolved, false);
  assert.equal(h.seen.cleared.length, 0); assert.equal(h.seen.settled.length, 0);
});

test('no trusted hash or no mined receipt keeps the intent pending/review without guessing another transaction', async () => {
  for (const options of [{ pending: { txHash: undefined } }, { receipt: { blockNumber: undefined } }]) {
    const h = harness(options), result = await reconcileScannerPending(h.args);
    assert.equal(result.resolved, false); assert.equal(h.seen.cleared.length, 0); assert.equal(h.seen.settled.length, 0);
  }
});

test('a chain revert settles only the already confirmed earlier steps of a USDT workflow', async () => {
  const h = harness({ receipt: { status: '0x0' }, pending: { settlement: { successSpentWei: '100', failureSpentWei: '25' } } });
  const result = await reconcileScannerPending(h.args);
  assert.equal(result.status, 'reverted'); assert.equal(result.spentWei, '25');
  assert.equal(h.seen.settled[0].spentWei, '25');
});

function marketHarness(extra = {}) {
  const order = { orderId: 'trusted-order', chain: '56', fromToken: native, toToken: usdt, fromTokenQty: '0.0000000000000001', status: 'FINISHED', txHash };
  const logs = [{ address: usdt, topics: [transfer, topic(target), topic(wallet.address)], data: '0x' + word(50) }];
  return harness({ pending: { kind: 'market-order', orderId: 'trusted-order', expected: { fromToken: native, toToken: usdt, fromTokenQty: '0.0000000000000001' } }, order: { ...order, ...extra.order }, receipt: { logs, ...extra.receipt }, tx: extra.tx });
}

test('official market order, exact BNB spending and USDT receipt together allow recovery', async () => {
  const h = marketHarness(), result = await reconcileScannerPending(h.args);
  assert.equal(result.status, 'confirmed'); assert.equal(result.resolved, true);
  assert.equal(h.seen.commands[0].options.walletId, wallet.id);
  assert.equal(h.seen.cleared[0].reference, 'trusted-order');
});

for (const [name, extra] of [
  ['wrong token', { order: { toToken: target } }],
  ['wrong quantity', { order: { fromTokenQty: '0.0000000000000002' } }],
  ['wrong order chain', { order: { chain: '1' } }],
  ['missing receive proof', { receipt: { logs: [] } }],
  ['unrelated asset outflow', { receipt: { logs: [{ address: target, topics: [transfer, topic(wallet.address), topic(target)], data: '0x' + word(1) }] } }],
]) test(`market recovery rejects ${name} without changing allowance or wallet blocking`, async () => {
  const h = marketHarness(extra), result = await reconcileScannerPending(h.args);
  assert.equal(result.status, 'review'); assert.equal(h.seen.settled.length, 0); assert.equal(h.seen.cleared.length, 0);
});

test('recovery is idempotent against the actual durable budget and wallet journal after a restart', async () => {
  const root = mkdtempSync(join(tmpdir(), 'scanner-recovery-'));
  try {
    const config = { monitorOnly: false, paid: { maxBnbPerDay: 0.1 }, wallets: [wallet] };
    const initialBudget = createWalletBudget({ root });
    const allocation = await initialBudget.reserve({ wallet, config, amountWei: '100', legacySpent: {} });
    await markWalletBlocked(wallet, '链上结果待核对', { root, details: { source: 'scanner', txHash, reservationId: allocation.id } });
    const h = harness({ pending: { reservationId: allocation.id } });
    const args = { ...h.args, root, budget: createWalletBudget({ root }), clearBlocked: undefined };
    assert.equal((await reconcileScannerPending(args)).resolved, true);
    assert.equal((await reconcileScannerPending(args)).resolved, true);
    const view = await createWalletBudget({ root }).view(config);
    assert.equal(view.wallets[wallet.id].spentWei, '100'); assert.equal(view.wallets[wallet.id].reservedWei, '0');
    assert.equal(walletExecutionView(wallet, { root }).blocked, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const [type, calldata] of [
  ['approve', '0x095ea7b3' + target.slice(2).padStart(64, '0') + word(0)],
  ['permit2', '0x87517c45' + usdt.slice(2).padStart(64, '0') + target.slice(2).padStart(64, '0') + word(0) + word(123)],
  ['permit2', '0xcc53287f' + word(32) + word(1) + usdt.slice(2).padStart(64, '0') + target.slice(2).padStart(64, '0')],
]) test(`${type} exact single-spender zero-allowance revoke can recover after a restart`, async () => {
  const h = harness({ pending: { kind: 'approval', amountWei: '0', reservationId: undefined, reservedAmountWei: '0', settlement: { successSpentWei: '0', failureSpentWei: '0' }, expected: { token: usdt, spender: target, type, permit2ContractAddress: addressPermit2() } }, tx: { to: type === 'approve' ? usdt : addressPermit2(), value: '0x0', input: calldata } });
  assert.equal((await reconcileScannerPending(h.args)).resolved, true);
  assert.equal(h.seen.settled.length, 0); assert.equal(h.seen.cleared.length, 1);
});
function addressPermit2() { return '0x4444444444444444444444444444444444444444'; }

test('permit2 nonzero grants, extra asset/spender pairs and altered revoke targets never unlock', async () => {
  const pair = usdt.slice(2).padStart(64, '0') + target.slice(2).padStart(64, '0');
  for (const input of ['0x87517c45' + pair + word(1) + word(0), '0xcc53287f' + word(32) + word(2) + pair + pair, '0x095ea7b3' + pair]) {
    const h = harness({ pending: { kind: 'approval', amountWei: '0', reservationId: undefined, reservedAmountWei: '0', settlement: { successSpentWei: '0', failureSpentWei: '0' }, expected: { token: usdt, spender: target, type: 'permit2', permit2ContractAddress: addressPermit2() } }, tx: { to: addressPermit2(), value: '0x0', input } });
    assert.equal((await reconcileScannerPending(h.args)).status, 'review');
    assert.equal(h.seen.cleared.length, 0);
  }
});


test('confirmed and reverted scanner intents settle the exact saved USD reservation with the original transaction evidence', async () => {
  for (const [status, expected] of [['0x1', '20000000'], ['0x0', '7000000']]) {
    const h = harness({ receipt: { status }, pending: { reservedAmountUsdMicros: '20000000', settlement: { successSpentWei: '100', failureSpentWei: '25', successSpentUsdMicros: '20000000', failureSpentUsdMicros: '7000000' } } });
    const result = await reconcileScannerPending(h.args);
    assert.equal(result.resolved, true);
    assert.equal(h.seen.settled[0].spentUsdMicros, expected);
    assert.equal(h.seen.cleared[0].reference, txHash);
  }
});

test('incomplete, overspent or malformed USD recovery metadata cannot release an unknown intent', async () => {
  for (const patch of [
    { reservedAmountUsdMicros: '20000000' },
    { settlement: { successSpentWei: '100', failureSpentWei: '0', successSpentUsdMicros: '20000000' } },
    { reservedAmountUsdMicros: '20000000', settlement: { successSpentWei: '100', failureSpentWei: '0', successSpentUsdMicros: '21000000', failureSpentUsdMicros: '0' } },
    { reservedAmountUsdMicros: '20000000', settlement: { successSpentWei: '100', failureSpentWei: '0', successSpentUsdMicros: '10000000', failureSpentUsdMicros: '11000000' } },
    { reservedAmountUsdMicros: '-1', settlement: { successSpentWei: '100', failureSpentWei: '0', successSpentUsdMicros: '0', failureSpentUsdMicros: '0' } },
  ]) {
    const h = harness({ pending: patch });
    const result = await reconcileScannerPending(h.args);
    assert.equal(result.resolved, false); assert.equal(result.status, 'review');
    assert.equal(h.seen.settled.length, 0); assert.equal(h.seen.cleared.length, 0);
  }
  const unrelated = harness({ tx: { from: target }, pending: { reservedAmountUsdMicros: '20000000', settlement: { successSpentWei: '100', failureSpentWei: '0', successSpentUsdMicros: '20000000', failureSpentUsdMicros: '0' } } });
  assert.equal((await reconcileScannerPending(unrelated.args)).resolved, false);
  assert.equal(unrelated.seen.settled.length, 0);
});
