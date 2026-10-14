import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { sandbox, NOW, inHours } from "./helpers.mjs";
import { pauseNow, resume, readState, recordReading } from "../src/store.mjs";
import { codexEnv } from "../src/codex.mjs";
import { runProtectionTest, readProtectionTest } from "../src/protection-test.mjs";
import { recordEvent, recentEvents } from "../src/events.mjs";
import { runHook } from "../src/hook.mjs";
import { checkResets } from "../src/reset-notifications.mjs";
import { setPreference } from "../src/preferences.mjs";
import { writeStatusPage } from "../src/status-page.mjs";

test("self-test runs real hook entrypoints while preserving both working agents' pause state", () => {
  const { env } = sandbox(), scoped = codexEnv(env);
  pauseNow(env, { now: NOW });
  pauseNow(scoped, { now: NOW, until: NOW + 3600_000 });
  const before = [readState(env, NOW), readState(scoped, NOW)];
  const result = runProtectionTest(env, NOW);
  assert.equal(result.passed, true, JSON.stringify(result));
  assert.deepEqual(result.providers.map(row => row.passed), [true, true]);
  assert.deepEqual([readState(env, NOW), readState(scoped, NOW)], before);
  assert.deepEqual(readProtectionTest(env), result);
  assert.equal(recentEvents(env).filter(row => row.kind === "test").length, 1);
});

test("history records a pause and resume once, and warnings even with alerts disabled", () => {
  const { env } = sandbox();
  setPreference(env, "warnings", "off");
  pauseNow(env, { now: NOW });
  runHook({ env, now: NOW, input: { hook_event_name: "PreToolUse" } });
  resume(env, { now: NOW + 1 });
  recordReading(env, { seven_day: { usedPct: 80, resetsAt: inHours(72), seenAt: NOW } });
  for (let i = 0; i < 2; i++) runHook({ env, now: NOW + 2, input: { hook_event_name: "PreToolUse" } });
  const events = recentEvents(env);
  assert.equal(events.filter(row => row.kind === "pause").length, 1);
  assert.equal(events.filter(row => row.kind === "resume").length, 1);
  assert.ok(events.some(row => row.kind === "warning"));
  assert.equal(new Set(events.filter(row => row.kind === "warning").map(row => row.message)).size, events.filter(row => row.kind === "warning").length);
});

test("history tolerates malformed lines, caps displayed entries, and escapes dashboard text", () => {
  const { env, home } = sandbox();
  for (let i = 0; i < 60; i++) recordEvent(env, { kind: "warning", message: `entry ${i}`, at: NOW + i });
  fs.appendFileSync(path.join(home, "events.jsonl"), "broken line\n");
  recordEvent(env, { kind: "pause", provider: "codex", message: '<script>alert("bad")</script>', at: NOW + 100 });
  assert.equal(recentEvents(env).length, 50);
  assert.equal(recentEvents(env)[0].provider, "codex");
  const page = writeStatusPage(env, [], NOW);
  const html = fs.readFileSync(page, "utf8");
  assert.ok(html.includes('&lt;script&gt;alert(&quot;bad&quot;)&lt;/script&gt;'));
  assert.ok(!html.includes('<script>alert("bad")</script>'));
});

test("reset history and timed-resume history are recorded once without requiring notifications", () => {
  const { env } = sandbox();
  const paused = { provider: "codex", ctx: { manualPause: { since: NOW, until: NOW + 60_000 }, window: { five_hour: { resetsAt: NOW / 1000 + 60 } } } };
  checkResets(env, [paused], NOW, () => {});
  const expired = { provider: "codex", ctx: { manualPause: null, window: {} } };
  checkResets(env, [expired], NOW + 60_000, () => {});
  checkResets(env, [expired], NOW + 120_000, () => {});
  assert.equal(recentEvents(env).filter(row => row.kind === "reset").length, 1);
  assert.equal(recentEvents(env).filter(row => row.kind === "resume").length, 1);
});
