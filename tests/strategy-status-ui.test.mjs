import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const text = node => typeof node === 'string' ? node : (node?.children || []).map(text).join(' ');
function fixture() {
  const wallet = { id: 'alpha', name: 'Alpha', address: '0x' + '1'.repeat(40), mode: 'auto', paused: false, rules: { backX: 4 } };
  const other = { id: 'beta', name: 'Beta', address: '0x' + '2'.repeat(40), mode: 'auto', paused: false };
  const state = { walletId: 'alpha', showArchived: false, config: { monitorOnly: false, rules: { strategy: 'steps', backX: 3 }, wallets: [wallet, other] }, status: { service: { running: true }, wallets: [] } };
  const el = (tag, attrs, ...children) => ({ tag, ...attrs, children: children.flat(Infinity).filter(value => value !== null && value !== undefined && value !== false) });
  const sandbox = { state, el, replace: (node, ...children) => { node.children = children.flat(); }, badge: (label, kind) => el('span', { kind }, label), icon: () => el('svg', {}), button: label => el('button', {}, label), date: value => 'T' + value, pct: value => `${value * 100}%`, serviceAction() {}, changeWalletScope() {}, shortAddress: value => value };
  vm.runInNewContext([
    section('function walletKey(', 'function shortAddress('),
    section('function walletMode(', 'function walletRunState('),
    section('function usesStepRules(', 'function tokenStrategyState('),
    section('function scopedStrategy(', 'function renderWalletStrategy('),
    '\nglobalThis.scoped = scopedStrategy; globalThis.render = renderStrategyState; globalThis.execution = strategyExecutionState; globalThis.loadLabel = strategyLoadLabel;',
  ].join('\n'), sandbox);
  const rules = { strategy: 'steps', backX: 3, steps: [[5, 25]], crash: 0.5 };
  const row = overrides => ({ walletId: wallet.id, walletAddress: wallet.address, mode: 'auto', paused: false, archived: false, configuredRules: rules, effectiveRules: null, reportStatus: 'waiting', rulesCheckedAt: null, ...overrides });
  const render = strategy => { const view = { strategy: {} }; sandbox.render(view, strategy); return text(view.strategy); };
  return { sandbox, state, wallet, other, rules, row, render };
}

test('a wallet without a current worker report is explicitly unreported rather than confirmed or automatic', () => {
  const f = fixture(), strategy = f.sandbox.scoped({ scannerRunning: true, effectiveRules: f.rules, wallets: [f.row({ reason: '等待此钱包 worker 上报' })], tokens: [] });
  assert.equal(strategy.effectiveRules, null); assert.equal(f.sandbox.execution(strategy).label, '等待上报');
  const output = f.render(strategy); assert.match(output, /尚未上报运行参数/); assert.match(output, /等待此钱包 worker 上报/); assert.doesNotMatch(output, /待确认|当前为自动交易模式|运行中规则/);
});

test('a genuine no-ERC20 report shows the loaded rules, load time and the no-position reason', () => {
  const f = fixture(), strategy = f.sandbox.scoped({ scannerRunning: true, wallets: [f.row({ effectiveRules: f.rules, reportStatus: 'no-erc20', rulesCheckedAt: 123, trackedERC20: 0, reason: '已载入规则，暂无追踪ERC20；NFT规则单独配置' })], tokens: [] });
  assert.equal(strategy.effectiveRules, f.rules); assert.equal(f.sandbox.execution(strategy).label, '已载入');
  const output = f.render(strategy); assert.match(output, /规则已载入，暂无追踪 ERC20/); assert.match(output, /已载入：新版阶梯与长抱策略/); assert.match(output, /最近规则载入 T123/); assert.match(output, /NFT规则单独配置/);
});

test('paused and offline wallets remain blocked even if an actual worker has loaded their rules in auto mode', () => {
  for (const [status, label] of [['paused', '已暂停'], ['offline', '未连接'], ['unavailable', '暂不可用']]) {
    const f = fixture(), entry = f.row({ effectiveRules: f.rules, reportStatus: status });
    if (status === 'paused') f.wallet.paused = true;
    if (status === 'unavailable') f.state.status.wallets = [{ id: f.wallet.id, availability: { ready: false, code: 'DEV_MODE_DISABLED', reason: '开发者模式未开启' } }];
    const strategy = f.sandbox.scoped({ scannerRunning: true, wallets: [entry], tokens: [] });
    assert.equal(strategy.mode, 'monitor'); assert.equal(f.sandbox.execution(strategy).label, label);
    assert.equal(f.sandbox.loadLabel(strategy), '新版阶梯与长抱策略', 'loaded proof is separate from execution permission');
    assert.doesNotMatch(f.render(strategy), /当前为自动交易模式/);
  }
});

test('missing per-wallet reports cannot borrow global rules and still filter positions to the selected wallet', () => {
  const f = fixture(), strategy = f.sandbox.scoped({ scannerRunning: true, effectiveRules: f.rules, rulesCheckedAt: 999, reportStatus: 'loaded', wallets: [], tokens: [{ walletId: 'alpha', addr: 'one' }, { walletId: 'beta', addr: 'two' }] });
  assert.equal(strategy.effectiveRules, null); assert.equal(strategy.rulesCheckedAt, null); assert.equal(strategy.reportStatus, 'waiting'); assert.equal(strategy.configuredRules.backX, 4);
  assert.deepEqual(Array.from(strategy.tokens, row => row.walletId), ['alpha']); assert.equal(f.state.walletId, 'alpha');
});

test('configuration, identity and stale report gaps show their explicit status rather than loaded execution', () => {
  const labels = { 'config-changed': '策略已更新，等待重新上报', 'identity-changed': '钱包身份变更，等待重新上报', stale: '运行参数上报已过期', stopped: '监控已停止' };
  for (const [status, label] of Object.entries(labels)) {
    const f = fixture(), strategy = f.sandbox.scoped({ scannerRunning: status !== 'stopped', wallets: [f.row({ reportStatus: status })], tokens: [] });
    assert.equal(f.sandbox.loadLabel(strategy), label); assert.equal(f.sandbox.execution(strategy).muted, true); assert.match(f.render(strategy), new RegExp(label));
  }
});

test('the all-wallet table names loaded strategy explicitly and renders each backend reason', () => {
  const f = fixture(); f.state.walletId = '';
  const output = f.render({ scannerRunning: true, wallets: [f.row({ effectiveRules: f.rules, reportStatus: 'no-erc20', rulesCheckedAt: 123, reason: '暂无追踪ERC20' }), f.row({ walletId: 'beta', walletAddress: f.other.address, reportStatus: 'offline', reason: '钱包未连接，等待重新登录' })], tokens: [] });
  assert.match(output, /已载入策略/); assert.match(output, /执行状态/); assert.match(output, /暂无追踪ERC20/); assert.match(output, /钱包未连接，等待重新登录/); assert.match(output, /载入时间 T123/);
  assert.doesNotMatch(output, /运行中策略|待确认/);
});

test('a global restart reminder cannot override a verified per-wallet loaded report', () => {
  const f = fixture(), strategy = f.sandbox.scoped({ scannerRunning: true, needsRestart: true, wallets: [f.row({ effectiveRules: f.rules, reportStatus: 'loaded', rulesCheckedAt: 123 })], tokens: [] });
  const output = f.render(strategy);
  assert.equal(f.sandbox.execution(strategy).label, '已载入'); assert.match(output, /本钱包 ERC20 规则已载入/); assert.match(output, /其他配置有改动，可能需要重启/);
  assert.doesNotMatch(output, /保存的配置尚未应用|等待重启生效/);
  const waiting = f.sandbox.scoped({ scannerRunning: true, needsRestart: true, wallets: [f.row({ reportStatus: 'config-changed' })], tokens: [] });
  assert.match(f.render(waiting), /尚未收到与当前配置匹配的规则上报/);
});

test('scoped reports require both stable ID and bound address, with only unique legacy-address fallback', () => {
  const f = fixture(), reported = f.row({ effectiveRules: f.rules, reportStatus: 'loaded', rulesCheckedAt: 123 });
  for (const rows of [
    [{ ...reported, walletId: 'old-wallet-id' }],
    [{ ...reported, walletAddress: f.other.address }],
    [{ ...reported, walletId: undefined }, { ...reported, walletId: undefined }],
    [{ ...reported, walletId: undefined }, { ...reported, walletId: 'old-wallet-id' }],
    [reported, { ...reported }],
  ]) {
    const result = f.sandbox.scoped({ scannerRunning: true, wallets: rows, tokens: [] });
    assert.equal(result.effectiveRules, null); assert.equal(result.rulesCheckedAt, null); assert.equal(result.reportStatus, 'waiting');
  }
  assert.equal(f.sandbox.scoped({ scannerRunning: true, wallets: [{ ...reported, walletId: undefined }], tokens: [] }).effectiveRules, f.rules);
  assert.equal(f.sandbox.scoped({ scannerRunning: true, wallets: [reported], tokens: [] }).effectiveRules, f.rules);
});
