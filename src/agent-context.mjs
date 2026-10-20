// Tells the agent its own usage and the other agent's, in one factual line next
// to the user's prompt, and only when something worth knowing changed. Opt-in
// (`peras agents on`). It reads the readings Peras already keeps and never
// decides anything: pauses stay the hooks' job.
import path from "node:path";
import { codexEnv } from "./codex.mjs";
import { forecasts, readUsage } from "./usage.mjs";
import { perasHome, readJson, readWindow, writeJsonAtomic } from "./store.mjs";
import { liveWindow, resetTime } from "./window.mjs";
import { preferences } from "./preferences.mjs";

const SOON_MS = 30 * 60_000;
const STALE_MS = 15 * 60_000;
const KEEP_MS = 7 * 86400_000;
const BANDS = [50, 75, 90, 100];
const LABEL = { claude: "Claude Code", codex: "Codex" };
const SHORT = { five_hour: "5h", seven_day: "week" };

const pad2 = (n) => String(n).padStart(2, "0");
const clock = (ms) => { const d = new Date(ms); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
const band = (pct) => BANDS.filter((b) => pct >= b).pop() ?? 0;

/** Each agent's live windows, as the readings Peras saved say: no reading, no row. */
function readings(env, now) {
  // Both hooks hand in the unscoped environment: CLAUDE_CONFIG_DIR is still Claude's.
  const scoped = { claude: env, codex: codexEnv(env) };
  const rows = {};
  for (const [provider, e] of Object.entries(scoped)) {
    let window = {};
    try { window = liveWindow(readWindow(e), now); } catch { /* unreadable: no row */ }
    if (!Object.keys(window).length) continue;
    let forecast = {};
    try { forecast = forecasts(readUsage(e), window, now); } catch { /* no pace, the rest stands */ }
    rows[provider] = Object.fromEntries(Object.entries(window).map(([name, w]) => [name, { ...w, projected: forecast[name]?.projected }]));
  }
  return rows;
}

/**
 * What has to change for a new line to be worth sending: a band crossed (a run-out
 * and a window coming back are both band changes) or a reset coming close. Not the
 * reset time itself: it drifts by seconds between readings.
 */
function signature(rows, now) {
  return JSON.stringify(Object.entries(rows).map(([provider, windows]) => [provider, Object.entries(windows).map(([name, w]) => [
    name, band(w.usedPct), w.resetsAt * 1000 - now <= SOON_MS,
  ])]));
}
// A reading going stale is news; one turning fresh again is not.
const isStale = (rows, now) => Object.values(rows).some((windows) => Object.values(windows).some((w) => Number.isFinite(w.seenAt) && now - w.seenAt > STALE_MS));

function windowText(name, w, now) {
  const pct = Math.round(w.usedPct);
  const reset = resetTime(w.resetsAt, now);
  if (pct >= 100) return `${SHORT[name]} 100% until ${reset}`;
  const pace = Number.isFinite(w.projected) && w.projected >= pct + 5 ? `, on pace for ${Math.round(Math.min(w.projected, 100))}%` : "";
  const seen = Number.isFinite(w.seenAt) && now - w.seenAt > STALE_MS ? `, reading from ${clock(w.seenAt)}` : "";
  return `${SHORT[name]} ${pct}% (resets ${reset}${pace}${seen})`;
}

/** The line itself: facts only, no instructions, so it reads as context rather than a command. */
export function usageNote(rows, self, now) {
  const parts = ["claude", "codex"].filter((p) => rows[p]).map((p) => {
    const windows = ["five_hour", "seven_day"].filter((n) => rows[p][n]).map((n) => windowText(n, rows[p][n], now));
    return `${LABEL[p]}${p === self ? " (this agent)" : ""}: ${windows.join(", ")}`;
  });
  return parts.length ? `Peras usage as of ${clock(now)} local. ${parts.join(". ")}.` : null;
}

const file = (env) => path.join(perasHome(env), "agent-context.json");

/**
 * The note for this prompt, or null: off, nothing read, or nothing changed since
 * this session's last note. Remembers what it sent per agent and session.
 */
export function noteForPrompt(env, { provider, session, now }) {
  if (!preferences(env).agents || !session) return null;
  const rows = readings(env, now);
  if (!Object.keys(rows).length) return null;
  const sig = signature(rows, now), stale = isStale(rows, now);
  const key = `${provider}:${session}`;
  let saved;
  try { saved = readJson(file(env)); } catch { /* unreadable: start over, at worst one repeat */ }
  const sessions = saved?.sessions && typeof saved.sessions === "object" ? saved.sessions : {};
  const last = sessions[key];
  const kept = Object.fromEntries(Object.entries(sessions).filter(([, v]) => Number.isFinite(v?.at) && now - v.at < KEEP_MS));
  if (last?.sig === sig && (last.stale || !stale)) {
    // Quiet, but remember a reading that turned fresh, so going stale again is news again.
    if (last.stale && !stale) writeJsonAtomic(file(env), { sessions: { ...kept, [key]: { ...last, stale } } });
    return null;
  }
  writeJsonAtomic(file(env), { sessions: { ...kept, [key]: { sig, stale, at: now } } });
  return usageNote(rows, provider, now);
}

/**
 * The hook's answer with the note added on a prompt. Anything going wrong here
 * leaves the answer exactly as it was: the note is never worth a check.
 */
export function withUsageNote(output, { env, input, provider, now = Date.now() }) {
  if (input?.hook_event_name !== "UserPromptSubmit" || output?.decision === "block" || output?.continue === false) return output;
  try {
    const note = noteForPrompt(env, { provider, session: String(input?.session_id ?? ""), now });
    if (!note) return output;
    return { ...(output ?? {}), hookSpecificOutput: { ...(output?.hookSpecificOutput ?? {}), hookEventName: "UserPromptSubmit", additionalContext: note } };
  } catch {
    return output;
  }
}

/** `peras usage`: the same facts on request, whatever the setting, for an agent about to start something big. */
export function usageReport(env, now = Date.now()) {
  const rows = readings(env, now);
  const providers = Object.fromEntries(Object.entries(rows).map(([provider, windows]) => [provider, Object.fromEntries(Object.entries(windows).map(([name, w]) => [name, {
    used: Math.round(w.usedPct * 10) / 10,
    resetsAtMs: w.resetsAt * 1000,
    seenAtMs: Number.isFinite(w.seenAt) ? w.seenAt : null,
    projected: Number.isFinite(w.projected) ? Math.round(Math.min(w.projected, 100)) : null,
  }]))]));
  return { asOfMs: now, providers, note: usageNote(rows, null, now) };
}
