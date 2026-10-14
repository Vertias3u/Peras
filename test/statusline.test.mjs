import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { runStatusline } from "../src/statusline.mjs";
import { readWindow, writeInstall } from "../src/store.mjs";
import { sandbox, NOW, statusInput, inHours } from "./helpers.mjs";
import { stripAnsi } from "../src/look.mjs";
import { writeUsage } from "../src/usage.mjs";

const text = (out) => stripAnsi(out.stdout.toString());

const bytes = (o) => Buffer.from(JSON.stringify(o));

test("saves the window and prints Peras's own line", () => {
  const { env } = sandbox();
  const out = runStatusline({ stdin: bytes(statusInput({ fiveHour: 24, sevenDay: 41 })), env, now: NOW });
  assert.equal(out.code, 0);
  assert.match(text(out), /^🍐 5h 24% · 7d 41%/);
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
  assert.match(out.stdout.toString(), /^\u001b\[31m🍐 ⏸️ paused 7d 93%\u001b\[0m · theirs /);
  assert.match(out.stdout.toString(), /\nline two$/);
});

test("chained: their command failing still leaves Peras's part", () => {
  const { env } = sandbox();
  writeInstall(env, { statusLine: { type: "command", command: "exit 3" } });
  const out = runStatusline({ stdin: bytes(statusInput({ sevenDay: 93 })), env, now: NOW });
  assert.match(text(out), /^🍐 ⏸️ paused 7d 93%$/);
});

test("real Claude Code 2.1.299 status-line inputs, as captured", () => {
  const { env } = sandbox();
  const dir = new URL("./fixtures/", import.meta.url);
  const first = fs.readFileSync(new URL("claude-code-2.1.299-statusline-first-render.json", dir));
  const later = fs.readFileSync(new URL("claude-code-2.1.299-statusline.json", dir));
  const before = (JSON.parse(later).rate_limits.five_hour.resets_at - 3600) * 1000;
  assert.match(runStatusline({ stdin: first, env, now: before }).stdout, /no usage window yet/);
  assert.match(text(runStatusline({ stdin: later, env, now: before })), /^🍐 (⚠️ · )?5h 56% · 7d 72%/);
});

test("colour follows your lines, and NO_COLOR turns it off", () => {
  const { env } = sandbox();
  const out = runStatusline({ stdin: bytes(statusInput({ fiveHour: 20, sevenDay: 80 })), env, now: NOW }).stdout;
  assert.match(out, /\u001b\[32m5h 20%/);
  assert.match(out, /\u001b\[33m7d 80%/);
  const plain = runStatusline({ stdin: bytes(statusInput({ fiveHour: 20, sevenDay: 80 })), env: { ...env, NO_COLOR: "1" }, now: NOW }).stdout;
  assert.doesNotMatch(plain, /\u001b/);
});

test("the forecast shows when the window is on track to fill before it resets", () => {
  const { env } = sandbox();
  const H = 3600_000;
  writeUsage(env, { v: 1, windows: { seven_day: { resetsAt: inHours(72), pts: [[NOW - 30 * H, 40], [NOW - 10 * H, 60]] } }, weeks: [], blame: null });
  const out = text(runStatusline({ stdin: bytes(statusInput({ sevenDay: 70 })), env, now: NOW }));
  assert.match(out, /7d 70% \(full /);
});

test("this chat's share of the week, from what it spent", () => {
  const { env } = sandbox();
  const render = (pct, cost, session = "s-1") =>
    text(runStatusline({ stdin: bytes({ ...statusInput({ sevenDay: pct }), session_id: session, cost: { total_cost_usd: cost } }), env, now: NOW }));
  render(40, 0);
  render(40, 0, "s-2");
  render(44, 3);
  render(44, 1, "s-2");
  assert.match(render(44, 3), /this chat ≈\+3%/);
});

test("per-folder lines: the status line reads the same folder the hook does", () => {
  const { env, root } = sandbox();
  const side = fs.realpathSync(fs.mkdtempSync(path.join(root, "side-")));
  fs.mkdirSync(env.PERAS_HOME, { recursive: true });
  fs.writeFileSync(path.join(env.PERAS_HOME, "config.json"), JSON.stringify({ v: 2, rules: [{ kind: "window", window: "seven_day", at: 60, action: "pause", project: side }] }));
  const at = (dir) => text(runStatusline({ stdin: bytes({ ...statusInput({ sevenDay: 65 }), workspace: { current_dir: dir, project_dir: dir } }), env, now: NOW }));
  assert.match(at(side), /paused/);
  assert.doesNotMatch(at(root), /paused/);
});
