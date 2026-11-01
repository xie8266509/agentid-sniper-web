import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import { normalizeWalletConfig } from '../lib/wallet-model.mjs';

const source = readFileSync(new URL('../lib/control.mjs', import.meta.url), 'utf8');
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
function fixture({ fail = false } = {}) {
  const wallets = [{ id: 'alpha', name: 'Alpha', address: '0x' + '11'.repeat(20) }, { id: 'beta', name: 'Beta', address: '0x' + '22'.repeat(20), archived: true }];
  const calls = [], result = { version: 1, coverage: 'since-enabled', trackingSince: 100, available: true, wallets: wallets.map(wallet => ({ walletId: wallet.id, walletAddress: wallet.address, total: 2, today: 1 })), recent: [] };
  const sandbox = { ROOT: '/memory-only', normalizeWalletConfig, publicWalletAvailability: () => null,
    readState: () => ({}), readConfig: () => ({ wallets, timeZone: 'Asia/Shanghai' }), serviceInfo: async () => ({ running: false }), readLogs: () => ({ lines: [] }),
    releaseInfo: async () => ({ version: 'test' }), configNeedsRestart: () => false,
    createMintSuccessStore: options => {
      calls.push(options); if (fail) throw new Error('private endpoint detail');
      return { readSummary(input) { calls.push(input); return result; } };
    },
  };
  vm.runInNewContext('let mintSuccessStore;\n' + section('function mintSuccessSummary(', 'async function releaseInfo(') + section('export async function dashboardStatus(', 'export async function holdingsData(').replace('export ', '') + '\nglobalThis.status = dashboardStatus;', sandbox);
  return { sandbox, calls, result };
}
test('dashboard includes all identity-bound mint statistics without new RPC or wallet work', async () => {
  const h = fixture(), first = await h.sandbox.status(), second = await h.sandbox.status();
  assert.equal(first.mintSuccess, h.result); assert.equal(second.mintSuccess, h.result);
  assert.equal(h.calls.filter(call => call.root).length, 1);
  assert.deepEqual(h.calls[1].wallets.map(wallet => wallet.id), ['alpha', 'beta']); assert.equal(h.calls[1].timeZone, 'Asia/Shanghai');
});
test('an unavailable success ledger cannot break status or masquerade as zero successful mints', async () => {
  const h = fixture({ fail: true }), data = await h.sandbox.status();
  assert.equal(data.service.running, false); assert.equal(data.mintSuccess.available, false);
  assert.ok(data.mintSuccess.wallets.every(wallet => wallet.total === null && wallet.today === null));
  assert.doesNotMatch(JSON.stringify(data), /private endpoint detail/);
});
