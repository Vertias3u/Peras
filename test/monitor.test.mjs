import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { PassThrough, Writable } from "node:stream";
import { sandbox, NOW } from "./helpers.mjs";
import { STALE_MS, holdMonitor, releaseMonitor, runMonitor } from "../src/monitor.mjs";
import { checkResets } from "../src/reset-notifications.mjs";
import { setPreference } from "../src/preferences.mjs";
import { perasHome } from "../src/store.mjs";
import { runBridge, nativePayloads } from "../src/native-bridge.mjs";
import { streamMenubar } from "../src/menubar-stream.mjs";
import { tokenSigner } from "../src/native-protocol.mjs";

const lease = (env) => JSON.parse(fs.readFileSync(path.join(perasHome(env), "monitor-owner.json"), "utf8"));
const deadPid = () => spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }).stdout | 0;

test("one monitor at a time: the holder renews, a second waits, and takes over when the first lets go, ends or stops renewing", () => {
  const { env } = sandbox();
  const app = { id: "app", owner: "app" }, bar = { id: "bar", owner: "swiftbar" };
  assert.equal(holdMonitor(env, NOW, app), true);
  assert.equal(holdMonitor(env, NOW + 1000, bar), false, "the app holds it");
  assert.equal(holdMonitor(env, NOW + 1000, app), true, "and renews it");
  releaseMonitor(env, "bar");
  assert.equal(lease(env).id, "app", "letting go of a lease you don't hold changes nothing");
  releaseMonitor(env, "app");
  assert.equal(holdMonitor(env, NOW + 2000, bar), true, "free at once after letting go");
  assert.equal(holdMonitor(env, NOW + 2000 + STALE_MS, app), false, "not yet stale");
  assert.equal(holdMonitor(env, NOW + 2001 + STALE_MS, app), true, "a holder that stopped renewing loses it");
  // A holder that crashed without letting go: its process is gone.
  fs.writeFileSync(path.join(perasHome(env), "monitor-owner.json"), JSON.stringify({ id: "crashed", owner: "app", pid: deadPid(), at: NOW + 50_000 }));
  assert.equal(holdMonitor(env, NOW + 50_001, bar), true);
  fs.writeFileSync(path.join(perasHome(env), "monitor-owner.json"), "{ half");
  assert.equal(holdMonitor(env, NOW + 50_002, app), true, "a damaged lease is free");
});

test("the app and SwiftBar both running send a reset reminder once, and a restarted monitor doesn't repeat it", () => {
  const { env } = sandbox();
  setPreference(env, "resets", "on");
  const sent = [];
  const notify = (...args) => sent.push(args);
  const rows = (at) => [{ provider: "claude", ctx: { window: { five_hour: { resetsAt: at } } } }];
  const at = NOW / 1000 + 60;
  for (let t = NOW; t <= NOW + 120_000; t += 1000) {
    runMonitor(env, rows(at), t, { id: "app", owner: "app", notify });
    runMonitor(env, rows(at), t, { id: "bar", owner: "swiftbar", notify });
  }
  assert.equal(sent.length, 1);
  releaseMonitor(env, "app");
  runMonitor(env, rows(at), NOW + 121_000, { id: "app-again", owner: "app", notify });
  assert.equal(sent.length, 1, "a new owner reads what was sent");
});

test("a reset reminder is saved before it is sent: a monitor that dies while sending doesn't send it again", () => {
  const { env } = sandbox();
  setPreference(env, "resets", "on");
  const rows = [{ provider: "claude", ctx: { window: { five_hour: { resetsAt: NOW / 1000 + 60 } } } }];
  checkResets(env, rows, NOW, () => {});
  assert.throws(() => checkResets(env, rows, NOW + 61_000, () => { throw new Error("died sending"); }));
  const sent = [];
  checkResets(env, rows, NOW + 62_000, (...args) => sent.push(args));
  assert.equal(sent.length, 0);
});

test("the bridge holds the lease while it runs and lets go when the app closes it; SwiftBar's stream waits meanwhile", { timeout: 10_000 }, async () => {
  const { env } = sandbox();
  const input = new PassThrough();
  const output = new Writable({ write(_chunk, _enc, done) { done(); } });
  let time = Date.now();
  const done = runBridge({ env, input, output, runtimeVersion: "test", bridgeInstance: "b1", clock: () => (time += 1000), intervalMs: 10, diagnose: () => {}, reader: async () => { throw new Error("no Codex in tests"); } });
  for (let i = 0; i < 200 && !fs.existsSync(path.join(perasHome(env), "monitor-owner.json")); i++) await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual([lease(env).id, lease(env).owner], ["b1", "app"]);
  assert.equal(holdMonitor(env, time, { id: "bar", owner: "swiftbar" }), false);
  input.end();
  await done;
  assert.equal(fs.existsSync(path.join(perasHome(env), "monitor-owner.json")), false, "let go on exit");
  // The stream takes it now, and lets go when it stops.
  let snapshots = 0;
  await streamMenubar({ env, frames: 2, intervalMs: 0, clock: () => time, write: () => true, getSnapshots: async () => { snapshots++; return []; } });
  assert.ok(snapshots >= 1);
  assert.equal(fs.existsSync(path.join(perasHome(env), "monitor-owner.json")), false);
});

test("reminders failing never cost the app its snapshot", async () => {
  const { env } = sandbox();
  const payloads = await nativePayloads(env, NOW, { signer: tokenSigner(), reader: async () => { throw new Error("no Codex"); }, monitor: () => { throw new Error("broken monitor"); } });
  assert.equal(payloads.length, 2);
});
