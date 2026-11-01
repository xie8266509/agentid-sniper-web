import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const walk = node => [node, ...(node?.children || []).flatMap(walk)];
class Element {
  constructor(tag, attrs = {}, ...children) { this.tag = tag; this.children = []; this.listeners = {}; this.checked = false; this.disabled = false; Object.assign(this, attrs); this.classList = { add() {}, remove() {} }; this.append(...children); }
  append(...children) { this.children.push(...children.flat(Infinity).filter(child => child && typeof child === 'object')); }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  addEventListener(type, fn) { this.listeners[type] = fn; }
  setAttribute(key, value) { this[key] = value; }
  fire(type) { return this.listeners[type]?.({ target: this }) ?? this['on' + type]?.({ target: this }); }
}
function fixture() {
  const wallets = [
    { id: 'alpha', name: 'Alpha', address: '0x' + '1'.repeat(40), agentId: 'first-agent', paused: true, mode: 'auto' },
    { id: 'beta', name: 'Beta', address: '0x' + '2'.repeat(40), agentId: 'second-agent', paused: true, mode: 'auto' },
    { id: 'gamma', name: 'Gamma', address: '0x' + '3'.repeat(40), agentId: 'third-agent', paused: true, mode: 'auto', archived: true },
    { id: 'draft', name: 'Draft', address: '', draft: true, paused: true, mode: 'monitor' },
  ];
  const state = { view: 'wallets', config: { wallets, monitorOnly: false, paid: {}, rules: {} }, status: {}, walletId: 'beta', walletSearch: '', showArchived: false, walletRegistry: new Map() };
  const nodes = Object.fromEntries(['content', 'global-wallet', 'scope-count', 'breadcrumb-view', 'sidebar', 'menu-toggle'].map(key => [key, new Element('div')]));
  const content = nodes.content, calls = [], balanceReads = [], connectionReads = [], storageWrites = [], navigation = [];
  const sandbox = {
    state, content, modal: { open: false }, routeGeneration: 0, views: { overview: '总览', wallets: '钱包', config: '策略', holdings: '持仓' }, location: { hash: '#wallets' },
    document: { title: '', querySelectorAll: () => [] }, $: selector => nodes[selector.replace(/^#/, '')],
    localStorage: { setItem: (...args) => storageWrites.push(args), removeItem: (...args) => storageWrites.push(args) },
    el: (tag, attrs, ...children) => new Element(tag, attrs, ...children), replace: (node, ...children) => node.replaceChildren(...children),
    button: (label, _icon, click) => new Element('button', { label, click }), title: (_name, _description, actions) => new Element('header', {}, actions),
    panel: (_name, _icon, body, aside) => new Element('section', {}, body, aside), badge: () => new Element('span'), icon: () => new Element('svg'),
    empty: () => new Element('div'), walletConnectionInfo: () => null, walletStateLabel: () => '未检查', walletBalanceCell: wallet => new Element('div', { balanceWallet: wallet.id }),
    walletExecutionCell: () => new Element('div'), walletRunState: () => '已暂停', walletModes: { auto: '自动交易', monitor: '只监控' }, walletMode: wallet => wallet.mode,
    shortAddress: value => value, agentIdLabel: wallet => wallet.agentId, budgetCell: () => new Element('div'),
    confirmAction: async () => true, api: async (path, options) => { calls.push({ path, ...JSON.parse(JSON.stringify(options)) }); return {}; },
    loadConfig: async () => state.config, loadWalletRegistry: async () => {}, toast() {}, usd: String, ruleStrategyName: () => 'existing rules',
    loadWalletBalanceSummary: async (id, options) => balanceReads.push({ id, options }), refreshWallet: async id => connectionReads.push(id),
    addWalletDialog() {}, openWalletSettings() {}, openWalletConnection() {}, startLogin() {}, reconcileWalletDialog() {}, pauseWallet() {},
    renderOverview() {}, renderOperations() {}, renderLogs() {}, renderUpdates() {},
    renderHoldings: async () => navigation.push({ view: 'holdings', ids: sandbox.scoped().map(wallet => wallet.id) }),
    renderWalletStrategy: () => navigation.push({ view: 'config', id: state.walletId }),
  };
  vm.runInNewContext([
    section('function walletKey(', 'function shortAddress('),
    section('async function forWalletsLimited(', 'async function loadWalletRegistry('),
    section('async function refreshWalletBalanceSummaries(', 'function openBalanceDetails('),
    section('function syncWalletScope(', 'async function changeWalletScope('),
    section('function renderWallets(', 'async function addWalletDialog('),
    section('function renderConfig(', 'function holdingsLoading('),
    section('async function route(', 'async function boot('),
    '\nglobalThis.render = renderWallets; globalThis.managed = managedWallets; globalThis.scoped = scopeWallets; globalThis.refreshSummary = refreshWalletBalanceSummaries; globalThis.syncScope = syncWalletScope; globalThis.navigate = route;',
  ].join('\n'), sandbox);
  const find = predicate => walk(content).find(predicate);
  return { state, content, nodes, calls, balanceReads, connectionReads, storageWrites, navigation, sandbox,
    render: () => sandbox.render(), find, button: label => find(node => node.label === label),
    search: query => { const input = find(node => node.type === 'search'); input.value = query; input.fire('input'); },
    showArchived: value => { const checkbox = find(node => node.type === 'checkbox' && !node['aria-label']); checkbox.checked = value; checkbox.fire('change'); },
    selectAll: value => { const checkbox = find(node => node['aria-label'] === '选择当前列表中的钱包'); checkbox.checked = value; checkbox.fire('change'); },
    listed: () => walk(content).filter(node => node.balanceWallet).map(node => node.balanceWallet),
  };
}

test('wallet management lists and searches every wallet without changing the selected global wallet', () => {
  const f = fixture(); f.render();
  assert.deepEqual(f.listed(), ['alpha', 'beta', 'draft']);
  assert.deepEqual(Array.from(f.sandbox.scoped(), wallet => wallet.id), ['beta']);
  f.search('ALPHA'); assert.deepEqual(f.listed(), ['alpha']);
  f.search('first-agent'); assert.deepEqual(f.listed(), ['alpha']);
  f.search('0x' + '1'.repeat(40)); assert.deepEqual(f.listed(), ['alpha']);
  f.search('Gamma'); assert.deepEqual(f.listed(), []);
  f.showArchived(true); assert.deepEqual(f.listed(), ['gamma']);
  assert.equal(f.state.walletId, 'beta'); assert.equal(f.storageWrites.length, 0);
});

test('select-all and batch pause operate on the visible management list, pruning hidden search selections', async () => {
  const f = fixture(); f.render(); f.selectAll(true);
  assert.equal(f.button('暂停所选').disabled, false);
  f.search('Alpha'); await f.button('暂停所选').click();
  assert.deepEqual(f.calls[0].body.walletIds, ['alpha']); assert.equal(f.state.walletId, 'beta');
  f.search('not found'); assert.equal(f.button('暂停所选').disabled, true);
});

test('hiding archived wallets removes their selection before a batch operation', async () => {
  const f = fixture(); f.render(); f.showArchived(true); f.search('Gamma'); f.selectAll(true);
  f.showArchived(false); assert.equal(f.button('暂停所选').disabled, true);
  f.search('Beta'); f.selectAll(true); await f.button('暂停所选').click();
  assert.deepEqual(f.calls[0].body.walletIds, ['beta']);
});

test('template batches target selected search results outside the current global selection', async () => {
  const f = fixture(); f.render(); f.search('Alpha'); f.selectAll(true); await f.button('复制策略模板').click();
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].path, '/api/wallets/alpha/settings');
  assert.equal(f.state.walletId, 'beta'); assert.equal(f.storageWrites.length, 0);
});

test('management balance refresh covers all bound wallets and archive visibility, while overview stays scoped', async () => {
  const f = fixture(); f.state.walletSearch = 'Alpha';
  await f.sandbox.refreshSummary({ refresh: true }); assert.deepEqual(f.balanceReads.map(row => row.id), ['alpha', 'beta']);
  f.balanceReads.length = 0; f.state.showArchived = true;
  await f.sandbox.refreshSummary(); assert.deepEqual(f.balanceReads.map(row => row.id), ['alpha', 'beta', 'gamma']);
  f.balanceReads.length = 0; f.state.view = 'overview';
  await f.sandbox.refreshSummary(); assert.deepEqual(f.balanceReads.map(row => row.id), ['beta']);
  assert.equal(f.state.walletId, 'beta');
});

test('bulk connection checks cover all nonarchived management wallets independent of the global selection', async () => {
  const f = fixture(); f.render();
  await f.button('检查连接').click(); assert.deepEqual(f.connectionReads, ['alpha', 'beta', 'draft']); assert.equal(f.state.walletId, 'beta');
});

test('routing disables the management selector and restores the same wallet for holdings and strategy', async () => {
  const f = fixture(); await f.sandbox.navigate();
  assert.equal(f.nodes['global-wallet'].disabled, true); assert.equal(f.nodes['global-wallet'].value, ''); assert.equal(f.state.walletId, 'beta');
  f.sandbox.location.hash = '#holdings'; await f.sandbox.navigate();
  assert.equal(f.nodes['global-wallet'].disabled, false); assert.equal(f.nodes['global-wallet'].value, 'beta');
  assert.deepEqual(f.navigation.at(-1), { view: 'holdings', ids: ['beta'] });
  f.sandbox.location.hash = '#config'; await f.sandbox.navigate();
  assert.deepEqual(f.navigation.at(-1), { view: 'config', id: 'beta' }); assert.equal(f.state.walletId, 'beta'); assert.equal(f.storageWrites.length, 0);
});
