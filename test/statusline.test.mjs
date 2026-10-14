import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { runStatusline } from "../src/statusline.mjs";
import { readWindow, writeInstall } from "../src/store.mjs";
import { sandbox, NOW, statusInput } from "./helpers.mjs";

const bytes = (o) => Buffer.from(JSON.stringify(o));

test("saves the window and prints Peras's own line", () => {
  const { env } = sandbox();
  const out = runStatusline({ stdin: bytes(statusInput({ fiveHour: 24, sevenDay: 41 })), env, now: NOW });
  assert.equal(out.code, 0);
  assert.match(out.stdout.toString(), /^🍐 5h 24% · 7d 41%/);
  assert.equal(readWindow(env).seven_day.usedPct, 41);
});

test("a render without rate_limits never wipes the window already saved", () => {
  const { env } = sandbox();
  runStatusline({ stdin: bytes(statusInput({ sevenDay: 41 })), env, now: NOW });
  runStatusline({ stdin: bytes(statusInput()), env, now: NOW + 1000 });
  assert.equal(readWindow(env).seven_day.usedPct, 41);
});

test("unparseable input still renders, and saves nothing", () => {
  const { env } = sandbox();
  const out = runStatusline({ stdin: Buffer.from("garbage"), env, now: NOW });
  assert.equal(out.code, 0);
  assert.equal(readWindow(env), null);
});

function chained(env, root) {
  const seen = path.join(root, "seen.bin");
  writeInstall(env, { statusLine: { type: "command", command: `cat > "${seen}"; printf 'theirs \\033[32mgreen\\033[0m\\nline two'`, padding: 2 } });
  return seen;
}

test("chained: their command gets the exact same stdin bytes, and its output passes through unchanged", () => {
  const { env, root } = sandbox();
  const seen = chained(env, root);
  // Odd but valid bytes: unicode, a trailing newline, spacing Claude Code might send.
  const input = Buffer.from(`${JSON.stringify(statusInput({ sevenDay: 40 }), null, 1)}\n  ✓ ünïcode\n`);
  const out = runStatusline({ stdin: input, env, now: NOW });
  assert.ok(fs.readFileSync(seen).equals(input));
  assert.equal(out.stdout.toString(), "theirs \u001b[32mgreen\u001b[0m\nline two");
  assert.equal(readWindow(env), null, "not valid JSON as a whole, so nothing saved; their line still renders");
});

test("chained: when a line is crossed, Peras's marker goes in front of their first line", () => {
  const { env, root } = sandbox();
  chained(env, root);
  const out = runStatusline({ stdin: bytes(statusInput({ sevenDay: 93 })), env, now: NOW });
  assert.match(out.stdout.toString(), /^🍐 ⏸ paused · 7d 93% · theirs /);
  assert.match(out.stdout.toString(), /\nline two$/);
});

test("chained: their command failing still leaves Peras's part", () => {
  const { env } = sandbox();
  writeInstall(env, { statusLine: { type: "command", command: "exit 3" } });
  const out = runStatusline({ stdin: bytes(statusInput({ sevenDay: 93 })), env, now: NOW });
  assert.match(out.stdout.toString(), /^🍐 ⏸ paused · 7d 93%/);
});

test("real Claude Code 2.1.299 status-line inputs, as captured", () => {
  const { env } = sandbox();
  const dir = new URL("./fixtures/", import.meta.url);
  const first = fs.readFileSync(new URL("claude-code-2.1.299-statusline-first-render.json", dir));
  const later = fs.readFileSync(new URL("claude-code-2.1.299-statusline.json", dir));
  const before = (JSON.parse(later).rate_limits.five_hour.resets_at - 3600) * 1000;
  assert.match(runStatusline({ stdin: first, env, now: before }).stdout, /no usage window yet/);
  assert.match(runStatusline({ stdin: later, env, now: before }).stdout, /^🍐 5h 56% · 7d 72%$/);
});
