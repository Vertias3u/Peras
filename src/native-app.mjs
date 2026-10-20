// The Peras app under PERAS_HOME/native, and moving the menu from SwiftBar to it.
// The app is copied as it was built and never re-signed. A download Gatekeeper accepts loses its
// quarantine on the way in: macOS runs a quarantined app from a temporary mirror (App Translocation),
// where it can't open at login and Peras can't find it to quit.
// SwiftBar's plugin is retired only after this launch's bridge has said hello,
// and it goes to a rollback folder SwiftBar doesn't scan, never to the bin.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { perasHome, readJson, writeJsonAtomic } from "./store.mjs";
import * as menubar from "./menubar.mjs";

const nativeDir = (env) => path.join(perasHome(env), "native");
export const appPath = (env) => path.join(nativeDir(env), "Peras.app");
export const rollbackDir = (env) => path.join(nativeDir(env), "rollback");
const bridgeFile = (env) => path.join(nativeDir(env), "bridge.json");

export const appInstalled = (env) => fs.existsSync(path.join(appPath(env), "Contents", "Info.plist"));

// The newest Peras app for this CLI's 0.x line. Raise it whenever a new app goes to Polar (RELEASING.md 1b):
// the menu then offers it to anyone whose app is older. Buyers get every app from their Polar purchase.
export const APP_RELEASE = "0.4.0";
export const APP_DOWNLOAD_URL = "https://peras.vertias.eu/download";
/** The Peras version an app bundle was built for (its PerasRuntimeVersion), or null. */
export function bundleVersion(app) {
  try { return /<key>PerasRuntimeVersion<\/key>\s*<string>([^<]+)<\/string>/.exec(fs.readFileSync(path.join(app, "Contents", "Info.plist"), "utf8"))?.[1] ?? null; } catch { return null; }
}
export const appVersion = (env) => bundleVersion(appPath(env));

/**
 * Which menu is live, read from what's on disk rather than a stored flag: 0.3
 * keeps any field it doesn't know, so a flag would outlive a rollback to 0.3
 * and a SwiftBar reinstall. A plugin file in place means SwiftBar.
 */
export function liveMenu(env) {
  if (menubar.installed(env)) return "swiftbar";
  return appInstalled(env) ? "native" : null;
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; } };

/** The bridge says it started: the app's launch reached Node and this runtime. */
export function announceBridge(env, { bridgeInstance, runtimeVersion, now = Date.now() }) {
  writeJsonAtomic(bridgeFile(env), { pid: process.pid, bridgeInstance, runtimeVersion, startedAtMs: now });
}
/** Takes the record away on a clean exit, unless a newer bridge has written its own. */
export function retireBridge(env, bridgeInstance) {
  try { if (readJson(bridgeFile(env))?.bridgeInstance === bridgeInstance) fs.rmSync(bridgeFile(env), { force: true }); } catch { /* the next bridge overwrites it */ }
}

/**
 * Waits for a bridge started since `sinceMs`, alive, running this version. The
 * monitor lease can't tell: SwiftBar's stream holds it until its plugin goes.
 */
export async function handshake(env, { sinceMs, runtimeVersion, timeoutMs = 20_000, clock = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  let last = "the app never started its bridge";
  for (const end = clock() + timeoutMs; ;) {
    let record = null;
    try { record = readJson(bridgeFile(env)); } catch { /* not written yet */ }
    if (record && record.startedAtMs >= sinceMs) {
      if (record.runtimeVersion !== runtimeVersion) last = `the app's bridge runs Peras ${record.runtimeVersion}, this is ${runtimeVersion}`;
      else if (!Number.isInteger(record.pid) || !alive(record.pid)) last = "the app's bridge started and stopped";
      else return { ok: true, record };
    }
    if (clock() >= end) return { ok: false, reason: last };
    await sleep(250);
  }
}

/** codesign's verdict gates the install; Gatekeeper's is only reported: a local build isn't notarized. */
export function verifyApp(app) {
  if (process.platform !== "darwin") return { ok: false, reason: "the Peras app needs macOS" };
  const signed = spawnSync("codesign", ["--verify", "--deep", "--strict", app], { encoding: "utf8", timeout: 60_000 });
  if (signed.status !== 0) return { ok: false, reason: `its signature doesn't check out (${(signed.stderr || "codesign failed").trim().split("\n")[0]})` };
  const assessed = spawnSync("spctl", ["--assess", "--type", "execute", app], { encoding: "utf8", timeout: 60_000 });
  const described = spawnSync("codesign", ["-dv", app], { encoding: "utf8", timeout: 60_000 });
  return { ok: true, gatekeeper: assessed.status === 0 ? "accepted" : "not notarized", adhoc: /^Signature=adhoc$/m.test(described.stderr ?? "") };
}

/** A downloaded app carries the quarantine flag: its first open waits on the person, so the handshake waits longer. */
export function quarantined(app) {
  if (process.platform !== "darwin") return false;
  return spawnSync("xattr", ["-p", "com.apple.quarantine", app], { timeout: 5000 }).status === 0;
}

// ditto keeps the signature, extended attributes and quarantine exactly as they came, unless `clean`:
// then only the files (the signature and Apple's stapled ticket are files too). Only both flags
// together drop the bundle's quarantine; a copy never opened can still lose it with xattr.
function copyBundle(from, to, { clean = false } = {}) {
  if (process.platform === "darwin") {
    const copied = spawnSync("ditto", [...(clean ? ["--noextattr", "--noqtn"] : []), from, to], { encoding: "utf8", timeout: 120_000 });
    if (copied.status !== 0) throw new Error(`Could not copy the app (${(copied.stderr || "ditto failed").trim()}).`);
    if (clean && quarantined(to)) spawnSync("xattr", ["-d", "com.apple.quarantine", to], { timeout: 5000 });
  } else fs.cpSync(from, to, { recursive: true, verbatimSymlinks: true });
}

const valid = (bundle) => fs.existsSync(path.join(bundle, "Contents", "Info.plist"));
const OPS = { rename: fs.renameSync, remove: (target) => fs.rmSync(target, { recursive: true, force: true }), copy: copyBundle };
const LEFTOVER = /^Peras\.app\.(?:new|trash-.+)$/;
let trashed = 0;
// A bundle is only ever deleted under a name nothing trusts: a crash mid-delete leaves trash, never half an app.
function discard(bundle, ops) {
  const to = path.join(path.dirname(bundle), `Peras.app.trash-${process.pid}-${++trashed}`);
  ops.rename(bundle, to);
  try { ops.remove(to); } catch { /* the next recoverInstall sweeps it */ }
}

/**
 * Puts the folder back together after an install that stopped part-way (a kill, a full
 * disk, a crash). Peras.app.previous is the last copy that checked in, since it only goes
 * once the new one has said hello: with no Peras.app it moves back into place. With both,
 * the next install or hello decides. Half-copied and half-deleted leftovers go.
 */
export function recoverInstall(env, ops = OPS) {
  const app = appPath(env), previous = `${app}.previous`;
  let recovered = false;
  if (!valid(app) && valid(previous)) {
    if (fs.existsSync(app)) discard(app, ops);
    ops.rename(previous, app);
    recovered = true;
  }
  let names = [];
  try { names = fs.readdirSync(nativeDir(env)); } catch { /* nothing installed yet */ }
  for (const name of names.filter((n) => LEFTOVER.test(n))) ops.remove(path.join(nativeDir(env), name));
  return { recovered };
}

function swap(env, ops) {
  const app = appPath(env), previous = `${app}.previous`;
  return {
    /** Puts back the last copy that checked in; with none, takes the new one out. */
    restore() {
      if (fs.existsSync(app)) discard(app, ops);
      if (valid(previous)) ops.rename(previous, app);
    },
    /** The new copy checked in: the one it replaced goes. */
    confirm() { if (fs.existsSync(previous)) discard(previous, ops); },
  };
}

/** An install that never checked in (its open was interrupted): its `restore` puts the earlier copy back. */
export function pendingInstall(env, ops = OPS) {
  return valid(`${appPath(env)}.previous`) ? { replaced: true, ...swap(env, ops) } : null;
}
/** The installed app checked in. */
export const confirmInstall = (env, ops = OPS) => swap(env, ops).confirm();

/**
 * Copies a built app into place beside the one it replaces, which stays as
 * Peras.app.previous until the new one has said hello. Returns `restore`.
 * Every step is a rename, so an interruption anywhere leaves either app whole
 * and `recoverInstall` (which runs first) finishes the job.
 */
export function installApp(env, source, { verify = verifyApp, downloaded = quarantined, ops: given = {} } = {}) {
  const ops = { ...OPS, ...given };
  const from = path.resolve(source);
  if (!from.endsWith(".app") || !fs.existsSync(path.join(from, "Contents", "Info.plist"))) throw new Error(`${source} is not an app bundle (no Contents/Info.plist).`);
  const checked = verify(from);
  if (!checked.ok) throw new Error(`The app was not installed: ${checked.reason}.`);
  // macOS calls a downloaded app with a local-only signature damaged and offers no way to allow it.
  if (checked.adhoc && downloaded(from)) throw new Error("The app was not installed: this build was downloaded but is signed for local testing only, so macOS won't open it. Use the Developer ID-signed download.");
  const app = appPath(env), fresh = `${app}.new`, previous = `${app}.previous`;
  fs.mkdirSync(nativeDir(env), { recursive: true, mode: 0o700 });
  recoverInstall(env, ops);
  // Gatekeeper has accepted this download: the installed copy runs where it is, not translocated.
  const clean = checked.gatekeeper === "accepted" && downloaded(from);
  try { ops.copy(from, fresh, { clean }); } catch (error) { ops.remove(fresh); throw error; }
  // An earlier install that never checked in keeps the copy before it: that one is known to work.
  const kept = valid(previous), hadOne = kept || valid(app);
  if (fs.existsSync(app)) {
    if (kept || !valid(app)) discard(app, ops);
    else ops.rename(app, previous);
  }
  try { ops.rename(fresh, app); } catch (error) {
    recoverInstall(env, ops);
    throw new Error(`Could not put the app in place (${error.message}).${hadOne ? " The app you had before is back." : ""}`);
  }
  return { gatekeeper: checked.gatekeeper, replaced: hadOne, ...swap(env, ops) };
}

/**
 * Where macOS runs a quarantined copy of `app` from: a read-only mirror under AppTranslocation,
 * which `mount` lists as "<app> on <mirror> (nullfs, …)". An app installed by 0.4.0 runs there.
 */
export function translocatedPaths(app, mounts = () => spawnSync("mount", [], { encoding: "utf8", timeout: 5000 }).stdout ?? "") {
  return mounts().split("\n").flatMap((line) => {
    if (!line.startsWith(`${app} on `)) return [];
    const mirror = /^(\/\S*\/AppTranslocation\/[^/\s]+) \(nullfs/.exec(line.slice(app.length + 4))?.[1];
    return mirror ? [path.join(mirror, "d", path.basename(app))] : [];
  });
}

// Only processes started from this exact bundle (or macOS's mirror of it): never a preview build or another copy of Peras.
function appPids(app) {
  // A process reports its resolved path: a PERAS_HOME behind a symlink still has to match.
  try { app = fs.realpathSync(app); } catch { /* not installed: nothing to match */ }
  return [app, ...translocatedPaths(app)].flatMap((bundle) => {
    // pgrep reads a regular expression: the path's dots and any brackets in a home folder are taken literally.
    const pattern = `^${`${bundle}/Contents/MacOS/`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`;
    const found = spawnSync("pgrep", ["-f", pattern], { encoding: "utf8", timeout: 5000 });
    return found.status === 0 ? found.stdout.split("\n").map(Number).filter((pid) => pid > 0 && pid !== process.pid) : [];
  });
}
export const appRunning = (app) => process.platform === "darwin" && appPids(app).length > 0;

/** Opens the installed app; a copy already running from the same place is brought forward instead. */
export function launchApp(app) {
  if (process.platform !== "darwin") throw new Error("The Peras app needs macOS.");
  const opened = spawnSync("open", appRunning(app) ? [app] : ["-n", app], { encoding: "utf8", timeout: 10_000 });
  if (opened.status !== 0) throw new Error((opened.stderr || "the app did not open").trim());
}
/** Asks the app to quit; `force` ends one that didn't. */
export function quitApp(app, { force = false } = {}) {
  for (const pid of process.platform === "darwin" ? appPids(app) : []) { try { process.kill(pid, force ? "SIGKILL" : "SIGTERM"); } catch { /* already gone */ } }
}

const PLUGIN_NAME = /^peras(?:-(?:live|stream|[a-f0-9]{16}))?\.1m\.sh$/;
/**
 * Moves Peras's own SwiftBar plugin to the rollback folder. Anything else in the
 * record's place (a renamed file, someone else's script) stays where it is.
 */
export function retirePlugin(env) {
  const file = menubar.installed(env);
  if (!file) return { moved: null };
  let head = "";
  try { head = fs.readFileSync(file, "utf8").slice(0, 400); } catch { /* unreadable: not ours to move */ }
  if (!PLUGIN_NAME.test(path.basename(file)) || !head.includes("Written by `peras menubar install`")) {
    return { moved: null, kept: file };
  }
  fs.mkdirSync(rollbackDir(env), { recursive: true, mode: 0o700 });
  const to = path.join(rollbackDir(env), path.basename(file));
  try { fs.renameSync(file, to); } catch (error) {
    if (error.code !== "EXDEV") throw error;
    fs.copyFileSync(file, to); fs.chmodSync(to, 0o755); fs.rmSync(file);
  }
  return { moved: to, from: file };
}
