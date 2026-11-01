import { chmodSync, existsSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeWalletConfig, WALLET_MODES } from './wallet-model.mjs';

export const CONFIG_PATH = join(dirname(dirname(fileURLToPath(import.meta.url))), 'config.json');
export const DEFAULT_PAID = Object.freeze({ goPct: 0.6, earlyPct: 0.6, riseDelta: 0.02, maxUsd: 20, maxBnbPerDay: 0, keepBnb: 0.006, minSold: 30, maxAgeH: 168 });
export const DEFAULT_RULES = Object.freeze({ strategy: 'steps', backX: 2, steps: [[10, 30], [20, 50]], crash: 0.4, crashAfterBack: 0.6, moonPct: 20, moonNotifyX: [50, 100], halfX: [], fastMin: 30, fastCrash: 0.4, noPumpMin: 0, noPumpX: 0, stallSec: 300, drop: 0.5, notifyX: [5, 10, 20] });
const LEGACY_RULES = Object.freeze({ strategy: 'legacy', backX: 3, steps: [], halfX: [5, 10], crash: 0.6, fastMin: 30, fastCrash: 0.35, noPumpMin: 20, noPumpX: 2, stallSec: 300, drop: 0.5, notifyX: [5, 10], moonPct: 0, moonNotifyX: [] });
export const DEFAULT_CONFIG = Object.freeze({ monitorOnly: true, enableFileCommands: false, wallets: [], portfolioBudget: { maxBnbPerDay: null }, telegram: { botToken: '', chatId: '', groupChatId: '' }, timeZone: 'Asia/Shanghai', paid: DEFAULT_PAID, rules: DEFAULT_RULES, tokens: [], watchVault: '', forceMint: [], notifyAll: false, rpcs: [] });
const clone = (value) => structuredClone(value);
const ADDRESS = /^0x[a-fA-F0-9]{40}$/;
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

function invalid(message) {
  const error = new Error(message);
  error.status = 400;
  error.errors = [message];
  return error;
}
function record(value, name) { if (!isRecord(value)) throw invalid(`${name} 必须是对象`); return value; }
function string(value, name, max, fallback = '') {
  const result = value ?? fallback;
  if (typeof result !== 'string' || result.length > max || /[\u0000-\u001f\u007f]/.test(result)) throw invalid(`${name} 必须是长度不超过 ${max} 的文本`);
  return result.trim();
}
function boolean(value, name, fallback) {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'boolean') throw invalid(`${name} 必须是布尔值`);
  return value;
}
function number(value, name, min, max, fallback, integer = false) {
  const result = value === undefined ? fallback : value;
  if (typeof result !== 'number' || !Number.isFinite(result) || result < min || result > max || (integer && !Number.isInteger(result))) throw invalid(`${name} 必须是 ${min} 至 ${max} 的${integer ? '整数' : '数值'}`);
  return result;
}
function address(value, name, optional = false) {
  const result = string(value, name, 42);
  if (optional && !result) return '';
  if (!ADDRESS.test(result) || /^0x0{40}$/i.test(result)) throw invalid(`${name} 必须是有效的 BSC 地址`);
  return result;
}
function array(value, name, max, fallback = []) {
  const result = value === undefined ? fallback : value;
  if (!Array.isArray(result) || result.length > max) throw invalid(`${name} 必须是最多 ${max} 项的数组`);
  return result;
}
function safeDirectory(value, name) {
  const result = string(value, name, 160);
  if (!result || !/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(result)) throw invalid(`${name} 只能使用项目内的相对目录，不允许绝对路径或上级目录`);
  return result;
}
function sessionDirectory(wallet, index) {
  // Resolve existing ancestors as well as lexical paths so aliases cannot make
  // two independently locked wallet indexes share one CLI session directory.
  let ancestor = resolve(dirname(CONFIG_PATH), wallet.bawDir || `data/wallets/wallet-${index + 1}`);
  const pending = [];
  while (!existsSync(ancestor)) { pending.unshift(basename(ancestor)); ancestor = dirname(ancestor); }
  let directory;
  try { directory = resolve(realpathSync(ancestor), ...pending); }
  catch { throw invalid('无法验证钱包会话目录，请检查目录权限'); }
  // macOS usually uses a case-insensitive volume; reject ambiguous case aliases
  // conservatively even when this checkout happens to use a case-sensitive one.
  return process.platform === 'darwin' ? directory.toLowerCase() : directory;
}
function multiples(value, name, fallback) {
  const result = array(value, name, 20, fallback).map((entry) => number(entry, name, 1, 1e6));
  if (result.some((entry, index) => index > 0 && entry <= result[index - 1])) throw invalid(`${name} 必须严格递增`);
  return result;
}

export function getPaidConfig(config = {}) {
  const input = record(config.paid ?? {}, 'paid');
  const output = {};
  for (const key of ['goPct', 'earlyPct', 'riseDelta']) output[key] = number(input[key], `paid.${key}`, 0, 1, DEFAULT_PAID[key]);
  // A configured entry threshold below the default early threshold disables the
  // higher early threshold rather than rejecting an otherwise valid old config.
  if (input.earlyPct === undefined) output.earlyPct = Math.min(output.earlyPct, output.goPct);
  if (output.earlyPct > output.goPct) throw invalid('paid.earlyPct 不能大于 paid.goPct');
  for (const key of ['maxUsd', 'maxBnbPerDay', 'keepBnb']) output[key] = number(input[key], `paid.${key}`, 0, 1e6, DEFAULT_PAID[key]);
  output.minSold = number(input.minSold, 'paid.minSold', 0, 1e6, DEFAULT_PAID.minSold, true);
  output.maxAgeH = number(input.maxAgeH, 'paid.maxAgeH', 1, 8760, DEFAULT_PAID.maxAgeH);
  return output;
}

export function getRuleConfig(config = {}) {
  const input = record(config.rules ?? {}, 'rules');
  const hasNewRules = ['steps', 'crashAfterBack', 'moonPct', 'moonNotifyX'].some((key) => Object.hasOwn(input, key));
  const strategy = input.strategy ?? (Object.keys(input).length > 0 && !hasNewRules ? 'legacy' : 'steps');
  if (!['legacy', 'steps'].includes(strategy)) throw invalid('rules.strategy 必须是 legacy 或 steps');
  const defaults = strategy === 'legacy' ? LEGACY_RULES : DEFAULT_RULES;
  const output = { strategy };
  for (const key of ['backX', 'noPumpX']) output[key] = number(input[key], `rules.${key}`, key === 'backX' ? 1 : 0, 1e6, defaults[key]);
  for (const key of ['crash', 'fastCrash', 'drop']) output[key] = number(input[key], `rules.${key}`, 0, 1, defaults[key]);
  output.crashAfterBack = number(input.crashAfterBack, 'rules.crashAfterBack', 0, 1, strategy === 'legacy' ? output.crash : defaults.crashAfterBack);
  output.moonPct = number(input.moonPct, 'rules.moonPct', 0, 100, defaults.moonPct, true);
  output.moonNotifyX = multiples(input.moonNotifyX, 'rules.moonNotifyX', defaults.moonNotifyX);
  for (const key of ['fastMin', 'noPumpMin']) output[key] = number(input[key], `rules.${key}`, 0, 10080, defaults[key]);
  output.stallSec = number(input.stallSec, 'rules.stallSec', 0, 604800, defaults.stallSec);
  output.halfX = multiples(input.halfX, 'rules.halfX', defaults.halfX);
  output.notifyX = multiples(input.notifyX, 'rules.notifyX', defaults.notifyX);
  output.steps = array(input.steps, 'rules.steps', 20, defaults.steps).map((entry) => {
    if (!Array.isArray(entry) || entry.length !== 2) throw invalid('rules.steps 每项必须为 [倍数, 卖出百分比]');
    return [number(entry[0], 'rules.steps 倍数', 1, 1e6), number(entry[1], 'rules.steps 百分比', 1, 100, undefined, true)];
  });
  if (output.steps.some(([multiple], index) => (strategy === 'steps' && multiple <= output.backX) || (index > 0 && multiple <= output.steps[index - 1][0]))) throw invalid('rules.steps 倍数必须严格递增且大于 rules.backX');
  if (strategy === 'legacy' && output.halfX.some((entry) => entry <= output.backX)) throw invalid('rules.halfX 的每个倍数都必须大于 rules.backX');
  return output;
}

export function withinPaidBudget(paid, { spentBnb, costBnb, costUsd, balanceBnb }) {
  if (![spentBnb, costBnb, costUsd, balanceBnb].every((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0)) return false;
  return paid.maxUsd > 0 && paid.maxBnbPerDay > 0 && costUsd <= paid.maxUsd && spentBnb + costBnb <= paid.maxBnbPerDay && balanceBnb - costBnb >= paid.keepBnb;
}

export function validateConfig(value, { allowEmptyMonitor = true } = {}) {
  const input = normalizeWalletConfig(record(value, 'config'));
  const output = { monitorOnly: boolean(input.monitorOnly, 'monitorOnly'), enableFileCommands: boolean(input.enableFileCommands, 'enableFileCommands', false) };
  const names = new Set(), addresses = new Set(), sessions = new Set(), ids = new Set();
  output.wallets = array(input.wallets, 'wallets', 16).map((item, index) => {
    const wallet = record(item, `wallets[${index}]`), name = string(wallet.name, `wallets[${index}].name`, 80, `钱包 ${index + 1}`);
    if (!name) throw invalid(`wallets[${index}].name 不能为空`);
    const id = string(wallet.id, `wallets[${index}].id`, 80);
    if (!/^[a-zA-Z0-9_-]+$/.test(id) || ['__proto__', 'prototype', 'constructor'].includes(id)) throw invalid('钱包 ID 无效');
    if (ids.has(id)) throw invalid('钱包 ID 不能重复');
    ids.add(id);
    const mode = string(wallet.mode, `wallets[${index}].mode`, 20);
    if (!WALLET_MODES.includes(mode)) throw invalid('钱包模式必须为 monitor、sell-only 或 auto');
    const draft = boolean(wallet.draft, `wallets[${index}].draft`, false);
    const paused = boolean(wallet.paused, `wallets[${index}].paused`, false);
    if (draft && (mode !== 'monitor' || !paused)) throw invalid('尚未绑定地址的钱包必须暂停并保持监控模式');
    const addr = address(wallet.address, `wallets[${index}].address`, draft);
    if (names.has(name) || addr && addresses.has(addr.toLowerCase())) throw invalid('钱包名称与地址不能重复');
    names.add(name); if (addr) addresses.add(addr.toLowerCase());
    const result = { id, name, address: addr, agentId: string(wallet.agentId, `wallets[${index}].agentId`, 80), agentIdVerified: boolean(wallet.agentIdVerified, `wallets[${index}].agentIdVerified`, false), mode, paused, draft, archived: boolean(wallet.archived, `wallets[${index}].archived`, false) };
    result.legacyNames = array(wallet.legacyNames, `wallets[${index}].legacyNames`, 4).map((alias, aliasIndex) => {
      if (!string(alias, `wallets[${index}].legacyNames[${aliasIndex}]`, 80)) throw invalid('历史钱包别名不能为空');
      return alias;
    });
    if (new Set(result.legacyNames).size !== result.legacyNames.length) throw invalid('历史钱包别名不能重复');
    for (const field of ['autoMint', 'autoSellTokens', 'autoSellNfts']) result[field] = boolean(wallet[field], `wallets[${index}].${field}`, true);
    for (const field of ['bawDir', 'bawPkg']) if (wallet[field] !== undefined && wallet[field] !== '') result[field] = safeDirectory(wallet[field], `wallets[${index}].${field}`);
    if (wallet.instanceId !== undefined && wallet.instanceId !== '') {
      const id = string(wallet.instanceId, `wallets[${index}].instanceId`, 80);
      if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw invalid(`wallets[${index}].instanceId 只能包含英文字母、数字、下划线和连字符`);
      result.instanceId = id;
    }
    const session = sessionDirectory(result, index);
    if (sessions.has(session)) throw invalid('钱包会话目录不能重复，请为每个钱包设置独立的 bawDir');
    sessions.add(session);
    if (wallet.paid !== undefined) {
      const override = record(wallet.paid, `wallets[${index}].paid`);
      const validated = getPaidConfig({ paid: { ...(input.paid || {}), ...override } });
      result.paid = Object.fromEntries(Object.keys(DEFAULT_PAID).filter(key => Object.hasOwn(override, key)).map(key => [key, validated[key]]));
    }
    if (wallet.rules !== undefined) {
      const override = record(wallet.rules, `wallets[${index}].rules`);
      const validated = getRuleConfig({ rules: { ...(input.rules || {}), ...override } });
      result.rules = Object.fromEntries(Object.keys(DEFAULT_RULES).filter(key => Object.hasOwn(override, key)).map(key => [key, validated[key]]));
    }
    return result;
  });
  if (!output.wallets.some(wallet => !wallet.draft) && (!output.monitorOnly || !allowEmptyMonitor)) throw invalid('请先配置至少一个钱包，或使用只读监控模式');
  const portfolio = record(input.portfolioBudget ?? {}, 'portfolioBudget');
  output.portfolioBudget = { maxBnbPerDay: portfolio.maxBnbPerDay == null ? null : number(portfolio.maxBnbPerDay, 'portfolioBudget.maxBnbPerDay', 0, 1e6) };
  output.timeZone = string(input.timeZone, 'timeZone', 80, 'Asia/Shanghai');
  try { new Intl.DateTimeFormat('en', { timeZone: output.timeZone }); } catch { throw invalid('timeZone 不是有效的时区'); }
  const telegram = record(input.telegram ?? {}, 'telegram');
  output.telegram = { botToken: string(telegram.botToken, 'telegram.botToken', 256), chatId: string(telegram.chatId, 'telegram.chatId', 40), groupChatId: string(telegram.groupChatId, 'telegram.groupChatId', 40) };
  if (output.telegram.botToken && !/^\d+:[a-zA-Z0-9_-]+$/.test(output.telegram.botToken)) throw invalid('telegram.botToken 格式无效');
  for (const key of ['chatId', 'groupChatId']) if (output.telegram[key] && !/^-?\d+$/.test(output.telegram[key])) throw invalid(`telegram.${key} 必须是数字 ID`);
  output.paid = getPaidConfig(input);
  output.rules = getRuleConfig(input);
  output.tokens = array(input.tokens, 'tokens', 1000).map((item, index) => {
    const token = record(item, `tokens[${index}]`);
    const result = { sym: string(token.sym, `tokens[${index}].sym`, 80), addr: address(token.addr, `tokens[${index}].addr`), cost: number(token.cost, `tokens[${index}].cost`, 0, 1e12, 0) };
    if (!result.sym) throw invalid(`tokens[${index}].sym 不能为空`);
    for (const key of ['both', 'hold', 'sellNow']) if (token[key] !== undefined) result[key] = boolean(token[key], `tokens[${index}].${key}`);
    if (token.only) result.only = address(token.only, `tokens[${index}].only`);
    if (token.costWalletAddress !== undefined) result.costWalletAddress = address(token.costWalletAddress, `tokens[${index}].costWalletAddress`);
    return result;
  });
  output.watchVault = address(input.watchVault, 'watchVault', true);
  output.forceMint = [...new Set(array(input.forceMint, 'forceMint', 100).map((entry) => address(entry, 'forceMint')))];
  output.notifyAll = boolean(input.notifyAll, 'notifyAll', false);
  output.rpcs = [...new Set(array(input.rpcs, 'rpcs', 12).map((entry) => {
    const text = string(entry, 'rpcs', 2048);
    let url; try { url = new URL(text); } catch { throw invalid('rpcs 必须是有效的 HTTP/HTTPS 节点地址'); }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash) throw invalid('rpcs 必须是没有用户信息或片段的 HTTP/HTTPS 节点地址');
    return url.href;
  }))];
  return output;
}

export function readConfig({ path = CONFIG_PATH } = {}) {
  if (!existsSync(path)) return clone(DEFAULT_CONFIG);
  return normalizeWalletConfig(JSON.parse(readFileSync(path, 'utf8')));
}

export function sanitizeConfig(raw) {
  raw = normalizeWalletConfig(raw);
  const pick = (value, keys) => Object.fromEntries(keys.filter((key) => value?.[key] !== undefined).map((key) => [key, clone(value[key])]));
  const result = pick(raw, Object.keys(DEFAULT_CONFIG));
  result.wallets = Array.isArray(raw.wallets) ? raw.wallets.map((wallet) => ({ ...pick(wallet, ['id', 'name', 'address', 'agentId', 'agentIdVerified', 'legacyNames', 'bawDir', 'bawPkg', 'instanceId', 'mode', 'paused', 'archived', 'draft', 'autoMint', 'autoSellTokens', 'autoSellNfts']), ...(wallet.paid ? { paid: pick(wallet.paid, Object.keys(DEFAULT_PAID)) } : {}), ...(wallet.rules ? { rules: pick(wallet.rules, Object.keys(DEFAULT_RULES)) } : {}) })) : [];
  result.portfolioBudget = { maxBnbPerDay: raw.portfolioBudget?.maxBnbPerDay ?? null };
  result.paid = pick(raw.paid, Object.keys(DEFAULT_PAID));
  result.rules = getRuleConfig(raw);
  result.tokens = Array.isArray(raw.tokens) ? raw.tokens.map((token) => pick(token, ['sym', 'addr', 'cost', 'both', 'hold', 'sellNow', 'only', 'costWalletAddress'])) : [];
  result.telegram = { ...pick(raw.telegram, ['chatId', 'groupChatId']), botToken: '', botTokenConfigured: Boolean(raw.telegram?.botToken || process.env.TG_BOT_TOKEN) };
  return result;
}

export function saveConfig(input, { path = CONFIG_PATH, allowEmptyMonitor = true, allowWalletBinding = false } = {}) {
  record(input, 'config');
  const current = readConfig({ path });
  const merged = { ...current, ...input };
  if (Array.isArray(input.tokens)) {
    merged.tokens = input.tokens.map(token => {
      if (!isRecord(token) || token.costWalletAddress !== undefined || token.only || token.both) return token;
      const previous = (current.tokens || []).find(old => String(old.addr || '').toLowerCase() === String(token.addr || '').toLowerCase() && !old.only && !old.both && old.costWalletAddress);
      return previous ? { ...token, costWalletAddress: previous.costWalletAddress } : token;
    });
  }
  if (Array.isArray(input.wallets)) {
    merged.wallets = input.wallets.map(wallet => {
      if (!isRecord(wallet)) return wallet;
      const previous = (current.wallets || []).find(old => wallet.id ? old.id === wallet.id : old.address && old.address.toLowerCase() === String(wallet.address || '').toLowerCase());
      if (!previous) {
        if ((current.wallets || []).some(old => old.address && old.address.toLowerCase() === String(wallet.address || '').toLowerCase())) throw invalid('不能为已有钱包更换 ID');
        if (wallet.agentIdVerified === true && !allowWalletBinding) throw invalid('Agent ID 核验标记只能由官方钱包导入设置');
        if (wallet.legacyNames !== undefined && (!Array.isArray(wallet.legacyNames) || wallet.legacyNames.length)) throw invalid('新钱包不能伪造存量历史别名');
        return { ...wallet, legacyNames: [] };
      }
      const next = { ...previous, ...wallet, id: previous.id };
      if (JSON.stringify(next.legacyNames) !== JSON.stringify(previous.legacyNames)) throw invalid('历史钱包别名不能修改或伪造');
      if (next.agentIdVerified !== previous.agentIdVerified && (!allowWalletBinding || next.agentIdVerified !== true)) throw invalid('Agent ID 核验标记只能由官方钱包导入设置');
      const sameAddress = Boolean(previous.address) && String(next.address || '').toLowerCase() === previous.address.toLowerCase();
      const firstBinding = previous.draft === true && !previous.address;
      for (const field of ['address', 'bawDir', 'instanceId', 'agentId']) {
        if (next[field] === previous[field]) continue;
        if (field === 'address' && String(next.address || '').toLowerCase() === String(previous.address || '').toLowerCase()) { next.address = previous.address; continue; }
        const binding = allowWalletBinding && (field === 'address' && firstBinding || field === 'agentId' && (previous.agentIdVerified !== true || !previous.agentId) && (firstBinding || sameAddress));
        if (!binding) throw invalid(`钱包 ${field} 已绑定，不能修改；请添加独立钱包`);
      }
      if (allowWalletBinding && (next.agentId !== previous.agentId || firstBinding && next.address)) next.agentIdVerified = true;
      return next;
    });
    const retained = new Set(normalizeWalletConfig({ ...merged }).wallets.map(wallet => wallet?.id));
    if ((current.wallets || []).some(wallet => !retained.has(wallet.id))) throw invalid('请停用或归档钱包，不要删除其会话与订单归属');
  }
  for (const key of ['paid', 'rules', 'telegram']) {
    if (input[key] !== undefined) merged[key] = { ...(current[key] || {}), ...record(input[key], key) };
  }
  if (input.telegram?.clearBotToken === true) merged.telegram.botToken = '';
  else if (!input.telegram?.botToken) merged.telegram = { ...(merged.telegram || {}), botToken: current.telegram?.botToken || '' };
  const validated = validateConfig(merged, { allowEmptyMonitor });
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(validated, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } finally { rmSync(temporary, { force: true }); }
  return sanitizeConfig(validated);
}
