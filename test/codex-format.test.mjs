import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { sandbox } from "./helpers.mjs";
import { cachePath, codexEnv, parseRateLimits, refreshCodex, refreshStatePath, runCodexHook } from "../src/codex.mjs";
import { readWindow, writeRules } from "../src/store.mjs";

// Illustrative Codex answers (research, 2026-10-17): no account data. resetsAt
// is 1900000000 s plus hours, so `now` sits just before it.
const DIR = new URL("./fixtures/codex-rate-limits/", import.meta.url);
const sample = (name) => JSON.parse(fs.readFileSync(new URL(fs.readdirSync(DIR).find((f) => f.startsWith(name)), DIR), "utf8"));
const now = 1_900_000_000_000;
const pcts = (reading) => Object.fromEntries(Object.entries(reading).map(([k, w]) => [k, w.usedPct]));

test("Codex answers in every known shape become the windows Codex reported", () => {
  // [windows read, windows Codex says are not there]
  const cases = {
    "01": [{ five_hour: 12, seven_day: 34 }, []],
    "02": [{ seven_day: 34 }, ["five_hour"]], // weekly in the primary slot is still weekly
    "03": [{ seven_day: 34 }, ["five_hour"]], // the map's codex entry, not another meter's 99%
    "04": [{ seven_day: 34 }, []], // reported, but with no reset to count to
    "05": [{ five_hour: 12, seven_day: 34 }, []],
    "06": [{ five_hour: 12, seven_day: 34 }, []],
    "07": [{}, []], // slots left out say nothing
    "08": [{}, ["five_hour", "seven_day"]], // both stated as null
    "14": [{ seven_day: 34 }, ["five_hour"]], // a 60-minute meter is no 5-hour window
    "16": [{ five_hour: 12, seven_day: 34 }, []],
  };
  for (const [name, [windows, absent]] of Object.entries(cases)) {
    const parsed = parseRateLimits(sample(name), now);
    assert.deepEqual(pcts(parsed.reading), windows, name);
    assert.deepEqual(parsed.absent, absent, name);
  }
});

test("a Codex answer Peras does not recognize is an error, not an empty reading", () => {
  for (const name of ["09", "13", "15"]) assert.throws(() => parseRateLimits(sample(name), now), /run peras update/, name);
  assert.throws(() => parseRateLimits({}, now), /does not recognize/);
  const week = { usedPercent: 34, windowDurationMins: 10080, resetsAt: 1_900_300_000 };
  for (const primary of ["96%", [1], { usedPercent: "high", windowDurationMins: 300, resetsAt: 1_900_007_200 }, { usedPercent: 96, windowDurationMins: "300", resetsAt: 1_900_007_200 }, { usedPercent: 96, windowDurationMins: 300, resetsAt: "soon" }]) {
    assert.throws(() => parseRateLimits({ rateLimits: { limitId: "codex", primary, secondary: week } }, now), /window this Peras does not recognize/, JSON.stringify(primary));
  }
});

test("an unrecognized answer keeps the last reading, stamps no fresh cache and starts the menu's backoff", async () => {
  const { env, root } = sandbox();
  env.CODEX_HOME = path.join(root, "codex");
  await refreshCodex(env, now, { reader: async () => sample("01") });
  await assert.rejects(refreshCodex(env, now + 61_000, { reader: async () => sample("09"), adaptive: true }), /does not recognize/);
  assert.equal(JSON.parse(fs.readFileSync(cachePath(env))).at, now, "the cache keeps its real age");
  assert.equal(JSON.parse(fs.readFileSync(refreshStatePath(env))).failures, 1);
  assert.deepEqual(pcts(readWindow(codexEnv(env))), { five_hour: 12, seven_day: 34 });
  let reads = 0;
  await assert.rejects(refreshCodex(env, now + 62_000, { reader: async () => { reads++; return sample("01"); }, adaptive: true }));
  assert.equal(reads, 0, "the menu waits before asking again");
});

test("a 5-hour window Codex stops reporting is dropped; one reported without a reset is kept", async () => {
  const { env, root } = sandbox();
  env.CODEX_HOME = path.join(root, "codex");
  const scoped = codexEnv(env);
  await refreshCodex(env, now, { reader: async () => sample("01") });
  await refreshCodex(env, now + 1000, { force: true, reader: async () => sample("04") });
  assert.deepEqual(pcts(readWindow(scoped)), { five_hour: 12, seven_day: 34 }, "still reported: the last reading stands");
  await refreshCodex(env, now + 2000, { force: true, reader: async () => sample("02") });
  assert.deepEqual(pcts(readWindow(scoped)), { seven_day: 34 }, "no longer reported: gone, not frozen until its old reset");
  await refreshCodex(env, now + 3000, { force: true, reader: async () => sample("08") });
  assert.deepEqual(readWindow(scoped), {});
});

test("a stop stays when Codex's answer leaves a window's identity unknown", async () => {
  const { env, root } = sandbox();
  env.CODEX_HOME = path.join(root, "codex");
  writeRules(codexEnv(env), [{ kind: "window", window: "five_hour", at: 90, action: "pause" }]);
  const week = { usedPercent: 34, windowDurationMins: 10080, resetsAt: 1_900_300_000 };
  const answer = (primary) => async () => ({ rateLimits: { limitId: "codex", primary, secondary: week } });
  const input = { hook_event_name: "PreToolUse", session_id: "s1", cwd: root, tool_name: "Bash" };
  const hook = (time, reader) => runCodexHook({ input, env, now: time, reader });
  const decision = (out) => out?.hookSpecificOutput?.permissionDecision;
  assert.equal(decision(await hook(now, answer({ usedPercent: 96, windowDurationMins: 300, resetsAt: 1_900_007_200 }))), "deny");
  assert.equal(decision(await hook(now + 61_000, answer({ usedPercent: 96, windowDurationMins: null, resetsAt: 1_900_007_200 }))), "deny", "a null duration could still be the 5-hour window");
  assert.equal(decision(await hook(now + 122_000, async () => ({ rateLimits: { limitId: "codex", secondary: week } }))), "deny", "a slot left out says nothing");
  assert.equal(decision(await hook(now + 183_000, answer({ usedPercent: 96, windowDurationMins: 300, resetsAt: "later" }))), "deny", "a malformed window is an error, and the last reading stands");
  assert.equal(decision(await hook(now + 244_000, answer(null))), undefined, "only an answer that says the window is gone lifts it");
});
