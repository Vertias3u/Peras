import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { perasHome, dirKey, readJson, writeJsonAtomic, readRules, writeRules } from "./store.mjs";
import { normalizeRules, realDir } from "./rules.mjs";
import { readBudgetRules, writeBudgetRules } from "./allowances.mjs";
import { localDay } from "./calendar.mjs";
import { recordEvent } from "./events.mjs";

const file = (env) => path.join(perasHome(env), "planning", `${dirKey(env)}.json`);
const round = (n) => Math.floor((n + Number.EPSILON) * 100) / 100;
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function readPlanning(env) {
  const raw = readJson(file(env)) || {};
  return {
    ...raw,
    profiles: raw.profiles && typeof raw.profiles === "object" && !Array.isArray(raw.profiles) ? raw.profiles : {},
    extras: Array.isArray(raw.extras) ? raw.extras : [],
  };
}

/** Read-modify-write under a lock. `attempts: 1` gives up at once instead of waiting. */
function change(env, fn, { attempts = 40 } = {}) {
  const lock = `${file(env)}.lock`;
  fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
  let fd;
  for (let i = 0; i < attempts; i++) {
    try {
      fd = fs.openSync(lock, "wx", 0o600);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 10_000) fs.unlinkSync(lock); } catch { /* Already released. */ }
      if (i + 1 < attempts) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  if (fd === undefined) throw new Error("Planning settings are busy. Try again shortly.");
  try {
    const value = readPlanning(env);
    const result = fn(value);
    writeJsonAtomic(file(env), value);
    return result;
  } finally {
    fs.closeSync(fd);
    fs.unlinkSync(lock);
  }
}

export function normalizePacing(raw) {
  if (raw === null || raw === false) return null;
  if (!raw || !Number.isFinite(raw.reserve) || raw.reserve < 0 || raw.reserve >= 100 || !["warn", "ask", "pause"].includes(raw.action)
    || !Array.isArray(raw.days) || !raw.days.length || raw.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
    throw new Error("Pacing needs working days, a reserve from 0 to below 100%, and warn, ask or pause.");
  }
  return { days: [...new Set(raw.days)].sort(), reserve: raw.reserve, action: raw.action };
}

export function setPacing(env, raw) {
  const pacing = normalizePacing(raw);
  return change(env, (p) => { p.pacing = pacing; return pacing; });
}

export const dayNames = (days) => days.map((day) => DAY_NAMES[day]).join(", ");

export function workdaysLeft(now, resetsAt, days) {
  const end = resetsAt * 1000;
  const d = new Date(localDay(now).start);
  let count = 0;
  for (let i = 0; i < 8 && d.getTime() < end; i++) {
    if (days.includes(d.getDay())) count++;
    d.setDate(d.getDate() + 1);
  }
  return count;
}

/**
 * Today's pacing allowance. The share is fixed at the first fresh reading of the
 * day and saved, so working (or switching back to the same plan) cannot renew it.
 * This runs inside the hooks: if the planning lock is busy it uses the share
 * computed now without saving it, rather than throwing and failing the hook open.
 */
export function pacingMeter(env, now, weekly, daily) {
  const planning = readPlanning(env);
  if (!planning.pacing) return null;
  const pacing = normalizePacing(planning.pacing);
  const day = localDay(now);
  if (!weekly || weekly.resetsAt * 1000 <= now) return null;
  const signature = JSON.stringify({ days: pacing.days, reserve: pacing.reserve });
  const cacheKey = `${day.key}|${weekly.resetsAt}|${signature}`;
  const matches = (a) => a?.day === day.key && a.resetsAt === weekly.resetsAt && a.signature === signature;
  const workday = pacing.days.includes(new Date(now).getDay());
  let anchor = planning.anchors?.[cacheKey] || (matches(planning.anchor) ? planning.anchor : null);
  if (!anchor) {
    if (!Number.isFinite(weekly.seenAt) || weekly.seenAt > now || now - weekly.seenAt > 300_000) return null;
    const fresh = () => {
      const days = workdaysLeft(now, weekly.resetsAt, pacing.days);
      const share = workday && days ? Math.max(0, 100 - weekly.usedPct - pacing.reserve) / days : 0;
      return { day: day.key, resetsAt: weekly.resetsAt, signature, at: round((daily?.spent || 0) + share), share: round(share), days, since: now };
    };
    try {
      anchor = change(env, (p) => {
        if (p.anchors?.[cacheKey]) return p.anchors[cacheKey];
        if (matches(p.anchor)) return p.anchor;
        p.anchor = fresh();
        p.anchors = Object.fromEntries([...Object.entries(p.anchors || {}).filter(([, a]) => a.day === day.key), [cacheKey, p.anchor]].slice(-32));
        return p.anchor;
      }, { attempts: 1 });
    } catch {
      anchor = fresh();
    }
  }
  return {
    period: "daily", kind: "pacing", at: anchor.at, spent: daily?.spent || 0, since: anchor.since, resetsAt: day.end / 1000,
    action: pacing.action, workdays: anchor.days, reserve: pacing.reserve, share: anchor.share, workday, estimated: false,
  };
}

function profileName(name) {
  const value = typeof name === "string" ? name.trim() : "";
  if (!value || value.length > 48 || /[\x00-\x1f|]/.test(value) || ["__proto__", "constructor", "prototype"].includes(value)) {
    throw new Error("Use a profile name of 1–48 characters without control characters or |.");
  }
  return value;
}
const comparable = (s) => JSON.stringify({ rules: s.rules, budgets: s.budgets.map(({ createdAt, ...r }) => r), pacing: s.pacing || null });

export function profileSummary(env) {
  const p = readPlanning(env);
  const current = { rules: readRules(env), budgets: readBudgetRules(env), pacing: p.pacing };
  const active = p.activeProfile;
  return {
    names: Object.keys(p.profiles).sort(),
    active: active || null,
    modified: Boolean(active && p.profiles[active] && comparable(current) !== comparable(p.profiles[active])),
  };
}

export function saveProfile(env, name) {
  name = profileName(name);
  const snapshot = { rules: readRules(env), budgets: readBudgetRules(env), pacing: readPlanning(env).pacing || null };
  change(env, (p) => { p.profiles[name] = snapshot; p.activeProfile = name; });
  return name;
}

export function useProfile(env, name, now = Date.now()) {
  name = profileName(name);
  const p = readPlanning(env);
  const selected = p.profiles[name];
  if (!selected) throw new Error("No such profile. Save your current settings as a profile first.");
  const rules = normalizeRules(selected.rules);
  if (!Array.isArray(selected.rules) || rules.length !== selected.rules.length) throw new Error("This profile has invalid rules.");
  const pacing = normalizePacing(selected.pacing);
  const previous = { rules: readRules(env), budgets: readBudgetRules(env), pacing: p.pacing || null };
  try {
    writeBudgetRules(env, selected.budgets);
    writeRules(env, rules);
    change(env, (next) => { next.pacing = pacing; next.activeProfile = name; });
  } catch (error) {
    writeBudgetRules(env, previous.budgets);
    writeRules(env, previous.rules);
    change(env, (next) => { next.pacing = previous.pacing; });
    throw error;
  }
  recordEvent(env, { kind: "profile", at: now, message: `Activated profile ${name}. Usage counters and pauses were preserved.` });
  return name;
}

export function deleteProfile(env, name) {
  name = profileName(name);
  change(env, (p) => {
    if (!Object.hasOwn(p.profiles, name)) throw new Error("No such profile.");
    delete p.profiles[name];
    if (p.activeProfile === name) delete p.activeProfile;
  });
}

export function activeExtras(env, now, weekly) {
  const day = localDay(now);
  return readPlanning(env).extras.filter((g) => g.until > now && g.createdAt <= now && (g.period !== "daily" || g.day === day.key)
    && weekly && Math.abs(g.resetsAt - weekly.resetsAt) < 3600);
}

export function grantExtra(env, { period = "daily", project, points, until }, now, weekly) {
  if (!Number.isFinite(points) || points <= 0 || points > 100) throw new Error("Extra allowance must be above zero and at most 100 points.");
  if (!Number.isFinite(until) || until <= now || until > localDay(now).end) throw new Error("An extra allowance must expire later today, at or before local midnight.");
  // A grant only needs to know which weekly window it belongs to. Claude's
  // readings come from its status line and age while you are away, which is
  // exactly when a paused allowance needs extra room.
  if (!weekly || weekly.resetsAt * 1000 <= now || !Number.isFinite(weekly.seenAt) || weekly.seenAt > now) {
    throw new Error("A weekly reading for the current window is needed before granting extra allowance.");
  }
  if (project) {
    if (!path.isAbsolute(project)) throw new Error("Choose an absolute project folder.");
    project = realDir(project);
    period = "weekly";
  }
  if (!["daily", "weekly"].includes(period) || (period === "weekly" && !project)) throw new Error("Choose a daily or project allowance.");
  const rules = readBudgetRules(env);
  const configured = rules.some((r) => r.period === period && (r.project || null) === (project || null)) || (period === "daily" && readPlanning(env).pacing);
  if (!configured) throw new Error("Set an allowance or pacing plan for this scope first.");
  const grant = {
    id: randomUUID(), period, ...(project ? { project } : {}), points, createdAt: now,
    until: Math.min(until, weekly.resetsAt * 1000), resetsAt: weekly.resetsAt, day: localDay(now).key,
  };
  change(env, (p) => {
    p.extras = p.extras.filter((g) => g.until > now);
    if (p.extras.length >= 100) throw new Error("Too many active extras. Revoke an existing grant first.");
    p.extras.push(grant);
  });
  recordEvent(env, { kind: "extra", at: now, message: `Added ${points} points to ${project || "today's allowance"} until ${new Date(grant.until).toISOString()}. Other limits still apply.` });
  return grant;
}

export function revokeExtra(env, id, now = Date.now()) {
  change(env, (p) => {
    if (!p.extras.some((g) => g.id === id)) throw new Error("No such extra allowance.");
    p.extras = p.extras.filter((g) => g.id !== id);
  });
  recordEvent(env, { kind: "extra", at: now, message: "Revoked a temporary extra allowance." });
}

export function applyExtras(env, meters, now, weekly) {
  const grants = activeExtras(env, now, weekly);
  return meters.map((m) => {
    const extra = grants.filter((g) => g.period === m.period && (g.project || null) === (m.project || null)).reduce((sum, g) => sum + g.points, 0);
    return { ...m, baseAt: m.at, at: round(m.at + extra), extra };
  });
}
