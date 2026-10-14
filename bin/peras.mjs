#!/usr/bin/env node
// The hook and the status line run on every tool call and every render, so they
// load only what they need; everything else goes through the CLI module.
import fs from "node:fs";

const command = process.argv[2];

if (command === "hook") {
  let output = null;
  try {
    const { runHook } = await import("../src/hook.mjs");
    const { notify } = await import("../src/notify.mjs");
    const input = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
    output = runHook({ input, notify });
  } catch (error) {
    // D3: whatever happened, the action goes ahead and the user is told.
    output = { systemMessage: `Peras could not check your usage (${String(error?.message ?? error).slice(0, 120)}), so this goes ahead.` };
  }
  if (output) process.stdout.write(JSON.stringify(output));
  process.exitCode = 0;
} else if (command === "statusline") {
  const { runStatusline } = await import("../src/statusline.mjs");
  let stdin = Buffer.alloc(0);
  try {
    stdin = fs.readFileSync(0);
  } catch {
    // No input: render what is stored.
  }
  const { stdout, code } = runStatusline({ stdin });
  process.stdout.write(stdout);
  process.exitCode = code;
} else {
  const { main } = await import("../src/cli.mjs");
  process.exitCode = await main(process.argv.slice(2));
}
