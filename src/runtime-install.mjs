// Publish one complete runtime through an atomic entrypoint link. Old runtimes stay
// available for hooks that resolved their entrypoint before the switch (including legacy app/src).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { perasHome } from "./store.mjs";
import { withControlLock } from "./control-lock.mjs";
import { COMPLETE, runtimeIdentity, completeRuntime, currentRuntime, pruneRuntimes } from "./runtime-storage.mjs";
export { pruneRuntimes } from "./runtime-storage.mjs";

export function installRuntime(env, root, { checkpoint = () => {}, platform = process.platform } = {}) {
  const home = perasHome(env), app = path.join(home, "app"), versions = path.join(home, "runtimes");
  const step = (name, fn) => { checkpoint(`before:${name}`); const result = fn(); checkpoint(`after:${name}`); return result; };
  step("versions", () => fs.mkdirSync(versions, { recursive: true, mode: 0o700 }));
  return withControlLock(path.join(versions, "install"), () => {
    const identity = step("identity", () => runtimeIdentity(root));
    const candidates = fs.readdirSync(versions).filter(name => name === identity.name || name.startsWith(`${identity.name}-repair-`));
    let fresh = candidates.map(name => path.join(versions, name)).find(dir => completeRuntime(dir, identity));
    if (!fresh) {
      const staged = step("directory", () => fs.mkdtempSync(path.join(versions, ".runtime-copy-")));
      for (const part of ["bin", "src", "package.json"]) step(`copy:${part}`, () => fs.cpSync(path.join(root, part), path.join(staged, part), { recursive: true, dereference: true }));
      if (runtimeIdentity(staged).digest !== identity.digest) throw Error("Runtime changed while copying; run setup again. The installed runtime was not changed.");
      // Completion is written last. A killed copy can never be mistaken for a reusable runtime.
      step("complete", () => fs.writeFileSync(path.join(staged, COMPLETE), JSON.stringify(identity), { mode: 0o600 }));
      const canonical = path.join(versions, identity.name);
      // A modified old directory may still be in use; never replace or rename it out from under imports.
      fresh = fs.existsSync(canonical) ? `${canonical}-repair-${crypto.randomUUID()}` : canonical;
      step("runtime-publish", () => fs.renameSync(staged, fresh));
    }
    // Protect the resolver-to-lease startup window when publishing an old runtime again.
    const touch = dir => { if (dir && path.dirname(dir) === fs.realpathSync(versions)) { const file = path.join(dir, COMPLETE); if (fs.existsSync(file)) { const now = new Date(); fs.utimesSync(file, now, now); } } };
    step("retain-current", () => touch(currentRuntime(env)));
    step("retain-next", () => touch(fs.realpathSync(fresh)));
    step("entry-directory", () => fs.mkdirSync(path.join(app, "bin"), { recursive: true, mode: 0o700 }));
    const link = (target, file, name) => {
      const temp = `${file}.${crypto.randomUUID()}.new`;
      if (platform === "win32") {
        // File symlinks require extra privileges on Windows. A regular launcher imports
        // the immutable entrypoint, so its imports are still isolated to one runtime.
        if (name === "entry") step(`link:${name}`, () => fs.writeFileSync(temp, `await import(${JSON.stringify(pathToFileURL(target).href)});\n`, { mode: 0o600 }));
        else step(`link:${name}`, () => fs.copyFileSync(target, temp));
      } else step(`link:${name}`, () => fs.symlinkSync(path.relative(path.dirname(file), target), temp));
      step(`publish:${name}`, () => fs.renameSync(temp, file));
    };
    // Compatibility views for existing tools. Keep original legacy files in place: an old
    // hook may already have loaded its main module and still need to import app/src.
    // Current entrypoints never read these legacy src/package files; already-running old processes may still use them.
    for (const part of ["src", "package.json"]) {
      const file = path.join(app, part), existing = fs.lstatSync(file, { throwIfNoEntry: false });
      if (platform === "win32" && part === "src") {
        if (!existing) step("legacy-sources", () => fs.cpSync(path.join(fresh, part), file, { recursive: true }));
      } else if (platform === "win32" || !existing || existing.isSymbolicLink()) link(path.join(fresh, part), file, part);
    }
    // Node resolves this symlink before loading any module; all relative imports then
    // stay inside that one complete directory, even if setup switches the link again.
    link(path.join(fresh, "bin", "peras.mjs"), path.join(app, "bin", "peras.mjs"), "entry");
    // Pruning is best effort; inspection or cleanup failures must not undo a published runtime.
    try { step("prune", () => pruneRuntimes(env)); } catch { /* retry next setup */ }
    return path.join(app, "bin", "peras.mjs");
  });
}
