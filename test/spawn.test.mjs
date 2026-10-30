import { test } from "node:test";
import assert from "node:assert/strict";
import { isSpawnTool } from "../src/spawn.mjs";
import { evaluate, normalizeRules, parseSet, ruleId, effectiveRules } from "../src/rules.mjs";
import { describe, runHook } from "../src/hook.mjs";
import { codexEnv, runCodexHook } from "../src/codex.mjs";
import { configFile, readJson, readRules, readState, recordReading, resume, sessionVerdict, writeJsonAtomic, writeRules } from "../src/store.mjs";
import { writeUsage } from "../src/usage.mjs";
import { main } from "../src/cli.mjs";
import { snapshot } from "../src/providers.mjs";
import { providerPayload, snapshotMessage, snapshotProblems } from "../src/native-protocol.mjs";
import { NOW, sandbox } from "./helpers.mjs";
const MIN = 60_000;

const agents = { kind: "agents", at: 3, action: "ask" };
const resetsAt = (NOW + 4 * 3600_000) / 1000;
const reading = { five_hour: { usedPct: 22, resetsAt, seenAt: NOW } };
const reader = async () => ({ rateLimits: { primary: { usedPercent: 22, windowDurationMins: 300, resetsAt } } });
const decision = out => out?.hookSpecificOutput?.permissionDecision;

test("spawn tools are provider-specific, including qualified Codex names", () => {
  for (const name of ["Agent", "Task"]) assert.equal(isSpawnTool("claude", name), true);
  // "collaborationspawn_agent" is what Codex CLI 0.163.0 sent the hook in a live run (2026-10-27).
  for (const name of ["spawn_agent", "collaborationspawn_agent", "collaboration.spawn_agent", "collaboration__spawn_agent"]) assert.equal(isSpawnTool("codex", name), true);
  for (const provider of ["claude", "codex", "future"]) {
    for (const name of ["Bash", "exec", "wait_agent", undefined]) assert.equal(isSpawnTool(provider, name), false);
  }
  assert.equal(isSpawnTool("codex", "Agent"), false);
  assert.equal(isSpawnTool("claude", "spawn_agent"), false);
});

test("agents parse, normalize and folder overrides have no window", () => {
  for (const [words, at, action] of [["agents 3 ask", 3, "ask"], ["agents 2 pause", 2, "pause"], ["agents off pause", null, "pause"], ["agents 0 pause", 0, "pause"]]) {
    assert.deepEqual(parseSet(words.split(" ")), { op: "set", rule: { kind: "agents", action }, at });
  }
  assert.deepEqual(normalizeRules([agents]), [agents]);
  assert.equal(ruleId(agents), "agents:3:ask");
  assert.match(ruleId({ ...agents, during: "09:00-17:00", project: "/tmp" }), /^agents:3:ask:09:00-17:00:p/);
  assert.deepEqual(effectiveRules([agents, { ...agents, project: "/tmp", off: true }], "/tmp/a"), []);
  for (const words of ["agents 1.5 ask", "5h agents 3 ask"]) assert.throws(() => parseSet(words.split(" ")));
  assert.deepEqual(normalizeRules([{ ...agents, at: 1.5 }]), []);
  assert.equal(evaluate({ rules: [agents], window: {}, spawn: { isSpawn: false, before: 9 }, prompt: { id: "p" } }).action, "none");
});

for (const provider of ["claude", "codex"]) {
  for (const action of ["ask", "pause"]) test(`${provider}: three spawns pass, fourth ${action}, other tools pass, next prompt resets`, async () => {
    const { env, root } = sandbox();
    const scoped = provider === "codex" ? codexEnv(env) : env;
    writeRules(scoped, [{ ...agents, action }]);
    let now = NOW;
    const call = async (event, tool_name) => {
      const opts = { env, now: now++, input: { hook_event_name: event, tool_name, session_id: "parent", cwd: root }, reader };
      return provider === "codex" ? runCodexHook(opts) : runHook(opts);
    };
    const spawn = provider === "codex" ? "spawn_agent" : "Agent";
    await call("UserPromptSubmit");
    for (let i = 0; i < 3; i++) assert.equal(decision(await call("PreToolUse", spawn)), undefined);
    assert.equal(decision(await call("PreToolUse", "Bash")), undefined);
    assert.equal(decision(await call("PreToolUse", spawn)), action === "ask" && provider === "claude" ? "ask" : "deny");
    assert.equal(readState(scoped, now).spawns.parent.n, 3, "blocked spawns do not count");
    const payload = providerPayload(await snapshot(env, now, { provider, cwd: null }), { now, sign: () => "test" });
    assert.equal(payload.reasons[0].kind, "agents");
    assert.equal(payload.reasons[0].window, null);
    assert.equal(payload.reasons[0].used, 3);
    assert.equal(payload.reasons[0].unit, "count");
    assert.deepEqual(snapshotProblems(snapshotMessage({ bridgeInstance: "test", revision: 0, now, providers: [payload] })), []);
    resume(scoped, { now });
    assert.equal(decision(await call("PreToolUse", spawn)), undefined);
    assert.equal(readState(scoped, now).spawns.parent.n, 4);
    await call("UserPromptSubmit");
    assert.equal(decision(await call("PreToolUse", spawn)), undefined);
    assert.equal(readState(scoped, now).spawns.parent.n, 1);
  });

  test(`${provider}: rate warning holds only spawns; resume lifts that hold`, async () => {
    const { env, root } = sandbox();
    const scoped = provider === "codex" ? codexEnv(env) : env;
    writeRules(scoped, [{ kind: "rate", window: "five_hour", at: 15, span: 10, action: "warn" }]);
    recordReading(scoped, reading);
    writeUsage(scoped, { windows: { five_hour: { resetsAt, pts: [[NOW - 60_000, 0], [NOW, 22]] } }, weeks: [] });
    const call = async tool_name => {
      const opts = { env, now: NOW, reader, input: { hook_event_name: "PreToolUse", tool_name, session_id: "parent", cwd: root } };
      return provider === "codex" ? runCodexHook(opts) : runHook(opts);
    };
    assert.equal(decision(await call(provider === "codex" ? "exec" : "Bash")), undefined);
    const spawn = provider === "codex" ? "spawn_agent" : "Task";
    const held = await call(spawn);
    assert.equal(decision(held), "deny");
    assert.match(held.hookSpecificOutput.permissionDecisionReason, /not starting new subagents: new subagents are held while usage is burning fast/);
    assert.equal(readState(scoped, NOW).spawns.parent.n, 0);
    assert.ok(resume(scoped, { now: NOW }).lifted.some(h => h.kind === "spawnhold"));
    assert.equal(decision(await call(spawn)), undefined);
  });
}

test("windowless lines survive status, why, native snapshot, and preserve future kinds", async () => {
  const { env } = sandbox();
  const future = { kind: "future", opaque: [1, 2] };
  writeJsonAtomic(configFile(env), { v: 3, rules: [agents, future] });
  writeRules(env, readRules(env));
  assert.deepEqual(readJson(configFile(env)).rules.at(-1), future);
  recordReading(env, reading);
  for (const command of ["status", "why"]) {
    const lines = [];
    assert.equal(await main([command], { env, now: NOW, out: line => lines.push(line) }), 0);
    if (command === "status") assert.match(lines.join("\n"), /more than 3 subagents per prompt ask/);
  }
  const payload = providerPayload(await snapshot(env, NOW, { cwd: null }), { now: NOW, sign: () => "test" });
  assert.deepEqual(payload.thresholds, []);
  assert.equal(payload.verdict.action, "none");
});

test("a spawn-only hold reads as a warning and never outranks a real stop", () => {
  const window = { five_hour: { usedPct: 30, resetsAt: (NOW + 4 * 3600_000) / 1000, seenAt: NOW } };
  const history = { five_hour: [[NOW - MIN, 0], [NOW, 30]] };
  const rate = { kind: "rate", window: "five_hour", at: 20, span: 10, action: "warn" };
  const spawn = { isSpawn: true, before: 0 };
  const held = evaluate({ window, rules: [rate], now: NOW, history, spawn });
  assert.equal(held.hit.kind, "spawnhold");
  const both = evaluate({ window, rules: [rate, { kind: "window", window: "five_hour", at: 25, action: "pause" }], now: NOW, history, spawn });
  assert.equal(both.hit.kind, "window", "a pause for the whole agent comes first");
  const state = { sessions: {}, prompts: {}, spawns: {} };
  assert.equal(sessionVerdict({ window, rules: [rate], now: NOW, history, resumed: [] }, state).action, "warn");
});

test("resuming one rate line lets the whole burst go for every rate line", () => {
  const window = { five_hour: { usedPct: 47, resetsAt: (NOW + 4 * 3600_000) / 1000, seenAt: NOW } };
  const history = { five_hour: [[NOW - 9 * MIN, 25], [NOW - 2 * MIN, 30], [NOW, 47]] };
  const rules = [{ kind: "rate", window: "five_hour", at: 20, span: 10, action: "warn" }, { kind: "rate", window: "five_hour", at: 15, span: 5, action: "pause" }];
  const fired = evaluate({ window, rules, now: NOW, history });
  assert.equal(fired.action, "pause");
  const pause = fired.hits.find(h => h.action === "pause" && h.kind === "rate");
  const after = evaluate({ window, rules, now: NOW + MIN, history, rateLatch: fired.rateLatch, resumed: [{ key: pause.key }] });
  assert.equal(after.action, "none", "the warning line doesn't fire again on the burst you let go");
});

test("spawns started together count one by one: 8 Claude hook processes, line 3", async () => {
  const { env, root } = sandbox();
  const { spawn } = await import("node:child_process");
  writeRules(env, [{ kind: "agents", at: 3, action: "pause" }]);
  const now = Date.now(), reset = Math.floor(now / 1000) + 4 * 3600;
  recordReading(env, { five_hour: { usedPct: 5, resetsAt: reset, seenAt: now }, seven_day: { usedPct: 30, resetsAt: reset + 3 * 86400, seenAt: now } }, { now });
  const bin = new URL("../bin/peras.mjs", import.meta.url).pathname;
  const run = (input) => new Promise((done) => {
    const p = spawn(process.execPath, [bin, "hook"], { env });
    let out = "";
    p.stdout.on("data", (d) => out += d);
    p.on("close", () => done(out));
    p.stdin.end(JSON.stringify(input));
  });
  const outs = await Promise.all([...Array(8)].map(() => run({ hook_event_name: "PreToolUse", session_id: "fan", cwd: root, tool_name: "Agent", tool_input: {} })));
  assert.equal(outs.filter((o) => /"permissionDecision":"deny"/.test(o)).length, 5);
});

test("a session with no prompt event still counts its spawns", async () => {
  const { env, root } = sandbox();
  const scoped = codexEnv(env);
  writeRules(scoped, [{ kind: "agents", at: 2, action: "ask" }]);
  const reader = async () => ({ rateLimits: { primary: { usedPercent: 5, windowDurationMins: 300, resetsAt: (NOW + 4 * 3600_000) / 1000 } } });
  const outs = [];
  for (let i = 0; i < 4; i++) outs.push(await runCodexHook({ env, now: NOW + i * 1000, reader, input: { hook_event_name: "PreToolUse", session_id: "headless", cwd: root, tool_name: "spawn_agent", tool_input: {} } }));
  assert.deepEqual(outs.map((o) => o?.hookSpecificOutput?.permissionDecision ?? "allow"), ["allow", "allow", "deny", "deny"]);
  assert.equal(readState(scoped, NOW + 4000).spawns.headless.n, 2, "refused spawns give their slot back");
});

test("resuming a headless run's subagent stop keeps", async () => {
  const { env, root } = sandbox();
  const scoped = codexEnv(env);
  writeRules(scoped, [{ kind: "agents", at: 2, action: "ask" }]);
  const reader = async () => ({ rateLimits: { primary: { usedPercent: 5, windowDurationMins: 300, resetsAt: (NOW + 4 * 3600_000) / 1000 } } });
  const spawn = (i) => runCodexHook({ env, now: NOW + i * 1000, reader, input: { hook_event_name: "PreToolUse", session_id: "headless", cwd: root, tool_name: "spawn_agent", tool_input: {} } });
  for (let i = 0; i < 3; i++) await spawn(i);
  assert.equal((await spawn(3))?.hookSpecificOutput?.permissionDecision, "deny");
  assert.equal(await main(["codex", "resume"], { env, now: NOW + 4000, out: () => {} }), 0);
  assert.equal((await spawn(5))?.hookSpecificOutput?.permissionDecision ?? "allow", "allow", "the resume holds for this run");
});

test("parallel hooks can't write a burn stop away, and resuming either latch lets the burst go", async () => {
  const { env } = sandbox();
  const { writeHookState } = await import("../src/store.mjs");
  const base = `${ruleId(normalizeRules([{ kind: "rate", window: "five_hour", at: 15, span: 5, action: "pause" }])[0])}@99999999999`;
  const stale = readState(env, NOW);
  const a = readState(env, NOW);
  a.rateLatch = { [base]: { firedAt: NOW, rise: 20, since: NOW - 60_000 } };
  writeHookState(env, a, NOW);
  writeHookState(env, stale, NOW + 10);
  assert.equal(readState(env, NOW + 20).rateLatch[base]?.firedAt, NOW, "the older snapshot keeps A's stop");
  const b = readState(env, NOW);
  b.rateLatch = { [base]: { firedAt: NOW + 5, rise: 21, since: NOW - 60_000 } };
  writeHookState(env, b, NOW + 30);
  assert.equal(readState(env, NOW + 40).rateLatch[base].firedAt, NOW, "the earliest stop stands");
  const released = { [base]: { releasedAt: NOW + 50, byResume: true } };
  const c = readState(env, NOW); c.rateLatch = released;
  writeHookState(env, c, NOW + 50);
  assert.deepEqual(readState(env, NOW + 60).rateLatch[base], released[base], "a later release wins");
  const window = { five_hour: { usedPct: 40, resetsAt: 99999999999 } };
  const rules = [{ kind: "rate", window: "five_hour", at: 15, span: 5, action: "pause" }];
  const resumed = [{ key: `${base}#${NOW + 5}`, until: null }];
  const out = evaluate({ window, rules, now: NOW + 70, resumed, rateLatch: { [base]: { firedAt: NOW, rise: 20, since: NOW - 60_000 } }, history: { five_hour: [[NOW - 60_000, 20], [NOW + 60, 40]] } });
  assert.equal(out.action, "none", "resuming the later latch released the earlier one");
});

test("an older hook's copy can't bring back a burst a resume let go, nor keep expired latches", async () => {
  const { env } = sandbox();
  const { writeHookState } = await import("../src/store.mjs");
  const base = `${ruleId(normalizeRules([{ kind: "rate", window: "five_hour", at: 15, span: 5, action: "pause" }])[0])}@99999999999`;
  const gone = `${ruleId(normalizeRules([{ kind: "rate", window: "five_hour", at: 15, span: 5, action: "pause" }])[0])}@1000`;
  const now = readState(env, NOW); now.rateLatch = { [base]: { releasedAt: NOW + 10, byResume: true, firedAt: NOW + 20, rise: 18, since: NOW + 15 } };
  writeHookState(env, now, NOW + 20);
  const stale = readState(env, NOW); stale.rateLatch = { [base]: { firedAt: NOW, rise: 20, since: NOW - 60_000 }, [gone]: { firedAt: 999 } };
  writeHookState(env, stale, NOW + 30);
  const latch = readState(env, NOW + 40).rateLatch[base];
  assert.equal(latch.firedAt, NOW + 20, "the new burst stands, not the one that was resumed");
  assert.equal(latch.releasedAt, NOW + 10);
  const { readJson: read, hookMemoryFile } = await import("../src/store.mjs");
  assert.equal(Object.keys(read(hookMemoryFile(env)).rateLatch).includes(gone), false, "an expired latch is not written back");
});

test("two headless sessions started in the same millisecond keep their own subagent stops", async () => {
  const window = { five_hour: { usedPct: 5, resetsAt: 99999999999 } };
  const rules = [{ kind: "agents", at: 1, action: "pause" }];
  const key = (session) => evaluate({ window, rules, now: NOW, spawn: { isSpawn: true, prompt: "session", before: 1, sessionStart: NOW, session } }).hits[0].key;
  assert.notEqual(key("019a-aaaa-1111"), key("019a-bbbb-2222"));
});

test("a subagent line of 0 says no subagents start, not that 0 were started", () => {
  const zero = describe({ kind: "agents", at: 0, before: 0, action: "pause" }, NOW).what;
  assert.match(zero, /^the subagent line is 0, so no subagents start/);
  assert.doesNotMatch(zero, /already started 0/);
  assert.match(describe({ kind: "agents", at: 3, before: 3, action: "pause" }, NOW).what, /already started 3 subagents, reaching the line of 3/);
});
