// A process holds its runtime for its entire lifetime, including future lazy imports.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function resolveRuntimeEntry(bin) {
  const resolved = fs.realpathSync(bin);
  // Windows uses a regular bootstrap rather than a privileged file symlink.
  const bootstrap = /^await import\(("[^\n]+")\);\s*$/.exec(fs.readFileSync(resolved, "utf8"));
  return bootstrap ? fs.realpathSync(fileURLToPath(JSON.parse(bootstrap[1]))) : resolved;
}

export function holdRuntime(entryURL) {
  try {
    const root = path.dirname(path.dirname(fileURLToPath(entryURL)));
    if (!fs.existsSync(path.join(root, ".complete.json"))) return;
    const leases = path.join(root, ".in-use");
    fs.mkdirSync(leases, { recursive: true, mode: 0o700 });
    const lease = path.join(leases, `${process.pid}-${crypto.randomUUID()}.json`);
    fs.writeFileSync(lease, JSON.stringify({ pid: process.pid }), { mode: 0o600 });
    process.once("exit", () => { try { fs.unlinkSync(lease); } catch { /* stale leases are reaped by pruning */ } });
  } catch { /* An unavailable lease must never cost a hook's answer; process inspection protects unknown users. */ }
}
