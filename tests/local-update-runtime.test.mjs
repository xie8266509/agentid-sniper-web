import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWebRestart, scannerIsActive } from '../lib/update-runtime.mjs';

const target = 'b'.repeat(40), previous = 'a'.repeat(40);
function fixture(overrides = {}) {
  const actions = [], states = [], health = [];
  return { actions, states, health, input: { root: '/isolated/project', targetCommit: target, backupId: 'test-only', port: 4317 }, deps: {
    control: async action => actions.push(action), record: state => states.push(state), wait: async () => {}, isScannerActive: async () => false,
    healthy: async commit => { health.push(commit); return true; }, ...overrides,
  } };
}

test('Web update recovery verifies the exact version and never starts the scanner', async () => {
  const f = fixture();
  assert.deepEqual(await runWebRestart(f.input, f.deps), { success: true, rolledBack: false });
  assert.deepEqual(f.actions, ['stop', 'start']);
  assert.deepEqual(f.health, [target]); assert.equal(f.states.at(-1).phase, 'verified');
});

test('failed Web startup restores the source backup and verifies the previous version', async () => {
  const rollbacks = [], f = fixture({ healthy: async commit => commit === previous, rollback: async id => { rollbacks.push(id); return { targetCommit: previous }; } });
  assert.deepEqual(await runWebRestart(f.input, f.deps), { success: false, rolledBack: true });
  assert.deepEqual(rollbacks, ['test-only']); assert.deepEqual(f.actions, ['stop', 'start', 'stop', 'start']);
  assert.equal(f.states.at(-1).phase, 'rolled-back'); assert.equal(f.states.at(-1).targetCommit, previous);
});

test('an active scanner blocks all restart and rollback effects', async () => {
  const f = fixture({ isScannerActive: async () => true });
  await assert.rejects(runWebRestart(f.input, f.deps), /扫描器/);
  assert.deepEqual(f.actions, []); assert.equal(f.states.at(-1).phase, 'failed');
});

test('manual rollback failure cannot recursively request another rollback', async () => {
  let restores = 0; const f = fixture({ healthy: async () => false, rollback: async () => { restores++; } });
  await assert.rejects(runWebRestart({ ...f.input, action: 'rollback' }, f.deps));
  assert.equal(restores, 0); assert.equal(f.states.at(-1).phase, 'failed');
});

test('direct scanner discovery checks Node processes and their project directory', async t => {
  const root = mkdtempSync(join(tmpdir(), 'local-update-runtime-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const scan = async (_file, args) => args.includes('pid=,command=') ? { stdout: '123 node watch.mjs\n124 /bin/zsh -c node watch.mjs\n' } : { stdout: 'p123\nn' + root + '\n' };
  assert.equal(await scannerIsActive(root, false, scan), true);
  assert.equal(await scannerIsActive(root, false, async () => ({ stdout: '124 /bin/zsh -c node ' + join(root, 'watch.mjs') })), false);
});
