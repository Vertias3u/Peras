import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// Build and run the pear-branded sender outside the hook process.
export function notify(title, body, { env = process.env, platform = process.platform, launch = spawn, provider, category, resetsAt, pauseKeys } = {}) {
  if (env.PERAS_NO_NOTIFY === "1" || !["darwin", "linux"].includes(platform)) return;
  try {
    const child = launch(process.execPath, [fileURLToPath(new URL("./notification-worker.mjs", import.meta.url)), title, body, JSON.stringify({ provider, category, resetsAt, pauseKeys })], {
      env: { ...process.env, ...env }, detached: true, stdio: "ignore",
    });
    child.on("error", () => {});
    child.unref();
  } catch { /* Notification failures must never interfere with enforcement. */ }
}

// Unlike hook alerts, the explicit test waits and reports permission/build errors.
export async function testNotification(title, body, { env = process.env } = {}) {
  if (env.PERAS_NO_NOTIFY === "1") return;
  const { deliverNotification } = await import("./notification-worker.mjs");
  await deliverNotification(title, body, env);
}
