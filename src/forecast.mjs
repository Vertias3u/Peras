// Where a window is headed, from the points Peras saw it at. A window's % only
// climbs between resets, so the recent rate times the hours left is the forecast.

const H = 3600_000;
const SPEC = {
  five_hour: { length: 5 * H, lookback: 1 * H, minSpan: 0.5 * H },
  seven_day: { length: 168 * H, lookback: 24 * H, minSpan: 6 * H },
};
const round = (n, places) => Math.round(n * 10 ** places) / 10 ** places;

/**
 * @param {string} name a window: five_hour | seven_day
 * @param {{usedPct: number, resetsAt: number}} w the live window
 * @param {[number, number][]} pts [time ms, used %] seen in this window
 * @returns {{window, usedPct, ratePerHour, projected, basis, now, resetsAt} | null} null until there is enough to go on
 */
export function forecastFor(name, w, pts = [], now = Date.now()) {
  const spec = SPEC[name];
  if (!spec || !w) return null;
  const resetMs = w.resetsAt * 1000;
  const startMs = resetMs - spec.length;
  if (now >= resetMs) return null;
  const mine = pts.filter(([t]) => t >= startMs && t <= now).sort((a, b) => a[0] - b[0]);
  const from = now - spec.lookback;
  const before = mine.filter(([t]) => t <= from).at(-1);
  const after = mine.find(([t]) => t > from);
  let rate;
  let basis = "recent";
  if (before) {
    // Where it stood a lookback ago, between the two points either side of it.
    const pctThen = after ? before[1] + ((after[1] - before[1]) * (from - before[0])) / (after[0] - before[0]) : before[1];
    rate = (w.usedPct - pctThen) / (spec.lookback / H);
  } else if (mine.length && now - mine[0][0] >= spec.minSpan) {
    rate = (w.usedPct - mine[0][1]) / ((now - mine[0][0]) / H);
  } else if (now - startMs >= spec.minSpan) {
    rate = w.usedPct / ((now - startMs) / H);
    basis = "average";
  } else return null;
  rate = round(Math.max(0, rate), 4);
  const projected = round(w.usedPct + (rate * (resetMs - now)) / H, 1);
  return { window: name, usedPct: w.usedPct, ratePerHour: rate, projected, basis, now, resetsAt: w.resetsAt };
}

/** When the forecast reaches `pct`, or null when it is past it already or will not get there before the reset. */
export function etaTo(f, pct) {
  if (!f || f.usedPct >= pct || f.ratePerHour <= 0) return null;
  const t = Math.round(f.now + ((pct - f.usedPct) / f.ratePerHour) * H);
  return t < f.resetsAt * 1000 ? t : null;
}
