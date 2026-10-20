import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { sandbox, VERSION } from "./helpers.mjs";
import { install } from "../src/settings.mjs";
import { codexEnv, installCodex, runCodexHook } from "../src/codex.mjs";
import { snapshot } from "../src/providers.mjs";
import { providerPayload, snapshotMessage, snapshotProblems } from "../src/native-protocol.mjs";
import { runProtectionTest } from "../src/protection-test.mjs";
import { pauseNow, perasHome, recordReading, writeRules } from "../src/store.mjs";

// These hooks run on the real clock, so the windows reset two days from now, not from the fixed test time.
const inHours = (h) => Math.floor(Date.now() / 1000) + h * 3600;
const BIN = new URL("../bin/peras.mjs", import.meta.url).pathname;
const HOOK = `"${process.execPath}" "${BIN}"`;

function home() {
  const box = sandbox();
  install({ env: box.env, command: HOOK, version: VERSION });
  return box;
}
const hook = (env, root, event = "PreToolUse", extra = {}) => {
  const r = spawnSync(process.execPath, [BIN, "hook"], { env: { ...env, ...extra }, input: JSON.stringify({ hook_event_name: event, session_id: "s1", cwd: root, tool_name: "Bash" }), encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout ? JSON.parse(r.stdout) : null;
};
const receipt = async (env, provider = "claude") => providerPayload(await snapshot(env, Date.now(), { provider, cwd: null }), { now: Date.now(), sign: () => "t" }).protectionReceipt;

test("no receipt for a crossed line, a pause request or a passed self-test: only for a denied tool call", async () => {
  const { env, root } = home();
  writeRules(env, [{ kind: "window", window: "seven_day", at: 40, action: "pause" }]);
  recordReading(env, { seven_day: { usedPct: 50, resetsAt: inHours(48), seenAt: Date.now() } });
  assert.equal(await receipt(env), null, "a crossed line");
  runProtectionTest(env);
  assert.equal(await receipt(env), null, "a self-test denies in its own home");
  hook(env, root, "UserPromptSubmit");
  assert.equal(await receipt(env), null, "a prompt goes through; no tool was denied");
  const before = Date.now();
  assert.equal(hook(env, root).hookSpecificOutput.permissionDecision, "deny");
  const first = await receipt(env);
  assert.equal(first.count, 1);
  assert.ok(first.firstAtMs >= before && first.atMs === first.firstAtMs);
  assert.deepEqual([first.reason.kind, first.reason.action, first.reason.window, first.reason.at, first.reason.used, first.reason.unit], ["window", "pause", "seven_day", 40, 50, "percent"]);
  hook(env, root);
  const second = await receipt(env);
  assert.deepEqual([second.count, second.firstAtMs], [2, first.firstAtMs], "the first denial is kept");
  assert.equal(await receipt(env, "codex"), null, "Codex's receipt is its own");
});

test("a manual pause's receipt names it, and the wire carries no path", async () => {
  const { env, root } = home();
  pauseNow(env, { now: Date.now() - 1000 });
  hook(env, root);
  const s = await snapshot(env, Date.now(), { cwd: null });
  const p = providerPayload(s, { now: Date.now(), sign: () => "t" });
  assert.deepEqual([p.protectionReceipt.reason.kind, p.protectionReceipt.reason.expiresAtMs], ["manual", null]);
  assert.equal(p.protectionReceipt.reason.id, p.reasons[0].id, "the same stop, the same id");
  const message = snapshotMessage({ bridgeInstance: "b", revision: 1, now: Date.now(), providers: [p], settings: { preferences: {}, display: "usage", actions: [] } });
  assert.ok(!JSON.stringify(p.protectionReceipt).includes(root));
  assert.deepEqual(snapshotProblems(message).filter((m) => m.includes("protectionReceipt")), []);
});

test("an ask is not a receipt for Claude; Codex, which denies an ask, records one", async () => {
  const { env, root } = home();
  writeRules(env, [{ kind: "window", window: "seven_day", at: 40, action: "ask" }]);
  recordReading(env, { seven_day: { usedPct: 50, resetsAt: inHours(48), seenAt: Date.now() } });
  assert.equal(hook(env, root).hookSpecificOutput.permissionDecision, "ask");
  assert.equal(await receipt(env), null);
  installCodex(env, HOOK);
  const scoped = codexEnv(env);
  writeRules(scoped, [{ kind: "window", window: "seven_day", at: 40, action: "ask" }]);
  recordReading(scoped, { seven_day: { usedPct: 50, resetsAt: inHours(48), seenAt: Date.now() } });
  const out = await runCodexHook({ env, input: { hook_event_name: "PreToolUse", session_id: "c1", turn_id: "t1", cwd: root, tool_name: "shell" }, reader: async () => { throw new Error("no Codex in tests"); } });
  assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
  assert.equal((await receipt(env, "codex")).reason.action, "ask");
});

test("a receipt that can't be written never lets the tool run, strict or not", (t) => {
  const { env, root } = home();
  pauseNow(env, { now: Date.now() - 1000 });
  // A file where the receipts folder would go: every receipt write fails.
  fs.writeFileSync(path.join(perasHome(env), "receipts"), "");
  t.after(() => fs.rmSync(path.join(perasHome(env), "receipts"), { force: true }));
  for (const extra of [{}, { PERAS_STRICT: "1" }]) assert.equal(hook(env, root, "PreToolUse", extra).hookSpecificOutput.permissionDecision, "deny", JSON.stringify(extra));
});
