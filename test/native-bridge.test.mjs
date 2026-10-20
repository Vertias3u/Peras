import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { sandbox, NOW, inHours, VERSION } from "./helpers.mjs";
import fs from "node:fs";
import path from "node:path";
import { nativePayloads, runBridge } from "../src/native-bridge.mjs";
import { parseCommand, tokenSigner } from "../src/native-protocol.mjs";
import { writeBudgetRules } from "../src/allowances.mjs";
import { saveProfile, setPacing } from "../src/planning.mjs";
import { snapshot } from "../src/providers.mjs";
import { providerPayload } from "../src/native-protocol.mjs";
import { preferences } from "../src/preferences.mjs";
import { displayMode } from "../src/menubar.mjs";
import { installFile, pauseNow, readState, recordReading } from "../src/store.mjs";
import { codexEnv, installCodex } from "../src/codex.mjs";
import { install } from "../src/settings.mjs";

/** Tests never start the real Codex: its reader always fails, so Codex shows its last saved reading. */
const noCodex = async () => { throw new Error("no Codex in tests"); };

/** A bridge on fake streams; `next(type)` waits for the next message of that type. */
function start(t, env, options = {}) {
  const input = new PassThrough();
  const messages = [];
  let notify = () => {};
  let buffer = "";
  const output = new Writable({ write(chunk, _enc, done) {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf("\n")) >= 0) { messages.push(JSON.parse(buffer.slice(0, at))); buffer = buffer.slice(at + 1); }
    notify();
    done();
  } });
  const controller = new AbortController();
  let time = NOW;
  const done = runBridge({ env, input, output, runtimeVersion: "0.4.0-test", bridgeInstance: "b1", signal: controller.signal, clock: () => (time += 1000), intervalMs: 20, diagnose: () => {}, reader: noCodex, ...options });
  let read = 0;
  async function next(type) {
    for (;;) {
      const i = messages.findIndex((m, n) => n >= read && m.type === type);
      if (i >= 0) { read = i + 1; return messages[i]; }
      await new Promise((resolve) => { notify = resolve; });
    }
  }
  const send = (command) => input.write(`${typeof command === "string" ? command : JSON.stringify({ type: "command", protocol: 1, ...command })}\n`);
  const stop = async () => { controller.abort(); input.end(); await done; };
  t.after(stop);
  return { next, send, stop, messages };
}

test("the bridge says hello, then sends a snapshot only when something changed", { timeout: 5000 }, async (t) => {
  const { env } = sandbox();
  const b = start(t, env);
  const hello = await b.next("hello");
  assert.deepEqual(Object.keys(hello), ["type", "protocol", "bridgeInstance", "runtimeVersion", "environmentId"]);
  assert.ok(!JSON.stringify(hello).includes(env.HOME));
  const first = await b.next("snapshot");
  assert.equal(first.revision, 1);
  recordReading(env, { five_hour: { usedPct: 40, resetsAt: inHours(3), seenAt: NOW + 5000 } });
  const second = await b.next("snapshot");
  assert.equal(second.revision, 2);
  assert.equal(second.providers[0].windows[0].used, 40);
  // Nothing changes for a few ticks (the readings stay current): nothing is sent.
  const count = b.messages.length;
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(b.messages.length, count);
  await b.stop();
});

test("pause from the app pauses only that provider and shows up at once", { timeout: 5000 }, async (t) => {
  const { env } = sandbox();
  install({ env, command: HOOK, version: VERSION });
  installCodex(env, HOOK);
  const b = start(t, env, { intervalMs: 60_000 });
  const before = await b.next("snapshot");
  const offer = before.providers[1].actions.find((a) => a.op === "pause" && a.params.duration === "1h");
  b.send({ id: "p1", op: "pause", provider: "codex", params: { duration: "1h" }, actionToken: offer.actionToken });
  assert.deepEqual(await b.next("result"), { type: "result", protocol: 1, id: "p1", ok: true });
  const after = await b.next("snapshot");
  assert.equal(after.providers[1].verdict.action, "pause");
  assert.equal(after.providers[0].verdict.action, "none");
  assert.ok(readState(codexEnv(env), NOW).manualPause.until > NOW);
  assert.equal(readState(env, NOW).manualPause, null);
  await b.stop();
});

test("a profile that was never offered is refused, and the status page opens through the bridge", { timeout: 5000 }, async (t) => {
  const { env } = sandbox();
  const opened = [];
  const b = start(t, env, { operations: { openURL: async (url) => { opened.push(url); } } });
  await b.next("snapshot");
  b.send({ id: "u1", op: "profile.use", provider: "claude", params: { name: "Normal day" }, actionToken: "unbound-v0" });
  assert.deepEqual([(await b.next("result")).id, b.messages.at(-1).code], ["u1", "state_changed"]);
  b.send({ id: "s1", op: "status.open", params: {} });
  assert.deepEqual([(await b.next("result")).id, b.messages.at(-1).ok], ["s1", true]);
  assert.equal(opened.length, 1);
  assert.ok(opened[0].startsWith("file://") && opened[0].includes(encodeURI(env.PERAS_HOME)), opened[0]);
  await b.stop();
});

const HOOK = `"${process.execPath}" "${new URL("../bin/peras.mjs", import.meta.url).pathname}"`;
function protectedHome() {
  const box = sandbox();
  install({ env: box.env, command: HOOK, version: VERSION });
  installCodex(box.env, HOOK);
  return box;
}
const readBudgetMeters = async (env) => providerPayload(await snapshot(env, NOW + 60_000, { cwd: null }), { now: NOW + 60_000, sign: () => "t" }).planning.meters.map((m) => [m.limit, m.extra]);
const offered = (snap, provider, op, duration) => snap.providers.find((p) => p.id === provider).actions.find((a) => a.op === op && a.params.duration === duration);

test("a daily Extra from the app adds 3 points under the reviewed token and lifts today's stop", { timeout: 5000 }, async (t) => {
  const { env } = protectedHome();
  writeBudgetRules(env, [{ period: "daily", at: 10, action: "pause", createdAt: NOW - 6 * 3600_000 }]);
  recordReading(env, { seven_day: { usedPct: 40, resetsAt: inHours(72), seenAt: NOW - 2 * 3600_000 } });
  recordReading(env, { seven_day: { usedPct: 52, resetsAt: inHours(72), seenAt: NOW } });
  const b = start(t, env, { intervalMs: 60_000 });
  const before = await b.next("snapshot");
  assert.equal(before.providers[0].verdict.action, "pause");
  const extra = offered(before, "claude", "extra.daily", "1h");
  assert.equal(extra.eligible, true);
  b.send({ id: "x0", op: "extra.daily", provider: "claude", params: { points: 3, duration: "1h" }, actionToken: "unbound-v0" });
  assert.equal((await b.next("result")).code, "state_changed", "an unsigned token is refused");
  b.send({ id: "x1", op: "extra.daily", provider: "claude", params: { points: 3, duration: "1h" }, actionToken: extra.actionToken });
  assert.equal((await b.next("result")).ok, true);
  const after = await b.next("snapshot");
  assert.equal(after.providers[0].verdict.action, "none");
  assert.deepEqual(after.providers[0].planning.meters.map((m) => [m.limit, m.extra]), [[13, 3]]);
  // A double click sends the same token under a new id: the grant it made has spent it.
  b.send({ id: "x2", op: "extra.daily", provider: "claude", params: { points: 3, duration: "1h" }, actionToken: extra.actionToken });
  assert.equal((await b.next("result")).code, "state_changed");
  assert.notEqual(offered(after, "claude", "extra.daily", "1h").actionToken, extra.actionToken);
  await b.stop();
  assert.deepEqual(await readBudgetMeters(env), [[13, 3]], "still one Extra");
});

test("a resume token clears only the pause it was shown, and dies with its bridge", { timeout: 5000 }, async (t) => {
  const { env } = protectedHome();
  pauseNow(env, { now: NOW - 60_000 });
  const b = start(t, env, { intervalMs: 60_000, notReady: new Set() });
  const first = offered(await b.next("snapshot"), "claude", "resume", null);
  assert.equal(first.eligible, true);
  // A newer pause arrives (say from the CLI) before the click: the old token no longer names it.
  pauseNow(env, { now: NOW + 500, until: NOW + 3 * 3600_000 });
  b.send({ id: "r1", op: "resume", provider: "claude", params: { duration: null }, actionToken: first.actionToken });
  assert.equal((await b.next("result")).code, "state_changed");
  assert.ok(readState(env, NOW + 1000).manualPause, "the newer pause stands");
  await b.stop();

  const other = start(t, env, { intervalMs: 60_000, notReady: new Set() });
  const fresh = offered(await other.next("snapshot"), "claude", "resume", null);
  other.send({ id: "r2", op: "resume", provider: "claude", params: { duration: null }, actionToken: fresh.actionToken });
  assert.equal((await other.next("result")).ok, true);
  assert.equal(readState(env, NOW + 5000).manualPause, null);
  assert.equal(readState(codexEnv(env), NOW + 5000).manualPause, null, "Codex was never paused");
  await other.stop();
  const third = start(t, env, { intervalMs: 60_000, notReady: new Set() });
  await third.next("snapshot");
  pauseNow(env, { now: NOW + 9000 });
  third.send({ id: "r3", op: "resume", provider: "claude", params: { duration: null }, actionToken: fresh.actionToken });
  assert.equal((await third.next("result")).code, "state_changed", "another bridge's token");
  await third.stop();
});

test("building the app's snapshot writes only what the 0.3 menu bar's monitoring writes, never a control", { timeout: 5000 }, async () => {
  const { env, root } = protectedHome();
  setPacing(env, { days: [0, 1, 2, 3, 4, 5, 6], reserve: 20, action: "pause" });
  recordReading(env, { five_hour: { usedPct: 30, resetsAt: inHours(2), seenAt: NOW }, seven_day: { usedPct: 50, resetsAt: inHours(48), seenAt: NOW } });
  pauseNow(env, { now: NOW - 60_000 });
  const files = () => Object.fromEntries(fs.readdirSync(root, { recursive: true }).filter((f) => fs.statSync(path.join(root, f)).isFile()).map((f) => [f, fs.readFileSync(path.join(root, f), "utf8")]));
  const before = files();
  // A successful Codex read: the snapshot saves it, exactly as `peras menubar stream` does each second.
  const reader = async () => ({ rateLimitsByLimitId: { codex: { limitId: "codex", primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: NOW / 1000 + 7200 }, secondary: { usedPercent: 34, windowDurationMins: 10080, resetsAt: NOW / 1000 + 300000 } } } });
  await nativePayloads(env, NOW, { signer: tokenSigner(), reader });
  const after = files();
  const changed = Object.keys(after).filter((f) => after[f] !== before[f]).map((f) => f.replace(/[0-9a-f]{12}/g, "<key>")).sort();
  // Monitoring: Codex's reading and its accounting, and today's pacing anchor (which the hooks would save the same way).
  const MONITORING = ["peras/allowances/<key>.json", "peras/codex/<key>-rate-limits.json", "peras/codex/<key>-refresh.json", "peras/planning/<key>.json", "peras/usage/<key>.json", "peras/windows/<key>.json"];
  assert.deepEqual(changed.filter((f) => !MONITORING.includes(f)), [], "nothing outside monitoring");
  const state = Object.keys(after).filter((f) => /peras\/state\//.test(f));
  assert.ok(state.length && state.every((f) => after[f] === before[f]), "pauses and resumes untouched");
  assert.ok(changed.includes("peras/planning/<key>.json") && changed.includes("peras/windows/<key>.json"), "the test does reach both writers");
});

test("settings change only as offered, under the token naming today's value", { timeout: 5000 }, async (t) => {
  const { env } = sandbox();
  const b = start(t, env, { intervalMs: 60_000 });
  const snap = await b.next("snapshot");
  assert.deepEqual([snap.settings.preferences.mascots, snap.settings.display], [true, "usage"]);
  const mascots = snap.settings.actions.find((a) => a.op === "preference.set" && a.params.name === "mascots");
  const display = snap.settings.actions.find((a) => a.op === "display.set");
  assert.deepEqual([mascots.params, display.params], [{ name: "mascots", value: false }, { value: "pear" }]);
  b.send({ id: "m0", op: "preference.set", params: { name: "mascots", value: false }, actionToken: "unbound-v0" });
  assert.equal((await b.next("result")).code, "state_changed", "no unsigned settings changes");
  b.send({ id: "m1", op: "preference.set", params: { name: "mascots", value: false }, actionToken: mascots.actionToken });
  b.send({ id: "d1", op: "display.set", params: { value: "pear" }, actionToken: display.actionToken });
  assert.equal((await b.next("result")).ok, true);
  assert.equal((await b.next("result")).ok, true);
  assert.equal(preferences(env).mascots, false);
  assert.equal(displayMode(env), "pear");
  // The same click again names a value that is no longer today's.
  b.send({ id: "d2", op: "display.set", params: { value: "pear" }, actionToken: display.actionToken });
  assert.equal((await b.next("result")).code, "state_changed");
  await b.stop();
});

test("the week's style changes through the bridge and the next snapshot shows it", { timeout: 5000 }, async (t) => {
  const { env } = sandbox();
  const b = start(t, env, { intervalMs: 60_000 });
  const snap = await b.next("snapshot");
  assert.equal(snap.settings.weeklyStyle, "bar");
  const text = snap.settings.actions.find((a) => a.op === "weeklyStyle.set" && a.params.value === "text");
  b.send({ id: "w1", op: "weeklyStyle.set", params: { value: "text" }, actionToken: text.actionToken });
  assert.equal((await b.next("result")).ok, true);
  assert.equal((await b.next("snapshot")).settings.weeklyStyle, "text");
  await b.stop();
});

test("an inherited name like constructor is an unknown operation, and the bridge keeps going", { timeout: 5000 }, async (t) => {
  const { env } = sandbox();
  const b = start(t, env, { intervalMs: 60_000 });
  await b.next("snapshot");
  for (const op of ["constructor", "__proto__", "toString", 7]) {
    b.send({ id: "i1", op, params: {}, actionToken: "t" });
    assert.equal((await b.next("result")).code, "unknown_op", String(op));
  }
  b.send({ id: "i2", op: "display.set", params: { value: "pear" }, actionToken: "t" });
  assert.equal((await b.next("result")).code, "state_changed", "still answering");
  await b.stop();
});

test("starting the bridge never updates hooks or prints before hello", { timeout: 15000 }, async () => {
  const { spawnSync } = await import("node:child_process");
  const { env, root } = sandbox();
  install({ env, command: HOOK, version: "0.0.1" });
  const record = () => fs.readFileSync(installFile(env), "utf8") + fs.readFileSync(path.join(env.CLAUDE_CONFIG_DIR, "settings.json"), "utf8");
  const before = record();
  const r = spawnSync(process.execPath, [new URL("../bin/peras.mjs", import.meta.url).pathname, "menubar", "bridge", "--protocol", "1"], { env: { ...env, PATH: path.join(root, "no-codex") }, input: "", encoding: "utf8", timeout: 10000 });
  assert.equal(JSON.parse(r.stdout.split("\n")[0]).type, "hello");
  assert.ok(r.stdout.trim().split("\n").every((line) => JSON.parse(line)), "JSON lines only");
  assert.equal(record(), before, "hooks left as they were");
});

test("a stale, ineligible or retried command gets a typed answer and changes nothing twice", { timeout: 5000 }, async (t) => {
  const { env } = sandbox();
  const b = start(t, env, { intervalMs: 60_000 });
  const snap = await b.next("snapshot");
  assert.ok(snap.providers.every((p) => p.health.state === "setup_missing"));
  b.send({ id: "a", op: "pause", provider: "claude", params: { duration: null }, actionToken: "unbound-v0" });
  assert.equal((await b.next("result")).code, "setup_missing", "no hooks: a pause would not hold");
  b.send({ id: "a", op: "pause", provider: "claude", params: { duration: null }, actionToken: "unbound-v0" });
  assert.equal((await b.next("result")).code, "setup_missing", "the same id gets the same answer");
  b.send({ id: "a", op: "pause", provider: "codex", params: { duration: null }, actionToken: "unbound-v0" });
  assert.equal((await b.next("result")).code, "id_reused");
  b.send({ id: "b", op: "resume", provider: "claude", params: { duration: "2h" }, actionToken: "t" });
  assert.equal((await b.next("result")).code, "bad_params");
  b.send("not json");
  assert.deepEqual(await b.next("result"), { type: "result", protocol: 1, id: null, ok: false, code: "bad_json", message: "The command is not JSON." });
  b.send({ id: "c", op: "rm", params: {} });
  assert.equal((await b.next("result")).code, "unknown_op");
  await b.stop();
});

test("the bridge stops when the app closes its input", { timeout: 5000 }, async () => {
  const { env } = sandbox();
  const input = new PassThrough();
  const output = new Writable({ write(_c, _e, done) { done(); } });
  const done = runBridge({ env, input, output, runtimeVersion: "t", intervalMs: 60_000, diagnose: () => {}, reader: noCodex });
  setTimeout(() => input.end(), 20);
  await done;
});

test("the bridge exits once setup installs another version, so the app restarts it on the new code", { timeout: 5000 }, async () => {
  const { env } = sandbox();
  const write = (version) => { fs.mkdirSync(path.dirname(installFile(env)), { recursive: true }); fs.writeFileSync(installFile(env), JSON.stringify({ version })); };
  write("0.4.0");
  const notes = [];
  const output = new Writable({ write(_c, _e, done) { done(); } });
  const done = runBridge({ env, input: new PassThrough(), output, runtimeVersion: "0.4.0", intervalMs: 10, diagnose: (text) => notes.push(text), reader: noCodex });
  setTimeout(() => write("0.4.1"), 40);
  await done;
  assert.ok(notes.some((text) => text.includes("was updated")));
});

test("an unreadable state file is reported once, not on every tick", { timeout: 5000 }, async () => {
  const { env } = sandbox();
  const notes = [];
  const input = new PassThrough();
  const output = new Writable({ write(_c, _e, done) { done(); } });
  const done = runBridge({ env, input, output, runtimeVersion: "t", intervalMs: 5, diagnose: (text) => notes.push(text), reader: noCodex,
    getPayloads: async () => { throw new Error("config.json is not JSON"); } });
  setTimeout(() => input.end(), 80);
  await done;
  assert.deepEqual(notes.filter((text) => text.includes("could not read")), ["peras bridge: could not read provider state (config.json is not JSON)"]);
});

test("commands cannot name a path, a URL or a provider an operation does not take", () => {
  const command = (fields) => JSON.stringify({ type: "command", protocol: 1, id: "q", actionToken: "t", ...fields });
  for (const bad of [
    { op: "failurePolicy.set", provider: "codex", params: { policy: "strict" } },
    { op: "display.set", provider: "claude", params: { value: "pear" } },
    { op: "preference.set", params: { name: "mascots", value: "on" } },
    { op: "pause", provider: "claude", params: { duration: "1h", cwd: "/tmp" } },
    { op: "settings.open", params: { url: "https://example.com" } },
    { op: "pause", provider: "claude", params: { duration: null }, actionToken: "" },
  ]) assert.throws(() => parseCommand(command(bad)), (e) => e.code === "bad_params", JSON.stringify(bad));
  assert.throws(() => parseCommand(command({ protocol: 2, op: "pause" })), (e) => e.code === "protocol");
  assert.throws(() => parseCommand("x".repeat(65 * 1024)), (e) => e.code === "too_large");
});
