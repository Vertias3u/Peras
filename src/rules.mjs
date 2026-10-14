import { WINDOWS } from "./window.mjs";

export const ACTIONS = ["warn", "ask", "pause"];
const RANK = { none: 0, warn: 1, ask: 2, pause: 3 };

// D1 (2026-10-14): weekly 75% → warn, weekly 90% → pause, 5-hour 95% → warn.
export const DEFAULT_RULES = [
  { window: "seven_day", at: 75, action: "warn" },
  { window: "seven_day", at: 90, action: "pause" },
  { window: "five_hour", at: 95, action: "warn" },
];

const ALIASES = { "5h": "five_hour", "5-hour": "five_hour", five_hour: "five_hour", weekly: "seven_day", "7d": "seven_day", week: "seven_day", seven_day: "seven_day" };

export function windowName(word) {
  return ALIASES[String(word).toLowerCase()] ?? null;
}

export function validRules(rules) {
  if (!Array.isArray(rules)) return DEFAULT_RULES;
  return rules.filter(
    (r) => r && WINDOWS[r.window] && ACTIONS.includes(r.action) && typeof r.at === "number" && r.at >= 0 && r.at <= 100
  );
}

/** One rule per window and action: `at` replaces it, `null` removes it. */
export function setRule(rules, window, action, at) {
  if (!WINDOWS[window]) throw new Error(`Unknown window "${window}". Use 5h or weekly.`);
  if (!ACTIONS.includes(action)) throw new Error(`Unknown action "${action}". Use warn, ask or pause.`);
  if (at !== null && !(typeof at === "number" && at > 0 && at <= 100)) throw new Error("A line is a percentage from 1 to 100.");
  const rest = rules.filter((r) => !(r.window === window && r.action === action));
  return at === null ? rest : [...rest, { window, at, action }];
}

/**
 * What the live window calls for. Every rule crossed is a hit; the strongest
 * action wins. A hit's `key` names that line in this window instance (its reset),
 * so a resume, a notification or an ask is remembered for this window, never the next.
 */
export function evaluate(window, rules, { resumed = [] } = {}) {
  const hits = [];
  for (const rule of validRules(rules)) {
    const w = window?.[rule.window];
    if (!w || w.usedPct < rule.at) continue;
    // Per line, not per window: resuming a 70% pause must not silence a 90% one.
    const key = `${rule.window}:${rule.at}:${rule.action}@${w.resetsAt}`;
    if (rule.action !== "warn" && resumed.includes(key)) continue;
    hits.push({ ...rule, usedPct: w.usedPct, resetsAt: w.resetsAt, key });
  }
  hits.sort((a, b) => RANK[b.action] - RANK[a.action] || b.at - a.at);
  return { action: hits[0]?.action ?? "none", hit: hits[0] ?? null, hits };
}
