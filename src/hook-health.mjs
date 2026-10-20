import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { perasHome, claudeDir, dirKey, readJson, writeJsonAtomic } from "./store.mjs";
import { resetTime } from "./window.mjs";

const file = (env) => path.join(perasHome(env), "health", `${env.PERAS_PROVIDER === "codex" ? "codex" : "claude"}-${dirKey(env)}.json`);
const config = (env) => path.join(claudeDir(env), env.PERAS_PROVIDER === "codex" ? "hooks.json" : "settings.json");
export function hookConfigurationFingerprint(env) {
  try {
    const hash = createHash("sha256").update(fs.readFileSync(config(env)));
    const toml = path.join(claudeDir(env), "config.toml");
    if (env.PERAS_PROVIDER === "codex" && fs.existsSync(toml)) hash.update(fs.readFileSync(toml));
    return hash.digest("hex");
  } catch { return null; }
}
export function recordHookRun(env, event, now) {
  if (event !== "PreToolUse") return;
  try { writeJsonAtomic(file(env), { at: now, fingerprint: hookConfigurationFingerprint(env) }); } catch { /* Health reporting cannot interfere with guarding tools. */ }
}
export function hookHealth(env, provider, now) {
  const codex = provider === "codex";
  const scoped = codex ? { ...env, CLAUDE_CONFIG_DIR: env.CODEX_HOME || path.join(env.HOME || os.homedir(), ".codex"), PERAS_PROVIDER: "codex" } : env;
  let settings, receipt;
  try { settings = readJson(config(scoped)); receipt = readJson(file(scoped)); } catch { return { label: "Setup missing", detail: "The hook configuration could not be read. Run the provider's setup." }; }
  if (settings?.disableAllHooks === true) return { label: "Hooks disabled", detail: "Claude's disableAllHooks setting is enabled." };
  if (codex) {
    const toml = path.join(claudeDir(scoped), "config.toml");
    const text = fs.existsSync(toml) ? fs.readFileSync(toml, "utf8") : "";
    const features = text.match(/^\[features\]\s*\n([\s\S]*?)(?=^\[|$(?![\s\S]))/m)?.[1] || "";
    if (/^\s*(?:hooks|codex_hooks)\s*=\s*false\s*(?:#.*)?$/m.test(features)) return { label: "Hooks disabled", detail: "Codex's hooks feature is disabled in config.toml." };
  }
  const wired = settings?.hooks?.PreToolUse?.some((group) => group.hooks?.some((hook) => typeof hook.command === "string" && (codex ? /peras\.mjs"? codex-hook\b/ : /peras\.mjs"? hook\b/).test(hook.command)));
  if (!wired) return { label: "Setup missing", detail: `Run peras ${codex ? "codex " : ""}setup to install the correct tool guard.` };
  const commands = settings.hooks.PreToolUse.flatMap(g => g.hooks || []).filter(h => /peras\.mjs/.test(h.command || ""));
  for (const hook of commands) {
    const paths = hook.command.match(/^(?:PERAS_STRICT=1 )?"([^"]+)"\s+"([^"]+)"/);
    if (paths && (!fs.existsSync(paths[1]) || !fs.existsSync(paths[2]))) return { label: "Setup missing", detail: "The Peras hook runtime is missing. Run setup again." };
  }
  const configuration = hookConfigurationFingerprint(scoped);
  if (receipt?.fingerprint === configuration && Number.isFinite(receipt.at)) {
    const recent = now - receipt.at <= 15 * 60_000 && now >= receipt.at;
    if (!recent) {
      let test;
      try { test = readJson(path.join(perasHome(env), "protection-test.json")); } catch { /* Ignore unreadable results. */ }
      const passed = Array.isArray(test?.providers) && test.providers.find(row => row?.provider === provider && row.passed === true && row.configuration === configuration);
      if (passed && Number.isFinite(test.at) && now >= test.at && now - test.at <= 15 * 60_000) {
        return { label: "Protection active", at: receipt.at, detail: `Protection self-test passed ${resetTime(test.at / 1000, now)}. Last live tool guard: ${resetTime(receipt.at / 1000, now)}. The self-test checks pause/resume logic, not activation in every open session.` };
      }
    }
    return { label: recent ? "Protection active" : "Not recently verified", at: receipt.at, detail: `A tool guard ran ${resetTime(receipt.at / 1000, now)}. This confirms a hook execution, not protection in every open session.` };
  }
  return { label: codex ? "Needs trust / activation" : "Needs activation", detail: codex ? "Review and trust Peras in /hooks, restart the session, then make a tool call to verify protection." : "Restart Claude Code and make a tool call to verify protection." };
}
