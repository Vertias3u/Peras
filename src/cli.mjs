import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WINDOWS, liveWindow, resetTime } from "./window.mjs";
import { DEFAULT_RULES, ACTIONS, evaluate, setRule, windowName } from "./rules.mjs";
import { claudeDir, perasHome, readInstall, readRules, readState, readWindow, resume, writeRules } from "./store.mjs";
import { install, uninstall, inspect, settingsPath } from "./settings.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
const PASSCONTROL = "https://passcontrol.vertias.eu";

const HELP = `Peras 🍐 ${VERSION}: stop Claude Code before it burns the rest of your limit.

  peras setup                 add the hooks + status line to Claude Code (with a backup)
  peras status                5h and weekly usage, your lines, paused or not
  peras resume                lift a pause for the rest of this window
  peras set weekly 85 pause   change a line: 5h|weekly, warn|ask|pause, 1-100|off
  peras set reset             back to the defaults
  peras doctor                check that everything is wired up
  peras remove                take out exactly what setup added
  peras connect               what PassControl adds on top

Watching: ${"$"}CLAUDE_CONFIG_DIR, or ~/.claude.`;

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

const ruleText = (r) => `${WINDOWS[r.window].name} ${r.at}% ${r.action}`;

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

function setup(env, out) {
  const bin = copyRuntime(env);
  const command = `"${nodePath(env)}" "${bin}"`;
  // The hint in a pause message must work as typed, however Peras was installed.
  const resumeHint = onPath("peras", env) ? "peras resume" : ROOT.includes(`${path.sep}_npx${path.sep}`) ? "npx peras resume" : `${command} resume`;
  const result = install({ env, command, resumeHint, version: VERSION });
  out(`Peras 🍐 is ${result.changed ? "set up" : "already set up"} in ${tilde(result.target, env)}`);
  if (result.backupPath && result.changed) out(`  backup of your settings: ${tilde(result.backupPath, env)}`);
  if (result.chained) out(`  your status line still shows; Peras runs in front of it: ${result.chained}`);
  if (result.hooksDisabled) out(`  ⚠ "disableAllHooks" is on in your settings, so Peras cannot pause anything until it is off.`);
  if (hasPassControl(env)) out("  PassControl's hooks are here too. Both run; the stricter answer wins.");
  out("");
  out(`Lines: ${readRules(env).map(ruleText).join(" · ")}`);
  out("The window shows up after Claude Code's next reply (Pro/Max logins only). Restart open sessions to pick up the hooks.");
  return 0;
}

function remove(env, out) {
  const result = uninstall({ env });
  if (!result.changed) out(`Nothing of Peras's in ${tilde(result.target, env)}.`);
  else out(`Peras is out of ${tilde(result.target, env)}.${result.restored ? ` Your status line is back: ${result.restored}` : ""}`);
  const others = fs.existsSync(path.join(perasHome(env), "install")) && fs.readdirSync(path.join(perasHome(env), "install")).length > 0;
  if (!others) fs.rmSync(path.join(perasHome(env), "app"), { recursive: true, force: true });
  out(`Your lines and history stay in ${tilde(perasHome(env), env)}; delete that folder to forget them too.`);
  return 0;
}

function status(env, out, now) {
  let stored = null;
  try {
    stored = readWindow(env);
  } catch (error) {
    out(`⚠ The saved window is unreadable (${error.message}). It is rewritten on Claude Code's next reply.`);
  }
  const live = liveWindow(stored, now);
  const rules = readRules(env);
  const resumed = readState(env, now).resumed;
  const { action, hit, hits } = evaluate(live, rules, { resumed });
  out(`Peras 🍐 watching ${tilde(claudeDir(env), env)}`);
  out("");
  if (!Object.keys(live).length) {
    out("  No usage window yet. It arrives after Claude Code's next reply, on a Pro/Max login.");
  } else {
    for (const [name, { label }] of Object.entries(WINDOWS)) {
      const w = live[name];
      if (!w) continue;
      out(`  ${label.padEnd(3)} ${String(Math.round(w.usedPct)).padStart(3)}%   resets ${resetTime(w.resetsAt, now)}   (seen ${ago(now - w.seenAt)})`);
    }
  }
  out("");
  if (action === "pause") out(`⏸ PAUSED: ${WINDOWS[hit.window].name} ${Math.round(hit.usedPct)}% is past your ${hit.at}% line. Run \`peras resume\` to go on.`);
  else if (action === "ask") out(`✋ Asking once per session: ${WINDOWS[hit.window].name} ${Math.round(hit.usedPct)}% is past your ${hit.at}% line.`);
  else if (action === "warn") out(`⚠ ${hits.map((h) => `${WINDOWS[h.window].name} past ${h.at}%`).join(", ")}.`);
  const lifted = resumed.filter((k) => live[k.split(":")[0]]);
  if (action !== "pause" && action !== "ask" && lifted.length) {
    const until = Math.min(...lifted.map((k) => Number(k.split("@")[1])));
    out(`▶ Resumed until ${resetTime(until, now)}. A higher line still stops it.`);
  } else if (action === "none" && Object.keys(live).length) out("✓ Under every line.");
  out(`Lines: ${rules.map(ruleText).join(" · ") || "none"}`);
  const wired = inspectSafe(env);
  if (!wired || !wired.events.length) out("Not set up yet: run `peras setup`.");
  return 0;
}

function inspectSafe(env) {
  try {
    return inspect(env);
  } catch {
    return null;
  }
}

function doResume(env, out, now) {
  const lifted = resume(env, now);
  if (!lifted.length) {
    out("Nothing is paused or asking right now.");
    return 0;
  }
  for (const h of lifted) out(`▶ Lifted: ${WINDOWS[h.window].name} ${Math.round(h.usedPct)}%, until it resets ${resetTime(h.resetsAt, now)}.`);
  return 0;
}

function set(env, out, args) {
  if (!args.length) {
    out(`Lines: ${readRules(env).map(ruleText).join(" · ") || "none"}`);
    return 0;
  }
  if (args[0] === "reset") {
    writeRules(env, DEFAULT_RULES);
    out(`Lines: ${DEFAULT_RULES.map(ruleText).join(" · ")}`);
    return 0;
  }
  let window = null;
  let action = null;
  let at;
  for (const word of args) {
    const w = String(word).replace(/%$/, "");
    if (windowName(w)) window = windowName(w);
    else if (ACTIONS.includes(w)) action = w;
    else if (w === "off") at = null;
    else if (/^\d+(\.\d+)?$/.test(w)) at = Number(w);
    else throw new Error(`Did not understand "${word}". Example: peras set weekly 85 pause`);
  }
  if (!window || !action || at === undefined) throw new Error("Say a window, an action and a line, e.g. peras set weekly 85 pause (or: peras set weekly pause off)");
  const rules = setRule(readRules(env), window, action, at);
  writeRules(env, rules);
  out(`Lines: ${rules.map(ruleText).join(" · ") || "none"}`);
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

export async function main(args, { env = process.env, out = console.log, now = Date.now() } = {}) {
  const [command, ...rest] = args;
  try {
    switch (command) {
      case "setup":
      case "install":
        return setup(env, out);
      case "remove":
      case "uninstall":
        return remove(env, out);
      case "status":
      case undefined:
        return status(env, out, now);
      case "resume":
        return doResume(env, out, now);
      case "set":
        return set(env, out, rest);
      case "doctor":
        return doctor(env, out, now);
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
