// Colour and bars, shared by `peras status`, the status line and the menu bar.
// Colour follows your own lines: red past a pause or ask line, yellow past a warn line.

const CODES = { red: 31, yellow: 33, green: 32, dim: 2, bold: 1 };

/** NO_COLOR (no-color.org) or PERAS_COLOR=0 turns colour off everywhere. */
export const colorOn = (env = process.env, isTTY = true) => isTTY && !env.NO_COLOR && env.PERAS_COLOR !== "0";

export const paint = (on, tone, text) => (on && CODES[tone] ? `\u001b[${CODES[tone]}m${text}\u001b[0m` : text);

export const stripAnsi = (s) => String(s).replace(/\u001b\[[0-9;]*m/g, "");

/** red / yellow / green for a window's %, by the lowest line of each kind on that window. */
export function toneFor(window, pct, rules) {
  const lines = rules.filter((r) => r.kind === "window" && r.window === window && !r.off);
  const lowest = (actions) => Math.min(...lines.filter((r) => actions.includes(r.action)).map((r) => r.at));
  if (pct >= lowest(["pause", "ask"])) return "red";
  if (pct >= lowest(["warn"])) return "yellow";
  return "green";
}

/** ▰▰▰▰▰▱▱▱▱▱ */
export function bar(pct, width = 10) {
  const full = Math.max(0, Math.min(width, Math.round((pct / 100) * width)));
  return "▰".repeat(full) + "▱".repeat(width - full);
}

export const MARK = { pause: "⏸️ paused", ask: "✋ asks", warn: "⚠️" };
