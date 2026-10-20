import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { sandbox, NOW, inHours } from "./helpers.mjs";
import { providerPayload, snapshotMessage, snapshotProblems } from "../src/native-protocol.mjs";
import { snapshot } from "../src/providers.mjs";
import { recordReading, writeRules } from "../src/store.mjs";
import { DEFAULT_RULES } from "../src/rules.mjs";
import { saveProfile } from "../src/planning.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const DIR = path.join(ROOT, "test", "fixtures", "native-v1");
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(DIR, `${name}.json`), "utf8"));
const NAMES = ["missing-setup", "normal-usage", "manual-pause", "scoped-stop", "daily-exhausted", "suggestion-pause", "pacing-text", "weekly-recap"];
const strings = (value) => (typeof value === "string" ? [value] : value && typeof value === "object" ? Object.values(value).flatMap(strings) : []);

test("the native fixtures are what the code makes today", () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", "native-fixtures.mjs"), "--check"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
});

test("every native fixture is a valid protocol-1 snapshot with nothing local in it", () => {
  for (const name of NAMES) {
    const message = fixture(name);
    assert.deepEqual(snapshotProblems(message), [], name);
    assert.deepEqual(message.providers.map((p) => p.id), ["claude", "codex"], name);
    for (const text of strings(message)) assert.ok(!text.includes("/") && !/\bUsers\b|\.peras|\.claude|\.codex/.test(text), `${name}: ${text}`);
  }
});

test("a Claude-only manual pause leaves the Codex payload exactly as it was", () => {
  const paused = fixture("manual-pause"), normal = fixture("normal-usage");
  assert.deepEqual(paused.providers[1], normal.providers[1]);
  const claude = paused.providers[0];
  assert.equal(claude.verdict.action, "pause");
  assert.deepEqual(claude.reasons.map((r) => r.code), ["manual_pause"]);
  assert.deepEqual(claude.actions.filter((a) => a.op === "resume").map((a) => a.params.duration), [null, "1h"]);
  assert.deepEqual(claude.actions.map((a) => a.op).filter((op) => op !== "resume"), ["protection.test", "failurePolicy.set"], "no pause while paused");
  assert.deepEqual(claude.actions[0].lifts, [claude.reasons[0].id]);
  assert.ok(claude.actions.every((a) => a.eligible && a.disabledReason === null), "resume is ready under its token");
  assert.ok(normal.providers.every((p) => p.actions.every((a) => a.eligible)), "pause is ready");
});

test("the fixtures cover a project stop, a used-up day, a missing Codex window and missing setup", () => {
  const scoped = fixture("scoped-stop").providers[0].reasons[0];
  assert.equal(scoped.scope, "project");
  assert.equal(scoped.project.label, "launch-site");
  const daily = fixture("daily-exhausted").providers;
  assert.equal(daily[0].reasons[0].code, "daily_pause");
  assert.deepEqual(daily[0].planning.meters.map((m) => [m.kind, m.spent, m.limit, m.remaining]), [["daily", 12, 10, 0]]);
  assert.ok(daily[0].actions.some((a) => a.op === "extra.daily" && a.params.points === 3 && a.params.duration === "1h"));
  assert.deepEqual(daily[1].windows.map((w) => w.freshness), ["missing", "current"]);
  for (const p of fixture("missing-setup").providers) {
    assert.equal(p.health.state, "setup_missing");
    assert.ok(p.actions.every((a) => !a.eligible && a.disabledReason === "setup_missing"));
  }
});

test("an expired window says so instead of looking current, and an old one is stale", async () => {
  const { env } = sandbox();
  recordReading(env, { five_hour: { usedPct: 80, resetsAt: NOW / 1000 - 60, seenAt: NOW - 3 * 3600_000 }, seven_day: { usedPct: 50, resetsAt: inHours(48), seenAt: NOW - 20 * 60_000 } });
  const p = providerPayload(await snapshot(env, NOW, { cwd: null }), { now: NOW, sign: () => "tok_test" });
  assert.deepEqual(p.windows.map((w) => [w.window, w.used, w.freshness]), [["five_hour", 80, "expired"], ["seven_day", 50, "stale"]]);
  assert.equal(p.windows[0].resetsAtMs, NOW - 60_000, "reset seconds become milliseconds once");
});

test("a project line judges observed sessions, not the folder the bridge was started in", async () => {
  const { env, root } = sandbox();
  writeRules(env, [...DEFAULT_RULES, { kind: "window", window: "seven_day", at: 40, action: "pause", project: fs.realpathSync(root) }]);
  recordReading(env, { seven_day: { usedPct: 50, resetsAt: inHours(48), seenAt: NOW } });
  assert.equal((await snapshot(env, NOW, { cwd: root })).verdict.action, "pause", "the CLI, run in that folder, sees the stop");
  assert.equal(providerPayload(await snapshot(env, NOW, { cwd: null }), { now: NOW, sign: () => "tok_test" }).verdict.action, "none");
});

test("snapshotProblems names what is wrong", () => {
  const good = fixture("normal-usage");
  assert.deepEqual(snapshotProblems(good), []);
  const bad = structuredClone(good);
  bad.providers[1].id = "claude";
  bad.providers[0].windows[0].used = 120;
  bad.providers[0].verdict.action = "pause";
  bad.revision = -1;
  assert.deepEqual(snapshotProblems(bad), ["revision", "providers[0].windows.five_hour.used", "providers[0].verdict matches reasons", "providers[1].id", "providers[1].actions"]);
  assert.deepEqual(snapshotProblems({ type: "hello" }), ["envelope"]);
  assert.deepEqual(snapshotProblems(snapshotMessage({ bridgeInstance: "b", revision: 0, now: NOW, providers: [] })), []);
});

test("a profile name that could be a folder goes out as Profile N", async () => {
  const { env } = sandbox();
  saveProfile(env, "Normal day");
  saveProfile(env, "/Users/someone/private-notes");
  const p = providerPayload(await snapshot(env, NOW, { cwd: null }), { now: NOW, sign: () => "tok_test" });
  assert.deepEqual(p.profiles.names, ["Profile 1", "Normal day"]);
  assert.equal(p.profiles.active, "Profile 1");
});
