import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const code = source.slice(source.indexOf('async function openWalletSettings('), source.indexOf('async function copyTemplateToWallet('));
const copy = value => JSON.parse(JSON.stringify(value));
const walk = node => [node, ...(node.children || []).flatMap(walk)];
class Element {
  constructor(tag, attrs = {}, ...children) { this.tag = tag; this.children = []; this.checked = false; this.hidden = false; this.isConnected = false; Object.assign(this, attrs); this.classList = { add() {} }; this.append(...children); }
  append(...children) { this.children.push(...children.flat(Infinity).filter(child => child && typeof child === 'object')); }
  reportValidity() { return true; }
}
function fixture() {
  const wallet = { id: 'wallet-a', name: 'A', address: '0x' + '1'.repeat(40), paused: true, mode: 'auto', paid: { maxBnbPerDay: 0.13, maxUsd: 17, dayUsd: 33, keepBnb: 0.006, goPct: 0.65, earlyPct: 0.6 }, rules: { strategy: 'trailing', backX: 3 } };
  const state = { config: { monitorOnly: false, paid: {}, rules: {}, wallets: [copy(wallet)] } }, modal = { open: false, body: null, actions: [], classList: { add() {} } };
  const calls = [], confirmations = [], messages = [];
  let respond = async (_path, { body }) => { state.config.wallets[0] = { ...state.config.wallets[0], ...copy(body.patch) }; return { config: copy(state.config) }; };
  const connect = (node, value) => { if (node) for (const child of walk(node)) child.isConnected = value; };
  const sandbox = {
    state, modal, modalGeneration: 0,
    walletIdentity: () => ({ wallet: state.config.wallets[0] }), walletMode: w => w.mode,
    walletModes: { monitor: '只监控', auto: '自动交易', 'sell-only': '仅卖出' },
    el: (tag, attrs, ...children) => new Element(tag, attrs, ...children),
    field: (_label, name, value) => new Element('input', { name, value: String(value) }),
    walletLabel: () => new Element('div'), mintEntryNotice: () => new Element('div'),
    configRulesEditor: rules => ({ body: new Element('div'), read: () => copy(rules) }),
    button: (label, _icon, click) => new Element('button', { label, click }),
    usd: String, ruleStrategyName: () => 'existing strategy',
    api: async (path, options) => { calls.push({ path, ...copy(options) }); return respond(path, options); },
    loadConfig: async () => { throw Error('Unexpected config reload'); }, updateChrome() {}, route: async () => {}, toast: message => messages.push(message),
    FormData: class { constructor(form) { this.values = new Map(walk(form).filter(n => n.name && (n.type !== 'checkbox' || n.checked)).map(n => [n.name, n.value ?? 'on'])); } get(name) { return this.values.get(name) ?? null; } },
    closeModal: () => { sandbox.modalGeneration++; connect(modal.body, false); modal.open = false; },
    openModal: (name, body, actions) => { if (modal.open) sandbox.closeModal(); modal.name = name; modal.body = body; modal.actions = actions; modal.open = true; sandbox.modalGeneration++; connect(body, true); },
    confirmAction: () => {
      sandbox.openModal('确认', new Element('div'), []);
      return new Promise(resolve => confirmations.push(value => { sandbox.closeModal(); resolve(value); }));
    },
  };
  vm.runInNewContext(code + '\nglobalThis.openSettings = openWalletSettings;', sandbox);
  return { wallet, state, modal, calls, confirmations, messages, sandbox, open: () => sandbox.openSettings(wallet.id), respond: fn => { respond = fn; }, input: (form, name) => walk(form).find(n => n.name === name), save: () => modal.actions.find(n => n.label === '保存钱包设置').click() };
}

test('unchecking pause sends false and keeps the edited form visible after a rejected save', async () => {
  const f = fixture(); await f.open();
  const form = f.modal.body, paused = f.input(form, 'paused'); paused.checked = false;
  f.respond(async () => { throw Error('开发者模式未开启'); });
  const failed = f.save(); f.confirmations.shift()(true);
  await assert.rejects(failed, /开发者模式未开启/);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].body.patch.paused, false);
  assert.equal(f.modal.open, true); assert.equal(f.modal.body, form); assert.equal(paused.checked, false);
  assert.equal(f.state.config.wallets[0].paused, true, 'a rejected save must not pretend the persisted value changed');
  const error = walk(form).find(n => n.role === 'alert'); assert.equal(error.hidden, false); assert.match(error.textContent, /设置未保存：开发者模式未开启/);
  assert.equal(f.messages.includes('钱包设置已保存'), false);
});

test('a successful retry preserves the unchecked pause value, existing strategy and budgets', async () => {
  const f = fixture(); await f.open(); const form = f.modal.body; f.input(form, 'paused').checked = false;
  f.respond(async (_path, { body }) => ({ config: { ...copy(f.state.config), wallets: [{ ...copy(f.wallet), ...copy(body.patch) }] } }));
  const saved = f.save(); f.confirmations.shift()(true); await saved;
  assert.equal(f.calls[0].body.confirmed, true); assert.equal(f.calls[0].body.patch.paused, false); assert.equal(f.calls[0].body.patch.mode, 'auto');
  assert.deepEqual(f.calls[0].body.patch.paid, f.wallet.paid); assert.deepEqual(f.calls[0].body.patch.rules, f.wallet.rules);
  assert.equal(f.state.config.wallets[0].paused, false); assert.equal(f.modal.open, false);
  await f.open(); assert.equal(f.input(f.modal.body, 'paused').checked, false);
});

test('cancelling confirmation keeps edits without sending a save or changing persisted settings', async () => {
  const f = fixture(); await f.open(); const form = f.modal.body; f.input(form, 'paused').checked = false;
  const cancelled = f.save(); f.confirmations.shift()(false); await cancelled;
  assert.equal(f.calls.length, 0); assert.equal(f.modal.body, form); assert.equal(f.input(form, 'paused').checked, false); assert.equal(f.state.config.wallets[0].paused, true);
});

test('a completed save does not close a different dialog opened while its request was pending', async () => {
  const f = fixture(); await f.open(); f.input(f.modal.body, 'paused').checked = false;
  let release, started; const admitted = new Promise(resolve => { started = resolve; });
  f.respond(() => new Promise(resolve => { release = resolve; started(); }));
  const pending = f.save(); f.confirmations.shift()(true); await admitted;
  const other = new Element('div'); f.sandbox.openModal('其他操作', other, []);
  release({ config: copy(f.state.config) }); await pending;
  assert.equal(f.modal.open, true); assert.equal(f.modal.body, other);
});
