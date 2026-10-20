import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { perasHome } from "./store.mjs";
import { resolveRuntimeEntry } from "./runtime-use.mjs";

export const COMPLETE = ".complete.json";
const WEEK = 7 * 86400_000;
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== "ESRCH"; } };
const real = file => { try { return fs.realpathSync(file); } catch { return file; } };

export function runtimeIdentity(root) {
  const hash = crypto.createHash("sha256");
  const walk = relative => {
    const file = path.join(root, relative), stat = fs.statSync(file);
    if (stat.isDirectory()) for (const name of fs.readdirSync(file).sort()) walk(path.join(relative, name));
    else {
      if (!stat.isFile()) throw Error(`Unsupported runtime file: ${relative}`);
      hash.update(JSON.stringify([relative.split(path.sep).join("/"), stat.mode & 0o777, stat.size]));
      hash.update(fs.readFileSync(file));
    }
  };
  for (const part of ["bin", "src", "package.json"]) walk(part);
  const { name, version } = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  if (name !== "peras-cli" || typeof version !== "string" || !/^[\w.+-]+$/.test(version)) throw Error("Invalid runtime package.");
  const digest = hash.digest("hex");
  return { version, digest, name: `runtime-${version}-${digest.slice(0, 20)}` };
}

export function completeRuntime(dir, identity) {
  try {
    const mark = JSON.parse(fs.readFileSync(path.join(dir, COMPLETE), "utf8"));
    return mark.digest === identity.digest && mark.version === identity.version && runtimeIdentity(dir).digest === identity.digest;
  } catch { return false; }
}

export function currentRuntime(env) {
  try { return path.dirname(path.dirname(resolveRuntimeEntry(path.join(perasHome(env), "app/bin/peras.mjs")))); }
  catch { return null; }
}

function users(env, rows, inspect) {
  const held = new Set(), knownPids = new Set();
  for (const row of rows) {
    let leases = [];
    try { leases = fs.readdirSync(path.join(row.dir, ".in-use")); } catch (e) { if (e.code !== "ENOENT") held.add(row.dir); }
    for (const name of leases) {
      const file = path.join(row.dir, ".in-use", name);
      try {
        const { pid } = JSON.parse(fs.readFileSync(file, "utf8"));
        if (!Number.isSafeInteger(pid) || pid <= 0) { held.add(row.dir); continue; }
        if (alive(pid)) { held.add(row.dir); knownPids.add(pid); }
        else fs.unlinkSync(file);
      } catch { held.add(row.dir); }
    }
  }
  // Old copies predate leases. A legacy process using the stable path is ambiguous:
  // retain all candidates rather than guess which copy it resolved when it started.
  const result = inspect();
  if (result.status !== 0 || typeof result.stdout !== "string") return { held, uncertain: true };
  const appBin = path.join(perasHome(env), "app/bin/peras.mjs");
  for (const line of result.stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]), command = match[2];
    for (const row of rows) if (command.includes(row.dir) || command.includes(real(row.dir))) held.add(row.dir);
    if (!knownPids.has(pid) && (command.includes(appBin) || command.includes(path.join(real(perasHome(env)), "app/bin/peras.mjs")))) return { held, uncertain: true };
  }
  return { held, uncertain: false };
}

export function pruneRuntimes(env, { now = Date.now(), inspect = () => process.platform === "win32" ? { status: 1 } : spawnSync("ps", ["-axo", "pid=,command="], { encoding: "utf8", timeout: 5000, maxBuffer: 4 * 1024 * 1024 }) } = {}) {
  const versions = path.join(perasHome(env), "runtimes");
  let names;
  try { names = fs.readdirSync(versions, { withFileTypes: true }); } catch { return; }
  const rows = names.filter(d => d.isDirectory() && (d.name.startsWith("runtime-") || d.name.startsWith(".runtime-copy-"))).map(d => {
    const dir = path.join(versions, d.name);
    const stat = fs.statSync(path.join(dir, COMPLETE), { throwIfNoEntry: false }) ?? fs.statSync(dir);
    return { dir, time: stat.mtimeMs };
  }).sort((a, b) => b.time - a.time || a.dir.localeCompare(b.dir));
  const published = rows.filter(r => path.basename(r.dir).startsWith("runtime-"));
  const current = currentRuntime(env), keep = new Set(published.slice(0, 3).map(r => r.dir));
  if (current) keep.add(real(current));
  for (const row of published.filter(r => real(r.dir) !== real(current ?? "")).slice(0, 2)) keep.add(row.dir);
  const { held, uncertain } = users(env, rows, inspect);
  if (uncertain) return;
  for (const row of rows) {
    if (keep.has(row.dir) || keep.has(real(row.dir)) || held.has(row.dir) || now - row.time <= WEEK) continue;
    fs.rmSync(row.dir, { recursive: true, force: true });
  }
}
