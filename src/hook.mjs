import { WINDOWS, liveWindow, resetTime } from "./window.mjs";
import { evaluate } from "./rules.mjs";
import { readInstall, readRules, readState, readWindow, writeState } from "./store.mjs";

// One command hook on three events (the same three PassControl gates):
//   UserPromptSubmit  a prompt the user typed      → goes through; a notice if paused (D2)
//   PreToolUse        before each tool runs        → deny + end the turn / ask / warn
//   PostToolBatch     before the next model call   → end the turn if paused
// stdout is JSON or nothing: plain text on UserPromptSubmit would reach the model.
// Text for Claude never says how to lift a pause, or the agent would lift it itself.
// The user is told to type `! <resume>` in Claude Code: a "!" command is the user's,
// and the pause does not stop it (owner's live run, 2026-10-14).

const FAIL_WARN_EVERY_MS = 60_000;

function describe(hit, now) {
  return {
    name: WINDOWS[hit.window].name,
    pct: Math.round(hit.usedPct),
    at: hit.at,
    reset: resetTime(hit.resetsAt, now),
  };
}

const toClaude = ({ name, pct, at }) =>
  `The user's usage guard (Peras) has paused tool use: their ${name} Claude usage is at ${pct}%, past the ${at}% line they set. Do not retry or work around this. Stop and tell the user their ${name} usage reached ${pct}%.`;

function pauseFor(event, d, resumeHint) {
  const stopReason = `Peras paused Claude Code: ${d.name} usage is ${d.pct}%, past your ${d.at}% line. It lifts at ${d.reset}, or type: ! ${resumeHint}`;
  if (event === "PreToolUse") {
    return {
      continue: false,
      stopReason,
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: toClaude(d) },
    };
  }
  return { continue: false, stopReason, decision: "block", reason: toClaude(d) };
}

/**
 * @param {{ input: object, env?: object, now?: number, notify?: (title: string, body: string) => void }} options
 * @returns {object | null} the hook's JSON answer, or null for "go ahead, say nothing"
 */
export function runHook({ input, env = process.env, now = Date.now(), notify = () => {} }) {
  const event = input?.hook_event_name;
  let state = readState(env, now);
  try {
    const window = liveWindow(readWindow(env), now);
    const { action, hit, hits } = evaluate(window, readRules(env), { resumed: state.resumed });
    if (action === "none") return null;

    const d = describe(hit, now);
    const resumeHint = readInstall(env)?.resumeHint || "peras resume";
    let changed = false;
    const once = (tag, body) => {
      const key = `${tag}:${hit.key}`;
      if (state.notified.includes(key)) return false;
      state.notified.push(key);
      changed = true;
      notify("Peras 🍐", body);
      return true;
    };

    // A pause or an ask already says more than the warnings on the same window.
    if (action !== "warn") {
      for (const h of hits) {
        if (h.action !== "warn" || h.window !== hit.window || state.notified.includes(`warn:${h.key}`)) continue;
        state.notified.push(`warn:${h.key}`);
        changed = true;
      }
    }

    let out = null;
    if (action === "pause") {
      once("pause", `Paused Claude Code: ${d.name} usage ${d.pct}%. Lifts ${d.reset}, or type ! ${resumeHint} in Claude Code.`);
      if (event === "PreToolUse" || event === "PostToolBatch") out = pauseFor(event, d, resumeHint);
      if (event === "UserPromptSubmit") {
        out = {
          systemMessage: `Peras: tool use is paused (${d.name} usage ${d.pct}%, your line ${d.at}%). Your message goes through, but tools stay paused until ${d.reset}, or type: ! ${resumeHint}`,
        };
      }
    } else if (action === "ask" && event === "PreToolUse") {
      // D9: once per session per window. Turning the prompt down ends the turn,
      // so a later tool call in the same session means the user is there.
      const session = String(input.session_id ?? "");
      const asked = state.asked[session] ?? [];
      if (!asked.includes(hit.key)) {
        state.asked[session] = [...asked, hit.key];
        changed = true;
        notify("Peras 🍐", `Claude Code is waiting for your OK: ${d.name} usage ${d.pct}%.`);
        out = {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "ask",
            permissionDecisionReason: `Peras: your ${d.name} usage is ${d.pct}% (your ask line is ${d.at}%). Let Claude keep using tools? Peras asks once per session.`,
          },
        };
      }
    } else if (action === "warn" && event === "PreToolUse") {
      const body = `${d.name} usage passed ${d.at}% (now ${d.pct}%, resets ${d.reset}).`;
      if (once("warn", body)) out = { systemMessage: `Peras: ${body}` };
    }

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
