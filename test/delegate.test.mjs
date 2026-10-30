import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { delegateTarget } from "../src/delegate.mjs";
import { runHook } from "../src/hook.mjs";
import { codexEnv, runCodexHook } from "../src/codex.mjs";
import { pauseNow, recordReading, stateFile, windowFile, writeRules } from "../src/store.mjs";
import { writeUsage } from "../src/usage.mjs";
import { NOW, sandbox } from "./helpers.mjs";

const codexCommands = [
  ['codex exec "review"', true], ['codex e "review"', true],
  ['codex -m x exec "review"', true], ['codex --model=x exec review', true],
  ['cd ~/x && codex exec review', true], ['false || codex e review', true],
  ['echo hi | codex exec -', true], ['echo hi; codex exec review', true],
  ['echo hi\ncodex exec review', true], ['FOO=1 BAR="two words" codex exec review', true],
  ['/opt/homebrew/bin/codex exec review', true], ['"/opt/homebrew/bin/codex" exec review', true],
  ['codex -c model_reasoning_effort=low -m x exec review', true],
  ['codex --version', false], ['codex features list', false], ['codex login', false],
  ['which codex', false], ['grep codex file', false], ['echo "codex exec"', false],
  ["echo 'hi; codex exec review'", false], ['echo "hi && codex exec review"', false],
  ['echo "hi | codex exec review"', false], ['codex', false],
  ['codex -m exec --version', false], ['mycodex exec review', false],
  ['codex features exec', false], ['cat file # codex exec', false],
];
for (const [command, matches] of codexCommands) test(`Claude command: ${JSON.stringify(command)}`, () => {
  assert.equal(delegateTarget("claude", "Bash", { command }), matches ? "codex" : null);
});

for (const [command, matches] of [
  ['claude -p "review"', true], ['claude --print review', true],
  ['claude --model sonnet review -p', true], ['FOO=1 /usr/local/bin/claude --print review', true],
  ['cd ~/x && claude -p review', true], ['echo hi | claude -p', true],
  ['claude --version', false], ['claude mcp list', false],
  ['echo "claude -p"', false], ["echo 'hi; claude -p review'", false],
  ['which claude', false], ['grep claude file', false], ['claude', false],
]) test(`Codex command: ${JSON.stringify(command)}`, () => {
  for (const tool of ["Bash", "exec", "shell", "exec_command", "local_shell"]) {
    assert.equal(delegateTarget("codex", tool, { command }), matches ? "claude" : null);
  }
});

test("matcher accepts shell command arrays and ignores other tools and malformed inputs", () => {
  assert.equal(delegateTarget("codex", "local_shell", { command: ["claude", "-p", "review"] }), "claude");
  assert.equal(delegateTarget("codex", "shell", { command: ["bash", "-lc", "claude -p review"] }), "claude");
  for (const command of [null, 7, {}, ["claude", null]]) assert.equal(delegateTarget("codex", "shell", { command }), null);
  assert.equal(delegateTarget("claude", "Read", { command: "codex exec review" }), null);
  assert.equal(delegateTarget("codex", "spawn_agent", { command: "claude -p review" }), null);
  assert.equal(delegateTarget("unknown", "Bash", { command: "codex exec review" }), null);
});

const resetsAt = (NOW + 3600_000) / 1000;
const reading = pct => ({ five_hour: { usedPct: pct, resetsAt, seenAt: NOW } });
const reader = async () => ({ rateLimits: { primary: { usedPercent: 10, windowDurationMins: 300, resetsAt } } });
const line = action => ({ kind: "window", window: "five_hour", at: 75, action });
const decision = out => out?.hookSpecificOutput?.permissionDecision;
function fixture(provider = "claude") {
  const { env, root } = sandbox();
  writeRules(env, []);
  writeRules(codexEnv(env), []);
  const target = provider === "claude" ? codexEnv(env) : env;
  const input = { hook_event_name: "PreToolUse", session_id: "parent", cwd: root, tool_name: "Bash", tool_input: { command: provider === "claude" ? "codex exec review" : "claude -p review" } };
  const call = () => provider === "claude" ? runHook({ env, input, now: NOW }) : runCodexHook({ env, input, now: NOW, reader });
  return { env, target, input, call };
}

for (const provider of ["claude", "codex"]) {
  for (const action of ["pause", "ask"]) test(`${provider}: a saved ${action} on the callee denies delegation`, async () => {
    const { target, call } = fixture(provider);
    recordReading(target, reading(79));
    writeRules(target, [line(action)]);
    const out = await call();
    assert.equal(decision(out), "deny");
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /is paused: 5-hour usage is 79%/);
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /Stop and tell the user why/);
  });

  test(`${provider}: warning allows with a fact on every delegation`, async () => {
    const { target, call } = fixture(provider);
    recordReading(target, reading(79));
    writeRules(target, [line("warn")]);
    for (let i = 0; i < 2; i++) {
      const out = await call();
      assert.equal(decision(out), undefined);
      assert.match(out.systemMessage, /(?:Codex|Claude Code): 5-hour 79%\./);
    }
  });

  test(`${provider}: no callee reading allows silently`, async () => {
    const { target, call } = fixture(provider);
    writeRules(target, [line("pause")]);
    assert.equal(await call(), null);
  });

  test(`${provider}: the caller's own deny wins`, async () => {
    const { env, target, call } = fixture(provider);
    recordReading(target, reading(79));
    writeRules(target, [line("pause")]);
    pauseNow(provider === "claude" ? env : codexEnv(env), { now: NOW });
    const out = await call();
    assert.equal(decision(out), "deny");
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /paused it by hand/);
    assert.doesNotMatch(out.hookSpecificOutput.permissionDecisionReason, /is paused: 5-hour/);
  });

  test(`${provider}: a rate warning reports the burst without a spawn-only deny`, async () => {
    const { target, call } = fixture(provider);
    recordReading(target, reading(22));
    writeRules(target, [{ kind: "rate", window: "five_hour", at: 15, span: 10, action: "warn" }]);
    writeUsage(target, { windows: { five_hour: { resetsAt, pts: [[NOW - 60_000, 0], [NOW, 22]] } }, weeks: [] });
    const out = await call();
    assert.equal(decision(out), undefined);
    assert.match(out.systemMessage, /5-hour burning fast: \+22 points within 10 min/);
  });
}

test("corrupt Codex state fails open even with a saved pause line hit", () => {
  const { target, call } = fixture();
  recordReading(target, reading(79));
  writeRules(target, [line("pause")]);
  pauseNow(target, { now: NOW });
  fs.writeFileSync(stateFile(target), "{broken");
  assert.equal(call(), null);
});

test("corrupt Codex reading fails open", () => {
  const { target, call } = fixture();
  recordReading(target, reading(79));
  writeRules(target, [line("pause")]);
  fs.writeFileSync(windowFile(target), "{broken");
  assert.equal(call(), null);
});

test("delegation does not check prompt events or unrelated commands", () => {
  const { target, input, call } = fixture();
  recordReading(target, reading(79));
  writeRules(target, [line("pause")]);
  input.hook_event_name = "UserPromptSubmit";
  assert.equal(call(), null);
  input.hook_event_name = "PreToolUse";
  input.tool_input.command = "codex --version";
  assert.equal(call(), null);
});

test("Claude's own approval request wins over a callee pause", () => {
  const { env, target, call } = fixture();
  for (const scoped of [env, target]) {
    recordReading(scoped, reading(79));
    writeRules(scoped, [line(scoped === env ? "ask" : "pause")]);
  }
  assert.equal(decision(call()), "ask");
});

test("callee facts preserve the caller's warning and do not change callee files", () => {
  const { env, target, call } = fixture();
  for (const scoped of [env, target]) {
    recordReading(scoped, reading(79));
    writeRules(scoped, [line("warn")]);
  }
  pauseNow(target, { now: NOW - 1000, until: NOW - 1 });
  const before = fs.readFileSync(stateFile(target), "utf8");
  const out = call();
  assert.equal(decision(out), undefined);
  assert.match(out.systemMessage, /Peras: 5-hour 79%/);
  assert.match(out.systemMessage, /Codex: 5-hour 79%/);
  assert.equal(fs.readFileSync(stateFile(target), "utf8"), before);
});

test("an expired callee reading allows silently", () => {
  const { target, call } = fixture();
  recordReading(target, { five_hour: { usedPct: 99, resetsAt: NOW / 1000 - 1, seenAt: NOW - 3600_000 } });
  writeRules(target, [line("pause")]);
  assert.equal(call(), null);
});

test("Codex's exec_command sends its command as cmd, and it is read", () => {
  assert.equal(delegateTarget("codex", "exec_command", { cmd: "claude -p review" }), "claude");
  assert.equal(delegateTarget("codex", "exec_command", { cmd: "ls" }), null);
});

test("plain argv is one command: words that look like shell syntax are just words", () => {
  assert.equal(delegateTarget("codex", "exec_command", { cmd: ["echo", "hello; claude -p review"] }), null);
  assert.equal(delegateTarget("codex", "local_shell", { command: ["claude", "-p", "review"] }), "claude");
  assert.equal(delegateTarget("codex", "local_shell", { command: ["bash", "-lc", "cd x && claude -p review"] }), "claude");
});
