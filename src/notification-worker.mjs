import { createActionTicket } from "./notification-actions.mjs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { createHash } from "node:crypto";
import { notificationSource } from "./notification-native.mjs";
import { perasHome } from "./store.mjs";

const exec = promisify(execFile);
// Build a universal native sender once; the same bundle owns every alert.
export async function prepareNotificationApp(root, run = exec, { bundleIdentifier = "eu.vertias.peras.desktop-notifications" } = {}) {
  const app = path.join(root, "Peras.app");
  const native = JSON.parse(await fs.readFile(new URL("./notification-native.json", import.meta.url), "utf8"));
  const binary = Buffer.from(native.binary, "base64");
  const sha = value => createHash("sha256").update(value).digest("hex");
  if (native.sourceSha256 !== sha(notificationSource) || native.binarySha256 !== sha(binary)) throw new Error("Native notification helper does not match its source. Rebuild with node scripts/build-notification-helper.mjs.");
  const sourceActionScript = fileURLToPath(new URL("./notification-actions.mjs", import.meta.url));
  const installedActionScript = path.join(path.dirname(root), "app", "src", "notification-actions.mjs");
  let actionScript = sourceActionScript;
  // Keep callbacks outside transient npx caches when the installed copy matches.
  try { if ((await fs.readFile(installedActionScript, "utf8")) === (await fs.readFile(sourceActionScript, "utf8"))) actionScript = installedActionScript; } catch { /* Global CLI or isolated test copy. */ }
  const identity = sha(native.binarySha256 + process.execPath + actionScript + bundleIdentifier);
  try {
    if ((await fs.readFile(path.join(root, ".ready"), "utf8")) === identity) {
      await fs.access(path.join(app, "Contents", "MacOS", "Peras"));
      return app;
    }
  } catch { /* Build or repair the installed sender. */ }
  const contents = path.join(app, "Contents");
  await fs.mkdir(path.join(contents, "MacOS"), { recursive: true, mode: 0o700 });
  await fs.mkdir(path.join(contents, "Resources"), { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(contents, "MacOS", "Peras"), binary, { mode: 0o755 });
  const icon = JSON.parse(await fs.readFile(new URL("./notification-icon.json", import.meta.url), "utf8"));
  await fs.writeFile(path.join(contents, "Resources", "Peras.icns"), Buffer.from(icon.icns, "base64"));
  const plist = path.join(contents, "Info.plist");
  const values = { CFBundleIdentifier: bundleIdentifier, CFBundleName: "Peras", CFBundleDisplayName: "Peras", CFBundleExecutable: "Peras", CFBundlePackageType: "APPL", CFBundleIconFile: "Peras.icns", CFBundleVersion: "5", CFBundleShortVersionString: "1.0", LSMinimumSystemVersion: "10.14", NSPrincipalClass: "NSApplication", PerasNodeExecutable: process.execPath, PerasActionScript: actionScript };
  const xmlEscape = value => value.replace(/[<>&"']/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]);
  await fs.writeFile(plist, `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>${Object.entries(values).map(([key, value]) => `<key>${key}</key><string>${xmlEscape(value)}</string>`).join("")}<key>LSUIElement</key><true/></dict></plist>`);
  await run("/usr/bin/codesign", ["--force", "--sign", "-", "--identifier", bundleIdentifier, app]);
  await run("/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister", ["-f", app]);
  await fs.writeFile(path.join(root, ".ready"), identity);
  return app;
}

export async function retireLegacyNotificationApps(home, run = exec) {
  // LaunchServices may keep resolving this bundle ID to the first app it saw.
  // Unregister and retain old generated senders outside the .app namespace.
  for (const revision of ["notifications-v1", "notifications-v2", "notifications-v3"]) {
    const app = path.join(home, revision, "Peras.app");
    try { await fs.access(app); } catch { continue; }
    await run("/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister", ["-u", app]);
    await fs.rename(app, `${app}.retired`);
  }
}

export async function deliverNotification(title, body, env = process.env, platform = process.platform, options = {}) {
  const root = path.join(perasHome(env), "notifications-native-v1");
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const lock = path.join(root, ".lock");
  let locked = false;
  for (let i = 0; i < 150; i++) {
    try { await fs.mkdir(lock); locked = true; break; }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      const stat = await fs.stat(lock).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > 120_000) await fs.rmdir(lock).catch(() => {});
      await delay(200);
    }
  }
  if (!locked) throw new Error("Peras notification sender is busy. Try again after the permission dialog closes.");
  try {
    if (platform === "darwin") {
      await retireLegacyNotificationApps(perasHome(env));
      const app = await prepareNotificationApp(root);
      const request = path.join(root, "request.json");
      await fs.writeFile(request, JSON.stringify({ title, body, category: options.category || "status", ticket: createActionTicket(root, env, options) }), { mode: 0o600 });
      await fs.unlink(`${request}.result`).catch(error => { if (error.code !== "ENOENT") throw error; });
      try {
        await exec("/usr/bin/open", ["-n", "-g", "-W", app, "--args", request], { timeout: 60_000 });
      } catch (error) {
        if (error.killed) throw new Error("Timed out waiting for Peras notification permission. Allow Peras in macOS Notifications, then retry.");
        throw error;
      }
      const result = JSON.parse(await fs.readFile(`${request}.result`, "utf8"));
      if (result.error) throw new Error(result.error);
      if (!result.scheduled) throw new Error("Peras notification was not scheduled.");
    } else if (platform === "linux") {
      const icon = JSON.parse(await fs.readFile(new URL("./notification-icon.json", import.meta.url), "utf8"));
      const png = path.join(root, "pear.png");
      await fs.writeFile(png, Buffer.from(icon.png, "base64"));
      await exec("notify-send", ["--app-name=Peras", "--icon", png, "--", title, body], { timeout: 10_000 });
    }
  } finally {
    await Promise.all(["request.json", "request.json.result"].map(name => fs.unlink(path.join(root, name)).catch(() => {})));
    await fs.rmdir(lock).catch(() => {});
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  deliverNotification(process.argv[2] || "Peras 🍐", process.argv[3] || "", process.env, process.platform, JSON.parse(process.argv[4] || "{}")).catch(() => { process.exitCode = 1; });
}
