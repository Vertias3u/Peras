import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Every throwaway folder goes when this test file's process ends: thousands of runs add up.
const made = [];
process.on("exit", () => {
  for (const dir of made) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {
      // A test that made something read-only: make it writable and try once more.
      try { fs.chmodSync(dir, 0o700); for (const f of fs.readdirSync(dir, { recursive: true })) fs.chmodSync(path.join(dir, f), 0o700); fs.rmSync(dir, { recursive: true, force: true }); } catch { /* left for the system to clear */ }
    }
  }
});
/** A new empty folder in the system's temp directory, removed when the process exits. */
export function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
}

/** A throwaway PERAS_HOME and Claude config dir, never the real ones. */
export function sandbox() {
  const root = tempDir("peras-test-");
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

/** This checkout's version, as `peras setup` records it. */
export const VERSION = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
