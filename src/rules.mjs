import { allowanceHits } from "./allowance-rules.mjs";
import fs from "node:fs";
import path from "node:path";
import { WINDOWS } from "./window.mjs";
import { etaTo } from "./forecast.mjs";

// A line is { kind, window, at, action, span?, during?, project?, off? }:
//   kind "window"  the window's used % reaches `at`
//   kind "pace"    from `at` % on, the forecast says the window hits 100% before it resets
//   kind "prompt"  one prompt's turn raised the window's % by `at` points or more
//   kind "rate"    the window rose `at` points within `span` minutes (default 10)
//   kind "agents"  more than `at` spawns per prompt, with no window
// `during` ("HH:MM-HH:MM", local time) limits a line to part of the day; `project`
// (a real path) limits it to a folder and below, overriding the same global line
// there, and `off` switches that global line off in the folder.

export const ACTIONS = ["warn", "ask", "pause"];
export const KINDS = ["window", "pace", "prompt", "rate", "agents"];
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
  { kind: "rate", window: "five_hour", at: 20, span: 10, action: "warn" },
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
  if (!KINDS.includes(kind) || (kind !== "agents" && !WINDOWS[raw.window]) || !ACTIONS.includes(raw.action)) return null;
  const at = raw.at ?? (kind === "pace" ? PACE_FLOOR : undefined);
  if (typeof at !== "number" || (kind === "agents" ? !Number.isSafeInteger(at) || at < 0 : !(at >= 0 && at <= 100))) return null;
  const rule = { kind, ...(kind === "agents" ? {} : { window: raw.window }), at, action: raw.action };
  if (kind === "rate") {
    const span = raw.span ?? 10;
    if (!Number.isInteger(span) || span < 1 || span > 300) return null;
    rule.span = span;
  }
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
const identity = (r) => [r.kind, r.window, r.action, r.during ?? "", r.project ?? "", ...(r.kind === "rate" ? [r.span ?? 10] : [])].join("|");
const overrideId = (r) => [r.kind, r.window, r.action, r.during ?? "", ...(r.kind === "rate" ? [r.span ?? 10] : [])].join("|");

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
export function ruleId(r) {
  const base = r.kind === "agents" ? `agents:${r.at}:${r.action}` : r.kind === "window" ? `${r.window}:${r.at}:${r.action}` : `${r.kind}:${r.window}:${r.at}:${r.action}`;
  return `${base}${r.kind === "rate" ? `/${r.span ?? 10}m` : ""}${r.during ? `:${r.during}` : ""}${r.project ? `:p${hashPath(r.project)}` : ""}`;
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

// The latest resume of any rate line on this window instance.
const resumeMark = (latch, name, resetsAt) => Object.entries(latch)
  .filter(([key, v]) => v?.byResume && key.startsWith(`rate:${name}:`) && key.endsWith(`@${resetsAt}`))
  .map(([, v]) => v).sort((a, b) => b.releasedAt - a.releasedAt)[0];

const resumedNow = (resumed, key, now) => resumed.some((r) => r && r.key === key && (r.until == null || r.until > now));
// Parallel hooks can latch one burst under two times: resuming the later lets go of the earlier too.
const burstResumed = (resumed, baseKey, firedAt, now) => resumed.some((r) => r && typeof r.key === "string" && r.key.startsWith(`${baseKey}#`)
  && Number(r.key.slice(baseKey.length + 1)) >= firedAt && (r.until == null || r.until > now));

// Release cuts off the old burst, even when the history still contains it.
function rateRise(rule, w, points, now, releasedAt, releasedPct) {
  const cutoff = Math.max(now - rule.span * 60_000, releasedAt ?? -Infinity);
  const pts = points.filter(([t, pct]) => Number.isFinite(t) && Number.isFinite(pct) && t <= now && (releasedAt == null || t >= releasedAt));
  if (pts.some(([t], i) => i > 0 && t < pts[i - 1][0])) pts.sort((a, b) => a[0] - b[0]);
  if (Number.isFinite(releasedAt) && Number.isFinite(releasedPct) && releasedAt <= now) {
    if (pts[0]?.[0] === releasedAt) pts.shift();
    pts.unshift([releasedAt, releasedPct]);
  }
  let base = pts.findLast(([t]) => t <= cutoff);
  // A stale sample cannot establish a rise inside this span; allow 5s of sampling slack.
  if (base && base[0] < cutoff - 5000) base = null;
  const start = w.resetsAt * 1000 - (rule.window === "five_hour" ? 5 : 7 * 24) * 3600_000;
  if (!base && releasedAt == null && start >= cutoff && start <= now) base = [start, 0];
  if (!base) base = pts.find(([t]) => t > cutoff);
  return base ? { rise: w.usedPct - base[1], since: base[0] } : null;
}

/**
 * When a burst empties the window at its own rate (`rise` points between `since` and `at`),
 * or null when it doesn't rise, the window is full already, or it resets first.
 */
export function emptyAt(w, rise, since, at, now) {
  if (!w || !Number.isFinite(w.usedPct) || w.usedPct >= 100 || !(rise > 0) || !Number.isFinite(since) || !Number.isFinite(at)) return null;
  const perMs = rise / Math.max(60_000, at - since);
  const t = Math.round(now + (100 - w.usedPct) / perMs);
  return Number.isFinite(w.resetsAt) && now < t && t < w.resetsAt * 1000 ? t : null;
}

/**
 * The window's rise over `span` minutes as a burn line would measure it now, and the
 * points it may use: none from before a resume, which let that burst go.
 */
export function windowBurn(name, w, points, now, span = 10, rateLatch = {}) {
  const mark = resumeMark(rateLatch ?? {}, name, w.resetsAt);
  const cut = mark?.releasedAt;
  const since = Number.isFinite(cut) ? cut : null;
  return { burst: rateRise({ window: name, span }, w, points ?? [], now, since, mark?.releasedPct), points: (points ?? []).filter(([t]) => since == null || t >= since) };
}

/** The last two points rose at least 3 points a minute, within the last three minutes. */
export function fastRise(points, now) {
  const [a, b] = points?.slice(-2) ?? [];
  if (!a || !b || ![...a, ...b].every(Number.isFinite)) return false;
  const dt = b[0] - a[0];
  return a[0] >= now - 180_000 && b[0] <= now && dt > 0 && (b[1] - a[1]) * 60_000 / dt >= 3;
}

/**
 * What the live window calls for. Every line crossed is a hit; the strongest action
 * wins. A hit's `key` names that line in this window instance (and, for a prompt
 * line, that prompt), so a resume, a notification or an ask never carries over.
 *
 * @param {{ window: object, rules: object[], now?: number, cwd?: string, resumed?: {key: string, until?: number}[],
 *           forecast?: object, latched?: string[], history?: object, rateLatch?: object,
 *           prompt?: object, manualPause?: {until: number|null} }} ctx
 */
export function evaluate({ window, rules, now = Date.now(), cwd = null, resumed = [], forecast = {}, latched = [], prompt = null, manualPause = null, allowances = [], history = {}, rateLatch = {}, spawn = null }) {
  const hits = [];
  const released = [];
  // Drop old window instances, keeping latches for other folders and schedules.
  const nextLatch = Object.fromEntries(Object.entries(rateLatch).filter(([key]) =>
    Object.entries(window ?? {}).some(([name, w]) => key.startsWith(`rate:${name}:`) && key.endsWith(`@${w.resetsAt}`))));
  // Release resumed bursts first, so every rate line on the window sees the resume.
  for (const [baseKey, latch] of Object.entries(nextLatch)) {
    if (latch?.firedAt == null || !burstResumed(resumed, baseKey, latch.firedAt, now)) continue;
    const name = baseKey.split(":")[1];
    nextLatch[baseKey] = { releasedAt: now, byResume: true, releasedPct: window?.[name]?.usedPct };
    released.push(baseKey);
  }
  const applied = effectiveRules(normalizeRules(rules), cwd ? realDir(cwd) : null);
  for (const rule of applied) {
    if (rule.during && !duringActive(rule.during, now)) continue;
    if (rule.kind === "agents") {
      if (!spawn?.isSpawn || spawn.before < rule.at) continue;
      const id = spawn.prompt ?? prompt?.id ?? "session";
      // A headless run has no prompt id; its stop is named by when the session started, so a resume keeps.
      const tag = String(spawn.session ?? "").replace(/[^A-Za-z0-9]/g, "").slice(-8);
      const key = `${ruleId(rule)}@${id === "session" ? `${Math.round(spawn.sessionStart ?? now).toString(36)}.${tag}` : id}`;
      if (!resumedNow(resumed, key, now)) hits.push({ ...rule, before: spawn.before, key });
      continue;
    }
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
    } else if (rule.kind === "rate") {
      const baseKey = key;
      const latch = nextLatch[baseKey];
      // A resume lets the whole burst go, so no rate line on that window counts it again.
      const mark = resumeMark(nextLatch, rule.window, w.resetsAt);
      const cut = Math.max(latch?.releasedAt ?? -Infinity, mark?.releasedAt ?? -Infinity);
      const burst = rateRise(rule, w, history[rule.window] ?? [], now, Number.isFinite(cut) ? cut : null, cut === mark?.releasedAt ? mark.releasedPct : null);
      const firedAt = latch?.firedAt ?? now;
      key = `${baseKey}#${firedAt}`;
      // A warning can't be resumed, so it lasts as long as the burst, not until the reset.
      if (latch?.firedAt != null && rule.action === "warn" && (!burst || burst.rise < rule.at)) {
        nextLatch[baseKey] = { releasedAt: now };
        released.push(baseKey);
        continue;
      }
      if (latch?.firedAt == null && (!burst || burst.rise < rule.at)) continue;
      const measured = latch?.firedAt != null ? { rise: latch.rise ?? burst?.rise ?? rule.at, since: latch.since ?? firedAt } : burst;
      Object.assign(hit, measured, { emptyAtMs: emptyAt(w, measured.rise, measured.since, firedAt, now) });
      nextLatch[baseKey] = { ...latch, firedAt, ...measured };
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
    // A warning still holds new fan-outs; the rest of the turn may continue.
    // One hold per window, whichever burn line found the burst first.
    if (rule.kind === "rate" && spawn?.isSpawn && !hits.some((h) => h.kind === "spawnhold" && h.window === rule.window)) {
      const holdKey = `spawnhold:${key}`;
      if (!resumedNow(resumed, holdKey, now)) hits.push({ ...hit, kind: "spawnhold", action: "pause", key: holdKey });
    }
  }
  if (manualPause && (manualPause.until == null || manualPause.until > now)) {
    const since = manualPause.since ?? 0;
    const ends = Math.floor((manualPause.until ?? since + 7 * 24 * 3600_000) / 1000);
    hits.push({ kind: "manual", action: "pause", until: manualPause.until ?? null, key: `manual:${since}@${ends}` });
  }
  hits.push(...allowanceHits(allowances, cwd ? realDir(cwd) : null, resumed, now));
  // At the same action, a stop for the whole agent outranks one that only refuses new subagents.
  const spawnOnly = (h) => Number(h.kind === "agents" || h.kind === "spawnhold");
  hits.sort((a, b) => RANK[b.action] - RANK[a.action] || spawnOnly(a) - spawnOnly(b) || (b.at ?? 0) - (a.at ?? 0));
  return { action: hits[0]?.action ?? "none", hit: hits[0] ?? null, hits, rules: applied, released, rateLatch: nextLatch };
}

/**
 * `peras set` words, in any order: a window (5h / weekly), an action, a number or
 * "off", optionally "pace", "prompt" or "rate" (N/Mm), a time range "HH:MM-HH:MM", and "--here".
 */
export function parseSet(words, { cwd = process.cwd(), realpath } = {}) {
  let kind = "window";
  let window = null;
  let action = null;
  let at;
  let during;
  let span;
  let here = false;
  let reset = false;
  for (const word of words) {
    const w = String(word).toLowerCase().replace(/%$/, "");
    if (w === "--here" || w === "here") here = true;
    else if (w === "reset") reset = true;
    else if (w === "pace" || w === "prompt" || w === "rate" || w === "agents") kind = w;
    else if (windowName(w)) window = windowName(w);
    else if (ACTIONS.includes(w)) action = w;
    else if (w === "off") at = null;
    else if (/^\d+(\.\d+)?$/.test(w)) at = Number(w);
    else if (/^\d+(\.\d+)?\/\d+m$/.test(w)) {
      const parts = w.slice(0, -1).split("/").map(Number);
      [at, span] = parts;
    } else if (RANGE.test(w)) during = w;
    else throw new Error(`Did not understand "${word}". Example: peras set weekly 85 pause`);
  }
  const project = here ? realDir(cwd, realpath) : null;
  if (reset) return { op: "reset", project };
  if (kind === "prompt" && !window) window = "seven_day";
  if (kind === "pace" && at === undefined) at = PACE_FLOOR;
  if ((kind !== "agents" && !window) || !action || at === undefined) {
    throw new Error("Say a window, an action and a line, e.g. peras set weekly 85 pause (or: peras set weekly pause off)");
  }
  if (kind === "agents" && window) throw new Error("An agents line has no window.");
  if (kind === "agents" && at !== null && (!Number.isSafeInteger(at) || at < 0)) throw new Error("An agents line needs a whole number of subagents, zero or more.");
  if (kind !== "agents" && at !== null && !(at > 0 && at <= 100)) throw new Error("A line is a percentage from 1 to 100.");
  const rule = { kind, ...(kind === "agents" ? {} : { window }), action };
  if (span !== undefined && kind !== "rate") throw new Error("A span needs a rate line.");
  if (kind === "rate") {
    rule.span = span ?? 10;
    if (!Number.isInteger(rule.span) || rule.span < 1 || rule.span > 300) throw new Error("A rate span is 1 to 300 whole minutes.");
  }
  if (during) rule.during = during;
  if (project) rule.project = project;
  return { op: "set", rule, at };
}
