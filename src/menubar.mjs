import { profileSummary } from "./planning.mjs";
import { alternativeHint } from "./alternative.mjs";
import { budgetText } from "./allowances.mjs";
import { unusedReminder } from "./unused-reminders.mjs";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { statusPageURL } from "./status-page.mjs";
import { preferences, countdown } from "./preferences.mjs";
import { spawnSync } from "node:child_process";
import { WINDOWS, resetTime } from "./window.mjs";
import { etaTo } from "./forecast.mjs";
import { toneFor } from "./look.mjs";
import { describe } from "./hook.mjs";
import { progressImage, titleImage, providerLabelImage } from "./menubar-image.mjs";
import { perasHome, readJson, writeJsonAtomic } from "./store.mjs";

// 🍐 in the macOS menu bar through SwiftBar (free, MIT: brew install --cask swiftbar).
// SwiftBar runs a script from its plugins folder every minute and shows what it
// prints. The script is written with the same node and runtime as the hooks, and
// with the env Peras was set up under, since SwiftBar starts with a bare PATH.

// A new identity makes SwiftBar discard the cached Executable plugin when
// upgrading from the old once-a-minute renderer to a Streamable renderer.
function rendererRevision() {
  const revision = createHash("sha256");
  for (const name of ["../package.json", "menubar.mjs", "menubar-image.mjs", "menubar-atlas.json", "menubar-stream.mjs", "mascots.mjs", "mascot-atlas.json", "status-page.mjs", "preferences.mjs", "hook-health.mjs", "reset-notifications.mjs", "protection-test.mjs", "events.mjs", "unused-reminders.mjs", "notify.mjs", "notification-worker.mjs", "notification-native.mjs", "notification-native.json", "notification-icon.json", "allowances.mjs", "allowance-rules.mjs", "alternative.mjs", "review.mjs", "settings-server.mjs", "settings-page.mjs", "planning.mjs", "calendar.mjs", "sessions.mjs", "notification-actions.mjs"]) {
    revision.update(fs.readFileSync(new URL(name, import.meta.url)));
  }
  return revision.digest("hex").slice(0, 16);
}
const recordFile = (env) => path.join(perasHome(env), "menubar.json");
const TONE = { red: "#E5484D", yellow: "#F5A524", green: "#30A46C" };
const shQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const explainLimits = () => `Explain limits… | href=${JSON.stringify(new URL("./limits.html", import.meta.url).href)}`;

function readRecord(env) {
  try {
    const record = readJson(recordFile(env));
    return record && typeof record === "object" && !Array.isArray(record) ? record : {};
  } catch { return {}; }
}

export const displayMode = (env) => readRecord(env).display === "pear" ? "pear" : "usage";

export function setDisplayMode(env, display) {
  if (display !== "pear" && display !== "usage") throw new Error("Choose pear or usage: peras menubar display pear|usage");
  writeJsonAtomic(recordFile(env), { ...readRecord(env), display });
  return display;
}

function swiftbarFolder(env) {
  if (env.PERAS_SWIFTBAR_DIR) return env.PERAS_SWIFTBAR_DIR;
  if (process.platform !== "darwin") return null;
  const r = spawnSync("defaults", ["read", "com.ameba.SwiftBar", "PluginDirectory"], { encoding: "utf8" });
  const dir = r.status === 0 ? r.stdout.trim().replace(/^~(?=\/|$)/, env.HOME ?? "") : "";
  return dir || null;
}

export function installed(env) {
  try {
    const file = readJson(recordFile(env))?.file;
    return file && fs.existsSync(file) ? file : null;
  } catch {
    return null;
  }
}

export function script({ command, env }) {
  const exports = ["PERAS_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "PATH"].filter((k) => env[k]).map((k) => `export ${k}=${shQuote(env[k])}`);
  return `#!/bin/sh
# Peras 🍐 for SwiftBar. Written by \`peras menubar install\`; \`peras menubar remove\` takes it out.
# <swiftbar.hideAbout>true</swiftbar.hideAbout>
# <swiftbar.hideRunInTerminal>true</swiftbar.hideRunInTerminal>
# <swiftbar.hideDisablePlugin>true</swiftbar.hideDisablePlugin>
# <swiftbar.hideSwiftBar>true</swiftbar.hideSwiftBar>
# <swiftbar.type>streamable</swiftbar.type>
# <swiftbar.useTrailingStreamSeparator>true</swiftbar.useTrailingStreamSeparator>
# Renderer revision: ${rendererRevision()}
${exports.join("\n")}${exports.length ? "\n" : ""}if [ $# -eq 0 ]; then
  if [ "${"$"}{SWIFTBAR:-}" = "1" ]; then exec ${command} menubar stream; else set -- menubar show; fi
fi
${command} "$@" || { echo "🍐 ?"; echo "---"; echo "Peras could not run: open a terminal and run peras doctor"; }
`;
}

export function install(env, { command, folder }) {
  const dir = folder || swiftbarFolder(env);
  if (!dir) {
    throw new Error("SwiftBar's plugin folder was not found. Install SwiftBar (free): brew install --cask swiftbar, open it once and pick a plugins folder, then run this again (or: peras menubar install <folder>).");
  }
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `peras-${rendererRevision()}.1m.sh`);
  fs.writeFileSync(file, script({ command, env }), { mode: 0o755 });
  fs.chmodSync(file, 0o755);
  const previous = installed(env);
  writeJsonAtomic(recordFile(env), { ...readRecord(env), file });
  if (previous && previous !== file && /^peras(?:-(?:live|stream|[a-f0-9]{16}))?\.1m\.sh$/.test(path.basename(previous))) {
    fs.rmSync(previous, { force: true });
  }
  return file;
}

/** Whether SwiftBar is up to draw the menu; null where there's no SwiftBar to ask about. */
export function swiftBarRunning() {
  if (process.platform !== "darwin") return null;
  return spawnSync("pgrep", ["-x", "SwiftBar"], { timeout: 5000 }).status === 0;
}

/** Launch SwiftBar, which draws the menu. Throws when it isn't installed. */
export function open() {
  if (process.platform !== "darwin") throw new Error("The menu bar needs macOS and SwiftBar.");
  const opened = spawnSync("open", ["-a", "SwiftBar"], { timeout: 10_000, encoding: "utf8" });
  if (opened.status !== 0) throw new Error((opened.stderr || "SwiftBar did not open").trim());
}

/** Quit SwiftBar, the app that draws the menu. The hooks don't need it, so protection keeps running. */
export function quit() {
  const quit = spawnSync("osascript", ["-e", 'if application "SwiftBar" is running then tell application "SwiftBar" to quit'], { timeout: 5000 });
  if (quit.status !== 0) spawnSync("pkill", ["-x", "SwiftBar"], { timeout: 5000 });
}

/** Quit takes every SwiftBar plugin with it, so with others in the folder the item says so. */
function sharesSwiftBar(self) {
  try {
    return fs.readdirSync(path.dirname(self), { withFileTypes: true }).some((f) => f.isFile() && !f.name.startsWith(".") && f.name !== path.basename(self) && (fs.statSync(path.join(path.dirname(self), f.name)).mode & 0o111));
  } catch {
    return false;
  }
}

export function remove(env) {
  const file = installed(env);
  if (file) fs.rmSync(file, { force: true });
  fs.rmSync(recordFile(env), { force: true });
  return file;
}

/** SwiftBar's text: the title line, then `---` and the dropdown. */
export function render({ ctx, usage, env, now, verdict, product = "Claude Code", prefix = [], freshness }) {
  const self = env.SWIFTBAR_PLUGIN_PATH || installed(env);
  const run = (args, label, extra = "") =>
    self ? `${label} | bash=${JSON.stringify(self)} ${[...prefix, ...args].map((a, i) => `param${i + 1}=${/^[\w.-]+$/.test(String(a)) ? a : JSON.stringify(String(a))}`).join(" ")} terminal=false refresh=true${extra}` : label;
  const live = ctx.window;
  const { action, hit, hits } = verdict;
  const week = live.seven_day;
  const lines = [];
  const titlePct = week ? `${Math.round(week.usedPct)}%` : live.five_hour ? `5h ${Math.round(live.five_hour.usedPct)}%` : "–";
  const titleTone = week ? toneFor("seven_day", week.usedPct, ctx.rules) : "green";
  lines.push(`🍐 ${action === "pause" ? "⏸️ " : action === "ask" ? "✋ " : ""}${titlePct}${titleTone === "green" ? "" : ` | color=${TONE[titleTone]}`}`);
  lines.push("---");
  if (freshness) lines.push(`${freshness} | size=12`);
  if (!Object.keys(live).length) lines.push(`No live usage window for ${product}`);
  for (const [name, { name: long }] of Object.entries(WINDOWS)) {
    const w = live[name];
    if (!w) continue;
    const pct = Math.round(w.usedPct);
    lines.push(`${long} ${pct}% · resets ${resetTime(w.resetsAt, now)} | color=${TONE[toneFor(name, pct, ctx.rules)]}`);
    const full = etaTo(ctx.forecast[name], 100);
    if (full) lines.push(`Full by ${resetTime(full / 1000, now)} | color=${TONE.red} size=12`);
  }
  if (action === "pause" || action === "ask") lines.push("---", `${action === "pause" ? "Paused" : "Asking"}: ${describe(hit, now).short} | color=${TONE.red}`);
  else if (action === "warn") lines.push("---", `${describe(hit, now).short} | color=${TONE.yellow}`);
  for (const project of new Set(hits.filter((h) => h.project).map((h) => h.project))) lines.push(`Folder: ${project} | size=12`);
  lines.push("---");
  if (action === "pause" || action === "ask" || ctx.manualPause) {
    lines.push(run(["resume"], "▶ Resume"));
    lines.push(run(["resume", "1h"], "▶ Resume for 1 hour"));
  } else {
    lines.push(run(["pause", "1h"], "Pause for 1 hour"));
    lines.push(run(["pause"], "Pause until resumed"));
  }
  lines.push("---", `Status… | href=${JSON.stringify(statusPageURL(env))}`);
  lines.push(explainLimits());
  return lines.join("\n");
}

export function renderCombined({ snapshots, env, now, animationTime = 0 }) {
  const prefs = preferences(env);
  const self = env.SWIFTBAR_PLUGIN_PATH || installed(env);
  const run = (args, label, terminal = false) => self
    ? `${label} | bash=${JSON.stringify(self)} ${args.map((a, i) => `param${i + 1}=${/^[\w.-]+$/.test(String(a)) ? a : JSON.stringify(String(a))}`).join(" ")} terminal=${terminal} refresh=true`
    : label;
  const readings = snapshots.map((s) => ({ provider: s.provider, pct: s.ctx.window.five_hour?.usedPct, stopped: s.verdict.action === "pause" || s.verdict.action === "ask" }));
  const mode = displayMode(env);
  const titleReadings = mode === "pear" ? [] : readings;
  const light = titleImage(titleReadings, { dark: false }), dark = titleImage(titleReadings);
  const tooltip = snapshots.map((s) => `${s.provider === "codex" ? "Codex" : "Claude"} 5-hour: ${Number.isFinite(s.ctx.window.five_hour?.usedPct) ? `${Math.round(s.ctx.window.five_hour.usedPct)}%` : "no reading"}${s.verdict.action === "none" ? "" : ` · ${s.verdict.action}`}`).join(" · ");
  const lines = [` | image=${light.png.toString("base64")},${dark.png.toString("base64")} width=${dark.width} height=${dark.height} tooltip=${JSON.stringify(tooltip)} dropdown=false`, "---"];
  for (const s of snapshots) {
    if (lines.length > 2) lines.push("---");
    const prefix = s.provider === "codex" ? ["codex"] : [];
    const paused = s.verdict.action === "pause" || s.verdict.action === "ask";
    const state = s.verdict.action === "pause" ? " · paused" : s.verdict.action === "ask" ? " · needs OK" : s.error ? " · offline" : "";
    const nameImage = providerLabelImage(s.provider);
    lines.push(`${state.trim()} | image=${nameImage.png.toString("base64")} width=${nameImage.width} height=${nameImage.height}`);
    const profiles = s.env ? profileSummary(s.env) : { names: [] };
    if (profiles.active) lines.push(`Profile: ${profiles.active}${profiles.modified ? " (modified)" : ""} | size=11`);
    if (profiles.names.length) {
      lines.push("Switch profile");
      // A leading "-" would read as another submenu level: show it as a non-breaking hyphen.
      for (const name of profiles.names) lines.push(run([...prefix, "profile", "use", name], `--${name.replace(/^-+/, (dashes) => "\u2011".repeat(dashes.length))}`));
    }
    if ((s.ctx.allowances || []).some(m => m.period === "daily")) lines.push(run([...prefix, "extra", "daily", "3", "1h"], "Extra 3 points for 1h"));
    if (s.health) lines.push(`${s.health.label} | size=11`);
    for (const [name, caption] of [["five_hour", "5h"], ["seven_day", "Week"]]) {
      if (name === "seven_day" && !prefs.weekly) continue;
      const w = s.ctx.window[name];
      if (w) {
        const pct = Math.round(w.usedPct);
        const tone = toneFor(name, w.usedPct, s.ctx.rules) === "red" ? "red" : s.provider;
        const mascot = prefs.mascots && name === "five_hour" ? { provider: s.provider, timeMs: animationTime, paused } : null;
        const light = progressImage(w.usedPct, { tone, dark: false, mascot }), dark = progressImage(w.usedPct, { tone, mascot });
        lines.push(`${caption.padEnd(4)} ${String(pct).padStart(3)}% · ${countdown(w.resetsAt, now)} (${resetTime(w.resetsAt, now)}) | image=${light.png.toString("base64")},${dark.png.toString("base64")} width=${dark.width} height=${dark.height} font=Menlo size=11 refresh=true`);
      } else lines.push(`${caption.padEnd(4)} – | font=Menlo size=11`);
    }
    for (const meter of s.ctx.allowances || []) lines.push(`${budgetText({ ...meter, ...(meter.project ? { project: path.basename(meter.project) || meter.project } : {}) }).replaceAll("|", "¦").replaceAll("\n", " ")} | size=11`);
    const hint = alternativeHint(s, snapshots, now, { compact: true });
    if (hint) lines.push(`${hint} | size=11`);
    const reminder = prefs.unused && unusedReminder(s, now);
    if (reminder) lines.push(`${reminder.menu} | size=11`);
    if (paused) {
      const manual = s.ctx.manualPause;
      const confirmation = manual ? (manual.until ? `Paused until ${resetTime(manual.until / 1000, now)} · ${countdown(manual.until / 1000, now)} left` : "Paused until you resume") : `${s.verdict.action === "pause" ? "Paused" : "Asking"}: ${describe(s.verdict.hit, now).short}`;
      lines.push(`${confirmation} | color=${TONE.red} size=12 refresh=true`);
    }
    if (paused || s.ctx.manualPause) {
      lines.push(run([...prefix, "resume"], "Resume"));
      lines.push(run([...prefix, "resume", "1h"], "Resume 1h"));
    } else {
      lines.push(run([...prefix, "pause", "1h"], "Pause 1h"));
      lines.push(run([...prefix, "pause"], "Pause"));
    }
  }
  lines.push("---", `Status… | href=${JSON.stringify(statusPageURL(env))}`, "Settings");
  lines.push(run(["settings"], "--Rules and allowances…"));
  lines.push(`--Session overview… | href=${JSON.stringify(`${statusPageURL(env)}#sessions`)}`);
  lines.push(`--Weekly comparison… | href=${JSON.stringify(`${statusPageURL(env)}#weekly-comparison`)}`);
  lines.push(`--Weekly review… | href=${JSON.stringify(`${statusPageURL(env)}#weekly-review`)}`);
  lines.push(`--${explainLimits()}`);
  lines.push(`${run(["menubar", "test"], "--Protection test…")} href=${JSON.stringify(statusPageURL(env))}`);
  lines.push(`--Recent events… | href=${JSON.stringify(`${statusPageURL(env)}#recent-events`)}`);
  lines.push("-----", "--Menu bar display");
  lines.push(`${run(["menubar", "display", "pear"], "----Pear only")}${self ? ` checked=${mode === "pear"}` : ""}`);
  lines.push(`${run(["menubar", "display", "usage"], "----Pear + icons and percentages")}${self ? ` checked=${mode === "usage"}` : ""}`);
  for (const [key, label] of [["mascots", "Show mascots"], ["weekly", "Show weekly bars"]]) {
    lines.push(`${run(["menubar", "preference", key, prefs[key] ? "off" : "on"], `----${label}`)}${self ? ` checked=${prefs[key]}` : ""}`);
  }
  lines.push("--Notifications");
  for (const [key, label] of [["warnings", "Warnings"], ["pauses", "Pauses and approval requests"], ["resets", "Usage resets"], ["unused", "Use it or lose it reminders"]]) {
    lines.push(`${run(["menubar", "preference", key, prefs[key] ? "off" : "on"], `----${label}`)}${self ? ` checked=${prefs[key]}` : ""}`);
  }
  if (self) lines.push("---", run(["menubar", "quit"], sharesSwiftBar(self) ? "Quit SwiftBar (all plugins)" : "Quit").replace(" refresh=true", ""));
  return lines.join("\n");
}
