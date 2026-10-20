// A protection receipt is proof that a hook denied a real tool call, which a crossed
// line, a pause request or a passed self-test is not. Recording one is best effort:
// it runs after the deny is decided and can never change it.
import path from "node:path";
import { dirKey, perasHome, readJson, writeJsonAtomic } from "./store.mjs";

const file = (env) => path.join(perasHome(env), "receipts", `${env.PERAS_PROVIDER === "codex" ? "codex" : "claude"}-${dirKey(env)}.json`);

// What the snapshot needs to name the stop again; the folder stays local, the wire gets its name only.
const FIELDS = ["kind", "action", "window", "at", "usedPct", "rise", "project", "period", "during", "resetsAt", "until", "key"];

export function recordDenial(env, hit, now) {
  try {
    let before = null;
    try { before = readReceipt(env); } catch { /* a damaged receipt starts over */ }
    const kept = Object.fromEntries(FIELDS.filter((k) => hit?.[k] !== undefined).map((k) => [k, hit[k]]));
    writeJsonAtomic(file(env), { firstAt: before?.firstAt ?? now, at: now, count: (before?.count ?? 0) + 1, hit: kept });
  } catch { /* A receipt must never stand between a deny and the tool. */ }
}

/** The last genuine denial for this provider and account, or null. */
export function readReceipt(env) {
  let r;
  try { r = readJson(file(env)); } catch { return null; }
  const ok = r && Number.isFinite(r.firstAt) && Number.isFinite(r.at) && Number.isInteger(r.count) && r.count > 0
    && typeof r.hit?.kind === "string" && typeof r.hit.action === "string" && typeof r.hit.key === "string";
  return ok ? r : null;
}
