import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { sandbox, NOW, inHours, VERSION } from "./helpers.mjs";
import { ControlsBusy, withControlLock } from "../src/control-lock.mjs";
import { ControlsChanged, commitResume, pauseNow, planResume, readState, recordReading, resume, stateFile, context, writeRules } from "../src/store.mjs";
import { DEFAULT_RULES } from "../src/rules.mjs";
import { install } from "../src/settings.mjs";
import { snapshot } from "../src/providers.mjs";
import { providerPayload, resultMessage, tokenSigner } from "../src/native-protocol.mjs";
import { runOperation } from "../src/native-operations.mjs";

const lockOf = (env) => `${stateFile(env)}.controls.lock`;
const HOOK = `"${process.execPath}" "${new URL("../bin/peras.mjs", import.meta.url).pathname}"`;

test("B01: a newer pause landing after the click was checked is not replaced by the older click", async () => {
  const { env } = sandbox();
  install({ env, command: HOOK, version: VERSION });
  const signer = tokenSigner();
  const offer = providerPayload(await snapshot(env, NOW, { cwd: null }), { now: NOW, sign: signer.sign }).actions.find((a) => a.op === "pause" && a.params.duration === "1h");
  // Just before the click's save takes the lock, someone pauses until resumed (the CLI, another app window).
  const open = fs.openSync;
  let inserted = false;
  fs.openSync = function (file, ...rest) {
    if (!inserted && file === lockOf(env)) { inserted = true; pauseNow(env, { now: NOW + 1 }); }
    return open.call(this, file, ...rest);
  };
  let result;
  try { result = await runOperation(env, { id: "c", op: "pause", provider: "claude", params: offer.params, actionToken: offer.actionToken }, { now: NOW, signer }); }
  finally { fs.openSync = open; }
  assert.ok(inserted);
  assert.equal(result.code, "state_changed");
  assert.deepEqual(readState(env, NOW + 2).manualPause, { since: NOW + 1, until: null }, "the newer pause stands");
});

test("a held lock answers the app's pause with busy, and the bridge sends it as a result", async () => {
  const { env } = sandbox();
  install({ env, command: HOOK, version: VERSION });
  const signer = tokenSigner();
  const offer = providerPayload(await snapshot(env, NOW, { cwd: null }), { now: NOW, sign: signer.sign }).actions.find((a) => a.op === "pause");
  fs.mkdirSync(stateFile(env).replace(/[^/]+$/, ""), { recursive: true });
  fs.writeFileSync(lockOf(env), `${process.pid} someone-else`);
  const result = await runOperation(env, { id: "c", op: "pause", provider: "claude", params: offer.params, actionToken: offer.actionToken }, { now: NOW, signer });
  assert.equal(result.code, "busy");
  assert.deepEqual(resultMessage({ id: "c", ...result }), { type: "result", protocol: 1, id: "c", ok: false, code: "busy", message: result.message });
  assert.equal(readState(env, NOW).manualPause, null);
});

test("a reviewed resume is refused when its pause or the lifts it replaces changed; the CLI's resume is not", () => {
  const { env } = sandbox();
  writeRules(env, [...DEFAULT_RULES, { kind: "window", window: "seven_day", at: 40, action: "pause" }]);
  recordReading(env, { seven_day: { usedPct: 50, resetsAt: inHours(48), seenAt: NOW } });
  resume(env, { now: NOW, forMs: 3600_000 });
  const state = readState(env, NOW + 1000);
  const plan = planResume(state, context(env, { now: NOW + 1000, state }), { now: NOW + 1000, forMs: 2 * 3600_000 });
  assert.equal(plan.replaced.length, 1);
  // Another resume replaces the same lift first.
  resume(env, { now: NOW + 2000 });
  assert.throws(() => commitResume(env, plan, { now: NOW + 3000, forMs: 2 * 3600_000, reviewed: true }), ControlsChanged);
  assert.equal(readState(env, NOW + 4000).resumed[0].until, undefined, "the other resume stands");
  pauseNow(env, { now: NOW + 5000 });
  assert.equal(resume(env, { now: NOW + 6000 }).manual.since, NOW + 5000, "an unreviewed resume clears whatever pause is there, as before");
});

test("a lock held by a running process makes a control writer busy, never a lost write", () => {
  const { env } = sandbox();
  fs.mkdirSync(stateFile(env).replace(/[^/]+$/, ""), { recursive: true });
  fs.writeFileSync(lockOf(env), `${process.pid} someone-else`);
  assert.throws(() => withControlLock(stateFile(env), () => assert.fail("ran without the lock"), { attempts: 3, waitMs: 1 }), ControlsBusy);
  assert.equal(fs.readFileSync(lockOf(env), "utf8"), `${process.pid} someone-else`, "the live owner keeps it");
  fs.writeFileSync(lockOf(env), "");
  assert.throws(() => withControlLock(stateFile(env), () => {}, { attempts: 3, waitMs: 1 }), ControlsBusy, "a lock being named right now is left alone");
});

test("a lock left by a process that ended is taken over, and released after", () => {
  const { env } = sandbox();
  const ended = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }).stdout;
  fs.mkdirSync(stateFile(env).replace(/[^/]+$/, ""), { recursive: true });
  fs.writeFileSync(lockOf(env), `${ended} gone`);
  pauseNow(env, { now: NOW });
  assert.equal(readState(env, NOW).manualPause.since, NOW);
  assert.equal(fs.existsSync(lockOf(env)), false);
});

test("two processes pausing at once both finish, one after the other", () => {
  const { env } = sandbox();
  const code = (now) => `const { pauseNow } = await import(${JSON.stringify(new URL("../src/store.mjs", import.meta.url).href)}); for (let i = 0; i < 25; i++) pauseNow(JSON.parse(process.env.E), { now: ${now} + i });`;
  const run = (now) => new Promise((resolve) => {
    const child = import("node:child_process").then(({ spawn }) => spawn(process.execPath, ["--input-type=module", "-e", code(now)], { env: { ...env, E: JSON.stringify(env) }, stdio: ["ignore", "ignore", "pipe"] }));
    child.then((c) => { let err = ""; c.stderr.on("data", (d) => (err += d)); c.on("close", (status) => resolve({ status, err })); });
  });
  return Promise.all([run(NOW), run(NOW + 1000)]).then((results) => {
    for (const r of results) assert.equal(r.status, 0, r.err);
    assert.ok([NOW + 24, NOW + 1024].includes(readState(env, NOW).manualPause.since));
    assert.equal(fs.existsSync(lockOf(env)), false);
  });
});
