// A made-up week in a throwaway home, for the README and the site's terminal.
//   node scripts/demo-week.mjs [status|why|history|menubar show|statusline]
//   node scripts/demo-week.mjs site-menu RUN_ROOT   redraws site/menubar/app-*.png with a built Peras app
//   node scripts/demo-week.mjs --check   fails if README.md or site/index.html no longer match
// The output is real: it is Peras itself, run on the demo week.
process.env.TZ = "Europe/Sofia";
import fs from "node:fs";
import path from "node:path";

const root = new URL("../", import.meta.url);
const { main } = await import(new URL("src/cli.mjs", root));
const { recordReading } = await import(new URL("src/store.mjs", root));
const { recordHookRun } = await import(new URL("src/hook-health.mjs", root));
const { readingFrom } = await import(new URL("src/window.mjs", root));
const { writeUsage } = await import(new URL("src/usage.mjs", root));
const { codexEnv } = await import(new URL("src/codex.mjs", root));
const { runStatusline } = await import(new URL("src/statusline.mjs", root));
const { sandbox, NOW, statusInput, inHours } = await import(new URL("test/helpers.mjs", root));

const H = 3600_000;
const { env, root: home } = sandbox();
env.CODEX_HOME = path.join(home, ".codex");
env.CLAUDE_CONFIG_DIR = path.join(home, ".claude");
fs.mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true });
fs.mkdirSync(env.CODEX_HOME, { recursive: true });
await main(["setup"], { env, now: NOW, out: () => {} });
await main(["codex", "setup"], { env, now: NOW, out: () => {} });
// Both guards ran a tool a few minutes ago, as on a machine in use.
recordHookRun(env, "PreToolUse", NOW - 5 * 60_000);
recordHookRun(codexEnv(env), "PreToolUse", NOW - 5 * 60_000);
const reading = { fiveHour: 24, sevenDay: 78, fiveResets: inHours(3.4), sevenResets: inHours(69) };
recordReading(env, readingFrom(statusInput(reading), NOW - 120_000));
const dir = (d) => path.join(home, "code", d);
writeUsage(env, {
  v: 1,
  windows: { seven_day: { resetsAt: inHours(69), pts: [[NOW - 30 * H, 52], [NOW - 12 * H, 64]] } },
  weeks: [],
  blame: { resetsAt: inHours(69), startPct: 20, sessions: {
    "7f3a9c21aa": { base: 0, cost: 41, spent: 0, dir: dir("app") },
    "b81e04d7bb": { base: 0, cost: 12, spent: 0, dir: dir("blog") },
    "c0ffee99cc": { base: 0, cost: 5, spent: 0, dir: dir("app") },
  } },
});
const codexReader = async () => ({ rateLimits: { limitId: "codex",
  primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: inHours(2.2) },
  secondary: { usedPercent: 41, windowDurationMins: 10080, resetsAt: inHours(101) } } });

async function run(args) {
  const lines = [];
  await main(args, { env: { ...env, NO_COLOR: "1" }, now: NOW, out: (l) => lines.push(l), codexReader });
  return lines.join("\n");
}
function statusline() {
  const input = { ...statusInput(reading), session_id: "b81e04d7bb", workspace: { current_dir: dir("blog") } };
  return runStatusline({ stdin: JSON.stringify(input), env: { ...env, NO_COLOR: "1" }, now: NOW }).stdout.trim();
}

const args = process.argv.slice(2);
// The Peras app's menu on the demo week, rendered by a built app (./script/build_and_run.sh --headless):
// the demo week becomes a protocol-1 snapshot, the app's menu probe draws it in dark mode without its
// "Preview" badge, and the menu and menu bar title land in site/menubar/app-*.png.
if (args[0] === "site-menu") {
  const runRoot = args[1];
  if (!runRoot || !path.isAbsolute(runRoot)) throw new Error("usage: demo-week.mjs site-menu ABSOLUTE_NATIVE_RUN_ROOT");
  const { spawnSync } = await import("node:child_process");
  const { refreshCodex } = await import(new URL("src/codex.mjs", root));
  const { snapshot } = await import(new URL("src/providers.mjs", root));
  const { providerPayload, settingsPayload, discoveryPayload, snapshotMessage, snapshotProblems } = await import(new URL("src/native-protocol.mjs", root));
  await refreshCodex(env, NOW - 60_000, { reader: codexReader });
  const sign = (body) => `tok_demo_${JSON.stringify(body).length}`;
  const providers = [];
  for (const provider of ["claude", "codex"]) providers.push(providerPayload(await snapshot(env, NOW, { provider, cwd: null }), { now: NOW, sign, id: () => `ctx_demo_${provider}` }));
  const message = snapshotMessage({ bridgeInstance: "demo", revision: 1, now: NOW, providers, settings: settingsPayload(env, { now: NOW, sign }), discovery: discoveryPayload(env, providers, { now: NOW, sign }) });
  const problems = snapshotProblems(message);
  if (problems.length) throw new Error(`demo snapshot: ${problems.join(", ")}`);
  // The app hides resets that are behind the real clock: move every time forward by whole weeks,
  // so the menu shows the demo week's weekdays and times.
  // Whole weeks, less any summer-time change between the two dates, so the wall-clock times stay.
  const WEEK = 7 * 24 * H, weeks = Math.ceil((Date.now() - NOW) / WEEK + 1) * WEEK;
  const shift = weeks + (new Date(NOW + weeks).getTimezoneOffset() - new Date(NOW).getTimezoneOffset()) * 60_000;
  const later = (value, key) => (typeof value === "number" && /Ms$/.test(key) && value > 1e12 ? value + shift
    : Array.isArray(value) ? value.map((v) => later(v, key))
    : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, later(v, k)])) : value);
  const shifted = later(message, "");
  const work = fs.mkdtempSync(path.join("/private/tmp", "peras-site-menu-"));
  fs.mkdirSync(path.join(work, "fixtures"));
  fs.writeFileSync(path.join(work, "fixtures", "demo-week.json"), JSON.stringify(shifted));
  const probe = path.join(work, "probe");
  const launched = spawnSync(process.execPath, [new URL("native/scripts/launch-built.mjs", root).pathname, runRoot, "--menu-probe", probe, "--site-image", "--fixtures", path.join(work, "fixtures"), "--fixture", "demo-week"], { stdio: "inherit", env: { ...process.env, PERAS_LAUNCH_TZ: process.env.TZ } });
  const report = JSON.parse(fs.readFileSync(path.join(probe, "menu-probe.json"), "utf8"));
  if (launched.status !== 0 || !report.complete || !report.titleWritten || !report.images?.[0]?.nonblank) throw new Error(`The app did not draw the menu; see ${probe}`);
  fs.copyFileSync(path.join(probe, "site-menu.png"), new URL("site/menubar/app-menu.png", root));
  fs.copyFileSync(path.join(probe, "site-title.png"), new URL("site/menubar/app-title.png", root));
  fs.rmSync(work, { recursive: true, force: true });
  console.log(`Wrote site/menubar/app-menu.png (${report.images[0].width}×${report.images[0].height}) and app-title.png.`);
  process.exit(0);
}
if (args[0] !== "--check") {
  console.log(args[0] === "statusline" ? statusline() : await run(args.length ? args : ["status"]));
  process.exit(0);
}

// --check: the docs must show what Peras prints today.
const status = await run(["status"]);
const lines = new Set(status.split("\n").map((l) => l.trimEnd()));
const problems = [];
const readme = fs.readFileSync(new URL("README.md", root), "utf8");
const block = /```\n\$ peras status\n([\s\S]*?)\n```/.exec(readme)?.[1];
if (block !== status) problems.push(`README's \`peras status\` block differs. Today's output:\n\n${status}\n`);
const line = /coloured by your own lines: `([^`]+)`/.exec(readme)?.[1];
if (line !== statusline()) problems.push(`README's status line example is \`${line}\`; today it is \`${statusline()}\`.`);
const site = fs.readFileSync(new URL("site/index.html", root), "utf8");
const term = /<div class="term-body"[^>]*>([\s\S]*?)\n {4}<\/div>/.exec(site)?.[1] ?? "";
for (const row of term.split("\n")) {
  const text = row.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").trimEnd();
  if (!text.trim() || text.startsWith("$")) continue;
  if (!lines.has(text)) problems.push(`site/index.html terminal shows a line Peras no longer prints: ${text}`);
}
// The app's menu on the site is a picture of the demo week; its description must name the demo's numbers.
const described = /aria-label="The Peras app's menu: ([^"]*)"/.exec(site)?.[1] ?? "";
for (const value of [`${reading.fiveHour}%`, `${reading.sevenDay}%`, "12%", "41%"]) {
  if (!described.includes(value)) problems.push(`site/index.html describes the app's menu without the demo week's ${value}: run demo-week.mjs site-menu and update its aria-label`);
}
if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log("README and site match today's demo output.");
