import crypto from "node:crypto";
import { failurePolicy } from "./failure-policy.mjs";
import fs from "node:fs";
import path from "node:path";
import { localDay } from "./calendar.mjs";
import { LINKS, LINK_IDS, SUGGESTION_IDS, suggestion } from "./discovery.mjs";
import { DISPLAY_STYLES, displayMode, displayStyle } from "./menubar.mjs";
import { weekRecap } from "./recap.mjs";
import { WEEKLY_STYLES, preferences, weeklyStyle } from "./preferences.mjs";
import { activeExtras, profileSummary, readPlanning } from "./planning.mjs";
import { duringActive, ruleId } from "./rules.mjs";
import { HOOK_MEMORY, dirKey, planResume, readInstall, readWindow, wholeMinute } from "./store.mjs";
import { WINDOWS } from "./window.mjs";
import { hookConfigurationFingerprint } from "./hook-health.mjs";
import { readProtectionTest } from "./protection-test.mjs";
import { readReceipt } from "./receipts.mjs";
import { APP_RELEASE, appVersion } from "./native-app.mjs";
import { compareVersions } from "./update.mjs";

// Protocol 1 between the native app and its Node child: JSON lines, one message
// per line. This module only builds and checks messages; the bridge loop and the
// operations live elsewhere. Every wire time is in milliseconds, and nothing on
// the wire is a path, an environment value or a sentence with a local clock time
// baked in: the app formats times itself.

export const PROTOCOL = 1;
export const PROVIDERS = ["claude", "codex"];
export const WINDOW_NAMES = Object.keys(WINDOWS);
export const FRESHNESS = ["current", "stale", "expired", "missing"];
export const ACTIONS = ["none", "warn", "ask", "pause"];
export const HEALTH = ["active", "unverified", "needs_activation", "setup_missing", "hooks_disabled"];
export const LIMITS = { commandBytes: 64 * 1024, frameBytes: 1024 * 1024 };
/** A reading older than this still counts until its reset, but is not current. */
export const STALE_MS = 5 * 60_000;
/** Settings changes have no reviewed impact to bind: the app sends this token with them. */
export const UNBOUND_TOKEN = "unbound-v0";
/**
 * Operations the bridge refuses for now. Resume waits for the explicit-controls
 * split (plans/v0.4-readiness.md §2): today a hook's whole-state write can undo it.
 */
const RUNTIME_VERSION = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
export const NOT_READY = new Set();
const HOUR = 3600_000;

const ms = (seconds) => (Number.isFinite(seconds) ? Math.round(seconds * 1000) : null);
/** The default way to turn a local key (a folder, a rule key) into an opaque wire id. */
export const digest = (text) => crypto.createHash("sha256").update(String(text)).digest("hex").slice(0, 12);

/** An opaque, stable name for a configuration folder: it says which context, never which account. */
export const contextId = (env) => `ctx_${dirKey(env)}`;

function windowRows(stored, live, now) {
  return WINDOW_NAMES.map((name) => {
    const w = live[name] ?? stored?.[name];
    if (!w || !Number.isFinite(w.usedPct)) return { window: name, used: null, resetsAtMs: null, seenAtMs: null, freshness: "missing" };
    const resetsAtMs = ms(w.resetsAt), seenAtMs = Number.isFinite(w.seenAt) ? w.seenAt : null;
    const freshness = !live[name] ? "expired" : seenAtMs !== null && now - seenAtMs <= STALE_MS ? "current" : "stale";
    return { window: name, used: w.usedPct, resetsAtMs, seenAtMs, freshness };
  });
}

const HEALTH_LABELS = {
  "Protection active": "active",
  "Not recently verified": "unverified",
  "Needs activation": "needs_activation",
  "Needs trust / activation": "needs_activation",
  "Setup missing": "setup_missing",
  "Hooks disabled": "hooks_disabled",
};

function healthRow(health) {
  // `at` is the last live tool guard the hook recorded: a real hook run, not a self-test.
  return { state: HEALTH_LABELS[health?.label] ?? "setup_missing", liveGuardAtMs: Number.isFinite(health?.at) ? health.at : null };
}

export const SETUP_HOOKS = ["configured", "missing", "disabled"];
export const SETUP_STEPS = ["run_setup", "enable_hooks", "update_hooks", "trust_and_restart", "restart"];

/**
 * First-run facts kept apart, as the app shows them: hooks configured, hooks
 * from this version, the isolated self-test passed for this configuration,
 * and `next`, the one step left before a live guard can be observed (null once
 * one has been, for this configuration). A current reading is in `windows`,
 * the last live guard in `health`. Codex's trust is the user's to give in
 * Codex: the step says so, nothing here grants it.
 */
function setupRow(s, health) {
  const hooks = health.state === "setup_missing" ? "missing" : health.state === "hooks_disabled" ? "disabled" : "configured";
  const install = readInstall(s.env);
  const current = hooks === "configured" && install?.hookMemory === HOOK_MEMORY && install.version === RUNTIME_VERSION;
  const test = s.env ? readProtectionTest(s.env) : null;
  const configuration = s.env ? hookConfigurationFingerprint(s.env) : null;
  const passed = hooks === "configured" && configuration && test?.providers.some((row) => row.provider === s.provider && row.passed && row.configuration === configuration);
  const next = hooks === "missing" ? "run_setup" : hooks === "disabled" ? "enable_hooks" : !current ? "update_hooks"
    : health.state === "needs_activation" ? (s.provider === "codex" ? "trust_and_restart" : "restart") : null;
  return { hooks, current, testPassedAtMs: passed ? test.at : null, next };
}

/** The last tool call a hook actually denied: when, how often, and the stop it named. Null until one is. */
function receiptRow(env, opaque) {
  const r = env ? readReceipt(env) : null;
  return r ? { firstAtMs: r.firstAt, atMs: r.at, count: r.count, reason: reasonRow(r.hit, opaque) } : null;
}

/** A project, by an opaque id and its folder's name only. */
const project = (dir, opaque) => (dir ? { id: `proj_${opaque(dir)}`, label: path.basename(dir) || "project" } : null);

/** Same stop, same id: the line, its folder and the window it belongs to (and the prompt, for a prompt line). */
const reasonKey = (hit) => (hit.kind === "manual" ? hit.key : [hit.kind, hit.period ?? "", hit.window ?? "", hit.at ?? "", hit.action, hit.during ?? "", hit.project ?? "", hit.key.slice(hit.key.indexOf("@"))].join("|"));

function reasonRow(hit, opaque) {
  const kind = hit.kind;
  const expiresAtMs = kind === "manual" ? hit.until ?? null : kind === "prompt" ? null : ms(hit.resetsAt);
  return {
    id: `rsn_${opaque(reasonKey(hit))}`,
    code: `${kind}_${hit.action}`,
    kind,
    action: hit.action,
    window: kind === "manual" ? null : hit.window ?? null,
    // `used` is measured in the same unit as `at`: a prompt line compares the rise since the prompt;
    // allowances compare points spent; window and pace lines compare the window's percentage.
    at: Number.isFinite(hit.at) ? hit.at : null,
    used: kind === "prompt" ? (Number.isFinite(hit.rise) ? hit.rise : null) : Number.isFinite(hit.usedPct) ? hit.usedPct : null,
    unit: ["prompt", "daily", "project", "pacing"].includes(kind) ? "points" : "percent",
    scope: hit.project ? "project" : "global",
    project: project(hit.project, opaque),
    expiresAtMs,
  };
}

function planningRow(meters, env, now, weekly, opaque) {
  const grants = meters.length ? activeExtras(env, now, weekly) : [];
  return {
    meters: meters.map((m) => {
      const mine = grants.filter((g) => g.period === m.period && (g.project || null) === (m.project || null));
      return {
        kind: m.kind === "pacing" ? "pacing" : m.project ? "project" : "daily",
        period: m.period,
        action: m.action,
        project: project(m.project, opaque),
        baseLimit: m.baseAt ?? m.at,
        limit: m.at,
        extra: m.extra ?? 0,
        extraExpiresAtMs: mine.length ? Math.min(...mine.map((g) => g.until)) : null,
        spent: m.spent,
        remaining: Math.max(0, Math.round((m.at - m.spent) * 10) / 10),
        estimated: Boolean(m.estimated),
        waitingForReading: !m.since,
        resetsAtMs: ms(m.resetsAt),
        ...(m.kind === "pacing" ? { workdaysLeft: m.workdays, reserve: m.reserve, workday: m.workday !== false, ...pace(m, weekly, now) } : {}),
      };
    }),
  };
}

/**
 * Where today's pacing share would leave the week by tonight, in weekly percent,
 * and whether today's share is used up. Null without a reading to measure from.
 */
function pace(m, weekly, now) {
  if (!m.since || !usableWeekly(weekly, now) || !Number.isFinite(weekly.usedPct)) return { expectedByTonightPercent: null, pace: null };
  const expected = Math.min(100, Math.max(0, weekly.usedPct - m.spent + m.at));
  return { expectedByTonightPercent: Math.round(expected * 10) / 10, pace: m.spent >= m.at ? "reached" : "within" };
}
export const PACE_STATES = ["within", "reached"];

/** A daily Extra from the app ends in an hour, at local midnight or at the weekly reset, whichever comes first. */
export const extraUntil = (now, weekly) => Math.min(wholeMinute(now + HOUR), localDay(now).end, weekly.resetsAt * 1000);
const usableWeekly = (weekly, now) => Boolean(weekly && weekly.resetsAt * 1000 > now && Number.isFinite(weekly.seenAt) && weekly.seenAt <= now);

/**
 * The actions a snapshot offers and exactly what each would change: `impact` is
 * what a token binds, so the app's command runs only if that is still true.
 * The snapshot and the command both come through here.
 */
export function offeredActions(s, now) {
  const manual = s.state?.manualPause ?? null;
  const pauseId = manual ? { since: manual.since, until: manual.until ?? null } : null;
  const stopped = s.verdict.action === "pause" || s.verdict.action === "ask" || Boolean(manual);
  const offers = [];
  if (stopped) {
    for (const duration of [null, "1h"]) {
      const plan = planResume(s.state, s.ctx, { now, forMs: duration ? HOUR : null });
      // Stops are named by reasonKey (fields + folder) rather than hit.key, which hashes the folder: the same identity, readable by a fixture signer.
      const name = (key) => reasonKey(plan.lifted.find((h) => h.key === key));
      const impact = { manual: pauseId, lifts: plan.lifted.map(reasonKey).sort(), replaced: plan.replaced.map((r) => [name(r.key), r.until ?? null]).sort(), duration };
      offers.push({ op: "resume", params: { duration }, impact, plan, expiresAtMs: plan.until });
    }
    // Stay paused once the stop lifts by itself: a pause of yours on top of it, which Resume lifts too.
    if (!manual) offers.push({ op: "pause", params: { duration: null }, impact: { manual: null, duration: null }, expiresAtMs: null });
  } else {
    for (const duration of ["1h", null]) offers.push({ op: "pause", params: { duration }, impact: { manual: pauseId, duration }, expiresAtMs: duration ? wholeMinute(now + HOUR) : null });
  }
  // Saved profiles, except the one in use as saved. The impact holds the profile's contents, so editing it voids the token.
  const { summary, saved } = savedProfiles(s.env);
  for (const name of summary.names) {
    if (name === summary.active && !summary.modified) continue;
    offers.push({ op: "profile.use", params: { name: profileLabel(summary.names, name) }, impact: { profile: digest(JSON.stringify(saved[name])) }, profile: name, expiresAtMs: null });
  }
  // The self-test runs both agents' hook commands in a throwaway home; it changes nothing to review.
  offers.push({ op: "protection.test", params: {}, impact: {}, expiresAtMs: null });
  if (s.provider === "claude") {
    // Strict on or off, as written in the settings. Turning it on checks Claude Code's version when clicked.
    const policy = failurePolicy(s.env, s.provider);
    if (policy.strict !== "unsupported") {
      const to = policy.mode === "strict" ? "default" : "strict";
      offers.push({ op: "failurePolicy.set", params: { policy: to }, impact: { from: policy.mode }, expiresAtMs: null, ...(to === "strict" && policy.strict === "requires_upgrade" ? { unavailable: "requires_upgrade" } : {}) });
    }
  }
  if ((s.ctx.allowances || []).some((m) => m.period === "daily")) {
    const weekly = s.ctx.window?.seven_day;
    const usable = usableWeekly(weekly, now);
    // Today's grants are part of the impact, so a token is spent by the grant it makes.
    const grants = usable ? activeExtras(s.env, now, weekly).filter((g) => g.period === "daily" && !g.project).map((g) => g.id).sort() : [];
    offers.push({ op: "extra.daily", params: { points: 3, duration: "1h" }, impact: { points: 3, duration: "1h", weeklyResetsAt: usable ? weekly.resetsAt : null, day: localDay(now).key, grants }, weekly, expiresAtMs: usable ? extraUntil(now, weekly) : null, ...(usable ? {} : { unavailable: "no_reading" }) });
  }
  return offers;
}

const NO_PROFILES = { names: [], active: null, modified: false };
/**
 * The saved profiles and the summary of which is in use, or none while the planning file or the
 * line config can't be read: the snapshot still goes out (with `readError`), Pause and Resume keep
 * working, and a profile can't be put back over a file nobody can read.
 */
function savedProfiles(env) {
  if (!env) return { summary: NO_PROFILES, saved: {}, unreadable: false };
  try { return { summary: profileSummary(env), saved: readPlanning(env).profiles, unreadable: false }; }
  catch { return { summary: NO_PROFILES, saved: {}, unreadable: true }; }
}

/** Why an offer cannot run now, or null. The same answer goes in the snapshot and gates the command. */
export function offerBlocked(s, offer, notReady = NOT_READY) {
  const state = healthRow(s.health).state;
  if (state === "setup_missing" || state === "hooks_disabled") return "setup_missing";
  if (notReady.has(offer.op)) return "not_ready";
  // Hooks from before v0.4 write their whole state file, pause and resumes included,
  // and could undo a change made here: pause and resume wait for `peras setup` from
  // this version (the version too, as an older setup can replace the code but not this provider's record).
  const install = readInstall(s.env);
  if ((offer.op === "pause" || offer.op === "resume") && (install?.hookMemory !== HOOK_MEMORY || install.version !== RUNTIME_VERSION)) return "runtime_outdated";
  return offer.unavailable ?? null;
}

/** What a token signs: the provider, the operation and its impact, nothing that changes every second. */
export const tokenBody = (provider, offer) => ({ provider, op: offer.op, params: offer.params, impact: offer.impact });

/**
 * Signs and checks action tokens with a secret that lives as long as one bridge:
 * a new bridge invalidates every token the app holds. A token lasts 30 to 60 seconds.
 */
export function tokenSigner(secret = crypto.randomBytes(32), { periodMs = 30_000 } = {}) {
  const at = (body, slot) => `tok_${crypto.createHmac("sha256", secret).update(JSON.stringify([slot, body])).digest("base64url").slice(0, 32)}`;
  return {
    sign: (body, now) => at(body, Math.floor(now / periodMs)),
    verify(token, body, now) {
      if (typeof token !== "string") return false;
      const slot = Math.floor(now / periodMs);
      return [slot, slot - 1].some((n) => { const want = Buffer.from(at(body, n)); const got = Buffer.from(token); return want.length === got.length && crypto.timingSafeEqual(want, got); });
    },
  };
}

function actionRows(s, now, sign, opaque, notReady) {
  const reasonId = (hit) => `rsn_${opaque(reasonKey(hit))}`;
  const manualHit = s.verdict.hits.find((h) => h.kind === "manual");
  return offeredActions(s, now).map((offer) => {
    const blocked = offerBlocked(s, offer, notReady);
    const row = { op: offer.op, provider: s.provider, params: offer.params, eligible: !blocked, disabledReason: blocked, actionToken: sign(tokenBody(s.provider, offer), now), expiresAtMs: offer.expiresAtMs };
    if (offer.plan) {
      // Everything this resume lifts, and the earlier lifts whose expiry it replaces.
      const ids = offer.plan.lifted.map(reasonId);
      row.lifts = [...(offer.plan.manual && manualHit ? [reasonId(manualHit)] : []), ...ids];
      row.extends = offer.plan.replaced.map((r) => ({ reason: ids[offer.plan.lifted.findIndex((h) => h.key === r.key)], untilMs: r.until ?? null }));
    }
    return row;
  });
}

/**
 * One global usage line and where it stands, judged as evaluate judges it:
 * clear (not reached), crossed (acting now), lifted (you resumed it, until
 * liftedUntilMs), inactive (outside its hours).
 */
function thresholdRow(rule, s, now) {
  const row = { window: rule.window, at: rule.at, action: rule.action, ...(rule.during ? { during: rule.during } : {}) };
  if (rule.during && !duringActive(rule.during, now)) return { ...row, state: "inactive" };
  const w = s.ctx.window?.[rule.window];
  if (!w || w.usedPct < rule.at) return { ...row, state: "clear" };
  if (rule.action === "warn") return { ...row, state: "crossed" };
  const key = `${ruleId(rule)}@${w.resetsAt}`;
  const lift = (s.state?.resumed || []).find((r) => r.key === key && (r.until == null || r.until > now));
  return lift ? { ...row, state: "lifted", liftedUntilMs: lift.until ?? w.resetsAt * 1000 } : { ...row, state: "crossed" };
}
export const THRESHOLD_STATES = ["clear", "crossed", "lifted", "inactive"];

/** The label each saved profile goes out under: a name that could be a folder becomes "Profile N". */
export const profileLabel = (names, name) => (name == null ? null : /[\\/]/.test(name) ? `Profile ${names.indexOf(name) + 1}` : name);

/**
 * Profile names are the person's own labels, sent as typed. A name with a path
 * separator in it could be a folder, so it goes out as "Profile N" instead.
 */
function profileRow({ names, active, modified }) {
  return { names: names.map((n) => profileLabel(names, n)), active: profileLabel(names, active), modified };
}

/**
 * One provider as protocol 1 describes it, from a providers.mjs snapshot taken
 * with `cwd: null`, so the verdict does not depend on where the bridge started.
 */
export function providerPayload(s, { now, sign, id = contextId, opaque = digest, notReady = NOT_READY } = {}) {
  if (typeof sign !== "function") throw new Error("providerPayload needs a token signer");
  let stored = null;
  try { stored = readWindow(s.env); } catch { /* reported as missing */ }
  const reasons = s.verdict.hits.map((hit) => reasonRow(hit, opaque));
  const health = healthRow(s.health);
  const { summary: profiles, unreadable } = savedProfiles(s.env);
  return {
    id: s.provider,
    accountContextId: id(s.env),
    label: s.provider === "codex" ? "Codex" : "Claude Code",
    windows: windowRows(stored, s.ctx.window ?? {}, now),
    readError: Boolean(s.error) || unreadable,
    health,
    setup: setupRow(s, health),
    protectionReceipt: receiptRow(s.env, opaque),
    failurePolicy: failurePolicy(s.env, s.provider),
    verdict: { action: s.verdict.action, reason: reasons[0]?.id ?? null },
    reasons,
    thresholds: (s.ctx.rules || []).filter((r) => r.kind === "window" && !r.project && !r.off).map((r) => thresholdRow(r, s, now)),
    planning: planningRow(s.ctx.allowances || [], s.env, now, s.ctx.window?.seven_day, opaque),
    profiles: profileRow(profiles),
    actions: actionRows(s, now, sign, opaque, notReady),
    recap: s.env ? weekRecap(s.env, s.usage, s.provider, now) : null,
  };
}

export const helloMessage = ({ bridgeInstance, runtimeVersion, environmentId }) => ({ type: "hello", protocol: PROTOCOL, bridgeInstance, runtimeVersion, environmentId });

export const snapshotMessage = ({ bridgeInstance, revision, now, providers, settings, discovery }) => ({ type: "snapshot", protocol: PROTOCOL, bridgeInstance, revision, generatedAtMs: now, providers, ...(settings ? { settings } : {}), ...(discovery ? { discovery } : {}) });

/**
 * The menu settings an app may change, each offered as the one change it would
 * make from today's value (flip a preference, switch the display), under a token
 * that names today's value: a click made against an older value is refused.
 */
export function settingsOffers(env) {
  const current = preferences(env), display = displayMode(env), style = weeklyStyle(env), look = displayStyle(env);
  return [
    ...Object.entries(current).map(([name, value]) => ({ op: "preference.set", params: { name, value: !value }, impact: { from: value } })),
    { op: "display.set", params: { value: display === "pear" ? "usage" : "pear" }, impact: { from: display } },
    ...WEEKLY_STYLES.filter((value) => value !== style).map((value) => ({ op: "weeklyStyle.set", params: { value }, impact: { from: style } })),
    ...DISPLAY_STYLES.filter((value) => value !== look).map((value) => ({ op: "displayStyle.set", params: { value }, impact: { from: look } })),
  ];
}

export const settingsTokenBody = (offer) => ({ provider: null, op: offer.op, params: offer.params, impact: offer.impact });

export function settingsPayload(env, { now, sign }) {
  return {
    preferences: preferences(env),
    display: displayMode(env),
    weeklyStyle: weeklyStyle(env),
    displayStyle: displayStyle(env),
    actions: settingsOffers(env).map((offer) => ({ op: offer.op, params: offer.params, eligible: true, disabledReason: null, actionToken: sign(settingsTokenBody(offer), now), expiresAtMs: null })),
  };
}

export const dismissTokenBody = (id) => ({ provider: null, op: "discovery.dismiss", params: { id }, impact: {} });

/**
 * PassControl links: the fixed list (opened with `link.open` and an id, never a
 * URL), and at most one suggestion, dismissed under a token for that suggestion.
 */
export function discoveryPayload(env, providers, { now, sign }) {
  // A newer Peras app takes the suggestion's place until it is installed: the app draws any link it is sent.
  const update = appUpdate(env);
  if (update) return { links: [...LINKS.map(({ id, title, detail }) => ({ id, title, detail })), update], suggestion: { id: APP_UPDATE, link: APP_UPDATE, dismiss: null } };
  const s = suggestion(env, providers);
  return {
    links: LINKS.map(({ id, title, detail }) => ({ id, title, detail })),
    suggestion: s && { ...s, dismiss: { op: "discovery.dismiss", params: { id: s.id }, eligible: true, disabledReason: null, actionToken: sign(dismissTokenBody(s.id), now), expiresAtMs: null } },
  };
}

export const APP_UPDATE = "app_update";
/** The link to a newer Peras app on this line, when the installed one is older (a preview counts as older). */
export function appUpdate(env) {
  const installed = appVersion(env);
  try { if (!installed || compareVersions(APP_RELEASE, installed) <= 0) return null; } catch { return null; }
  return { id: APP_UPDATE, title: "Newer Peras App Available", detail: `Peras app ${APP_RELEASE} is out, included in your purchase. Download it, then run peras menubar install --native --app ~/Downloads/Peras.app.` };
}

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isMs = (v) => v === null || (Number.isSafeInteger(v) && v >= 0);

/** Problems with an outbound snapshot, as a list; empty means it may be sent. */
export function snapshotProblems(message) {
  const problems = [];
  const need = (ok, what) => { if (!ok) problems.push(what); };
  need(isObject(message) && message.type === "snapshot" && message.protocol === PROTOCOL, "envelope");
  if (!problems.length) {
    need(typeof message.bridgeInstance === "string" && message.bridgeInstance.length > 0, "bridgeInstance");
    need(Number.isSafeInteger(message.revision) && message.revision >= 0, "revision");
    need(isMs(message.generatedAtMs) && message.generatedAtMs !== null, "generatedAtMs");
    need(Array.isArray(message.providers), "providers");
    need(Buffer.byteLength(JSON.stringify(message)) <= LIMITS.frameBytes, "frame size");
    const d = message.discovery;
    if (d !== undefined) need(isObject(d) && Array.isArray(d.links) && d.links.every((l) => (LINK_IDS.includes(l?.id) || l?.id === APP_UPDATE) && typeof l.title === "string" && typeof l.detail === "string") && (d.suggestion === null || (isObject(d.suggestion) && SUGGESTION_IDS.includes(d.suggestion.id) && LINK_IDS.includes(d.suggestion.link) && d.suggestion.dismiss?.op === "discovery.dismiss" && typeof d.suggestion.dismiss.actionToken === "string") || (d.suggestion?.id === APP_UPDATE && d.suggestion.link === APP_UPDATE && d.suggestion.dismiss === null && d.links.some((l) => l.id === APP_UPDATE))), "discovery");
    if (message.settings !== undefined) need(isObject(message.settings) && isObject(message.settings.preferences) && ["pear", "usage"].includes(message.settings.display) && (message.settings.weeklyStyle === undefined || WEEKLY_STYLES.includes(message.settings.weeklyStyle)) && (message.settings.displayStyle === undefined || DISPLAY_STYLES.includes(message.settings.displayStyle)) && Array.isArray(message.settings.actions) && message.settings.actions.every((a) => ["preference.set", "display.set", "weeklyStyle.set", "displayStyle.set"].includes(a?.op) && typeof a.actionToken === "string" && typeof a.eligible === "boolean"), "settings");
  }
  const seen = new Set();
  for (const [i, p] of (Array.isArray(message?.providers) ? message.providers : []).entries()) {
    const at = `providers[${i}]`;
    need(PROVIDERS.includes(p?.id) && !seen.has(p.id), `${at}.id`);
    seen.add(p?.id);
    need(typeof p?.accountContextId === "string" && /^ctx_[\w-]+$/.test(p.accountContextId), `${at}.accountContextId`);
    need(Array.isArray(p?.windows) && p.windows.length === WINDOW_NAMES.length, `${at}.windows`);
    for (const w of p?.windows ?? []) {
      need(WINDOW_NAMES.includes(w?.window) && FRESHNESS.includes(w?.freshness), `${at}.windows.${w?.window}`);
      need(w?.freshness === "missing" ? w.used === null : Number.isFinite(w?.used) && w.used >= 0 && w.used <= 100, `${at}.windows.${w?.window}.used`);
      need(isMs(w?.resetsAtMs) && isMs(w?.seenAtMs), `${at}.windows.${w?.window} times`);
    }
    need(HEALTH.includes(p?.health?.state) && isMs(p?.health?.liveGuardAtMs), `${at}.health`);
    need(SETUP_HOOKS.includes(p?.setup?.hooks) && typeof p.setup.current === "boolean" && isMs(p.setup.testPassedAtMs) && (p.setup.next === null || SETUP_STEPS.includes(p.setup.next)), `${at}.setup`);
    need(["default", "strict"].includes(p?.failurePolicy?.mode), `${at}.failurePolicy`);
    need(ACTIONS.includes(p?.verdict?.action), `${at}.verdict`);
    const r = p?.protectionReceipt;
    need(r === null || (isObject(r) && Number.isFinite(r.firstAtMs) && Number.isFinite(r.atMs) && Number.isInteger(r.count) && ACTIONS.includes(r.reason?.action) && ["points", "percent"].includes(r.reason.unit)), `${at}.protectionReceipt`);
    need(Array.isArray(p?.reasons) && p.reasons.every((r) => ACTIONS.includes(r?.action) && typeof r.code === "string" && ["global", "project"].includes(r.scope) && ["points", "percent"].includes(r.unit) && isMs(r.expiresAtMs)), `${at}.reasons`);
    need((p?.verdict?.action === "none") === !(p?.reasons ?? []).length, `${at}.verdict matches reasons`);
    need(Array.isArray(p?.thresholds) && p.thresholds.every((t) => THRESHOLD_STATES.includes(t?.state) && (t.state !== "lifted" || isMs(t.liftedUntilMs))) && isObject(p?.planning) && Array.isArray(p.planning.meters), `${at}.thresholds/planning`);
    need((p?.planning?.meters ?? []).every((m) => m?.kind !== "pacing" || ((m.expectedByTonightPercent === null || (Number.isFinite(m.expectedByTonightPercent) && m.expectedByTonightPercent >= 0 && m.expectedByTonightPercent <= 100)) && (m.pace === null || PACE_STATES.includes(m.pace)))), `${at}.planning.pace`);
    const recap = p?.recap;
    need(recap === undefined || recap === null || (isObject(recap) && typeof recap.id === "string" && isMs(recap.weekEndedAtMs) && recap.weekEndedAtMs !== null && Number.isFinite(recap.usedPercent) && recap.usedPercent >= 0 && recap.usedPercent <= 100 && isMs(recap.lastReadingAtMs) && typeof recap.atReset === "boolean" && (recap.pauses === null || (Number.isSafeInteger(recap.pauses) && recap.pauses >= 0)) && isMs(recap.untilMs)), `${at}.recap`);
    need(isObject(p?.profiles) && Array.isArray(p.profiles.names), `${at}.profiles`);
    need(Array.isArray(p?.actions) && p.actions.every((a) => typeof a?.op === "string" && a.provider === p.id && typeof a.eligible === "boolean" && isMs(a.expiresAtMs)), `${at}.actions`);
  }
  return problems;
}

// Commands from the app. Every operation and its parameters are fixed here:
// nothing in a command becomes a path, a URL or a shell command.
const PREFERENCES = ["mascots", "weekly", "warnings", "pauses", "resets", "unused", "agents"];
const duration = (v) => v === null || v === "1h";
const OPERATIONS = {
  pause: { provider: true, mutates: true, params: { duration } },
  resume: { provider: true, mutates: true, params: { duration } },
  "extra.daily": { provider: true, mutates: true, params: { points: (v) => v === 3, duration: (v) => v === "1h" } },
  "profile.use": { provider: true, mutates: true, params: { name: (v) => typeof v === "string" && v.length > 0 && v.length <= 48 } },
  "preference.set": { provider: false, mutates: true, params: { name: (v) => PREFERENCES.includes(v), value: (v) => typeof v === "boolean" } },
  "display.set": { provider: false, mutates: true, params: { value: (v) => v === "pear" || v === "usage" } },
  "weeklyStyle.set": { provider: false, mutates: true, params: { value: (v) => WEEKLY_STYLES.includes(v) } },
  "displayStyle.set": { provider: false, mutates: true, params: { value: (v) => DISPLAY_STYLES.includes(v) } },
  "failurePolicy.set": { provider: ["claude"], mutates: true, params: { policy: (v) => v === "default" || v === "strict" } },
  "settings.open": { provider: false, mutates: false, params: {} },
  "status.open": { provider: false, mutates: false, params: {} },
  "protection.test": { provider: true, mutates: false, params: {} },
  "link.open": { provider: false, mutates: false, params: { id: (v) => LINK_IDS.includes(v) || v === APP_UPDATE } },
  "discovery.dismiss": { provider: false, mutates: true, params: { id: (v) => SUGGESTION_IDS.includes(v) } },
};
export const OPERATION_NAMES = Object.keys(OPERATIONS);
export const isMutation = (op) => Boolean(OPERATIONS[op]?.mutates);

export class ProtocolError extends Error {
  constructor(code, message, id = null) { super(message); this.code = code; this.id = id; }
}

/** One command line from the app, checked field by field, or a ProtocolError. */
export function parseCommand(line) {
  if (Buffer.byteLength(line) > LIMITS.commandBytes) throw new ProtocolError("too_large", "The command is longer than 64 KiB.");
  let c;
  try { c = JSON.parse(line); } catch { throw new ProtocolError("bad_json", "The command is not JSON."); }
  const id = isObject(c) && typeof c.id === "string" && /^[\w-]{1,64}$/.test(c.id) ? c.id : null;
  const fail = (code, message) => { throw new ProtocolError(code, message, id); };
  if (!isObject(c) || c.type !== "command") fail("bad_command", "Expected a command.");
  if (c.protocol !== PROTOCOL) fail("protocol", `This runtime speaks protocol ${PROTOCOL}.`);
  if (!id) fail("bad_command", "A command needs an id of 1–64 letters, digits, - or _.");
  const spec = typeof c.op === "string" && Object.hasOwn(OPERATIONS, c.op) ? OPERATIONS[c.op] : null;
  if (!spec) fail("unknown_op", "Unknown operation.");
  const allowed = spec.provider === true ? PROVIDERS : spec.provider || [];
  if (spec.provider ? !allowed.includes(c.provider) : c.provider !== undefined) fail("bad_params", spec.provider ? `Choose ${allowed.join(" or ")}.` : "This operation takes no provider.");
  const params = c.params ?? {};
  if (!isObject(params)) fail("bad_params", "params must be an object.");
  const keys = Object.keys(spec.params);
  if (Object.keys(params).some((k) => !keys.includes(k)) || keys.some((k) => !(k in params) || !spec.params[k](params[k]))) fail("bad_params", `Unexpected parameters for ${c.op}.`);
  if (spec.mutates && (typeof c.actionToken !== "string" || !c.actionToken || c.actionToken.length > 256)) fail("bad_params", "A change needs the actionToken it was reviewed with.");
  return { id, op: c.op, ...(spec.provider ? { provider: c.provider } : {}), params, ...(spec.mutates ? { actionToken: c.actionToken } : {}) };
}

export const resultMessage = ({ id, ok, code = null, message = null }) => ({ type: "result", protocol: PROTOCOL, id, ok, ...(ok ? {} : { code, message }) });
