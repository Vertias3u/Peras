// What happens when Peras cannot answer a tool call. Default: the call goes ahead
// and you are told (D3). Strict, Claude Code only: the call is blocked. Codex has
// no strict mode: its hooks let a tool run after a failed or timed-out check.
import { spawnSync } from "node:child_process";
import { readInstall } from "./store.mjs";
import { inspect, install } from "./settings.mjs";

export const STRICT_MIN = "2.1.295";

const parts = (v) => String(v ?? "").match(/(\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number) ?? null;
/** True when `version` is at least STRICT_MIN; null when it can't be read. */
export function strictCapable(version) {
  const v = parts(version), min = parts(STRICT_MIN);
  if (!v) return null;
  for (let i = 0; i < 3; i++) if (v[i] !== min[i]) return v[i] > min[i];
  return true;
}

/** Claude Code's version from `claude --version`, or null. Never called by hooks or the bridge. */
export function claudeCodeVersion(env = process.env) {
  const run = spawnSync("claude", ["--version"], { env, encoding: "utf8", timeout: 10_000 });
  return run.status === 0 ? parts(run.stdout)?.join(".") ?? null : null;
}

/**
 * The policy as installed and what this Claude Code can do, from files only.
 * strict: supported | requires_upgrade | unknown (not checked yet) | unsupported.
 */
export function failurePolicy(env, provider = "claude") {
  if (provider !== "claude" || process.platform === "win32") return { mode: "default", strict: "unsupported" };
  let mode = "default";
  try { if (inspect(env).strict) mode = "strict"; } catch { /* unreadable settings: not strict */ }
  const version = readInstall(env)?.claudeVersion;
  const capable = strictCapable(version);
  return { mode, strict: capable === null ? "unknown" : capable ? "supported" : "requires_upgrade", ...(version ? { claudeVersion: version } : {}) };
}

export class PolicyError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/** Turns strict on or off by rewriting Peras's own hooks. Checks the version first; writes nothing when it can't. */
export function setFailurePolicy(env, policy, { version } = {}) {
  const record = readInstall(env);
  if (!record?.command) throw new PolicyError("setup_missing", "Run peras setup first.");
  if (policy === "strict") {
    if (process.platform === "win32") throw new PolicyError("unsupported", "Strict mode needs macOS or Linux.");
    const capable = strictCapable(version);
    if (!capable) throw new PolicyError(capable === null ? "unknown_version" : "requires_upgrade", capable === null ? `Peras could not read your Claude Code version. Strict mode needs Claude Code ${STRICT_MIN} or later.` : `Strict mode needs Claude Code ${STRICT_MIN} or later; this is ${version}. Update Claude Code, then try again.`);
  }
  install({ env, command: record.command, resumeHint: record.resumeHint, version: record.version, failurePolicy: policy, ...(version ? { claudeVersion: version } : {}) });
  return failurePolicy(env);
}
