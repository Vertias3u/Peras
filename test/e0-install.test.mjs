import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { NOW, VERSION, sandbox, tempDir } from "./helpers.mjs";
import { main } from "../src/cli.mjs";
import { NODE_FIX, launchFile, nodePath, nodeSupported, parseNodeVersion } from "../src/node-runtime.mjs";
import { nativePayloads } from "../src/native-bridge.mjs";
import { providerPayload, settingsPayload, snapshotMessage, snapshotProblems, tokenSigner } from "../src/native-protocol.mjs";
import { snapshot } from "../src/providers.mjs";
import { install, settingsPath } from "../src/settings.mjs";
import { codexEnv, installCodex } from "../src/codex.mjs";
import { runProtectionTest } from "../src/protection-test.mjs";
import { readInstall, readState } from "../src/store.mjs";

const REPO = new URL("..", import.meta.url).pathname;
const BIN = path.join(REPO, "bin", "peras.mjs");
const HOOK = `"${process.execPath}" "${BIN}"`;

/** A Mac account that has never seen Peras, Claude Code or Codex: only HOME, PATH and a SwiftBar folder that isn't the real one. */
function cleanAccount() {
  const home = tempDir("peras-clean-");
  return { home, env: { HOME: home, PATH: process.env.PATH, PERAS_NO_NOTIFY: "1", PERAS_SWIFTBAR_DIR: path.join(home, "swiftbar") } };
}
const cli = async (env, args) => { const lines = []; const code = await main(args, { env, out: (l) => lines.push(l), now: Date.now(), claudeVersion: () => assert.fail("claude --version was not expected") }); return { code, text: lines.join("\n") }; };
const files = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).map(String).sort() : []);

test("the recorded node is a path that survives upgrades: a steady link before a version folder, never a per-shell link", () => {
  const root = tempDir("peras-node-");
  const binary = path.join(root, "real", "node-binary");
  fs.mkdirSync(path.dirname(binary));
  fs.writeFileSync(binary, "");
  const link = (dir) => { fs.mkdirSync(path.join(root, dir), { recursive: true }); fs.symlinkSync(binary, path.join(root, dir, "node")); return path.join(root, dir); };
  const shell = link(".local/state/fnm_multishells/123_456/bin");
  const versioned = link(".nvm/versions/node/v22.3.0/bin");
  const steady = link("bin");
  const env = (...dirs) => ({ HOME: root, PATH: dirs.join(path.delimiter) });
  assert.equal(nodePath(env(shell, versioned, steady), binary), path.join(steady, "node"));
  assert.equal(nodePath(env(shell, versioned), binary), path.join(versioned, "node"), "a version folder beats the shell's link");
  assert.equal(nodePath(env(shell), binary), binary, "nothing steadier: the binary's own path");
  assert.deepEqual([parseNodeVersion("v22.3.0\n"), parseNodeVersion("node"), nodeSupported("18.0.0"), nodeSupported("16.20.2"), nodeSupported(null)], ["22.3.0", null, true, false, false]);
});

test("a clean account: --native readies the runtime and the launch record and touches neither Claude Code nor Codex", async () => {
  const { home, env } = cleanAccount();
  const r = await cli(env, ["menubar", "install", "--native"]);
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /Nothing is set up in Claude Code or Codex yet/);
  const record = JSON.parse(fs.readFileSync(launchFile(env), "utf8"));
  assert.equal(record.cli, path.join(home, ".peras", "app", "bin", "peras.mjs"));
  assert.ok(fs.existsSync(record.cli));
  assert.ok(path.isAbsolute(record.node) && fs.realpathSync(record.node) === fs.realpathSync(process.execPath));
  assert.deepEqual([record.nodeMin, record.nodeFix, record.runtimeVersion, record.environment], [18, NODE_FIX, VERSION, { PATH: process.env.PATH }]);
  assert.equal(fs.statSync(launchFile(env)).mode & 0o777, 0o600);
  for (const dir of [".claude", ".codex", "swiftbar"]) assert.equal(fs.existsSync(path.join(home, dir)), false, dir);
  assert.deepEqual(files(path.join(home, ".peras", "install")), [], "no install record");
  // A wrong extra word is refused, and the SwiftBar route still needs setup first.
  assert.equal((await cli(env, ["menubar", "install", "--native", "x"])).code, 1);
  assert.equal((await cli(env, ["menubar", "install"])).code, 1);
});

test("a clean account's first snapshot is valid, says to run setup, and writes nothing in Claude Code or Codex", async () => {
  const { home, env } = cleanAccount();
  const signer = tokenSigner();
  const providers = await nativePayloads(env, NOW, { reader: () => assert.fail("no Codex install: nothing to read"), signer });
  const message = snapshotMessage({ bridgeInstance: "b", revision: 1, now: NOW, providers, settings: settingsPayload(env, { now: NOW, sign: signer.sign }) });
  assert.deepEqual(snapshotProblems(message), []);
  assert.deepEqual(providers.map((p) => p.setup), [{ hooks: "missing", current: false, testPassedAtMs: null, next: "run_setup" }, { hooks: "missing", current: false, testPassedAtMs: null, next: "run_setup" }]);
  for (const dir of [".claude", ".codex"]) assert.equal(fs.existsSync(path.join(home, dir)), false, dir);
});

test("setup steps in order: hooks, this version's hooks, restart (Codex: trust, then restart), then nothing once a guard ran", async () => {
  const { env, root } = sandbox();
  const setupOf = async (provider = "claude") => providerPayload(await snapshot(env, Date.now(), { provider, cwd: null }), { now: Date.now(), sign: () => "t" }).setup;
  install({ env, command: HOOK, version: "0.3.1" });
  assert.equal((await setupOf()).next, "update_hooks", "hooks from another version");
  install({ env, command: HOOK, version: VERSION });
  assert.deepEqual(await setupOf(), { hooks: "configured", current: true, testPassedAtMs: null, next: "restart" });
  const run = spawnSync(process.execPath, [BIN, "hook"], { env, input: JSON.stringify({ hook_event_name: "PreToolUse", session_id: "s1", cwd: root, tool_name: "Bash" }), encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.equal((await setupOf()).next, null, "a live guard was observed");
  runProtectionTest(env);
  assert.ok(Number.isFinite((await setupOf()).testPassedAtMs), "the self-test for this configuration");
  const settings = JSON.parse(fs.readFileSync(settingsPath(env), "utf8"));
  // Any edit to the settings makes a configuration that was neither tested nor seen guarding.
  fs.writeFileSync(settingsPath(env), JSON.stringify({ ...settings, model: "edited" }));
  assert.deepEqual(await setupOf(), { hooks: "configured", current: true, testPassedAtMs: null, next: "restart" }, "a changed configuration is not the one tested");
  fs.writeFileSync(settingsPath(env), JSON.stringify({ ...settings, disableAllHooks: true }));
  assert.deepEqual(await setupOf(), { hooks: "disabled", current: false, testPassedAtMs: null, next: "enable_hooks" });
  installCodex(env, HOOK);
  assert.equal((await setupOf("codex")).next, "trust_and_restart");
});

test("a clean account through v0.4 setup, 0.3's setup and uninstall, and v0.4 again: every file reads, nothing is backed up that wasn't there, the app's runtime stays", async (t) => {
  const old = tempDir("peras-03-");
  const archive = spawnSync("git", ["-C", REPO, "archive", "v0.3.2", "src", "package.json"], { maxBuffer: 1 << 26 });
  if (archive.status !== 0 || spawnSync("tar", ["-x", "-C", old], { input: archive.stdout }).status !== 0) return t.skip("no v0.3.2 tag to compare with");
  assert.equal(JSON.parse(fs.readFileSync(path.join(old, "package.json"), "utf8")).version, "0.3.2");
  const { home, env } = cleanAccount();
  const peras = path.join(home, ".peras");
  assert.equal((await cli(env, ["menubar", "install", "--native"])).code, 0);
  assert.equal((await cli(env, ["setup"])).code, 0);
  const hook = spawnSync(process.execPath, [path.join(peras, "app", "bin", "peras.mjs"), "hook"], { env, input: JSON.stringify({ hook_event_name: "PreToolUse", session_id: "s1", cwd: home, tool_name: "Bash" }), encoding: "utf8" });
  assert.equal(hook.status, 0, hook.stderr);
  assert.ok(files(path.join(peras, "hook-memory")).length, "the hook kept its memory apart");
  assert.deepEqual(files(path.join(peras, "state")).filter((f) => f.includes("before-v04")), [], "nothing to back up on a fresh account");

  // Back to 0.3: it reads every file v0.4 wrote, then replaces and removes its hooks.
  const store03 = await import(path.join(old, "src", "store.mjs"));
  const settings03 = await import(path.join(old, "src", "settings.mjs"));
  const state03 = store03.readState(env, Date.now());
  assert.ok(state03 && Array.isArray(state03.resumed));
  assert.ok(store03.readInstall(env)?.command);
  assert.ok(Array.isArray(store03.readRules(env)));
  settings03.install({ env, command: HOOK, version: "0.3.2" });
  settings03.uninstall({ env });
  assert.equal(JSON.stringify(JSON.parse(fs.readFileSync(settingsPath(env), "utf8")).hooks ?? {}).includes("peras.mjs"), false);

  // v0.4's own uninstall keeps the runtime the app starts; setup again picks up where it was.
  assert.equal((await cli(env, ["setup"])).code, 0);
  assert.equal((await cli(env, ["remove"])).code, 0);
  assert.ok(fs.existsSync(JSON.parse(fs.readFileSync(launchFile(env), "utf8")).cli), "the app's runtime stays");
  assert.equal((await cli(env, ["setup"])).code, 0);
  assert.equal(readInstall(env).hookMemory, 1);
  assert.ok(readState(env, Date.now()));
  assert.ok(fs.existsSync(launchFile(env)), "setup's copy of the runtime leaves native/ alone");
  assert.equal(readInstall(codexEnv(env)), null, "Codex never set up");
});

test("--native on an account with older hooks refreshes them like any write command, keeping their settings", async () => {
  const { env } = sandbox();
  install({ env, command: HOOK, version: "0.3.1" });
  const r = await cli(env, ["menubar", "install", "--native"]);
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /Updated the hooks from Peras 0\.3\.1/);
  assert.equal(readInstall(env).version, VERSION);
  assert.doesNotMatch(r.text, /Nothing is set up/);
  assert.equal(readInstall(codexEnv(env)), null, "no Codex hooks added");
});

test("a home with spaces: the installed tool check runs through the shell and denies, and the launch record keeps the paths whole", async () => {
  const { home: base } = cleanAccount();
  const home = path.join(base, "Mac HD", "J Doe");
  fs.mkdirSync(home, { recursive: true });
  const env = { HOME: home, PATH: process.env.PATH, PERAS_NO_NOTIFY: "1", PERAS_SWIFTBAR_DIR: path.join(home, "swift bar") };
  assert.equal((await cli(env, ["setup"])).code, 0);
  assert.equal((await cli(env, ["menubar", "install", "--native"])).code, 0);
  assert.equal(JSON.parse(fs.readFileSync(launchFile(env), "utf8")).cli, path.join(home, ".peras", "app", "bin", "peras.mjs"));
  assert.equal((await cli(env, ["pause"])).code, 0);
  const command = JSON.parse(fs.readFileSync(settingsPath(env), "utf8")).hooks.PreToolUse.flatMap((g) => g.hooks).find((h) => /peras\.mjs"? hook/.test(h.command)).command;
  const r = spawnSync("/bin/sh", ["-c", command], { env, input: JSON.stringify({ hook_event_name: "PreToolUse", session_id: "s1", cwd: home, tool_name: "Bash" }), encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, "deny");
});

test("custom roots travel in the launch record, since Finder won't pass the shell's", async () => {
  const { home, env: base } = cleanAccount();
  const env = { ...base, PERAS_HOME: path.join(home, "my peras"), CLAUDE_CONFIG_DIR: path.join(home, "cc"), CODEX_HOME: path.join(home, "cx") };
  assert.equal((await cli(env, ["menubar", "install", "--native"])).code, 0);
  const record = JSON.parse(fs.readFileSync(path.join(home, "my peras", "native", "launch.json"), "utf8"));
  assert.deepEqual(record.environment, { PERAS_HOME: env.PERAS_HOME, CLAUDE_CONFIG_DIR: env.CLAUDE_CONFIG_DIR, CODEX_HOME: env.CODEX_HOME, PATH: env.PATH });
  assert.equal(record.cli, path.join(env.PERAS_HOME, "app", "bin", "peras.mjs"));
});

test("repeated --native, setup and remove settle the same way; the legacy SwiftBar plugin and unrelated plugins are left as they are", async () => {
  const { home, env } = cleanAccount();
  fs.mkdirSync(env.PERAS_SWIFTBAR_DIR, { recursive: true });
  const other = path.join(env.PERAS_SWIFTBAR_DIR, "weather.10m.sh");
  fs.writeFileSync(other, "#!/bin/sh\necho sun\n");
  assert.equal((await cli(env, ["setup"])).code, 0);
  assert.equal((await cli(env, ["menubar", "install", env.PERAS_SWIFTBAR_DIR])).code, 0);
  const swiftbar = () => Object.fromEntries(files(env.PERAS_SWIFTBAR_DIR).map((f) => [f, fs.readFileSync(path.join(env.PERAS_SWIFTBAR_DIR, f), "utf8")]));
  const plugins = swiftbar();
  assert.equal(Object.keys(plugins).length, 2, "Peras's plugin next to the other one");
  for (let i = 0; i < 2; i++) assert.equal((await cli(env, ["menubar", "install", "--native"])).code, 0);
  assert.equal((await cli(env, ["setup"])).code, 0);
  assert.deepEqual(swiftbar(), plugins, "--native and setup leave SwiftBar's folder alone");
  const record = fs.readFileSync(launchFile(env), "utf8");
  for (let i = 0; i < 2; i++) assert.equal((await cli(env, ["remove"])).code, 0);
  assert.deepEqual(files(env.PERAS_SWIFTBAR_DIR), ["weather.10m.sh"], "only Peras's plugin goes");
  assert.equal(fs.readFileSync(launchFile(env), "utf8"), record);
  assert.ok(fs.existsSync(path.join(home, ".peras", "app", "bin", "peras.mjs")));
});

test("interrupted midway: a half-copied runtime, a migration stopped after its backup, a damaged launch record all recover on the next run", async () => {
  const { home, env } = cleanAccount();
  const peras = path.join(home, ".peras");
  assert.equal((await cli(env, ["setup"])).code, 0);
  // The runtime copy stopped after removing the old one: setup again restores it.
  fs.rmSync(path.join(peras, "app", "src"), { recursive: true });
  assert.equal((await cli(env, ["setup"])).code, 0);
  assert.ok(fs.existsSync(path.join(peras, "app", "src", "hook.mjs")));
  // 0.3's state, then a migration that kept its backup and stopped before writing hook memory.
  const { stateFile, hookMemoryFile, writeState } = await import("../src/store.mjs");
  fs.rmSync(path.join(peras, "hook-memory"), { recursive: true, force: true });
  writeState(env, { notified: [], resumed: [], asked: {}, prompts: {}, sessions: { s0: { cwd: home, t: Date.now(), startedAt: Date.now() } }, latched: [], manualPause: null, failWarnAt: 0 });
  const legacy = fs.readFileSync(stateFile(env), "utf8");
  fs.copyFileSync(stateFile(env), stateFile(env).replace(/\.json$/, ".before-v04.json"));
  const r = spawnSync(process.execPath, [path.join(peras, "app", "bin", "peras.mjs"), "hook"], { env, input: JSON.stringify({ hook_event_name: "PreToolUse", session_id: "s1", cwd: home, tool_name: "Bash" }), encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const memory = JSON.parse(fs.readFileSync(hookMemoryFile(env), "utf8"));
  assert.ok(memory.sessions.s0 && memory.sessions.s1, "0.3's memory carried over, the new session added");
  assert.equal(fs.readFileSync(stateFile(env).replace(/\.json$/, ".before-v04.json"), "utf8"), legacy, "the backup is not replaced");
  // A damaged launch record is written again.
  fs.mkdirSync(path.dirname(launchFile(env)), { recursive: true });
  fs.writeFileSync(launchFile(env), "{ half");
  assert.equal((await cli(env, ["menubar", "install", "--native"])).code, 0);
  assert.equal(JSON.parse(fs.readFileSync(launchFile(env), "utf8")).nodeMin, 18);
});
