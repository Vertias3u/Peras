import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** A throwaway PERAS_HOME and Claude config dir, never the real ones. */
export function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "peras-test-"));
  const home = path.join(root, "peras");
  const claude = path.join(root, "claude");
  fs.mkdirSync(claude, { recursive: true });
  const env = { PERAS_HOME: home, CLAUDE_CONFIG_DIR: claude, PERAS_NO_NOTIFY: "1", PATH: process.env.PATH, HOME: root };
  return { root, home, claude, env };
}

export const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);
export const inHours = (h) => Math.floor((NOW + h * 3600_000) / 1000);

/** Claude Code's status-line input carrying a usage window. */
export function statusInput({ fiveHour, sevenDay, fiveResets = inHours(3), sevenResets = inHours(72) } = {}) {
  const rate_limits = {};
  if (fiveHour !== undefined) rate_limits.five_hour = { used_percentage: fiveHour, resets_at: fiveResets };
  if (sevenDay !== undefined) rate_limits.seven_day = { used_percentage: sevenDay, resets_at: sevenResets };
  return {
    session_id: "s-1",
    model: { id: "claude-opus-5-5", display_name: "Opus" },
    workspace: { current_dir: "/tmp/x" },
    ...(Object.keys(rate_limits).length ? { rate_limits } : {}),
  };
}
