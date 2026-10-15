import { countdown } from "./preferences.mjs";
export function alternativeHint(stopped, snapshots, now, { compact = false } = {}) {
  if (!["pause", "ask"].includes(stopped.verdict.action)) return null;
  const other = snapshots.find(s => s.provider !== stopped.provider && !s.error && !["pause", "ask"].includes(s.verdict.action));
  if (!other) return null;
  const windows = [other.ctx.window.five_hour, other.ctx.window.seven_day];
  if (!windows.every(w => w && Number.isFinite(w.usedPct) && w.usedPct >= 0 && w.usedPct < 100 && Number.isFinite(w.seenAt) && w.seenAt <= now && now - w.seenAt <= 300_000 && w.resetsAt * 1000 > now)) return null;
  if (compact) return `${other.provider === "codex" ? "Codex" : "Claude"}: ${Math.floor(100 - windows[0].usedPct)}% 5h · ${Math.floor(100 - windows[1].usedPct)}% weekly left · fresh reading`;
  return `${other.provider === "codex" ? "Codex" : "Claude"} reports ${Math.floor(100 - windows[0].usedPct)}% 5-hour and ${Math.floor(100 - windows[1].usedPct)}% weekly remaining · weekly reset in ${countdown(windows[1].resetsAt, now)}. Readings updated within 5 minutes; provider limits still apply.`;
}
