import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { sandbox, NOW, VERSION, tempDir } from "./helpers.mjs";
import { main } from "../src/cli.mjs";
import { install, settingsPath } from "../src/settings.mjs";
import { failurePolicy } from "../src/failure-policy.mjs";
import { installFile, pauseNow, perasHome, readInstall, stateFile, writeInstall } from "../src/store.mjs";
import { snapshot } from "../src/providers.mjs";
import { providerPayload } from "../src/native-protocol.mjs";

const REPO = new URL("..", import.meta.url).pathname;
const BIN = path.join(REPO, "bin", "peras.mjs");
const COMMAND = `"${process.execPath}" "${BIN}"`;
// Tests never start the real claude: its version is handed in.
const cli = (env, args, version = "2.1.302") => { const lines = []; return main(args, { env, out: (l) => lines.push(l), now: NOW, claudeVersion: () => version }).then((code) => ({ code, text: lines.join("\n") })); };
const settings = (env) => JSON.parse(fs.readFileSync(settingsPath(env), "utf8"));
const ours = (group) => group.hooks.filter((h) => /peras\.mjs"?\s+hook/.test(h.command));
const toolHook = (env) => settings(env).hooks.PreToolUse.flatMap(ours)[0];

function home() {
  const box = sandbox();
  install({ env: box.env, command: COMMAND, version: VERSION });
  return box;
}

test("strict on writes only the tool check: blocks on failure, no fallback; prompts and the status line keep theirs", async () => {
  const { env } = home();
  const before = settings(env);
  const on = await cli(env, ["strict", "on"]);
  assert.equal(on.code, 0, on.text);
  assert.match(on.text, /Strict mode is on/);
  const hook = toolHook(env);
  assert.equal(hook.onFailure, "block");
  assert.ok(hook.command.startsWith("PERAS_STRICT=1 ") && hook.command.endsWith(" hook"), hook.command);
  const after = settings(env);
  assert.deepEqual(after.hooks.UserPromptSubmit, before.hooks.UserPromptSubmit);
  assert.deepEqual(after.hooks.PostToolBatch, before.hooks.PostToolBatch);
  assert.deepEqual(after.statusLine, before.statusLine);
  assert.deepEqual(failurePolicy(env), { mode: "strict", strict: "supported", claudeVersion: "2.1.302" });
  const off = await cli(env, ["strict", "off"]);
  assert.match(off.text, /Strict mode is off/);
  assert.deepEqual(settings(env), before);
});

test("an older or unreadable Claude Code version changes nothing", async () => {
  const { env } = home();
  const before = fs.readFileSync(settingsPath(env), "utf8");
  for (const version of ["2.1.294", null]) {
    const r = await cli(env, ["strict", "on"], version);
    assert.equal(r.code, 1);
    assert.match(r.text, /2\.1\.295 or later.*Nothing was changed/s);
    assert.equal(fs.readFileSync(settingsPath(env), "utf8"), before);
  }
  assert.equal(failurePolicy(env).mode, "default");
});

test("setup, and the automatic refresh of older hooks, keep strict on", async () => {
  const { env } = home();
  await cli(env, ["strict", "on"]);
  install({ env, command: COMMAND, version: VERSION });
  assert.equal(toolHook(env).onFailure, "block", "setup again");
  writeInstall(env, { ...readInstall(env), version: "0.3.1" });
  const r = await cli(env, ["pause", "1h"]);
  assert.match(r.text, /Updated the hooks from Peras 0\.3\.1/);
  assert.equal(failurePolicy(env).mode, "strict", "refreshed from an older version");
  assert.ok(fs.readFileSync(installFile(env), "utf8").includes('"failurePolicy": "strict"'));
});

test("rolling back: 0.3's setup replaces the strict hook with its own and its uninstall takes it out", async (t) => {
  const dir = tempDir("peras-03-");
  const archive = spawnSync("git", ["-C", REPO, "archive", "v0.3.2", "src", "package.json"], { maxBuffer: 1 << 26 });
  if (archive.status !== 0 || spawnSync("tar", ["-x", "-C", dir], { input: archive.stdout }).status !== 0) return t.skip("no v0.3.2 tag to compare with");
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).version, "0.3.2");
  const settings03 = await import(path.join(dir, "src", "settings.mjs"));
  const { env } = home();
  await cli(env, ["strict", "on"]);
  settings03.install({ env, command: COMMAND, version: "0.3.2" });
  for (const event of ["UserPromptSubmit", "PreToolUse", "PostToolBatch"]) {
    const found = settings(env).hooks[event].flatMap(ours);
    assert.equal(found.length, 1, event);
    assert.equal(found[0].onFailure, undefined, event);
  }
  settings03.uninstall({ env });
  assert.equal(JSON.stringify(settings(env).hooks ?? {}).includes("peras.mjs"), false);
});

test("the wire reports the policy as written: default and unknown until checked, Codex unsupported", async () => {
  const { env } = home();
  const policies = async () => (await Promise.all(["claude", "codex"].map((provider) => snapshot(env, NOW, { provider, cwd: null })))).map((s) => providerPayload(s, { now: NOW, sign: () => "t" }).failurePolicy);
  assert.deepEqual(await policies(), [{ mode: "default", strict: "unknown" }, { mode: "default", strict: "unsupported" }]);
  await cli(env, ["strict", "on"]);
  assert.deepEqual((await policies())[0], { mode: "strict", strict: "supported", claudeVersion: "2.1.302" });
  // Strict taken out of the settings by hand: the wire says so, whatever the record says.
  const s = settings(env);
  s.hooks.PreToolUse = s.hooks.PreToolUse.map((g) => ({ ...g, hooks: g.hooks.map(({ onFailure, ...h }) => h) }));
  fs.writeFileSync(settingsPath(env), JSON.stringify(s));
  assert.equal((await policies())[0].mode, "default");
});

// The hook as Claude Code runs it: a process, stdin in, exit code and stdout out.
const hook = (env, input, { strict, bin = BIN } = {}) => spawnSync(process.execPath, [bin, "hook"], { env: { ...env, ...(strict ? { PERAS_STRICT: "1" } : {}) }, input: typeof input === "string" ? input : JSON.stringify(input), encoding: "utf8" });
const tool = (root) => ({ hook_event_name: "PreToolUse", session_id: "s1", cwd: root, tool_name: "Bash" });
const blocked = (r) => { assert.equal(r.status, 2, r.stderr); assert.match(r.stderr, /strict mode blocks tools/); assert.doesNotMatch(r.stderr, /\/|resume/, "fixed text: no path, no way to lift a pause"); };
const wentAhead = (r) => { assert.equal(r.status, 0, r.stderr); assert.notEqual(r.stdout && JSON.parse(r.stdout).hookSpecificOutput?.permissionDecision, "deny"); };

test("malformed input: strict blocks, default goes ahead with a warning", () => {
  const { env } = home();
  blocked(hook(env, "{ not json", { strict: true }));
  const r = hook(env, "{ not json");
  wentAhead(r);
  assert.match(JSON.parse(r.stdout).systemMessage, /goes ahead/);
});

test("a corrupt pause/resume file: strict blocks, default reads it as no pause", () => {
  const { env, root } = home();
  fs.mkdirSync(path.dirname(stateFile(env)), { recursive: true });
  fs.writeFileSync(stateFile(env), "{ half a file");
  blocked(hook(env, tool(root), { strict: true }));
  wentAhead(hook(env, tool(root)));
  fs.rmSync(stateFile(env));
  wentAhead(hook(env, tool(root), { strict: true }), "a missing file is a fresh install, not an error");
});

test("a broken file in the runtime: strict blocks, default goes ahead with a warning", () => {
  const { env, root } = home();
  const app = tempDir("peras-app-");
  for (const part of ["bin", "src", "package.json"]) fs.cpSync(path.join(REPO, part), path.join(app, part), { recursive: true });
  fs.writeFileSync(path.join(app, "src", "rules.mjs"), "export const = ;");
  const bin = path.join(app, "bin", "peras.mjs");
  blocked(hook(env, tool(root), { strict: true, bin }));
  const r = hook(env, tool(root), { bin });
  wentAhead(r);
  assert.match(JSON.parse(r.stdout).systemMessage, /goes ahead/);
});

test("node gone: the strict command fails for Claude Code to block; the default one says so and lets it run", () => {
  const { env } = home();
  const gone = `"/nonexistent/node" "${BIN}"`;
  install({ env, command: gone, version: VERSION, failurePolicy: "strict" });
  const strictRun = spawnSync("/bin/sh", ["-c", toolHook(env).command], { input: "{}", encoding: "utf8" });
  assert.equal(strictRun.status, 127, "a failure, which onFailure: block turns into a blocked tool");
  install({ env, command: gone, version: VERSION, failurePolicy: "default" });
  const defaultRun = spawnSync("/bin/sh", ["-c", toolHook(env).command], { input: "{}", encoding: "utf8" });
  assert.equal(defaultRun.status, 0);
  assert.match(JSON.parse(defaultRun.stdout).systemMessage, /could not run/);
});

/** Peras home read-only: the hook's own bookkeeping cannot be saved. */
function readOnly(t, env) {
  const all = [];
  const walk = (dir) => { all.push(dir); for (const e of fs.readdirSync(dir, { withFileTypes: true })) e.isDirectory() ? walk(path.join(dir, e.name)) : all.push(path.join(dir, e.name)); };
  walk(perasHome(env));
  for (const p of all) fs.chmodSync(p, fs.statSync(p).isDirectory() ? 0o500 : 0o400);
  t.after(() => { for (const p of all) fs.chmodSync(p, fs.statSync(p).isDirectory() ? 0o700 : 0o600); });
}

test("bookkeeping that can't be saved: strict blocks an allow, default lets it run; a worked-out pause is a deny in both", (t) => {
  const { env, root } = home();
  hook(env, tool(root));
  readOnly(t, env);
  // A new session forces a memory write.
  blocked(hook(env, { ...tool(root), session_id: "s2" }, { strict: true }));
  wentAhead(hook(env, { ...tool(root), session_id: "s3" }));
  const paused = home();
  pauseNow(paused.env, { now: Date.now() - 60_000 });
  readOnly(t, paused.env);
  for (const strict of [true, false]) {
    const r = hook(paused.env, tool(paused.root), { strict });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, "deny", `strict: ${strict}`);
  }
});
