import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { pauseNow, resume, perasHome, readJson, writeJsonAtomic } from "./store.mjs";
import { codexEnv, cachePath } from "./codex.mjs";
import { recordEvent } from "./events.mjs";
import { hookConfigurationFingerprint } from "./hook-health.mjs";

export function readProtectionTest(env) {
  try {
    const result = readJson(path.join(perasHome(env), "protection-test.json"));
    return result && Number.isFinite(result.at) && typeof result.passed === "boolean" && Array.isArray(result.providers) && result.providers.every(row => row && typeof row.provider === "string" && typeof row.passed === "boolean" && typeof row.message === "string") ? result : null;
  } catch { return null; }
}
export function runProtectionTest(env, now = Date.now()) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "peras-protection-"));
  const isolated = { ...env, HOME: root, PERAS_HOME: path.join(root, "peras"), CLAUDE_CONFIG_DIR: path.join(root, "claude"), CODEX_HOME: path.join(root, "codex"), PERAS_PROVIDER: "claude", PERAS_NO_NOTIFY: "1" };
  const bin = fileURLToPath(new URL("../bin/peras.mjs", import.meta.url));
  const providers = [];
  try {
    for (const provider of ["claude", "codex"]) {
      const scoped = provider === "codex" ? codexEnv(isolated) : isolated;
      const configuration = hookConfigurationFingerprint(provider === "codex" ? codexEnv(env) : env);
      writeJsonAtomic(cachePath(isolated), { at: Date.now(), reading: {} });
      const input = JSON.stringify({ hook_event_name: "PreToolUse", session_id: "peras-protection-test", cwd: root, tool_name: "Bash", ...(provider === "codex" ? { turn_id: "peras-protection-test" } : {}) });
      const invoke = () => {
        const result = spawnSync(process.execPath, [bin, provider === "codex" ? "codex-hook" : "hook"], { env: isolated, cwd: root, input, encoding: "utf8", timeout: 8000, maxBuffer: 256 * 1024 });
        if (result.error || result.status !== 0) throw Error(result.error?.message || `Hook exited ${result.status}: ${result.stderr.slice(0, 200)}`);
        const output = result.stdout.trim() ? JSON.parse(result.stdout) : null;
        if (output?.systemMessage && /could not/i.test(output.systemMessage)) throw Error(output.systemMessage);
        return output?.hookSpecificOutput?.permissionDecision === "deny";
      };
      try {
        if (invoke()) throw Error("Unpaused hook unexpectedly denied the action.");
        pauseNow(scoped);
        if (!invoke()) throw Error("Paused hook did not deny the action.");
        resume(scoped);
        if (invoke()) throw Error("Resumed hook still denied the action.");
        providers.push({ provider, passed: true, configuration, message: "Unpaused allowed · paused denied · resumed allowed" });
      } catch (error) { providers.push({ provider, passed: false, configuration, message: error.message }); }
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
  const result = { at: now, passed: providers.every(row => row.passed), providers };
  writeJsonAtomic(path.join(perasHome(env), "protection-test.json"), result);
  recordEvent(env, { provider: "peras", kind: "test", at: now, message: `Protection self-test ${result.passed ? "passed" : "failed"}. Uses isolated state; live hook activation is reported separately.` });
  return result;
}
