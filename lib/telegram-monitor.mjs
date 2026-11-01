import { createRequire } from 'node:module';
import { existsSync, lstatSync, readFileSync, realpathSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { atomicWalletJson } from './wallet-executor.mjs';
import { createSocialAccumulator, socialSelectionHash } from './social-candidates.mjs';

export function telegramPaths(root) {
  root = realpathSync(root);
  return { root, runtime: join(root, 'data', 'telegram_runtime'), session: join(root, 'data', 'tg_user', 'session.json'), feed: join(root, 'data', 'tg_candidates.json') };
}
export function assertPrivateTelegramPath(root, file) {
  if (!resolve(file).startsWith(realpathSync(root) + sep)) throw new Error('TG 路径必须位于项目内');
  for (let path = file; path !== root && path !== dirname(path); path = dirname(path)) if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error('TG 文件或目录不能使用符号链接');
}
export function readTelegramSession(root) {
  const { session } = telegramPaths(root); assertPrivateTelegramPath(root, session);
  const stat = lstatSync(session);
  if (!stat.isFile() || stat.size > 131072 || process.platform !== 'win32' && (stat.mode & 0o077)) throw new Error('TG 会话须为仅本人可读的普通文件');
  const value = JSON.parse(readFileSync(session, 'utf8'));
  if (value?.version !== 1 || !Number.isInteger(value.apiId) || value.apiId < 1 || value.apiId > 2147483647 || !/^[a-f0-9]{32}$/i.test(value.apiHash || '') || typeof value.session !== 'string' || !value.session || value.session.length > 8192 || !value.peers || typeof value.peers !== 'object' || Array.isArray(value.peers)) throw new Error('TG 会话配置无效，请重新登录');
  return value;
}
export function loadTelegramLibrary(root) {
  const { runtime } = telegramPaths(root); assertPrivateTelegramPath(root, runtime);
  const req = createRequire(join(runtime, 'package.json'));
  if (req('telegram/package.json').version !== '2.26.22') throw new Error('TG 可选依赖版本不匹配，请运行手动安装脚本');
  return { ...req('telegram'), StringSession: req('telegram/sessions').StringSession, bigInt: req('big-integer') };
}
function defaultClientFactory(root, credentials) {
  const { TelegramClient, StringSession, Api, bigInt } = loadTelegramLibrary(root);
  const client = new TelegramClient(new StringSession(credentials.session), credentials.apiId, credentials.apiHash, { connectionRetries: 1, floodSleepThreshold: 0 });
  client.setLogLevel('none');
  return { client, toPeer(peer) {
    const integer = value => { if (!/^-?\d{1,24}$/.test(String(value))) throw new Error('TG 群身份无效'); return bigInt(String(value)); };
    if (peer?.className === 'InputPeerChannel') return new Api.InputPeerChannel({ channelId: integer(peer.channelId), accessHash: integer(peer.accessHash) });
    if (peer?.className === 'InputPeerChat') return new Api.InputPeerChat({ chatId: integer(peer.chatId) });
    throw new Error('TG 仅支持明确选中的群与频道');
  } };
}

export function createTelegramMonitor({ root, readConfig, now = Date.now, clientFactory = defaultClientFactory, pollMs = 60000 } = {}) {
  const paths = telegramPaths(root), cursors = new Map();
  let accumulator = createSocialAccumulator({ now }), selectionKey = '';
  let adapter, timer, flight, stopped = false, state = 'disabled', lastPollAt = null, error = null;
  const settings = () => readConfig()?.telegramUser || { enabled: false, groupIds: [] };
  const deadline = async (work, ms = 15000) => { let timer; try { return await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('TG read timed out')), ms); })]); } finally { clearTimeout(timer); } };
  const close = async () => { const previous = adapter; adapter = null; cursors.clear(); try { await deadline(previous?.client.disconnect(), 2000); } catch {} };
  const resetSelection = async key => {
    if (key === selectionKey) return;
    selectionKey = key; accumulator = createSocialAccumulator({ now }); await close();
    if (existsSync(paths.feed)) { assertPrivateTelegramPath(paths.root, paths.feed); atomicWalletJson(paths.feed, accumulator.snapshot()); }
  };
  const view = () => {
    let selected;
    try { selected = settings(); } catch { selected = { enabled: false, groupIds: [] }; }
    return { state, configured: existsSync(paths.session), enabled: selected.enabled === true, allowedGroups: selected.groupIds?.length || 0, lastPollAt, error };
  };
  async function poll() {
    if (flight) return flight;
    flight = (async () => {
      try {
      const selected = settings();
      if (stopped || selected.enabled !== true) { state = 'disabled'; error = null; await resetSelection(''); await close(); return view(); }
      const groupIds = [...new Set(selected.groupIds || [])].slice(0, 12);
      if (!groupIds.length || groupIds.some(id => !/^-?\d{1,16}$/.test(id))) { await resetSelection(''); state = 'setup-required'; error = '请先明确选择要监听的群'; return view(); }
        const pollKey = [...groupIds].sort().join(','); await resetSelection(pollKey);
        const credentials = readTelegramSession(paths.root);
        if (!adapter) { adapter = clientFactory(paths.root, credentials); await deadline(adapter.client.connect()); if (!await deadline(adapter.client.isUserAuthorized())) { await close(); throw new Error('not authorized'); } }
        for (const id of groupIds) {
          if (stopped || settings().enabled !== true || !settings().groupIds?.includes(id)) break;
          const peer = credentials.peers[id]; if (!peer) throw new Error('TG 群尚未获准');
          const input = adapter.toPeer(peer), first = !cursors.has(id);
          const messages = await deadline(adapter.client.getMessages(input, first ? { limit: 1 } : { limit: 20, minId: cursors.get(id), reverse: true }));
          if (stopped || settings().enabled !== true || !settings().groupIds?.includes(id)) continue;
          for (const message of [...messages || []].sort((a, b) => a.id - b.id)) {
            if (!Number.isSafeInteger(message.id) || message.id <= (cursors.get(id) || 0)) continue;
            cursors.set(id, message.id);
            if (!first) accumulator.ingest({ groupId: id, senderId: message.senderId?.toString() || 'channel:' + id, messageId: message.id, text: message.message || '', at: Number(message.date) * 1000 });
          }
          if (first && !messages?.length) cursors.set(id, 0);
        }
        if (!stopped && settings().enabled === true) {
          const currentKey = [...new Set(settings().groupIds || [])].sort().join(',');
          if (currentKey !== pollKey) { await resetSelection(currentKey); state = 'reloading'; return view(); }
          assertPrivateTelegramPath(paths.root, paths.feed); mkdirSync(dirname(paths.feed), { recursive: true, mode: 0o700 });
          atomicWalletJson(paths.feed, { ...accumulator.snapshot(), selectionHash: socialSelectionHash(groupIds) }); lastPollAt = now(); state = 'listening'; error = null;
        }
      } catch { state = 'setup-required'; error = 'TG 只读监听未就绪，请检查可选依赖、登录和所选群权限'; await close(); }
      return view();
    })().finally(() => { flight = null; });
    return flight;
  }
  return { poll, view, start() { stopped = false; void poll(); timer ||= setInterval(() => { void poll(); }, Math.max(60000, pollMs)); timer.unref?.(); }, async stop() { stopped = true; clearInterval(timer); timer = null; try { await resetSelection(''); } catch { state = 'setup-required'; error = 'TG 候选文件无法清理，请检查本机权限'; } finally { await close(); } } };
}
