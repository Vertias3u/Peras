#!/usr/bin/env node
// The hook and the status line run on every tool call and every render, so they
// load only what they need; everything else goes through the CLI module.
import fs from "node:fs";
import { holdRuntime } from "../src/runtime-use.mjs";
holdRuntime(import.meta.url);

const command = process.argv[2];

if (command === "hook") {
  let output = null;
  // Set only on the tool check, by setup's strict mode, next to onFailure: "block".
  const strict = process.env.PERAS_STRICT === "1";
  try {
    const { runHook } = await import("../src/hook.mjs");
    const { notify } = await import("../src/notify.mjs");
    const input = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
    // Codex adds turn_id to hook input. Older installations mistakenly pointed
    // Codex at the Claude hook; keep already-loaded sessions enforcing Codex
    // pauses while setup replaces their hook definitions.
    const codex = typeof input.turn_id === "string";
    if (codex) {
      const { runCodexHook } = await import("../src/codex.mjs");
      output = await runCodexHook({ input, notify });
    } else output = runHook({ input, notify, strict });
    // Opt-in: the agent's own and the other agent's usage, next to a prompt. Never costs the answer.
    if (input.hook_event_name === "UserPromptSubmit" && (await import("../src/preferences.mjs")).preferences(process.env).agents) {
      try { output = (await import("../src/agent-context.mjs")).withUsageNote(output, { env: process.env, input, provider: codex ? "codex" : "claude" }); } catch { /* the answer stands */ }
    }
  } catch (error) {
    if (strict) {
      // Exit 2 blocks the tool call; stderr is the reason Claude reads. Fixed text: an error can carry a path.
      process.stderr.write("The user's usage guard (Peras) could not check this tool call, and its strict mode blocks tools when that happens. Stop and tell the user Peras needs attention.\n");
      process.exitCode = 2;
    }
    // D3: whatever happened, the action goes ahead and the user is told.
    else output = { systemMessage: `Peras could not check your usage (${String(error?.message ?? error).slice(0, 120)}), so this goes ahead.` };
  }
  if (output) process.stdout.write(JSON.stringify(output));
  process.exitCode ??= 0;
} else if (command === "codex-hook") {
  const { runCodexHook } = await import("../src/codex.mjs");
  const { notify } = await import("../src/notify.mjs");
  let output;
  try {
    const input = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
    output = await runCodexHook({ input, notify });
    if (input.hook_event_name === "UserPromptSubmit" && (await import("../src/preferences.mjs")).preferences(process.env).agents) {
      try { output = (await import("../src/agent-context.mjs")).withUsageNote(output, { env: process.env, input, provider: "codex" }); } catch { /* the answer stands */ }
    }
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
