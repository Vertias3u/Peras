import { readPlanning } from "./planning.mjs";
import { readBudgetRules, touchAllowanceSession } from "./allowances.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { readJson, writeJsonAtomic, perasHome, dirKey, installFile, context, readState, writeState, readInstall, writeInstall, readRules, resumableKeys } from "./store.mjs";
import { evaluate, realDir } from "./rules.mjs";
import { describe } from "./hook.mjs";
import { windowText } from "./window.mjs";
import { readUsage, trackReading, writeUsage } from "./usage.mjs";
import { recordHookRun } from "./hook-health.mjs";
import { preferences } from "./preferences.mjs";
import { recordEvent } from "./events.mjs";

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

/** Codex primary and secondary buckets are identified by duration, not position. */
export function readingFromRateLimits(result, now = Date.now()) {
  const bucket = result?.rateLimitsByLimitId?.codex ?? result?.rateLimits;
  const reading = {};
  for (const limit of [bucket?.primary, bucket?.secondary]) {
    const mins = limit?.windowDurationMins;
    const name = mins === 300 ? "five_hour" : mins === 10080 ? "seven_day" : null;
    if (!name || !Number.isFinite(limit.usedPercent) || !Number.isFinite(limit.resetsAt)) continue;
    reading[name] = { usedPct: Math.max(0, Math.min(100, limit.usedPercent)), resetsAt: limit.resetsAt, seenAt: now };
  }
  return reading;
}

export async function refreshCodex(env = process.env, now = Date.now(), { force = false, maxAge = CACHE_MS, reader = readRateLimits } = {}) {
  const scoped = codexEnv(env);
  let cached;
  try { cached = readJson(cachePath(env)); } catch { cached = null; }
  if (!force && cached?.at && now - cached.at < maxAge) return cached.reading ?? {};
  try {
    const result = await reader({ env, executable: readInstall(scoped)?.codexExecutable ?? codexExecutable(env) });
    const reading = readingFromRateLimits(result, now);
    if (Object.keys(reading).length) {
      const { recordReading } = await import("./store.mjs");
      recordReading(scoped, reading);
      const tracked = trackReading(readUsage(scoped), reading, { now });
      if (tracked.changed) writeUsage(scoped, tracked.usage);
    }
    writeJsonAtomic(cachePath(env), { at: now, reading });
    return reading;
  } catch (error) {
    // Keep the last window on disk, but let callers report a failed refresh.
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
  touchAllowanceSession(scoped, String(input?.session_id ?? ""), input?.cwd, now);
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
  recordHookRun(scoped, input?.hook_event_name, now);
  state.latched = hits.filter((h) => h.kind === "pace").map((h) => h.key);
  writeState(scoped, state);
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
    writeState(scoped, state);
    return { systemMessage: `Peras: ${d.what}.` };
  }
  if (!state.notified.includes(notification)) { state.notified.push(notification); writeState(scoped, state); }
  const reason = `Peras ${action === "ask" ? "requires the user's OK" : "paused Codex"}: ${d.what}. ${d.lifts}. Stop and tell the user why.`;
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } };
}

export async function codexStatus(env, now = Date.now()) {
  await refreshCodex(env, now);
  const scoped = codexEnv(env);
  const ctx = context(scoped, { now, cwd: process.cwd(), usage: readUsage(scoped) });
  const verdict = evaluate(ctx);
  return `Peras 🍐 Codex ${windowText(ctx.window, { resets: true, now }) || "no usage window"}${verdict.action === "none" ? "" : `\n${verdict.action.toUpperCase()}: ${describe(verdict.hit, now).what}`}`;
}
