// Rebuild the shipped universal native sender on macOS with Command Line Tools.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { notificationSource } from "../src/notification-native.mjs";
const root = await fs.mkdtemp(path.join(os.tmpdir(), "peras-native-build-"));
const source = path.join(root, "Peras.m"), binary = path.join(root, "Peras");
await fs.writeFile(source, notificationSource);
execFileSync("/usr/bin/clang", ["-fobjc-arc", "-arch", "arm64", "-arch", "x86_64", "-mmacosx-version-min=10.14", "-framework", "Cocoa", "-framework", "UserNotifications", source, "-o", binary], { stdio: "inherit" });
const bytes = await fs.readFile(binary);
const sha = value => createHash("sha256").update(value).digest("hex");
await fs.writeFile(new URL("../src/notification-native.json", import.meta.url), JSON.stringify({ sourceSha256: sha(notificationSource), binarySha256: sha(bytes), binary: bytes.toString("base64") }) + "\n");
console.log(`Built universal Peras notification helper (${bytes.length} bytes).`);
