#!/usr/bin/env node
// Hook latency, a published release (default v0.3.2) against this tree: `bin/peras.mjs hook` spawned as Claude Code runs it,
// allowing and denying, each in a throwaway home. `node scripts/bench-hook.mjs [runs] [git ref]`
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { spawnSync } from "node:child_process";
const N = Number(process.argv[2] ?? 40);
const v04 = new URL("..", import.meta.url).pathname;
const BASE = process.argv[3] ?? "v0.3.2";
const v03 = fs.mkdtempSync(path.join(os.tmpdir(), "peras-base-"));
const archive = spawnSync("git", ["-C", v04, "archive", BASE, "bin", "src", "package.json"], { maxBuffer: 1 << 26 });
if (archive.status !== 0 || spawnSync("tar", ["-x", "-C", v03], { input: archive.stdout }).status !== 0) throw new Error(`needs git and ${BASE}`);
const pct = (a, p) => a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))];
async function run(root, label, paused) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "peras-bench-"));
  const env = { HOME: home, PERAS_HOME: path.join(home, "peras"), CLAUDE_CONFIG_DIR: path.join(home, "claude"), PERAS_NO_NOTIFY: "1", PATH: process.env.PATH };
  fs.mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true });
  const bin = path.join(root, "bin", "peras.mjs");
  const settings = await import(path.join(root, "src", "settings.mjs"));
  settings.install({ env, command: `"${process.execPath}" "${bin}"`, version: JSON.parse(fs.readFileSync(path.join(root, "package.json"))).version });
  if (paused) { const store = await import(path.join(root, "src", "store.mjs")); (store.pauseNow ?? store.pause)?.(env, { now: Date.now() - 1000 }); }
  const input = JSON.stringify({ hook_event_name: "PreToolUse", session_id: "s1", cwd: home, tool_name: "Bash" });
  const times = [];
  for (let i = 0; i < N + 3; i++) {
    const t = process.hrtime.bigint();
    const r = spawnSync(process.execPath, [bin, "hook"], { env, input, encoding: "utf8" });
    const ms = Number(process.hrtime.bigint() - t) / 1e6;
    if (r.status !== 0) throw new Error(`${label}: ${r.stderr}`);
    if (paused && !r.stdout.includes('"deny"')) throw new Error(`${label}: not denied: ${r.stdout}`);
    if (i >= 3) times.push(ms);
  }
  console.log(`${label.padEnd(18)} p50 ${pct(times, 0.5).toFixed(1)} ms  p95 ${pct(times, 0.95).toFixed(1)} ms`);
}
for (const paused of [false, true]) for (const [root, v] of [[v03, BASE], [v04, "this tree"]]) await run(root, `${v} ${paused ? "deny" : "allow"}`, paused);
