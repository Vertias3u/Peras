import { setPacing, readPlanning, dayNames, profileSummary, saveProfile, useProfile, deleteProfile, grantExtra, activeExtras, revokeExtra } from "./planning.mjs";
import { sessionOverview, sessionsText } from "./sessions.mjs";
import { parseBudget, setBudget, allowanceMeters, budgetText } from "./allowances.mjs";
import { reviewFor, reviewText, comparisonText } from "./review.mjs";
import { alternativeHint } from "./alternative.mjs";
import { testNotification } from "./notify.mjs";
import { localDay } from "./calendar.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WINDOWS, resetTime } from "./window.mjs";
import { DEFAULT_RULES, effectiveRules, evaluate, parseSet, realDir, setRule } from "./rules.mjs";
import { claudeDir, context, pauseNow, perasHome, readInstall, readRules, readState, readWindow, resume, wholeMinute, writeRules } from "./store.mjs";
import { install, uninstall, inspect, settingsPath } from "./settings.mjs";
import { readUsage, weeklyHistory } from "./usage.mjs";
import { etaTo } from "./forecast.mjs";
import { blameShares } from "./blame.mjs";
import { MARK, bar, colorOn, paint, toneFor } from "./look.mjs";
import { describe } from "./hook.mjs";
import * as menubar from "./menubar.mjs";
import { codexEnv, inspectCodex, installCodex, removeCodex } from "./codex.mjs";
import { snapshot, statusText, whyText, codexDoctor, terminalStatusline } from "./providers.mjs";
import { preferences, setPreference } from "./preferences.mjs";
import { hookHealth } from "./hook-health.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
export const VERSION = PACKAGE.version;
const PASSCONTROL = "https://passcontrol.vertias.eu";

const HELP = `Peras 🍐 ${VERSION}: stop Claude Code or Codex before it burns the rest of your limit.

  peras setup                 add the hooks + status line to Claude Code (with a backup)
  peras update [--check]      update the CLI, installed hooks, and menu bar
  peras codex setup           add hooks for Codex desktop and CLI
  peras codex status          read Codex's ChatGPT plan usage
  peras codex statusline      compact ANSI usage readout (outside Codex's native footer)
  peras codex pause|resume    pause or resume Codex tools
  peras codex set ...         set Codex's limits (same syntax as peras set)
  peras codex history         past Codex usage windows
  peras codex doctor          check Codex hooks, runtime, and usage
  peras why                   explain active rules for both agents
  peras codex why             explain Codex's active rules
  peras codex remove          remove Peras's Codex hooks
  peras status                both agents: usage, resets, pauses, and reading ages
  peras budget daily 10 pause  cap today’s observed rise in weekly usage
  peras budget --here weekly 5 pause  estimated allowance for this project
  peras pace 20               keep 20% reserved across remaining workdays
  peras profile save NAME     save current rules, allowances and pacing
  peras profile use NAME      switch profiles without resetting usage
  peras extra daily 3 1h      add 3 points to today’s allowance for an hour
  peras extra --here 3 today  add 3 project points until local midnight
  peras sessions              recently observed sessions and their limits
  peras compare               compare two completed tracked weeks
  peras settings              open the local visual rule editor
  peras review                weekly usage charts and retained interventions
  peras history               past weeks: peak, lines crossed, when it hit the wall
  peras pause [1h|18:00]      pause Claude Code now, until a time or until you resume
  peras resume [1h]           lift a pause: for the rest of the window, or for 1h

  peras set weekly 85 pause   a line: 5h|weekly, warn|ask|pause, 1-100|off
  peras set weekly pace pause act when the week is on pace to run out early
  peras set prompt 3 pause    act when one prompt raises the week by 3 points
  peras set 01:00-08:00 weekly 50 pause    a line for part of the day
  peras set --here weekly 60 pause         a line for this folder and below
  peras set reset             back to the defaults (--here: drop this folder's lines)

  peras notify                which desktop notifications are on
  peras notify warnings off   switch one: warnings|pauses|resets|unused on|off
  peras notify test           send a sample pear notification
  peras events                recent warnings, pauses, resumes, and resets
  peras test                  test pause and resume on a throwaway copy of the hooks
  peras doctor                check that everything is wired up, hooks included

  peras menubar               whether 🍐 is in the menu bar, and its commands
  peras menubar install       🍐 in the macOS menu bar (needs the free SwiftBar)
  peras menubar display pear|usage    choose pear only, or icons and percentages
  peras menubar quit          quit the menu bar (protection keeps running)
  peras menubar open          open the menu bar again after quitting
  peras menubar preference mascots|weekly on|off
  peras remove                take out exactly what setup added
  peras connect               what PassControl adds on top

Watching: ${"$"}CLAUDE_CONFIG_DIR (or ~/.claude) and ${"$"}CODEX_HOME (or ~/.codex).`;

const tilde = (p, env) => {
  const home = env.HOME;
  return home && p.startsWith(home) ? `~${p.slice(home.length)}` : p;
};

const ago = (ms) => {
  const m = Math.round(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
};

function ruleText(r) {
  const name = WINDOWS[r.window].name;
  const during = r.during ? ` ${r.during}` : "";
  if (r.off) return `${r.kind === "window" ? name : `${name} ${r.kind}`} ${r.action} off${during}`;
  if (r.kind === "pace") return `${name} pace ${r.action} (from ${r.at}%)${during}`;
  if (r.kind === "prompt") return `${name} +${r.at}% per prompt ${r.action}${during}`;
  return `${name} ${r.at}% ${r.action}${during}`;
}

/** Global lines on one line, then each folder's. */
function linesText(rules, env) {
  const global = rules.filter((r) => !r.project);
  const out = [`Lines: ${global.map(ruleText).join(" · ") || "none"}`];
  for (const project of [...new Set(rules.filter((r) => r.project).map((r) => r.project))]) {
    out.push(`  in ${tilde(project, env)}: ${rules.filter((r) => r.project === project).map(ruleText).join(" · ")}`);
  }
  return out.join("\n");
}

const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad2 = (n) => String(n).padStart(2, "0");
const dateText = (ms, clock = true) => {
  const d = new Date(ms);
  return `${DAY[d.getDay()]} ${d.getDate()} ${MONTH[d.getMonth()]}${clock ? ` ${pad2(d.getHours())}:${pad2(d.getMinutes())}` : ""}`;
};

/** "1h", "30m", "1h30m" → ms; "18:00" → ms until it next comes round. */
export function parseWhen(word, now = Date.now()) {
  const w = String(word ?? "").toLowerCase();
  const dur = /^(?:(\d+)h)?(?:(\d+)m)?$/.exec(w);
  if (dur && (dur[1] || dur[2])) {
    const ms = Number(dur[1] ?? 0) * 3600_000 + Number(dur[2] ?? 0) * 60_000;
    if (!Number.isSafeInteger(ms) || ms <= 0 || !Number.isFinite(new Date(now + ms).getTime())) throw new Error("Say a positive, finite length like 1h or 30m.");
    return ms;
  }
  const clock = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(w);
  if (clock) {
    const at = new Date(now);
    at.setHours(Number(clock[1]), Number(clock[2]), 0, 0);
    if (at.getTime() <= now) at.setDate(at.getDate() + 1);
    return at.getTime() - now;
  }
  throw new Error(`Did not understand "${word}". Say a length like 1h or 30m, or a time like 18:00.`);
}

function onPath(name, env) {
  const exts = process.platform === "win32" ? [".cmd", ".exe", ""] : [""];
  return String(env.PATH ?? "")
    .split(path.delimiter)
    .some((dir) => dir && exts.some((ext) => fs.existsSync(path.join(dir, name + ext))));
}

/** The runtime goes to ~/.peras/app so the hooks never point into an npx cache. */
function copyRuntime(env) {
  const app = path.join(perasHome(env), "app");
  if (path.resolve(app) !== ROOT) {
    fs.rmSync(app, { recursive: true, force: true });
    fs.mkdirSync(app, { recursive: true, mode: 0o700 });
    for (const part of ["bin", "src", "package.json"]) fs.cpSync(path.join(ROOT, part), path.join(app, part), { recursive: true });
  }
  return path.join(app, "bin", "peras.mjs");
}

function hasPassControl(env) {
  try {
    return /_passcontrol\//.test(fs.readFileSync(settingsPath(env), "utf8"));
  } catch {
    return false;
  }
}

/**
 * The node on PATH when it is this same binary, else this binary's real path.
 * process.execPath resolves symlinks, and a version manager's real path moves
 * on the next upgrade, while the PATH entry stays put.
 */
function nodePath(env) {
  for (const dir of String(env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, process.platform === "win32" ? "node.exe" : "node");
    try {
      if (fs.realpathSync(candidate) === fs.realpathSync(process.execPath)) return candidate;
    } catch {
      // Not here.
    }
  }
  return process.execPath;
}

/**
 * The hint in a pause message must work as typed, however Peras was installed.
 * The npm package is `peras-cli` (npm refused `peras` as too close to `pegjs`);
 * the command it installs is `peras`.
 */
export function resumeHintFor({ onPath: found, root, command }) {
  // npx first: while it runs, its temporary bin is on PATH, so `found` is true
  // for a `peras` that is gone the moment setup exits.
  if (root.split(/[\\/]/).includes("_npx")) return `npx ${PACKAGE.name} resume`;
  if (found) return "peras resume";
  return `${command} resume`;
}

function setup(env, out) {
  const before = readInstall(env)?.version;
  const bin = copyRuntime(env);
  const command = `"${nodePath(env)}" "${bin}"`;
  const resumeHint = resumeHintFor({ onPath: onPath("peras", env), root: ROOT, command });
  const result = install({ env, command, resumeHint, version: VERSION });
  const upgraded = before && before !== VERSION ? ` (updated from ${before} to ${VERSION})` : "";
  out(`Peras 🍐 is ${result.changed ? "set up" : "already set up"} in ${tilde(result.target, env)}${upgraded}`);
  if (result.backupPath && result.changed) out(`  backup of your settings: ${tilde(result.backupPath, env)}`);
  if (result.chained) out(`  your status line still shows; Peras runs in front of it: ${result.chained}`);
  if (result.hooksDisabled) out(`  ⚠️ "disableAllHooks" is on in your settings, so Peras cannot pause anything until it is off.`);
  if (hasPassControl(env)) out("  PassControl's hooks are here too. Both run; the stricter answer wins.");
  if (menubar.installed(env)) {
    menubar.install(env, { command, folder: path.dirname(menubar.installed(env)) });
    out("  the menu bar plugin is updated too");
  }
  out("");
  out(linesText(readRules(env), env));
  out("The window shows up after Claude Code's next reply (Pro/Max logins only). Restart open sessions to pick up the hooks.");
  if (upgraded) out("Open sessions keep the old hooks' behaviour until they restart.");
  return 0;
}

function remove(env, out) {
  const result = uninstall({ env });
  if (!result.changed) out(`Nothing of Peras's in ${tilde(result.target, env)}.`);
  else out(`Peras is out of ${tilde(result.target, env)}.${result.restored ? ` Your status line is back: ${result.restored}` : ""}`);
  const others = fs.existsSync(path.join(perasHome(env), "install")) && fs.readdirSync(path.join(perasHome(env), "install")).length > 0;
  if (!others) {
    const plugin = menubar.remove(env);
    if (plugin) out(`The menu bar plugin is gone too (${tilde(plugin, env)}).`);
    fs.rmSync(path.join(perasHome(env), "app"), { recursive: true, force: true });
  }
  out(`Your lines and history stay in ${tilde(perasHome(env), env)}; delete that folder to forget them too.`);
  return 0;
}

function readContext(env, now, out, codex = false) {
  try {
    readWindow(env);
  } catch (error) {
    out(`⚠️ The saved window is unreadable (${error.message}). It is rewritten on ${codex ? "Peras's next Codex usage read" : "Claude Code's next reply"}.`);
  }
  const usage = readUsage(env);
  const state = readState(env, now);
  const cwd = realDir(process.cwd());
  const ctx = context(env, { now, cwd, state, usage });
  return { ctx, usage, state, cwd };
}

/** One agent's panel. `env` is that agent's (codexEnv for Codex); `snap` is its snapshot, for hook health. */
function status(env, out, now, { isTTY = process.stdout.isTTY, verdict, snap, root = env } = {}) {
  const codex = snap?.provider === "codex";
  const cmd = (words) => `\`peras ${codex ? "codex " : ""}${words}\``;
  const { ctx, usage, state, cwd } = readContext(env, now, out, codex);
  const live = ctx.window;
  const color = colorOn(env, Boolean(isTTY));
  const { action, hit, hits } = verdict ?? evaluate(ctx);
  const health = snap?.health;
  const healthy = health?.label === "Protection active";
  // A guard that last ran a while ago is normal after a break, not a problem.
  const idle = health?.label === "Not recently verified";
  out(`Peras 🍐 watching ${tilde(claudeDir(env), env)}`);
  out("");
  if (snap?.error) out(`  Could not refresh: ${snap.error}. Showing saved readings while their windows last.`);
  if (!Object.keys(live).length) {
    out(codex ? "  No usage window yet. It arrives once Peras can read Codex's plan usage." : "  No usage window yet. It arrives after Claude Code's next reply, on a Pro/Max login.");
  } else {
    for (const [name, { label }] of Object.entries(WINDOWS)) {
      const w = live[name];
      if (!w) continue;
      const pct = Math.round(w.usedPct);
      const tone = toneFor(name, pct, ctx.rules);
      const f = ctx.forecast[name];
      const full = etaTo(f, 100);
      let where = "";
      if (full) where = paint(color, "red", `full by ${resetTime(full / 1000, now)}`);
      else if (f) where = `on pace for ${Math.round(Math.min(f.projected, 100))}% at reset`;
      out(`  ${label.padEnd(3)} ${paint(color, tone, `${bar(pct)} ${String(pct).padStart(3)}%`)}   resets ${resetTime(w.resetsAt, now).padEnd(9)}  ${where}`);
    }
    out(paint(color, "dim", `      seen ${ago(now - Math.max(...Object.values(live).map((w) => w.seenAt ?? 0)))}${healthy ? " · protection active" : idle ? ` · hooks last ran ${ago(now - health.at)}` : ""}`));
  }
  out("");
  if (action === "pause") {
    const d = describe(hit, now);
    out(paint(color, "red", `⏸️  PAUSED: ${d.what}.`) + ` ${d.lifts}, or run ${cmd("resume")}.`);
  } else if (action === "ask") {
    out(paint(color, "red", `✋ Asking once per session: ${describe(hit, now).what}.`));
  } else if (action === "warn") {
    out(paint(color, "yellow", `${MARK.warn} ${hits.map((h) => describe(h, now).short).join(", ")}.`));
  }
  for (const meter of ctx.allowances || []) out(`  ${budgetText(meter)}`);
  const liveKeys = [...Object.values(live), ...(ctx.allowances || [])].map((w) => `@${w.resetsAt}`);
  const lifted = state.resumed.filter((r) => liveKeys.some((k) => r.key.includes(k)));
  if (action !== "pause" && action !== "ask" && lifted.length) {
    const until = Math.min(...lifted.map((r) => r.until ?? Number(r.key.split("@")[1].split("#")[0]) * 1000));
    out(`▶ Resumed until ${resetTime(until / 1000, now)}. A higher line still stops it.`);
  } else if (action === "none" && Object.keys(live).length) out(paint(color, "green", "✓ Under every line."));
  const wired = codex ? inspectCodexSafe(root) : inspectSafe(env);
  const setUp = Boolean(wired?.events.length);
  if (health && !healthy && !idle && setUp) out(paint(color, "yellow", `• Hooks: ${health.label}. ${health.detail}`));

  const shares = live.seven_day && !codex ? blameShares(usage.blame, live.seven_day.usedPct) : [];
  if (shares.length) {
    out("");
    out(`This week by chat (≈: shared out by what each spent; claude.ai use counts too):`);
    const top = shares.slice(0, 5);
    const width = Math.max(...top.map((s) => (s.dir ? tilde(s.dir, env) : "?").length));
    for (const s of top) {
      out(`  ≈ ${`+${s.pct}%`.padEnd(7)} ${(s.dir ? tilde(s.dir, env) : "?").padEnd(width)}  ${paint(color, "dim", s.session.slice(0, 8))}`);
    }
  }
  if (action !== "none" || lifted.length || Object.keys(live).length) out("");
  const here = effectiveRules(ctx.rules, cwd).length !== effectiveRules(ctx.rules, null).length || ctx.rules.some((r) => r.project && cwd && cwd.startsWith(r.project));
  out(linesText(ctx.rules, env));
  if (here) out(`  (this folder has its own lines)`);
  if (!setUp) out(`Not set up yet: run ${cmd("setup")}.`);
  const record = readInstall(env);
  if (record?.version && record.version !== VERSION) out(`• The hooks still run Peras ${record.version}: run ${cmd("setup")} to update them to ${VERSION}.`);
  return 0;
}

function inspectCodexSafe(env) {
  try {
    return inspectCodex(env);
  } catch {
    return null;
  }
}

function inspectSafe(env) {
  try {
    return inspect(env);
  } catch {
    return null;
  }
}

function doResume(env, out, now, args) {
  const forMs = args.length ? parseWhen(args.join(""), now) : null;
  const { lifted, manual, until, issue } = resume(env, { now, forMs, cwd: realDir(process.cwd()) });
  if (!lifted.length && !manual) {
    out("Nothing is paused or asking right now.");
    return 0;
  }
  if (manual) out("▶ Your pause is over.");
  if (issue) out(`⚠️ Usage rules could not be checked (${issue}). Only your manual pause was cleared; run \`peras doctor\`.`);
  for (const h of lifted) {
    const d = describe(h, now);
    const till = until ? `for ${args.join(" ")}, until ${resetTime(until / 1000, now)}` : h.kind === "prompt" ? "for this prompt" : `until it resets ${resetTime(h.resetsAt, now)}`;
    out(`▶ Lifted: ${d.short}, ${till}.`);
  }
  return 0;
}

function doPause(env, out, now, args, product = "Claude Code") {
  const words = args.filter((w) => w !== "until" && w !== "for");
  const until = words.length ? wholeMinute(now + parseWhen(words.join(""), now)) : null;
  pauseNow(env, { now, until });
  out(`⏸️  ${product} is paused${until ? ` until ${resetTime(until / 1000, now)}` : ` until you run \`peras ${product === "Codex" ? "codex " : ""}resume\``}. A prompt you type still goes through; tools wait.`);
  return 0;
}

function set(env, out, args) {
  if (!args.length) {
    out(linesText(readRules(env), env));
    return 0;
  }
  const parsed = parseSet(args);
  let rules = readRules(env);
  if (parsed.op === "reset") {
    rules = parsed.project ? rules.filter((r) => r.project !== parsed.project) : [...DEFAULT_RULES, ...rules.filter((r) => r.project)];
  } else {
    rules = setRule(rules, parsed.rule, parsed.at);
  }
  writeRules(env, rules);
  out(linesText(rules, env));
  return 0;
}

function pacingCommand(env, out, args) {
  if (args[0] === "off" && args.length === 1) setPacing(env, null);
  else if (args.length) {
    const names = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
    const action = args.find((word) => ["warn", "ask", "pause"].includes(word)) || "pause";
    const rest = args.slice(1).filter((word) => !["warn", "ask", "pause"].includes(word));
    if (rest.length > 1 || args.length > 3) throw new Error("Use peras pace 20 mon,tue,wed,thu,fri pause, or peras pace off");
    const days = rest.length ? rest[0].split(",").map((day) => names[day.toLowerCase()]) : [1, 2, 3, 4, 5];
    setPacing(env, { reserve: Number(args[0]), days, action });
  }
  const plan = readPlanning(env).pacing;
  if (!plan) {
    out("Workday pacing is off. Use peras pace 20 to reserve 20% across your remaining weekdays.");
    return 0;
  }
  out(`Workday pacing: reserve ${plan.reserve}% · working days ${dayNames(plan.days)} · ${plan.action}. Today's share is fixed at the first fresh reading; other limits still apply.`);
  if (plan.days.length < 7) out(`On other days agents get no share, so every tool call meets the ${plan.action}. Add those days to the plan if you work them.`);
  return 0;
}

function profileCommand(env, out, now, args) {
  const [op, ...words] = args;
  const name = words.join(" ");
  if (op === "save") out(`Saved profile ${saveProfile(env, name)}.`);
  else if (op === "use") out(`Activated profile ${useProfile(env, name, now)}. Usage counters and pauses were preserved.`);
  else if (op === "delete") {
    deleteProfile(env, name);
    out(`Deleted profile ${name}.`);
  } else if (op && op !== "list") throw new Error("Use peras profile save|use|delete NAME, or peras profile list");
  const summary = profileSummary(env);
  if (!summary.names.length) out("No profiles saved yet. Configure your rules, then peras profile save Normal day.");
  else out(summary.names.map((n) => `${n === summary.active ? "●" : "○"} ${n}${n === summary.active && summary.modified ? " (modified)" : ""}`).join("\n"));
  return 0;
}

function extraCommand(env, out, now, args) {
  const weekly = context(env, { now }).window.seven_day;
  if (args[0] === "revoke") {
    if (args.length !== 2) throw new Error("Use peras extra revoke ID");
    revokeExtra(env, args[1], now);
  } else if (args.length) {
    const here = args.includes("--here");
    if ((args.includes("weekly") && !here) || (args.includes("daily") && here)) throw new Error("Use daily for the account, or --here for a project allowance.");
    const words = args.filter((w) => !["--here", "daily", "weekly"].includes(w));
    if (words.length < 1 || words.length > 2) throw new Error("Use peras extra daily 3 1h or peras extra --here 3 today");
    const midnight = localDay(now).end;
    const until = !words[1] || words[1] === "today" ? midnight : Math.min(midnight, now + parseWhen(words[1], now));
    grantExtra(env, { period: here ? "weekly" : "daily", ...(here ? { project: realDir(process.cwd()) } : {}), points: Number(words[0]), until }, now, weekly);
  }
  const extras = activeExtras(env, now, weekly);
  out(extras.length ? extras.map((g) => `${g.id} · +${g.points} points · ${g.project || "today"} · until ${eventTime(g.until, now)}`).join("\n") : "No active extra allowances.");
  out("Extras change only the selected allowance. Other warning, pause and provider limits still apply.");
  return 0;
}

function budget(env, out, now, words) {
  if (words.length) {
    const parsed = parseBudget(words);
    setBudget(env, parsed.rule, now, parsed.remove);
  }
  const meters = allowanceMeters(env, now, context(env, { now }).window);
  out(meters.length ? meters.map(budgetText).join("\n") : "No allowances set. Try peras budget daily 10 pause or peras budget --here weekly 5 pause.");
  out("Allowances count observed percentage-point increases, not token costs. Daily resets at local midnight. Project usage is a conservative estimate while that folder has an active session; parallel account use can count too.");
  return 0;
}

function history(env, out, now, { isTTY = process.stdout.isTTY } = {}) {
  const color = colorOn(env, Boolean(isTTY));
  const weeks = weeklyHistory(readUsage(env), readRules(env));
  out("Peras 🍐 weekly history");
  out("");
  if (!weeks.length) {
    out(`  Nothing yet: Peras keeps a week's points from 0.2 on, as ${env.PERAS_PROVIDER === "codex" ? "Codex" : "Claude Code"} reports them.`);
    return 0;
  }
  for (const w of weeks.sort((a, b) => b.resetsAt - a.resetsAt)) {
    const current = w.resetsAt * 1000 > now;
    const head = current ? `this week, to ${dateText(w.resetsAt * 1000, false)}` : `week to ${dateText(w.resetsAt * 1000, false)}`;
    const tone = w.wall ? "red" : w.peak >= 75 ? "yellow" : "green";
    out(`  ${head.padEnd(26)} ${paint(color, tone, `${bar(w.peak)} ${String(Math.round(w.peak)).padStart(3)}%`)}${current ? " so far" : ""}`);
    const notes = [];
    for (const c of w.crossed) if (c.at < 100) notes.push(`${c.at}% ${dateText(c.t)}`);
    if (w.wall) notes.push(paint(color, "red", `hit the wall ${dateText(w.wall)}`));
    if (notes.length) out(`  ${"".padEnd(26)} ${notes.join(" · ")}`);
    if (w.since > (w.resetsAt - 168 * 3600) * 1000 + 24 * 3600_000) out(paint(color, "dim", `  ${"".padEnd(26)} (seen from ${dateText(w.since)})`));
  }
  out("");
  out(paint(color, "dim", `Peras keeps 8 weeks. Days it saw no ${env.PERAS_PROVIDER === "codex" ? "Codex reading" : "Claude Code reply"} are gaps, not zeros.`));
  return 0;
}

async function providerSnapshots(env, now, reader) {
  const claude = await snapshot(env, now);
  const scoped = codexEnv(env);
  let hasReading = false;
  try { hasReading = Boolean(readWindow(scoped)); } catch { /* snapshot reports it */ }
  const codex = await snapshot(env, now, { provider: "codex", refresh: Boolean(readInstall(scoped) || hasReading), reader });
  return [claude, codex];
}

function panel(env, out, now, s) {
  try { status(s.env, out, now, { verdict: s.verdict, snap: s, root: env }); }
  catch { out(statusText(s, now)); }
}

async function combinedStatus(env, out, now, reader) {
  const [claude, codex] = await providerSnapshots(env, now, reader);
  panel(env, out, now, claude);
  out("");
  // Most people run only Claude Code: an unused Codex gets one line, not a panel.
  if (!readInstall(codex.env) && !Object.keys(codex.ctx.window).length) out("Codex: not set up. `peras codex setup` guards it too.");
  else panel(env, out, now, codex);
  for (const s of [claude, codex]) {
    const hint = alternativeHint(s, [claude, codex], now);
    if (hint) out(`Another agent: ${hint}`);
  }
  return 0;
}

async function protectionTest(env, out, now, reader) {
  const { runProtectionTest } = await import("./protection-test.mjs");
  const result = runProtectionTest(env, now);
  for (const row of result.providers) out(`${row.provider}: ${row.passed ? "PASS" : "FAIL"} · ${row.message}`);
  out("This isolated self-test checks the hook commands. Live activation is shown by hook health.");
  const { writeStatusPage } = await import("./status-page.mjs");
  writeStatusPage(env, await providerSnapshots(env, now, reader), now);
  return result.passed ? 0 : 1;
}

const NOTIFICATIONS = {
  warnings: "when usage crosses a warning line",
  pauses: "when Peras pauses an agent or asks for your OK",
  resets: "when a usage window resets (only while the menu bar runs)",
  unused: "use it or lose it: 20%+ left within 48h of weekly reset (only while the menu bar runs)",
};

async function notifySettings(env, out, args, sendNotification) {
  if (args.length === 1 && args[0] === "test") {
    await sendNotification("Use it or lose it 🍐", "Test notification: Claude has 30% of its weekly allowance left. Resets in 2 days.", { env });
    out("Sample notification scheduled. If no banner appears, check Peras in your desktop notification settings.");
    return 0;
  }
  if (!args.length) {
    const on = preferences(env);
    for (const [name, what] of Object.entries(NOTIFICATIONS)) out(`  ${name.padEnd(9)} ${on[name] ? "on " : "off"}  ${what}`);
    out("Switch one: peras notify warnings|pauses|resets|unused on|off");
    return 0;
  }
  if (args.length !== 2 || !(args[0] in NOTIFICATIONS)) throw new Error("Use peras notify warnings|pauses|resets|unused on|off");
  setPreference(env, args[0], args[1]);
  out(`Notifications for ${args[0]}: ${args[1]}.`);
  return 0;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** 14:05 today, Sat 14:05 this past week, 3 Oct 14:05 before that. */
function eventTime(at, now) {
  const d = new Date(at);
  if (now - at < 6 * 86_400_000) return resetTime(at / 1000, now);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${resetTime(at / 1000, at)}`;
}

async function doMenubar(env, out, now, args, reader, { quitMenubar = menubar.quit, openMenubar = menubar.open, isTTY } = {}) {
  const [sub, folder] = args;
  if (sub === "quit") {
    if (args.length !== 1) throw new Error("Use peras menubar quit");
    try { await quitMenubar(); } catch {}
    out("Quit the menu bar. Protection keeps running: the hooks don't need it. `peras menubar open` brings the 🍐 back.");
    return 0;
  }
  if (sub === "open") {
    if (args.length !== 1) throw new Error("Use peras menubar open");
    if (!menubar.installed(env)) throw new Error("🍐 is not in the menu bar yet: run `peras menubar install` first.");
    try {
      await openMenubar();
    } catch (error) {
      throw new Error(`Could not open SwiftBar (${error.message}). Install it with \`brew install --cask swiftbar\` or from swiftbar.app.`);
    }
    out("Opened SwiftBar: the 🍐 is back in the menu bar.");
    return 0;
  }
  if (sub === "test") {
    if (args.length !== 1) throw new Error("Use peras menubar test");
    return await protectionTest(env, out, now, reader);
  }
  if (sub === "preference") {
    if (args.length === 1) { out(JSON.stringify(preferences(env), null, 2)); return 0; }
    if (args.length !== 3) throw new Error("Use peras menubar preference mascots|weekly|warnings|pauses|resets|unused on|off");
    setPreference(env, args[1], args[2]);
    out(`${args[1]}: ${args[2]}`);
    return 0;
  }
  if (sub === "stream") {
    const { streamMenubar } = await import("./menubar-stream.mjs");
    const controller = new AbortController();
    const stop = () => controller.abort();
    const outputError = (error) => { if (error.code === "EPIPE") stop(); else throw error; };
    process.once("SIGTERM", stop); process.once("SIGINT", stop);
    process.stdout.on("error", outputError);
    try {
      await streamMenubar({ env, getSnapshots: () => providerSnapshots(env, Date.now(), reader), signal: controller.signal });
    } finally {
      process.removeListener("SIGTERM", stop); process.removeListener("SIGINT", stop);
      process.stdout.removeListener("error", outputError);
    }
    return 0;
  }
  if (sub === "display") {
    if (args.length > 2) throw new Error("Choose pear or usage: peras menubar display pear|usage");
    if (!folder) { out(`Menu bar display: ${menubar.displayMode(env)}`); return 0; }
    const mode = menubar.setDisplayMode(env, folder);
    out(`Menu bar display: ${mode === "pear" ? "pear only" : "pear + icons and 5-hour percentages"}. Refresh SwiftBar to see it.`);
    return 0;
  }
  if (sub === "install") {
    const record = readInstall(env) ?? readInstall(codexEnv(env));
    if (!record?.command) throw new Error("Run `peras setup` first, or `peras codex setup`; the menu bar uses the same runtime.");
    const file = menubar.install(env, { command: record.command, folder });
    out(`🍐 is in the menu bar: ${tilde(file, env)}`);
    out("SwiftBar picks it up within a minute. `peras menubar remove` takes it out.");
    return 0;
  }
  if (sub === "remove") {
    const file = menubar.remove(env);
    out(file ? `Removed ${tilde(file, env)}.` : "No menu bar plugin of Peras's to remove.");
    return 0;
  }
  if (sub && sub !== "show") throw new Error(`Did not understand "${sub}". Try: peras menubar install`);
  // SwiftBar reads the bare command's markup; a person typing it gets this instead.
  if (!sub && isTTY) { out(menubarSummary(env)); return 0; }
  const snapshots = await providerSnapshots(env, now, reader);
  const { writeStatusPage } = await import("./status-page.mjs");
  writeStatusPage(env, snapshots, now);
  out(menubar.renderCombined({ snapshots, env, now }));
  return 0;
}

function doctor(env, out, now) {
  let problems = 0;
  const check = (ok, good, bad) => {
    out(`${ok ? "✓" : "✗"} ${ok ? good : bad}`);
    if (!ok) problems++;
  };
  let wired = null;
  try {
    wired = inspect(env);
  } catch (error) {
    check(false, "", error.message);
  }
  if (wired) {
    check(wired.missingEvents.length === 0, `hooks in ${tilde(wired.target, env)}`, `hooks missing for ${wired.missingEvents.join(", ")}: run \`peras setup\``);
    check(wired.statusLine, "status line is Peras's (it feeds the window)", "status line is not Peras's, so no window arrives: run `peras setup`");
    check(!wired.hooksDisabled, "hooks are allowed", '"disableAllHooks" is on, so nothing can be paused');
  }
  const record = readInstall(env);
  if (record) {
    const bin = record.command?.match(/"([^"]+peras\.mjs)"/)?.[1];
    const node = record.command?.match(/^"([^"]+)"/)?.[1];
    check(Boolean(node && fs.existsSync(node)), `node at ${node}`, `the node Peras was set up with is gone (${node}): run \`peras setup\` again`);
    check(Boolean(bin && fs.existsSync(bin)), "runtime in place", "the runtime copy is missing: run `peras setup` again");
    if (record.version && record.version !== VERSION) out(`• hooks run Peras ${record.version}, this is ${VERSION}: run \`peras setup\` to update them`);
    if (record.statusLine?.command) out(`• chained in front of: ${record.statusLine.command}`);
  }
  let stored = null;
  try {
    stored = readWindow(env);
  } catch (error) {
    check(false, "", `the saved window is unreadable (${error.message})`);
  }
  const seen = Math.max(0, ...Object.values(stored ?? {}).map((w) => w?.seenAt ?? 0));
  check(seen > 0, `window last seen ${ago(now - seen)}`, "no window seen yet: send Claude Code one message on a Pro/Max login, then check again");
  // The menu's hook health: did a guard actually run lately? Informational, so
  // a fresh setup that hasn't run a tool yet isn't reported as broken.
  const health = (name, h) => out(h.label === "Protection active" ? `✓ ${name} hooks: protection active`
    : h.label === "Not recently verified" ? `✓ ${name} hooks: last ran ${ago(now - h.at)}. A tool call shows them active again.`
    : `• ${name} hooks: ${h.label.toLowerCase()}. ${h.detail}`);
  health("Claude Code", hookHealth(env, "claude", now));
  if (readInstall(codexEnv(env))) health("Codex", hookHealth(env, "codex", now));
  out(problems ? `\n${problems} thing${problems === 1 ? "" : "s"} to fix.` : "\nAll good.");
  return problems ? 1 : 0;
}

function connect(out) {
  out(`Peras pauses one machine's Claude Code at a line. PassControl 🛂 is the next step up:

  • Stop any agent from your phone's browser, mid-task, on a Pro/Max login too
  • A Telegram ping, and Approve / Deny from there, before a risky tool runs
  • Tool rules: block a command outright, or make it ask first
  • API keys and bot tokens kept in a vault, never in the agent
  • Daily or monthly caps per agent, sub-agent caps, alerts in Slack, Discord or Telegram
  • Signed receipts for every API call

Free beta: ${PASSCONTROL}`);
  return 0;
}

function menubarSummary(env) {
  const file = menubar.installed(env);
  if (!file) return "🍐 is not in the menu bar yet. `peras menubar install` puts it there (needs the free SwiftBar).\n`peras status` shows the same readings here.";
  const running = menubar.swiftBarRunning();
  const display = menubar.displayMode(env) === "pear" ? "pear only" : "pear + icons and 5-hour percentages";
  return [
    `🍐 is in the menu bar: ${tilde(file, env)}`,
    running === false ? "SwiftBar isn't running, so the menu is closed. `peras menubar open` brings it back." : `Display: ${display}.`,
    "",
    "`peras status` shows the same readings here.",
    "  peras menubar display pear|usage",
    "  peras menubar preference mascots|weekly on|off",
    "  peras menubar quit          close the menu (protection keeps running)",
    "  peras menubar open          open it again",
    "  peras menubar remove        take the 🍐 out",
    "  peras menubar show          the raw text SwiftBar reads",
  ].join("\n");
}

// Commands that change what the hooks read. Hooks run the copy in ~/.peras/app, so
// after `npm i -g peras-cli@latest` they can be older than this CLI, and an older
// hook reads newer lines wrongly: 0.1.1 took `prompt 3 pause` for "pause at 3% of
// the week" and ignored `peras pause` (checked against the published 0.1.1).
const WRITES = new Set(["set", "budget", "pace", "profile", "extra", "settings", "pause", "resume", "menubar"]);

/** When the hooks run an older Peras than this CLI, bring them up to date first. */
function refreshStaleHooks(env, out) {
  const claude = readInstall(env)?.version, codex = readInstall(codexEnv(env))?.version;
  const staleClaude = claude && claude !== VERSION, staleCodex = codex && codex !== VERSION;
  if (!staleClaude && !staleCodex) return;
  const bin = copyRuntime(env);
  const command = `"${nodePath(env)}" "${bin}"`;
  if (staleClaude) install({ env, command, resumeHint: resumeHintFor({ onPath: onPath("peras", env), root: ROOT, command }), version: VERSION });
  if (staleCodex) installCodex(env, command);
  if (menubar.installed(env)) menubar.install(env, { command, folder: path.dirname(menubar.installed(env)) });
  out(`(Updated the hooks from Peras ${staleClaude ? claude : codex} to ${VERSION} first. Restart open sessions to pick them up.)`);
}

export async function main(args, { env = process.env, out = console.log, now = Date.now(), codexReader, quitMenubar, openMenubar, openSettingsURL, sendNotification = testNotification, isTTY = process.stdout.isTTY } = {}) {
  const [command, ...rest] = args;
  if ((WRITES.has(command) || (command === "codex" && ["set", "budget", "pace", "profile", "extra", "pause", "resume"].includes(rest[0]))) && !(command === "menubar" && (!rest[0] || ["show", "quit", "open"].includes(rest[0])))) {
    try {
      refreshStaleHooks(env, out);
    } catch (error) {
      out(`✗ The hooks run an older Peras and could not be updated (${error.message}). Run \`peras setup\` first.`);
      return 1;
    }
  }
  try {
    switch (command) {
      case "update": {
        if (rest.length > 1 || (rest[0] && rest[0] !== "--check")) throw new Error("Use peras update or peras update --check");
        const { updateCLI } = await import("./update.mjs");
        await updateCLI({ env, version: VERSION, root: ROOT, check: rest[0] === "--check", out });
        return 0;
      }
      case "events": {
        const { recentEvents } = await import("./events.mjs");
        const rows = recentEvents(env);
        out(rows.length ? rows.map(row => `${eventTime(row.at, now)} · ${row.provider} · ${row.kind}: ${row.message}`).join("\n") : "No recent events yet.");
        return 0;
      }
      case "codex": {
        const [sub = "status", ...words] = rest;
        const scoped = codexEnv(env);
        if (sub === "setup" || sub === "install") {
          const bin = copyRuntime(env);
          const result = installCodex(env, `"${nodePath(env)}" "${bin}"`);
          out(`Peras 🍐 Codex hooks ${result.changed ? "installed" : "already installed"} in ${tilde(result.target, env)}.`);
          out("Open /hooks in Codex CLI to review and trust them. Restart open sessions to load them.");
          return 0;
        }
        if (sub === "remove" || sub === "uninstall") {
          const result = removeCodex(env);
          out(result.changed ? `Removed Peras's Codex hooks from ${tilde(result.target, env)}.` : "No Peras Codex hooks found.");
          return 0;
        }
        if (sub === "status" || sub === "why") {
          const s = await snapshot(env, now, { provider: "codex", refresh: true, reader: codexReader });
          if (sub === "why") out(whyText(s, now));
          else panel(env, out, now, s);
          return s.error ? 1 : 0;
        }
        if (sub === "statusline") {
          if (words.length) throw new Error("Use peras codex statusline");
          const s = await snapshot(env, now, { provider: "codex", refresh: true, reader: codexReader });
          out(terminalStatusline(s, env));
          return s.error ? 1 : 0;
        }
        if (sub === "doctor") {
          const result = await codexDoctor(env, now, { reader: codexReader, version: VERSION });
          out(result.text);
          return result.code;
        }
        if (sub === "pause") return doPause(scoped, out, now, words, "Codex");
        if (sub === "resume") return doResume(scoped, out, now, words);
        if (sub === "set") return set(scoped, out, words);
        if (sub === "history") return history(scoped, out, now);
        if (sub === "pace") return pacingCommand(scoped,out,words);
        if (sub === "profile") return profileCommand(scoped,out,now,words);
        if (sub === "extra") return extraCommand(scoped,out,now,words);
        if (sub === "sessions") { out(sessionsText(sessionOverview([await snapshot(env,now,{provider:"codex"})],now),now)); return 0; }
        if (sub === "compare") { out(comparisonText(reviewFor(scoped,now))); return 0; }
        if (sub === "budget") return budget(scoped, out, now, words);
        if (sub === "review") { out(reviewText(reviewFor(scoped, now))); return 0; }
        throw new Error(`Unknown Codex command "${sub}".`);
      }
      case "setup":
      case "install":
        return setup(env, out);
      case "remove":
      case "uninstall":
        return remove(env, out);
      case "status":
      case undefined:
        return await combinedStatus(env, out, now, codexReader);
      case "why":
        for (const s of await providerSnapshots(env, now, codexReader)) out(whyText(s, now));
        return 0;
      case "resume":
        return doResume(env, out, now, rest);
      case "pause":
        return doPause(env, out, now, rest);
      case "set":
        return set(env, out, rest);
      case "pace": return pacingCommand(env,out,rest);
      case "profile": return profileCommand(env,out,now,rest);
      case "extra": return extraCommand(env,out,now,rest);
      case "sessions": { out(sessionsText(sessionOverview(await Promise.all([snapshot(env,now),snapshot(env,now,{provider:"codex"})]),now),now)); return 0; }
      case "compare": out(comparisonText(reviewFor(env,now))); return 0;
      case "settings": {
        if (rest.length) throw new Error("Use peras settings");
        const { openSettings } = await import("./settings-server.mjs");
        await openSettings(env, { openURL: openSettingsURL });
        out("Opened Rules and allowances on this computer. The editor closes after 30 idle minutes.");
        return 0;
      }
      case "budget":
        return budget(env, out, now, rest);
      case "review":
        if (rest.length) throw new Error("Use peras review or peras codex review");
        out(reviewText(reviewFor(env, now))); return 0;
      case "history":
        return history(env, out, now);
      case "menubar":
        return await doMenubar(env, out, now, rest, codexReader, { quitMenubar, openMenubar, isTTY });
      case "doctor":
        return doctor(env, out, now);
      case "notify":
        return await notifySettings(env, out, rest, sendNotification);
      case "test":
        if (rest.length) throw new Error("Use peras test");
        return await protectionTest(env, out, now, codexReader);
      case "connect":
        return connect(out);
      case "--version":
      case "-v":
      case "version":
        out(VERSION);
        return 0;
      case "help":
      case "--help":
      case "-h":
        out(HELP);
        return 0;
      default:
        out(`Unknown command "${command}".\n\n${HELP}`);
        return 1;
    }
  } catch (error) {
    out(`✗ ${error.message}`);
    return 1;
  }
}
