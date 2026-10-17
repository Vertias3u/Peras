import { setTimeout as delay } from "node:timers/promises";
import { once } from "node:events";
import { renderCombined } from "./menubar.mjs";
import { writeStatusPage } from "./status-page.mjs";
import { checkUnusedReminders } from "./unused-reminders.mjs";
import { checkResets } from "./reset-notifications.mjs";

/** SwiftBar's stream protocol: complete menus followed by ~~~, eight times a second. */
export async function streamMenubar({ env, getSnapshots, write = (text) => process.stdout.write(text), signal, clock = Date.now, frames = Infinity, intervalMs = 125 }) {
  let snapshots = await getSnapshots();
  const started = clock();
  writeStatusPage(env, snapshots, started);
  checkResets(env, snapshots, started);
  checkUnusedReminders(env, snapshots, started);
  let lastSnapshot = started, pending = null;
  let outputCount = 0, lastMenu = null;
  try {
    while (!signal?.aborted && outputCount < frames) {
      const now = clock();
      // Local state updates every second; Codex itself caches RPC reads for a minute.
      // Fetch in the background so a slow/offline app-server cannot stall animation.
      if (now - lastSnapshot >= 1000 && !pending) {
        lastSnapshot = now;
        pending = Promise.resolve().then(getSnapshots).then((next) => { snapshots = next; writeStatusPage(env, snapshots, clock()); checkResets(env, snapshots, clock()); checkUnusedReminders(env, snapshots, clock()); }).catch(() => {}).finally(() => { pending = null; });
      }
      const menu = renderCombined({ snapshots, env, now, animationTime: now - started });
      // An unchanged menu (mascots paused or hidden, nothing new) is not sent again:
      // SwiftBar parses every frame it gets, images and all.
      if (menu !== lastMenu) {
        lastMenu = menu;
        const accepted = write(`${menu}\n~~~\n`);
        // Drop time rather than queue animation frames behind a slow reader.
        if (accepted === false) await once(process.stdout, "drain", { signal });
      }
      outputCount++;
      if (outputCount < frames) await delay(intervalMs, undefined, { signal });
    }
  } catch (error) {
    if (error.name !== "AbortError") throw error;
  } finally {
    if (pending) await pending;
  }
}
