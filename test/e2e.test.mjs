import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { sandbox, statusInput } from "./helpers.mjs";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "peras.mjs");

// Runs a command string through a shell, the way Claude Code runs hooks and status lines.
const sh = (command, env, input = "") =>
  spawnSync(command, { shell: true, env, input, encoding: "utf8", cwd: env.HOME });
const peras = (args, env) => spawnSync(process.execPath, [BIN, ...args], { env, encoding: "utf8" });

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
  const line = sh(s.statusLine.command, env, JSON.stringify(statusInput({ fiveHour: 20, sevenDay: 93 })));
  assert.equal(line.status, 0, line.stderr);
  assert.match(line.stdout, /🍐 ⏸ paused · 5h 20% · 7d 93%/);

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
