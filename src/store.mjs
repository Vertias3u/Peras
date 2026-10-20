import { allowanceMeters, observeAllowances } from "./allowances.mjs";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mergeWindow, liveWindow, resetTime } from "./window.mjs";
import { DEFAULT_RULES, evaluate, normalizeRules } from "./rules.mjs";
import { forecasts, readUsage } from "./usage.mjs";
import { recordEvent } from "./events.mjs";
import { withControlLock } from "./control-lock.mjs";

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
/**
 * What hooks remember (sessions, prompts, what was said and asked). Since v0.4 it
 * has its own file, so a hook never writes the file that holds your pause and
 * resumes. state/ keeps those where 0.3 reads them, for rollback.
 */
export const hookMemoryFile = (env) => path.join(perasHome(env), "hook-memory", `${dirKey(env)}.json`);
/** An install record with this says its hooks write hookMemoryFile, never state/. */
export const HOOK_MEMORY = 1;
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
export function recordReading(env, reading, options = {}) {
  if (!reading) return;
  let stored = null;
  try {
    stored = readWindow(env);
  } catch {
    // A damaged file is replaced by the fresh reading.
  }
  writeJsonAtomic(windowFile(env), mergeWindow(stored, reading));
  observeAllowances(env, stored, reading, { now: reading.seven_day?.seenAt ?? Date.now(), ...options });
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
const mtime = (file) => fs.statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? 0;
// Before a v0.4 hook first runs, its memory is still in state/ with the controls.
// After a rollback, 0.3 keeps writing memory there (and drops the mark v0.4's
// control writers leave): state/ newer than hook memory and unmarked is the newer memory.
const memoryInState = (env, controls) => Boolean(controls) && controls.hookMemory !== HOOK_MEMORY && mtime(stateFile(env)) > mtime(hookMemoryFile(env));

/** With `strict`, a pause/resume file that exists but can't be read is an error, not an empty state. */
export function readState(env, now = Date.now(), { strict = false } = {}) {
  let controls = null, memory = null;
  try {
    controls = readJson(stateFile(env));
  } catch (error) {
    // State is only memory of what was already said; losing it repeats a message.
    // But it also holds your pause: strict mode won't guess that there is none.
    if (strict) throw Object.assign(new Error("Peras could not read your pause and resume state."), { code: "state_unreadable" });
  }
  try { memory = readJson(hookMemoryFile(env)); } catch { /* as above */ }
  if (memory && memoryInState(env, controls)) memory = null;
  const raw = { ...(memory ?? controls), manualPause: controls?.manualPause, resumed: controls?.resumed };
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

/**
 * A hook's write: only its own memory (sessions, prompts, what was said), in its
 * own file. Your pause and resumes live in state/, which only the locked control
 * writers write, so a hook can never write an older copy of them back.
 */
export function writeHookState(env, state, now = Date.now()) {
  const file = hookMemoryFile(env);
  // The first write moves hook memory out of state/: keep a copy of state/ as it was, once.
  if (!fs.existsSync(file)) {
    try { fs.copyFileSync(stateFile(env), stateFile(env).replace(/\.json$/, ".before-v04.json"), fs.constants.COPYFILE_EXCL); } catch { /* none yet, or already kept */ }
  }
  const { notified, asked, prompts, sessions, latched, failWarnAt } = state;
  writeJsonAtomic(file, { notified, asked, prompts, sessions, latched, failWarnAt });
}

export function readInstall(env) {
  try {
    return readJson(installFile(env));
  } catch {
    return null;
  }
}

export function writeInstall(env, record) {
  writeJsonAtomic(installFile(env), { ...record, hookMemory: HOOK_MEMORY });
}

/** The rules engine's view of the moment: the live window plus what Peras remembers. */
export function context(env, { now = Date.now(), cwd = null, session = null, state = readState(env, now), usage = null } = {}) {
  const window = liveWindow(readWindow(env), now);
  return {
    window,
    allowances: allowanceMeters(env, now, window),
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
 * The stops a notification's Resume button would lift, across every session.
 * The hook captures them when it notifies and the button compares them again,
 * so both must compute them the same way.
 */
export function resumableKeys(ctx, state) {
  return sessionVerdict({ ...ctx, cwd: null, prompt: null }, state).hits.filter((h) => h.action !== "warn").map((h) => h.key).sort();
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
  const plan = planResume(state, ctx, { now, forMs });
  commitResume(env, plan, { now, forMs });
  return { lifted: plan.lifted, manual: plan.manual, until: plan.until, issue };
}

/**
 * What a resume would do now, without doing it: the stops it lifts, the earlier
 * lifts whose expiry it replaces and the manual pause it clears.
 * `ctx` may be null when usage cannot be evaluated: then only the manual pause clears.
 */
export function planResume(state, ctx, { now = Date.now(), forMs = null } = {}) {
  // Re-evaluate lifted rules too, so another resume can replace their expiry.
  const hits = ctx ? sessionVerdict({ ...ctx, resumed: [] }, state).hits.filter((h) => h.action !== "warn" && h.kind !== "manual") : [];
  const lifted = [...new Map(hits.map((h) => [h.key, h])).values()];
  const until = forMs !== null ? wholeMinute(now + forMs) : null;
  const replaced = state.resumed.filter((r) => lifted.some((h) => h.key === r.key));
  return { lifted, replaced, manual: state.manualPause, until };
}

export class ControlsChanged extends Error {
  constructor() { super("Your pause or resume changed since this was reviewed."); this.code = "state_changed"; }
}
const samePause = (a, b) => (a?.since ?? null) === (b?.since ?? null) && (a?.until ?? null) === (b?.until ?? null);
const lifts = (resumed, plan) => resumed.filter((r) => plan.lifted.some((h) => h.key === r.key)).map((r) => [r.key, r.until ?? null]).sort().join();

/** Re-reads the state under the control lock, so control writers apply one at a time to the latest controls. */
function changeControls(env, now, fn) {
  return withControlLock(stateFile(env), () => {
    let controls = null;
    try { controls = readJson(stateFile(env)); } catch { /* readState decides */ }
    const state = readState(env, now);
    const result = fn(state);
    if (result !== false) {
      // The mark makes hook memory lead again, so newer memory still in state/ moves there first.
      if (fs.existsSync(hookMemoryFile(env)) && memoryInState(env, controls)) writeHookState(env, state, now);
      writeState(env, { ...state, hookMemory: HOOK_MEMORY });
    }
    return result;
  });
}

/**
 * Saves a plan from planResume, when it changes anything. Under the lock it
 * re-checks what the plan was made from: with `reviewed`, the pause and the
 * earlier lifts it replaces must still be the ones reviewed (else ControlsChanged).
 * The lifts are applied to the controls as they are now.
 */
export function commitResume(env, plan, { now = Date.now(), forMs = null, reviewed = false } = {}) {
  if (!plan.lifted.length && !plan.manual) return false;
  changeControls(env, now, (state) => {
    if (reviewed && (!samePause(state.manualPause, plan.manual) || lifts(state.resumed, plan) !== lifts(plan.replaced, plan))) throw new ControlsChanged();
    state.resumed = [...state.resumed.filter((r) => !plan.lifted.some((h) => h.key === r.key)), ...plan.lifted.map((h) => ({ key: h.key, ...(plan.until ? { until: plan.until } : {}) }))];
    state.manualPause = null;
  });
  recordEvent(env, { kind: "resume", at: now, // Clearing only your own pause is not timed, whatever duration was asked for.
    message: plan.until && plan.lifted.length ? `Resumed for ${Math.round(forMs / 60_000)} minutes, until ${resetTime(plan.until / 1000, now)}.` : "Resumed by you.", });
  return true;
}

/** Timed pauses and resumes end on a whole minute, so "until 03:05" means 03:05:00. */
export const wholeMinute = (ms) => Math.ceil(ms / 60_000) * 60_000;

/**
 * Pause by hand, under every line: until `until` (ms), or until `peras resume`.
 * With `reviewed` (the pause that was there when this was offered, or null), a
 * different pause found under the lock means someone acted since: ControlsChanged.
 */
export function pauseNow(env, { now = Date.now(), until = null, reviewed } = {}) {
  if (until) until = wholeMinute(until);
  const manualPause = changeControls(env, now, (state) => {
    if (reviewed !== undefined && !samePause(state.manualPause, reviewed)) throw new ControlsChanged();
    state.manualPause = { since: now, until };
    return state.manualPause;
  });
  recordEvent(env, { kind: "pause", at: now, message: until ? `Paused by you until ${resetTime(until / 1000, now)}.` : "Paused by you until resume." });
  return manualPause;
}
