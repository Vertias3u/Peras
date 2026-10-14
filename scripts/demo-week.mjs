// A made-up week in a throwaway home, for the README and the site's terminal.
//   node scripts/demo-week.mjs [status|why|history|menubar show|statusline]
//   node scripts/demo-week.mjs site-images   redraws site/menubar/*.png from the demo week's menu
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

// The menu bar as SwiftBar shows it: each row's text and its dark-mode image.
async function menubar() {
  return (await run(["menubar"])).split("\n").map((line) => {
    const [text, params = ""] = line.split(" | ");
    const image = /image=([A-Za-z0-9+/=]+)(?:,([A-Za-z0-9+/=]+))?/.exec(params);
    return { text: text.trimEnd(), image: image && Buffer.from(image[2] ?? image[1], "base64") };
  });
}

const args = process.argv.slice(2);
if (args[0] === "site-images") {
  const { progressImage } = await import(new URL("src/menubar-image.mjs", root));
  const { inflateSync, deflateSync } = await import("node:zlib");
  const rows = await menubar();
  const out = new URL("site/menubar/", root);
  fs.mkdirSync(out, { recursive: true });
  const labels = rows.filter((r) => r.image && !r.text && r !== rows[0]);
  const weeks = rows.filter((r) => r.text.startsWith("Week"));
  const files = { "title.png": rows[0].image, "label-claude.png": labels[0].image, "label-codex.png": labels[1].image, "week-claude.png": weeks[0].image, "week-codex.png": weeks[1].image };
  // The 5-hour bars as a strip of 80 frames, 125 ms apart: one 10 s walk there and back, as the menu streams it.
  const rgba = (png) => {
    let i = 8, w = 0, h = 0; const idat = [];
    while (i < png.length) { const n = png.readUInt32BE(i), type = png.toString("ascii", i + 4, i + 8), data = png.subarray(i + 8, i + 8 + n); i += 12 + n; if (type === "IHDR") { w = data.readUInt32BE(0); h = data.readUInt32BE(4); } if (type === "IDAT") idat.push(data); }
    const raw = inflateSync(Buffer.concat(idat)), px = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) raw.copy(px, y * w * 4, y * (w * 4 + 1) + 1, (y + 1) * (w * 4 + 1));
    return px;
  };
  const strip = (frames, w, h) => {
    const width = w * frames.length, px = Buffer.alloc(width * h * 4);
    frames.forEach((f, n) => { for (let y = 0; y < h; y++) f.copy(px, (y * width + n * w) * 4, y * w * 4, (y + 1) * w * 4); });
    const rows = Buffer.alloc((width * 4 + 1) * h);
    for (let y = 0; y < h; y++) px.copy(rows, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
    // Reuse Peras' own PNG writer by drawing a bar and swapping in these pixels.
    const head = progressImage(0).png, ihdr = Buffer.from(head.subarray(8, 33));
    ihdr.writeUInt32BE(width, 8); ihdr.writeUInt32BE(h, 12);
    return Buffer.concat([head.subarray(0, 8), chunk("IHDR", ihdr.subarray(8, 21)), chunk("IDAT", deflateSync(rows, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
  };
  const crcTable = Array.from({ length: 256 }, (_, n) => { for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1; return n >>> 0; });
  function chunk(type, data) {
    const body = Buffer.concat([Buffer.from(type), data]); let crc = 0xffffffff;
    for (const b of body) crc = crcTable[(crc ^ b) & 255] ^ (crc >>> 8);
    const len = Buffer.alloc(4), sum = Buffer.alloc(4); len.writeUInt32BE(data.length); sum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([len, body, sum]);
  }
  for (const [provider, row] of [["claude", rows.find((r) => r.text.startsWith("5h"))], ["codex", rows.filter((r) => r.text.startsWith("5h"))[1]]]) {
    const pct = Number(/(\d+)%/.exec(row.text)[1]);
    const frames = Array.from({ length: 80 }, (_, n) => rgba(progressImage(pct, { tone: provider, mascot: { provider, timeMs: n * 125, paused: false } }).png));
    files[`walk-${provider}.png`] = strip(frames, 192, 40);
  }
  for (const [name, png] of Object.entries(files)) fs.writeFileSync(new URL(name, out), png);
  console.log(`Wrote ${Object.keys(files).length} images to site/menubar/.`);
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
// The menu bar drawn on the site shows rows the menu really has.
const menu = new Set((await menubar()).map((r) => r.text.replace(/^-+/, "")));
for (const [, row] of site.matchAll(/data-menu>([^<]*)</g)) {
  const text = row.replace(/&amp;/g, "&");
  if (!menu.has(text)) problems.push(`site/index.html menu bar shows a row the menu no longer has: ${text}`);
}
if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log("README and site match today's demo output.");
