// "Empty in ~7 min" during a burn, and Codex's saved resets.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { sandbox, NOW } from "./helpers.mjs";
import { emptyAt, DEFAULT_RULES } from "../src/rules.mjs";
import { emptyIn } from "../src/window.mjs";
import { describe, runHook } from "../src/hook.mjs";
import { cachePath, codexEnv, refreshCodex, runCodexHook } from "../src/codex.mjs";
import { checkSavedResetReminders, parseResetCredits, savedResets, savedResetsHint, savedResetsText } from "../src/saved-resets.mjs";
import { pauseNow, readJson, recordReading, writeJsonAtomic, writeRules } from "../src/store.mjs";
import { setPreference } from "../src/preferences.mjs";
import { writeUsage } from "../src/usage.mjs";
import { snapshot, statusText } from "../src/providers.mjs";
import { providerPayload, snapshotMessage, snapshotProblems } from "../src/native-protocol.mjs";

const MIN = 60_000;
const HOUR = 3600_000;
const resetsAt = (NOW + 4 * HOUR) / 1000;
const s = (ms) => Math.round(ms / 1000);
const credit = (expiresInMs, extra = {}) => ({ id: "c", grantedAt: s(NOW - 10 * 86_400_000), expiresAt: expiresInMs == null ? null : s(NOW + expiresInMs), resetType: "codexRateLimits", status: "available", title: "Full reset (Weekly + 5 hr)", ...extra });
const answer = (pct, credits) => ({ rateLimits: { primary: { usedPercent: pct, windowDurationMins: 300, resetsAt } }, ...(credits === undefined ? {} : { rateLimitResetCredits: credits }) });

test("a burst empties the window at its own rate, unless it is calm, full, or the reset comes first", () => {
  const w = { usedPct: 32, resetsAt };
  assert.equal(emptyAt(w, 22, NOW - 2 * MIN, NOW, NOW), Math.round(NOW + (68 / 22) * 2 * MIN));
  assert.equal(emptyAt(w, 0, NOW - 2 * MIN, NOW, NOW), null, "no rise");
  assert.equal(emptyAt({ usedPct: 100, resetsAt }, 22, NOW - 2 * MIN, NOW, NOW), null, "already full");
  assert.equal(emptyAt({ usedPct: 32, resetsAt: (NOW + 5 * MIN) / 1000 }, 22, NOW - 2 * MIN, NOW, NOW), null, "the reset comes first");
  assert.equal(emptyAt(w, 22, NOW - 10_000, NOW, NOW), Math.round(NOW + (68 / 22) * MIN), "a burst under a minute counts as one minute");
  // A held burst keeps the rate it fired at, not one that thins out while it waits.
  assert.equal(emptyAt(w, 22, NOW - 12 * MIN, NOW - 10 * MIN, NOW), Math.round(NOW + (68 / 22) * 2 * MIN));
});

test("the countdown is always approximate, in minutes under an hour, then a clock time", () => {
  assert.deepEqual([emptyIn(NOW + 90_000, NOW), emptyIn(NOW + 90_000, NOW, { long: true })], ["in ~1 min", "in about a minute"]);
  assert.deepEqual([emptyIn(NOW + 7.4 * MIN, NOW), emptyIn(NOW + 7.4 * MIN, NOW, { long: true })], ["in ~7 min", "in about 7 minutes"]);
  assert.match(emptyIn(NOW + 59.6 * MIN, NOW), /^~(\w{3} )?\d\d:\d\d$/, "59.6 minutes rounds to an hour, so it reads as a time");
  assert.match(emptyIn(NOW + 80 * MIN, NOW, { long: true }), /^around (\w{3} )?\d\d:\d\d$/);
});

test("a burn stop tells the agent and the notification when the window empties", () => {
  const { env } = sandbox();
  writeRules(env, [...DEFAULT_RULES, { kind: "rate", window: "five_hour", at: 15, span: 5, action: "pause" }]);
  writeUsage(env, { v: 1, windows: { five_hour: { resetsAt, pts: [[NOW - 2 * MIN, 10], [NOW - MIN, 20], [NOW, 32]] } }, weeks: [], blame: null });
  recordReading(env, { five_hour: { usedPct: 32, resetsAt, seenAt: NOW }, seven_day: { usedPct: 30, resetsAt: resetsAt + 86400, seenAt: NOW } });
  const notes = [];
  const out = runHook({ env, now: NOW, notify: (...a) => notes.push(a), input: { hook_event_name: "PreToolUse", session_id: "s", tool_name: "Bash" } });
  const text = JSON.stringify(out);
  assert.match(text, /At that rate the 5-hour window empties in about 6 minutes/);
  const d = describe({ kind: "rate", window: "five_hour", rise: 22, span: 5, at: 15, action: "pause", usedPct: 32, resetsAt, emptyAtMs: NOW + 6 * MIN }, NOW);
  assert.match(d.short, /, empty in ~6 min$/);
  const none = describe({ kind: "rate", window: "five_hour", rise: 22, span: 5, at: 15, action: "pause", usedPct: 32, resetsAt, emptyAtMs: null }, NOW);
  assert.doesNotMatch(none.what + none.short, /empt/, "no countdown when the reset comes first");
});

test("saved resets are read from Codex's answer, and an unknown shape never costs the reading", () => {
  assert.equal(parseResetCredits({}), null, "Codex didn't say");
  assert.equal(parseResetCredits({ rateLimitResetCredits: { availableCount: -1 } }), null);
  assert.equal(parseResetCredits({ rateLimitResetCredits: "x" }), null);
  assert.deepEqual(parseResetCredits({ rateLimitResetCredits: { availableCount: 0, credits: [] } }), { count: 0, credits: [] });
  // Count comes from availableCount: the list may be capped. Redeemed ones are not available.
  const parsed = parseResetCredits({ rateLimitResetCredits: { availableCount: 3, credits: [credit(HOUR), credit(2 * HOUR, { status: "redeemed" }), credit(null), { bad: true }] } });
  assert.equal(parsed.count, 3);
  assert.deepEqual(parsed.credits.map((c) => c.expiresAt), [s(NOW + HOUR), null]);
  assert.deepEqual(parseResetCredits({ rateLimitResetCredits: { availableCount: 2, credits: null } }), { count: 2, credits: null });
});

test("saved resets as of now: expired ones drop, old readings say nothing, and the words", async () => {
  const { env } = sandbox();
  await refreshCodex(env, NOW, { force: true, reader: async () => answer(22, { availableCount: 2, credits: [credit(HOUR), credit(30 * HOUR)] }) });
  assert.equal(readJson(cachePath(env)).reading.five_hour.usedPct, 22, "the reading is still there");
  assert.deepEqual(savedResets(env, NOW), { count: 2, nextExpiresAtMs: s(NOW + HOUR) * 1000 });
  assert.deepEqual(savedResets(env, NOW + 2 * HOUR), { count: 1, nextExpiresAtMs: s(NOW + 30 * HOUR) * 1000 });
  assert.equal(savedResets(env, NOW + 7 * HOUR), null, "a reading over six hours old says nothing");
  assert.match(savedResetsText({ count: 1, nextExpiresAtMs: NOW + HOUR }, NOW), /^1 saved reset · expires \d\d:\d\d$/);
  assert.match(savedResetsText({ count: 2, nextExpiresAtMs: NOW + HOUR }, NOW), /^2 saved resets · next expires /);
  assert.equal(savedResetsText({ count: 0, nextExpiresAtMs: null }, NOW), null);
  assert.equal(savedResetsText({ count: 1, nextExpiresAtMs: null }, NOW), "1 saved reset");
  await refreshCodex(env, NOW + MIN, { force: true, reader: async () => answer(23) });
  assert.equal(savedResets(env, NOW + MIN), null, "Codex stopped saying: unknown, not zero");
});

test("a Codex usage stop names a saved reset; a pause by hand does not; Peras never spends one", async () => {
  const { env, root } = sandbox();
  const scoped = codexEnv(env);
  writeRules(scoped, [{ kind: "window", window: "five_hour", at: 20, action: "pause" }]);
  const calls = [];
  const reader = async (...a) => { calls.push(a); return answer(22, { availableCount: 1, credits: [credit(20 * HOUR)] }); };
  const notes = [];
  const out = await runCodexHook({ env, now: NOW, reader, notify: (...a) => notes.push(a), input: { hook_event_name: "PreToolUse", session_id: "s", cwd: root, tool_name: "exec", tool_input: {} } });
  const reason = out.hookSpecificOutput.permissionDecisionReason;
  assert.match(reason, /The user has 1 saved Codex reset \(it expires (\w{3} )?\d\d:\d\d\); spending one is their call\. Stop and tell the user why\.$/);
  assert.match(notes[0]?.[1] ?? "", /1 saved reset available\.$/);
  writeRules(scoped, []);
  pauseNow(scoped, { now: NOW + 1000 });
  const manual = await runCodexHook({ env, now: NOW + 2000, reader, input: { hook_event_name: "PreToolUse", session_id: "s", cwd: root, tool_name: "exec", tool_input: {} } });
  assert.doesNotMatch(manual.hookSpecificOutput.permissionDecisionReason, /saved/);
  assert.equal(savedResetsHint(null, NOW), "");
  // Every read is a read: nothing in Peras calls the consume method.
  const src = fs.readdirSync(new URL("../src/", import.meta.url)).filter((f) => f.endsWith(".mjs")).map((f) => fs.readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8")).join("\n");
  assert.doesNotMatch(src, /rateLimitResetCredit\/consume/);
});

test("status and the app show saved resets; a malformed one is refused", async () => {
  const { env } = sandbox();
  await refreshCodex(env, NOW, { force: true, reader: async () => answer(22, { availableCount: 1, credits: [credit(20 * HOUR)] }) });
  const snap = await snapshot(env, NOW, { provider: "codex", cwd: null });
  assert.match(statusText(snap, NOW), /\n {2}1 saved reset · expires .+ \(spend it in Codex; Peras never does\)\./);
  const p = providerPayload(snap, { now: NOW, sign: () => "tok_test" });
  assert.deepEqual(p.savedResets, { count: 1, nextExpiresAtMs: s(NOW + 20 * HOUR) * 1000 });
  const problems = (x) => snapshotProblems(snapshotMessage({ bridgeInstance: "b", revision: 1, now: NOW, providers: [x] }));
  assert.deepEqual(problems(p), []);
  assert.deepEqual(problems({ ...p, savedResets: null }), []);
  assert.notDeepEqual(problems({ ...p, savedResets: { count: -1, nextExpiresAtMs: null } }), []);
  assert.notDeepEqual(problems({ ...p, savedResets: { count: 1, nextExpiresAtMs: 1.5 } }), []);
  const claude = providerPayload(await snapshot(env, NOW, { cwd: null }), { now: NOW, sign: () => "tok_test" });
  assert.equal(claude.savedResets, null);
});

test("a saved reset is reminded once, a day before it expires, under the Warnings setting", async () => {
  const { env } = sandbox();
  const snaps = () => [{ provider: "codex", env: codexEnv(env) }];
  const notes = [];
  const notify = (...a) => notes.push(a);
  await refreshCodex(env, NOW, { force: true, reader: async () => answer(22, { availableCount: 1, credits: [credit(30 * HOUR)] }) });
  checkSavedResetReminders(env, snaps(), NOW, notify);
  assert.equal(notes.length, 0, "30 hours out is too early");
  await refreshCodex(env, NOW + 7 * HOUR, { force: true, reader: async () => answer(22, { availableCount: 1, credits: [credit(30 * HOUR)] }) });
  checkSavedResetReminders(env, snaps(), NOW + 7 * HOUR, notify);
  checkSavedResetReminders(env, snaps(), NOW + 7 * HOUR + MIN, notify);
  assert.equal(notes.length, 1, "once");
  assert.match(notes[0][1], /^A saved Codex reset expires .+\. Spend it in Codex before then, or it's gone\. Peras never spends it for you\.$/);
  const other = sandbox().env;
  setPreference(other, "warnings", "off");
  await refreshCodex(other, NOW + 7 * HOUR, { force: true, reader: async () => answer(22, { availableCount: 1, credits: [credit(30 * HOUR)] }) });
  checkSavedResetReminders(other, [{ provider: "codex", env: codexEnv(other) }], NOW + 7 * HOUR, notify);
  assert.equal(notes.length, 1, "Warnings off: no reminder");
  writeJsonAtomic(cachePath(env), { at: NOW, reading: {} });
});

test("a Codex burn stop carries the same countdown, beside its saved reset", async () => {
  const { env, root } = sandbox();
  const scoped = codexEnv(env);
  writeRules(scoped, [{ kind: "rate", window: "five_hour", at: 15, span: 5, action: "pause" }]);
  writeUsage(scoped, { v: 1, windows: { five_hour: { resetsAt, pts: [[NOW - 2 * MIN, 10], [NOW - MIN, 20]] } }, weeks: [], blame: null });
  const reader = async () => answer(32, { availableCount: 1, credits: [credit(20 * HOUR)] });
  const out = await runCodexHook({ env, now: NOW, reader, notify: () => {}, input: { hook_event_name: "PreToolUse", session_id: "s", cwd: root, tool_name: "exec", tool_input: {} } });
  const reason = out.hookSpecificOutput.permissionDecisionReason;
  assert.match(reason, /^Peras paused Codex: 5-hour usage rose 22 points within 5 minutes, past the 15-point rate line\. At that rate the 5-hour window empties in about 6 minutes\. .*The user has 1 saved Codex reset/);
});

test("peras codex status and peras status show the saved reset", async () => {
  const { main } = await import("../src/cli.mjs");
  const { env } = sandbox();
  const now = Date.now();
  const answerNow = { rateLimits: { primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: Math.round(now / 1000) + 3600 } }, rateLimitResetCredits: { availableCount: 1, credits: [{ id: "c", expiresAt: Math.round(now / 1000) + 20 * 3600, status: "available", title: "Full reset" }] } };
  for (const args of [["codex", "status"], ["status"]]) {
    const lines = [];
    assert.equal(await main(args, { env, now, out: (l) => lines.push(l), codexReader: async () => answerNow, isTTY: false }), 0);
    assert.match(lines.join("\n"), /1 saved reset · expires .* \(spend it in Codex; Peras never does\)\./, args.join(" "));
  }
});
