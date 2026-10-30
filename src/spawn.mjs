import { withControlLock } from "./control-lock.mjs";
import { readJson, stateFile, writeJsonAtomic } from "./store.mjs";

/** Spawn names differ between providers; Codex may qualify its tool name. */
export function isSpawnTool(provider, toolName) {
  if (typeof toolName !== "string") return false;
  if (provider === "claude") return toolName === "Agent" || toolName === "Task";
  return provider === "codex" && toolName.endsWith("spawn_agent");
}

// Headless runs may never send a prompt event; the session then counts as one prompt.
export const promptKey = (state, session) => state.prompts[session]?.id ?? "session";

// Spawns started together arrive as separate hook processes at the same moment, so
// the count lives in its own file, changed only under a lock and only by spawn calls.
const ledgerFile = (env) => stateFile(env).replace(/\.json$/, "") + ".spawns.json";
const MAX_SESSIONS = 50;

function changeLedger(env, session, fn) {
  return withControlLock(ledgerFile(env), () => {
    let all = {};
    try { all = readJson(ledgerFile(env)) ?? {}; } catch { /* a broken ledger starts over */ }
    const result = fn(all);
    const kept = Object.entries(all).filter(([, s]) => s && Number.isSafeInteger(s.n)).sort((a, b) => (b[1].t ?? 0) - (a[1].t ?? 0)).slice(0, MAX_SESSIONS);
    writeJsonAtomic(ledgerFile(env), Object.fromEntries(kept));
    return result;
  }, { attempts: 80, waitMs: 10 });
}

/**
 * The parent's prompt owns the whole tree's counter. A spawn call takes the next
 * slot before the verdict; `releaseSpawn` gives it back if the spawn is refused.
 */
export function spawnContext(state, session, provider, input, env, now = Date.now()) {
  state.spawns ??= {};
  const prompt = promptKey(state, session);
  if (state.spawns[session]?.prompt !== prompt) state.spawns[session] = { prompt, n: 0 };
  const isSpawn = input?.hook_event_name === "PreToolUse" && isSpawnTool(provider, input?.tool_name);
  if (!isSpawn || !env) return { isSpawn, prompt, before: state.spawns[session].n };
  try {
    const before = changeLedger(env, session, (all) => {
      const n = all[session]?.prompt === prompt ? all[session].n : 0;
      all[session] = { prompt, n: n + 1, t: now };
      return n;
    });
    state.spawns[session] = { prompt, n: before + 1 };
    return { isSpawn, prompt, before, claimed: true };
  } catch {
    // No atomic slot: refuse only this spawn, never admit from an unshared count.
    return { isSpawn, prompt, before: state.spawns[session].n, blocked: "the subagent counter is busy or unavailable, so a safe slot could not be claimed" };
  }
}

// "This prompt" for the app: the newest session's count while it is recent. An hour-old
// prompt that started 3 subagents is history, not what the agent is doing.
const RECENT_MS = 15 * 60_000;
export function promptSpawns(env, state, now = Date.now()) {
  let all = {};
  try { all = readJson(ledgerFile(env)) ?? {}; } catch { return 0; }
  const [session, s] = Object.entries(all).filter(([, v]) => v && Number.isSafeInteger(v.n) && Number.isFinite(v.t)).sort((a, b) => b[1].t - a[1].t)[0] ?? [];
  if (!s || now - s.t > RECENT_MS || s.prompt !== promptKey(state, session)) return 0;
  return s.n;
}

/** A refused or asked spawn doesn't start a subagent, so it gives its slot back. */
export function releaseSpawn(state, session, spawn, env) {
  if (!spawn?.isSpawn) return;
  state.spawns[session] = { prompt: spawn.prompt, n: Math.max(0, (state.spawns[session]?.n ?? 1) - 1) };
  if (!spawn.claimed) return;
  try {
    changeLedger(env, session, (all) => {
      if (all[session]?.prompt === spawn.prompt && all[session].n > 0) all[session].n--;
    });
  } catch { /* counted once too often: errs toward holding */ }
}
