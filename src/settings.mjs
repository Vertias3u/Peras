import fs from "node:fs";
import path from "node:path";
import { claudeDir, readInstall, writeInstall, installFile } from "./store.mjs";

// Peras writes into Claude Code's USER settings: three command hooks and the
// status line. It never touches the login, the env, or ANTHROPIC_BASE_URL, so
// Remote Control keeps working. `uninstall` takes out exactly what `install` put in.

const EVENTS = ["UserPromptSubmit", "PreToolUse", "PostToolBatch"];
// Short: a hook that times out lets the action go ahead (D3, fail open).
const HOOK_TIMEOUT_S = 10;
const OURS = /peras\.mjs"?\s+(hook|statusline)(\s+\|\|.*)?$/;

// If node itself cannot start (moved, upgraded away), the command exits 127 and
// Claude Code lets the action go ahead without a word. The fallback makes it say so.
const FIX = "Peras could not run (is node still where setup found it?): run peras setup again";
const withFallback = (command, text) => (process.platform === "win32" ? command : `${command} || echo '${text}'`);
const hookCommand = (command) => withFallback(`${command} hook`, JSON.stringify({ systemMessage: FIX }));
const statusCommand = (command) => withFallback(`${command} statusline`, `🍐 ${FIX}`);

export const settingsPath = (env = process.env) => path.join(claudeDir(env), "settings.json");
export const isPerasCommand = (command) => typeof command === "string" && OURS.test(command);

const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const isOurHook = (h) => isObject(h) && h.type === "command" && isPerasCommand(h.command);
const hasOurHook = (g) => isObject(g) && Array.isArray(g.hooks) && g.hooks.some(isOurHook);

function readSettings(target) {
  if (!fs.existsSync(target)) return { exists: false, value: {} };
  const text = fs.readFileSync(target, "utf8");
  if (!text.trim()) return { exists: true, value: {} };
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${target} is not valid JSON; fix it, then run this again. Nothing was written.`);
  }
  if (!isObject(value)) throw new Error(`${target} is not a JSON object; nothing was written.`);
  return { exists: true, value };
}

function save(target, value) {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const mode = fs.existsSync(target) ? fs.statSync(target).mode & 0o777 : 0o600;
  const tmp = `${target}.peras-${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode });
  fs.renameSync(tmp, target);
}

function ourGroups(command) {
  const hook = { type: "command", command: hookCommand(command), timeout: HOOK_TIMEOUT_S };
  return {
    UserPromptSubmit: { hooks: [hook] },
    PreToolUse: { matcher: "*", hooks: [hook] },
    PostToolBatch: { hooks: [hook] },
  };
}

function withoutOurHooks(hooks) {
  if (!isObject(hooks)) return hooks;
  const next = {};
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) {
      next[event] = groups;
      continue;
    }
    const kept = [];
    for (const group of groups) {
      if (!hasOurHook(group)) {
        kept.push(group);
        continue;
      }
      const rest = group.hooks.filter((h) => !isOurHook(h));
      if (rest.length) kept.push({ ...group, hooks: rest });
    }
    if (kept.length) next[event] = kept;
  }
  return next;
}

function withOurHooks(hooks, command) {
  const ours = ourGroups(command);
  const base = isObject(hooks) ? hooks : {};
  const next = withoutOurHooks(base);
  for (const event of EVENTS) {
    const current = Array.isArray(base[event]) ? base[event] : [];
    const already = current.filter(hasOurHook);
    // Already right: leave it where it is, so a second setup changes nothing.
    if (already.length === 1 && same(already[0], ours[event])) next[event] = current;
    else next[event] = [...(next[event] ?? []), ours[event]];
  }
  return next;
}

const hasPerasParts = (value) =>
  isPerasCommand(value.statusLine?.command) || (isObject(value.hooks) && Object.values(value.hooks).some((g) => Array.isArray(g) && g.some(hasOurHook)));

/**
 * @param {{ env?: object, command: string, resumeHint?: string, version?: string }} options
 *   `command` runs Peras: `"<node>" "<home>/.peras/app/bin/peras.mjs"`.
 */
export function install({ env = process.env, command, resumeHint = "peras resume", version = "" }) {
  const target = settingsPath(env);
  const { exists, value } = readSettings(target);
  const record = readInstall(env);

  let original = record?.statusLine ?? null;
  let statusLine;
  const current = value.statusLine;
  if (isObject(current) && isPerasCommand(current.command)) {
    statusLine = { ...current, command: statusCommand(command) };
  } else if (isObject(current) && typeof current.command === "string" && current.command) {
    original = current;
    statusLine = { ...current, type: "command", command: statusCommand(command) };
  } else {
    original = null;
    statusLine = { type: "command", command: statusCommand(command) };
  }

  const next = { ...value, hooks: withOurHooks(value.hooks, command), statusLine };
  writeInstall(env, { settingsPath: target, statusLine: original, command, resumeHint, version });

  // The file as it was before this round of Peras, kept once: a second setup
  // must not back up its own output over the user's original.
  const backupPath = `${target}.peras-backup`;
  if (exists && !hasPerasParts(value)) fs.copyFileSync(target, backupPath);

  const changed = !same(next, value);
  if (changed) save(target, next);
  return {
    target,
    changed,
    backupPath: fs.existsSync(backupPath) ? backupPath : null,
    chained: original?.command ?? null,
    hooksDisabled: value.disableAllHooks === true,
  };
}

/** Takes out Peras's hooks and status line, putting back the status line it wrapped. */
export function uninstall({ env = process.env }) {
  const target = settingsPath(env);
  if (!fs.existsSync(target)) {
    fs.rmSync(installFile(env), { force: true });
    return { target, changed: false, restored: null };
  }
  const { value } = readSettings(target);
  const record = readInstall(env);
  const next = { ...value };

  if (isObject(value.hooks)) {
    const hooks = withoutOurHooks(value.hooks);
    if (Object.keys(hooks).length) next.hooks = hooks;
    else delete next.hooks;
  }
  let restored = null;
  if (isPerasCommand(value.statusLine?.command)) {
    if (isObject(record?.statusLine)) {
      next.statusLine = record.statusLine;
      restored = record.statusLine.command;
    } else delete next.statusLine;
  }

  const changed = !same(next, value);
  if (changed) save(target, next);
  fs.rmSync(installFile(env), { force: true });
  return { target, changed, restored };
}

/** What Peras finds in the settings, for `status` and `doctor`. */
export function inspect(env = process.env) {
  const target = settingsPath(env);
  const { value } = readSettings(target);
  const events = EVENTS.filter((e) => Array.isArray(value.hooks?.[e]) && value.hooks[e].some(hasOurHook));
  return {
    target,
    events,
    missingEvents: EVENTS.filter((e) => !events.includes(e)),
    statusLine: isPerasCommand(value.statusLine?.command),
    hooksDisabled: value.disableAllHooks === true,
  };
}
