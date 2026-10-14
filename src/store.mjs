import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mergeWindow, liveWindow, resetTime } from "./window.mjs";
import { DEFAULT_RULES, evaluate, normalizeRules } from "./rules.mjs";
import { forecasts, readUsage } from "./usage.mjs";
import { recordEvent } from "./events.mjs";

// Everything Peras keeps lives under ~/.peras (PERAS_HOME). The window, the
// state and the install record are kept per Claude config dir, because each
// CLAUDE_CONFIG_DIR can be a different account with its own window.

export function perasHome(env = process.env) {
  return env.PERAS_HOME || path.join(env.HOME || os.homedir(), ".peras");
}

export function claudeDir(env = process.env) {
  return env.CLAUDE_CONFIG_DIR || path.join(env.HOME || os.homedir(), ".claude");
}

export function dirKey(env) {
  return crypto.createHash("sha256").update(path.resolve(claudeDir(env))).digest("hex").slice(0, 12);
}

export const windowFile = (env) => path.join(perasHome(env), "windows", `${dirKey(env)}.json`);
export const stateFile = (env) => path.join(perasHome(env), "state", `${dirKey(env)}.json`);
export const installFile = (env) => path.join(perasHome(env), "install", `${dirKey(env)}.json`);
export const configFile = (env) => path.join(perasHome(env), env.PERAS_PROVIDER === "codex" ? "codex-config.json" : "config.json");

/** Null when the file does not exist; throws when it exists and is not JSON. */
export function readJson(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  return JSON.parse(text);
}

/** Write-then-rename, so a hook in another session never reads half a file. */
export function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function readWindow(env) {
  return readJson(windowFile(env));
}

/** Saves a reading over the stored window, one window at a time. Never saves an absence. */
export function recordReading(env, reading) {
  if (!reading) return;
  let stored = null;
  try {
    stored = readWindow(env);
  } catch {
    // A damaged file is replaced by the fresh reading.
  }
  writeJsonAtomic(windowFile(env), mergeWindow(stored, reading));
}

// Lines a version added to the defaults. A config saved by an older version gets
// them too, once: `peras set reset` in 0.1 wrote its defaults out in full.
const CONFIG_VERSION = 2;
const ADDED_IN = { 2: DEFAULT_RULES.filter((r) => r.kind === "pace") };

export function readRules(env) {
  const config = readJson(configFile(env));
  if (!config || !Array.isArray(config.rules)) return DEFAULT_RULES;
  const rules = normalizeRules(config.rules);
  const from = typeof config.v === "number" ? config.v : 1;
  for (let v = from + 1; v <= CONFIG_VERSION; v++) rules.push(...(ADDED_IN[v] ?? []));
  return rules;
}

export function writeRules(env, rules) {
  let config = {};
  try {
    config = readJson(configFile(env)) ?? {};
  } catch {
    // A damaged config is replaced by the lines being saved.
  }
  writeJsonAtomic(configFile(env), { ...config, v: CONFIG_VERSION, rules });
}

// Every key ends `@resetsAt` (epoch s), and a prompt line's key adds `#prompt`;
// one whose window has reset is dead weight.
const keyAlive = (key, now) => Number(String(key).split("@")[1]?.split("#")[0]) * 1000 > now;
const MAX_SESSIONS = 100;
const PROMPT_TTL = 7 * 24 * 3600_000;

const recent = (obj, max) => (obj && typeof obj === "object" && !Array.isArray(obj) ? Object.entries(obj).slice(-max) : []);

/**
 * What Peras remembers between hook calls. 0.1 files load as they are: a resume
 * there was a bare key string, and its notified keys keep their meaning.
 */
export function readState(env, now = Date.now()) {
  let raw = null;
  try {
    raw = readJson(stateFile(env));
  } catch {
    // State is only memory of what was already said; losing it repeats a message.
  }
  const keys = (list) => (Array.isArray(list) ? list.filter((k) => typeof k === "string" && keyAlive(k, now)) : []);
  const asked = {};
  for (const [session, list] of recent(raw?.asked, MAX_SESSIONS)) {
    const live = keys(list);
    if (live.length) asked[session] = live;
  }
  const resumed = (Array.isArray(raw?.resumed) ? raw.resumed : [])
    .map((r) => (typeof r === "string" ? { key: r } : r))
    .filter((r) => r && typeof r.key === "string" && keyAlive(r.key, now) && (r.until == null || r.until > now));
  const prompts = {};
  for (const [session, p] of recent(raw?.prompts, MAX_SESSIONS)) {
    if (p && typeof p.id === "string" && typeof p.t === "number" && now - p.t < PROMPT_TTL) prompts[session] = p;
  }
  const sessions = {};
  for (const [session, s] of recent(raw?.sessions, MAX_SESSIONS)) {
    if (s && typeof s.cwd === "string" && typeof s.t === "number" && now - s.t < PROMPT_TTL) sessions[session] = s;
  }
  const mp = raw?.manualPause;
  const manualPause = mp && typeof mp.since === "number" && (mp.until == null || mp.until > now) ? { since: mp.since, until: mp.until ?? null } : null;
  return {
    notified: keys(raw?.notified),
    resumed,
    asked,
    prompts,
    sessions,
    latched: keys(raw?.latched),
    manualPause,
    failWarnAt: typeof raw?.failWarnAt === "number" ? raw.failWarnAt : 0,
  };
}

export function writeState(env, state) {
  writeJsonAtomic(stateFile(env), state);
}

export function readInstall(env) {
  try {
    return readJson(installFile(env));
  } catch {
    return null;
  }
}

export function writeInstall(env, record) {
  writeJsonAtomic(installFile(env), record);
}

/** The rules engine's view of the moment: the live window plus what Peras remembers. */
export function context(env, { now = Date.now(), cwd = null, session = null, state = readState(env, now), usage = null } = {}) {
  const window = liveWindow(readWindow(env), now);
  return {
    window,
    rules: readRules(env),
    now,
    cwd,
    resumed: state.resumed,
    latched: state.latched,
    manualPause: state.manualPause,
    prompt: session ? state.prompts[session] ?? null : null,
    forecast: usage ? forecasts(usage, window, now) : {},
  };
}

/** Evaluate the terminal and recently seen agent sessions, using each session's folder. */
export function sessionVerdict(ctx, state) {
  const ids = new Set([...Object.keys(state.sessions ?? {}), ...Object.keys(state.prompts)]);
  const hits = [...evaluate(ctx).hits];
  for (const id of ids) {
    hits.push(...evaluate({ ...ctx, cwd: state.sessions?.[id]?.cwd ?? ctx.cwd, prompt: state.prompts[id] ?? null }).hits);
  }
  const unique = [...new Map(hits.map((h) => [h.key, h])).values()];
  const rank = { warn: 1, ask: 2, pause: 3 };
  unique.sort((a, b) => rank[b.action] - rank[a.action] || (b.at ?? 0) - (a.at ?? 0));
  return { hits: unique, hit: unique[0] ?? null, action: unique[0]?.action ?? "none" };
}

/**
 * Lifts every ask and pause the moment calls for, and a pause you started.
 * Without `forMs` until the window resets (or the next prompt, for a prompt
 * line); with it, for that long.
 */
export function resume(env, { now = Date.now(), forMs = null, cwd = null } = {}) {
  if (forMs !== null && (!Number.isSafeInteger(forMs) || forMs <= 0 || !Number.isFinite(new Date(now + forMs).getTime()))) {
    throw new Error("A resume duration must be a positive, finite length.");
  }
  const state = readState(env, now);
  let ctx;
  let issue = null;
  try { ctx = context(env, { now, cwd, state, usage: readUsage(env) }); }
  catch (error) {
    if (!state.manualPause) throw error;
    // A manual pause can always be cleared, even when usage cannot be evaluated.
    issue = error.message;
  }
  // Re-evaluate lifted rules too, so another resume can replace their expiry.
  const hits = ctx ? sessionVerdict({ ...ctx, resumed: [] }, state).hits.filter((h) => h.action !== "warn" && h.kind !== "manual") : [];
  const lifted = [...new Map(hits.map((h) => [h.key, h])).values()];
  const until = forMs !== null ? wholeMinute(now + forMs) : null;
  const manual = state.manualPause;
  state.resumed = [...state.resumed.filter((r) => !lifted.some((h) => h.key === r.key)), ...lifted.map((h) => ({ key: h.key, ...(until ? { until } : {}) }))];
  state.manualPause = null;
  if (lifted.length || manual) {
    writeState(env, state);
    recordEvent(env, { kind: "resume", at: now, message: until ? `Resumed for ${Math.round(forMs / 60_000)} minutes, until ${resetTime(until / 1000, now)}.` : "Resumed by you.", });
  }
  return { lifted, manual, until, issue };
}

/** Timed pauses and resumes end on a whole minute, so "until 03:05" means 03:05:00. */
export const wholeMinute = (ms) => Math.ceil(ms / 60_000) * 60_000;

/** Pause by hand, under every line: until `until` (ms), or until `peras resume`. */
export function pauseNow(env, { now = Date.now(), until = null } = {}) {
  const state = readState(env, now);
  if (until) until = wholeMinute(until);
  state.manualPause = { since: now, until };
  writeState(env, state);
  recordEvent(env, { kind: "pause", at: now, message: until ? `Paused by you until ${resetTime(until / 1000, now)}.` : "Paused by you until resume." });
  return state.manualPause;
}
