import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { main } from "../src/cli.mjs";
import { codexEnv, cachePath, installCodex, refreshCodex, runCodexHook } from "../src/codex.mjs";
import { freshness, snapshot, whyText, terminalStatusline } from "../src/providers.mjs";
import { recordReading, pauseNow, readWindow, writeRules, writeInstall } from "../src/store.mjs";
import { sandbox, NOW, inHours } from "./helpers.mjs";
import { runHook } from "../src/hook.mjs";
import { realDir } from "../src/rules.mjs";
// The installed hooks are this version, so commands don't first refresh them as stale.
const VERSION = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

test("Codex's compact terminal readout colors usage and supports both color opt-outs", async () => {
  const { env } = sandbox();
  recordReading(codexEnv(env), { five_hour: { usedPct: 20, resetsAt: inHours(3), seenAt: NOW }, seven_day: { usedPct: 80, resetsAt: inHours(72), seenAt: NOW } });
  const s = await snapshot(env, NOW, { provider: "codex" });
  const colored = terminalStatusline(s, env);
  assert.match(colored, /\u001b\[32m5h 20%/);
  assert.match(colored, /\u001b\[33m7d 80%/);
  assert.doesNotMatch(terminalStatusline(s, { ...env, NO_COLOR: "1" }), /\u001b/);
  assert.doesNotMatch(terminalStatusline(s, { ...env, PERAS_COLOR: "0" }), /\u001b/);
  pauseNow(codexEnv(env), { now: NOW });
  assert.match(terminalStatusline(await snapshot(env, NOW, { provider: "codex" }), env), /\u001b\[31m⏸️ paused/);
});

const limits = (pct = 30) => ({ rateLimits: { primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: inHours(3) }, secondary: { usedPercent: pct, windowDurationMins: 10080, resetsAt: inHours(72) } } });
const reader = async () => limits();
const offline = async () => { throw new Error("offline"); };
async function run(env, args, codexReader = reader) {
  const lines = [];
  const code = await main(args, { env, now: NOW, out: (line) => lines.push(line), codexReader });
  return { code, text: lines.join("\n") };
}

test("combined status includes both providers and reading ages", async () => {
  const { env } = sandbox();
  recordReading(env, { seven_day: { usedPct: 20, resetsAt: inHours(72), seenAt: NOW - 30_000 } });
  writeInstall(codexEnv(env), { command: "test" });
  const s = await run(env, ["status"]);
  assert.equal(s.code, 0);
  assert.match(s.text, /20%/);
  const codex = s.text.slice(s.text.lastIndexOf("Peras 🍐 watching"));
  assert.notEqual(codex, s.text, "Codex has its own panel");
  assert.match(codex, /5h .* 10%[\s\S]*7d .* 30%/);
  assert.equal(s.text.match(/^ {6}seen (just now|1 min ago)/gm)?.length, 2, "each panel says how old its reading is");
});

test("failed refresh exposes old readings without bypassing manual pauses", async () => {
  const { env } = sandbox();
  await refreshCodex(env, NOW - 600_000, { reader });
  const s = await snapshot(env, NOW, { provider: "codex", refresh: true, reader: offline });
  assert.equal(s.error, "offline");
  assert.match(s.freshness.text, /10 minutes ago · older reading/);
  pauseNow(codexEnv(env), { now: NOW });
  const result = await runCodexHook({ env, now: NOW, reader: offline, input: { hook_event_name: "PreToolUse", session_id: "s" } });
  assert.equal(result.hookSpecificOutput.permissionDecision, "deny");
  const freshHome = sandbox().env;
  pauseNow(codexEnv(freshHome), { now: NOW });
  const noCache = await runCodexHook({ env: freshHome, now: NOW, reader: offline, input: { hook_event_name: "PreToolUse" } });
  assert.equal(noCache.hookSpecificOutput.permissionDecision, "deny");
});

test("Codex config homes do not share cache entries", async () => {
  const { env, root } = sandbox();
  const a = { ...env, CODEX_HOME: path.join(root, "a") };
  const b = { ...env, CODEX_HOME: path.join(root, "b") };
  await refreshCodex(a, NOW, { reader });
  await refreshCodex(b, NOW, { reader: async () => limits(80) });
  assert.notEqual(cachePath(a), cachePath(b));
  assert.equal(readWindow(codexEnv(a)).seven_day.usedPct, 30);
  assert.equal(readWindow(codexEnv(b)).seven_day.usedPct, 80);
});

test("Codex pace rules use forecasts in the enforcement hook", async () => {
  const { env } = sandbox();
  writeRules(codexEnv(env), [{ kind: "pace", window: "seven_day", at: 50, action: "pause" }]);
  const result = await runCodexHook({ env, now: NOW, reader: async () => limits(70), input: { hook_event_name: "PreToolUse" } });
  assert.equal(result.hookSpecificOutput.permissionDecision, "deny");
  assert.match(result.hookSpecificOutput.permissionDecisionReason, /at this pace runs out/);
});

test("why identifies rule, automatic release, and user resume command", async () => {
  const { env } = sandbox();
  recordReading(env, { seven_day: { usedPct: 93, resetsAt: inHours(72), seenAt: NOW } });
  const s = await run(env, ["why"]);
  assert.match(s.text, /Claude Code: PAUSE/);
  assert.match(s.text, /past the 90% line/);
  assert.match(s.text, /It lifts at/);
  assert.match(s.text, /To lift this stop: peras resume/);
  assert.match(s.text, /Codex: no active stop/);
  pauseNow(codexEnv(env), { now: NOW, until: NOW + 3600_000 });
  const codex = await snapshot(env, NOW, { provider: "codex" });
  assert.match(whyText(codex, NOW), /user paused it by hand/);
  assert.match(whyText(codex, NOW), /peras codex resume/);
});

test("menu bar actions address the matching provider", async () => {
  const { env, root } = sandbox();
  env.PERAS_SWIFTBAR_DIR = path.join(root, "swiftbar");
  writeInstall(codexEnv(env), { command: `"${process.execPath}" "/x/peras.mjs"` });
  const installed = await run(env, ["menubar", "install"]);
  assert.equal(installed.code, 0);
  pauseNow(codexEnv(env), { now: NOW });
  const shown = await run(env, ["menubar"]);
  assert.equal(shown.text.split("\n").filter(l => l.includes("image=") && !l.includes("dropdown=false") && !/^(5h|Week)/.test(l)).length, 2);
  assert.match(shown.text, /param1=codex param2=resume/);
  assert.match(shown.text, /param1=pause param2=1h/);
  assert.match(shown.text, /· paused \| image=/);
});

test("menu bar detects and resumes folder stops from agent sessions for both providers", async () => {
  for (const provider of ["claude", "codex"]) {
    const { env, root } = sandbox();
    env.CODEX_HOME = path.join(root, "codex");
    env.PERAS_SWIFTBAR_DIR = path.join(root, "swiftbar");
    const dir = path.join(root, "project");
    fs.mkdirSync(dir);
    const project = realDir(dir);
    const scoped = provider === "codex" ? codexEnv(env) : env;
    writeInstall(scoped, { command: `"${process.execPath}" "/x/peras.mjs"`, version: VERSION });
    await run(env, ["menubar", "install"]);
    recordReading(scoped, { seven_day: { usedPct: 70, resetsAt: inHours(72), seenAt: NOW } });
    writeRules(scoped, [{ kind: "window", window: "seven_day", at: 60, action: "pause", project }]);
    const input = { hook_event_name: "PreToolUse", session_id: "project-session", cwd: project };
    const projectReader = async () => limits(70);
    const hook = () => provider === "codex" ? runCodexHook({ env, now: NOW, reader: projectReader, input }) : runHook({ env, now: NOW, input });
    assert.equal((await hook()).hookSpecificOutput.permissionDecision, "deny");
    const shown = await run(env, ["menubar"], projectReader);
    assert.match(shown.text, /Paused: weekly 70% \(line 60%\)/);
    assert.ok(fs.readFileSync(path.join(env.PERAS_HOME, "status.html"), "utf8").includes(project), "folder details remain in Status");
    assert.match(shown.text, provider === "codex" ? /param1=codex param2=resume/ : /param1=resume/);
    assert.match((await run(env, ["why"], projectReader)).text, /Applies in/);
    assert.match((await run(env, ["status"], projectReader)).text, /past the 60% line/);
    const args = provider === "codex" ? ["codex", "resume", "1h"] : ["resume", "1h"];
    assert.match((await run(env, args, projectReader)).text, /Lifted:/);
    assert.notEqual((await hook())?.hookSpecificOutput?.permissionDecision, "deny");
    assert.doesNotMatch((await run(env, ["menubar"], projectReader)).text, /Paused: weekly 70%/);
  }
});

test("Codex doctor reports runtime and RPC failures and does not claim hook trust", async () => {
  const { env, root } = sandbox();
  env.CODEX_HOME = path.join(root, "codex");
  installCodex(env, `"${process.execPath}" "/missing/peras.mjs"`);
  const result = await run(env, ["codex", "doctor"], offline);
  assert.equal(result.code, 1);
  assert.match(result.text, /Peras hooks configured/);
  assert.match(result.text, /runtime missing/);
  assert.match(result.text, /usage read failed: offline/);
  assert.match(result.text, /Open \/hooks to confirm/);
  assert.equal(freshness({}, NOW).text, "No reading yet");
});

// The menu asks for a snapshot every second. Codex reads cost an app-server start
// each, so the menu path paces them by what the last reading showed.
const counting = (fn) => { const r = async (...a) => { r.calls++; return fn(...a); }; r.calls = 0; return r; };
const codexOnly = (five) => async () => ({ rateLimits: { ...(five ? { primary: five } : {}), secondary: { usedPercent: 30, windowDurationMins: 10080, resetsAt: inHours(72) } } });
const menuTick = (env, now, reader) => snapshot(env, now, { provider: "codex", refresh: true, adaptive: true, reader });

test("a failing Codex read backs off on the menu path instead of retrying every second", async () => {
  const { env } = sandbox();
  const failing = counting(offline);
  const errors = [];
  for (let s = 0; s < 60; s++) errors.push((await menuTick(env, NOW + s * 1000, failing)).error);
  assert.ok(failing.calls <= 6, `${failing.calls} reads in a minute`);
  assert.ok(errors.every((e) => e === "offline"), "a skipped read still reports the last failure");
  const forced = counting(reader);
  await snapshot(env, NOW + 60_500, { provider: "codex", refresh: true, force: true, reader: forced });
  assert.equal(forced.calls, 1, "force skips the backoff");
});

test("one success ends the backoff", async () => {
  const { env } = sandbox();
  for (let s = 0; s < 3; s++) await menuTick(env, NOW + s * 1000, offline);
  await refreshCodex(env, NOW + 3000, { reader });
  const next = counting(reader);
  const s = await menuTick(env, NOW + 64_000, next);
  assert.equal(next.calls, 1);
  assert.equal(s.error, null);
});

test("right after the 5-hour window resets, the menu looks for the new one every second", async () => {
  const { env } = sandbox();
  const resetAt = NOW / 1000 - 5;
  recordReading(codexEnv(env), { five_hour: { usedPct: 60, resetsAt: resetAt, seenAt: NOW - 3600_000 } });
  await refreshCodex(env, NOW - 2000, { reader: codexOnly(null) });
  const soon = counting(codexOnly({ usedPercent: 1, windowDurationMins: 300, resetsAt: NOW / 1000 + 5 * 3600 }));
  await menuTick(env, NOW, soon);
  assert.equal(soon.calls, 1, "a 2-second-old reading is too old just after a reset");
  assert.equal(readWindow(codexEnv(env)).five_hour.usedPct, 1, "the new window is picked up");
});

test("hours after a reset with no new window, the menu reads once a minute", async () => {
  const { env } = sandbox();
  recordReading(codexEnv(env), { five_hour: { usedPct: 60, resetsAt: NOW / 1000 - 3 * 3600, seenAt: NOW - 8 * 3600_000 } });
  await refreshCodex(env, NOW - 30_000, { reader: codexOnly(null) });
  const idle = counting(codexOnly(null));
  await menuTick(env, NOW, idle);
  assert.equal(idle.calls, 0);
  await menuTick(env, NOW + 31_000, idle);
  assert.equal(idle.calls, 1);
});

test("with no 5-hour window ever seen, the menu reads once a minute", async () => {
  const { env } = sandbox();
  await refreshCodex(env, NOW - 30_000, { reader: codexOnly(null) });
  const idle = counting(codexOnly(null));
  await menuTick(env, NOW, idle);
  assert.equal(idle.calls, 0);
});

test("a live window is read once a minute, and again as soon as it resets", async () => {
  const { env } = sandbox();
  const resetMs = NOW + 20_000;
  await refreshCodex(env, NOW - 10_000, { reader: codexOnly({ usedPercent: 40, windowDurationMins: 300, resetsAt: resetMs / 1000 }) });
  const r = counting(codexOnly(null));
  await menuTick(env, NOW, r);
  assert.equal(r.calls, 0, "a 10-second-old reading of a live window is fine");
  await menuTick(env, resetMs + 500, r);
  assert.equal(r.calls, 1, "the reset itself starts a search");
});
