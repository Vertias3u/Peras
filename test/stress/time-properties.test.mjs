import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NOW } from '../helpers.mjs';
import { evaluate, windowBurn, emptyAt, ruleId } from '../../src/rules.mjs';
import { emptyIn } from '../../src/window.mjs';
import { recordReading, readWindow, writeJsonAtomic } from '../../src/store.mjs';
import { writeUsage, trackReading, readUsage } from '../../src/usage.mjs';
import { runHook } from '../../src/hook.mjs';
import { cachePath, runCodexHook } from '../../src/codex.mjs';
import { savedResets, savedResetsText, checkSavedResetReminders } from '../../src/saved-resets.mjs';
import { statusText, whyText } from '../../src/providers.mjs';
import { snapshot } from '../../src/providers.mjs';
import { fixture, input, payloadOK, MIN, decision, answer } from './helpers.mjs';

const SEED = 0x5eed0500;
function prng(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const rule = { kind: 'rate', window: 'five_hour', at: 15, span: 5, action: 'pause' };

test('seeded properties: below-line rise never pauses; resume with no new rise never re-pauses; emptyAt stays inside window', t => {
  t.diagnostic(`PRNG seed=${SEED} (0x${SEED.toString(16)}), 4000 cases`);
  const random = prng(SEED);
  for (let i = 0; i < 4000; i++) {
    const now = NOW + Math.floor(random() * 86400_000), resetsAt = (now + (30 + random() * 240) * MIN) / 1000;
    const base = random() * 30, rise = random() * (99 - base), usedPct = base + rise;
    const span = 1 + Math.floor(random() * 30), at = 1 + Math.floor(random() * 80);
    const r = { ...rule, span, at }, w = { usedPct, resetsAt, seenAt: now };
    const history = { five_hour: [[now - span * MIN, base], [now, usedPct]] };
    const out = evaluate({ rules: [r], window: { five_hour: w }, history, now });
    if (rise < at) assert.equal(out.action, 'none', `case ${i}`);
    if (out.action === 'pause') {
      assert.ok(out.hit.rise >= at);
      const resumed = evaluate({ rules: [r], window: { five_hour: w }, history, now: now + 1000, rateLatch: out.rateLatch, resumed: [{ key: out.hit.key }] });
      const later = evaluate({ rules: [r], window: { five_hour: w }, history, now: now + 2000, rateLatch: resumed.rateLatch });
      assert.equal(resumed.action, 'none');
      assert.equal(later.action, 'none', `case ${i}: resumed burst`);
    }
    const e = emptyAt(w, rise, now - span * MIN, now, now);
    assert.ok(e === null || Number.isFinite(e) && e > now && e < resetsAt * 1000, `case ${i}: ${e}`);
    if (e !== null) assert.doesNotMatch(emptyIn(e, now, { long: true }), /NaN|-\d/);
  }
});

test('seeded property: the same readings in any arrival order have the same burn verdict', t => {
  t.diagnostic(`PRNG seed=${SEED} (0x${SEED.toString(16)}), 1000 permutations`);
  const random = prng(SEED);
  const w = { usedPct: 40, resetsAt: NOW / 1000 + 4 * 3600 };
  const sorted = [[NOW - 4 * MIN, 10], [NOW - 3 * MIN, 20], [NOW - MIN, 40]];
  const expected = windowBurn('five_hour', w, sorted, NOW, 5).burst;
  for (let i = 0; i < 1000; i++) {
    const points = sorted.map(p => [...p]);
    for (let j = points.length - 1; j > 0; j--) { const k = Math.floor(random() * (j + 1)); [points[j], points[k]] = [points[k], points[j]]; }
    assert.deepEqual(windowBurn('five_hour', w, points, NOW, 5).burst, expected, JSON.stringify(points));
  }
});

for (const delta of [-3600_000, -MIN, 0, MIN, 3600_000, 5 * 3600_000]) test(`clock jump ${delta / MIN} minutes: text, expiry and native payload stay sane`, async () => {
  const s = fixture({ now: NOW, pct: 40, rules: [rule] }), now = NOW + delta;
  const resetsAt = NOW / 1000 + 4 * 3600;
  writeUsage(s.env, { v: 1, windows: { five_hour: { resetsAt, pts: [[NOW - 2 * MIN, 10], [NOW - MIN, 20], [NOW, 40], [NOW + MIN, 50]] } }, weeks: [] });
  writeJsonAtomic(cachePath(s.env), { at: NOW, savedResets: { count: 2, credits: [{ id: 'past', expiresAt: NOW / 1000 - 10 }, { id: 'future', expiresAt: NOW / 1000 + 1800 }] } });
  const snaps = [];
  for (const provider of ['claude', 'codex']) {
    const snap = await snapshot(s.env, now, { provider, cwd: null });
    assert.doesNotMatch(statusText(snap, now) + whyText(snap, now), /NaN|Infinity|-\d+ (?:minutes|min|seconds)/);
    const p = await payloadOK(s, provider, now);
    for (const b of p.burn) assert.ok(b.emptyAtMs == null || b.emptyAtMs > now && b.emptyAtMs < resetsAt * 1000);
    snaps.push(snap);
  }
  const saved = savedResets(s.env, now);
  assert.ok(saved === null || Number.isSafeInteger(saved.count) && saved.count >= 0);
  assert.doesNotMatch(savedResetsText(saved, now) ?? '', /NaN|-\d+/);
  const notes = [];
  checkSavedResetReminders(s.env, snaps, now, (...args) => notes.push(args));
  checkSavedResetReminders(s.env, snaps, now, (...args) => notes.push(args));
  assert.ok(notes.length <= 2, 'at most one reminder per unexpired credit');
});

test('late lower reading cannot overwrite a newer reading and bypass a pause', { todo: 'BUG: recordReading overwrites newer usage with an older lower sample, bypassing a pause' }, async () => {
  const s = fixture({ now: NOW, pct: 80, rules: [{ kind: 'window', window: 'five_hour', at: 70, action: 'pause' }] });
  recordReading(s.env, { five_hour: { usedPct: 20, resetsAt: NOW / 1000 + 4 * 3600, seenAt: NOW - MIN } }, { now: NOW });
  assert.equal(decision(runHook({ env: s.env, input: input(s, 'claude'), now: NOW })), 'deny');
  assert.equal(readWindow(s.env).five_hour.usedPct, 80);
  await payloadOK(s);
});

test('a reset mid-burst clears the old latch and does not count old-window history', async () => {
  const s = fixture({ now: NOW, pct: 40, rules: [rule] });
  const old = { usedPct: 40, resetsAt: NOW / 1000 + 1, seenAt: NOW };
  const fired = evaluate({ rules: [rule], window: { five_hour: old }, history: { five_hour: [[NOW - MIN, 10], [NOW, 40]] }, now: NOW });
  assert.equal(fired.action, 'pause');
  const now = NOW + 2000, fresh = { usedPct: 2, resetsAt: now / 1000 + 5 * 3600, seenAt: now };
  recordReading(s.env, { five_hour: fresh }, { now });
  const tracked = trackReading(readUsage(s.env), { five_hour: fresh }, { now });
  writeUsage(s.env, tracked.usage);
  const out = evaluate({ rules: [rule], window: { five_hour: fresh }, history: { five_hour: tracked.usage.windows.five_hour.pts }, rateLatch: fired.rateLatch, now });
  assert.equal(out.action, 'none');
  assert.equal(Object.hasOwn(out.rateLatch, `${ruleId(rule)}@${old.resetsAt}`), false);
  await payloadOK(s, 'claude', now);
});

test('emptyAt cannot round a tiny remaining allowance down to now', () => {
  const e = emptyAt({ usedPct: 99.999999, resetsAt: NOW / 1000 + 3600 }, 50, NOW - MIN, NOW, NOW);
  assert.ok(e === null || e > NOW);
});

test('a future-dated Codex cache cannot hide current usage after the clock moves backwards', { todo: 'BUG: negative cache age is treated as fresh, hiding current usage until the clock catches up' }, async () => {
  const s = fixture({ now: NOW, pct: 20, rules: [{ kind: 'window', window: 'five_hour', at: 70, action: 'pause' }] });
  writeJsonAtomic(cachePath(s.env), { at: NOW + 3600_000, reading: {} });
  let reads = 0;
  const out = await runCodexHook({ env: s.env, now: NOW, input: input(s, 'codex'), reader: async () => { reads++; return answer(NOW, 80); } });
  assert.equal(decision(out), 'deny');
  assert.equal(reads, 1, 'future cache timestamp must cause a refresh');
  await payloadOK(s, 'codex');
});
