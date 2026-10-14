import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readInstall } from "./store.mjs";
import { codexEnv } from "./codex.mjs";
import { installed as installedMenubar } from "./menubar.mjs";

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

function packageAt(root) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    if (value.name !== "peras-cli") return null;
    parseVersion(value.version);
    return value;
  } catch { return null; }
}

/** Install a published CLI, then run that CLI's setup for existing integrations.
 * The runner is injectable so tests use a private fake registry/global prefix. */
export async function updateCLI({ env, version, root, check = false, out = console.log, run = runUpdateCommand }) {
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

  const globalResponse = await run(npm, ["root", "--global"], options);
  const globalModules = globalResponse.stdout.trim();
  if (!path.isAbsolute(globalModules)) throw new Error("npm did not return an absolute global package directory; nothing was changed.");
  const globalRoot = path.join(globalModules, "peras-cli"), globalPackage = packageAt(globalRoot);
  let activeRoot = root, activeVersion = version;
  if (globalPackage && compareVersions(globalPackage.version, version) > 0) { activeRoot = globalRoot; activeVersion = globalPackage.version; }
  const newer = compareVersions(latest, activeVersion) > 0;
  if (check) {
    out(newer ? `Update available: ${activeVersion} → ${latest}. Run peras update.` : `No newer release. Installed ${activeVersion}; published ${latest}.`);
    return { updated: false, available: newer, version: activeVersion, latest };
  }

  if (newer) {
    out(`Updating the CLI: ${activeVersion} → ${latest}…`);
    // npm link can point the global CLI into a working checkout. Detach only
    // the link, so a release install cannot overwrite that checkout's files.
    let linkedTarget = null;
    if (fs.existsSync(globalRoot) && fs.lstatSync(globalRoot).isSymbolicLink()) {
      linkedTarget = fs.readlinkSync(globalRoot);
      fs.unlinkSync(globalRoot);
    }
    try {
      await run(npm, ["install", "--global", `peras-cli@${latest}`, "--ignore-scripts", "--no-audit", "--no-fund"], { ...options, timeout: 120_000 });
    } catch (error) {
      if (linkedTarget && !fs.existsSync(globalRoot)) fs.symlinkSync(linkedTarget, globalRoot, process.platform === "win32" ? "junction" : "dir");
      throw new Error(`CLI installation failed; hook and menu refresh was not attempted. ${error.message}`);
    }
    if (packageAt(globalRoot)?.version !== latest || !fs.existsSync(path.join(globalRoot, "bin", "peras.mjs"))) throw new Error("npm finished, but the new CLI could not be verified. Hook and menu refresh was not attempted.");
    activeRoot = globalRoot; activeVersion = latest;
    out(`CLI updated to ${latest}.`);
  } else out(`No newer release. Installed ${activeVersion}; published ${latest}.`);

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
  return { updated: newer, available: newer, version: activeVersion, latest };
}
