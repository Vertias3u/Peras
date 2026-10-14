import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { main, parseWhen } from "../src/cli.mjs";
import { recordReading, readState, readRules, writeInstall, readInstall, windowFile } from "../src/store.mjs";
import { codexEnv } from "../src/codex.mjs";
import { displayMode } from "../src/menubar.mjs";
import { runHook } from "../src/hook.mjs";
import { readingFrom } from "../src/window.mjs";
import { writeUsage } from "../src/usage.mjs";
import { stripAnsi } from "../src/look.mjs";
import { sandbox, NOW, statusInput, inHours } from "./helpers.mjs";

const H = 3600_000;
async function run(env, ...args) {
  const lines = [];
  const code = await main(args, { env, out: (l) => lines.push(stripAnsi(l)), now: NOW });
  return { code, text: lines.join("\n") };
}

test("pause and resume by hand, with and without a time", async () => {
  const { env } = sandbox();
  recordReading(env, readingFrom(statusInput({ sevenDay: 10 }), NOW));
  assert.match((await run(env, "pause")).text, /until you run `peras resume`/);
  assert.match((await run(env, "status")).text, /PAUSED: the user paused it by hand/);
  assert.match((await run(env, "resume")).text, /Your pause is over/);
  assert.equal(readState(env, NOW).manualPause, null);
  assert.match((await run(env, "pause", "1h")).text, /paused until/);
  assert.equal(readState(env, NOW).manualPause.until, NOW + H);
  assert.equal((await run(env, "pause", "soon")).code, 1);
});

test("a timed resume says until when", async () => {
  const { env } = sandbox();
  recordReading(env, readingFrom(statusInput({ sevenDay: 95 }), NOW));
  assert.match((await run(env, "resume", "1h")).text, /Lifted: weekly 95% \(line 90%\), for 1h, until/);
  assert.equal(readState(env, NOW).resumed[0].until, NOW + H);
});

test("parseWhen: lengths and clock times", () => {
  assert.equal(parseWhen("1h", NOW), H);
  assert.equal(parseWhen("90m", NOW), 90 * 60_000);
  assert.equal(parseWhen("1h30m", NOW), 90 * 60_000);
  const t = parseWhen("18:00", NOW);
  assert.ok(t > 0 && t <= 24 * H);
  assert.equal(new Date(NOW + t).getHours(), 18);
});

test("zero and overflowing durations fail without lifting a stop", async () => {
  const { env } = sandbox();
  recordReading(env, readingFrom(statusInput({ sevenDay: 95 }), NOW));
  for (const duration of ["0m", "0h", "0h0m", `${"9".repeat(310)}h`]) {
    assert.throws(() => parseWhen(duration, NOW), /positive, finite/);
    assert.equal((await run(env, "resume", duration)).code, 1);
    assert.deepEqual(readState(env, NOW).resumed, []);
    assert.equal((await run(env, "pause", duration)).code, 1);
    assert.equal(readState(env, NOW).manualPause, null);
  }
});

test("a timed resume can be extended or changed to last until reset", async () => {
  for (const provider of [[], ["codex"]]) {
    const { env } = sandbox();
    const scoped = provider.length ? codexEnv(env) : env;
    recordReading(scoped, readingFrom(statusInput({ sevenDay: 95 }), NOW));
    assert.equal((await run(env, ...provider, "resume", "1h")).code, 0);
    assert.match((await run(env, ...provider, "resume", "2h")).text, /Lifted:/);
    assert.equal(readState(scoped, NOW).resumed[0].until, NOW + 2 * H);
    assert.match((await run(env, ...provider, "resume")).text, /until it resets/);
    assert.equal(readState(scoped, NOW).resumed[0].until, undefined);
    const ctx = { env: scoped, now: NOW + 3 * H, input: { hook_event_name: "PreToolUse", session_id: "s" } };
    assert.notEqual(runHook(ctx)?.hookSpecificOutput?.permissionDecision, "deny");
  }
});

test("resume clears a manual pause despite damaged usage, preserving saved lifts", async () => {
  for (const provider of [[], ["codex"]]) {
    const { env } = sandbox();
    const scoped = provider.length ? codexEnv(env) : env;
    recordReading(scoped, readingFrom(statusInput({ sevenDay: 95 }), NOW));
    await run(env, ...provider, "resume", "1h");
    const saved = readState(scoped, NOW).resumed;
    await run(env, ...provider, "pause");
    fs.writeFileSync(windowFile(scoped), "{");
    const result = await run(env, ...provider, "resume");
    assert.equal(result.code, 0);
    assert.match(result.text, /Your pause is over/);
    assert.match(result.text, /Only your manual pause was cleared/);
    assert.equal(readState(scoped, NOW).manualPause, null);
    assert.deepEqual(readState(scoped, NOW).resumed, saved);
  }
});

test("removing Claude preserves the shared menu bar and Codex runtime", async () => {
  const { env, root } = sandbox();
  env.CODEX_HOME = path.join(root, "codex");
  env.PERAS_SWIFTBAR_DIR = path.join(root, "swiftbar");
  await run(env, "setup");
  await run(env, "codex", "setup");
  await run(env, "menubar", "install");
  const file = JSON.parse(fs.readFileSync(path.join(env.PERAS_HOME, "menubar.json"), "utf8")).file;
  const body = fs.readFileSync(file, "utf8");
  assert.ok(body.includes("<swiftbar.hideSwiftBar>true</swiftbar.hideSwiftBar>"));
  assert.equal((await run(env, "remove")).code, 0);
  assert.equal(readInstall(env), null);
  assert.ok(readInstall(codexEnv(env)));
  assert.equal(fs.readFileSync(file, "utf8"), body);
  assert.ok(fs.existsSync(path.join(env.PERAS_HOME, "app", "bin", "peras.mjs")));
});

test("set: every kind, per folder, and reset keeps or drops folder lines", async () => {
  const { env } = sandbox();
  assert.match((await run(env, "set", "prompt", "3", "pause")).text, /weekly \+3% per prompt pause/);
  assert.match((await run(env, "set", "weekly", "pace", "pause")).text, /weekly pace pause \(from 50%\)/);
  assert.match((await run(env, "set", "01:00-08:00", "weekly", "50", "pause")).text, /weekly 50% pause 01:00-08:00/);
  const here = await run(env, "set", "--here", "weekly", "60", "pause");
  assert.match(here.text, /in .+: weekly 60% pause/);
  assert.match((await run(env, "set", "reset")).text, /in .+: weekly 60% pause/);
  assert.doesNotMatch((await run(env, "set", "--here", "reset")).text, /in .+:/);
  assert.equal(readRules(env).length, 4);
});

test("status: bars, the forecast, and this week by chat", async () => {
  const { env } = sandbox();
  recordReading(env, readingFrom(statusInput({ fiveHour: 20, sevenDay: 70 }), NOW));
  writeUsage(env, {
    v: 1,
    windows: { seven_day: { resetsAt: inHours(72), pts: [[NOW - 30 * H, 40], [NOW - 10 * H, 60]] } },
    weeks: [],
    blame: { resetsAt: inHours(72), startPct: 60, sessions: { abcdef123: { base: 0, cost: 3, spent: 0, dir: "/w/app" }, b: { base: 0, cost: 1, spent: 0, dir: "/w/b" } } },
  });
  const { text } = await run(env, "status");
  assert.match(text, /7d  ▰▰▰▰▰▰▰▱▱▱  70%/);
  assert.match(text, /full by /);
  assert.match(text, /weekly runs out .* at this pace \(resets /);
  assert.doesNotMatch(text, /on pace for 1\d\d%/, "never a percentage past 100");
  assert.match(text, /≈ \+7\.5% +\/w\/app  abcdef12/);
  assert.match(text, /≈ \+2\.5% +\/w\/b/);
});

test("status tells you when the hooks still run an older version", async () => {
  const { env } = sandbox();
  writeInstall(env, { version: "0.1.1", command: "x" });
  assert.match((await run(env, "status")).text, /still run Peras 0\.1\.1: run `peras setup`/);
});

test("history: past weeks with peak, lines and the wall", async () => {
  const { env } = sandbox();
  assert.match((await run(env, "history")).text, /Nothing yet/);
  writeUsage(env, {
    v: 1,
    windows: { seven_day: { resetsAt: inHours(144), pts: [[NOW - 2 * H, 5]] } },
    weeks: [{ resetsAt: inHours(-24), pts: [[NOW - 160 * H, 10], [NOW - 90 * H, 76], [NOW - 80 * H, 91], [NOW - 50 * H, 100]] }],
    blame: null,
  });
  const { text } = await run(env, "history");
  assert.match(text, /this week, to .+  5% so far/);
  assert.match(text, /week to .+▰▰▰▰▰▰▰▰▰▰ 100%/);
  assert.match(text, /75% .+ · 90% .+ · hit the wall /);
});

test("menu bar: migrates the cached executable plugin to a fresh streaming identity", async () => {
  const { env, root } = sandbox();
  env.PERAS_SWIFTBAR_DIR = path.join(root, "swiftbar");
  fs.mkdirSync(env.PERAS_SWIFTBAR_DIR);
  const oldFile = path.join(env.PERAS_SWIFTBAR_DIR, "peras.1m.sh");
  fs.writeFileSync(oldFile, "old renderer");
  fs.mkdirSync(env.PERAS_HOME, { recursive: true });
  fs.writeFileSync(path.join(env.PERAS_HOME, "menubar.json"), JSON.stringify({ file: oldFile, display: "pear" }));
  writeInstall(env, { command: `"${process.execPath}" "/x/peras.mjs"`, version: "0.2.0" });
  assert.equal((await run(env, "menubar", "install")).code, 0);
  assert.equal(fs.existsSync(oldFile), false);
  const record = JSON.parse(fs.readFileSync(path.join(env.PERAS_HOME, "menubar.json"), "utf8"));
  assert.equal(record.display, "pear");
  assert.match(record.file, /peras-[a-f0-9]{16}\.1m\.sh$/);
  assert.match(fs.readFileSync(record.file, "utf8"), /<swiftbar.type>streamable<\/swiftbar.type>/);
});

test("menu bar: installs a SwiftBar script, renders, and is removed with Peras", async () => {
  const { env, root } = sandbox();
  env.PERAS_SWIFTBAR_DIR = path.join(root, "swiftbar");
  assert.match((await run(env, "menubar", "install")).text, /Run `peras setup` first/);
  writeInstall(env, { command: `"${process.execPath}" "/x/peras.mjs"`, version: "0.2.0" });
  assert.match((await run(env, "menubar", "install")).text, /in the menu bar/);
  const file = JSON.parse(fs.readFileSync(path.join(env.PERAS_HOME, "menubar.json"), "utf8")).file;
  const body = fs.readFileSync(file, "utf8");
  assert.ok(body.includes(`export PERAS_HOME='${env.PERAS_HOME}'`));
  assert.ok(body.includes(`"${process.execPath}" "/x/peras.mjs" "$@" ||`));
  assert.equal(fs.statSync(file).mode & 0o111, 0o111);

  recordReading(env, readingFrom(statusInput({ fiveHour: 20, sevenDay: 93 }), NOW));
  const shown = (await run(env, "menubar")).text.split("\n");
  assert.match(shown[0], /image=[A-Za-z0-9+/=]+,[A-Za-z0-9+/=]+ width=\d+ height=20/);
  assert.match(shown[0], /Claude 5-hour: 20% · pause/);
  assert.match(shown[0], /Codex 5-hour: no reading/);
  assert.doesNotMatch(shown[0], /93%/);
  assert.ok(shown.some(l => l.startsWith("· paused | image=")));
  const labels = shown.filter(l => l.includes("image=") && !l.includes("dropdown=false") && !/^(5h|Week)/.test(l));
  assert.equal(labels.length, 2);
  assert.ok(shown.slice(1).every(l => !l.includes("tooltip=")), "animated dropdown rows cannot produce stray tooltips");
  assert.ok(labels.every(l => !/\b(?:color|refresh|bash|href|stdin)=/.test(l)), "agent names have no action or enabling color parameter");
  const healthRows = shown.filter(l => /^(Protection active|Needs|Not recently verified|Setup missing|Hooks disabled)/.test(l));
  assert.ok(healthRows.every(l => !/\b(?:color|refresh|bash|href|stdin)=/.test(l)), "health is informational");
  assert.ok(shown.filter((l) => /^(--)?(?:Pause(?: 1h)?|Resume(?: 1h)?) \|/.test(l)).every((l) => !l.startsWith("--")), "pause and resume controls stay visible");
  assert.ok(shown.some((l) => /^Resume \| bash=".+peras-[a-f0-9]{16}\.1m\.sh" param1=resume terminal=false refresh=true$/.test(l)));
  assert.ok(shown.some((l) => /^5h +20% · .+ \| image=/.test(l)));
  assert.ok(shown.some((l) => /^Week +93% · .+ \| image=/.test(l)));
  assert.ok(shown.filter((l) => /^(5h|Week).*image=/.test(l)).every((l) => l.includes("refresh=true")), "image rows remain enabled in SwiftBar");
  assert.ok(shown.some((l) => /^----Pear \+ icons and percentages.*checked=true$/.test(l)));
  assert.equal(shown.filter((l) => l.startsWith("Status…")).length, 1);
  const statusAction = shown.find((l) => l.startsWith("Status…"));
  assert.match(statusAction, /^Status… \| href="file:\/\/.+\/status\.html"$/);
  const statusPage = fs.readFileSync(new URL(JSON.parse(statusAction.split("href=")[1])), "utf8");
  assert.match(statusPage, /5-hour · 20% used/);
  assert.match(statusPage, /Weekly · 93% used/);
  assert.match(statusPage, /Active rules &amp; pause reasons/);
  assert.ok(shown.filter((l) => /^(5h|Week).*image=/.test(l)).every((l) => !l.includes("tooltip=")), "resets stay visible without animation-disrupted tooltips");
  assert.equal(shown.filter((l) => l.startsWith("--Explain limits…")).length, 1);
  const explanation = shown.find((l) => l.startsWith("--Explain limits…"));
  assert.match(explanation, /^--Explain limits… \| href="file:\/\/.+\/limits\.html"$/);
  const guide = new URL(JSON.parse(explanation.split("href=")[1]));
  assert.ok(fs.existsSync(guide));

  assert.match((await run(env, "remove")).text, /menu bar plugin is gone/);
  assert.equal(fs.existsSync(file), false);
});

test("menu bar display switches title only and survives reinstall", async () => {
  const { env, root } = sandbox();
  env.PERAS_SWIFTBAR_DIR = path.join(root, "swiftbar");
  writeInstall(env, { command: `"${process.execPath}" "/x/peras.mjs"`, version: "0.2.0" });
  await run(env, "menubar", "install");
  recordReading(env, readingFrom(statusInput({ fiveHour: 20, sevenDay: 60 }), NOW));
  const detailed = (await run(env, "menubar")).text.split("\n");
  assert.equal(displayMode(env), "usage");
  assert.equal((await run(env, "menubar", "display", "pear")).code, 0);
  const pear = (await run(env, "menubar")).text.split("\n");
  assert.match(pear[0], /width=11 height=20/);
  assert.notEqual(pear[0], detailed[0]);
  assert.deepEqual(pear.slice(1).filter(l => !l.includes("param2=display")), detailed.slice(1).filter(l => !l.includes("param2=display")), "meters and controls are unchanged by title mode");
  assert.match(pear.find(l => l.includes("param3=pear")), /param1=menubar param2=display param3=pear.*checked=true/);
  assert.match(pear.find(l => l.includes("param3=usage")), /param3=usage.*checked=false/);
  await run(env, "menubar", "install");
  assert.equal(displayMode(env), "pear");
  assert.equal((await run(env, "menubar", "display", "invalid")).code, 1);
  assert.equal(displayMode(env), "pear");
  assert.equal((await run(env, "menubar", "display", "usage")).code, 0);
  assert.equal((await run(env, "menubar")).text.split("\n")[0], detailed[0]);
});
