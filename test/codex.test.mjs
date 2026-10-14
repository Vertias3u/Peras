import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { sandbox } from "./helpers.mjs";
import { codexEnv, hooksPath, installCodex, readingFromRateLimits, removeCodex, runCodexHook } from "../src/codex.mjs";
import { pauseNow, resume, readRules, writeRules } from "../src/store.mjs";

const now = Date.UTC(2026, 9, 14, 12);
const limits = (pct) => ({ rateLimits: { limitId: "codex", primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: (now + 3600_000) / 1000 }, secondary: { usedPercent: pct, windowDurationMins: 10080, resetsAt: (now + 72 * 3600_000) / 1000 } } });

test("Codex rate-limit buckets become Peras windows", () => {
  const reading = readingFromRateLimits(limits(93), now);
  assert.equal(reading.five_hour.usedPct, 20);
  assert.equal(reading.seven_day.usedPct, 93);
});

test("Codex rules are separate from Claude rules", () => {
  const { env, root } = sandbox();
  env.CODEX_HOME = path.join(root, "codex");
  writeRules(codexEnv(env), [{ kind: "window", window: "seven_day", at: 20, action: "pause" }]);
  assert.equal(readRules(codexEnv(env))[0].at, 20);
  assert.equal(readRules(env)[0].at, 75);
});

test("Codex hooks install and remove without touching other hooks", () => {
  const { env, root } = sandbox();
  env.CODEX_HOME = path.join(root, "codex");
  fs.mkdirSync(env.CODEX_HOME);
  const original = { hooks: { SessionStart: [{ hooks: [{ type: "command", command: "hello" }] }] } };
  fs.writeFileSync(hooksPath(env), JSON.stringify(original));
  installCodex(env, '"/usr/bin/node" "/tmp/app/bin/peras.mjs"');
  assert.equal(JSON.parse(fs.readFileSync(hooksPath(env))).hooks.PreToolUse.length, 1);
  removeCodex(env);
  assert.deepEqual(JSON.parse(fs.readFileSync(hooksPath(env))), original);
});

test("Codex hook denies at the weekly pause line and resume lifts it", async () => {
  const { env, root } = sandbox();
  env.CODEX_HOME = path.join(root, "codex");
  const input = { hook_event_name: "PreToolUse", session_id: "s1", cwd: root, tool_name: "Bash" };
  const reader = async () => limits(93);
  const denied = await runCodexHook({ input, env, now, reader });
  assert.equal(denied.hookSpecificOutput.permissionDecision, "deny");
  assert.equal("continue" in denied, false);
  assert.equal("stopReason" in denied, false);
  resume(codexEnv(env), { now });
  const allowed = await runCodexHook({ input, env, now: now + 1000, reader });
  assert.equal(allowed?.hookSpecificOutput?.permissionDecision, undefined);
  pauseNow(codexEnv(env), { now: now + 2000 });
  const manual = await runCodexHook({ input, env, now: now + 3000, reader });
  assert.equal(manual.hookSpecificOutput.permissionDecision, "deny");
});

test("Codex per-prompt allowances read fresh usage at each prompt, at most every 10 s at tool calls, and reset per session", async () => {
  const { env, root } = sandbox();
  const scoped = codexEnv(env);
  writeRules(scoped, [{ kind: "prompt", window: "seven_day", at: 3, action: "pause" }]);
  let pct = 50, reads = 0;
  const reader = async () => { reads++; return limits(pct); };
  const input = { session_id: "prompt-session", cwd: root, tool_name: "Bash" };
  const invoke = (event, time, session = input.session_id) => runCodexHook({ env, now: time, reader, input: { ...input, session_id: session, hook_event_name: event } });
  assert.equal(await invoke("UserPromptSubmit", now), null);
  pct = 53;
  assert.equal(await invoke("PreToolUse", now + 5000), null, "a tool call within 10 s reuses the prompt's reading");
  assert.equal(reads, 1);
  const stopped = await invoke("PreToolUse", now + 10000);
  assert.equal(stopped.hookSpecificOutput.permissionDecision, "deny");
  assert.match(stopped.hookSpecificOutput.permissionDecisionReason, /raised weekly usage by 3 points/);
  assert.equal(await invoke("UserPromptSubmit", now + 11000, "other-session"), null);
  assert.equal(await invoke("PreToolUse", now + 12000, "other-session"), null);
  assert.equal((await invoke("PreToolUse", now + 13000)).hookSpecificOutput.permissionDecision, "deny");
  assert.equal(await invoke("UserPromptSubmit", now + 14000), null);
  assert.equal(await invoke("PreToolUse", now + 15000), null);
  assert.equal(reads, 4, "each prompt reads usage; tool calls read it only when the last reading is 10 s old");
});

test("codex setup replaces a Claude-Code Peras hook wired into Codex by hand, and records this version", async () => {
  const { env, root } = sandbox();
  env.CODEX_HOME = path.join(root, "codex");
  fs.mkdirSync(env.CODEX_HOME, { recursive: true });
  // The shape found in a real ~/.codex/hooks.json on 2026-10-14: the Claude hook
  // command (reads Claude's window, not Codex's), with setup's `|| echo` fallback.
  const claudeHook = { type: "command", command: `"/n/node" "/h/.peras/app/bin/peras.mjs" hook || echo '{"systemMessage":"Peras could not run"}'`, timeout: 10 };
  const other = { type: "command", command: "my-own-hook", timeout: 5 };
  fs.writeFileSync(hooksPath(env), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "*", hooks: [claudeHook, other] }], UserPromptSubmit: [{ hooks: [claudeHook] }] } }));
  const { inspectCodex } = await import("../src/codex.mjs");
  assert.deepEqual(inspectCodex(env).claudeHookEvents, ["UserPromptSubmit", "PreToolUse"]);
  assert.deepEqual(inspectCodex(env).events, []);
  installCodex(env, `"/n/node" "/h/.peras/app/bin/peras.mjs"`);
  const hooks = JSON.parse(fs.readFileSync(hooksPath(env), "utf8")).hooks;
  const commands = Object.values(hooks).flat().flatMap((g) => g.hooks.map((h) => h.command));
  assert.ok(!commands.some((c) => / hook \|\|/.test(c)), "the Claude hook is gone from Codex");
  assert.ok(commands.includes("my-own-hook"), "someone else's hook stays");
  assert.equal(commands.filter((c) => c.endsWith(" codex-hook")).length, 2);
  assert.deepEqual(inspectCodex(env).claudeHookEvents, []);
  const version = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
  const { readInstall } = await import("../src/store.mjs");
  assert.equal(readInstall(codexEnv(env)).version, version);
  removeCodex(env);
  assert.deepEqual(JSON.parse(fs.readFileSync(hooksPath(env), "utf8")), { hooks: { PreToolUse: [{ matcher: "*", hooks: [other] }] } });
});
