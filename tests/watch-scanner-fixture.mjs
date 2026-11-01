// Execute the real scanner functions with in-memory I/O. No network, filesystem
// mutation, wallet process, authentication, or Telegram request can escape the VM.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPaidConfig, getRuleConfig, withinPaidBudget } from '../lib/config.mjs';
import { createHash } from 'node:crypto';
import { decodeAbiUint } from '../lib/nft-codec.mjs';
import * as sellRules from '../lib/sell-rules.mjs';
import * as walletModel from '../lib/wallet-model.mjs';
import * as mintPolicy from '../lib/mint-policy.mjs';

export const raw = readFileSync(new URL('../watch.mjs', import.meta.url), 'utf8');
export const VIRTUAL_ROOT = '/isolated/watch-monitor';
export const wallet = { name: 'test-wallet', address: '0x1111111111111111111111111111111111111111' };
export const target = '0x2222222222222222222222222222222222222222';
export const deployer = '0x3333333333333333333333333333333333333333';
export const registry = '60b9262456de011f7d15a54cdd8c48baaa8b022f';
export const word = value => BigInt(value).toString(16).padStart(64, '0');
// Upstream may append release comments. Only whitespace and // line comments
// may follow the entry call; another executable statement remains a failure.
const entryPoint = /\nmain\(\);(?:\s|\/\/[^\r\n]*(?=\r?\n|$))*$/;

export function isolatedWatch({ wallets = [], monitorOnly = true, enableFileCommands, tokens = [], state, files = {}, rpcResponse, cliFactory, configOverrides = {}, sourceText = raw } = {}) {
  assert.doesNotMatch(sourceText, /^(?:<<<<<<<|=======|>>>>>>>)/m, 'watch.mjs merge must be resolved before running scanner tests');
  assert.match(sourceText, entryPoint, 'explicitly isolate the current scanner entry point before evaluating it');
  assert.equal(sourceText.match(/\nmain\(\);/g)?.length, 1, 'explicitly isolate the single scanner entry point before evaluating it');
  const source = sourceText
    .replace(/^import .*;\n/gm, '')
    .replaceAll('import.meta.url', JSON.stringify('file://' + VIRTUAL_ROOT + '/watch.mjs'))
    .replace(entryPoint, `
globalThis.api = {
  makeBaw, sell, holdings, holdW, positionFor, findFree, queueMint, autoMintMax, autoMint,
  previewExec, executeUsdtMint, paidLoop, loginCheck, cmdSell, manualMints, scanNew,
  getState: () => S, getMe: () => ME, getWallets: () => WALLETS,
  getMintQueueSize: () => MQ.size,
  canWallet, paidFor, rulesFor, syncWalletProfiles, runtimeWallet, tokenCostFor,
  heatOf, freeProgress, getInflight: () => INFLIGHT,
  setHoldingsWorker: fn => { holdW = fn; },
};`);
  const config = { monitorOnly, enableFileCommands, wallets, tokens, telegram: {}, timeZone: 'Asia/Shanghai', forceMint: [target], ...configOverrides };
  const memoryFiles = new Map(Object.entries(files).map(([path, value]) => [join(VIRTUAL_ROOT, path), typeof value === 'string' ? value : JSON.stringify(value)]));
  const seen = { cliFactories: [], cliCalls: [], network: [], writes: [], directories: [], logs: [], errors: [] };
  const timers = [];
  const sandbox = {
    Buffer, structuredClone, dirname, join, fileURLToPath, withinPaidBudget, decodeAbiUint, createHash, ...sellRules, ...mintPolicy,
    normalizeWalletConfig: input => walletModel.normalizeWalletConfig(JSON.parse(JSON.stringify(input))),
    getWalletId: walletModel.getWalletId,
    effectiveWalletConfig: (config, wallet) => walletModel.effectiveWalletConfig(JSON.parse(JSON.stringify(config)), JSON.parse(JSON.stringify(wallet))),
    walletCanAutomate: (config, wallet, kind) => walletModel.walletCanAutomate(JSON.parse(JSON.stringify(config)), JSON.parse(JSON.stringify(wallet)), kind),
    withWalletExecution: async (_wallet, work) => work(),
    reconcileScannerPending: async () => { throw new Error('Unexpected recovery in monitor fixture'); },
    markWalletBlocked: async () => {}, clearWalletBlocked: async () => {},
    createWalletBudget: () => { throw new Error('Monitor fixture must not create a real execution ledger'); },
    createMintMedia: () => ({ check: async () => ({ verified: true }) }),
    createSafeWeb: () => async () => { throw new Error('Unexpected social or metadata web request in scanner fixture'); },
    processSocialCandidates: async () => [],
    getRuleConfig: input => getRuleConfig(JSON.parse(JSON.stringify(input))),
    // Validation uses host-realm records; clone the VM config without reading any
    // real configuration or changing the validation behavior under test.
    getPaidConfig: input => getPaidConfig(JSON.parse(JSON.stringify(input))),
    makeWatchBaw(profile, index) {
      seen.cliFactories.push({ profile, index });
      if (cliFactory) return cliFactory(profile, index, seen);
      return async args => {
        seen.cliCalls.push(args);
        return { t: '{"success":true,"data":{"status":"CONNECTED"}}', j: { success: true, data: { status: 'CONNECTED' } } };
      };
    },
    async fetch(url, options) {
      assert.ok(options?.body, 'only explicit mocked JSON-RPC calls are allowed');
      assert.ok(!String(url).includes('telegram.org'), 'Telegram calls must not run in this harness');
      const request = JSON.parse(options.body);
      seen.network.push(request);
      if (!rpcResponse) throw new Error('Unexpected mocked network request: ' + request.method);
      return { async json() { return { result: await rpcResponse(request) }; } };
    },
    appendFileSync(path, value) { seen.logs.push({ path, value }); },
    writeFileSync(path, value) { if (path !== join(VIRTUAL_ROOT, 'data', 'watch.lock')) seen.writes.push({ path, value }); memoryFiles.set(path, String(value)); },
    mkdirSync(path, options) { seen.directories.push({ path, recursive: options.recursive }); },
    readFileSync(path) {
      if (path === join(VIRTUAL_ROOT, 'config.json')) return JSON.stringify(config);
      if (path === join(VIRTUAL_ROOT, 'data', 'watch_state.json') && state) return JSON.stringify(state);
      if (memoryFiles.has(path)) return memoryFiles.get(path);
      throw new Error('No such in-memory file');
    },
    existsSync: path => memoryFiles.has(path),
    unlinkSync: path => { seen.writes.push({ path, removed: true }); memoryFiles.delete(path); },
    copyFileSync() { throw new Error('Copying scanner code is forbidden in the test harness'); },
    statSync: () => ({ mtimeMs: 1 }),
    process: { execPath: '/mock/node', env: {}, on() {}, exit(code) { throw new Error('SCANNER_EXIT_' + code); } },
    console: { error: message => seen.errors.push(message), log() {} },
    AbortSignal: { timeout: () => ({}) },
    setInterval: () => ({ unref() {} }),
    setTimeout(callback, ms) { if (ms > 0) { const timer = { callback, ms, unref() {} }; timers.push(timer); return timer; } callback(); return { unref() {} }; },
  };
  vm.runInNewContext(source, sandbox, { filename: 'isolated-watch.mjs', timeout: 1000 });
  return { api: sandbox.api, seen, config, timers, setFile: (path, value) => memoryFiles.set(join(VIRTUAL_ROOT, path), String(value)), file: path => memoryFiles.get(join(VIRTUAL_ROOT, path)) };
}

