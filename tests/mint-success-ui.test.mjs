import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const A = '0x' + '1'.repeat(40), B = '0x' + '2'.repeat(40), C = '0x' + '3'.repeat(40);
const event = (n, overrides = {}) => ({ id: '56:0x' + n.toString(16).padStart(64, '0'), walletId: 'alpha', walletAddress: A, chainId: 56, txHash: '0x' + n.toString(16).padStart(64, '0'), project: C, name: 'Project ' + n, confirmedAt: 1000 + n, recordedAt: 1000 + n, source: 'live', assets: [], ...overrides });
const summary = (recent = [], overrides = {}) => ({ version: 1, available: true, coverage: 'since-enabled', trackingSince: 1000, ledgerId: '1000', asOf: 1000, wallets: [{ walletId: 'alpha', walletAddress: A, total: 0, today: 0 }, { walletId: 'beta', walletAddress: B, total: 0, today: 0 }], recent, ...overrides });
const text = node => typeof node === 'string' ? node : node?.ownText ?? (node?.children || []).map(text).join(' ');
const walk = node => node && typeof node === 'object' ? [node, ...(node.children || []).flatMap(walk)] : [];
class Element {
  constructor(tag, attrs = {}, ...children) { this.tag = tag; this.children = []; this.parent = null; Object.assign(this, attrs); this.append(...children); }
  append(...children) { for (const child of children.flat(Infinity)) if (child !== undefined && child !== null && child !== false) { if (typeof child === 'object') child.parent = this; this.children.push(child); } }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; }
  contains(node) { return walk(this).includes(node); }
  querySelectorAll() { return []; }
  get textContent() { return text(this); }
  set textContent(value) { this.ownText = value; }
}
function fixture() {
  const wallets = [{ id: 'alpha', name: 'Alpha', address: A }, { id: 'beta', name: 'Beta', address: B }];
  const state = { walletId: 'beta', view: 'wallets', config: { wallets }, status: { mintSuccess: summary() } }, nodes = { toasts: new Element('div'), 'updated-at': new Element('span'), 'release-version': new Element('span') };
  const active = new Element('input'), document = { hidden: false, activeElement: active }, timers = new Map(), modals = [];
  let timerId = 0;
  const sandbox = { state, document, content: new Element('main'),
    walletById: id => wallets.find(wallet => wallet.id === id),
    el: (tag, attrs, ...children) => new Element(tag, attrs, ...children), replace: (node, ...children) => { node.children = []; node.append(...children); }, icon: () => new Element('svg'),
    button: (label, _icon, onclick) => new Element('button', { onclick }, label), fmt: value => value == null ? '—' : Number(value).toLocaleString('en-US'), date: String,
    openModal: (name, body, actions) => modals.push({ name, body, actions }), closeModal() {}, walletLabel: wallet => new Element('div', {}, wallet.name),
    $: selector => nodes[selector.replace(/^#/, '')], setTimeout: fn => { const id = ++timerId; timers.set(id, fn); return id; }, clearTimeout: id => timers.delete(id),
    updateChrome() {}, paintWalletExecution() {}, paintUpdates() {}, renderOverview() {}, mintNotifications: { consume() {} },
  };
  vm.runInNewContext(section('function mintLedgerKey(', 'const mintNotifications =') + '\nglobalThis.tracker = createMintNotificationTracker; globalThis.queue = enqueueMintNotifications; globalThis.cards = () => [...activeMintToasts]; globalThis.stats = walletMintStats; globalThis.cell = walletMintCell; globalThis.details = openMintSuccessDetails; globalThis.nftAmount = mintNftAmount; globalThis.link = mintTransactionLink;', sandbox);
  vm.runInNewContext(section('async function refreshStatus(', 'function walletKey(') + '\nglobalThis.refresh = refreshStatus;', sandbox);
  return { sandbox, state, wallets, nodes, document, active, timers, modals };
}
function notificationWorld() {
  const storage = new Map(), shown = [], locks = new Map();
  const lock = (key, work) => { const next = (locks.get(key) || Promise.resolve()).then(work); locks.set(key, next.catch(() => {})); return next; };
  const tab = ({ storageError = false } = {}) => {
    const f = fixture();
    const consumer = f.sandbox.tracker({ readStorage: key => { if (storageError) throw Error('denied'); return storage.get(key) ?? null; }, writeStorage: (key, value) => { if (storageError) throw Error('denied'); storage.set(key, value); }, withLock: lock, visible: () => !f.document.hidden, currentEvent: value => f.sandbox.mintEventWallet(value), notify: events => shown.push(...events.map(value => value.id)) });
    return { ...f, consume: value => consumer.consume(value) };
  };
  return { storage, shown, tab };
}

test('Mint counts distinguish verified zero from unavailable, mismatched or invalid statistics', () => {
  const f = fixture(); assert.equal(f.sandbox.stats(f.wallets[0]).total, 0); assert.match(text(f.sandbox.cell(f.wallets[0])), /0 笔.*今日确认 0 笔/);
  f.state.status.mintSuccess = { available: false, wallets: null }; assert.equal(f.sandbox.stats(f.wallets[0]), null); assert.match(text(f.sandbox.cell(f.wallets[0])), /—.*统计暂不可用/);
  for (const row of [{ walletId: 'old-alpha', walletAddress: A, total: 9, today: 1 }, { walletId: 'alpha', walletAddress: B, total: 9, today: 1 }, { walletId: 'alpha', walletAddress: A, total: null, today: null }]) {
    f.state.status.mintSuccess = summary([], { wallets: [row] }); assert.equal(f.sandbox.stats(f.wallets[0]), null);
  }
});

test('first payload is a silent baseline and reloads do not repeat previously consumed event IDs', async () => {
  const w = notificationWorld(), first = w.tab(); await first.consume(summary([event(1, { recordedAt: 900 })])); assert.deepEqual(w.shown, []);
  const next = summary([event(1, { recordedAt: 900 }), event(2)], { asOf: 1010 }); await first.consume(next); await first.consume(next); assert.deepEqual(w.shown, [event(2).id]);
  const reloaded = w.tab(); await reloaded.consume(next); assert.deepEqual(w.shown, [event(2).id]);
  await reloaded.consume(summary([event(3)], { asOf: 1020 })); assert.deepEqual(w.shown, [event(2).id, event(3).id]); assert.equal(reloaded.state.walletId, 'beta', 'an Alpha notification does not change the selected Beta wallet');
});

test('Web Lock consumption deduplicates concurrent tabs against shared persistent state', async () => {
  const w = notificationWorld(), a = w.tab(), b = w.tab(); await Promise.all([a.consume(summary()), b.consume(summary())]);
  const next = summary([event(1), event(2, { recordedAt: 1001 })], { asOf: 1010 }); await Promise.all([a.consume(next), b.consume(next)]);
  assert.deepEqual(w.shown.sort(), [event(1).id, event(2).id]);
});

test('a different event ID cannot replay the same transaction hash as a second success card', async () => {
  const w = notificationWorld(), tab = w.tab(); await tab.consume(summary());
  await tab.consume(summary([event(1)], { asOf: 1010 }));
  await tab.consume(summary([event(1, { id: 'forged-other-id' })], { asOf: 1020 }));
  assert.deepEqual(w.shown, [event(1).id]);
});

test('reconnection consumes new live IDs only and never fabricates events from count increases', async () => {
  const w = notificationWorld(), tab = w.tab(); await tab.consume(summary());
  tab.document.hidden = true; const next = summary([event(1), event(2, { source: 'backfill' }), event(3, { recordedAt: 999 }), event(4, { walletAddress: B }), event(5, { walletId: 'old-alpha' }), event(6, { txHash: 'javascript:bad' })], { asOf: 1100 });
  await tab.consume(next); assert.deepEqual(w.shown, []);
  await tab.consume({ available: false }); tab.document.hidden = false; await tab.consume(next); assert.deepEqual(w.shown, [event(1).id]);
  await tab.consume(summary([], { asOf: 1200, wallets: [{ walletId: 'alpha', walletAddress: A, total: 1000, today: 1000 }] })); assert.deepEqual(w.shown, [event(1).id]);
});

test('storage denial degrades to memory dedupe and a new ledger starts with another quiet baseline', async () => {
  const w = notificationWorld(), tab = w.tab({ storageError: true }); await tab.consume(summary());
  const next = summary([event(1)], { asOf: 1010 }); await tab.consume(next); await tab.consume(next); assert.deepEqual(w.shown, [event(1).id]);
  const rebuilt = summary([event(2)], { trackingSince: 2000, ledgerId: '2000', asOf: 2010 }); await tab.consume(rebuilt); assert.deepEqual(w.shown, [event(1).id]);
});

test('seen IDs are bounded and same-millisecond live records remain separate notifications', async () => {
  const w = notificationWorld(), tab = w.tab(); await tab.consume(summary());
  await tab.consume(summary([event(1), event(2, { recordedAt: 1001 })], { asOf: 1002 })); assert.deepEqual(w.shown, [event(1).id, event(2).id]);
  for (let batch = 0; batch < 45; batch++) await tab.consume(summary(Array.from({ length: 50 }, (_, i) => event(100 + batch * 50 + i, { source: 'backfill' })), { asOf: 2000 + batch }));
  const saved = JSON.parse([...w.storage.values()][0]); assert.equal(saved.seenIds.length, 2000); assert.ok(saved.seenIds.includes(event(2349).id));
});

test('success cards are nonblocking, show NFT units safely and closing them cannot change counts', () => {
  const f = fixture(), initial = JSON.stringify(f.state.status), nft = event(1, { name: '<img src=x onerror=alert(1)>', assets: [{ address: C, standard: 'ERC721', tokenId: '7', amountBaseUnits: '1' }, { address: C, standard: 'ERC1155', tokenId: '8', amountBaseUnits: '3' }, { address: C, standard: 'ERC20', amountBaseUnits: '999999999999999999999999999999999999' }] });
  f.sandbox.queue([nft]); const card = f.sandbox.cards()[0]; assert.match(text(card), /Alpha.*<img src=x onerror=alert\(1\)>.*已确认 4 张 NFT/); assert.doesNotMatch(text(card), /999999999/);
  const link = walk(card).find(node => node.tag === 'a'); assert.equal(link.href, 'https://bscscan.com/tx/' + nft.txHash); assert.equal(link.rel, 'noopener noreferrer');
  assert.equal(f.document.activeElement, f.active); assert.equal(f.modals.length, 0); assert.equal(f.state.walletId, 'beta'); assert.equal(walk(card).some(node => node.tag === 'img'), false);
  walk(card).find(node => node['aria-label'] === '关闭 Mint 成功提示').onclick(); assert.equal(f.sandbox.cards().length, 0); assert.equal(JSON.stringify(f.state.status), initial);
});

test('a burst of events is summarized and no more than three Mint cards can be visible', () => {
  const f = fixture(); f.sandbox.queue([event(1), event(2), event(3)]); assert.equal(f.sandbox.cards().length, 3);
  f.sandbox.queue(Array.from({ length: 8 }, (_, i) => event(10 + i))); assert.equal(f.sandbox.cards().length, 3);
  const first = f.sandbox.cards()[0]; walk(first).find(node => node['aria-label'] === '关闭 Mint 成功提示').onclick();
  assert.equal(f.sandbox.cards().length, 3); assert.ok(f.sandbox.cards().some(card => /8 笔 Mint 已确认/.test(text(card))));
});

test('details explain since-enabled coverage and a missing recent row is not presented as zero historical mints', () => {
  const f = fixture(); f.state.status.mintSuccess = summary([], { wallets: [{ walletId: 'alpha', walletAddress: A, total: 12, today: 2 }] });
  f.sandbox.details('alpha'); const output = text(f.modals[0].body);
  assert.match(output, /启用前的历史不计入/); assert.match(output, /累计 12 笔.*今日确认 2 笔/); assert.match(output, /最近 50 笔记录中，暂无此钱包/);
  assert.equal(walk(f.sandbox.link({ txHash: 'javascript:alert(1)' })).some(node => node.tag === 'a'), false);
});

test('out-of-order status replies do not regress same-ledger counters, while unavailable responses remain unknown', async () => {
  const f = fixture(), newer = summary([], { asOf: 5000, wallets: [{ walletId: 'alpha', walletAddress: A, total: 5, today: 5 }] }); f.state.status.mintSuccess = newer;
  f.sandbox.api = async () => ({ mintSuccess: summary([], { asOf: 4000, wallets: [{ walletId: 'alpha', walletAddress: A, total: 4, today: 4 }] }) }); await f.sandbox.refresh(); assert.equal(f.sandbox.stats(f.wallets[0]).total, 5);
  f.sandbox.api = async () => ({ mintSuccess: { version: 1, available: false, wallets: null } }); await f.sandbox.refresh(); assert.equal(f.sandbox.stats(f.wallets[0]), null);
});
