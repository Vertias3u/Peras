import path from "node:path";
import { perasHome, readJson, writeJsonAtomic } from "./store.mjs";
import { preferences } from "./preferences.mjs";
import { notify as desktopNotify } from "./notify.mjs";
import { recordEvent } from "./events.mjs";

export function checkResets(env, snapshots, now, notify = desktopNotify) {
  const file = path.join(perasHome(env), "reset-notifications.json");
  let saved;
  try { saved = readJson(file) || {}; } catch { saved = {}; }
  const next = { ...saved };
  const outgoing = [];
  for (const s of snapshots) {
    const key = `${s.provider}:manual`, old = saved[key], current = s.ctx.manualPause;
    if (old?.until && now >= old.until && current?.since !== old.since) {
      recordEvent(env, { kind: "resume", provider: s.provider, at: now, message: "Timed manual pause ended automatically." });
    }
    if (current) next[key] = { since: current.since, until: current.until };
    else delete next[key];
  }
  for (const s of snapshots) for (const [window, label] of [["five_hour", "5-hour"], ["seven_day", "weekly"]]) {
    const key = `${s.provider}:${window}`, old = saved[key], current = s.ctx.window[window]?.resetsAt;
    if (old && !old.sent && now >= old.at * 1000) {
      recordEvent(env, { kind: "reset", provider: s.provider, at: now, message: `${label} window reached its reported reset time.` });
      if (preferences(env).resets) outgoing.push([`Peras 🍐 ${s.provider === "codex" ? "Codex" : "Claude"}`, `Your ${label} usage window has reached its reported reset time.`, { env }]);
      next[key] = { ...old, sent: true };
    }
    if (Number.isFinite(current) && current !== old?.at) next[key] = { at: current, sent: now >= current * 1000 };
  }
  if (JSON.stringify(next) !== JSON.stringify(saved)) writeJsonAtomic(file, next);
  // Saved before sent: a monitor that stops here never sends the same reset twice.
  for (const message of outgoing) notify(...message);
}
