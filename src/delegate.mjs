import { codexEnv } from "./codex.mjs";
import { describe, spawnOnly } from "./hook.mjs";
import { context, readState } from "./store.mjs";
import { evaluate } from "./rules.mjs";
import { readUsage } from "./usage.mjs";
import { WINDOWS } from "./window.mjs";

const SHELLS = new Set(["Bash", "exec", "shell", "exec_command", "local_shell"]);
const VALUE_FLAGS = new Set(["-m", "--model", "-c", "--config", "-C", "--cd", "-s", "--sandbox", "-a", "--ask-for-approval", "-p", "--profile", "--add-dir", "--enable", "--disable", "-i", "--image"]);
const unquote = word => word.replace(/^(["'])(.*)\1$/, "$2");

// Keep quoted text together, including separators in prompts. This deliberately
// recognizes direct commands only: aliases and wrapper scripts are out of scope.
function commandParts(command) {
  const tokens = command.match(/#[^\n]*|(?:[^\s;&|"'\\]+|\\[\s\S]|"(?:\\.|[^"\\])*"|'[^']*')+|&&|\|\||[;|\n]/g) ?? [];
  const parts = [[]];
  for (const token of tokens) {
    if (token.startsWith("#")) continue;
    if (/^(?:&&|\|\||[;|\n])$/.test(token)) parts.push([]);
    else parts[parts.length - 1].push(token);
  }
  return parts;
}

/** The other CLI a direct shell command starts, without executing anything. */
export function delegateTarget(provider, toolName, toolInput) {
  if (provider === "claude" ? toolName !== "Bash" : provider !== "codex" || !SHELLS.has(toolName)) return null;
  const raw = toolInput?.command ?? toolInput?.cmd;
  const argv = Array.isArray(raw) && raw.every(s => typeof s === "string") ? raw : null;
  // Codex's local_shell can supply argv for a shell rather than command text. Plain argv is one
  // command as given: its words are never shell syntax.
  const shell = argv && /^(?:.*\/)?(?:bash|sh|zsh)$/.test(argv[0]) && ["-c", "-lc"].includes(argv[1]) && typeof argv[2] === "string";
  const parts = typeof raw === "string" ? commandParts(raw) : shell ? commandParts(argv[2]) : argv ? [[...argv]] : [];
  for (const part of parts) {
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(part[0] ?? "")) part.shift();
    const executable = unquote(part.shift() ?? "").split("/").pop();
    if (provider === "codex" && executable === "claude" && part.some(word => ["-p", "--print"].includes(unquote(word)))) return "claude";
    if (provider !== "claude" || executable !== "codex") continue;
    while (part.length) {
      const word = unquote(part.shift());
      if (word === "exec" || word === "e") return "codex";
      if (!word.startsWith("-")) break;
      if (VALUE_FLAGS.has(word)) part.shift();
    }
  }
  return null;
}

/** Read the callee's saved verdict only. Its broken files must never stop the caller. */
export function withDelegation(output, { provider, input, env, now }) {
  if (input?.hook_event_name !== "PreToolUse" || output?.continue === false || output?.decision === "block" || ["deny", "ask"].includes(output?.hookSpecificOutput?.permissionDecision)) return output;
  const target = delegateTarget(provider, input.tool_name, input.tool_input);
  if (!target) return output;
  try {
    const scoped = target === "codex" ? codexEnv(env) : env;
    const state = readState(scoped, now, { strict: true });
    const ctx = context(scoped, { now, cwd: input.cwd, state, usage: readUsage(scoped) });
    // This starts a new target session in the caller's folder, with no old prompt or spawns.
    const verdict = evaluate(ctx);
    const label = target === "codex" ? "Codex" : "Claude Code";
    if (["pause", "ask"].includes(verdict.action) && !spawnOnly(verdict.hit)) {
      const d = describe(verdict.hit, now);
      return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `${label} is paused: ${d.what}. ${d.lifts}. Stop and tell the user why.` } };
    }
    const hit = verdict.hits.find(h => h.action === "warn" && !spawnOnly(h));
    if (!hit) return output;
    const fact = hit.kind === "window" ? `${WINDOWS[hit.window].name} ${Math.round(hit.usedPct)}%` : describe(hit, now).short;
    return { ...(output ?? {}), systemMessage: [output?.systemMessage, `${label}: ${fact}.`].filter(Boolean).join("\n") };
  } catch {
    return output;
  }
}
