import { localDay } from "./calendar.mjs";
export { localDay } from "./calendar.mjs";
import { pacingMeter, applyExtras } from "./planning.mjs";
import fs from "node:fs";
import path from "node:path";
import { perasHome, dirKey, readJson, writeJsonAtomic } from "./store.mjs";
import { realDir } from "./rules.mjs";

const ACTIVE_MS = 5 * 60_000;
const file = (env, name) => path.join(perasHome(env), name, `${dirKey(env)}.json`);
const round = n => Math.round(n * 1000) / 1000;
const inside = (dir, root) => dir === root || dir.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
export function normalizeBudget(raw) {
  if (!raw || !["daily", "weekly"].includes(raw.period) || !["warn", "ask", "pause"].includes(raw.action) || !Number.isFinite(raw.at) || raw.at <= 0 || raw.at > 100) throw new Error("An allowance needs daily or weekly, 0–100 points (above zero), and warn, ask or pause.");
  if (raw.period === "weekly" && (typeof raw.project !== "string" || !path.isAbsolute(raw.project))) throw new Error("A weekly project allowance needs an absolute folder path.");
  if (raw.period === "daily" && raw.project) throw new Error("Daily allowances apply to the whole provider account.");
  return { period: raw.period, at: raw.at, action: raw.action, ...(raw.project ? { project: realDir(raw.project) } : {}), ...(Number.isFinite(raw.createdAt) ? { createdAt: raw.createdAt } : {}) };
}
export const budgetId = r => `${r.period}|${r.action}|${r.project || ""}`;
export function readBudgetRules(env) {
  const saved = readJson(file(env, "budgets"));
  if (!saved) return [];
  if (!Array.isArray(saved)) throw new Error("Invalid allowance configuration. Run peras budget to inspect it.");
  return saved.map(normalizeBudget);
}
export function writeBudgetRules(env, rules) { writeJsonAtomic(file(env, "budgets"), rules.map(normalizeBudget)); }
export function setBudget(env, raw, now = Date.now(), remove = false) {
  const rule = normalizeBudget(raw), rules = readBudgetRules(env), old = rules.find(r => budgetId(r) === budgetId(rule));
  const next = rules.filter(r => budgetId(r) !== budgetId(rule));
  if (!remove) next.push({ ...rule, createdAt: old?.createdAt ?? now });
  writeBudgetRules(env, next);
  return next;
}
function savedState(env) {
  const raw = readJson(file(env, "allowances"));
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : { activity: {}, projects: {} };
}
function touchSession(env, session, dir, now) {
  if (!session || !dir || !readBudgetRules(env).some(r => r.project)) return;
  const state = savedState(env);
  state.activity = Object.fromEntries(Object.entries(state.activity || {}).filter(([, s]) => now - s.t <= ACTIVE_MS));
  state.activity[session] = { dir: realDir(dir), t: now };
  state.activity = Object.fromEntries(Object.entries(state.activity).slice(-100));
  writeJsonAtomic(file(env, "allowances"), state);
}

// Observed deltas, never a percentage inferred from tokens or model prices.
function observe(env, previous, reading, { now = Date.now(), session, dir } = {}) {
  const w = reading?.seven_day;
  if (!w || !Number.isFinite(w.usedPct) || !Number.isFinite(w.seenAt) || w.seenAt > now || w.resetsAt * 1000 <= now) return;
  const state = savedState(env), day = localDay(now), old = state.observed || previous?.seven_day;
  if (old && old.seenAt === w.seenAt && old.usedPct === w.usedPct && old.resetsAt === w.resetsAt) return;
  if (state.lastSeenAt > w.seenAt) return;
  const same = old && Math.abs(old.resetsAt - w.resetsAt) < 3600;
  if (same && w.usedPct < old.usedPct) return;
  const delta = same ? Math.max(0, w.usedPct - old.usedPct) : 0;
  const daily = state.daily?.key === day.key ? state.daily : { key: day.key, spent: 0, since: now, gaps: true };
  if (same && old.seenAt >= day.start && old.seenAt <= w.seenAt) daily.spent = round(daily.spent + delta);
  else if (!same && old && (w.resetsAt - 7 * 86400) * 1000 >= day.start) daily.spent = round(daily.spent + w.usedPct);
  if (old && now - old.seenAt > ACTIVE_MS) daily.gaps = true;
  state.daily = daily;
  state.projects ||= {};
  state.activity = Object.fromEntries(Object.entries(state.activity || {}).filter(([, s]) => now >= s.t && now - s.t <= ACTIVE_MS));
  if (session && dir) state.activity[session] = { dir: realDir(dir), t: now };
  state.activity = Object.fromEntries(Object.entries(state.activity).slice(-100));
  const projectRules = new Map();
  for (const rule of readBudgetRules(env).filter(r => r.project)) {
    if (!projectRules.has(rule.project) || (rule.createdAt ?? 0) < (projectRules.get(rule.project).createdAt ?? 0)) projectRules.set(rule.project, rule);
  }
  for (const rule of projectRules.values()) {
    let project = state.projects[rule.project];
    if (!project || Math.abs(project.resetsAt - w.resetsAt) >= 3600) project = { resetsAt: w.resetsAt, spent: 0, since: now, gaps: false };
    const active = Object.values(state.activity).some(s => inside(s.dir, rule.project));
    // One tally per folder, even when it has both warning and pause thresholds.
    if ((project.lastSeenAt !== w.seenAt || project.lastSeenPct !== w.usedPct) && active && old && old.seenAt >= (rule.createdAt ?? 0)) {
      if (same && now - old.seenAt <= ACTIVE_MS) project.spent = round(project.spent + delta);
      else project.gaps = true;
    }
    project.lastSeenAt = w.seenAt;
    project.lastSeenPct = w.usedPct;
    state.projects[rule.project] = project;
  }
  state.projects = Object.fromEntries(Object.entries(state.projects).filter(([, tally]) => tally.resetsAt * 1000 > now).slice(-200));
  state.lastSeenAt = w.seenAt;
  state.observed = w;
  writeJsonAtomic(file(env, "allowances"), state);
}

function withLock(env, fn, { attempts = 40 } = {}) {
  const lock = file(env, "allowance-locks");
  fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
  let fd;
  for (let i = 0; i < attempts; i++) {
    try { fd = fs.openSync(lock, "wx", 0o600); break; }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 10_000) fs.unlinkSync(lock); } catch { /* Already released. */ }
      if (i + 1 < attempts) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  if (fd === undefined) throw new Error("Allowance accounting is busy; retry shortly.");
  try { return fn(); } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}
export function observeAllowances(env, previous, reading, options) {
  if (!reading?.seven_day) return;
  return withLock(env, () => observe(env, previous, reading, options));
}
// Runs inside the hooks before enforcement: bookkeeping must never block or
// throw there, or a busy lock would fail the hook open and skip a pause.
export function touchAllowanceSession(env, session, dir, now) {
  try {
    if (!session || !dir || !readBudgetRules(env).some(r => r.project)) return;
    withLock(env, () => touchSession(env, session, dir, now), { attempts: 1 });
  } catch { /* The next hook or reading records the activity. */ }
}

export function allowanceMeters(env, now = Date.now(), window = {}) {
  const state = savedState(env), day = localDay(now), weekly = window.seven_day;
  const meters = readBudgetRules(env).map(rule => {
    const tally = rule.period === "daily" ? (state.daily?.key === day.key ? state.daily : null) : state.projects?.[rule.project];
    const valid = rule.period === "daily" || (weekly && tally && Math.abs(weekly.resetsAt - tally.resetsAt) < 3600);
    return { ...rule, spent: valid ? tally?.spent ?? 0 : 0, since: valid ? tally?.since ?? null : null, gaps: tally?.gaps ?? true, estimated: Boolean(rule.project), resetsAt: rule.period === "daily" ? day.end / 1000 : weekly?.resetsAt ?? null };
  });
  const pacing = pacingMeter(env, now, weekly, state.daily?.key === day.key ? state.daily : null);
  if (pacing) meters.push(pacing);
  return applyExtras(env, meters, now, weekly);
}
export function budgetText(m) {
  // A non-working day has no share to count against, unless an extra added some.
  if (m.kind === "pacing" && m.workday === false && !m.extra) return `Workday pace: not a working day in your plan, so agents get no share today · ${m.action}`;
  const label = m.kind === "pacing" ? `Workday pace (${m.workdays} workdays left, ${m.reserve}% reserved)` : m.project ? `Project ${m.project} (estimate)` : "Today";
  return `${label}: ${m.estimated ? "≈" : ""}${m.spent} / ${m.at} points${m.extra ? ` (+${m.extra} temporary)` : ""} · ${m.action}${m.since ? "" : " · waiting for a weekly reading"}`;
}
export function parseBudget(words, cwd = process.cwd()) {
  const args = [...words], here = args.includes("--here");
  const period = args.find(w => ["daily", "weekly"].includes(w));
  const action = args.find(w => ["warn", "ask", "pause"].includes(w)) || "pause";
  const value = args.find(w => /^(?:\d+(?:\.\d+)?%?|off)$/.test(w));
  if (args.some(w => !["--here", "daily", "weekly", "warn", "ask", "pause", value].includes(w)) || !period || value === undefined) throw new Error("Use peras budget daily 10 pause, or peras budget --here weekly 5 pause (off removes that allowance).");
  return { rule: normalizeBudget({ period, at: value === "off" ? 1 : Number(value.replace(/%$/, "")), action, ...(here ? { project: realDir(cwd) } : {}) }), remove: value === "off" };
}
