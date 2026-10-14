import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { sandbox, statusInput } from "./helpers.mjs";
import { stripAnsi } from "../src/look.mjs";
import { codexEnv, cachePath } from "../src/codex.mjs";
import { pauseNow, resume } from "../src/store.mjs";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "peras.mjs");

// Runs a command string through a shell, the way Claude Code runs hooks and status lines.
const sh = (command, env, input = "") =>
  spawnSync(command, { shell: true, env, input, encoding: "utf8", cwd: env.HOME });
const peras = (args, env) => spawnSync(process.execPath, [BIN, ...args], { env, encoding: "utf8" });

test("a legacy Claude hook loaded by Codex enforces Codex pause and resume", () => {
  const { env, root } = sandbox();
  const cache = cachePath(env);
  fs.mkdirSync(path.dirname(cache), { recursive: true });
  fs.writeFileSync(cache, JSON.stringify({ at: Date.now(), reading: {} }));
  const scoped = codexEnv(env);
  pauseNow(scoped);
  const input = JSON.stringify({ hook_event_name: "PreToolUse", turn_id: "codex-turn", session_id: "codex-session", cwd: root, tool_name: "Bash" });
  const invoke = () => spawnSync(process.execPath, [BIN, "hook"], { env, input, encoding: "utf8" });
  const denied = invoke();
  assert.equal(denied.status, 0, denied.stderr);
  assert.equal(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision, "deny");
  resume(scoped);
  pauseNow(env);
  const allowed = invoke();
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(allowed.stdout, "", "Claude's pause must not block Codex after Codex resumes");
});

test("SwiftBar runs the installed streaming script and stops its animation process cleanly", async () => {
  const { env, root, claude } = sandbox();
  env.PERAS_SWIFTBAR_DIR = path.join(root, "swiftbar");
  assert.equal(peras(["setup"], env).status, 0);
  const settings = JSON.parse(fs.readFileSync(path.join(claude, "settings.json"), "utf8"));
  const future = Math.floor(Date.now() / 1000) + 72 * 3600;
  sh(settings.statusLine.command, env, JSON.stringify(statusInput({ fiveHour: 37, sevenDay: 60, fiveResets: future, sevenResets: future })));
  assert.equal(peras(["menubar", "install"], env).status, 0);
  const plugin = JSON.parse(fs.readFileSync(path.join(env.PERAS_HOME, "menubar.json"), "utf8")).file;
  assert.match(fs.readFileSync(plugin, "utf8"), /<swiftbar.type>streamable<\/swiftbar.type>/);
  assert.match(fs.readFileSync(plugin, "utf8"), /<swiftbar.useTrailingStreamSeparator>true<\/swiftbar.useTrailingStreamSeparator>/);
  const child = spawn(plugin, [], { env: { ...env, SWIFTBAR: "1" }, cwd: env.HOME, stdio: ["ignore", "pipe", "pipe"] });
  let output = "", stderr = "", terminated = false;
  const timer = setTimeout(() => child.kill("SIGKILL"), 6000);
  try {
    await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.stdout.on("data", (chunk) => {
        output += chunk;
        if (!terminated && output.split("\n~~~\n").length >= 3) { terminated = true; child.kill("SIGTERM"); }
      });
      child.on("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`stream exited ${code}/${signal}: ${stderr}`)));
    });
  } finally { clearTimeout(timer); }
  const menus = output.split("\n~~~\n").filter(Boolean);
  assert.ok(menus.length >= 2);
  const tracks = menus.map((m) => m.split("\n").find((l) => l.startsWith("5h")));
  assert.notEqual(tracks[0], tracks[1], "the installed runtime changes the mascot image");
  assert.match(menus[0], /param1=pause param2=1h/);
  assert.match(menus[0], /param1=menubar param2=display param3=pear/);
});

test("setup → the written status line and hook really pause → resume → remove", () => {
  const { env, claude, home } = sandbox();
  const settings = path.join(claude, "settings.json");
  fs.writeFileSync(settings, JSON.stringify({ model: "opus" }));

  const setup = peras(["setup"], env);
  assert.equal(setup.status, 0, setup.stdout + setup.stderr);
  const s = JSON.parse(fs.readFileSync(settings, "utf8"));
  const hookCmd = s.hooks.PreToolUse[0].hooks[0].command;
  assert.ok(hookCmd.includes(path.join(home, "app", "bin", "peras.mjs")), "hooks run the copy, not the package");

  // Claude Code renders the status line with a window at 93% of the week.
  const future = Math.floor(Date.now() / 1000) + 3 * 3600;
  const line = sh(s.statusLine.command, env, JSON.stringify(statusInput({ fiveHour: 20, sevenDay: 93, fiveResets: future, sevenResets: future + 72 * 3600 })));
  assert.equal(line.status, 0, line.stderr);
  assert.match(stripAnsi(line.stdout), /^🍐 ⏸️ paused · 5h 20% · 7d 93%/);

  const pre = JSON.stringify({ hook_event_name: "PreToolUse", session_id: "a", tool_name: "Bash", tool_input: { command: "ls" } });
  const t0 = Date.now();
  const denied = sh(hookCmd, env, pre);
  const ms = Date.now() - t0;
  assert.equal(denied.status, 0, denied.stderr);
  const answer = JSON.parse(denied.stdout);
  assert.equal(answer.hookSpecificOutput.permissionDecision, "deny");
  assert.equal(answer.continue, false);
  assert.ok(ms < 2000, `hook took ${ms} ms`);

  const prompt = sh(hookCmd, env, JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "a", prompt: "hi" }));
  assert.match(JSON.parse(prompt.stdout).systemMessage, /paused/);

  assert.match(peras(["status"], env).stdout, /PAUSED/);
  assert.match(peras(["resume"], env).stdout, /Lifted: weekly 93%/);
  assert.equal(sh(hookCmd, env, pre).stdout, "");
  assert.match(peras(["status"], env).stdout, /Resumed until/);
  assert.doesNotMatch(peras(["status"], env).stdout, /Under every line/);

  const removed = peras(["remove"], env);
  assert.equal(removed.status, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(settings, "utf8")), { model: "opus" });
  assert.equal(fs.existsSync(path.join(home, "app")), false);
});

test("the installed menu bar script resumes a folder pause from outside the project", () => {
  const { env, root, claude } = sandbox();
  env.PERAS_SWIFTBAR_DIR = path.join(root, "swiftbar");
  const project = path.join(root, "project");
  fs.mkdirSync(project);
  assert.equal(peras(["setup"], env).status, 0);
  const set = spawnSync(process.execPath, [BIN, "set", "--here", "weekly", "60", "pause"], { env, cwd: project, encoding: "utf8" });
  assert.equal(set.status, 0, set.stderr + set.stdout);
  const settings = JSON.parse(fs.readFileSync(path.join(claude, "settings.json"), "utf8"));
  const hook = settings.hooks.PreToolUse[0].hooks[0].command;
  const reset = Math.floor(Date.now() / 1000) + 72 * 3600;
  sh(settings.statusLine.command, env, JSON.stringify(statusInput({ sevenDay: 70, sevenResets: reset })));
  const input = JSON.stringify({ hook_event_name: "PreToolUse", session_id: "folder-session", cwd: project });
  assert.equal(JSON.parse(sh(hook, env, input).stdout).hookSpecificOutput.permissionDecision, "deny");
  assert.equal(peras(["menubar", "install"], env).status, 0);
  const plugin = JSON.parse(fs.readFileSync(path.join(env.PERAS_HOME, "menubar.json"), "utf8")).file;
  const show = spawnSync(plugin, [], { env, cwd: env.HOME, encoding: "utf8" });
  assert.equal(show.status, 0, show.stderr);
  assert.match(show.stdout, /Paused: weekly 70% \(line 60%\)/);
  assert.match(show.stdout, /param1=resume param2=1h/);
  const lifted = spawnSync(plugin, ["resume", "1h"], { env, cwd: env.HOME, encoding: "utf8" });
  assert.equal(lifted.status, 0, lifted.stderr);
  assert.match(lifted.stdout, /Lifted: weekly 70% \(line 60%\)/);
  const display = spawnSync(plugin, ["menubar", "display", "pear"], { env, cwd: env.HOME, encoding: "utf8" });
  assert.equal(display.status, 0, display.stderr);
  const compact = spawnSync(plugin, [], { env, cwd: env.HOME, encoding: "utf8" });
  assert.equal(compact.status, 0, compact.stderr);
  assert.match(compact.stdout.split("\n")[0], /width=11 height=20/);
  assert.match(compact.stdout, /Week +70% · .+ \| image=/);
  assert.match(compact.stdout, /param1=menubar param2=display param3=pear.*checked=true/);
  const after = sh(hook, env, input);
  assert.equal(after.status, 0, after.stderr);
  assert.equal(after.stdout, "");
});

test("a hook given garbage still lets the action go ahead, and says why", () => {
  const { env } = sandbox();
  peras(["setup"], env);
  const hookCmd = JSON.parse(fs.readFileSync(path.join(env.CLAUDE_CONFIG_DIR, "settings.json"), "utf8")).hooks.PreToolUse[0].hooks[0].command;
  const r = sh(hookCmd, env, "not json");
  assert.equal(r.status, 0);
  assert.match(JSON.parse(r.stdout).systemMessage, /could not check/);
});

test("set changes a line, and refuses nonsense without writing", () => {
  const { env } = sandbox();
  assert.match(peras(["set", "weekly", "85", "pause"], env).stdout, /weekly 85% pause/);
  assert.doesNotMatch(peras(["set"], env).stdout, /weekly 90% pause/);
  const bad = peras(["set", "monthly", "50", "pause"], env);
  assert.equal(bad.status, 1);
  assert.match(peras(["set", "reset"], env).stdout, /weekly 90% pause/);
});

test("if the node the hooks were written with disappears, the hook still says so (never a silent pass)", () => {
  const { env } = sandbox();
  peras(["setup"], env);
  const s = JSON.parse(fs.readFileSync(path.join(env.CLAUDE_CONFIG_DIR, "settings.json"), "utf8"));
  const broken = (cmd) => cmd.replace(/^"[^"]+"/, '"/nonexistent/node"');
  const hook = sh(broken(s.hooks.PreToolUse[0].hooks[0].command), env, "{}");
  assert.equal(hook.status, 0);
  assert.match(JSON.parse(hook.stdout).systemMessage, /Peras could not run/);
  const line = sh(broken(s.statusLine.command), env, "{}");
  assert.match(line.stdout, /Peras could not run/);
  // remove still recognises the commands it wrote.
  peras(["remove"], env);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(env.CLAUDE_CONFIG_DIR, "settings.json"), "utf8")), {});
});

test("the resume hint works as typed, however Peras was installed", async () => {
  const { resumeHintFor } = await import("../src/cli.mjs");
  const name = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).name;
  const cmd = '"/n/node" "/h/.peras/app/bin/peras.mjs"';
  assert.equal(resumeHintFor({ onPath: true, root: "/x", command: cmd }), "peras resume");
  assert.equal(resumeHintFor({ onPath: false, root: `/u/.npm/_npx/ab12/node_modules/${name}`, command: cmd }), `npx ${name} resume`);
  assert.equal(resumeHintFor({ onPath: false, root: "/src/peras", command: cmd }), `${cmd} resume`);
  // npx puts its own temporary bin on PATH while it runs, so "peras" looks installed
  // when it is not (seen on the published 0.1.0, 2026-10-14).
  assert.equal(resumeHintFor({ onPath: true, root: `/u/.npm/_npx/ab12/node_modules/${name}`, command: cmd }), `npx ${name} resume`);
});

test("upgrading a 0.1 install: setup replaces the runtime and says so", () => {
  const { env, claude, home } = sandbox();
  fs.writeFileSync(path.join(claude, "settings.json"), "{}");
  peras(["setup"], env);
  // Make it look like 0.1.1 set it up: an old runtime copy and an old record.
  const appPkg = path.join(home, "app", "package.json");
  fs.writeFileSync(appPkg, JSON.stringify({ name: "peras-cli", version: "0.1.1" }));
  const installDir = path.join(home, "install");
  const record = path.join(installDir, fs.readdirSync(installDir)[0]);
  fs.writeFileSync(record, JSON.stringify({ ...JSON.parse(fs.readFileSync(record, "utf8")), version: "0.1.1" }));
  assert.match(peras(["status"], env).stdout, /still run Peras 0\.1\.1/);
  const again = peras(["setup"], env);
  assert.match(again.stdout, /updated from 0\.1\.1 to /);
  assert.notEqual(JSON.parse(fs.readFileSync(appPkg, "utf8")).version, "0.1.1");
  assert.doesNotMatch(peras(["status"], env).stdout, /still run Peras/);
  assert.match(peras(["doctor"], env).stdout, /hooks in/);
});

test("a command that changes the lines first brings older hooks up to date", () => {
  const { env, claude, home } = sandbox();
  fs.writeFileSync(path.join(claude, "settings.json"), "{}");
  peras(["setup"], env);
  const appPkg = path.join(home, "app", "package.json");
  fs.writeFileSync(appPkg, JSON.stringify({ name: "peras-cli", version: "0.1.1" }));
  const installDir = path.join(home, "install");
  const record = path.join(installDir, fs.readdirSync(installDir)[0]);
  fs.writeFileSync(record, JSON.stringify({ ...JSON.parse(fs.readFileSync(record, "utf8")), version: "0.1.1" }));
  const set = peras(["set", "prompt", "3", "pause"], env);
  assert.equal(set.status, 0, set.stdout);
  assert.match(set.stdout, /Updated the hooks from Peras 0\.1\.1/);
  assert.notEqual(JSON.parse(fs.readFileSync(appPkg, "utf8")).version, "0.1.1");
  assert.doesNotMatch(peras(["set", "weekly", "80", "warn"], env).stdout, /Updated the hooks/);
});
