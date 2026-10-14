import { WINDOWS, resetTime } from "./window.mjs";
import { evaluate, realDir } from "./rules.mjs";
import { context, readInstall, readState, writeState } from "./store.mjs";
import { readUsage } from "./usage.mjs";
import { recordHookRun } from "./hook-health.mjs";
import { preferences } from "./preferences.mjs";
import { recordEvent } from "./events.mjs";

// One command hook on three events (the same three PassControl gates):
//   UserPromptSubmit  a prompt the user typed      → goes through; a notice if paused (D2)
//   PreToolUse        before each tool runs        → deny + end the turn / ask / warn
//   PostToolBatch     before the next model call   → end the turn if paused
// stdout is JSON or nothing: plain text on UserPromptSubmit would reach the model.
// Text for Claude never says how to lift a pause, or the agent would lift it itself.
// The user is told to type `! <resume>` in Claude Code: a "!" command is the user's,
// and the pause does not stop it (owner's live run, 2026-10-14).

const FAIL_WARN_EVERY_MS = 60_000;

/** A hit in words: what happened, a short form, and when it lifts by itself. */
export function describe(hit, now) {
  const name = hit.window ? WINDOWS[hit.window].name : "";
  const pct = Math.round(hit.usedPct);
  const reset = hit.resetsAt ? resetTime(hit.resetsAt, now) : null;
  const during = hit.during ? ` (${hit.during})` : "";
  switch (hit.kind) {
    case "manual":
      return {
        what: "the user paused it by hand",
        short: "paused by you",
        lifts: hit.until ? `It lifts at ${resetTime(hit.until / 1000, now)}` : "It stays paused until you resume",
      };
    case "pace": {
      const out = hit.runsOutAt ? resetTime(hit.runsOutAt / 1000, now) : null;
      return {
        what: out ? `${name} usage is ${pct}% and at this pace runs out ${out}, before it resets ${reset}` : `${name} usage is ${pct}% and on pace for ${Math.round(hit.projected)}% before it resets ${reset}`,
        short: out ? `${name} runs out ${out} at this pace (resets ${reset})` : `${name} on pace for ${Math.round(hit.projected)}% by ${reset}`,
        lifts: `It lifts when the pace slows or at ${reset}`,
      };
    }
    case "prompt":
      return {
        what: `this prompt raised ${name} usage by ${Math.round(hit.rise)} points, past the ${hit.at}-point allowance per prompt${during}`,
        short: `prompt used +${Math.round(hit.rise)}% ${name}`,
        lifts: "It lifts at your next prompt",
      };
    default:
      return {
        what: `${name} usage is ${pct}%, past the ${hit.at}% line${during}`,
        short: `${name} ${pct}% (line ${hit.at}%)`,
        lifts: `It lifts at ${reset}`,
      };
  }
}

const toClaude = (d) =>
  `The user's usage guard (Peras) has paused tool use: ${d.what}. Do not retry or work around this. Stop and tell the user why you stopped.`;

function pauseFor(event, d, resumeHint) {
  const stopReason = `Peras paused Claude Code: ${d.what}. ${d.lifts}, or type: ! ${resumeHint}`;
  if (event === "PreToolUse") {
    return {
      continue: false,
      stopReason,
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: toClaude(d) },
    };
  }
  return { continue: false, stopReason, decision: "block", reason: toClaude(d) };
}

const hasKind = (rules, kind) => rules.some((r) => r.kind === kind);

/**
 * @param {{ input: object, env?: object, now?: number, notify?: (title: string, body: string) => void }} options
 * @returns {object | null} the hook's JSON answer, or null for "go ahead, say nothing"
 */
export function runHook({ input, env = process.env, now = Date.now(), notify = () => {} }) {
  const event = input?.hook_event_name;
  let state = readState(env, now);
  try {
    const session = String(input?.session_id ?? "");
    const cwd = typeof input?.cwd === "string" ? input.cwd : null;
    const ctx = context(env, { now, cwd, session, state, usage: readUsage(env) });
    let changed = false;
    if (session && cwd) {
      state.sessions[session] = { cwd: realDir(cwd), t: now };
      changed = true;
    }

    // A prompt line measures from the moment the user sent the prompt.
    if (event === "UserPromptSubmit" && hasKind(ctx.rules, "prompt") && session) {
      state.prompts[session] = {
        id: now.toString(36),
        t: now,
        ...Object.fromEntries(Object.entries(ctx.window).map(([name, w]) => [name, w.usedPct])),
      };
      ctx.prompt = state.prompts[session];
      changed = true;
    }

    const { action, hit, hits } = evaluate(ctx);
    recordHookRun(env, event, now);
    const latched = hits.filter((h) => h.kind === "pace").map((h) => h.key);
    if (latched.join() !== state.latched.join()) {
      state.latched = latched;
      changed = true;
    }
    if (action === "none") {
      if (changed) writeState(env, state);
      return null;
    }

    const d = describe(hit, now);
    const resumeHint = readInstall(env)?.resumeHint || "peras resume";
    const lines = [];
    const notificationLines = [];
    const notificationPreferences = preferences(env);
    let out = null;

    // Every line crossed is told once, and lines crossed together in one notification.
    for (const h of hits) {
      if (h.action === "ask") continue;
      const tag = `${h.action}:${h.key}`;
      if (state.notified.includes(tag)) continue;
      state.notified.push(tag);
      changed = true;
      const hd = describe(h, now);
      if (h.kind !== "manual") recordEvent(env, { kind: h.action === "warn" ? "warning" : "pause", at: now, message: `${hd.what}. ${hd.lifts}.` });
      const text = h.action === "pause" ? `Paused: ${hd.short}. ${hd.lifts}, or type ! ${resumeHint}` : `${hd.short}.`;
      lines.push(text);
      if (notificationPreferences[h.action === "pause" ? "pauses" : "warnings"]) notificationLines.push(text);
    }

    if (action === "pause") {
      if (event === "PreToolUse" || event === "PostToolBatch") out = pauseFor(event, d, resumeHint);
      if (event === "UserPromptSubmit") {
        out = {
          systemMessage: `Peras: tool use is paused (${d.short}). Your message goes through, but tools stay paused. ${d.lifts}, or type: ! ${resumeHint}`,
        };
      }
    } else if (action === "ask" && event === "PreToolUse") {
      // D9: once per session per line. Turning the prompt down ends the turn,
      // so a later tool call in the same session means the user is there.
      const asked = state.asked[session] ?? [];
      if (!asked.includes(hit.key)) {
        state.asked[session] = [...asked, hit.key];
        changed = true;
        const text = `Claude Code is waiting for your OK: ${d.short}.`;
        recordEvent(env, { kind: "approval", at: now, message: text });
        lines.unshift(text);
        if (notificationPreferences.pauses) notificationLines.unshift(text);
        out = {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "ask",
            permissionDecisionReason: `Peras: ${d.what}. Let Claude keep using tools? Peras asks once per session.`,
          },
        };
      }
    }
    if (!out && lines.length) out = { systemMessage: `Peras: ${lines.join(" ")}` };
    if (notificationLines.length) notify("Peras 🍐", notificationLines.join("\n"), { env });

    if (changed) writeState(env, state);
    return out;
  } catch (error) {
    // D3: fail open, loudly, but at most once a minute.
    if (now - state.failWarnAt < FAIL_WARN_EVERY_MS) return null;
    try {
      writeState(env, { ...state, failWarnAt: now });
    } catch {
      // Still say it, even if it cannot be remembered.
    }
    const why = String(error?.message ?? error).slice(0, 120);
    return { systemMessage: `Peras could not check your usage (${why}), so this goes ahead. Run \`peras doctor\`.` };
  }
}
