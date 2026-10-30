import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NOW } from '../helpers.mjs';
import { runCodexHook, refreshCodex, cachePath } from '../../src/codex.mjs';
import { savedResets, savedResetsText, parseResetCredits } from '../../src/saved-resets.mjs';
import { writeJsonAtomic } from '../../src/store.mjs';
import { fixture, input, answer, payloadOK } from './helpers.mjs';

const variants = {
  missing: {}, null: null, 'null-bucket': { rateLimits: null },
  'missing-window-fields': { rateLimits: { primary: {} } },
  'null-window': { rateLimits: { primary: null, secondary: null } },
  'string-window': { rateLimits: { primary: 'wrong' } },
  'strings-for-numbers': { rateLimits: { primary: { usedPercent: '40', windowDurationMins: '300', resetsAt: '1790000000' } } },
  'negative-percent': answer(NOW, -100), 'over-100-percent': answer(NOW, 200),
  'huge-percent': answer(NOW, 1e308), 'unknown-fields': { ...answer(NOW), extra: { nested: ['ignored'] } },
  'past-reset': { rateLimits: { primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: NOW / 1000 - 100 } } },
  'huge-reset': { rateLimits: { primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: 1e308 } } },
  'fractional-reset': { rateLimits: { primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: NOW / 1000 + 3600.1234 } } },
};
for (const [name, result] of Object.entries(variants)) test(`Codex answer: ${name} never crashes; native accepts it`, async () => {
  const s = fixture({ now: NOW });
  // Force the malformed answer through the refresh path, including its error policy.
  writeJsonAtomic(cachePath(s.env), { at: 0 });
  const out = await runCodexHook({ env: s.env, now: NOW, input: input(s, 'codex'), reader: async () => result });
  assert.doesNotMatch(JSON.stringify(out), /NaN|Infinity|\n\s+at /);
  const p = await payloadOK(s, 'codex');
  for (const w of p.windows) assert.ok(w.used === null || w.used >= 0 && w.used <= 100);
});

for (const count of [0, 1, 1000]) for (const expires of ['null', 'past', 'future', 'huge']) test(`saved resets: ${count} credits, expiresAt ${expires}`, async () => {
  const s = fixture({ now: NOW });
  const expiresAt = { null: null, past: NOW / 1000 - 1, future: NOW / 1000 + 20 * 365 * 86400, huge: 1e308 }[expires];
  const result = answer(NOW, 40, { rateLimitResetCredits: { availableCount: count, credits: Array.from({ length: count }, (_, i) => ({ id: `c${i}`, status: 'available', expiresAt, title: 'Full reset' })) } });
  assert.doesNotThrow(() => parseResetCredits(result));
  await refreshCodex(s.env, NOW, { force: true, reader: async () => result });
  const saved = savedResets(s.env, NOW);
  assert.ok(saved === null || Number.isSafeInteger(saved.count) && saved.count >= 0);
  assert.doesNotMatch(savedResetsText(saved, NOW) ?? '', /NaN|Infinity|-\d/);
  assert.equal(saved.count, expires === 'past' ? 0 : count);
  await runCodexHook({ env: s.env, now: NOW, input: input(s, 'codex'), reader: async () => result });
  await payloadOK(s, 'codex');
});

for (const raw of [null, {}, { availableCount: null }, { availableCount: '1000' }, { availableCount: -1 }, { availableCount: 1e308 }, { availableCount: 1, credits: [null, 'wrong', 4, {}, { status: 'available', expiresAt: 'soon' }] }]) test(`saved reset answer shape: ${JSON.stringify(raw)}`, async () => {
  const s = fixture({ now: NOW });
  const result = answer(NOW, 40, { rateLimitResetCredits: raw });
  await refreshCodex(s.env, NOW, { force: true, reader: async () => result });
  const saved = savedResets(s.env, NOW);
  assert.ok(saved === null || Number.isSafeInteger(saved.count) && saved.count >= 0);
  await payloadOK(s, 'codex');
});

test('corrupt cached saved reset credit entries cannot crash the snapshot or hook', async () => {
  const s = fixture({ now: NOW, rules: [{ kind: 'window', window: 'five_hour', at: 10, action: 'pause' }] });
  writeJsonAtomic(cachePath(s.env), { at: NOW, savedResets: { count: 1, credits: [null] } });
  await runCodexHook({ env: s.env, now: NOW, input: input(s, 'codex') });
  await payloadOK(s, 'codex');
});
