#!/usr/bin/env node
// Writes test/fixtures/native-v1/*.json: protocol-1 snapshots the native app is
// built against. Each one comes from the real Peras code run in a throwaway home
// at a fixed moment, never from the machine it runs on and never from a live
// provider. `--check` fails when a fixture no longer matches what the code makes.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "test", "fixtures", "native-v1");
const PACKAGE_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
const check = process.argv.includes("--check");

// Daily allowances and pacing count local days: run in UTC so the fixtures are the same everywhere.
if (process.env.TZ !== "UTC") {
  const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: "inherit", env: { ...process.env, TZ: "UTC" } });
  process.exit(r.status ?? 1);
}

const { install } = await import("../src/settings.mjs");
const { codexEnv, installCodex, refreshCodex } = await import("../src/codex.mjs");
const { recordHookRun } = await import("../src/hook-health.mjs");
const { runHook } = await import("../src/hook.mjs");
const { pauseNow, recordReading, writeRules } = await import("../src/store.mjs");
const { writeBudgetRules } = await import("../src/allowances.mjs");
const { snapshot } = await import("../src/providers.mjs");
const { digest, discoveryPayload, providerPayload, settingsPayload, snapshotMessage, snapshotProblems } = await import("../src/native-protocol.mjs");
const { DEFAULT_RULES } = await import("../src/rules.mjs");

// 2030-03-17 17:46:40 UTC: the clock of Codex's illustrative answers in test/fixtures/codex-rate-limits.
const NOW = 1_900_000_000_000;
const S = NOW / 1000;
const codexAnswer = (name) => JSON.parse(fs.readFileSync(path.join(ROOT, "test", "fixtures", "codex-rate-limits", fs.readdirSync(path.join(ROOT, "test", "fixtures", "codex-rate-limits")).find((f) => f.startsWith(name))), "utf8"));
const COMMAND = `"${process.execPath}" "${path.join(ROOT, "bin", "peras.mjs")}"`;

function home() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "peras-native-fixture-"));
  return { dir, env: { HOME: dir, PATH: process.env.PATH, TZ: "UTC", PERAS_SWIFTBAR_DIR: path.join(dir, "swiftbar") } };
}

function setUp(env) {
  install({ env, command: COMMAND, version: PACKAGE_VERSION });
  installCodex(env, COMMAND);
  recordHookRun(env, "PreToolUse", NOW - 60_000);
  recordHookRun(codexEnv(env), "PreToolUse", NOW - 90_000);
}

const claudeReading = (five, week, seenAt = NOW - 30_000) => ({
  five_hour: { usedPct: five, resetsAt: S + 2 * 3600, seenAt },
  seven_day: { usedPct: week, resetsAt: S + 3 * 86400, seenAt },
});

const scenarios = {
  "missing-setup": async () => {},
  "normal-usage": async (env) => {
    setUp(env);
    recordReading(env, claudeReading(32, 48));
    await refreshCodex(env, NOW - 30_000, { reader: async () => codexAnswer("01") });
  },
  // The integration gate: a Claude-only pause leaves Codex exactly as it was.
  "manual-pause": async (env) => {
    setUp(env);
    recordReading(env, claudeReading(32, 48));
    await refreshCodex(env, NOW - 30_000, { reader: async () => codexAnswer("01") });
    pauseNow(env, { now: NOW - 10 * 60_000, until: NOW + 50 * 60_000 });
    // Two tool calls the paused hook denied: a genuine protection receipt.
    for (const at of [NOW - 8 * 60_000, NOW - 2 * 60_000]) runHook({ env, now: at, input: { hook_event_name: "PreToolUse", session_id: "fixture-session", cwd: env.HOME, tool_name: "Bash" } });
  },
  // Protected and tested, then paused by hand: the app's one PassControl suggestion shows.
  "suggestion-pause": async (env) => {
    setUp(env);
    recordReading(env, claudeReading(32, 48));
    await refreshCodex(env, NOW - 30_000, { reader: async () => codexAnswer("01") });
    const { runProtectionTest } = await import("../src/protection-test.mjs");
    if (!runProtectionTest(env, NOW - 20 * 60_000).passed) throw new Error("the fixture's protection test failed");
    pauseNow(env, { now: NOW - 10 * 60_000, until: NOW + 50 * 60_000 });
  },
  // A stop in one project folder, seen through an agent session working there.
  "scoped-stop": async (env, dir) => {
    setUp(env);
    const site = path.join(dir, "work", "launch-site");
    fs.mkdirSync(site, { recursive: true });
    writeRules(env, [...DEFAULT_RULES, { kind: "window", window: "seven_day", at: 40, action: "pause", project: fs.realpathSync(site) }]);
    recordReading(env, claudeReading(32, 48));
    const { readState, writeState } = await import("../src/store.mjs");
    const state = readState(env, NOW);
    state.sessions["fixture-session"] = { cwd: fs.realpathSync(site), t: NOW - 20_000, startedAt: NOW - 600_000, event: "PreToolUse", lastToolAt: NOW - 20_000 };
    writeState(env, state);
    await refreshCodex(env, NOW - 30_000, { reader: async () => codexAnswer("01") });
  },
  // A workday pacing plan with the week shown as text: the weekly bar's pace tick reads expectedByTonightPercent.
  "pacing-text": async (env) => {
    setUp(env);
    const { setPacing } = await import("../src/planning.mjs");
    const { setWeeklyStyle } = await import("../src/preferences.mjs");
    setPacing(env, { days: [0, 1, 2, 3, 4, 5, 6], reserve: 10, action: "warn" });
    setWeeklyStyle(env, "text");
    recordReading(env, claudeReading(30, 40, NOW - 2 * 3600_000));
    recordReading(env, claudeReading(41, 46));
    await refreshCodex(env, NOW - 30_000, { reader: async () => codexAnswer("01") });
  },
  // The morning after Claude's week rolled over: the recap beside the reset greeting, and the filling pear.
  "weekly-recap": async (env) => {
    setUp(env);
    const { writeUsage } = await import("../src/usage.mjs");
    const { recordEvent } = await import("../src/events.mjs");
    const { setDisplayStyle } = await import("../src/menubar.mjs");
    setDisplayStyle(env, "fill");
    const end = Math.floor((NOW - 9 * 3600_000) / 1000), endMs = end * 1000;
    recordReading(env, { ...claudeReading(12, 2), seven_day: { usedPct: 2, resetsAt: end + 7 * 86400, seenAt: NOW - 30_000 } });
    writeUsage(env, { v: 1, windows: { seven_day: { resetsAt: end + 7 * 86400, pts: [[NOW, 2]] } }, weeks: [{ resetsAt: end, pts: [[endMs - 4 * 86400_000, 35], [endMs - 25 * 60_000, 88]] }], blame: null });
    recordEvent(env, { kind: "warning", provider: "claude", at: endMs - 86400_000, message: "Weekly usage passed 80%." });
    await refreshCodex(env, NOW - 30_000, { reader: async () => codexAnswer("01") });
  },
  // Today's allowance is used up; Codex is reporting weekly usage only.
  "daily-exhausted": async (env) => {
    setUp(env);
    writeBudgetRules(env, [{ period: "daily", at: 10, action: "pause", createdAt: NOW - 6 * 3600_000 }]);
    recordReading(env, claudeReading(30, 40, NOW - 2 * 3600_000));
    recordReading(env, claudeReading(41, 52));
    await refreshCodex(env, NOW - 30_000, { reader: async () => codexAnswer("02") });
  },
};

let failed = false;
fs.mkdirSync(OUT, { recursive: true });
for (const [name, build] of Object.entries(scenarios)) {
  const { dir, env } = home();
  try {
    await build(env, dir);
    const providers = [];
    for (const provider of ["claude", "codex"]) {
      const s = await snapshot(env, NOW, { provider, cwd: null });
      // Ids hash local folders; hash them as if the throwaway home were always the same place.
      const opaque = (text) => digest(String(text).replaceAll(fs.realpathSync(dir), "<home>").replaceAll(dir, "<home>"));
      // Real tokens are keyed to one bridge; a fixture's are a stable digest of the same body.
      const sign = (body) => `tok_fixture_${opaque(JSON.stringify(body))}`;
      providers.push(providerPayload(s, { now: NOW, sign, id: () => `ctx_fixture_${provider}`, opaque }));
    }
    const settings = settingsPayload(env, { now: NOW, sign: (body) => `tok_fixture_${digest(JSON.stringify(body))}` });
    const discovery = discoveryPayload(env, providers, { now: NOW, sign: (body) => `tok_fixture_${digest(JSON.stringify(body))}` });
    const message = snapshotMessage({ bridgeInstance: "fixture", revision: 1, now: NOW, providers, settings, discovery });
    const problems = snapshotProblems(message);
    const text = `${JSON.stringify(message, null, 2)}\n`;
    const file = path.join(OUT, `${name}.json`);
    if (problems.length) { console.error(`${name}: ${problems.join(", ")}`); failed = true; }
    else if (text.includes(dir) || text.includes(os.homedir()) || text.includes(ROOT)) { console.error(`${name}: a local path reached the fixture`); failed = true; }
    else if (check) {
      if (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== text) { console.error(`${name}: out of date. Run node scripts/native-fixtures.mjs`); failed = true; }
    } else fs.writeFileSync(file, text);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
if (failed) process.exit(1);
console.log(check ? "Native fixtures match the code." : `Wrote ${Object.keys(scenarios).length} fixtures to test/fixtures/native-v1.`);
