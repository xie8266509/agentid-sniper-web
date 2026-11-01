const $ = (s, root = document) => root.querySelector(s);
const content = $('#content'), modal = $('#modal'), modalContent = $('#modal-content');
const state = { view: 'overview', status: null, config: null, csrf: '', logs: [], walletStatus: new Map(), balances: new Map(), samples: [], autoLogs: true, search: '', preview: null, disconnected: false };
let sessionRenewal = null;
let nftTradingData = null, nftTradingError = null, nftTradingRequest = null;
const nftManagerViews = new Set();
const nftRuleModes = { 'fixed-listing': '固定价格挂单', 'take-profit-offer': '目标净收入成交', 'trailing-offer': '跟踪止盈买单' };
const views = { overview: '运行概览', wallets: '钱包管理', config: '策略配置', holdings: '持仓追踪', operations: '手动操作', logs: '运行日志', updates: '系统更新' };
const paths = {
  overview: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  wallet: '<path d="M20 8V5a2 2 0 0 0-2-2H6a3 3 0 0 0 0 6h14v11H6a3 3 0 0 1-3-3V6"/><path d="M20 12h-5v5h5"/><path d="M17 14.5h.01"/>',
  sliders: '<path d="M4 7h5m5 0h6M4 17h9m5 0h2"/><circle cx="11.5" cy="7" r="2.5"/><circle cx="15.5" cy="17" r="2.5"/>',
  portfolio: '<path d="M4 8h16v12H4zM9 8V4h6v4M4 13h16M10 13v3h4v-3"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3m6 0h4"/>',
  logs: '<path d="M6 3h9l4 4v14H6zM14 3v5h5M9 12h7M9 16h7"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.1 7a7 7 0 0 1 11.5-1L20 9M4 15l2.4 3A7 7 0 0 0 18 17"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  activity: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  block: '<path d="m12 3 9 5-9 5-9-5 9-5Zm-9 5v9l9 5 9-5V8M12 13v9"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  radar: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><path d="m12 12 7-7M12 3v2M3 12h2M12 19v2M19 12h2"/>',
  arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
  external: '<path d="M14 3h7v7m0-7L10 14M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  play: '<path d="m8 5 11 7-11 7V5Z"/>',
  stop: '<rect x="5" y="5" width="14" height="14" rx="1.5"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  shield: '<path d="m12 3 8 3v6c0 4-5 8-8 9-3-1-8-5-8-9V6l8-3Z"/><path d="m8 12 3 3 5-6"/>',
  eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  save: '<path d="M4 3h13l4 4v14H3V3h1Zm3 0v6h10V3M7 21v-8h10v8"/>',
  trash: '<path d="M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10h.01"/>',
  copy: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
};
function icon(name) { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true'); s.innerHTML = paths[name] || paths.info; return s; }
function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'checked' || k === 'disabled' || k === 'value') n[k] = v;
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const child of children.flat(Infinity)) if (child !== undefined && child !== null && child !== false) n.append(child instanceof Node ? child : document.createTextNode(String(child)));
  return n;
}
function replace(n, ...children) { n.replaceChildren(...children.flat().filter(Boolean)); }
function fmt(n) { return n == null || !Number.isFinite(Number(n)) ? '—' : Number(n).toLocaleString('en-US'); }
function usd(n) { if (n == null || (typeof n === 'string' && !n.trim())) return '—'; const x = Number(n); return !Number.isFinite(x) ? '—' : x > 0 && x < .01 ? '$' + String(n) : '$' + x.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function date(v, withDate = false) { if (!v) return '—'; const d = typeof v === 'number' && v < 1e11 ? new Date(v * 1000) : new Date(v); return Number.isNaN(d.valueOf()) ? String(v) : d.toLocaleString('zh-CN', { ...(withDate ? { month: '2-digit', day: '2-digit' } : {}), hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }); }
function pct(v) { return Number.isFinite(Number(v)) ? (Number(v) * 100).toFixed(0) + '%' : '—'; }
function toast(message, error = false) { const n = el('div', { class: 'toast' + (error ? ' error' : '') }, icon(error ? 'info' : 'check'), el('span', {}, message)); $('#toasts').append(n); setTimeout(() => n.remove(), error ? 8000 : 4300); }
async function renewSession() {
  if (!sessionRenewal) sessionRenewal = (async () => {
    const response = await fetch('/api/bootstrap', { headers: { Accept: 'application/json' }, credentials: 'same-origin' });
    const result = await response.json();
    if (!response.ok || result.ok === false) throw new Error(result.error?.message || '无法恢复本地页面会话。');
    state.csrf = (result.data ?? result).csrfToken;
  })().finally(() => { sessionRenewal = null; });
  return sessionRenewal;
}
async function api(path, { method = 'GET', body, signal, retried = false } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET') headers['X-CSRF-Token'] = state.csrf;
  let response;
  try { response = await fetch(path, { method, headers, credentials: 'same-origin', body: body === undefined ? undefined : JSON.stringify(body), signal }); }
  catch (e) { if (e.name === 'AbortError') throw e; throw new Error('无法连接本地服务，请确认 Web 控制台正在运行。'); }
  let result; try { result = await response.json(); } catch { throw new Error(`服务返回了无法读取的响应（${response.status}）`); }
  if (response.status === 401 && !retried && path !== '/api/bootstrap') {
    await renewSession();
    return api(path, { method, body, signal, retried: true });
  }
  if (!response.ok || result.ok === false) { const error = new Error(result.error?.message || result.error || `请求失败（${response.status}）`); error.details = result.error?.details; error.status = response.status; throw error; }
  return result.data ?? result;
}
async function busy(button, fn) { if (button.disabled) return; const old = [...button.childNodes]; button.disabled = true; replace(button, el('span', { class: 'spinner' }), '处理中'); try { return await fn(); } catch (e) { if (e.name !== 'AbortError') toast(e.message, true); } finally { if (button.isConnected) { button.disabled = false; replace(button, old); } } }
function button(label, iconName, fn, style = '') { const b = el('button', { type: 'button', class: 'button ' + style }, iconName && icon(iconName), label); if (fn) b.addEventListener('click', () => busy(b, fn)); return b; }
function badge(text, kind = '', dot = false) { return el('span', { class: 'badge ' + kind }, dot && el('span', { class: 'status-dot' + (kind === 'muted' ? ' off' : '') }), text); }
function title(name, subtitle, actions = []) { return el('div', { class: 'page-heading' }, el('div', {}, el('div', { class: 'eyebrow' }, 'AGENT ID WORKSPACE'), el('h1', {}, name), el('p', { class: 'page-description' }, subtitle)), actions.length ? el('div', { class: 'heading-actions' }, actions) : null); }
function panel(name, iconName, body, aside, subtitle = '') { return el('section', { class: 'panel' }, el('div', { class: 'panel-header' }, el('div', {}, el('div', { class: 'panel-title' }, iconName && icon(iconName), el('h2', {}, name)), subtitle && el('p', { class: 'panel-subtitle' }, subtitle)), aside), body); }
function empty(message, description, iconName = 'radar', action) { return el('div', { class: 'empty-state' }, el('span', { class: 'empty-symbol' }, icon(iconName)), el('h3', {}, message), el('p', {}, description), action); }
function errorPanel(error, retry) { return el('div', { class: 'error-panel' }, el('h2', {}, '暂时无法读取数据'), el('p', {}, error.message), button('重新加载', 'refresh', retry)); }
function go(view) { location.hash = view; }
let modalCleanup = null, modalResolve = null;
function closeModal() { modal.close(); modal.classList.remove('nft-rule-dialog'); if (modalCleanup) { const fn = modalCleanup; modalCleanup = null; fn(); } if (modalResolve) { modalResolve(false); modalResolve = null; } }
function openModal(name, body, actions = []) { if (modal.open) closeModal(); const x = el('button', { type: 'button', class: 'icon-button', 'aria-label': '关闭', onclick: closeModal }, icon('close')); replace(modalContent, el('div', { class: 'modal-header' }, el('h2', {}, name), x), el('div', { class: 'modal-body' }, body), actions.length ? el('div', { class: 'modal-footer' }, actions) : null); modal.showModal(); }
modal.addEventListener('cancel', (e) => { e.preventDefault(); closeModal(); });
modal.addEventListener('click', (e) => { if (e.target === modal) { const r = modal.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) closeModal(); } });
function confirmAction(name, description, label = '确认', { checkbox, danger = false, details } = {}) {
  return new Promise((resolve) => {
    const yes = button(label, 'check', async () => { modalResolve = null; closeModal(); resolve(true); }, danger ? 'danger' : 'primary');
    const check = checkbox && el('input', { type: 'checkbox', onchange: () => { yes.disabled = !check.checked; } });
    if (check) yes.disabled = true;
    openModal(name, [el('p', { class: 'modal-description' }, description), details && el('div', { class: 'confirmation-list' }, details.map((x) => el('span', {}, x))), check && el('label', { class: 'checkbox-row' }, check, checkbox)], [button('取消', null, async () => closeModal()), yes]);
    modalResolve = resolve;
  });
}
async function loadConfig() { const data = await api('/api/config'); state.config = data.config || data; return state.config; }
async function refreshStatus({ passive = false } = {}) {
  const data = await api('/api/status'); state.status = data; state.disconnected = false;
  if (Number.isFinite(Number(data.scan?.head || data.scan?.lastBlock))) {
    const b = Number(data.scan?.lastBlock); const last = state.samples.at(-1); if (!last || b !== last.value) state.samples.push({ at: Date.now(), value: b }); state.samples = state.samples.slice(-30);
  }
  updateChrome();
  paintUpdates();
  $('#updated-at').textContent = '最近同步 ' + date(Date.now());
  const version = typeof data.release?.version === 'string' ? data.release.version : '';
  const commit = typeof data.release?.commit === 'string' ? data.release.commit : '';
  const releaseNode = $('#release-version');
  if (releaseNode) releaseNode.textContent = version || commit ? ' · ' + [version, commit && `(${commit})`, data.release?.upstreamVersion && `· 上游 ${data.release.upstreamVersion}`].filter(Boolean).join(' ') : '';
  const focusedControl = content.contains(document.activeElement) && document.activeElement.matches('button,a,input,textarea,select');
  if (state.view === 'overview' && !(passive && focusedControl)) renderOverview();
  return data;
}
function updateChrome() { const s = state.status || {}; const running = Boolean(s.service?.running); $('#sidebar-service').textContent = running ? '监控正在运行' : '监控已停止'; $('#sidebar-dot').className = 'status-dot' + (running ? '' : ' off'); $('#sidebar-mode').textContent = s.mode === 'auto' ? '自动交易 · BSC' : '只读监控 · BSC'; $('#wallet-count').textContent = state.config?.wallets?.length || 0; }
async function serviceAction(action) {
  const isAuto = state.config?.monitorOnly === false;
  let confirmAutoTrading = false;
  if (isAuto && action !== 'stop') {
    confirmAutoTrading = await confirmAction('启动自动交易', '启动后，程序会按当前策略自动铸造、兑换和卖出。请先核对交易预算。', '确认并启动', { checkbox: '我已核对预算，同意按当前配置自动交易', details: [`单项目上限：${usd(state.config.paid?.maxUsd)}`, `每日付费上限：${state.config.paid?.maxBnbPerDay ?? 0} BNB`] });
    if (!confirmAutoTrading) return;
  }
  await api('/api/service/' + action, { method: 'POST', body: { confirmAutoTrading } });
  toast(action === 'stop' ? '监控已停止' : action === 'restart' ? '监控已重启' : '监控已启动');
  await refreshStatus();
}
function modeBanner() { const auto = state.status?.mode === 'auto'; const needsRestart = state.status?.service?.needsRestart; return el('div', { class: 'mode-banner' + (auto || needsRestart ? ' amber' : '') }, el('span', { class: 'banner-icon' }, icon(needsRestart ? 'refresh' : auto ? 'activity' : 'eye')), el('span', {}, el('strong', {}, needsRestart ? '新配置等待应用' : auto ? '自动交易已启用' : '只读监控模式'), needsRestart ? ' · 重启监控后，新保存的钱包与策略设置才会生效。' : auto ? ' · 满足策略条件后会自动发送链上交易。' : ' · 正在发现与记录项目，自动铸造和买卖均已关闭。'), needsRestart ? button('重启并应用 →', null, () => serviceAction('restart'), 'ghost') : el('a', { href: '#config' }, '管理策略 →')); }
function metric(label, value, unit, note, iconName, positive = false) { return el('div', { class: 'metric-card' }, el('div', { class: 'metric-title' }, label, icon(iconName)), el('div', { class: 'metric-value' + (String(value).length > 8 ? ' small' : '') }, value, unit && el('span', { class: 'metric-unit' }, unit)), el('div', { class: 'metric-note' + (positive ? ' positive' : '') }, positive && icon('check'), note)); }
function dataDetail(label, value, mono = false) { return el('div', {}, el('div', { class: 'detail-label' }, label), el('div', { class: 'detail-value' + (mono ? ' mono' : '') }, value)); }
function sparkline() {
  const wrap = el('div', { class: 'chart-wrap' });
  if (state.samples.length < 2) return el('div', {}, wrap.appendChild(el('div', { class: 'chart-empty' }, '扫描进度将在同步后显示')) && wrap, el('div', { class: 'chart-caption' }, el('span', {}, '扫描区块'), el('span', {}, '等待采样')));
  const vals = state.samples.map((s) => s.value); const low = Math.min(...vals), high = Math.max(...vals); const points = vals.map((v, i) => `${i * 600 / (vals.length - 1)},${63 - (v - low) / Math.max(1, high - low) * 53}`).join(' ');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 600 76'); svg.setAttribute('preserveAspectRatio', 'none'); const poly = document.createElementNS(svg.namespaceURI, 'polyline'); poly.setAttribute('points', points); svg.append(poly); wrap.append(svg);
  return el('div', {}, wrap, el('div', { class: 'chart-caption' }, el('span', {}, '扫描区块 · 本次会话'), el('span', {}, date(state.samples[0].at) + ' — ' + date(state.samples.at(-1).at))));
}
function renderOverview() {
  const s = state.status; if (!s) return;
  const running = Boolean(s.service?.running), wallets = state.config?.wallets || [], scan = s.scan || {};
  const age = s.service?.heartbeatAgeSec;
  const slow = running && typeof age === 'number' && age > 180;
  const serviceBody = el('div', { class: 'panel-content' },
    el('div', { class: 'service-hero' }, el('div', { class: 'service-symbol' }, icon('activity')), el('div', {}, el('h3', {}, running ? '区块监控已启动' : '区块监控已停止'), el('p', {}, running ? '发现新合约与 Agent ID 铸造活动' : '启动后开始扫描 BSC 链上活动')), badge(running ? '运行中' : '已停止', running ? '' : 'muted', true)),
    slow && el('div', { class: 'warning-note' }, el('strong', {}, '扫描处理较慢'), ` · 最近心跳已过去 ${Math.round(age)} 秒，进程仍在运行。请留意后续心跳与运行日志。`),
    el('div', { class: 'detail-grid' }, dataDetail('管理进程', s.service?.pid ? 'PID ' + s.service.pid : '—', true), dataDetail('最近心跳', s.service?.heartbeat ? (typeof age === 'number' ? `${Math.round(age)} 秒前` : s.service.heartbeat) : '等待首次扫描'), dataDetail('最新链上区块', fmt(scan.head), true), dataDetail('当前模式', s.mode === 'auto' ? '自动交易' : '只读监控')),
    sparkline(),
    el('div', { class: 'service-actions' }, button(running ? '重新启动' : '启动监控', running ? 'refresh' : 'play', () => serviceAction(running ? 'restart' : 'start'), 'primary'), running && button('停止监控', 'stop', () => serviceAction('stop')), button('查看日志', 'logs', async () => go('logs'), 'ghost')));
  let walletBody;
  if (!wallets.length) walletBody = el('div', { class: 'wallet-empty' }, el('span', { class: 'empty-symbol' }, icon('wallet')), el('h3', {}, '连接你的 Agentic Wallet'), el('p', {}, '使用币安 App 确认登录后，即可导入钱包。'), button('连接钱包', 'plus', () => startLogin(0), 'small'));
  else walletBody = el('div', { class: 'panel-content' }, wallets.slice(0, 3).map((w, i) => el('div', { class: 'quick-wallet' }, el('div', { class: 'wallet-avatar' }, i + 1), el('div', { class: 'quick-wallet-info' }, el('strong', {}, w.name || `钱包 ${i + 1}`), el('div', { class: 'address', title: w.address }, w.address)), el('a', { href: '#wallets' }, '管理'))));
  const paid = state.config?.paid || {}, rules = state.config?.rules || {};
  const strategy = el('div', { class: 'panel-content' }, el('div', { class: 'info-list' }, [['单项目预算', usd(paid.maxUsd)], ['每日付费上限', `${paid.maxBnbPerDay ?? 0} BNB`], ['有效进场门槛', pct(Math.max(.6, paid.goPct ?? .6))], ['卖出策略', ruleStrategyName(rules)], ['回本卖出', `${rules.backX ?? (usesStepRules(rules) ? 2 : 3)}×`], ['回本前回撤', pct(rules.crash ?? (usesStepRules(rules) ? .4 : .6))]].map(([label, value]) => el('div', { class: 'info-row' }, el('span', {}, label), el('strong', {}, value)))));
  const projects = s.recentProjects || [];
  const eventsBody = projects.length ? el('ul', { class: 'event-list' }, projects.slice(0, 6).map((p) => el('li', { class: 'event-item' }, el('span', { class: 'event-dot' }), el('div', { class: 'event-body' }, el('div', { class: 'event-text' }, p.name || '发现 Agent ID 项目'), el('div', { class: 'event-secondary mono' }, p.address || ''), p.source && el('div', { class: 'event-secondary' }, p.source)), el('span', { class: 'event-time' }, date(p.at))))) : empty('等待新的链上发现', '监控到 Agent ID 项目后，会在这里展示记录。', 'radar');
  replace(content, title('运行概览', '掌握链上动态，管理你的 Agent ID 工作空间。', [button('钱包管理', 'wallet', async () => go('wallets')), button('配置策略', 'sliders', async () => go('config'), 'primary')]), state.disconnected && el('div', { class: 'connection-error-banner' }, '连接暂时中断，当前显示最近一次数据。'), modeBanner(),
    el('div', { class: 'metrics-grid' }, metric('已扫描区块', fmt(scan.lastBlock), '', '持续扫描 BSC 新区块', 'block'), metric('扫描落后', fmt(scan.lag), '区块', scan.head ? '最近完成扫描时采样' : '等待链上高度同步', 'clock', scan.lag === 0), metric('发现项目', fmt(scan.seenCount), '个', '本地累计发现记录', 'radar'), metric('追踪持仓', fmt(s.stats?.trackedTokens ?? 0), '项', `${wallets.length} 个已配置钱包`, 'portfolio')),
    el('div', { class: 'content-grid' }, panel('监控服务', 'activity', serviceBody, badge('BSC MAINNET', 'muted')), el('div', { class: 'overview-side' }, panel('Agentic Wallet', 'wallet', walletBody, el('a', { href: '#wallets', class: 'text-link' }, '全部 →')), panel('当前策略', 'sliders', strategy, el('a', { href: '#config', class: 'text-link' }, '编辑 →')), renderOverviewUpdates())), el('div', { class: 'section-spacer' }, panel('最近发现', 'radar', eventsBody, el('a', { href: '#logs', class: 'text-link' }, '查看全部日志 →'))));
}
async function refreshWallet(index, { quiet = false } = {}) {
  try { const data = await api(`/api/wallet/status?wallet=${index}`); state.walletStatus.set(index, data); return data; }
  catch (e) { state.walletStatus.set(index, { status: 'ERROR', error: e.message }); if (!quiet) toast(e.message, true); return null; }
}
function walletStateLabel(w) { return w?.status === 'CONNECTED' ? '已连接' : w?.status === 'CREATING' ? '创建中' : w?.status === 'ERROR' ? '连接异常' : w ? '未连接' : '未检查'; }
function renderWallets() {
  const wallets = state.config?.wallets || [], list = wallets.length ? wallets : [{ name: '默认钱包', address: '' }];
  const cards = list.map((w, i) => {
    const info = state.walletStatus.get(i), connected = info?.status === 'CONNECTED';
    const actions = [button(connected ? '重新登录' : '登录钱包', 'wallet', () => startLogin(i), 'small primary'), button('检查连接', 'refresh', async () => { await refreshWallet(i); renderWallets(); }, 'small')];
    if (connected) actions.push(button('导入地址', 'download', async () => importWallet(i), 'small'), button('退出登录', 'external', async () => logoutWallet(i), 'small ghost'));
    const address = info?.address || w.address;
    return el('section', { class: 'panel wallet-card' }, el('div', { class: 'wallet-card-top' }, el('div', { class: 'wallet-avatar' }, i + 1), el('div', {}, el('h2', {}, w.name || `钱包 ${i + 1}`), el('div', { class: 'panel-subtitle' }, 'Binance Agentic Wallet')), badge(walletStateLabel(info), connected ? '' : info?.status === 'ERROR' ? 'amber' : 'muted', connected)),
      address ? el('div', { class: 'address' }, address) : el('div', { class: 'address' }, '登录后可导入 BSC 钱包地址'),
      info?.settings && el('div', { class: 'wallet-meta' }, el('span', {}, '开发者模式', el('strong', {}, info.settings.devMode?.enabled ? '已开启' : '未开启')), el('span', {}, '登录有效期', el('strong', {}, date(info.settings.sessionExpireTime, true)))),
      info?.error && el('p', { class: 'wallet-status-message' }, typeof info.error === 'object' ? info.error.message || JSON.stringify(info.error) : info.error), el('div', { class: 'wallet-card-actions' }, actions));
  });
  replace(content, title('钱包管理', '通过币安 App 配对登录，钱包会话独立保存在本机。', [button('刷新连接', 'refresh', async () => { await Promise.all(list.map((_, i) => refreshWallet(i, { quiet: true }))); renderWallets(); }), button('配置钱包', 'plus', async () => go('config'), 'primary')]),
    el('div', { class: 'wallet-grid' }, cards, el('div', { class: 'add-wallet-card' }, el('span', { class: 'empty-symbol' }, icon('plus')), el('h3', {}, '管理多个钱包'), el('p', {}, '在策略配置中添加钱包地址与名称。'), button('前往配置', 'arrow', async () => go('config'), 'small'))),
    el('div', { class: 'wallet-help' }, icon('info'), el('div', {}, '登录时请用对应币安账号确认配对码。合约操作需要在币安 App → Agentic Wallet → 设置中开启开发者模式。')));
}
async function importWallet(walletIndex) { const data = await api('/api/wallet/import', { method: 'POST', body: { walletIndex } }); if (data.config) state.config = data.config; else await loadConfig(); updateChrome(); toast('真实钱包地址已导入配置'); if (state.view === 'wallets') renderWallets(); await refreshStatus(); }
async function logoutWallet(walletIndex) { if (!await confirmAction('退出钱包登录', '退出后，此钱包的合约操作将暂停，需重新登录后恢复。', '退出登录')) return; await api('/api/wallet/logout', { method: 'POST', body: { walletIndex, confirmed: true } }); await refreshWallet(walletIndex, { quiet: true }); if (state.view === 'wallets') renderWallets(); toast('钱包已退出登录'); }
async function startLogin(walletIndex) {
  const loading = el('div', { class: 'loading-page', style: 'padding:35px 15px' }, el('span', { class: 'spinner' }), el('p', {}, '正在获取钱包配对链接…'));
  openModal('登录 Agentic Wallet', loading);
  let data;
  try { data = await api('/api/wallet/login', { method: 'POST', body: { walletIndex } }); }
  catch (e) { if (modal.open) openModal('钱包登录失败', el('div', { class: 'error-panel' }, el('p', {}, e.message)), [button('关闭', null, async () => closeModal())]); return; }
  if (!modal.open) { await api(`/api/wallet/login/${encodeURIComponent(data.id)}/cancel`, { method: 'POST', body: {} }).catch(() => {}); return; }
  const body = el('div', {}, el('p', { class: 'modal-description' }, '请打开币安登录页面，并在手机 App 中核对以下配对码。'), el('div', { class: 'pairing-code' }, el('span', {}, 'PAIRING CODE'), el('strong', {}, data.pairingCode || '—')));
  const link = data.urlForWeb;
  if (typeof link === 'string' && /^https:\/\//i.test(link)) body.append(el('a', { class: 'button primary wide', href: link, target: '_blank', rel: 'noopener noreferrer' }, icon('external'), '打开币安登录页面'), el('a', { class: 'login-link', href: link, target: '_blank', rel: 'noopener noreferrer' }, link));
  const progress = el('div', { class: 'login-wait' }, el('span', { class: 'spinner' }), '等待手机确认 · 链接约 5 分钟有效'); body.append(progress);
  openModal('登录 Agentic Wallet', body, [button('取消登录', null, async () => closeModal())]);
  let active = true, settled = false, timer;
  modalCleanup = () => { active = false; clearTimeout(timer); if (!settled) api(`/api/wallet/login/${encodeURIComponent(data.id)}/cancel`, { method: 'POST', body: {} }).catch(() => {}); };
  const poll = async () => {
    if (!active) return;
    try {
      const result = await api(`/api/wallet/login/${encodeURIComponent(data.id)}`);
      if (!active) return;
      if (result.status === 'SUCCESS') {
        settled = true; modalCleanup = null; active = false; await refreshWallet(walletIndex, { quiet: true });
        const done = el('div', {}, el('div', { class: 'success-note' }, '钱包已连接，可以将真实 BSC 地址导入监控配置。'), result.address && el('div', { class: 'result-block address' }, result.address));
        openModal('钱包登录成功', done, [button('稍后导入', null, async () => { closeModal(); if (state.view === 'wallets') renderWallets(); }), button('导入钱包地址', 'download', async () => { await importWallet(walletIndex); closeModal(); }, 'primary')]);
        return;
      }
      if (['FAILED', 'CANCELLED', 'EXPIRED'].includes(result.status)) {
        settled = true; active = false; modalCleanup = null;
        const msg = result.error?.message || result.error || result.message || (result.status === 'EXPIRED' ? '配对链接已过期，请重新登录。' : result.status === 'CANCELLED' ? '登录已取消。' : '钱包登录未完成。');
        openModal('登录未完成', el('p', { class: 'modal-description' }, msg), [button('关闭', null, async () => closeModal()), button('重新获取链接', 'refresh', () => startLogin(walletIndex), 'primary')]); return;
      }
      timer = setTimeout(poll, 1800);
    } catch (e) { if (!active) return; replace(progress, icon('info'), e.message); timer = setTimeout(poll, 4000); }
  };
  timer = setTimeout(poll, 900);
}
function field(label, name, value, { type = 'text', min, max, step, help, placeholder, suffix, full = false, required = false } = {}) { const input = el('input', { class: 'input', type, name, id: name, value: value ?? '', min, max, step, placeholder, required, autocomplete: type === 'password' ? 'new-password' : 'off' }); return el('div', { class: 'field' + (full ? ' full' : '') }, el('label', { for: name }, label), suffix ? el('div', { class: 'input-wrap' }, input, el('span', { class: 'input-suffix' }, suffix)) : input, help && el('p', { class: 'help' }, help)); }
function configSection(id, titleText, subtitle, body) { const p = panel(titleText, null, el('div', { class: 'panel-content' }, body), null, subtitle); p.id = id; p.classList.add('form-section'); return p; }
function configRulesEditor(rules) {
  const modern = usesStepRules(rules);
  const mode = el('select', { class: 'input', id: 'rules.strategy', name: 'rules.strategy' }, el('option', { value: 'legacy' }, '旧版 · 半仓止盈与速战'), el('option', { value: 'steps' }, '新版 · 阶梯止盈与长抱'));
  mode.value = modern ? 'steps' : 'legacy';
  const notice = el('p', { class: 'help rule-strategy-note', role: 'status' });
  const stepsList = el('div', { class: 'rule-step-list' });
  const stepRows = []; let stepSequence = 0;
  const addStep = (multiple = '', percent = '') => {
    if (stepRows.length >= 20) { toast('最多可配置 20 个止盈阶梯。', true); return; }
    const id = stepSequence++;
    const x = field('目标价格倍数', `rules.step.${id}.multiple`, multiple, { type: 'number', min: 1, max: 1000000, step: 'any', suffix: '倍', required: true });
    const amount = field('卖出可卖余额', `rules.step.${id}.percent`, percent, { type: 'number', min: 1, max: 100, step: 1, suffix: '%', required: true });
    const entry = { id, row: null };
    const remove = el('button', { type: 'button', class: 'icon-button', 'aria-label': '删除此止盈阶梯', onclick: () => { entry.row.remove(); stepRows.splice(stepRows.indexOf(entry), 1); } }, icon('trash'));
    entry.row = el('div', { class: 'rule-step-row' }, x, amount, remove); stepRows.push(entry); stepsList.append(entry.row);
  };
  for (const [x, percent] of modern && Array.isArray(rules.steps) ? rules.steps : [[10, 30], [20, 50]]) addStep(x, percent);
  const stepsBody = el('div', { class: 'rule-mode-fields' }, el('div', { class: 'rule-step-heading' }, el('h3', {}, '按倍数分批止盈'), button('添加阶梯', 'plus', async () => addStep(), 'small')), el('p', { class: 'help' }, '倍数按单币价格相对成本计算，须递增且高于回本倍数。百分比按当时可卖余额计算，长抱部分保留；删除全部阶梯可关闭分批止盈。'), stepsList,
    el('div', { class: 'form-grid three section-spacer' }, field('回本后最高点回撤', 'rules.crashAfterBack', (modern ? rules.crashAfterBack ?? .6 : .6) * 100, { type: 'number', min: 0, max: 100, step: 1, suffix: '%', required: true }), field('回本后保留长抱', 'rules.moonPct', modern ? rules.moonPct ?? 20 : 20, { type: 'number', min: 0, max: 100, step: 1, suffix: '%', help: '回本后剩余数量的比例；0 为不保留。长抱部分不会自动卖出。', required: true }), field('长抱提醒倍数', 'rules.moonNotifyX', (modern ? rules.moonNotifyX ?? [50, 100] : [50, 100]).join(', '), { help: '逗号分隔，递增；留空关闭提醒。' })));
  const legacyBody = el('div', { class: 'rule-mode-fields' }, el('div', { class: 'form-grid three' }, field('每次卖一半的倍数', 'rules.halfX', (modern ? [5, 10] : rules.halfX ?? [5, 10]).join(', '), { help: '逗号分隔，递增且高于回本倍数；留空关闭分批止盈。' }), field('速战回撤卖出', 'rules.fastCrash', (modern ? .35 : rules.fastCrash ?? .35) * 100, { type: 'number', min: 0, max: 100, step: 1, suffix: '%', required: true }), field('无拉升观察时间', 'rules.noPumpMin', modern ? 20 : rules.noPumpMin ?? 20, { type: 'number', min: 0, max: 10080, step: 1, suffix: '分钟', help: '0 为关闭。', required: true }), field('观察期目标倍数', 'rules.noPumpX', modern ? 2 : rules.noPumpX ?? 2, { type: 'number', min: 0, max: 1000000, step: 'any', suffix: '倍', required: true })));
  const common = el('div', { class: 'form-grid three' }, field('卖出收回本金', 'rules.backX', rules.backX ?? (modern ? 2 : 3), { type: 'number', min: 1, max: 1000000, step: 'any', suffix: '倍', required: true }), field(modern ? '回本前最高点回撤' : '常规最高点回撤', 'rules.crash', (rules.crash ?? (modern ? .4 : .6)) * 100, { type: 'number', min: 0, max: 100, step: 1, suffix: '%', required: true }), field('密集检查时长', 'rules.fastMin', rules.fastMin ?? 30, { type: 'number', min: 0, max: 10080, step: 1, suffix: '分钟', help: '开池后此窗口内每秒检查。0 为关闭；旧版同时使用速战回撤。', required: true }), field('免费币回撤', 'rules.drop', (rules.drop ?? .5) * 100, { type: 'number', min: 0, max: 100, step: 1, suffix: '%', required: true }));
  const syncMode = () => {
    const steps = mode.value === 'steps';
    for (const [section, active] of [[stepsBody, steps], [legacyBody, !steps]]) { section.hidden = !active; for (const input of section.querySelectorAll('input, select, button')) input.disabled = !active; }
    $('label[for="rules.crash"]', common).textContent = steps ? '回本前最高点回撤' : '常规最高点回撤';
    notice.textContent = steps ? '当前编辑新版策略：阶梯百分比、回本前后回撤和长抱规则。切换策略后，共用的回本与回撤阈值保留当前输入。' : '当前编辑旧版策略：每个目标卖剩余一半，保留速战回撤与无拉升退出规则。升级不会自动切换已有策略。';
  };
  mode.addEventListener('change', syncMode); syncMode();
  const multiples = (value, label) => { const values = String(value || '').split(/[,，\s]+/).filter(Boolean).map(Number); if (values.some((x, i) => !Number.isFinite(x) || x < 1 || x > 1000000 || (i && x <= values[i - 1]))) throw new Error(`${label}须为递增的正数倍数。`); return values; };
  return {
    body: el('div', { class: 'rule-config-editor' }, el('div', { class: 'field' }, el('label', { for: 'rules.strategy' }, '卖出策略版本'), mode, notice), common, stepsBody, legacyBody),
    read(fd) {
      const num = (key) => Number(fd.get('rules.' + key));
      const result = { strategy: mode.value, backX: num('backX'), crash: num('crash') / 100, fastMin: num('fastMin'), drop: num('drop') / 100 };
      if (mode.value === 'steps') {
        result.steps = stepRows.map(({ id }) => [Number(fd.get(`rules.step.${id}.multiple`)), Number(fd.get(`rules.step.${id}.percent`))]);
        if (result.steps.some(([x, amount], i) => !Number.isFinite(x) || x <= result.backX || x > 1000000 || (i && x <= result.steps[i - 1][0]) || !Number.isInteger(amount) || amount < 1 || amount > 100)) throw new Error('止盈阶梯须按倍数递增、高于回本倍数，卖出比例须为 1–100 的整数。');
        result.crashAfterBack = num('crashAfterBack') / 100; result.moonPct = num('moonPct'); result.moonNotifyX = multiples(fd.get('rules.moonNotifyX'), '长抱提醒');
      } else {
        result.halfX = multiples(fd.get('rules.halfX'), '半仓止盈');
        if (result.halfX.some((x) => x <= result.backX)) throw new Error('半仓止盈倍数须高于回本倍数。');
        result.fastCrash = num('fastCrash') / 100; result.noPumpMin = num('noPumpMin'); result.noPumpX = num('noPumpX');
      }
      return result;
    },
  };
}
function renderConfig() {
  const c = state.config || {}, p = c.paid || {}, r = c.rules || {};
  const form = el('form', { id: 'config-form', onsubmit: (e) => e.preventDefault() });
  const monitorRadio = el('input', { type: 'radio', name: 'monitorOnly', value: 'true', checked: c.monitorOnly !== false });
  const autoRadio = el('input', { type: 'radio', name: 'monitorOnly', value: 'false', checked: c.monitorOnly === false });
  const mode = configSection('config-mode', '运行模式', '选择监控方式，保存后需重启监控才能生效。', el('div', { class: 'segmented' }, el('label', { class: 'mode-option' }, monitorRadio, el('strong', {}, '只读监控'), el('span', {}, '发现项目、追踪持仓，不发送交易。')), el('label', { class: 'mode-option' }, autoRadio, el('strong', {}, '自动交易'), el('span', {}, '按策略执行铸造、兑换和卖出。'))));
  const wallets = el('div', { class: 'wallet-config-list' });
  const walletRows = [];
  function addWallet(w = {}) {
    const name = field('钱包名称', 'wallet-name-' + Date.now() + Math.random(), w.name || `钱包 ${walletRows.length + 1}`, { required: true }); const address = field('BSC 钱包地址', 'wallet-address-' + Date.now() + Math.random(), w.address || '', { placeholder: '0x…', required: true }); $('input', address).pattern = '0x[a-fA-F0-9]{40}';
    const row = el('div', { class: 'wallet-config-row' }, name, address); const entry = { row, original: w, name: $('input', name), address: $('input', address) }; walletRows.push(entry);
    const remove = el('button', { type: 'button', class: 'icon-button', 'aria-label': '移除此钱包', onclick: () => { row.remove(); walletRows.splice(walletRows.indexOf(entry), 1); } }, icon('trash')); row.append(remove); wallets.append(row);
  }
  for (const w of c.wallets || []) addWallet(w);
  const walletSection = configSection('config-wallets', '钱包与通知', '每个钱包独立登录；可在钱包管理中导入真实地址。', [wallets, el('div', { class: 'inline-actions' }, button('添加钱包', 'plus', async () => addWallet(), 'small')), el('div', { class: 'form-grid section-spacer' }, field('Telegram Bot Token', 'telegram.botToken', '', { type: 'password', placeholder: c.telegram?.botTokenConfigured ? '已配置 · 留空保留原 Token' : '尚未配置', help: '仅写入本地配置，保存后不回显。', full: true }), field('个人 Chat ID', 'telegram.chatId', c.telegram?.chatId), field('群组 Chat ID', 'telegram.groupChatId', c.telegram?.groupChatId)), c.telegram?.botTokenConfigured && el('label', { class: 'checkbox-row section-spacer' }, el('input', { type: 'checkbox', name: 'telegram.clearBotToken' }), '清除已保存的 Bot Token')]);
  const paidSection = configSection('config-paid', '铸造预算与进场', '进场进度至少 60%；保存值低于 60% 时仍按 60% 执行。提前进场进度、短时增幅、最少已售份数为旧参数，当前版本不参与判断。付费铸造（含收取手续费的项目）须检测到合约退款机制；这不保证能退款。任一付费预算设为 0 可禁止付费铸造。', el('div', { class: 'form-grid three' }, field('单项目预算上限', 'paid.maxUsd', p.maxUsd ?? 20, { type: 'number', min: 0, max: 100000, step: .01, suffix: 'USD', required: true }), field('每日付费上限', 'paid.maxBnbPerDay', p.maxBnbPerDay ?? 0, { type: 'number', min: 0, max: 10000, step: .0001, suffix: 'BNB', required: true }), field('保留 Gas 余额', 'paid.keepBnb', p.keepBnb ?? .006, { type: 'number', min: 0, max: 100, step: .0001, suffix: 'BNB', required: true }), field('标准进场进度', 'paid.goPct', (p.goPct ?? .6) * 100, { type: 'number', min: 0, max: 100, step: .1, suffix: '%', help: '实际门槛取保存值与 60% 中的较大值；此处保留保存值。', required: true }), field('提前进场进度 · 旧参数', 'paid.earlyPct', (p.earlyPct ?? .6) * 100, { type: 'number', min: 0, max: 100, step: .1, suffix: '%', required: true }), field('短时进度增幅 · 旧参数', 'paid.riseDelta', (p.riseDelta ?? .02) * 100, { type: 'number', min: 0, max: 100, step: .1, suffix: '%', required: true }), field('最少已售份数 · 旧参数', 'paid.minSold', p.minSold ?? 30, { type: 'number', min: 0, max: 100000, step: 1, required: true }), field('最长追踪时间', 'paid.maxAgeH', p.maxAgeH ?? 168, { type: 'number', min: 1, max: 8760, step: 1, suffix: '小时', required: true })));
  const ruleEditor = configRulesEditor(r);
  const rulesSection = configSection('config-rules', 'ERC20 卖出与止盈规则', '可选择旧版半仓或新版阶梯策略，保存并重启后生效；只读模式不会卖出。', ruleEditor.body);
  const tokens = field('手动追踪持仓', 'tokens', JSON.stringify(c.tokens || [], null, 2), { full: true }); const tokenInput = el('textarea', { id: 'tokens-json', name: 'tokens-json', rows: 7, 'aria-label': '手动追踪持仓 JSON' }, JSON.stringify(c.tokens || [], null, 2)); $('input', tokens).replaceWith(tokenInput); $('label', tokens).htmlFor = 'tokens-json'; tokens.append(el('p', { class: 'help' }, 'JSON 数组。示例字段：sym、addr、cost；hold: true 只追踪不自动卖出。'));
  const otherSection = configSection('config-other', '高级设置', '手动追踪项目与通知设置。', [el('div', { class: 'form-grid' }, field('时区', 'timeZone', c.timeZone || 'Asia/Shanghai', { required: true }), field('观察金库地址', 'watchVault', c.watchVault || '', { placeholder: '可选 · 0x…' }), tokens), el('label', { class: 'checkbox-row section-spacer' }, el('input', { type: 'checkbox', name: 'notifyAll', checked: c.notifyAll === true }), 'Telegram 接收全部发现通知')]);
  form.append(mode, walletSection, paidSection, rulesSection, otherSection);
  const save = button('保存配置', 'save', async () => {
    if (!form.reportValidity()) return;
    let tokenData; try { tokenData = JSON.parse(tokenInput.value); if (!Array.isArray(tokenData)) throw new Error(); } catch { toast('手动追踪持仓必须是有效的 JSON 数组。', true); tokenInput.focus(); return; }
    const fd = new FormData(form), get = (n) => fd.get(n), num = (n) => Number(get(n));
    let ruleData; try { ruleData = ruleEditor.read(fd); } catch (error) { toast(error.message, true); return; }
    const next = { ...c, monitorOnly: get('monitorOnly') !== 'false', wallets: walletRows.map((w) => ({ ...w.original, name: w.name.value.trim(), address: w.address.value.trim() })), telegram: { ...c.telegram, botToken: String(get('telegram.botToken') || '').trim(), chatId: String(get('telegram.chatId') || '').trim(), groupChatId: String(get('telegram.groupChatId') || '').trim(), clearBotToken: get('telegram.clearBotToken') === 'on' }, paid: { ...p }, rules: { ...r, ...ruleData }, tokens: tokenData, timeZone: String(get('timeZone')).trim(), watchVault: String(get('watchVault') || '').trim(), notifyAll: get('notifyAll') === 'on' };
    for (const key of ['maxUsd', 'maxBnbPerDay', 'keepBnb', 'minSold', 'maxAgeH']) next.paid[key] = num('paid.' + key);
    for (const key of ['goPct', 'earlyPct', 'riseDelta']) next.paid[key] = num('paid.' + key) / 100;

    let confirmAutoTrading = false;
    if (!next.monitorOnly) { confirmAutoTrading = await confirmAction('保存自动交易配置', '重启应用此配置后，监控服务会按策略自动铸造、兑换和卖出。', '确认并保存', { checkbox: '我已核对钱包与预算，同意保存自动交易配置', details: [`钱包数量：${next.wallets.length}`, `单项目预算：${usd(next.paid.maxUsd)}`, `每日付费上限：${next.paid.maxBnbPerDay} BNB`] }); if (!confirmAutoTrading) return; }
    const result = await api('/api/config', { method: 'POST', body: { config: next, confirmAutoTrading } });
    state.config = result.config || result; toast('配置已保存，重启监控后生效'); updateChrome(); renderConfig(); await refreshStatus();
  }, 'primary wide');
  const aside = panel('配置导航', null, el('div', { class: 'panel-content' }, el('div', {}, [['config-mode', '运行模式'], ['config-wallets', '钱包与通知'], ['config-paid', '铸造预算与进场'], ['config-rules', 'ERC20 止盈规则'], ['config-other', '高级设置'], ['config-nft-automation', 'NFT 自动卖出']].map(([id, text]) => el('a', { href: '#' + id, onclick: (e) => { e.preventDefault(); $('#' + id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); } }, text))), save, el('p', { class: 'save-note' }, '上方配置保存后需重启监控。NFT 规则在其独立面板单独保存和启用。'))); aside.classList.add('config-sidebar');
  const mobileSave = save.cloneNode(true); mobileSave.style.marginTop = '3px'; mobileSave.classList.add('mobile-save'); mobileSave.addEventListener('click', () => save.click());
  replace(content, title('策略配置', '设置预算、进场与卖出规则，掌握每一次自动操作。'), state.status?.service?.needsRestart && modeBanner(), el('div', { class: 'form-layout' }, el('div', {}, form, mobileSave, nftManagerPanel()), aside));
}
let holdingsView = null;
function holdingsLoading(message) { return el('div', { class: 'loading-page holdings-loading' }, el('span', { class: 'spinner' }), el('p', {}, message)); }
function nftStatus(nft) {
  const kind = { held: '', zero: 'muted', unverified: 'amber', error: 'red' };
  const label = { held: '持有中', zero: '已无持仓', unverified: '待核验', error: '核验失败' };
  return el('div', { class: 'nft-verification' }, badge(label[nft.status] || '待核验', kind[nft.status] ?? 'amber'),
    nft.verifiedAt && el('div', { class: 'table-muted' }, '核验于 ' + date(nft.verifiedAt, true)),
    nft.status === 'unverified' && el('div', { class: 'table-muted' }, '链上数量尚未确认'),
    ['error', 'unverified'].includes(nft.status) && nft.error && el('div', { class: 'nft-error' }, String(nft.error)));
}
function nftQuantity(nft) {
  const partial = nft.standard === 'ERC1155' && nft.idsComplete === false;
  const ids = Array.isArray(nft.tokenIds) ? nft.tokenIds.map(String) : [];
  return el('div', {}, el('span', { class: 'mono' }, nft.quantity == null || nft.quantity === '' ? '—' : String(nft.quantity)),
    partial && el('div', { class: 'table-muted' }, '已知 ID 合计'),
    partial && ids.length > 0 && el('div', { class: 'table-muted', title: ids.join(', ') }, 'ID：' + ids.slice(0, 5).join(', ') + (ids.length > 5 ? ' …' : '')));
}
function marketUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443') && ['element.market', 'www.element.market', 'opensea.io', 'www.opensea.io'].includes(url.hostname) ? value : null;
  } catch { return null; }
}
function marketNumber(value) {
  const raw = String(value), number = Number(value);
  if (!Number.isFinite(number)) return raw;
  // Keep underflowed non-zero decimal strings rather than displaying a false 0.
  if (number === 0 && /[1-9]/.test(raw.split(/[eE]/)[0])) return raw;
  return new Intl.NumberFormat('en-US', { maximumSignificantDigits: 12, useGrouping: false }).format(number);
}
function marketAmount(quote, emptyLabel) {
  if (!quote || quote.amount == null || String(quote.amount).trim() === '') return el('span', { class: 'table-muted' }, emptyLabel);
  const dollar = Number(quote.usd);
  return el('span', {}, el('span', { class: 'mono', title: String(quote.amount) + (quote.currency ? ' ' + String(quote.currency) : '') }, marketNumber(quote.amount), quote.currency ? ' ' + String(quote.currency) : ''), quote.usd != null && String(quote.usd).trim() !== '' && el('span', { class: 'market-usd', title: '$' + String(quote.usd) }, dollar > 0 && dollar < .01 ? '$' + marketNumber(quote.usd) : usd(quote.usd)));
}
function nftMarket(nft) {
  const market = nft.market;
  if (!market) return el('div', { class: 'market-cell' }, el('span', { class: 'table-muted' }, '报价待更新'));
  return el('div', { class: 'market-cell' },
    el('div', { class: 'market-price-line' }, el('span', { class: 'market-label' }, '参考地板价'), marketAmount(market.floor, '暂无报价')),
    el('div', { class: 'market-price-line' }, el('span', { class: 'market-label' }, '最近成交'), marketAmount(market.lastSale, '暂无公开成交数据')),
    market.bestBid && el('div', { class: 'market-price-line' }, el('span', { class: 'market-label' }, '最高出价'), marketAmount(market.bestBid, '暂无出价')),
    market.lastSale?.at && el('div', { class: 'market-meta' }, '成交于 ' + date(market.lastSale.at, true)),
    market.volume && el('div', { class: 'market-meta' }, '累计成交量：', marketAmount(market.volume, '暂无数据')),
    el('div', { class: 'market-meta' }, [market.source, market.updatedAt && date(market.updatedAt)].filter(Boolean).join(' · ')),
    market.reason && el('div', { class: 'market-reason' }, String(market.reason)));
}
function nftMarketAction(nft) {
  const listing = marketUrl(nft.market?.sellUrl), details = marketUrl(nft.market?.url);
  const marketAction = listing ? el('a', { class: 'button small', href: listing, target: '_blank', rel: 'noopener noreferrer' }, icon('external'), '去市场挂单') : details ? el('a', { class: 'button small ghost', href: details, target: '_blank', rel: 'noopener noreferrer' }, icon('external'), '查看市场') : el('span', { class: 'table-muted' }, nft.status === 'zero' ? '已无持仓' : nft.market?.status === 'pending_id' ? '待识别 NFT ID' : '暂无市场入口');
  const rules = nftAssetRules(nft), enabled = rules.filter((rule) => rule.enabled).length;
  return el('div', { class: 'nft-market-actions' }, marketAction, button('自动卖出规则', 'sliders', () => openNftAssetRules(nft), 'small'), rules.length > 0 && el('span', { class: 'table-muted' }, enabled ? `${enabled} 条已启用` : `${rules.length} 条停用规则`));
}
function nftRules() { return Array.isArray(nftTradingData?.rules) ? nftTradingData.rules : []; }
function nftAssetRules(nft) { return nftRules().filter((rule) => String(rule.addr).toLowerCase() === String(nft.addr).toLowerCase() && String(rule.walletAddress).toLowerCase() === String(nft.walletAddress).toLowerCase()); }
function nftKeyReady() { return Boolean(nftTradingData?.capabilities?.apiKeyConfigured ?? nftTradingData?.settings?.apiKeyConfigured); }
function nftRulePhase(rule) {
  const live = nftTradingData?.states?.[rule.key] || {}, phase = String(live.phase || (rule.enabled ? 'enabled' : 'disabled'));
  const labels = { draft: '停用草稿', disabled: '已停用', enabled: '已启用', waiting: '等待条件', 'waiting-offer': '等待有效买单', waiting_offer: '等待有效买单', 'waiting-approval': '等待授权', awaiting_approval: '等待授权', 'needs-confirmation': '等待确认', pending_confirmation: '等待确认', listed: '已挂单', listing: '挂单处理中', filled: '已成交', finished: '已完成', cancelled: '已撤单', canceled: '已撤单', expired: '已过期', paused: '已暂停', blocked: '执行受阻', error: '执行异常', submitting: '提交中' };
  Object.assign(labels, { idle: '待检查', intent: '准备提交', signing: '签名中', 'signature-pending': '等待手机确认', publishing: '发布挂单中', pending: '待链上确认', review: '需核对订单', 'awaiting-approval': '等待单独授权', 'awaiting-confirmation': '等待预演确认', 'waiting-trigger': '等待规则条件' });
  return { ...live, label: labels[phase.toLowerCase()] || phase, phase };
}
function nftPolicyLines(rule) {
  const modeLine = rule.mode === 'fixed-listing' ? `挂单单价：${rule.listingUnitPriceBnb || '未设置'} BNB / NFT` : rule.mode === 'take-profit-offer' ? `目标净收入：${rule.takeProfitNetBnb || '未设置'} BNB（整笔）` : `跟踪止盈：净收入达到 ${rule.trailingArmNetBnb || '未设置'} BNB 后，从峰值回撤 ${Number(rule.trailingDropBps || 0) / 100}%`;
  return [`钱包：${rule.walletAddress}`, `合约：${rule.addr}`, `Token ID：${rule.tokenId} · 数量：${rule.quantity}`, `${nftRuleModes[rule.mode] || rule.mode} · ${modeLine}`, `最低净收入：${rule.minNetBnb || '未设置'} BNB · 最高费用：${rule.maxFeesBnb === '' || rule.maxFeesBnb == null ? '未设置' : rule.maxFeesBnb} BNB`, `订单有效期：${rule.expirySec} 秒 · 冷却：${rule.cooldownSec} 秒`];
}
function nftRuleComplete(rule) {
  const positive = (value) => typeof value === 'string' && /^\d+(?:\.\d{1,18})?$/.test(value) && /[1-9]/.test(value);
  const price = rule.mode === 'fixed-listing' ? rule.listingUnitPriceBnb : rule.mode === 'take-profit-offer' ? rule.takeProfitNetBnb : rule.trailingArmNetBnb;
  return positive(price) && positive(rule.minNetBnb) && typeof rule.maxFeesBnb === 'string' && /^\d+(?:\.\d{1,18})?$/.test(rule.maxFeesBnb);
}
function openNftModal(name, body, actions = []) { openModal(name, body, actions); modal.classList.add('nft-rule-dialog'); }
async function loadNftTrading({ force = false, quiet = false } = {}) {
  if (nftTradingRequest) {
    if (!force) return nftTradingRequest;
    await nftTradingRequest;
  }
  nftTradingRequest = (async () => {
    try { nftTradingData = await api('/api/nft/trading'); nftTradingError = null; return nftTradingData; }
    catch (e) { nftTradingError = e; if (!quiet) toast(e.message, true); return null; }
    finally {
      nftTradingRequest = null;
      for (const view of nftManagerViews) { if (!view.root.isConnected) nftManagerViews.delete(view); else updateNftManager(view); }
    }
  })();
  return nftTradingRequest;
}
function nftRuleContext(rule) {
  const rows = holdingsView?.data?.nfts || [];
  return rows.find((nft) => String(nft.addr).toLowerCase() === rule.addr.toLowerCase() && String(nft.walletAddress).toLowerCase() === rule.walletAddress.toLowerCase()) || { addr: rule.addr, walletAddress: rule.walletAddress, standard: rule.standard, ownedTokenId: rule.tokenId, tokenIds: [rule.tokenId], name: rule.addr, wallet: state.config?.wallets?.find((wallet) => wallet.address.toLowerCase() === rule.walletAddress.toLowerCase())?.name };
}
function currentNftRule(key, result, fallback) {
  const returned = result?.rule || (result?.key ? result : null);
  return (!nftTradingError && nftRules().find((rule) => rule.key === key)) || returned || fallback;
}
async function disableNftRule(rule) {
  const result = await api('/api/nft/trading/disable', { method: 'POST', body: { key: rule.key } });
  await loadNftTrading({ force: true, quiet: true });
  toast('规则已停用；已挂订单不会自动撤销');
  return currentNftRule(rule.key, result, rule);
}
function nftManagerPanel() {
  const root = el('div'), view = { root, capability: el('div', { class: 'nft-capability' }), keyState: el('span'), ruleList: el('div', { class: 'nft-rule-list' }), keyInput: el('input', { class: 'input', type: 'password', autocomplete: 'new-password', placeholder: '输入 Element API Key · 留空不修改', 'aria-label': 'Element API Key' }) };
  const saveKey = button('保存 API Key', 'save', async () => {
    const value = view.keyInput.value.trim(); if (!value) throw new Error('请先填写 API Key。');
    try { await api('/api/nft/trading/settings', { method: 'POST', body: { apiKey: value } }); toast('API Key 已保存在本机'); }
    finally { view.keyInput.value = ''; }
    await loadNftTrading({ force: true, quiet: true });
  }, 'small');
  view.clearKey = button('清除 API Key', 'trash', async () => {
    if (!await confirmAction('清除市场 API Key', '清除后相关 NFT 规则将无法继续调用市场 API。已挂订单不会自动撤销。', '确认清除')) return;
    await api('/api/nft/trading/settings', { method: 'POST', body: { clearApiKey: true } }); await loadNftTrading({ force: true, quiet: true }); toast('API Key 已清除');
  }, 'small ghost');
  root.append(view.capability, el('details', { class: 'nft-key-settings' }, el('summary', {}, 'Element 市场 API Key 设置 · ', view.keyState), el('div', { class: 'field' }, view.keyInput, el('p', { class: 'help' }, '仅写入本地文件，不回显。缺少 API Key 可保存草稿，不能启用规则。')), el('div', { class: 'inline-actions' }, saveKey, view.clearKey)),
    el('div', { class: 'nft-trading-notice' }, 'NFT 规则独立于 ERC20 止盈。执行授权与签名需要钱包登录并开启开发者模式；实际收入可能是 WBNB，不会自动兑换成 BNB。'),
    el('div', { class: 'nft-rule-list-heading' }, el('h3', {}, '已保存的资产规则'), el('div', { class: 'inline-actions' }, button('刷新状态', 'refresh', () => loadNftTrading({ force: true }), 'small'), button('从持仓添加', 'plus', async () => { go('holdings'); toast('请选择 NFT 行的“自动卖出规则”'); }, 'small'))), view.ruleList);
  nftManagerViews.add(view); updateNftManager(view); loadNftTrading({ quiet: true });
  return configSection('config-nft-automation', 'NFT 自动卖出', '按钱包、合约和真实 Token ID 独立配置；保存草稿不会启用或发送交易。', root);
}
function updateNftManager(view) {
  if (nftTradingError) {
    replace(view.capability, el('div', { class: 'holdings-error' }, el('div', {}, el('strong', {}, 'NFT 自动卖出状态暂不可用'), el('p', {}, nftTradingError.message)), button('重试', 'refresh', () => loadNftTrading({ force: true }), 'small')));
    if (!nftTradingData) replace(view.ruleList, empty('暂时无法读取规则', '读取成功前不会展示为已启用。', 'info'));
    return;
  }
  if (!nftTradingData) { replace(view.capability, holdingsLoading('正在读取 NFT 自动卖出状态…')); return; }
  const ready = nftTradingData.capabilities?.ready === true;
  replace(view.capability, badge(ready ? '市场 API 已配置' : '暂不可启用', ready ? '' : 'amber'), el('span', {}, nftTradingData.capabilities?.reason || (nftKeyReady() ? '请查看各规则实际执行状态。' : '尚未配置 Element API Key。')));
  view.keyState.textContent = nftKeyReady() ? '已保存 · 不回显' : '未配置'; view.clearKey.disabled = !nftKeyReady();
  if (view.ruleList.contains(document.activeElement)) return;
  const rules = nftRules();
  replace(view.ruleList, rules.length ? rules.map((rule) => {
    const live = nftRulePhase(rule), activeOrder = live.orderId && !['filled', 'finished', 'cancelled', 'canceled', 'expired'].includes(String(live.phase).toLowerCase());
    return el('div', { class: 'nft-rule-card' }, el('div', { class: 'nft-rule-card-header' }, el('div', {}, el('h3', {}, `${nftRuleModes[rule.mode] || rule.mode} · Token ID ${rule.tokenId}`), el('div', { class: 'address' }, rule.addr)), badge(rule.enabled ? '已启用' : '已停用', rule.enabled ? '' : 'muted')),
      el('div', { class: 'nft-rule-policy-summary' }, nftPolicyLines(rule).slice(0, 1).concat(nftPolicyLines(rule).slice(2)).map((line) => el('span', {}, line))),
      el('div', { class: 'nft-rule-live-state' }, badge(live.label, ['blocked', 'error', 'paused'].includes(String(live.phase).toLowerCase()) ? 'amber' : 'muted'), live.reason && el('span', {}, String(live.reason)), live.lastCheckedAt && el('span', { class: 'table-muted' }, '最近检查 ' + date(live.lastCheckedAt, true))),
      live.orderId && el('div', { class: 'nft-rule-order mono' }, '订单：' + live.orderId), live.txHash && el('div', { class: 'nft-rule-order mono' }, '交易：' + live.txHash),
      el('div', { class: 'nft-rule-card-actions' }, button('编辑价格与规则', 'sliders', async () => showNftRuleEditor(nftRuleContext(rule), rule), 'small'), rule.enabled ? button('停用新单', 'stop', () => disableNftRule(rule), 'small') : button('启用规则', 'play', async () => showNftRuleEditor(nftRuleContext(rule), rule, { requestEnable: true }), 'small'), button('检查并预演', 'shield', () => previewNftRule(rule), 'small'), activeOrder && button('撤单预演', 'close', () => previewNftRule(rule, { cancel: true }), 'small ghost')));
  }) : empty('还没有 NFT 自动卖出规则', '从持仓中的真实 NFT 创建规则；草稿需单独确认启用。', 'portfolio'));
}
async function openNftAssetRules(nft) {
  await loadNftTrading({ force: true, quiet: true });
  if (nftTradingError) { openNftModal('NFT 自动卖出规则', errorPanel(nftTradingError, () => openNftAssetRules(nft)), [button('关闭', null, async () => closeModal())]); return; }
  const rules = nftAssetRules(nft);
  if (rules.length === 1) return showNftRuleEditor(nft, rules[0]);
  if (!rules.length) return showNftRuleEditor(nft);
  openNftModal('选择 NFT 规则', el('div', { class: 'nft-rule-list' }, rules.map((rule) => el('div', { class: 'nft-rule-choice' }, el('div', {}, el('h3', {}, `Token ID ${rule.tokenId} · ${nftRuleModes[rule.mode] || rule.mode}`), el('p', { class: 'table-muted' }, rule.enabled ? '已启用' : '已停用')), button('编辑规则', 'sliders', async () => showNftRuleEditor(nft, rule), 'small')))), [button('关闭', null, async () => closeModal()), button('为当前持有 ID 新建', 'plus', async () => showNftRuleEditor(nft), 'primary')]);
}
function showNftRuleEditor(nft, savedRule = null, { requestEnable = false } = {}) {
  const tokenId = savedRule?.tokenId ?? nft.ownedTokenId;
  const standard = savedRule?.standard || nft.standard;
  if (!/^\d+$/.test(String(tokenId ?? '')) || !['ERC721', 'ERC1155'].includes(standard)) {
    openNftModal('等待核验真实 NFT', el('div', {}, el('p', { class: 'modal-description' }, '尚未核验此钱包实际持有的 Token ID 或 NFT 类型，暂不能建立自动卖出规则。不会用历史候选 ID 或系列地板价替代。'), el('div', { class: 'address' }, nft.addr)), [button('关闭', null, async () => closeModal()), button('刷新 NFT 核验', 'refresh', async () => { const data = await api('/api/holdings?refresh=1'); const fresh = data.nfts?.find((row) => row.addr === nft.addr && row.walletAddress === nft.walletAddress && row.ownedTokenId != null); if (fresh) showNftRuleEditor(fresh); else toast('已请求链上核验，请稍后刷新持仓'); }, 'primary')]); return;
  }
  const rule = savedRule || { enabled: false, walletAddress: nft.walletAddress, addr: nft.addr, standard, tokenId: String(tokenId), quantity: '1', mode: 'fixed-listing', listingUnitPriceBnb: '', takeProfitNetBnb: '', trailingArmNetBnb: '', trailingDropBps: 2000, minNetBnb: '', maxFeesBnb: '', expirySec: 86400, cooldownSec: 60 };
  const form = el('form', { class: 'nft-rule-form', onsubmit: (e) => e.preventDefault() }), message = el('div', { class: 'form-message', role: 'status' }), enableReview = el('div');
  let dirty = false;
  const identity = (label, name, value) => { const node = field(label, name, value, { full: true }); $('input', node).readOnly = true; return node; };
  const mode = el('select', { id: 'nft-rule-mode', name: 'mode' }, Object.entries(nftRuleModes).map(([value, label]) => el('option', { value, selected: value === rule.mode }, label))); mode.value = rule.mode;
  const money = (label, name, value, help) => { const node = field(label, name, value, { suffix: 'BNB', help }); const input = $('input', node); input.inputMode = 'decimal'; input.pattern = '\\d+(?:\\.\\d{1,18})?'; input.placeholder = '十进制字符串，最多 18 位小数'; return node; };
  const listing = money('挂单单价（每个 NFT）', 'listingUnitPriceBnb', rule.listingUnitPriceBnb || '', '固定挂单不要求当前买单，但需取得费用估算。');
  const target = money('目标净收入（整笔）', 'takeProfitNetBnb', rule.takeProfitNetBnb || '', '仅在存在满足条件的可执行买单时成交，地板价不作为买价。');
  const arm = money('跟踪止盈启动净收入（整笔）', 'trailingArmNetBnb', rule.trailingArmNetBnb || '', '以有效买单的净收入采样峰值，无买单时等待。');
  const drop = field('从净收入峰值回撤', 'trailingDropPercent', Number(rule.trailingDropBps ?? 2000) / 100, { type: 'number', min: .01, max: 100, step: .01, suffix: '%' });
  const updateMode = () => { for (const [node, visible] of [[listing, mode.value === 'fixed-listing'], [target, mode.value === 'take-profit-offer'], [arm, mode.value === 'trailing-offer'], [drop, mode.value === 'trailing-offer']]) { node.hidden = !visible; for (const input of node.querySelectorAll('input')) input.disabled = !visible; } };
  mode.addEventListener('change', updateMode); updateMode();
  const quantity = field('出售数量', 'quantity', rule.quantity, { help: standard === 'ERC721' ? 'ERC-721 固定为 1。' : '正整数；后端会按此 Token ID 核验，系列总量不作为上限。' }); $('input', quantity).pattern = '[1-9]\\d*'; $('input', quantity).required = true; if (standard === 'ERC721') $('input', quantity).readOnly = true;
  form.append(el('div', { class: 'nft-rule-identity' }, identity('钱包地址', 'walletAddress', rule.walletAddress), identity('NFT 合约地址', 'addr', rule.addr), el('div', { class: 'nft-identity-id' }, el('span', {}, `${standard} · Token ID ${tokenId}`))),
    el('div', { class: 'field section-spacer' }, el('label', { for: 'nft-rule-mode' }, '自动卖出方式'), mode),
    el('div', { class: 'form-grid section-spacer' }, listing, target, arm, drop, quantity, money('最低净收入（整笔）', 'minNetBnb', rule.minNetBnb || '', '启用时须大于 0。实际收入可能为 WBNB。'), money('市场费与预估 Gas 上限', 'maxFeesBnb', rule.maxFeesBnb ?? '', '整笔上限，须填写，可为 0。Gas 为预估，实际值可能变化；部分成交需人工核对。'), field('订单有效期', 'expirySec', rule.expirySec ?? 86400, { type: 'number', min: 300, max: 604800, step: 1, suffix: '秒', required: true }), field('操作冷却时间', 'cooldownSec', rule.cooldownSec ?? 60, { type: 'number', min: 5, max: 3600, step: 1, suffix: '秒', required: true })), message);
  const enable = el('input', { type: 'checkbox', checked: rule.enabled === true, 'aria-label': '启用此 NFT 自动卖出规则' });
  const enableReason = el('p', { class: 'help' });
  const updateEnable = () => { enable.checked = rule.enabled === true; enable.disabled = !rule.enabled && (dirty || !savedRule || !nftKeyReady() || nftTradingData?.capabilities?.ready === false || !nftRuleComplete(rule)); enableReason.textContent = dirty ? '修改后请先保存停用草稿，再启用或预演。' : !savedRule ? '先保存停用草稿，之后单独确认启用。' : !nftKeyReady() ? '未配置 Element API Key，不能启用；可保存规则。' : !nftRuleComplete(rule) ? '请先填写正数目标价、最低净收入及费用上限并保存。' : nftTradingData?.capabilities?.reason || '无有效买单时会等待；启用不表示立即成交。'; };
  const preview = button('检查并预演', 'shield', () => previewNftRule(rule), 'small'); preview.disabled = !savedRule || !nftKeyReady();
  function showEnableReview() {
    if (dirty || !savedRule || !nftRuleComplete(rule) || !nftKeyReady() || nftTradingData?.capabilities?.ready === false) { updateEnable(); return; }
    const hash = rule.hash || rule.policyHash; if (!hash) { message.textContent = '此规则缺少政策哈希，请刷新后重新保存。'; return; }
    const allowed = el('input', { type: 'checkbox' });
    const execute = button('确认启用真实自动卖出', 'play', async () => {
      if (!allowed.checked) return;
      const result = await api('/api/nft/trading/enable', { method: 'POST', body: { key: rule.key, policyHash: hash, confirmed: true } });
      await loadNftTrading({ force: true, quiet: true }); toast('NFT 规则已启用，具体执行以运行状态为准');
      if (!modal.open || !body.isConnected) return;
      showNftRuleEditor(nft, currentNftRule(rule.key, result, rule));
    }, 'primary'); execute.disabled = true; allowed.addEventListener('change', () => { execute.disabled = !allowed.checked; });
    replace(enableReview, el('div', { class: 'nft-enable-review' }, el('h3', {}, '授权按以下边界自动执行'), el('div', { class: 'confirmation-list' }, nftPolicyLines(rule).map((line) => el('span', {}, line))), el('p', { class: 'nft-trading-notice' }, '这是实际自动签名、挂单或接受买单的授权，不是模拟。需手机确认时会暂停等待；无买单不会用地板价代替成交价。'), el('label', { class: 'checkbox-row nft-enable-check' }, allowed, '我授权此 NFT 在上述资产、数量、价格、费用和期限边界内自动签名及成交。'), el('div', { class: 'inline-actions' }, execute, button('取消启用', null, async () => replace(enableReview), 'ghost'))));
  }
  enable.addEventListener('change', async () => {
    const desired = enable.checked; enable.checked = rule.enabled === true;
    if (desired) { showEnableReview(); return; }
    enable.disabled = true;
    try { const updated = await disableNftRule(rule); rule.enabled = updated.enabled; updateEnable(); } catch (e) { toast(e.message, true); updateEnable(); }
  });
  const markDirty = () => { dirty = true; replace(enableReview); preview.disabled = true; updateEnable(); };
  form.addEventListener('input', markDirty); form.addEventListener('change', markDirty);
  const live = savedRule && nftRulePhase(rule);
  const body = el('div', {}, savedRule && el('div', { class: 'nft-editor-current' }, badge(rule.enabled ? '已启用' : '已停用', rule.enabled ? '' : 'muted'), badge(live.label, 'muted'), live.reason && el('span', {}, String(live.reason))), form,
    el('div', { class: 'nft-enable-control' }, el('label', { class: 'checkbox-row' }, enable, '启用此资产的自动卖出规则'), enableReason),
    el('p', { class: 'nft-trading-notice' }, '保存会生成停用草稿。停用仅停止新单，不会自动撤销已挂订单。授权/签名需开发者模式；可能收到 WBNB，不自动兑换。'), enableReview);
  const save = button('保存停用草稿', 'save', async () => {
    if (!form.reportValidity()) return;
    const fd = new FormData(form), selectedMode = String(fd.get('mode'));
    const draft = { enabled: false, walletAddress: rule.walletAddress, addr: rule.addr, standard, tokenId: String(tokenId), quantity: String(fd.get('quantity')).trim(), mode: selectedMode, minNetBnb: String(fd.get('minNetBnb') || '').trim(), maxFeesBnb: String(fd.get('maxFeesBnb') || '').trim(), expirySec: Number(fd.get('expirySec')), cooldownSec: Number(fd.get('cooldownSec')) };
    if (typeof rule.name === 'string' && rule.name) draft.name = rule.name;
    if (selectedMode === 'fixed-listing') draft.listingUnitPriceBnb = String(fd.get('listingUnitPriceBnb') || '').trim();
    if (selectedMode === 'take-profit-offer') draft.takeProfitNetBnb = String(fd.get('takeProfitNetBnb') || '').trim();
    if (selectedMode === 'trailing-offer') { draft.trailingArmNetBnb = String(fd.get('trailingArmNetBnb') || '').trim(); draft.trailingDropBps = Math.round(Number(fd.get('trailingDropPercent')) * 100); }
    const result = await api('/api/nft/trading/rules', { method: 'POST', body: { rule: draft } }); await loadNftTrading({ force: true, quiet: true });
    const key = result.rule?.key || result.key || `${draft.walletAddress.toLowerCase()}:${draft.addr.toLowerCase()}:${draft.tokenId}`;
    const saved = currentNftRule(key, result, null);
    if (!saved) throw new Error('草稿已提交，但没有返回可识别的规则，请刷新管理列表。');
    toast('规则草稿已保存，尚未启用'); if (modal.open && form.isConnected) showNftRuleEditor(nft, saved);
  }, 'primary');
  openNftModal('NFT 自动卖出规则', body, [button('关闭', null, async () => closeModal()), preview, save]); updateEnable();
  if (requestEnable && !rule.enabled) showEnableReview();
}
function nftExpiry(value) { if (typeof value === 'number' || /^\d+$/.test(String(value))) return Number(value) < 1e12 ? Number(value) * 1000 : Number(value); return Date.parse(value || ''); }
async function previewNftRule(rule, { cancel = false } = {}) {
  const loading = holdingsLoading('正在核验资产、市场报价与权限…');
  openNftModal(cancel ? '预演 NFT 撤单' : '检查并预演 NFT 动作', loading);
  let data;
  try { data = await api('/api/nft/trading/' + (cancel ? 'cancel-preview' : 'preview'), { method: 'POST', body: { key: rule.key } }); }
  catch (e) { if (modal.open && loading.isConnected) openNftModal('NFT 预演未完成', errorPanel(e, () => previewNftRule(rule, { cancel })), [button('返回规则', 'arrow', async () => showNftRuleEditor(nftRuleContext(rule), rule))]); return; }
  if (!modal.open || !loading.isConnected) return;
  const renderValue = (value) => typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  const body = el('div', {}, el('div', { class: 'nft-preview-status' }, badge(data.status || '预演结果', data.actionId ? '' : 'amber'), data.reason && el('p', {}, String(data.reason))),
    cancel && el('p', { class: 'nft-trading-notice' }, '确认撤单会同时停用此规则；只有链上确认后才视为订单失效。撤单 Gas 另按本次预演核对。'),
    ['summary', 'estimatedGasBnb', 'position', 'quote', 'approval', 'parsedTx', 'parsedMessage', 'simulationResult', 'risks'].filter((key) => data[key] != null).map((key) => el('div', { class: 'result-block' }, el('h3', {}, ({ summary: '动作概览', estimatedGasBnb: '本次预估 Gas（BNB）', position: 'NFT 资产与数量', quote: '可执行报价、费用与净收入', approval: '授权对象与范围', parsedTx: '交易解析', parsedMessage: '签名消息解析', simulationResult: '模拟资产变化、授权与权限变化', risks: '风险信息' })[key]), el('pre', { class: 'json-block' }, renderValue(data[key])))),
    data.expiresAt && el('p', { class: 'nft-preview-expiry' }, '本次预演有效至 ' + date(data.expiresAt, true)));
  const actions = [button('返回规则', 'arrow', async () => showNftRuleEditor(nftRuleContext(rule), nftRules().find((entry) => entry.key === rule.key) || rule))];
  if (data.actionId) {
    const checked = el('input', { type: 'checkbox' });
    const submit = button('确认本次预演动作', 'check', async () => {
      if (!checked.checked) return;
      const expiry = nftExpiry(data.expiresAt); if (Number.isFinite(expiry) && expiry <= Date.now()) throw new Error('本次预演已过期，请重新预演。');
      const result = await api('/api/nft/trading/confirm', { method: 'POST', body: { actionId: data.actionId, confirmed: true } });
      await loadNftTrading({ force: true, quiet: true });
      if (!modal.open || !body.isConnected) { toast('NFT 预演动作已提交，请查看规则状态'); return; }
      openNftModal('NFT 动作已提交', el('div', {}, el('p', { class: 'modal-description' }, '请以订单与链上最终状态为准；如需币安 App 确认，请在手机完成。'), el('pre', { class: 'json-block' }, renderValue(result))), [button('关闭', null, async () => closeModal()), button('查看规则状态', 'refresh', async () => showNftRuleEditor(nftRuleContext(rule), nftRules().find((entry) => entry.key === rule.key) || rule), 'primary')]);
      toast('NFT 预演动作已提交');
    }, 'primary'); submit.disabled = true; checked.addEventListener('change', () => { submit.disabled = !checked.checked; });
    body.append(el('label', { class: 'checkbox-row nft-enable-check' }, checked, '我已核对本次 NFT、数量、价格、费用、spender 与权限范围，以及交易/签名风险，确认提交本动作。')); actions.push(submit);
  }
  openNftModal(cancel ? '核对 NFT 撤单预演' : '核对 NFT 预演与授权', body, actions);
}
function usesStepRules(rules = {}) { return rules.strategy === 'steps' || (rules.strategy !== 'legacy' && !Array.isArray(rules.halfX)); }
function ruleStrategyName(rules = {}) { return usesStepRules(rules) ? '新版阶梯与长抱策略' : '旧版半仓止盈策略'; }
function ruleSummary(key, value) {
  if (value == null) return '—';
  if (key === 'halfX' || key === 'moonNotifyX') return Array.isArray(value) ? value.map((x) => `${x}×`).join(' / ') || '关闭' : '—';
  if (key === 'steps') return Array.isArray(value) ? value.map(([x, amount]) => `${x}× 卖 ${amount}%`).join(' / ') || '关闭' : '—';
  if (key === 'moonPct') return `${value}%`;
  if (key === 'fastMin' || key === 'noPumpMin') return `${value} 分钟`;
  return key === 'backX' || key === 'noPumpX' ? `${value}×` : pct(value);
}
function renderStrategyState(view, strategy) {
  if (!view.strategy) return;
  if (!strategy) { replace(view.strategy, el('div', { class: 'strategy-unavailable' }, 'ERC20 策略生效状态暂不可用。NFT 自动卖出使用独立资产规则。')); return; }
  const configured = strategy.configuredRules || {}, effective = strategy.effectiveRules || {}, running = typeof strategy.scannerRunning === 'boolean' ? strategy.scannerRunning : Boolean(state.status?.service?.running), monitor = strategy.mode === 'monitor';
  const steps = usesStepRules(configured) || Boolean(strategy.effectiveRules && usesStepRules(effective)), legacy = !usesStepRules(configured) || Boolean(strategy.effectiveRules && !usesStepRules(effective));
  const rows = [['backX', '回本倍数'], ...(steps ? [['steps', '阶梯止盈'], ['crashAfterBack', '回本后回撤'], ['moonPct', '回本后长抱比例'], ['moonNotifyX', '长抱通知倍数']] : []), ...(legacy ? [['halfX', '每次卖一半的倍数']] : []), ['crash', '回本前回撤'], ['fastMin', '密集检查时长'], ...(legacy ? [['fastCrash', '旧版速战回撤'], ['noPumpMin', '旧版无拉升观察'], ['noPumpX', '旧版观察期目标']] : []), ['drop', '免费币回撤']];
  replace(view.strategy, el('div', { class: 'strategy-content' },
    el('div', { class: 'table-muted' }, strategy.checkedAt ? '最近持仓检查 ' + date(strategy.checkedAt, true) : '等待持仓检查完成'),
    el('div', { class: 'strategy-summary' }, el('div', {}, el('h3', {}, !running ? '监控已停止' : monitor ? '当前仅监控，不执行止盈' : '当前为自动交易模式'), el('p', {}, strategy.needsRestart ? '保存的配置尚未应用，请重启监控。' : '下方对比已保存设置与当前运行参数。'), el('p', {}, '已保存：' + ruleStrategyName(configured) + '；运行中：' + (strategy.effectiveRules ? ruleStrategyName(effective) : '待确认'))), badge(strategy.needsRestart ? '等待重启生效' : !running ? '已停止' : monitor ? '只读监控' : '自动交易', strategy.needsRestart ? 'amber' : !running || monitor ? 'muted' : '')),
    el('div', { class: 'table-wrap' }, el('table', { class: 'strategy-rules-table' }, el('thead', {}, el('tr', {}, ['规则', '已保存配置', '运行中规则'].map((text) => el('th', {}, text)))), el('tbody', {}, rows.map(([key, label]) => el('tr', {}, el('td', {}, label), el('td', { class: 'mono' }, ruleSummary(key, configured[key])), el('td', { class: 'mono' }, ruleSummary(key, effective[key]))))))),
    el('div', { class: 'strategy-scope' }, icon('info'), el('span', {}, '上方规则仅适用于追踪中的 ERC20 代币。NFT 自动卖出与止盈需按钱包、合约和 Token ID 单独配置与确认启用；运行结果以各 NFT 规则状态为准。', el('br'), '免费币止盈：开池 3 分钟后开始采样峰值，持仓估值至少 $0.30 才会触发自动卖出。')),
    strategy.needsRestart && el('div', { class: 'strategy-actions' }, button('重启并应用配置', 'refresh', () => serviceAction('restart'), 'small'), el('a', { class: 'text-link', href: '#config' }, '查看策略配置 →'))));
}
function tokenStrategyState(token, strategy) {
  const address = String(token.addr || token.address || '').toLowerCase(), wallet = String(token.walletAddress || token.only || '').toLowerCase();
  const candidates = (Array.isArray(strategy?.tokens) ? strategy.tokens : []).filter((t) => String(t.addr || '').toLowerCase() === address);
  const item = wallet ? candidates.find((t) => String(t.walletAddress || '').toLowerCase() === wallet) : candidates.length === 1 ? candidates[0] : null;
  const readable = (value) => value == null ? '' : typeof value === 'string' ? value : JSON.stringify(value);
  return el('div', {}, badge(token.hold ? '仅追踪' : token.done ? '已结束' : '追踪中', token.done ? 'muted' : ''),
    item?.reason && el('div', { class: 'token-strategy-reason' }, readable(item.reason)),
    item?.nextTrigger && el('div', { class: 'token-next-trigger' }, '下一条件：' + readable(item.nextTrigger)));
}
function tokenHoldingInfo(token) {
  const walletAddress = String(token.walletAddress || token.only || ''), shortWallet = /^0x[0-9a-f]{40}$/i.test(walletAddress) ? walletAddress.slice(0, 6) + '…' + walletAddress.slice(-4) : walletAddress;
  return el('div', { class: 'token-cell' }, el('div', { class: 'token-avatar' }, String(token.sym || token.symbol || '?').slice(0, 1)),
    el('div', { class: 'erc20-token-info' }, el('div', { class: 'token-name' }, token.sym || token.symbol || '未命名代币'), el('div', { class: 'address' }, token.addr || token.address || ''),
      el('div', { class: 'erc20-token-meta' }, el('span', {}, '钱包：' + (token.walletName || token.wallet || (token.both ? '所有钱包' : '默认钱包'))), shortWallet && el('span', { class: 'mono', title: walletAddress }, shortWallet)),
      el('div', { class: 'erc20-token-meta' }, '成本：' + usd(token.cost))));
}
function renderMarketSync(view, marketSync) {
  if (!view.marketSync) return;
  const sync = marketSync || {};
  replace(view.marketSync, el('div', { class: 'nft-sync-main' }, sync.loading ? el('span', { class: 'spinner' }) : icon('radar'), el('span', {}, sync.loading ? '正在更新市场报价' : sync.updatedAt ? '市场报价已更新' : '等待市场报价更新'), sync.total != null && el('span', { class: 'nft-sync-count' }, `已查询 ${fmt(sync.verified ?? 0)} / ${fmt(sync.total)} 项`)),
    el('div', { class: 'nft-sync-details' }, sync.errors > 0 && badge(`${fmt(sync.errors)} 项更新失败`, 'amber'), sync.updatedAt && el('span', {}, '最近更新 ' + date(sync.updatedAt, true))));
}
function nftHoldingInfo(nft) {
  const walletAddress = String(nft.walletAddress || ''), shortWallet = /^0x[0-9a-f]{40}$/i.test(walletAddress) ? walletAddress.slice(0, 6) + '…' + walletAddress.slice(-4) : walletAddress;
  return el('div', { class: 'nft-holding-info' },
    el('div', { class: 'token-name' }, nft.name || nft.sym || '未命名系列'),
    nft.name && nft.sym && nft.name !== nft.sym && el('div', { class: 'table-muted' }, nft.sym),
    el('div', { class: 'address' }, nft.addr || '—'),
    el('div', { class: 'nft-wallet-info' }, el('span', { class: 'market-label' }, '钱包'), el('span', {}, nft.wallet || '默认钱包'), shortWallet && el('span', { class: 'mono', title: walletAddress }, shortWallet)),
    el('div', { class: 'nft-type-quantity' }, badge(nft.standard === 'ERC721' ? 'ERC-721' : nft.standard === 'ERC1155' ? 'ERC-1155' : '类型待识别', 'muted'), el('div', { class: 'nft-quantity' }, el('span', { class: 'table-muted' }, '数量 '), nftQuantity(nft))),
    nft.standardInferred && el('div', { class: 'table-muted nft-inferred' }, '事件与归属核验'),
    nftStatus(nft));
}
function renderHoldingsData(view, data) {
  view.data = data;
  const tokens = Array.isArray(data.tokens) ? data.tokens : [], trades = Array.isArray(data.trades) ? data.trades : [], nfts = Array.isArray(data.nfts) ? data.nfts : [];
  replace(view.tokenCount, `${tokens.length} 项`);
  replace(view.tokens, tokens.length ? el('div', { class: 'table-wrap' }, el('table', { class: 'erc20-table' }, el('thead', {}, el('tr', {}, ['代币', '持仓估值', '策略状态'].map((h) => el('th', {}, h)))), el('tbody', {}, tokens.map((t) => el('tr', {}, el('td', {}, tokenHoldingInfo(t)), el('td', { class: 'mono' }, usd(t.valueUsd ?? t.value ?? t.last?.v)), el('td', {}, tokenStrategyState(t, data.strategy))))))) : empty('暂无追踪中的 ERC20 代币', '这里只展示监控程序记录的代币。NFT 系列在下方单独列示。', 'portfolio', button('配置代币追踪', 'plus', async () => go('config'), 'small')));
  replace(view.nftCount, `${new Set(nfts.map((nft) => nft.addr).filter(Boolean)).size} 个系列`);
  replace(view.nfts, nfts.length ? el('div', { class: 'table-wrap' }, el('table', { class: 'nft-table' }, el('thead', {}, el('tr', {}, ['NFT 持仓信息', '市场参考报价', '操作'].map((h) => el('th', {}, h)))), el('tbody', {}, nfts.map((nft) => el('tr', {}, el('td', {}, nftHoldingInfo(nft)), el('td', {}, nftMarket(nft)), el('td', {}, nftMarketAction(nft))))))) : empty('暂无已记录的 NFT 系列', '监控程序记录过的 NFT 系列会显示在这里，并通过链上查询核验当前持有数量。', 'portfolio'));
  renderStrategyState(view, data.strategy);
  renderMarketSync(view, data.marketSync);
  const sync = data.nftSync || {}, total = sync.total ?? nfts.length, verified = sync.verified ?? 0, errors = sync.errors ?? 0;
  replace(view.nftSync, el('div', { class: 'nft-sync-main' }, sync.loading ? el('span', { class: 'spinner' }) : icon('shield'), el('span', {}, sync.loading ? '正在链上核验 NFT' : sync.updatedAt ? 'NFT 链上核验已更新' : nfts.length ? 'NFT 等待链上核验' : '等待 NFT 记录'), el('span', { class: 'nft-sync-count' }, `已核验 ${fmt(verified)} / ${fmt(total)} 项`)),
    el('div', { class: 'nft-sync-details' }, errors > 0 && badge(`${fmt(errors)} 项核验失败`, 'amber'), el('span', {}, sync.updatedAt ? '最近核验 ' + date(sync.updatedAt, true) : '尚无核验完成时间')));
  replace(view.tradeCount, `${trades.length} 笔`);
  replace(view.trades, trades.length ? el('div', { class: 'table-wrap' }, el('table', {}, el('thead', {}, el('tr', {}, ['时间', '代币', '钱包', '换回 BNB', '换回估值', '原因'].map((h) => el('th', {}, h)))), el('tbody', {}, trades.slice(0, 50).map((t) => el('tr', {}, el('td', {}, date(t.at, true)), el('td', {}, t.sym || '—'), el('td', {}, t.w || t.wallet || '—'), el('td', { class: 'mono' }, t.bnb ?? '—'), el('td', {}, usd(t.usd)), el('td', { class: 'table-muted' }, t.why || '—')))))) : empty('暂无已记录的卖出', '由本工具完成的卖出会记录在这里。', 'logs'));
  view.hasData = true;
}
async function refreshHoldings({ manual = false } = {}) {
  const view = holdingsView;
  if (state.view !== 'holdings' || !view?.root.isConnected) return;
  if (view.request) {
    if (!manual) return view.request;
    await view.request;
    if (view !== holdingsView || state.view !== 'holdings' || !view.root.isConnected) return;
    return refreshHoldings({ manual: true });
  }
  view.refreshState.textContent = '正在刷新持仓…';
  view.root.setAttribute('aria-busy', 'true');
  view.request = (async () => {
    try {
      const data = await api('/api/holdings' + (manual ? '?refresh=1' : ''));
      if (view !== holdingsView || state.view !== 'holdings' || !view.root.isConnected) return;
      if (data.nftTrading) {
        nftTradingData = data.nftTrading; nftTradingError = null;
        for (const manager of nftManagerViews) { if (!manager.root.isConnected) nftManagerViews.delete(manager); else updateNftManager(manager); }
      } else await loadNftTrading({ quiet: true });
      if (view !== holdingsView || state.view !== 'holdings' || !view.root.isConnected) return;
      renderHoldingsData(view, data);
      replace(view.error);
      view.refreshState.textContent = '每 15 秒自动刷新 · 最近读取 ' + date(Date.now());
      if (manual) toast(data.nftSync?.loading ? '持仓已刷新，NFT 链上核验正在后台进行' : '持仓已刷新');
    } catch (e) {
      if (view !== holdingsView || state.view !== 'holdings' || !view.root.isConnected) return;
      replace(view.error, el('div', { class: 'holdings-error' }, el('div', {}, el('strong', {}, '持仓读取失败'), el('p', {}, e.message), view.hasData && el('p', {}, '已保留最近一次读取的数据。')), button('重新加载', 'refresh', () => refreshHoldings({ manual: true }), 'small')));
      view.refreshState.textContent = '刷新失败 · 15 秒后自动重试';
      if (!view.hasData) {
        for (const target of [view.strategy, view.tokens, view.nfts, view.trades]) replace(target, empty('暂时无法读取数据', '请使用上方重新加载按钮重试。', 'info'));
        replace(view.nftSync, el('span', { class: 'muted' }, '暂时无法获取 NFT 核验进度'));
        replace(view.marketSync, el('span', { class: 'muted' }, '暂时无法获取市场报价进度'));
      }
    } finally {
      view.request = null;
      view.root.setAttribute('aria-busy', 'false');
    }
  })();
  return view.request;
}
async function refreshWalletBalances(view = holdingsView) {
  if (state.view !== 'holdings' || !view?.root.isConnected) return;
  const walletIndex = Number(view.walletSelect.value), generation = ++view.balanceGeneration;
  const current = () => view === holdingsView && state.view === 'holdings' && view.root.isConnected && generation === view.balanceGeneration;
  replace(view.balanceState, el('span', { class: 'spinner' }), '正在读取钱包资产…');
  if (view.balanceWallet !== walletIndex) replace(view.balances, holdingsLoading('正在读取当前钱包资产…'));
  view.balanceWallet = walletIndex;
  try {
    let request = view.balanceRequests.get(walletIndex);
    if (!request) {
      request = api('/api/wallet/balance?wallet=' + walletIndex);
      view.balanceRequests.set(walletIndex, request);
      request.finally(() => { if (view.balanceRequests.get(walletIndex) === request) view.balanceRequests.delete(walletIndex); }).catch(() => {});
    }
    const result = await request;
    if (!current()) return;
    const rows = Array.isArray(result.balances) ? result.balances : [];
    replace(view.balances, rows.length ? el('div', { class: 'table-wrap' }, el('table', {}, el('thead', {}, el('tr', {}, ['资产 / 合约', '余额', '估值'].map((h) => el('th', {}, h)))), el('tbody', {}, rows.map((b) => el('tr', {}, el('td', {}, el('div', { class: 'token-name' }, b.symbol), el('div', { class: 'address' }, b.address || b.contractAddress || '')), el('td', { class: 'mono' }, b.balance ?? b.amount ?? '—'), el('td', {}, usd(b.value))))))) : empty('没有可显示的资产', '当前钱包没有返回 BSC 代币余额。NFT 在上方单独列示。', 'wallet'));
    replace(view.balanceState, `${rows.length} 项钱包资产 · 最近读取 ${date(Date.now())}`);
  } catch (e) {
    if (!current()) return;
    replace(view.balanceState, el('span', { class: 'nft-error' }, '余额读取失败'));
    replace(view.balances, el('div', { class: 'holdings-error holdings-balance-error' }, el('div', {}, el('strong', {}, '暂时无法读取钱包资产'), el('p', {}, e.message)), el('div', { class: 'holdings-error-actions' }, button('重新读取', 'refresh', () => refreshWalletBalances(view), 'small'), button('钱包管理', 'wallet', async () => go('wallets'), 'small'))));
  }
}
async function refreshHoldingsPage() { return Promise.all([refreshHoldings({ manual: true }), refreshWalletBalances()]); }
async function renderHoldings() {
  if (holdingsView?.root.isConnected && state.view === 'holdings') return refreshHoldingsPage();
  const view = { root: el('div', { id: 'holdings-page' }), error: el('div', { role: 'status', 'aria-live': 'polite' }), refreshState: el('span', {}, '正在首次读取持仓…'), strategy: el('div', {}, holdingsLoading('正在读取策略生效状态…')), tokens: el('div', {}, holdingsLoading('正在读取代币持仓…')), nfts: el('div', {}, holdingsLoading('正在读取 NFT 系列…')), nftSync: el('div', { class: 'nft-sync', role: 'status', 'aria-live': 'polite' }), marketSync: el('div', { class: 'nft-sync market-sync', role: 'status', 'aria-live': 'polite' }), trades: el('div', {}, holdingsLoading('正在读取已记录交易…')), tokenCount: badge('—', 'muted'), nftCount: badge('—', 'muted'), tradeCount: badge('—', 'muted'), hasData: false, request: null };
  holdingsView = view;
  const walletSelect = el('select', { id: 'holdings-wallet-select', 'aria-label': '查询余额的钱包' }, (state.config?.wallets?.length ? state.config.wallets : [{ name: '默认钱包' }]).map((w, i) => el('option', { value: i }, w.name || `钱包 ${i + 1}`)));
  const balances = el('div', { id: 'balance-results' }, holdingsLoading('正在读取当前钱包资产…'));
  Object.assign(view, { walletSelect, balances, balanceState: el('div', { class: 'holdings-balance-state', role: 'status', 'aria-live': 'polite' }), balanceGeneration: 0, balanceWallet: null, balanceRequests: new Map() });
  const balanceButton = button('刷新余额', 'refresh', () => refreshWalletBalances(view));
  walletSelect.addEventListener('change', () => refreshWalletBalances(view));
  view.root.append(title('持仓追踪', '代币与 NFT 分开列示，NFT 持有数量按链上结果核验。', [button('刷新持仓', 'refresh', refreshHoldingsPage), button('添加追踪', 'plus', async () => go('config'), 'primary')]), modeBanner(), el('div', { class: 'holdings-update-bar' }, icon('refresh'), view.refreshState), view.error,
    panel('ERC20 止盈策略生效状态', 'shield', view.strategy),
    el('div', { class: 'section-spacer' }, panel('ERC20 代币持仓', 'portfolio', view.tokens, view.tokenCount)),
    el('div', { class: 'section-spacer' }, panel('NFT 持仓', 'portfolio', [view.nftSync, view.marketSync, view.nfts, el('div', { class: 'nft-market-note' }, icon('info'), el('span', {}, '参考地板价和历史成交不代表能立即成交，当前未提供可执行买价。NFT 挂单需在官方市场完成。'))], view.nftCount, '数量按链上核验，市场报价仅供参考；挂单在官方市场完成。')),
    el('div', { class: 'section-spacer' }, panel('钱包资产', 'wallet', [el('div', { class: 'panel-content holdings-balance-controls' }, el('div', { class: 'holdings-balance-selector' }, walletSelect, balanceButton), view.balanceState), balances], null, '钱包资产仅供查看，不会自动加入卖出策略。')),
    el('div', { class: 'section-spacer' }, panel('已记录的卖出', 'logs', view.trades, view.tradeCount)));
  replace(content, view.root);
  refreshWalletBalances(view);
  return refreshHoldings();
}
function renderOperations() {
  const wallets = state.config?.wallets?.length ? state.config.wallets : [{ name: '默认钱包（未配置）' }];
  const form = el('form', { id: 'operation-form', onsubmit: (e) => e.preventDefault() });
  const wallet = el('select', { id: 'operation-wallet', name: 'walletIndex', required: true }, wallets.map((w, i) => el('option', { value: i }, w.name || `钱包 ${i + 1}`)));
  const address = field('目标合约地址', 'to', '', { placeholder: '0x…（完整 BSC 合约地址）', required: true }); $('input', address).pattern = '0x[a-fA-F0-9]{40}';
  const input = el('textarea', { id: 'inputData', name: 'inputData', placeholder: '0x…', rows: 4, required: true, spellcheck: 'false' }, '0x');
  const one = '1'.padStart(64, '0');
  // Function selectors match the monitor's CANDS list; choosing a template only fills calldata.
  const templates = [['手动填写调用数据', ''], ['mint()', '0x1249c58b'], ['freeMint()', '0x5b70ea9f'], ['claim()', '0x4e71d92d'], ['mint(1)', '0xa0712d68' + one], ['freeMint(1)', '0x7c928fe9' + one], ['claim(1)', '0x379607f5' + one], ['publicMint()', '0x26092b83']];
  const template = el('select', { id: 'operation-template', onchange: () => { if (template.value) { input.value = template.value; clearPreview(); } } }, templates.map(([name, value]) => el('option', { value }, name)));
  input.addEventListener('input', () => { template.value = ''; });
  form.append(el('div', { class: 'field' }, el('label', { for: 'operation-wallet' }, '操作钱包'), wallet), el('div', { class: 'section-spacer' }, address), el('div', { class: 'field section-spacer' }, el('label', { for: 'operation-template' }, '常用调用模板'), template, el('p', { class: 'help' }, '仅填入调用数据，能否执行与实际费用以预演结果为准。')), el('div', { class: 'field section-spacer' }, el('label', { for: 'inputData' }, '合约调用数据'), input, el('p', { class: 'help' }, '填写完整的十六进制 calldata；原生 BNB 转入使用 0x。')), el('div', { class: 'section-spacer' }, field('随交易发送', 'value', '0', { type: 'number', min: 0, step: 'any', suffix: 'BNB', required: true, help: '此处单位为 BNB。预演前不会发送链上交易。' })));
  const result = el('div', { class: 'panel-content operation-preview' });
  function clearPreview() { state.preview = null; replace(result, el('div', { class: 'preview-empty' }, el('div', {}, icon('shield'), el('h3', {}, '先预演，再确认'), el('p', {}, '预演结果会展示合约解析、资产变化与风险。核对后才可发送交易。')))); }
  clearPreview();
  form.addEventListener('input', clearPreview);
  const preview = button('预演合约调用', 'shield', async () => {
    if (!form.reportValidity()) return;
    const fd = new FormData(form); const value = String(fd.get('value')).trim(); const calldata = String(fd.get('inputData')).trim();
    if (!/^0x(?:[a-fA-F0-9]{2})*$/.test(calldata)) { toast('调用数据必须为完整的十六进制字节，以 0x 开头。', true); return; }
    const data = await api('/api/contract/preview', { method: 'POST', body: { walletIndex: Number(wallet.value), to: String(fd.get('to')).trim(), inputData: calldata, value } });
    if (state.view !== 'operations') return;
    state.preview = data;
    const riskItems = data.risks || [], changes = data.authorityChanges || [];
    const exec = button('确认并发送交易', 'arrow', async () => {
      if (state.preview?.id !== data.id) throw new Error('预演已失效，请重新预演。');
      const expires = typeof data.expiresAt === 'number' ? data.expiresAt : Date.parse(data.expiresAt); if (Number.isFinite(expires) && Date.now() >= expires) { clearPreview(); throw new Error('预演已过期，请重新预演。'); }
      const confirmed = await confirmAction('确认发送链上交易', '交易发送后无法撤回。请确认已核对本次预演结果；请自行研究并核实目标合约。', '确认发送', { checkbox: '我已核对合约、金额、资产变化及风险', details: [`合约：${String(fd.get('to')).trim()}`, `金额：${value} BNB`] });
      if (!confirmed) return;
      const tx = await api('/api/contract/execute', { method: 'POST', body: { id: data.id, confirmed: true } }); state.preview = null;
      replace(result, el('div', { class: 'success-note' }, el('strong', {}, '交易已提交'), el('pre', { class: 'json-block', style: 'margin-top:12px' }, JSON.stringify(tx, null, 2)))); toast('交易已提交');
    }, 'primary wide');
    const block = (name, value) => el('div', { class: 'result-block' }, el('h3', {}, name), el('pre', { class: 'json-block' }, JSON.stringify(value ?? {}, null, 2)));
    replace(result, el('div', { class: 'status-line' }, badge('预演完成', '', true), data.expiresAt && el('span', { class: 'muted', style: 'font-size:10px' }, '有效至 ' + date(data.expiresAt))), block('交易解析', data.parsedTx), block('资产变化 / 模拟结果', data.simulationResult), block(`风险信息（${Array.isArray(riskItems) ? riskItems.length : '—'}）`, riskItems), block('权限变化', changes), el('div', { class: 'preview-actions' }, el('p', { class: 'warning-note' }, '请逐项核对资产扣减和授权变化。确认后将通过当前钱包发送交易。'), exec));
  }, 'primary wide');
  form.append(el('div', { class: 'section-spacer' }, preview));
  replace(content, title('手动操作', '对指定 BSC 合约执行预演，并在核对结果后确认发送。'), el('div', { class: 'operations-layout' }, panel('合约调用', 'terminal', el('div', { class: 'panel-content' }, el('div', { class: 'operation-heading' }, el('div', { class: 'step-label' }, '01 / BUILD TRANSACTION'), el('p', {}, '使用已登录且开启开发者模式的钱包。')), form), badge('BSC', 'muted')), panel('预演与确认', 'shield', result, el('span', { class: 'step-label', style: 'margin:0' }, '02 / REVIEW'))));
}
async function loadLogs() { const data = await api('/api/logs?limit=200'); state.logs = Array.isArray(data.lines) ? data.lines : []; return state.logs; }
function renderLogLines() {
  const root = $('#log-lines'); if (!root) return;
  const list = state.logs.map((line, index) => ({ text: typeof line === 'string' ? line : line.text || line.message || JSON.stringify(line), index })).filter((x) => !state.search || x.text.toLowerCase().includes(state.search.toLowerCase()));
  replace(root, list.length ? list.map((line) => el('div', { class: 'log-line' + (/出错|失败|error|illegal parameter/i.test(line.text) ? ' error' : /发现|發現|SUCCESS|已启动/.test(line.text) ? ' highlight' : '') }, el('span', { class: 'log-line-number' }, line.index + 1), el('span', {}, line.text))) : empty(state.search ? '没有匹配的日志' : '暂无运行日志', state.search ? '尝试其他关键词。' : '监控启动后，运行记录会显示在这里。', 'logs'));
  $('#log-count').textContent = `${list.length} / ${state.logs.length} 行`;
}
async function renderLogs() {
  replace(content, title('运行日志', '查看区块扫描、项目发现和钱包操作的本地记录。', [button('刷新日志', 'refresh', async () => { await loadLogs(); renderLogLines(); }), button('导出日志', 'download', async () => { await loadLogs(); const blob = new Blob([state.logs.map((x) => typeof x === 'string' ? x : JSON.stringify(x)).join('\n')], { type: 'text/plain;charset=utf-8' }); const url = URL.createObjectURL(blob); const a = el('a', { href: url, download: 'agentid-sniper-' + new Date().toISOString().slice(0, 10) + '.log' }); a.click(); setTimeout(() => URL.revokeObjectURL(url), 500); })]), panel('监控日志', 'logs', [el('div', { class: 'logs-toolbar' }, el('div', { class: 'log-search' }, icon('search'), el('input', { class: 'input', type: 'search', placeholder: '搜索项目、合约或关键词…', 'aria-label': '搜索日志', value: state.search, oninput: (e) => { state.search = e.target.value; renderLogLines(); } })), el('div', { class: 'log-controls' }, el('label', { class: 'checkbox-row' }, el('input', { type: 'checkbox', checked: state.autoLogs, onchange: (e) => { state.autoLogs = e.target.checked; } }), '自动刷新'), badge('最近 200 行', 'muted'))), el('div', { class: 'log-window', id: 'log-lines' }), el('div', { class: 'logs-footer' }, el('span', {}, 'DATA / WATCH.LOG'), el('span', { id: 'log-count' }, '正在读取…'))]));
  if (state.logs.length) renderLogLines();
  try { await loadLogs(); if (state.view === 'logs') renderLogLines(); } catch (e) { toast(e.message, true); }
}
// Local source updates are managed independently of the scanner and wallet.
const updatePhases = { idle: '等待检查', checking: '检查中', available: '发现新版本', ready: '检查完成', preparing: '准备候选版本', testing: '验证中', 'rolling-back': '正在回退', validating: '验证中', updating: '正在更新', applying: '正在更新', restarting: '正在重启 Web', succeeded: '更新完成', success: '更新完成', failed: '更新失败', blocked: '需要处理', 'rolled-back': '已回退', rolledback: '已回退', conflict: '合并冲突', 'manual-review': '需要手动整合', current: '已是最新版本', disabled: '发行渠道待配置', 'not-released': '暂无正式发行' };
const activeUpdatePhases = new Set(['preparing', 'testing', 'rolling-back', 'validating', 'updating', 'applying', 'restarting']);
let updatesData = null, updatesError = '', updatesRequest = null, updatesView = null;
let updateActionPending = false, updateAwaitingResult = false, updatePollAt = 0;
function updateSnapshot(data = updatesData) {
  const value = data || {}, current = value.current || state.status?.release || {}, latest = value.latest || null;
  const phase = value.phase || value.status || (value.available ? 'available' : 'idle');
  const available = typeof value.available === 'boolean' ? value.available : Boolean(latest?.commit && current.commit && latest.commit !== current.commit && !latest.commit.startsWith(current.commit));
  const logs = Array.isArray(value.progress) ? value.progress : value.logs || (value.progress?.stage ? [value.progress.stage + (value.progress.total ? ` · ${value.progress.completed ?? 0}/${value.progress.total}` : ''), ...(value.progress.conflicts || []).map(file => '冲突：' + file)] : []);
  return { ...value, current, latest, phase, available, active: activeUpdatePhases.has(phase) || value.updating === true || value.busy === true && phase !== 'checking', logs: Array.isArray(logs) ? logs : [], rollback: value.rollback || {} };
}
function updateVersionText(release) {
  if (!release) return '尚未检查';
  return [release.version ? String(release.version).replace(/^([^v])/, 'v$1') : '', release.commit ? String(release.commit).slice(0, 7) : ''].filter(Boolean).join(' · ') || '—';
}
function updateBlockReason(value = updateSnapshot()) {
  if (value.active || updateActionPending) return '正在处理更新，请等待完成。';
  if (value.scannerRunning || state.status?.service?.running) return '请先停止监控，再更新程序。';
  if (value.walletBusy || value.operationBusy || value.canApply === false && value.blockedReason) return value.blockedReason || '请先完成当前钱包或服务操作。';
  return value.blockedReason || '';
}
function rollbackBlockReason(value = updateSnapshot()) {
  if (value.active || updateActionPending) return '正在处理更新，请等待完成。';
  if (value.scannerRunning || state.status?.service?.running) return '请先停止监控，再回退程序。';
  if (value.walletBusy || value.operationBusy) return value.rollbackBlockedReason || '请先完成当前钱包或服务操作。';
  return value.rollbackBlockedReason || (value.canRollback === false ? '当前没有可执行的回退任务。' : '');
}
function renderOverviewUpdates() {
  const value = updateSnapshot();
  return panel('程序更新', 'download', el('div', { class: 'panel-content overview-update-content', id: 'overview-updates' }, overviewUpdatesContent(value)), el('a', { href: '#updates', class: 'text-link' }, '管理 →'));
}
function overviewUpdatesContent(value) {
  return [el('div', { class: 'overview-update-top' }, el('strong', {}, updateVersionText(value.current)), badge(value.active ? updatePhases[value.phase] || '处理中' : value.available ? '有新版本' : updatesData ? '自动检查已开启' : '正在读取', value.available ? 'amber' : 'muted')),
    el('p', {}, value.available ? '最新 ' + updateVersionText(value.latest) : 'Web 运行时每 30 分钟检查，监控停止也可检查。'),
    updatesError && el('p', { class: 'nft-error' }, updatesError)];
}
function paintUpdates() {
  const value = updateSnapshot(), marker = $('#update-count');
  if (marker) { marker.hidden = !value.available; marker.textContent = value.available ? 'NEW' : ''; }
  const overview = $('#overview-updates'); if (overview) replace(overview, overviewUpdatesContent(value));
  const view = updatesView;
  if (!view?.root.isConnected || state.view !== 'updates') return;
  const blocked = updateBlockReason(value), waiting = updateAwaitingResult && !updatesData;
  view.current.textContent = updateVersionText(value.current);
  view.latest.textContent = updateVersionText(value.latest);
  view.lastCheck.textContent = value.checkedAt || value.lastCheckedAt ? date(value.checkedAt || value.lastCheckedAt, true) : '尚未检查';
  view.nextCheck.textContent = value.nextCheckAt ? date(value.nextCheckAt, true) : 'Web 后台每 30 分钟';
  const phaseLabel = value.phase === 'manual-review' && /校验不一致/.test(value.message || value.error || '') ? '上游发布校验待同步' : updatePhases[value.phase] || value.phase;
  replace(view.phase, badge(waiting ? '等待服务恢复' : phaseLabel, ['failed', 'blocked', 'conflict', 'manual-review'].includes(value.phase) ? 'amber' : value.active ? '' : 'muted', value.active), el('span', {}, value.message || (value.active ? '进度由本地后台保存，恢复连接后继续查看。' : value.available ? '新版本已准备检查，点击一键更新后开始合并。' : '自动检查已开启；安装更新需你点击一键更新。')));
  const error = updatesError || value.error || value.lastError;
  replace(view.error, error ? el('div', { class: 'holdings-error', role: 'alert' }, typeof error === 'string' ? error : error.message || '更新检查失败，请重试。') : null);
  view.blocked.textContent = blocked;
  view.blocked.hidden = !blocked;
  const notes = value.latest?.notes || [];
  replace(view.notes, Array.isArray(notes) && notes.length ? el('ul', { class: 'update-notes' }, notes.slice(0, 12).map(note => el('li', {}, String(note)))) : el('p', { class: 'table-muted' }, value.latest ? '上游未附更新摘要。' : '检查后显示上游发布信息。'));
  replace(view.logs, value.logs.length ? value.logs.slice(-14).map(item => el('li', {}, typeof item === 'string' ? item : [item.at && date(item.at), item.message || item.text || item.phase].filter(Boolean).join(' · '))) : el('li', { class: 'table-muted' }, '尚无更新任务。'));
  view.check.disabled = updateActionPending || value.phase === 'checking' || value.active;
  view.apply.disabled = updateActionPending || value.active || value.phase === 'checking' || !value.available || Boolean(blocked) || !value.latest?.commit;
  view.apply.textContent = value.active ? '正在更新…' : '一键更新';
  const hasRollback = typeof value.canRollback === 'boolean' ? value.canRollback : value.rollback.available === true;
  view.rollback.disabled = updateActionPending || value.active || value.phase === 'checking' || !hasRollback || Boolean(rollbackBlockReason(value));
  view.rollback.title = hasRollback ? '回退程序代码，保留当前配置与持仓数据' : '成功更新后才有可回退版本';
  view.rollbackInfo.textContent = hasRollback ? '可回退到 ' + updateVersionText({ version: value.rollback.fromVersion || value.rollback.version, commit: value.rollback.fromCommit || value.rollback.commit }) : '首次成功更新后，可回退到更新前的程序版本。';
}
async function loadUpdates({ quiet = false } = {}) {
  if (updatesRequest) return updatesRequest;
  updatesRequest = (async () => {
    try {
      const data = await api('/api/updates');
      updatesData = data.update || data;
      updatesError = '';
      const value = updateSnapshot();
      if (updateAwaitingResult && ['succeeded', 'success', 'rolled-back', 'rolledback', 'failed', 'blocked', 'conflict', 'manual-review'].includes(value.phase)) {
        updateAwaitingResult = false;
        if (['succeeded', 'success', 'rolled-back', 'rolledback'].includes(value.phase)) {
          await Promise.all([loadConfig(), refreshStatus({ passive: true })]);
          toast(updatePhases[value.phase]);
        }
      }
      return updatesData;
    } catch (error) {
      updatesError = updateAwaitingResult ? 'Web 正在重启或请求结果待确认；页面只查询状态，不重复提交更新。' : error.message;
      if (!quiet && !updateAwaitingResult) toast(updatesError, true);
      return null;
    } finally { updatesRequest = null; updatePollAt = Date.now(); paintUpdates(); }
  })();
  return updatesRequest;
}
function updateButton(label, iconName, callback, style = '') {
  const control = el('button', { type: 'button', class: 'button ' + style }, icon(iconName), label);
  control.addEventListener('click', async () => { if (control.disabled) return; try { await callback(); } catch (error) { toast(error.message, true); } finally { paintUpdates(); } });
  return control;
}
async function checkUpdatesNow() {
  if (updateActionPending || updateSnapshot().active) return;
  updateActionPending = true; paintUpdates();
  try { const result = await api('/api/updates/check', { method: 'POST', body: {}, retried: true }); updatesData = result.update || result; updatesError = ''; }
  finally { updateActionPending = false; await loadUpdates({ quiet: true }); }
}
async function performLocalUpdate(kind) {
  let value = updateSnapshot();
  const blocked = kind === 'rollback' ? rollbackBlockReason(value) : updateBlockReason(value);
  if (blocked) return toast(blocked, true);
  if (kind === 'rollback' && (value.canRollback === false || value.canRollback !== true && value.rollback.available !== true)) return;
  if (kind === 'apply' && (!value.available || !value.latest?.commit)) return;
  const target = kind === 'apply' ? value.latest : value.rollback;
  const accepted = await confirmAction(kind === 'apply' ? '更新本地程序' : '回退程序版本', kind === 'apply' ? `将更新到 ${updateVersionText(target)}。保留 Web、钱包和 NFT 功能；验证完成后重启 Web。` : '将恢复更新前的程序代码，保留当前配置、钱包会话和持仓数据。', kind === 'apply' ? '确认更新' : '确认回退', { details: ['更新前保存程序备份', '合并冲突或验证失败时保留原版本', '完成后监控保持停止，不自动启用交易'] });
  if (!accepted) return;
  value = updateSnapshot();
  const latestBlock = kind === 'rollback' ? rollbackBlockReason(value) : updateBlockReason(value);
  if (latestBlock) return toast(latestBlock, true);
  updateActionPending = true; paintUpdates();
  try {
    // A mutation is sent once; after a lost response only the status endpoint is polled.
    await renewSession();
    updateAwaitingResult = true;
    const response = await api('/api/updates/' + kind, { method: 'POST', body: { ...(kind === 'apply' ? { targetCommit: target.commit } : {}), confirmed: true }, retried: true });
    updatesData = response.update || response;
    updatesError = '';
  } catch (error) {
    if (error.status) { updateAwaitingResult = false; updatesError = error.message; }
    else updatesError = '请求结果尚待确认，页面会查询后台状态；不会重复提交。';
    toast(error.message, true);
  } finally { updateActionPending = false; paintUpdates(); await loadUpdates({ quiet: true }); }
}
async function renderUpdates() {
  if (updatesView?.root.isConnected && state.view === 'updates') { paintUpdates(); return loadUpdates({ quiet: true }); }
  const view = { root: el('div', { id: 'updates-page' }), current: el('strong', { class: 'update-version' }), latest: el('strong', { class: 'update-version' }), lastCheck: el('span'), nextCheck: el('span'), phase: el('div', { class: 'update-phase', role: 'status', 'aria-live': 'polite' }), error: el('div'), blocked: el('div', { class: 'update-blocked', role: 'status' }), notes: el('div'), logs: el('ol', { class: 'update-progress' }), rollbackInfo: el('p', { class: 'help' }) };
  updatesView = view;
  view.check = updateButton('立即检查', 'refresh', checkUpdatesNow);
  view.apply = updateButton('一键更新', 'download', () => performLocalUpdate('apply'), 'primary');
  view.rollback = updateButton('回退上一版本', 'refresh', () => performLocalUpdate('rollback'), 'ghost');
  view.root.append(title('系统更新', '检查 Web 增强版正式发行，保留本地配置与数据。', [view.check]), view.error,
    panel('本地版本', 'download', el('div', { class: 'panel-content' }, view.phase, el('div', { class: 'update-version-grid' }, el('div', {}, el('span', {}, '当前程序'), view.current), el('div', {}, el('span', {}, '最新正式发行'), view.latest)), el('div', { class: 'update-check-times' }, el('span', {}, '最后检查：', view.lastCheck), el('span', {}, '下次检查：', view.nextCheck)), view.blocked, el('div', { class: 'update-actions' }, view.apply, view.rollback), view.rollbackInfo), badge('30 分钟自动检查', 'muted')),
    el('div', { class: 'update-detail-grid section-spacer' }, panel('更新内容', 'logs', el('div', { class: 'panel-content' }, view.notes)), panel('任务进度', 'activity', el('div', { class: 'panel-content' }, view.logs))),
    el('div', { class: 'update-preserve-note' }, icon('shield'), el('div', {}, el('strong', {}, '本地功能保留'), el('p', {}, '保留 Web 控制台、独立钱包会话和 NFT 自动卖出；配置、持仓数据与市场 Key 保存在本机。合并冲突或发行文件校验不通过时停止更新，并显示处理原因。'))));
  replace(content, view.root); paintUpdates();
  await loadUpdates({ quiet: true });
}

async function route() {
  const key = location.hash.replace(/^#/, '') || 'overview'; state.view = views[key] ? key : 'overview';
  document.querySelectorAll('.nav-item').forEach((n) => { const active = n.dataset.view === state.view; n.classList.toggle('active', active); if (active) n.setAttribute('aria-current', 'page'); else n.removeAttribute('aria-current'); });
  $('#breadcrumb-view').textContent = views[state.view]; document.title = views[state.view] + ' · Agent ID'; $('#sidebar').classList.remove('open'); $('#menu-toggle').setAttribute('aria-expanded', 'false');
  if (!state.config || !state.status) return;
  if (state.view === 'overview') renderOverview();
  else if (state.view === 'wallets') { renderWallets(); const rows = state.config.wallets?.length ? state.config.wallets : [{}]; await Promise.all(rows.map((_, i) => refreshWallet(i, { quiet: true }))); if (state.view === 'wallets') renderWallets(); }
  else if (state.view === 'config') renderConfig();
  else if (state.view === 'holdings') await renderHoldings();
  else if (state.view === 'operations') renderOperations();
  else if (state.view === 'logs') await renderLogs();
  else if (state.view === 'updates') await renderUpdates();
}
async function boot() {
  try { const data = await api('/api/bootstrap'); state.csrf = data.csrfToken; await Promise.all([loadConfig(), refreshStatus()]); updateChrome(); await route(); void loadUpdates({ quiet: true }); }
  catch (e) { replace(content, title('本地控制台', '连接监控服务与 Agentic Wallet。'), errorPanel(e, boot)); $('#sidebar-service').textContent = '控制台连接异常'; $('#sidebar-dot').className = 'status-dot error'; }
}
document.querySelectorAll('[data-icon]').forEach((n) => n.append(icon(n.dataset.icon)));
$('#menu-toggle').addEventListener('click', () => { const open = $('#sidebar').classList.toggle('open'); $('#menu-toggle').setAttribute('aria-expanded', String(open)); });
$('#global-refresh').addEventListener('click', () => busy($('#global-refresh'), async () => { await Promise.all([loadConfig(), refreshStatus()]); await route(); if (state.view === 'updates') await loadUpdates({ quiet: true }); toast('数据已刷新'); }));
window.addEventListener('hashchange', route);
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') { $('#sidebar').classList.remove('open'); $('#menu-toggle').setAttribute('aria-expanded', 'false'); } });
document.addEventListener('click', (e) => { if (innerWidth <= 700 && !e.target.closest('.sidebar') && !e.target.closest('#menu-toggle')) { $('#sidebar').classList.remove('open'); $('#menu-toggle').setAttribute('aria-expanded', 'false'); } });
setInterval(async () => { if (document.hidden || !state.csrf) return; try { await refreshStatus({ passive: true }); if (state.view === 'logs' && state.autoLogs) { const scroll = $('#log-lines')?.scrollTop; await loadLogs(); if (state.view === 'logs') { renderLogLines(); if ($('#log-lines')) $('#log-lines').scrollTop = scroll; } } } catch { state.disconnected = true; $('#sidebar-service').textContent = '控制台连接中断'; $('#sidebar-dot').className = 'status-dot warn'; } }, 8000);
setInterval(() => { if (!document.hidden && state.csrf && state.view === 'holdings') refreshHoldings(); }, 15000);
setInterval(() => { if (!document.hidden && state.csrf && state.view === 'config') loadNftTrading({ quiet: true }); }, 15000);
setInterval(() => { if (document.hidden || !state.csrf) return; const value = updateSnapshot(); const interval = updateAwaitingResult || value.active ? 2000 : state.view === 'updates' ? 15000 : 60000; if (Date.now() - updatePollAt >= interval) void loadUpdates({ quiet: true }); }, 2000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && state.csrf && state.view === 'holdings') refreshHoldings(); });
boot();
