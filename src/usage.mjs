import path from "node:path";
import { WINDOWS } from "./window.mjs";
import { forecastFor } from "./forecast.mjs";
import { updateBlame } from "./blame.mjs";
import { dirKey, perasHome, readJson, writeJsonAtomic } from "./store.mjs";

// What the windows did over time: the points each live window was seen at (for
// the forecast), the past weeks (for `peras history`) and the week's session tally
// (for blame). One small file per Claude config dir, rewritten only when a point
// is added, so the status line never parses weeks of samples on a render.

const MIN = 60_000;
// A point is added when the % changes, or this long after the last one, so an idle
// stretch still shows as idle to the forecast.
const HEARTBEAT = { five_hour: 10 * MIN, seven_day: 60 * MIN };
const MAX_POINTS = 400;
const MAX_WEEKS = 8;
// Cost moves on nearly every render; the tally is saved when it moved this much.
const COST_STEP = 0.1;

export const usageFile = (env) => path.join(perasHome(env), "usage", `${dirKey(env)}.json`);

const empty = () => ({ v: 1, windows: {}, weeks: [], blame: null });

export function readUsage(env) {
  try {
    const raw = readJson(usageFile(env));
    if (!raw || typeof raw !== "object") return empty();
    return {
      v: 1,
      windows: raw.windows && typeof raw.windows === "object" ? raw.windows : {},
      weeks: Array.isArray(raw.weeks) ? raw.weeks : [],
      blame: raw.blame && typeof raw.blame === "object" ? raw.blame : null,
    };
  } catch {
    // History is a nicety: a damaged file starts over.
    return empty();
  }
}

export const writeUsage = (env, usage) => writeJsonAtomic(usageFile(env), usage);

const sameWindow = (a, b) => Math.abs(a - b) < 3600;

/**
 * A status-line reading folded into the usage record.
 * @returns {{ usage: object, changed: boolean }}
 */
export function trackReading(usage, reading, { session = null, cost = null, dir = null, now = Date.now() } = {}) {
  if (!reading) return { usage, changed: false };
  const next = { ...usage, windows: { ...usage.windows }, weeks: [...usage.weeks] };
  let changed = false;
  for (const name of Object.keys(WINDOWS)) {
    const w = reading[name];
    if (!w) continue;
    const cur = next.windows[name];
    if (!cur || !sameWindow(cur.resetsAt, w.resetsAt)) {
      if (cur && name === "seven_day" && cur.pts?.length) {
        next.weeks = [...next.weeks, { resetsAt: cur.resetsAt, pts: cur.pts }].slice(-MAX_WEEKS);
      }
      next.windows[name] = { resetsAt: w.resetsAt, pts: [[now, w.usedPct]] };
      changed = true;
      continue;
    }
    const last = cur.pts.at(-1);
    if (!last || last[1] !== w.usedPct || now - last[0] >= HEARTBEAT[name]) {
      next.windows[name] = { resetsAt: cur.resetsAt, pts: [...cur.pts, [now, w.usedPct]].slice(-MAX_POINTS) };
      changed = true;
    }
  }
  const week = reading.seven_day;
  if (week && session && typeof cost === "number" && Number.isFinite(cost)) {
    const before = next.blame?.sessions?.[session];
    const fresh = !next.blame || !sameWindow(next.blame.resetsAt, week.resetsAt) || !before;
    if (fresh || changed || Math.abs(cost - before.cost) >= COST_STEP || cost < before.cost) {
      next.blame = updateBlame(next.blame, { session, cost, pct: week.usedPct, resetsAt: week.resetsAt, now, dir });
      changed = true;
    }
  }
  return { usage: changed ? next : usage, changed };
}

/** The forecast for every live window that has one. */
export function forecasts(usage, live, now = Date.now()) {
  const out = {};
  for (const name of Object.keys(WINDOWS)) {
    const w = live?.[name];
    if (!w) continue;
    const track = usage.windows[name];
    const pts = track && sameWindow(track.resetsAt, w.resetsAt) ? track.pts : [];
    const f = forecastFor(name, w, pts, now);
    if (f) out[name] = f;
  }
  return out;
}

/**
 * Each week Peras saw, oldest first: its peak, when each weekly line was crossed,
 * and when it hit 100%.
 */
export function weeklyHistory(usage, rules) {
  const lines = rules
    .filter((r) => r.kind === "window" && r.window === "seven_day" && !r.project && !r.off)
    .sort((a, b) => a.at - b.at);
  const weeks = [...usage.weeks];
  if (usage.windows.seven_day?.pts?.length) weeks.push(usage.windows.seven_day);
  return weeks.map(({ resetsAt, pts }) => {
    const first = (pct) => pts.find(([, p]) => p >= pct)?.[0] ?? null;
    return {
      resetsAt,
      peak: Math.max(...pts.map(([, p]) => p)),
      wall: first(100),
      crossed: lines.map((r) => ({ at: r.at, action: r.action, during: r.during, t: first(r.at) })).filter((c) => c.t !== null),
      since: pts[0][0],
    };
  });
}
