import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { acquireWalletFileLock, atomicWalletJson, walletRuntimeDirectory } from './wallet-executor.mjs';
import { effectiveWalletConfig, getWalletId, normalizeWalletConfig } from './wallet-model.mjs';

const fail = message => Object.assign(new Error(message), { status: 409 });
const ownValue = (value, key) => Object.hasOwn(value || {}, key) ? value[key] : undefined;
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value) && !['__proto__', 'prototype', 'constructor'].includes(value);
const asWei = value => {
  const text = typeof value === 'bigint' ? value.toString() : value;
  if (typeof text !== 'string' || !/^\d{1,78}$/.test(text)) throw fail('预算金额必须是非负 wei 整数字符串');
  return BigInt(text);
};

export function bnbToWei(value) {
  if (typeof value === 'number' && (!Number.isFinite(value) || value < 0)) throw fail('BNB 预算金额无效');
  let text = String(value);
  if (/^\d+(?:\.\d+)?e[+-]?\d+$/i.test(text)) {
    const [coefficient, exponent] = text.toLowerCase().split('e'), [whole, fraction = ''] = coefficient.split('.');
    const digits = whole + fraction, point = whole.length + Number(exponent);
    text = point <= 0 ? '0.' + '0'.repeat(-point) + digits : point >= digits.length ? digits + '0'.repeat(point - digits.length) : digits.slice(0, point) + '.' + digits.slice(point);
  }
  if (!/^\d+(?:\.\d{1,18})?$/.test(text)) throw fail('BNB 预算最多支持 18 位小数');
  const [whole, fraction = ''] = text.split('.');
  return (BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, '0'))).toString();
}

export function createWalletBudget({ root, now = Date.now } = {}) {
  const directory = walletRuntimeDirectory(root), path = join(directory, 'budget.json'), lock = join(directory, 'budget.lock');
  function load() {
    if (!existsSync(path)) return { version: 1, days: {}, reservations: {}, legacyImports: {} };
    let value;
    try { value = JSON.parse(readFileSync(path, 'utf8')); } catch { throw fail('钱包预算账本损坏，请恢复备份后再交易'); }
    if (value?.version !== 1 || !value.days || !value.reservations || !value.legacyImports || [value.days, value.reservations, value.legacyImports].some(item => typeof item !== 'object' || Array.isArray(item))) throw fail('钱包预算账本格式无效，已停止付费交易');
    for (const [name, day] of Object.entries(value.days)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(name) || !day || typeof day !== 'object' || Array.isArray(day)) throw fail('预算日期或钱包记录无效');
      for (const [id, amount] of Object.entries(day)) { if (!validId(id)) throw fail('预算钱包身份无效'); asWei(amount); }
    }
    for (const entry of Object.values(value.reservations)) {
      if (!entry || !validId(entry.walletId) || !['reserved', 'settled', 'released'].includes(entry.status) || !/^\d{4}-\d{2}-\d{2}$/.test(entry.day)) throw fail('预算预占记录无效');
      asWei(entry.amountWei);
      if (entry.spentWei !== undefined) asWei(entry.spentWei);
    }
    return value;
  }
  const today = config => new Intl.DateTimeFormat('en-CA', { timeZone: config.timeZone || 'Asia/Shanghai' }).format(new Date(now()));
  async function transaction(work) {
    const release = await acquireWalletFileLock(lock);
    try {
      const state = load(), result = await work(state);
      atomicWalletJson(path, state);
      return result;
    } finally { release(); }
  }
  function legacySource(explicit) {
    if (explicit !== undefined) return explicit;
    const statePath = join(root, 'data', 'watch_state.json');
    if (!existsSync(statePath)) return null;
    try { return JSON.parse(readFileSync(statePath, 'utf8')).paidSpend || null; }
    catch { throw fail('无法核对旧预算记录，已停止付费交易'); }
  }
  function importLegacy(state, config, explicit) {
    const source = legacySource(explicit), day = today(config);
    if (!source || source.day !== day) return;
    state.days[day] ||= {};
    state.legacyImports[day] ||= {};
    const profiles = normalizeWalletConfig(config).wallets || [];
    for (const wallet of profiles) {
      const id = getWalletId(wallet);
      if (state.legacyImports[day][id]) continue;
      if (!Array.isArray(wallet.legacyNames)) throw fail('旧钱包历史别名记录无效，请人工核对');
      const indexed = ownValue(source, id);
      const values = indexed !== undefined ? [indexed] : wallet.legacyNames.map(name => ownValue(source, name)).filter(value => value !== undefined);
      if (values.some(value => typeof value !== 'number' || !Number.isFinite(value) || value < 0)) throw fail('旧钱包预算记录无效，请人工核对');
      const amount = values.length ? Math.max(...values) : 0;
      const spent = BigInt(bnbToWei(amount));
      state.days[day][id] = ((asWei(state.days[day][id] || '0') > spent) ? asWei(state.days[day][id]) : spent).toString();
      state.legacyImports[day][id] = true;
    }
  }
  function totals(state, day, walletId) {
    const spentWei = Object.entries(state.days[day] || {}).reduce((sum, [id, amount]) => sum + (!walletId || walletId === id ? asWei(amount) : 0n), 0n);
    // Reservations survive midnight until an explicit final result; an unknown
    // transaction cannot gain a fresh allowance by waiting for a new date.
    const reservedWei = Object.values(state.reservations).reduce((sum, reservation) => sum + (reservation.status === 'reserved' && (!walletId || reservation.walletId === walletId) ? asWei(reservation.amountWei) : 0n), 0n);
    return { spentWei, reservedWei };
  }
  function formatted(total, limit) {
    const maxWei = limit == null ? null : BigInt(bnbToWei(limit));
    const remaining = maxWei === null ? null : maxWei - total.spentWei - total.reservedWei;
    return { spentWei: total.spentWei.toString(), reservedWei: total.reservedWei.toString(), remainingWei: remaining === null ? null : (remaining > 0n ? remaining : 0n).toString(), limitWei: maxWei === null ? null : maxWei.toString() };
  }
  return {
    async reserve({ wallet, config, amountWei, id = randomUUID(), legacySpent } = {}) {
      const amount = asWei(amountWei), walletId = getWalletId(wallet);
      if (!validId(walletId) || amount <= 0n || typeof id !== 'string' || !/^[a-zA-Z0-9:_-]{1,160}$/.test(id)) throw fail('预算预占任务或金额无效');
      return transaction(state => {
        importLegacy(state, config, legacySpent);
        if (['__proto__', 'prototype', 'constructor'].includes(id)) throw fail('预算预占任务 ID 无效');
        const day = today(config), existing = ownValue(state.reservations, id);
        if (existing) {
          if (existing.walletId !== walletId || existing.amountWei !== amount.toString() || existing.status !== 'reserved') throw fail('预算任务已结算或参数发生变化，不能重复提交');
          return { ...existing };
        }
        const paid = effectiveWalletConfig(config, wallet).paid, own = totals(state, day, walletId), total = totals(state, day);
        if (asWei(bnbToWei(paid.maxBnbPerDay)) < own.spentWei + own.reservedWei + amount) throw fail('超过此钱包每日付费额度');
        const cap = config.portfolioBudget?.maxBnbPerDay;
        if (cap != null && asWei(bnbToWei(cap)) < total.spentWei + total.reservedWei + amount) throw fail('超过全部钱包每日付费总额度');
        const reservation = { id, walletId, day, amountWei: amount.toString(), status: 'reserved', createdAt: now() };
        state.reservations[id] = reservation;
        return { ...reservation };
      });
    },
    async settle(id, { spentWei } = {}) {
      return transaction(state => {
        const reservation = ownValue(state.reservations, id);
        if (!reservation) throw fail('预算预占任务不存在');
        if (reservation.status === 'settled') return { ...reservation };
        if (reservation.status !== 'reserved') throw fail('已释放的预算任务不能结算');
        const spent = asWei(spentWei ?? reservation.amountWei);
        state.days[reservation.day] ||= {};
        state.days[reservation.day][reservation.walletId] = (asWei(state.days[reservation.day][reservation.walletId] || '0') + spent).toString();
        Object.assign(reservation, { status: 'settled', spentWei: spent.toString(), settledAt: now() });
        return { ...reservation };
      });
    },
    async release(id) {
      return transaction(state => {
        const reservation = ownValue(state.reservations, id);
        if (!reservation) throw fail('预算预占任务不存在');
        if (reservation.status === 'settled') throw fail('已花费的额度不能释放');
        Object.assign(reservation, { status: 'released', releasedAt: now() });
        return { ...reservation };
      });
    },
    async view(config) {
      return transaction(state => {
        importLegacy(state, config);
        const day = today(config), wallets = {};
        for (const wallet of normalizeWalletConfig(config).wallets || []) {
          const id = getWalletId(wallet);
          if (!validId(id)) throw fail('预算钱包身份无效');
          wallets[id] = formatted(totals(state, day, id), effectiveWalletConfig(config, wallet).paid.maxBnbPerDay);
        }
        return { day, wallets, portfolio: formatted(totals(state, day), config.portfolioBudget?.maxBnbPerDay ?? null) };
      });
    },
  };
}
