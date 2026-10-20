// Exercise the README's downgrade commands with an archived 0.3.2 in place of npm's
// global install. No registry, real desktop app, provider or global prefix is touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { sandbox, tempDir } from './helpers.mjs';
import { main } from '../src/cli.mjs';
import { runHook } from '../src/hook.mjs';
import { recordReading, writeRules, pauseNow, hookMemoryFile } from '../src/store.mjs';

const ROOT = new URL('../', import.meta.url).pathname;
function oldRelease() {
  const dir = tempDir('rollback-release-');
  const archive = spawnSync('git', ['archive', 'v0.3.2', 'bin', 'src', 'package.json'], { cwd: ROOT, maxBuffer: 32 * 1024 * 1024 });
  if (archive.status !== 0) return null;
  assert.equal(spawnSync('tar', ['-x', '-C', dir], { input: archive.stdout }).status, 0);
  assert.equal(JSON.parse(fs.readFileSync(dir + '/package.json')).version, '0.3.2');
  return dir;
}

for (const manual of [false, true]) test(`R6 documented downgrade and fresh sessions retain protection (manual=${manual})`, async (t) => {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const block = /## Going back to 0\.3\n[\s\S]*?```sh\n([\s\S]*?)```/.exec(readme);
  assert.ok(block, 'the documented downgrade must include the hook-refresh commands, not just the global npm install');
  const old = oldRelease();
  if (!old) return t.skip('no v0.3.2 tag to compare with');
  const oldCLI = await import(old + '/src/cli.mjs');
  const oldStore = await import(old + '/src/store.mjs'), oldHook = await import(old + '/src/hook.mjs');
  const { env, root } = sandbox(); env.CODEX_HOME = root + '/codex'; env.PERAS_SWIFTBAR_DIR = root + '/swiftbar';
  const now = Date.now();
  const options = { env, now, out: () => {}, quitMenubar: async () => {}, codexReader: async () => { throw Error('No provider calls in rollback test'); } };
  assert.equal(await main(['setup'], options), 0); assert.equal(await main(['codex', 'setup'], options), 0);
  writeRules(env, [{ kind: 'prompt', window: 'seven_day', at: 3, action: 'pause' }]);
  const read = (usedPct) => recordReading(env, { seven_day: { usedPct, resetsAt: Math.floor(now / 1000) + 86400, seenAt: now } });
  if (manual) pauseNow(env, { now });
  read(10); runHook({ env, now, input: { hook_event_name: 'UserPromptSubmit', session_id: 'old-session' } });
  read(14);
  assert.equal(runHook({ env, now, input: { hook_event_name: 'PreToolUse', session_id: 'old-session' } }).hookSpecificOutput.permissionDecision, 'deny');
  const memory = fs.readFileSync(hookMemoryFile(env), 'utf8');
  let active = main, installedOld = false;
  for (const line of block[1].trim().split('\n').map(s => s.trim()).filter(Boolean)) {
    if (line === 'npm install --global peras-cli@0.3.2') { active = oldCLI.main; installedOld = true; continue; }
    assert.ok(line.startsWith('peras '), line);
    assert.equal(await active(line.slice(6).split(/\s+/), options), 0, line);
  }
  assert.ok(installedOld);
  assert.equal(oldStore.readInstall(env).version, '0.3.2', 'old CLI setup actually refreshed the hook runtime');
  if (manual) {
    assert.equal(oldStore.readState(env, now).manualPause.since, now, 'manual control survives downgrade');
    oldStore.resume(env, { now });
  }
  // No automatic export: the old session's baseline is invisible. The documented
  // fresh prompt establishes 0.3's own baseline, without rewriting hook-memory/.
  assert.equal(oldHook.runHook({ env, now, input: { hook_event_name: 'PreToolUse', session_id: 'old-session' } })?.hookSpecificOutput?.permissionDecision ?? null, null);
  oldHook.runHook({ env, now, input: { hook_event_name: 'UserPromptSubmit', session_id: 'fresh-session' } });
  read(18);
  assert.equal(oldHook.runHook({ env, now, input: { hook_event_name: 'PreToolUse', session_id: 'fresh-session' } }).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(fs.readFileSync(hookMemoryFile(env), 'utf8'), memory, 'new-format memory remains intact for an upgrade again');
});
