import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mergeWindow, liveWindow } from "./window.mjs";
import { DEFAULT_RULES, evaluate, validRules } from "./rules.mjs";

// Everything Peras keeps lives under ~/.peras (PERAS_HOME). The window, the
// state and the install record are kept per Claude config dir, because each
// CLAUDE_CONFIG_DIR can be a different account with its own window.

export function perasHome(env = process.env) {
  return env.PERAS_HOME || path.join(env.HOME || os.homedir(), ".peras");
}

export function claudeDir(env = process.env) {
  return env.CLAUDE_CONFIG_DIR || path.join(env.HOME || os.homedir(), ".claude");
}

function dirKey(env) {
  return crypto.createHash("sha256").update(path.resolve(claudeDir(env))).digest("hex").slice(0, 12);
}

export const windowFile = (env) => path.join(perasHome(env), "windows", `${dirKey(env)}.json`);
export const stateFile = (env) => path.join(perasHome(env), "state", `${dirKey(env)}.json`);
export const installFile = (env) => path.join(perasHome(env), "install", `${dirKey(env)}.json`);
export const configFile = (env) => path.join(perasHome(env), "config.json");

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

export function readRules(env) {
  const config = readJson(configFile(env));
  return config && Array.isArray(config.rules) ? validRules(config.rules) : DEFAULT_RULES;
}

export function writeRules(env, rules) {
  const config = readJson(configFile(env)) ?? {};
  writeJsonAtomic(configFile(env), { ...config, rules });
}

// Keys are `window@resetsAt`; one whose reset has passed is dead weight.
const liveKey = (key, now) => Number(String(key).split("@")[1]) * 1000 > now;
const MAX_SESSIONS = 100;

export function readState(env, now = Date.now()) {
  let raw = null;
  try {
    raw = readJson(stateFile(env));
  } catch {
    // State is only memory of what was already said; losing it repeats a message.
  }
  const keys = (list) => (Array.isArray(list) ? list.filter((k) => liveKey(k, now)) : []);
  const asked = {};
  if (raw && typeof raw.asked === "object" && raw.asked !== null) {
    for (const [session, list] of Object.entries(raw.asked).slice(-MAX_SESSIONS)) {
      const live = keys(list);
      if (live.length) asked[session] = live;
    }
  }
  return {
    notified: keys(raw?.notified),
    resumed: keys(raw?.resumed),
    asked,
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

/** Lifts every ask and pause the live window calls for, until that window resets. */
export function resume(env, now = Date.now()) {
  const window = liveWindow(readWindow(env), now);
  const state = readState(env, now);
  const { hits } = evaluate(window, readRules(env), { resumed: state.resumed });
  const lifted = hits.filter((h) => h.action !== "warn");
  if (lifted.length) {
    state.resumed = [...new Set([...state.resumed, ...lifted.map((h) => h.key)])];
    writeState(env, state);
  }
  return lifted;
}
