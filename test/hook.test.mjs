import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { runHook } from "../src/hook.mjs";
import { recordReading, windowFile, stateFile, configFile, readState, resume, pauseNow, writeRules } from "../src/store.mjs";
import { writeUsage } from "../src/usage.mjs";
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
  fs.writeFileSync(path.join(box.home, "config.json"), JSON.stringify({ v: 2, rules: [{ window: "seven_day", at: 80, action: "ask" }] }));
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
  const { lifted } = resume(box.env, { now: NOW });
  assert.deepEqual(lifted.map((h) => h.window), ["seven_day"]);
  assert.equal(hook("PreToolUse")?.hookSpecificOutput, undefined);
});

test("after a resume, a higher pause line still pauses, and status says resumed", async () => {
  const { box, hook } = setup({ sevenDay: 92 });
  fs.mkdirSync(box.home, { recursive: true });
  fs.writeFileSync(path.join(box.home, "config.json"), JSON.stringify({ v: 2, rules: [{ window: "seven_day", at: 70, action: "pause" }, { window: "seven_day", at: 95, action: "pause" }] }));
  const { resume } = await import("../src/store.mjs");
  resume(box.env, { now: NOW });
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

const rulesFile = (box, rules) => {
  fs.mkdirSync(box.home, { recursive: true });
  fs.writeFileSync(configFile(box.env), JSON.stringify({ v: 2, rules }));
};

test("lines crossed together are told in one notification, and every one is marked", () => {
  const { hook, notes } = setup({ fiveHour: 96, sevenDay: 91 });
  hook("PreToolUse");
  assert.equal(notes.length, 1);
  assert.match(notes[0].body, /Paused/);
  assert.match(notes[0].body, /weekly 91% \(line 75%\)/);
  assert.match(notes[0].body, /5-hour 96%/);
  hook("PreToolUse");
  hook("UserPromptSubmit");
  assert.equal(notes.length, 1, "nothing stale fires again");
});

test("prompt allowance: measured from each prompt, lifted by the next one", () => {
  const { box, hook, notes } = setup({ sevenDay: 50 });
  rulesFile(box, [{ kind: "prompt", window: "seven_day", at: 3, action: "pause" }]);
  assert.equal(hook("UserPromptSubmit"), null);
  recordReading(box.env, readingFrom(statusInput({ sevenDay: 52 }), NOW));
  assert.equal(hook("PreToolUse", { now: NOW + 1 }), null);
  recordReading(box.env, readingFrom(statusInput({ sevenDay: 53 }), NOW));
  const out = hook("PreToolUse", { now: NOW + 2 });
  assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
  assert.match(out.stopReason, /this prompt raised weekly usage by 3 points/);
  assert.match(out.stopReason, /next prompt/);
  assert.equal(notes.length, 1);
  // Another session's prompt has its own baseline.
  assert.equal(hook("PreToolUse", { session: "s-2", now: NOW + 3 }), null);
  // The next prompt in this session starts over from 53%.
  assert.equal(hook("UserPromptSubmit", { now: NOW + 4 }), null);
  assert.equal(hook("PreToolUse", { now: NOW + 5 }), null);
});

test("a manual pause pauses, and resume ends it", () => {
  const { box, hook } = setup({ sevenDay: 10 });
  pauseNow(box.env, { now: NOW });
  const out = hook("PreToolUse");
  assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
  assert.match(out.stopReason, /paused it by hand/);
  assert.match(out.stopReason, /until you resume/);
  assert.equal(resume(box.env, { now: NOW }).manual.since, NOW);
  assert.equal(hook("PreToolUse"), null);
});

test("a manual pause with a time ends by itself", () => {
  const { box, hook } = setup({ sevenDay: 10 });
  pauseNow(box.env, { now: NOW, until: NOW + 3600_000 });
  assert.match(hook("PreToolUse").stopReason, /lifts at/);
  assert.equal(hook("PreToolUse", { now: NOW + 3600_000 }), null);
});

test("a timed resume runs out and the pause comes back", () => {
  const { box, hook } = setup({ sevenDay: 95 });
  resume(box.env, { now: NOW, forMs: 3600_000 });
  assert.equal(hook("PreToolUse", { now: NOW + 1000 })?.hookSpecificOutput, undefined);
  assert.equal(hook("PreToolUse", { now: NOW + 3600_000 }).hookSpecificOutput.permissionDecision, "deny");
});

test("per-folder lines follow the session's cwd", () => {
  const { box, hook } = setup({ sevenDay: 65 });
  const side = fs.mkdtempSync(path.join(box.root, "side-"));
  fs.mkdirSync(path.join(side, "src"));
  rulesFile(box, [{ kind: "window", window: "seven_day", at: 60, action: "pause", project: fs.realpathSync(side) }]);
  assert.equal(hook("PreToolUse", { extra: { cwd: path.join(side, "src") } }).hookSpecificOutput.permissionDecision, "deny");
  assert.equal(hook("PreToolUse", { extra: { cwd: box.root } }), null);
});

test("pace: warns once when the week is on track to run out before it resets", () => {
  const { box, hook, notes } = setup({ sevenDay: 70 });
  const H = 3600_000;
  const resetsAt = readingFrom(statusInput({ sevenDay: 70 }), NOW).seven_day.resetsAt;
  writeUsage(box.env, { v: 1, windows: { seven_day: { resetsAt, pts: [[NOW - 30 * H, 40], [NOW - 10 * H, 60]] } }, weeks: [], blame: null });
  rulesFile(box, [{ kind: "pace", window: "seven_day", at: 50, action: "warn" }]);
  const out = hook("PreToolUse");
  assert.match(out.systemMessage, /weekly runs out .* at this pace \(resets /);
  assert.equal(notes.length, 1);
  assert.equal(hook("PreToolUse"), null);
  assert.equal(readState(box.env, NOW).latched.length, 1);
});

test("upgrading from 0.1: its real config and state load, and nothing already said is said again", async () => {
  const box = sandbox();
  const fixture = (name) => fs.readFileSync(new URL(`./fixtures/v0.1-home/${name}`, import.meta.url), "utf8");
  const window = JSON.parse(fixture("window.json"));
  const now = (window.seven_day.resetsAt - 72 * 3600) * 1000;
  fs.mkdirSync(path.dirname(stateFile(box.env)), { recursive: true });
  fs.writeFileSync(configFile(box.env), fixture("config.json"));
  fs.writeFileSync(stateFile(box.env), fixture("state.json"));
  fs.mkdirSync(path.dirname(windowFile(box.env)), { recursive: true });
  fs.writeFileSync(windowFile(box.env), JSON.stringify({ seven_day: { ...window.seven_day, usedPct: 75 } }));
  const notes = [];
  const state = readState(box.env, now);
  assert.deepEqual(state.resumed, [{ key: "seven_day@1792260000" }]);
  const out = runHook({ input: { hook_event_name: "PreToolUse", session_id: "x" }, env: box.env, now, notify: (t, b) => notes.push(b) });
  // The 75% warning 0.1 already gave is not given again; the only news is 0.2's
  // pace line (75% four days into the week runs out before the reset).
  assert.match(out.systemMessage, /^Peras: weekly runs out \S+ \d\d:\d\d at this pace \(resets \S+ \d\d:\d\d\)\.$/);
  assert.equal(notes.length, 1);
  assert.doesNotMatch(notes[0], /line 75%/);
  // 0.1 wrote its defaults out in full; 0.2's new default line still arrives.
  const { readRules } = await import("../src/store.mjs");
  assert.deepEqual(readRules(box.env).map((r) => r.kind), ["window", "window", "window", "pace"]);
  writeRules(box.env, readRules(box.env).filter((r) => r.kind !== "pace"));
  assert.equal(readRules(box.env).length, 3, "turned off after the upgrade, it stays off");
});
