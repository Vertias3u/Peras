import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { sandbox, tempDir } from "./helpers.mjs";
import { installRuntime } from "../src/runtime-install.mjs";
import { main } from "../src/cli.mjs";
const ROOT = new URL("../", import.meta.url).pathname;
const DAY = 86400_000;
const names = (env) => fs.readdirSync(path.join(env.PERAS_HOME, "runtimes")).filter(n => n.startsWith("runtime-"));
const resolved = (env) => path.dirname(path.dirname(fs.realpathSync(path.join(env.PERAS_HOME, "app/bin/peras.mjs"))));
function source() {
  const dir = tempDir("runtime-payload-");
  for (const n of ["bin", "src", "package.json"]) fs.cpSync(path.join(ROOT, n), path.join(dir, n), { recursive: true });
  return dir;
}
function version(root, value) { const f = path.join(root, "package.json"); fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f)), version: value })); }
function age(dir) { const t = new Date(Date.now() - 9 * DAY); fs.utimesSync(path.join(dir, ".complete.json"), t, t); }

test("F1 setup and codex setup reuse one complete runtime for identical contents", async () => {
  const { env, root } = sandbox(); env.CODEX_HOME = root + "/codex";
  for (const args of [["setup"], ["codex", "setup"], ["setup"]]) assert.equal(await main(args, { env, out: () => {} }), 0);
  assert.equal(names(env).length, 1);
  assert.match(names(env)[0], /^runtime-0\.4\.0-[a-f0-9]{20}$/);
  assert.ok(fs.existsSync(path.join(resolved(env), ".complete.json")));
});

test("F1 another version adds one runtime, while another identical install reuses it", () => {
  const { env } = sandbox(), root = source();
  installRuntime(env, root); const old = resolved(env);
  version(root, "0.4.1"); installRuntime(env, root); const next = resolved(env);
  installRuntime(env, root);
  assert.equal(names(env).length, 2); assert.notEqual(old, next); assert.equal(resolved(env), next);
});

test("F1 an incomplete copy is never reused after a real process crash", () => {
  const { env } = sandbox(), root = source(); installRuntime(env, root); const old = resolved(env);
  version(root, "0.4.1");
  const driver = path.join(tempDir("runtime-copy-crash-"), "driver.mjs");
  fs.writeFileSync(driver, `import {installRuntime} from ${JSON.stringify(new URL("../src/runtime-install.mjs", import.meta.url).href)};installRuntime(process.env,process.argv[2],{checkpoint:n=>{if(n==='after:copy:bin')process.kill(process.pid,'SIGKILL');}});`);
  const r = spawnSync(process.execPath, [driver, root], { env, encoding: "utf8" }); assert.equal(r.signal, "SIGKILL", r.stderr);
  assert.equal(resolved(env), old);
  assert.equal(names(env).length, 1, "partial copies must not use a published runtime name");
  installRuntime(env, root); const next = resolved(env);
  assert.ok(fs.existsSync(path.join(next, "src/hook.mjs"))); assert.ok(fs.existsSync(path.join(next, ".complete.json")));
  installRuntime(env, root); assert.equal(names(env).length, 2);
});

test("F1 pruning keeps current, two recent others and an old runtime held by a live bridge", async () => {
  const { pruneRuntimes } = await import("../src/runtime-install.mjs");
  const { env } = sandbox(), root = source(); installRuntime(env, root); const held = resolved(env);
  const child = spawn(process.execPath, [path.join(env.PERAS_HOME, "app/bin/peras.mjs"), "menubar", "bridge", "--protocol", "1"], { env, stdio: ["pipe", "pipe", "pipe"] });
  const ended = new Promise(resolve => child.once("exit", resolve));
  try {
    await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error("bridge did not start")), 5000); child.stdout.on("data", chunk => { if (chunk.toString().includes('"hello"')) { clearTimeout(timer); resolve(); } }); child.once("error", reject); });
    age(held);
    const others = [];
    for (let n = 1; n <= 4; n++) { version(root, `0.4.${n}`); installRuntime(env, root); others.push(resolved(env)); }
    pruneRuntimes(env, { now: Date.now() + 8 * DAY });
    assert.ok(fs.existsSync(held), "live old bridge must retain its lazy imports even after seven days");
    for (const dir of others.slice(-3)) assert.ok(fs.existsSync(dir));
    assert.equal(fs.existsSync(others[0]), false, "old unused runtime can be pruned");
    child.stdin.end(); await ended;
    pruneRuntimes(env, { now: Date.now() + 8 * DAY });
    assert.equal(fs.existsSync(held), false); assert.equal(names(env).length, 3);
  } finally { child.kill(); child.stdin.destroy(); await ended; }
});

test("F1 uncertain process inspection or an unleased legacy process keeps old copies", async () => {
  const { pruneRuntimes } = await import("../src/runtime-install.mjs");
  const { env } = sandbox(), root = source();
  for (let n = 0; n < 5; n++) { version(root, `0.4.${n}`); installRuntime(env, root); }
  pruneRuntimes(env, { now: Date.now() + 8 * DAY, inspect: () => ({ status: 1 }) });
  assert.equal(names(env).length, 5);
  pruneRuntimes(env, { now: Date.now() + 8 * DAY, inspect: () => ({ status: 0, stdout: `${process.pid} node ${env.PERAS_HOME}/app/bin/peras.mjs menubar bridge\n` }) });
  assert.equal(names(env).length, 5);
  pruneRuntimes(env, { now: Date.now() + 8 * DAY, inspect: () => ({ status: 0, stdout: `${process.pid} node test\n` }) });
  assert.equal(names(env).length, 3);
});

test("F1 a changed payload on the same version gets its own content identity", () => {
  const { env } = sandbox(), root = source(); installRuntime(env, root); const before = resolved(env);
  fs.appendFileSync(path.join(root, "src/hook.mjs"), "\n// changed build\n");
  installRuntime(env, root); assert.notEqual(resolved(env), before); assert.equal(names(env).length, 2);
  installRuntime(env, root); assert.equal(names(env).length, 2);
});
