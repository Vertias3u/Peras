import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { sandbox, NOW, inHours, VERSION } from "./helpers.mjs";
import { install } from "../src/settings.mjs";
import { snapshot } from "../src/providers.mjs";
import { providerPayload, settingsPayload, tokenSigner } from "../src/native-protocol.mjs";
import { runOperation } from "../src/native-operations.mjs";
import { preferences, setPreference, weeklyStyle } from "../src/preferences.mjs";
import { setPacing } from "../src/planning.mjs";
import { readState, recordReading, writeRules } from "../src/store.mjs";
import { displayMode, displayStyle, setDisplayMode } from "../src/menubar.mjs";
import { writeUsage } from "../src/usage.mjs";
import { recordEvent } from "../src/events.mjs";
import { RECAP_MS } from "../src/recap.mjs";

// What the compact menu needs from the backend: the week's style, a pace target
// for the weekly bar, staying paused past a stop, and the self-test as an offer.

const HOOK = `"${process.execPath}" "${new URL("../bin/peras.mjs", import.meta.url).pathname}"`;
const home = () => { const box = sandbox(); install({ env: box.env, command: HOOK, version: VERSION }); return box; };
const payload = async (env, signer, now = NOW) => providerPayload(await snapshot(env, now, { cwd: null }), { now, sign: signer.sign });
const run = (env, signer, a, now = NOW) => runOperation(env, { id: "c", op: a.op, ...(a.provider ? { provider: a.provider } : {}), params: a.params, actionToken: a.actionToken }, { now, signer });

test("the week shows as a bar, as text or not at all, and 0.3's weekly switch stays the on/off truth", async () => {
  const { env } = sandbox();
  const signer = tokenSigner();
  const settings = () => settingsPayload(env, { now: NOW, sign: signer.sign });
  const style = (s, value) => s.actions.find((a) => a.op === "weeklyStyle.set" && a.params.value === value);
  const first = settings();
  assert.equal(first.weeklyStyle, "bar");
  assert.deepEqual(first.actions.filter((a) => a.op === "weeklyStyle.set").map((a) => a.params.value), ["text", "off"]);
  assert.deepEqual(await run(env, signer, style(first, "text")), { ok: true });
  assert.equal(weeklyStyle(env), "text");
  // The same click again names a style that is no longer today's.
  assert.equal((await run(env, signer, style(first, "off"))).code, "state_changed");
  assert.deepEqual(await run(env, signer, style(settings(), "off")), { ok: true });
  assert.deepEqual([weeklyStyle(env), preferences(env).weekly], ["off", false]);
  // 0.3's menu and the CLI turn the week back on: the style chosen before comes back with it.
  setPreference(env, "weekly", "on");
  assert.equal(weeklyStyle(env), "text");
  // Flipping any other switch keeps the style in the file.
  setPreference(env, "mascots", "off");
  assert.equal(JSON.parse(fs.readFileSync(path.join(env.PERAS_HOME, "preferences.json"), "utf8")).weeklyStyle, "text");
  assert.equal((await runOperation(env, { id: "x", op: "weeklyStyle.set", params: { value: "dots" }, actionToken: "t" }, { now: NOW, signer })).code, "state_changed");
});

test("a pacing plan sends where the week should be by tonight and whether today's share is used", async () => {
  const { env } = home();
  const pacing = async (now) => (await payload(env, tokenSigner(), now)).planning.meters.find((m) => m.kind === "pacing");
  setPacing(env, { days: [0, 1, 2, 3, 4, 5, 6], reserve: 10, action: "warn" });
  const none = await pacing(NOW);
  assert.equal(none, undefined, "no reading, no pacing meter");
  recordReading(env, { seven_day: { usedPct: 40, resetsAt: inHours(72), seenAt: NOW - 2 * 3600_000 } });
  recordReading(env, { seven_day: { usedPct: 46, resetsAt: inHours(72), seenAt: NOW } });
  const m = await pacing(NOW);
  assert.equal(m.expectedByTonightPercent, Math.round((46 - m.spent + m.limit) * 10) / 10);
  assert.ok(m.expectedByTonightPercent > 46 && m.expectedByTonightPercent <= 100);
  assert.equal(m.pace, "within");
  // A reserve that leaves no share for today: today's share is used from the first point.
  const { env: tight } = home();
  setPacing(tight, { days: [0, 1, 2, 3, 4, 5, 6], reserve: 80, action: "warn" });
  recordReading(tight, { seven_day: { usedPct: 40, resetsAt: inHours(72), seenAt: NOW - 2 * 3600_000 } });
  recordReading(tight, { seven_day: { usedPct: 46, resetsAt: inHours(72), seenAt: NOW } });
  const used = (await payload(tight, tokenSigner())).planning.meters.find((x) => x.kind === "pacing");
  assert.deepEqual([used.pace, used.expectedByTonightPercent], ["reached", 46]);
});

test("while a usage line stops an agent, it can stay paused after the line lifts, and Resume lifts both", async () => {
  const { env } = home();
  const signer = tokenSigner();
  writeRules(env, [{ kind: "window", window: "five_hour", at: 90, action: "pause" }]);
  recordReading(env, { five_hour: { usedPct: 95, resetsAt: inHours(1), seenAt: NOW } });
  const stopped = await payload(env, signer);
  assert.equal(stopped.verdict.action, "pause");
  const stay = stopped.actions.find((a) => a.op === "pause");
  assert.deepEqual([stay.params, stay.eligible], [{ duration: null }, true]);
  assert.deepEqual(await run(env, signer, stay), { ok: true });
  assert.deepEqual(readState(env, NOW).manualPause, { since: NOW, until: null });
  const paused = await payload(env, signer);
  assert.equal(paused.actions.filter((a) => a.op === "pause").length, 0, "already paused until resumed");
  // Two hours on, the five-hour window has reset: the line is clear, the pause holds.
  const later = NOW + 2 * 3600_000;
  recordReading(env, { five_hour: { usedPct: 3, resetsAt: inHours(6), seenAt: later } });
  const after = await payload(env, signer, later);
  assert.equal(after.verdict.action, "pause");
  const resume = after.actions.find((a) => a.op === "resume" && a.params.duration === null);
  assert.deepEqual(await run(env, signer, resume, later), { ok: true });
  assert.equal((await payload(env, signer, later)).verdict.action, "none");
});

test("one Resume lifts a pause you added and the usage line under it at once", async () => {
  const { env } = home();
  const signer = tokenSigner();
  writeRules(env, [{ kind: "window", window: "five_hour", at: 90, action: "pause" }]);
  recordReading(env, { five_hour: { usedPct: 95, resetsAt: inHours(1), seenAt: NOW } });
  assert.deepEqual(await run(env, signer, (await payload(env, signer)).actions.find((a) => a.op === "pause")), { ok: true });
  const both = await payload(env, signer);
  assert.equal(both.reasons.length, 2);
  const resume = both.actions.find((a) => a.op === "resume" && a.params.duration === null);
  assert.deepEqual([...resume.lifts].sort(), both.reasons.map((r) => r.id).sort());
  assert.deepEqual(await run(env, signer, resume), { ok: true });
  assert.equal((await payload(env, signer)).verdict.action, "none");
  assert.equal(readState(env, NOW).manualPause, null);
});

test("the self-test is offered on each agent and refused, writing nothing, while setup is missing", async () => {
  const { env } = sandbox();
  const signer = tokenSigner();
  const row = (await payload(env, signer)).actions.find((a) => a.op === "protection.test");
  assert.deepEqual([row.params, row.eligible, row.disabledReason], [{}, false, "setup_missing"]);
  const result = await runOperation(env, { id: "t", op: "protection.test", provider: "claude", params: {} }, { now: NOW, signer });
  assert.equal(result.code, "setup_missing");
  assert.equal(fs.existsSync(path.join(env.PERAS_HOME, "protection-test.json")), false);
  const ready = home();
  assert.equal((await payload(ready.env, signer)).actions.find((a) => a.op === "protection.test").eligible, true);
});

test("the menu bar can show a filling pear, and 0.3 still reads a pear it knows", async () => {
  const { env } = sandbox();
  const signer = tokenSigner();
  const settings = () => settingsPayload(env, { now: NOW, sign: signer.sign });
  const look = (s, value) => s.actions.find((a) => a.op === "displayStyle.set" && a.params.value === value);
  const first = settings();
  assert.deepEqual([first.display, first.displayStyle], ["usage", "usage"]);
  assert.deepEqual(first.actions.filter((a) => a.op === "displayStyle.set").map((a) => a.params.value), ["pear", "fill"]);
  assert.deepEqual(await run(env, signer, look(first, "fill")), { ok: true });
  const record = JSON.parse(fs.readFileSync(path.join(env.PERAS_HOME, "menubar.json"), "utf8"));
  assert.deepEqual([record.display, record.fill], ["pear", true]);
  // SwiftBar and the 0.3 field see the pear alone; the app sees it fill.
  assert.deepEqual([displayMode(env), displayStyle(env), settings().display, settings().displayStyle], ["pear", "fill", "pear", "fill"]);
  assert.equal((await run(env, signer, look(first, "pear"))).code, "state_changed");
  // The two-way switch picks the plain pear, as its name says.
  setDisplayMode(env, "pear");
  assert.equal(displayStyle(env), "pear");
  assert.equal((await runOperation(env, { id: "x", op: "displayStyle.set", params: { value: "glow" }, actionToken: "t" }, { now: NOW, signer })).code, "state_changed");
});

test("after a week Peras saw roll over, the recap tells how far it got and how often Peras paused", async () => {
  const end = Math.floor((NOW - 6 * 3600_000) / 1000), endMs = end * 1000;
  const week = (pts) => ({ v: 1, windows: { seven_day: { resetsAt: end + 7 * 86400, pts: [[NOW - 3600_000, 1]] } }, weeks: [{ resetsAt: end, pts }], blame: null });
  const recap = async (env, now = NOW) => (await payload(env, tokenSigner(), now)).recap;
  const { env } = home();
  writeUsage(env, week([[endMs - 3 * 86400_000, 40], [endMs - 20 * 60_000, 88]]));
  recordEvent(env, { kind: "pause", provider: "claude", at: endMs - 86400_000, message: "line" });
  recordEvent(env, { kind: "pause", provider: "codex", at: endMs - 86400_000, message: "other agent" });
  recordEvent(env, { kind: "pause", provider: "claude", at: endMs - 8 * 86400_000, message: "the week before" });
  assert.deepEqual(await recap(env), { id: `claude:${end}`, weekEndedAtMs: endMs, usedPercent: 88, lastReadingAtMs: endMs - 20 * 60_000, atReset: true, pauses: 1, untilMs: endMs + RECAP_MS });
  assert.equal(await recap(env, endMs + RECAP_MS), null, "offered only in the days after the reset");
  // A last reading hours before the reset is said as such, and a cut history gives no pause count.
  const { env: early } = home();
  writeUsage(early, week([[endMs - 5 * 3600_000, 61]]));
  fs.writeFileSync(path.join(early.PERAS_HOME, "events.jsonl.previous"), `${JSON.stringify({ at: endMs - 2 * 86400_000, provider: "claude", kind: "warning", message: "kept" })}\n`);
  const r = await recap(early);
  assert.deepEqual([r.usedPercent, r.atReset, r.pauses], [61, false, null]);
  // A reset time that passed without a new week being read proves nothing.
  const { env: quiet } = home();
  writeUsage(quiet, { v: 1, windows: { seven_day: { resetsAt: end, pts: [[endMs - 3600_000, 70]] } }, weeks: [], blame: null });
  assert.equal(await recap(quiet), null);
});
