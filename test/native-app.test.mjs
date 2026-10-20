// Moving the 🍐 from SwiftBar to the Peras app, with a stand-in app: nothing here
// opens, quits or signs a real application.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { main } from "../src/cli.mjs";
import { sandbox, tempDir, VERSION } from "./helpers.mjs";
import { announceBridge, appPath, handshake, installApp, liveMenu, recoverInstall, rollbackDir } from "../src/native-app.mjs";
import { runProtectionTest } from "../src/protection-test.mjs";

const BIN = new URL("../bin/peras.mjs", import.meta.url).pathname;

function fakeApp(name = "Peras", marker = "one") {
  const app = path.join(tempDir("peras-app-"), `${name}.app`);
  fs.mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
  fs.writeFileSync(path.join(app, "Contents", "Info.plist"), `<plist><dict><key>CFBundleName</key><string>${name}</string></dict></plist>`);
  fs.writeFileSync(path.join(app, "Contents", "MacOS", name), `#!/bin/sh\n# ${marker}\n`, { mode: 0o755 });
  return app;
}
const marker = (env) => fs.readFileSync(path.join(appPath(env), "Contents", "MacOS", "Peras"), "utf8");

/**
 * A stand-in for macOS: `launch` does what the app would, or nothing. Every call is logged.
 * `open` is the version of a copy already running; `stubborn` is "term" (only a forced quit
 * ends it) or "kill" (nothing does).
 */
function standIn(env, { starts = true, version = VERSION, verified = true, downloaded = false, adhoc = false, open = null, stubborn = null } = {}) {
  const calls = [];
  let running = Boolean(open), clock = Date.now();
  const start = clock;
  if (open) announceBridge(env, { bridgeInstance: "b0", runtimeVersion: open, now: clock - 60_000 });
  const app = {
    calls,
    launch: async (bundle) => {
      calls.push(["launch", bundle]);
      if (starts) { running = true; announceBridge(env, { bridgeInstance: "b1", runtimeVersion: version, now: clock }); }
    },
    quit: async (bundle, { force = false } = {}) => {
      calls.push([force ? "kill" : "quit", bundle]);
      if (stubborn === "kill" || (stubborn === "term" && !force)) return;
      running = false;
    },
    running: async () => running,
    verify: () => (verified ? { ok: true, gatekeeper: "not notarized", adhoc } : { ok: false, reason: "its signature doesn't check out" }),
    quarantined: () => downloaded,
    clock: () => clock,
    waited: () => clock - start,
    sleep: async (ms) => { clock += ms; },
    timeoutMs: 2000,
    firstOpenTimeoutMs: 120_000,
  };
  return app;
}

async function run(env, args, nativeApp) {
  const lines = [];
  const quits = [];
  const code = await main(args, { env, out: (l) => lines.push(l), codexReader: async () => { throw new Error("no codex"); }, nativeApp, quitMenubar: async () => { quits.push("swiftbar"); }, openMenubar: async () => {}, isTTY: true });
  return { code, text: lines.join("\n"), quits };
}
/** A command that has to fail: exit 1 and its ✗ line. */
async function refused(env, args, nativeApp, pattern) {
  const { code, text } = await run(env, args, nativeApp);
  assert.equal(code, 1, text);
  assert.match(text, pattern);
}
async function withSwiftBar() {
  const box = sandbox();
  box.env.PERAS_SWIFTBAR_DIR = path.join(box.root, "plugins");
  await run(box.env, ["setup"]);
  await run(box.env, ["menubar", "install"]);
  const record = JSON.parse(fs.readFileSync(path.join(box.env.PERAS_HOME, "menubar.json"), "utf8"));
  return { ...box, plugin: record.file };
}

test("the app goes in, says hello, and only then SwiftBar's plugin moves to the rollback folder", async () => {
  const { env, plugin } = await withSwiftBar();
  const app = standIn(env);
  const { code, text } = await run(env, ["menubar", "install", "--native", "--app", fakeApp()], app);
  assert.equal(code, 0, text);
  assert.ok(fs.existsSync(path.join(appPath(env), "Contents", "Info.plist")), "the app is in PERAS_HOME/native");
  assert.ok(!fs.existsSync(plugin), "SwiftBar no longer sees the plugin");
  const kept = path.join(rollbackDir(env), path.basename(plugin));
  assert.match(fs.readFileSync(kept, "utf8"), /Written by `peras menubar install`/, "kept, not deleted");
  assert.equal(JSON.parse(fs.readFileSync(path.join(env.PERAS_HOME, "menubar.json"), "utf8")).file, plugin, "the field 0.3 reads is untouched");
  assert.equal(liveMenu(env), "native");
  assert.match(text, /The app draws the 🍐 now/);
  assert.match(text, /Gatekeeper: not notarized/);
  assert.match(text, /Peras runs that copy, so you can delete .*Peras\.app\./, "the downloaded copy is not the one that runs");
  assert.match((await run(env, ["menubar"], app)).text, /the Peras app in/);
});

test("an app that never checks in leaves SwiftBar's menu alone and takes itself back out", async () => {
  const { env, plugin } = await withSwiftBar();
  const app = standIn(env, { starts: false });
  await refused(env, ["menubar", "install", "--native", "--app", fakeApp()], app, /never started its bridge\. SwiftBar's menu stays as it was\./);
  assert.ok(fs.existsSync(plugin));
  assert.ok(!fs.existsSync(appPath(env)), "a first install that failed leaves no app");
  assert.equal(liveMenu(env), "swiftbar");
  assert.deepEqual(app.calls.map((c) => c[0]), ["launch", "quit"]);
});

test("a failed update puts the previous app back", async () => {
  const { env, plugin } = await withSwiftBar();
  await run(env, ["menubar", "install", "--native", "--app", fakeApp("Peras", "first")], standIn(env));
  await run(env, ["menubar", "install"], standIn(env));
  assert.equal(liveMenu(env), "swiftbar", "back on SwiftBar, the app still installed");
  await refused(env, ["menubar", "install", "--native", "--app", fakeApp("Peras", "second")], standIn(env, { version: "0.3.2" }), /runs Peras 0\.3\.2, this is .*the app you had before is back/);
  assert.match(marker(env), /first/);
  assert.ok(!fs.existsSync(`${appPath(env)}.previous`) && !fs.existsSync(`${appPath(env)}.new`));
  assert.ok(fs.existsSync(path.dirname(plugin)) && liveMenu(env) === "swiftbar");
});

// Every file of the bundle, so a half-copied or half-deleted app can't pass for a whole one.
function bundleFiles(app) {
  const files = {};
  const walk = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const f = path.join(dir, e.name); if (e.isDirectory()) walk(f); else files[path.relative(app, f)] = fs.readFileSync(f, "utf8"); } };
  walk(app);
  return files;
}
function wholeApp(name) {
  const app = fakeApp("Peras", name);
  fs.mkdirSync(path.join(app, "Contents", "Resources"));
  for (let i = 0; i < 20; i++) fs.writeFileSync(path.join(app, "Contents", "Resources", `part-${i}`), `${name} ${i}`);
  return app;
}
const ok = { verify: () => ({ ok: true, gatekeeper: "not notarized" }), downloaded: () => false };
/** What's in PERAS_HOME/native besides the rollback folder: names, and which build each whole bundle is. */
function nativeState(env, builds) {
  const dir = path.dirname(appPath(env)), state = {};
  for (const name of fs.readdirSync(dir).filter((n) => n.startsWith("Peras.app")).sort()) {
    const files = bundleFiles(path.join(dir, name));
    state[name] = Object.keys(builds).find((b) => JSON.stringify(files) === JSON.stringify(builds[b])) ?? "broken";
  }
  return state;
}
/** Records every step; `failAt` makes that step throw. Bundles are only ever deleted under a trash name. */
function counted(failAt = -1) {
  let n = 0;
  const step = (name, fn) => (...a) => {
    if (name === "remove") assert.match(path.basename(a[0]), /^Peras\.app\.(new|trash-.+)$/, `never deletes ${a[0]} in place`);
    if (n++ === failAt) throw Object.assign(new Error(`${name} failed`), { code: "EIO" });
    return fn(...a);
  };
  const ops = {
    rename: step("rename", fs.renameSync),
    remove: step("remove", (t) => fs.rmSync(t, { recursive: true, force: true })),
    copy: step("copy", (from, to) => fs.cpSync(from, to, { recursive: true })),
  };
  return { ops, count: () => n };
}

test("an update that fails at any step leaves a whole app, and a retry whose hello fails puts the first one back", () => {
  const prior = wholeApp("prior"), next = wholeApp("next");
  const builds = { prior: bundleFiles(prior), next: bundleFiles(next) };
  const probe = counted();
  const { env } = sandbox();
  installApp(env, prior, ok).confirm();
  installApp(env, next, { ...ok, ops: probe.ops }).restore();
  const steps = probe.count();
  assert.ok(steps >= 6, `install + restore take ${steps} steps`);
  for (let failAt = 0; failAt < steps; failAt++) {
    const { env } = sandbox();
    installApp(env, prior, ok).confirm();
    const faulty = counted(failAt);
    try { installApp(env, next, { ...ok, ops: faulty.ops }).restore(); } catch { /* the step that failed */ }
    const left = nativeState(env, builds);
    assert.ok(left["Peras.app"] || left["Peras.app.previous"] === "prior", `step ${failAt}: an app, or the first build to put back (${JSON.stringify(left)})`);
    recoverInstall(env);
    const after = nativeState(env, builds);
    assert.ok(after["Peras.app"] === "prior" || after["Peras.app"] === "next", `step ${failAt}: an app is in place (${JSON.stringify(after)})`);
    assert.ok(!after["Peras.app.previous"] || after["Peras.app.previous"] === "prior", `step ${failAt}: the fallback is the first build, whole`);
    assert.ok(Object.keys(after).every((n) => n === "Peras.app" || n === "Peras.app.previous"), `step ${failAt}: no leftovers (${JSON.stringify(after)})`);
    // The next attempt also fails to check in: the build that last did is what's left.
    installApp(env, next, ok).restore();
    assert.deepEqual(nativeState(env, builds), { "Peras.app": "prior" }, `step ${failAt}: retry then failed hello`);
    installApp(env, next, ok).confirm();
    assert.deepEqual(nativeState(env, builds), { "Peras.app": "next" }, `step ${failAt}: retry then hello`);
  }
});

test("an update killed between any two steps is put back together by the next run", () => {
  const prior = wholeApp("prior"), next = wholeApp("next");
  const builds = { prior: bundleFiles(prior), next: bundleFiles(next) };
  const driver = path.join(tempDir("peras-driver-"), "driver.mjs");
  // A real process, really killed: no catch or finally of the installer runs.
  fs.writeFileSync(driver, `import fs from "node:fs";
import { installApp } from ${JSON.stringify(new URL("../src/native-app.mjs", import.meta.url).href)};
const [home, source, killAt, finish] = JSON.parse(process.argv[2]);
let n = 0;
const step = (fn) => (...a) => { if (n++ * 2 === killAt) process.kill(process.pid, "SIGKILL"); const r = fn(...a); if (n * 2 - 1 === killAt) process.kill(process.pid, "SIGKILL"); return r; };
const ops = { rename: step(fs.renameSync), remove: step((t) => fs.rmSync(t, { recursive: true, force: true })), copy: step((f, t) => fs.cpSync(f, t, { recursive: true })) };
installApp({ PERAS_HOME: home }, source, { verify: () => ({ ok: true }), downloaded: () => false, ops })[finish]();
`);
  for (const finish of ["restore", "confirm"]) {
    for (let killAt = 0; ; killAt++) {
      const { env } = sandbox();
      installApp(env, prior, ok).confirm();
      const ran = spawnSync(process.execPath, [driver, JSON.stringify([env.PERAS_HOME, next, killAt, finish])], { encoding: "utf8" });
      if (ran.status === 0) { assert.ok(killAt > 8, `${finish}: every point was tried (${killAt})`); break; }
      assert.equal(ran.signal, "SIGKILL", ran.stderr);
      recoverInstall(env);
      const after = nativeState(env, builds);
      assert.ok(after["Peras.app"] === "prior" || after["Peras.app"] === "next", `${finish} killed at ${killAt}: an app is in place (${JSON.stringify(after)})`);
      assert.ok(Object.keys(after).every((n) => n === "Peras.app" || n === "Peras.app.previous"), `${finish} killed at ${killAt}: no leftovers (${JSON.stringify(after)})`);
      assert.ok(!after["Peras.app.previous"] || after["Peras.app.previous"] === "prior", `${finish} killed at ${killAt}: the fallback is the first build, whole`);
      // The last build that checked in: the fallback if one is kept, else what's in place. Only a
      // hello (confirm) can make that the new build.
      const good = after["Peras.app.previous"] ?? after["Peras.app"];
      if (finish === "restore") assert.equal(good, "prior", `restore killed at ${killAt}: the new build never counts as good`);
      installApp(env, next, ok).restore();
      assert.deepEqual(nativeState(env, builds), { "Peras.app": good }, `${finish} killed at ${killAt}: retry then failed hello`);
    }
  }
});

test("after an interrupted update, install and open bring the last good app back and leave other plugins alone", async () => {
  const { env, plugin } = await withSwiftBar();
  const other = path.join(path.dirname(plugin), "weather.5m.sh");
  fs.writeFileSync(other, "#!/bin/sh\necho ☀️\n", { mode: 0o755 });
  const prior = wholeApp("prior"), builds = { prior: bundleFiles(prior), next: bundleFiles(wholeApp("next")) };
  assert.equal((await run(env, ["menubar", "install", "--native", "--app", prior], standIn(env))).code, 0);
  // What a kill right after the first rename leaves: the last good app as .previous, the new one half-copied.
  fs.renameSync(appPath(env), `${appPath(env)}.previous`);
  fs.mkdirSync(path.join(`${appPath(env)}.new`, "Contents"), { recursive: true });
  assert.equal(liveMenu(env), null, "no menu at all until something repairs it");
  assert.equal((await run(env, ["menubar", "open"], standIn(env))).code, 0);
  assert.deepEqual(nativeState(env, builds), { "Peras.app": "prior" });
  // Killed after the swap, before hello: the new build is in place but never checked in.
  fs.renameSync(appPath(env), `${appPath(env)}.previous`);
  fs.cpSync(wholeApp("next"), appPath(env), { recursive: true });
  await refused(env, ["menubar", "install", "--native"], standIn(env, { starts: false }), /never started its bridge\. .*the app you had before is back/);
  assert.deepEqual(nativeState(env, builds), { "Peras.app": "prior" });
  // The same, and this time the new build checks in: it stays and the fallback goes.
  fs.renameSync(appPath(env), `${appPath(env)}.previous`);
  fs.cpSync(wholeApp("next"), appPath(env), { recursive: true });
  assert.equal((await run(env, ["menubar", "install", "--native"], standIn(env))).code, 0);
  assert.deepEqual(nativeState(env, builds), { "Peras.app": "next" });
  assert.equal(fs.readFileSync(other, "utf8"), "#!/bin/sh\necho ☀️\n", "someone else's plugin is untouched");
});

test("an open app that ignores quit is ended, so the new build starts its own bridge", async () => {
  const { env } = await withSwiftBar();
  await run(env, ["menubar", "install", "--native", "--app", fakeApp("Peras", "first")], standIn(env));
  const app = standIn(env, { open: VERSION, stubborn: "term" });
  const { code, text } = await run(env, ["menubar", "install", "--native", "--app", fakeApp("Peras", "second")], app);
  assert.equal(code, 0, text);
  assert.deepEqual(app.calls.map((c) => c[0]), ["quit", "kill", "launch"]);
  assert.match(marker(env), /second/);
});

test("an open app nothing can end leaves the build you had, and says why", async () => {
  const { env } = await withSwiftBar();
  await run(env, ["menubar", "install", "--native", "--app", fakeApp("Peras", "first")], standIn(env));
  const app = standIn(env, { open: VERSION, stubborn: "kill" });
  await refused(env, ["menubar", "install", "--native", "--app", fakeApp("Peras", "second")], app, /already open didn't quit\. .*the app you had before is back/);
  assert.match(marker(env), /first/);
  assert.ok(!app.calls.some((c) => c[0] === "launch"), "the old copy is never brought forward as if it were the new one");
});

test("without --app, an open app on this version stays open; one on an older runtime restarts", async () => {
  const { env } = await withSwiftBar();
  await run(env, ["menubar", "install", "--native", "--app", fakeApp()], standIn(env));
  const current = standIn(env, { open: VERSION });
  assert.equal((await run(env, ["menubar", "install", "--native"], current)).code, 0);
  assert.deepEqual(current.calls.map((c) => c[0]), ["launch"], "brought forward, not restarted");
  const older = standIn(env, { open: "0.3.2" });
  const { code, text } = await run(env, ["menubar", "install", "--native"], older);
  assert.equal(code, 0, text);
  assert.deepEqual(older.calls.map((c) => c[0]), ["quit", "launch"], "restarted onto this runtime");
});

test("an app whose signature doesn't check out is never copied", async () => {
  const { env, plugin } = await withSwiftBar();
  await refused(env, ["menubar", "install", "--native", "--app", fakeApp()], standIn(env, { verified: false }), /The app was not installed: its signature doesn't check out/);
  assert.ok(!fs.existsSync(appPath(env)) && fs.existsSync(plugin));
  await refused(env, ["menubar", "install", "--native", "--app", tempDir("not-an-app-")], standIn(env), /is not an app bundle/);
});

test("the handshake takes only a live bridge started since the launch, on this version", async () => {
  const { env } = sandbox();
  const fast = { timeoutMs: 500, clock: (() => { let t = 1000; return () => (t += 100); })(), sleep: async () => {} };
  announceBridge(env, { bridgeInstance: "old", runtimeVersion: VERSION, now: 500 });
  assert.match((await handshake(env, { sinceMs: 1000, runtimeVersion: VERSION, ...fast })).reason, /never started/, "an earlier bridge's record");
  announceBridge(env, { bridgeInstance: "new", runtimeVersion: VERSION, now: 2000 });
  assert.equal((await handshake(env, { sinceMs: 1000, runtimeVersion: VERSION, ...fast })).ok, true);
  const record = path.join(env.PERAS_HOME, "native", "bridge.json");
  fs.writeFileSync(record, JSON.stringify({ ...JSON.parse(fs.readFileSync(record, "utf8")), pid: 2 ** 22 + 7 }));
  assert.match((await handshake(env, { sinceMs: 1000, runtimeVersion: VERSION, ...fast })).reason, /started and stopped/);
});

test("the real bridge announces itself and clears its record when the app closes it", async () => {
  const { env } = sandbox();
  env.PATH = path.dirname(process.execPath);
  const since = Date.now();
  const child = spawn(process.execPath, [BIN, "menubar", "bridge", "--protocol", "1"], { env, stdio: ["pipe", "pipe", "ignore"] });
  try {
    const hello = await handshake(env, { sinceMs: since, runtimeVersion: VERSION, timeoutMs: 15_000 });
    assert.equal(hello.ok, true, hello.reason);
    assert.equal(hello.record.pid, child.pid);
  } finally {
    child.stdin.end();
    await new Promise((resolve) => child.once("exit", resolve));
  }
  assert.ok(!fs.existsSync(path.join(env.PERAS_HOME, "native", "bridge.json")));
});

test("after a rollback to 0.3 reinstalls SwiftBar's plugin, SwiftBar is the live menu again", async () => {
  const { env } = await withSwiftBar();
  const app = standIn(env);
  await run(env, ["menubar", "install", "--native", "--app", fakeApp()], app);
  // What 0.3's `menubar install` does: write a plugin, then `{ ...record, file }`.
  const file = path.join(env.PERAS_SWIFTBAR_DIR, "peras-0123456789abcdef.1m.sh");
  fs.writeFileSync(file, "#!/bin/sh\n# Written by `peras menubar install`\n", { mode: 0o755 });
  const recordFile = path.join(env.PERAS_HOME, "menubar.json");
  fs.writeFileSync(recordFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(recordFile, "utf8")), file }));
  assert.equal(liveMenu(env), "swiftbar");
  app.calls.length = 0;
  const quit = await run(env, ["menubar", "quit"], app);
  assert.deepEqual(quit.quits, ["swiftbar"], "quit goes to SwiftBar");
  assert.deepEqual(app.calls, [], "and not to the app");
});

test("peras menubar install is the way back; quit, open and remove follow the live menu", async () => {
  const { env, plugin } = await withSwiftBar();
  const app = standIn(env);
  await run(env, ["menubar", "install", "--native", "--app", fakeApp()], app);
  const bundle = appPath(env);
  app.calls.length = 0;
  assert.deepEqual((await run(env, ["menubar", "quit"], app)).quits, []);
  await run(env, ["menubar", "open"], app);
  assert.deepEqual(app.calls, [["quit", bundle], ["launch", bundle]]);
  app.calls.length = 0;
  const back = await run(env, ["menubar", "install"], app);
  assert.match(back.text, /Closed the Peras app: SwiftBar draws the 🍐 again/);
  assert.deepEqual(app.calls, [["quit", bundle]]);
  assert.equal(liveMenu(env), "swiftbar");
  assert.equal(fs.readdirSync(env.PERAS_SWIFTBAR_DIR).filter((f) => /^peras.*\.1m\.sh$/.test(f)).length, 1, "one Peras plugin in SwiftBar's folder");
  assert.ok(fs.existsSync(path.join(rollbackDir(env), path.basename(plugin))), "the rollback copy stays outside it");
  assert.ok(!rollbackDir(env).startsWith(env.PERAS_SWIFTBAR_DIR));
  const removed = await run(env, ["menubar", "remove"], app);
  assert.match(removed.text, /Removed the Peras app/);
  assert.ok(!fs.existsSync(bundle) && liveMenu(env) === null);
});

test("a plugin Peras didn't write stays where it is", async () => {
  const { env, plugin } = await withSwiftBar();
  fs.writeFileSync(plugin, "#!/bin/sh\necho mine\n", { mode: 0o755 });
  const { text } = await run(env, ["menubar", "install", "--native", "--app", fakeApp()], standIn(env));
  assert.match(text, /isn't a plugin Peras wrote, so it stays/);
  assert.equal(fs.readFileSync(plugin, "utf8"), "#!/bin/sh\necho mine\n");
});

test("without --app and with no app installed, it readies the runtime and opens nothing", async () => {
  const { env } = sandbox();
  const app = standIn(env);
  const { code, text } = await run(env, ["menubar", "install", "--native"], app);
  assert.equal(code, 0);
  assert.match(text, /No Peras app to open yet/);
  assert.match(text, /peras\.vertias\.eu\/app .*build it yourself/);
  assert.deepEqual(app.calls, []);
  await refused(env, ["menubar", "install", "--native", "--app"], app, /Use peras menubar install --native \[--app/);
});

test("a downloaded app gets minutes for its first open, and a failure says where macOS keeps the approval", async () => {
  const { env, plugin } = await withSwiftBar();
  const slow = standIn(env, { starts: false, downloaded: true });
  const r = await run(env, ["menubar", "install", "--native", "--app", fakeApp()], slow);
  assert.equal(r.code, 1);
  assert.match(r.text, /macOS may ask you to confirm opening Peras\. Peras waits up to 2 minutes\./);
  assert.match(r.text, /SwiftBar's menu stays as it was\. The downloaded copy is kept at .*Peras-pending-.*\.app/);
  assert.ok(slow.waited() >= 120_000, "waited the long timer, not the short one");
  assert.ok(fs.existsSync(plugin));
  const pending = path.join(path.dirname(appPath(env)), fs.readdirSync(path.dirname(appPath(env))).find((n) => /^Peras-pending-.*\.app$/.test(n)));
  assert.ok(fs.existsSync(pending) && !fs.existsSync(appPath(env)), "approval copy stays aside without an incompatible installed app");
  assert.deepEqual(slow.calls.map((c) => c[0]), ["launch", "quit"]);
  const approved = standIn(env, { downloaded: true });
  const again = await run(env, ["menubar", "install", "--native", "--app", pending], approved);
  assert.equal(again.code, 0, again.text);
  assert.ok(!fs.existsSync(plugin) && liveMenu(env) === "native", "the rerun without --app finishes the move");
  await run(env, ["menubar", "install"], approved);
  const local = standIn(env, { starts: false });
  await refused(env, ["menubar", "install", "--native", "--app", fakeApp()], local, /never started its bridge\. SwiftBar's menu stays as it was; the app you had before is back\.$/);
  assert.ok(local.waited() < 120_000, "a locally built app keeps the short timer");
});

test("after the move: what's still missing for protection, then nothing once it's all there", async () => {
  const box = sandbox();
  const { env } = box;
  env.PATH = path.dirname(process.execPath);
  env.CODEX_HOME = path.join(box.root, "codex");
  env.PERAS_SWIFTBAR_DIR = path.join(box.root, "plugins");
  const app = standIn(env);
  const next = async () => (await run(env, ["menubar", "install", "--native", "--app", fakeApp()], app)).text;
  let text = await next();
  assert.match(text, /Next:\n  Claude Code: `peras setup` adds the hooks\.$/, "no Codex here: no Codex line, and nothing to self-test");
  fs.mkdirSync(env.CODEX_HOME);
  await run(env, ["setup"]);
  text = await next();
  assert.match(text, /Claude Code: restart it; its next tool call confirms protection\./);
  assert.match(text, /Codex: `peras codex setup` adds the hooks, then trust them in Codex's \/hooks\./);
  assert.match(text, /`peras menubar test` checks the hooks in a throwaway folder; your agents keep running\./);
  await run(env, ["codex", "setup"]);
  assert.match(await next(), /Codex: trust Peras in \/hooks and restart open sessions/);
  assert.ok(runProtectionTest(env).passed);
  assert.doesNotMatch(await next(), /menubar test/, "the self-test passed");
  assert.match(await next(), /Going back to Peras 0\.3: `peras menubar quit` first/);
  assert.match((await run(env, ["menubar"], app)).text, /Going back to Peras 0\.3/);
});

test("a downloaded build signed for local testing only is refused before anything is copied", async () => {
  const { env, plugin } = await withSwiftBar();
  const app = standIn(env, { downloaded: true, adhoc: true });
  await refused(env, ["menubar", "install", "--native", "--app", fakeApp()], app, /downloaded but is signed for local testing only, so macOS won't open it/);
  assert.ok(!fs.existsSync(appPath(env)) && fs.existsSync(plugin));
  assert.deepEqual(app.calls, [], "never opened");
  const local = await run(env, ["menubar", "install", "--native", "--app", fakeApp()], standIn(env, { adhoc: true }));
  assert.equal(local.code, 0, local.text);
});


test("R4 a failed quarantined replacement restores the previous app and keeps the download aside", async () => {
  const { env } = await withSwiftBar();
  assert.equal((await run(env, ["menubar", "install", "--native", "--app", fakeApp("Peras", "old")], standIn(env))).code, 0);
  const r = await run(env, ["menubar", "install", "--native", "--app", fakeApp("Peras", "new")], standIn(env, { starts: false, downloaded: true }));
  assert.equal(r.code, 1);
  assert.match(marker(env), /old/, "normal installed path must contain the last working app");
  const pending = fs.readdirSync(path.dirname(appPath(env))).filter((n) => /^Peras-pending-.*\.app$/.test(n));
  assert.equal(pending.length, 1);
  assert.match(fs.readFileSync(path.join(path.dirname(appPath(env)), pending[0], "Contents", "MacOS", "Peras"), "utf8"), /new/);
  assert.match(r.text, /previous app is back/);
});
