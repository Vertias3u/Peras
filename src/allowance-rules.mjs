import path from "node:path";
import { createHash } from "node:crypto";
const budgetId = r => `${r.kind || "budget"}|${r.period}|${r.action}|${r.project || ""}`;
const inside = (dir, root) => dir === root || dir.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
export function allowanceHits(meters, cwd, resumed, now) {
  return meters.filter(m => m.resetsAt * 1000 > now && m.spent >= m.at && (!m.project || (cwd && inside(path.resolve(cwd), m.project)))).map(m => {
    const hash = createHash("sha256").update(budgetId(m)).digest("hex").slice(0, 16);
    return { ...m, kind: m.kind === "pacing" ? "pacing" : m.project ? "project" : "daily", window: "seven_day", usedPct: m.spent, key: `allowance:${hash}:${m.at}@${m.resetsAt}` };
  }).filter(hit => hit.action === "warn" || !resumed.some(r => r.key === hit.key && (r.until == null || r.until > now)));
}
