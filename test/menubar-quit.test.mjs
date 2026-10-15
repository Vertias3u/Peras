// The menu has a way out: Quit, at the bottom like every menu bar app.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { main } from "../src/cli.mjs";
import { sandbox } from "./helpers.mjs";

async function run(env, args, quitMenubar) {
  const lines = [];
  const code = await main(args, { env, out: (l) => lines.push(l), codexReader: async () => { throw new Error("no codex"); }, quitMenubar });
  return { code, text: lines.join("\n") };
}
function installed() {
  const { env, root } = sandbox();
  env.PERAS_SWIFTBAR_DIR = path.join(root, "plugins");
  return { env, root };
}

test("the menu ends with Quit, which runs peras menubar quit", async () => {
  const { env } = installed();
  await run(env, ["setup"]);
  await run(env, ["menubar", "install"]);
  const menu = (await run(env, ["menubar"])).text.split("\n");
  const last = menu.filter((l) => !l.startsWith("--")).at(-1);
  assert.match(last, /^Quit \| bash=".*\.sh" param1=menubar param2=quit terminal=false/);
  assert.equal(menu.at(menu.indexOf(last) - 1), "---", "Quit sits under its own separator");
});

test("with other SwiftBar plugins around, the item says it quits SwiftBar", async () => {
  const { env } = installed();
  await run(env, ["setup"]);
  await run(env, ["menubar", "install"]);
  fs.writeFileSync(path.join(env.PERAS_SWIFTBAR_DIR, "weather.5m.sh"), "#!/bin/sh\necho ☀️\n", { mode: 0o755 });
  assert.match((await run(env, ["menubar"])).text, /^Quit SwiftBar \(all plugins\) \| bash=/m);
});

test("peras menubar quit quits SwiftBar and says protection keeps running", async () => {
  const { env } = installed();
  let quits = 0;
  const { code, text } = await run(env, ["menubar", "quit"], async () => { quits++; });
  assert.equal(code, 0);
  assert.equal(quits, 1);
  assert.match(text, /Protection keeps running/);
  assert.match(text, /open SwiftBar/i);
  const failed = await run(env, ["menubar", "quit"], async () => { throw new Error("not running"); });
  assert.equal(failed.code, 0, "quitting a menu that isn't running is not an error");
});
