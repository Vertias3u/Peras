import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readInstall, perasHome, installFile } from "./store.mjs";
import { codexEnv, hooksPath } from "./codex.mjs";
import { installed as installedMenubar } from "./menubar.mjs";
import { APP_DOWNLOAD_URL, appInstalled, appPath, appVersion, bundleVersion, quitApp } from "./native-app.mjs";

import { settingsPath } from "./settings.mjs";
import { launchFile } from "./node-runtime.mjs";
import { updateBackup, globalLaunchers } from "./update-backup.mjs";

const exec = promisify(execFile);
export async function runUpdateCommand(command, args, options) {
  return exec(command, args, { ...options, encoding: "utf8", maxBuffer: 4 * 1024 * 1024, shell: command.endsWith(".cmd") });
}

function parseVersion(value) {
  const match = typeof value === "string" && value.match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) throw new Error(`Invalid release version: ${String(value).slice(0, 80)}`);
  const numbers = match.slice(1, 4).map(Number);
  if (!numbers.every(Number.isSafeInteger)) throw new Error("Release version numbers are too large.");
  const pre = match[4]?.split(".") || [];
  if (pre.some(part => !part || (/^\d+$/.test(part) && part.length > 1 && part[0] === "0"))) throw new Error("Invalid prerelease version.");
  return { numbers, pre };
}
export function compareVersions(a, b) {
  const left = parseVersion(a), right = parseVersion(b);
  for (let i = 0; i < 3; i++) if (left.numbers[i] !== right.numbers[i]) return left.numbers[i] > right.numbers[i] ? 1 : -1;
  if (!left.pre.length || !right.pre.length) return left.pre.length === right.pre.length ? 0 : left.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i++) {
    if (left.pre[i] === undefined || right.pre[i] === undefined) return left.pre[i] === undefined ? -1 : 1;
    if (left.pre[i] === right.pre[i]) continue;
    const ln = /^\d+$/.test(left.pre[i]), rn = /^\d+$/.test(right.pre[i]);
    if (ln && rn) return BigInt(left.pre[i]) > BigInt(right.pre[i]) ? 1 : -1;
    if (ln !== rn) return ln ? -1 : 1;
    return left.pre[i] > right.pre[i] ? 1 : -1;
  }
  return 0;
}

const isVersion = (value) => { try { parseVersion(value); return true; } catch { return false; } };
export const lineOf = (value) => parseVersion(value).numbers.slice(0, 2).join(".");

function packageAt(root) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    if (value.name !== "peras-cli") return null;
    parseVersion(value.version);
    return value;
  } catch { return null; }
}

/** Install a published CLI, then run that CLI's setup for existing integrations.
 * The Peras app only runs a CLI of its own 0.x line, so with the app installed the update stays on
 * that line; `app` (a downloaded Peras.app) moves CLI and app to the newer line together.
 * The runner is injectable so tests use a private fake registry/global prefix. */
export async function updateCLI({ env, version, root, check = false, app: source = null, out = console.log, run = runUpdateCommand }) {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const options = { env, cwd: env.HOME || root, timeout: 30_000 };
  const claude = readInstall(env), codex = readInstall(codexEnv(env)), menu = installedMenubar(env);
  out("Checking npm for a Peras update…");
  let latest;
  try {
    const response = await run(npm, ["view", "peras-cli@latest", "version", "--json", "--fetch-retries=0", "--fetch-timeout=15000"], options);
    latest = JSON.parse(response.stdout.trim());
    parseVersion(latest);
  } catch (error) { throw new Error(`Could not check for updates. Nothing was changed. ${error.message}`); }

  const incoming = source && bundleVersion(path.resolve(source));
  if (source && !(incoming && isVersion(incoming))) throw new Error(`${source} is not a Peras app. Nothing was changed.`);
  if (incoming && lineOf(incoming) !== lineOf(latest)) throw new Error(`That Peras.app is for Peras ${incoming}, and the newest Peras is ${latest}. Download the newest app from your purchase at ${APP_DOWNLOAD_URL}. Nothing was changed.`);
  const installedApp = !incoming && appInstalled(env) ? appVersion(env) : null;
  if (!incoming && appInstalled(env) && !isVersion(installedApp)) throw new Error("The installed app version could not be read. Reinstall a matching app before updating. Nothing was changed.");
  let target = latest, held = null;
  if (installedApp && isVersion(installedApp) && lineOf(installedApp) !== lineOf(latest)) {
    // The newest release on the app's own line: `npm view` answers one version as a string, several as a list.
    const [major, minor] = parseVersion(installedApp).numbers;
    let found;
    try { found = JSON.parse((await run(npm, ["view", `peras-cli@~${major}.${minor}.0`, "version", "--json", "--fetch-retries=0", "--fetch-timeout=15000"], options)).stdout.trim() || "null"); }
    catch (error) { throw new Error(`Could not check for updates. Nothing was changed. ${error.message}`); }
    target = [found].flat().filter(isVersion).sort(compareVersions).at(-1) ?? null;
    if (compareVersions(latest, installedApp) > 0) held = latest;
  }
  const holdNote = held && `Peras ${held} is out. It needs the Peras ${lineOf(held)} app, and yours is ${installedApp}, so Peras stays on ${lineOf(installedApp)} until then. The new app comes with your purchase: download it from ${APP_DOWNLOAD_URL} (or build it yourself), then run peras update --app ~/Downloads/Peras.app.`;

  const globalResponse = await run(npm, ["root", "--global"], options);
  const globalModules = globalResponse.stdout.trim();
  if (!path.isAbsolute(globalModules)) throw new Error("npm did not return an absolute global package directory; nothing was changed.");
  const globalRoot = path.join(globalModules, "peras-cli"), globalPackage = packageAt(globalRoot);
  let activeRoot = root, activeVersion = version;
  if (globalPackage && compareVersions(globalPackage.version, version) > 0) { activeRoot = globalRoot; activeVersion = globalPackage.version; }
  const previous = activeVersion;
  const newer = target !== null && compareVersions(target, activeVersion) > 0;
  // Resolve npm first: a different prefix must not silently supply a newer, incompatible runtime.
  const required = incoming || installedApp;
  if (required && ((!incoming && lineOf(activeVersion) !== lineOf(required)) || (!newer && lineOf(activeVersion) !== lineOf(required)))) {
    throw new Error(`The selected npm prefix resolves to Peras ${activeVersion}, but the app is ${required}. Select the matching npm prefix or download its matching app before updating. Nothing was changed.`);
  }
  if (check) {
    out(newer ? `Update available: ${activeVersion} → ${target}. Run peras update.` : `No newer release${held ? ` on ${lineOf(installedApp)}` : ""}. Installed ${activeVersion}; published ${held ? target ?? "none" : latest}.`);
    if (holdNote) out(holdNote);
    return { updated: false, available: newer, version: activeVersion, latest, held };
  }

  // Capture before npm or setup can change anything, even when invoked from npx or another prefix.
  const home = perasHome(env);
  const priorApp = source ? fs.statSync(appPath(env), { throwIfNoEntry: false }) : null;
  const backup = updateBackup([
    globalRoot, ...globalLaunchers(globalModules), path.join(home, "app"),
    installFile(env), installFile(codexEnv(env)), settingsPath(env), `${settingsPath(env)}.peras-backup`,
    hooksPath(env), `${hooksPath(env)}.peras-backup`, path.join(home, "menubar.json"), menu, launchFile(env), ...(source ? [appPath(env), `${appPath(env)}.previous`] : []),
  ], home, { runtime: path.join(home, "app") });
  try {
  if (newer) {
    out(`Updating the CLI: ${activeVersion} → ${target}…`);
    const linked = fs.lstatSync(globalRoot, { throwIfNoEntry: false })?.isSymbolicLink();
    // npm must never write through or detach a checkout while downloading. Install a linked
    // package into a private prefix on the same filesystem, then promote the verified package.
    const stage = linked ? fs.mkdtempSync(path.join(globalModules, ".peras-stage-")) : null;
    const candidate = stage ? path.join(stage, process.platform === "win32" ? "node_modules" : "lib/node_modules", "peras-cli") : globalRoot;
    try {
      try {
        await run(npm, ["install", "--global", `peras-cli@${target}`, ...(stage ? ["--prefix", stage] : []), "--ignore-scripts", "--no-audit", "--no-fund"], { ...options, timeout: 120_000 });
      } catch (error) { throw new Error(`CLI installation failed; hook and menu refresh was not attempted. ${error.message}`); }
      if (packageAt(candidate)?.version !== target || !fs.existsSync(path.join(candidate, "bin", "peras.mjs"))) throw new Error("npm finished, but the new CLI could not be verified. Hook and menu refresh was not attempted.");
      if (stage) {
        fs.unlinkSync(globalRoot); // Only the link, after npm and verification succeeded.
        fs.renameSync(candidate, globalRoot);
        // npm staged its launchers under the private prefix. Publish launchers for the
        // selected real prefix too, including links that used to point straight into a checkout.
        for (const file of globalLaunchers(globalModules)) {
          fs.mkdirSync(path.dirname(file), { recursive: true });
          const temp = `${file}.${crypto.randomUUID()}.new`;
          try {
            if (process.platform === "win32") fs.copyFileSync(path.join(stage, path.basename(file)), temp);
            else fs.symlinkSync(path.relative(path.dirname(file), path.join(globalRoot, "bin", "peras.mjs")), temp);
            fs.renameSync(temp, file);
          } finally { fs.rmSync(temp, { force: true }); }
        }
      }
    } finally {
      if (stage) { try { fs.rmSync(stage, { recursive: true, force: true }); } catch { /* isolated leftovers are harmless */ } }
    }
    activeRoot = globalRoot; activeVersion = target;
    out(`CLI updated to ${target}.`);
  } else out(`No newer release${held ? ` on ${lineOf(installedApp)}` : ""}. Installed ${activeVersion}; published ${held ? target ?? "none" : latest}.`);

  // Also repair stale hook copies after somebody updates the CLI with npm.
  const stale = [claude, codex].some(record => record && (!record.version || compareVersions(record.version, activeVersion) < 0));
  if (newer || stale) {
    const bin = path.join(activeRoot, "bin", "peras.mjs");
    const refresh = async (args, label) => {
      out(`Refreshing ${label}…`);
      try { await run(process.execPath, [bin, ...args], { ...options, timeout: 30_000 }); }
      catch (error) { throw new Error(`CLI is ${activeVersion}, but ${label} refresh failed. Run peras ${args.join(" ")} to retry. ${error.message}`); }
    };
    if (claude) await refresh(["setup"], "Claude hooks and runtime");
    if (codex) await refresh(["codex", "setup"], "Codex hooks and runtime");
    if (menu) await refresh(["menubar", "install", path.dirname(menu)], "menu bar");
    if (claude || codex || menu) out("Installed integrations updated. Your rules, pauses, history, and preferences are preserved.");
    if (claude || codex) out("Restart open agent sessions; review hook changes in Codex /hooks if prompted.");
  }
  if (source) {
    out("Installing the Peras app…");
    try { await run(process.execPath, [path.join(activeRoot, "bin", "peras.mjs"), "menubar", "install", "--native", "--app", path.resolve(source)], { ...options, timeout: 600_000 }); }
    catch (error) { throw new Error(`The Peras app was not installed. ${error.message}`); }
  }
  } catch (error) {
    try {
      // A new renderer's plugin may have a different name. Remove only our generated replacement.
      const current = installedMenubar(env);
      if (current && current !== menu && /^peras(?:-[a-f0-9]{16})?\.1m\.sh$/.test(path.basename(current)) && fs.readFileSync(current, "utf8").includes("Written by `peras menubar install`")) fs.rmSync(current);
      // The outer runner can time out before the installer handles its own failure.
      // Keep any newly copied app aside too, then restore the old app and CLI together.
      const currentApp = source ? fs.statSync(appPath(env), { throwIfNoEntry: false }) : null;
      if (currentApp && (!priorApp || currentApp.ino !== priorApp.ino || currentApp.dev !== priorApp.dev)) {
        quitApp(appPath(env), { force: true });
        fs.renameSync(appPath(env), path.join(path.dirname(appPath(env)), `Peras-pending-${crypto.randomUUID()}.app`));
      }
      backup.restore();
    } catch (undo) {
      throw new Error(`Update failed, and restoring the local backup failed too. Backup kept at ${backup.dir}. ${undo.message}. Original failure: ${error.message}`);
    }
    backup.discard();
    throw new Error(`Update failed; the previous CLI and integrations are restored (Peras ${previous} is back). ${error.message}`);
  }
  // Cleanup cannot turn a completed upgrade into a rollback.
  try { backup.discard(); } catch { out(`Update finished; an old backup remains at ${backup.dir}.`); }

  if (holdNote) out(holdNote);
  return { updated: newer, available: newer, version: activeVersion, latest, held };
}
