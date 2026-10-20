import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { sandbox, NOW, inHours, VERSION } from "./helpers.mjs";
import { install, settingsPath } from "../src/settings.mjs";
import { snapshot } from "../src/providers.mjs";
import { providerPayload, tokenSigner } from "../src/native-protocol.mjs";
import { runOperation } from "../src/native-operations.mjs";
import { readRules, recordReading, resume, writeRules } from "../src/store.mjs";
import { DEFAULT_RULES } from "../src/rules.mjs";
import { saveProfile, profileSummary } from "../src/planning.mjs";
import { failurePolicy } from "../src/failure-policy.mjs";
import { writeBudgetRules } from "../src/allowances.mjs";
import { localDay } from "../src/calendar.mjs";
import { activeExtras } from "../src/planning.mjs";

const HOOK = `"${process.execPath}" "${new URL("../bin/peras.mjs", import.meta.url).pathname}"`;
const home = () => { const box = sandbox(); install({ env: box.env, command: HOOK, version: VERSION }); return box; };
const payload = async (env, signer, now = NOW) => providerPayload(await snapshot(env, now, { cwd: null }), { now, sign: signer.sign });
const offer = (p, op, test = () => true) => p.actions.find((a) => a.op === op && test(a));
const run = (env, signer, a, options = {}) => runOperation(env, { id: "c", op: a.op, provider: a.provider, params: a.params, actionToken: a.actionToken }, { now: NOW, signer, claudeVersion: () => assert.fail("claude --version was not expected"), ...options });

test("each usage line says where it stands: clear, crossed, lifted until, or outside its hours", async () => {
  const { env } = home();
  writeRules(env, [{ kind: "window", window: "seven_day", at: 40, action: "pause" }, { kind: "window", window: "seven_day", at: 30, action: "warn" }, { kind: "window", window: "seven_day", at: 90, action: "pause" }, { kind: "window", window: "five_hour", at: 10, action: "pause", during: "03:00-04:00" }]);
  recordReading(env, { seven_day: { usedPct: 50, resetsAt: inHours(48), seenAt: NOW }, five_hour: { usedPct: 60, resetsAt: inHours(2), seenAt: NOW } });
  const states = async () => (await payload(env, tokenSigner())).thresholds.map((t) => [t.window, t.at, t.state, t.liftedUntilMs ?? null]);
  const before = await states();
  assert.deepEqual(before.filter(([w]) => w === "seven_day"), [["seven_day", 40, "crossed", null], ["seven_day", 30, "crossed", null], ["seven_day", 90, "clear", null]]);
  assert.equal(before.find(([w]) => w === "five_hour")[2], "inactive", "NOW is 12:00 UTC, outside 03:00-04:00");
  resume(env, { now: NOW, forMs: 3600_000 });
  assert.deepEqual((await states()).find(([, at]) => at === 40), ["seven_day", 40, "lifted", NOW + 3600_000]);
  resume(env, { now: NOW });
  assert.deepEqual((await states()).find(([, at]) => at === 40), ["seven_day", 40, "lifted", inHours(48) * 1000], "lifted until the reset");
});

test("profile.use runs only the profile that was reviewed, by its wire label", async () => {
  const { env } = home();
  writeRules(env, [...DEFAULT_RULES, { kind: "window", window: "seven_day", at: 50, action: "pause" }]);
  saveProfile(env, "Work/heavy");
  writeRules(env, DEFAULT_RULES);
  saveProfile(env, "Light");
  const signer = tokenSigner();
  const p = await payload(env, signer);
  assert.deepEqual(p.profiles.names, ["Light", "Profile 2"]);
  assert.equal(offer(p, "profile.use", (a) => a.params.name === "Light"), undefined, "the profile in use, unchanged, is not offered");
  const heavy = offer(p, "profile.use", (a) => a.params.name === "Profile 2");
  assert.ok(heavy?.eligible);
  // Edited after it was reviewed: the old token is spent.
  writeRules(env, [...DEFAULT_RULES, { kind: "window", window: "seven_day", at: 60, action: "pause" }]);
  saveProfile(env, "Work/heavy");
  writeRules(env, DEFAULT_RULES);
  saveProfile(env, "Light");
  assert.equal((await run(env, signer, heavy)).code, "state_changed");
  const fresh = offer(await payload(env, signer), "profile.use", (a) => a.params.name === "Profile 2");
  assert.deepEqual(await run(env, signer, fresh), { ok: true });
  assert.ok(readRules(env).some((r) => r.at === 60));
  assert.equal(profileSummary(env).active, "Work/heavy");
});

test("strict from the app: checks the version at the click, writes the hook, and offers the way back", async () => {
  const { env } = home();
  const signer = tokenSigner();
  const on = offer(await payload(env, signer), "failurePolicy.set");
  assert.deepEqual([on.params, on.eligible], [{ policy: "strict" }, true]);
  assert.deepEqual(await run(env, signer, on, { claudeVersion: () => "2.1.294" }), { ok: false, code: "requires_upgrade", message: "Strict mode needs a newer Claude Code." });
  assert.equal(failurePolicy(env).mode, "default", "nothing written");
  assert.equal(offer(await payload(env, signer), "failurePolicy.set").eligible, true, "a refused check writes nothing, not even the version");
  // A version recorded as too old shows the requirement instead of a switch.
  install({ env, command: HOOK, version: VERSION, claudeVersion: "2.1.200" });
  const old = offer(await payload(env, signer), "failurePolicy.set");
  assert.deepEqual([old.eligible, old.disabledReason], [false, "requires_upgrade"]);
  install({ env, command: HOOK, version: VERSION, claudeVersion: "2.1.302" });
  const retry = offer(await payload(env, signer), "failurePolicy.set");
  assert.deepEqual(await run(env, signer, retry, { claudeVersion: () => "2.1.302" }), { ok: true });
  assert.equal(failurePolicy(env).mode, "strict");
  assert.match(fs.readFileSync(settingsPath(env), "utf8"), /"onFailure": "block"/);
  assert.equal((await run(env, signer, on, { claudeVersion: () => "2.1.302" })).code, "state_changed", "an on-token is refused while strict is on");
  const off = offer(await payload(env, signer), "failurePolicy.set");
  assert.deepEqual(off.params, { policy: "default" });
  assert.deepEqual(await run(env, signer, off), { ok: true }, "turning off checks nothing");
  assert.equal(failurePolicy(env).mode, "default");
});

test("Codex is never offered strict", async () => {
  const { env } = home();
  const codex = providerPayload(await snapshot(env, NOW, { provider: "codex", cwd: null }), { now: NOW, sign: () => "t" });
  assert.equal(offer(codex, "failurePolicy.set"), undefined);
});

test("the self-test runs from the app and records its result", async () => {
  const { env } = home();
  const result = await runOperation(env, { id: "t", op: "protection.test", provider: "claude", params: {} }, { now: NOW, signer: tokenSigner() });
  assert.deepEqual(result, { ok: true });
  assert.equal(JSON.parse(fs.readFileSync(`${env.PERAS_HOME}/protection-test.json`, "utf8")).passed, true);
});

test("a reason's used and at share a unit: the rise for a prompt line, the percentage for a window or pace line, points for an allowance", async () => {
  const { env } = home();
  writeRules(env, [{ kind: "window", window: "seven_day", at: 40, action: "warn" }, { kind: "prompt", window: "seven_day", at: 3, action: "pause" }]);
  recordReading(env, { seven_day: { usedPct: 47, resetsAt: inHours(48), seenAt: NOW } });
  const { readState, writeHookState } = await import("../src/store.mjs");
  const state = readState(env, NOW);
  state.prompts.s1 = { id: "p1", t: NOW - 60_000, seven_day: 42 };
  writeHookState(env, state, NOW);
  const reasons = (await payload(env, tokenSigner())).reasons.map((r) => [r.kind, r.used, r.at, r.unit]);
  assert.deepEqual(reasons.find(([kind]) => kind === "prompt"), ["prompt", 5, 3, "points"]);
  assert.deepEqual(reasons.find(([kind]) => kind === "window"), ["window", 47, 40, "percent"]);
  // A pace line is a window percentage too; an allowance meter counts points.
  const s = await snapshot(env, NOW, { cwd: null });
  s.verdict.hits.push({ kind: "pace", window: "seven_day", at: 30, action: "warn", usedPct: 47, resetsAt: inHours(48), key: "pace@1" }, { kind: "pacing", window: "seven_day", at: 6, action: "pause", usedPct: 7, resetsAt: inHours(10), key: "allowance:x:6@1" });
  const units = providerPayload(s, { now: NOW, sign: () => "t" }).reasons.map((r) => [r.kind, r.used, r.at, r.unit]);
  assert.deepEqual(units.filter(([kind]) => kind.startsWith("pac")), [["pace", 47, 30, "percent"], ["pacing", 7, 6, "points"]]);
});

test("the app's Extra just before local midnight ends at midnight, and a click that lands after it is refused", async () => {
  const { env } = home();
  const midnight = localDay(NOW).end, late = midnight - 30_000, after = midnight + 30_000;
  writeBudgetRules(env, [{ period: "daily", at: 10, action: "pause", createdAt: late - 6 * 3600_000 }]);
  recordReading(env, { seven_day: { usedPct: 52, resetsAt: inHours(72), seenAt: late - 60_000 } });
  const signer = tokenSigner();
  const reviewed = offer(await payload(env, signer, late), "extra.daily");
  assert.deepEqual([reviewed.eligible, reviewed.expiresAtMs], [true, midnight], "until midnight, not an hour later");
  assert.equal((await run(env, signer, reviewed, { now: after })).code, "state_changed", "reviewed for yesterday");
  assert.deepEqual(activeExtras(env, after, { resetsAt: inHours(72) }), [], "nothing granted");
  const fresh = offer(await payload(env, signer, after), "extra.daily");
  assert.ok(fresh.expiresAtMs >= after + 3600_000 && fresh.expiresAtMs < after + 3660_000, "today's runs its hour, to the next whole minute");
  assert.deepEqual(await run(env, signer, fresh, { now: after }), { ok: true });
});

test("the app's Extra ends at the weekly reset if that comes first, and a click after the reset is refused", async () => {
  const { env } = home();
  const resetsAt = Math.floor(NOW / 1000) + 20 * 60;
  writeBudgetRules(env, [{ period: "daily", at: 10, action: "pause", createdAt: NOW - 6 * 3600_000 }]);
  recordReading(env, { seven_day: { usedPct: 52, resetsAt, seenAt: NOW - 60_000 } });
  const signer = tokenSigner();
  const reviewed = offer(await payload(env, signer), "extra.daily");
  assert.equal(reviewed.expiresAtMs, resetsAt * 1000);
  const late = await run(env, signer, reviewed, { now: resetsAt * 1000 + 60_000 });
  assert.equal(late.ok, false);
  assert.deepEqual(activeExtras(env, resetsAt * 1000 + 60_000, { resetsAt }), [], "nothing granted");
});

test("an unreadable line config or planning file still sends the snapshot, flagged, and Pause still works", async () => {
  const { nativePayloads } = await import("../src/native-bridge.mjs");
  const { snapshotMessage, snapshotProblems } = await import("../src/native-protocol.mjs");
  const { configFile, dirKey } = await import("../src/store.mjs");
  for (const broken of [configFile, (env) => `${env.PERAS_HOME}/planning/${dirKey(env)}.json`]) {
    const { env } = home();
    saveProfile(env, "Normal day");
    recordReading(env, { five_hour: { usedPct: 30, resetsAt: inHours(3), seenAt: NOW }, seven_day: { usedPct: 40, resetsAt: inHours(48), seenAt: NOW } });
    const file = broken(env);
    fs.writeFileSync(file, "{ not json");
    const signer = tokenSigner();
    const providers = await nativePayloads(env, NOW, { reader: async () => { throw new Error("no codex"); }, signer });
    assert.deepEqual(snapshotProblems(snapshotMessage({ bridgeInstance: "b", revision: 1, now: NOW, providers })), [], file);
    const [claude] = providers;
    assert.equal(claude.readError, true, file);
    assert.deepEqual(claude.windows.map((w) => w.used), [30, 40], "the readings still show");
    assert.deepEqual(claude.profiles, { names: [], active: null, modified: false });
    assert.equal(offer(claude, "profile.use"), undefined, "no profile goes back over a file nobody can read");
    const pause = offer(claude, "pause", (a) => a.params.duration === "1h");
    assert.equal(pause.eligible, true);
    assert.equal((await run(env, signer, pause)).ok, true);
    assert.equal(fs.readFileSync(file, "utf8"), "{ not json", "the broken file is left as it was");
  }
});
