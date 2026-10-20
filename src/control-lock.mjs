// One writer at a time for your explicit controls: a pause, a resume. The CLI,
// the native app, notification actions and the self-test all take this lock;
// hooks never do, so a tool call never waits on it.
//
// The lock file names its owner (pid and a random nonce). A lock is taken over
// only when that process is gone, never just because it is old: a slow writer
// keeps its lock.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export class ControlsBusy extends Error {
  constructor() { super("Another Peras change is being saved. Try again in a moment."); this.code = "busy"; }
}

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
};
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const read = (file) => { try { return fs.readFileSync(file, "utf8"); } catch { return null; } };

/** Removes `lock` only if it still holds `owner`, a process that has ended. */
function takeOver(lock, owner) {
  const pid = Number(owner?.split(" ")[0]);
  // An empty lock is a writer between creating and naming it: leave it, unless that moment is long past.
  if (owner === "" ? Date.now() - (fs.statSync(lock, { throwIfNoEntry: false })?.mtimeMs ?? Infinity) < 10_000 : !Number.isSafeInteger(pid) || pid <= 0 || alive(pid)) return;
  const aside = `${lock}.${crypto.randomUUID()}`;
  try { fs.renameSync(lock, aside); } catch { return; }
  // Someone else took the lock between reading and moving it: put theirs back.
  if (read(aside) !== owner) { try { fs.linkSync(aside, lock); } catch { /* a newer lock exists: theirs stands */ } }
  try { fs.unlinkSync(aside); } catch { /* gone already */ }
}

/** Runs `fn` while holding the lock next to `file`. Synchronous, so nothing else runs inside. */
export function withControlLock(file, fn, { attempts = 40, waitMs = 25 } = {}) {
  const lock = `${file}.controls.lock`;
  fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
  const owner = `${process.pid} ${crypto.randomUUID()}`;
  let fd;
  for (let i = 0; i < attempts && fd === undefined; i++) {
    try {
      fd = fs.openSync(lock, "wx", 0o600);
      try { fs.writeSync(fd, owner); } catch (error) { fs.closeSync(fd); fd = undefined; fs.unlinkSync(lock); throw error; }
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      takeOver(lock, read(lock));
      if (i + 1 < attempts) pause(waitMs);
    }
  }
  if (fd === undefined) throw new ControlsBusy();
  try {
    return fn();
  } finally {
    fs.closeSync(fd);
    if (read(lock) === owner) fs.unlinkSync(lock);
  }
}
