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
const USD_CAP = 60n * 1000000n;
export const usdToMicros = value => (BigInt(bnbToWei(value)) / 1000000000000n).toString();

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
    if (!existsSync(path)) return { version: 1, days: {}, usdDays: {}, reservations: {}, legacyImports: {}, usdLegacyImports: {} };
    let value;
    try { value = JSON.parse(readFileSync(path, 'utf8')); } catch { throw fail('钱包预算账本损坏，请恢复备份后再交易'); }
    if (value?.version !== 1 || !value.days || !value.reservations || !value.legacyImports || [value.days, value.reservations, value.legacyImports].some(item => typeof item !== 'object' || Array.isArray(item))) throw fail('钱包预算账本格式无效，已停止付费交易');
    value.usdDays ??= {}; value.usdLegacyImports ??= {};
    if ([value.usdDays, value.usdLegacyImports].some(item => !item || typeof item !== 'object' || Array.isArray(item))) throw fail('USD 预算账本格式无效');
    for (const [name, day] of [...Object.entries(value.days), ...Object.entries(value.usdDays)]) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(name) || !day || typeof day !== 'object' || Array.isArray(day)) throw fail('预算日期或钱包记录无效');
      for (const [id, amount] of Object.entries(day)) { if (!validId(id)) throw fail('预算钱包身份无效'); asWei(amount); }
    }
    for (const entry of Object.values(value.reservations)) {
      if (!entry || !validId(entry.walletId) || !['reserved', 'settled', 'released'].includes(entry.status) || !/^\d{4}-\d{2}-\d{2}$/.test(entry.day)) throw fail('预算预占记录无效');
      asWei(entry.amountWei);
      if (entry.spentWei !== undefined) asWei(entry.spentWei);
      if (entry.amountUsdMicros !== undefined) asWei(entry.amountUsdMicros);
      if (entry.spentUsdMicros !== undefined) asWei(entry.spentUsdMicros);
      if (entry.projectId !== undefined && (!/^0x[0-9a-f]{40}$/.test(entry.projectId) || entry.amountUsdMicros === undefined || entry.projectLimitUsdMicros === undefined)) throw fail('项目 USD 额度记录无效');
      if (entry.projectLimitUsdMicros !== undefined) asWei(entry.projectLimitUsdMicros);
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
  function importLegacyUsd(state, config) {
    const day = today(config); state.usdDays[day] ||= {}; state.usdLegacyImports[day] ||= {};
    for (const wallet of normalizeWalletConfig(config).wallets || []) {
      const id = getWalletId(wallet);
      if (state.usdLegacyImports[day][id]) continue;
      // Old BNB accounting does not prove its historical USD exchange rate.
      // Consume this day's USD allowance instead of guessing a cheaper price.
      if (asWei(state.days[day]?.[id] || '0') > 0n && !Object.hasOwn(state.usdDays[day], id)) state.usdDays[day][id] = USD_CAP.toString();
      state.usdLegacyImports[day][id] = true;
    }
  }
  function usdTotals(state, day, walletId) {
    const spent = asWei(state.usdDays[day]?.[walletId] || '0');
    const pending = Object.values(state.reservations).filter(r => r.status === 'reserved' && r.walletId === walletId);
    return { spent, reserved: pending.reduce((sum, r) => sum + (r.amountUsdMicros === undefined ? USD_CAP : asWei(r.amountUsdMicros)), 0n), review: pending.some(r => r.amountUsdMicros === undefined) };
  }
  function usdView(state, day, walletId, limit) {
    const t = usdTotals(state, day, walletId), cap = asWei(usdToMicros(limit ?? 60)), remaining = cap - t.spent - t.reserved;
    return { spentUsdMicros: t.spent.toString(), reservedUsdMicros: t.reserved.toString(), remainingUsdMicros: (remaining > 0n ? remaining : 0n).toString(), limitUsdMicros: cap.toString(), usdReviewRequired: t.review };
  }
  function formatted(total, limit) {
    const maxWei = limit == null ? null : BigInt(bnbToWei(limit));
    const remaining = maxWei === null ? null : maxWei - total.spentWei - total.reservedWei;
    return { spentWei: total.spentWei.toString(), reservedWei: total.reservedWei.toString(), remainingWei: remaining === null ? null : (remaining > 0n ? remaining : 0n).toString(), limitWei: maxWei === null ? null : maxWei.toString() };
  }
  return {
    async reserve({ wallet, config, amountWei, amountUsdMicros, projectId, projectLimitUsdMicros, id = randomUUID(), legacySpent } = {}) {
      const amount = asWei(amountWei), walletId = getWalletId(wallet);
      const usd = amountUsdMicros === undefined ? null : asWei(amountUsdMicros);
      const project = projectId === undefined ? null : String(projectId).toLowerCase(), projectLimit = projectLimitUsdMicros === undefined ? null : asWei(projectLimitUsdMicros);
      if ((project !== null || projectLimit !== null) && (usd === null || !/^0x[0-9a-f]{40}$/.test(project || '') || projectLimit === null || projectLimit <= 0n || projectLimit > 10000000n)) throw fail('NFT 项目额度参数无效');
      if (!validId(walletId) || amount <= 0n || typeof id !== 'string' || !/^[a-zA-Z0-9:_-]{1,160}$/.test(id)) throw fail('预算预占任务或金额无效');
      return transaction(state => {
        importLegacy(state, config, legacySpent);
        importLegacyUsd(state, config);
        const paid = effectiveWalletConfig(config, wallet).paid;
        const configuredProjectLimit = project === null ? null : asWei(usdToMicros(paid.maxUsd));
        const effectiveProjectLimit = project === null ? null : projectLimit < configuredProjectLimit ? projectLimit : configuredProjectLimit;
        if (['__proto__', 'prototype', 'constructor'].includes(id)) throw fail('预算预占任务 ID 无效');
        const day = today(config), existing = ownValue(state.reservations, id);
        if (existing) {
          if (existing.walletId !== walletId || existing.amountWei !== amount.toString() || (existing.amountUsdMicros ?? null) !== (usd === null ? null : usd.toString()) || (existing.projectId ?? null) !== project || (existing.projectLimitUsdMicros ?? null) !== (effectiveProjectLimit?.toString() ?? null) || existing.status !== 'reserved') throw fail('预算任务已结算或参数发生变化，不能重复提交');
          return { ...existing };
        }
        const own = totals(state, day, walletId), total = totals(state, day);
        if (asWei(bnbToWei(paid.maxBnbPerDay)) < own.spentWei + own.reservedWei + amount) throw fail('超过此钱包每日付费额度');
        const cap = config.portfolioBudget?.maxBnbPerDay;
        if (cap != null && asWei(bnbToWei(cap)) < total.spentWei + total.reservedWei + amount) throw fail('超过全部钱包每日付费总额度');
        if (usd !== null) { const used = usdTotals(state, day, walletId), limit = asWei(usdToMicros(paid.dayUsd)); if (usd <= 0n || used.spent + used.reserved + usd > limit) throw fail('超过此钱包每日 USD 付费额度'); }
        if (project !== null) {
          const used = Object.values(state.reservations).filter(r => r.walletId === walletId && r.projectId === project).reduce((sum, r) => sum + (r.status === 'reserved' ? asWei(r.amountUsdMicros) : r.status === 'settled' ? asWei(r.spentUsdMicros ?? r.amountUsdMicros) : 0n), 0n);
          if (used + usd > effectiveProjectLimit) throw fail('超过此钱包在该 NFT 项目的累计 USD 额度');
        }
        const reservation = { id, walletId, day, amountWei: amount.toString(), ...(usd === null ? {} : { amountUsdMicros: usd.toString() }), ...(project === null ? {} : { projectId: project, projectLimitUsdMicros: effectiveProjectLimit.toString() }), status: 'reserved', createdAt: now() };
        state.reservations[id] = reservation;
        return { ...reservation };
      });
    },
    async settle(id, { spentWei, spentUsdMicros } = {}) {
      return transaction(state => {
        const reservation = ownValue(state.reservations, id);
        if (!reservation) throw fail('预算预占任务不存在');
        if (reservation.status === 'settled') return { ...reservation };
        if (reservation.status !== 'reserved') throw fail('已释放的预算任务不能结算');
        const spent = asWei(spentWei ?? reservation.amountWei);
        // A verified debit is recorded in full even if it exceeds an estimate;
        // subsequent reservations see that actual debit and cannot spend it again.
        state.days[reservation.day] ||= {};
        state.days[reservation.day][reservation.walletId] = (asWei(state.days[reservation.day][reservation.walletId] || '0') + spent).toString();
        if (reservation.amountUsdMicros !== undefined) {
          const usd = asWei(spentUsdMicros ?? reservation.amountUsdMicros); state.usdDays[reservation.day] ||= {};
          state.usdDays[reservation.day][reservation.walletId] = (asWei(state.usdDays[reservation.day][reservation.walletId] || '0') + usd).toString();
          reservation.spentUsdMicros = usd.toString();
        } else if (spent > 0n) {
          // A legacy pending payment may settle after view() marked migration
          // complete. Preserve its conservative USD charge when it stops being
          // a reservation; unknown historical prices cannot restore allowance.
          state.usdDays[reservation.day] ||= {};
          const previous = asWei(state.usdDays[reservation.day][reservation.walletId] || '0');
          state.usdDays[reservation.day][reservation.walletId] = (previous > USD_CAP ? previous : USD_CAP).toString();
          reservation.spentUsdMicros = USD_CAP.toString();
        }
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
        importLegacyUsd(state, config);
        const day = today(config), wallets = {};
        for (const wallet of normalizeWalletConfig(config).wallets || []) {
          const id = getWalletId(wallet);
          if (!validId(id)) throw fail('预算钱包身份无效');
          const paid = effectiveWalletConfig(config, wallet).paid;
          wallets[id] = { ...formatted(totals(state, day, id), paid.maxBnbPerDay), ...usdView(state, day, id, paid.dayUsd) };
        }
        return { day, wallets, portfolio: formatted(totals(state, day), config.portfolioBudget?.maxBnbPerDay ?? null) };
      });
    },
  };
}
