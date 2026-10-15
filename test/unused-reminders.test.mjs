import { test } from "node:test";
import assert from "node:assert/strict";
import { unusedReminder, checkUnusedReminders } from "../src/unused-reminders.mjs";
import { setPreference } from "../src/preferences.mjs";
import { recentEvents } from "../src/events.mjs";
import { snapshot } from "../src/providers.mjs";
import { renderCombined } from "../src/menubar.mjs";
import { recordReading } from "../src/store.mjs";
import { main } from "../src/cli.mjs";
import { sandbox, NOW, inHours } from "./helpers.mjs";
const row = (changes = {}) => ({ provider: "claude", ctx: { window: { seven_day: { usedPct: 70, resetsAt: inHours(48), seenAt: NOW, ...changes } } } });

test("reminders honor weekly time, usage and freshness boundaries", () => {
  assert.match(unusedReminder(row(), NOW).body, /Claude has 30%.*2 days/);
  assert.ok(unusedReminder(row({ usedPct: 80, seenAt: NOW - 300_000 }), NOW));
  for (const changes of [{ usedPct: 80.01 }, { usedPct: NaN }, { usedPct: -1 }, { resetsAt: inHours(48) + 1 }, { resetsAt: NOW / 1000 }, { seenAt: NOW - 300_001 }, { seenAt: NOW + 1 }, { seenAt: undefined }]) assert.equal(unusedReminder(row(changes), NOW), null);
  assert.equal(unusedReminder({ ...row(), error: "offline" }, NOW), null);
  assert.equal(unusedReminder({ ctx: { window: {} } }, NOW), null);
});

test("opt-in, persisted deduplication, next week, and providers are independent", () => {
  const { env } = sandbox();
  const sent = [], notify = (...args) => sent.push(args);
  const rows = [row(), { ...row(), provider: "codex" }];
  checkUnusedReminders(env, rows, NOW, notify);
  assert.equal(sent.length, 0);
  setPreference(env, "unused", "on");
  checkUnusedReminders(env, rows, NOW, notify);
  checkUnusedReminders({ ...env }, rows, NOW, notify);
  assert.equal(sent.length, 2);
  assert.equal(sent[0][0], "Use it or lose it 🍐");
  assert.match(sent[1][1], /Codex/);
  assert.equal(recentEvents(env).filter(e => e.kind === "unused").length, 2);
  setPreference(env, "unused", "off");
  setPreference(env, "unused", "on");
  checkUnusedReminders(env, rows, NOW, notify);
  assert.equal(sent.length, 2);
  const later = NOW + 7 * 86400_000;
  checkUnusedReminders(env, [row({ seenAt: later, resetsAt: inHours(48 + 168) })], later, notify);
  assert.equal(sent.length, 3);
});

test("wake inside reminder period qualifies, stale reading retries once fresh; expired windows skip", () => {
  const { env } = sandbox(); setPreference(env, "unused", "on");
  let sent = 0; const notify = () => sent++;
  checkUnusedReminders(env, [row({ seenAt: NOW - 600_000 })], NOW, notify);
  checkUnusedReminders(env, [row({ resetsAt: inHours(4) })], NOW, notify);
  checkUnusedReminders(env, [row({ resetsAt: inHours(-1) })], NOW, notify);
  assert.equal(sent, 1);
});

test("menu shows reminder with weekly bars hidden; CLI toggles and test remain independent", async () => {
  const { env } = sandbox();
  const output = []; const options = { env, now: NOW, out: s => output.push(s) };
  assert.equal(await main(["notify", "unused", "on"], options), 0);
  setPreference(env, "weekly", "off");
  recordReading(env, { seven_day: row().ctx.window.seven_day });
  const snapshots = [await snapshot(env, NOW)];
  const menu = renderCombined({ snapshots, env, now: NOW });
  assert.match(menu, /30% left · resets in 2d/);
  assert.match(menu, /Use it or lose it reminders/);
  assert.doesNotMatch(menu, /^Week /m);
  assert.equal(await main(["menubar", "preference", "unused", "off"], options), 0);
  assert.doesNotMatch(renderCombined({ snapshots, env, now: NOW }), /30% left/);
  let sample;
  assert.equal(await main(["notify", "test"], { ...options, sendNotification: (...args) => { sample = args; } }), 0);
  assert.match(sample[1], /Test notification/);
});


test("menu stream checks reminders on startup without needing an active agent", async () => {
  const { streamMenubar } = await import("../src/menubar-stream.mjs");
  const { env } = sandbox(); setPreference(env, "unused", "on");
  recordReading(env, { seven_day: row().ctx.window.seven_day });
  await streamMenubar({ env, frames: 1, clock: () => NOW, getSnapshots: async () => [await snapshot(env, NOW)], write: () => true });
  assert.equal(recentEvents(env).filter(e => e.kind === "unused").length, 1);
});
