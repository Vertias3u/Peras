// What the app sees of the burn guard: the burn badge, this prompt's subagents and burns in the recap.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sandbox, NOW } from "./helpers.mjs";
import { providerPayload, snapshotMessage, snapshotProblems } from "../src/native-protocol.mjs";
import { snapshot } from "../src/providers.mjs";
import { recordReading, resume, writeRules } from "../src/store.mjs";
import { writeUsage } from "../src/usage.mjs";
import { recordEvent, recentEvents } from "../src/events.mjs";
import { weekRecap } from "../src/recap.mjs";
import { runHook } from "../src/hook.mjs";
import { DEFAULT_RULES } from "../src/rules.mjs";

const MIN = 60_000;
const resetsAt = (NOW + 4 * 3600_000) / 1000;
const burning = (env, pts, now = NOW) => {
  writeUsage(env, { v: 1, windows: { five_hour: { resetsAt, pts } }, weeks: [], blame: null });
  recordReading(env, { five_hour: { usedPct: pts.at(-1)[1], resetsAt, seenAt: now }, seven_day: { usedPct: 30, resetsAt: resetsAt + 86400, seenAt: now } });
};
const payload = async (env, now = NOW) => providerPayload(await snapshot(env, now, { cwd: null }), { now, sign: () => "tok_test" });
const five = (p) => p.burn.find((b) => b.window === "five_hour");

test("the burn badge is calm, rising on a warning or a fast climb, stopped on a pause line", async () => {
  const { env } = sandbox();
  writeRules(env, DEFAULT_RULES);
  burning(env, [[NOW - 9 * MIN, 10], [NOW - 5 * MIN, 11]]);
  assert.deepEqual(five(await payload(env)), { window: "five_hour", rise: 1, spanMinutes: 10, sinceMs: NOW - 9 * MIN, line: { at: 20, action: "warn" }, state: "calm", emptyAtMs: null });
  burning(env, [[NOW - 2 * MIN, 10], [NOW - MIN, 14]]);
  assert.equal(five(await payload(env)).state, "rising", "4 points a minute, under every line");
  burning(env, [[NOW - 2 * MIN, 10], [NOW - MIN, 20], [NOW, 32]]);
  assert.deepEqual(five(await payload(env)), { window: "five_hour", rise: 22, spanMinutes: 10, sinceMs: NOW - 2 * MIN, line: { at: 20, action: "warn" }, state: "rising", emptyAtMs: Math.round(NOW + (68 / 22) * 2 * MIN) });
  writeRules(env, [...DEFAULT_RULES, { kind: "rate", window: "five_hour", at: 15, span: 5, action: "pause" }]);
  runHook({ env, now: NOW, input: { hook_event_name: "PreToolUse", session_id: "s", tool_name: "Bash" } });
  const stopped = five(await payload(env));
  assert.equal(stopped.state, "stopped");
  assert.deepEqual([stopped.line, stopped.spanMinutes], [{ at: 15, action: "pause" }, 5]);
  // Resume lets the burst go: the badge measures from the resume, as the lines do.
  resume(env, { now: NOW + MIN });
  runHook({ env, now: NOW + MIN, input: { hook_event_name: "PreToolUse", session_id: "s", tool_name: "Bash" } });
  const after = five(await payload(env, NOW + 2 * MIN));
  assert.equal(after.state, "calm");
  assert.equal(after.rise, 0);
  assert.equal(after.sinceMs, null);
});

test("subagents count for the latest prompt while it is recent, with the subagent line", async () => {
  const { env } = sandbox();
  writeRules(env, [...DEFAULT_RULES, { kind: "agents", at: 3, action: "ask" }, { kind: "agents", at: 5, action: "pause" }]);
  const spawn = (now, session = "s") => runHook({ env, now, input: { hook_event_name: "PreToolUse", session_id: session, tool_name: "Agent" } });
  assert.deepEqual((await payload(env)).subagents, { prompt: 0, line: 3 });
  spawn(NOW - 2 * MIN); spawn(NOW - MIN);
  assert.deepEqual((await payload(env)).subagents, { prompt: 2, line: 3 });
  assert.equal((await payload(env, NOW + 16 * MIN)).subagents.prompt, 0, "a quarter of an hour later it is history");
  runHook({ env, now: NOW, input: { hook_event_name: "UserPromptSubmit", session_id: "s", prompt: "next" } });
  assert.equal((await payload(env, NOW + 1000)).subagents.prompt, 0, "a new prompt starts at zero");
});

test("the recap counts burns that stopped the agent, from the events' numbers, never their text", () => {
  const { env } = sandbox();
  const end = Math.floor((NOW - 6 * 3600_000) / 1000), endMs = end * 1000;
  const usage = { weeks: [{ resetsAt: end, pts: [[endMs - 3 * 86400_000, 40], [endMs - 20 * MIN, 70]] }] };
  const burn = (at, rise, action, span = 10, since = at - 6 * MIN) => recordEvent(env, { kind: action === "warn" ? "warning" : "pause", provider: "claude", at, message: "Rose 99 points", data: { kind: "rate", window: "five_hour", rise, span, since, action } });
  assert.deepEqual(weekRecap(env, usage, "claude", NOW).burns, { count: 0, biggest: null });
  burn(endMs - 2 * 86400_000, 22, "pause");
  burn(endMs - 86400_000, 31, "warn");
  burn(endMs - 3600_000, 18.25, "ask", 5, null);
  burn(endMs - 8 * 86400_000, 60, "pause");
  recordEvent(env, { kind: "pause", provider: "codex", at: endMs - 3600_000, message: "x", data: { kind: "rate", window: "five_hour", rise: 90, span: 10, since: null, action: "pause" } });
  recordEvent(env, { kind: "pause", provider: "claude", at: endMs - 3600_000, message: "a level line, no numbers" });
  assert.deepEqual(weekRecap(env, usage, "claude", NOW).burns, { count: 2, biggest: { rise: 22, minutes: 6 } });
  assert.equal(recentEvents(env, Infinity).length, 6, "rows with data still read as plain events");
});

test("snapshots with a malformed burn, subagents or recap burns are refused", async () => {
  const { env } = sandbox();
  writeRules(env, DEFAULT_RULES);
  burning(env, [[NOW - MIN, 10], [NOW, 12]]);
  const good = await payload(env);
  const problems = (p) => snapshotProblems(snapshotMessage({ bridgeInstance: "b", revision: 1, now: NOW, providers: [p] }));
  assert.deepEqual(problems(good), []);
  for (const bad of [
    { burn: [{ ...good.burn[0], state: "hot" }] }, { burn: [{ ...good.burn[0], rise: -1 }] }, { burn: [{ ...good.burn[0], spanMinutes: 0 }] },
    { burn: {} }, { subagents: { prompt: -1, line: null } }, { subagents: { prompt: 1, line: "3" } },
    { recap: { id: "x", weekEndedAtMs: NOW, usedPercent: 1, lastReadingAtMs: NOW, atReset: true, pauses: 0, untilMs: NOW, burns: { count: 1, biggest: { rise: 3, minutes: 0 } } } },
  ]) assert.notDeepEqual(problems({ ...good, ...bad }), [], JSON.stringify(bad));
  const { burn, subagents, ...old } = good;
  assert.deepEqual(problems(old), [], "an older bridge that sends neither is fine");
});
