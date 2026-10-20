import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { runHook } from "../src/hook.mjs";
import { codexEnv, runCodexHook } from "../src/codex.mjs";
import { pauseNow, perasHome, readState } from "../src/store.mjs";
import { sandbox, NOW } from "./helpers.mjs";

const noCodex = async () => { throw new Error("no codex in tests"); };
const failing = () => { throw new Error("notifier broke"); };

/** Every file and folder under the Peras home read-only: each write after the verdict fails. */
function readOnly(t, env) {
  const all = [];
  const walk = (dir) => { all.push(dir); for (const e of fs.readdirSync(dir, { withFileTypes: true })) e.isDirectory() ? walk(path.join(dir, e.name)) : all.push(path.join(dir, e.name)); };
  walk(perasHome(env));
  for (const p of all) fs.chmodSync(p, fs.statSync(p).isDirectory() ? 0o500 : 0o400);
  t.after(() => { for (const p of all) fs.chmodSync(p, fs.statSync(p).isDirectory() ? 0o700 : 0o600); });
}

test("Claude: a pause stays a deny when every write and the notifier fail after the verdict", (t) => {
  const { env, root } = sandbox();
  pauseNow(env, { now: NOW - 60_000 });
  readOnly(t, env);
  assert.throws(() => fs.writeFileSync(path.join(perasHome(env), "probe"), ""), "the home really is read-only");
  const out = runHook({ input: { hook_event_name: "PreToolUse", session_id: "s1", cwd: root, tool_name: "Bash" }, env, now: NOW, notify: failing });
  assert.equal(out?.hookSpecificOutput?.permissionDecision, "deny");
  assert.equal(out.continue, false);
  const batch = runHook({ input: { hook_event_name: "PostToolBatch", session_id: "s1", cwd: root }, env, now: NOW + 1, notify: failing });
  assert.equal(batch?.decision, "block");
});

test("Claude: a failure before any verdict still goes ahead with a warning, as before", (t) => {
  const { env, root } = sandbox();
  readState(env, NOW);
  fs.mkdirSync(perasHome(env), { recursive: true });
  fs.writeFileSync(path.join(perasHome(env), "config.json"), "{ not json");
  const out = runHook({ input: { hook_event_name: "PreToolUse", session_id: "s1", cwd: root, tool_name: "Bash" }, env, now: NOW });
  assert.equal(out?.hookSpecificOutput, undefined);
  assert.match(out?.systemMessage ?? "", /goes ahead/);
});

test("Codex: a pause stays a deny when every write and the notifier fail after the verdict", async (t) => {
  const { env, root } = sandbox();
  pauseNow(codexEnv(env), { now: NOW - 60_000 });
  readOnly(t, env);
  const out = await runCodexHook({ input: { hook_event_name: "PreToolUse", session_id: "s1", turn_id: "t1", cwd: root, tool_name: "shell" }, env, now: NOW, reader: noCodex, notify: failing });
  assert.equal(out?.hookSpecificOutput?.permissionDecision, "deny");
});

test("through bin/peras.mjs: the deny reaches the host on stdout with exit 0, in a read-only home", async (t) => {
  const { spawnSync } = await import("node:child_process");
  const { env, root } = sandbox();
  pauseNow(env, { now: Date.now() - 60_000 });
  readOnly(t, env);
  const bin = new URL("../bin/peras.mjs", import.meta.url).pathname;
  const run = (input) => spawnSync(process.execPath, [bin, "hook"], { env: { ...env, PERAS_NO_NOTIFY: "1" }, input: JSON.stringify(input), encoding: "utf8" });
  const claude = run({ hook_event_name: "PreToolUse", session_id: "s1", cwd: root, tool_name: "Bash" });
  assert.equal(claude.status, 0, claude.stderr);
  assert.equal(JSON.parse(claude.stdout).hookSpecificOutput.permissionDecision, "deny");
});
