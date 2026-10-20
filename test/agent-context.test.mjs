import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { sandbox, NOW, inHours } from "./helpers.mjs";
import { recordReading } from "../src/store.mjs";
import { codexEnv } from "../src/codex.mjs";
import { setPreference } from "../src/preferences.mjs";
import { noteForPrompt, usageReport, withUsageNote } from "../src/agent-context.mjs";

const BIN = new URL("../bin/peras.mjs", import.meta.url).pathname;
const at = (base, h) => Math.floor((base + h * 3600_000) / 1000);
const reading = (five, week, { base = NOW, seenAt = base, fiveReset = at(base, 2) } = {}) => ({
  five_hour: { usedPct: five, resetsAt: fiveReset, seenAt },
  seven_day: { usedPct: week, resetsAt: at(base, 100), seenAt },
});
// The command-line tests run a real process on the real clock: their readings are made around it.
function home({ claude = [45, 9], codex = [100, 16], on = true, base = NOW } = {}) {
  const box = sandbox();
  box.env.CODEX_HOME = path.join(box.root, "codex");
  // No real codex on PATH: a Codex hook must not reach the user's account.
  box.env.PATH = path.dirname(process.execPath);
  if (claude) recordReading(box.env, reading(...claude, { base }));
  if (codex) recordReading(codexEnv(box.env), reading(...codex, { base }));
  if (on) setPreference(box.env, "agents", "on");
  return box;
}
const prompt = (session = "s1") => ({ hook_event_name: "UserPromptSubmit", session_id: session, cwd: "/tmp", prompt: "next task" });

test("off unless turned on: no line, nothing written", () => {
  const { env } = home({ on: false });
  assert.equal(noteForPrompt(env, { provider: "claude", session: "s1", now: NOW }), null);
  assert.ok(!fs.existsSync(path.join(env.PERAS_HOME, "agent-context.json")));
});

test("the first prompt gets both agents' usage, facts only; the same facts again stay quiet", () => {
  const { env, root } = home();
  const note = noteForPrompt(env, { provider: "claude", session: "s1", now: NOW });
  assert.match(note, /^Peras usage as of \d\d:\d\d local\. Claude Code \(this agent\): 5h 45% \(resets [^)]+\), week 9% \([^)]+\)\. Codex: 5h 100% until [\d:]+, week 16% \([^)]+\)\.$/);
  assert.ok(note.length < 400, "one short line");
  assert.ok(!note.includes(root) && !/\b(must|should|stop|do not|don't)\b/i.test(note), "no paths, no instructions");
  assert.equal(noteForPrompt(env, { provider: "claude", session: "s1", now: NOW + 60_000 }), null, "nothing changed");
  assert.match(noteForPrompt(env, { provider: "claude", session: "s2", now: NOW + 60_000 }), /Claude Code \(this agent\)/, "a new session hears it once too");
  assert.match(noteForPrompt(env, { provider: "codex", session: "s1", now: NOW + 60_000 }), /Codex \(this agent\): 5h 100%/, "Codex's own session is its own");
});

test("a new line goes out when a band is crossed, the other agent comes back, a reset nears or a reading goes stale", () => {
  const { env } = home({ claude: [45, 9], codex: [60, 16] });
  const next = (now) => noteForPrompt(env, { provider: "claude", session: "s1", now });
  assert.ok(next(NOW));
  recordReading(env, reading(48, 9));
  assert.equal(next(NOW + 1000), null, "45 → 48 stays in its band");
  recordReading(env, reading(52, 9));
  assert.match(next(NOW + 2000), /5h 52%/, "crossed 50");
  recordReading(codexEnv(env), reading(100, 16));
  assert.match(next(NOW + 3000), /Codex: 5h 100% until/, "the other agent ran out");
  assert.match(next(NOW + 16 * 60_000), /reading from \d\d:\d\d/, "the readings went stale");
  assert.equal(next(NOW + 17 * 60_000), null);
  assert.ok(next(inHours(2) * 1000 - 20 * 60_000), "a reset 20 minutes away");
});

test("reset times drifting by seconds between readings, and a reading turning fresh again, stay quiet", () => {
  const { env } = home({ claude: [45, 9], codex: [60, 16] });
  const next = (now) => noteForPrompt(env, { provider: "claude", session: "s1", now });
  assert.ok(next(NOW));
  recordReading(env, reading(46, 9, { fiveReset: inHours(2) + 37 }));
  recordReading(codexEnv(env), reading(61, 16, { fiveReset: inHours(2) - 52 }));
  assert.equal(next(NOW + 1000), null, "same bands, resets a few seconds off");
  assert.match(next(NOW + 16 * 60_000), /reading from/, "stale is news");
  recordReading(env, reading(46, 9, { seenAt: NOW + 17 * 60_000 }));
  recordReading(codexEnv(env), reading(61, 16, { seenAt: NOW + 17 * 60_000 }));
  assert.equal(next(NOW + 17 * 60_000), null, "fresh again is not");
  assert.match(next(NOW + 33 * 60_000) ?? "", /reading from/, "stale again is news again");
});

test("a stale reading says how old it is", () => {
  const { env } = home({ claude: null, codex: null });
  recordReading(env, reading(30, 5, { seenAt: NOW - 40 * 60_000 }));
  assert.match(noteForPrompt(env, { provider: "claude", session: "s1", now: NOW }), /reading from \d\d:\d\d/);
});

test("the note joins the hook's own answer, only on a prompt, and never replaces a block", () => {
  const { env } = home();
  const told = withUsageNote({ systemMessage: "Peras: tool use is paused." }, { env, input: prompt(), provider: "claude", now: NOW });
  assert.equal(told.systemMessage, "Peras: tool use is paused.", "the user's message stays");
  assert.equal(told.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.match(told.hookSpecificOutput.additionalContext, /^Peras usage as of/);
  assert.equal(withUsageNote(null, { env, input: { ...prompt("s9"), hook_event_name: "PreToolUse" }, provider: "claude", now: NOW }), null, "tool checks carry no note");
  const block = { decision: "block", reason: "x" };
  assert.equal(withUsageNote(block, { env, input: prompt("s8"), provider: "codex", now: NOW }), block);
});

test("if the note can't be worked out, the hook's answer is exactly what it was", () => {
  const { env } = home();
  fs.mkdirSync(path.join(env.PERAS_HOME, "agent-context.json"), { recursive: true });
  const answer = { systemMessage: "kept" };
  assert.equal(withUsageNote(answer, { env, input: prompt(), provider: "claude", now: NOW }), answer);
  assert.equal(withUsageNote(null, { env, input: prompt(), provider: "claude", now: NOW }), null);
});

test("through the real hook command: Claude's prompt carries the line; Codex's names Codex as this agent", () => {
  const { env } = home({ base: Date.now() });
  const run = (input) => spawnSync(process.execPath, [BIN, "hook"], { env, input: JSON.stringify(input), encoding: "utf8" });
  const claude = run(prompt("c1"));
  assert.equal(claude.status, 0);
  assert.match(JSON.parse(claude.stdout).hookSpecificOutput.additionalContext, /Claude Code \(this agent\)/);
  const codex = run({ ...prompt("x1"), turn_id: "t1" });
  assert.equal(codex.status, 0);
  assert.match(JSON.parse(codex.stdout).hookSpecificOutput.additionalContext, /Codex \(this agent\)/);
  assert.equal(run(prompt("c1")).stdout, "", "the same facts, the same session: silent");
});

test("peras usage answers on request, setting or not; --json has each agent's windows", () => {
  const base = Date.now();
  const { env } = home({ on: false, base });
  const text = spawnSync(process.execPath, [BIN, "usage"], { env, encoding: "utf8" });
  assert.match(text.stdout, /^Peras usage as of .*Claude Code: 5h 45%.*Codex: 5h 100%/);
  const json = JSON.parse(spawnSync(process.execPath, [BIN, "usage", "--json"], { env, encoding: "utf8" }).stdout);
  assert.deepEqual(Object.keys(json.providers), ["claude", "codex"]);
  assert.equal(json.providers.codex.five_hour.used, 100);
  assert.equal(json.providers.claude.five_hour.resetsAtMs, at(base, 2) * 1000);
  assert.deepEqual(usageReport(sandbox().env, NOW).providers, {}, "no readings, no rows");
});

test("peras agents turns it on and off", () => {
  const { env } = home({ on: false });
  const run = (...args) => spawnSync(process.execPath, [BIN, "agents", ...args], { env, encoding: "utf8" });
  assert.match(run().stdout, /don't hear/);
  assert.match(run("on").stdout, /Agents hear about usage/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(env.PERAS_HOME, "preferences.json"), "utf8")).agents, true);
  assert.match(run("off").stdout, /don't hear/);
  assert.notEqual(run("maybe").status, 0);
});
