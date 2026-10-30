import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate, normalizeRules, parseSet, ruleId, setRule } from "../src/rules.mjs";
import { configFile, context, readJson, readRules, readState, recordReading, resume, writeJsonAtomic, writeRules } from "../src/store.mjs";
import { writeUsage } from "../src/usage.mjs";
import { runHook, describe } from "../src/hook.mjs";
import { codexEnv, runCodexHook } from "../src/codex.mjs";
import { NOW, sandbox } from "./helpers.mjs";

const MIN = 60_000;
const rule = { kind: "rate", window: "five_hour", at: 15, span: 10, action: "pause" };
const resetsAt = (NOW + 4 * 3600_000) / 1000;
const reading = (pct, reset = resetsAt) => ({ five_hour: { usedPct: pct, resetsAt: reset, seenAt: NOW } });
const ev = (pct, extra = {}) => evaluate({ window: reading(pct), rules: [rule], now: NOW, ...extra });

test("rate parse forms and span validation", () => {
  for (const [words, window, at, span, action] of [
    ["5h rate 15 pause", "five_hour", 15, 10, "pause"],
    ["5h rate 15/5m ask", "five_hour", 15, 5, "ask"],
    ["weekly rate 5/30m warn", "seven_day", 5, 30, "warn"],
    ["5h rate off pause", "five_hour", null, 10, "pause"],
  ]) assert.deepEqual(parseSet(words.split(" ")), { op: "set", rule: { kind: "rate", window, action, span }, at });
  for (const span of [0, 301, 1.5, "10"]) assert.deepEqual(normalizeRules([{ ...rule, span }]), []);
  assert.equal(normalizeRules([{ ...rule, span: undefined }])[0].span, 10);
  for (const words of ["5h rate 15/0m pause", "5h rate 15/301m pause", "5h 15/5m pause"]) assert.throws(() => parseSet(words.split(" ")));
  assert.notEqual(ruleId(rule), ruleId({ ...rule, span: 5 }));
  assert.equal(setRule([rule], { ...rule, span: 5 }, 15).length, 2);
});

test("fresh window counts a jump from zero without an earlier point", () => {
  const window = reading(22, (NOW + 5 * 3600_000 - MIN) / 1000);
  const hit = ev(22, { window }).hit;
  assert.equal(hit.rise, 22);
  assert.equal(hit.since, NOW - MIN);
  assert.match(describe(hit, NOW).what, /22 points/);
});

test("slow climb never hits; span edge uses the last point at or before it", () => {
  const pts = Array.from({ length: 31 }, (_, i) => [NOW - (30 - i) * MIN, i / 5]);
  for (let i = 0; i < pts.length; i++) {
    assert.equal(ev(pts[i][1], { now: pts[i][0], history: { five_hour: pts.slice(0, i + 1) } }).action, "none");
  }
  const history = { five_hour: [[NOW - 11 * MIN, 0], [NOW - 10 * MIN, 5], [NOW - 9 * MIN, 10]] };
  assert.equal(ev(20, { history }).hit.rise, 15);
  assert.equal(ev(19, { history }).action, "none");
  assert.equal(ev(99).action, "none", "an old window without history has no baseline");
});

test("latch holds, resume releases, only a new burst gets a new key, reset prunes", () => {
  const history = { five_hour: [[NOW - MIN, 0], [NOW, 22]] };
  const fired = ev(22, { history });
  assert.equal(fired.action, "pause");
  const held = ev(22, { now: NOW + 11 * MIN, history, rateLatch: fired.rateLatch });
  assert.equal(held.hit.key, fired.hit.key);
  const released = ev(22, { now: NOW + 11 * MIN, history, rateLatch: held.rateLatch, resumed: [{ key: held.hit.key }] });
  assert.equal(released.action, "none");
  assert.equal(released.released.length, 1);
  assert.equal(ev(22, { now: NOW + 12 * MIN, history, rateLatch: released.rateLatch }).action, "none");
  const fresh = { five_hour: [...history.five_hour, [NOW + 11 * MIN, 22], [NOW + 12 * MIN, 40]] };
  const burst = ev(40, { now: NOW + 12 * MIN, history: fresh, rateLatch: released.rateLatch });
  assert.equal(burst.action, "pause");
  assert.notEqual(burst.hit.key, fired.hit.key);
  assert.deepEqual(ev(0, { window: reading(0, resetsAt + 18000), rateLatch: burst.rateLatch }).rateLatch, {});
});

test("a rate warning lasts as long as the burst, and the same burst doesn't warn twice", () => {
  const warn = { ...rule, action: "warn" };
  const evw = (pct, extra) => evaluate({ window: reading(pct), rules: [warn], now: NOW, ...extra });
  const history = { five_hour: [[NOW - MIN, 0], [NOW, 22]] };
  const fired = evw(22, { history });
  assert.equal(fired.action, "warn");
  assert.equal(evw(22, { now: NOW + 5 * MIN, history, rateLatch: fired.rateLatch }).hit.key, fired.hit.key, "still inside the burst");
  const over = evw(22, { now: NOW + 11 * MIN, history, rateLatch: fired.rateLatch });
  assert.equal(over.action, "none", "the burst left the span");
  assert.equal(over.released.length, 1);
  assert.equal(evw(22, { now: NOW + 12 * MIN, history, rateLatch: over.rateLatch }).action, "none");
});

test("context accepts only the matching window history", () => {
  const { env } = sandbox();
  recordReading(env, reading(22));
  const pts = [[NOW - MIN, 0]];
  assert.deepEqual(context(env, { now: NOW, usage: { windows: { five_hour: { resetsAt, pts } } } }).history, { five_hour: pts });
  assert.deepEqual(context(env, { now: NOW, usage: { windows: { five_hour: { resetsAt: resetsAt - 18000, pts } } } }).history, {});
});

test("writeRules keeps future rule kinds; migration adds the default once", () => {
  const { env } = sandbox();
  const future = { kind: "future", opaque: { keep: [1, 2] } };
  writeJsonAtomic(configFile(env), { v: 2, rules: [future] });
  const migrated = readRules(env);
  assert.equal(migrated.filter(r => r.kind === "rate").length, 1);
  assert.deepEqual(migrated[0], { kind: "rate", window: "five_hour", at: 20, span: 10, action: "warn" });
  writeRules(env, migrated);
  writeRules(env, readRules(env));
  assert.equal(readRules(env).filter(r => r.kind === "rate").length, 1);
  assert.deepEqual(readJson(configFile(env)).rules.at(-1), future);
  assert.equal(readJson(configFile(env)).v, 3);
});

test("Claude hook persists the hold and release even on an allowed call", () => {
  const { env } = sandbox();
  writeRules(env, [rule]);
  recordReading(env, reading(22));
  writeUsage(env, { windows: { five_hour: { resetsAt, pts: [[NOW - MIN, 0], [NOW, 22]] } }, weeks: [] });
  const invoke = now => runHook({ env, now, input: { hook_event_name: "PreToolUse", session_id: "rate" } });
  assert.equal(invoke(NOW).hookSpecificOutput.permissionDecision, "deny");
  assert.equal(invoke(NOW + 11 * MIN).hookSpecificOutput.permissionDecision, "deny");
  resume(env, { now: NOW + 11 * MIN });
  assert.equal(invoke(NOW + 11 * MIN), null);
  assert.ok(Object.values(readState(env, NOW + 11 * MIN).rateLatch)[0].releasedAt);
  assert.equal(invoke(NOW + 12 * MIN), null);
});

test("Codex replay of 0 to 100 over five minutes pauses by 30 percent and holds", async () => {
  const { env, root } = sandbox();
  const scoped = codexEnv(env);
  writeRules(scoped, [{ ...rule, span: 5 }]);
  const reset = (NOW + 5 * 3600_000) / 1000;
  let first = null;
  for (let i = 0; i <= 5; i++) {
    const pct = i * 20;
    const out = await runCodexHook({ env, now: NOW + i * MIN,
      input: { hook_event_name: "PreToolUse", session_id: "replay", cwd: root },
      reader: async () => ({ rateLimits: { primary: { usedPercent: pct, windowDurationMins: 300, resetsAt: reset } } }),
    });
    if (out?.hookSpecificOutput?.permissionDecision === "deny") first ??= pct;
  }
  assert.ok(first !== null && first <= 30, `first pause at ${first}%`);
  const before = readState(scoped, NOW + 6 * MIN).rateLatch;
  assert.equal(Object.keys(before).length, 1);
  resume(scoped, { now: NOW + 6 * MIN });
  await runCodexHook({ env, now: NOW + 6 * MIN, input: { hook_event_name: "PreToolUse" }, reader: async () => ({ rateLimits: { primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: reset } } }) });
  assert.ok(Object.values(readState(scoped, NOW + 6 * MIN).rateLatch)[0].releasedAt);
});

test("fast-rise trigger needs two recent increasing points in either window", async () => {
  const { hasFastRise } = await import("../src/codex.mjs");
  const usage = (pts, name = "five_hour") => ({ windows: { [name]: { pts } } });
  assert.equal(hasFastRise(usage([[NOW - MIN, 0], [NOW, 3]]), NOW), true);
  assert.equal(hasFastRise(usage([[NOW - MIN, 1], [NOW, 10]], "seven_day"), NOW), true);
  assert.equal(hasFastRise(usage([[NOW - MIN, 0], [NOW, 2]]), NOW), false);
  assert.equal(hasFastRise(usage([[NOW - 4 * MIN, 0], [NOW - 3 * MIN, 9]]), NOW), false);
  assert.equal(hasFastRise(usage([[NOW, 9]]), NOW), false);
  assert.equal(hasFastRise(usage([[NOW, 0], [NOW, 9]]), NOW), false);
});

test("Codex hook uses ten-second caching for a rate line or fast history, otherwise sixty", async () => {
  for (const mode of ["rate", "fast", "slow", "off"]) {
    const { env, root } = sandbox();
    const scoped = codexEnv(env);
    writeRules(scoped, mode === "rate" ? [{ ...rule, action: "warn" }] : mode === "off" ? [{ ...rule, project: root, off: true }] : []);
    let reads = 0;
    const reader = async () => {
      reads++;
      return { rateLimits: { primary: { usedPercent: 10, windowDurationMins: 300, resetsAt } } };
    };
    const call = now => runCodexHook({ env, now, reader, input: { hook_event_name: "PreToolUse", session_id: mode, cwd: root, tool_name: "exec" } });
    await call(NOW);
    writeUsage(scoped, { windows: { five_hour: { resetsAt, pts: [[NOW - MIN, mode === "fast" ? 0 : 9], [NOW, 10]] } }, weeks: [] });
    await call(NOW + 9_000);
    assert.equal(reads, 1, mode);
    await call(NOW + 11_000);
    assert.equal(reads, ["rate", "fast"].includes(mode) ? 2 : 1, mode);
  }
});
