// The usage window Claude Code passes to its status line on a Pro/Max login:
// rate_limits.five_hour / seven_day → used_percentage (0–100), resets_at (epoch s).
// Each window may be absent, and none is sent before a session's first response.

export const WINDOWS = {
  five_hour: { label: "5h", name: "5-hour" },
  seven_day: { label: "7d", name: "weekly" },
};

function one(raw, now) {
  if (!raw || typeof raw !== "object") return null;
  const usedPct = raw.used_percentage;
  const resetsAt = raw.resets_at;
  if (typeof usedPct !== "number" || !Number.isFinite(usedPct)) return null;
  if (typeof resetsAt !== "number" || !Number.isFinite(resetsAt)) return null;
  return { usedPct: Math.min(100, Math.max(0, usedPct)), resetsAt, seenAt: now };
}

/** The windows in a status-line input, or null when it carries none. */
export function readingFrom(input, now = Date.now()) {
  const limits = input && typeof input === "object" ? input.rate_limits : null;
  if (!limits || typeof limits !== "object") return null;
  const reading = {};
  for (const name of Object.keys(WINDOWS)) {
    const w = one(limits[name], now);
    if (w) reading[name] = w;
  }
  return Object.keys(reading).length ? reading : null;
}

/** Each window in the new reading replaces that window; a window it lacks is kept. */
export function mergeWindow(stored, reading) {
  return { ...(stored ?? {}), ...(reading ?? {}) };
}

/**
 * The windows that still count. Usage only climbs inside a window, so an old
 * reading is a lower bound until its reset, and nothing at all after it.
 */
export function liveWindow(stored, now = Date.now()) {
  const live = {};
  for (const name of Object.keys(WINDOWS)) {
    const w = stored?.[name];
    if (w && typeof w.resetsAt === "number" && w.resetsAt * 1000 > now) live[name] = w;
  }
  return live;
}

const pad2 = (n) => String(n).padStart(2, "0");
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** A reset time as the local clock reads it, with the weekday when it is not today. */
export function resetTime(epochSeconds, now = Date.now()) {
  const at = new Date(epochSeconds * 1000);
  const clock = `${pad2(at.getHours())}:${pad2(at.getMinutes())}`;
  return at.toDateString() === new Date(now).toDateString() ? clock : `${DAYS[at.getDay()]} ${clock}`;
}

/** `5h 24% · 7d 41%`, or with `resets`, `5h 24% (resets 21:40) · 7d 41% (resets Tue 09:00)`. */
export function windowText(window, { resets = false, now = Date.now() } = {}) {
  return Object.entries(WINDOWS)
    .filter(([name]) => window?.[name])
    .map(([name, { label }]) => {
      const w = window[name];
      return `${label} ${Math.round(w.usedPct)}%${resets ? ` (resets ${resetTime(w.resetsAt, now)})` : ""}`;
    })
    .join(" · ");
}
