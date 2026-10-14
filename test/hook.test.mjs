import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { runHook } from "../src/hook.mjs";
import { recordReading, windowFile } from "../src/store.mjs";
import { readingFrom } from "../src/window.mjs";
import { sandbox, NOW, statusInput } from "./helpers.mjs";

function setup({ fiveHour, sevenDay } = {}) {
  const box = sandbox();
  if (fiveHour !== undefined || sevenDay !== undefined) {
    recordReading(box.env, readingFrom(statusInput({ fiveHour, sevenDay }), NOW));
  }
  const notes = [];
  const hook = (event, { session = "s-1", now = NOW, extra = {} } = {}) =>
    runHook({
      input: { hook_event_name: event, session_id: session, tool_name: "Bash", tool_input: { command: "ls" }, ...extra },
      env: box.env,
      now,
      notify: (title, body) => notes.push({ title, body }),
    });
  return { box, hook, notes };
}

test("no window seen: every event goes ahead, silently", () => {
  const { hook, notes } = setup();
  for (const e of ["UserPromptSubmit", "PreToolUse", "PostToolBatch"]) assert.equal(hook(e), null);
  assert.equal(notes.length, 0);
});

test("below every line: tool calls go ahead, silently", () => {
  const { hook } = setup({ fiveHour: 10, sevenDay: 40 });
  assert.equal(hook("PreToolUse"), null);
});

test("paused: a tool call is refused and the turn ends; Claude is not told how to lift it", () => {
  const { hook, notes } = setup({ sevenDay: 91 });
  const out = hook("PreToolUse");
  assert.equal(out.continue, false);
  assert.equal(out.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
  const toClaude = out.hookSpecificOutput.permissionDecisionReason;
  assert.match(toClaude, /91%/);
  assert.doesNotMatch(toClaude, /resume/i);
  assert.match(out.stopReason, /peras resume/);
  assert.equal(notes.length, 1);
  // One notification per window, not one per call.
  hook("PreToolUse");
  assert.equal(notes.length, 1);
});

test("paused: the end of a tool batch ends the turn", () => {
  const { hook } = setup({ sevenDay: 95 });
  const out = hook("PostToolBatch");
  assert.equal(out.continue, false);
  assert.equal(out.decision, "block");
});

test("paused: a prompt the user types goes through, with a notice (D2)", () => {
  const { hook } = setup({ sevenDay: 95 });
  const out = hook("UserPromptSubmit");
  assert.equal(out.continue, undefined);
  assert.equal(out.decision, undefined);
  assert.match(out.systemMessage, /paused/);
  assert.match(out.systemMessage, /peras resume/);
});

test("the pause lifts by itself when the window resets", () => {
  const { hook } = setup({ sevenDay: 95 });
  const reset = readingFrom(statusInput({ sevenDay: 95 }), NOW).seven_day.resetsAt * 1000;
  assert.equal(hook("PreToolUse", { now: reset }), null);
});

test("ask: once per session per window, then that session goes ahead (D9)", () => {
  const { box, hook, notes } = setup({ sevenDay: 80 });
  fs.mkdirSync(box.home, { recursive: true });
  fs.writeFileSync(path.join(box.home, "config.json"), JSON.stringify({ rules: [{ window: "seven_day", at: 80, action: "ask" }] }));
  const first = hook("PreToolUse");
  assert.equal(first.hookSpecificOutput.permissionDecision, "ask");
  assert.match(first.hookSpecificOutput.permissionDecisionReason, /80%/);
  assert.equal(notes.length, 1);
  assert.equal(hook("PreToolUse"), null);
  assert.equal(hook("PreToolUse", { session: "s-2" }).hookSpecificOutput.permissionDecision, "ask");
  assert.equal(hook("PostToolBatch"), null);
});

test("warn: one message and one notification per window, and the tool goes ahead", () => {
  const { hook, notes } = setup({ sevenDay: 76 });
  const first = hook("PreToolUse");
  assert.equal(first.hookSpecificOutput, undefined);
  assert.match(first.systemMessage, /76%/);
  assert.equal(notes.length, 1);
  assert.equal(hook("PreToolUse"), null);
  assert.equal(hook("PreToolUse", { session: "s-2" }), null);
  assert.equal(notes.length, 1);
});

test("resume lifts the pause for the rest of this window", async () => {
  const { box, hook } = setup({ sevenDay: 95 });
  const { resume } = await import("../src/store.mjs");
  const lifted = resume(box.env, NOW);
  assert.deepEqual(lifted.map((h) => h.window), ["seven_day"]);
  assert.equal(hook("PreToolUse")?.hookSpecificOutput, undefined);
});

test("after a resume, a higher pause line still pauses, and status says resumed", async () => {
  const { box, hook } = setup({ sevenDay: 92 });
  fs.mkdirSync(box.home, { recursive: true });
  fs.writeFileSync(path.join(box.home, "config.json"), JSON.stringify({ rules: [{ window: "seven_day", at: 70, action: "pause" }, { window: "seven_day", at: 95, action: "pause" }] }));
  const { resume } = await import("../src/store.mjs");
  resume(box.env, NOW);
  assert.equal(hook("PreToolUse"), null);
  recordReading(box.env, readingFrom(statusInput({ sevenDay: 96 }), NOW));
  assert.equal(hook("PreToolUse").hookSpecificOutput.permissionDecision, "deny");
});

test("the pause notice says how to resume from inside Claude Code", () => {
  const { hook } = setup({ sevenDay: 95 });
  assert.match(hook("UserPromptSubmit").systemMessage, /! peras resume/);
  assert.match(hook("PreToolUse").stopReason, /! peras resume/);
});

test("another Claude config dir (another account) has its own window", () => {
  const { box, hook } = setup({ sevenDay: 95 });
  box.env.CLAUDE_CONFIG_DIR = path.join(box.root, "other-claude");
  assert.equal(hook("PreToolUse"), null);
});

test("an unreadable window fails open, and says so at most once a minute (D3)", () => {
  const { box, hook } = setup({ sevenDay: 95 });
  fs.writeFileSync(windowFile(box.env), "{not json");
  const first = hook("PreToolUse");
  assert.equal(first.hookSpecificOutput, undefined);
  assert.equal(first.continue, undefined);
  assert.match(first.systemMessage, /could not check/);
  assert.equal(hook("PreToolUse", { now: NOW + 30_000 }), null);
  assert.match(hook("PreToolUse", { now: NOW + 61_000 }).systemMessage, /could not check/);
});
