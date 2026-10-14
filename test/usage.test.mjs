import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { forecastFor, etaTo } from "../src/forecast.mjs";
import { updateBlame, blameShares } from "../src/blame.mjs";
import { trackReading, readUsage, writeUsage, usageFile, forecasts, weeklyHistory } from "../src/usage.mjs";
import { sandbox, NOW, inHours } from "./helpers.mjs";

const H = 3600_000;
const live = (pct, resets = inHours(72)) => ({ usedPct: pct, resetsAt: resets, seenAt: NOW });
const pt = (hoursAgo, pct) => [NOW - hoursAgo * H, pct];

test("forecast: none until there is enough to go on", () => {
  // A week that began an hour ago says nothing yet.
  assert.equal(forecastFor("seven_day", live(2, inHours(167)), [], NOW), null);
});

test("forecast: the last day's rate when there is a day of points", () => {
  const f = forecastFor("seven_day", live(70), [pt(30, 40), pt(10, 60), pt(1, 69)], NOW);
  assert.equal(f.basis, "recent");
  assert.equal(f.ratePerHour, 1);
  assert.equal(f.projected, 142);
  assert.equal(etaTo(f, 90), NOW + 20 * H);
  assert.equal(etaTo(f, 60), null, "already past it");
  assert.equal(etaTo({ ...f, ratePerHour: 0.1 }, 100), null, "not before the reset");
});

test("forecast: the average since the window began, without points", () => {
  // Resets in 72 h, so the week began 96 h ago: 30% over 96 h.
  const f = forecastFor("seven_day", live(30), [], NOW);
  assert.equal(f.basis, "average");
  assert.equal(f.ratePerHour, 0.3125);
  assert.equal(f.projected, 52.5);
});

test("forecast: points from before the window began never count", () => {
  assert.equal(forecastFor("seven_day", live(30), [pt(100, 95)], NOW).basis, "average");
});

test("forecast: an idle day forecasts a flat line", () => {
  const f = forecastFor("seven_day", live(50), [pt(20, 50)], NOW);
  assert.equal(f.ratePerHour, 0);
  assert.equal(f.projected, 50);
  assert.equal(etaTo(f, 90), null);
});

test("forecast: the 5-hour window uses the last hour", () => {
  const f = forecastFor("five_hour", live(60, inHours(2)), [pt(2, 20), pt(0.5, 50)], NOW);
  assert.equal(f.basis, "recent");
  assert.equal(f.ratePerHour, 20);
  assert.equal(f.projected, 100);
});

test("blame: the week's rise is split by what each session spent", () => {
  const r = inHours(72);
  let b = updateBlame(null, { session: "a", cost: 1, pct: 40, resetsAt: r, now: NOW, dir: "/x" });
  b = updateBlame(b, { session: "b", cost: 0, pct: 40, resetsAt: r, now: NOW, dir: "/y" });
  b = updateBlame(b, { session: "a", cost: 4, pct: 44, resetsAt: r, now: NOW + 1 });
  b = updateBlame(b, { session: "b", cost: 1, pct: 44, resetsAt: r, now: NOW + 2 });
  const shares = blameShares(b, 44);
  assert.deepEqual(shares.map((s) => [s.session, s.pct]), [["a", 3], ["b", 1]]);
  assert.equal(shares[0].dir, "/x");
});

test("blame: a session's cost going down is a restart, never a negative share", () => {
  const r = inHours(72);
  let b = updateBlame(null, { session: "a", cost: 2, pct: 40, resetsAt: r, now: NOW });
  b = updateBlame(b, { session: "a", cost: 5, pct: 43, resetsAt: r, now: NOW });
  b = updateBlame(b, { session: "a", cost: 0.5, pct: 43, resetsAt: r, now: NOW });
  b = updateBlame(b, { session: "a", cost: 1.5, pct: 44, resetsAt: r, now: NOW });
  assert.equal(b.sessions.a.spent + b.sessions.a.cost - b.sessions.a.base, 4);
  assert.deepEqual(blameShares(b, 44).map((s) => s.pct), [4]);
});

test("blame: a new week starts from zero", () => {
  let b = updateBlame(null, { session: "a", cost: 1, pct: 80, resetsAt: inHours(1), now: NOW });
  b = updateBlame(b, { session: "a", cost: 9, pct: 3, resetsAt: inHours(169), now: NOW + 2 * H });
  assert.equal(b.startPct, 3);
  assert.deepEqual(blameShares(b, 3), []);
});

const reading = (five, seven, sevenResets = inHours(72)) => ({
  five_hour: { usedPct: five, resetsAt: inHours(3), seenAt: 0 },
  seven_day: { usedPct: seven, resetsAt: sevenResets, seenAt: 0 },
});

test("tracking: a point when the % moves or an hour passed, not on every render", () => {
  let u = readUsage(sandbox().env);
  let r = trackReading(u, reading(10, 40), { now: NOW });
  assert.equal(r.changed, true);
  u = r.usage;
  r = trackReading(u, reading(10, 40), { now: NOW + 60_000 });
  assert.equal(r.changed, false, "same % a minute later: nothing to save");
  r = trackReading(u, reading(10, 41), { now: NOW + 120_000 });
  assert.equal(r.changed, true);
  assert.equal(r.usage.windows.seven_day.pts.length, 2);
  r = trackReading(r.usage, reading(10, 41), { now: NOW + 2 * H });
  assert.equal(r.usage.windows.seven_day.pts.length, 3, "an idle hour is a point too");
});

test("tracking: cost alone is saved only when it moved by 10 cents", () => {
  let { usage } = trackReading(readUsage(sandbox().env), reading(10, 40), { session: "s", cost: 1, now: NOW });
  assert.equal(trackReading(usage, reading(10, 40), { session: "s", cost: 1.05, now: NOW + 1000 }).changed, false);
  const r = trackReading(usage, reading(10, 40), { session: "s", cost: 1.2, now: NOW + 2000 });
  assert.equal(r.changed, true);
  assert.equal(r.usage.blame.sessions.s.cost, 1.2);
});

test("tracking: a new week files the last one under history", () => {
  let { usage } = trackReading(readUsage(sandbox().env), reading(10, 90, inHours(1)), { now: NOW });
  usage = trackReading(usage, reading(10, 3, inHours(169)), { now: NOW + 2 * H }).usage;
  assert.equal(usage.weeks.length, 1);
  assert.equal(usage.weeks[0].resetsAt, inHours(1));
  assert.deepEqual(usage.windows.seven_day.pts, [[NOW + 2 * H, 3]]);
});

test("tracking: saved and read back; a damaged file starts over", () => {
  const { env } = sandbox();
  writeUsage(env, trackReading(readUsage(env), reading(10, 40), { now: NOW }).usage);
  assert.equal(readUsage(env).windows.seven_day.pts.length, 1);
  fs.writeFileSync(usageFile(env), "{torn");
  assert.deepEqual(readUsage(env).windows, {});
  const f = forecasts({ windows: { seven_day: { resetsAt: inHours(72), pts: [pt(30, 40), pt(10, 60)] } } }, { seven_day: live(70) }, NOW);
  assert.equal(f.seven_day.ratePerHour, 1);
});

test("history: each week's peak, when each line was crossed, and when it hit the wall", () => {
  const usage = {
    weeks: [{ resetsAt: inHours(-24), pts: [pt(100, 60), pt(90, 76), pt(50, 100)] }],
    windows: { seven_day: { resetsAt: inHours(144), pts: [pt(2, 5)] } },
  };
  const weeks = weeklyHistory(usage, [{ kind: "window", window: "seven_day", at: 75, action: "warn" }]);
  assert.equal(weeks.length, 2);
  assert.equal(weeks[0].peak, 100);
  assert.equal(weeks[0].wall, NOW - 50 * H);
  assert.deepEqual(weeks[0].crossed.map((c) => [c.at, c.t]), [[75, NOW - 90 * H]]);
  assert.equal(weeks[1].peak, 5);
  assert.equal(weeks[1].wall, null);
});
