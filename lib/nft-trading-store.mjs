import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { validateNftRule, hashRule } from './nft-rules.mjs';

export function writePrivateJson(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx', flush: true });
    renameSync(temporary, path); chmodSync(path, 0o600);
  } finally { rmSync(temporary, { force: true }); }
}
function readJson(path, fallback) {
  if (!existsSync(path)) return structuredClone(fallback);
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw Object.assign(new Error('NFT 本地配置无法读取，请检查文件后重试'), { status: 409 }); }
}

export function createNftTradingStore({ rulesFile, settingsFile, now = Date.now, env = process.env, write = writePrivateJson }) {
  const readRules = () => {
    const data = readJson(rulesFile, { version: 1, rules: [] });
    if (data.version !== 1 || !Array.isArray(data.rules) || data.rules.length > 500) throw Object.assign(new Error('NFT 规则文件格式无效'), { status: 409 });
    return data.rules.map(entry => {
      const { policyHash, consent, updatedAt, authorizedAt, key, ...raw } = entry;
      const rule = validateNftRule(raw);
      const hash = hashRule(rule);
      return { ...rule, policyHash: hash, updatedAt, ...(consent?.policyHash === hash ? { consent } : {}) };
    });
  };
  const getApiKey = () => {
    const settings = readJson(settingsFile, { version: 1, apiKey: '' });
    return settings.apiKey || env.ELEMENT_API_KEY || '';
  };
  const view = () => ({ settings: { apiKeyConfigured: Boolean(getApiKey()) }, rules: readRules().map(({ consent, ...rule }) => ({ ...rule, authorizedAt: consent?.acceptedAt || null })) });
  function saveSettings(input) {
    if (!input || typeof input !== 'object' || Object.keys(input).some(key => !['apiKey', 'clearApiKey'].includes(key))) throw Object.assign(new Error('NFT 市场设置字段无效'), { status: 400 });
    const old = readJson(settingsFile, { version: 1, apiKey: '' });
    let apiKey = old.apiKey || '';
    if (input.clearApiKey === true) apiKey = '';
    else if (input.apiKey !== undefined && input.apiKey !== '') {
      if (typeof input.apiKey !== 'string' || !/^[\x21-\x7e]{8,512}$/.test(input.apiKey)) throw Object.assign(new Error('API Key 格式无效，不允许空白或控制字符'), { status: 400 });
      apiKey = input.apiKey;
    }
    write(settingsFile, { version: 1, apiKey });
    return { apiKeyConfigured: Boolean(getApiKey()) };
  }
  function saveRule(raw) {
    if (!raw || typeof raw !== 'object') throw Object.assign(new Error('缺少 NFT 规则'), { status: 400 });
    const { policyHash, updatedAt, authorizedAt, key, consent, ...input } = raw;
    const rule = validateNftRule({ ...input, enabled: false });
    const rules = readRules(), index = rules.findIndex(entry => entry.key === rule.key);
    const saved = { ...rule, policyHash: hashRule(rule), updatedAt: now() };
    if (index === -1) { if (rules.length >= 500) throw Object.assign(new Error('最多保存 500 条 NFT 规则'), { status: 400 }); rules.push(saved); }
    else rules[index] = saved;
    write(rulesFile, { version: 1, rules });
    return { ...saved, authorizedAt: null };
  }
  function setEnabled(key, enabled, policyHash) {
    const rules = readRules(), rule = rules.find(rule => rule.key === key);
    if (!rule) throw Object.assign(new Error('NFT 规则不存在，请先保存'), { status: 404 });
    if (enabled && policyHash !== rule.policyHash) throw Object.assign(new Error('NFT 规则已改变，请重新核对价格和授权'), { status: 409 });
    const { policyHash: savedHash, consent: savedConsent, updatedAt: savedAt, ...input } = rule;
    try { validateNftRule({ ...input, enabled: enabled === true }); }
    catch (error) { throw Object.assign(error, { status: 400 }); }
    rule.enabled = enabled === true;
    if (enabled) rule.consent = { policyHash: rule.policyHash, acceptedAt: now() };
    else delete rule.consent;
    rule.updatedAt = now(); write(rulesFile, { version: 1, rules });
    const { consent, ...safe } = rule;
    return { ...safe, authorizedAt: consent?.acceptedAt || null };
  }
  return { readRules, getApiKey, view, saveSettings, saveRule, setEnabled };
}
