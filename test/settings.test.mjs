import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { install, uninstall, settingsPath, isPerasCommand } from "../src/settings.mjs";
import { readInstall } from "../src/store.mjs";
import { sandbox } from "./helpers.mjs";

const CMD = '"/usr/bin/node" "/x/.peras/app/bin/peras.mjs"';
const read = (p) => JSON.parse(fs.readFileSync(p, "utf8"));

const ORIGINAL = {
  model: "opus",
  permissions: { allow: ["Bash(ls)"] },
  hooks: {
    PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "my-guard.sh" }] }],
    Stop: [{ hooks: [{ type: "command", command: "say done" }] }],
  },
  statusLine: { type: "command", command: "npx -y ccstatusline@latest", padding: 0, refreshInterval: 5 },
  env: { FOO: "1" },
};

test("setup on a machine with no settings, then remove, leaves no settings behind", () => {
  const { env } = sandbox();
  const target = settingsPath(env);
  install({ env, command: CMD });
  const s = read(target);
  for (const e of ["UserPromptSubmit", "PreToolUse", "PostToolBatch"]) {
    assert.ok(s.hooks[e].some((g) => g.hooks.some((h) => isPerasCommand(h.command))), e);
  }
  assert.ok(s.statusLine.command.startsWith(`${CMD} statusline`));
  uninstall({ env });
  assert.deepEqual(read(target), {});
});

test("setup twice, then remove, gives back the user's settings exactly", () => {
  const { env } = sandbox();
  const target = settingsPath(env);
  const originalText = `${JSON.stringify(ORIGINAL, null, 4)}\n`;
  fs.writeFileSync(target, originalText);
  const first = install({ env, command: CMD });
  assert.equal(first.chained, "npx -y ccstatusline@latest");
  const second = install({ env, command: CMD });
  assert.equal(second.changed, false);
  const s = read(target);
  assert.equal(s.hooks.PreToolUse.filter((g) => g.hooks.some((h) => isPerasCommand(h.command))).length, 1);
  assert.equal(s.statusLine.padding, 0);
  assert.equal(s.statusLine.refreshInterval, 5);
  assert.deepEqual(readInstall(env).statusLine, ORIGINAL.statusLine);
  // The backup is the file as it was before Peras ever touched it, written once.
  assert.equal(fs.readFileSync(first.backupPath, "utf8"), originalText);
  uninstall({ env });
  assert.deepEqual(read(target), ORIGINAL);
  assert.deepEqual(Object.keys(read(target)), Object.keys(ORIGINAL));
});

test("remove leaves a status line the user changed after setup", () => {
  const { env } = sandbox();
  const target = settingsPath(env);
  fs.writeFileSync(target, JSON.stringify(ORIGINAL));
  install({ env, command: CMD });
  const s = read(target);
  s.statusLine = { type: "command", command: "my-new-line" };
  fs.writeFileSync(target, JSON.stringify(s));
  uninstall({ env });
  assert.equal(read(target).statusLine.command, "my-new-line");
});

test("settings that are not valid JSON are left alone, and nothing is written", () => {
  const { env } = sandbox();
  const target = settingsPath(env);
  fs.writeFileSync(target, "{ oops");
  assert.throws(() => install({ env, command: CMD }), /not valid JSON/);
  assert.equal(fs.readFileSync(target, "utf8"), "{ oops");
  assert.equal(fs.readdirSync(path.dirname(target)).length, 1);
});

test("hooks that turn every hook off are reported", () => {
  const { env } = sandbox();
  fs.writeFileSync(settingsPath(env), JSON.stringify({ disableAllHooks: true }));
  assert.equal(install({ env, command: CMD }).hooksDisabled, true);
});
