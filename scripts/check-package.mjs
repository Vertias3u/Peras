// Checks what `npm publish` would ship, before it ships. Run: node scripts/check-package.mjs
// Fails on: a file outside bin/src/README/LICENSE (a SwiftBar plugin written into
// src/, say), a home-folder path inside a shipped file, or a relative import that
// points at a file the package leaves out.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const [pack] = JSON.parse(execFileSync(npm, ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
const files = new Set(pack.files.map((f) => f.path));
const problems = [];

const allowed = [/^package\.json$/, /^README\.md$/, /^LICENSE$/, /^bin\/[\w.-]+\.mjs$/, /^src\/[\w.-]+\.(?:mjs|json|html)$/];
for (const file of files) {
  if (!allowed.some((re) => re.test(file))) problems.push(`not meant to ship: ${file}`);
}

const home = /\/(?:Users|home)\/[\w.-]+\//;
for (const file of files) {
  const text = fs.readFileSync(path.join(root, file), "utf8");
  const hit = text.match(home);
  if (hit) problems.push(`home-folder path in ${file}: ${hit[0]}`);
  if (!file.endsWith(".mjs")) continue;
  for (const [, spec] of text.matchAll(/["'](\.{1,2}\/[\w./-]+\.(?:mjs|json))["']/g)) {
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), spec));
    if (!files.has(target)) problems.push(`${file} needs ${target}, which is not in the package`);
  }
}

if (problems.length) {
  console.error(`The package is not ready (${problems.length}):\n${problems.map((p) => `  ✗ ${p}`).join("\n")}`);
  process.exit(1);
}
console.log(`Package OK: ${pack.name}@${pack.version}, ${files.size} files, ${(pack.size / 1024).toFixed(1)} kB.`);
