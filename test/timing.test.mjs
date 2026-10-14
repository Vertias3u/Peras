// Times Peras promises are times you can read off a clock.
import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "../src/cli.mjs";
import { readState, recordReading } from "../src/store.mjs";
import { describe } from "../src/hook.mjs";
import { resetTime } from "../src/window.mjs";
import { stripAnsi } from "../src/look.mjs";
import { sandbox, NOW, inHours } from "./helpers.mjs";

async function run(env, now, ...args) {
  const lines = [];
  const code = await main(args, { env, now, out: (l) => lines.push(stripAnsi(l)) });
  return { code, text: lines.join("\n") };
}

test("a timed pause ends on the whole minute it names, never seconds after it", async () => {
  const { env } = sandbox();
  const now = NOW + 54_000; // 54 s past the minute, like the owner's 03:03:54
  const { text } = await run(env, now, "pause", "1m");
  const until = readState(env, now).manualPause.until;
  assert.equal(until, NOW + 120_000, "1 minute from :54 rounds up to the next whole minute");
  assert.match(text, new RegExp(`until ${resetTime(until / 1000, now)}\\.`));
  assert.equal(readState(env, until - 1).manualPause?.until, until, "still paused a moment before");
  assert.equal(readState(env, until).manualPause, null, "lifted exactly at the minute it said");
});

test("a timed resume also ends on a whole minute", async () => {
  const { env } = sandbox();
  recordReading(env, { seven_day: { usedPct: 95, resetsAt: inHours(30), seenAt: NOW } });
  const now = NOW + 20_000;
  const { text } = await run(env, now, "resume", "1m");
  const until = readState(env, now).resumed[0].until;
  assert.equal(until, NOW + 120_000);
  assert.match(text, new RegExp(`until ${resetTime(until / 1000, now)}\\.`));
});

test("a pace warning says when usage runs out, not a percentage past 100", () => {
  const runsOutAt = NOW + 7 * 3600_000;
  const d = describe({ kind: "pace", window: "seven_day", usedPct: 86, resetsAt: inHours(66), projected: 141.4, runsOutAt }, NOW);
  for (const text of [d.what, d.short]) {
    assert.doesNotMatch(text, /141|142/);
    assert.match(text, new RegExp(`runs out ${resetTime(runsOutAt / 1000, NOW)}`));
    assert.match(text, new RegExp(resetTime(inHours(66), NOW)));
  }
  // A latched pace line that slowed to under 100% keeps its percentage: it's reachable.
  const slowed = describe({ kind: "pace", window: "seven_day", usedPct: 86, resetsAt: inHours(66), projected: 97 }, NOW);
  assert.match(slowed.short, /on pace for 97%/);
});
