// Agent ID Sniper — 幣安 Agentic Wallet（.ai Agent ID）專屬鑄造監控 + 自動鑄造 + 持倉自動止盈。
// 全部在本地跑：掃 BSC 新合約 → 模擬 → 用 baw CLI 自動打 → 開池後照規則自動賣 → Telegram 通知。不使用任何 AI。
// 停止：在同資料夾放 WATCH_STOP 檔。設定見 config.example.json。
import { appendFileSync, writeFileSync, readFileSync, existsSync, statSync, renameSync, unlinkSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeWatchBaw } from './lib/wallet-cli.mjs';
import { getPaidConfig, getRuleConfig, withinPaidBudget } from './lib/config.mjs';
import { decodeAbiUint } from './lib/nft-codec.mjs';
import { normalizeWalletConfig, getWalletId, effectiveWalletConfig, walletCanAutomate } from './lib/wallet-model.mjs';
import { withWalletExecution, markWalletBlocked, clearWalletBlocked, assertWalletMaintenanceIdle } from './lib/wallet-executor.mjs';
import { createWalletBudget } from './lib/wallet-budget.mjs';
import { reconcileScannerPending } from './lib/scanner-recovery.mjs';
import { ensureEntryPolicy, effectiveEntryPolicy, entryGate, createMintRisk, deriveMintCost, MINT_RISK_LIMITS } from './lib/mint-policy.mjs';
import { createMintMedia } from './lib/mint-media.mjs';
import { createSafeWeb } from './lib/safe-web.mjs';
import { processSocialCandidates, socialSelectionHash } from './lib/social-candidates.mjs';
import { FREE_PEAK_DELAY_MS, FREE_SELL_MIN_USD, applyConfirmedSell, formatTokenAmount, marketOrderRecord, marketOrderState, normalizedPositionValue, parseTokenAmount, planPositionSell, positionStateKey, receiptTokenOutflow, refundedTokenUnits, samplePositionDrawdown } from './lib/sell-rules.mjs';

const DIR = dirname(fileURLToPath(import.meta.url));
assertWalletMaintenanceIdle(DIR);
const SELF = fileURLToPath(import.meta.url), SELF_MT = statSync(SELF).mtimeMs;
const LOG = join(DIR, 'data', 'watch.log'), STATE = join(DIR, 'data', 'watch_state.json');
mkdirSync(join(DIR, 'data'), { recursive: true });
{ /* 審查 11/1：同時跑兩份會重複鑄造、重複賣、互相覆蓋紀錄 → 只允許一份在跑 */ const lk = join(DIR, 'data', 'watch.lock'); try { const old = existsSync(lk) ? Number(readFileSync(lk, 'utf8')) : 0; if (old && old !== process.pid) { let alive = false; try { process.kill(old, 0); alive = true; } catch {} if (alive) { console.log(`已經有一份在執行（PID ${old}），這份不重複啟動`); process.exit(0); } } writeFileSync(lk, String(process.pid)); process.on('exit', () => { try { if (Number(readFileSync(lk, 'utf8')) === process.pid) unlinkSync(lk); } catch {} }); } catch {} }
const ts = () => new Date().toLocaleString('zh-TW', { hour12: false, timeZone: CONFIG.timeZone || 'Asia/Taipei' });
const log = (s) => { try { appendFileSync(LOG, `[${ts()}] ${s}\n`); } catch {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CONFIG = normalizeWalletConfig(JSON.parse(readFileSync(join(DIR, 'config.json'), 'utf8')));
const MONITOR_ONLY = CONFIG.monitorOnly === true;
const FILE_COMMANDS_ENABLED = CONFIG.enableFileCommands === true;
const CONFIG_LOADED_AT = Date.now();
const MONITOR_NOTE = '👀 仅监控模式：自动铸造和买卖已关闭';
const USDT = '0x55d398326f99059ff775485246999027b3197955', WBNB = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', USD1 = '0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d';
const NATIVE_BNB = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'; // 賣出一律換回 BNB
const ROUTER = '0x10ed43c718714eb63d5aa57b78b54704e256024e', FACTORY = '0xca143ce32fe78f1f7019d7d551a6402fc5350c73';
const REGISTRY = '60b9262456de011f7d15a54cdd8c48baaa8b022f'; // 幣安 Agent ID 登記合約：合約碼裡出現它 = 只限 Agent ID
const INFRA = new Set(['0x' + REGISTRY]); // Agent ID 登記合約本身不是鑄造項目（用户反馈 v2.4.4：开源版漏了这一行，ReferenceError: INFRA is not defined）
const T_TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const T_SWAP = '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822';

// 手動追蹤的持倉（config.json 的 tokens）。cost = 每個錢包的成本（U）；both = 每個錢包都有這個成本；hold = 不自動賣只通知；sellNow = 立刻全部賣出
const TOKENS = (CONFIG.tokens || []).map((t) => ({ ...t, addr: t.addr.toLowerCase() }));
// 旧配置保持原规则；新版阶梯与长抱须由配置明确选择。
const RULE = getRuleConfig(CONFIG);
const ruleTxt = () => RULE.strategy === 'legacy'
  ? `${RULE.backX} 倍回本、${RULE.halfX.map((x) => x + ' 倍减半').join('、')}；按已保存的速战、滞涨和回撤规则执行`
  : `${RULE.backX} 倍回本、${RULE.steps.map(([x, p]) => x + ' 倍卖 ' + p + '%').join('、')}；回本前回撤 ${Math.round(RULE.crash * 100)}%，回本后回撤 ${Math.round(RULE.crashAfterBack * 100)}%，留 ${RULE.moonPct}% 长抱`;

let TG = null;
{ const a = CONFIG.telegram?.botToken || process.env.TG_BOT_TOKEN, b = CONFIG.telegram?.chatId || process.env.TG_CHAT_ID; if (a && b) TG = { a, b }; }
// 使用者定：只有要買賣、要使用者決定的才響鈴；其他（自動鑄、收到幣、登入成功…）靜音送達
const isFreeMintNote = (t) => /^🆓/u.test(t) || (/^🆕/u.test(t) && t.includes('🤖 已自動鑄造'));
const important = (t) => !isFreeMintNote(t) && (/^(⏰|⚠️|🔑|💰|🔥|🚀|🦋|🏗|🛒|🔔)/u.test(t) || t.includes('不是免費'));

const sendable = (t) => (!GROUP_ID && /^(🛒|🚀)/u.test(t)) || /^(💰|🔑|⏰|🦋|🔔)/u.test(t) /* 免费达标改为通知，由用户决定是否手动铸造。 */ || (/^🚀/u.test(t) && t.includes('平台幣')) || (/^🔥/u.test(t) && /\d+ 倍/.test(t) && !t.includes('搶打')) || (/^⚠️/u.test(t) && /(想賣但失敗|回調|回落|登入|開發者模式|打不了|自動打失敗|掃描落後|結果不明|BNB 快不夠|賣不出|貔貅|Flap)/.test(t));

const GROUP_ID = CONFIG.telegram?.groupChatId || ''; // 可選：也發到 TG 群（買入、開池、倍數、賣出）
const groupSent = new Map();
async function toGroup(text) {
  if (!TG || !GROUP_ID) return;
  let msg = '', key = '';
  const ca = (text.match(/0x[a-fA-F0-9]{40}/) || [])[0] || '';

  if (/^🛒/u.test(text)) { const name = (text.match(/項目[：:]\s*([^\n（(|]+)/) || [])[1]?.trim() || ''; const pct = (text.match(/進度約?\s*(\d+)%/) || [])[1]; msg = `🎯 打了付费项目：${name || '新项目'}${pct ? `（铸造进度约 ${pct}%）` : ''}\n合约：${ca}`; key = 'mint:' + ca.toLowerCase(); }
  /* 使用者 10/31 20:48：打到什麼都在大群通知（免費也發），開盤也通知 */
  if (!msg && /^🆓/u.test(text)) { const name = (text.match(/項目[：:]\s*([^\n（(]+)/) || [])[1]?.trim() || ''; msg = `🎁 打了免费项目：${name || '新项目'}\n合约：${ca}`; key = 'free:' + ca.toLowerCase(); }
  if (!msg && /^🚀/u.test(text) && text.includes('開池')) { const sym = (text.match(/^🚀\s*(\S+)/u) || [])[1] || ''; const tok = (text.match(/合約 (0x[a-fA-F0-9]{40})/) || [])[1] || ca; msg = `🚀 ${sym} 开盘了${(text.match(/開池了（([^）]+)）/) || [])[1] ? '（' + text.match(/開池了（([^）]+)）/)[1].replace('配對', '配对') + '）' : ''}\n合约：${tok}`; key = 'open:' + tok.toLowerCase(); }
  if (!msg || !ca) return;
  { const cl = ca.toLowerCase(); S.grpOnce = S.grpOnce || {}; const gk = key.startsWith('open:') ? key : cl; if (S.grpOnce[gk]) return; S.grpOnce[gk] = 1; } /* 同一個合約群裡只播一次（打到／70% 擇一，開盤另外播） */
  const now = Date.now(); if (groupSent.has(key) && now - groupSent.get(key) < 6 * 3600e3) return; groupSent.set(key, now);
  try { await fetch(`https://api.telegram.org/bot${TG.a}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: GROUP_ID, text: '📡 Agent ID 播报\n' + msg, disable_web_page_preview: true }), signal: AbortSignal.timeout(10000) }); } catch {}
}
async function freeProgWatch() { // 免費項目也看鑄造進度（已鑄造／總量），過 70% 播報到群
  S.freeTrack = S.freeTrack || {};
  for (const [c, F] of Object.entries(S.freeTrack)) {
    if (Date.now() - F.at > 72 * 3600e3 || F.done) { delete S.freeTrack[c]; continue; }
    const tsR = await call(c, '0x18160ddd'); if (!tsR || tsR.length < 66) { F.done = 1; continue; } const sup = Number(BigInt(tsR.slice(0, 66)));
    let max = 0; for (const sel of ['0xd5abeb01', '0x32cb6b0c', '0x355274ea', '0xe985e367', '0xf1aee5a2']) { const r = await call(c, sel); if (r && r.length >= 66) { const x = Number(BigInt(r.slice(0, 66))); if (x > 0 && x >= sup && x < 1e15) { max = x; break; } } }
    if (!max) { F.miss = (F.miss || 0) + 1; if (F.miss >= 3) F.done = 1; continue; } // 讀不到總量的就不追了
    const pct = sup / max, prev = F.p; F.p = pct;
    if (pct >= 0.7 && (prev != null ? prev < 0.7 : Date.now() - F.at < 3600e3)) { const nm = tokStr(await call(c, '0x06fdde03')) || ''; await groupProgress(c, nm, pct); }
    if (pct >= 1) F.done = 1;
    await sleep(100);
  }
}
async function groupProgress(c, name, pct) { // 任何項目（免費或付費、有沒有打都算）鑄造進度第一次超過 70% → 播報到群，同一個項目只發一次
  S.g70 = S.g70 || {}; if (!TG || !GROUP_ID || S.g70[c]) return;
  try { const d = S.deployer?.[c] || (await deployerOf(c)); if (d && (S.black?.[d] || S.paid?.[c]?.drain)) { S.g70[c] = 'skip'; return; } } catch {} /* 審查修正：黑名單/抽走過資金的開發者，不推給群 */
  S.g70[c] = 'wait'; await sleep(90e3); /* 使用者 10/31 21:18：同一個項目群裡只播一次——先等 90 秒，期間如果我們打到了，就只發「打了」那則 */
  if (S.grpOnce?.[c]) { S.g70[c] = 'merged'; return; }
  try {
    const owner = S.deployer?.[c] || await deployerOf(c);
    if (owner && S.black?.[owner] || S.paid?.[c]?.drain) { S.g70[c] = 'skip'; return; }
    const serial = await serialDev(c);
    if (serial) { S.g70[c] = 'skip-serial'; return; }
    if (!await verifyAgentProject(c)) { S.g70[c] = 'skip-agent-proof'; return; }
    const P = S.paid?.[c];
    if (!P) { S.g70[c] = 'skip-agents'; return; }
    const freshHeat = () => Number.isFinite(P.heatAt) && P.heatAt > 0 && P.heatAt <= Date.now() && Date.now() - P.heatAt <= 120000;
    if (!freshHeat()) await heatOf(c, P);
    if (!freshHeat() || !Number.isSafeInteger(P.agents) || P.agents < ENTRY_POLICY.minAgents) { S.g70[c] = 'skip-agents'; return; }
  } catch { delete S.g70[c]; return; }
  S.g70[c] = ts(); S.grpOnce = S.grpOnce || {}; S.grpOnce[c] = 1;
  const text = `📡 Agent ID 播报\n🔥 ${name || '新项目'} 铸造进度已超过 70%（目前 ${Math.round(pct * 100)}%）\n合约：${c}`;
  log('群播報: ' + text.replace(/\n/g, ' | '));
  try { await fetch(`https://api.telegram.org/bot${TG.a}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: GROUP_ID, text, disable_web_page_preview: true }), signal: AbortSignal.timeout(10000) }); } catch {}
}
async function riskNote(c) { /* 新功能：看合約有沒有「增發／暫停／黑名單／改稅」這類開發者權限，只提醒不擋 */
  try { const code = (await rpc('eth_getCode', [c, 'latest'])) || ''; if (code.length < 10) return '';
    const has = (sels) => sels.some((x) => code.includes('63' + x)); const f = [];
    if (has(['40c10f19'])) f.push('可增發');
    if (has(['8456cb59', '02329a29'])) f.push('可暫停交易');
    if (has(['f9f92be4', '44337ea1', '0ecb93c0', '1a895266'])) f.push('有黑名單');
    if (has(['8c0b5e22', 'c0246668', '5342acb4', 'aa4b6fca', '061c82d0'])) f.push('可改稅/限額');
    if (!f.length) return ''; const ow = await call(c, '0x8da5cb5b'); if (ow && BigInt(ow.slice(0, 66)) === 0n) return '';
    return '\n⚠️ 合約權限提醒：' + f.join('、') + '（開發者還沒放棄權限）';
  } catch { return ''; } }
async function honeypotCheck(W, t, st, bal) { /* 新功能：開池時模擬「把幣轉進池子」（賣出第一步），轉不過去很可能是貔貅 */
  if (st.hpChecked || !st.pair || !/^0x[0-9a-f]{40}$/.test(st.pair) || !(bal > 0n)) return; st.hpChecked = 1;
  try { await rpc('eth_call', [{ from: W.addr, to: t.addr, data: '0xa9059cbb' + wa(st.pair) + w(bal / 100n || 1n) }, 'latest']); }
  catch (e) { await tg(`⚠️ [${W.name}] ${t.sym} 開池了，但模擬賣出失敗，可能是貔貅（只能買不能賣），自動賣出可能會失敗\n${t.addr}`); }
}
async function revokeWalletApproval(W, token, spender, type = 'approve') {
  const kind = canWallet(W, 'mint') ? 'mint' : 'token-sell';
  if (!canWallet(W, kind) || !validMintAddress(token) || !validMintAddress(spender) || !['approve', 'permit2'].includes(type)) throw new Error('此钱包或授权撤销参数不可用');
  return withWalletExecution(W.profile, async () => {
    const previous = W.operationKind; W.operationKind = kind;
    try {
      const result = await W.baw(['approvals', 'detail', '--binanceChainId', '56', '--tokenContract', token, '--spender', spender, '--type', type]);
      const detail = result.j?.success ? result.j.data?.detail : null;
      if (!detail || String(detail.binanceChainId) !== '56' || detail.tokenContract?.toLowerCase() !== token.toLowerCase() || detail.spender?.toLowerCase() !== spender.toLowerCase() || detail.type !== type) throw new Error('授权详情与原钱包、资产或对象不一致，未撤销');
      if (type === 'permit2' && !validMintAddress(detail.permit2ContractAddress)) throw new Error('无法核验 Permit2 撤销合约，未撤销');
      return await runPaidCommand(W, ['approvals', 'revoke', '--binanceChainId', '56', '--tokenContract', token, '--spender', spender, '--type', type], 0n, { token, spender, type, ...(type === 'permit2' ? { permit2ContractAddress: detail.permit2ContractAddress } : {}) });
    } finally { W.operationKind = previous; }
  }, { root: DIR, kind: 'scanner-approval' });
}
async function flapApprovalWatch() {
  if (!FLAP_BAN || MONITOR_ONLY) return;
  await Promise.allSettled(WALLETS.map(async W => {
    if (!canWallet(W, 'mint') && !canWallet(W, 'token-sell')) return;
    const r = await W.baw(['approvals', 'list', '--limit', '100']);
    for (const approval of r.j?.data?.list || []) {
      const spender = String(approval.spender || '').toLowerCase();
      if (!FLAP_BLOCK.has(spender) && !/flap/i.test(String(approval.spenderName || ''))) continue;
      try {
        const rv = await revokeWalletApproval(W, approval.tokenContract, approval.spender, approval.type || 'approve');
        await tg(`⚠️ [${W.name}] Flap 授权${rv.j?.success ? '已核验撤销' : '未完成撤销，请到钱包管理核对'}`);
      } catch (error) { logWallet(W, '授权撤销待核对 ' + error.message); }
    }
  }));
}
async function lowBnbWatch() { /* 新功能：BNB 快不夠付 gas 時提醒（每個錢包 6 小時最多一次） */
  S.lowBnbAt = S.lowBnbAt || {};
  for (const W of WALLETS) { const PAID = paidFor(W); const b = Number(BigInt((await rpc('eth_getBalance', [W.addr, 'latest'])) || '0x0')) / 1e18;
    if (b < PAID.keepBnb + 0.02 && Date.now() - (S.lowBnbAt[W.id] || 0) > 6 * 3600e3) { S.lowBnbAt[W.id] = Date.now(); await tg(`⚠️ [${W.name}] BNB 快不夠了：剩 ${b.toFixed(4)} BNB，可能付不出 gas，免費項目也會打不了，請補一點 BNB`); } }
}
function pruneState() { /* 審查修正：狀態檔定期瘦身，避免越來越大、越存越慢 */
  const cut = (o, max) => { const k = Object.keys(o || {}); if (k.length > max) for (const x of k.slice(0, k.length - max)) delete o[x]; };
  cut(S.seenMints, 30000); cut(S.g70, 3000); cut(S.grpOnce, 5000); cut(S.missed, 500); cut(S.deployer, 20000);
  if (S.trades?.length > 1000) S.trades = S.trades.slice(-1000);
  for (const st of Object.values(S.tokens || {})) if (st.holders) cut(st.holders, 20000);
}
async function dailyReport() { /* 新功能：每天晚上 9 點（台北）自動發戰績＋持倉 */
  const tp = new Date(Date.now() + 8 * 3600e3); const day = tp.toISOString().slice(0, 10);
  if (tp.getUTCHours() !== 21 || S.dailyAt === day) return; S.dailyAt = day; save();
  let um = 0; try { const today = ts().split(/\s/)[0]; /* 審查 11/1：日誌日期是 2026/11/1（沒有補 0），以前比對不到 */ um = new Set(readFileSync(LOG, 'utf8').split('\n').filter((l) => l.startsWith('[' + today) && l.includes('] 打不了 ')).map((l) => (l.match(/0x[a-f0-9]{40}/) || [''])[0])).size; } catch {}
  const today2 = ts().split(/\s/)[0]; const ms = Object.entries(S.missed || {}).filter(([, m]) => String(m.at).startsWith(today2)).slice(-8);
  const missTxt = ms.length ? `\n今天快賣完卻沒打到的 ${ms.length} 個：\n` + ms.map(([c, m]) => `· ${m.name}：${m.why}`).join('\n') : '\n今天沒有錯過快賣完的項目';
  await tgSay(`🌙 每日總結（晚上 9 點自動發）${missTxt}\n今天有 ${um} 個項目打不了（要官網簽名、白名單或模擬失敗），只記在紀錄裡${UPD.on ? `\n\n官方群：${UPD.group}` : ''}`); await cmdStats().catch(() => {}); /* 持倉總結改由 holdReport 在 1 點／13 點發 */
}
async function lockNote(c, wAddr) { /* 買到的幣現在能不能轉：模擬轉 1 單位到黑洞地址，被擋就提醒（像 aiagentbsc 的白名單鎖）（使用者 10/30 21:44 要補的漏洞） */
  const toks = [...new Set([c, ...(S.dyn || []).filter((t) => t.only === wAddr).slice(-3).map((t) => t.addr)])];
  for (const t of toks) { const dR = await call(t, '0x313ce567'); if (!(dR && dR.length >= 66)) continue; /* NFT 沒有小數位數，不能用轉代幣的方式測（以前 NFT 會誤報轉不出去） */ const b = big(await call(t, '0x70a08231' + wa(wAddr))); if (!(b > 0n)) continue;
    try { await rpc('eth_call', [{ from: wAddr, to: t, data: '0xa9059cbb' + wa('0x000000000000000000000000000000000000dead') + w(1n) }, 'latest']); return ''; }
    catch (e) { return `\n⚠️ 這個幣現在轉不出去（${String(e.message).slice(0, 40)}）：可能要等開發者開放交易，也可能是貔貅`; } }
  return '';
}
async function tg(text) { if (/^🛒/u.test(text)) { const m = text.match(/\n(0x[a-fA-F0-9]{40})\n/); if (m) { text += await riskNote(m[1].toLowerCase()); const wn = (text.match(/^🛒 \[([^\]]+)\]/u) || [])[1]; const W = WALLETS.find((x) => x.name === wn); if (W) text += await lockNote(m[1].toLowerCase(), W.addr).catch(() => ''); } } log('TG: ' + text.replace(/\n/g, ' | ')); toGroup(text).catch(() => {}); if (!TG || (!CONFIG.notifyAll && !sendable(text))) return; try { await fetch(`https://api.telegram.org/bot${TG.a}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: TG.b, text, disable_web_page_preview: true, disable_notification: !important(text) }), signal: AbortSignal.timeout(10000) }); } catch {} }

const RPCS = Array.isArray(CONFIG.rpcs) && CONFIG.rpcs.length ? CONFIG.rpcs : ['https://bsc-dataseed.bnbchain.org', 'https://bsc-rpc.publicnode.com', 'https://bsc.publicnode.com', 'https://bsc.drpc.org', 'https://1rpc.io/bnb', 'https://binance.llamarpc.com']; // 可在 config.json 的 rpcs 换成自己的节点（公共节点常被限流）
let ri = 0;
async function rpc(method, params) {
  let last; for (let i = 0; i < RPCS.length; i++) { const u = RPCS[(ri + i) % RPCS.length]; try { const r = await (await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(12000) })).json(); if (r.error) throw new Error(r.error.message); ri = (ri + i) % RPCS.length; return r.result; } catch (e) { last = e; } }
  throw last;
}
const w = (n) => BigInt(n).toString(16).padStart(64, '0');
const wa = (a) => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
const call = (to, data) => rpc('eth_call', [{ to, data }, 'latest']).catch(() => null);
const big = (h) => (h && h !== '0x' ? BigInt(h.slice(0, 66)) : 0n);
// 所有錢包共用項目內官方 CLI，各自使用獨立加密會話（見 README.local.md）。
function makeBaw(wc, index) {
  // 兜底：监控模式下不启动任何钱包 CLI，包括登录和预演。
  if (MONITOR_ONLY) return async () => ({ t: MONITOR_NOTE, j: { success: false, error: { message: MONITOR_NOTE } } });
  const adapter = makeWatchBaw(wc, index);
  return async (args, timeout) => {
    const config = currentRuntimeConfig(), current = (config.wallets || []).find((entry, i) => getWalletId(entry, i) === wc.id);
    const write = args[0] === 'auth' || args[0] === 'approvals' && args[1] === 'revoke' || ['contract-call', 'sign-message'].includes(args[0]) && args[1] === 'execute' || ['market-order', 'limit-order'].includes(args[0]) && ['swap', 'buy', 'sell', 'cancel'].includes(args[1]);
    const fromToken = args[args.indexOf('--fromToken') + 1];
    const kind = walletProfiles.get(wc.id)?.operationKind || (args[0] === 'market-order' && args[1] === 'swap' && String(fromToken).toLowerCase() !== NATIVE_BNB.toLowerCase() ? 'token-sell' : 'mint');
    if (!current || current.address?.toLowerCase() !== wc.address.toLowerCase() || current.bawDir !== wc.bawDir || current.instanceId !== wc.instanceId) return { t: MONITOR_NOTE, j: { success: false, error: { name: 'CONFIG_ERROR', message: '钱包身份或会话配置已变化，请重启后核对' } } };
    if (write && (config.monitorOnly || !(walletCanAutomate(config, current, kind) || args[0] === 'auth' && walletCanAutomate(config, current, 'token-sell')))) return { t: MONITOR_NOTE, j: { success: false, error: { name: 'CONFIG_ERROR', message: '此钱包已暂停或未授权此操作' } } };
    if (!write) return adapter(args, timeout);
    const scopeOf = (source, profile) => {
      const effective = effectiveWalletConfig(source, profile);
      return JSON.stringify([profile.id, profile.address.toLowerCase(), profile.bawDir, profile.instanceId, profile.agentId, profile.agentIdVerified, profile.legacyNames, profile.name, profile.mode, profile.paused, profile.archived, profile.draft, profile.autoMint, profile.autoSellTokens, profile.autoSellNfts, effective.paid, effective.rules, source.portfolioBudget?.maxBnbPerDay ?? null, source.monitorOnly, source.enableFileCommands]);
    };
    const scope = scopeOf(config, current);
    return adapter(args, timeout, { beforeSend: () => {
      // The CLI address preflight awaits I/O. Re-read policy synchronously after
      // it, immediately before the write process is spawned.
      const latest = currentRuntimeConfig(), selected = runtimeWallet(walletProfiles.get(wc.id), latest);
      if (existsSync(join(DIR, 'WATCH_STOP')) || !selected || latest.monitorOnly || !(walletCanAutomate(latest, selected, kind) || args[0] === 'auth' && walletCanAutomate(latest, selected, 'token-sell')) || scopeOf(latest, selected) !== scope) throw new Error('钱包已暂停、配置已变化或扫描器已停止，未提交交易');
    } });
  };
}
const walletProfiles = new Map();
let WALLETS = (CONFIG.wallets || []).filter(wc => /^0x[a-fA-F0-9]{40}$/.test(wc.address || '')).map((wc, index) => createWatchWallet(wc, index));
function createWatchWallet(wc, index) {
  const profile = { ...wc }, id = getWalletId(wc, index);
  const legacyNames = Object.hasOwn(wc, 'legacyNames') ? (Array.isArray(wc.legacyNames) ? [...wc.legacyNames] : []) : [...new Set([wc.agentId, wc.name].filter(name => typeof name === 'string' && name))];
  const W = { id, name: wc.name, legacyName: wc.agentId || wc.name, legacyNames, addr: wc.address.toLowerCase(), profile, index, baw: makeBaw(profile, index), agentId: wc.agentIdVerified === true && wc.agentId ? keccak256(wc.agentId.toLowerCase().replace(/\.ai$/, '')) : '' };
  walletProfiles.set(id, W); return W;
}
function currentRuntimeConfig() {
  // A malformed or partially written configuration closes the transaction gate.
  try { return normalizeWalletConfig(JSON.parse(readFileSync(join(DIR, 'config.json'), 'utf8'))); }
  catch { return { ...CONFIG, monitorOnly: true }; }
}
function runtimeWallet(W, config = currentRuntimeConfig()) {
  if (!W) return null;
  const wc = (config.wallets || []).find((entry, index) => getWalletId(entry, index) === W.id);
  if (!wc || String(wc.address).toLowerCase() !== W.addr || wc.bawDir !== W.profile.bawDir || wc.instanceId !== W.profile.instanceId || wc.agentId !== W.profile.agentId || wc.agentIdVerified !== W.profile.agentIdVerified || JSON.stringify(wc.legacyNames) !== JSON.stringify(W.profile.legacyNames)) return null;
  return wc;
}
function canWallet(W, kind = 'mint') {
  if (MONITOR_ONLY || !W) return false;
  const config = currentRuntimeConfig(), wc = runtimeWallet(W, config);
  return Boolean(wc && walletCanAutomate(config, wc, kind));
}
function paidFor(W) {
  const config = currentRuntimeConfig(), wc = runtimeWallet(W, config);
  return getPaidConfig(wc ? effectiveWalletConfig(config, wc) : { paid: { maxUsd: 0, maxBnbPerDay: 0 } });
}
function rulesFor(W) {
  const config = currentRuntimeConfig(), wc = runtimeWallet(W, config);
  return getRuleConfig(wc ? effectiveWalletConfig(config, wc) : CONFIG);
}
function syncWalletProfiles() {
  const config = currentRuntimeConfig(), next = [];
  for (const [index, wc] of (config.wallets || []).entries()) {
    if (!/^0x[a-fA-F0-9]{40}$/.test(wc.address || '')) continue;
    const id = getWalletId(wc, index), old = walletProfiles.get(id);
    const W = old || createWatchWallet(wc, index);
    // Existing workers keep their original session binding until the process ends.
    W.name = wc.name; next.push(W);
  }
  WALLETS = next;
  if (!S.costWalletAddress && next[0]) S.costWalletAddress = next[0].addr;
  return next;
}
function logWallet(W, text) { log(`[${W.id}][${W.name}] ${text}`); }
function legacyAliases(W) {
  // An explicit empty list identifies a new wallet, even if its display label
  // happens to reuse an old wallet's name. Only pre-migration fixtures may lack it.
  if (Object.hasOwn(W, 'legacyNames')) return Array.isArray(W.legacyNames) ? W.legacyNames : [];
  return [...new Set([W.legacyName, W.name].filter(name => typeof name === 'string' && name))];
}
function tokenCostFor(W, token) {
  if (token.only) return token.only.toLowerCase() === W.addr ? Number(token.cost) || 0 : 0;
  if (token.both) return Number(token.cost) || 0;
  const owner = token.costWalletAddress || S.costWalletAddress;
  return owner?.toLowerCase() === W.addr ? Number(token.cost) || 0 : 0;
}

if (!WALLETS.length && !MONITOR_ONLY) { console.error('config.json 裡沒有 wallets'); process.exit(1); }
const ME = WALLETS[0]?.addr || '';
function keccak256(str) { /* 小型 keccak256（BigInt 版），算 Agent ID 編號用 */
  const M = (1n << 64n) - 1n, RC = [], R = [1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 2, 14, 27, 41, 56, 8, 25, 43, 62, 18, 39, 61, 20, 44], P = [10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4, 15, 23, 19, 13, 12, 2, 20, 14, 22, 9, 6, 1];
  let r = 1n; for (let i = 0; i < 24; i++) { let c = 0n; for (let j = 0; j < 7; j++) { r = ((r << 1n) ^ ((r >> 7n) * 0x71n)) & 0xffn; if (r & 2n) c ^= 1n << ((1n << BigInt(j)) - 1n); } RC.push(c); }
  const rot = (x, n) => ((x << BigInt(n)) | (x >> BigInt(64 - n))) & M;
  const b = [...Buffer.from(str, 'utf8')]; b.push(1); while (b.length % 136) b.push(0); b[b.length - 1] |= 0x80;
  const s = Array(25).fill(0n);
  for (let o = 0; o < b.length; o += 136) {
    for (let i = 0; i < 17; i++) { let v = 0n; for (let k = 7; k >= 0; k--) v = (v << 8n) | BigInt(b[o + i * 8 + k]); s[i] ^= v; }
    for (let rd = 0; rd < 24; rd++) {
      const C = [0, 1, 2, 3, 4].map((x) => s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20]);
      for (let x = 0; x < 5; x++) { const d = C[(x + 4) % 5] ^ rot(C[(x + 1) % 5], 1); for (let y = 0; y < 25; y += 5) s[x + y] ^= d; }
      let t = s[1]; for (let i = 0; i < 24; i++) { const j = P[i], u = s[j]; s[j] = rot(t, R[i]); t = u; }
      for (let y = 0; y < 25; y += 5) { const a = s.slice(y, y + 5); for (let x = 0; x < 5; x++) s[y + x] = a[x] ^ (~a[(x + 1) % 5] & M & a[(x + 2) % 5]); }
      s[0] ^= RC[rd];
    }
  }
  let h = ''; for (let i = 0; i < 4; i++) for (let k = 0; k < 8; k++) h += Number((s[i] >> BigInt(8 * k)) & 0xffn).toString(16).padStart(2, '0'); return h;
}

/* 每個錢包自己的 Agent ID 編號 = keccak256(名稱去掉 .ai)；有些項目鑄造時要帶這個編號（像 SYNAPE 的 mint(agentTokenId)）（使用者 10/30 21:44 要補的漏洞） */
// Agent ID names are pinned separately from editable display labels.

let S = { tokens: {}, lastBlock: 0, seenMints: {}, lastLoginAlert: 0 };
try { S = { ...S, ...JSON.parse(readFileSync(STATE, 'utf8')) }; } catch {}
S.costWalletAddress ||= ME;
S.walletRuntime ||= {};
S.walletPending ||= {};
if (S.walletIdentityVersion !== 2) {
  const copy = (map, W, suffix = '') => {
    if (!map || typeof map !== 'object') return;
    const values = legacyAliases(W).filter(name => Object.hasOwn(map, name + suffix)).map(name => map[name + suffix]).filter(value => value !== undefined);
    if (map[W.id + suffix] === undefined && values.length) map[W.id + suffix] = values.every(value => typeof value === 'number') ? Math.max(...values) : values[0];
  };
  for (const W of WALLETS) {
    for (const map of [S.paidSpend, S.mintCnt, S.lowBnbAt, S.devAlert, S.lastLoginAlert]) copy(map, W);
    copy(S.devAlert, W, ':off');
    for (const project of Object.values(S.paid || {})) for (const map of [project.done, project.qAt, project.failW]) copy(map, W);
  }
  S.walletIdentityVersion = 2;
}
S.runtimeMode = MONITOR_ONLY ? 'monitor' : 'auto';
S.configLoadedAt = CONFIG_LOADED_AT;
S.effectiveRules = structuredClone(RULE);
S.sellRuleLimits = { freeMinUsd: FREE_SELL_MIN_USD, freePeakDelayMs: FREE_PEAK_DELAY_MS };
for (const k of Object.keys(S.tokens)) delete S.tokens[k].verified;
const save = (strict = false) => {
  const temporary = STATE + '.' + process.pid + '.tmp';
  try { writeFileSync(temporary, JSON.stringify(S, null, 1), { mode: 0o600, flush: strict }); renameSync(temporary, STATE); }
  catch (error) { try { rmSync(temporary, { force: true }); } catch {} if (strict) throw error; }
};
const ENTRY_POLICY = ensureEntryPolicy(S);
const MINT_MEDIA = createMintMedia({ state: S, save });
const SAFE_WEB = createSafeWeb();
const MINT_RISK = createMintRisk({ state: S, rpc, call, fullCode, nftMediaCheck: (contract, uri) => MINT_MEDIA.check(contract, uri), save, timeZone: CONFIG.timeZone || 'Asia/Taipei', usdt: USDT, wrappedBnb: WBNB, factory: FACTORY });
S.mintPolicy = { ...ENTRY_POLICY, version: '2.7.4', schemaVersion: 3, freeMode: 'notify-only', participants: 'transaction-senders', limits: { ...MINT_RISK_LIMITS }, wallets: {} };
if (S.agentsV !== 2) { S.agentsV = 2; for (const P of Object.values(S.paid || {})) { delete P.agents; delete P.burst; delete P.heatAt; } }
function entryFor(W, nft = false) {
  const policy = effectiveEntryPolicy(ENTRY_POLICY, paidFor(W).goPct), nftPolicy = effectiveEntryPolicy(ENTRY_POLICY, paidFor(W).goPct, { nft: true });
  S.mintPolicy.wallets[W.id] = { ...policy, nftGoPct: nftPolicy.goPct, nftMinAgents: nftPolicy.minAgents }; return nft ? nftPolicy : policy;
}
for (const W of WALLETS) entryFor(W);
function queuePaidPhase(c) {
  S.paid ||= {}; const P = S.paid[c] ||= { at: Date.now(), name: '', done: {} };
  P.needLearn = 1; P.freePhase = true;
  if (P.replay && !P.replay.payTok && BigInt(P.replay.value || '0') === 0n) delete P.replay;
  for (const [walletId, status] of Object.entries(P.done || {})) if (status === 'free-notify') delete P.done[walletId];
  delete S.freeNote?.[c]; if (!MONITOR_ONLY) save(true);
}
function receiptUsdtPayment(receipt, sender) {
  return Array.isArray(receipt?.logs) && receipt.logs.some(log => String(log.address).toLowerCase() === USDT && log.topics?.[0] === T_TRANSFER && log.topics.length === 3 && /^0x[0-9a-f]{64}$/i.test(log.topics[1]) && ('0x' + log.topics[1].slice(26)).toLowerCase() === sender.toLowerCase() && /^0x[0-9a-f]{64}$/i.test(log.data || '') && BigInt(log.data) > 0n);
}
async function othersPay(c) {
  const cached = S.paymentPhase?.[c]; if (cached && Date.now() - cached.at < 60000) return cached.paid;
  try {
    const head = parseInt(await rpc('eth_blockNumber', []), 16);
    if (!Number.isFinite(head)) throw new Error('Invalid block');
    const logs = await rpc('eth_getLogs', [{ address: c, fromBlock: '0x' + Math.max(0, head - 2000).toString(16), toBlock: 'latest' }]);
    if (!Array.isArray(logs)) throw new Error('Invalid logs');
    const hashes = [...new Set(logs.map(log => log.transactionHash).filter(hash => /^0x[0-9a-f]{64}$/i.test(hash || '')))].slice(-20);
    const transactions = await rpcBatch(hashes.map(hash => ({ method: 'eth_getTransactionByHash', params: [hash] })));
    if (!Array.isArray(transactions) || transactions.length !== hashes.length) throw new Error('Incomplete transactions');
    const wallets = new Map();
    for (let i = 0; i < hashes.length; i++) {
      const tx = transactions[i];
      if (!tx || !validMintAddress(tx.from) || !/^0x[0-9a-f]+$/i.test(tx.value || '') || !validMintCalldata(tx.input, true)) throw new Error('Invalid transaction');
      if (String(tx.to).toLowerCase() !== c.toLowerCase() || badSel(tx.input)) continue;
      const receipt = await rpc('eth_getTransactionReceipt', [hashes[i]]);
      if (String(receipt?.transactionHash).toLowerCase() !== hashes[i].toLowerCase() || !/^0x0?[01]$/i.test(receipt?.status || '')) throw new Error('Unverified receipt');
      if (BigInt(receipt.status) !== 1n) continue;
      wallets.set(tx.from.toLowerCase(), BigInt(tx.value) > 0n || receiptUsdtPayment(receipt, tx.from));
    }
    const values = [...wallets.values()], paid = values.length >= 5 && values.filter(Boolean).length / values.length >= 0.5;
    if (values.length >= 5 || hashes.length === 0) { S.paymentPhase ||= {}; S.paymentPhase[c] = { at: Date.now(), paid }; }
    return paid;
  } catch { return null; } // Unknown is neither proof of a free nor paid phase.
}
async function verifyAgentProject(c) {
  if (!validMintAddress(c) || INFRA.has(c)) return false;
  try {
    // Bytecode containing the registry address is only a discovery hint. A
    // social candidate must also have real Agent ID participant evidence.
    const head = parseInt(await rpc('eth_blockNumber', []), 16);
    if (!Number.isSafeInteger(head) || head < 0) return false;
    const logs = await rpc('eth_getLogs', [{ address: c, fromBlock: '0x' + Math.max(0, head - 3000).toString(16), toBlock: 'latest' }]);
    if (!Array.isArray(logs)) return false;
    const hashes = [...new Set(logs.map(l => l.transactionHash).filter(h => /^0x[0-9a-f]{64}$/i.test(h || '')))].slice(-40);
    const transactions = await rpcBatch(hashes.map(hash => ({ method: 'eth_getTransactionByHash', params: [hash] })));
    if (!Array.isArray(transactions) || transactions.length !== hashes.length) return false;
    const verifiedSenders = new Set();
    for (let index = 0; index < hashes.length; index++) {
      const tx = transactions[index];
      if (!tx || String(tx.hash).toLowerCase() !== hashes[index].toLowerCase() || !validMintAddress(tx.from) || !validMintCalldata(tx.input, true)) return false;
      if (String(tx.to).toLowerCase() !== c.toLowerCase() || badSel(tx.input)) continue;
      const receipt = await rpc('eth_getTransactionReceipt', [hashes[index]]);
      if (String(receipt?.transactionHash).toLowerCase() !== hashes[index].toLowerCase() || !/^0x0?[01]$/i.test(receipt?.status || '')) return false;
      if (BigInt(receipt.status) === 1n) verifiedSenders.add(tx.from.toLowerCase());
    }
    const senders = [...verifiedSenders].slice(0, 16);
    if (senders.length < 5) return false;
    let agents = 0;
    for (const sender of senders) { const result = decodeAbiUint(await call('0x' + REGISTRY, '0x70a08231' + wa(sender))); if (result === null) return false; if (result > 0n) agents++; }
    return agents / senders.length >= 0.6;
  } catch { return false; }
}
async function findSocialNameHints({ title, host }) {
  const words = [...new Set(String(title + ' ' + host.split('.')[0]).toLowerCase().match(/[a-z0-9一-鿿]{4,}/g) || [])].filter(word => !/^(agent|mint|meme|token|launch|https|www|fair|curve|chain|smart|binance)$/.test(word));
  if (!words.length) return [];
  const choices = [...HOT.entries()].filter(([address, heat]) => validMintAddress(address) && !INFRA.has(address) && heat.from?.size >= 5).sort((a, b) => b[1].from.size - a[1].from.size).slice(0, 12);
  const out = [];
  for (const [address] of choices) {
    const name = String(S.paid?.[address]?.name || tokStr(await call(address, '0x06fdde03')) || '').toLowerCase().replace(/[^a-z0-9一-鿿]/g, '');
    if (name.length >= 4 && words.some(word => name.includes(word) || word.includes(name))) out.push(address);
    if (out.length >= 3) break;
  }
  return out;
}
function socialConfigScope(settings) {
  if (settings?.enabled !== true || !Array.isArray(settings.groupIds) || settings.vipGroupIds !== undefined && !Array.isArray(settings.vipGroupIds)) return null;
  return socialSelectionHash(settings.groupIds) + ':' + socialSelectionHash(settings.vipGroupIds || []);
}
async function socialCandidateWatch() {
  const selected = currentRuntimeConfig().telegramUser, scope = socialConfigScope(selected);
  if (!scope) return;
  const isCurrent = () => { try { return socialConfigScope(currentRuntimeConfig().telegramUser) === scope; } catch { return false; } };
  const file = join(DIR, 'data', 'tg_candidates.json');
  if (!existsSync(file) || statSync(file).size > 524288) return;
  const snapshot = JSON.parse(readFileSync(file, 'utf8'));
  S.socialDiscovery ||= {};
  const candidates = await processSocialCandidates({ snapshot, verifyContract: verifyAgentProject, fetchBytes: SAFE_WEB, allowedGroupIds: selected.groupIds, vipGroupIds: selected.vipGroupIds || [], discoveryState: S.socialDiscovery, isCurrent, findNameHints: findSocialNameHints, onNameHints: async ({ host, addresses }) => {
    if (!isCurrent()) return;
    log(`热门网址 ${noLink(host)} 有同名链上候选（未确认网站关联，不加入自动交易）：${addresses.join('、')}`);
    await tg(`🌐 热门网址 ${noLink(host)} 有同名链上候选，未确认网站关联；仅供手动核验，未加入自动交易：\n${addresses.join('\n')}`);
  } });
  if (!isCurrent()) return; // Revoked groups/priority cannot enqueue results from an awaited round.
  for (const candidate of candidates) {
    // Group popularity only schedules chain checks. It cannot override wallet,
    // participant, project, simulation, or budget gates in the mint paths.
    const c = candidate.address;
    if (!validMintAddress(c) || INFRA.has(c)) continue;
    S.paid ||= {}; const P = S.paid[c] ||= { at: Date.now(), name: '', done: {} };
    P.groupSignalAt = candidate.observedAt;
    P.groupCount = candidate.groupCount;
    P.groupSenders = candidate.senderCount;
    if (candidate.priority) P.prioritySignalAt = candidate.observedAt;
    if (candidate.source === 'telegram-url') P.fromUrl = true;
    P.needLearn = 1;
  }
  save(); // Persist bounded retry timers and the hourly priority quota across restarts.
}
async function notifyFreeMint(c, progress, agents, W = null) {
  const check = entryGate({ progress, agents, policy: W ? entryFor(W) : ENTRY_POLICY });
  if (!check.allowed) return '⏸ ' + check.reason;
  const junk = await MINT_RISK.nftCheck(c); if (junk) return '⏸ ' + junk;
  S.freeNote ||= {};
  if (S.freeNote[c]) return '✅ 免费项目已通知，不自动铸造';
  const name = S.paid?.[c]?.name || tokStr(await call(c, '0x06fdde03')) || c.slice(0, 10);
  // Record only after the URI check; a transient RPC failure can be retried.
  S.freeNote[c] = Date.now(); if (!MONITOR_ONLY) save(true);
  await tg(`🔔 免费项目达到条件（只通知，不自动铸造）：${name}\n进度 ${progress == null ? '未知' : Math.floor(progress * 100) + '%'} · ${agents} 个 Agent ID 交易钱包\n${c}\n如需参加，请手动预演并确认铸造`);
  return '🔔 免费项目已通知，不自动铸造';
}

// ---------- 持倉 ----------
const XQ = ['0x4902c5ebc598265ed2212b559b042de8a5eeec3f', '0x02fca66c1d1afb4e2a7884261eb00f63598a7436', '0x205812cdbed920aff76c6580abd681a46d11efc7', '0xbe9d156892e55e7154bcd3cb0fea677f9d3103e1']; /* 使用者 10/31 19:49：币安无忧 的池子是跟 BNCB（Flap 系報價幣）配對，以前只看 BNB/USDT/USD1 漏掉了 */
const dsCache = new Map();
async function dexScreener(addr) { /* 使用者 10/31 19:55：不管跟什麼幣配對、在哪個 DEX（V2／V3／其他），都要查得到開盤——用 DexScreener 當保險（60 秒快取） */
  const k = dsCache.get(addr); if (k && Date.now() - k.t < 60e3) return k.v;
  let v = null; try { const j = await (await fetch('https://api.dexscreener.com/latest/dex/tokens/' + addr, { signal: AbortSignal.timeout(10000) })).json(); const ps = (j.pairs || []).filter((p) => p.chainId === 'bsc' && String(p.baseToken?.address || '').toLowerCase() === addr && (p.liquidity?.usd || 0) > 50); if (ps.length) { ps.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0)); const p = ps[0]; v = { pair: String(p.pairAddress).toLowerCase(), dex: p.dexId + (p.labels?.length ? ' ' + p.labels.join('') : ''), quote: p.quoteToken?.symbol || '', px: Number(p.priceUsd) || 0, liq: p.liquidity?.usd || 0 }; } } catch {}
  if (!v) v = await geckoPool(addr); /* 除錯 11/1：NOV 的池子開在 PancakeSwap Infinity，DexScreener 一直沒收錄，工具以為沒開盤、也讀不到價格 → 再用 GeckoTerminal 查（Infinity、Uniswap v4、V3 都有） */
  dsCache.set(addr, { t: Date.now(), v }); return v;
}
async function geckoPool(addr) {
  try {
    const j = await (await fetch(`https://api.geckoterminal.com/api/v2/networks/bsc/tokens/${addr}/pools`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10000) })).json();
    const ps = (j.data || []).map((p) => { const a = p.attributes || {}, base = String(p.relationships?.base_token?.data?.id || '').toLowerCase().endsWith(addr); return { id: String(a.address || '').toLowerCase(), name: a.name || '', dex: String(p.relationships?.dex?.data?.id || 'gecko'), px: Number(base ? a.base_token_price_usd : a.quote_token_price_usd) || 0, liq: Number(a.reserve_in_usd) || 0 }; }).filter((x) => x.px > 0 && x.liq > 50).sort((x, y) => y.liq - x.liq);
    if (!ps.length) return null; const p = ps[0];
    return { pair: /^0x[0-9a-f]{40}$/.test(p.id) ? p.id : 'gt:' + p.id, dex: p.dex, quote: (p.name.split('/')[1] || '').trim().split(' ')[0], px: p.px, liq: p.liq };
  } catch { return null; }
}
async function poolOpen(tk) { /* 有沒有已經開池（任何配對、任何 DEX）：V2 常見報價幣＋DexScreener（審查修正） */
  for (const q of [WBNB, USDT, USD1, ...XQ]) { const pr = await cc(FACTORY, '0xe6a43905' + wa(tk) + wa(q), 60e3); if (pr && BigInt(pr) > 0n) { const rs = await call('0x' + pr.slice(26), '0x0902f1ac'); if (rs && BigInt('0x' + rs.slice(2, 66)) > 0n) return true; } }
  return !!(await dexScreener(tk));
}
async function findPair(t) {
  for (const q of [USDT, WBNB, USD1, ...XQ]) { const r = await call(FACTORY, '0xe6a43905' + wa(t.addr) + wa(q)); const p = r ? '0x' + r.slice(-40) : null; if (!p || /^0x0{40}$/.test(p)) continue; const rs = await call(p, '0x0902f1ac'); if (!rs || BigInt('0x' + rs.slice(2, 66)) === 0n || BigInt('0x' + rs.slice(66, 130)) === 0n) continue; /* 有池子但沒加流動性 = 還沒真的開盤 */ return { pair: p, quote: q }; }
  { const d = await dexScreener(t.addr); if (d) return { pair: d.pair, ds: 1, dex: d.dex, quote: d.quote }; } /* V2 的 BNB/USDT/USD1/Flap 報價幣都沒有 → 用 DexScreener 找任何池子 */
  return null;
}
async function valueUsd(t, amt) { // 全部賣掉約可換多少 USDT
  if (amt <= 0n) return 0;
  let best = null; for (const path of [[t.addr, USDT], [t.addr, WBNB, USDT], [t.addr, USD1], ...XQ.flatMap((q) => [[t.addr, q, WBNB, USDT], [t.addr, q, USDT]])]) { const r = await call(ROUTER, '0xd06ca61f' + w(amt) + w(64) + w(path.length) + path.map(wa).join('')); if (r) { const x = Number(BigInt('0x' + r.slice(-64))) / 1e18; if (best == null || x > best) best = x; } } // 審查修正：取所有池子裡最好的價格，避免被很小的池子誤判
  if (best != null && best > 0) { const d = await dexScreener(t.addr); if (d?.px && d.liq > 2000) { const dec = await tokDec(t.addr).catch(() => 18); const dv = Math.min((Number(amt) / 10 ** dec) * d.px * 0.97, d.liq * 0.3); if (dv > best * 1.5) best = dv; } } /* 審查修正：有很小的 V2 池子、但真正的大池子在別處時，用大池子的價格，避免誤判成暴跌而賣掉 */
  if (best == null) { const d = await dexScreener(t.addr); if (d?.px) { const dec = await tokDec(t.addr).catch(() => 18); best = Math.min((Number(amt) / 10 ** dec) * d.px * 0.97, d.liq * 0.3); } /* 小池子：最多估到池子流動性的 3 成，避免高估 */ } /* 路由算不出來（V3／其他 DEX／其他報價幣）→ 用 DexScreener 價格估，打 97 折當滑價 */
  return best;
}
async function flow(t, st, from, to) { // 新錢包數、成交筆數
  try {
    const tr = await rpc('eth_getLogs', [{ address: t.addr, topics: [T_TRANSFER], fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16) }]);
    st.holders = st.holders || {}; let fresh = 0;
    for (const l of tr) { const toA = '0x' + l.topics[2].slice(26); if (!st.holders[toA]) { st.holders[toA] = 1; fresh++; } }
    let swaps = 0; if (st.pair && /^0x[0-9a-f]{40}$/.test(st.pair)) swaps = (await rpc('eth_getLogs', [{ address: st.pair, topics: [T_SWAP], fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16) }])).length;
    return { fresh, swaps };
  } catch { return { fresh: 0, swaps: 0 }; }
}
const decCache = new Map();
async function tokDec(a) {
  if (!decCache.has(a)) {
    const result = decodeAbiUint(await call(a, '0x313ce567'));
    if (result === null || result > 255n) throw new Error('无法确认代币精度');
    decCache.set(a, Number(result));
  }
  return decCache.get(a);
}
const noLink = value => String(value || '').replace(/https?:\/\/\S+|www\.\S+|\b[\w-]+\.(?:xyz|com|io|org|net|app|fun|site|top)\b\S*/gi, '[链接已移除]').slice(0, 160);
function trackFromSim(W, sim, sym, costUsd, transactionId = null, fallbackToken = '') {
  const lastPrice = S.lastBnbUsd > 0 && Date.now() - (S.lastBnbUsdAt || 0) < 900000 ? S.lastBnbUsd : 0;
  const basis = deriveMintCost(sim, W.addr, { costUsd, bnbUsd: lastPrice, usdt: USDT });
  const tx = /^0x[0-9a-f]{64}$/i.test(transactionId || '') ? transactionId.toLowerCase() : null;
  const seen = new Set();
  // Some verified paid mint calls lock the token before it appears as a wallet
  // balance gain. Preserve their existing token() tracking via this same basis.
  const changes = [...(sim?.balanceChanges || [])];
  if (/^0x[0-9a-f]{40}$/i.test(fallbackToken || '')) changes.push({ owner: W.addr, tokenType: 'Erc20', contractAddress: fallbackToken, change: '1' });
  for (const change of changes) {
    const addr = String(change.contractAddress || '').toLowerCase();
    if (String(change.owner).toLowerCase() !== W.addr || change.tokenType !== 'Erc20' || !(Number(change.change) > 0) || !/^0x[0-9a-f]{40}$/.test(addr) || [USDT, WBNB, NATIVE_BNB.toLowerCase()].includes(addr)) continue;
    if (seen.has(addr)) continue; seen.add(addr);
    S.dyn ||= [];
    const existing = S.dyn.find(token => token.addr === addr && token.only === W.addr);
    if (!existing) {
      S.dyn.push({ sym: sym || addr.slice(0, 8), addr, ...basis, knownCostUsd: basis.costUnknown ? 0 : basis.cost, unpricedPaidBnbWei: basis.costUnknown ? basis.paidBnbWei : '0', unpricedPaidUsdtWei: basis.costUnknown ? basis.paidUsdtWei : '0', ...(tx ? { mintTxHashes: [tx] } : {}), only: W.addr, boughtAt: Date.now() });
      continue;
    }
    if (tx && existing.mintTxHashes?.includes(tx)) { if (sym) existing.sym = sym; continue; }
    // Confirmed hashes permit cumulative accounting. Legacy callers without a
    // hash can still correct free -> paid, but cannot double-count a prior cost.
    if (!tx && (existing.cost > 0 || existing.costUnknown)) continue;
    const uint = value => /^\d+$/.test(value || '') ? BigInt(value) : 0n;
    const known = Number.isFinite(existing.knownCostUsd) ? existing.knownCostUsd : existing.costUnknown ? 0 : Number(existing.cost) || 0;
    const priorUnknownBnb = existing.unpricedPaidBnbWei ?? (existing.costUnknown ? existing.paidBnbWei : '0');
    const priorUnknownUsdt = existing.unpricedPaidUsdtWei ?? (existing.costUnknown ? existing.paidUsdtWei : '0');
    existing.knownCostUsd = known + (basis.costUnknown ? 0 : basis.cost);
    existing.unpricedPaidBnbWei = (uint(priorUnknownBnb) + (basis.costUnknown ? uint(basis.paidBnbWei) : 0n)).toString();
    existing.unpricedPaidUsdtWei = (uint(priorUnknownUsdt) + (basis.costUnknown ? uint(basis.paidUsdtWei) : 0n)).toString();
    existing.paidBnbWei = (uint(existing.paidBnbWei) + uint(basis.paidBnbWei)).toString();
    existing.paidUsdtWei = (uint(existing.paidUsdtWei) + uint(basis.paidUsdtWei)).toString();
    existing.cost = existing.knownCostUsd;
    existing.costUnknown = existing.costUnknown || basis.costUnknown;
    existing.costEstimated = existing.costEstimated || basis.costEstimated;
    existing.costSource = existing.costUnknown ? 'payment-price-unavailable' : 'confirmed-mint-cost';
    if (tx) existing.mintTxHashes = [...(existing.mintTxHashes || []), tx];
  }
}
function mintTrackingPlan(W, sim, costUsd, fallbackToken = '') {
  if (!(costUsd > 0)) return null;
  const tokens = [...new Set([...(sim?.balanceChanges || []).filter(change => String(change.owner).toLowerCase() === W.addr && change.tokenType === 'Erc20' && /^\d+$/.test(String(change.change)) && BigInt(String(change.change)) > 0n).map(change => String(change.contractAddress).toLowerCase()), String(fallbackToken).toLowerCase()].filter(address => validMintAddress(address) && ![USDT, WBNB, NATIVE_BNB.toLowerCase()].includes(address)))].slice(0, 32);
  if (!tokens.length) return null;
  const basis = deriveMintCost(sim, W.addr, { costUsd, usdt: USDT });
  return { version: 1, walletAddress: W.addr, receivedTokens: tokens, costUsdMicros: usdBudgetMicros(costUsd), paidBnbWei: basis.paidBnbWei, paidUsdtWei: basis.paidUsdtWei };
}
function applyMintTracking(W, pending, txHash) {
  const plan = pending.mintTracking;
  if (!plan) return;
  const uint = value => typeof value === 'string' && /^\d{1,78}$/.test(value);
  if (plan.version !== 1 || plan.walletAddress !== W.addr || !/^0x[0-9a-f]{64}$/i.test(txHash || '') || !Array.isArray(plan.receivedTokens) || plan.receivedTokens.length > 32 || !plan.receivedTokens.every(address => validMintAddress(address) && ![USDT, WBNB, NATIVE_BNB.toLowerCase()].includes(address)) || !uint(plan.costUsdMicros) || !uint(plan.paidBnbWei) || !uint(plan.paidUsdtWei) || BigInt(plan.costUsdMicros) <= 0n || plan.costUsdMicros !== pending.settlement?.successSpentUsdMicros) throw new Error('铸造成本恢复计划无法核验');
  const changes = plan.receivedTokens.map(address => ({ owner: W.addr, tokenType: 'Erc20', contractAddress: address, change: '1' }));
  if (BigInt(plan.paidBnbWei) > 0n) changes.push({ owner: W.addr, contractAddress: NATIVE_BNB, change: '-' + plan.paidBnbWei });
  if (BigInt(plan.paidUsdtWei) > 0n) changes.push({ owner: W.addr, contractAddress: USDT, change: '-' + plan.paidUsdtWei });
  trackFromSim(W, { balanceChanges: changes }, '', Number(plan.costUsdMicros) / 1e6, txHash);
  save(true);
}
function positionFor(W, token) {
  const key = positionStateKey(W.addr, token.addr);
  if (!S.tokens[key]) {
    const aliases = legacyAliases(W);
    const oldKeys = [...new Set([...(aliases.length && W.addr === S.costWalletAddress ? [token.sym] : []), ...aliases.map(name => name + ':' + token.sym)])];
    const matching = new Set(TOKENS.concat(S.dyn || []).filter((item) => item.sym === token.sym && (!item.only || item.only.toLowerCase() === W.addr)).map((item) => item.addr.toLowerCase()));
    const candidates = matching.size === 1 ? oldKeys.map(oldKey => ({ oldKey, state: Object.hasOwn(S.tokens, oldKey) ? S.tokens[oldKey] : null })).filter(entry => entry.state && typeof entry.state === 'object' && !Array.isArray(entry.state) && (!entry.state.addr || typeof entry.state.addr === 'string' && entry.state.addr.toLowerCase() === token.addr.toLowerCase()) && (!entry.state.walletAddress || typeof entry.state.walletAddress === 'string' && entry.state.walletAddress.toLowerCase() === W.addr)) : [];
    if (candidates.length && candidates.every(entry => JSON.stringify(entry.state) === JSON.stringify(candidates[0].state))) {
      S.tokens[key] = candidates[0].state;
      for (const entry of candidates) delete S.tokens[entry.oldKey];
    } else {
      S.tokens[key] = { hist: [], peak: 0, peakAt: 0, sold: 0 };
      if (candidates.length > 1) {
        const reason = '旧持仓记录存在多个冲突版本，请人工核对后再恢复自动卖出';
        Object.assign(S.tokens[key], { sellReviewRequired: true, sellReview: { reason, legacyKeys: candidates.map(entry => entry.oldKey) }, sellStatus: 'manual-review', eligibility: 'blocked', reason });
      }
    }
  }
  const state = S.tokens[key];
  state.walletId = W.id; state.effectiveRules = rulesFor(W);
  state.addr = token.addr.toLowerCase(); state.walletAddress = W.addr; state.sym = token.sym;
  state.hist ||= []; state.done2 ||= []; state.notified ||= [];
  return state;
}
function requireSellReview(st, pending, reason, details = {}) {
  st.sellReviewRequired = true;
  st.sellReview = { orderId: pending.orderId, requestedUnits: pending.requestedUnits, walletAddress: pending.walletAddress, addr: pending.addr, reason, checkedAt: Date.now(), ...details };
  delete st.pendingSell; delete st.sellRetry;
  st.sellStatus = 'manual-review'; st.eligibility = 'blocked'; st.reason = reason;
  st.nextTrigger = { type: 'manual-review', orderId: pending.orderId }; save();
  return false;
}
const SELL_BUSY = new Set();
async function reconcileSell(t, st, W) {
  return withWalletExecution(W.profile, () => reconcileSellInner(t, st, W), { root: DIR, kind: 'reconcile', allowBlocked: true });
}
async function reconcileSellInner(t, st, W) {
  const pending = st.pendingSell; if (!pending) return false;
  const response = await W.baw(['market-order', 'list', '--orderId', pending.orderId], 60000);
  // Another concurrent status check may have already resolved this order.
  if (st.pendingSell !== pending) return false;
  const order = response.j?.success ? marketOrderRecord(response.j.data, pending.orderId) : null;
  const status = marketOrderState(order);
  pending.status = status; pending.checkedAt = Date.now();
  if (status === 'pending') { st.sellStatus = 'pending'; st.eligibility = 'pending'; st.reason = '卖出订单已提交，等待最终成交确认'; st.nextTrigger = { type: 'pending', orderId: pending.orderId, since: pending.submittedAt }; save(); return false; }
  if (status === 'failed') {
    await clearWalletBlocked(W.profile, { root: DIR, reference: pending.orderId });
    delete st.pendingSell; st.sellStatus = 'failed'; st.sellRetryAfter = Date.now() + 30000;
    if (pending.action.id === 'freeDrop') { st.freeFail = (st.freeFail || 0) + 1; st.freeFailAt = Date.now(); }
    save(); await tg(`⚠️ [${W.name}] ${t.sym} 卖出订单失败，未标记成交\n订单 ${pending.orderId}`); return false;
  }
  const [after, receipt] = await Promise.all([
    call(t.addr, '0x70a08231' + wa(W.addr)).then(decodeAbiUint),
    /^0x[0-9a-f]{64}$/i.test(order.txHash || '') ? rpc('eth_getTransactionReceipt', [order.txHash]).catch(() => null) : null,
  ]);
  if (st.pendingSell !== pending) return false;
  const before = BigInt(pending.balanceBefore), requested = BigInt(pending.requestedUnits);
  const spent = receiptTokenOutflow(receipt, t.addr, W.addr), refunded = refundedTokenUnits(order, t.addr, pending.decimals);
  if (refunded !== null && refunded > 0n || spent !== null && spent !== requested) {
    return requireSellReview(st, pending, '订单部分成交或实际扣款与目标不一致，已停止自动补卖，请人工核对', { receiptOutUnits: spent?.toString() ?? null, refundedUnits: refunded?.toString() ?? null, currentBalance: after?.toString() ?? null });
  }
  if (spent === null) { pending.status = 'finished-awaiting-receipt'; st.sellStatus = pending.status; st.eligibility = 'pending'; st.reason = '订单完成，仍待本笔交易转账凭证核验'; st.nextTrigger = { type: pending.status, orderId: pending.orderId }; save(); return false; }
  if (after === null || after >= before) { pending.status = 'finished-awaiting-balance'; st.sellStatus = pending.status; st.eligibility = 'pending'; st.reason = '本单转账已核验，仍待链上余额减少确认'; st.nextTrigger = { type: pending.status, orderId: pending.orderId }; save(); return false; }
  const action = pending.action;
  await clearWalletBlocked(W.profile, { root: DIR, reference: pending.orderId });
  delete st.pendingSell; delete st.sellRetry;
  st.lastBal = after.toString(); st.sellStatus = 'finished';
  Object.assign(st, applyConfirmedSell(st, action)); if (action.full) st.closedOrderConfirmed = true;
  const received = parseTokenAmount(order.toTokenActualQty, 18);
  const got = received === null ? null : Number(received) / 1e18;
  const price = got === null ? 0 : await bnbUsd().catch(() => 0);
  const usd = got === null || !(price > 0) ? null : got * price;
  S.trades ||= [];
  S.trades.push({ sym: t.sym, addr: t.addr, w: W.name, walletId: W.id, walletAddress: W.addr, orderId: pending.orderId, txHash: order.txHash || null, status: st.sellStatus, quantity: formatTokenAmount(spent, pending.decimals), bnb: got, usd, cost: t.cost || 0, at: ts(), why: pending.why });
  st.nextTrigger = null;
  save();
  await tg(`💰 [${W.name}] 已确认卖出 ${t.sym}（${pending.why}）\n数量 ${formatTokenAmount(spent, pending.decimals)}${got !== null ? '\n实际收到 ' + formatTokenAmount(received, 18) + ' BNB' : '\n实际回款数量尚未提供'}\n订单 ${pending.orderId}${order.txHash ? '\n交易 ' + order.txHash : ''}`);
  return true;
}
async function sell(t, st, amt, why, W = WALLETS[0], action = { id: 'manual', full: false }) {
  if (MONITOR_ONLY) return false;
  INFLIGHT++;
  try {
    if (st?.pendingSell) return await reconcileSell(t, st, W);
    if (!canWallet(W, 'token-sell')) return false;
    return await withWalletExecution(W.profile, () => sellInner(t, st, amt, why, W, action), { root: DIR, kind: 'scanner-token-sell' });
  } finally { INFLIGHT--; }
}
async function sellInner(t, st, amt, why, W, action) {
  if (!canWallet(W, 'token-sell')) return false;
  const key = positionStateKey(W.addr, t.addr);
  if (SELL_BUSY.has(key)) return false;
  SELL_BUSY.add(key);
  try {
    if (st.pendingSell) return await reconcileSell(t, st, W);
    if (st.sellReviewRequired) { st.eligibility = 'blocked'; st.reason = st.sellReview?.reason || '上次卖出需要人工核对，未自动重发'; st.nextTrigger = { type: 'manual-review', orderId: st.sellReview?.orderId }; save(); return false; }
    if (st.submissionIntent) { st.sellStatus = 'submission-unknown'; st.eligibility = 'blocked'; st.reason = '上次卖出提交结果不明，需人工对账，已阻止自动重发'; st.nextTrigger = { type: 'submission-unknown', since: st.submissionIntent.createdAt }; save(); return false; }
    if (Date.now() < (st.sellRetryAfter || 0)) return false;
    const decimalsWord = Number.isInteger(st.decimals) ? BigInt(st.decimals) : decodeAbiUint(await call(t.addr, '0x313ce567'));
    if (decimalsWord === null || decimalsWord > 255n) { st.sellStatus = 'unknown-decimals'; save(); return false; }
    st.decimals = Number(decimalsWord);
    const before = decodeAbiUint(await call(t.addr, '0x70a08231' + wa(W.addr)));
    if (before === null || before === 0n) return false;

    if (typeof amt !== 'bigint' || amt <= 0n) return false;
    const manual = ['manual', 'manualHalf', 'manualFull', 'sellNow'].includes(action.id);
    if (!manual) {
      const moon = (st.done2 || []).includes('back') && /^\d+$/.test(st.moon || '') ? BigInt(st.moon) : 0n;
      if (amt > before || amt > (before > moon ? before - moon : 0n)) {
        st.eligibility = 'waiting-price'; st.reason = '余额已变化，等待重新报价与计算长抱保留量'; return false;
      }
    } else if (amt > before) amt = before;
    const quantity = formatTokenAmount(amt, st.decimals);
    st.submissionIntent = { schemaVersion: 1, addr: t.addr, walletAddress: W.addr, requestedUnits: amt.toString(), quantity, decimals: st.decimals, createdAt: Date.now(), why, action: { id: action.id, full: action.full === true, ...(typeof action.moonReserveUnits === 'string' ? { moonReserveUnits: action.moonReserveUnits } : {}), ...(action.moonOnlyAfter === true ? { moonOnlyAfter: true } : {}) } };
    st.sellStatus = 'submitting'; st.eligibility = 'pending'; st.reason = '正在提交卖出，等待订单号'; save(true);
    const result = await W.baw(['market-order', 'swap', '--binanceChainId', '56', '--fromTokenQty', quantity, '--fromToken', t.addr, '--toToken', NATIVE_BNB]);
    logWallet(W, `提交卖出 ${t.sym} ${quantity}: ${result.t.slice(0, 600)}`);
    const orderId = result.j?.success && result.j.data?.orderId;
    if (!orderId) {
      const rejected = ['INVALID_PARAMS', 'INVALID_AMOUNT', 'INVALID_ADDRESS', 'NOT_LOGGED_IN', 'INSUFFICIENT_BALANCE', 'CONFIG_ERROR', 'CLI_NOT_READY'].includes(result.j?.error?.name);
      if (!rejected) await markWalletBlocked(W.profile, '代币卖出提交结果不明', { root: DIR });
      if (rejected) { delete st.submissionIntent; st.sellStatus = 'submit-rejected'; st.sellRetryAfter = Date.now() + 30000; }
      else { st.sellStatus = 'submission-unknown'; st.eligibility = 'blocked'; st.reason = '卖出提交结果不明，需人工对账，已阻止自动重发'; st.nextTrigger = { type: 'submission-unknown', since: st.submissionIntent.createdAt }; }
      save(); await tg(`⚠️ [${W.name}] ${t.sym} ${rejected ? '卖出已被明确拒绝' : '卖出提交结果不明，已阻止自动重发，请人工核对'}\n${(result.j?.error?.message || '未返回订单号').slice(0, 160)}`); return false;
    }
    st.pendingSell = { schemaVersion: 1, orderId: String(orderId), addr: t.addr, walletAddress: W.addr, requestedUnits: amt.toString(), balanceBefore: before.toString(), decimals: st.decimals, submittedAt: Date.now(), why, action: { id: action.id, full: action.full === true, ...(typeof action.moonReserveUnits === 'string' ? { moonReserveUnits: action.moonReserveUnits } : {}), ...(action.moonOnlyAfter === true ? { moonOnlyAfter: true } : {}) } };
    delete st.submissionIntent;
    st.sellStatus = 'pending'; st.nextTrigger = { type: 'pending', orderId: String(orderId) }; save(true);
    return await reconcileSell(t, st, W);
  } catch (error) {
    if (st.submissionIntent && !st.pendingSell) { await markWalletBlocked(W.profile, '代币卖出提交响应中断', { root: DIR }); st.sellStatus = 'submission-unknown'; st.eligibility = 'blocked'; st.reason = '提交过程中响应中断，需人工对账，已阻止自动重发'; st.nextTrigger = { type: 'submission-unknown', since: st.submissionIntent.createdAt }; save(); return false; }
    throw error;
  } finally { SELL_BUSY.delete(key); }
}

const HOLDINGS_WALLET_JOBS = new Map();
async function holdings(head, onlyFast = false) {
  syncWalletProfiles();
  const jobs = [];
  S.walletRuntime ||= {};
  for (const W of WALLETS) {
    let job = HOLDINGS_WALLET_JOBS.get(W.id);
    if (!job) {
      const status = S.walletRuntime[W.id] ||= {};
      Object.assign(status, { walletAddress: W.addr, name: W.name, checking: true, startedAt: Date.now() });
      job = holdW(W, head, onlyFast).then(() => {
        status.updatedAt = Date.now(); delete status.error; S.holdingsUpdatedAt = status.updatedAt;
      }).catch(error => {
        status.error = error.message; status.errorAt = Date.now(); logWallet(W, '持仓检查失败 ' + error.message); throw error;
      }).finally(() => {
        status.checking = false; HOLDINGS_WALLET_JOBS.delete(W.id);
        S.holdingsInFlight = HOLDINGS_WALLET_JOBS.size > 0; save();
      });
      HOLDINGS_WALLET_JOBS.set(W.id, job);
    }
    jobs.push(job);
  }
  const completed = Promise.allSettled(jobs).then(results => {
    const errors = results.filter(result => result.status === 'rejected');
    if (errors.length) throw new Error('部分钱包持仓检查失败，请查看各钱包状态');
    return { pending: false };
  });
  // A slow wallet keeps its own job while faster peers may enter the next round.
  // Every promise is observed even after the bounded scheduler wait has elapsed.
  return Promise.race([completed, sleep(1000).then(() => ({ pending: true }))]);
}
async function holdW(W, head, onlyFast) {
  await recoverScannerWallet(W);
  const RULE = rulesFor(W), sellingEnabled = canWallet(W, 'token-sell');
  S.effectiveWalletRules ||= {}; S.effectiveWalletRules[W.id] = structuredClone(RULE);
  const seen = new Set();
  for (const t0 of TOKENS.concat(S.dyn || [])) {
    if (t0.only && t0.only.toLowerCase() !== W.addr) continue;
    if (seen.has(t0.addr.toLowerCase())) continue; seen.add(t0.addr.toLowerCase());
    if (!(tokenCostFor(W, t0) > 0) && !t0.costUnknown && (/^\d+$/.test(t0.paidBnbWei || '') && BigInt(t0.paidBnbWei) > 0n || /^\d+$/.test(t0.paidUsdtWei || '') && BigInt(t0.paidUsdtWei) > 0n)) { t0.costUnknown = true; t0.costSource = 'payment-evidence'; save(); }
    if (t0.costUnknown) {
      const bnbEvidence = t0.unpricedPaidBnbWei ?? t0.paidBnbWei, usdtEvidence = t0.unpricedPaidUsdtWei ?? t0.paidUsdtWei;
      const paidBnb = /^\d+$/.test(bnbEvidence || '') ? BigInt(bnbEvidence) : 0n, paidUsdt = /^\d+$/.test(usdtEvidence || '') ? BigInt(usdtEvidence) : 0n;
      const price = paidBnb > 0n ? await bnbUsd().catch(() => 0) : 0;
      if ((paidBnb > 0n || paidUsdt > 0n) && (paidBnb === 0n || price > 0)) { t0.cost = (Number(t0.knownCostUsd) || 0) + Number(paidBnb) / 1e18 * price + Number(paidUsdt) / 1e18; t0.knownCostUsd = t0.cost; t0.unpricedPaidBnbWei = '0'; t0.unpricedPaidUsdtWei = '0'; t0.costUnknown = false; t0.costEstimated = true; save(); }
    }
    const pendingCost = S.walletPending?.[W.id]?.mintTracking?.receivedTokens?.includes(t0.addr.toLowerCase()) === true;
    const t = { ...t0, addr: t0.addr.toLowerCase(), cost: tokenCostFor(W, t0), costUnknown: t0.costUnknown || pendingCost, ...(!sellingEnabled ? { hold: true, sellNow: false } : {}) };
    const st = positionFor(W, t); st.cost = Number(t.cost) || 0;
    st.eligibility = !sellingEnabled ? 'monitor-only' : t.hold ? 'hold' : 'waiting-price';
    st.reason = !sellingEnabled ? '此钱包只监控或已暂停，不执行新卖出' : t.hold ? '配置为持有，仅通知' : '等待可用价格';
    if ((st.pendingSell || st.submissionIntent || st.sellReviewRequired) && !MONITOR_ONLY) { await sell(t, st, 0n, '', W); if (st.pendingSell || st.submissionIntent || st.sellReviewRequired) continue; }
    if (t.costUnknown) { st.eligibility = 'unknown-cost'; st.reason = '已确认付费但成本价格无法核验，暂停自动卖出并等待恢复成本'; st.costUnknown = true; continue; }
    delete st.costUnknown;
    if (onlyFast && !(st.openAt && Date.now() - st.openAt < RULE.fastMin * 60000 && st.stage !== 9 && !st.done)) continue;
    const bal = decodeAbiUint(await call(t.addr, '0x70a08231' + wa(W.addr)));
    if (bal === null) { st.balanceReadErrorAt = Date.now(); st.eligibility = 'read-error'; st.reason = '余额读取失败，未标记清仓'; continue; }
    const previous = BigInt(st.lastBal || '0');
    st.lastBal = bal.toString();
    const received = bal > previous && st.balInit; st.balInit = true;
    if (bal === 0n) { st.done = true; st.eligibility = 'empty'; st.reason = '当前链上余额为零'; st.last = { v: 0, at: ts() }; continue; }
    if ((st.done || st.stage >= 9) && (!st.closedOrderConfirmed || previous === 0n || bal > previous)) {
      Object.assign(st, { done: false, stage: 0, done2: [], sellNowDone: false, referenceBalance: bal.toString(), pricePeak: 0, freePricePeak: 0, freeFail: 0 });
      delete st.sellRetry; delete st.moon; delete st.moonOnly; delete st.drawdownSampleAt; delete st.drawdownRule; delete st.drawdownHits;
    }
    if (st.moonOnly && /^\d+$/.test(st.moon || '') && bal > BigInt(st.moon)) st.moonOnly = false;
    st.done = false;
    if (!st.referenceBalance || BigInt(st.referenceBalance) <= 0n) { st.referenceBalance = bal.toString(); st.basisEstimated = st.done2.length > 0; }
    const decimals = Number.isInteger(st.decimals) ? BigInt(st.decimals) : decodeAbiUint(await call(t.addr, '0x313ce567'));
    if (decimals !== null && decimals <= 255n) st.decimals = Number(decimals);
    if (st.pair && !st.verified && !st.pairDs && /^0x[0-9a-f]{40}$/i.test(st.pair)) {
      const rs = await call(st.pair, '0x0902f1ac');
      if (rs && rs.length >= 130) { if (BigInt(rs.slice(0, 66)) === 0n) { delete st.pair; st.checked = true; } st.verified = true; }
    }
    if (!st.pair) {
      const pair = await findPair(t); const first = !st.checked; st.checked = true;
      if (pair) { st.pair = pair.pair; if (pair.ds) { st.pairDs = 1; st.pairInfo = `${pair.dex} / ${pair.quote}`; } st.openAt ||= Date.now(); st.fromBlock = head - 400; if (!first) await honeypotCheck(W, t, st, bal); if (!first) await tg(`🚀 ${t.sym} 开池了\n池子 ${pair.pair}\n按配置规则追踪价格`); }
      else { st.eligibility = 'no-liquidity'; st.reason = '尚未发现可用流动池'; if (t0.deployer && t0.boughtAt && Date.now() - t0.boughtAt > 48 * 3600000) blacklist(t0.deployer, `${t.sym} 打完48小时还没开池`); continue; }
    }
    const value = await valueUsd(t, bal); if (value === null || !Number.isFinite(value) || value < 0) { st.eligibility = 'quote-unavailable'; st.reason = '当前无法取得有效报价'; continue; }
    if (received) await tg(`🎁 [${W.name}] 收到 ${t.sym} ${Number.isInteger(st.decimals) ? formatTokenAmount(bal - previous, st.decimals) : '（数量精度待确认）'}，当前仓位约 ${value.toFixed(2)}U`);
    const normalized = normalizedPositionValue(value, bal, BigInt(st.referenceBalance)); if (normalized === null) continue;
    const now = Date.now();
    st.priceValue = normalized;
    if (!(st.pricePeak > 0)) st.pricePeak = !st.basisEstimated && st.peak > 0 ? Math.max(st.peak, normalized) : normalized;
    if (normalized > st.pricePeak) { st.pricePeak = normalized; st.pricePeakAt = now; }
    if (value > (st.peak || 0)) { st.peak = value; st.peakAt = now; }
    if (!(t.cost > 0) && st.openAt && now - st.openAt >= FREE_PEAK_DELAY_MS) {
      if (!(st.freePricePeak > 0)) st.freePricePeak = !st.basisEstimated && st.fpeak > 0 ? Math.max(st.fpeak, normalized) : normalized;
      if (normalized > st.freePricePeak) { st.freePricePeak = normalized; st.freeFail = 0; }
      st.fpeak = st.freePricePeak;
    }
    Object.assign(st, samplePositionDrawdown({ token: t, state: st, value, referenceValue: normalized, now, rules: RULE }));
    st.base ||= normalized;
    const notifyBase = t.cost > 0 ? t.cost : st.base;
    for (const multiple of (st.moonOnly ? RULE.moonNotifyX : RULE.notifyX)) if (notifyBase > 0 && normalized >= notifyBase * multiple && !st.notified.includes(multiple)) { st.notified.push(multiple); await tg(`🔥 [${W.name}] ${t.sym} 到 ${multiple} 倍，当前仓位约 ${value.toFixed(2)}U\n${t.hold || st.moonOnly ? '长抱/持有，仅通知，不自动卖出' : '继续按配置的止盈和回撤规则执行'}`); }
    if (t.hold && st.pricePeak > 0 && normalized < st.pricePeak * (1 - RULE.drop) && st.dropWarnedPeak !== st.pricePeak) { st.dropWarnedPeak = st.pricePeak; await tg(`⚠️ [${W.name}] ${t.sym} 从最高点回撤 ${Math.round(RULE.drop * 100)}%，当前仓位约 ${value.toFixed(2)}U\n仅通知，不自动卖出`); }
    if (st.stage == null) st.stage = st.sold >= 2 ? 9 : st.sold === 1 ? 1 : 0;
    if (st.moonOnly && !t.sellNow) { st.eligibility = 'moon'; st.reason = '长抱仓位仅通知，不自动卖出'; }
    if (sellingEnabled && !t.hold && !st.moonOnly) {
      st.eligibility = !Number.isInteger(st.decimals) ? 'unknown-decimals' : !(t.cost > 0) && value < FREE_SELL_MIN_USD ? 'below-free-minimum' : 'ready';
      st.reason = st.eligibility === 'unknown-decimals' ? '无法确认代币精度，未执行卖出' : st.eligibility === 'below-free-minimum' ? `免费币仓位低于 ${FREE_SELL_MIN_USD}U 最低自动卖出金额` : '按生效规则等待触发';
    }
    const action = Number.isInteger(st.decimals) ? planPositionSell({ token: t, state: st, balance: bal, value, referenceValue: normalized, now, rules: RULE, monitorOnly: !sellingEnabled }) : null;
    st.nextTrigger = action ? { type: 'sell', actionId: action.id, reason: action.reason, requestedUnits: action.amount.toString() } : { type: t.hold ? 'hold' : t.cost > 0 ? 'paid-rules' : value < FREE_SELL_MIN_USD ? 'below-free-minimum' : 'free-drop', nextBackX: RULE.backX, halfX: [...(RULE.halfX || [])], steps: RULE.steps, moonPct: RULE.moonPct, drop: t.cost > 0 ? RULE.crash : RULE.drop };
    st.last = { v: value, priceValue: normalized, at: ts() };
    if (action) { if (action.id === 'crash' && !st.done2.includes('back') && t0.deployer) blacklist(t0.deployer, `${t.sym} 还没回本就崩`); await sell(t, st, action.amount, action.reason, W, action); }
  }
}

// ---------- 新的 Agent ID 專屬鑄造 ----------
const CANDS = [['mint()', '0x1249c58b'], ['freeMint()', '0x5b70ea9f'], ['claim()', '0x4e71d92d'], ['mint(1)', '0xa0712d68' + w(1)], ['publicMint()', '0x26092b83'], ['commitFreeMint()', '0x74d04cfc'], ['registerForRewards()', '0x9f92d0dd'], ['freeMint(1)', '0x7c928fe9' + w(1)], ['claim(1)', '0x379607f5' + w(1)], ['mintFree()', '0x8ab53447'], ['claimFree()', '0xf366afc9'], ['agentMint()', '0x1be3587a']];
// ---- keccak256（算 CREATE2 地址用）----
const KRC = [1n,0x8082n,0x800000000000808an,0x8000000080008000n,0x808bn,0x80000001n,0x8000000080008081n,0x8000000000008009n,0x8an,0x88n,0x80008009n,0x8000000an,0x8000808bn,0x800000000000008bn,0x8000000000008089n,0x8000000000008003n,0x8000000000008002n,0x8000000000000080n,0x800an,0x800000008000000an,0x8000000080008081n,0x8000000000008080n,0x80000001n,0x8000000080008008n];
const KROT = [0,1,62,28,27,36,44,6,55,20,3,10,43,25,39,41,45,15,21,8,18,2,61,56,14];
const M64 = (1n << 64n) - 1n; const rotl = (x, n) => (n === 0 ? x : ((x << BigInt(n)) | (x >> BigInt(64 - n))) & M64);
function keccakHex(hex) {
  const msg = Buffer.from(hex, 'hex'); const rate = 136; const padLen = rate - (msg.length % rate); const p = Buffer.concat([msg, Buffer.alloc(padLen)]); p[msg.length] ^= 0x01; p[p.length - 1] ^= 0x80;
  const A = new Array(25).fill(0n);
  for (let off = 0; off < p.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) A[i] ^= p.readBigUInt64LE(off + i * 8);
    for (let r = 0; r < 24; r++) {
      const C = [0, 1, 2, 3, 4].map((x) => A[x] ^ A[x + 5] ^ A[x + 10] ^ A[x + 15] ^ A[x + 20]);
      for (let x = 0; x < 5; x++) { const D = C[(x + 4) % 5] ^ rotl(C[(x + 1) % 5], 1); for (let y = 0; y < 25; y += 5) A[y + x] ^= D; }
      const B = new Array(25);
      for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) B[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(A[x + 5 * y], KROT[x + 5 * y]);
      for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) A[x + 5 * y] = B[x + 5 * y] ^ (~B[((x + 1) % 5) + 5 * y] & M64 & B[((x + 2) % 5) + 5 * y]);
      A[0] ^= KRC[r];
    }
  }
  const out = Buffer.alloc(32); for (let i = 0; i < 4; i++) out.writeBigUInt64LE(A[i], i * 8); return out.toString('hex');
}
const DEPLOYERS = ['0x4e59b44847b379578588920ca78fbf26c0b4956c', '0xba5ed099633d3b313e4d5f7bdc1305d3c28ba5ed', '0x0000000000ffe8b47b3e2130213b802212439497', '0x914d7fec6aac8cd542e72bca78b30650d45643d7'];

// ---------- 聰明錢包：之前賺錢項目（JAGENT/SWARM/BIBIAI/BNBS…）最早去打的 Agent ID 錢包；他們一動手就提早檢查 ----------
const WINNERS = ['0x8e6442663a4f8c50b6132c68d42a30e7dfe4ae15', '0x04fd77c2f97d044b3c719282fd0a0568f4254afa', '0x415aac3e46264c046d103c994a1da71f05c547f9', '0x171f264f938d55d968afc5d6b133c4157a61f05f'];
let SMART = new Set(S.smart || []);
async function buildSmart() {
  const head = parseInt(await rpc('eth_blockNumber', []), 16); const cnt = {};
  for (const a of WINNERS) {
    try {
      const has = async (b) => (((await rpc('eth_getCode', [a, '0x' + b.toString(16)]).catch(() => '0x')) || '0x').length > 2);
      let lo = head - 400000, hi = head; if (await has(lo)) continue;
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (await has(m)) hi = m; else lo = m; }
      const tos = [];
      for (let f = hi; f < Math.min(head, hi + 60000) && tos.length < 300; f += 3000) {
        const logs = await rpc('eth_getLogs', [{ address: a, fromBlock: '0x' + f.toString(16), toBlock: '0x' + (f + 2999).toString(16), topics: [T_TRANSFER, '0x' + '0'.repeat(64)] }]).catch(() => []);
        for (const l of logs || []) { const t = '0x' + l.topics[2].slice(26); if (!tos.includes(t)) tos.push(t); if (tos.length >= 300) break; }
      }
      for (const t of tos) cnt[t] = (cnt[t] || 0) + 1;
    } catch (e) { log('smart ' + a + ' ' + e.message); }
  }
  for (const W of WALLETS) delete cnt[W.addr];
  const list = Object.entries(cnt).filter(([, c]) => c >= 2).map(([t]) => t);
  if (list.length) { SMART = new Set(list); S.smart = list; S.smartAt = Date.now(); log(`聰明錢包名單更新：${list.length} 個`); }
}

// ---------- 保險：同一個合約短時間被很多錢包呼叫（像奶寶龍開打）→ 立刻檢查是不是 Agent ID 專屬 ----------
const HOT = new Map(), hotChecked = new Map(), INSC = new Map();
function countHot(txs) {
  const now = Date.now(); if (!SMART.size && S.smart?.length) SMART = new Set(S.smart);
  for (const t of txs) {
    if (/^0x646174613a/i.test(t.input || '') && t.input.length < 4000 && /^0x(?:[0-9a-f]{2})*$/i.test(t.input) && /^0x[0-9a-f]{40}$/i.test(t.from || '')) {
      const text = Buffer.from(t.input.slice(2), 'hex').toString('utf8');
      const tick = (text.match(/"tick"\s*:\s*"([^"\r\n]{1,40})"/i) || [])[1];
      const protocol = (text.match(/"p"\s*:\s*"([^"\r\n]{1,30})"/i) || [])[1] || '';
      const key = tick ? (protocol + ':' + tick).toLowerCase() : 'to:' + String(t.to || '').toLowerCase();
      let item = INSC.get(key);
      if (!item || now - item.at > 180000) item = { from: new Set(), at: now, sample: text.slice(0, 160) };
      item.from.add(t.from.toLowerCase()); INSC.set(key, item);
      while (INSC.size > 5000) INSC.delete(INSC.keys().next().value);
      continue; // Inscription text never becomes a mint transaction candidate.
    }
    const recv = (t.input || '0x') === '0x' && BigInt(t.value || '0x0') > 0n; // 直接轉 BNB 就鑄（像 BNBS）
    if (!t.to || (t.input || '').length > 2 + 8 + 64 * 4 || BigInt(t.value || '0x0') > 2n * 10n ** 17n) continue; // 鑄造常要付 BNB（QUOGENT 0.0005、灯笼镇 0.0125–0.1），≤0.2 BNB 的呼叫都算
    if (/^0x(a9059cbb|095ea7b3|23b872dd|d0e30db0|2e1a7d4d|39509351|a457c2d7)/.test(t.input || '')) continue; // 轉帳、授權、存取這類不是鑄造 // 只看短呼叫、≤0.001 BNB 的（鑄造的樣子）
    const k = t.to.toLowerCase(); let h = HOT.get(k); if (!h) { h = { from: new Set(), at: now, sel: new Map() }; HOT.set(k, h); }
    if (now - h.at > 180e3) { h.from.clear(); h.at = now; h.sel.clear(); h.smart = new Set(); h.vals = new Map(); }
    if (SMART.has(t.from.toLowerCase())) (h.smart = h.smart || new Set()).add(t.from.toLowerCase());
    h.from.add(t.from.toLowerCase()); const sl = (t.input || '').slice(0, 10); h.sel.set(sl, (h.sel.get(sl) || 0) + 1); if (recv) { h.vals = h.vals || new Map(); const vv = BigInt(t.value).toString(); h.vals.set(vv, (h.vals.get(vv) || 0) + 1); }
  }
  if (HOT.size > 20000) for (const [k, h] of HOT) if (now - h.at > 180e3) HOT.delete(k);
}
async function inscScan() {
  S.inscNoted ||= {};
  for (const [key, item] of INSC) {
    if (Date.now() - item.at > 180000) { INSC.delete(key); continue; }
    if (item.from.size < 12 || S.inscNoted[key]) continue;
    const sample = [...item.from].slice(0, 16); let agents = 0, known = true;
    for (const address of sample) { const balance = decodeAbiUint(await call('0x' + REGISTRY, '0x70a08231' + wa(address))); if (balance === null) { known = false; break; } if (balance > 0n) agents++; }
    if (!known || agents < 8 || agents / sample.length < 0.6) continue;
    S.inscNoted[key] = Date.now();
    while (Object.keys(S.inscNoted).length > 2000) delete S.inscNoted[Object.keys(S.inscNoted)[0]];
    await tg(`🔥 热门 Agent ID 铭文：${noLink(key)}\n3 分钟内 ${item.from.size} 个钱包，其中 ${Math.round(agents / sample.length * 100)}% 持有 Agent ID\n内容样本：${noLink(item.sample)}\n铭文仅通知，请自行核实；工具不会自动铸造`);
  }
}
// ---------- 第三道保險：直接看「鑄造事件」（不管合約怎麼部署、付多少錢）----------
// 每個區塊所有 Transfer(from=0x0) 都看：同一個代幣／NFT 3 分鐘內被鑄給 15 個以上不同錢包 → 找出大家呼叫的合約 → 判斷是不是 Agent ID 專屬 → 照規則打
const MINTS = new Map(), mintChecked = new Map();
const ZERO32 = '0x' + '0'.repeat(64);
async function mintLogs(from, to) {
  // 1) drpc 支援不帶地址的 getLogs（最省流量）
  try { const r = await (await fetch('https://bsc.drpc.org', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getLogs', params: [{ fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16), topics: [T_TRANSFER, ZERO32] }] }), signal: AbortSignal.timeout(10000) })).json(); if (Array.isArray(r.result)) return r.result; } catch {}
  // 2) 退而求其次：抓整個區塊的收據自己過濾
  const out = [], nodes = ['https://bsc-dataseed.bnbchain.org', 'https://bsc-dataseed1.defibit.io', 'https://bsc-dataseed1.ninicoin.io', 'https://bsc-rpc.publicnode.com'];
  await Promise.all(Array.from({ length: to - from + 1 }, (_, i) => from + i).map(async (b, i) => {
    for (let k = 0; k < nodes.length; k++) { try { const r = await (await fetch(nodes[(i + k) % nodes.length], { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBlockReceipts', params: ['0x' + b.toString(16)] }), signal: AbortSignal.timeout(12000) })).json(); if (Array.isArray(r.result)) { for (const rc of r.result) for (const l of rc.logs || []) if (l.topics?.[0] === T_TRANSFER && l.topics[1] === ZERO32 && l.topics[2]) out.push(l); return; } } catch {} }
  }));
  return out;
}
async function fullCode(c, code) { /* 審查修正（FAGENT 漏掉的原因）：代理合約一律追到背後的真正程式——EIP-1967、Beacon 槽位、程式裡寫死的 Beacon／實作地址、最小代理（EIP-1167） */
  code = String(code || '').toLowerCase(); if (code.length < 4 || code.length >= 4000 || code.includes(REGISTRY)) return code;
  const add = async (a) => { const x = ((await rpc('eth_getCode', [a, 'latest']).catch(() => '')) || '').toLowerCase(); code += x; return x; };
  try { const impl = await rpc('eth_getStorageAt', [c, '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc', 'latest']); if (impl && BigInt(impl) !== 0n) await add('0x' + impl.slice(-40)); } catch {}
  try { const bc = await rpc('eth_getStorageAt', [c, '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50', 'latest']); if (bc && BigInt(bc) !== 0n) { const r = await call('0x' + bc.slice(-40), '0x5c60da1b'); if (r && BigInt(r) !== 0n) await add('0x' + r.slice(-40)); } } catch {}
  const emb0 = []; { const h = code.replace(/^0x/, '').slice(0, 1200); const m1167 = h.match(/^363d3d373d3d3d363d73([0-9a-f]{40})5af4/); if (m1167) emb0.push('0x' + m1167[1]); for (let i = 0; i + 42 <= h.length; i += 2) { const op = h.slice(i, i + 2); if (op === '73') { emb0.push('0x' + h.slice(i + 2, i + 42)); i += 40; } else if (op === '7f') { const wv = h.slice(i + 2, i + 66); if (/^0{24}/.test(wv)) emb0.push('0x' + wv.slice(24)); i += 64; } else { const n = parseInt(op, 16); if (n >= 0x60 && n <= 0x7f) i += (n - 0x5f) * 2; } } } /* 除錯 11/1：以前用字串比對會從錯的位置切（最小代理 363d3d37… 裡的「37 3d」被當成 73），抓不到 bibiai 的實作合約 → 誤判沒有退款機制；改成照位元組逐一解析 */
  const emb = [...new Set(emb0)].filter((a) => !/^0x0{40}$/.test(a) && a.length === 42).slice(0, 3);
  for (const a of emb) { if (code.includes(REGISTRY)) break; const r = await call(a, '0x5c60da1b'); if (r && r.length >= 66 && BigInt(r.slice(0, 66)) !== 0n) await add('0x' + r.slice(-40)); else await add(a); }
  return code;
}
async function mintScan(head) {
  if (!S.mintBlock || head - S.mintBlock > 300) S.mintBlock = head - 5;
  const to = Math.min(head, S.mintBlock + 60); if (to <= S.mintBlock) return;
  const logs = await mintLogs(S.mintBlock + 1, to); S.mintBlock = to;
  const now = Date.now();
  for (const l of logs) {
    const a = l.address.toLowerCase(); let m = MINTS.get(a); if (!m) { m = { at: now, to: new Set(), txs: [] }; MINTS.set(a, m); }
    if (now - m.at > 1800e3) { m.at = now; m.to.clear(); m.txs = []; } // 30 分鐘內累計（慢熱的項目也抓得到）
    m.to.add('0x' + l.topics[2].slice(26)); if (m.txs.length < 8) m.txs.push(l.transactionHash);
  }
  if (MINTS.size > 30000) for (const [k, m] of MINTS) if (now - m.at > 1800e3) MINTS.delete(k);
  for (const [a, m] of MINTS) {
    if (m.to.size < 6 || (mintChecked.has(a) && m.to.size < mintChecked.get(a) * 2) || S.seenMints[a]) continue; // 沒過的，等人數翻倍再看一次 // 6 個不同錢包被鑄到就檢查（QUOGENT 開打頭 15 分鐘只有十幾個錢包）
    mintChecked.set(a, m.to.size); if (mintChecked.size > 20000) mintChecked.delete(mintChecked.keys().next().value);
    await checkMinted(a, m).catch((e) => log('mintScan ' + a + ' ' + e.message));
  }
}
const CLAIM = new Set();
async function checkMinted(tok, m) {
  // 找出大家實際呼叫的合約（鑄造合約可能跟代幣合約不同）
  const txs = (await Promise.all(m.txs.slice(0, 6).map((h) => rpc('eth_getTransactionByHash', [h]).catch(() => null)))).filter(Boolean);
  const cnt = {}; for (const t of txs) if (t.to) cnt[t.to.toLowerCase()] = (cnt[t.to.toLowerCase()] || 0) + 1;
  const target = Object.entries(cnt).sort((x, y) => y[1] - x[1])[0]?.[0]; if (!target) return;
  if (S.seenMints[target] || S.seenMints[tok] || CLAIM.has(target)) return; CLAIM.add(target); // 審查修正：同一個合約只讓一個流程處理，避免重複打
  // 是不是 Agent ID 專屬：合約碼有登記合約，或鑄到的錢包六成以上有 .ai 身份
  let code = ((await rpc('eth_getCode', [target, 'latest']).catch(() => '')) || '').toLowerCase();
  code = await fullCode(target, code);
  const tcode = tok === target ? code : ((await rpc('eth_getCode', [tok, 'latest']).catch(() => '')) || '').toLowerCase();
  let gated = code.includes(REGISTRY) || tcode.includes(REGISTRY), share = 0;
  if (!gated) {
    // 沒寫 Agent ID 檢查的：只看兩天內新部署的合約（排除 LP、老代幣這類每天都在鑄的）
    const head = parseInt(await rpc('eth_blockNumber', []), 16);
    const old = (await rpc('eth_getCode', [tok, '0x' + (head - 400000).toString(16)]).catch(() => '0x')) || '0x';
    if (old.length > 2) return;
    const sample = [...m.to].slice(0, 12); let n = 0;
    for (const x of sample) { const r = await call('0x' + REGISTRY, '0x70a08231' + wa(x)); if (r && BigInt(r.slice(0, 66)) > 0n) n++; }
    share = n / sample.length; if (n < 4 || share < 0.6) return;
    gated = true;
  }
  if (INFRA.has(target) || INFRA.has(tok)) return; // Agent ID 登記合約本身不是項目
  S.seenMints[target] = ts(); S.seenMints[tok] = ts();
  const name = tokStr(await call(tok, '0x06fdde03')) || tokStr(await call(target, '0x06fdde03'));
  // 先試常見免費函式；不行就「照別人的呼叫內容重播」（不含別人地址的才重播）
  let minted = '';
  const sampleTx = txs.find((t) => t.to && t.to.toLowerCase() === target);
  for (const W of WALLETS) {
    let ff = await findFree(W.addr, target, code);
    if (!ff && sampleTx && sampleTx.input.length >= 10 && !badSel(sampleTx.input) && !sampleTx.input.toLowerCase().includes(sampleTx.from.slice(2).toLowerCase())) {
      for (const v of NEAR_FREE) { try { await rpc('eth_call', [{ from: W.addr, to: target, data: sampleTx.input, value: '0x' + v.toString(16) }, 'latest']); const nm = '重播' + sampleTx.input.slice(0, 10) + '@' + target.slice(2, 10); if (!CANDS.some((c) => c[0] === nm)) CANDS.push([nm, sampleTx.input]); ff = { n: nm, v }; break; } catch {} }
    }
    if (ff) minted += `[${W.name}] ` + queueMint(target, ff.n, W, ff.v) + '\n';
  }
  if (!minted) {
    S.paid = S.paid || {};
    const val = sampleTx ? BigInt(sampleTx.value || '0x0') : 0n;
    const noAddr = sampleTx && !sampleTx.input.toLowerCase().includes(sampleTx.from.slice(2).toLowerCase());
    S.paid[target] = { at: Date.now(), name, done: {}, wallets: m.to.size, ...((sampleTx?.input || '0x') === '0x' && val > 0n ? { recvValue: val.toString(), recvSeen: m.to.size } : {}), ...(noAddr && sampleTx.input !== '0x' && !badSel(sampleTx.input) ? { replay: { data: sampleTx.input, value: val.toString() } } : {}) };
  }
  await tg(`🔥 發現正在被鑄造的 Agent ID 項目${name ? '：' + name : ''}（3 分鐘內鑄給 ${m.to.size} 個錢包${share ? `，${Math.round(share * 100)}% 有 .ai 身份` : ''}）\n${target}\n${MONITOR_ONLY ? MONITOR_NOTE : minted || '⚪ 不是免費的 → 已加入追蹤：進度達到配置門檻（或讀不到進度但很多人在打）且每個錢包 ≤20U 會自動打'}`);
}

async function hotScan() {
  for (const [c, h] of HOT) {
    if (INFRA.has(c) || CLAIM.has(c)) continue;
    if ((h.from.size < 12 && (h.smart?.size || 0) < 2) || S.seenMints[c] || hotChecked.has(c)) continue;
    CLAIM.add(c); hotChecked.set(c, Date.now()); if (hotChecked.size > 5000) hotChecked.delete(hotChecked.keys().next().value);
    let code = ((await rpc('eth_getCode', [c, 'latest']).catch(() => '')) || '').toLowerCase();
    code = await fullCode(c, code);
    let viaAgents = 0;
    if (!code.includes(REGISTRY)) {
      // 合約碼裡沒有 Agent ID 登記合約（可能用後端簽名驗證，像灯笼镇、Silicon Dreamers）→ 改看「打它的人是不是大多持有 Agent ID」
      if (code.length < 4) continue;
      const head = parseInt(await rpc('eth_blockNumber', []), 16);
      const old = (await rpc('eth_getCode', [c, '0x' + (head - 400000).toString(16)]).catch(() => '0x')) || '0x';
      if (old.length > 2) continue; // 兩天前就存在的老合約不算新項目
      const sample = [...h.from].slice(0, 16); let n = 0;
      for (const a of sample) { const r = await call('0x' + REGISTRY, '0x70a08231' + wa(a)); if (r && BigInt(r.slice(0, 66)) > 0n) n++; }
      if (n < 8 || n / sample.length < 0.6) continue;
      viaAgents = n / sample.length;
    }
    S.seenMints[c] = ts();
    const name = tokStr(await call(c, '0x06fdde03'));
    // 熱門呼叫的函式也加入候選（不在 CANDS 裡的鑄造函式名）
    const topSel = [...h.sel.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    let minted = '';
    for (const W of WALLETS) {
      let ff = await findFree(W.addr, c, code);
      if (!ff && topSel && topSel.length === 10 && !badSel(topSel)) for (const v of NEAR_FREE) { try { await rpc('eth_call', [{ from: W.addr, to: c, data: topSel, value: '0x' + v.toString(16) }, 'latest']); { const nm = '熱門函式' + topSel + '@' + c.slice(2, 10); if (!CANDS.some((x) => x[0] === nm)) CANDS.push([nm, topSel]); ff = { n: nm, v }; } break; } catch {} }
      if (ff) minted += `[${W.name}] ` + queueMint(c, ff.n, W, ff.v) + '\n';
    }
    if (!minted) {
      S.paid = S.paid || {};
      // 轉 BNB 就鑄的：取大家最常轉的金額當「一份的價格」（至少 10 筆一樣才算數）
      const top = [...(h.vals || new Map()).entries()].sort((a, b) => b[1] - a[1])[0];
      S.paid[c] = { at: Date.now(), name, done: {}, wallets: h.from.size, ...(top && top[1] >= 2 ? { recvValue: top[0], recvSeen: top[1] } : {}) };
    }
    await tg(`🔥 發現正在被搶打的 Agent ID 項目${name ? '：' + name : ''}${viaAgents ? `（合約沒寫 Agent ID 檢查，但打它的錢包 ${Math.round(viaAgents * 100)}% 持有 .ai 身份，可能是後端簽名驗證）` : ''}（3 分鐘內 ${h.from.size} 個錢包${h.smart?.size ? '，其中聰明錢包 ' + h.smart.size + ' 個' : ''}）\n${c}\n${MONITOR_ONLY ? MONITOR_NOTE : minted || '⚪ 不是免費的 → 已加入追蹤：進度達到配置門檻（或讀不到進度但很多人在打）且每個錢包 ≤20U 會自動打'}\nhttps://bscscan.com/address/${c}`);
  }
}

const BG = []; let bgRun = 0; // 背景工作佇列（最多同時 3 個）
function bgJob(fn) { BG.push(fn); pumpBG(); }
function pumpBG() { while (bgRun < 3 && BG.length) { const f = BG.shift(); bgRun++; f().catch((e) => log('bg ' + e.message)).finally(() => { bgRun--; pumpBG(); }); } }
async function scanNew(head) {
  if (!S.lastBlock) S.lastBlock = head - 5;
  if (head - S.lastBlock > 1500) { log(`掃描落後太多（${head - S.lastBlock} 塊），跳到最新`); S.lastBlock = head - 200; }
  // BSC 現在約 0.45 秒一個區塊（每分鐘 ~130 塊），以前一次只掃 40 塊會越落越後（曾落後 2.5 小時）→ 改成多節點並行抓
  const to = Math.min(head, S.lastBlock + 400);
  const nums = []; for (let b = S.lastBlock + 1; b <= to; b++) nums.push(b);
  const blocks = new Map(); let idx = 0;
  const fetchBlk = async (b) => { for (let k = 0; k < RPCS.length; k++) { const u = RPCS[(b + k) % RPCS.length]; try { const r = await (await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBlockByNumber', params: ['0x' + b.toString(16), true] }), signal: AbortSignal.timeout(15000) })).json(); if (r.result) return r.result; } catch {} } return null; };
  await Promise.all(Array.from({ length: 24 }, async () => { while (idx < nums.length) { const b = nums[idx++]; const blk = await fetchBlk(b); if (blk) { countHot(blk.transactions); } if (blk) blocks.set(b, blk.transactions.filter((t) => !t.to || ((t.input || '').length > 2000 && ((t.input || '').toLowerCase().includes(REGISTRY) || DEPLOYERS.includes(t.to.toLowerCase()))))); else blocks.set(b, null); } }));
  let done = S.lastBlock;
  for (const b of nums) { if (blocks.get(b) == null) break; done = b; }
  if (done === S.lastBlock && nums.length) { log('scan 抓區塊失敗 ' + nums[0]); return; }
  S.scanBatchLag = head - done;
  for (let b = S.lastBlock + 1; b <= done; b++) {
    for (const tx of blocks.get(b) || []) {
      // 新合約有三種出生方式：①直接部署 ②透過 CREATE2 部署器（灯笼镇就是這種）③由別的工廠合約建立
      const inp = (tx.input || '').toLowerCase();
      if (tx.to && !(inp.length > 2000 && (inp.includes(REGISTRY) || DEPLOYERS.includes(tx.to.toLowerCase())))) continue;
      let cs = [];
      try {
        if (!tx.to) { const rc = await rpc('eth_getTransactionReceipt', [tx.hash]); if (rc?.contractAddress) cs = [rc.contractAddress.toLowerCase()]; }
        else if (tx.to.toLowerCase() === '0x4e59b44847b379578588920ca78fbf26c0b4956c') { const salt = inp.slice(2, 66), init = inp.slice(66); cs = ['0x' + keccakHex('ff' + tx.to.slice(2).toLowerCase() + salt + keccakHex(init)).slice(24)]; }
        else { const rc = await rpc('eth_getTransactionReceipt', [tx.hash]); if (rc?.status !== '0x1') continue; const as = [...new Set((rc.logs || []).map((l) => l.address.toLowerCase()))]; for (const a of as) { const before = await rpc('eth_getCode', [a, '0x' + (b - 1).toString(16)]).catch(() => '0x'); if (!before || before === '0x') cs.push(a); } }
      } catch { continue; }
      for (const c of cs) try {
        if (S.seenMints[c]) continue;
        let code = (await rpc('eth_getCode', [c, 'latest'])) || '';
        code = await fullCode(c, code); /* 代理合約（各種寫法）都追到背後真正的程式 */
        if (!code.toLowerCase().includes(REGISTRY) && !code.includes('9f92d0dd')) continue;
        S.seenMints[c] = ts(); noteDeploy(code); S.deployer = S.deployer || {}; S.deployer[c] = (tx.from || '').toLowerCase(); S.depFrom = S.depFrom || {}; S.depFrom[c] = S.deployer[c]; noteDev(S.deployer[c], c);
        log(`🆕 发现新的 Agent ID 专属合约 ${c}${MONITOR_ONLY ? ' · ' + MONITOR_NOTE : ''}`);
        bgJob(async () => {
        const ok = [];
        { const ff = await findFree(ME, c, code); if (ff) ok.push(ff.n + (ff.v > 0n ? `（付 ${Number(ff.v) / 1e18} BNB 手續費）` : '')); }
        const str = (r) => { try { const h = r.slice(2); const len = Number(BigInt('0x' + h.slice(64, 128))); return noLink(Buffer.from(h.slice(128, 128 + len * 2), 'hex').toString('utf8')); } catch { return ''; } };
        let name = str(await call(c, '0x06fdde03'));
        if (!name) for (const sel of ['0xfc0c546a']) { const r = await call(c, sel); if (r && r.length >= 66 && BigInt(r.slice(0, 66)) > 0n) { const ta = '0x' + r.slice(26, 66); const n2 = str(await call(ta, '0x06fdde03')), s2 = str(await call(ta, '0x95d89b41')); if (n2) { name = `${n2}${s2 ? ' ($' + s2 + ')' : ''}`; break; } } }
        const lc = code.toLowerCase();
        const pay = lc.includes('55d398326f99059ff775485246999027b3197955') ? '要付 USDT' : lc.includes('8ac76a51cc950d9822d68b83fe1ad97b32cd580d') ? '要付 USDC' : '可能要付 BNB';
        const factoryLike = ['27cca59f', '7d38bb0d', '1737a4bd'].some((x) => code.includes(x)) || /(6c61756e6368|666163746f7279)/.test(code.toLowerCase());
        if (factoryLike) await tg(`🏗 發現疑似新的 Agent ID 發射台／工廠合約${name ? '：' + name : ''}\n${c}\n可能是像 ToshX、Flap Agent 這種平台，可以自己到 BscScan 查看`);
        let minted = '';
        for (const W of WALLETS) { const ff = await findFree(W.addr, c, code); const f = ff?.n; if (f) minted += `[${W.name}] ` + queueMint(c, f, W, ff.v) + '\n'; }
        if (!ok.length) { S.paid = S.paid || {}; S.paid[c] = { at: Date.now(), name, done: {} }; }
        await tg(`🆕 發現新的 Agent ID 專屬合約${name ? '：' + name : ''}\n${c}\n${MONITOR_ONLY ? MONITOR_NOTE : ok.length ? '✅ 模擬免費可鑄：' + ok.join('、') + '\n' + minted : `⚪ 現在不是免費的（${pay}，或還沒開）→ 已加入追蹤：\n· 開放後若免費或手續費 ≤0.001 BNB → 自動打\n· 付費 → 進度達到配置門檻（或讀不到進度但很多人在打）且每個錢包 ≤20U → 自動打`}\nhttps://bscscan.com/address/${c}`);
        }); // 背景處理新合約（模擬、鑄造、通知），掃描不用等
      } catch {}
    }
  }

  if (!globalThis._hsBusy) { globalThis._hsBusy = true; hotScan().catch((e) => log('hotScan ' + e.message)).finally(() => { globalThis._hsBusy = false; }); }
  if (!globalThis._msBusy) { globalThis._msBusy = true; mintScan(done).catch((e) => log('mintScan ' + e.message)).finally(() => { globalThis._msBusy = false; }); }
  { /* 代理合約掃描：被限流就換節點；全部被限流先暫停 30 秒，之後從沒掃到的區塊補掃，不跳過 */
    S.proxyFrom = S.proxyFrom || S.lastBlock + 1; if (done - S.proxyFrom > 3000) S.proxyFrom = done - 3000;
    if (Date.now() > (globalThis._proxyPause || 0)) { const to = Math.min(done, S.proxyFrom + 500); try { await proxyScan(S.proxyFrom, to); S.proxyFrom = to + 1; globalThis._proxyFails = 0; } catch (e) { globalThis._proxyFails = (globalThis._proxyFails || 0) + 1; globalThis._proxyPause = Date.now() + 30e3; if (globalThis._proxyFails === 1 || globalThis._proxyFails % 20 === 0) log(`proxyScan 所有節點都被限流（第 ${globalThis._proxyFails} 次），暫停 30 秒後補掃：${e.message.slice(0, 80)}`); } }
  }
  S.lastBlock = done;
}

// ---------- 工厂合约建出来的代理合约（像 AIDROP 金库）：用「代理升级」事件抓 ----------
const T_BEACON_UP = '0x1cf3b03a6cf19fa2baba4df148e9dcabedea7f8a5c07840e207e5c089be95d3e'; // BeaconUpgraded(address)
const T_UPGRADED = '0xbc7cd75a20ee27fd9adebab32041f755214dbc6bffa90cc0225b39da2e5c2d3b';  // Upgraded(address)
const implCache = new Map();
const VAULT_FACTORIES = ['0x90497450f2a706f1951b5bdda52b4e5d16f34c06']; // Flap 金庫工廠（AIDROP 就是它建的）
const LOG_NODES = ['https://bsc-rpc.publicnode.com', 'https://bsc.blockpi.network/v1/rpc/public', 'https://bsc.drpc.org', 'https://1rpc.io/bnb', 'https://binance.llamarpc.com', 'https://bsc.publicnode.com'];
let logNi = 0; const logBad = new Map();
async function logsRpc(params) { /* 查事件用的多節點輪替：某個節點被限流就冷卻 2 分鐘換下一個 */
  let last; for (let i = 0; i < LOG_NODES.length; i++) { const u = LOG_NODES[(logNi + i) % LOG_NODES.length]; if ((logBad.get(u) || 0) > Date.now()) continue;
    try { const r = await (await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getLogs', params }), signal: AbortSignal.timeout(12000) })).json(); if (r.error) throw new Error(r.error.message); if (!Array.isArray(r.result)) throw new Error('bad result'); logNi = (logNi + i) % LOG_NODES.length; return r.result; }
    catch (e) { last = e; logBad.set(u, Date.now() + 120e3); } }
  throw last || new Error('所有節點冷卻中');
}
async function proxyScan(from, to) {
  if (to < from) return;
  // 公用節點不允許不帶地址的 getLogs，所以盯 Flap 金庫工廠：它每建一個新金庫就有事件，再從那筆交易收據找新代理合約
  const fl = await logsRpc([{ address: VAULT_FACTORIES, fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16) }]);
  const txs = [...new Set((fl || []).map((l) => l.transactionHash))];
  const logs = [];
  for (const h of txs) { const rc = await rpc('eth_getTransactionReceipt', [h]).catch(() => null); for (const l of rc?.logs || []) if (l.topics[0] === T_BEACON_UP || l.topics[0] === T_UPGRADED) logs.push(l); }
  for (const l of logs) {
    const c = l.address.toLowerCase(); if (S.seenMints[c]) continue;
    let impl = '0x' + l.topics[1].slice(26);
    if (l.topics[0] === T_BEACON_UP) { const r = await call(impl, '0x5c60da1b'); if (!r) continue; impl = '0x' + r.slice(-40); }
    if (!implCache.has(impl)) { const code = (await rpc('eth_getCode', [impl, 'latest']).catch(() => '')) || ''; implCache.set(impl, code); if (implCache.size > 500) implCache.delete(implCache.keys().next().value); }
    const code = implCache.get(impl);
    if (!code.toLowerCase().includes(REGISTRY) && !code.includes('9f92d0dd')) continue;
    S.seenMints[c] = ts();
    let minted = '';
    for (const W of WALLETS) { const ff = await findFree(W.addr, c, code); const f = ff?.n; if (f) minted += `[${W.name}] ` + queueMint(c, f, W, ff.v) + '\n'; }
    await tg(`🧩 發現工廠建立的 Agent ID 合約（代理合約，像 AIDROP 那種）\n${c}\n${MONITOR_ONLY ? MONITOR_NOTE : minted || '⚪ 目前模擬不能免費參加（可能要付費或還沒開）'}`);
  }
}

// ---------- 自動鑄造（使用者要求開啟）：只鑄 0 元、無授權、不扣使用者任何資產的 ----------
// 「幾乎免費」：有些項目要付一點防女巫手續費（像奶寶龍 0.00022 BNB），最多接受 0.001 BNB
const NEAR_FREE = [0n, 10n ** 14n, 22n * 10n ** 13n, 3n * 10n ** 14n, 5n * 10n ** 14n, 10n ** 15n];
async function findFree(from, c, code) {
  if (!from) return null;
  const W0 = WALLETS.find(x => x.addr === from);
  if (MONITOR_ONLY || !canWallet(W0, 'mint')) return null;
  for (const [n, d] of CANDS) { if (n.includes('@') && !n.endsWith('@' + c.slice(2, 10))) continue; if (n.includes('#') && !n.includes('#' + (WALLETS.find((x) => x.addr === from)?.id || '?') + '@')) continue; if (d.length < 10 || badSel(d) || !code.includes(d.slice(2, 10))) continue; /* 空呼叫（直接轉 0 BNB）不算鑄造 */ const dd = /重播|熱門函式/.test(n) ? freshDeadline(d) : d; for (const v of NEAR_FREE) { try { await rpc('eth_call', [{ from, to: c, data: dd, value: '0x' + v.toString(16) }, 'latest']); return { n, v }; } catch {} } }
  // Agent ID arguments are used only after the actual identity has been bound.
  if (W0?.agentId) for (const sel of ['a0712d68', '379607f5', '6a627842']) { if (!code.includes(sel)) continue; const d = '0x' + sel + W0.agentId, n = `帶Agent編號${sel}#${W0.id}@${c.slice(2, 10)}`; for (const v of NEAR_FREE) { try { await rpc('eth_call', [{ from, to: c, data: d, value: '0x' + v.toString(16) }, 'latest']); if (!CANDS.some((x) => x[0] === n)) CANDS.push([n, d]); return { n, v }; } catch {} } }
  return null;
}
// 鑄造排隊：每個錢包一條隊伍在背景跑（交易要一筆一筆送），不卡住掃描
const MQ = new Map();

const BAD_SEL = new Set(['0xa9059cbb', '0x095ea7b3', '0x23b872dd', '0x42842e0e', '0xb88d4fde', '0xa22cb465', '0x39509351', '0xd505accf', '0xf242432a', '0x2eb2c2d6']);
const badSel = (d) => BAD_SEL.has(String(d || '').slice(0, 10).toLowerCase());
const freeNoted = new Map(); // 免費 mint 通知：同一個項目等兩個錢包都打完，合成一則
function noteFree(c, W, name = '') { const first = !freeNoted.has(c); if (first) freeNoted.set(c, new Set()); freeNoted.get(c).add(W.id); if (first) setTimeout(async () => { const ok = freeNoted.get(c) || new Set(); freeNoted.delete(c); const nm = name || tokStr(await call(c, '0x06fdde03')) || c.slice(0, 10); await tg(`🆓 打了免費項目：${nm}（${WALLETS.map((x) => x.name + (ok.has(x.id) ? ' ✅' : ' ❌')).join('、')}）\n${c}`).catch(() => {}); }, 150e3); }
const MQK = new Set(); /* 審查修正：同一個合約＋錢包同時只排一個鑄造工作，避免重複打 */
function queueMint(c, fname, W, v) {
  if (MONITOR_ONLY || v > 0n && !canWallet(W, 'mint')) return MONITOR_NOTE;
  const qk = c + '|' + W.id; if (MQK.has(qk)) return '⏳ 已在排隊中'; if (S.paid?.[c]?.done?.[W.id] && S.paid[c].done[W.id] !== 'pool-open') return '✅ 這個錢包已經打過';
  MQK.add(qk);
  const prev = MQ.get(W.id) || Promise.resolve();
  const job = prev.then(() => autoMintMax(c, fname, W, v)).finally(() => MQK.delete(qk)).then(async (m) => { if (m.startsWith('🤖') || m.includes('結果不明')) { S.paid = S.paid || {}; if (!S.paid[c]) S.paid[c] = { at: Date.now(), name: '', done: {} }; S.paid[c].done[W.id] = m.startsWith('🤖') ? 'free' : 'unknown'; save(true); } else if (!m.startsWith('⏸') && !m.startsWith('✅')) { S.paid = S.paid || {}; if (!S.paid[c]) S.paid[c] = { at: Date.now(), name: '', done: {}, waitHot: 1 }; } /* 審查 11/1：第一次就失敗（預演失敗、BNB 不夠…）的以前不會再追蹤 */ logWallet(W, `${c} ${m.replace(/\n/g, ' | ')}`); if (m.startsWith('🤖')) { S.freeTrack = S.freeTrack || {}; S.freeTrack[c] = S.freeTrack[c] || { at: Date.now() }; } if (m.startsWith('🤖')) noteFree(c, W); }).catch((e) => logWallet(W, `鑄造失敗 ${c} ${e.message}`));
  MQ.set(W.id, job);
  return '⏳ 已排入规则检查（完全免费只通知）';
}

// 每個錢包可以打多份的（每錢包上限 >1），模擬還能過就繼續打，最多 MAX_REPEAT 次
const MAX_REPEAT = 10;
async function autoMintMax(c, fname, W, val = 0n) {
  if (MONITOR_ONLY || val > 0n && !canWallet(W, 'mint')) return MONITOR_NOTE;
  const d = Object.fromEntries(CANDS)[fname]; let first = await autoMint(c, fname, W, val), n = first.startsWith('🤖') ? 1 : 0;
  while (n > 0 && n < MAX_REPEAT) {
    await sleep(6000);
    // 第一份免費、之後要付一點的（像 QUOGENT）：每次重新找能過的金額（≤0.001 BNB）
    // 防釣魚：只有「完全免費」才連續打；要付手續費的每個項目每個錢包只打 1 份（避免被故意發盤賺手續費）
    let v2 = null; try { await rpc('eth_call', [{ from: W.addr, to: c, data: d, value: '0x0' }, 'latest']); v2 = 0n; } catch {}
    if (v2 == null) break;
    const m = await autoMint(c, fname, W, v2); if (!m.startsWith('🤖')) break; n++;
  }
  return n > 1 ? first + `\n（同一個錢包共打了 ${n} 份）` : first;
}
const fpCache = new Map();
async function freeProgress(c) { /* 免費項目的進度：已鑄造／總量；讀不到回傳 null（30 秒快取） */
  const k = fpCache.get(c); if (k && Date.now() - k.t < 30e3) return k.p;
  let p = null; const decR = await call(c, '0x313ce567'); const isErc20 = !!(decR && decR.length >= 66 && BigInt(decR.slice(0, 66)) > 0n && BigInt(decR.slice(0, 66)) <= 36n); /* ERC20 常常一開始就全部發行，用「已發行÷總量」會誤判成 100% */
  const mintedR = isErc20 ? null : await call(c, '0xa2309ff8');
  const tsR = isErc20 ? null : mintedR && mintedR.length >= 66 ? mintedR : await call(c, '0x18160ddd');
  if (tsR && tsR.length >= 66) { const sup = Number(BigInt(tsR.slice(0, 66))); for (const sel of ['0xd5abeb01', '0x32cb6b0c', '0x355274ea', '0xe985e367', '0xf1aee5a2', '0x0f2cdd6c', '0xa035b1fe', '0xa0e23ebd']) { const r = await call(c, sel); if (r && r.length >= 66) { const x = Number(BigInt(r.slice(0, 66))); if (x > 0 && x >= sup && x < 1e15) { p = sup / x; break; } } } }
  if (p == null) { const code = (await rpc('eth_getCode', [c, 'latest']).catch(() => '')) || ''; const pr = await progressOf(c, code.toLowerCase(), '').catch(() => ({})); if (typeof pr.progress === 'number' && Number.isFinite(pr.progress) && pr.progress >= 0) p = pr.progress; }
  fpCache.set(c, { t: Date.now(), p }); return p;
}
async function progressSweep() { /* 使用者 10/31 23:21 查 Pulsepanther 沒打到：追蹤名單 500 多個，一般檢查每輪只看 16 個、一個要 10~30 秒，低進度的項目要 2~3 小時才回頭看一次，10% 直接漲到 100% 都沒發現。改成每分鐘用輕量方式只讀進度（最多 80 個、6 個同時），進度過 45% 就會進快速名單，每 15 秒檢查 */
  const now = Date.now(); const list = Object.entries(S.paid || {}).filter(([c, P]) => !P.unmintable && (P.progress || 0) < 0.999 && now - (P.at || 0) < 86400e3 && !WALLETS.every((W) => P.done?.[W.id])).sort((x, y) => (y[1].groupSignalAt && !y[1].sweepAt ? 1 : 0) - (x[1].groupSignalAt && !x[1].sweepAt ? 1 : 0) || (x[1].sweepAt || 0) - (y[1].sweepAt || 0) || (y[1].at || 0) - (x[1].at || 0)).slice(0, 80);
  let i = 0; await Promise.all(Array.from({ length: 6 }, async () => { while (i < list.length) { const [c, P] = list[i++]; try { if (P.progAt && Date.now() - P.progAt < 180e3) { P.sweepAt = Date.now(); continue; } /* 除錯：正式檢查 3 分鐘內剛讀過的不覆蓋（避免讀法不同把已賣完的又拉回快速名單、佔名額） */ let fp = null; if (P.soldSel) { /* 除錯 11/1：bibiai AGENT ID 用「已售／總量」才讀得到（已售 a2309ff8、總量 a0e23ebd），一般免費讀法讀不到 → 卡在 0% 兩小時沒回頭看，漲到 92% 都不知道 */ const sr = await call(c, P.soldSel); const sold = sr && sr.length >= 66 ? Number(BigInt(sr.slice(0, 66))) : null; if (sold > 0) { if (P.capSel === undefined) P.capSel = (await findCapSel(c, await fullCode(c, await codeOf(c)).catch(() => ''), sold).catch(() => '')) || ''; if (P.capSel) { const cr = await call(c, '0x' + P.capSel); const cap = cr && cr.length >= 66 ? Number(BigInt(cr.slice(0, 66))) : 0; if (cap >= sold && cap > 0) fp = sold / cap; } } }
      if (fp == null) fp = await freeProgress(c); P.sweepAt = Date.now(); if (fp != null && fp > 0) { if (fp >= 0.45 && (P.progress || 0) < 0.45 && !P.swLog) { P.swLog = 1; log(`進度掃描：${P.name || c} 進度 ${Math.round(fp * 100)}%，移到快速檢查`); } P.progress = Math.min(fp, 0.99); /* 審查 11/1：免費合約正式檢查不會讀進度，賣完的會永遠卡 99% 佔快速名單 → 直接記 100% */ /* 100% 交給快速檢查用正式讀法確認，避免讀錯就永遠不看 */ } } catch {} } }));
}
async function autoMint(c, fname, W = WALLETS[0], val = 0n) {
  if (MONITOR_ONLY || !W) return MONITOR_NOTE;
  if (val === 0n) {
    const progress = await freeProgress(c), P = S.paid?.[c];
    const paidPhase = await othersPay(c);
    if (paidPhase === null) return '⏸ 付费阶段暂时无法核验，等待重新检查';
    if (paidPhase) { queuePaidPhase(c); return '💱 首份免费、后续付费，已转入付费策略检查'; }
    if (progress == null && await poolOpen(c)) return '⏸ 读不到进度且已开池，不自动铸造';
    return notifyFreeMint(c, progress, P?.agents || 0, W);
  }
  if (MONITOR_ONLY || !canWallet(W, 'mint')) return MONITOR_NOTE;
  try { return await withMintWalletLock(W, () => autoMintInner(c, fname, W, val)); }
  catch (error) { if (String(error.message).includes('結果不明')) return '⚠️ ' + error.message; throw error; }
}
async function autoMintInner(c, fname, W, val) {
  if (MONITOR_ONLY || !canWallet(W, 'mint')) return MONITOR_NOTE;
  const PAID = paidFor(W);
  /* 使用者 10/31 19:21：新規則——不管免費還是付費，進度超過 50% 就打，之前的規矩（重複 DEV、黑名單、熱度、手續費上限…）全部不看；只保留貔貅類安全檢查（每筆都模擬、不能授權、不能扣到預期外的資產、Flap 禁止）。讀不到進度的才用熱度判斷 */
  { const sd = await serialDev(c); if (sd) { if (S.paid?.[c]) { S.paid[c].serialLog = 1; S.paid[c].lastReason = sd + '，照規則不打'; } return `⛔ ${sd}，照規則不打`; } }
  const fp = await freeProgress(c);
  const agentsN = S.paid?.[c]?.agents || 0;
  const projectInfo = await MINT_RISK.contractInfo(c);
  const policy = entryFor(W, projectInfo.nft), entry = entryGate({ progress: fp, agents: agentsN, configuredPct: PAID.goPct, policy, nft: projectInfo.nft });
  if (!entry.allowed) return '⏸ ' + entry.reason;
  if (fp == null && await poolOpen(c)) return '⏸ 读不到进度且已开池，不自动铸造';
  const feeBnb = Number(val) / 1e18, feePrice = val > 0n ? await bnbUsd().catch(() => 0) : 0;
  const feeAllowed = (balance) => val === 0n || withinPaidBudget(PAID, { spentBnb: resetPaidBudgetDay()[W.id] || 0, costBnb: feeBnb, costUsd: feeBnb * feePrice, balanceBnb: balance });
  let d = Object.fromEntries(CANDS)[fname]; if (d && /重播|熱門函式/.test(fname)) d = freshDeadline(d); /* 照抄的免費鑄造也換新期限 */
  const today = new Date().toDateString(); if (S.mintDay !== today) { S.mintDay = today; S.mintCount = 0; }
  S.mintCnt = S.mintCnt && S.mintCnt.d === today ? S.mintCnt : { d: today }; if ((S.mintCnt[W.id] || 0) >= 1000) return '⏸ 這個錢包今天自動鑄已達 1000 筆上限，沒有鑄';
  const bnb = BigInt((await rpc('eth_getBalance', [W.addr, 'latest']).catch(() => '0x0')) || '0x0');
  if (bnb < 5n * 10n ** 14n) return '⚠️ BNB 不夠付 gas（< 0.0005），沒有鑄';
  if (projectInfo.nft && feeBnb * feePrice > 10) return '⏸ NFT 单项目支出超过 10 USD';
  if (val > 0n && (!(feePrice > 0) || !feeAllowed(Number(bnb) / 1e18))) return '⏸ 超过单笔/每日付费预算，或 BNB 保留金额不足，没有铸';
  const p = await W.baw(['contract-call', 'preview', '--binanceChainId', '56', '--from', W.addr, '--to', c, '--value', val.toString(), '--inputData', d]);
  const sim = p.j?.data?.simulationResult, rid = p.j?.data?.requestId;
  if (!p.j?.success || !rid) return '❌ 預演失敗，沒有鑄：' + (p.j?.error?.message || '').slice(0, 120);
  { const fg = flapGuard(c, d, sim); if (fg) return '⛔ ' + fg + '，沒有鑄'; }
  const simulationProblem = mintSimulationCheck(sim, W, { bnbWei: val });
  if (simulationProblem) return '⚠️ 预演不安全：' + simulationProblem + '，没有铸';
  if (!hasPositiveMintGain(sim, W)) return '⚪ 预演显示拿不到东西（可能铸给别人或净额为 0），没有铸';
  const riskQuote = await MINT_RISK.quoteTransaction(W, { to: c, data: d, valueWei: val, keepBnb: PAID.keepBnb, paid: true, feeLike: true, project: true, paymentUsd: feeBnb * feePrice, quantity: mintQuantity(d, sim, W), nftEvidence: simulationNftGain(sim, W) });
  riskQuote.paymentUsdMicros = usdBudgetMicros(feeBnb * feePrice);
  riskQuote.mintTracking = mintTrackingPlan(W, sim, feeBnb * feePrice, riskQuote.mintToken);
  if (val > 0n) {
    const balance = Number(BigInt(await rpc('eth_getBalance', [W.addr, 'latest']))) / 1e18;
    if (!feeAllowed(balance)) return '⏸ 超过单笔/每日付费预算，没有铸';
    // The shared ledger reserves before sending, including interrupted results.
  }
  INFLIGHT++; let x; try { x = await runPaidCommand(W, ['contract-call', 'execute', '--requestId', rid], val, { from: W.addr, to: c, value: val.toString(), inputData: d }, riskQuote); } finally { INFLIGHT--; }
  if (mintExecutionUnknown(x)) return '⚠️ 送出結果不明（逾時或响应中断），先不重打';
  if (!x.j?.success) return '❌ 送出失敗：' + (x.j?.error?.message || x.t).slice(0, 120);
  S.mintCount++; S.mintCnt[W.id] = (S.mintCnt[W.id] || 0) + 1;
  // 免費鑄造拿到的代幣也加入持倉追蹤（成本 0 → 只通知 5／10 倍、回調，不自動賣）
  trackFromSim(W, sim, '', feeBnb * feePrice, x.j?.data?.txHash);
  for (const b of sim?.balanceChanges || []) if (String(b.owner).toLowerCase() === W.addr && /Erc721|Erc1155/i.test(b.tokenType || '')) { S.nftCols = S.nftCols || {}; S.nftCols[String(b.contractAddress).toLowerCase()] = 1; } // 記下持有的 NFT 系列（12 小時看一次成交量）
  const got = (sim?.balanceChanges || []).filter((b) => String(b.owner).toLowerCase() === W.addr).map((b) => (b.tokenType === 'Erc721' ? 'NFT ×1' : b.tokenType + ' +' + b.change)).join('、');
  return `🤖 已自動鑄造 ${fname}${got ? '（' + got + '）' : ''}${fname.startsWith('commit') ? '\n（這種是兩步式，還要 reveal 才拿到，手動處理）' : ''}\n交易 ${x.j.data?.txHash || x.j.data?.orderId || ''}`;
}

// ---------- AIDROP 金库：出现新类型的事件（例如开放领取/发放）就通知 ----------
const AIDROP_VAULT = (CONFIG.watchVault || '').toLowerCase(); // 可選：要盯的 Flap 金庫（例如 AIDROP）
async function aidropWatch(head) {
  if (!AIDROP_VAULT) return;
  S.aidrop = S.aidrop || { topics: {}, from: head - 2000 };
  try {
    const logs = await rpc('eth_getLogs', [{ address: AIDROP_VAULT, fromBlock: '0x' + Math.max(S.aidrop.from, head - 4000).toString(16), toBlock: '0x' + head.toString(16) }]);
    const first = Object.keys(S.aidrop.topics).length === 0;
    let alerted = false;
    for (const l of logs) { const t0 = l.topics[0]; if (['0x8a587a0e', '0xe988651c'].includes(t0.slice(0, 10))) { S.aidrop.topics[t0] = 1; continue; } if (!S.aidrop.topics[t0]) { S.aidrop.topics[t0] = 1; if (!first && !alerted && (alerted = true)) await tg(`📣 AIDROP 金库出现新的链上动作（新事件类型）\n可能是开放领取或开始发放，请自行查看\n交易 ${l.transactionHash}`); } }
    S.aidrop.from = head + 1;
  } catch {}
}

// ---------- ToshX：Agent ID 专属的小额 IGO（要付钱，不自动买）。有新项目就分析后 TG 通知 ----------
const TOSH_FACTORIES = [['BNB', '0x091d0cbd1e3b7d8b2a6fd8e0795b784eddffb590'], ['USDT', '0x8296fa2d430dcf25233a39cc3306ee503967a6bb']];
async function toshWatch() {
  S.tosh = S.tosh || { counts: {} };
  for (const [quote, f] of TOSH_FACTORIES) {
    const r = await call(f, '0x27cca59f'); if (!r) continue; const n = Number(BigInt(r.slice(0, 66)));
    const prev = S.tosh.counts[f];
    if (prev === undefined) { S.tosh.counts[f] = n; continue; } // 第一次只记数量，不通知旧项目
    for (let i = prev; i < n; i++) {
      try {
        const L = await call(f, '0x7b443a76' + w(i)); const W4 = L.slice(2).match(/.{64}/g);
        const token = '0x' + W4[0].slice(24), hook = '0x' + W4[1].slice(24), creator = '0x' + W4[2].slice(24), createdAt = Number(BigInt('0x' + W4[3]));
        const str = async (sel) => { const h = await call(token, sel); try { const x = h.slice(2); const len = Number(BigInt('0x' + x.slice(64, 128))); return Buffer.from(x.slice(128, 128 + len * 2), 'hex').toString('utf8'); } catch { return '?'; } };
        const name = await str('0x06fdde03'), sym = await str('0x95d89b41');
        // 创建者以前发过几个（两个工厂都算）
        let byCreator = 0; for (const [, f2] of TOSH_FACTORIES) { const c2 = await call(f2, '0x27cca59f'); const n2 = c2 ? Number(BigInt(c2.slice(0, 66))) : 0; for (let k = Math.max(0, n2 - 60); k < n2; k++) { const L2 = await call(f2, '0x7b443a76' + w(k)); if (L2 && L2.slice(2).match(/.{64}/g)[2].slice(24) === creator.slice(2)) byCreator++; } }
        // 官网资料（简介、推特、TG）
        let meta = null; try { const j = await (await fetch('https://toshx.xyz/api/projects', { signal: AbortSignal.timeout(10000) })).json(); meta = (j.data || []).find((p) => String(p.token_address).toLowerCase() === token); } catch {}
        const raisedRaw = quote === 'BNB' ? await rpc('eth_getBalance', [hook, 'latest']).catch(() => '0x0') : await call(USDT, '0x70a08231' + wa(hook));
        const raised = Number(BigInt(raisedRaw || '0x0')) / 1e18;
        const flags = [];
        if (!meta) flags.push('官网还没有资料（可能是测试盘）');
        if (meta && !meta.twitter) flags.push('没有推特');
        if (meta && !meta.website) flags.push('没有官网');
        if (byCreator > 1) flags.push(`同一个创建者已发过 ${byCreator} 个`);
        if (/test/i.test(name + sym)) flags.push('名字像测试盘');
        const desc = (meta?.description || '').replace(/\s+/g, ' ').slice(0, 220);
        const verdict = flags.length >= 2 ? '🔴 風險偏高，建議觀望' : flags.length === 1 ? '🟡 有疑點，自己再看看' : '🟢 資料齊全，可以考慮';
        // 使用者的規則：發射台上的一般代幣不打，只打平台幣
        const PLATFORM_DEPLOYER = '0x790091e8965ecc1adfa40aa9b95515c6289dce9d'; // TOSH 平台幣的建立者
        const isPlatform = creator.toLowerCase() === PLATFORM_DEPLOYER || /platform token|平台币|平台幣|platform coin/i.test((meta?.description || '') + name);
        if (!isPlatform) { log(`ToshX 新项目 ${name}(${sym}) 不是平台币，按规则不通知`); continue; }
        await tg(`🚀 ToshX 平台幣相關新項目：${name}（$${sym}）\n報價幣：${quote} · 已募到約 ${raised.toFixed(3)} ${quote}\n建立時間：${new Date(createdAt * 1000).toLocaleString('zh-TW', { hour12: false, timeZone: CONFIG.timeZone || 'Asia/Taipei' })}\n${desc ? '簡介：' + desc + '\n' : ''}${meta?.twitter ? 'X：' + meta.twitter + '\n' : ''}${meta?.telegram ? 'TG：' + meta.telegram + '\n' : ''}代幣 ${token}\n分析：${verdict}${flags.length ? '（' + flags.join('、') + '）' : ''}\n規則：每個 Agent ID 一份額度，通常開賣幾分鐘就滿。要打的話手動處理「打 ${sym}」和每個錢包打多少\nhttps://toshx.xyz/launchpad`);
      } catch (e) { log('tosh err ' + e.message); }
    }
    S.tosh.counts[f] = n;
  }
}

// ---------- Flap「ID AGENT CURVE」：只限 Agent ID 的曲线发射台，有新盘就分析后 TG ----------
const FLAP_READER = '0x18aa6c93f1887a243fdc348c9a77f5136555174a';
const FLAP_QUOTES = { '0x4902c5ebc598265ed2212b559b042de8a5eeec3f': 'BNCB', '0x02fca66c1d1afb4e2a7884261eb00f63598a7436': 'NVDAB', '0x205812cdbed920aff76c6580abd681a46d11efc7': 'QQQB', '0xbe9d156892e55e7154bcd3cb0fea677f9d3103e1': 'SPCXB' };
function decStrAt(hex, byteOff) { const h = hex.replace(/^0x/, ''); const len = Number(BigInt('0x' + h.slice(byteOff * 2, byteOff * 2 + 64))); return Buffer.from(h.slice(byteOff * 2 + 64, byteOff * 2 + 64 + len * 2), 'hex').toString('utf8'); }
async function flapAgentWatch() {
  S.flapAgent = S.flapAgent || { total: null, names: {} };
  const p0 = await call(FLAP_READER, '0x8f82e165' + w(0) + w(1)); if (!p0) return;
  const total = Number(BigInt('0x' + p0.slice(2 + 128, 2 + 192)));
  if (S.flapAgent.total === null) { S.flapAgent.total = total; return; }
  for (let i = S.flapAgent.total; i < total; i++) {
    try {
      const pg = await call(FLAP_READER, '0x8f82e165' + w(i) + w(1)); const W5 = pg.slice(2).match(/.{64}/g); const off = Number(BigInt('0x' + W5[0])) / 32; const m = '0x' + W5[off + 1].slice(24);
      const st = await call(FLAP_READER, '0x51c023e2' + wa(m)); const SW = st.slice(2).match(/.{64}/g);
      const t0 = Number(BigInt('0x' + SW[0])) / 32, inner = t0 + Number(BigInt('0x' + SW[t0])) / 32;
      const name = decStrAt(st, (inner + Number(BigInt('0x' + SW[inner])) / 32) * 32), sym = decStrAt(st, (inner + Number(BigInt('0x' + SW[inner + 1])) / 32) * 32);
      const buyTax = Number(BigInt('0x' + SW[inner + 5])) / 100, sellTax = Number(BigInt('0x' + SW[inner + 6])) / 100, maxW = Number(BigInt('0x' + SW[inner + 11])) / 100;
      const quote = '0x' + SW[t0 + 1].slice(24); const qn = /^0x0{40}$/.test(quote) ? 'BNB' : FLAP_QUOTES[quote] || quote.slice(0, 10);
      const key = (sym || name).toLowerCase(); const dup = S.flapAgent.names[key]; S.flapAgent.names[key] = (dup || 0) + 1;
      const flags = []; if (buyTax + sellTax > 8) flags.push(`稅偏高 ${buyTax}%/${sellTax}%`); if (dup) flags.push('跟風同名（之前已有同名盤）'); if (/<|script|onerror|http/i.test(name + sym)) flags.push('⚠️ 名稱含可疑程式碼，別在網頁上點');
      const verdict = flags.length >= 2 ? '🔴 建議跳過' : flags.length === 1 ? '🟡 有疑點' : '🟢 首發、稅合理';
      if (!/^(flap|flapx)$/i.test(sym.trim())) { log(`Flap Agent 新盘 ${name}(${sym}) 是发射台代币，按规则不通知`); continue; }
      await tg(`🦋 Flap ID AGENT CURVE 新盤：${name.slice(0, 40)}（${sym.slice(0, 20)}）\n底池：${qn} · 稅 ${buyTax}%/${sellTax}% · 單錢包上限 ${maxW}%\n分析：${verdict}${flags.length ? '（' + flags.join('、') + '）' : ''}\n市場 ${m}\n要打的話手動處理「打 ${sym.slice(0, 20)}」和金額`);
    } catch (e) { log('flapAgent err ' + e.message); }
  }
  S.flapAgent.total = total;
}

// ---------- AI 錢包登入狀態 ----------
// ---------- 使用者確認：Agent ID 專屬的「付費」鑄造也自動打（有預算上限＋過濾）----------
// User-pinned projects receive priority tracking; all automatic safety gates apply.
const FORCE = new Set((CONFIG.forceMint || []).map((a) => a.toLowerCase())); // config.json forceMint: priority project tracking
const PAID = getPaidConfig(CONFIG); // 配置中的零预算明确关闭付费铸造。
const codeCache = new Map();
async function codeOf(a) { if (!codeCache.has(a)) codeCache.set(a, ((await rpc('eth_getCode', [a, 'latest']).catch(() => '')) || '').toLowerCase()); return codeCache.get(a); }
async function bnbUsd() {
  const p = await call(FACTORY, '0xe6a43905' + wa(WBNB) + wa(USDT)); const pair = '0x' + (p || '').slice(26); const r = await call(pair, '0x0902f1ac'); const t0 = await call(pair, '0x0dfe1681');
  if (!r || !t0 || r.length < 130) return 0; const a = BigInt(r.slice(0, 66)), b = BigInt('0x' + r.slice(66, 130)); const price = t0.slice(26) === WBNB.slice(2) ? Number(b) / Number(a) : Number(a) / Number(b);
  if (Number.isFinite(price) && price > 0) { S.lastBnbUsd = price; S.lastBnbUsdAt = Date.now(); return price; } return 0;
}
const tokStr = (r) => { try { const h = r.slice(2); const len = Number(BigInt('0x' + h.slice(64, 128))); return noLink(Buffer.from(h.slice(128, 128 + len * 2), 'hex').toString('utf8')); } catch { return ''; } };
async function readLimit(W, c) {
  const code = ((await codeOf(c)) || '').toLowerCase(); const has = (s) => code.includes(s); const num = (r) => (r && r.length >= 66 ? BigInt(r.slice(0, 66)) : null); const me = wa(W.addr); const lim = [];
  for (const s of ['d872e413', 'b399b0bc', 'b0b5230f', '7aa9a9d8']) if (has(s)) { const x = num(await call(c, '0x' + s + me)); if (x != null && x < 1000000n) { lim.push(x); break; } }
  let per = null; for (const s of ['453c2310', 'b228d925', '0f2cdd6c', 'f516a2e6', '3c8463a1', 'a4183dbe', '6ac8c1b7']) if (has(s)) { const x = num(await call(c, '0x' + s)); if (x != null && x > 0n && x < 1000000n) { per = x; break; } }
  if (per == null) for (const s of ['1cee24f5', 'ef23b3a3']) if (has(s)) { const x = num(await call(c, '0x' + s + me)); if (x != null && x > 0n && x < 1000000n) { per = x; break; } }
  if (per != null) { let mine = 0n; for (const s of ['1e7269c5', '3cef28d2', 'dc33e681', 'fddcb5ea', 'f5eb42dc', '7b622c72']) if (has(s)) { const x = num(await call(c, '0x' + s + me)); if (x != null && x < 1000000n) { mine = x; break; } } lim.push(per > mine ? per - mine : 0n); }
  for (const s of ['f968adbe', 'f43a22dc', 'de7fcb1d']) if (has(s)) { const x = num(await call(c, '0x' + s)); if (x != null && x > 0n && x < 1000000n) { lim.push(x); break; } }
  return lim.length ? lim.reduce((a, b) => (b < a ? b : a)) : null;
}
async function fitShares(W, c, data, v) { // 份數：先讀項目方開放幾份；讀不到再自動降到 5、3、2、1 份試
  const ws = data.slice(10).match(/.{64}/g) || []; if (!ws.length) return data;
  let n0 = BigInt('0x' + ws[0]); if (n0 < 1n || n0 > 100n) return data;
  const lim = await readLimit(W, c).catch(() => null);
  if (lim != null) { if (lim === 0n) throw new Error('這個錢包的額度已經用完'); if (lim < n0) { log(`讀到項目方開放份數 ${lim}，照這個打：${c}`); n0 = lim; } }
  const nOrig = BigInt('0x' + ws[0]);
  for (const n of [n0, ...[5n, 3n, 2n, 1n].filter((x) => x < n0)]) {
    const d2 = data.slice(0, 10) + w(n) + ws.slice(1).join(''); const vv = (BigInt(v || 0) * n) / nOrig; /* 審查 11/1：份數降了，付的錢也要按比例降（以前照付原本的金額） */
    try { await rpc('eth_call', [{ from: W.addr, to: c, data: d2, value: '0x' + vv.toString(16) }, 'latest']); if (n !== n0) log(`份數降到 ${n} 份才打得了：${c}`); return d2; } catch {}
  }
  return data;
}
const REFUND_SELS = ['590e1ae3', 'b5545a3c', '278ecde1', '5b7baf64', '110f8874', '16bfe25c', '38e771ab', 'b2d5ae44', 'fa89401a', 'bffa55d5', '68ec0d99', '74c1b1c9', 'b30196e5', 'c033a490', '4c4a386f', 'd233e4eb']; // 退款相關函式：refund()、claimRefund()、refundOpen()、refundable(address)…
const scaleV = (d0, d1, v) => { /* 份數從 d0 的第一個參數變成 d1 的，金額按比例調整 */ try { const a = BigInt('0x' + d0.slice(10, 74)), b = BigInt('0x' + d1.slice(10, 74)); if (a >= 1n && a <= 100n && b >= 1n && b < a) return (BigInt(v) * b) / a; } catch {} return BigInt(v); };
async function safeAddrs(W, c, data, v) {
  if (!validMintAddress(W.addr) || !validMintAddress(c) || !validMintCalldata(data, true)) throw new Error('重放地址或调用数据无效');
  const body = data.slice(10), ws = body.match(/.{64}/g) || [], tail = body.slice(ws.length * 64);
  let me = W.addr.slice(2).toLowerCase();
  if (W.agentId) { let sw = 0; for (let i = 0; i < ws.length; i++) { const x = ws[i].toLowerCase(); if (/^0{24}/.test(x) || BigInt('0x' + x) < 2n ** 128n || x === W.agentId) continue; const o = await call('0x' + REGISTRY, '0x6352211e' + x); if (o && BigInt(o.slice(0, 66)) > 0n && o.slice(26, 66).toLowerCase() !== me) { ws[i] = W.agentId; sw = 1; } } if (sw) { data = data.slice(0, 10) + ws.join('') + tail; log(`照抄前把別人的 Agent ID 編號換成自己的：${c}`); } } /* 照抄的交易帶著別人的 Agent ID 編號 → 換成自己的 */
  const skip = new Set([me, c.slice(2).toLowerCase(), USDT.slice(2).toLowerCase(), WBNB.slice(2).toLowerCase()]);
  const idx = ws.map((x, i) => [x.toLowerCase(), i]).filter(([x]) => /^0{24}[0-9a-f]{40}$/.test(x) && x.slice(24, 32) !== '00000000' && !skip.has(x.slice(24))).map(([, i]) => i);
  if (!idx.length) return data;
  for (const r of [me.padStart(64, '0'), '0'.repeat(64)]) {
    const d2 = data.slice(0, 10) + ws.map((x, i) => (idx.includes(i) ? r : x)).join('') + tail;
    try { await rpc('eth_call', [{ from: W.addr, to: c, data: d2, value: '0x' + BigInt(v || 0).toString(16) }, 'latest']); log(`照抄前把別人的地址換成${r === '0'.repeat(64) ? '零地址' : '自己的地址'}：${c}`); return d2; } catch {}
  }
  throw new Error('交易中的其他地址换成自己或零地址都无法执行，未重放');
}
async function revokeOnFail(W, token, spender, operation) {
  if (MONITOR_ONLY) throw new Error(MONITOR_NOTE);
  try { return await operation(); }
  catch (error) {
    try {
      await previewExec(W, token, '0x095ea7b3' + wa(spender) + w(0), 0n, (sim) => approvalSimulationCheck(sim, W, spender, token));
      logWallet(W, `铸造失败，已撤销对 ${spender} 的授权`);
    } catch (revokeError) { logWallet(W, `撤销授权失败 ${revokeError.message}`); }
    throw error;
  }
}
/* 使用者 10/31 10:49：全部禁止授權給 Flap。Flap 的合約一律不互動、不授權 */
const FLAP_BLOCK = new Set(['0xe2ce6ab80874fa9fa2aae65d277dd6b8e65c9de0', '0x90497450f2a706f1951b5bdda52b4e5d16f34c06', '0x18aa6c93f1887a243fdc348c9a77f5136555174a', '0x8b4329947e34b6d56d71a3385cac122bade7d78d', '0x5dd913731c12ad8df3e574859fde45412bf4aad9']);
const FLAP_BAN = true; // 保留本地原有的 Flap 交互限制。
function flapGuard(to, data, sim) {
  if (!FLAP_BAN) return '';
  if (FLAP_BLOCK.has(String(to).toLowerCase())) return '禁止跟 Flap 合約互動';
  const d = String(data || '').toLowerCase(); if (/^0x(095ea7b3|39509351)/.test(d) && FLAP_BLOCK.has('0x' + d.slice(34, 74))) return '禁止授權給 Flap';
  if ((sim?.allowanceChanges || []).some((a) => FLAP_BLOCK.has(String(a.spender).toLowerCase()))) return '會授權給 Flap，禁止';
  return '';
}
let INFLIGHT = 0; // 正在送出的交易數（重啟前要等它歸零，避免重打）
function mintQuantity(data, sim, W) {
  let nftQuantity = 0n;
  for (const change of sim?.balanceChanges || []) if (String(change.owner).toLowerCase() === W.addr && /Erc721|Erc1155/i.test(change.tokenType || '') && /^\d+$/.test(String(change.change)) && BigInt(String(change.change)) > 0n) nftQuantity += BigInt(String(change.change));
  if (nftQuantity > 0n) return nftQuantity <= 10000n ? Number(nftQuantity) : 10001;
  if (/^0x(?:a0712d68|e38fd349|94bf804d)[0-9a-f]{64}/i.test(data)) { const value = BigInt('0x' + data.slice(10, 74)); if (value > 0n) return value <= 10000n ? Number(value) : 10001; }
  return null;
}
function simulationNftGain(sim, W) { return (sim?.balanceChanges || []).some(change => String(change.owner).toLowerCase() === W.addr && /Erc721|Erc1155/i.test(change.tokenType || '') && /^\d+$/.test(String(change.change)) && BigInt(String(change.change)) > 0n); }
async function previewExec(W, to, data, valueWei, check, recheck = null, kind = 'mint', opts = {}) {
  if (MONITOR_ONLY || !canWallet(W, kind)) throw new Error(MONITOR_NOTE);
  return withWalletExecution(W.profile, async () => {
    const previousKind = W.operationKind; W.operationKind = kind;
    try { return await previewExecInner(W, to, data, valueWei, check, recheck, opts); } finally { W.operationKind = previousKind; }
  }, { root: DIR, kind: 'scanner-contract' });
}
async function previewExecInner(W, to, data, valueWei, check, recheck, opts = {}) {
  const PAID = paidFor(W);
  const p = await W.baw(['contract-call', 'preview', '--binanceChainId', '56', '--from', W.addr, '--to', to, '--value', valueWei.toString(), '--inputData', data]);
  const sim = p.j?.data?.simulationResult, rid = p.j?.data?.requestId;
  if (!p.j?.success || !rid) throw new Error('預演失敗 ' + (p.j?.error?.message || p.t).slice(0, 120));
  const fg = flapGuard(to, data, sim); if (fg) throw new Error('預演不安全：' + fg);
  const why = check(sim); if (why) throw new Error('預演不安全：' + why);
  const isApproval = /^(0x095ea7b3|0x39509351)/i.test(data);
  if (W.operationKind !== 'token-sell' && !opts.manual && !isApproval && valueWei === 0n && !opts.paymentToken) throw new Error('完全免费项目只通知，不自动铸造');
  const nativeChanges = (sim?.balanceChanges || []).filter(change => String(change.owner).toLowerCase() === W.addr && String(change.contractAddress).toLowerCase() === NATIVE_BNB.toLowerCase());
  if (nativeChanges.some(change => !/^-?\d+$/.test(String(change.change)))) throw new Error('预演 BNB 变化金额无效');
  const nativeOut = nativeChanges.reduce((sum, change) => BigInt(String(change.change)) < 0n ? sum - BigInt(String(change.change)) : sum, 0n);
  if (nativeOut > valueWei) throw new Error('预演扣除的 BNB 超过明确金额');
  if (recheck) { const r2 = await recheck(); if (r2) throw new Error('送出前再確認不通過：' + r2); } // 送出前再確認價格（審查建議 5）
  if (valueWei > 0n) {
    const price = await bnbUsd(), costBnb = Number(valueWei) / 1e18;
    const spent = resetPaidBudgetDay()[W.id] || 0;
    const balanceBnb = Number(BigInt(await rpc('eth_getBalance', [W.addr, 'latest']))) / 1e18;
    if (!(price > 0) || !withinPaidBudget(PAID, { spentBnb: spent, costBnb, costUsd: costBnb * price, balanceBnb })) throw new Error('超过单笔/每日付费预算或 BNB 保留金额');
  }
  const paymentPrice = valueWei > 0n ? await bnbUsd() : 0;
  if (valueWei > 0n && !(paymentPrice > 0)) throw new Error('无法核验本笔付款的 USD 成本');
  const paymentUsd = Number(valueWei) / 1e18 * paymentPrice + (opts.paymentToken === USDT ? Number(opts.paymentWei || 0n) / 1e18 : 0);
  const riskQuote = W.operationKind === 'token-sell' ? null : await MINT_RISK.quoteTransaction(W, { to, data, valueWei, keepBnb: PAID.keepBnb, paid: true, manual: opts.manual === true, project: !isApproval, paymentToken: opts.paymentToken, paymentWei: opts.paymentWei ?? valueWei, paymentUsd, quantity: mintQuantity(data, sim, W), nftEvidence: !isApproval && simulationNftGain(sim, W) });
  if (riskQuote && valueWei > 0n) riskQuote.paymentUsdMicros = usdBudgetMicros(paymentUsd);
  if (riskQuote && !isApproval) riskQuote.mintTracking = mintTrackingPlan(W, sim, paymentUsd, riskQuote.mintToken || opts.fallbackToken);
  INFLIGHT++; let x; try { x = await runPaidCommand(W, ['contract-call', 'execute', '--requestId', rid], valueWei, { from: W.addr, to, value: valueWei.toString(), inputData: data }, riskQuote); } finally { INFLIGHT--; }
  if (mintExecutionUnknown(x)) throw new Error('結果不明：送出逾時或响应中断，可能已上鏈，先不重打');
  if (!x.j?.success) throw new Error('送出失敗 ' + (x.j?.error?.message || x.t).slice(0, 120));
  await sleep(8000); return { tx: x.j.data?.txHash || '', sim };
}
async function poolOut(amtIn, from, to) { // 池子現在買得到多少（沒池子回 0）
  const r = await call(ROUTER, '0xd06ca61f' + w(amtIn) + w(64) + w(2) + wa(from) + wa(to)); if (!r || r.length < 2 + 64 * 4) return 0n; return BigInt('0x' + r.slice(2 + 64 * 3, 2 + 64 * 4));
}
const gotTok = (sim, W) => (sim?.balanceChanges || []).filter((b) => String(b.owner).toLowerCase() === W.addr && Number(b.change) > 0).reduce((a, b) => a + Number(b.change), 0);
const validMintAddress = (address) => typeof address === 'string' && /^0x[a-fA-F0-9]{40}$/.test(address) && !/^0x0{40}$/i.test(address);
const validMintCalldata = (data, allowEmpty = false) => typeof data === 'string' && data.length <= 131074 && /^0x(?:[a-fA-F0-9]{2})*$/.test(data) && (allowEmpty || data.length >= 10);
const mintUint = (value) => { const text = String(value ?? '0'); if (!/^\d+$/.test(text)) throw new Error('金额必须是非负整数'); const result = BigInt(text); if (result >= 1n << 256n) throw new Error('金额超出范围'); return result; };
function hasPositiveMintGain(sim, W) {
  const net = new Map();
  for (const change of sim?.balanceChanges || []) {
    if (String(change.owner).toLowerCase() !== W.addr.toLowerCase() || !/^-?\d+$/.test(String(change.change))) continue;
    const key = String(change.contractAddress).toLowerCase() + ':' + String(change.tokenId ?? '');
    net.set(key, (net.get(key) || 0n) + BigInt(String(change.change)));
  }
  return [...net.values()].some((amount) => amount > 0n);
}
function mintSimulationCheck(sim, W, { bnbWei = 0n, usdtWei = 0n } = {}) {
  if (!sim || !Array.isArray(sim.balanceChanges)) return '缺少资产变化预演';
  if (sim.allowanceChanges?.length || sim.authorityChanges?.length) return '有授权或权限变化';
  let bnbOut = 0n, usdtOut = 0n, received = false;
  for (const change of sim.balanceChanges) {
    if (String(change.owner).toLowerCase() !== W.addr.toLowerCase()) continue;
    if (!/^-?\d+$/.test(String(change.change))) return '资产变化金额无效';
    const amount = BigInt(String(change.change)), token = String(change.contractAddress).toLowerCase();
    if (amount < 0n) {
      if (token === NATIVE_BNB.toLowerCase()) bnbOut -= amount;
      else if (token === USDT) usdtOut -= amount;
      else return '会扣到预期以外的资产';
    } else if (amount > 0n && validMintAddress(token) && token !== NATIVE_BNB.toLowerCase() && token !== USDT) received = true;
  }
  if (bnbOut > bnbWei || usdtOut > usdtWei) return '预演扣款超过明确金额';
  if (!received) return '模拟没有获得代币或 NFT';
  return '';
}
function approvalSimulationCheck(sim, W, spender, token = USDT) {
  if (!sim || !Array.isArray(sim.balanceChanges)) return '缺少授权预演';
  if (sim.authorityChanges?.length) return '有权限变化';
  if (sim.balanceChanges.some((change) => String(change.owner).toLowerCase() === W.addr.toLowerCase() && (!/^-?\d+$/.test(String(change.change)) || BigInt(String(change.change)) < 0n))) return '授权会扣除资产';
  for (const change of sim.allowanceChanges || []) {
    if (String(change.spender).toLowerCase() !== spender.toLowerCase()) return '授权对象不符';
    const asset = change.contractAddress || change.tokenAddress || change.tokenContract;
    if (asset && String(asset).toLowerCase() !== token.toLowerCase()) return '授权资产不符';
    if (change.owner && String(change.owner).toLowerCase() !== W.addr.toLowerCase()) return '授权钱包不符';
  }
  return '';
}
let SCANNER_BUDGET;
const scannerBudget = () => SCANNER_BUDGET ||= createWalletBudget({ root: DIR });
function usdBudgetMicros(value) {
  if (!Number.isFinite(value) || value < 0 || !Number.isSafeInteger(Math.ceil(value * 1e6))) throw new Error('USD 预算金额无效');
  return String(Math.ceil(value * 1e6));
}
function bnbBudgetWei(value) {
  if (!Number.isFinite(value) || value < 0) throw new Error('预算金额无效');
  // Round up at nanobnb precision, then use exact integer wei in the shared ledger.
  return BigInt(Math.ceil(value * 1e9)) * 1000000000n;
}
async function confirmWalletResult(W, scope = null) {
  const pending = S.walletPending?.[W.id];
  if (!pending) throw new Error('結果不明：缺少已保存的交易意图');
  for (let attempt = 0; attempt < 12; attempt++) {
    const result = await reconcileScannerPending({ wallet: W.profile, pending, runWallet: async (args) => (await W.baw(args, 30000)).j, rpc, budget: scope ? { settle: async () => {} } : scannerBudget(), root: DIR });
    if (result.resolved) { await settleConfirmedMintRisk(pending, result); if (result.status === 'confirmed') { applyMintTracking(W, pending, result.txHash); pending.txHash = result.txHash; } return result.status === 'confirmed'; }
    if (result.status === 'review') break;
    await sleep(2000);
  }
  await markWalletBlocked(W.profile, '交易已提交，链上结果尚未核对', { root: DIR, details: { source: 'scanner', ...(pending.orderId ? { orderId: pending.orderId } : {}), ...(pending.txHash ? { txHash: pending.txHash } : {}), ...(pending.reservationId ? { reservationId: pending.reservationId } : {}) } });
  throw new Error('結果不明：等待链上核验，请在钱包管理中核对待处理交易');
}
async function settleConfirmedMintRisk(pending, result) {
  if (!pending.mintRiskReservation || !result.resolved) return;
  if (!result.txHash) { if (result.status === 'reverted') MINT_RISK.settle(pending.mintRiskReservation, { rejected: true }); return; }
  // The reconciler has already checked the original from/to/value/data, BSC and
  // transaction/block linkage. Never settle fees using an unrelated receipt.
  const receipt = await rpc('eth_getTransactionReceipt', [result.txHash]).catch(() => null);
  if (String(receipt?.transactionHash).toLowerCase() !== result.txHash.toLowerCase() || !['0x1', '0x0', '0x01', '0x00'].includes(receipt?.status) || (BigInt(receipt.status) === 1n) !== (result.status === 'confirmed')) return;
  MINT_RISK.settle(pending.mintRiskReservation, { receipt });
}
const SCANNER_RECOVERY_JOBS = new Map();
function recoverScannerWallet(W) {
  if (!S.walletPending?.[W.id]) return Promise.resolve(null);
  if (SCANNER_RECOVERY_JOBS.has(W.id)) return SCANNER_RECOVERY_JOBS.get(W.id);
  const job = withWalletExecution(W.profile, async () => {
    const pending = S.walletPending?.[W.id]; if (!pending) return null;
    const result = await reconcileScannerPending({ wallet: W.profile, pending, runWallet: async args => (await W.baw(args, 30000)).j, rpc, budget: scannerBudget(), root: DIR });
    if (result.resolved && S.walletPending[W.id] === pending) {
      await settleConfirmedMintRisk(pending, result);
      if (result.status === 'confirmed') applyMintTracking(W, pending, result.txHash);
      if (pending.reservationDay === S.paidSpend?.day) S.paidSpend[W.id] = Math.max(0, (S.paidSpend[W.id] || 0) - Number(pending.reservedAmountWei || 0) / 1e18 + Number(result.spentWei || 0) / 1e18);
      delete S.walletPending[W.id];
      S.walletRuntime ||= {}; S.walletRuntime[W.id] ||= {};
      S.walletRuntime[W.id].recovery = { status: result.status, at: Date.now(), txHash: result.txHash || null };
      save(true);
    }
    return result;
  }, { root: DIR, kind: 'reconcile', allowBlocked: true }).finally(() => SCANNER_RECOVERY_JOBS.delete(W.id));
  SCANNER_RECOVERY_JOBS.set(W.id, job); return job;
}
async function runPaidCommand(W, args, amountWei = 0n, expected = null, riskQuote = null) {
  if (!canWallet(W, W.operationKind || 'mint')) throw new Error('此钱包已暂停或禁止此操作');
  if (S.walletPending?.[W.id] && S.walletPending[W.id].phase !== 'verified') throw new Error('結果不明：此钱包仍有待核对的原始交易');
  const scope = W.paidReservation;
  const kind = args[0] === 'market-order' ? 'market-order' : args[0] === 'approvals' ? 'approval' : 'contract';
  if (kind !== 'market-order' && !expected) throw new Error('缺少完整合约意图，未提交交易');
  const paymentUsdMicros = amountWei > 0n && !scope ? riskQuote?.paymentUsdMicros || usdBudgetMicros(Number(amountWei) / 1e18 * await bnbUsd()) : '0';
  if (amountWei > 0n && !scope && BigInt(paymentUsdMicros) <= 0n) throw new Error('无法核验 USD 付款预算');
  const reservation = amountWei > 0n && !scope ? await scannerBudget().reserve({ wallet: W.profile, config: currentRuntimeConfig(), amountWei, amountUsdMicros: paymentUsdMicros, ...(riskQuote?.projectId ? { projectId: riskQuote.projectId, projectLimitUsdMicros: riskQuote.projectLimitUsdMicros } : {}), legacySpent: S.paidSpend }) : null;
  const allocation = scope?.reservation || reservation;
  const spent = resetPaidBudgetDay()[W.id] || 0;
  const field = name => args[args.indexOf(name) + 1];
  const isFinalMint = scope && expected?.to === scope.finalTarget && expected?.inputData === scope.finalData;
  const successSpent = scope ? isFinalMint ? scope.totalWei : scope.spentWei + (kind === 'market-order' ? amountWei : 0n) : amountWei;
  const failureSpent = scope ? scope.spentWei : 0n;
  const successUsd = scope ? isFinalMint ? scope.totalUsdMicros : scope.spentUsdMicros + (kind === 'market-order' ? BigInt(usdBudgetMicros(Number(amountWei) / 1e18 * scope.price)) : 0n) : BigInt(paymentUsdMicros);
  const failureUsd = scope ? scope.spentUsdMicros : 0n;
  let mintRiskReservation;
  try { mintRiskReservation = riskQuote ? MINT_RISK.reserve(riskQuote) : null; }
  catch (error) { if (reservation) await scannerBudget().settle(reservation.id, { spentWei: 0n, spentUsdMicros: '0' }); throw error; }
  const pending = { version: 1, walletId: W.id, walletAddress: W.addr, walletIndex: W.index, kind, createdAt: Date.now(), amountWei: amountWei.toString(), expected: kind !== 'market-order' ? expected : { fromToken: field('--fromToken'), toToken: field('--toToken'), fromTokenQty: field('--fromTokenQty') }, ...(allocation ? { reservationId: allocation.id, reservationDay: allocation.day, reservedAmountWei: allocation.amountWei, ...(allocation.amountUsdMicros !== undefined ? { reservedAmountUsdMicros: allocation.amountUsdMicros } : {}) } : { reservedAmountWei: '0' }), ...(mintRiskReservation ? { mintRiskReservation } : {}), ...(riskQuote?.mintTracking ? { mintTracking: { ...riskQuote.mintTracking, costUsdMicros: successUsd.toString() } } : {}), settlement: { successSpentWei: successSpent.toString(), failureSpentWei: failureSpent.toString(), ...(allocation?.amountUsdMicros !== undefined ? { successSpentUsdMicros: successUsd.toString(), failureSpentUsdMicros: failureUsd.toString() } : {}) } };
  S.walletPending ||= {}; S.walletPending[W.id] = pending; save(true);
  let result;
  try {
    result = await W.baw(args);
    const data = result.j?.data;
    if (typeof data?.txHash === 'string') pending.txHash = data.txHash;
    if (typeof data?.orderId === 'string') pending.orderId = data.orderId;
    if (args.includes('--requestId')) pending.requestId = field('--requestId');
    save(true);
    if (mintExecutionUnknown(result)) throw new Error('結果不明：钱包提交未返回明确结果');
    let chainConfirmed = false;
    if (!result.j?.success && (pending.txHash || pending.orderId)) {
      chainConfirmed = await confirmWalletResult(W, scope);
      if (chainConfirmed) result = { ...result, j: { success: true, data: { ...(result.j?.data || {}), txHash: pending.txHash, orderId: pending.orderId } } };
      else { if (reservation) await scannerBudget().settle(reservation.id, { spentWei: 0n, spentUsdMicros: '0' }); delete S.walletPending[W.id]; save(true); return { t: '交易已回滚', j: { success: false, error: { name: 'TRANSACTION_REVERTED', message: '链上交易失败，已按原始交易核验 gas' } } }; }
    }
    if (!result.j?.success) {
      if (mintRiskReservation && !pending.txHash && !pending.orderId) MINT_RISK.settle(mintRiskReservation, { rejected: true });
      pending.phase = 'rejected'; pending.rejection = result.j.error?.name; save(true);
      if (reservation) await scannerBudget().settle(reservation.id, { spentWei: 0n, spentUsdMicros: '0' });
      delete S.walletPending[W.id]; save(true); return result;
    }
    const confirmed = chainConfirmed || await confirmWalletResult(W, scope);
    if (!confirmed) { if (reservation) await scannerBudget().settle(reservation.id, { spentWei: 0n, spentUsdMicros: '0' }); delete S.walletPending[W.id]; save(true); return { t: '交易已回滚', j: { success: false, error: { name: 'TRANSACTION_REVERTED', message: '链上交易失败，未计入买入支出' } } }; }
    if (reservation) await scannerBudget().settle(reservation.id, { spentWei: amountWei, spentUsdMicros: paymentUsdMicros });
    if (scope) { scope.spentWei = successSpent; scope.spentUsdMicros = successUsd; pending.phase = 'verified'; } else delete S.walletPending[W.id];
    save(true);
    if (amountWei > 0n && !scope) { S.paidSpend[W.id] = spent + Number(amountWei) / 1e18; save(); }
    return result;
  } catch (error) {
    if (scope) scope.unknown = true;
    if (amountWei > 0n && !scope) { S.paidSpend[W.id] = spent + Number(amountWei) / 1e18; save(true); }
    await markWalletBlocked(W.profile, '钱包交易提交结果不明', { root: DIR, details: { source: 'scanner', ...(allocation ? { reservationId: allocation.id } : {}), ...(pending.orderId ? { orderId: pending.orderId } : {}), ...(pending.txHash ? { txHash: pending.txHash } : {}) } });
    throw new Error('結果不明：' + String(error.message || '钱包响应中断').replace(/^結果不明：/, ''));
  }
}
const MINT_WALLET_QUEUE = new Map();
function withMintWalletLock(W, operation, kind = 'mint') {
  const key = W.addr.toLowerCase();
  const previous = MINT_WALLET_QUEUE.get(key) || Promise.resolve();
  const running = previous.catch(() => {}).then(() => {
    if (!canWallet(W, kind)) throw new Error('此钱包已暂停或禁止此操作');
    return withWalletExecution(W.profile, async () => {
      const previousKind = W.operationKind; W.operationKind = kind;
      try { return await operation(); } finally { W.operationKind = previousKind; }
    }, { root: DIR, kind: kind === 'mint' ? 'scanner-mint' : 'scanner-token-sell' });
  });
  MINT_WALLET_QUEUE.set(key, running);
  return running.finally(() => { if (MINT_WALLET_QUEUE.get(key) === running) MINT_WALLET_QUEUE.delete(key); });
}
function mintExecutionUnknown(result) {
  if (result.j?.success) return false;
  const explicitRejection = ['INVALID_PARAMS', 'INVALID_AMOUNT', 'INVALID_ADDRESS', 'NOT_LOGGED_IN', 'INSUFFICIENT_BALANCE', 'CONFIG_ERROR', 'CLI_NOT_READY', 'TRANSACTION_REVERTED'];
  return !result.j || !explicitRejection.includes(result.j?.error?.name);
}
function resetPaidBudgetDay() {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: CONFIG.timeZone || 'Asia/Taipei' }).format(new Date());
  if (S.paidSpend?.day !== day) S.paidSpend = { day };
  return S.paidSpend;
}
function prepareUsdtReplay(replay, maxUsd, price) {
  if (!validMintCalldata(replay.data) || badSel(replay.data) || !(price > 0) || !(maxUsd > 0)) return null;
  const value = mintUint(replay.value), originalNeed = mintUint(replay.payAmt);
  if (originalNeed <= 0n) return null;
  const words = replay.data.slice(10).match(/.{64}/g) || [];
  if (words.length === 3 && replay.data.length === 202) {
    const originalN = BigInt('0x' + words[0]), maximum = BigInt('0x' + words[2]);
    if (originalN > 0n && originalN <= 100n && maximum >= originalNeed && maximum <= originalNeed * 12n / 10n) {
      const unit = (originalNeed + originalN - 1n) / originalN;
      for (let n = 10n; n >= 1n; n--) {
        const need = (unit * n * 105n + 99n) / 100n;
        if (Number(need) / 1e18 + Number(value) / 1e18 * price <= maxUsd) return { data: replay.data.slice(0, 10) + w(n) + words[1] + w(need), need, value };
      }
      return null;
    }
  }
  return Number(originalNeed) / 1e18 + Number(value) / 1e18 * price <= maxUsd ? { data: replay.data, need: originalNeed, value } : null;
}
async function executeUsdtMint(W, options) {
  if (MONITOR_ONLY || !canWallet(W, 'mint')) throw new Error(MONITOR_NOTE);
  return withWalletExecution(W.profile, () => executeUsdtMintInner(W, options), { root: DIR, kind: 'scanner-usdt-mint' });
}
async function executeUsdtMintInner(W, { to, data, need, value = 0n, recheck = null, manual = false }) {
  const PAID = paidFor(W);
  if (!validMintAddress(to) || !validMintCalldata(data) || badSel(data)) throw new Error('铸造地址或调用数据无效');
  need = mintUint(need); value = mintUint(value);
  if (need <= 0n || !(PAID.maxUsd > 0) || !(PAID.maxBnbPerDay > 0)) throw new Error('付费预算为零，未执行');
  const price = await bnbUsd(); if (!(price > 0) || !Number.isFinite(price)) throw new Error('无法取得 BNB 价格');
  const usd = Number(need) / 1e18, valueBnb = Number(value) / 1e18;
  if (usd + valueBnb * price > PAID.maxUsd) throw new Error('超过单笔预算');
  const spent = resetPaidBudgetDay()[W.id] || 0;
  const balance = Number(BigInt(await rpc('eth_getBalance', [W.addr, 'latest']))) / 1e18;
  let usdtBalance = big(await call(USDT, '0x70a08231' + wa(W.addr)));
  const held = usdtBalance < need ? usdtBalance : need;
  const heldEquivalent = Number(held) / 1e18 / price;
  const missing = need - held;
  const swapBnb = missing > 0n ? Math.ceil(Number(missing) / 1e18 * 1.04 / price * 1e6) / 1e6 : 0;
  const chargeBnb = heldEquivalent + swapBnb + valueBnb, chargeUsd = chargeBnb * price;
  if (!withinPaidBudget(PAID, { spentBnb: spent, costBnb: chargeBnb, costUsd: chargeUsd, balanceBnb: balance + heldEquivalent })) throw new Error('超过单笔/每日预算或 BNB 保留金额');
  data = await safeAddrs(W, to, data, value);
  // Check the final project before any recharge or approval consumes gas.
  const projectInfo = await MINT_RISK.projectCheck(to, { paying: true, paymentToken: USDT, paymentWei: need, paymentUsd: chargeUsd, quantity: mintQuantity(data, null, W), manual });
  if (value > 0n) await MINT_RISK.projectCheck(to, { paying: true, paymentWei: value, paymentUsd: chargeUsd, quantity: mintQuantity(data, null, W), manual });
  if (swapBnb > 0 && balance < swapBnb + valueBnb + PAID.keepBnb + 0.001) throw new Error('补款后不足以保留 gas 及 BNB 保留额');
  const reservation = await scannerBudget().reserve({ wallet: W.profile, config: currentRuntimeConfig(), amountWei: bnbBudgetWei(chargeBnb), amountUsdMicros: usdBudgetMicros(chargeUsd), ...(projectInfo?.nft ? { projectId: to.toLowerCase(), projectLimitUsdMicros: '10000000' } : {}), legacySpent: S.paidSpend });
  const scope = { reservation, totalWei: bnbBudgetWei(chargeBnb), finalTarget: to, finalData: data, spentWei: 0n, totalUsdMicros: BigInt(usdBudgetMicros(chargeUsd)), spentUsdMicros: 0n, price, unknown: false }; W.paidReservation = scope;
  try {
    if (swapBnb > 0) {
      // The official CLI chooses the swap route. Reserve a conservative fee
      // allowance instead of pretending to estimate unknown router calldata.
      const swapRisk = { walletId: W.id, contract: USDT, day: S.paidSpend.day, gasWei: '1000000000000000', feeWei: '0', amountWei: '1000000000000000', manual };
      const swap = await runPaidCommand(W, ['market-order', 'swap', '--binanceChainId', '56', '--fromTokenQty', swapBnb.toFixed(6), '--fromToken', NATIVE_BNB, '--toToken', USDT], bnbBudgetWei(swapBnb), null, swapRisk);
      if (!swap.j?.success) throw new Error('BNB 换 USDT 失败 ' + (swap.j?.error?.message || swap.t).slice(0, 100));
      S.paidSpend[W.id] = spent + swapBnb; save();
      for (let i = 0; i < 30 && usdtBalance < need; i++) { await sleep(3000); usdtBalance = big(await call(USDT, '0x70a08231' + wa(W.addr))); }
      if (usdtBalance < need) throw new Error('USDT 未到账');
    }
    await previewExec(W, USDT, '0x095ea7b3' + wa(to) + w(need), 0n, (sim) => approvalSimulationCheck(sim, W, to), null, 'mint', { manual });
    const result = await revokeOnFail(W, USDT, to, () => previewExec(W, to, data, value, (sim) => mintSimulationCheck(sim, W, { bnbWei: value, usdtWei: need }), recheck, 'mint', { manual, paymentToken: USDT, paymentWei: need }));
    scope.spentWei = bnbBudgetWei(chargeBnb); scope.spentUsdMicros = BigInt(usdBudgetMicros(chargeUsd));
    await scannerBudget().settle(reservation.id, { spentWei: scope.spentWei, spentUsdMicros: scope.spentUsdMicros.toString() });
    if (S.walletPending[W.id]?.reservationId === reservation.id && S.walletPending[W.id].phase === 'verified') delete S.walletPending[W.id];
    S.paidSpend[W.id] = spent + chargeBnb; save();
    return { ...result, usd: chargeUsd };
  } catch (error) {
    if (scope.unknown || String(error.message).includes('結果不明')) {
      S.paidSpend[W.id] = spent + chargeBnb; save(true);
      await markWalletBlocked(W.profile, 'USDT 铸造执行结果尚未核对', { root: DIR, details: { reservationId: reservation.id } });
    } else {
      await scannerBudget().settle(reservation.id, { spentWei: scope.spentWei, spentUsdMicros: scope.spentUsdMicros.toString() });
      if (S.walletPending[W.id]?.reservationId === reservation.id) delete S.walletPending[W.id];
      save(true);
    }
    throw error;
  } finally { delete W.paidReservation; }
}
// 鑄造進度：先找「已售／上限」這類函式；找不到就看「鑄造池剩多少幣」（合約剛部署時持有的幣 vs 現在）
const SOLD_SELS = ['a2309ff8', 'f4514d2e', '505e05fd', 'cc84efea', '192fc516', '9106d7ba', '67153ab4', 'f3f8a4fd', '06ed0717', '9659867e', '4f02c420', '1f21bfbf'];
const CAP_SELS = ['d8f93498', 'c65b61ca', '3a98ef39', 'b6b6f0c3', 'cce132d1', 'd5abeb01', '32cb6b0c', '06517a29', '2163837f', 'aa2d9a02', '76c71ca1', '98f1312e', '355274ea', '85e3f997'];
async function progressOf(c, code, tokAddr) {
  let sold = null, cap = null;
  for (const s of SOLD_SELS) { if (!code.includes(s)) continue; const r = await call(c, '0x' + s); if (r && r.length >= 66) { sold = Number(BigInt(r.slice(0, 66))); break; } }
  if (sold != null) for (const s of CAP_SELS) { if (!code.includes(s)) continue; const r = await call(c, '0x' + s); if (r && r.length >= 66) { const x = Number(BigInt(r.slice(0, 66))); if (x > 10 && x >= sold && x < 1e12) { cap = x; break; } } }
  if (sold != null && cap) return { progress: sold / cap, sold, cap, how: '已售／上限' };
  S.prog = S.prog || {}; let pg = S.prog[c];
  const tok = tokAddr || c;
  if (!pg) {
    const head = parseInt(await rpc('eth_blockNumber', []), 16);
    const has = async (b) => (((await rpc('eth_getCode', [c, '0x' + b.toString(16)]).catch(() => '0x')) || '0x').length > 2);
    let lo = head - 400000, hi = head; if (await has(lo)) { S.prog[c] = { none: 1 }; return { progress: null, sold, cap }; }
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (await has(m)) hi = m; else lo = m; }
    let init = 0n; for (const b of [hi, hi + 1, hi + 5, hi + 20]) { const r = await rpc('eth_call', [{ to: tok, data: '0x70a08231' + wa(c) }, '0x' + b.toString(16)]).catch(() => null); if (r && r.length >= 66 && BigInt(r.slice(0, 66)) > 0n) { init = BigInt(r.slice(0, 66)); break; } }
    pg = S.prog[c] = init > 0n ? { init: init.toString(), tok } : { none: 1 };
  }
  if (pg.none) return { progress: null, sold, cap };
  const now = decodeAbiUint(await call(pg.tok, '0x70a08231' + wa(c)));
  if (now === null) return { progress: null, sold, cap };
  const init = BigInt(pg.init); const ratio = Number(init - now) / Number(init);
  return { progress: ratio >= 0 && ratio < 0.999 ? ratio : null, sold, cap, how: ratio >= 0.999 ? '库存耗尽但无法证明已售完' : '鑄造池剩餘' };
}

// ---------- 防「連續發盤釣魚」：同一份合約程式碼（換名字重複部署）24 小時內出現 3 次以上 → 視為批量發盤，付費／手續費一律不打 ----------
function codePrint(code) { const c = (code || '').toLowerCase().replace(/0x/, ''); return c.length + ':' + c.slice(0, 120) + c.slice(-120); }
function noteDeploy(code) { const fp = codePrint(code); S.fps = S.fps || {}; const now = Date.now(); const arr = (S.fps[fp] || []).filter((t) => now - t < 86400e3); arr.push(now); S.fps[fp] = arr.slice(-20); if (Object.keys(S.fps).length > 3000) S.fps = {}; return arr.length; }
function isSerial(code) { const arr = (S.fps || {})[codePrint(code)] || []; return arr.filter((t) => Date.now() - t < 86400e3).length >= 3; }

// ---------- 第三層：查項目方底細 ----------
async function deployerOf(c) {
  S.deployer = S.deployer || {}; if (S.deployer[c]) return S.deployer[c];
  const ow = await call(c, '0x8da5cb5b'); if (ow && ow.length >= 66 && BigInt(ow.slice(0, 66)) > 0n) return (S.deployer[c] = '0x' + ow.slice(26, 66));
  return '';
}
async function freshWallet(a) { // 部署者是不是大約 8 小時內才開始用的新錢包（查不到就當不是）
  try { const head = parseInt(await rpc('eth_blockNumber', []), 16); const old = await rpc('eth_getTransactionCount', [a, '0x' + (head - 60000).toString(16)]); const now = await rpc('eth_getTransactionCount', [a, 'latest']); return parseInt(old, 16) === 0 && parseInt(now, 16) < 50; } catch { return false; }
}
// 重複 DEV：同一個部署者 24 小時內發 3 個以上 Agent ID 項目 → 硬性不鑄造（免費、手續費、付費全部）
function noteDev(dep, c) { if (!dep) return; S.devs = S.devs || {}; const now = Date.now(); const arr = (S.devs[dep] || []).filter((x) => now - x.t < 86400e3 && x.c !== c); arr.push({ t: now, c }); S.devs[dep] = arr.slice(-30); if (Object.keys(S.devs).length > 5000) S.devs = {};
  (async () => { let n = tokStr(await call(c, '0x95d89b41')) || tokStr(await call(c, '0x06fdde03')); if (!n) { const tr = await call(c, '0xfc0c546a'); if (tr && tr.length >= 66 && BigInt(tr.slice(0, 66)) > 0n) n = tokStr(await call('0x' + tr.slice(26, 66), '0x95d89b41')); } const e = (S.devs[dep] || []).find((x) => x.c === c); if (e && n) e.n = n; })().catch(() => {}); }

const devKey = (x) => String(x.n || S.paid?.[x.c]?.name || x.c).toLowerCase().replace(/\s*\(.*?\)\s*/g, '').replace(/^\$/, '').trim();
const DEV_MAX = 10; // 使用者 11/1 14:21：同一個部署者 24 小時內部署 ≥10 個項目就不打（大量部署收手續費的那種）
async function serialDev(c) { const dep = (S.depFrom || {})[c]; if (!dep) return ''; /* 只用「實際送出部署交易的錢包」判斷，不用 owner()（發射台的項目 owner 常是同一個平台，會誤殺） */ const n = new Set(((S.devs || {})[dep] || []).filter((x) => Date.now() - x.t < 86400e3).map((x) => x.c)).size; return n >= DEV_MAX ? `同一個部署者 ${dep.slice(0, 10)}… 24 小時內部署了 ${n} 個項目` : ''; }
function isRepeatDev(dep) { return !!dep && new Set(((S.devs || {})[dep] || []).filter((x) => Date.now() - x.t < 86400e3).map(devKey)).size >= 3; }
function blacklist(dep, why) { if (!dep) return; S.black = S.black || {}; if (!S.black[dep]) { S.black[dep] = { at: ts(), why }; log(`黑名單：${dep}（${why}）`); } }

const heatTier = (P) => ((P.agents || 0) >= 200 || (P.burst || 0) >= 30 ? 2 : (P.agents || 0) >= 100 || (P.burst || 0) >= 15 ? 1 : 0);
async function ownerHeavy(c, name) {
  S.ownerWarn ||= {}; if (S.ownerWarn[c]) return;
  let token = c; const tr = await call(c, '0xfc0c546a'); if (tr && tr.length >= 66 && BigInt(tr.slice(0, 66)) > 0n) token = '0x' + tr.slice(26, 66);
  const total = decodeAbiUint(await call(token, '0x18160ddd')); if (total === null || total <= 0n) return;
  const owners = new Set(); const owner = await call(c, '0x8da5cb5b'); if (owner && owner.length >= 66 && BigInt(owner.slice(0, 66)) > 0n) owners.add('0x' + owner.slice(26, 66).toLowerCase());
  if (/^0x[a-f0-9]{40}$/i.test(S.depFrom?.[c] || '')) owners.add(S.depFrom[c].toLowerCase());
  for (const address of owners) {
    const code = await rpc('eth_getCode', [address, 'latest']); if (code !== '0x' && code !== '0x0') continue;
    const balance = decodeAbiUint(await call(token, '0x70a08231' + wa(address))); if (balance === null) continue;
    const percent = Number(balance * 10000n / total) / 100;
    if (percent > 30) { S.ownerWarn[c] = { at: Date.now(), address, percent }; await tg(`⚠️ ${name || c}：项目方钱包持有 ${percent}% 代币，可能集中抛售（仅提醒）\n${c}`); return; }
  }
}
function markUnmintable(c, P, sym, progress, why = '要官網簽名或白名單') { P.lastReason = why; // 達到進場條件但我們打不了：標記不再重試，通知使用者一次
  if (P.unmintable) return; P.unmintable = ts(); P.unmintableAt = Date.now();
  log(`打不了 ${c}（${sym}）：${why}`);
  if (false && (heatTier(P) >= 1 || ((progress || 0) >= 0.4 && (progress || 0) < 0.95))) tg(`⚠️ ${sym || P.name || '新項目'} 達到進場條件（累計 ${P.agents || 0} 個代理人${progress > 0 ? '，進度約 ' + Math.round(progress * 100) + '%' : ''}），但工具打不了：${why}。要的話請手動\n${c}`).catch(() => {});
}
function noteFail(c, P, sym, progress) { P.cf = (P.cf || 0) + 1; if (P.cf >= 8) markUnmintable(c, P, sym, progress, '模擬鑄造一直失敗，可能已賣完、要官網簽名、白名單或已關閉'); } // 重試 4 輪（兩個錢包）都失敗就不再試
const agentCache = new Map(); // 地址 → 有沒有 .ai Agent ID
async function rpcBatch(reqs) { const out = []; for (let i = 0; i < reqs.length; i += 100) { for (const u of ['https://bsc-rpc.publicnode.com', 'https://bsc-dataseed.bnbchain.org', 'https://bsc.publicnode.com']) { let got = 0; try { const j = await (await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(reqs.slice(i, i + 100).map((r, k) => ({ jsonrpc: '2.0', id: i + k, ...r }))), signal: AbortSignal.timeout(20000) })).json(); for (const r of (Array.isArray(j) ? j : [])) if (r.result !== undefined) { out[r.id] = r.result; got++; } } catch {} if (got) break; } } return out; } /* 除錯 11/1：只用一個節點，被限流時整批查不到 → Agent ID 人數算成 0（GOOSE 534 人在打卻顯示 0） */
async function heatOf(c, P) { // Only transaction senders with a verified Agent ID count.
  const hadHeat = Boolean(P.heatAt); P.agents = 0; P.burst = 0; P.heatAt = 0;
  const head = parseInt(await rpc('eth_blockNumber', []), 16); let tok = ''; const tr = await call(c, '0xfc0c546a'); if (tr && tr.length >= 66 && BigInt(tr.slice(0, 66)) > 0n) tok = '0x' + tr.slice(26, 66).toLowerCase();
  const last = new Map(), hashes = new Map(), skip = new Set([c, tok, '0x0000000000000000000000000000000000000000', '0x000000000000000000000000000000000000dead']);
  const span = hadHeat ? 6000 : 20000;
  for (let b = Math.max(0, head - span); b <= head; b += 10000) {
    const q = [{ address: tok ? [c, tok] : c, fromBlock: '0x' + b.toString(16), toBlock: '0x' + Math.min(b + 9999, head).toString(16) }];
    const logs = await rpc('eth_getLogs', q).catch(() => logsRpc(q));
    if (!Array.isArray(logs)) throw new Error('无法核验参与交易日志');
    for (const record of logs) { const block = parseInt(record.blockNumber, 16); if (!record.transactionHash || !Number.isFinite(block)) continue; if (!hashes.has(record.transactionHash) || hashes.get(record.transactionHash) < block) hashes.set(record.transactionHash, block); }
  }
  const recent = [...hashes].sort((a, b) => b[1] - a[1]).slice(0, 800);
  if (recent.length) {
    const transactions = await rpcBatch(recent.map(([hash]) => ({ method: 'eth_getTransactionByHash', params: [hash] })));
    recent.forEach(([, block], index) => { const sender = String(transactions[index]?.from || '').toLowerCase(); if (!/^0x[0-9a-f]{40}$/.test(sender) || skip.has(sender)) return; if (!last.has(sender) || last.get(sender) < block) last.set(sender, block); });
  }
  const unknown = [...last.keys()].filter(address => !(agentCache.get(address)?.at > Date.now() - 60000)).slice(0, 800);
  if (unknown.length) {
    const res = await rpcBatch(unknown.map(address => ({ method: 'eth_call', params: [{ to: '0x' + REGISTRY, data: '0x70a08231' + wa(address) }, 'latest'] })));
    unknown.forEach((address, index) => { const value = res[index]; if (typeof value === 'string' && /^0x[0-9a-f]{64}$/i.test(value)) agentCache.set(address, { value: BigInt(value) > 0n, at: Date.now() }); });
  }
  let agents = 0, burst = 0; for (const [address, block] of last) { const proof = agentCache.get(address); if (proof?.at > Date.now() - 60000 && proof.value) { agents++; if (block >= head - 400) burst++; } }
  P.agents = agents; P.burst = burst; P.heatAt = Date.now();
}
const hk = (P) => (P.heatAt || 0) + (heatTier(P) >= 1 || (P.progress || 0) >= 0.2 ? 0 : 540e3);
async function observeFreeMint(c, P) {
  const progress = await freeProgress(c);
  const paidPhase = await othersPay(c); if (paidPhase === null) return; if (paidPhase) { queuePaidPhase(c); return; }
  const selected = WALLETS.find(W => entryGate({ progress, agents: P.agents || 0, policy: entryFor(W) }).allowed);
  if (!selected || S.freeNote?.[c] || progress == null && await poolOpen(c)) return;
  const code = await codeOf(c);
  const candidates = [...(P.replay?.data && !P.replay.payTok && BigInt(P.replay.value || '0') === 0n ? [P.replay.data] : []), ...CANDS.filter(([, data]) => validMintCalldata(data) && code.includes(data.slice(2, 10))).map(([, data]) => data)].slice(0, 40);
  for (const data of candidates) {
    if (badSel(data)) continue;
    try { await rpc('eth_call', [{ from: selected.addr, to: c, data, value: '0x0' }, 'latest']); }
    catch { continue; }
    await notifyFreeMint(c, progress, P.agents || 0, selected); return;
  }
}
async function heatWatch() { // 背景：替追蹤中的付費項目算熱度，看不懂的合約順便學別人的打法（不拖慢 15 秒的快速檢查）
  const signal = P => P.groupSignalAt && Date.now() - P.groupSignalAt < 86400e3;
  const signalFirst = P => signal(P) && !P.heatAt ? 1 : 0;
  const ents = Object.entries(S.paid || {}).filter(([c, P]) => !INFRA.has(c) && !P.unmintable && (P.progress || 0) < 0.999 && !WALLETS.every((W) => P.done?.[W.id]) && Date.now() - (P.at || 0) < 86400e3)
    .sort((a, b) => signalFirst(b[1]) - signalFirst(a[1]) || ((b[1].needLearn && (b[1].progress || 0) >= 0.45) - (a[1].needLearn && (a[1].progress || 0) >= 0.45)) || hk(a[1]) - hk(b[1]) || (b[1].at || 0) - (a[1].at || 0)).slice(0, 8); // 快滿或很熱的約每分鐘更新，其他約 10 分鐘；快到門檻又還不會打的排最前面（除錯 11/1：BNBCAT 57% 一直排不到）
  for (const [c, P] of ents) {
    try {
      await heatOf(c, P).catch((e) => log('heat ' + c + ' ' + e.message)); /* 除錯 11/1：算熱度被節點限流時，學打法也跟著被跳過 → 分開處理 */
      if ((P.needLearn || signal(P) && !P.replay && !P.recvValue) && (!P.replay || Date.now() - (P.replay.learnedAt || 0) > 120e3) && (heatTier(P) >= 1 || (P.progress || 0) >= 0.2 || (P.agents || 0) >= 20 || signal(P))) { const lr = await learnReplay(c).catch(() => null); if (lr?.recv) { P.recvValue = lr.recv; P.recvSeen = lr.recvSeen; P.recvVals = lr.recvVals; P.replay = { hot: lr.hot, learnedAt: lr.learnedAt }; delete P.needLearn; log(`學到 ${P.name || c} 的打法：直接轉 ${Number(BigInt(lr.recv)) / 1e18} BNB 就鑄造（${lr.recvSeen} 筆）`); } else if (lr) P.replay = lr; }
      await observeFreeMint(c, P).catch(error => log('免费项目通知检查 ' + c + ' ' + error.message));
    } catch (e) { log('heat ' + c + ' ' + e.message); }
  }
}
function freshDeadline(data) { /* 照抄的交易裡如果有「期限」（看起來像時間戳記的數字），換成 15 分鐘後，不然舊交易一定過期失敗（币安无忧 10/31） */
  const now = Math.floor(Date.now() / 1000); const ws = data.slice(10).match(/.{64}/g) || []; let ch = 0;
  const out = ws.map((x) => { const v = BigInt('0x' + x); if (v > BigInt(now - 30 * 86400) && v < BigInt(now + 30 * 86400)) { ch = 1; return (BigInt(now + 900)).toString(16).padStart(64, '0'); } return x; });
  return ch ? data.slice(0, 10) + out.join('') : data;
}
async function findCapSel(c, code, sold) { /* 從合約碼找無參數函式，回傳「像總量」的（大於已售、整百、≤1 千萬），優先 10000 */
  const hex = String(code || '').toLowerCase().replace(/^0x/, ''); const sels = new Set(); for (let i = 0; i < hex.length - 10; i += 2) if (hex.slice(i, i + 2) === '63') sels.add(hex.slice(i + 2, i + 10));
  const cand = []; for (const sel of [...sels].slice(0, 160)) { const r = await call(c, '0x' + sel); if (!r || r.length !== 66) continue; const v = Number(BigInt(r)); if (v > sold && v <= 1e7 && v % 100 === 0) cand.push([sel, v]); }
  if (!cand.length) return ''; cand.sort((x, y) => (y[1] === 10000) - (x[1] === 10000) || x[1] - y[1]); log(`找到 ${c} 的總量函式 0x${cand[0][0]} = ${cand[0][1]}`); return cand[0][0];
}
async function learnReplay(c) { // 學別人最近成功的鑄造：最常見的函式、要付多少 BNB／USDT、最近有幾個錢包在打
  if (!validMintAddress(c)) return null;
  const head = parseInt(await rpc('eth_blockNumber', []), 16);
  const L = await logsRpc([{ address: c, fromBlock: '0x' + (head - 1500).toString(16), toBlock: '0x' + head.toString(16) }]).catch(() => rpc('eth_getLogs', [{ address: c, fromBlock: '0x' + (head - 1500).toString(16), toBlock: 'latest' }]).catch(() => [])); /* 除錯 11/1：預設節點查事件常被限流（limit exceeded）→ 學不到打法；改用多節點輪替 */
  const hs = [...new Set((L || []).map((l) => l.transactionHash))].slice(-40);
  const all = (await Promise.all(hs.map((h) => rpc('eth_getTransactionByHash', [h]).catch(() => null)))).filter((t) => t && validMintAddress(t.from) && t.to && t.to.toLowerCase() === c.toLowerCase());
  let txs = all.filter((t) => validMintCalldata(t.input) && !badSel(t.input) && !t.input.toLowerCase().includes(t.from.slice(2).toLowerCase()));
  if (S.paid?.[c]?.freePhase) {
    const paying = [];
    for (const tx of txs) {
      const receipt = await rpc('eth_getTransactionReceipt', [tx.hash]).catch(() => null);
      if (String(receipt?.transactionHash).toLowerCase() !== String(tx.hash).toLowerCase() || !/^0x0?1$/i.test(receipt?.status || '')) continue;
      if (/^0x[0-9a-f]+$/i.test(tx.value || '') && BigInt(tx.value) > 0n || receiptUsdtPayment(receipt, tx.from)) paying.push(tx);
    }
    txs = paying;
  }
  { /* 除錯 11/1：BNBCAT 這種「直接轉 BNB 就鑄造」的合約，別人的交易沒有呼叫資料，以前學不到 → 進度過 55% 也一直沒打。現在學「大家最常轉的金額」 */
    const plain = all.filter((t) => (t.input || '0x') === '0x' && BigInt(t.value || '0x0') > 0n);
    if (plain.length >= 3 && plain.length >= txs.length) { const vc = {}; for (const t of plain) { const v = BigInt(t.value).toString(); vc[v] = (vc[v] || 0) + 1; } const top = Object.entries(vc).sort((x, y) => y[1] - x[1])[0]; const hot = new Set(plain.filter((t) => parseInt(t.blockNumber, 16) >= head - 400).map((t) => t.from.toLowerCase())).size; return { recv: top[0], recvSeen: top[1], recvVals: Object.keys(vc), hot, learned: 1, learnedAt: Date.now() }; }
  }
  if (!txs.length) return null;
  const cnt = {}; for (const t of txs) cnt[t.input.slice(0, 10)] = (cnt[t.input.slice(0, 10)] || 0) + 1;
  const sel = Object.entries(cnt).sort((a, b) => b[1] - a[1])[0][0];
  const cands = txs.filter((t) => t.input.startsWith(sel)).reverse().sort((a, b) => a.input.length - b.input.length); // 優先學最簡單的那種（別人帶了自己的 NFT 編號等額外參數的，照抄會失敗）
  for (const pick of cands.slice(0, 3)) {
    const rc = await rpc('eth_getTransactionReceipt', [pick.hash]).catch(() => null); if (!rc || rc.status !== '0x1') continue;
    let payTok = '', payAmt = '0';
    for (const l of rc.logs || []) if (l.topics?.[0] === T_TRANSFER && l.topics.length === 3 && ('0x' + l.topics[1].slice(26)).toLowerCase() === pick.from.toLowerCase()) { payTok = l.address.toLowerCase(); payAmt = BigInt(l.data).toString(); break; }
    const hot = new Set(txs.filter((t) => parseInt(t.blockNumber, 16) >= head - 400).map((t) => t.from.toLowerCase())).size;
    return { data: pick.input, value: BigInt(pick.value).toString(), sampleData: pick.input, sampleValue: BigInt(pick.value).toString(), payTok, payAmt, hot, learned: 1, learnedAt: Date.now() };
  }
  return null;
}
async function repeatDevOk(dep, c, P) {
  const mine = devKey({ c, n: P.name });
  const others = ((S.devs || {})[dep] || []).filter((x) => x.c !== c);
  if (others.some((x) => devKey(x) === mine)) return '同名重新部署';
  for (const x of others) { // 他之前的項目有沒有正常開盤（池子還有錢、沒被抽走）
    let tk = x.c; const tr = await call(x.c, '0xfc0c546a'); if (tr && tr.length >= 66 && BigInt(tr.slice(0, 66)) > 0n) tk = '0x' + tr.slice(26, 66);
    for (const q of [WBNB, USDT]) { const pr = await call(FACTORY, '0xe6a43905' + wa(tk) + wa(q)); if (!pr || !(BigInt(pr) > 0n)) continue; const rs = await call('0x' + pr.slice(26), '0x0902f1ac'); if (rs && BigInt('0x' + rs.slice(2, 66)) > 0n && BigInt('0x' + rs.slice(66, 130)) > 0n) return '之前有項目正常開盤'; }
  }
  return '';
}
const memoC = new Map(); const cc = async (to, data, ttl = 600e3) => { const k = to + data, m = memoC.get(k); if (m && Date.now() - m.t < ttl) return m.v; const v = await call(to, data); memoC.set(k, { v, t: Date.now() }); if (memoC.size > 20000) memoC.clear(); return v; }; // 不常變的合約資料快取，加快檢查
const busyP = new Set(); // 同一個項目同時只處理一次（快速檢查和一般檢查分開跑，避免重複打）
async function paidLoop(mode = 'all', shard = null) {
  if (MONITOR_ONLY) return;
  syncWalletProfiles();
  for (const W of WALLETS) void recoverScannerWallet(W).catch(error => logWallet(W, '交易核对失败 ' + error.message));
  const mintWallets = WALLETS.filter(W => canWallet(W, 'mint'));
  if (!mintWallets.length) return;
  const paidSettings = mintWallets.map(W => paidFor(W));
  const PAID = { ...getPaidConfig(CONFIG), goPct: Math.min(...paidSettings.map(p => p.goPct)), maxAgeH: Math.max(...paidSettings.map(p => p.maxAgeH)) };
  if (S.umReset !== 3) { S.umReset = 3; for (const P of Object.values(S.paid || {})) { if (P.unmintable) { delete P.unmintable; P.fail = 0; P.cf = 0; if (P.replay?.learned) delete P.replay; } } } // 新版一次性：之前標記打不了的重新試
  S.paid = S.paid || {}; S.dyn = S.dyn || []; S.paidSpend = S.paidSpend || {};
  if (S.missed && !S.missedClean1) { S.missedClean1 = 1; for (const [k, m] of Object.entries(S.missed)) if (String(m.why || '').includes('保本')) delete S.missed[k]; } /* 照規則不打的不算錯過 */
  if (S.refundReset !== 1) { S.refundReset = 1; for (const P of Object.values(S.paid)) { delete P.refundOk; delete P.noRefundLog; } } /* 除錯 11/1：代理合約解析修正後，重新判斷一次有沒有退款機制 */
  resetPaidBudgetDay();
  if (S.progressFixV !== 2) { S.progressFixV = 2; for (const P of Object.values(S.paid)) if ((P.progress || 0) >= 0.999 && !P.progAt) { delete P.progress; delete P.swLog; } }
  let price = 0;
  if (!S.forceDone) S.forceDone = { '0xc7d563a7bd5af3de83567a67058b3eb9f285149e': 1 }; // VARC 早上已經打完
  for (const c of FORCE) if (S.forceDone[c] && S.paid[c]) delete S.paid[c];
  for (const c of FORCE) if (!S.paid[c] && !S.forceDone[c]) S.paid[c] = { at: Date.now(), name: '', done: {} }; // 審查修正：手動指定的項目打完就不再加回來重打
  if (!S.migrated2) { S.migrated2 = 1; for (const c of Object.keys(S.seenMints || {})) { if (S.paid[c]) continue; const cd = await codeOf(c); if ((cd.includes('e38fd349') && cd.includes('68bce8cd')) || (cd.includes('725c4058') && cd.includes('94bf804d'))) { S.paid[c] = { at: Date.now(), name: '', done: {} }; log('補登付費追蹤 ' + c); } } }
  // 進度 ≥40% 的（快滿的）每輪都看，不跟其他一百多個排隊；其餘輪流，每輪補到 16 個
  if (S.mixedPhaseV !== 1) { S.mixedPhaseV = 1; for (const [c, at] of Object.entries(S.freeNote || {}).slice(-100)) if (validMintAddress(c) && !S.paid[c] && typeof at === 'number' && Date.now() - at < PAID.maxAgeH * 3600000) S.paid[c] = { at, name: '', done: {}, needLearn: 1 }; for (const P of Object.values(S.paid)) for (const [id, status] of Object.entries(P.done || {})) if (status === 'free-notify') delete P.done[id]; }
  const all = Object.entries(S.paid);

  const hotP = all.filter(([c, P]) => FORCE.has(c) || ((Date.now() - (P.groupSignalAt || 0) < 86400e3 || (P.progress || 0) >= 0.45 || (fpCache.get(c)?.p || 0) >= 0.45 || (!(P.progress > 0) && Math.max(P.agents || 0, HOT.get(c)?.from.size || 0) >= 70)) && (P.progress || 0) < 0.999 && !P.unmintable)).filter(([c, P]) => !WALLETS.every((W) => P.done[W.id])).sort((a, b) => (b[1].progress || 0) - (a[1].progress || 0) || (b[1].agents || 0) - (a[1].agents || 0)).slice(0, 12); /* 已通过链上身份候选检查的群组热议项目也加入15秒快查，自动交易门槛不变。 */
  // 快速檢查（mode='hot'）每 15 秒只看快滿／很熱的；一般檢查（mode='rest'）另外在背景約每分鐘輪流看其他的，互不拖慢
  const rest = mode === 'hot' ? [] : all.filter((e) => !hotP.includes(e) && Date.now() - (e[1].at || 0) < 86400e3).sort((a, b) => (a[1].lastTry || 0) - (b[1].lastTry || 0) || (b[1].at || 0) - (a[1].at || 0)).slice(0, 16);
  const ents = mode === 'rest' ? rest : mode === 'hot' ? (shard == null ? hotP : hotP.filter((e, i) => i % 3 === shard)) : hotP.concat(rest); /* 快速檢查分 3 組同時跑（審查修正：一個一個查要 1 分多鐘） */
  for (const [c, P] of ents) {
    if (INFRA.has(c)) { delete S.paid[c]; continue; } // Agent ID 登記合約本身不是項目（註冊 .ai 身份），不打
    if (busyP.has(c)) continue; busyP.add(c); const tE = Date.now();
    try {
    P.lastTry = Date.now(); if (WALLETS.every((W) => P.done[W.id])) { if (FORCE.has(c)) { S.forceDone = S.forceDone || {}; S.forceDone[c] = 1; } delete S.paid[c]; continue; }
    if (Date.now() - P.at > PAID.maxAgeH * 3600e3) { delete S.paid[c]; continue; }
    const code = await codeOf(c);
    // 發現時還沒開的「免費」鑄造：之後每分鐘重試，一開就自動打
    const fcd = (P.progress || 0) >= ENTRY_POLICY.goPct - 0.02 || Math.max(P.agents || 0, HOT.get(c)?.from.size || 0) >= 70 ? 20e3 : 120e3; /* 除錯 11/1：快到 60% 的免費項目改成 20 秒重試一次（之前固定 2 分鐘，0xa69adf 在這 2 分鐘內從 63% 賣完） */
    if (Date.now() - (P.freeTryAt || 0) > fcd && !((P.progress || 0) > 0 && P.progress < ENTRY_POLICY.goPct - 0.02 && Date.now() - (P.freeTryAt || 0) < 600e3)) { /* 優化 11/1：進度讀得到且還沒到 58% 的免費項目，不用每 2 分鐘模擬一次（一晚 850 次白跑、還害節點限流）；改成 10 分鐘看一次，快到門檻才密集重試 */ P.freeTryAt = Date.now(); for (const W of mintWallets) { if (P.done[W.id]) continue; { const ff = await findFree(W.addr, c, code); if (!ff || P.qAt?.[W.id] > Date.now() - (fcd - 5e3)) continue; P.qAt = P.qAt || {}; P.qAt[W.id] = Date.now(); queueMint(c, ff.n, W, ff.v); logWallet(W, `之前還沒開的 ${P.name || c} 現在開了，按新规则检查（完全免费只通知）`); } } }
    let kind = code.includes('e38fd349') && code.includes('68bce8cd') ? 'bnb' : code.includes('725c4058') && code.includes('94bf804d') ? 'usdt' : null;
    let unit = 0n; // 一般 NFT：mint(數量) 付「單價 × 數量」BNB（像 Sentient Syndicate 的 PRICE）
    if (!kind && code.includes('a0712d68')) for (const sel of ['8d859f3e', 'a035b1fe', '6817c76c', '13faede6', '817b1cd2']) { if (!code.includes(sel)) continue; const r = await cc(c, '0x' + sel); if (r && r.length >= 66 && BigInt(r.slice(0, 66)) > 0n) { unit = BigInt(r.slice(0, 66)); kind = 'gen'; break; } }
    if (!kind && P.recvValue) kind = 'recv';
    if (P.replay && badSel(P.replay.data)) delete P.replay;
    if (!kind && P.replay?.data) kind = 'replay'; // 少見的鑄造函式：照別人的呼叫內容與金額打

    if (!kind || kind === 'replay') P.needLearn = 1; // 看不懂的合約：交給背景的熱度監測去學別人的打法，這裡不等
    if (!kind) continue;
    if (P.unmintable && P.unmintableAt && Date.now() - P.unmintableAt > 30 * 60e3 && (P.umN || 0) < 2) { P.umN = (P.umN || 0) + 1; delete P.unmintable; P.fail = 0; P.cf = 0; } // 30 分鐘後再試，最多再試 2 次（避免付 USDT 的項目每半小時換一次 USDT 又失敗）
    if (P.unmintable && !FORCE.has(c)) continue;
    let soldR = await call(c, kind === 'bnb' || kind === 'gen' ? '0xa2309ff8' : '0x192fc516');
    if (kind === 'gen' && !(soldR && soldR.length >= 66)) soldR = await call(c, '0x18160ddd');
    if (!(soldR && soldR.length >= 66) && (kind === 'replay' || kind === 'recv')) { if (P.soldSel) soldR = await call(c, P.soldSel); else for (const sel of ['0x02c7e7af', '0xa2309ff8', '0x9106d7ba', '0xf4514d2e', '0x505e05fd', '0x3a98ef39']) { const r = await cc(c, sel, 60e3); if (r && r.length >= 66) { soldR = r; P.soldSel = sel; break; } } }
    const sold = soldR && soldR.length >= 66 ? Number(BigInt(soldR.slice(0, 66))) : null;
    let cap = null; { const r = await cc(c, '0xa0e23ebd'); if (r && r.length >= 66 && sold != null) { const x = Number(BigInt(r.slice(0, 66))); if (x >= 1000 && x <= 1e7 && x % 100 === 0) cap = Math.max(x, sold); } } if (!cap) for (const sel of ['0xd8f93498', '0xcef6feda', '0x29b80536', '0xd5abeb01', '0x32cb6b0c', '0x355274ea', '0x3a1d8d3a', '0xf1aee5a2', '0x85e3f997']) { const r = await cc(c, sel); if (r && r.length >= 66) { const x = Number(BigInt(r.slice(0, 66))); if (x > 0 && sold != null && x >= sold && x < 1e12) { cap = x; break; } } }
    if (!cap && sold != null && sold > 0) { /* 審查 11/1：bibiai 發射台的總量函式不在常見清單（a0e23ebd=10000）→ 讀不到進度 → 被當成「讀不到＋很多人打」在 4% 就可能買；改成自動從合約裡找「總量」函式並記住 */
      if (P.capSel === undefined) P.capSel = await findCapSel(c, code, sold).catch(() => '') || '';
      if (P.capSel) { const r = await cc(c, '0x' + P.capSel, 600e3); if (r && r.length >= 66) { const x = Number(BigInt(r.slice(0, 66))); if (x > 0 && x < 1e9) cap = Math.max(x, sold); } } /* 已售超過總量＝賣完（AID 賣到 10246／10000 時被讀成 0.23%） */
    }
    let tokAddr0 = ''; { const tr0 = await cc(c, '0xfc0c546a', 3600e3); if (tr0 && tr0.length >= 66 && BigInt(tr0.slice(0, 66)) > 0n) tokAddr0 = '0x' + tr0.slice(26, 66); }
    let progress = cap && sold != null ? sold / cap : null, how = '已售／上限';
    if (progress === null) { const pr = await progressOf(c, code, tokAddr0); progress = typeof pr.progress === 'number' && Number.isFinite(pr.progress) && pr.progress >= 0 ? pr.progress : null; how = pr.how || ''; }
    // A low on-chain progress stays low; it cannot be replaced by unknown to bypass the gate.
    const prevProg = P.progress; P.progress = progress; P.progAt = Date.now();
    if (progress >= 0.95 && !P.noRefundLog && !P.serialLog && !String(P.lastReason || '').includes('保本') && !String(P.lastReason || '').includes('部署者') && !(await serialDev(c)) && !WALLETS.some((W) => P.done[W.id] && !['pool-open', 'fail', 'unknown'].includes(P.done[W.id]))) { /* 照規則不打（沒有保本）的不算錯過 */ S.missed = S.missed || {}; if (!S.missed[c]) { S.missed[c] = { name: P.name || c.slice(0, 10), at: ts(), why: P.lastReason || (P.unmintable ? '打不了' : '還沒找到能打的方式') }; log(`錯過 ${c}（${S.missed[c].name}）：進度已 ${Math.round(progress * 100)}%，我們沒打到，原因：${S.missed[c].why}`); } } /* 讓自己更聰明：記下快賣完卻沒打到的項目和原因，每晚總結列出來，方便找出要補的漏洞 */
    if (progress >= 0.7 && progress <= 1 && (prevProg != null ? prevProg < 0.7 : Date.now() - P.at < 6 * 3600e3)) groupProgress(c, P.name, progress).catch(() => {});
    { const now = Date.now(); P.ph = (P.ph || []).filter((x) => now - x.t < 15 * 60e3); if (!P.ph.length || now - P.ph[P.ph.length - 1].t > 10e3) P.ph.push({ t: now, p: progress }); }
    price = price || (await bnbUsd());
    const projectInfo = await MINT_RISK.contractInfo(c);
    const needPct = effectiveEntryPolicy(ENTRY_POLICY, PAID.goPct, { nft: projectInfo.nft }).goPct;
    const entry = entryGate({ progress, agents: P.agents || 0, configuredPct: PAID.goPct, policy: ENTRY_POLICY, nft: projectInfo.nft });
    if (!entry.allowed) { P.lastReason = entry.reason; continue; }
    { const sd = await serialDev(c); if (sd) { if (!P.serialLog) { P.serialLog = 1; P.lastReason = sd + '，照規則不打'; if (S.missed?.[c]) delete S.missed[c]; log(`跳過 ${P.name || c}：${sd}，照規則不打`); } continue; } }
    {
      const paying = !(kind === 'replay' && !(BigInt(P.replay?.value || '0') > 0n) && !P.replay?.payTok);
      if (!paying) {
        const paidPhase = await othersPay(c); if (paidPhase === null) continue; if (paidPhase) { queuePaidPhase(c); continue; }
        const eligible = mintWallets.find(W => entryGate({ progress, agents: P.agents || 0, policy: entryFor(W, projectInfo.nft), nft: projectInfo.nft }).allowed);
        if (eligible) { await notifyFreeMint(c, progress, P.agents || 0, eligible); for (const W of mintWallets) P.done[W.id] ||= 'free-notify'; } continue;
      }
      if (!projectInfo.limit) { P.lastReason = projectInfo.nft ? 'NFT 必须有可核验的每钱包数量上限' : '付费项目须有可核验的每钱包或每笔数量上限'; continue; }
    }
    if (!P.goLogged) { P.goLogged = 1; void ownerHeavy(c, P.name).catch(error => log('项目方持仓检查 ' + error.message)); log(`進場 ${c}：${progress != null ? '进度过 ' + Math.round(needPct * 100) + '%' : '进度未知、' + ENTRY_POLICY.minAgents + ' 个以上交易钱包'}（累計 ${P.agents || 0} 個代理人、3 分鐘 ${P.burst || 0} 個），進度 ${progress > 0 ? Math.round(progress * 100) + '%' : '讀不到'}`); }
    // 防釣魚：① 同款合約 24 小時內被部署 3 次以上（批量發盤）不打 ② 進度要是很多人打出來的（至少 20 個不同錢包），不是項目方自己刷的
    { const dep = P.deployer !== undefined ? P.deployer : await deployerOf(c); P.deployer = dep;
      if (dep && !(S.devs?.[dep] || []).some((x) => x.c === c)) noteDev(dep, c);
      if (dep && S.black?.[dep]) { if (!P.blackLogged) { P.blackLogged = 1; log(`跳過 ${c}：部署者 ${dep} 在黑名單（${S.black[dep].why}）`); } continue; }
      if (dep && P.fresh == null) P.fresh = await freshWallet(dep);
      if (P.fresh) { if (!P.freshLogged) { P.freshLogged = 1; log(`跳過 ${c}：部署者 ${dep} 是剛建立的新錢包`); } continue; }
      // 錢流：合約裡幾乎沒留 BNB、也還沒開池 → 錢多半直接流進項目方錢包，要求更多人打過（40 個）才算可信
      if (P.drain == null) { const cb = Number(BigInt((await rpc('eth_getBalance', [c, 'latest']).catch(() => '0x0')) || '0x0')) / 1e18; const pr = tokAddr0 || c; const pair = await call(FACTORY, '0xe6a43905' + wa(pr) + wa(WBNB)); P.drain = cb < 0.01 && !(pair && BigInt(pair) > 0n); }

      P.needW = 0;
      if (isRepeatDev(dep)) {
        if (P.repeatOk == null || Date.now() - (P.repeatAt || 0) > 600e3) { P.repeatOk = await repeatDevOk(dep, c, P); P.repeatAt = Date.now(); }
        if (!P.repeatOk) { if (P.drain) { if (!P.devLogged) { P.devLogged = 1; log(`跳過 ${c}：重複 DEV ${dep}，沒有開盤紀錄，而且錢直接流走`); } continue; } P.needW = 40; }
        else if (!P.devLogged) { P.devLogged = 1; log(`重複 DEV ${dep} 但照打 ${c}（${P.repeatOk}）`); }
      }
    }
    // 使用者定：只打新的 → 兩天前就部署的老合約不打
    { if (P.old == null) { const head = parseInt(await rpc('eth_blockNumber', []), 16); const o = await rpc('eth_getCode', [c, '0x' + (head - 400000).toString(16)]).catch(() => '0x'); P.old = !!o && o.length > 2; } if (P.old) { for (const W of WALLETS) P.done[W.id] = P.done[W.id] || 'old'; continue; } }
    // 已經開池交易的項目不再自動鑄造（鑄造≈用市價買，不划算）
    if (progress === null) { const tk = tokAddr0 || c; if (await poolOpen(tk)) { if (!P.poolSkipLog) { P.poolSkipLog = 1; log(`跳過 ${c}：已經開池交易，读不到进度时不在开池后铸造`); } continue; } } /* 審查 11/1：以前會直接標記完成並刪掉，讀錯一次就永遠不打 */
    if (isSerial(code)) { if (!P.serialLogged) { P.serialLogged = 1; log(`跳過 ${c}：同款合約 24 小時內部署 3 次以上，疑似批量發盤`); } continue; }
    { const need = Math.max(P.drain ? 40 : 20, P.needW || 0); const seen = Math.max(P.wallets || 0, HOT.get(c)?.from.size || 0, P.agents || 0); /* 熱度算到的 Agent ID 錢包數也算（USDT 鑄造、幣先鎖住的項目沒有轉帳紀錄可數） */ if (seen < need) { if (Date.now() - (P.wAt || 0) < 60e3) continue; P.wAt = Date.now(); const r = await rpc('eth_getLogs', [{ address: tokAddr0 || c, fromBlock: '0x' + (parseInt(await rpc('eth_blockNumber', []), 16) - 3000).toString(16), toBlock: 'latest', topics: [T_TRANSFER] }]).catch(() => []); const uniq = new Set((r || []).map((l) => l.topics[2])).size; P.wallets = Math.max(P.wallets || 0, uniq); if (uniq < need) continue; } }
    const limitUsd = Infinity;
    let tokAddr = ''; const tr = await cc(c, '0xfc0c546a', 3600e3); if (tr && tr.length >= 66) tokAddr = '0x' + tr.slice(26, 66);
    const sym = tokAddr ? tokStr(await cc(tokAddr, '0x95d89b41', 3600e3)) || P.name || c.slice(0, 8) : P.name || c.slice(0, 8);
    await Promise.allSettled(mintWallets.map((W) => withMintWalletLock(W, async () => {
      if (P.done[W.id] || !canWallet(W, 'mint')) return;
      const paid = paidFor(W), PAID = { ...paid, maxUsd: Math.min(paid.maxUsd, projectInfo.nft ? 10 : paid.maxUsd) };
      if (Date.now() - P.at > PAID.maxAgeH * 3600e3 || !entryGate({ progress, agents: P.agents || 0, policy: entryFor(W, projectInfo.nft), nft: projectInfo.nft }).allowed) return;
      try {
        price = price || (await bnbUsd());
        const spent = resetPaidBudgetDay()[W.id] || 0;
        const bal = Number(BigInt((await rpc('eth_getBalance', [W.addr, 'latest'])) || '0x0')) / 1e18;
        const fitsBudget = (bnb, usd = bnb * price) => withinPaidBudget(PAID, { spentBnb: spent, costBnb: bnb, costUsd: usd, balanceBnb: bal });
        let n = Math.min(10, projectInfo.limit?.value || 1), costWei = 0n;
        if (kind === 'replay' && P.replay.payTok) {
          if (P.replay.payTok !== USDT) return;
          if (Date.now() - (P.replay.learnedAt || 0) > 90e3) { const learned = await learnReplay(c).catch(() => null); if (learned) P.replay = { ...P.replay, ...learned }; }
          const prepared = prepareUsdtReplay({ ...P.replay, data: freshDeadline(P.replay.data) }, PAID.maxUsd, price);
          if (!prepared) return;
          const r = await executeUsdtMint(W, { to: c, ...prepared });
          P.done[W.id] = 'minted';
          trackFromSim(W, r.sim, sym, r.usd, r.tx, tokAddr);
          if (tokAddr && !S.dyn.some((token) => token.addr === tokAddr.toLowerCase() && token.only === W.addr)) S.dyn.push({ sym, addr: tokAddr.toLowerCase(), cost: r.usd, only: W.addr, deployer: P.deployer, boughtAt: Date.now() });
          await tg(`🛒 [${W.name}] 自动铸造付费 Agent ID 项目：${sym}（USDT）\n支出预算约 ${r.usd.toFixed(2)}U\n${c}\n交易 ${r.tx}`);
          return;
        }
        if (kind === 'replay') {
          if (Date.now() - (P.replay.learnedAt || 0) > 90e3) { const lr = await learnReplay(c).catch(() => null); if (lr) P.replay = { ...P.replay, ...lr }; } /* 用最新的別人交易（價格參數要新） */
          if (!/^\d+$/.test(P.replay.sampleValue || '') || !validMintCalldata(P.replay.sampleData)) { const sample = await learnReplay(c).catch(() => null); if (!sample?.sampleValue || !sample.sampleData) { P.needLearn = 1; return; } P.replay = { ...P.replay, ...sample }; }
          let v = BigInt(P.replay.value || '0'); let vb = Number(v) / 1e18;
          if (price && vb * price > PAID.maxUsd && P.replay.data) { /* 審查 11/1：學到的金額超過 20U 時，第一個參數是份數就按比例降份數＋金額，不再直接放棄 */
            const w0 = P.replay.data.slice(10, 74); const n0 = w0.length === 64 ? Number(BigInt('0x' + w0)) : 0;
            if (n0 >= 2 && n0 <= 100) { const n1 = Math.floor((PAID.maxUsd / (vb * price)) * n0); if (n1 >= 1) { v = (v * BigInt(n1)) / BigInt(n0); vb = Number(v) / 1e18; P.replay = { ...P.replay, data: P.replay.data.slice(0, 10) + n1.toString(16).padStart(64, '0') + P.replay.data.slice(74), value: v.toString() }; log(`照抄金額超過預算，份數 ${n0}→${n1}：${c}`); } }
          }
          if (!price || !fitsBudget(vb) || vb * 1.005 > bal - PAID.keepBnb) return;
          let rdata = freshDeadline(P.replay.data); try { rdata = await safeAddrs(W, c, rdata, v); const rd0 = rdata; rdata = await fitShares(W, c, rdata, v); v = scaleV(rd0, rdata, v); vb = Number(v) / 1e18; } catch (e) { if (/額度|quota|已打滿/.test(e?.message || '')) P.done[W.id] = 'full'; else noteFail(c, P, sym, progress); return; } /* 審查修正：付 BNB 的照抄也要換掉別人的地址、自動調份數 */
          { /* 使用者 10/31 19:16「用這種邏輯去優化」：照抄失敗時不馬上放棄——先換最新樣本再試，再試「價格上限 +2%」（只在交易內容裡有跟付款金額一樣的上限數字時） */
            const ok = async (d, val) => { try { await rpc('eth_call', [{ from: W.addr, to: c, data: d, value: '0x' + val.toString(16) }, 'latest']); return true; } catch { return false; } };
            let good = await ok(rdata, v);
            if (!good) { const lr = await learnReplay(c).catch(() => null); if (lr?.data) { P.replay = { ...P.replay, ...lr }; const v2 = BigInt(lr.value || '0'); let d2 = freshDeadline(lr.data); let v2s = v2; try { d2 = await safeAddrs(W, c, d2, v2); const dd = d2; d2 = await fitShares(W, c, d2, v2); v2s = scaleV(dd, d2, v2); } catch {} if (fitsBudget(Number(v2s) / 1e18) && (Number(v2s) / 1e18) * 1.005 <= bal - PAID.keepBnb && await ok(d2, v2s)) /* 審查 11/1：重新學到的金額也要在 20U 預算和餘額內 */ { rdata = d2; v = v2s; vb = Number(v) / 1e18; good = true; } } }
            if (!good && v > 0n) for (const pct of [102n, 105n, 110n, 120n]) { /* 除錯 11/1：AID 價格從 0.0204 漲到 0.022（+8%），舊的只試 +2% → 合約回 MAX_COST 打不了；改成 +2%～+35% 一路試，金額在 20U 預算與餘額內 */
              const vU = (v * pct) / 100n, ceiling = scaleV(P.replay.sampleData, rdata, BigInt(P.replay.sampleValue)) * 120n / 100n; if (vU > ceiling || !fitsBudget(Number(vU) / 1e18) || (Number(vU) / 1e18) * 1.005 > bal - PAID.keepBnb) break;
              const ws = rdata.slice(10).match(/.{64}/g) || []; let hit = 0; const d3 = rdata.slice(0, 10) + ws.map((x) => { const y = BigInt('0x' + x); if (y > 0n && y * 1000n >= v * 995n && y * 1000n <= v * 1005n) { hit = 1; return vU.toString(16).padStart(64, '0'); } return x; }).join('');
              if (await ok(hit ? d3 : rdata, vU)) { rdata = hit ? d3 : rdata; v = vU; vb = Number(v) / 1e18; good = true; log(`照抄時金額 +${pct - 100n}% 才過：${c}`); P.replay = { ...P.replay, data: rdata, value: v.toString() }; break; }
            }
            if (!good) { noteFail(c, P, sym, progress); return; } /* 審查 11/1：一次失敗就標打不了 → 改成累計 8 次 */
          }
          if (v > scaleV(P.replay.sampleData, rdata, BigInt(P.replay.sampleValue)) * 120n / 100n || !fitsBudget(vb)) return;
          const r = await previewExec(W, c, rdata, v, (sim) => {
            const mine = (sim?.balanceChanges || []).filter((b) => String(b.owner).toLowerCase() === W.addr);
            if (sim?.allowanceChanges?.length || sim?.authorityChanges?.length) return '有授權變化';
            const out = mine.filter((b) => Number(b.change) < 0); if (out.some((b) => !String(b.contractAddress).toLowerCase().startsWith('0xeeee')) || out.reduce((a, b) => a - Number(b.change), 0) > Number(v) * 1.01) return '會扣到 BNB 以外或超過金額';
            if (!mine.some((b) => Number(b.change) > 0)) return '模擬沒拿到東西'; return '';
          });
          S.paidSpend[W.id] = spent + vb; P.done[W.id] = 'minted';
          if (!(v > 0n)) { trackFromSim(W, r.sim, sym, 0, r.tx); noteFree(c, W, sym); return; }
          trackFromSim(W, r.sim, sym, vb * price, r.tx);
          await tg(`🛒 [${W.name}] 自動打了付費 Agent ID 項目：${sym}（照別人的鑄造方式）\n花 ${vb.toFixed(4)} BNB（約 ${(vb * price).toFixed(1)}U）· 進度約 ${Math.round(progress * 100)}%\n${c}\n交易 ${r.tx}`);
          return;
        }
        if (kind === 'recv') {
          let v = BigInt(P.recvValue);
          if (price && (Number(v) / 1e18) * price > PAID.maxUsd) { /* 除錯 11/1：大家最常轉的金額超過 20U 預算（BNBCAT 10 份＝0.03 BNB≈21U）時，改用別人轉過、在預算內最大的金額，不再直接放棄 */
            const ok = (P.recvVals || []).map((x) => BigInt(x)).filter((x) => (Number(x) / 1e18) * price <= PAID.maxUsd).sort((x, y) => (x > y ? -1 : 1)); if (ok.length) v = ok[0]; }
          const vb = Number(v) / 1e18;
          if (!price || !fitsBudget(vb) || vb * 1.005 > bal - PAID.keepBnb) return;
          try { await rpc('eth_call', [{ from: W.addr, to: c, value: '0x' + v.toString(16) }, 'latest']); } catch { noteFail(c, P, sym, progress); if ((P.cf || 0) >= 3) { delete P.recvValue; delete P.replay; P.needLearn = 1; } return; } /* 審查 11/1：轉 BNB 金額可能學錯，失敗幾次就重學 */ // 不能鑄（沒資格、已打過、額度滿）
          const r = await previewExec(W, c, '0x', v, (sim) => {
            const mine = (sim?.balanceChanges || []).filter((b) => String(b.owner).toLowerCase() === W.addr);
            if (sim?.allowanceChanges?.length || sim?.authorityChanges?.length) return '有授權變化';
            const out = mine.filter((b) => Number(b.change) < 0); if (out.some((b) => !String(b.contractAddress).toLowerCase().startsWith('0xeeee')) || out.reduce((a, b) => a - Number(b.change), 0) > Number(v) * 1.01) return '會扣到 BNB 以外或超過金額';
            if (!mine.some((b) => Number(b.change) > 0)) return '模擬沒拿到代幣'; return '';
          });
          S.paidSpend[W.id] = spent + vb; P.done[W.id] = 'minted';
          const ta = tokAddr0 || c; trackFromSim(W, r.sim, sym, vb * price, r.tx, ta);
          const tracked = S.dyn.find(token => token.addr === ta.toLowerCase() && token.only === W.addr); if (tracked) tracked.deployer = P.deployer;
          await tg(`🛒 [${W.name}] 自動打了「轉 BNB 鑄造」項目：${sym}\n轉 ${vb} BNB（約 ${(vb * price).toFixed(1)}U，${P.recvSeen} 個錢包都轉這個金額）· 進度約 ${Math.round(progress * 100)}%（${how}）\n${c}\n交易 ${r.tx}`);
          return;
        }
        if (kind === 'gen') {
          let data = '';
          for (; n >= 1; n--) { costWei = unit * BigInt(n); if ((Number(costWei) / 1e18) * 1.005 > bal - PAID.keepBnb || !price || !fitsBudget(Number(costWei) / 1e18)) continue; data = '0xa0712d68' + w(n); try { await rpc('eth_call', [{ from: W.addr, to: c, data, value: '0x' + costWei.toString(16) }, 'latest']); break; } catch {} }
          if (n < 1) { noteFail(c, P, sym, progress); return; }
          const r = await previewExec(W, c, data, costWei, (sim) => {
            const mine = (sim?.balanceChanges || []).filter((b) => String(b.owner).toLowerCase() === W.addr);
            if (sim?.allowanceChanges?.length || sim?.authorityChanges?.length) return '有授權變化';
            const out = mine.filter((b) => Number(b.change) < 0); if (out.some((b) => !String(b.contractAddress).toLowerCase().startsWith('0xeeee')) || out.reduce((a, b) => a - Number(b.change), 0) > Number(costWei) * 1.01) return '會扣到 BNB 以外或超過價格';
            if (!mine.some((b) => Number(b.change) > 0)) return '模擬沒拿到東西'; return '';
          });
          const vb = Number(costWei) / 1e18; S.paidSpend[W.id] = spent + vb; P.done[W.id] = 'minted';
          trackFromSim(W, r.sim, sym, vb * price, r.tx);
          await tg(`🛒 [${W.name}] 自動打了付費 Agent ID 項目：${sym}\n${n} 份，花 ${vb.toFixed(4)} BNB（約 ${(vb * price).toFixed(1)}U）· 進度約 ${Math.round(progress * 100)}%（${sold ?? '?'}／${cap ?? '?'}）\n${c}\n交易 ${r.tx}`);
          return;
        }
        if (kind === 'bnb') {
          for (; n >= 1; n--) { const q = await call(c, '0x68bce8cd' + w(n)); costWei = q ? BigInt(q.slice(0, 66)) : 0n; if (costWei > 0n && price && fitsBudget(Number((costWei * 1005n) / 1000n) / 1e18)) break; } // 含 0.5% 余量的实际支出也必须符合单笔与每日预算。
          if (n < 1) return; // 太貴：先不打（進度到 85% 後上限會放寬到 25U，會再檢查）
          const v = (costWei * 1005n) / 1000n, vb = Number(v) / 1e18;
          if (!fitsBudget(vb)) return;
          const data = '0xe38fd349' + w(n) + wa('0x0000000000000000000000000000000000000000') + w(v);
          try { await rpc('eth_call', [{ from: W.addr, to: c, data, value: '0x' + v.toString(16) }, 'latest']); } catch { noteFail(c, P, sym, progress); return; } // 還沒開或沒資格
          const pool = tokAddr ? Number(await poolOut(v, WBNB, tokAddr)) : 0;
          const r = await previewExec(W, c, data, v, (sim) => {
            if (pool > 0 && gotTok(sim, W) < pool * 1.1) log(`注意：${c} 已開池，鑄造沒有比池子便宜（新規則：进度与参与钱包均达门槛才参与）`);
            const mine = (sim?.balanceChanges || []).filter((b) => String(b.owner).toLowerCase() === W.addr);
            if (sim?.allowanceChanges?.length || sim?.authorityChanges?.length) return '有授權變化';
            const out = mine.filter((b) => Number(b.change) < 0); if (out.some((b) => !String(b.contractAddress).toLowerCase().startsWith('0xeeee')) || out.reduce((a, b) => a - Number(b.change), 0) > Number(v) * 1.01) return '會扣到 BNB 以外的資產或超過報價';
            if (!mine.some((b) => Number(b.change) > 0)) return '模擬沒拿到代幣'; return '';
          }, async () => { const q2 = await call(c, '0x68bce8cd' + w(n)); const c2 = q2 ? BigInt(q2.slice(0, 66)) : 0n; return c2 > (costWei * 105n) / 100n ? '價格剛剛漲了超過 5%' : ''; }); /* 新功能：送出前再查一次價格 */
          S.paidSpend[W.id] = spent + vb; P.done[W.id] = 'minted';
          const usd = vb * price; const tka = tokAddr && !/^0x0{40}$/i.test(tokAddr) ? tokAddr : tokAddr0; trackFromSim(W, r.sim, sym, usd, r.tx, tka);
          if (tka) { const tracked = S.dyn.find(token => token.addr === tka.toLowerCase() && token.only === W.addr); if (tracked) { tracked.deployer = P.deployer; if (FORCE.has(c)) tracked.hold = true; } }
          await tg(`🛒 [${W.name}] 自動打了付費 Agent ID 項目：${sym}\n${n} 份，花 ${vb.toFixed(4)} BNB（約 ${usd.toFixed(1)}U）· 已售 ${sold ?? '?'} 份 · 進度約 ${Math.round(progress * 100)}%\n${c}\n交易 ${r.tx}\n已加入監控：${ruleTxt()}`);
        } else {
          for (; n >= 1; n--) { const q = await call(c, '0x725c4058' + w(n)); costWei = q ? BigInt(q.slice(0, 66)) : 0n; if (costWei > 0n && price && fitsBudget(((Number(costWei) / 1e18) * 1.04) / price, Number(costWei) / 1e18)) break; }
          if (n < 1) return;
          const cu = Number(costWei) / 1e18;
          const data = '0x94bf804d' + w(n) + wa('0x0000000000000000000000000000000000000000');
          const r = await executeUsdtMint(W, { to: c, data, need: costWei, recheck: async () => { const q2 = await call(c, '0x725c4058' + w(n)); const c2 = q2 ? BigInt(q2.slice(0, 66)) : 0n; return c2 > (costWei * 105n) / 100n ? '價格剛剛漲了超過 5%' : ''; } });
          P.done[W.id] = 'minted';
          const tku = tokAddr && !/^0x0{40}$/i.test(tokAddr) ? tokAddr : tokAddr0; trackFromSim(W, r.sim, sym, r.usd, r.tx, tku);
          if (tku) { const tracked = S.dyn.find(token => token.addr === tku.toLowerCase() && token.only === W.addr); if (tracked) tracked.deployer = P.deployer; }
          await tg(`🛒 [${W.name}] 自動打了付費 Agent ID 項目：${sym}\n${n} 份，花 ${cu.toFixed(2)} USDT（由 BNB 換）· 已售 ${sold ?? '?'} 份 · 進度約 ${Math.round(progress * 100)}%\n${c}\n交易 ${r.tx}\n已加入監控：${ruleTxt()}`);
        }
      } catch (e) { if (e.message.includes('結果不明')) { P.done[W.id] = 'unknown'; save(true); logWallet(W, `paid ${c} ${e.message}`); await tg(`⚠️ [${W.name}] ${sym} 送出結果不明（逾時），為避免重打已停止，請到錢包確認有沒有打到\n${c}`); return; } if (e.message.includes('已開池')) { P.done[W.id] = 'pool-cheaper'; logWallet(W, `paid ${c} ${e.message}`); return; } if (/價格剛剛漲了/.test(e.message)) { logWallet(W, `paid ${c} ${e.message}（下一輪再打）`); return; } P.failW = P.failW || {}; P.failW[W.id] = (P.failW[W.id] || 0) + 1; P.fail = (P.fail || 0) + 1; logWallet(W, `paid ${c} ${e.message}`); if (kind === 'replay' && P.fail >= 6) { markUnmintable(c, P, sym, progress, '照別人的方式預演一直失敗'); return; } /* 審查 11/1：照抄型 2 次失敗就放棄太快、價格變動不算失敗、失敗按錢包算 */ if (P.failW[W.id] >= 6) { P.done[W.id] = 'fail'; await tg(`⚠️ [${W.name}] 付費項目 ${sym} 自動打失敗，已放棄：${e.message.slice(0, 150)}\n${c}`); } }
    })));
    } finally { busyP.delete(c); const dt = Date.now() - tE; if (dt > 10e3) log(`檢查 ${c} 花了 ${Math.round(dt / 1000)} 秒（${mode}）`); }
  }
}

async function loginCheck() {
  if (MONITOR_ONLY) return;
  syncWalletProfiles();
  await Promise.allSettled(WALLETS.map(async W => {
    if (!canWallet(W, 'mint') && !canWallet(W, 'token-sell')) return;
    const r = await W.baw(['wallet', 'status'], 30000);
    if (r.j?.data?.status === 'CONNECTED') {
      const st = await W.baw(['wallet', 'settings'], 30000), exp = Date.parse(st.j?.data?.devMode?.expiresAt || '');
      S.devAlert ||= {};
      if (exp && exp - Date.now() < 24 * 3600e3 && S.devAlert[W.id] !== exp) { S.devAlert[W.id] = exp; await tg(`⏰ [${W.name}] 开发者模式即将到期，请在对应币安 App 中续期；其他钱包继续运行`); }
      if (st.j?.data?.devMode && st.j.data.devMode.enabled === false && S.devAlert[W.id + ':off'] !== 1) { S.devAlert[W.id + ':off'] = 1; await tg(`⚠️ [${W.name}] 开发者模式已关闭，此钱包等待恢复`); }
      if (st.j?.data?.devMode?.enabled) S.devAlert[W.id + ':off'] = 0;
      return;
    }
    S.lastLoginAlert = S.lastLoginAlert && typeof S.lastLoginAlert === 'object' ? S.lastLoginAlert : {};
    if (Date.now() - (S.lastLoginAlert[W.id] || 0) < 6 * 3600e3) return;
    S.lastLoginAlert[W.id] = Date.now();
    await tg(`🔑 [${W.name}] 钱包登录已失效，此钱包的自动操作暂停。请到 Web「钱包管理」重新配对；其他钱包继续运行。`);
  }));
}



const ELEMENT_EX = '0xb3e3dfcb2d9f3dde16d78b9e6eb3538eb32b5ae1';
const T_721_FILLED = '0x9c248aa1a265aa616f707b979d57f4529bb63a4fc34dc7fc61fdddc18410f74e'; // Element ERC721SellOrderFilled
async function nftVolWatch() {
  S.nftCols = S.nftCols || {}; S.nftVol = S.nftVol || {};
  if (!S.nftColsBackfilled) { // 第一次：從日誌補回之前打到的 NFT 系列
    try { for (const l of readFileSync(LOG, 'utf8').split('\n')) { if (!l.includes('已自動鑄造') || !l.includes('NFT')) continue; const m = l.match(/\] (0x[a-fA-F0-9]{40}) /); if (m) S.nftCols[m[1].toLowerCase()] = 1; } } catch {}
    S.nftColsBackfilled = true;
  }
  const head = parseInt(await rpc('eth_blockNumber', []), 16), from = head - 96000; // 約 12 小時
  // 1) Element 成交（一次抓完再按系列分）
  const fills = {};
  for (let b = from; b <= head; b += 10000) {
    const L = await rpc('eth_getLogs', [{ address: ELEMENT_EX, topics: [T_721_FILLED], fromBlock: '0x' + b.toString(16), toBlock: '0x' + Math.min(b + 9999, head).toString(16) }]).catch(() => []);
    for (const l of L || []) { const w = l.data.slice(2).match(/.{64}/g) || []; const col = '0x' + (w[7] || '').slice(24); if (!S.nftCols[col]) continue; const isBnb = (w[4] || '').endsWith('eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'); const px = Number(BigInt('0x' + (w[5] || '0'))) / 1e18; (fills[col] = fills[col] || []).push(isBnb ? px : null); }
    await sleep(200);
  }
  // 2) 各系列轉手次數（不含新鑄造）＋我們持有幾張
  for (const col of Object.keys(S.nftCols)) {
    let moves = 0;
    for (let b = from; b <= head; b += 50000) { const L = await rpc('eth_getLogs', [{ address: col, topics: [T_TRANSFER], fromBlock: '0x' + b.toString(16), toBlock: '0x' + Math.min(b + 49999, head).toString(16) }]).catch(() => []); for (const l of L || []) if (l.topics.length === 4 && !/^0x0+$/.test(l.topics[1])) moves++; }
    let held = 0; for (const W of WALLETS) { const r = await call(col, '0x70a08231' + wa(W.addr)); if (r && r.length >= 66) held += Number(BigInt(r.slice(0, 66))); }
    const f = fills[col] || [], prev = S.nftVol[col];
    const px = f.filter((x) => x != null), vol = px.reduce((a, b) => a + b, 0);
    const hot = held > 0 && px.length >= 3 && vol > 0 && (prev ? px.length >= 2 * (prev.f || 0) : px.length >= 5); // 只看真的有付錢的成交（使用者 15:22：轉來轉去不算）
    if (hot) {
      const name = tokStr(await call(col, '0x06fdde03')) || col.slice(0, 10);
      await tg(`🦋 NFT 成交量變多：${name}\n錢包共持有 ${held} 張\n過去 12 小時 Element 成交 ${f.length} 筆${prev ? '（上次 ' + (prev.f || 0) + ' 筆）' : ''}${px.length ? `，成交價 ${Math.min(...px).toFixed(4)}～${Math.max(...px).toFixed(4)} BNB，合計 ${vol.toFixed(4)} BNB` : ''}\n轉手 ${moves} 次${prev ? '（上次 ' + (prev.t || 0) + ' 次）' : ''}\n${col}\nhttps://element.market/assets/bsc/${col}/1\n要掛單或賣手動處理`);
    }
    S.nftVol[col] = { f: f.length, t: moves, held, at: ts() };
    await sleep(150);
  }
  log(`NFT 成交量檢查完成：${Object.keys(S.nftCols).length} 個系列`);
}


function validateFileJob(job) {
  const fields = ['schemaVersion', 'c', 'data', 'value', 'n', 'randArg', 'sel', 'name', 'tok', 'usdt', 'swapBack', 'revoke'];
  if (!job || typeof job !== 'object' || Array.isArray(job) || job.schemaVersion !== 1 || Object.keys(job).some((key) => !fields.includes(key))) throw new Error('文件任务必须使用已知 schemaVersion:1');
  if (job.name !== undefined && (typeof job.name !== 'string' || job.name.length > 80 || /[\r\n\0]/.test(job.name))) throw new Error('文件任务名称无效');
  if (job.swapBack !== undefined) {
    if (!validMintAddress(job.swapBack) || (job.revoke !== undefined && !validMintAddress(job.revoke)) || Object.keys(job).some((key) => !['schemaVersion', 'swapBack', 'revoke', 'name'].includes(key))) throw new Error('换回 BNB 文件任务无效');
    return { ...job, swapBack: job.swapBack.toLowerCase(), ...(job.revoke ? { revoke: job.revoke.toLowerCase() } : {}) };
  }
  if (!validMintAddress(job.c) || (job.tok !== undefined && !validMintAddress(job.tok)) || job.revoke !== undefined) throw new Error('文件任务地址无效');
  const n = job.n === undefined ? 1 : job.n;
  if (!Number.isInteger(n) || n < 1 || n > 10) throw new Error('文件任务份数必须是 1 至 10');
  if (job.randArg !== undefined && typeof job.randArg !== 'boolean') throw new Error('randArg 必须是布尔值');
  if (job.randArg) {
    if (typeof job.sel !== 'string' || !/^0x[a-fA-F0-9]{8}$/.test(job.sel) || badSel(job.sel) || job.data !== undefined || job.usdt !== undefined) throw new Error('文件任务函数选择器无效');
  } else if (!validMintCalldata(job.data, job.usdt === undefined) || badSel(job.data) || job.sel !== undefined) throw new Error('文件任务调用数据无效');
  const value = mintUint(job.value);
  if (job.usdt !== undefined && (typeof job.usdt !== 'number' || !Number.isFinite(job.usdt) || job.usdt <= 0 || job.usdt > PAID.maxUsd || n !== 1 || value !== 0n)) throw new Error('USDT 文件任务金额或份数无效');
  return { ...job, c: job.c.toLowerCase(), ...(job.tok ? { tok: job.tok.toLowerCase() } : {}), value: value.toString(), n };
}
async function manualMints() {
  // Existing or unknown queue files are inert until explicitly enabled. A monitor
  // never reads, clears, previews, or executes this independent command channel.
  if (MONITOR_ONLY || !FILE_COMMANDS_ENABLED) return;
  const f = join(DIR, 'data', 'manual_mint.json'); if (!existsSync(f)) return;
  let jobs;
  try {
    const input = JSON.parse(readFileSync(f, 'utf8'));
    if (!Array.isArray(input) || input.length > 100) throw new Error('文件任务必须是最多 100 项的数组');
    if (!input.length) return;
    jobs = input.map(validateFileJob);
  } catch (e) { log('文件任务未消费：' + e.message); return; }
  writeFileSync(f, '[]');
  for (const J of jobs) {
    const res = await Promise.all(WALLETS.filter(W => canWallet(W, J.swapBack ? 'token-sell' : 'mint')).map((W) => withMintWalletLock(W, async () => {
      const PAID = paidFor(W);
      let ok = 0, err = '';
      if (J.approvals) { /* 列出錢包所有授權，存到 data/approvals_錢包.json（使用者 10/31 10:34：Flap 出事，要取消授權） */
        const r = await W.baw(['approvals', 'list', '--limit', '100']); writeFileSync(join(DIR, 'data', `approvals_${W.id}.json`), r.t || ''); return `[${W.name}] 已列出授權`;
      }
      if (J.revokeAll) { /* 取消指定的授權：[{token, spender, type}] */
        const out = []; for (const x of J.revokeAll) { const r = await revokeWalletApproval(W, x.token, x.spender, x.type || 'approve'); out.push(`${x.token.slice(0, 8)}→${x.spender.slice(0, 8)} ${r.j?.success ? '✅' : '❌ ' + (r.j?.error?.message || r.t).slice(0, 80)}`); }
        writeFileSync(join(DIR, 'data', `revoke_${W.id}.txt`), out.join('\n')); return `[${W.name}] 取消授權：${out.join('；')}`;
      }
      if (J.swapBack) { // 把代幣換回 BNB，並（可選）取消授權
        try {
          const out = [];
          if (J.revoke) { await previewExec(W, J.swapBack, '0x095ea7b3' + wa(J.revoke) + w(0), 0n, (sim) => approvalSimulationCheck(sim, W, J.revoke, J.swapBack), null, 'token-sell'); out.push('已取消授权'); }
          const balance = big(await call(J.swapBack, '0x70a08231' + wa(W.addr)));
          if (balance > 10n ** 16n) {
            const token = TOKENS.concat(S.dyn || []).find(entry => entry.addr.toLowerCase() === J.swapBack && (!entry.only || entry.only === W.addr)) || { sym: J.name || 'TOKEN', addr: J.swapBack, cost: 0, only: W.addr };
            S.dyn ||= [];
            if (!TOKENS.concat(S.dyn).some(entry => entry.addr.toLowerCase() === J.swapBack && (!entry.only || entry.only === W.addr))) S.dyn.push(token);
            const position = positionFor(W, token);
            const confirmed = await sell(token, position, balance, '本地文件指定换回 BNB', W, { id: 'manualFull', full: true });
            out.push(confirmed ? '已核验换回 BNB' : position.pendingSell ? '换回 BNB 已提交，继续核对成交' : '换回 BNB 尚未完成，请核对钱包状态');
          }
          return `[${W.name}] ${out.join('，') || '没有需要处理的'}`;
        } catch (e) { return `[${W.name}] ❌ ${e.message.slice(0, 100)}`; }
      }
      if (J.usdt !== undefined) {
        try {
          const need = BigInt(Math.ceil(J.usdt * 1e6)) * 10n ** 12n;
          const result = await executeUsdtMint(W, { to: J.c, data: J.data, need, manual: true });
          trackFromSim(W, result.sim, J.name || 'TOKEN', result.usd, result.tx, J.tok);
          return `[${W.name}] ✅ 打到（支出预算约 ${result.usd.toFixed(2)}U）交易 ${result.tx}`;
        } catch (e) { return `[${W.name}] ❌ 没打到（${e.message.slice(0, 100)}）`; }
      }
      try {
        const price = await bnbUsd(), value = mintUint(J.value), totalBnb = Number(value) / 1e18 * J.n;
        const spent = resetPaidBudgetDay()[W.id] || 0;
        const balance = Number(BigInt(await rpc('eth_getBalance', [W.addr, 'latest']))) / 1e18;
        if (!(price > 0) || !withinPaidBudget(PAID, { spentBnb: spent, costBnb: totalBnb, costUsd: totalBnb * price, balanceBnb: balance })) throw new Error('超过单笔/每日预算或 BNB 保留金额');
        for (let i = 0; i < J.n; i++) {
          const data = J.randArg ? J.sel + w(BigInt(Math.floor(Math.random() * 65536))) : J.data;
          try {
            const minted = await previewExec(W, J.c, data, value, (sim) => mintSimulationCheck(sim, W, { bnbWei: value }), null, 'mint', { manual: true, fallbackToken: J.tok });
            trackFromSim(W, minted.sim, J.name || '', Number(value) / 1e18 * price, minted.tx, J.tok);
            ok++; S.paidSpend[W.id] = spent + Number(value) / 1e18 * ok; save();
          } catch (e) { err = e.message.slice(0, 80); break; }
        }
      } catch (e) { err = e.message.slice(0, 80); }
      if (ok) { S.nftCols = S.nftCols || {}; S.nftCols[J.c] = 1; S.freeTrack = S.freeTrack || {}; S.freeTrack[J.c] = S.freeTrack[J.c] || { at: Date.now() }; }
      return ok ? `[${W.name}] ✅ 打到 ${ok} 份${err ? '（后续未执行：' + err + '）' : ''}` : `[${W.name}] ❌ 没打到（${err}）`;
    }, J.swapBack ? 'token-sell' : 'mint')));
    log(`手动补打 ${J.name || J.c || J.swapBack}：${res.join('；')}`);
    await tgSay(`🛠 ${J.swapBack ? '换回 BNB' : '补打'} ${J.name || J.c || ''}\n${res.join('\n')}`);
  }
}
// ── TG 指令：使用者直接在機器人打「賣 XXX」「賣 XXX 一半」「餘額」，幾秒內執行，不經過 Claude ──
// ── 更新提醒（開源版才開；使用者 11/1 00:47：不自動更新，只提醒；用戶回 /update 才更新，更新前安檢＋sha256＋備份，新版起不來自動換回）──
const UPD = { on: false, ver: '2.7.6', repo: 'nancyc0813-maker/agentid-sniper', group: 't.me/nancy_c0813' }; /* Web 增强版仅由 Web 后台检查自己的正式发行；扫描器不查询或安装 Nancy 上游版本。 */
const verGt = (a, b) => { const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); return false; };
async function updCheck(quiet = false) {
  if (!UPD.on) return null;
  try {
    const r = await fetch(`https://raw.githubusercontent.com/${UPD.repo}/main/version.json?t=${Date.now()}`, { signal: AbortSignal.timeout(15000) }); if (!r.ok) return null;
    const v = await r.json(); if (!v.version || !verGt(v.version, UPD.ver)) return null; UPD.latest = v;
    if (!quiet && S.updNotified !== v.version) { /* 使用者 11/1 00:47：不要自動更新（怕被罵）——只提醒，用戶自己回 /update 才更新 */
      S.updNotified = v.version; save();
      const msg = `🔔 Agent ID Sniper 有新版 v${v.version}（你現在是 v${UPD.ver}）\n${(v.notes || []).map((x) => '• ' + x).join('\n')}\n\n请在电脑 Web 控制台「系统更新」中一键合并更新，保留钱包、Web 和 NFT 功能。\n不更新也可以照常使用。\n官方群：${UPD.group}`;
      log(msg.replace(/\n/g, ' | ')); console.log('\n' + '='.repeat(48) + '\n' + msg + '\n' + '='.repeat(48) + '\n'); await tgSay(msg);
    }
    return v;
  } catch { return null; }
}
async function doUpdate() {
  return '本地定制版包含独立钱包、Web 和 NFT 功能，禁止覆盖式更新；请在 Web 控制台「系统更新」中使用一键更新。';
}

async function groupInvite() { if (!UPD.on || S.grpInvited === 1) return; S.grpInvited = 1; save(); const msg = `👋 歡迎使用 Agent ID Sniper v${UPD.ver}\n加入官方 TG 群，第一時間收到：\n• 工具更新通知\n• 打到什麼項目、哪個開盤的即時播報\n• 使用教學與問題解答\n👉 ${UPD.group}`; log(msg.replace(/\n/g, ' | ')); console.log('\n' + '='.repeat(48) + '\n' + msg + '\n' + '='.repeat(48) + '\n'); await tgSay(msg); }
if (UPD.on) setTimeout(() => { const b = join(DIR, 'data', 'update_backup.mjs'); if (existsSync(b)) { try { renameSync(b, join(DIR, 'data', 'backup_prev.mjs')); log('新版已穩定運行 10 分鐘，舊版備份改存為 data/backup_prev.mjs'); } catch {} } }, 10 * 60e3).unref();
async function tgSay(text) { if (!TG) return; log('TG回覆: ' + text.replace(/\n/g, ' | ')); try { await fetch(`https://api.telegram.org/bot${TG.a}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: TG.b, text, disable_web_page_preview: true }), signal: AbortSignal.timeout(10000) }); } catch {} }
function findTok(q, W) {
  q = q.toLowerCase();
  return TOKENS.concat(S.dyn || []).find((t) => (!t.only || t.only === W.addr) && (t.sym.toLowerCase() === q || t.addr === q));
}
async function cmdSell(q, half) {
  if (MONITOR_ONLY) { await tgSay(MONITOR_NOTE); return; }
  const head = parseInt(await rpc('eth_blockNumber', []), 16);
  const jobs = WALLETS.filter(W => canWallet(W, 'token-sell')).map(async (W) => {
    const t0 = findTok(q, W); if (!t0) return `[${W.name}] 找不到 ${q}`;
    const bal = big(await call(t0.addr, '0x70a08231' + wa(W.addr))); if (bal === 0n) return `[${W.name}] 沒有 ${t0.sym}`;
    const st = positionFor(W, t0);
    const ok = await sell(t0, st, half ? bal / 2n : bal, half ? '你在 TG 指示賣一半' : '你在 TG 指示全部賣出', W, { id: half ? 'manualHalf' : 'manualFull', full: !half });
    return ok ? null : `[${W.name}] ${t0.sym} ${st.pendingSell ? '卖出待确认' : '卖出未完成'}`;
  });
  const errs = (await Promise.all(jobs)).filter(Boolean); save();
  if (errs.length) await tgSay('⚠️ ' + errs.join('\n'));
  void head;
}
async function cmdBalance() {
  const lines = await Promise.all(WALLETS.map(async (W) => { const b = Number(BigInt(await rpc('eth_getBalance', [W.addr, 'latest']))) / 1e18; return `${W.name}：${b.toFixed(5)} BNB`; }));
  await tgSay('💼 錢包餘額\n' + lines.join('\n'));
}
async function cmdHold() {
  const out = [];
  for (const W of WALLETS) for (const t0 of TOKENS.concat(S.dyn || [])) {
    if (t0.only && t0.only !== W.addr) continue;
    const bal = big(await call(t0.addr, '0x70a08231' + wa(W.addr))); if (bal === 0n) continue;
    const v = await valueUsd(t0, bal).catch(() => null); const line = `[${W.name}] ${t0.sym}：${v == null ? '還沒有池子' : '約 ' + v.toFixed(2) + 'U'}`;
    if (!out.includes(line)) out.push(line);
  }
  await tgSay('📦 還沒賣的幣\n' + (out.length ? out.join('\n') : '沒有') + '\n（NFT 不在這裡，NFT 成交量變多會另外通知）');
}
async function holdReport(title = '📦 持倉總結') { /* 使用者 11/1 03:19：每 12 小時（凌晨 1 點、下午 1 點；使用者 11/1 03:36 改）發一次持倉總結：成本、現值、倍數、狀態 */
  const rows = [], noPool = [], dust = []; let tc = 0, tv = 0;
  for (const W of WALLETS) for (const t0 of TOKENS.concat(S.dyn || [])) {
    if (t0.only && t0.only !== W.addr) continue;
    const bal = big(await call(t0.addr, '0x70a08231' + wa(W.addr)).catch(() => null)); if (!(bal > 0n)) continue;
    const RULE = rulesFor(W);
    const v = await valueUsd(t0, bal).catch(() => null); const wn = W.name;
    if (v == null) { if (!noPool.includes(t0.sym)) noPool.push(t0.sym); continue; }
    if (v < 0.3) { if (!dust.includes(t0.sym)) dust.push(t0.sym); continue; }
    const st = positionFor(W, t0); const cost = tokenCostFor(W, t0); const x = cost > 0 ? v / cost : 0;
    const status = t0.hold ? '只通知' : t0.custom ? '特殊規則' : (st.done2 || []).includes('back') ? (st.moon ? `已回本，含 ${RULE.moonPct}% 長抱` : '已回本，照策略持有') : cost > 0 ? '照策略持有' : '免費幣';
    tc += cost; tv += v; rows.push({ v, line: `${t0.sym}（錢包${wn}）${cost > 0 ? `成本 ${cost.toFixed(1)}U → ` : ''}約 ${v.toFixed(2)}U${x ? `（${x.toFixed(2)} 倍）` : ''} · ${status}` });
  }
  rows.sort((a, b) => b.v - a.v);
  const msg = `${title}（${WALLETS.map(W => W.name).join('、')}）\n${rows.length ? rows.map((r) => '· ' + r.line).join('\n') : '目前沒有有價格的持倉'}\n\n有價格的合計：約 ${tv.toFixed(2)}U${tc ? `（付費成本合計 ${tc.toFixed(1)}U）` : ''}${noPool.length ? `\n還沒開池（${noPool.length} 個）：${noPool.slice(0, 20).join('、')}${noPool.length > 20 ? '…' : ''}` : ''}${dust.length ? `\n不到 0.3U 的零頭：${dust.join('、')}` : ''}`;
  await tgSay(msg);
}
setInterval(() => { const tp = new Date(Date.now() + 8 * 3600e3), h = tp.getUTCHours(), k = tp.toISOString().slice(0, 10) + '-' + h; if ((h === 1 || h === 13) && S.holdRepAt !== k) { S.holdRepAt = k; save(); holdReport().catch((e) => log('holdReport ' + e.message)); } }, 60e3).unref();
async function cmdStats() {
  // 免費項目：所有「已自動鑄造」的記錄都算（含一發現就馬上打的），用合約地址去重；「現在開了」那種用名稱對回合約；扣掉早上 0 BNB bug 的假鑄造
  const free = new Set(), bog = new Set(), paidC = new Set(); let paid = 0; const n2a = {};
  try {
    const lines = readFileSync(LOG, 'utf8').split('\n');
    for (const l of lines) { const m = l.match(/(?:專屬合約|項目)：([^|（(\n]+?)\s*(?:（[^|]*）)?\s*\|\s*(0x[a-fA-F0-9]{40})/); if (m && !n2a[m[1].trim().toLowerCase()]) n2a[m[1].trim().toLowerCase()] = m[2].toLowerCase(); }
    for (const l of lines) {
      if (l.includes('🛒')) { paid++; const c = l.match(/(?<![0-9a-fA-Fx])(0x[a-fA-F0-9]{40})(?![0-9a-fA-F])/); if (c) paidC.add(c[1].toLowerCase()); }
      if (!l.includes('已自動鑄造')) continue;
      const nm = l.match(/項目\s*([^\n（(|]+?)\s*現在開了/); let key = '';
      if (nm) key = n2a[nm[1].trim().toLowerCase()] || 'N:' + nm[1].trim().toLowerCase();
      else { const c = l.match(/(?<![0-9a-fA-Fx])(0x[a-fA-F0-9]{40})(?![0-9a-fA-F])/); if (c) key = c[1].toLowerCase(); }
      if (!key) continue;
      (/重播0x(（| \||$)/.test(l) ? bog : free).add(key);
    }
    for (const k of bog) free.delete(k);
  } catch {}
  const tr = S.trades || [], by = {};
  for (const x of tr) { const k = x.sym; by[k] = by[k] || { usd: 0, n: 0 }; by[k].usd += x.usd; by[k].n++; }
  const px = await bnbUsd().catch(() => 0); let tot = 0; for (const W of WALLETS) tot += Number(BigInt(await rpc('eth_getBalance', [W.addr, 'latest']))) / 1e18;
  const lines = Object.entries(by).map(([k, v]) => `${k}：賣 ${v.n} 筆，拿回約 ${v.usd.toFixed(2)}U`);
  await tgSay(`📊 戰績\n自動打的免費項目：${free.size} 個\n付費打的：${paidC.size} 個項目（${paid} 筆）\n${lines.length ? '有記錄的賣出：\n' + lines.join('\n') + '\n' : ''}錢包現在共 ${tot.toFixed(4)} BNB（約 ${(tot * px).toFixed(2)}U）`);
}
async function tgCmdLoop() {
  if (!TG) return;
  if (S.tgOff == null) { try { const r = await (await fetch(`https://api.telegram.org/bot${TG.a}/getUpdates?timeout=0`)).json(); const u = r.result || []; S.tgOff = u.length ? u[u.length - 1].update_id + 1 : 0; save(); } catch { S.tgOff = 0; } }
  for (;;) {
    try {
      const r = await (await fetch(`https://api.telegram.org/bot${TG.a}/getUpdates?timeout=25&offset=${S.tgOff}`, { signal: AbortSignal.timeout(35000) })).json();
      for (const u of r.result || []) {
        S.tgOff = u.update_id + 1; save();
        const m = u.message; if (!m || String(m.chat?.id) !== String(TG.b) || !m.text) continue; // 只聽使用者本人
        if (Date.now() / 1000 - m.date > 120) continue; // 太舊的指令不執行
        const txt = m.text.trim().replace(/^\//, '');
        let mm;
        if ((mm = txt.match(/^(?:賣|卖|sell)\s*(\S+?)\s*(一半|半|half)?$/i)) || (mm = txt.match(/^(\S+?)\s*(?:全出|全賣|全卖)$/i))) {
          const half = !!mm[2]; await tgSay(`⚡ 收到，${mm[1]} 所有錢包${half ? '各賣一半' : '全部賣出'}中…`);
          cmdSell(mm[1], half).catch((e) => tgSay('⚠️ 賣出出錯：' + e.message));
        } else if ((mm = txt.match(/^(\S+?)\s*(?:出一半|賣一半|卖一半)$/i))) {
          await tgSay(`⚡ 收到，${mm[1]} 所有錢包各賣一半中…`); cmdSell(mm[1], true).catch((e) => tgSay('⚠️ 賣出出錯：' + e.message));
        } else if (/^(餘額|余额|錢包|钱包|balance)$/i.test(txt)) { cmdBalance().catch(() => {}); }
        else if (/^(持倉|持仓|holdings?)$/i.test(txt)) { holdReport('📦 持倉').catch((e) => tgSay('⚠️ ' + e.message)); }
        else if (/^(戰績|战绩|統計|统计|stats?)$/i.test(txt)) { cmdStats().catch((e) => tgSay('⚠️ ' + e.message)); }
        else if (/^(update|更新)$/i.test(txt)) { if (!UPD.on) await tgSay('這個版本不自動更新'); else { await tgSay('⚡ 收到，下載新版並安檢中…'); await tgSay(await doUpdate().catch((e) => '⚠️ 更新出錯：' + e.message)); } }
        else if (/^(help|指令|說明|说明)$/i.test(txt)) await tgSay('可用指令：\n賣 XXX → 所有錢包全賣\n賣 XXX 一半 → 各賣一半\n（也可打「XXX 全出」「XXX 出一半」）\n餘額 → 看各錢包 BNB\n持倉 → 還沒賣的幣和現值\n戰績 → 上線以來打了多少、賣了多少');
      }
    } catch { await sleep(3000); }
  }
}

let HOLDINGS_SCHEDULER = null;
function startHoldingsScheduler() {
  if (HOLDINGS_SCHEDULER) return HOLDINGS_SCHEDULER;
  let stopped = false, busy = false, lastFullStarted = null, lastFastStarted = null;
  let timer;
  const stop = () => { stopped = true; if (timer) clearInterval(timer); };
  const tick = async () => {
    if (stopped || busy) return;
    if (existsSync(join(DIR, 'WATCH_STOP'))) { stop(); return; }
    const now = Date.now();
    const activeFast = Object.values(S.tokens).some((state) => state.openAt && now - state.openAt < (state.effectiveRules?.fastMin ?? RULE.fastMin) * 60000 && state.stage !== 9 && !state.done);
    const fullDue = lastFullStarted === null || now - lastFullStarted >= 5000;
    const fastDue = activeFast && (lastFastStarted === null || now - lastFastStarted >= 1000);
    if (!fullDue && !fastDue) return;
    const onlyFast = !fullDue;
    busy = true; S.holdingsInFlight = true; S.holdingsStartedAt = now;
    if (fullDue) { lastFullStarted = now; lastFastStarted = now; } else lastFastStarted = now;
    let partial = false;
    try {
      const head = Number.parseInt(await rpc('eth_blockNumber', []), 16);
      if (!Number.isSafeInteger(head) || head < 0) throw new Error('持仓检查无法取得有效区块高度');
      if (stopped) return;
      const result = await holdings(head, onlyFast);
      if (result?.pending) { S.holdingsScope = 'partial'; partial = true; return; }
      if (stopped || existsSync(join(DIR, 'WATCH_STOP'))) return;
      S.holdingsUpdatedAt = Date.now();
      S.holdingsScope = onlyFast ? 'fast' : 'all';
      if (onlyFast) S.holdingsFastUpdatedAt = S.holdingsUpdatedAt;
      else S.holdingsFullUpdatedAt = S.holdingsUpdatedAt;
      delete S.holdingsError; delete S.holdingsErrorAt;
    } catch (error) {
      if (!stopped) { S.holdingsError = error.message; S.holdingsErrorAt = Date.now(); log('独立持仓检查失败：' + error.message); }
    } finally {
      busy = false; S.holdingsInFlight = partial;
      if (!stopped) save();
    }
  };
  HOLDINGS_SCHEDULER = { stop, tick };
  timer = setInterval(() => { void tick(); }, 1000);
  timer.unref?.();
  void tick();
  return HOLDINGS_SCHEDULER;
}

let lastLoopAt = Date.now();
setInterval(() => { if (Date.now() - lastLoopAt > (INFLIGHT > 0 ? 11 : 8) * 60e3) { log('看門狗：主迴圈卡住超過 8 分鐘，自動重啟'); try { save(); } catch {} process.exit(3); } }, 30e3).unref();
async function main() {
  log(MONITOR_ONLY ? '启动监测（仅监控，不调用钱包 CLI）' : '启动监测');
  log(`入场门槛：进度至少 ${Math.round(ENTRY_POLICY.goPct * 1000) / 10}%，${ENTRY_POLICY.minAgents} 个 Agent ID 交易钱包；完全免费只通知`);
  save();
  const holdingsScheduler = startHoldingsScheduler();
  process.on('exit', () => holdingsScheduler.stop());
  tgCmdLoop().catch((e) => log('tgCmd ' + e.message));
  let lastLogin = 0;
  for (;;) {
    try { if (statSync(SELF).mtimeMs !== SELF_MT) { if ((INFLIGHT > 0 || globalThis._xBusy) && !globalThis._waitSince) globalThis._waitSince = Date.now(); if ((INFLIGHT === 0 && !globalThis._xBusy) || Date.now() - (globalThis._waitSince || 0) > 300e3) { log('程序更新，重启'); save(); process.exit(0); } } } catch {} // 等进行中的交易与卖出处理，最多五分钟；持久化的未明意图在重启后核对。
    if (UPD.on && existsSync(join(DIR, 'UPDATE'))) { try { unlinkSync(join(DIR, 'UPDATE')); } catch {} doUpdate().then((m) => { log(m); console.log('\n' + m + '\n'); tgSay(m); }).catch((e) => log('update ' + e.message)); }
    if (UPD.on && (!globalThis._updAt || Date.now() - globalThis._updAt > 30 * 60e3)) { globalThis._updAt = Date.now(); updCheck().catch(() => {}); } // 每 30 分鐘看一次 GitHub 有沒有新版
    if (existsSync(join(DIR, 'WATCH_STOP'))) { log('WATCH_STOP，退出'); save(); process.exit(0); }
    try {
      const loopStartedAt = Date.now();
      const head = parseInt(await rpc('eth_blockNumber', []), 16);
      if (!globalThis._socialBusy && Date.now() - (globalThis._socialAt || 0) > 30000) { globalThis._socialAt = Date.now(); globalThis._socialBusy = true; socialCandidateWatch().catch(error => log('群组候选检查 ' + error.message)).finally(() => { globalThis._socialBusy = false; }); }
      const tS = Date.now(); await scanNew(head); if (Date.now() - tS > 20e3) log(`掃描一輪花了 ${Math.round((Date.now() - tS) / 1000)} 秒`);
      if (!globalThis._flapAt || Date.now() - globalThis._flapAt > 30e3) { globalThis._flapAt = Date.now(); if (!globalThis._flapBusy) { globalThis._flapBusy = true; flapAgentWatch().catch((e) => log('flap ' + e.message)).finally(() => { globalThis._flapBusy = false; }); } }
      if (!globalThis._toshAt || Date.now() - globalThis._toshAt > 60e3) { globalThis._toshAt = Date.now(); if (!globalThis._toshBusy) { globalThis._toshBusy = true; toshWatch().catch((e) => log('tosh ' + e.message)).finally(() => { globalThis._toshBusy = false; }); } }
      if (!globalThis._miscAt || Date.now() - globalThis._miscAt > 600e3) { globalThis._miscAt = Date.now(); lowBnbWatch().catch(() => {}); flapApprovalWatch().catch((e) => log('flapApproval ' + e.message)); } /* 每 10 分鐘看 BNB 夠不夠 */
      dailyReport().catch((e) => log('daily ' + e.message));
      if (!globalThis._pruneAt || Date.now() - globalThis._pruneAt > 3600e3) { globalThis._pruneAt = Date.now(); pruneState(); }
      if (!globalThis._aidropAt || Date.now() - globalThis._aidropAt > 120e3) { globalThis._aidropAt = Date.now(); const tA = Date.now(); await aidropWatch(head); if (Date.now() - tA > 20e3) log(`aidrop 檢查花了 ${Math.round((Date.now() - tA) / 1000)} 秒`); }
      for (let k = 0; k < 3; k++) { const bk = '_paidBusy' + k, ak = '_paidAt' + k; if (!globalThis._mmBusy && !globalThis[bk] && (!globalThis[ak] || Date.now() - globalThis[ak] > 15e3)) { globalThis[ak] = Date.now(); globalThis[bk] = true; paidLoop('hot', k).catch((e) => log('paidLoop ' + e.message)).finally(() => { globalThis[bk] = false; globalThis._paidDur = Math.round((Date.now() - globalThis[ak]) / 1000); }); } } /* 快速檢查：每 15 秒，分 3 組同時跑 */
      if (!globalThis._swBusy && (!globalThis._swAt || Date.now() - globalThis._swAt > 60e3)) { globalThis._swAt = Date.now(); globalThis._swBusy = true; progressSweep().catch((e) => log('sweep ' + e.message)).finally(() => { globalThis._swBusy = false; }); } // 每分鐘輕量讀進度
      if (!globalThis._mmBusy && !globalThis._restBusy && (!globalThis._restAt || Date.now() - globalThis._restAt > 60e3)) { globalThis._restAt = Date.now(); globalThis._restBusy = true; paidLoop('rest').catch((e) => log('paidRest ' + e.message)).finally(() => { globalThis._restBusy = false; }); } // 一般檢查：約每分鐘 // 背景跑，不卡住掃描
      if (!globalThis._smartBusy && Date.now() - (S.smartAt || 0) > 6 * 3600e3) { S.smartAt = Date.now(); globalThis._smartBusy = true; buildSmart().catch((e) => log('smart ' + e.message)).finally(() => { globalThis._smartBusy = false; }); }
      if (!MONITOR_ONLY && FILE_COMMANDS_ENABLED && !globalThis._mmBusy && !globalThis._restBusy && ![0, 1, 2].some((k) => globalThis['_paidBusy' + k]) && existsSync(join(DIR, 'data', 'manual_mint.json'))) { globalThis._mmBusy = true; manualMints().catch((e) => log('manual ' + e.message)).finally(() => { globalThis._mmBusy = false; }); }
      if (!globalThis._heatBusy && Date.now() - (globalThis._heatAt || 0) > 20e3) { globalThis._heatAt = Date.now(); globalThis._heatBusy = true; heatWatch().catch((e) => log('heatWatch ' + e.message)).finally(() => { globalThis._heatBusy = false; }); } // 熱度監測（背景）
      if (!globalThis._inscBusy && Date.now() - (globalThis._inscAt || 0) > 30000) { globalThis._inscAt = Date.now(); globalThis._inscBusy = true; inscScan().catch(error => log('铭文通知检查 ' + error.message)).finally(() => { globalThis._inscBusy = false; }); }
      if (!globalThis._fpBusy && Date.now() - (globalThis._fpAt || 0) > 300e3) { globalThis._fpAt = Date.now(); globalThis._fpBusy = true; freeProgWatch().catch((e) => log('freeProg ' + e.message)).finally(() => { globalThis._fpBusy = false; }); } // 免費項目進度，每 5 分鐘
      if (!globalThis._nftBusy && Date.now() - (S.nftVolAt || 0) > 12 * 3600e3) { S.nftVolAt = Date.now(); globalThis._nftBusy = true; nftVolWatch().catch((e) => log('nftVol ' + e.message)).finally(() => { globalThis._nftBusy = false; }); } // 12 小時看一次 NFT 成交量（背景）
      if (Date.now() - lastLogin > 600e3) { lastLogin = Date.now(); loginCheck().catch(() => {}); }
      // Classification may take minutes; measure lag against a fresh chain head,
      // rather than the head captured before the batch was scanned.
      const latestHead = await rpc('eth_blockNumber', []).then((value) => parseInt(value, 16)).catch(() => null);
      S.chainHead = Number.isFinite(latestHead) ? latestHead : head;
      S.chainHeadAt = Number.isFinite(latestHead) ? Date.now() : loopStartedAt;
      S.scanLagEstimated = !Number.isFinite(latestHead);
      S.scanLag = Math.max(0, S.chainHead - (S.lastBlock || 0));
      S.scanUpdatedAt = Date.now();
      S.loopDurationMs = S.scanUpdatedAt - loopStartedAt;
      lastLoopAt = Date.now(); save(); writeFileSync(join(DIR, 'data', 'watch_heartbeat.txt'), ts() + ' 掃描落後 ' + S.scanLag + ' 塊' + (S.scanLagEstimated ? '（估算）' : '') + ' · 付費檢查一輪 ' + (globalThis._paidDur ?? '?') + ' 秒');
      if ((S.scanLag || 0) > 400 && Date.now() - (S.lagAlert || 0) > 3600e3) { S.lagAlert = Date.now(); await tg(`⚠️ 新合約掃描落後 ${S.scanLag} 個區塊（約 ${Math.round(S.scanLag * 0.45 / 60)} 分鐘），可能是公用節點變慢，手動處理`); }
    } catch (e) { log('出错 ' + e.message); }
    await sleep(1000);
  }
}
process.on('uncaughtException', (e) => log('uncaught ' + e.message));
process.on('unhandledRejection', (e) => log('unhandled ' + (e?.message || e)));
main();
