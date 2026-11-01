import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const A = '0x' + '1'.repeat(40), B = '0x' + '2'.repeat(40);
const code = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
function fixture() {
  let wallets = [{ id: 'alpha', address: A }, { id: 'beta', address: B }];
  const pending = [], state = { balances: new Map() }, requests = new Map();
  const sandbox = { state, walletBalanceRequests: requests, Date, paintWalletBalances() {},
    walletById: id => wallets.find(w => w.id === id),
    walletIdentity: id => { const wallet = wallets.find(w => w.id === id); return { id, wallet, query: 'walletId=' + id }; },
    api: path => new Promise((resolve, reject) => pending.push({ path, resolve, reject })),
  };
  vm.runInNewContext(code('function balanceEntry(', 'function balanceParts(') + code('async function loadWalletBalanceSummary(', 'async function refreshWalletBalanceSummaries(') + '\nglobalThis.load=loadWalletBalanceSummary; globalThis.format=balanceAmount;', sandbox);
  const response = (id, walletAddress, balance) => ({ walletId: id, walletAddress, chainId: 56, status: 'ready', assets: [{ symbol: 'BNB', balance }], updatedAt: Date.now() });
  return { sandbox, state, pending, response, wallets: value => { wallets = value; } };
}
test('balance UI distinguishes exact zero, unknown, dust and amounts above Number precision', () => {
  const { sandbox: s } = fixture();
  assert.equal(s.format(null, 'BNB'), '—'); assert.equal(s.format('0', 'BNB'), '0');
  assert.equal(s.format('0.000000000000000001', 'BNB'), '<0.00000001');
  assert.equal(s.format('9007199254740993', 'USDT'), '9,007,199,254,740,993');
});
test('balance summaries show useful decimals and explicit rounding instead of ellipses', () => {
  const { sandbox: s } = fixture();
  assert.equal(s.format('0.061834123456789', 'BNB'), '≈0.06183412');
  assert.equal(s.format('0.71456789', 'USDT'), '≈0.714568');
  assert.equal(s.format('0.714567', 'USDT'), '0.714567');
  assert.equal(s.format('0.710000000000000000', 'USDT'), '0.71');
  assert.equal(s.format('0.0000009', 'USDT'), '<0.000001');
  assert.equal(s.format('0.000001', 'USDT'), '0.000001');
  assert.equal(s.format('999999999999999999.9999999', 'USDT'), '≈1,000,000,000,000,000,000');
  assert.equal(s.format('0009007199254740993.123456789', 'USDT'), '≈9,007,199,254,740,993.123457');
});
test('two wallets resolve out of order without mixing balances, and repeated requests are merged', async () => {
  const f = fixture(), a = f.sandbox.load('alpha'), repeat = f.sandbox.load('alpha'), b = f.sandbox.load('beta');
  assert.equal(f.pending.length, 2);
  f.pending[1].resolve(f.response('beta', B, '2')); await b;
  f.pending[0].resolve(f.response('alpha', A, '1')); await Promise.all([a, repeat]);
  assert.equal(f.state.balances.get('alpha').data.assets[0].balance, '1');
  assert.equal(f.state.balances.get('beta').data.assets[0].balance, '2');
});
test('an old address response cannot overwrite a new binding or survive a removed wallet', async () => {
  const f = fixture(), old = f.sandbox.load('alpha'); f.wallets([{ id: 'alpha', address: B }]);
  const newer = f.sandbox.load('alpha', { refresh: true });
  f.pending[1].resolve(f.response('alpha', B, '7')); await newer;
  f.pending[0].resolve(f.response('alpha', A, '99')); await old;
  assert.equal(f.state.balances.get('alpha').data.assets[0].balance, '7');
  const removed = f.sandbox.load('alpha', { refresh: true }); f.wallets([]);
  f.pending[2].resolve(f.response('alpha', B, '100')); await removed;
  assert.equal(f.state.balances.get('alpha').data.assets[0].balance, '7');
});
test('wrong identity is refused and a refresh failure preserves a marked old value rather than zero', async () => {
  const f = fixture(), wrong = f.sandbox.load('alpha');
  f.pending[0].resolve(f.response('beta', B, '99')); await wrong;
  assert.equal(f.state.balances.get('alpha').data, undefined);
  const success = f.sandbox.load('alpha', { refresh: true }); f.pending[1].resolve(f.response('alpha', A, '3.14')); await success;
  const failure = f.sandbox.load('alpha', { refresh: true }); f.pending[2].reject(Error('mock unreachable')); await failure;
  assert.equal(f.state.balances.get('alpha').data.assets[0].balance, '3.14');
  assert.equal(f.state.balances.get('alpha').data.stale, true); assert.ok(f.state.balances.get('alpha').error);
});
