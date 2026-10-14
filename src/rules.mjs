import fs from "node:fs";
import path from "node:path";
import { WINDOWS } from "./window.mjs";
import { etaTo } from "./forecast.mjs";

// A line is { kind, window, at, action, during?, project?, off? }:
//   kind "window"  the window's used % reaches `at`
//   kind "pace"    from `at` % on, the forecast says the window hits 100% before it resets
//   kind "prompt"  one prompt's turn raised the window's % by `at` points or more
// `during` ("HH:MM-HH:MM", local time) limits a line to part of the day; `project`
// (a real path) limits it to a folder and below, overriding the same global line
// there, and `off` switches that global line off in the folder.

export const ACTIONS = ["warn", "ask", "pause"];
export const KINDS = ["window", "pace", "prompt"];
const RANK = { none: 0, warn: 1, ask: 2, pause: 3 };
const PACE_FLOOR = 50;
// A pace line that fired holds until the forecast drops under this, so it never flaps.
const PACE_RELEASE = 90;

// D1 (2026-10-14) plus, in 0.2, a heads-up when this week's pace runs out before the reset.
export const DEFAULT_RULES = [
  { kind: "window", window: "seven_day", at: 75, action: "warn" },
  { kind: "window", window: "seven_day", at: 90, action: "pause" },
  { kind: "window", window: "five_hour", at: 95, action: "warn" },
  { kind: "pace", window: "seven_day", at: PACE_FLOOR, action: "warn" },
];

const ALIASES = { "5h": "five_hour", "5-hour": "five_hour", five_hour: "five_hour", weekly: "seven_day", "7d": "seven_day", week: "seven_day", seven_day: "seven_day" };
export const windowName = (word) => ALIASES[String(word).toLowerCase()] ?? null;

const RANGE = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/;
const minutes = (hh, mm) => Number(hh) * 60 + Number(mm);

/** Whether `now` (local time) falls inside "HH:MM-HH:MM"; a range may cross midnight. */
export function duringActive(during, now) {
  const m = RANGE.exec(during ?? "");
  if (!m) return false;
  const start = minutes(m[1], m[2]);
  const end = minutes(m[3], m[4]);
  const d = new Date(now);
  const at = d.getHours() * 60 + d.getMinutes();
  return start <= end ? at >= start && at < end : at >= start || at < end;
}

function normalizeRule(raw) {
  if (!raw || typeof raw !== "object") return null;
  const kind = raw.kind ?? "window";
  if (!KINDS.includes(kind) || !WINDOWS[raw.window] || !ACTIONS.includes(raw.action)) return null;
  const at = raw.at ?? (kind === "pace" ? PACE_FLOOR : undefined);
  if (typeof at !== "number" || !(at >= 0 && at <= 100)) return null;
  const rule = { kind, window: raw.window, at, action: raw.action };
  if (raw.during !== undefined) {
    if (!RANGE.test(raw.during)) return null;
    rule.during = raw.during;
  }
  if (raw.project !== undefined) {
    if (typeof raw.project !== "string" || !path.isAbsolute(raw.project)) return null;
    rule.project = raw.project;
  }
  if (raw.off === true && rule.project) rule.off = true;
  return rule;
}

/** The valid lines, 0.1 lines (no `kind`) read as window lines. */
export function normalizeRules(rules) {
  if (!Array.isArray(rules)) return DEFAULT_RULES;
  return rules.map(normalizeRule).filter(Boolean);
}

// Which line a rule is, regardless of its number.
const identity = (r) => [r.kind, r.window, r.action, r.during ?? "", r.project ?? ""].join("|");
const overrideId = (r) => [r.kind, r.window, r.action, r.during ?? ""].join("|");

/** One line per kind, window, action, time range and folder: `at` sets it, null removes it (or, in a folder, switches it off there). */
export function setRule(rules, rule, at) {
  const rest = rules.filter((r) => identity(r) !== identity(rule));
  if (at === null) return rule.project ? [...rest, { ...rule, at: 0, off: true }] : rest;
  return [...rest, { ...rule, at }];
}

function hashPath(p) {
  let h = 5381;
  for (let i = 0; i < p.length; i++) h = ((h << 5) + h + p.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

// The key a resume, a notification or an ask is remembered under. A window line in
// all-day, global form keeps 0.1's key, so an upgrade does not repeat a notification.
function ruleId(r) {
  const base = r.kind === "window" ? `${r.window}:${r.at}:${r.action}` : `${r.kind}:${r.window}:${r.at}:${r.action}`;
  return `${base}${r.during ? `:${r.during}` : ""}${r.project ? `:p${hashPath(r.project)}` : ""}`;
}

const inside = (dir, project) => dir === project || dir.startsWith(project.endsWith(path.sep) ? project : project + path.sep);

/** The lines that apply in `dir`: global ones, with the closest folder's overrides on top. */
export function effectiveRules(rules, dir) {
  const global = rules.filter((r) => !r.project);
  if (!dir) return global;
  const projects = [...new Set(rules.filter((r) => r.project && inside(dir, r.project)).map((r) => r.project))];
  if (!projects.length) return global;
  const closest = projects.sort((a, b) => b.length - a.length)[0];
  const local = rules.filter((r) => r.project === closest);
  const replaced = new Set(local.map(overrideId));
  return [...global.filter((r) => !replaced.has(overrideId(r))), ...local.filter((r) => !r.off)];
}

/** A folder as the rules store it: its real path when it exists. */
export function realDir(dir, realpath = fs.realpathSync) {
  if (!dir) return null;
  try {
    return realpath(dir);
  } catch {
    return path.resolve(dir);
  }
}

const resumedNow = (resumed, key, now) => resumed.some((r) => r && r.key === key && (r.until == null || r.until > now));

/**
 * What the live window calls for. Every line crossed is a hit; the strongest action
 * wins. A hit's `key` names that line in this window instance (and, for a prompt
 * line, that prompt), so a resume, a notification or an ask never carries over.
 *
 * @param {{ window: object, rules: object[], now?: number, cwd?: string, resumed?: {key: string, until?: number}[],
 *           forecast?: object, latched?: string[], prompt?: object, manualPause?: {until: number|null} }} ctx
 */
export function evaluate({ window, rules, now = Date.now(), cwd = null, resumed = [], forecast = {}, latched = [], prompt = null, manualPause = null }) {
  const hits = [];
  const applied = effectiveRules(normalizeRules(rules), cwd ? realDir(cwd) : null);
  for (const rule of applied) {
    if (rule.during && !duringActive(rule.during, now)) continue;
    const w = window?.[rule.window];
    if (!w) continue;
    let key = `${ruleId(rule)}@${w.resetsAt}`;
    const hit = { ...rule, usedPct: w.usedPct, resetsAt: w.resetsAt };
    if (rule.kind === "window") {
      if (w.usedPct < rule.at) continue;
    } else if (rule.kind === "pace") {
      const projected = forecast?.[rule.window]?.projected;
      if (w.usedPct < rule.at || typeof projected !== "number") continue;
      if (projected < (latched.includes(key) ? PACE_RELEASE : 100)) continue;
      hit.projected = projected;
      // A % past 100 can never be reached; when usage runs out is what matters.
      hit.runsOutAt = etaTo(forecast[rule.window], 100);
    } else if (rule.kind === "prompt") {
      const base = prompt?.[rule.window];
      if (typeof base !== "number") continue;
      const rise = w.usedPct - base;
      if (rise < rule.at) continue;
      key = `${key}#${prompt.id}`;
      hit.rise = rise;
    }
    if (rule.action !== "warn" && resumedNow(resumed, key, now)) continue;
    hits.push({ ...hit, key });
  }
  if (manualPause && (manualPause.until == null || manualPause.until > now)) {
    const since = manualPause.since ?? 0;
    const ends = Math.floor((manualPause.until ?? since + 7 * 24 * 3600_000) / 1000);
    hits.push({ kind: "manual", action: "pause", until: manualPause.until ?? null, key: `manual:${since}@${ends}` });
  }
  hits.sort((a, b) => RANK[b.action] - RANK[a.action] || (b.at ?? 0) - (a.at ?? 0));
  return { action: hits[0]?.action ?? "none", hit: hits[0] ?? null, hits, rules: applied };
}

/**
 * `peras set` words, in any order: a window (5h / weekly), an action, a number or
 * "off", optionally "pace" or "prompt", a time range "HH:MM-HH:MM", and "--here".
 */
export function parseSet(words, { cwd = process.cwd(), realpath } = {}) {
  let kind = "window";
  let window = null;
  let action = null;
  let at;
  let during;
  let here = false;
  let reset = false;
  for (const word of words) {
    const w = String(word).toLowerCase().replace(/%$/, "");
    if (w === "--here" || w === "here") here = true;
    else if (w === "reset") reset = true;
    else if (w === "pace" || w === "prompt") kind = w;
    else if (windowName(w)) window = windowName(w);
    else if (ACTIONS.includes(w)) action = w;
    else if (w === "off") at = null;
    else if (/^\d+(\.\d+)?$/.test(w)) at = Number(w);
    else if (RANGE.test(w)) during = w;
    else throw new Error(`Did not understand "${word}". Example: peras set weekly 85 pause`);
  }
  const project = here ? realDir(cwd, realpath) : null;
  if (reset) return { op: "reset", project };
  if (kind === "prompt" && !window) window = "seven_day";
  if (kind === "pace" && at === undefined) at = PACE_FLOOR;
  if (!window || !action || at === undefined) {
    throw new Error("Say a window, an action and a line, e.g. peras set weekly 85 pause (or: peras set weekly pause off)");
  }
  if (at !== null && !(at > 0 && at <= 100)) throw new Error("A line is a percentage from 1 to 100.");
  const rule = { kind, window, action };
  if (during) rule.during = during;
  if (project) rule.project = project;
  return { op: "set", rule, at };
}
