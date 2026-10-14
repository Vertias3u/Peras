import { spawnSync } from "node:child_process";
import { WINDOWS, liveWindow, readingFrom, windowText } from "./window.mjs";
import { DEFAULT_RULES, evaluate } from "./rules.mjs";
import { readInstall, readRules, readState, readWindow, recordReading } from "./store.mjs";

// Claude Code allows one status-line command, and it is the only place the usage
// window arrives. So Peras's status line saves the window, then, when the user
// already had a status line, runs theirs with the exact same stdin and prints its
// output untouched, adding a marker in front only when a line is crossed.

const CHAIN_TIMEOUT_MS = 8000;
const MARK = { pause: "⏸ paused", ask: "✋ asks", warn: "⚠" };

function safe(fn, fallback) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/**
 * @param {{ stdin: Buffer, env?: object, now?: number }} options
 * @returns {{ stdout: Buffer | string, code: number }}
 */
export function runStatusline({ stdin, env = process.env, now = Date.now() }) {
  const input = safe(() => JSON.parse(stdin.toString("utf8")), null);
  safe(() => recordReading(env, readingFrom(input, now)));

  const live = liveWindow(safe(() => readWindow(env), null), now);
  const rules = safe(() => readRules(env), DEFAULT_RULES);
  const { action, hit } = evaluate(live, rules, { resumed: safe(() => readState(env, now).resumed, []) });

  const chain = readInstall(env)?.statusLine;
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
    const marker = `🍐 ${MARK[action]} · ${WINDOWS[hit.window].label} ${Math.round(hit.usedPct)}%`;
    const ok = run.status === 0 && theirs.length > 0;
    return { stdout: ok ? `${marker} · ${theirs.toString("utf8")}` : marker, code: 0 };
  }

  const text = windowText(live, { now });
  if (!text) return { stdout: "🍐 no usage window yet", code: 0 };
  return { stdout: `🍐 ${action === "none" ? "" : `${MARK[action]} · `}${text}`, code: 0 };
}
