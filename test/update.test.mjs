import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sandbox } from "./helpers.mjs";
import { updateCLI, compareVersions, runUpdateCommand } from "../src/update.mjs";
import { main } from "../src/cli.mjs";
import { codexEnv } from "../src/codex.mjs";
import { readInstall, readRules, pauseNow, readState } from "../src/store.mjs";
import { installed, setDisplayMode, displayMode } from "../src/menubar.mjs";
import { setPreference, preferences } from "../src/preferences.mjs";
import { appPath } from "../src/native-app.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
// The registry's "latest" is this checkout's version, so a version bump needs no test edits.
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
async function cli(env, ...args) {
  const code = await main(args, { env, out: () => {} });
  assert.equal(code, 0, args.join(" "));
}
function fixture(latest = VERSION) {
  const box = sandbox();
  box.env.CODEX_HOME = path.join(box.root, "codex");
  box.env.PERAS_SWIFTBAR_DIR = path.join(box.root, "swiftbar");
  const modules = path.join(box.root, "global modules"), globalRoot = path.join(modules, "peras-cli");
  const calls = [], messages = [];
  const installRelease = (destination = globalRoot) => {
    fs.mkdirSync(destination, { recursive: true });
    for (const name of ["bin", "src"]) fs.cpSync(path.join(ROOT, name), path.join(destination, name), { recursive: true, filter: source => !source.endsWith(".sh") && !source.endsWith(".swiftbarignore") });
    fs.writeFileSync(path.join(destination, "package.json"), JSON.stringify({ name: "peras-cli", version: latest, type: "module" }));
  };
  const run = async (command, args, options) => {
    calls.push({ command, args });
    if (args[0] === "view") return { stdout: JSON.stringify(latest) };
    if (args[0] === "root") return { stdout: `${modules}\n` };
    if (args[0] === "install") {
      const i = args.indexOf("--prefix");
      installRelease(i < 0 ? globalRoot : path.join(args[i + 1], process.platform === "win32" ? "node_modules" : "lib/node_modules", "peras-cli"));
      return { stdout: "installed" };
    }
    return runUpdateCommand(command, args, options);
  };
  const invoke = (extra = {}) => updateCLI({ env: box.env, version: "0.2.0", root: ROOT, run, out: text => messages.push(text), ...extra });
  return { ...box, globalRoot, calls, messages, invoke, run, installRelease };
}

test("version ordering handles numeric components, prereleases, and rejects package injection", () => {
  assert.ok(compareVersions("0.10.0", "0.9.9") > 0);
  assert.ok(compareVersions("0.2.0", "0.2.0-beta.2") > 0);
  assert.ok(compareVersions("0.2.0-beta.10", "0.2.0-beta.2") > 0);
  assert.equal(compareVersions("0.2.0+local", "0.2.0"), 0);
  assert.throws(() => compareVersions("0.3.0; touch bad", "0.2.0"));
});

test("read-only check reports an update without installing or refreshing anything", async () => {
  const f = fixture();
  await cli(f.env, "setup");
  const before = fs.readFileSync(path.join(f.env.PERAS_HOME, "app", "package.json"), "utf8");
  const result = await f.invoke({ check: true });
  assert.equal(result.available, true);
  assert.equal(f.calls.length, 2);
  assert.ok(f.messages.some(text => text.includes("Run peras update")));
  assert.equal(fs.readFileSync(path.join(f.env.PERAS_HOME, "app", "package.json"), "utf8"), before);
});

test("older published versions never downgrade a newer local checkout", async () => {
  const f = fixture("0.1.1");
  const result = await f.invoke();
  assert.equal(result.updated, false);
  assert.deepEqual(f.calls.map(call => call.args[0]), ["view", "root"]);
});

test("updating a linked global CLI replaces the link and preserves its checkout", async () => {
  const f = fixture(), checkout = path.join(f.root, "checkout");
  fs.mkdirSync(checkout);
  const original = JSON.stringify({ name: "peras-cli", version: "0.2.0" });
  fs.writeFileSync(path.join(checkout, "package.json"), original);
  fs.mkdirSync(path.dirname(f.globalRoot), { recursive: true });
  fs.symlinkSync(checkout, f.globalRoot, "dir");
  await f.invoke();
  assert.equal(fs.lstatSync(f.globalRoot).isSymbolicLink(), false);
  assert.equal(fs.readFileSync(path.join(checkout, "package.json"), "utf8"), original);
});

test("failed npm installation restores a detached development link", async () => {
  const f = fixture(), checkout = path.join(f.root, "checkout");
  fs.mkdirSync(checkout);
  fs.writeFileSync(path.join(checkout, "package.json"), JSON.stringify({ name: "peras-cli", version: "0.2.0" }));
  fs.mkdirSync(path.dirname(f.globalRoot), { recursive: true });
  fs.symlinkSync(checkout, f.globalRoot, "dir");
  await assert.rejects(f.invoke({ run: (command, args, options) => args[0] === "install" ? Promise.reject(Error("offline")) : f.run(command, args, options) }), /CLI installation failed/);
  assert.equal(fs.realpathSync(f.globalRoot), fs.realpathSync(checkout));
});

test("upgrade refreshes both runtimes and the menu while preserving rules, pauses, and preferences", async () => {
  const f = fixture();
  await cli(f.env, "setup");
  await cli(f.env, "codex", "setup");
  await cli(f.env, "menubar", "install");
  await cli(f.env, "set", "weekly", "85", "pause");
  const rules = readRules(f.env);
  const now = Date.now();
  pauseNow(codexEnv(f.env), { now });
  const state = readState(codexEnv(f.env), now);
  setDisplayMode(f.env, "pear");
  setPreference(f.env, "mascots", "off");
  const oldPlugin = installed(f.env);
  const result = await f.invoke();
  assert.equal(result.updated, true);
  assert.equal(readInstall(f.env).version, VERSION);
  assert.equal(readInstall(codexEnv(f.env)).version, VERSION);
  assert.deepEqual(readRules(f.env), rules);
  assert.deepEqual(readState(codexEnv(f.env), now), state);
  assert.equal(displayMode(f.env), "pear");
  assert.equal(preferences(f.env).mascots, false);
  assert.notEqual(installed(f.env), oldPlugin, "release changes reload the streaming menu");
  assert.equal(fs.existsSync(oldPlugin), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.env.PERAS_HOME, "app", "package.json"))).version, VERSION);
  assert.ok(f.calls.some(call => call.args.includes("--ignore-scripts")));
  assert.ok(f.calls.some(call => call.args.slice(1).join(" ") === "menubar install " + f.env.PERAS_SWIFTBAR_DIR));
});

test("Codex-only upgrade leaves Claude uninstalled and updates the shared menu", async () => {
  const f = fixture();
  await cli(f.env, "codex", "setup");
  await cli(f.env, "menubar", "install");
  await f.invoke();
  assert.equal(readInstall(f.env), null);
  assert.equal(readInstall(codexEnv(f.env)).version, VERSION);
  assert.ok(installed(f.env));
  assert.ok(!f.calls.some(call => call.args.slice(1).join(" ") === "setup"));
});

test("an already updated global CLI repairs stale runtimes without reinstalling npm", async () => {
  const f = fixture();
  await cli(f.env, "codex", "setup");
  f.installRelease();
  await f.invoke();
  assert.ok(!f.calls.some(call => call.args[0] === "install"));
  assert.equal(readInstall(codexEnv(f.env)).version, VERSION);
});

test("failed registry checks and failed installations stop before integration refresh", async () => {
  const f = fixture();
  await assert.rejects(f.invoke({ run: async () => { throw Error("offline"); } }), /Nothing was changed/);
  const calls = [];
  await assert.rejects(f.invoke({ run: async (command, args, options) => {
    calls.push(args[0]);
    if (args[0] === "install") throw Error("permission denied");
    return f.run(command, args, options);
  } }), /refresh was not attempted/);
  assert.deepEqual(calls, ["view", "root", "install"]);
});

// The Peras app runs only a CLI of its own 0.x line: a fake bundle and a registry with two lines.
function lines({ app = "0.4.0", global = null } = {}) {
  const f = fixture("0.5.1"), installs = [], native = [];
  const plist = (dir, version) => {
    fs.mkdirSync(path.join(dir, "Contents"), { recursive: true });
    fs.writeFileSync(path.join(dir, "Contents", "Info.plist"), `<plist><dict><key>PerasRuntimeVersion</key><string>${version}</string></dict></plist>`);
    return dir;
  };
  if (app) plist(appPath(f.env), app);
  const put = (version) => {
    fs.mkdirSync(path.join(f.globalRoot, "bin"), { recursive: true });
    fs.writeFileSync(path.join(f.globalRoot, "bin", "peras.mjs"), "");
    fs.writeFileSync(path.join(f.globalRoot, "package.json"), JSON.stringify({ name: "peras-cli", version, type: "module" }));
  };
  if (global) put(global);
  const run = async (command, args, options) => {
    f.calls.push({ command, args });
    if (args[0] === "view") return { stdout: JSON.stringify(args[1] === "peras-cli@~0.4.0" ? ["0.4.0", "0.4.2"] : "0.5.1") };
    if (args[0] === "root") return f.run(command, args, options);
    if (args[0] === "install") { const version = args[2].split("@")[1]; installs.push(version); put(version); return { stdout: "installed" }; }
    if (args.includes("--native")) { native.push(args.at(-1)); return { stdout: "" }; }
    throw Error(`unexpected ${args.join(" ")}`);
  };
  const invoke = (extra = {}) => f.invoke({ version: "0.4.0", run, ...extra });
  return { ...f, installs, native, plist, invoke };
}

test("with the Peras app installed, an update stays on the app's line and says how to move on", async () => {
  const f = lines();
  const result = await f.invoke();
  assert.deepEqual(f.installs, ["0.4.2"]);
  assert.equal(result.held, "0.5.1");
  assert.ok(f.messages.some(text => text.includes("peras update --app ~/Downloads/Peras.app") && text.includes("peras.vertias.eu/download")));
  const check = lines();
  await check.invoke({ check: true });
  assert.deepEqual(check.installs, []);
  assert.ok(check.messages.some(text => text.includes("Peras 0.5.1 is out")));
});

test("without the Peras app, an update crosses lines as before", async () => {
  const f = lines({ app: null });
  const result = await f.invoke();
  assert.deepEqual(f.installs, ["0.5.1"]);
  assert.equal(result.held, null);
});

test("update --app moves CLI and app to the new line together, and refuses an app from another line", async () => {
  const f = lines();
  const download = f.plist(path.join(f.root, "Downloads", "Peras.app"), "0.5.1");
  await f.invoke({ app: download });
  assert.deepEqual(f.installs, ["0.5.1"]);
  assert.deepEqual(f.native, [download]);
  const old = lines();
  await assert.rejects(old.invoke({ app: old.plist(path.join(old.root, "Old.app"), "0.4.2") }), /for Peras 0\.4\.2.*Nothing was changed/);
  assert.deepEqual(old.installs, []);
  await assert.rejects(old.invoke({ app: path.join(old.root, "missing.app") }), /not a Peras app/);
});

test("update --app restores the previous CLI locally when the new app fails to install", async () => {
  const f = lines({ global: "0.4.0" });
  const download = f.plist(path.join(f.root, "Peras.app"), "0.5.1");
  const failing = async (command, args, options) => {
    if (args.includes("--native")) { f.calls.push({ args }); throw Error("the app did not answer"); }
    if (args[0] === "view") return { stdout: JSON.stringify("0.5.1") };
    if (args[0] === "root") return { stdout: `${path.dirname(f.globalRoot)}\n` };
    if (args[0] === "install") { const version = args[2].split("@")[1]; f.installs.push(version); fs.writeFileSync(path.join(f.globalRoot, "package.json"), JSON.stringify({ name: "peras-cli", version, type: "module" })); return { stdout: "" }; }
    throw Error(`unexpected ${args.join(" ")}`);
  };
  await assert.rejects(f.invoke({ version: "0.3.9", app: download, run: failing }), /Peras 0\.4\.0 is back.*did not answer/);
  assert.deepEqual(f.installs, ["0.5.1"]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.globalRoot, "package.json"))).version, "0.4.0");
});
