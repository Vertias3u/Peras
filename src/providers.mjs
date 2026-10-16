import { budgetText } from "./allowances.mjs";
import fs from "node:fs";
import { codexEnv, codexExecutable, inspectCodex, refreshCodex } from "./codex.mjs";
import { context, readInstall, readState, readWindow, sessionVerdict } from "./store.mjs";
import { readUsage } from "./usage.mjs";
import { describe } from "./hook.mjs";
import { windowText } from "./window.mjs";
import { hookHealth } from "./hook-health.mjs";
import { colorOn, paint, toneFor, MARK } from "./look.mjs";

/** Compact ANSI readout for terminal integrations, outside Codex's native footer. */
export function terminalStatusline(s, env) {
  const color = colorOn(env);
  const parts = [["five_hour", "5h"], ["seven_day", "7d"]].filter(([key]) => s.ctx.window[key]).map(([key, label]) => {
    const pct = Math.round(s.ctx.window[key].usedPct);
    return paint(color, toneFor(key, pct, s.ctx.rules), `${label} ${pct}%`);
  });
  const action = s.verdict.action;
  const state = action === "none" ? "" : `${paint(color, action === "warn" ? "yellow" : "red", MARK[action])} · `;
  return `🍐 ${state}${parts.length ? parts.join(" · ") : "no usage window yet"}`;
}

export function freshness(window, now) {
  const seen = Object.values(window ?? {}).map((w) => w?.seenAt).filter(Number.isFinite);
  if (!seen.length) return { age: null, text: "No reading yet" };
  const age = Math.max(0, now - Math.min(...seen));
  const secs = Math.floor(age / 1000);
  const amount = secs < 60 ? secs : secs < 3600 ? Math.floor(secs / 60) : secs < 86400 ? Math.floor(secs / 3600) : Math.floor(secs / 86400);
  const unit = secs < 60 ? "second" : secs < 3600 ? "minute" : secs < 86400 ? "hour" : "day";
  const ago = `${amount} ${unit}${amount === 1 ? "" : "s"}`;
  return { age, text: `Updated ${ago} ago${age > 5 * 60_000 ? " · older reading" : ""}` };
}

export async function snapshot(env, now, { provider = "claude", refresh = false, reader, force = false, adaptive = false } = {}) {
  const scoped = provider === "codex" ? codexEnv(env) : env;
  const label = provider === "codex" ? "Codex" : "Claude Code";
  let error = null;
  if (provider === "codex" && refresh) {
    try { await refreshCodex(env, now, { reader, force, adaptive }); } catch (e) { error = e.message; }
  }
  let stored;
  try { stored = readWindow(scoped); } catch (e) { error = e.message; }
  const state = readState(scoped, now);
  const usage = readUsage(scoped);
  let ctx;
  try { ctx = context(scoped, { now, cwd: process.cwd(), state, usage }); }
  catch (e) {
    error = e.message;
    ctx = { window: {}, rules: [], now, cwd: process.cwd(), manualPause: state.manualPause, forecast: {}, resumed: state.resumed };
  }
  const verdict = sessionVerdict(ctx, state);
  const reading = freshness(Object.keys(ctx.window).length ? ctx.window : stored, now);
  if (stored && Object.keys(stored).length && !Object.keys(ctx.window).length) reading.text += " · expired";
  return { provider, label, env: scoped, ctx, usage, state, error, freshness: reading, verdict, health: hookHealth(env, provider, now) };
}

export function statusText(s, now) {
  const { ctx, verdict } = s;
  const lines = [`${s.label}: ${windowText(ctx.window, { resets: true, now }) || "no live usage window"}`, `  ${s.freshness.text}`];
  for (const meter of s.ctx.allowances || []) lines.push(`  ${budgetText(meter)}`);
  if (s.error) lines.push(`  Could not refresh: ${s.error}. Showing saved readings while their windows remain valid.`);
  if (verdict.action === "none") lines.push(Object.keys(ctx.window).length ? "  ✓ Under every active line." : "  Usage thresholds cannot be evaluated yet.");
  else lines.push(`  ${verdict.action.toUpperCase()}: ${describe(verdict.hit, now).what}. ${describe(verdict.hit, now).lifts}.`);
  if (s.provider === "codex" && !readInstall(s.env)) lines.push("  Run peras codex setup, then review /hooks in Codex.");
  return lines.join("\n");
}

export function whyText(s, now) {
  const lines = [`${s.label}: ${s.verdict.action === "none" ? "no active stop" : s.verdict.action.toUpperCase()}`, `  ${s.freshness.text}`];
  if (s.error) lines.push(`  Reading issue: ${s.error}`);
  for (const h of s.verdict.hits) {
    const d = describe(h, now);
    lines.push(`  ${h.action}: ${d.what}. ${d.lifts}.`);
    if (h.project) lines.push(`    Applies in ${h.project} and its subfolders.`);
  }
  if (!s.verdict.hits.length) lines.push(Object.keys(s.ctx.window).length ? "  No applicable rule is currently crossed." : "  No live usage window; usage thresholds cannot be evaluated.");
  if (s.state.resumed.length) lines.push("  Some stop rules have been lifted by a resume; higher lines still apply.");
  if (s.verdict.action === "pause" || s.verdict.action === "ask") lines.push(`  To lift this stop: peras ${s.provider === "codex" ? "codex " : ""}resume`);
  if (s.provider === "codex" && s.verdict.action === "ask") lines.push("  Codex cannot show a hook approval prompt; this ask blocks tools until you resume.");
  return lines.join("\n");
}

export async function codexDoctor(env, now, { reader, version } = {}) {
  const lines = [];
  let problems = 0;
  const check = (ok, good, bad) => { lines.push(`${ok ? "✓" : "✗"} ${ok ? good : bad}`); if (!ok) problems++; };
  try {
    const wired = inspectCodex(env);
    check(!wired.missingEvents.length, `Peras hooks configured in ${wired.target}`, `Missing hooks: ${wired.missingEvents.join(", ")}. Run peras codex setup.`);
    check(!wired.claudeHookEvents.length, "No Claude Code Peras hook in Codex", `Codex runs Peras's Claude Code hook on ${wired.claudeHookEvents.join(", ")}, so it pauses on Claude's usage, not Codex's. Run peras codex setup to replace it.`);
  } catch (e) { check(false, "", e.message); }
  const record = readInstall(codexEnv(env));
  const executable = record?.codexExecutable ?? codexExecutable(env);
  check(fs.existsSync(executable), `Codex executable: ${executable}`, `Codex executable unavailable: ${executable}. Install Codex CLI and rerun peras codex setup.`);
  const node = record?.command?.match(/^"([^"]+)"/)?.[1];
  const bin = record?.command?.match(/"([^"]+peras\.mjs)"/)?.[1];
  check(Boolean(node && bin && fs.existsSync(node) && fs.existsSync(bin)), "Peras hook runtime exists", "Peras hook runtime missing. Run peras codex setup.");
  if (record?.version && version) check(record.version === version, `Hook runtime is Peras ${version}`, `Hook runtime is Peras ${record.version}, CLI is ${version}. Run peras codex setup.`);
  const s = await snapshot(env, now, { provider: "codex", refresh: true, force: true, reader });
  check(!s.error, "Codex usage RPC is reachable", `Codex usage read failed: ${s.error}`);
  check(Object.keys(s.ctx.window).length > 0, `Live usage available. ${s.freshness.text}`, "No live ChatGPT plan window. Check your Codex login and account type.");
  lines.push("• Hook trust is controlled by Codex. Open /hooks to confirm Peras is trusted and enabled.");
  lines.push(problems ? `${problems} thing${problems === 1 ? "" : "s"} to fix.` : "Configured checks passed; confirm hook trust in Codex.");
  return { code: problems ? 1 : 0, text: lines.join("\n") };
}
