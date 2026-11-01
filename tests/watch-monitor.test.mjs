// The complete scanner is evaluated with in-memory I/O and wallet doubles.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import * as sellRules from '../lib/sell-rules.mjs';
import { isolatedWatch, raw, VIRTUAL_ROOT, wallet, target, deployer, registry, word } from './watch-scanner-fixture.mjs';

for (const wallets of [[], [wallet]]) {
  test(`monitorOnly blocks every original transaction entry with ${wallets.length} wallet(s)`, async () => {
    const { api, seen } = isolatedWatch({ wallets, state: { paid: { [target]: { done: {} } }, trades: [], dyn: [] } });
    const before = JSON.stringify(api.getState());
    assert.equal(api.getMe(), wallets[0]?.address || '');
    assert.equal(seen.directories.length, 1);
    assert.equal(seen.directories[0].path, join(VIRTUAL_ROOT, 'data'));
    assert.equal(seen.directories[0].recursive, true);
    assert.equal(api.getState().runtimeMode, 'monitor');
    for (let i = 0; i < 2; i++) {
      assert.equal(await api.sell(undefined, undefined, undefined, undefined), false);
      api.queueMint(target, 'mint()', api.getWallets()[0], 0n);
      await api.autoMintMax(target, 'mint()', api.getWallets()[0]);
      await api.autoMint(target, 'mint()');
      await assert.rejects(api.previewExec(undefined, target, '0x', 0n, () => ''));
      await assert.rejects(api.executeUsdtMint(undefined, { to: target, data: '0x1249c58b', need: 1n }));
      await api.paidLoop();
      await api.loginCheck();
      await api.cmdSell('TEST', false);
    }
    assert.equal(await api.findFree('', target, '0x1249c58b'), null);
    for (const args of [
      ['wallet', 'status'], ['auth', 'signin'], ['auth', 'verify', '--qrCodeId', 'mock-id'],
      ['contract-call', 'preview'], ['contract-call', 'execute'], ['market-order', 'swap'],
    ]) assert.equal((await api.makeBaw(wallet, 0)(args)).j.success, false);
    if (!wallets.length) await api.holdings(100);
    assert.equal(JSON.stringify(api.getState()), before, 'blocked entries must not mark a trade or force mint as completed');
    assert.equal(api.getMintQueueSize(), 0);
    assert.equal(seen.cliFactories.length, 0, 'the real wallet wrapper must not even be constructed');
    assert.equal(seen.cliCalls.length, 0);
    assert.equal(seen.network.length, 0);
    assert.equal(seen.writes.length, 0);
    assert.equal(seen.logs.length, 0, 'repeated blocked entries must not spam the log');
  });

  test(`monitorOnly preserves manual command files even when explicitly enabled (${wallets.length} wallet(s))`, async () => {
    const jobs = [
      { schemaVersion: 1, c: target, data: '0x1249c58b', value: '0', n: 1 },
      { schemaVersion: 1, swapBack: target, revoke: deployer },
      { schemaVersion: 1, c: target, data: '0x1249c58b', usdt: 5 },
    ];
    const { api, seen, file } = isolatedWatch({ wallets, enableFileCommands: true, files: { 'data/manual_mint.json': jobs } });
    const before = JSON.stringify(api.getState()), commands = file('data/manual_mint.json');
    await api.manualMints();
    assert.equal(file('data/manual_mint.json'), commands, 'monitoring must not consume pending manual commands');
    assert.equal(JSON.stringify(api.getState()), before);
    assert.equal(seen.cliCalls.length, 0);
    assert.equal(seen.network.length, 0);
    assert.equal(seen.writes.length, 0);
  });
}

test('monitorOnly suppresses sellNow and profit-taking while still tracking holdings', async () => {
  const { api, seen } = isolatedWatch({
    wallets: [wallet], tokens: [{ sym: 'TEST', addr: target, cost: 1, sellNow: true }],
    state: { tokens: { TEST: { hist: [], peak: 100, openAt: Date.now() - 3600000, pair: target } } },
    rpcResponse({ method, params }) {
      if (method === 'eth_getLogs') return [];
      if (method === 'eth_call') {
        const data = params[0].data;
        if (data === '0x0902f1ac') return '0x' + word(10n ** 18n) + word(10n ** 18n);
        return '0x' + word(data.startsWith('0x70a08231') ? 10n ** 18n : 10n * 10n ** 18n);
      }
      throw new Error('Unexpected RPC ' + method);
    },
  });
  await api.holdings(100);
  const position = api.getState().tokens[sellRules.positionStateKey(wallet.address, target)];
  assert.equal(position.lastBal, (10n ** 18n).toString());
  assert.equal(position.last?.v, 10);
  assert.equal(position.sellNowDone, undefined);
  assert.notEqual(position.stage, 9);
  assert.equal(api.getState().trades, undefined);
  assert.equal(seen.cliFactories.length, 0);
  assert.equal(seen.cliCalls.length, 0);
});

test('empty-wallet monitor scans and records a new mock Agent ID contract without trading', async () => {
  const { api, seen } = isolatedWatch({ rpcResponse({ method, params }) {
    if (method === 'eth_getBlockByNumber') return { transactions: params[0] === '0x2' ? [{ from: deployer, to: null, value: '0x0', input: '0x' + '00'.repeat(1020) + registry, hash: 'mock-deployment' }] : [] };
    if (method === 'eth_getTransactionReceipt') return { contractAddress: target };
    if (method === 'eth_getCode') return '0x' + '00'.repeat(2050) + registry + '1249c58b';
    if (method === 'eth_call') return '0x';
    if (method === 'eth_getLogs') return [];
    throw new Error('Unexpected RPC ' + method);
  } });
  await api.scanNew(6);
  const state = api.getState();
  assert.equal(state.lastBlock, 6);
  assert.ok(state.seenMints[target]);
  assert.equal(state.mintCount, undefined);
  assert.equal(state.dyn, undefined);
  assert.equal(state.trades, undefined);
  assert.ok(seen.logs.some(({ value }) => value.includes(target) && /监控/.test(value)), 'discovery must remain observable as monitoring');
  assert.equal(seen.cliFactories.length, 0);
  assert.equal(seen.cliCalls.length, 0);
  assert.equal(seen.network.some(q => q.method === 'eth_call' && q.params[0].from === ''), false);
});

for (const enableFileCommands of [undefined, false]) {
  test(`automatic mode leaves command files untouched when enableFileCommands=${enableFileCommands}`, async () => {
    const jobs = [{ schemaVersion: 1, c: target, data: '0x1249c58b', value: '0', n: 1 }];
    const { api, seen, file } = isolatedWatch({ monitorOnly: false, wallets: [wallet], enableFileCommands, files: { 'data/manual_mint.json': jobs } });
    const commands = file('data/manual_mint.json');
    await api.manualMints();
    assert.equal(file('data/manual_mint.json'), commands);
    assert.equal(seen.cliCalls.length, 0);
    assert.equal(seen.network.length, 0);
    assert.equal(seen.writes.length, 0);
  });
}

test('normal mode still delegates to the wallet adapter and requires a wallet', async () => {
  const { api, seen } = isolatedWatch({ monitorOnly: false, wallets: [wallet] });
  assert.equal(seen.cliFactories.length, 1);
  assert.equal(seen.cliFactories[0].index, 0);
  assert.equal((await api.getWallets()[0].baw(['wallet', 'status'])).j.data.status, 'CONNECTED');
  assert.equal(seen.cliCalls.length, 1, 'the harness must detect wallet calls when monitoring is disabled');
  assert.throws(() => isolatedWatch({ monitorOnly: false }), /SCANNER_EXIT_1/);
});

test('scanner isolation accepts trailing release comments but rejects trailing executable code', () => {
  const { api, seen } = isolatedWatch({ sourceText: raw + '\n// Harmless upstream release note.\n  // Another comment.\n' });
  assert.equal(api.getState().runtimeMode, 'monitor');
  assert.equal(seen.cliCalls.length, 0); assert.equal(seen.network.length, 0);
  for (const suffix of ['\nmain();\n', '\nconsole.log("unexpected execution");\n', '\n// comment\nprocess.exit(0);\n']) {
    assert.throws(() => isolatedWatch({ sourceText: raw + suffix }), /explicitly isolate/);
  }
});
