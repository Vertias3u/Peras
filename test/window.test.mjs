import { test } from "node:test";
import assert from "node:assert/strict";
import { readingFrom, mergeWindow, liveWindow } from "../src/window.mjs";
import { NOW, inHours, statusInput } from "./helpers.mjs";

test("a status-line input with rate_limits becomes a reading", () => {
  const r = readingFrom(statusInput({ fiveHour: 24.4, sevenDay: 41 }), NOW);
  assert.deepEqual(r, {
    five_hour: { usedPct: 24.4, resetsAt: inHours(3), seenAt: NOW },
    seven_day: { usedPct: 41, resetsAt: inHours(72), seenAt: NOW },
  });
});

test("no rate_limits (API key, or before the first response) is no reading", () => {
  assert.equal(readingFrom(statusInput(), NOW), null);
  assert.equal(readingFrom({ rate_limits: { five_hour: { used_percentage: "x" } } }, NOW), null);
  assert.equal(readingFrom(null, NOW), null);
});

test("a reading with one window keeps the other window already stored", () => {
  const stored = readingFrom(statusInput({ fiveHour: 10, sevenDay: 50 }), NOW);
  const merged = mergeWindow(stored, readingFrom(statusInput({ fiveHour: 30 }), NOW + 1000));
  assert.equal(merged.five_hour.usedPct, 30);
  assert.equal(merged.seven_day.usedPct, 50);
});

test("a reading counts only until its window resets", () => {
  const stored = readingFrom(statusInput({ fiveHour: 96, sevenDay: 92 }), NOW);
  const fiveResetMs = inHours(3) * 1000;
  assert.equal(liveWindow(stored, fiveResetMs - 1).five_hour.usedPct, 96);
  const after = liveWindow(stored, fiveResetMs);
  assert.equal(after.five_hour, undefined);
  assert.equal(after.seven_day.usedPct, 92);
  assert.deepEqual(liveWindow(stored, inHours(72) * 1000), {});
});
