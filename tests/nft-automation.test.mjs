// Fault-injection integration tests. Only temporary files and in-memory market /
// wallet / JSON-RPC doubles are used; no real keys, wallet CLI or network runs.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { TypedDataEncoder, Wallet } from 'ethers';
import { createNftAutomation } from '../lib/nft-automation.mjs';
import { createNftTradingStore, writePrivateJson } from '../lib/nft-trading-store.mjs';
import { parseBnbWei } from '../lib/nft-rules.mjs';
import { NFT_EVENT_TOPICS } from '../lib/nft-codec.mjs';

const signer = Wallet.createRandom(); // ephemeral test identity, never logged
const walletAddress = signer.address.toLowerCase();
const addr = '0x2222222222222222222222222222222222222222';
const exchange = '0xb3e3dfcb2d9f3dde16d78b9e6eb3538eb32b5ae1';
const wrapped = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
const hash = '0x' + 'a'.repeat(64);
const word = (value) => BigInt(value).toString(16).padStart(64, '0');
const addressWord = (value) => '0x' + value.slice(2).padStart(64, '0');
const wei = (value) => parseBnbWei(value).toString();

function harness(options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'nft-automation-test-'));
  const stateFile = join(directory, 'state.json');
  let clock = 1800000000000, engine, currentPlan;
  const seen = { wallet: [], executes: [], publications: [], writes: [], positionCalls: 0 };
  const store = createNftTradingStore({ rulesFile: join(directory, 'rules.json'), settingsFile: join(directory, 'settings.json'), now: () => clock, env: { ELEMENT_API_KEY: 'fake-test-api-key' } });
  const saved = store.saveRule({ walletAddress, addr, standard: 'ERC721', tokenId: '7', quantity: '1', mode: options.mode || 'take-profit-offer', listingUnitPriceBnb: '0.5', takeProfitNetBnb: '0.6', trailingArmNetBnb: '0.7', minNetBnb: '0.4', maxFeesBnb: '0.02', expirySec: 300, cooldownSec: 5, ...options.rule });
  if (options.enabled !== false) store.setEnabled(saved.key, true, saved.policyHash);
  const currentRule = () => store.readRules()[0];
  const binding = (rule) => ({ walletAddress: rule.walletAddress, addr: rule.addr, standard: rule.standard, tokenId: rule.tokenId, quantity: rule.quantity });
  const simulation = () => options.simulation ?? {
    simulationCode: '000000000', allowanceChanges: [], authorityChanges: [],
    balanceChanges: [{ owner: walletAddress, contractAddress: addr, tokenType: 'Erc721', tokenId: '7', change: '-1' }, { owner: walletAddress, contractAddress: wrapped, tokenType: 'Erc20', change: wei('1') }],
  };
  const quote = (rule) => ({ ...binding(rule), source: rule.mode === 'fixed-listing' ? 'listing-fees' : 'executable-offer', currency: rule.mode === 'fixed-listing' ? 'BNB' : 'WBNB', quoteId: 'mock-quote', grossWei: wei(rule.mode === 'fixed-listing' ? '0.5' : '1.01'), feesWei: wei('0.01'), marketFeesWei: wei('0.01'), gasWei: '0', expiresAt: clock + 60000, context: { transaction: { to: exchange, data: '0x12345678', value: '0' } } });
  const market = {
    async position(rule) {
      seen.positionCalls++;
      if (options.onPosition) await options.onPosition({ rule, seen, store, advance: ms => { clock += ms; } });
      return { ...binding(rule), verifiedOwnership: true, verifiedAt: clock, approved: options.approved !== false, approval: { to: addr, data: '0x095ea7b3', value: '0', scope: 'token', spender: exchange, tokenId: '7' } };
    },
    async quote(rule) { return quote(rule); },
    async buildListing(rule, q) {
      const typedData = { domain: { name: 'NftAutomationTest', version: '1', chainId: 56, verifyingContract: exchange }, types: { Listing: [{ name: 'maker', type: 'address' }, { name: 'nft', type: 'address' }, { name: 'id', type: 'uint256' }, { name: 'price', type: 'uint256' }] }, message: { maker: walletAddress, nft: addr, id: '7', price: q.grossWei } };
      currentPlan = { ...binding(rule), typedData, hash: TypedDataEncoder.hash(typedData.domain, typedData.types, typedData.message), order: { maker: walletAddress, nonce: '1', hashNonce: '1' }, nonce: '1', expirationTime: Math.floor(clock / 1000) + rule.expirySec, expiresAt: q.expiresAt, grossWei: q.grossWei, feesWei: q.feesWei };
      return currentPlan;
    },
    async publishListing(plan, signature) { seen.publications.push({ plan, signature }); return { verified: true, orderId: 'market-order-1', hash: plan.hash }; },
    async orderStatus() { return { status: 'listed', verified: true, confirmed: true }; },
    async verifyFill() { return { confirmed: true, filledQuantity: '1', netWei: wei('1'), currency: 'WBNB' }; },
    async cancelTransaction() { return { to: exchange, data: '0xabcd1234', value: '0' }; },
  };
  const runWallet = async (args) => {
    seen.wallet.push(args);
    if (args[0] === 'wallet') {
      if (args[1] === 'status') return { success: true, data: { status: 'CONNECTED' } };
      if (args[1] === 'settings') return { success: true, data: { devMode: { enabled: true, expiresAt: clock + 3600000 } } };
      if (args[1] === 'address') return { success: true, data: { addresses: [{ binanceChainId: '56', address: walletAddress }] } };
      if (args[1] === 'tx-lock') return { success: true, data: { status: 'UNLOCKED' } };
    }
    if (args[1] === 'preview') {
      const risks = Object.hasOwn(options, 'risks') ? options.risks : { riskDetails: [], riskBehaviors: [], addresses: {} };
      return { success: true, data: { requestId: 'mock-request', expiresAt: clock + 60000, parsedTx: { test: true }, ...(risks === undefined ? {} : { risks }), simulationResult: simulation(), requireConfirmation: options.requireConfirmation === true } };
    }
    if (args[1] === 'execute') {
      seen.executes.push(args);
      if (options.executeResult) return options.executeResult(args);
      return { success: true, data: args[0] === 'sign-message' ? options.signaturePending ? { orderId: 'signature-1', status: 'PENDING_CONFIRMATION' } : { signature: signer.signingKey.sign(currentPlan.hash).serialized } : { orderId: 'wallet-order-1', txHash: hash, status: 'SUBMITTED' } };
    }
    if (args[0] === 'sign-message' && args[1] === 'result') return { success: true, data: { status: 'COMPLETED', signature: signer.signingKey.sign(currentPlan.hash).serialized } };
    throw new Error('Unexpected mocked wallet command ' + args.slice(0, 2).join(' '));
  };
  const rpc = async (method) => {
    if (method === 'eth_estimateGas') return options.estimatedGas || '0x5208';
    if (method === 'eth_gasPrice') return options.gasPrice || '0x3b9aca00';
    if (method === 'eth_blockNumber') { if (options.onHead) await options.onHead({ store, seen, advance: ms => { clock += ms; } }); return '0x64'; }
    if (method === 'eth_getTransactionReceipt') return Object.hasOwn(options, 'receipt') ? options.receipt : { transactionHash: hash, status: '0x1', logs: [{ address: addr, topics: [NFT_EVENT_TOPICS.ERC721_TRANSFER, addressWord(walletAddress), addressWord(exchange), '0x' + word(7)], data: '0x' }], gasUsed: '0x1', effectiveGasPrice: '0x1' };
    if (method === 'eth_getTransactionByHash') return { hash, from: walletAddress, to: exchange, input: '0x12345678', value: '0x0', ...options.transaction };
    if (method === 'eth_getLogs') return [];
    throw new Error('Unexpected mocked RPC ' + method);
  };
  const config = { monitorOnly: options.monitorOnly === true, wallets: [{ name: 'mock-wallet', address: walletAddress }] };
  const dependencies = {
    store, market, runWallet, rpc, readConfig: () => config, serviceInfo: async () => ({ running: options.running !== false }), stateFile, now: () => clock,
    write(path, value) { seen.writes.push(structuredClone(value)); if (options.failWrite?.(value)) throw new Error('simulated disk failure'); writePrivateJson(path, value); },
  };
  engine = createNftAutomation(dependencies);
  return { engine, store, market, seen, key: saved.key, stateFile, currentRule, restart: () => createNftAutomation(dependencies), state: () => existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')).states[saved.key] : null, advance(ms = 16000) { clock += ms; }, cleanup() { engine.stop(); rmSync(directory, { recursive: true, force: true }); } };
}

test('disabled, monitor-only or stopped NFT automation never broadcasts', async () => {
  for (const options of [{ enabled: false }, { monitorOnly: true }, { running: false }]) {
    const h = harness(options); try { await h.engine.tick(); assert.equal(h.seen.executes.length, 0); assert.equal(h.seen.publications.length, 0); } finally { h.cleanup(); }
  }
});

test('a durable intent precedes a mocked offer broadcast and an uncertain result blocks restart retries', async () => {
  const h = harness({ executeResult: async () => ({ success: false, error: { name: 'TIMEOUT', message: 'mock response lost' } }) });
  try {
    await h.engine.tick(); assert.equal(h.seen.executes.length, 1); assert.equal(h.state().phase, 'review');
    assert.ok(h.seen.writes.some(value => value.states[h.key].effectIntent?.stage === 'submitting'));
    h.advance(); const restarted = h.restart(); await restarted.tick();
    assert.equal(h.seen.executes.length, 1); assert.equal(h.state().phase, 'review'); restarted.stop();
  } finally { h.cleanup(); }
});

test('state-write failure prevents the wallet execute call', async () => {
  const h = harness({ failWrite: value => Object.values(value.states).some(state => state.effectIntent?.stage === 'submitting') });
  try { await assert.rejects(h.engine.tick(), /disk failure/); assert.equal(h.seen.executes.length, 0); } finally { h.cleanup(); }
});

test('unexpected NFT-sale asset changes and unknown/missing risk schemas require manual confirmation', async () => {
  const extraAsset = { simulationCode: '000000000', allowanceChanges: [], authorityChanges: [], balanceChanges: [{ owner: walletAddress, contractAddress: addr, tokenType: 'Erc721', tokenId: '7', change: '-1' }, { owner: walletAddress, contractAddress: wrapped, tokenType: 'Erc20', change: wei('1') }, { owner: walletAddress, contractAddress: '0x55d398326f99059ff775485246999027b3197955', tokenType: 'Erc20', change: '-1' }] };
  for (const options of [{ simulation: extraAsset }, { risks: { unknownPolicy: [] } }, { risks: undefined }, { risks: { riskDetails: [], riskBehaviors: [], addresses: { [exchange]: { riskDetails: [], riskLevel: -1 } } } }, { risks: { riskDetails: [], riskBehaviors: [], addresses: { [exchange]: { riskDetails: [], riskLevel: null } } } }]) {
    const h = harness(options); try { await h.engine.tick(); assert.equal(h.seen.executes.length, 0); assert.equal(h.state().phase, 'awaiting-confirmation'); } finally { h.cleanup(); }
  }
});

test('a wallet preview that explicitly requests confirmation cannot execute automatically', async () => {
  const h = harness({ requireConfirmation: true });
  try { await h.engine.tick(); assert.equal(h.seen.executes.length, 0); assert.equal(h.state().phase, 'awaiting-confirmation'); } finally { h.cleanup(); }
});

test('the final gas estimate enforces both total fee cap and take-profit net target', async () => {
  for (const options of [{ estimatedGas: '0x989680' }, { rule: { takeProfitNetBnb: '1' } }]) {
    const h = harness(options);
    try { await h.engine.tick(); assert.equal(h.seen.executes.length, 0); assert.equal(h.state().phase, 'blocked'); assert.match(h.state().reason, /Gas|净收入/); } finally { h.cleanup(); }
  }
});

test('overlapping scheduler ticks never prepare two automatic sells', async () => {
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const h = harness({ onPosition: async ({ seen }) => { if (seen.positionCalls === 1) { entered(); await gate; } } });
  try {
    const first = h.engine.tick(); await started;
    await h.engine.tick(); assert.equal(h.seen.executes.length, 0);
    release(); await first;
    assert.equal(h.seen.executes.length, 1); assert.equal(h.state().phase, 'pending');
  } finally { release(); h.cleanup(); }
});

test('disabling or expiring the rule during awaited preflights or final block lookup prevents execute', async () => {
  const disableAfterPreview = async ({ store, seen }) => { if (seen.wallet.some(args => args[1] === 'preview')) store.setEnabled(store.readRules()[0].key, false); };
  const expireAfterPreview = async ({ seen, advance }) => { if (seen.wallet.some(args => args[1] === 'preview')) advance(61000); };
  for (const options of [{ onPosition: disableAfterPreview }, { onPosition: expireAfterPreview }, { onHead: disableAfterPreview }, { onHead: expireAfterPreview }]) {
    const h = harness(options); try { await h.engine.tick(); assert.equal(h.seen.executes.length, 0); } finally { h.cleanup(); }
  }
});

test('a pending listing signature is not published after the rule is disabled', async () => {
  const h = harness({ mode: 'fixed-listing', signaturePending: true });
  try {
    await h.engine.tick(); assert.equal(h.state().phase, 'signature-pending'); assert.equal(h.seen.executes.length, 1);
    h.store.setEnabled(h.key, false); h.advance(); await h.engine.tick();
    assert.equal(h.seen.publications.length, 0); assert.equal(h.state().phase, 'review');
  } finally { h.cleanup(); }
});

test('a confirmed fill is terminal and cannot cause another automatic listing or sell', async () => {
  const h = harness();
  try {
    await h.engine.tick(); assert.equal(h.state().phase, 'pending');
    h.advance(); await h.engine.tick(); assert.equal(h.state().phase, 'filled');
    h.advance(); await h.engine.tick(); assert.equal(h.seen.executes.length, 1); assert.equal(h.state().phase, 'filled');
  } finally { h.cleanup(); }
});

test('missing, reverted or mismatched sale evidence never advances filled or resubmits', async () => {
  for (const options of [{ receipt: null }, { receipt: { status: '0x0', logs: [] } }, { receipt: { status: '0x1', logs: [], gasUsed: '0x1', effectiveGasPrice: '0x1' } }, { transaction: { input: '0xdeadbeef' } }]) {
    const h = harness(options);
    try {
      await h.engine.tick(); assert.equal(h.seen.executes.length, 1);
      h.advance(); await h.engine.tick(); assert.equal(h.state().phase, options.receipt === null ? 'pending' : 'review');
      assert.equal(h.state().ruleState.filledQuantity, '0');
      h.advance(); await h.engine.tick(); assert.equal(h.seen.executes.length, 1);
    } finally { h.cleanup(); }
  }
});

test('manual previews are browser-owned and one-use before any mocked execute', async () => {
  const h = harness({ enabled: false });
  try {
    const preview = await h.engine.preview(h.key, 'owner-a'); assert.ok(preview.actionId);
    await assert.rejects(h.engine.confirm(preview.actionId, 'owner-b', true), /页面|属于/); assert.equal(h.seen.executes.length, 0);
    await h.engine.confirm(preview.actionId, 'owner-a', true); assert.equal(h.seen.executes.length, 1);
    await assert.rejects(h.engine.confirm(preview.actionId, 'owner-a', true), /预演/); assert.equal(h.seen.executes.length, 1);
  } finally { h.cleanup(); }
});

test('a bound listing can be cancelled even after its NFT ownerOf becomes unreadable', async () => {
  const h = harness({ mode: 'fixed-listing', transaction: { input: '0xabcd1234' } });
  try {
    await h.engine.tick(); assert.equal(h.state().phase, 'listed');
    h.market.position = async () => { throw new Error('ownerOf reverted after burn'); };
    h.market.orderStatus = async () => ({ status: 'cancelled', confirmed: true });
    const preview = await h.engine.preview(h.key, 'browser-owner', true);
    assert.ok(preview.actionId);
    await h.engine.confirm(preview.actionId, 'browser-owner', true);
    assert.equal(h.currentRule().enabled, false);
    h.advance(); await h.engine.tick();
    assert.equal(h.state().phase, 'cancelled');
  } finally { h.cleanup(); }
});

test('store cannot enable an incomplete draft or corrupt the saved rule set', () => {
  const h = harness({ enabled: false });
  try {
    const draft = h.store.saveRule({ walletAddress, addr, standard: 'ERC721', tokenId: '7', mode: 'fixed-listing' });
    assert.throws(() => h.store.setEnabled(draft.key, true, draft.policyHash), /required/);
    assert.equal(h.store.readRules()[0].enabled, false);
  } finally { h.cleanup(); }
});
