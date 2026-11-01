import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { reconcileScannerPending } from '../lib/scanner-recovery.mjs';

const wallet = { id: 'wallet-a', address: '0x' + '1'.repeat(40) };
const project = '0x' + '2'.repeat(40), token = '0x' + '3'.repeat(40);
const txHash = '0x' + 'a'.repeat(64), blockHash = '0x' + 'b'.repeat(64);
const native = '0x' + 'e'.repeat(40), usdt = '0x55d398326f99059ff775485246999027b3197955';
const transfer = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const word = value => BigInt(value).toString(16).padStart(64, '0');
const topic = address => '0x' + address.slice(2).padStart(64, '0');
const event = { id: 'confirmed-event', walletId: wallet.id, walletAddress: wallet.address, chainId: 56, txHash };
const accepted = () => ({ recorded: true, duplicate: false, event });

// The real shared reconciler runs with only read RPCs and an in-memory recorder.
// /never-used is deliberately not a usable store: no default writer is invoked.
function fixture({ pending = {}, transaction = {}, receipt = {}, order, record = accepted } = {}) {
  const intent = { version: 1, walletId: wallet.id, walletAddress: wallet.address, kind: 'contract', txHash, amountWei: '100',
    expected: { from: wallet.address, to: project, value: '100', inputData: '0x12345678' },
    mintContext: { version: 1, final: true, project, name: 'Test mint' },
    reservationId: 'original-reservation', reservedAmountWei: '100', settlement: { successSpentWei: '100', failureSpentWei: '0' }, ...pending };
  const tx = { hash: txHash, from: wallet.address, to: project, value: '0x64', input: '0x12345678', chainId: '0x38', blockNumber: '0x10', blockHash, ...transaction };
  const proof = { transactionHash: txHash, blockHash, blockNumber: '0x10', status: '0x1', logs: [{ address: token, topics: [transfer, topic('0x' + '0'.repeat(40)), topic(wallet.address), '0x' + word(7)], data: '0x' }], ...receipt };
  const seen = { order: [], rpc: [], records: [], settlements: [], clears: [], commands: [] };
  const args = { wallet, pending: intent, root: '/never-used',
    rpc: async method => {
      seen.rpc.push(method);
      if (method === 'eth_chainId') return '0x38';
      if (method === 'eth_getTransactionByHash') return tx;
      if (method === 'eth_getTransactionReceipt') return proof;
      throw new Error('No other RPC is allowed');
    },
    budget: { async settle(id, value) { seen.order.push('settle'); seen.settlements.push({ id, ...value }); } },
    async clearBlocked(selected, options) { seen.order.push('clear'); seen.clears.push({ selected, options }); },
    async recordMintSuccess(payload) { seen.order.push('record'); seen.records.push(payload); return record(payload); },
    async runWallet(command) { seen.commands.push(command); assert.deepEqual(command, ['market-order', 'list', '--orderId', 'original-order']); return { success: true, data: { list: order ? [order] : [] } }; },
  };
  return { args, intent, tx, proof, seen, run: () => reconcileScannerPending(args) };
}

test('repeated confirmed reconciliation shares one proof-bound hook before budget settlement and unblock', async () => {
  const keys = new Set(); let appends = 0;
  const h = fixture({ record: payload => {
    const key = [payload.wallet.id, payload.wallet.address, payload.transaction.chainId, payload.transaction.hash].join(':');
    const duplicate = keys.has(key); keys.add(key); if (!duplicate) appends++;
    return { recorded: !duplicate, duplicate, event };
  } });
  const before = structuredClone(h.intent);
  for (const path of ['live confirmation', 'scanner recovery', 'Web recovery']) {
    const result = await h.run(); assert.equal(result.status, 'confirmed', path); assert.equal(result.resolved, true, path);
  }
  assert.equal(appends, 1); assert.deepEqual(h.seen.order, ['record', 'settle', 'clear', 'record', 'settle', 'clear', 'record', 'settle', 'clear']);
  for (const payload of h.seen.records) {
    assert.equal(payload.wallet, wallet); assert.equal(payload.pending, h.intent); assert.equal(payload.transaction, h.tx); assert.equal(payload.receipt, h.proof); assert.equal(payload.source, 'live');
  }
  assert.deepEqual(h.intent, before); assert.equal(h.seen.commands.length, 0);
  assert.equal(h.seen.rpc.length, 9); assert.ok(h.seen.rpc.every(method => ['eth_chainId', 'eth_getTransactionByHash', 'eth_getTransactionReceipt'].includes(method)));
});

for (const path of ['live', 'recovery', 'web']) test(`the actual ${path} caller records the same verified mint before completing its existing recovery path`, async () => {
  const h = fixture(), S = { walletPending: { [wallet.id]: h.intent }, paidSpend: { day: 'today' } };
  const W = { id: wallet.id, addr: wallet.address, profile: wallet, baw: async () => { throw new Error('No wallet command is allowed'); } };
  const sandbox = {
    S, DIR: '/never-used', rpc: h.args.rpc, scannerBudget: () => h.args.budget,
    reconcileScannerPending: options => reconcileScannerPending({ ...h.args, ...options, recordMintSuccess: h.args.recordMintSuccess, clearBlocked: h.args.clearBlocked }),
    settleConfirmedMintRisk: async () => {}, settleMintParticipation() {}, applyMintTracking() {}, applyManualMintCompletion() {}, save() {},
    sleep: async () => {}, markWalletBlocked: async () => { throw new Error('A verified stored result must not be blocked'); },
    withWalletExecution: async (_wallet, work) => work(),
    durableRuntime: true, appRoot: '/never-used', executor: async (_wallet, work) => work(),
    walletExecutionView: async () => ({ blocked: true, details: { source: 'scanner' } }), scannerPending: () => h.intent,
    deps: { runWallet: async () => { throw new Error('No wallet command is allowed'); } }, budget: h.args.budget, indexOf: () => 0,
    failure: (_status, reason) => new Error(reason),
  };
  const file = path === 'web' ? '../server.mjs' : '../watch.mjs';
  const source = readFileSync(new URL(file, import.meta.url), 'utf8');
  const start = source.indexOf(path === 'web' ? '  async function reconcileManual(' : path === 'live' ? 'async function confirmWalletResult(' : 'const SCANNER_RECOVERY_JOBS =');
  const end = source.indexOf(path === 'web' ? '  const clean = setInterval' : path === 'live' ? 'async function settleConfirmedMintRisk(' : 'async function runPaidCommand(', start);
  assert.ok(start >= 0 && end > start);
  vm.runInNewContext(source.slice(start, end) + `\nglobalThis.run = ${path === 'web' ? 'reconcileManual' : path === 'live' ? 'confirmWalletResult' : 'recoverScannerWallet'};`, sandbox);
  const result = await sandbox.run(path === 'web' ? wallet : W);
  assert.equal(path === 'live' ? result : result.status, path === 'live' ? true : 'confirmed');
  assert.equal(h.seen.records.length, 1); assert.deepEqual(h.seen.order, ['record', 'settle', 'clear']); assert.equal(h.seen.rpc.length, 3); assert.equal(h.seen.commands.length, 0);
  if (path === 'recovery') assert.equal(S.walletPending[wallet.id], undefined);
});

test('a verified non-gain or commit result does not manufacture a mint event and still completes original transaction accounting', async () => {
  const h = fixture({ receipt: { logs: [] }, record: () => ({ recorded: false, duplicate: false, event: null, reason: 'no-gain' }) });
  assert.equal((await h.run()).status, 'confirmed'); assert.equal(h.seen.records.length, 1); assert.equal(h.seen.settlements.length, 1); assert.equal(h.seen.clears.length, 1);
  const commit = fixture({ pending: { mintContext: { version: 1, final: false, project } } });
  assert.equal((await commit.run()).status, 'confirmed'); assert.equal(commit.seen.records.length, 0);
});

for (const [name, options, status] of [
  ['reverted transaction', { receipt: { status: '0x0' } }, 'reverted'],
  ['unmined transaction', { receipt: { blockNumber: null } }, 'pending'],
  ['missing trusted hash', { pending: { txHash: undefined } }, 'review'],
  ['another wallet', { transaction: { from: project } }, 'review'],
  ['another chain', { transaction: { chainId: '0x1' } }, 'review'],
  ['another transaction', { receipt: { transactionHash: '0x' + 'c'.repeat(64) } }, 'review'],
  ['another block', { receipt: { blockHash: '0x' + 'c'.repeat(64) } }, 'review'],
  ['another contract', { transaction: { to: token } }, 'review'],
  ['different calldata', { transaction: { input: '0x12345679' } }, 'review'],
]) test(`${name} never calls the mint recorder`, async () => {
  const h = fixture(options), result = await h.run();
  assert.equal(result.status, status); assert.equal(h.seen.records.length, 0);
  if (status !== 'reverted') { assert.equal(h.seen.settlements.length, 0); assert.equal(h.seen.clears.length, 0); }
});

test('legacy intents and invalid or mismatched mint contexts never initialize the lazy store', async () => {
  for (const mintContext of [undefined, null, {}, { version: 2, final: true, project }, { version: 1, final: true, project: token }]) {
    const h = fixture({ pending: { mintContext } }); delete h.args.recordMintSuccess;
    assert.equal((await h.run()).status, 'confirmed'); assert.equal(h.seen.settlements.length, 1); assert.equal(h.seen.clears.length, 1);
  }
});

test('approval and swap transactions cannot be counted even if they erroneously carry a final mint context', async () => {
  const calldata = '0x095ea7b3' + project.slice(2).padStart(64, '0') + word(0);
  const approval = fixture({ pending: { kind: 'approval', expected: { token, spender: project, type: 'approve' } }, transaction: { to: token, value: '0x0', input: calldata } });
  assert.equal((await approval.run()).status, 'confirmed'); assert.equal(approval.seen.records.length, 0);
  const contractApproval = fixture({ pending: { expected: { from: wallet.address, to: project, value: '100', inputData: calldata } }, transaction: { input: calldata } });
  assert.equal((await contractApproval.run()).status, 'confirmed'); assert.equal(contractApproval.seen.records.length, 0);
  const order = { orderId: 'original-order', chain: '56', fromToken: native, toToken: usdt, fromTokenQty: '0.0000000000000001', status: 'FINISHED', txHash };
  const swap = fixture({ pending: { kind: 'market-order', orderId: order.orderId, expected: { fromToken: native, toToken: usdt, fromTokenQty: order.fromTokenQty } }, order,
    receipt: { logs: [{ address: usdt, topics: [transfer, topic(project), topic(wallet.address)], data: '0x' + word(50) }] } });
  assert.equal((await swap.run()).status, 'confirmed'); assert.equal(swap.seen.records.length, 0); assert.equal(swap.seen.commands.length, 1);
});

test('a failed ledger write preserves the original intent, funds and block; a later read-only retry records once and settles', async () => {
  let failed = true, writes = 0;
  const h = fixture({ record: () => {
    if (failed) throw new Error('private-path?token=SECRET');
    return { recorded: ++writes === 1, duplicate: writes > 1, event };
  } });
  const before = structuredClone(h.intent), first = await h.run();
  assert.equal(first.status, 'review'); assert.equal(first.resolved, false); assert.match(first.reason, /交易已确认.*尚未保存/); assert.doesNotMatch(first.reason, /SECRET|private-path/);
  assert.equal(h.seen.settlements.length, 0); assert.equal(h.seen.clears.length, 0); assert.deepEqual(h.intent, before);
  failed = false; assert.equal((await h.run()).status, 'confirmed'); assert.equal((await h.run()).status, 'confirmed');
  assert.equal(h.seen.settlements.length, 2); assert.equal(h.seen.clears.length, 2); assert.deepEqual(h.intent, before); assert.equal(h.seen.commands.length, 0);
  assert.ok(h.seen.rpc.every(method => ['eth_chainId', 'eth_getTransactionByHash', 'eth_getTransactionReceipt'].includes(method)));
});

test('an invalid recorder response cannot silently clear an unpersisted mint', async () => {
  for (const response of [undefined, null, {}, { recorded: true, duplicate: false, event: null }, { recorded: true, duplicate: true, event }]) {
    const h = fixture({ record: () => response }); assert.equal((await h.run()).status, 'review');
    assert.equal(h.seen.settlements.length, 0); assert.equal(h.seen.clears.length, 0);
  }
});

test('a budget failure after recording cannot cause a second mint event on reconciliation retry', async () => {
  let appended = false, appends = 0, failSettlement = true;
  const h = fixture({ record: () => { const duplicate = appended; if (!duplicate) appends++; appended = true; return { recorded: !duplicate, duplicate, event }; } });
  h.args.budget.settle = async () => { if (failSettlement) throw new Error('mock accounting unavailable'); };
  await assert.rejects(h.run(), /accounting unavailable/); assert.equal(h.seen.clears.length, 0); assert.equal(appends, 1);
  failSettlement = false; assert.equal((await h.run()).status, 'confirmed'); assert.equal(h.seen.clears.length, 1); assert.equal(appends, 1); assert.equal(h.seen.commands.length, 0);
});

test('the default lazy store persists one confirmed event across repeated recovery calls in an isolated project root', async () => {
  const root = mkdtempSync(join(tmpdir(), 'scanner-mint-success-'));
  try {
    const h = fixture(); h.args.root = root; delete h.args.recordMintSuccess;
    assert.equal((await h.run()).status, 'confirmed'); assert.equal((await h.run()).status, 'confirmed');
    const { createMintSuccessStore } = await import('../lib/mint-success.mjs');
    const summary = createMintSuccessStore({ root }).readSummary({ wallets: [wallet] });
    assert.equal(summary.available, true); assert.equal(summary.wallets[0].total, 1); assert.equal(summary.recent.length, 1);
    assert.equal(summary.recent[0].walletId, wallet.id); assert.equal(summary.recent[0].txHash, txHash);
    assert.deepEqual(summary.recent[0].assets, [{ address: token, standard: 'ERC721', tokenId: '7', amountBaseUnits: '1' }]);
    assert.equal(h.seen.rpc.length, 6); assert.equal(h.seen.commands.length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
