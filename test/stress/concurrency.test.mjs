import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { codexEnv } from '../../src/codex.mjs';
import { hookMemoryFile, stateFile, readJson, readState, pauseNow, resume } from '../../src/store.mjs';
import { writeUsage } from '../../src/usage.mjs';
import { fixture, input, processRun, hookAnswer, decision, payloadOK, jsonFiles, timings, MIN } from './helpers.mjs';

for (const provider of ['claude', 'codex']) {
  const command = provider === 'codex' ? 'codex-hook' : 'hook';
  test(`${provider}: 64 parallel PreToolUse processes admit exactly 7 subagents with a burn line`, async t => {
    const s = fixture({ rules: [{ kind: 'agents', at: 7, action: 'pause' }, { kind: 'rate', window: 'five_hour', at: 15, span: 5, action: 'pause' }] });
    const scoped = provider === 'codex' ? codexEnv(s.env) : s.env;
    const run = () => processRun(s, [command], input(s, provider, provider === 'codex' ? 'collaborationspawn_agent' : 'Agent'));
    const results = await Promise.all(Array.from({ length: 64 }, run));
    timings(t, `${provider} fan-out`, results);
    const outs = results.map(r => hookAnswer(r));
    assert.equal(outs.filter(o => decision(o) === 'allow').length, 7, JSON.stringify(outs));
    assert.equal(outs.filter(o => decision(o) === 'deny').length, 57);
    assert.equal(readJson(stateFile(scoped).replace(/\.json$/, '.spawns.json')).stress.n, 7);
    for (const f of jsonFiles(s.home)) assert.doesNotThrow(() => readJson(f), f);
    await payloadOK(s, provider);
    assert.ok(results.every(r => r.ms < 5000), 'every hook completes within 5 seconds');
  });

  test(`${provider}: burn latch and explicit pause/resume survive 64 parallel hooks`, async t => {
    const s = fixture({ pct: 40, rules: [{ kind: 'agents', at: 7, action: 'pause' }, { kind: 'rate', window: 'five_hour', at: 15, span: 5, action: 'pause' }] });
    const scoped = provider === 'codex' ? codexEnv(s.env) : s.env;
    const reset = Math.floor(s.now / 1000) + 4 * 3600;
    writeUsage(scoped, { v: 1, windows: { five_hour: { resetsAt: reset, pts: [[s.now - MIN, 10], [s.now, 40]] } }, weeks: [] });
    const results = await Promise.all(Array.from({ length: 64 }, () => processRun(s, [command], input(s, provider))));
    timings(t, `${provider} burn`, results);
    for (const r of results) assert.equal(decision(hookAnswer(r)), 'deny');
    assert.ok(Object.values(readState(scoped).rateLatch).some(l => l.firedAt), 'burn latch persisted');
    const pending = Array.from({ length: 64 }, () => processRun(s, [command], input(s, provider)));
    pauseNow(scoped, { now: Date.now() });
    const pausedResults = await Promise.all(pending);
    pausedResults.forEach(r => hookAnswer(r));
    assert.ok(readState(scoped).manualPause, 'concurrent hooks cannot lose a manual pause');
    const beforeResume = Array.from({ length: 64 }, () => processRun(s, [command], input(s, provider)));
    resume(scoped, { now: Date.now() });
    const resumedResults = await Promise.all(beforeResume);
    resumedResults.forEach(r => hookAnswer(r));
    assert.equal(readState(scoped).manualPause, null);
    assert.ok(readState(scoped).resumed.length > 0, 'resume controls survived stale hooks');
    assert.equal(decision(hookAnswer(await processRun(s, [command], input(s, provider)))), 'allow', 'no new rise after resume');
    assert.ok(Object.values(readJson(hookMemoryFile(scoped)).rateLatch).every(l => !l.firedAt), 'stale hooks cannot resurrect a released burn');
    for (const f of jsonFiles(s.home)) assert.doesNotThrow(() => readJson(f), f);
    await payloadOK(s, provider, Date.now());
    assert.ok([...results, ...pausedResults, ...resumedResults].every(r => r.ms < 5000));
  });
}

for (const provider of ['claude', 'codex']) test(`${provider}: busy spawn ledger still enforces the exact subagent line`, async () => {
  const s = fixture({ rules: [{ kind: 'agents', at: 2, action: 'pause' }] });
  // A live writer can hold its lock for >800ms. No process inspection needed:
  // our own PID is the documented lock owner, and the test removes the lock.
  const scoped = provider === 'codex' ? codexEnv(s.env) : s.env;
  const lock = stateFile(scoped).replace(/\.json$/, '.spawns.json.controls.lock');
  fs.mkdirSync(new URL('.', `file://${lock}`).pathname, { recursive: true });
  fs.writeFileSync(lock, `${process.pid} stress-writer`);
  try {
    const outs = await Promise.all(Array.from({ length: 50 }, () => processRun(s, [provider === 'codex' ? 'codex-hook' : 'hook'], input(s, provider, provider === 'codex' ? 'spawn_agent' : 'Agent'))));
    for (const r of outs) {
      const out = hookAnswer(r);
      assert.equal(decision(out), 'deny');
      assert.match(out.hookSpecificOutput.permissionDecisionReason, /subagent counter is busy or unavailable/);
      assert.equal(out.continue, undefined, 'only the spawn is refused; the turn continues');
    }
    assert.equal(decision(hookAnswer(await processRun(s, [provider === 'codex' ? 'codex-hook' : 'hook'], input(s, provider)))), 'allow', 'ordinary tools still pass while the ledger is locked');
    await payloadOK(s, provider);
  } finally { fs.rmSync(lock, { force: true }); }
  const outs = await Promise.all(Array.from({ length: 50 }, () => processRun(s, [provider === 'codex' ? 'codex-hook' : 'hook'], input(s, provider, provider === 'codex' ? 'spawn_agent' : 'Agent'))));
  assert.equal(outs.map(r => hookAnswer(r)).filter(o => decision(o) === 'allow').length, 2, 'after unlocking, exactly two slots are available');
});
