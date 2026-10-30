import { test } from "node:test";
import assert from "node:assert/strict";
import { sandbox, NOW, VERSION } from "./helpers.mjs";
import { context, pauseNow, readRules, readState, recordReading, resume, writeHookState, writeRules } from "../src/store.mjs";
import { writeUsage } from "../src/usage.mjs";
import { snapshot } from "../src/providers.mjs";
import { providerPayload, tokenSigner } from "../src/native-protocol.mjs";
import { runOperation } from "../src/native-operations.mjs";
import { install } from "../src/settings.mjs";
import { runHook } from "../src/hook.mjs";
import { evaluate, windowBurn } from "../src/rules.mjs";
import { codexEnv, refreshCodex, runCodexHook } from "../src/codex.mjs";
import { delegateTarget, withDelegation } from "../src/delegate.mjs";
import path from "node:path";
import { recentEvents } from "../src/events.mjs";
import { checkSavedResetReminders } from "../src/saved-resets.mjs";

const MIN = 60_000;
const resetsAt = (NOW + 4 * 3600_000) / 1000;
const rate = { kind: "rate", window: "five_hour", at: 15, span: 10, action: "pause" };
const reading = (pct, now = NOW) => ({ five_hour: { usedPct: pct, resetsAt, seenAt: now } });
const burn = env => {
  writeRules(env, [rate]);
  recordReading(env, reading(20));
  writeUsage(env, { windows: { five_hour: { resetsAt, pts: [[NOW - MIN, 0], [NOW, 20]] } }, weeks: [] });
};
const tool = (env, now) => runHook({ env, now, input: { hook_event_name: "PreToolUse", session_id: "s", tool_name: "Bash" } });

test("review 1: a snapshot-only burn keeps its identity and accepts app Resume", async () => {
  const { env } = sandbox();
  install({ env, command: `"${process.execPath}" "${new URL("../bin/peras.mjs", import.meta.url).pathname}"`, version: VERSION });
  burn(env);
  const signer = tokenSigner();
  const first = await snapshot(env, NOW, { cwd: null });
  const offer = providerPayload(first, { now: NOW, sign: signer.sign }).actions.find(a => a.op === "resume" && a.params.duration === null);
  const later = await snapshot(env, NOW + 1000, { cwd: null });
  assert.equal(later.verdict.hit.key, first.verdict.hit.key);
  assert.deepEqual(await runOperation(env, { id: "resume", op: "resume", provider: "claude", params: offer.params, actionToken: offer.actionToken }, { now: NOW + 2000, signer }), { ok: true });
  assert.equal(tool(env, NOW + 3000), null);
});

test("review 1: resume before any hook releases the same saved burn", () => {
  const { env } = sandbox();
  burn(env);
  assert.equal(resume(env, { now: NOW + 1000 }).lifted.length, 1);
  assert.equal(tool(env, NOW + 2000), null);
});

test("review 2: a delayed first hook after Resume measures from resume-time usage", () => {
  const { env } = sandbox();
  burn(env);
  tool(env, NOW);
  resume(env, { now: NOW + MIN });
  recordReading(env, reading(60, NOW + 2 * MIN));
  writeUsage(env, { windows: { five_hour: { resetsAt, pts: [[NOW - MIN, 0], [NOW, 20], [NOW + 2 * MIN, 60]] } }, weeks: [] });
  assert.equal(tool(env, NOW + 2 * MIN)?.hookSpecificOutput?.permissionDecision, "deny");
  const ctx = context(env, { now: NOW + 2 * MIN, usage: { windows: { five_hour: { resetsAt, pts: [[NOW + 2 * MIN, 60]] } } } });
  assert.equal(evaluate(ctx).hit.rise, 40);
  assert.equal(windowBurn("five_hour", ctx.window.five_hour, ctx.history.five_hour, ctx.now, 10, ctx.rateLatch).burst.rise, 40);
});

test("review 3: subagent warn and pause notifications are deduplicated in both hooks", async () => {
  for (const provider of ["claude", "codex"]) for (const action of ["warn", "pause"]) {
    const { env, root } = sandbox();
    const scoped = provider === "codex" ? codexEnv(env) : env;
    writeRules(scoped, [{ kind: "agents", at: 0, action }]);
    const notes = [];
    const input = { hook_event_name: "PreToolUse", session_id: "s", cwd: root, tool_name: provider === "codex" ? "spawn_agent" : "Agent" };
    const options = { env, input, notify: (...args) => notes.push(args), reader: async () => ({}) };
    const call = provider === "codex" ? runCodexHook : runHook;
    await call({ ...options, now: NOW });
    await call({ ...options, now: NOW + 1000 });
    assert.equal(notes.length, 1, `${provider} ${action}`);
    assert.equal(readState(scoped, NOW + 1000).notified.length, 1);
    assert.equal(readState(scoped, NOW + 8 * 86400_000).notified.length, 0, "expires with prompt memory");
  }
});

test("review 4: delegation checks the launch folder, not unrelated saved target sessions", () => {
  for (const provider of ["claude", "codex"]) {
    const { env, root } = sandbox();
    const target = provider === "claude" ? codexEnv(env) : env;
    const projectA = path.join(root, "a"), projectB = path.join(root, "b");
    recordReading(target, reading(80));
    writeRules(target, [{ kind: "window", window: "five_hour", at: 50, action: "pause", project: projectA }]);
    const state = readState(target, NOW);
    state.sessions.old = { cwd: projectA, t: NOW };
    writeHookState(target, state, NOW);
    const input = { hook_event_name: "PreToolUse", cwd: projectB, tool_name: provider === "claude" ? "Bash" : "exec_command", tool_input: { command: provider === "claude" ? "codex exec review" : "claude -p review" } };
    assert.equal(withDelegation(null, { provider, input, env, now: NOW }), null, `${provider}: unrelated stop`);
    input.cwd = projectA;
    assert.equal(withDelegation(null, { provider, input, env, now: NOW }).hookSpecificOutput.permissionDecision, "deny", `${provider}: matching stop`);
  }
});

test("review 5: a target's manual pause blocks delegation without a live reading", () => {
  for (const provider of ["claude", "codex"]) for (const expired of [false, true]) {
    const { env, root } = sandbox();
    const target = provider === "claude" ? codexEnv(env) : env;
    writeRules(target, []);
    if (expired) recordReading(target, { five_hour: { usedPct: 90, resetsAt: NOW / 1000 - 1, seenAt: NOW - MIN } });
    pauseNow(target, { now: NOW });
    const input = { hook_event_name: "PreToolUse", cwd: root, tool_name: provider === "claude" ? "Bash" : "exec_command", tool_input: { command: provider === "claude" ? "codex exec review" : "claude -p review" } };
    assert.equal(withDelegation(null, { provider, input, env, now: NOW })?.hookSpecificOutput?.permissionDecision, "deny");
    resume(target, { now: NOW + 1000 });
    assert.equal(withDelegation(null, { provider, input, env, now: NOW + 1000 }), null);
  }
});

test("review 6: shell comments hide delegation commands until the next line", () => {
  for (const command of ["echo ok # ; codex exec review", "# codex exec review", "echo ok # && codex exec review", "echo ok # | codex exec review"]) {
    assert.equal(delegateTarget("claude", "Bash", { command }), null, command);
  }
  assert.equal(delegateTarget("codex", "exec_command", { cmd: "echo ok # ; claude -p review" }), null);
  assert.equal(delegateTarget("codex", "local_shell", { command: ["bash", "-lc", "echo ok # ; claude -p review"] }), null);
  for (const command of ["echo ok # ignored\ncodex exec review", 'echo "#"; codex exec review', "echo '#'; codex exec review", "echo ok# ; codex exec review", "echo \\# ; codex exec review"]) {
    assert.equal(delegateTarget("claude", "Bash", { command }), "codex", command);
  }
});

test("review 7: Codex agents ask uses spawn-only denial and warning notification", async () => {
  for (const action of ["ask", "pause"]) {
    const { env, root } = sandbox();
    const scoped = codexEnv(env);
    writeRules(scoped, [{ kind: "agents", at: 0, action }]);
    const notes = [];
    const input = { hook_event_name: "PreToolUse", session_id: "s", cwd: root, tool_name: "spawn_agent" };
    const out = await runCodexHook({ env, now: NOW, input, reader: async () => ({}), notify: (...args) => notes.push(args) });
    assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /^Peras is not starting new subagents:/);
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /Continue without new subagents/);
    assert.match(notes[0][1], /^Warning:/);
    assert.equal(notes[0][2].category, "status");
    assert.equal(recentEvents(scoped, Infinity)[0].kind, "warning");
    const ordinary = await runCodexHook({ env, now: NOW + 1000, input: { ...input, tool_name: "exec" }, reader: async () => ({}) });
    assert.notEqual(ordinary?.hookSpecificOutput?.permissionDecision, "deny");
  }
});

test("review 8: each saved credit is reminded when it enters its final day", async () => {
  const { env } = sandbox();
  const HOUR = 3600_000;
  const credits = [24, 25].map((hours, i) => ({ id: `credit-${i}`, status: "available", expiresAt: (NOW + hours * HOUR) / 1000 }));
  await refreshCodex(env, NOW, { force: true, reader: async () => ({ rateLimits: { primary: { usedPercent: 20, windowDurationMins: 300, resetsAt } }, rateLimitResetCredits: { availableCount: 2, credits } }) });
  const notes = [];
  const check = now => checkSavedResetReminders(env, [{ provider: "codex", env: codexEnv(env) }], now, (...args) => notes.push(args));
  check(NOW);
  assert.equal(notes.length, 1);
  check(NOW + HOUR);
  assert.equal(notes.length, 2, "the second credit has 24 hours left, while the first is still available");
  check(NOW + HOUR + MIN);
  assert.equal(notes.length, 2, "neither reminder repeats");
});

test("review 8: credits with the same expiry retain separate reminder identities", async () => {
  const { env } = sandbox();
  const credits = ["a", "b"].map(id => ({ id, status: "available", expiresAt: (NOW + 3600_000) / 1000 }));
  const reader = async () => ({ rateLimits: { primary: { usedPercent: 20, windowDurationMins: 300, resetsAt } }, rateLimitResetCredits: { availableCount: 2, credits } });
  await refreshCodex(env, NOW, { force: true, reader });
  const notes = [];
  const check = now => checkSavedResetReminders(env, [{ provider: "codex", env: codexEnv(env) }], now, (...args) => notes.push(args));
  check(NOW);
  assert.equal(notes.length, 2);
  credits.reverse();
  await refreshCodex(env, NOW + MIN, { force: true, reader });
  check(NOW + MIN);
  assert.equal(notes.length, 2, "reordering credits doesn't repeat reminders");
});


test("review rate gap: sparse history cannot claim a short-interval rise", () => {
  const check = points => evaluate({ window: reading(20), rules: [rate], now: NOW, history: { five_hour: points } });
  assert.equal(check([[NOW - 60 * MIN, 0], [NOW, 20]]).action, "none");
  assert.equal(check([[NOW - 60 * MIN, 0]]).action, "none");
  assert.equal(check([[NOW - 60 * MIN, 0], [NOW - MIN, 18], [NOW, 20]]).action, "none");
  assert.equal(check([[NOW - 60 * MIN, 0], [NOW - MIN, 2], [NOW, 20]]).hit.rise, 18);
  assert.equal(check([[NOW - 10 * MIN - 1000, 0], [NOW, 20]]).hit.rise, 20, "allow small sampling slack");
});


test("review burn latch: a stopped badge preserves the triggering measurement", async () => {
  const { env } = sandbox();
  writeRules(env, [rate]);
  recordReading(env, reading(22));
  writeUsage(env, { windows: { five_hour: { resetsAt, pts: [[NOW - 2 * MIN, 0], [NOW, 22]] } }, weeks: [] });
  await snapshot(env, NOW, { cwd: null });
  const later = NOW + 11 * MIN;
  const payload = providerPayload(await snapshot(env, later, { cwd: null }), { now: later, sign: () => "tok_test" });
  const badge = payload.burn.find(b => b.window === "five_hour");
  assert.equal(badge.state, "stopped");
  assert.equal(badge.rise, 22);
  assert.equal(badge.rise, payload.reasons.find(r => r.kind === "rate").used);
  assert.equal(badge.sinceMs, NOW - 2 * MIN);
  assert.equal(badge.measuredAtMs, NOW);
  assert.equal((badge.measuredAtMs - badge.sinceMs) / MIN, 2);
});


test("review spawn resume: spawn-only stops offer a signed working Resume", async () => {
  for (const kind of ["agents", "spawnhold"]) {
    const { env, root } = sandbox();
    install({ env, command: `"${process.execPath}" "${new URL("../bin/peras.mjs", import.meta.url).pathname}"`, version: VERSION });
    if (kind === "agents") writeRules(env, [{ kind: "agents", at: 0, action: "pause" }]);
    else {
      burn(env);
      writeRules(env, [{ ...rate, action: "warn" }]);
    }
    const spawn = now => runHook({ env, now, input: { hook_event_name: "PreToolUse", session_id: "s", cwd: root, tool_name: "Agent" } });
    assert.equal(spawn(NOW).hookSpecificOutput.permissionDecision, "deny");
    const signer = tokenSigner();
    const s = await snapshot(env, NOW + 1000, { cwd: null });
    const payload = providerPayload(s, { now: NOW + 1000, sign: signer.sign });
    assert.equal(payload.verdict.action, "warn", "the agent itself keeps running");
    const offer = payload.actions.find(a => a.op === "resume" && a.params.duration === null);
    assert.ok(offer?.eligible, kind + " has a usable resume");
    assert.deepEqual(offer.lifts, payload.reasons.filter(r => r.kind === kind).map(r => r.id));
    assert.deepEqual(await runOperation(env, { id: "spawn-resume", op: "resume", provider: "claude", params: offer.params, actionToken: offer.actionToken }, { now: NOW + 2000, signer }), { ok: true });
    assert.notEqual(spawn(NOW + 3000)?.hookSpecificOutput?.permissionDecision, "deny", kind + " resumes subagents");
  }
});


test("review agents zero: settings form allows zero only for subagent rules", async () => {
  const { settingsHTML } = await import("../src/settings-page.mjs");
  const { runInNewContext } = await import("node:vm");
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { elements: new Proxy({}, { get: (fields, name) => fields[name] ??= { value: name === "kind" ? "window" : "" } }) });
    return elements.get(id);
  };
  const script = settingsHTML().match(/<script>([\s\S]*?)<\/script>/)[1];
  runInNewContext(script, {
    document: { getElementById: element }, location: { hash: "", pathname: "/" }, history: { replaceState() {} },
    sessionStorage: { getItem: () => null }, fetch: () => new Promise(() => {}),
  });
  const fields = element("rule-form").elements;
  fields.kind.value = "agents";
  fields.kind.onchange();
  assert.equal(Number(fields.at.min), 0);
  assert.equal(fields.at.step, "1");
  for (const kind of ["window", "pace", "prompt", "rate"]) {
    fields.kind.value = kind;
    fields.kind.onchange();
    assert.ok(Number(fields.at.min) > 0, kind + " still requires a positive threshold");
  }
});

test("review agents zero: settings server keeps and edits zero subagent rules", async t => {
  const { default: http } = await import("node:http");
  const { Readable } = await import("node:stream");
  const { startSettingsServer } = await import("../src/settings-server.mjs");
  // Exercise the actual request handler without binding a sandbox-restricted socket.
  const createServer = http.createServer;
  const stub = t.mock.method(http, "createServer", (...args) => {
    const server = createServer(...args);
    server.listen = (_port, _host, ready) => { ready(); return server; };
    server.address = () => ({ port: 43123 });
    server.close = done => { server.emit("close"); done(); return server; };
    return server;
  });
  const { env } = sandbox();
  const zero = { kind: "agents", at: 0, action: "pause" };
  writeRules(env, [zero]);
  const app = await startSettingsServer({ env, now: () => NOW, getSnapshots: async () => [] });
  stub.mock.restore();
  t.after(() => app.close());
  const request = async (url, body) => {
    const req = Readable.from(body ? [JSON.stringify(body)] : []);
    Object.assign(req, { url, method: body ? "POST" : "GET", headers: {
      host: new URL(app.origin).host, origin: app.origin, authorization: `Bearer ${app.token}`, "content-type": "application/json",
    } });
    const response = { status: null, body: null };
    const res = { setHeader() {}, writeHead: status => { response.status = status; }, end: raw => { response.body = JSON.parse(raw); } };
    await app.server.listeners("request")[0](req, res);
    return response;
  };
  const save = async body => {
    const { body: state } = await request("/api/state");
    return request("/api/save", { revision: state.revision, provider: "claude", op: "rule", ...body });
  };
  for (const provider of ["claude", "codex"]) {
    const scoped = provider === "codex" ? codexEnv(env) : env;
    if (provider === "claude") assert.equal((await save({ provider, rule: zero, original: zero })).status, 200, "keep an existing CLI rule");
    else assert.equal((await save({ provider, rule: zero })).status, 200, "create a zero rule");
    assert.deepEqual(readRules(scoped).find(r => r.kind === "agents"), zero);
    const one = { ...zero, at: 1 };
    assert.equal((await save({ provider, rule: one, original: zero })).status, 200);
    assert.equal((await save({ provider, rule: zero, original: one })).status, 200, "edit back to zero");
  }
  for (const at of [-1, 0.5]) assert.equal((await save({ rule: { ...zero, at } })).status, 400);
  for (const kind of ["window", "pace", "prompt", "rate"]) {
    assert.equal((await save({ rule: { kind, window: "five_hour", at: 0, action: "pause" } })).status, 400, kind);
  }
});
