// Local rollback copies: never depend on a previous (possibly unpublished) npm version.
// Only installation files are captured. Rules, controls, readings and history keep growing.
import fs from "node:fs";
import { perasHome } from "./store.mjs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const exists = (file) => Boolean(fs.lstatSync(file, { throwIfNoEntry: false }));
const copy = (from, to) => {
  if (fs.lstatSync(from).isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(from), to, process.platform === "win32" ? "junction" : undefined);
  else if (process.platform === "darwin" && fs.existsSync(path.join(from, "Contents", "Info.plist"))) {
    // fs.cp drops quarantine/xattrs. An app rollback must preserve the original bundle as received.
    const copied = spawnSync("/usr/bin/ditto", [from, to], { encoding: "utf8", timeout: 120_000 });
    if (copied.status !== 0) throw new Error(`Could not preserve the app bundle: ${copied.stderr || copied.error?.message || "ditto failed"}`);
  } else fs.cpSync(from, to, { recursive: true, verbatimSymlinks: true });
};
// Restore runtime entrypoints without taking away app/bin while a hook starts.
// Retain new files too: old and new in-flight hooks may still reference either copy.
function restoreRuntime(saved, target) {
  const stat = fs.lstatSync(saved);
  if (stat.isDirectory()) {
    fs.mkdirSync(target, { recursive: true });
    for (const name of fs.readdirSync(saved)) restoreRuntime(path.join(saved, name), path.join(target, name));
  } else {
    const temp = `${target}.${process.pid}.restore`;
    fs.rmSync(temp, { force: true });
    copy(saved, temp);
    fs.renameSync(temp, target);
  }
}

export function updateBackup(files, home = perasHome(process.env), { runtime = null } = {}) {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const dir = fs.mkdtempSync(path.join(home, ".peras-update-"));
  const entries = [];
  try {
    for (const file of new Set(files.filter(Boolean))) {
      const saved = path.join(dir, String(entries.length));
      const present = exists(file);
      if (present) copy(file, saved);
      entries.push({ file, saved, present });
    }
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(entries), { mode: 0o600 });
  } catch (error) { fs.rmSync(dir, { recursive: true, force: true }); throw error; }
  return {
    dir,
    restore() {
      for (const { file, saved, present } of entries) {
        // A failed staged install never detached this link; leave it continuously available.
        if (present && fs.lstatSync(saved).isSymbolicLink() && fs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink() && fs.readlinkSync(saved) === fs.readlinkSync(file)) continue;
        if (present && file === runtime) { restoreRuntime(saved, file); continue; }
        fs.rmSync(file, { recursive: true, force: true });
        if (present) { fs.mkdirSync(path.dirname(file), { recursive: true }); copy(saved, file); }
      }
    },
    discard() { fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

/** npm's global launchers, including Windows shims. Unknown test/custom layouts have no inferred bin. */
export function globalLaunchers(modules) {
  if (path.basename(modules) !== "node_modules") return [];
  const prefix = path.basename(path.dirname(modules)) === "lib" ? path.resolve(modules, "../..") : path.dirname(modules);
  return process.platform === "win32"
    ? ["peras", "peras.cmd", "peras.ps1"].map((name) => path.join(prefix, name))
    : [path.join(prefix, "bin", "peras")];
}
