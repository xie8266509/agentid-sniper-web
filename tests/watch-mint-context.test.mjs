import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const source = readFileSync(new URL('../watch.mjs', import.meta.url), 'utf8');
const from = source.indexOf('async function runPaidCommand('), to = source.indexOf('const MINT_WALLET_QUEUE =', from);
const A = '0x' + '11'.repeat(20), B = '0x' + '22'.repeat(20);
function fixture({ scope, operationKind = 'mint', unknown = false } = {}) {
  const S = { walletPending: {}, paidSpend: {} }, snapshots = [], calls = [];
  const W = { id: 'wallet-a', addr: A, profile: { id: 'wallet-a', address: A }, operationKind, paidReservation: scope,
    async baw(args) { calls.push({ args, pending: structuredClone(S.walletPending['wallet-a']) }); return { j: { success: true, data: { txHash: '0x' + 'ab'.repeat(32) } } }; },
  };
  const sandbox = { S, DIR: '/memory', canWallet: () => true, resetPaidBudgetDay: () => S.paidSpend,
    usdBudgetMicros: () => '0', MINT_RISK: { reserve: () => null }, save: () => snapshots.push(structuredClone(S.walletPending)),
    mintExecutionUnknown: () => false, confirmWalletResult: async () => { if (unknown) throw new Error('receipt unavailable'); return true; }, markWalletBlocked: async () => {},
  };
  vm.runInNewContext(source.slice(from, to) + '\nglobalThis.run = runPaidCommand;', sandbox);
  const expected = { from: A, to: B, value: '0', inputData: '0x12345678' };
  const risk = { mintContext: { version: 1, final: true, project: B, name: 'PROJECT' } };
  return { S, snapshots, calls, run: (args = ['contract-call', 'execute', '--requestId', 'request']) => sandbox.run(W, args, 0n, expected, risk) };
}

test('final mint context is durably snapshotted before the wallet execution boundary', async () => {
  const h = fixture(); await h.run();
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].pending.mintContext.project, B);
  assert.equal(h.snapshots[0]['wallet-a'].mintContext.final, true); assert.equal(h.S.walletPending['wallet-a'], undefined);
});

test('unknown confirmations retain the exact mint context for later read-only recovery', async () => {
  const h = fixture({ unknown: true }); await assert.rejects(h.run(), /結果不明/);
  assert.equal(h.S.walletPending['wallet-a'].mintContext.project, B); assert.equal(h.calls.length, 1);
});

test('USDT workflow context is attached only to the bound final contract call', async () => {
  for (const matches of [true, false]) {
    const h = fixture({ scope: { finalTarget: matches ? B : A, finalData: '0x12345678', spentWei: 0n, spentUsdMicros: 0n, totalWei: 0n, totalUsdMicros: 0n } });
    await h.run(); assert.equal(Boolean(h.calls[0].pending.mintContext), matches);
  }
});

test('token sells, market swaps and revoke calls never acquire a mint context', async () => {
  for (const [operationKind, args] of [['token-sell', ['contract-call', 'execute']], ['mint', ['market-order', 'swap', '--fromToken', A, '--toToken', B, '--fromTokenQty', '1']], ['mint', ['approvals', 'revoke']]]) {
    const h = fixture({ operationKind }); await h.run(args); assert.equal(h.calls[0].pending.mintContext, undefined);
  }
});
