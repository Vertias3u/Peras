// Codex's saved ("banked") resets: one-time resets held on the account until used or expired.
// `account/rateLimits/read` already answers with them (`rateLimitResetCredits`); Peras shows
// them and reminds before one expires. It never spends one: that stays the user's call.
import path from "node:path";
import { cachePath } from "./codex.mjs";
import { dirKey, perasHome, readJson, writeJsonAtomic } from "./store.mjs";
import { resetTime } from "./window.mjs";
import { preferences } from "./preferences.mjs";
import { notify as desktopNotify } from "./notify.mjs";
import { recordEvent } from "./events.mjs";

const STALE_MS = 6 * 3600_000;
const REMIND_MS = 24 * 3600_000;
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
// Unix seconds Peras can show as a date; anything else counts as "no known expiry".
const expirySeconds = (v) => (Number.isFinite(v) && v > 0 && !Number.isNaN(new Date(v * 1000).getTime()) ? v : null);

/**
 * The saved resets in a rate-limit answer, or null when Codex didn't say. Never throws:
 * a shape Peras doesn't know must not cost the usage reading.
 * `count` is Codex's `availableCount`; `credits` may be capped, so it can be shorter.
 */
export function parseResetCredits(result) {
  const raw = result?.rateLimitResetCredits;
  if (!isObject(raw) || !Number.isSafeInteger(raw.availableCount) || raw.availableCount < 0) return null;
  const credits = Array.isArray(raw.credits)
    ? raw.credits.filter((c) => isObject(c) && c.status === "available" && (c.expiresAt == null || Number.isFinite(c.expiresAt)))
      .map((c) => ({ ...(typeof c.id === "string" ? { id: c.id } : {}), expiresAt: expirySeconds(c.expiresAt), title: typeof c.title === "string" ? c.title.slice(0, 80) : null }))
    : null;
  return { count: raw.availableCount, credits };
}

function readSavedResets(env, now) {
  let cached;
  try { cached = readJson(cachePath(env)); } catch { return null; }
  const saved = cached?.savedResets;
  if (!isObject(saved) || !Number.isSafeInteger(saved.count) || saved.count < 0 || !Number.isFinite(cached.at) || now - cached.at > STALE_MS) return null;
  // The cache is a file anyone can break: keep only entries of the shape Peras wrote.
  const credits = Array.isArray(saved.credits) ? saved.credits.filter(isObject).map((c) => ({ ...c, expiresAt: expirySeconds(c.expiresAt) })) : null;
  return { count: saved.count, credits };
}

/**
 * What the last Codex reading said about saved resets, as of `now`: `{ count, nextExpiresAtMs }`,
 * or null when unknown (never read, an old reading, or Codex didn't say). Credits that expired
 * since the reading no longer count. `nextExpiresAtMs` is null when no known credit expires.
 */
export function savedResets(env, now = Date.now()) {
  // Only ever extra information: it must never cost a stop or a snapshot.
  try { return savedResetsAt(env, now); } catch { return null; }
}

function savedResetsAt(env, now) {
  const saved = readSavedResets(env, now);
  if (!saved) return null;
  const credits = Array.isArray(saved.credits) ? saved.credits : [];
  const expired = credits.filter((c) => c.expiresAt != null && c.expiresAt * 1000 <= now).length;
  const live = credits.filter((c) => c.expiresAt != null && c.expiresAt * 1000 > now).map((c) => c.expiresAt * 1000);
  return { count: Math.max(0, saved.count - expired), nextExpiresAtMs: live.length ? Math.min(...live) : null };
}

/** "1 saved reset · expires Thu 16:40", or null when there are none. */
export function savedResetsText(saved, now = Date.now()) {
  if (!saved?.count) return null;
  const n = `${saved.count} saved reset${saved.count === 1 ? "" : "s"}`;
  return saved.nextExpiresAtMs ? `${n} · ${saved.count === 1 ? "expires" : "next expires"} ${resetTime(saved.nextExpiresAtMs / 1000, now)}` : n;
}

/** One sentence for a Codex stop, so the agent can tell the user; empty when there are none. */
export function savedResetsHint(saved, now = Date.now()) {
  if (!saved?.count) return "";
  const when = saved.nextExpiresAtMs ? ` (${saved.count === 1 ? "it expires" : "the next expires"} ${resetTime(saved.nextExpiresAtMs / 1000, now)})` : "";
  return ` The user has ${saved.count} saved Codex reset${saved.count === 1 ? "" : "s"}${when}; spending one is their call.`;
}

/** Notify once per credit, a day before it expires. Under the Warnings setting. */
export function checkSavedResetReminders(env, snapshots, now, notify = desktopNotify) {
  if (!preferences(env).warnings) return;
  const file = path.join(perasHome(env), "saved-reset-reminders.json");
  let sent;
  try { sent = readJson(file); } catch { /* start over */ }
  if (!isObject(sent)) sent = {};
  for (const s of snapshots) {
    if (s.provider !== "codex") continue;
    const saved = readSavedResets(s.env || env, now);
    if (!saved?.count || !Array.isArray(saved.credits)) continue;
    for (const credit of saved.credits) {
      const at = credit.expiresAt * 1000;
      if (!Number.isFinite(at) || at - now > REMIND_MS || at <= now) continue;
      const legacy = `${dirKey(s.env || env)}:${at}`;
      const key = typeof credit.id === "string" ? `${legacy}:${credit.id}` : legacy;
      if (sent[key] || sent[legacy]) continue;
      // Persist before dispatch: a restart must not repeat it. Drop keys for credits long gone.
      sent = Object.fromEntries(Object.entries({ ...sent, [key]: now }).filter(([, t]) => now - t < 40 * 86_400_000));
      writeJsonAtomic(file, sent);
      const body = `A saved Codex reset expires ${resetTime(at / 1000, now)}. Spend it in Codex before then, or it's gone. Peras never spends it for you.`;
      notify("Saved reset expires soon 🍐", body, { env, provider: "codex", category: "status" });
      recordEvent(env, { kind: "warning", provider: "codex", at: now, message: body });
    }
  }
}
