// The week that just ended, told once beside the reset greeting: how far it got
// and how often Peras paused. Only a week Peras saw roll over counts (a reset
// time passing proves nothing), and every number is a saved reading or event.
import { weeklyReview } from "./review.mjs";
import { eventsCoverSince, recentEvents } from "./events.mjs";

const WEEK = 7 * 86400_000;
// How long after the reset the recap is offered. The app shows each id once.
export const RECAP_MS = 3 * 86400_000;
// A last reading this close to the reset is the week's end, not a guess at it.
const AT_RESET_MS = 3600_000;

/**
 * The provider's last completed week, or null outside the days after its reset.
 * `pauses` is null when the kept event history doesn't reach back to the week's start.
 */
export function weekRecap(env, usage, provider, now) {
  const weeks = (usage?.weeks ?? []).filter((w) => Number.isFinite(w?.resetsAt));
  const latest = weeks.reduce((a, w) => (!a || w.resetsAt > a.resetsAt ? w : a), null);
  if (!latest) return null;
  const end = latest.resetsAt * 1000;
  if (end > now || now - end >= RECAP_MS) return null;
  const [week] = weeklyReview({ weeks: [latest] }, [], provider, now);
  if (!week) return null;
  const events = recentEvents(env, Infinity);
  const pauses = eventsCoverSince(env, events) <= end - WEEK
    ? events.filter((e) => e.provider === provider && e.kind === "pause" && e.at >= end - WEEK && e.at < end).length
    : null;
  const used = week.pts.at(-1)[1];
  return {
    id: `${provider}:${latest.resetsAt}`,
    weekEndedAtMs: end,
    usedPercent: Math.round(used * 10) / 10,
    lastReadingAtMs: week.lastAt,
    atReset: end - week.lastAt <= AT_RESET_MS,
    pauses,
    untilMs: end + RECAP_MS,
  };
}
