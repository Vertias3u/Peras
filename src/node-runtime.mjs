// Which node the hooks and the native app run Peras with. Finder does not start
// apps with the shell's PATH, so the app is handed absolute paths, recorded here.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { perasHome, writeJsonAtomic } from "./store.mjs";

export const NODE_MIN = 18;
export const NODE_FIX = "Node.js is required; install the current LTS from nodejs.org/en/download, then reopen Peras.";

// fnm puts a per-shell link on PATH that is deleted when that shell closes.
const TRANSIENT = /[\\/]fnm_multishells[\\/]/;
// A version manager's own folder for one version: gone after the next upgrade.
const VERSIONED = /[\\/](Cellar|\.nvm[\\/]versions|node-versions|\.volta[\\/]tools[\\/]image|installs[\\/]nodejs|mise[\\/]installs)[\\/]/;

const exe = process.platform === "win32" ? "node.exe" : "node";
const real = (file) => { try { return fs.realpathSync(file); } catch { return null; } };

/** Where a GUI-started app finds node when no recorded path works: the usual install places and version-manager shims. */
export const fallbackNodes = (env) => {
  const home = env.HOME || os.homedir();
  return ["/opt/homebrew/bin/node", "/usr/local/bin/node", path.join(home, ".volta", "bin", "node"), path.join(home, ".asdf", "shims", "node"), path.join(home, ".local", "share", "mise", "shims", "node")];
};

/**
 * The path to record for this same node binary. A PATH entry or a usual install
 * place that resolves to it stays put across upgrades; its real path, under a
 * version manager, moves on the next one. A path that will move is used only
 * when nothing steadier points at this binary.
 */
export function nodePath(env, execPath = process.execPath) {
  const target = real(execPath);
  const onPath = String(env.PATH ?? "").split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, exe));
  const same = [...onPath, ...fallbackNodes(env).slice(0, 2)].filter((file) => !TRANSIENT.test(file) && target && real(file) === target);
  return same.find((file) => !VERSIONED.test(file)) ?? same[0] ?? execPath;
}

/** `v22.3.0` → 22.3.0, or null for anything else. */
export function parseNodeVersion(text) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(text ?? "").trim());
  return match ? match.slice(1, 4).join(".") : null;
}
export const nodeSupported = (version) => Number(String(version ?? "").split(".")[0]) >= NODE_MIN;

export const launchFile = (env) => path.join(perasHome(env), "native", "launch.json");

// The settings a GUI launch would otherwise lose: where Peras, Claude and Codex
// keep their files, and the PATH that finds `codex` for its readings.
const CARRIED = ["PERAS_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "PATH"];

/**
 * What the native app needs to start `peras menubar bridge` without a shell:
 * absolute node and CLI paths, the fallbacks to try if node moved, and the one
 * line to show if none works. Only `menubar install --native` writes it; it
 * changes nothing in Claude Code or Codex.
 */
export function writeLaunchRecord(env, { cli, runtimeVersion, execPath = process.execPath, nodeVersion = process.versions.node }) {
  const record = {
    schema: 1,
    runtimeVersion,
    node: nodePath(env, execPath),
    nodeVersion,
    nodeMin: NODE_MIN,
    cli,
    fallbackNodes: fallbackNodes(env),
    nodeFix: NODE_FIX,
    environment: Object.fromEntries(CARRIED.filter((name) => env[name]).map((name) => [name, env[name]])),
  };
  fs.mkdirSync(path.dirname(launchFile(env)), { recursive: true, mode: 0o700 });
  writeJsonAtomic(launchFile(env), record);
  return record;
}
