import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { main } from '../../src/cli.mjs';
import { codexEnv, cachePath, refreshStatePath } from '../../src/codex.mjs';
import { configFile, windowFile, stateFile, hookMemoryFile, installFile, dirKey } from '../../src/store.mjs';
import { usageFile } from '../../src/usage.mjs';
import { checkSavedResetReminders } from '../../src/saved-resets.mjs';
import { fixture, input, processRun, hookAnswer, payloadOK, answer } from './helpers.mjs';

const variants = { truncated: '{"x":', empty: '', garbage: 'not JSON', null: 'null', string: '"wrong"', number: '7', array: '[null,1,"x"]', object: '{"windows":{"five_hour":{"resetsAt":99999999999,"pts":[null]}}}' };
// All account/runtime-state JSON readers, including files not ordinarily created
// until the menu, settings, a reminder, or a new v0.5 spawn has run.
const files = {
  rules: s => configFile(s.env), state: s => stateFile(s.env), memory: s => hookMemoryFile(s.env),
  window: s => windowFile(s.env), usage: s => usageFile(s.env), install: s => installFile(s.env),
  'spawn-ledger': s => stateFile(s.env).replace(/\.json$/, '.spawns.json'),
  'codex-rules': s => configFile(codexEnv(s.env)), 'codex-state': s => stateFile(codexEnv(s.env)),
  'codex-memory': s => hookMemoryFile(codexEnv(s.env)), 'codex-window': s => windowFile(codexEnv(s.env)),
  'codex-usage': s => usageFile(codexEnv(s.env)), 'codex-install': s => installFile(codexEnv(s.env)),
  'codex-spawn-ledger': s => stateFile(codexEnv(s.env)).replace(/\.json$/, '.spawns.json'),
  'codex-cache': s => cachePath(s.env), 'codex-refresh': s => refreshStatePath(s.env),
};
for (const name of ['budgets', 'allowances', 'planning', 'reminder-snoozes']) {
  for (const provider of ['claude', 'codex']) files[`${provider}-${name}`] = s => path.join(s.home, name, `${dirKey(provider === 'codex' ? codexEnv(s.env) : s.env)}.json`);
}
for (const name of ['preferences', 'saved-reset-reminders', 'reset-notifications', 'unused-reminders', 'protection-test', 'discovery', 'agent-context', 'menubar', 'monitor-owner', 'settings-session']) files[name] = s => path.join(s.home, `${name}.json`);
for (const provider of ['claude', 'codex']) {
  for (const folder of ['health', 'receipts']) files[`${provider}-${folder}`] = s => path.join(s.home, folder, `${provider}-${dirKey(provider === 'codex' ? codexEnv(s.env) : s.env)}.json`);
}
files['native-launch'] = s => path.join(s.home, 'native', 'launch.json');
files['native-bridge'] = s => path.join(s.home, 'native', 'bridge.json');

for (const [name, file] of Object.entries(files)) test(`corruption: ${name}`, async t => {
  for (const [variant, raw] of Object.entries({ ...variants, nested: null })) await t.test(variant,
    variant === 'nested' && ['window', 'codex-window'].includes(name) ? { todo: 'BUG: liveWindow accepts non-numeric usedPct and CLI status prints NaN percentages and forecasts' }
      : name === 'codex-cache' && variant === 'nested' ? { todo: 'BUG: null cached saved-reset credits crash status/why and the native snapshot' } : {}, async t => {
    const s = fixture();
    const text = variant === 'nested' ? JSON.stringify({
      five_hour: { usedPct: 'broken', resetsAt: s.now / 1000 + 3600, seenAt: s.now },
      windows: { five_hour: { resetsAt: Math.floor(s.now / 1000) + 4 * 3600, pts: [null] } },
      at: s.now, savedResets: { count: 1, credits: [null] },
      command: 7, version: 7, rules: [null],
    }) : raw;
    fs.mkdirSync(path.dirname(file(s)), { recursive: true });
    fs.writeFileSync(file(s), text);
    for (const provider of ['claude', 'codex']) {
      // Hook gets first look at the damage; no preceding reader repairs it.
      hookAnswer(await processRun(s, [provider === 'codex' ? 'codex-hook' : 'hook'], input(s, provider, provider === 'codex' ? 'spawn_agent' : 'Agent')));
      if (provider === 'claude') {
        s.env.PERAS_STRICT = '1';
        hookAnswer(await processRun(s, ['hook'], input(s, provider)), { strict: true });
        delete s.env.PERAS_STRICT;
      }
      for (const command of ['status', 'why', 'doctor']) {
        // Re-inject before each reader so a hook/cache refresh cannot hide damage.
        fs.writeFileSync(file(s), text);
        const lines = [];
        const code = await main(provider === 'codex' ? ['codex', command] : [command], { env: s.env, now: s.now, out: l => lines.push(l), codexReader: async () => answer(s.now), claudeVersion: () => '2.1.295', isTTY: false });
        assert.ok([0, 1].includes(code));
        assert.ok(lines.join('\n').length > 0, `${provider} ${command} prints`);
        assert.doesNotMatch(lines.join('\n'), /\n\s+at (?:file:|async |\w+\s*\()/);
        assert.doesNotMatch(lines.join('\n'), /NaN|Infinity|-\d+ (?:minutes|min|seconds)/);
      }
      fs.writeFileSync(file(s), text);
      await payloadOK(s, provider);
    }
    fs.writeFileSync(file(s), text);
    checkSavedResetReminders(s.env, [{ provider: 'codex', env: codexEnv(s.env) }], s.now, () => {});
  });
});

for (const value of [7, ['not-state'], { manualPause: 'broken' }]) test(`strict Claude hook rejects malformed control-state shape ${JSON.stringify(value)}`, { todo: 'BUG: strict readState validates JSON syntax but accepts malformed controls as an unpaused state' }, async () => {
  const s = fixture();
  fs.mkdirSync(path.dirname(stateFile(s.env)), { recursive: true });
  fs.writeFileSync(stateFile(s.env), JSON.stringify(value));
  s.env.PERAS_STRICT = '1';
  const r = await processRun(s, ['hook'], input(s, 'claude'));
  hookAnswer(r, { strict: true });
  assert.equal(r.code, 2, 'strict mode cannot assume an unreadable pause/resume object means no pause');
  await payloadOK(s);
});
