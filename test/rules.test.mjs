import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_RULES, evaluate, setRule, parseSet, effectiveRules, normalizeRules, duringActive } from "../src/rules.mjs";
import { inHours, NOW } from "./helpers.mjs";

const w = (five, seven) => ({
  ...(five !== undefined ? { five_hour: { usedPct: five, resetsAt: inHours(3), seenAt: 0 } } : {}),
  ...(seven !== undefined ? { seven_day: { usedPct: seven, resetsAt: inHours(72), seenAt: 0 } } : {}),
});
const ev = (window, rules, extra = {}) => evaluate({ window, rules, now: NOW, ...extra });
const ONLY = (rule) => [{ kind: "window", ...rule }];

test("the defaults: weekly 75 warn, weekly 90 pause, 5-hour 95 warn, weekly pace warn from 50", () => {
  assert.equal(ev(w(50, 50), DEFAULT_RULES).action, "none");
  assert.equal(ev(w(50, 75), DEFAULT_RULES).action, "warn");
  assert.equal(ev(w(50, 89.9), DEFAULT_RULES).action, "warn");
  assert.equal(ev(w(50, 90), DEFAULT_RULES).action, "pause");
  assert.equal(ev(w(95, 10), DEFAULT_RULES).action, "warn");
  assert.equal(ev({}, DEFAULT_RULES).action, "none");
  assert.ok(DEFAULT_RULES.some((r) => r.kind === "pace" && r.window === "seven_day" && r.action === "warn"));
});

test("0.1 rules (no kind) still load, as window lines", () => {
  const rules = normalizeRules([{ window: "seven_day", at: 75, action: "warn" }, { window: "nope", at: 1, action: "warn" }]);
  assert.deepEqual(rules, [{ kind: "window", window: "seven_day", at: 75, action: "warn" }]);
});

test("the strongest action wins, and names the rule that set it", () => {
  const rules = [
    { kind: "window", window: "five_hour", at: 80, action: "ask" },
    { kind: "window", window: "seven_day", at: 90, action: "pause" },
  ];
  const v = ev(w(85, 95), rules);
  assert.equal(v.action, "pause");
  assert.equal(v.hit.window, "seven_day");
  // Same key form as 0.1, so an upgrade never repeats a notification already sent.
  assert.equal(v.hit.key, `seven_day:90:pause@${inHours(72)}`);
  assert.equal(v.hits.length, 2);
});

test("a resume lifts the lines it lifted, not its warn, and only for its window", () => {
  const rules = [...DEFAULT_RULES, { kind: "window", window: "seven_day", at: 80, action: "ask" }];
  const resumed = ev(w(10, 95), rules).hits.filter((h) => h.action !== "warn").map((h) => ({ key: h.key }));
  assert.equal(ev(w(10, 95), rules, { resumed }).action, "warn");
  assert.equal(ev(w(10, 95), rules, { resumed: [{ key: "seven_day:90:pause@1" }] }).action, "pause");
});

test("a line crossed after a resume still fires (owner's live run, 2026-10-14)", () => {
  const rules = [{ kind: "window", window: "seven_day", at: 70, action: "pause" }, { kind: "window", window: "seven_day", at: 90, action: "pause" }];
  const resumed = ev(w(10, 74), rules).hits.map((h) => ({ key: h.key }));
  assert.equal(ev(w(10, 74), rules, { resumed }).action, "none");
  assert.equal(ev(w(10, 95), rules, { resumed }).action, "pause");
});

test("a timed resume runs out", () => {
  const rules = ONLY({ window: "seven_day", at: 90, action: "pause" });
  const key = ev(w(10, 95), rules).hit.key;
  const resumed = [{ key, until: NOW + 3600_000 }];
  assert.equal(ev(w(10, 95), rules, { resumed }).action, "none");
  assert.equal(evaluate({ window: w(10, 95), rules, resumed, now: NOW + 3600_000 }).action, "pause");
});

test("a manual pause pauses under every line, until its time or a resume", () => {
  const v = ev(w(10, 10), DEFAULT_RULES, { manualPause: { until: NOW + 60_000 } });
  assert.equal(v.action, "pause");
  assert.equal(v.hit.kind, "manual");
  assert.equal(ev(w(10, 10), DEFAULT_RULES, { manualPause: { until: null } }).action, "pause");
  assert.equal(evaluate({ window: w(10, 10), rules: DEFAULT_RULES, now: NOW + 60_000, manualPause: { until: NOW + 60_000 } }).action, "none");
});

test("quiet hours: a line with a time range only counts inside it, across midnight too", () => {
  const night = [{ kind: "window", window: "seven_day", at: 50, action: "pause", during: "23:00-07:00" }];
  const at = (h, m = 0) => new Date(2026, 9, 14, h, m).getTime();
  assert.equal(evaluate({ window: w(10, 60), rules: night, now: at(23, 30) }).action, "pause");
  assert.equal(evaluate({ window: w(10, 60), rules: night, now: at(3) }).action, "pause");
  assert.equal(evaluate({ window: w(10, 60), rules: night, now: at(7) }).action, "none");
  assert.equal(evaluate({ window: w(10, 60), rules: night, now: at(14) }).action, "none");
  assert.equal(duringActive("09:00-17:00", at(9)), true);
  assert.equal(duringActive("09:00-17:00", at(17)), false);
});

test("pace: fires when the forecast reaches 100% before the reset, with hysteresis, and only from its floor", () => {
  const rules = [{ kind: "pace", window: "seven_day", at: 50, action: "pause" }];
  const f = (projected) => ({ seven_day: { projected } });
  assert.equal(ev(w(10, 60), rules, { forecast: f(104) }).action, "pause");
  assert.equal(ev(w(10, 60), rules, { forecast: f(95) }).action, "none");
  assert.equal(ev(w(10, 40), rules, { forecast: f(150) }).action, "none", "under the floor");
  assert.equal(ev(w(10, 60), rules, { forecast: {} }).action, "none", "no forecast yet");
  // Once it has fired, it holds until the forecast drops under 90%: no flapping.
  const key = ev(w(10, 60), rules, { forecast: f(104) }).hit.key;
  assert.equal(ev(w(10, 60), rules, { forecast: f(95), latched: [key] }).action, "pause");
  assert.equal(ev(w(10, 60), rules, { forecast: f(89), latched: [key] }).action, "none");
});

test("prompt allowance: a prompt may raise the weekly % by its allowance, per prompt", () => {
  const rules = [{ kind: "prompt", window: "seven_day", at: 3, action: "pause" }];
  const prompt = (id, base) => ({ id, seven_day: base, five_hour: 0 });
  assert.equal(ev(w(10, 52), rules, { prompt: prompt("p1", 50) }).action, "none");
  const v = ev(w(10, 53), rules, { prompt: prompt("p1", 50) });
  assert.equal(v.action, "pause");
  assert.equal(v.hit.rise, 3);
  assert.equal(ev(w(10, 53), rules).action, "none", "no prompt seen: nothing to measure from");
  // A resume of one prompt's pause does not cover the next prompt.
  const resumed = [{ key: v.hit.key }];
  assert.equal(ev(w(10, 53), rules, { prompt: prompt("p1", 50), resumed }).action, "none");
  assert.equal(ev(w(10, 56), rules, { prompt: prompt("p2", 53), resumed }).action, "pause");
});

test("per-project lines override the same global line in that folder and below", () => {
  const rules = [
    ...DEFAULT_RULES,
    { kind: "window", window: "seven_day", at: 60, action: "pause", project: "/code/side" },
    { kind: "window", window: "seven_day", at: 75, action: "warn", project: "/code/side", off: true },
  ];
  const side = effectiveRules(rules, "/code/side/src");
  assert.ok(side.some((r) => r.at === 60 && r.action === "pause"));
  assert.ok(!side.some((r) => r.at === 90 && r.action === "pause"), "global pause replaced");
  assert.ok(!side.some((r) => r.window === "seven_day" && r.action === "warn" && r.kind === "window"), "turned off here");
  assert.ok(side.some((r) => r.window === "five_hour"), "other global lines still apply");
  assert.deepEqual(effectiveRules(rules, "/code/sidecar"), DEFAULT_RULES, "a prefix is not a parent folder");
  assert.equal(evaluate({ window: w(10, 65), rules, now: NOW, cwd: "/code/side" }).action, "pause");
  assert.equal(evaluate({ window: w(10, 65), rules, now: NOW, cwd: "/code/main" }).action, "none");
});

test("set: words in any order, every kind, and off", () => {
  const cwd = "/code/side";
  const table = [
    ["weekly 85 pause", { kind: "window", window: "seven_day", action: "pause" }, 85],
    ["pause 85% weekly", { kind: "window", window: "seven_day", action: "pause" }, 85],
    ["5h 95 warn", { kind: "window", window: "five_hour", action: "warn" }, 95],
    ["weekly pause off", { kind: "window", window: "seven_day", action: "pause" }, null],
    ["prompt 3 pause", { kind: "prompt", window: "seven_day", action: "pause" }, 3],
    ["prompt 5h 10 ask", { kind: "prompt", window: "five_hour", action: "ask" }, 10],
    ["weekly pace pause", { kind: "pace", window: "seven_day", action: "pause" }, 50],
    ["weekly pace 60 pause", { kind: "pace", window: "seven_day", action: "pause" }, 60],
    ["01:00-08:00 weekly 50 pause", { kind: "window", window: "seven_day", action: "pause", during: "01:00-08:00" }, 50],
    ["--here weekly 60 pause", { kind: "window", window: "seven_day", action: "pause", project: cwd }, 60],
    ["--here weekly warn off", { kind: "window", window: "seven_day", action: "warn", project: cwd }, null],
  ];
  for (const [words, rule, at] of table) {
    const parsed = parseSet(words.split(" "), { cwd, realpath: (p) => p });
    assert.deepEqual(parsed, { op: "set", rule, at }, words);
  }
  assert.deepEqual(parseSet(["reset"], { cwd }), { op: "reset", project: null });
  assert.deepEqual(parseSet(["--here", "reset"], { cwd, realpath: (p) => p }), { op: "reset", project: cwd });
  for (const bad of ["monthly 50 pause", "weekly 50", "weekly pause", "weekly 101 pause", "25:00-02:00 weekly 5 pause", "weekly 50 explode"]) {
    assert.throws(() => parseSet(bad.split(" "), { cwd }), bad);
  }
});

test("setRule: one line per kind, window, action, time range and folder", () => {
  let rules = setRule(DEFAULT_RULES, { kind: "window", window: "seven_day", action: "pause" }, 85);
  assert.deepEqual(rules.filter((r) => r.kind === "window" && r.action === "pause"), [{ kind: "window", window: "seven_day", at: 85, action: "pause" }]);
  // A night line is its own line: setting it leaves the all-day one alone, and so does removing it.
  rules = setRule(rules, { kind: "window", window: "seven_day", action: "pause", during: "01:00-08:00" }, 50);
  rules = setRule(rules, { kind: "window", window: "seven_day", action: "pause", during: "01:00-08:00" }, null);
  assert.deepEqual(rules.filter((r) => r.action === "pause" && r.kind === "window"), [{ kind: "window", window: "seven_day", at: 85, action: "pause" }]);
  // "off" in a folder is an override that switches the global line off there.
  rules = setRule(rules, { kind: "window", window: "seven_day", action: "warn", project: "/p" }, null);
  assert.ok(rules.some((r) => r.project === "/p" && r.off === true));
  assert.ok(rules.some((r) => !r.project && r.action === "warn" && r.window === "seven_day"));
});
