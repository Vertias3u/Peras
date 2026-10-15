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
  assert.match(text, /peras menubar open/);
  const failed = await run(env, ["menubar", "quit"], async () => { throw new Error("not running"); });
  assert.equal(failed.code, 0, "quitting a menu that isn't running is not an error");
});

test("typed in a terminal, peras menubar reads like a person wrote it; piped, it stays SwiftBar's input", async () => {
  const { env } = installed();
  await run(env, ["setup"]);
  const say = async (args, isTTY) => {
    const lines = [];
    const code = await main(args, { env, out: (l) => lines.push(l), isTTY, codexReader: async () => { throw new Error("no codex"); } });
    return { code, text: lines.join("\n") };
  };
  let { code, text } = await say(["menubar"], true);
  assert.equal(code, 0);
  assert.doesNotMatch(text, /image=|bash=|\| /);
  assert.match(text, /not in the menu bar/);
  assert.match(text, /peras menubar install/);
  await run(env, ["menubar", "install"]);
  ({ text } = await say(["menubar"], true));
  assert.doesNotMatch(text, /image=|bash=/);
  assert.match(text, /is in the menu bar/);
  assert.match(text, /peras status/);
  assert.match(text, /peras menubar quit/);
  assert.match((await say(["menubar"], false)).text, /^.*image=.*dropdown=false$/m, "SwiftBar and pipes still get the markup");
  assert.match((await say(["menubar", "show"], true)).text, /image=/, "show always prints the raw menu");
});

test("peras menubar open launches SwiftBar, and quit points to it", async () => {
  const { env } = installed();
  await run(env, ["setup"]);
  const say = async (args, openMenubar) => {
    const lines = [];
    const code = await main(args, { env, out: (l) => lines.push(l), openMenubar, quitMenubar: async () => {}, codexReader: async () => { throw new Error("no codex"); } });
    return { code, text: lines.join("\n") };
  };
  let opens = 0;
  const notInstalled = await say(["menubar", "open"], async () => { opens++; });
  assert.equal(opens, 0, "nothing to open before install");
  assert.match(notInstalled.text, /peras menubar install/);
  await run(env, ["menubar", "install"]);
  const opened = await say(["menubar", "open"], async () => { opens++; });
  assert.equal(opened.code, 0);
  assert.equal(opens, 1);
  assert.match(opened.text, /🍐/);
  const missing = await say(["menubar", "open"], async () => { throw new Error("Unable to find application named 'SwiftBar'"); });
  assert.equal(missing.code, 1);
  assert.match(missing.text, /brew install --cask swiftbar/);
  assert.match((await say(["menubar", "quit"])).text, /peras menubar open/);
});
