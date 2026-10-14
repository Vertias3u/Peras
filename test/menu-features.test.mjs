import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { sandbox, NOW, inHours } from "./helpers.mjs";
import { preferences, setPreference, countdown } from "../src/preferences.mjs";
import { recordReading, pauseNow, resume } from "../src/store.mjs";
import { snapshot } from "../src/providers.mjs";
import { renderCombined } from "../src/menubar.mjs";
import { install, settingsPath } from "../src/settings.mjs";
import { hookHealth } from "../src/hook-health.mjs";
import { runHook } from "../src/hook.mjs";
import { runCodexHook, codexEnv, installCodex } from "../src/codex.mjs";
import { checkResets } from "../src/reset-notifications.mjs";
import { runProtectionTest } from "../src/protection-test.mjs";

test("health distinguishes missing setup, no verified hook, execution, and changed config", () => {
  const { env } = sandbox();
  assert.equal(hookHealth(env, "claude", NOW).label, "Setup missing");
  install({ env, command: `"${process.execPath}" "${new URL("../bin/peras.mjs", import.meta.url).pathname}"` });
  assert.equal(hookHealth(env, "claude", NOW).label, "Needs activation");
  runHook({ env, now: NOW, input: { hook_event_name: "PreToolUse" } });
  assert.equal(hookHealth(env, "claude", NOW).label, "Protection active");
  assert.equal(hookHealth(env, "claude", NOW + 16 * 60_000).label, "Not recently verified");
  runProtectionTest(env, NOW + 16 * 60_000);
  const tested = hookHealth(env, "claude", NOW + 16 * 60_000);
  assert.equal(tested.label, "Protection active");
  assert.match(tested.detail, /self-test passed/);
  assert.match(tested.detail, /Last live tool guard/);
  assert.equal(hookHealth(env, "claude", NOW + 32 * 60_000).label, "Not recently verified");
  const file = settingsPath(env), value = JSON.parse(fs.readFileSync(file));
  value.model = "another-model";
  fs.writeFileSync(file, JSON.stringify(value));
  assert.equal(hookHealth(env, "claude", NOW).label, "Needs activation");
  value.disableAllHooks = true;
  fs.writeFileSync(file, JSON.stringify(value));
  assert.equal(hookHealth(env, "claude", NOW).label, "Hooks disabled");
});

test("Codex health requires a verified tool hook and notices disabled features", async () => {
  const { env, root } = sandbox();
  env.CODEX_HOME = `${root}/codex`;
  const command = `"${process.execPath}" "${new URL("../bin/peras.mjs", import.meta.url).pathname}"`;
  installCodex(env, command);
  assert.equal(hookHealth(env, "codex", NOW).label, "Needs trust / activation");
  await runCodexHook({ env, now: NOW, input: { hook_event_name: "PreToolUse" }, reader: async () => ({ rateLimits: {} }) });
  assert.equal(hookHealth(env, "codex", NOW).label, "Protection active");
  fs.writeFileSync(`${env.CODEX_HOME}/config.toml`, "[features]\nhooks = false\n[other]\nx = true\n");
  assert.equal(hookHealth(env, "codex", NOW).label, "Hooks disabled");
});

test("warning alerts can be disabled without losing the hook's warning message", async () => {
  const { env } = sandbox(), notices = [];
  setPreference(env, "warnings", "off");
  recordReading(env, { seven_day: { usedPct: 80, resetsAt: inHours(72), seenAt: NOW } });
  const input = { hook_event_name: "PreToolUse" }, notify = (...args) => notices.push(args);
  const output = runHook({ env, now: NOW, input, notify });
  assert.match(output.systemMessage, /Peras:/);
  const result = await runCodexHook({ env, now: NOW, input, notify, reader: async () => ({ rateLimits: { primary: { usedPercent: 80, resetsAt: inHours(72), windowDurationMins: 10080 } } }) });
  assert.match(result.systemMessage, /Peras:/);
  assert.equal(notices.length, 0);
  assert.throws(() => setPreference(env, "mascots", "maybe"));
});

test("display toggles independently hide weekly rows and stop mascot animation; pause shows its end", async () => {
  const { env } = sandbox();
  recordReading(env, { five_hour: { usedPct: 20, resetsAt: inHours(3), seenAt: NOW }, seven_day: { usedPct: 30, resetsAt: inHours(72), seenAt: NOW } });
  setPreference(env, "weekly", "off");
  let snapshots = [await snapshot(env, NOW)];
  const render = (time) => renderCombined({ snapshots, env, now: NOW, animationTime: time });
  assert.doesNotMatch(render(0), /^Week/m);
  assert.notEqual(render(0), render(2000));
  setPreference(env, "mascots", "off");
  assert.equal(render(0), render(2000));
  assert.equal(preferences(env).weekly, false);
  pauseNow(env, { now: NOW, until: NOW + 3600_000 });
  snapshots = [await snapshot(env, NOW)];
  assert.match(render(0), /Paused until .+ · 1h left/);
  assert.match(render(0), /^Resume$/m);
  assert.equal(countdown(inHours(1) - 18 * 60, NOW), "42m");
  assert.equal(countdown(NOW / 1000 - 1, NOW), "now");
});

test("turning notifications off never disables a pause, for either provider", async () => {
  const { env } = sandbox();
  setPreference(env, "pauses", "off");
  const notices = [], notify = (...args) => notices.push(args);
  const input = { hook_event_name: "PreToolUse" };
  pauseNow(env, { now: NOW });
  assert.equal(runHook({ env, now: NOW, input, notify }).hookSpecificOutput.permissionDecision, "deny");
  const scoped = codexEnv(env);
  pauseNow(scoped, { now: NOW });
  const reader = async () => ({ rateLimits: {} });
  assert.equal((await runCodexHook({ env, now: NOW, input, notify, reader })).hookSpecificOutput.permissionDecision, "deny");
  assert.equal(notices.length, 0);
  resume(scoped, { now: NOW });
  setPreference(env, "pauses", "on");
  pauseNow(scoped, { now: NOW + 1000 });
  await runCodexHook({ env, now: NOW + 1000, input, notify, reader });
  await runCodexHook({ env, now: NOW + 2000, input, notify, reader });
  assert.equal(notices.length, 1, "one notice per distinct pause");
});

test("reset notifications are opt-in and persist deduplication across checks", () => {
  const { env } = sandbox(), notices = [];
  const notify = (...args) => notices.push(args);
  const rows = (at) => [{ provider: "claude", ctx: { window: { five_hour: { resetsAt: at } } } }];
  const at = NOW / 1000 + 60;
  checkResets(env, rows(at), NOW, notify);
  checkResets(env, [], NOW + 60_000, notify);
  assert.equal(notices.length, 0);
  setPreference(env, "resets", "on");
  checkResets(env, rows(at + 60), NOW + 60_000, notify);
  checkResets(env, [], NOW + 120_000, notify);
  checkResets(env, [], NOW + 180_000, notify);
  assert.equal(notices.length, 1);
});
