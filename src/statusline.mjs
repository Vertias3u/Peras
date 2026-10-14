import { spawnSync } from "node:child_process";
import { WINDOWS, liveWindow, readingFrom, resetTime } from "./window.mjs";
import { DEFAULT_RULES, evaluate } from "./rules.mjs";
import { context, readInstall, readState, recordReading } from "./store.mjs";
import { readUsage, trackReading, writeUsage } from "./usage.mjs";
import { etaTo } from "./forecast.mjs";
import { blameShares } from "./blame.mjs";
import { MARK, colorOn, paint, toneFor } from "./look.mjs";

// Claude Code allows one status-line command, and it is the only place the usage
// window arrives. So Peras's status line saves the window, then, when the user
// already had a status line, runs theirs with the exact same stdin and prints its
// output untouched, adding a marker in front only when a line is crossed.

const CHAIN_TIMEOUT_MS = 8000;

function safe(fn, fallback) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/** The folder the session works in, as the hook sees it (`cwd`) and the status line does. */
export const sessionDir = (input) => input?.workspace?.project_dir ?? input?.workspace?.current_dir ?? input?.cwd ?? null;

/**
 * @param {{ stdin: Buffer, env?: object, now?: number }} options
 * @returns {{ stdout: Buffer | string, code: number }}
 */
export function runStatusline({ stdin, env = process.env, now = Date.now() }) {
  const input = safe(() => JSON.parse(stdin.toString("utf8")), null);
  const reading = readingFrom(input, now);
  safe(() => recordReading(env, reading));
  const session = typeof input?.session_id === "string" ? input.session_id : null;
  const dir = sessionDir(input);
  const cost = input?.cost?.total_cost_usd;
  const usage = safe(() => {
    const tracked = trackReading(readUsage(env), reading, { session, cost, dir, now });
    if (tracked.changed) writeUsage(env, tracked.usage);
    return tracked.usage;
  }, null);

  const state = safe(() => readState(env, now), null);
  const ctx = safe(() => context(env, { now, cwd: dir, session, state: state ?? undefined, usage }), null);
  const live = ctx?.window ?? liveWindow(null, now);
  const rules = ctx?.rules ?? DEFAULT_RULES;
  const { action, hit } = ctx ? evaluate(ctx) : { action: "none", hit: null };
  const color = colorOn(env);

  const chain = safe(() => readInstall(env)?.statusLine, null);
  if (chain && typeof chain.command === "string" && chain.command) {
    const run = spawnSync(chain.command, {
      shell: true,
      input: stdin,
      env,
      timeout: CHAIN_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });
    const theirs = run.stdout ?? Buffer.alloc(0);
    if (action === "none") return { stdout: theirs, code: run.status ?? 0 };
    // Kept short: a long marker in front of a full status line wraps.
    const where = hit.window ? ` ${WINDOWS[hit.window].label} ${Math.round(hit.usedPct)}%` : "";
    const marker = paint(color, action === "warn" ? "yellow" : "red", `🍐 ${MARK[action]}${where}`);
    const ok = run.status === 0 && theirs.length > 0;
    return { stdout: ok ? `${marker} · ${theirs.toString("utf8")}` : marker, code: 0 };
  }

  const parts = Object.entries(WINDOWS)
    .filter(([name]) => live[name])
    .map(([name, { label }]) => {
      const pct = Math.round(live[name].usedPct);
      const full = etaTo(ctx?.forecast?.[name], 100);
      const text = `${label} ${pct}%${full ? ` (full ${resetTime(full / 1000, now)})` : ""}`;
      return paint(color, toneFor(name, pct, rules), text);
    });
  if (!parts.length) return { stdout: "🍐 no usage window yet", code: 0 };
  const mine = session && live.seven_day ? blameShares(usage?.blame, live.seven_day.usedPct).find((s) => s.session === session) : null;
  if (mine && mine.pct >= 0.5) parts.push(paint(color, "dim", `this chat ≈+${mine.pct}%`));
  const mark = action === "none" ? "" : `${paint(color, action === "warn" ? "yellow" : "red", MARK[action])} · `;
  return { stdout: `🍐 ${mark}${parts.join(" · ")}`, code: 0 };
}
