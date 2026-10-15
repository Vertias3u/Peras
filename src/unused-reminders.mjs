import { reminderSnooze, consumeSnooze } from "./notification-actions.mjs";
import { codexEnv } from "./codex.mjs";
import path from "node:path";
import { perasHome, readJson, writeJsonAtomic, dirKey } from "./store.mjs";
import { preferences, countdown } from "./preferences.mjs";
import { notify as desktopNotify } from "./notify.mjs";
import { recordEvent } from "./events.mjs";

export function unusedReminder(snapshot, now) {
  const w = snapshot.ctx.window.seven_day;
  if (snapshot.error || !w || !Number.isFinite(w.usedPct) || w.usedPct < 0 || w.usedPct > 100 || !Number.isFinite(w.seenAt) || w.seenAt > now || now - w.seenAt > 5 * 60_000) return null;
  const left = w.resetsAt * 1000 - now;
  if (!Number.isFinite(left) || left <= 0 || left > 48 * 3600_000 || w.usedPct > 80) return null;
  const remaining = Math.floor(100 - w.usedPct);
  const time = countdown(w.resetsAt, now);
  const spokenTime = time.replace(/(\d+)d/g, (_, n) => `${n} ${n === "1" ? "day" : "days"}`).replace(/(\d+)h/g, (_, n) => `${n} ${n === "1" ? "hour" : "hours"}`).replace(/(\d+)m/g, (_, n) => `${n} ${n === "1" ? "minute" : "minutes"}`);
  return { resetsAt: w.resetsAt, menu: `${remaining}% left · resets in ${time}`, body: `${snapshot.provider === "codex" ? "Codex" : "Claude"} has ${remaining}% of its weekly allowance left. Resets in ${spokenTime}.` };
}

export function checkUnusedReminders(env, snapshots, now, notify = desktopNotify) {
  if (!preferences(env).unused) return;
  const file = path.join(perasHome(env), "unused-reminders.json");
  let saved;
  try { saved = readJson(file); } catch { /* Recover from unreadable state. */ }
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) saved = {};
  const next = { ...saved };
  for (const s of snapshots) {
    const reminder = unusedReminder(s, now);
    const key = `${s.provider}:${dirKey(s.env || env)}`;
    const scoped = s.env || (s.provider === "codex" ? codexEnv(env) : env);
    const snooze = reminderSnooze(scoped);
    const sameSnooze = snooze && reminder && snooze.resetsAt === reminder.resetsAt && !snooze.consumed;
    if (!reminder || (sameSnooze && snooze.until > now) || (next[key] === reminder.resetsAt && !sameSnooze)) continue;
    next[key] = reminder.resetsAt;
    // Persist before dispatch: a restart must not repeat a reminder.
    writeJsonAtomic(file, next);
    notify("Use it or lose it 🍐", reminder.body, { env, provider: s.provider, category: "reminder", resetsAt: reminder.resetsAt });
    if (sameSnooze) consumeSnooze(scoped, snooze);
    recordEvent(env, { kind: "unused", provider: s.provider, at: now, message: reminder.body });
  }
}
