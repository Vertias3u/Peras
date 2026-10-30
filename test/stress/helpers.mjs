import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
import { sandbox } from '../helpers.mjs';
import { codexEnv, cachePath } from '../../src/codex.mjs';
import { recordReading, writeRules, writeJsonAtomic } from '../../src/store.mjs';
import { writeUsage } from '../../src/usage.mjs';
import { snapshot } from '../../src/providers.mjs';
import { providerPayload, snapshotMessage, snapshotProblems } from '../../src/native-protocol.mjs';

export const MIN = 60_000;
export const bin = new URL('../../bin/peras.mjs', import.meta.url).pathname;
export const decision = r => r?.hookSpecificOutput?.permissionDecision ?? 'allow';
export const answer = (now, pct = 20, extra = {}) => ({ rateLimits: {
  primary: { usedPercent: pct, windowDurationMins: 300, resetsAt: Math.floor(now / 1000) + 4 * 3600 },
  secondary: { usedPercent: 30, windowDurationMins: 10080, resetsAt: Math.floor(now / 1000) + 4 * 86400 },
}, ...extra });

export function fixture({ now = Date.now(), pct = 20, rules = [], suffix = '' } = {}) {
  const s = sandbox();
  if (suffix) {
    s.env.HOME = path.join(s.root, suffix);
    s.env.PERAS_HOME = s.home = path.join(s.env.HOME, '.peras');
    s.env.CLAUDE_CONFIG_DIR = s.claude = path.join(s.env.HOME, '.claude');
  }
  s.env.CODEX_HOME = path.join(s.env.HOME, '.codex');
  s.env.PERAS_SWIFTBAR_DIR = path.join(s.env.HOME, 'swiftbar');
  // No real codex/claude executable, auth, notifications, or network. This stdio-only
  // RPC fixture also handles a cold cache during longer stress bursts.
  const fakebin = path.join(s.root, 'fakebin');
  fs.mkdirSync(fakebin, { recursive: true });
  const fake = path.join(fakebin, 'codex');
  fs.writeFileSync(fake, `#!${process.execPath}\nif(process.argv.includes('--version')){console.log('codex-cli 0.163.0');process.exit(0)}\nconst readline=require('node:readline');readline.createInterface({input:process.stdin}).on('line',l=>{const m=JSON.parse(l);if(m.id)console.log(JSON.stringify({id:m.id,result:m.id===1?{}:JSON.parse(process.env.PERAS_STRESS_ANSWER)}))});\n`, { mode: 0o700 });
  s.env.PATH = fakebin;
  s.env.PERAS_STRESS_ANSWER = JSON.stringify(answer(now, pct));
  fs.mkdirSync(s.env.CODEX_HOME, { recursive: true });
  fs.mkdirSync(s.claude, { recursive: true });
  s.now = now;
  for (const provider of ['claude', 'codex']) {
    const env = provider === 'codex' ? codexEnv(s.env) : s.env;
    const a = answer(now, pct);
    const reading = { five_hour: { usedPct: pct, resetsAt: a.rateLimits.primary.resetsAt, seenAt: now }, seven_day: { usedPct: 30, resetsAt: a.rateLimits.secondary.resetsAt, seenAt: now } };
    writeRules(env, rules);
    recordReading(env, reading, { now });
    writeUsage(env, { v: 1, windows: { five_hour: { resetsAt: reading.five_hour.resetsAt, pts: [[now - MIN, pct], [now, pct]] } }, weeks: [], blame: null });
  }
  writeJsonAtomic(cachePath(s.env), { at: now, reading: {}, savedResets: null });
  return s;
}

export function input(s, provider, tool, session = 'stress') {
  return { hook_event_name: 'PreToolUse', session_id: session, cwd: s.env.HOME, tool_name: tool ?? (provider === 'codex' ? 'exec' : 'Read'), tool_input: {} };
}

export function processRun(s, args, payload, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const start = performance.now();
    const p = spawn(process.execPath, [bin, ...args], { env: s.env });
    let stdout = '', stderr = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; p.kill('SIGKILL'); }, timeoutMs);
    p.on('error', reject);
    p.stdout.on('data', d => stdout += d);
    p.stderr.on('data', d => stderr += d);
    p.stdin.on('error', () => {});
    p.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut, ms: performance.now() - start });
    });
    p.stdin.end(payload === undefined ? '' : JSON.stringify(payload));
  });
}

export function hookAnswer(r, { strict = false } = {}) {
  assert.equal(r.timedOut, false, 'hook timed out');
  assert.doesNotMatch(r.stderr + r.stdout, /\n\s+at (?:async |file:|\w+\s*\()/, 'no stack trace');
  assert.ok(r.code === 0 || (strict && r.code === 2), `hook exit ${r.code}: ${r.stderr}`);
  const out = r.stdout ? JSON.parse(r.stdout) : null;
  if (decision(out) === 'deny') assert.ok(out.hookSpecificOutput.permissionDecisionReason.length > 0);
  if (r.code === 2) assert.match(r.stderr, /strict mode blocks/);
  return out;
}

export async function payloadOK(s, provider = 'claude', now = s.now) {
  const snap = await snapshot(s.env, now, { provider, cwd: null });
  const p = providerPayload(snap, { now, sign: () => 'stress-token' });
  const frame = snapshotMessage({ bridgeInstance: 'stress', revision: 1, now, providers: [p] });
  assert.deepEqual(snapshotProblems(frame), [], JSON.stringify(p));
  // Check the actual JSON wire representation too (Infinity/NaN become null).
  assert.deepEqual(snapshotProblems(JSON.parse(JSON.stringify(frame))), []);
  assert.doesNotMatch(JSON.stringify(p), /NaN|Infinity/);
  return p;
}

export function jsonFiles(root) {
  return fs.existsSync(root) ? fs.readdirSync(root, { recursive: true }).filter(f => f.endsWith('.json')).map(f => path.join(root, f)) : [];
}

export function timings(t, label, results) {
  const ms = results.map(r => r.ms).sort((a, b) => a - b);
  const facts = { n: ms.length, min: Math.round(ms[0]), p50: Math.round(ms[Math.floor(ms.length / 2)]), p95: Math.round(ms[Math.floor(ms.length * .95)]), max: Math.round(ms.at(-1)) };
  t.diagnostic(`${label} milliseconds ${JSON.stringify(facts)}`);
  return facts;
}
