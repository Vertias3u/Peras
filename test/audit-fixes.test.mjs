import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { sandbox, NOW, inHours } from "./helpers.mjs";
import { recordReading, context, pauseNow, writeRules, perasHome, dirKey, readState } from "../src/store.mjs";
import { setBudget, allowanceMeters, budgetText } from "../src/allowances.mjs";
import { setPacing, grantExtra, saveProfile, readPlanning } from "../src/planning.mjs";
import { evaluate } from "../src/rules.mjs";
import { runHook, describe } from "../src/hook.mjs";
import { handleNotificationAction, createActionTicket } from "../src/notification-actions.mjs";
import { snapshot } from "../src/providers.mjs";
import { codexEnv, runCodexHook } from "../src/codex.mjs";
import { renderCombined } from "../src/menubar.mjs";
import { main } from "../src/cli.mjs";

const read = (env, pct, at = NOW) => recordReading(env, { seven_day: { usedPct: pct, seenAt: at, resetsAt: inHours(72) }, five_hour: { usedPct: 10, seenAt: at, resetsAt: inHours(3) } });
const tool = (cwd, session = "s1") => ({ hook_event_name: "PreToolUse", session_id: session, cwd, tool_name: "Bash" });
const denied = (out) => out?.hookSpecificOutput?.permissionDecision === "deny" || out?.decision === "block";

test("a held allowance or planning lock cannot skip a pause in the hook", () => {
  for (const which of ["allowance", "planning"]) {
    const { env, root } = sandbox();
    fs.mkdirSync(path.join(root, "proj"));
    const project = fs.realpathSync(path.join(root, "proj"));
    writeRules(env, []);
    read(env, 30);
    if (which === "allowance") setBudget(env, { period: "weekly", at: 50, action: "pause", project }, NOW - 1000);
    else setPacing(env, { days: [0, 1, 2, 3, 4, 5, 6], reserve: 20, action: "pause" });
    pauseNow(env, { now: NOW });
    const lock = which === "allowance" ? path.join(perasHome(env), "allowance-locks", `${dirKey(env)}.json`) : path.join(perasHome(env), "planning", `${dirKey(env)}.json.lock`);
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, "");
    const started = Date.now();
    for (const at of [NOW + 1000, NOW + 2000]) {
      const out = runHook({ input: tool(project), env, now: at });
      assert.ok(denied(out), `${which}: ${JSON.stringify(out)}`);
    }
    assert.ok(Date.now() - started < 1000, `${which}: hooks must not wait on the lock`);
  }
});

test("pacing still enforces today's share while its lock is busy", () => {
  const { env } = sandbox();
  writeRules(env, []);
  read(env, 40);
  setPacing(env, { days: [0, 1, 2, 3, 4, 5, 6], reserve: 20, action: "pause" });
  const lock = path.join(perasHome(env), "planning", `${dirKey(env)}.json.lock`);
  fs.writeFileSync(lock, "");
  const busy = allowanceMeters(env, NOW, context(env, { now: NOW }).window).find((m) => m.kind === "pacing");
  assert.ok(busy.at > 0);
  assert.equal(readPlanning(env).anchor, undefined, "nothing is saved while the lock is held");
  fs.unlinkSync(lock);
  const saved = allowanceMeters(env, NOW, context(env, { now: NOW }).window).find((m) => m.kind === "pacing");
  assert.equal(readPlanning(env).anchor.at, saved.at);
  assert.equal(busy.at, saved.at);
});

test("notification Resume works with a folder override and sessions in two folders", async () => {
  const { env, root } = sandbox();
  const a = path.join(root, "a"), b = path.join(root, "b");
  fs.mkdirSync(a); fs.mkdirSync(b);
  writeRules(env, [{ kind: "window", window: "seven_day", at: 50, action: "pause" }, { kind: "window", window: "seven_day", at: 40, action: "pause", project: fs.realpathSync(a) }]);
  read(env, 60);
  runHook({ input: tool(b, "sb"), env, now: NOW + 500 });
  let options;
  runHook({ input: tool(a, "sa"), env, now: NOW + 1000, notify: (title, body, o) => { options = o; } });
  assert.ok(options?.pauseKeys?.length);
  const tickets = path.join(perasHome(env), "notifications-native-v1");
  const id = createActionTicket(tickets, env, { provider: "claude", category: "pause", pauseKeys: options.pauseKeys }, NOW + 1000);
  const result = await handleNotificationAction(path.join(tickets, "actions", `${id}.json`), "PERAS_RESUME", { now: NOW + 2000 });
  assert.equal(result.resumed, true);
  assert.equal(runHook({ input: tool(a, "sa"), env, now: NOW + 3000 }), null);
});

test("Codex notification Resume works with a folder override and sessions in two folders", async () => {
  const { env, root } = sandbox();
  const scoped = codexEnv(env);
  const a = path.join(root, "a"), b = path.join(root, "b");
  fs.mkdirSync(a); fs.mkdirSync(b);
  writeRules(scoped, [{ kind: "window", window: "seven_day", at: 50, action: "pause" }, { kind: "window", window: "seven_day", at: 40, action: "pause", project: fs.realpathSync(a) }]);
  const reader = async () => ({ rateLimits: { limitId: "codex", primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: inHours(3) }, secondary: { usedPercent: 60, windowDurationMins: 10080, resetsAt: inHours(72) } } });
  await runCodexHook({ input: tool(b, "sb"), env, now: NOW + 500, reader });
  let options;
  await runCodexHook({ input: tool(a, "sa"), env, now: NOW + 1000, reader, notify: (title, body, o) => { options = o; } });
  assert.equal(options?.provider, "codex");
  const tickets = path.join(perasHome(env), "notifications-native-v1");
  const id = createActionTicket(tickets, env, { provider: "codex", category: "pause", pauseKeys: options.pauseKeys }, NOW + 1000);
  const result = await handleNotificationAction(path.join(tickets, "actions", `${id}.json`), "PERAS_RESUME", { now: NOW + 2000 });
  assert.deepEqual(result, { resumed: true, provider: "codex" });
  assert.equal(readState(scoped, NOW + 2000).resumed.length, options.pauseKeys.length);
});

test("extra points can be granted from an older reading in the current weekly window", () => {
  const { env } = sandbox();
  writeRules(env, []);
  setBudget(env, { period: "daily", at: 5, action: "pause" }, NOW - 60_000);
  read(env, 30, NOW);
  read(env, 36, NOW + 60_000);
  const later = NOW + 11 * 60_000;
  assert.equal(evaluate(context(env, { now: later })).action, "pause");
  grantExtra(env, { period: "daily", points: 3, until: later + 3600_000 }, later, context(env, { now: later }).window.seven_day);
  assert.equal(evaluate(context(env, { now: later })).action, "none");
});

test("a non-working pacing day says so instead of 0/0 points", async () => {
  const { env } = sandbox();
  writeRules(env, []);
  read(env, 10);
  setPacing(env, { days: [(new Date(NOW).getDay() + 1) % 7], reserve: 20, action: "pause" });
  const verdict = evaluate(context(env, { now: NOW }));
  assert.equal(verdict.action, "pause");
  assert.match(describe(verdict.hit, NOW).short, /not a working day/);
  assert.doesNotMatch(describe(verdict.hit, NOW).what, /0 of 0/);
  const lines = [];
  await main(["status"], { env, now: NOW, out: (line) => lines.push(line), isTTY: false });
  const status = lines.join("\n");
  assert.match(status, /Workday pace: not a working day/);
  assert.doesNotMatch(status, /0 \/ 0 points/);
  const menu = renderCombined({ snapshots: [await snapshot(env, NOW)], env, now: NOW });
  assert.doesNotMatch(menu, /0 \/ 0 points/);
  lines.length = 0;
  await main(["pace", "20", "fri", "pause"], { env, now: NOW, out: (line) => lines.push(line), isTTY: false });
  assert.match(lines.join("\n"), /On other days agents get no share/);
});

test("an extra on a non-working pacing day shows the points it adds", () => {
  const { env } = sandbox();
  writeRules(env, []);
  read(env, 10);
  setPacing(env, { days: [(new Date(NOW).getDay() + 1) % 7], reserve: 20, action: "pause" });
  const weekly = context(env, { now: NOW }).window.seven_day;
  grantExtra(env, { period: "daily", points: 3, until: NOW + 3600_000 }, NOW, weekly);
  const meter = allowanceMeters(env, NOW, context(env, { now: NOW }).window).find((m) => m.kind === "pacing");
  assert.match(budgetText(meter), /0 \/ 3 points \(\+3 temporary\)/);
  assert.equal(evaluate(context(env, { now: NOW })).action, "none");
});

test("a profile name starting with a dash stays one menu level deep", async () => {
  const { env } = sandbox();
  writeRules(env, []);
  read(env, 30);
  saveProfile(env, "-late");
  const menu = renderCombined({ snapshots: [await snapshot(env, NOW + 1000)], env: { ...env, SWIFTBAR_PLUGIN_PATH: "/x/peras.sh" }, now: NOW + 1000 });
  const row = menu.split("\n").find((line) => line.includes("param3=-late"));
  assert.match(row, /^--‑late \|/);
});
