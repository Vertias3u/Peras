import fs from "node:fs";
import path from "node:path";
import { perasHome } from "./store.mjs";

const file = env => path.join(perasHome(env), "events.jsonl");
export function recordEvent(env, { kind, message, provider = env.PERAS_PROVIDER === "codex" ? "codex" : "claude", at = Date.now() }) {
  try {
    const target = file(env);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    // Two bounded local files retain recent history. One append keeps concurrent
    // hook writers from replacing each other's entries.
    if (fs.existsSync(target) && fs.statSync(target).size > 512 * 1024) {
      try { fs.renameSync(target, `${target}.previous`); } catch { /* Another writer rotated first. */ }
    }
    fs.appendFileSync(target, `${JSON.stringify({ at, provider, kind, message: String(message).slice(0, 1000) })}\n`, { mode: 0o600 });
  } catch { /* History must never prevent pause enforcement. */ }
}
export function recentEvents(env, limit = 50) {
  const rows = [];
  for (const target of [`${file(env)}.previous`, file(env)]) {
    let text;
    try { text = fs.readFileSync(target, "utf8"); } catch { continue; }
    for (const line of text.split("\n")) {
      try {
        const row = JSON.parse(line);
        if (Number.isFinite(row.at) && typeof row.message === "string" && typeof row.kind === "string" && typeof row.provider === "string") rows.push(row);
      } catch { /* Ignore an incomplete or damaged line. */ }
    }
  }
  return rows.sort((a, b) => b.at - a.at).slice(0, limit);
}
