import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { perasHome } from "./store.mjs";
import { statusText, whyText } from "./providers.mjs";
import { resetTime } from "./window.mjs";
import { toneFor } from "./look.mjs";
import { countdown } from "./preferences.mjs";
import { recentEvents } from "./events.mjs";
import { readProtectionTest } from "./protection-test.mjs";

const escape = (value) => String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
export const statusPageURL = (env) => pathToFileURL(path.join(perasHome(env), "status.html")).href;

// The look of peras.vertias.eu, without web fonts: the page is local and must not call out.
export const PAGE_STYLE = `
  :root { color-scheme: dark; --ink: #0b0d0c; --panel: #121613; --deep: #070908; --hair: #1d231e; --line: #293029; --paper: #edf1e9; --muted: #a6afa3; --quiet: #8a948a; --dim: #768076; --track: #232a24; --signal: #b7f34a; --yellow: #f2c14e; --red: #ff7a6b;
    --sans: Manrope, system-ui, -apple-system, "Segoe UI", sans-serif; --mono: "JetBrains Mono", "SF Mono", ui-monospace, Menlo, monospace; }
  * { box-sizing: border-box; }
  html { background: var(--ink); }
  body { margin: 0; background: var(--ink); color: var(--paper); font: 16px/1.6 var(--sans); -webkit-font-smoothing: antialiased; }
  a { color: var(--muted); text-underline-offset: 3px; }
  a:hover { color: var(--paper); }
  :focus-visible { outline: 2px solid var(--signal); outline-offset: 3px; border-radius: 4px; }
  .wrap { max-width: 1080px; margin: 0 auto; padding: 0 24px; }
  nav { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 12px; padding: 20px 0; }
  .crumb { display: flex; align-items: center; gap: 10px; line-height: 1; }
  .crumb svg { width: 26px; height: 26px; }
  .crumb b { font: 800 18px var(--mono); letter-spacing: -0.02em; }
  .crumb span { color: var(--muted); font-weight: 500; }
  .tabs { display: flex; align-items: center; gap: 6px; }
  .tabs a, .tabs button { display: inline-flex; align-items: center; min-height: 40px; padding: 0 14px; border: 1px solid transparent; border-radius: 10px; background: none; color: var(--muted); font: 600 14px var(--sans); text-decoration: none; cursor: pointer; }
  .tabs a:hover, .tabs button:hover { color: var(--paper); }
  .tabs [aria-current] { color: var(--paper); border-color: var(--line); }
  .tabs button { border-color: var(--line); color: var(--paper); }
  .tabs button:hover { border-color: #4d6a1d; }
  h1 { margin: 28px 0 8px; font-weight: 800; font-size: clamp(32px, 4.6vw, 48px); line-height: 1.05; letter-spacing: -0.04em; }
  h1 em { font-style: normal; color: var(--signal); }
  .lede { margin: 0; color: var(--muted); }
  .mono, code { font-family: var(--mono); }
  code { font-size: 0.9em; color: var(--paper); }
  footer { margin-top: 64px; padding: 28px 0 40px; border-top: 1px solid var(--hair); font-size: 14px; color: var(--quiet); display: flex; flex-wrap: wrap; justify-content: space-between; gap: 8px 24px; }
  footer .by svg { margin-right: 6px; vertical-align: -4px; }
  footer .by b { color: var(--paper); font-weight: 700; letter-spacing: -0.055em; }
  footer .by b i { font-style: normal; color: var(--signal); }
`;
export const PEAR_SVG = `<svg viewBox="0 -1 16 16" shape-rendering="crispEdges" aria-hidden="true"><path d="M7 3h3v1h-3zM6 4h5v2h-5zM5 6h7v1h-7zM4 7h9v1h-9zM3 8h11v4h-11zM4 12h9v1h-9zM5 13h7v1h-7z" fill="#b7f34a"/><path d="M5 8h1v2h-1z" fill="#e4fbb8"/><path d="M8 1h1v2h-1z" fill="#edf1e9"/><path d="M9 1h2v1h-2zM10 0h2v1h-2z" fill="#7fa933"/></svg>`;
export const VERTIAS_SVG = `<svg width="18" height="19" viewBox="0 0 58 62" fill="none" aria-hidden="true"><path d="M29 57C25 47 12 36 10 20 8 9 14 3 19 6c6 4 7 20 9 33 1 8 1 13 1 18Z" fill="#7fa933"/><path d="M29 57c-2-12-5-29-3-43 1-8 4-13 7-12 4 1 5 8 3 19-2 13-5 26-7 36Z" fill="#b7f34a"/><path d="M29 57c4-10 14-21 19-37 3-10-2-17-7-14-6 4-8 20-10 33-1 8-2 13-2 18Z" fill="#94c63b"/></svg>`;

const TONE = { green: "var(--signal)", yellow: "var(--yellow)", red: "var(--red)" };
const healthTone = (label) => (/active/i.test(label) && !/needs/i.test(label) ? "green" : /missing|disabled/i.test(label) ? "red" : "yellow");
const STATE = { none: ["green", "Under every line"], warn: ["yellow", "Warning"], ask: ["red", "Asking first"], pause: ["red", "Paused"] };
const when = (ms) => new Date(ms).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });

export function writeStatusPage(env, snapshots, now) {
  const protection = readProtectionTest(env);
  const testSummary = protection ? `<p><strong>${protection.passed ? "Self-test passed" : "Self-test failed"}</strong> · ${escape(when(protection.at))}</p>${(protection.providers || []).map(row => `<p><strong>${escape(row.provider === "codex" ? "Codex" : "Claude")}: ${row.passed ? "Pass" : "Fail"}</strong> · ${escape(row.message)}</p>`).join("")}` : "<p>No self-test run yet.</p>";
  const events = recentEvents(env);
  const eventRows = events.map(row => `<tr><td class="mono">${escape(when(row.at))}</td><td>${escape(row.provider === "codex" ? "Codex" : row.provider === "claude" ? "Claude" : "Peras")}</td><td>${escape(row.kind)}</td><td>${escape(row.message)}</td></tr>`).join("");
  const cards = snapshots.map((s) => {
    const name = s.provider === "codex" ? "Codex" : "Claude";
    const [stateTone, stateText] = STATE[s.verdict.action] ?? STATE.none;
    const meters = [["five_hour", "5-hour"], ["seven_day", "Weekly"]].map(([key, label]) => {
      const window = s.ctx.window[key];
      if (!window) return `<div class="meter"><div class="row"><strong>${label}</strong><span class="mono">no live reading</span></div><div class="track"></div></div>`;
      const used = Math.max(0, Math.min(100, window.usedPct));
      const fill = TONE[toneFor(key, used, s.ctx.rules)] ?? TONE.green;
      return `<div class="meter"><div class="row"><strong>${label} · ${Math.round(used)}% used</strong><span class="mono">resets in ${escape(countdown(window.resetsAt, now))} · ${escape(resetTime(window.resetsAt, now))}</span></div><div class="track" role="meter" aria-label="${name} ${label} usage" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(used)}"><div style="width:${used}%;background:${fill}"></div></div></div>`;
    }).join("");
    const health = s.health ? `<p class="health"><i style="background:${TONE[healthTone(s.health.label)]}"></i><span><strong>${escape(s.health.label)}</strong> · ${escape(s.health.detail)}</span></p>` : "";
    const stopped = s.verdict.action === "pause" || s.verdict.action === "ask";
    return `<section class="card${stopped ? " stopped" : ""}"><div class="head"><h2>${name}</h2><span class="pill" style="color:${TONE[stateTone]}">${stateText}</span></div>${health}${meters}<h3>Readout</h3><pre>${escape(statusText(s, now))}</pre><h3>Active rules &amp; pause reasons</h3><pre>${escape(whyText(s, now))}</pre></section>`;
  }).join("");
  const limits = escape(new URL("./limits.html", import.meta.url).href);
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="refresh" content="10"><meta name="color-scheme" content="dark"><title>Status · Peras</title><style>${PAGE_STYLE}
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 380px), 1fr)); gap: 14px; margin-top: 32px; }
  .card { background: var(--panel); border: 1px solid var(--hair); border-radius: 16px; padding: 24px; min-width: 0; }
  .card.stopped { background: #1a1210; border-color: #5c2b25; }
  .head { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
  h2 { margin: 0; font-weight: 800; font-size: 26px; letter-spacing: -0.03em; }
  .pill { font: 700 13px var(--mono); padding: 5px 10px; border: 1px solid currentColor; border-radius: 999px; white-space: nowrap; }
  .health { display: flex; gap: 10px; margin: 14px 0 22px; font-size: 14px; color: var(--muted); }
  .health strong { color: var(--paper); }
  .health i { flex: none; width: 8px; height: 8px; margin-top: 8px; border-radius: 50%; }
  .meter { margin-bottom: 18px; }
  .row { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 2px 16px; margin-bottom: 8px; font-size: 15px; }
  .row .mono { font-size: 13px; color: var(--muted); }
  .track { height: 8px; border-radius: 8px; background: var(--track); overflow: hidden; }
  .track div { height: 100%; border-radius: 8px; }
  h3 { margin: 24px 0 8px; font: 500 12px var(--mono); color: var(--dim); text-transform: uppercase; letter-spacing: 0.08em; }
  pre { margin: 0; padding: 14px 16px; background: var(--deep); border: 1px solid #1a201b; border-radius: 12px; white-space: pre-wrap; overflow-wrap: anywhere; font: 13px/1.65 var(--mono); color: #d9ded5; }
  .section { margin-top: 24px; } .section h2 { font-size: 24px; } .section p { color: var(--muted); }
  .table-wrap { overflow-x: auto; margin-top: 16px; } table { width: 100%; border-collapse: collapse; text-align: left; font-size: 14px; }
  th, td { border-bottom: 1px solid var(--hair); padding: 12px 10px; vertical-align: top; } th { color: var(--muted); } td:last-child { min-width: 240px; overflow-wrap: anywhere; } td.mono { white-space: nowrap; font-size: 12px; }
  </style></head><body><div class="wrap">
  <nav aria-label="Peras"><div class="crumb">${PEAR_SVG}<b>peras</b><span>/ Status</span></div><div class="tabs"><a href="#" aria-current="page">Status</a><a href="${limits}">Explain limits</a><button type="button" onclick="location.reload()">Refresh</button></div></nav>
  <h1>Your agents, <em>right now.</em></h1>
  <p class="lede">Updated <span class="mono">${escape(when(now))}</span>. The page reloads every 10 seconds while the menu bar is running.</p>
  <div class="cards">${cards}</div>
    <section class="card section" id="protection-test"><h2>Protection test</h2>${testSummary}<p>Choose <strong>Settings → Protection test…</strong> in the pear menu to run again, or use <code>peras menubar test</code>. The test uses temporary state and runs no model calls. It checks that the hook commands allow tools, deny while paused, and allow after resume. A pass refreshes previously verified protection to active for 15 minutes. Each agent's health details above show the verification source and last live tool guard. It does not establish hook trust or activation in every open session.</p></section>
  <section class="card section" id="recent-events"><h2>Recent events</h2>${events.length ? `<div class="table-wrap"><table><thead><tr><th>Time</th><th>Agent</th><th>Event</th><th>Details</th></tr></thead><tbody>${eventRows}</tbody></table></div>` : "<p>No events recorded yet. New warnings, pauses, resumes, and resets will appear here.</p>"}<p>The latest 50 events are shown. History stays on your machine and contains event summaries, not prompts or tool commands.</p></section>
  <footer><span>Pause or resume from the pear menu. A missing reading doesn't mean zero usage.</span><span class="by">${VERTIAS_SVG}Peras by <b>Ver<i>tias</i></b> · local, nothing leaves your machine</span></footer>
  </div></body></html>`;
  const file = path.join(perasHome(env), "status.html");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, html, { mode: 0o600 });
  fs.renameSync(temporary, file);
  return file;
}
