import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { sandbox, NOW, VERSION, tempDir } from "./helpers.mjs";
import { hookMemoryFile, pauseNow, readInstall, readJson, readState, resume, stateFile, writeHookState, writeInstall, writeState } from "../src/store.mjs";
import { install } from "../src/settings.mjs";
import { snapshot } from "../src/providers.mjs";
import { providerPayload } from "../src/native-protocol.mjs";

const HOOK = `"${process.execPath}" "${new URL("../bin/peras.mjs", import.meta.url).pathname}"`;

test("a hook's write in the instant a pause lands cannot write the old controls back", () => {
  const { env } = sandbox();
  const state = readState(env, NOW);
  state.sessions.s1 = { cwd: "/w", t: NOW, startedAt: NOW, event: "PreToolUse" };
  // The pause is saved after the hook read the state and before its write lands.
  const rename = fs.renameSync;
  let inserted = false;
  fs.renameSync = function (from, to, ...rest) {
    if (!inserted) { inserted = true; pauseNow(env, { now: NOW + 1 }); }
    return rename.call(this, from, to, ...rest);
  };
  try { writeHookState(env, state, NOW); } finally { fs.renameSync = rename; }
  assert.ok(inserted);
  const after = readState(env, NOW + 2);
  assert.equal(after.manualPause?.since, NOW + 1, "the pause stands");
  assert.ok(after.sessions.s1, "and the hook's memory was kept");
});

test("hook memory moves out of state/ on the first v0.4 hook write, with one backup", () => {
  const { env } = sandbox();
  // State as 0.3 left it: memory and controls in one file.
  writeState(env, { notified: [], resumed: [], asked: { s0: [] }, prompts: {}, sessions: { s0: { cwd: "/old", t: NOW, startedAt: NOW } }, latched: [], manualPause: { since: NOW - 1000, until: null }, failWarnAt: 0 });
  assert.ok(readState(env, NOW).sessions.s0, "read as before, until a v0.4 hook writes");
  const legacy = fs.readFileSync(stateFile(env), "utf8");
  const state = readState(env, NOW);
  state.sessions.s1 = { cwd: "/new", t: NOW, startedAt: NOW };
  writeHookState(env, state, NOW);
  const backup = stateFile(env).replace(/\.json$/, ".before-v04.json");
  assert.equal(fs.readFileSync(backup, "utf8"), legacy);
  assert.equal(fs.readFileSync(stateFile(env), "utf8"), legacy, "the hook did not touch state/");
  assert.deepEqual(Object.keys(readJson(hookMemoryFile(env)).sessions).sort(), ["s0", "s1"]);
  assert.equal(readState(env, NOW).manualPause.since, NOW - 1000);
  // Later writes never rewrite the backup.
  writeState(env, { ...readJson(stateFile(env)), manualPause: null });
  writeHookState(env, readState(env, NOW), NOW);
  assert.equal(fs.readFileSync(backup, "utf8"), legacy);
});

test("app pause and resume wait for hooks that keep their memory apart", async () => {
  const { env } = sandbox();
  install({ env, command: HOOK, version: VERSION });
  const pause = async () => providerPayload(await snapshot(env, NOW, { cwd: null }), { now: NOW, sign: () => "t" }).actions.find((a) => a.op === "pause");
  assert.equal((await pause()).eligible, true, "setup from this version marks the install");
  const { hookMemory, ...older } = readInstall(env);
  assert.equal(hookMemory, 1);
  fs.writeFileSync(path.join(env.PERAS_HOME, "install", fs.readdirSync(path.join(env.PERAS_HOME, "install"))[0]), JSON.stringify(older));
  assert.deepEqual([(await pause()).eligible, (await pause()).disabledReason], [false, "runtime_outdated"]);
  writeInstall(env, older);
  assert.equal((await pause()).eligible, true);
  writeInstall(env, { ...older, version: "0.3.1" });
  assert.equal((await pause()).disabledReason, "runtime_outdated", "an install record from another version");
});

/** Peras 0.3.2 exactly as published (its tag), unpacked next to nothing else. Null when git or the tag is not there. */
function peras03() {
  const dir = tempDir("peras-03-");
  const repo = new URL("..", import.meta.url).pathname;
  const archive = spawnSync("git", ["-C", repo, "archive", "v0.3.2", "src", "package.json"], { maxBuffer: 1 << 26 });
  if (archive.status !== 0) return null;
  if (spawnSync("tar", ["-x", "-C", dir], { input: archive.stdout }).status !== 0) return null;
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).version, "0.3.2");
  return dir;
}

test("rolling back to 0.3 sees today's pause and resumes; a pause made under 0.3 holds after upgrading again", async (t) => {
  const old = peras03();
  if (!old) return t.skip("no v0.3.2 tag to compare with");
  const store03 = await import(path.join(old, "src", "store.mjs"));
  const { env } = sandbox();
  writeHookState(env, readState(env, NOW), NOW);
  pauseNow(env, { now: NOW });
  assert.equal(store03.readState(env, NOW + 1).manualPause.since, NOW, "0.3 reads the v0.4 pause");
  resume(env, { now: NOW + 2 });
  assert.equal(store03.readState(env, NOW + 3).manualPause, null, "and the resume");
  // Back on 0.3: its pause and its hooks write state/ the old way.
  store03.pauseNow(env, { now: NOW + 10 });
  const s03 = store03.readState(env, NOW + 11);
  s03.sessions.under03 = { cwd: "/w", t: NOW + 11, startedAt: NOW + 11 };
  store03.writeHookState(env, s03, NOW + 11);
  const later = new Date(Date.now() + 2000);
  fs.utimesSync(stateFile(env), later, later);
  const again = readState(env, NOW + 12);
  assert.equal(again.manualPause.since, NOW + 10, "v0.4 again: the 0.3 pause holds");
  assert.ok(again.sessions.under03, "and what 0.3's hooks remembered, not the older v0.4 copy");
  writeHookState(env, again, NOW + 12);
  pauseNow(env, { now: NOW + 13 });
  assert.ok(readState(env, NOW + 14).sessions.under03, "once v0.4 writes again, its own memory file leads");
});

test("back from 0.3, a pause or resume before any v0.4 hook keeps what 0.3's hooks remembered", () => {
  const { env } = sandbox();
  const before = readState(env, NOW);
  before.sessions.v04 = { cwd: "/old", t: NOW, startedAt: NOW };
  writeHookState(env, before, NOW);
  // 0.3's hooks write their memory into state/, unmarked, after v0.4's memory file.
  const s03 = readState(env, NOW + 1);
  s03.sessions = { under03: { cwd: "/w", t: NOW + 1, startedAt: NOW + 1 } };
  delete s03.hookMemory;
  writeState(env, s03);
  const later = new Date(Date.now() + 2000);
  fs.utimesSync(stateFile(env), later, later);
  pauseNow(env, { now: NOW + 2 });
  const after = readState(env, NOW + 3);
  assert.equal(after.manualPause.since, NOW + 2);
  assert.ok(after.sessions.under03 && !after.sessions.v04, "the control write must not bring back v0.4's older memory");
});
