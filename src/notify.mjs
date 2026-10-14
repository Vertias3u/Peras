import { spawn } from "node:child_process";

// A desktop notification that never holds up the hook: fire and forget.
// Claude Code does not push a phone notification for a hook's "ask" (checked
// 2026-10-14), so this is how the user hears that Peras is asking or has paused.

const appleQuote = (s) => `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

export function notify(title, body, { env = process.env, platform = process.platform } = {}) {
  if (env.PERAS_NO_NOTIFY === "1") return;
  let command;
  let args;
  if (platform === "darwin") {
    command = "osascript";
    args = ["-e", `display notification ${appleQuote(body)} with title ${appleQuote(title)}`];
  } else if (platform === "linux") {
    command = "notify-send";
    args = [title, body];
  } else return;
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  } catch {
    // No notifier on this machine: the status line and hook messages still say it.
  }
}
