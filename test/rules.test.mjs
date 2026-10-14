import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_RULES, evaluate, setRule } from "../src/rules.mjs";
import { inHours } from "./helpers.mjs";

const w = (five, seven) => ({
  ...(five !== undefined ? { five_hour: { usedPct: five, resetsAt: inHours(3), seenAt: 0 } } : {}),
  ...(seven !== undefined ? { seven_day: { usedPct: seven, resetsAt: inHours(72), seenAt: 0 } } : {}),
});

test("the defaults: weekly 75 warn, weekly 90 pause, 5-hour 95 warn", () => {
  assert.equal(evaluate(w(50, 50), DEFAULT_RULES).action, "none");
  assert.equal(evaluate(w(50, 75), DEFAULT_RULES).action, "warn");
  assert.equal(evaluate(w(50, 89.9), DEFAULT_RULES).action, "warn");
  assert.equal(evaluate(w(50, 90), DEFAULT_RULES).action, "pause");
  assert.equal(evaluate(w(95, 10), DEFAULT_RULES).action, "warn");
  assert.equal(evaluate({}, DEFAULT_RULES).action, "none");
});

test("the strongest action wins, and names the rule that set it", () => {
  const rules = [
    { window: "five_hour", at: 80, action: "ask" },
    { window: "seven_day", at: 90, action: "pause" },
  ];
  const v = evaluate(w(85, 95), rules);
  assert.equal(v.action, "pause");
  assert.equal(v.hit.window, "seven_day");
  assert.equal(v.hit.key, `seven_day:90:pause@${inHours(72)}`);
  assert.equal(v.hits.length, 2);
});

test("a resume lifts the lines it lifted, not its warn", () => {
  const rules = [...DEFAULT_RULES, { window: "seven_day", at: 80, action: "ask" }];
  const v = evaluate(w(10, 95), rules);
  const resumed = v.hits.filter((h) => h.action !== "warn").map((h) => h.key);
  assert.equal(evaluate(w(10, 95), rules, { resumed }).action, "warn");
  // A resume of the previous week does not carry into this one.
  assert.equal(evaluate(w(10, 95), rules, { resumed: ["seven_day:90:pause@1"] }).action, "pause");
});

test("a line crossed after a resume still fires (found in the owner's live run, 2026-10-14)", () => {
  const rules = [{ window: "seven_day", at: 70, action: "pause" }, { window: "seven_day", at: 90, action: "pause" }];
  const resumed = evaluate(w(10, 74), rules).hits.map((h) => h.key);
  assert.equal(evaluate(w(10, 74), rules, { resumed }).action, "none");
  assert.equal(evaluate(w(10, 95), rules, { resumed }).action, "pause");
  // A line added after the resume is not covered by it either.
  const withAsk = [...rules, { window: "seven_day", at: 72, action: "ask" }];
  assert.equal(evaluate(w(10, 74), withAsk, { resumed }).action, "ask");
});

test("setRule replaces the rule for that window and action, and off removes it", () => {
  let rules = setRule(DEFAULT_RULES, "seven_day", "pause", 85);
  assert.deepEqual(rules.filter((r) => r.action === "pause"), [{ window: "seven_day", at: 85, action: "pause" }]);
  rules = setRule(rules, "seven_day", "pause", null);
  assert.equal(rules.some((r) => r.action === "pause"), false);
  assert.throws(() => setRule(rules, "seven_day", "pause", 101));
  assert.throws(() => setRule(rules, "monthly", "pause", 50));
  assert.throws(() => setRule(rules, "seven_day", "explode", 50));
});
