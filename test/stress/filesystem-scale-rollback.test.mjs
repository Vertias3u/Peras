import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { codexEnv } from '../../src/codex.mjs';
import { configFile, hookMemoryFile, stateFile, windowFile, installFile, writeInstall, readJson, readState, writeJsonAtomic, writeRules, pauseNow, resume } from '../../src/store.mjs';
import { usageFile, writeUsage } from '../../src/usage.mjs';
import { fixture, input, processRun, hookAnswer, payloadOK, jsonFiles, timings, MIN, decision } from './helpers.mjs';

for (const suffix of ['é ü 名前 space', Array.from({ length: 12 }, (_, i) => `${i}-${'x'.repeat(48)}`).join('/')]) test(`filesystem: ${suffix.startsWith('é') ? 'unicode and spaces in HOME' : 'HOME path over 600 bytes'}`, async () => {
  const s = fixture({ suffix, rules: [{ kind: 'agents', at: 1, action: 'pause' }] });
  for (const provider of ['claude', 'codex']) {
    const args = [provider === 'codex' ? 'codex-hook' : 'hook'];
    const tool = provider === 'codex' ? 'spawn_agent' : 'Agent';
    assert.equal(decision(hookAnswer(await processRun(s, args, input(s, provider, tool)))), 'allow');
    assert.equal(decision(hookAnswer(await processRun(s, args, input(s, provider, tool)))), 'deny');
    for (const command of ['status', 'why', 'doctor']) {
      const r = await processRun(s, provider === 'codex' ? ['codex', command] : [command]);
      assert.ok([0, 1].includes(r.code));
      assert.ok(r.stdout.length);
      assert.doesNotMatch(r.stdout + r.stderr, /NaN|\n\s+at file:/);
    }
    await payloadOK(s, provider);
  }
});

test('filesystem: missing PERAS_HOME and all account directories are recreated safely', async () => {
  const s = fixture();
  fs.rmSync(s.home, { recursive: true });
  fs.rmSync(s.claude, { recursive: true });
  fs.rmSync(s.env.CODEX_HOME, { recursive: true });
  for (const provider of ['claude', 'codex']) {
    hookAnswer(await processRun(s, [provider === 'codex' ? 'codex-hook' : 'hook'], input(s, provider)));
    await payloadOK(s, provider);
  }
  for (const f of jsonFiles(s.home)) assert.doesNotThrow(() => readJson(f), f);
});

test('filesystem: read-only PERAS_HOME still answers every hook and CLI diagnostic', async t => {
  const s = fixture({ rules: [{ kind: 'window', window: 'five_hour', at: 10, action: 'pause' }] });
  const dirs = fs.readdirSync(s.home, { recursive: true }).map(p => path.join(s.home, p));
  try {
    for (const p of dirs) fs.chmodSync(p, fs.statSync(p).isDirectory() ? 0o500 : 0o400);
    fs.chmodSync(s.home, 0o500);
    let enforced = false;
    try { fs.writeFileSync(path.join(s.home, 'probe'), 'x'); } catch (e) { enforced = e.code === 'EACCES' || e.code === 'EPERM'; }
    if (!enforced) { t.skip('filesystem does not enforce read-only mode for this user'); return; }
    for (const provider of ['claude', 'codex']) {
      const r = hookAnswer(await processRun(s, [provider === 'codex' ? 'codex-hook' : 'hook'], input(s, provider)));
      assert.equal(decision(r), 'deny', 'known stop remains enforceable without writes');
      for (const command of ['status', 'why', 'doctor']) {
        const out = await processRun(s, provider === 'codex' ? ['codex', command] : [command]);
        assert.ok([0, 1].includes(out.code));
        assert.ok(out.stdout.length);
        assert.doesNotMatch(out.stdout + out.stderr, /\n\s+at file:/);
      }
      await payloadOK(s, provider);
    }
  } finally {
    fs.chmodSync(s.home, 0o700);
    for (const p of dirs) fs.chmodSync(p, fs.statSync(p).isDirectory() ? 0o700 : 0o600);
  }
});

for (const provider of ['claude', 'codex']) test(`scale ${provider}: 100k usage points, 1000 sessions, 200 rules`, async t => {
  const s = fixture({ pct: 40 });
  const scoped = provider === 'codex' ? codexEnv(s.env) : s.env;
  const reset = Math.floor(s.now / 1000) + 4 * 3600;
  writeUsage(scoped, { v: 1, windows: { five_hour: { resetsAt: reset, pts: Array.from({ length: 100_000 }, (_, i) => [s.now - (100_000 - i) * 100, i / 2500]) } }, weeks: [], blame: null });
  const sessions = Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`s${i}`, { cwd: s.env.HOME, t: s.now, startedAt: s.now - MIN, event: 'PreToolUse' }]));
  writeJsonAtomic(hookMemoryFile(scoped), { sessions, prompts: {}, asked: {}, spawns: {}, notified: [], latched: [], rateLatch: {} });
  writeRules(scoped, Array.from({ length: 200 }, (_, i) => ({ kind: 'rate', window: 'five_hour', at: 80 + i % 20, span: 1 + i, action: 'pause' })));
  const results = [];
  for (let i = 0; i < 5; i++) results.push(await processRun(s, [provider === 'codex' ? 'codex-hook' : 'hook'], input(s, provider)));
  const measured = timings(t, `${provider} scale hooks`, results);
  for (const r of results) hookAnswer(r);
  assert.ok(measured.max < 5000, 'scale hooks stay below 5s');
  await t.test('native snapshot completes within 5 seconds', { todo: 'BUG: sessionVerdict repeatedly scans 100k points for every session and rule; native snapshot takes tens of seconds' }, async t => {
    const start = performance.now();
    await payloadOK(s, provider, Date.now());
    const ms = Math.round(performance.now() - start);
    t.diagnostic(`${provider} scale snapshot milliseconds=${ms}`);
    assert.ok(ms < 5000, `native snapshot took ${ms}ms`);
  });
  assert.ok(Object.keys(readState(scoped).sessions).length <= 100, 'bounded live session memory');
  assert.equal(readJson(usageFile(scoped)).windows.five_hour.pts.length, 100_000, 'benchmark actually retained all 100k input points');
});

test('rollback: real v0.4.1 readers accept every legacy file after v0.5 hook, burn, pause, resume and new rules', async () => {
  const s = fixture({ rules: [{ kind: 'window', window: 'five_hour', at: 10, action: 'pause' }, { kind: 'rate', window: 'five_hour', at: 15, span: 5, action: 'pause' }, { kind: 'agents', at: 2, action: 'pause' }] });
  const legacy = path.join(s.root, 'v041');
  fs.mkdirSync(legacy);
  const archive = execFileSync('git', ['archive', 'v0.4.1', 'src', 'package.json'], { cwd: new URL('../..', import.meta.url), maxBuffer: 20 * 1024 * 1024 });
  execFileSync('tar', ['-x', '-C', legacy], { input: archive });
  const old = await import(pathToFileURL(path.join(legacy, 'src/store.mjs')));
  const oldUsage = await import(pathToFileURL(path.join(legacy, 'src/usage.mjs')));
  const oldProviders = await import(pathToFileURL(path.join(legacy, 'src/providers.mjs')));
  const oldProtocol = await import(pathToFileURL(path.join(legacy, 'src/native-protocol.mjs')));
  for (const provider of ['claude', 'codex']) {
    const scoped = provider === 'codex' ? codexEnv(s.env) : s.env;
    writeInstall(scoped, { version: '0.5.0', command: `"${process.execPath}" "${new URL('../../bin/peras.mjs', import.meta.url).pathname}"` });
    const reset = Math.floor(s.now / 1000) + 4 * 3600;
    writeUsage(scoped, { v: 1, windows: { five_hour: { resetsAt: reset, pts: [[s.now - MIN, 0], [s.now, 20]] } }, weeks: [], blame: null });
    hookAnswer(await processRun(s, [provider === 'codex' ? 'codex-hook' : 'hook'], input(s, provider)));
    pauseNow(scoped, { now: s.now });
    resume(scoped, { now: s.now + 1000 });
    for (const file of [configFile, windowFile, stateFile, hookMemoryFile, installFile]) {
      assert.equal(old[file.name](scoped), file(scoped), `${file.name} path unchanged`);
      assert.ok(fs.existsSync(file(scoped)), file.name);
      const value = JSON.parse(fs.readFileSync(file(scoped), 'utf8'));
      assert.ok(value && typeof value === 'object' && !Array.isArray(value), file.name);
    }
    assert.ok(Array.isArray(old.readRules(scoped)));
    const state = old.readState(scoped, s.now + 1000);
    assert.ok(Array.isArray(state.resumed) && Array.isArray(state.notified));
    assert.equal(state.manualPause, null);
    assert.ok(Object.values(old.readWindow(scoped)).every(w => Number.isFinite(w.usedPct) && Number.isFinite(w.resetsAt) && Number.isFinite(w.seenAt)));
    assert.ok(Array.isArray(oldUsage.readUsage(scoped).weeks));
    const snap = await oldProviders.snapshot(s.env, s.now + 1000, { provider, cwd: null });
    assert.doesNotMatch(oldProviders.statusText(snap, s.now + 1000), /NaN|Infinity/);
    const payload = oldProtocol.providerPayload(snap, { now: s.now + 1000, sign: () => 'rollback' });
    assert.deepEqual(oldProtocol.snapshotProblems(oldProtocol.snapshotMessage({ bridgeInstance: 'rollback', revision: 1, now: s.now + 1000, providers: [payload] })), []);
    await payloadOK(s, provider, s.now + 1000);
  }
  for (const f of jsonFiles(s.home)) assert.doesNotThrow(() => JSON.parse(fs.readFileSync(f, 'utf8')), f);
});
