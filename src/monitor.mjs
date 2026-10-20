// Reset and unused-allowance reminders come from one process at a time: the native
// app's bridge or the SwiftBar stream, whichever holds the lease. The holder renews
// it on every refresh; it passes on at once when the holder ends or lets go, and
// after STALE_MS when the holder stops renewing (asleep, stuck). Enforcement never
// depends on it: hooks don't read it.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { withControlLock } from "./control-lock.mjs";
import { perasHome, readJson, writeJsonAtomic } from "./store.mjs";
import { checkResets } from "./reset-notifications.mjs";
import { checkUnusedReminders } from "./unused-reminders.mjs";

export const STALE_MS = 15_000;
const file = (env) => path.join(perasHome(env), "monitor-owner.json");
const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; } };

/** A fresh holder identity for one bridge or stream. */
export const monitorId = () => crypto.randomUUID();

/** True when `id` holds the lease now, taking it if it is free. Never waits: a busy lease is a skipped turn. */
export function holdMonitor(env, now, { id, owner, pid = process.pid, alive = isAlive }) {
  try {
    return withControlLock(file(env), () => {
      let lease = null;
      try { lease = readJson(file(env)); } catch { /* damaged: free */ }
      const free = !lease || lease.id === id || !Number.isSafeInteger(lease.pid) || !alive(lease.pid) || !Number.isFinite(lease.at) || now - lease.at > STALE_MS || now < lease.at - STALE_MS;
      if (!free) return false;
      writeJsonAtomic(file(env), { id, owner, pid, at: now });
      return true;
    }, { attempts: 1 });
  } catch {
    return false;
  }
}

/** Lets the lease go if `id` holds it, so the other monitor takes over on its next refresh. */
export function releaseMonitor(env, id) {
  try {
    withControlLock(file(env), () => {
      let lease = null;
      try { lease = readJson(file(env)); } catch { return; }
      if (lease?.id === id) fs.rmSync(file(env), { force: true });
    }, { attempts: 4 });
  } catch { /* it goes stale instead */ }
}

/** Runs the reminders if this process is the monitor. Each check fails alone. */
export function runMonitor(env, snapshots, now, { id, owner, notify }) {
  if (!holdMonitor(env, now, { id, owner })) return false;
  try { checkResets(env, snapshots, now, notify); } catch { /* next refresh */ }
  try { checkUnusedReminders(env, snapshots, now, notify); } catch { /* next refresh */ }
  return true;
}
