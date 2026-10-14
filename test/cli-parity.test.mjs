// What the menu bar shows or does, the CLI can too.
import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "../src/cli.mjs";
import { codexEnv } from "../src/codex.mjs";
import { recordReading, pauseNow, writeInstall } from "../src/store.mjs";
import { recordHookRun } from "../src/hook-health.mjs";
import { recordEvent } from "../src/events.mjs";
import { preferences } from "../src/preferences.mjs";
import { stripAnsi } from "../src/look.mjs";
import { sandbox, NOW, inHours } from "./helpers.mjs";

const limits = (pct = 30) => ({ rateLimits: { primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: inHours(3) }, secondary: { usedPercent: pct, windowDurationMins: 10080, resetsAt: inHours(72) } } });
async function run(env, args, { reader = async () => limits(), now = NOW } = {}) {
  const lines = [];
  const code = await main(args, { env, now, out: (l) => lines.push(stripAnsi(l)), codexReader: reader });
  return { code, text: lines.join("\n") };
}
const codexPart = (text) => text.slice(text.lastIndexOf("Peras 🍐 watching"));

test("status gives Codex the same panel as Claude Code, in Codex's own words", async () => {
  const { env } = sandbox();
  await run(env, ["setup"]);
  await run(env, ["codex", "setup"]);
  recordReading(env, { seven_day: { usedPct: 20, resetsAt: inHours(72), seenAt: NOW } });
  const { code, text } = await run(env, ["status"]);
  assert.equal(code, 0);
  assert.equal(text.match(/Peras 🍐 watching/g).length, 2, text);
  const codex = codexPart(text);
  assert.match(codex, /watching .*codex/i);
  assert.match(codex, /5h\s+▰▱+\s+10%\s+resets/);
  assert.match(codex, /7d\s+▰+▱+\s+30%\s+resets/);
  assert.match(codex, /Lines: /);
  assert.doesNotMatch(codex, /Claude/);
  assert.doesNotMatch(codex, /`peras (setup|resume)`/);
  const solo = await run(env, ["codex", "status"]);
  assert.equal(solo.code, 0);
  assert.equal(solo.text, codex.trimEnd(), "peras codex status prints the same panel");
});

test("a paused Codex tells you the Codex resume command", async () => {
  const { env } = sandbox();
  await run(env, ["codex", "setup"]);
  pauseNow(codexEnv(env), { now: NOW });
  const codex = codexPart((await run(env, ["status"])).text);
  assert.match(codex, /PAUSED/);
  assert.match(codex, /`peras codex resume`/);
});

test("without Codex set up or read, status gives it one line", async () => {
  const { env } = sandbox();
  const { text } = await run(env, ["status"], { reader: async () => { throw new Error("no codex"); } });
  assert.equal(text.match(/Peras 🍐 watching/g).length, 1, text);
  assert.match(text, /^Codex: not set up\. `peras codex setup` guards it too\.$/m);
});

test("status and doctor show hook health for each agent, like the menu", async () => {
  const { env } = sandbox();
  await run(env, ["setup"]);
  await run(env, ["codex", "setup"]);
  recordReading(env, { seven_day: { usedPct: 20, resetsAt: inHours(72), seenAt: NOW } });
  let { text } = await run(env, ["status"]);
  assert.match(text, /Hooks: Needs activation\. Restart Claude Code/);
  assert.match(codexPart(text), /Hooks: Needs trust \/ activation\./);
  recordHookRun(env, "PreToolUse", NOW - 60_000);
  recordHookRun(codexEnv(env), "PreToolUse", NOW - 60_000);
  ({ text } = await run(env, ["status"]));
  assert.equal(text.match(/seen just now · protection active/g).length, 2, text);
  assert.doesNotMatch(text, /Hooks: /);
  const doctor = await run(env, ["doctor"]);
  assert.match(doctor.text, /✓ Claude Code hooks: protection active/);
  assert.match(doctor.text, /✓ Codex hooks: protection active/);
});

test("hooks that last ran a while ago read as normal, not as a problem", async () => {
  const { env } = sandbox();
  await run(env, ["setup"]);
  recordReading(env, { seven_day: { usedPct: 20, resetsAt: inHours(72), seenAt: NOW } });
  recordHookRun(env, "PreToolUse", NOW - 40 * 60_000);
  const { text } = await run(env, ["status"]);
  assert.match(text, /seen just now · hooks last ran 40 min ago/);
  assert.doesNotMatch(text, /Hooks: /);
  const doctor = await run(env, ["doctor"]);
  assert.equal(doctor.code, 0);
  assert.match(doctor.text, /✓ Claude Code hooks: last ran 40 min ago/);
  for (const out of [text, doctor.text]) assert.doesNotMatch(out, /AM|PM|\d+\/\d+\/\d+/);
});

test("peras notify lists and switches notifications; the menu's command still works", async () => {
  const { env } = sandbox();
  let { code, text } = await run(env, ["notify"]);
  assert.equal(code, 0);
  assert.match(text, /warnings\s+on/);
  assert.match(text, /pauses\s+on/);
  assert.match(text, /resets\s+off .*menu bar/);
  assert.equal((await run(env, ["notify", "resets", "on"])).code, 0);
  assert.equal(preferences(env).resets, true);
  assert.equal((await run(env, ["notify", "warnings", "off"])).code, 0);
  assert.equal(preferences(env).warnings, false);
  ({ code, text } = await run(env, ["notify", "mascots", "off"]));
  assert.equal(code, 1);
  assert.match(text, /warnings\|pauses\|resets/);
  assert.equal(preferences(env).mascots, true);
  assert.equal((await run(env, ["menubar", "preference", "warnings", "on"])).code, 0);
  assert.equal(preferences(env).warnings, true);
});

test("peras test runs the protection test, same as the menu's", async () => {
  const { env } = sandbox();
  const { code, text } = await run(env, ["test"]);
  assert.equal(code, 0, text);
  assert.match(text, /claude: PASS/);
  assert.match(text, /codex: PASS/);
});

test("events read in one local format, with no US dates", async () => {
  const { env } = sandbox();
  await run(env, ["pause", "1h"]);
  recordEvent(env, { kind: "warning", at: NOW - 3 * 86_400_000, message: "weekly 80%." });
  recordEvent(env, { kind: "warning", at: NOW - 10 * 86_400_000, message: "weekly 81%." });
  const { text } = await run(env, ["events"]);
  assert.doesNotMatch(text, /AM|PM|\d+\/\d+\/\d+/, text);
  const at = new Date(NOW), hhmm = (d) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  assert.match(text, new RegExp(`^${hhmm(at)} · claude · pause: Paused by you until ${hhmm(new Date(NOW + 3_600_000))}\\.$`, "m"));
  assert.match(text, /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) \d\d:\d\d · claude · warning: weekly 80%\.$/m);
  assert.match(text, /^\d{1,2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d\d:\d\d · claude · warning: weekly 81%\.$/m);
});
