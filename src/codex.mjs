import { readPlanning } from "./planning.mjs";
import { readBudgetRules, touchAllowanceSession } from "./allowances.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { readJson, writeJsonAtomic, perasHome, dirKey, installFile, context, readState, readWindow, windowFile, writeHookState, readInstall, writeInstall, readRules, resumableKeys } from "./store.mjs";
import { evaluate, realDir } from "./rules.mjs";
import { describe } from "./hook.mjs";
import { WINDOWS, windowText } from "./window.mjs";
import { readUsage, trackReading, writeUsage } from "./usage.mjs";
import { recordHookRun } from "./hook-health.mjs";
import { preferences } from "./preferences.mjs";
import { recordEvent } from "./events.mjs";
import { recordDenial } from "./receipts.mjs";

export const codexDir = (env = process.env) => env.CODEX_HOME || path.join(env.HOME || os.homedir(), ".codex");
export const codexEnv = (env = process.env) => ({ ...env, CLAUDE_CONFIG_DIR: codexDir(env), PERAS_PROVIDER: "codex" });
export const hooksPath = (env = process.env) => path.join(codexDir(env), "hooks.json");
export const codexExecutable = (env) => String(env.PATH ?? "").split(path.delimiter).filter(Boolean)
  .map((dir) => path.join(dir, process.platform === "win32" ? "codex.exe" : "codex"))
  .find((candidate) => fs.existsSync(candidate)) ?? "codex";
export const cachePath = (env) => path.join(perasHome(env), "codex", `${dirKey(codexEnv(env))}-rate-limits.json`);
const CACHE_MS = 60_000;
// With a prompt rule on, a tool call reuses a reading this young instead of
// asking Codex again, which costs about a second each time.
const PROMPT_RULE_MS = 10_000;
const EVENTS = ["UserPromptSubmit", "PreToolUse"];
const isObject = (v) => v && typeof v === "object" && !Array.isArray(v);
// Ours is any Peras hook in Codex's file: the codex-hook setup writes, or the Claude
// Code `hook` command wired in by hand, which reads Claude's window, not Codex's.
const ours = (h) => isObject(h) && h.type === "command" && /peras\.mjs"? (codex-)?hook\b/.test(h.command);
const VERSION = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

/** Read the public app-server RPC without inspecting Codex credentials. */
export function readRateLimits({ env = process.env, executable = "codex", timeout = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ["app-server", "--listen", "stdio://"], { env, stdio: ["pipe", "pipe", "pipe"] });
    let buffer = "";
    let stderr = "";
    let done = false;
    const finish = (error, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill();
      error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => finish(new Error("Codex rate-limit read timed out")), timeout);
    child.on("error", (e) => finish(e));
    child.stdin.on("error", (e) => finish(e));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-1000); });
    child.on("exit", (code) => finish(new Error(`Codex app-server exited (${code}) before returning rate limits${stderr ? `: ${stderr.trim()}` : ""}`)));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      for (let end; (end = buffer.indexOf("\n")) !== -1;) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1) {
          if (msg.error) return finish(new Error(msg.error.message || "Codex initialization failed"));
          child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
          child.stdin.write(`${JSON.stringify({ method: "account/rateLimits/read", id: 2 })}\n`);
        } else if (msg.id === 2) {
          return msg.error ? finish(new Error(msg.error.message || "Codex rate-limit read failed")) : finish(null, msg.result);
        }
      }
    });
    child.stdin.write(`${JSON.stringify({ method: "initialize", id: 1, params: { clientInfo: { name: "peras", title: "Peras", version: VERSION } } })}\n`);
  });
}

const WINDOW_MINS = { 300: "five_hour", 10080: "seven_day" };

/**
 * Reads Codex's answer. Buckets are identified by duration, not position, and
 * only Codex's own meter counts: the keyed map's `codex` entry, or the single
 * view when it names no meter or names `codex`. An answer in a shape Peras does
 * not know throws, so it is never taken for a fresh reading with nothing in it.
 *
 * `absent` lists the windows Codex says are not there. Only a certain answer
 * says that: both slots stated, every duration known. A slot left out, or one
 * whose duration is missing, could be any window, so then nothing is absent.
 */
export function parseRateLimits(result, now = Date.now()) {
  const map = result?.rateLimitsByLimitId;
  const single = result?.rateLimits;
  if (!isObject(result) || (!isObject(map) && !isObject(single))) {
    throw new Error("Codex reported usage in a shape this Peras does not recognize; run peras update");
  }
  const own = (b) => isObject(b) && (b.limitId == null || b.limitId === "codex");
  const bucket = isObject(map?.codex) ? map.codex : own(single) ? single : null;
  if (!bucket) throw new Error("Codex reported no Codex usage meter; run peras update");
  const malformed = () => new Error("Codex reported a usage window this Peras does not recognize; run peras update");
  const reading = {};
  const reported = new Set();
  let certain = "primary" in bucket && "secondary" in bucket;
  for (const limit of [bucket.primary, bucket.secondary]) {
    if (limit == null) continue;
    if (!isObject(limit)) throw malformed();
    const mins = limit.windowDurationMins;
    if (mins == null) { certain = false; continue; }
    if (!Number.isFinite(mins)) throw malformed();
    const name = WINDOW_MINS[mins];
    if (!name) continue;
    if (!Number.isFinite(limit.usedPercent) || (limit.resetsAt != null && !Number.isFinite(limit.resetsAt))) throw malformed();
    reported.add(name);
    if (limit.resetsAt == null) continue;
    reading[name] = { usedPct: Math.max(0, Math.min(100, limit.usedPercent)), resetsAt: limit.resetsAt, seenAt: now };
  }
  const absent = certain ? Object.keys(WINDOWS).filter((name) => !reported.has(name)) : [];
  return { reading, absent };
}

export const readingFromRateLimits = (result, now = Date.now()) => parseRateLimits(result, now).reading;

// Failed reads are remembered apart from the cache, whose `at` hooks trust as fresh.
export const refreshStatePath = (env) => path.join(perasHome(env), "codex", `${dirKey(codexEnv(env))}-refresh.json`);
const BACKOFF_MS = [2_000, 5_000, 15_000, 30_000, 60_000];

/**
 * How old a reading the menu accepts. A live 5-hour window changes slowly: once a
 * minute. Just after it resets the next one starts with your next message, maybe
 * from ChatGPT, so look every second, then less and less often. Timed from the
 * stored reset itself, so it settles at once a minute however long the menu runs.
 */
export function adaptiveMaxAge(stored, now) {
  const reset = stored?.five_hour?.resetsAt;
  if (typeof reset !== "number" || reset * 1000 > now) return CACHE_MS;
  const since = now - reset * 1000;
  return since < 15_000 ? 1_000 : since < 60_000 ? 5_000 : since < 300_000 ? 15_000 : CACHE_MS;
}

export async function refreshCodex(env = process.env, now = Date.now(), { force = false, maxAge = CACHE_MS, reader = readRateLimits, adaptive = false } = {}) {
  const scoped = codexEnv(env);
  let cached, failed;
  try { cached = readJson(cachePath(env)); } catch { cached = null; }
  try { failed = readJson(refreshStatePath(env)); } catch { failed = null; }
  if (adaptive && !force) {
    let stored = null;
    try { stored = readWindow(scoped); } catch { /* no window to pace by */ }
    maxAge = adaptiveMaxAge(stored, now);
  }
  if (!force && cached?.at && now - cached.at < maxAge) return cached.reading ?? {};
  // The menu waits out a failing Codex (offline, logged out, missing) instead of
  // starting an app-server every second. Hooks still try: they need the answer.
  if (adaptive && !force && failed?.failedAt && now - failed.failedAt < BACKOFF_MS[Math.min(failed.failures, BACKOFF_MS.length) - 1]) {
    throw new Error(failed.lastError || "Codex rate-limit read failed");
  }
  try {
    const result = await reader({ env, executable: readInstall(scoped)?.codexExecutable ?? codexExecutable(env) });
    const { reading, absent } = parseRateLimits(result, now);
    // A live window Codex says is not there (it has run weekly-only for some
    // accounts) is gone, not frozen at its last reading until that reading's reset.
    // An expired one already counts for nothing and stays: the menu times its
    // search for the next window from that reset.
    let stored = null;
    try { stored = readWindow(scoped); } catch { /* replaced below */ }
    const dropped = absent.filter((name) => stored?.[name]?.resetsAt * 1000 > now);
    if (dropped.length) writeJsonAtomic(windowFile(scoped), Object.fromEntries(Object.entries(stored).filter(([name]) => !dropped.includes(name))));
    if (Object.keys(reading).length) {
      const { recordReading } = await import("./store.mjs");
      recordReading(scoped, reading);
      const tracked = trackReading(readUsage(scoped), reading, { now });
      if (tracked.changed) writeUsage(scoped, tracked.usage);
    }
    writeJsonAtomic(cachePath(env), { at: now, reading });
    if (failed) fs.rmSync(refreshStatePath(env), { force: true });
    return reading;
  } catch (error) {
    // Keep the last window on disk, but let callers report a failed refresh.
    try {
      writeJsonAtomic(refreshStatePath(env), { failedAt: now, failures: Math.min((failed?.failures ?? 0) + 1, BACKOFF_MS.length), lastError: String(error?.message ?? error).slice(0, 300) });
    } catch { /* the failure is still reported */ }
    throw error;
  }
}

export function inspectCodex(env) {
  const target = hooksPath(env);
  const value = readJson(target) ?? {};
  if (!isObject(value) || (value.hooks !== undefined && !isObject(value.hooks))) throw new Error(`${target} is not a hooks object.`);
  const has = (test) => EVENTS.filter((e) => Array.isArray(value.hooks?.[e]) && value.hooks[e].some((g) => Array.isArray(g?.hooks) && g.hooks.some((h) => ours(h) && test(h))));
  const events = has((h) => /codex-hook\b/.test(h.command));
  return { target, events, missingEvents: EVENTS.filter((e) => !events.includes(e)), claudeHookEvents: has((h) => !/codex-hook\b/.test(h.command)) };
}

export function installCodex(env, command) {
  const target = hooksPath(env);
  const value = readJson(target) ?? {};
  if (!isObject(value) || (value.hooks !== undefined && !isObject(value.hooks))) throw new Error(`${target} is not a hooks object; nothing was written.`);
  const hooks = { ...(value.hooks ?? {}) };
  const hook = { type: "command", command: `${command} codex-hook`, timeout: 10 };
  for (const event of EVENTS) {
    const groups = Array.isArray(hooks[event]) ? hooks[event] : [];
    const kept = groups.flatMap((g) => {
      if (!isObject(g) || !Array.isArray(g.hooks)) return [g];
      const rest = g.hooks.filter((h) => !ours(h));
      return rest.length ? [{ ...g, hooks: rest }] : [];
    });
    hooks[event] = [...kept, { ...(event === "PreToolUse" ? { matcher: ".*" } : {}), hooks: [hook] }];
  }
  const next = { ...value, hooks };
  const changed = JSON.stringify(next) !== JSON.stringify(value);
  if (changed) {
    if (fs.existsSync(target) && !EVENTS.some((e) => value.hooks?.[e]?.some((g) => g.hooks?.some(ours)))) fs.copyFileSync(target, `${target}.peras-backup`);
    writeJsonAtomic(target, next);
  }
  writeInstall(codexEnv(env), { command, version: VERSION, hooksPath: target, codexExecutable: codexExecutable(env) });
  return { target, changed };
}

export function removeCodex(env) {
  const target = hooksPath(env);
  const value = readJson(target);
  if (!isObject(value)) return { target, changed: false };
  const next = { ...value, hooks: { ...value.hooks } };
  for (const event of EVENTS) {
    if (!Array.isArray(next.hooks[event])) continue;
    next.hooks[event] = next.hooks[event].flatMap((g) => {
      if (!isObject(g) || !Array.isArray(g.hooks)) return [g];
      const rest = g.hooks.filter((h) => !ours(h));
      return rest.length ? [{ ...g, hooks: rest }] : [];
    });
    if (!next.hooks[event].length) delete next.hooks[event];
  }
  if (!Object.keys(next.hooks).length) delete next.hooks;
  const changed = JSON.stringify(next) !== JSON.stringify(value);
  if (changed) writeJsonAtomic(target, next);
  fs.rmSync(installFile(codexEnv(env)), { force: true });
  return { target, changed };
}

export async function runCodexHook({ input, env = process.env, now = Date.now(), reader, notify = () => {} } = {}) {
  const scoped = codexEnv(env);
  let refreshError;
  // Only allowance bookkeeping: failing to note the session must not cost the check.
  try { touchAllowanceSession(scoped, String(input?.session_id ?? ""), input?.cwd, now); } catch { /* noted next call */ }
  // Prompt allowances need a current baseline at each prompt, and recent usage
  // at tool calls. The menu's minute-long cache could otherwise hide the rise.
  const promptRule = readRules(scoped).some(rule => rule.kind === "prompt" && !rule.off) || readBudgetRules(scoped).length > 0 || Boolean(readPlanning(scoped).pacing);
  const force = promptRule && input?.hook_event_name === "UserPromptSubmit";
  const maxAge = promptRule ? PROMPT_RULE_MS : CACHE_MS;
  try { await refreshCodex(env, now, { reader, force, maxAge }); } catch (error) { refreshError = error; }
  const state = readState(scoped, now);
  const session = String(input?.session_id ?? "");
  if (session && typeof input?.cwd === "string") state.sessions[session] = { ...state.sessions[session], cwd: realDir(input.cwd), t: now, startedAt: state.sessions[session]?.startedAt ?? now, event: input.hook_event_name, ...(input.hook_event_name === "PreToolUse" ? { lastToolAt: now } : {}) };
  const ctx = context(scoped, { now, cwd: input?.cwd, session, state, usage: readUsage(scoped) });
  if (input?.hook_event_name === "UserPromptSubmit") {
    state.prompts[session] = { id: now.toString(36), t: now, ...Object.fromEntries(Object.entries(ctx.window).map(([name, w]) => [name, w.usedPct])) };
    ctx.prompt = state.prompts[session];
  }
  const { action, hit, hits } = evaluate(ctx);
  if (action === "pause" || action === "ask") {
    // The deny is the answer: bookkeeping, events and notifications after it can fail without letting the tool run.
    const d = describe(hit, now);
    const deny = input?.hook_event_name === "PreToolUse"
      ? { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `Peras ${action === "ask" ? "requires the user's OK" : "paused Codex"}: ${d.what}. ${d.lifts}. Stop and tell the user why.` } }
      : { systemMessage: `Peras: ${d.what}. ${d.lifts}.` };
    if (input?.hook_event_name === "PreToolUse") recordDenial(scoped, hit, now);
    try { afterVerdict({ scoped, env, state, ctx, action, hit, hits, input, now, notify }); } catch { /* the deny stands */ }
    return deny;
  }
  return afterVerdict({ scoped, env, state, ctx, action, hit, hits, input, now, notify, refreshError });
}

function afterVerdict({ scoped, env, state, ctx, action, hit, hits, input, now, notify, refreshError }) {
  recordHookRun(scoped, input?.hook_event_name, now);
  state.latched = hits.filter((h) => h.kind === "pace").map((h) => h.key);
  writeHookState(scoped, state, now);
  if (action === "none") return refreshError ? { systemMessage: `Peras could not refresh Codex usage (${refreshError.message}); using the last reading if still valid.` } : null;
  const d = describe(hit, now);
  if (input?.hook_event_name !== "PreToolUse") return { systemMessage: `Peras: ${d.what}. ${d.lifts}.` };
  const notification = `${action}:${hit.key}`;
  if (!state.notified.includes(notification) && hit.kind !== "manual") recordEvent(scoped, { kind: action === "warn" ? "warning" : action === "ask" ? "approval" : "pause", at: now, message: `${d.what}. ${d.lifts}.` });
  if (!state.notified.includes(notification) && preferences(env)[action === "warn" ? "warnings" : "pauses"]) {
    notify("Peras 🍐 Codex", `${action === "warn" ? "Warning" : "Paused"}: ${d.short}. ${d.lifts}.`, { env, provider: "codex", category: action === "warn" ? "status" : "pause", pauseKeys: resumableKeys(ctx, state) });
  }
  if (action === "warn") {
    const tag = `warn:${hit.key}`;
    if (state.notified.includes(tag)) return null;
    state.notified.push(tag);
    writeHookState(scoped, state, now);
    return { systemMessage: `Peras: ${d.what}.` };
  }
  if (!state.notified.includes(notification)) { state.notified.push(notification); writeHookState(scoped, state, now); }
  return null;
}

export async function codexStatus(env, now = Date.now()) {
  await refreshCodex(env, now);
  const scoped = codexEnv(env);
  const ctx = context(scoped, { now, cwd: process.cwd(), usage: readUsage(scoped) });
  const verdict = evaluate(ctx);
  return `Peras 🍐 Codex ${windowText(ctx.window, { resets: true, now }) || "no usage window"}${verdict.action === "none" ? "" : `\n${verdict.action.toUpperCase()}: ${describe(verdict.hit, now).what}`}`;
}
