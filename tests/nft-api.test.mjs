import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { createApp } from '../server.mjs';
import { DEFAULT_CONFIG, sanitizeConfig } from '../lib/config.mjs';

async function fixture(t) {
  const calls = [], previews = new Map(); let apiKey = '';
  const nft = {
    async view() { return { settings: { apiKeyConfigured: Boolean(apiKey) }, rules: [], states: {}, capabilities: { ready: false } }; },
    getApiKey: () => apiKey,
    saveSettings(input) { apiKey = input.apiKey || ''; return { apiKeyConfigured: Boolean(apiKey) }; },
    saveRule(rule) { calls.push(['save', rule]); return { ...rule, enabled: false }; },
    enable(key, hash, confirmed) { if (confirmed !== true) throw Object.assign(new Error('Explicit confirmation required'), { status: 409 }); calls.push(['enable', key, hash]); return { key, enabled: true }; },
    disable(key) { calls.push(['disable', key]); return { key, enabled: false }; },
    preview(key, owner, cancel = false) { previews.set('mock-preview', { key, owner, cancel }); return { actionId: 'mock-preview', status: 'preview' }; },
    confirm(actionId, owner, confirmed) {
      const p = previews.get(actionId);
      if (!p || p.owner !== owner || confirmed !== true) throw Object.assign(new Error('Invalid confirmation'), { status: 409 });
      previews.delete(actionId); calls.push([p.cancel ? 'cancel' : 'confirm', p.key]); return { phase: 'pending' };
    },
    stop() {}, hasInFlight: () => false,
  };
  const app = createApp({ nftTrading: nft, readConfig: () => structuredClone(DEFAULT_CONFIG), sanitizeConfig, dashboardStatus: async () => ({ service: { running: false } }), holdingsData: async () => ({ nfts: [] }), runWallet: async () => { throw new Error('Unexpected real wallet operation'); } });
  app.listen(0, '127.0.0.1'); await once(app, 'listening');
  t.after(async () => { app.closeAllConnections(); await new Promise(resolve => app.close(resolve)); });
  const base = 'http://127.0.0.1:' + app.address().port;
  async function session() { const r = await fetch(base + '/api/bootstrap'); return { cookie: r.headers.get('set-cookie').split(';')[0], csrf: (await r.json()).data.csrfToken }; }
  async function req(s, method, path, body, headers = {}) {
    const r = await fetch(base + path, { method, headers: { cookie: s.cookie, 'content-type': 'application/json', 'x-csrf-token': s.csrf, ...headers }, ...(method === 'POST' ? { body: JSON.stringify(body || {}) } : {}) });
    return { status: r.status, body: await r.json() };
  }
  return { session, req, calls };
}

test('NFT endpoints enforce CSRF and preserve write-only marketplace keys', async t => {
  const f = await fixture(t), s = await f.session(), secret = 'TEST_ONLY_FAKE_MARKET_KEY';
  assert.equal((await f.req(s, 'POST', '/api/nft/trading/settings', { apiKey: secret }, { 'x-csrf-token': '' })).status, 403);
  const saved = await f.req(s, 'POST', '/api/nft/trading/settings', { apiKey: secret });
  assert.equal(saved.status, 200); assert.equal(saved.body.data.apiKeyConfigured, true);
  const read = await f.req(s, 'GET', '/api/nft/trading');
  assert.ok(!JSON.stringify(read.body).includes(secret));
  const holdings = await f.req(s, 'GET', '/api/holdings');
  assert.equal(holdings.body.data.nftTrading.settings.apiKeyConfigured, true);
  assert.deepEqual(f.calls, []);
});

test('NFT draft save, enable consent and stop-new-orders are separate actions', async t => {
  const f = await fixture(t), s = await f.session();
  const saved = await f.req(s, 'POST', '/api/nft/trading/rules', { rule: { key: 'asset', enabled: true } });
  assert.equal(saved.body.data.enabled, false);
  assert.equal((await f.req(s, 'POST', '/api/nft/trading/enable', { key: 'asset', policyHash: 'h' })).status, 409);
  assert.equal((await f.req(s, 'POST', '/api/nft/trading/enable', { key: 'asset', policyHash: 'h', confirmed: true })).status, 200);
  assert.equal((await f.req(s, 'POST', '/api/nft/trading/disable', { key: 'asset' })).status, 200);
  assert.deepEqual(f.calls.map(call => call[0]), ['save', 'enable', 'disable']);
});

test('NFT execution and cancellation previews stay session-owned and one-use', async t => {
  const f = await fixture(t), s = await f.session(), other = await f.session();
  const p = await f.req(s, 'POST', '/api/nft/trading/cancel-preview', { key: 'asset' });
  assert.equal(p.body.data.status, 'preview'); assert.deepEqual(f.calls, []);
  const body = { actionId: p.body.data.actionId, confirmed: true };
  assert.equal((await f.req(other, 'POST', '/api/nft/trading/confirm', body)).status, 409);
  assert.equal((await f.req(s, 'POST', '/api/nft/trading/confirm', body)).status, 200);
  assert.equal((await f.req(s, 'POST', '/api/nft/trading/confirm', body)).status, 409);
  assert.deepEqual(f.calls, [['cancel', 'asset']]);
});
