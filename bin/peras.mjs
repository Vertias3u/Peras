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
    // Codex adds turn_id to hook input. Older installations mistakenly pointed
    // Codex at the Claude hook; keep already-loaded sessions enforcing Codex
    // pauses while setup replaces their hook definitions.
    if (typeof input.turn_id === "string") {
      const { runCodexHook } = await import("../src/codex.mjs");
      output = await runCodexHook({ input, notify });
    } else output = runHook({ input, notify });
  } catch (error) {
    // D3: whatever happened, the action goes ahead and the user is told.
    output = { systemMessage: `Peras could not check your usage (${String(error?.message ?? error).slice(0, 120)}), so this goes ahead.` };
  }
  if (output) process.stdout.write(JSON.stringify(output));
  process.exitCode = 0;
} else if (command === "codex-hook") {
  const { runCodexHook } = await import("../src/codex.mjs");
  const { notify } = await import("../src/notify.mjs");
  let output;
  try {
    output = await runCodexHook({ input: JSON.parse(fs.readFileSync(0, "utf8") || "{}"), notify });
  } catch (error) {
    output = { systemMessage: `Peras could not check Codex usage (${String(error?.message ?? error).slice(0, 120)}); this action goes ahead.` };
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
