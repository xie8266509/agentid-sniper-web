// All execution state lives in memory. This boundary double cannot start a
// process, reach a network endpoint or read a user's wallet/session files.
export function scannerRuntimeDouble({ sandbox, wallet, state, events }) {
  state.walletPending ||= {};
  let sequence = 0, usedWei = BigInt(Math.ceil((state.paidSpend?.[wallet.id] || 0) * 1e9)) * 1000000000n, usedUsdMicros = 0n;
  const reservations = new Map(), blocked = new Map(), settled = new Set();
  events.reservations = reservations;
  const budget = {
    async reserve({ wallet: selected, amountWei, amountUsdMicros, projectId, projectLimitUsdMicros, config }) {
      if (amountUsdMicros === undefined || BigInt(amountUsdMicros) <= 0n) throw new Error('Scanner must reserve a verified positive USD cost');
      amountWei = BigInt(amountWei);
      const outstanding = [...reservations.values()].reduce((sum, entry) => sum + BigInt(entry.amountWei), 0n);
      const outstandingUsd = [...reservations.values()].reduce((sum, entry) => sum + BigInt(entry.amountUsdMicros), 0n);
      const maximum = sandbox.PAID.maxBnbPerDay;
      if (!(sandbox.PAID.maxUsd > 0) || !(maximum > 0) || usedWei + outstanding + amountWei > BigInt(Math.round(maximum * 1e9)) * 1000000000n) throw new Error('超过共享钱包预算');
      if (usedUsdMicros + outstandingUsd + BigInt(amountUsdMicros) > BigInt(Math.round(sandbox.PAID.dayUsd * 1e6))) throw new Error('超过每日 USD 预算');
      const entry = { id: `mock-reservation-${++sequence}`, amountWei: amountWei.toString(), amountUsdMicros: amountUsdMicros.toString(), walletId: selected.id, ...(projectId ? { projectId, projectLimitUsdMicros } : {}) };
      (events.reservationCalls ||= []).push({ ...entry });
      reservations.set(entry.id, entry); return entry;
    },
    async settle(id, { spentWei, spentUsdMicros } = {}) { if (settled.has(id)) return; const entry = reservations.get(id); if (!entry) throw new Error('Missing fake reservation'); usedWei += BigInt(spentWei ?? entry.amountWei); usedUsdMicros += BigInt(spentUsdMicros ?? entry.amountUsdMicros); reservations.delete(id); settled.add(id); },
    async release(id) { reservations.delete(id); },
  };
  return {
    async reconcileScannerPending({ pending, budget: selectedBudget }) { if (pending.reservationId) await selectedBudget.settle(pending.reservationId, { spentWei: BigInt(pending.settlement.successSpentWei), ...(pending.settlement.successSpentUsdMicros !== undefined ? { spentUsdMicros: pending.settlement.successSpentUsdMicros } : {}) }); blocked.delete(wallet.id); return { resolved: true, status: 'confirmed', spentWei: pending.settlement.successSpentWei, ...(pending.txHash ? { txHash: pending.txHash } : {}) }; },
    logWallet: (selected, text) => sandbox.log(`[${selected.id}][${selected.name}] ${text}`),
    syncWalletProfiles: () => sandbox.WALLETS,
    currentRuntimeConfig: () => ({ ...sandbox.CONFIG, monitorOnly: sandbox.MONITOR_ONLY, paid: sandbox.PAID, wallets: [wallet.profile] }),
    paidFor: () => sandbox.PAID,
    canWallet: () => !sandbox.MONITOR_ONLY,
    async withWalletExecution(selected, work, { allowBlocked } = {}) { if (!allowBlocked && blocked.has(selected.id)) throw new Error('結果不明：此钱包尚有待核对交易'); return work(); },
    async markWalletBlocked(selected, reason, { details = {} } = {}) { blocked.set(selected.id, { reason, details }); },
    async clearWalletBlocked(selected) { blocked.delete(selected.id); },
    assertWalletMaintenanceIdle: () => {},
    createWalletBudget: () => budget,
  };
}
