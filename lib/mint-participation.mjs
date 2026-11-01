import { randomUUID } from 'node:crypto';

const address = /^0x[0-9a-f]{40}$/;
const fail = message => { throw Object.assign(new Error(message), { code: 'MINT_POLICY_DEFERRED' }); };
function uint(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) fail('项目规模或铸造份数无法核验');
  const text = String(value);
  if (!/^\d{1,78}$/.test(text)) fail('项目规模或铸造份数无法核验');
  return BigInt(text);
}
export function createMintParticipation({ state, save = () => {}, now = Date.now } = {}) {
  state.mintParticipation ??= { version: 1, projects: {} };
  const ledger = state.mintParticipation;
  if (ledger.version !== 1 || !ledger.projects || typeof ledger.projects !== 'object' || Array.isArray(ledger.projects)) fail('项目累计份额账本损坏，停止自动付费');
  function record(project) {
    const item = ledger.projects[project];
    if (!item) return null;
    if (!item || typeof item !== 'object' || !item.reservations || typeof item.reservations !== 'object' || Array.isArray(item.reservations)) fail('项目累计份额记录损坏');
    uint(item.limitQuantity); uint(item.limitBnbWei);
    for (const entry of Object.values(item.reservations)) {
      if (!entry || !['reserved', 'confirmed', 'reverted', 'rejected'].includes(entry.status) || typeof entry.walletId !== 'string') fail('项目累计预占记录损坏');
      if (uint(entry.quantity) <= 0n || uint(entry.amountBnbWei) <= 0n) fail('项目累计预占金额无效');
    }
    return item;
  }
  function quote({ project, cap, sold, unitBnbWei, quantity, amountBnbWei, legacyUnknown = false, excludeId = null }) {
    if (!address.test(project || '')) fail('项目地址无法核验');
    const total = uint(cap), minted = uint(sold), unit = uint(unitBnbWei), count = uint(quantity), amount = uint(amountBnbWei);
    if (total <= 0n || minted > total || unit <= 0n || count <= 0n || amount <= 0n) fail('项目价格、已售或本次份数无法核验');
    if (amount < unit * count) fail('项目付款金额低于可核验单价，不能核验 2% 额度');
    const totalBnb = total * unit;
    if (totalBnb < 10n * 10n ** 18n) fail('总盘不足 10 BNB，防定点钓鱼规则未通过');
    if (minted < 500n && minted * unit < 5n * 10n ** 18n) fail('已售不足 500 份且已募不足 5 BNB');
    let previous = record(project);
    if (legacyUnknown) { previous ||= ledger.projects[project] = { limitQuantity: '0', limitBnbWei: '0', reservations: {} }; previous.legacyUnknown = true; save(true); }
    if (previous?.legacyUnknown) fail('此项目存在无法核验份数的历史铸造或在途记录，暂停自动追加');
    const limitQuantity = previous && uint(previous.limitQuantity) < total / 50n ? uint(previous.limitQuantity) : total / 50n;
    const limitBnbWei = previous && uint(previous.limitBnbWei) < totalBnb / 50n ? uint(previous.limitBnbWei) : totalBnb / 50n;
    let usedQuantity = 0n, usedBnbWei = 0n;
    if (excludeId && (!previous?.reservations[excludeId] || previous.reservations[excludeId].status !== 'reserved' || count > uint(previous.reservations[excludeId].quantity) || amount > uint(previous.reservations[excludeId].amountBnbWei))) fail('最终铸造超出补款前的项目预占');
    for (const [id, entry] of Object.entries(previous?.reservations || {})) if (id !== excludeId && (entry.status === 'reserved' || entry.status === 'confirmed')) { usedQuantity += uint(entry.quantity); usedBnbWei += uint(entry.amountBnbWei); }
    if (usedQuantity + count > limitQuantity || usedBnbWei + amount > limitBnbWei) fail('全部钱包在此项目的累计投入（含在途）超过总盘 2%');
    if (previous && (previous.limitQuantity !== limitQuantity.toString() || previous.limitBnbWei !== limitBnbWei.toString())) { previous.limitQuantity = limitQuantity.toString(); previous.limitBnbWei = limitBnbWei.toString(); save(true); }
    return { project, cap: total.toString(), sold: minted.toString(), unitBnbWei: unit.toString(), quantity: count.toString(), amountBnbWei: amount.toString(), limitQuantity: limitQuantity.toString(), limitBnbWei: limitBnbWei.toString(), legacyUnknown };
  }
  let migrated = false;
  const blockLegacy = (project, walletId = null) => {
    if (!address.test(project || '')) return;
    const previous = record(project);
    if (walletId && Object.values(previous?.reservations || {}).some(entry => entry.walletId === walletId && ['reserved', 'confirmed'].includes(entry.status))) return;
    const item = previous || (ledger.projects[project] = { limitQuantity: '0', limitBnbWei: '0', reservations: {} });
    if (!item.legacyUnknown) { item.legacyUnknown = true; migrated = true; }
  };
  for (const [project, info] of Object.entries(state.paid || {})) for (const [walletId, status] of Object.entries(info.done || {})) if (['minted', 'free', 'unknown', 'full'].includes(status)) blockLegacy(project, walletId);
  for (const [project, done] of Object.entries(state.forceDone || {})) if (done && !record(project)) blockLegacy(project);
  for (const pending of Object.values(state.walletPending || {})) if (!pending.participationId && pending.kind === 'contract') blockLegacy(pending.expected?.to?.toLowerCase());
  if (migrated) save(true);
  return {
    quote,
    markUnknown(project) { blockLegacy(project); save(true); },
    release(id) {
      const item = Object.values(ledger.projects).find(project => Object.hasOwn(project.reservations || {}, id)), entry = item?.reservations[id];
      if (!entry) fail('项目预占记录缺失');
      if (entry.status === 'reserved') { entry.status = 'rejected'; entry.settledAt = now(); save(true); }
    },
    reserve(plan, walletId) {
      if (typeof walletId !== 'string' || !walletId) fail('项目预占钱包身份无效');
      const checked = quote({ ...plan, excludeId: null }), id = randomUUID();
      const item = ledger.projects[checked.project] ||= { limitQuantity: checked.limitQuantity, limitBnbWei: checked.limitBnbWei, reservations: {} };
      item.limitQuantity = checked.limitQuantity; item.limitBnbWei = checked.limitBnbWei;
      item.reservations[id] = { walletId, quantity: checked.quantity, amountBnbWei: checked.amountBnbWei, status: 'reserved', createdAt: now() };
      save(true); return id;
    },
    settle(id, { status, txHash } = {}) {
      if (!['confirmed', 'reverted', 'rejected'].includes(status)) fail('项目预占结果尚未核验');
      const item = Object.values(ledger.projects).find(project => Object.hasOwn(project.reservations || {}, id));
      const entry = item?.reservations[id]; if (!entry) fail('项目预占记录缺失');
      if (entry.status !== 'reserved') { if (entry.status !== status || status === 'confirmed' && entry.txHash !== txHash?.toLowerCase()) fail('项目预占结算结果冲突'); return; }
      if (status === 'confirmed' && !/^0x[0-9a-f]{64}$/i.test(txHash || '')) fail('项目铸造交易哈希无法核验');
      Object.assign(entry, { status, settledAt: now(), ...(status === 'confirmed' ? { txHash: txHash.toLowerCase() } : {}) }); save(true);
    },
  };
}
