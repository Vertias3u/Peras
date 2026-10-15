import { localDay } from "./calendar.mjs";
import { readPlanning, setPacing, profileSummary, saveProfile, useProfile, deleteProfile, grantExtra, revokeExtra, activeExtras } from "./planning.mjs";
import { sessionOverview } from "./sessions.mjs";
import { context } from "./store.mjs";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { perasHome, readJson, writeJsonAtomic, readRules, writeRules } from "./store.mjs";
import { codexEnv } from "./codex.mjs";
import { snapshot } from "./providers.mjs";
import { normalizeRules, setRule, realDir } from "./rules.mjs";
import { readBudgetRules, setBudget, normalizeBudget, budgetId } from "./allowances.mjs";
import { preferences, setPreference } from "./preferences.mjs";
import { settingsHTML } from "./settings-page.mjs";

const sessionFile = env => path.join(perasHome(env), "settings-session.json");
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const config = env => ({ claude: { rules: readRules(env), budgets: readBudgetRules(env), pacing: readPlanning(env).pacing || null, profiles: profileSummary(env), extras: readPlanning(env).extras }, codex: { rules: readRules(codexEnv(env)), budgets: readBudgetRules(codexEnv(env)), pacing: readPlanning(codexEnv(env)).pacing || null, profiles: profileSummary(codexEnv(env)), extras: readPlanning(codexEnv(env)).extras }, preferences: preferences(env) });
const editorBuild = hash([fs.readFileSync(new URL("./settings-server.mjs", import.meta.url), "utf8"), fs.readFileSync(new URL("./settings-page.mjs", import.meta.url), "utf8")]);
const sameRule = (a,b) => JSON.stringify(a) === JSON.stringify(b);
export async function startSettingsServer({ env = process.env, now = Date.now, getSnapshots, idleMs = 30 * 60_000, persist = false } = {}) {
  const token = randomBytes(32).toString("hex");
  let lastUsed = Date.now(), origin;
  const server = http.createServer(async (req, res) => {
    const json = (code, body) => { res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(body)); };
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    if (req.headers.host !== new URL(origin).host) return json(403, { error: "Unexpected local host." });
    if (req.url === "/" && req.method === "GET") { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }); res.end(settingsHTML()); return; }
    const supplied = Buffer.from(req.headers.authorization || ""), expected = Buffer.from(`Bearer ${token}`);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return json(401, { error: "Open Settings from the Peras menu to start a private session." });
    if (req.headers.origin && req.headers.origin !== origin) return json(403, { error: "Cross-origin requests are refused." });
    lastUsed = Date.now();
    try {
      if (req.url === "/api/ping" && req.method === "GET") return json(200, { ready: true });
      if (req.url === "/api/state" && req.method === "GET") {
        const value = config(env);
        const snapshots = getSnapshots ? await getSnapshots() : await Promise.all([snapshot(env, now()), snapshot(env, now(), { provider: "codex", refresh: true })]);
        return json(200, { ...value, revision: hash(value), now: now(), sessions: sessionOverview(snapshots, now()), snapshots: snapshots.map(s => ({ provider: s.provider, allowances: s.ctx.allowances || [], freshness: s.freshness, error: s.error })) });
      }
      if (req.url !== "/api/save" || req.method !== "POST") return json(404, { error: "Not found." });
      if (req.headers.origin !== origin || !/^application\/json(?:;|$)/.test(req.headers["content-type"] || "")) return json(403, { error: "Use the local Settings page to save JSON changes." });
      let raw = "";
      for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > 32768) return json(413, { error: "Settings request too large." }); }
      const body = JSON.parse(raw), current = config(env);
      if (body.revision !== hash(current)) return json(409, { error: "Settings changed elsewhere. Refresh before saving." });
      const scoped = body.provider === "claude" ? env : body.provider === "codex" ? codexEnv(env) : null;
      if (body.op === "preference") setPreference(env, body.name, body.value);
      else if (!scoped) throw new Error("Choose Claude or Codex.");
      else if (body.op === "pacing") setPacing(scoped, body.pacing);
      else if (body.op === "profile-save") saveProfile(scoped, body.name);
      else if (body.op === "profile-use") useProfile(scoped, body.name, now());
      else if (body.op === "profile-delete") deleteProfile(scoped, body.name);
      else if (body.op === "extra") {
        const at=now(),end=localDay(at).end;
        if(body.grant.duration && !["1h","today"].includes(body.grant.duration))throw new Error("Choose 1h or today.");
        const until=body.grant.duration==="today"?end:body.grant.duration==="1h"?Math.min(end,at+3600_000):body.grant.until;
        grantExtra(scoped, {...body.grant,until}, at, context(scoped,{now:at}).window.seven_day);
      }
      else if (body.op === "extra-revoke") revokeExtra(scoped, body.id, now());
      else if (body.op === "rule") {
        if (typeof body.rule?.at !== "number" || body.rule.at <= 0) throw new Error("A rule threshold must be above zero.");
        if (body.rule.project && (typeof body.rule.project !== "string" || !path.isAbsolute(body.rule.project))) throw new Error("Choose an absolute folder path.");
        const candidate = { ...body.rule, ...(body.rule.project ? { project: realDir(body.rule.project) } : {}) };
        const normalized = normalizeRules([candidate]);
        if (normalized.length !== 1) throw new Error("Invalid rule. Check the threshold, action, schedule and absolute folder path.");
        let rules = readRules(scoped);
        if (body.original) {
          if (!rules.some(r => sameRule(r, body.original))) throw new Error("Original rule no longer exists. Refresh settings.");
          rules = rules.filter(r => !sameRule(r, body.original));
        }
        writeRules(scoped, setRule(rules, normalized[0], normalized[0].at));
      } else if (body.op === "delete-rule") {
        const rules = readRules(scoped);
        if (!rules.some(r => sameRule(r, body.rule))) throw new Error("Rule no longer exists. Refresh settings.");
        writeRules(scoped, rules.filter(r => !sameRule(r, body.rule)));
      } else if (body.op === "budget") {
        const rule = normalizeBudget(body.rule);
        // Editing an allowance may change its threshold, not its accounting scope.
        if (body.original && budgetId(body.original) !== budgetId(rule)) throw new Error("To change the allowance scope or action, add a new allowance and remove the old one.");
        setBudget(scoped, rule, now());
      } else if (body.op === "delete-budget") setBudget(scoped, body.rule, now(), true);
      else throw new Error("Unknown settings action.");
      const value = config(env);
      return json(200, { revision: hash(value), saved: true });
    } catch (error) { return json(400, { error: error.message }); }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  const url = `${origin}/#${token}`;
  const timer = setInterval(() => { if (Date.now() - lastUsed > idleMs) server.close(); }, Math.min(idleMs, 60_000));
  timer.unref();
  server.on("close", () => {
    clearInterval(timer);
    if (persist) { try { if (readJson(sessionFile(env))?.token === token) fs.unlinkSync(sessionFile(env)); } catch { /* Another process owns it. */ } }
  });
  if (persist) writeJsonAtomic(sessionFile(env), { url, token, origin, pid: process.pid, build: editorBuild });
  return { server, origin, token, url, close: () => new Promise(resolve => server.close(resolve)) };
}

export async function openSettings(env, { openURL = async url => {
  const command = process.platform === "darwin" ? "/usr/bin/open" : process.platform === "win32" ? "rundll32" : "xdg-open";
  await promisify(execFile)(command, process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url]);
} } = {}) {
  let saved;
  try {
    saved = readJson(sessionFile(env));
    if (saved?.build === editorBuild && /^http:\/\/127\.0\.0\.1:\d+\/#/.test(saved.url)) {
      const response = await fetch(`${saved.origin}/api/ping`, { headers: { Authorization: `Bearer ${saved.token}` }, signal: AbortSignal.timeout(1000) });
      if (response.ok) { await openURL(saved.url); return saved.url; }
    }
  } catch { /* Start a fresh private editor process. */ }
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], { env: { ...process.env, ...env }, detached: true, stdio: "ignore" });
  child.unref();
  for (let attempt = 0; attempt < 80; attempt++) {
    await delay(100);
    try {
      const next = readJson(sessionFile(env));
      if (next && next.token !== saved?.token) { await openURL(next.url); return next.url; }
    } catch { /* Worker has not written its session yet. */ }
  }
  throw new Error("Could not start the local Settings editor.");
}
if (process.argv[1] === fileURLToPath(import.meta.url)) startSettingsServer({ persist: true }).catch(() => { process.exitCode = 1; });
