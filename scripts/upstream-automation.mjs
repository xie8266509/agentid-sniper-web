import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const UPSTREAM = 'nancyc0813-maker/agentid-sniper';
const COMMIT = /^[a-f0-9]{40}$/;
const VERSION = /^(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})$/;
const REPOSITORY = /^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/;
const digest = value => createHash('sha256').update(value).digest('hex');
const fail = text => { throw new Error(text); };
const git = (root, args, options = {}) => execFileSync('git', ['--no-optional-locks', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: root, encoding: 'utf8', timeout: 60000, maxBuffer: 2 << 20, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, ...options });
export function versionGreater(a, b) {
  if (!VERSION.test(a || '') || !VERSION.test(b || '')) fail('Invalid stable version');
  for (let i = 0; i < 3; i++) { const x = BigInt(a.split('.')[i]), y = BigInt(b.split('.')[i]); if (x !== y) return x > y; }
  return false;
}
export function validateTarget({ repository, mainCommit, upstreamCommit, version, baseline }) {
  if (!REPOSITORY.test(repository || '') || !COMMIT.test(mainCommit || '') || !COMMIT.test(upstreamCommit || '') || !VERSION.test(version || '') || baseline?.repository !== UPSTREAM || !COMMIT.test(baseline?.commit || '') || !VERSION.test(baseline?.version || '')) fail('Invalid pinned upstream target');
  if (upstreamCommit !== baseline.commit && versionGreater(baseline.version, version)) fail('Upstream version moved backwards; manual review is required');
  return { changed: upstreamCommit !== baseline.commit && (version === baseline.version || versionGreater(version, baseline.version)), branch: `codex/upstream-${version}-${upstreamCommit.slice(0, 12)}` };
}
export function changedPaths(text) {
  if (text === '') return [];
  if (typeof text !== 'string' || !text.endsWith('\0')) fail('Invalid upstream change list');
  const entries = text.split('\0'); if (entries.at(-1) === '') entries.pop();
  if (entries.length % 2 || entries.length > 128) fail('Invalid or oversized upstream change list');
  return Array.from({ length: entries.length / 2 }, (_, i) => {
    const status = entries[i * 2], path = entries[i * 2 + 1];
    if (!['A', 'M', 'D', 'T'].includes(status) || !path || path.length > 240 || path.startsWith('/') || path.includes('\\') || /[\x00-\x1f\x7f]/.test(path) || path.split('/').some(x => !x || x === '.' || x === '..')) fail('Unsafe upstream path');
    return { status, path };
  });
}
export function changeRisk(paths) {
  const critical = paths.filter(({ path }) => /^(?:watch\.mjs|package(?:-lock)?\.json|config(?:\.|\/)|(?:lib|scripts|\.github)\/)/.test(path));
  return { reviewRequired: true, criticalPaths: critical.map(x => x.path), reason: critical.length ? '涉及交易、钱包、预算、依赖或执行流程；需逐项适配并审核' : '需核对上游改动与增强版兼容性后审核' };
}
export function reviewDocument({ repository, mainCommit, baseline, upstreamCommit, version, paths, merge, patch }) {
  if (Buffer.byteLength(patch) > 1024 * 1024 || patch.includes('\0')) fail('Upstream patch exceeds review limit');
  const fence = '`'.repeat(Math.max(3, ...[...patch.matchAll(/`+/g)].map(x => x[0].length + 1)));
  const risk = changeRisk(paths);
  return `# 上游 v${version} 兼容审核\n\n<!-- upstream-review:${upstreamCommit} -->\n\n- 上游：[${UPSTREAM}@${upstreamCommit}](https://github.com/${UPSTREAM}/commit/${upstreamCommit})\n- 原基线：v${baseline.version} / ${baseline.commit}\n- 增强版候选起点：[${mainCommit}](https://github.com/${repository}/commit/${mainCommit})\n- 状态：**待兼容适配；此 PR 只增加审查资料，未改变交易代码或上游基线。**\n- ${risk.reason}。\n- watch.mjs 三方合入分析：${merge.status}。即使无文本冲突，也不代表策略语义已兼容。\n\n## 完成条件\n\n- [ ] 将上游变更适配到 Web、多钱包、NFT、原子预算及未知交易恢复。\n- [ ] 保留更严格的钱包/预算/模拟保护；不移植单文件覆盖更新器。\n- [ ] 补齐变更回归，核对依赖、许可与敏感信息。\n- [ ] 更新版本、上游基线、CHANGELOG 和发行清单。\n- [ ] 运行完整 CI 并审核；合入 main 后才运行 Publish reviewed release。\n\n自动检查结果只覆盖现有增强版和这份审查资料，不代表已验证上游新增行为。\n\n## 固定提交的完整差异\n\n${fence}diff\n${patch}\n${fence}\n`;
}
export function createGithubApi({ token, fetchImpl = fetch } = {}) {
  return async (path, { method = 'GET', body, allow404 = false } = {}) => {
    if (!/^\/repos\/[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+\//.test(path) || path.includes('..') || /[\r\n]/.test(path)) fail('Unsupported GitHub API path');
    const response = await fetchImpl('https://api.github.com' + path, { method, redirect: 'error', signal: AbortSignal.timeout(20000), headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2026-03-10', 'user-agent': 'agentid-sniper-web-upstream-review', ...(token ? { authorization: 'Bearer ' + token } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (response.status === 404 && allow404) return null;
    const text = await response.text(); if (text.length > 2 * 1024 * 1024) fail('Oversized GitHub response');
    if (!response.ok) fail(`GitHub API failed (${response.status})`);
    try { return JSON.parse(text); } catch { fail('Invalid GitHub response'); }
  };
}
export function mergeAnalysis(root, baseline, target) {
  const temporary = mkdtempSync(join(tmpdir(), 'upstream-merge-review-'));
  try {
    for (const [name, ref] of [['local', 'HEAD'], ['base', baseline], ['next', target]]) writeFileSync(join(temporary, name), git(root, ['show', ref + ':watch.mjs']), { mode: 0o600 });
    const result = spawnSync('git', ['--no-optional-locks', '-c', 'core.hooksPath=/dev/null', 'merge-file', '-p', '--diff3', join(temporary, 'local'), join(temporary, 'base'), join(temporary, 'next')], { encoding: 'utf8', timeout: 30000, maxBuffer: 2 << 20 });
    if (result.error || result.signal || !Number.isInteger(result.status) || result.status < 0 || result.status > 127) fail('Unable to analyze three-way merge');
    return { status: result.status === 0 ? '无文本冲突，仍需语义审核' : '存在冲突，需人工适配', clean: result.status === 0, mergedHash: digest(result.stdout || '') };
  } catch { return { status: '无法形成完整三方分析，需人工适配', clean: false }; }
  finally { rmSync(temporary, { recursive: true, force: true }); }
}
export async function prepareUpstreamReview({ root, repository, api, targetCommit, runGit = git, analyzeMerge = mergeAnalysis } = {}) {
  root = resolve(root);
  const readGit = (args, options) => runGit(root, args, options);
  const config = JSON.parse(readFileSync(join(root, 'release-config.json'), 'utf8'));
  if (!REPOSITORY.test(repository || '') || config.repository !== repository || config.channel !== 'stable' || config.upstream?.repository !== UPSTREAM) fail('Workflow repository does not match release channel');
  const main = await api(`/repos/${repository}/git/ref/heads/main`), mainCommit = main?.object?.sha;
  if (!COMMIT.test(mainCommit || '') || readGit(['rev-parse', 'HEAD']).trim() !== mainCommit) fail('Review must start at the current main commit');
  const latest = targetCommit ? { sha: targetCommit } : await api(`/repos/${UPSTREAM}/commits/main`);
  if (!COMMIT.test(latest?.sha || '')) fail('Invalid upstream commit');
  readGit(['fetch', '--no-tags', '--no-recurse-submodules', 'https://github.com/' + UPSTREAM + '.git', latest.sha, config.upstream.commit]);
  const next = JSON.parse(readGit(['show', latest.sha + ':version.json']));
  const target = validateTarget({ repository, mainCommit, upstreamCommit: latest.sha, version: next.version, baseline: config.upstream });
  if (!target.changed) return { changed: false, version: next.version, upstreamCommit: latest.sha };
  if (!/^[a-f0-9]{64}$/.test(next.sha256 || '') || digest(readGit(['show', latest.sha + ':watch.mjs'], { encoding: 'buffer' })) !== next.sha256) fail('Upstream scanner hash does not match version metadata');
  readGit(['merge-base', '--is-ancestor', config.upstream.commit, latest.sha]);
  const paths = changedPaths(readGit(['diff', '--name-status', '--no-renames', '-z', config.upstream.commit, latest.sha]));
  const patch = readGit(['diff', '--no-ext-diff', '--no-textconv', '--no-renames', config.upstream.commit, latest.sha]);
  const merge = analyzeMerge(root, config.upstream.commit, latest.sha);
  const doc = reviewDocument({ repository, mainCommit, baseline: config.upstream, upstreamCommit: latest.sha, version: next.version, paths, merge, patch });
  const path = `docs/upstream-reviews/v${next.version}-${latest.sha.slice(0, 12)}.md`;
  const manifest = JSON.parse(readFileSync(join(root, 'release.json'), 'utf8'));
  if (manifest.upstreamCommit !== config.upstream.commit) fail('Local release baseline is inconsistent');
  manifest.files[path] = digest(doc); manifest.files = Object.fromEntries(Object.entries(manifest.files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  return { changed: true, repository, mainCommit, upstreamCommit: latest.sha, version: next.version, branch: target.branch, path, doc, manifest: JSON.stringify(manifest, null, 2) + '\n', paths, merge, risk: changeRisk(paths) };
}
export async function submitUpstreamReview(plan, { api } = {}) {
  if (!plan.changed) return { changed: false };
  const target = validateTarget({ repository: plan.repository, mainCommit: plan.mainCommit, upstreamCommit: plan.upstreamCommit, version: plan.version, baseline: { repository: UPSTREAM, commit: plan.mainCommit, version: '0.0.0' } });
  if (plan.branch !== target.branch) fail('Invalid review branch');
  if (plan.path !== `docs/upstream-reviews/v${plan.version}-${plan.upstreamCommit.slice(0, 12)}.md` || !plan.doc.includes(`<!-- upstream-review:${plan.upstreamCommit} -->`)) fail('Invalid review bundle');
  const prefix = `/repos/${plan.repository}`;
  const pulls = await api(`${prefix}/pulls?state=all&head=${encodeURIComponent(plan.repository.split('/')[0] + ':' + plan.branch)}&per_page=100`);
  const existing = pulls.find(pr => pr.head?.ref === plan.branch && pr.head?.repo?.full_name === plan.repository);
  if (existing) return { changed: false, deduplicated: true, pull: existing.html_url };
  const current = await api(`${prefix}/git/ref/heads/main`); if (current.object?.sha !== plan.mainCommit) fail('Main advanced; retry from its current commit');
  let branch = await api(`${prefix}/git/ref/heads/${encodeURIComponent(plan.branch)}`, { allow404: true });
  if (branch) {
    const file = await api(`${prefix}/contents/${plan.path}?ref=${encodeURIComponent(plan.branch)}`);
    if (file.encoding !== 'base64' || !Buffer.from(file.content, 'base64').toString().includes(`<!-- upstream-review:${plan.upstreamCommit} -->`)) fail('Existing branch is not this review; no branch was overwritten');
  } else {
    const base = await api(`${prefix}/git/commits/${plan.mainCommit}`);
    const tree = await api(`${prefix}/git/trees`, { method: 'POST', body: { base_tree: base.tree.sha, tree: [{ path: plan.path, mode: '100644', type: 'blob', content: plan.doc }, { path: 'release.json', mode: '100644', type: 'blob', content: plan.manifest }] } });
    const commit = await api(`${prefix}/git/commits`, { method: 'POST', body: { message: `Review upstream v${plan.version} (${plan.upstreamCommit.slice(0, 12)})`, tree: tree.sha, parents: [plan.mainCommit] } });
    if (!COMMIT.test(commit.sha || '')) fail('Invalid review commit');
    const lease = await api(`${prefix}/git/ref/heads/main`); if (lease.object?.sha !== plan.mainCommit) fail('Main advanced; review branch was not created');
    branch = await api(`${prefix}/git/refs`, { method: 'POST', body: { ref: 'refs/heads/' + plan.branch, sha: commit.sha } });
  }
  const body = `检测到上游 **v${plan.version}**：https://github.com/${UPSTREAM}/commit/${plan.upstreamCommit}\n\n本 PR 只提交固定差异与兼容审核清单；未改写扫描器、钱包、NFT 或上游基线。${plan.risk.reason}。三方分析：${plan.merge.status}。\n\n完整差异与待办：[${plan.path}](../blob/${plan.branch}/${plan.path})。同工作流的回归只验证当前增强版及审查资料，不能视作新增行为已适配。完成适配、补测试与审核后合入 main，再手动运行 Publish reviewed release。\n\n<!-- upstream-review:${plan.upstreamCommit} -->`;
  const pull = await api(`${prefix}/pulls`, { method: 'POST', body: { title: `适配上游 v${plan.version} · ${plan.upstreamCommit.slice(0, 12)}`, head: plan.branch, base: 'main', body, draft: true, maintainer_can_modify: true } });
  return { changed: true, branch: plan.branch, commit: branch.object?.sha, pull: pull.html_url };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  (async () => {
    const mode = process.argv[2] || '--dry-run'; if (!['--dry-run', '--submit'].includes(mode)) fail('Use --dry-run or --submit');
    const repository = process.env.GITHUB_REPOSITORY, api = createGithubApi({ token: process.env.GH_TOKEN });
    const plan = await prepareUpstreamReview({ root: process.cwd(), repository, api });
    const result = mode === '--submit' ? await submitUpstreamReview(plan, { api }) : { changed: plan.changed, version: plan.version, upstreamCommit: plan.upstreamCommit, branch: plan.branch, paths: plan.paths, merge: plan.merge, reviewRequired: true };
    if (process.env.GITHUB_OUTPUT) {
      const { appendFileSync } = await import('node:fs');
      appendFileSync(process.env.GITHUB_OUTPUT, `created=${result.changed === true}\ncommit=${result.commit || ''}\n`);
    }
    console.log(JSON.stringify(result, null, 2));
  })().catch(error => { console.error(error.message); process.exitCode = 1; });
}
