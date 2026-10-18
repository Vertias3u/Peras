import { test } from "node:test";
import assert from "node:assert/strict";
import { notify } from "../src/notify.mjs";

const LSREGISTER = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
/** Building a sender registers it with LaunchServices; the record would outlive the temp folder. */
async function unregisterAfter(t, app) {
  const { execFileSync } = await import("node:child_process");
  t.after(() => { try { execFileSync(LSREGISTER, ["-u", app]); } catch { /* never registered */ } });
}

test("notifications dispatch pear worker without shell interpolation or blocking", () => {
  const calls = []; let detached = false;
  const launch = (...args) => { calls.push(args); return { on() {}, unref() { detached = true; } }; };
  const body = 'Quotes " and $(commands) stay data';
  notify("Peras", body, { env: { PERAS_NO_NOTIFY: "0" }, platform: "darwin", launch });
  assert.equal(calls[0][0], process.execPath);
  assert.match(calls[0][1][0], /notification-worker.mjs$/);
  assert.equal(calls[0][1][2], body);
  assert.equal(calls[0][2].detached, true);
  assert.ok(detached);
  notify("Peras", body, { env: { PERAS_NO_NOTIFY: "1" }, platform: "darwin", launch });
  notify("Peras", body, { env: {}, platform: "win32", launch });
  assert.equal(calls.length, 1);
});

test("macOS notification bundle uses the pear instead of the compiler's asset catalog", { skip: process.platform !== "darwin" || process.env.PERAS_TEST_MAC_NOTIFIER !== "1" }, async (t) => {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const { promisify } = await import("node:util");
  const { execFile } = await import("node:child_process");
  const { sandbox } = await import("./helpers.mjs");
  const { prepareNotificationApp } = await import("../src/notification-worker.mjs");
  const run = promisify(execFile);
  const { root } = sandbox();
  const bundleIdentifier = `eu.vertias.peras.test.p${process.pid}.t${Date.now()}`;
  await unregisterAfter(t, path.join(root, "sender", "Peras.app"));
  const app = await prepareNotificationApp(path.join(root, "sender"), undefined, { bundleIdentifier });
  const plist = JSON.parse((await run("/usr/bin/plutil", ["-convert", "json", "-o", "-", path.join(app, "Contents", "Info.plist")])).stdout);
  assert.equal(plist.CFBundleIconName, undefined);
  assert.equal(plist.CFBundleIconFile, "Peras.icns");
  assert.equal(plist.CFBundleIdentifier, bundleIdentifier);
  assert.equal(plist.CFBundleVersion, "5");
  assert.equal(plist.CFBundleExecutable, "Peras");
  await assert.rejects(fs.access(path.join(app, "Contents", "Resources", "Assets.car")), { code: "ENOENT" });
  const icon = await fs.readFile(path.join(app, "Contents", "Resources", "Peras.icns"));
  const expected = JSON.parse(await fs.readFile(new URL("../src/notification-icon.json", import.meta.url), "utf8"));
  assert.deepEqual(icon, Buffer.from(expected.icns, "base64"));
  await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
  const architectures = (await run("/usr/bin/lipo", ["-archs", path.join(app, "Contents", "MacOS", "Peras")])).stdout;
  assert.match(architectures, /arm64/); assert.match(architectures, /x86_64/);
  const request = path.join(root, "inspect.json");
  await fs.writeFile(request, JSON.stringify({ mode: "inspect" }));
  await run("/usr/bin/open", ["-n", "-g", "-W", app, "--args", request]);
  const result = JSON.parse(await fs.readFile(`${request}.result`, "utf8"));
  assert.equal(result.bundleIdentifier, bundleIdentifier);
  assert.equal(result.icon, "Peras.icns");
  assert.deepEqual(result.declaredCategories.PERAS_PAUSE, ["PERAS_STATUS", "PERAS_RESUME"]);
  assert.deepEqual(result.declaredCategories.PERAS_REMINDER, ["PERAS_STATUS", "PERAS_SNOOZE"]);
  assert.equal(result.executable, await fs.realpath(path.join(app, "Contents", "MacOS", "Peras")));
  assert.equal(await prepareNotificationApp(path.join(root, "sender"), () => { throw new Error("must reuse finished bundle"); }, { bundleIdentifier }), app);
});

test("legacy sender migration unregisters old app paths and preserves reversible backups", async () => {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const { sandbox } = await import("./helpers.mjs");
  const { retireLegacyNotificationApps } = await import("../src/notification-worker.mjs");
  const { home } = sandbox();
  const old = path.join(home, "notifications-v1", "Peras.app");
  await fs.mkdir(old, { recursive: true });
  await fs.writeFile(path.join(old, "original"), "retained");
  const calls = [];
  const run = async (...args) => calls.push(args);
  await retireLegacyNotificationApps(home, run);
  assert.deepEqual(calls[0][1], ["-u", old]);
  assert.equal(await fs.readFile(path.join(`${old}.retired`, "original"), "utf8"), "retained");
  await assert.rejects(fs.access(old), { code: "ENOENT" });
  await retireLegacyNotificationApps(home, run);
  assert.equal(calls.length, 1, "migration is idempotent");
});


test("explicit notification test reports sender failures through the CLI", async () => {
  const { main } = await import("../src/cli.mjs");
  const { sandbox } = await import("./helpers.mjs");
  const { env } = sandbox(); const lines = [];
  const code = await main(["notify", "test"], { env, out: line => lines.push(line), sendNotification: async () => { throw new Error("Allow Peras in macOS Notifications."); } });
  assert.equal(code, 1);
  assert.match(lines.join("\n"), /Allow Peras/);
});

test('native notification bridge resumes only a disposable Codex pause after a fresh app launch', {skip:process.platform!=='darwin'||process.env.PERAS_TEST_MAC_NOTIFIER!=='1'},async(t)=>{
 const fs=await import('node:fs/promises'),path=await import('node:path');const {promisify}=await import('node:util'),{execFile}=await import('node:child_process');const run=promisify(execFile);
 const {sandbox}=await import('./helpers.mjs'),{prepareNotificationApp}=await import('../src/notification-worker.mjs'),{createActionTicket}=await import('../src/notification-actions.mjs');
 const {pauseNow,readState,context,sessionVerdict}=await import('../src/store.mjs'),{codexEnv}=await import('../src/codex.mjs');
 const {env,root}=sandbox(),scoped=codexEnv(env),now=Date.now();pauseNow(env,{now});pauseNow(scoped,{now});
 const sender=path.join(root,'native-action');await unregisterAfter(t,path.join(sender,'Peras.app'));const app=await prepareNotificationApp(sender,undefined,{bundleIdentifier:`eu.vertias.peras.test.bridge.p${process.pid}.t${now}`});
 const pauseKeys=sessionVerdict(context(scoped,{now}),readState(scoped,now)).hits.map(h=>h.key);
 const ticket=createActionTicket(sender,env,{provider:'codex',category:'pause',pauseKeys},now);
 const request=path.join(root,'action.json');await fs.writeFile(request,JSON.stringify({mode:'action',ticket,action:'PERAS_RESUME'}));
 await run('/usr/bin/open',['-n','-g','-W',app,'--args',request]);
 const result=JSON.parse(await fs.readFile(request+'.result','utf8'));assert.equal(result.actionHandled,true);assert.equal(readState(scoped).manualPause,null);assert.ok(readState(env).manualPause);
});
