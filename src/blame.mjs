// Which session used the week. Claude Code reports each session's API-equivalent
// cost, but the window's % is one number for the account, so the % a window rose
// is shared out by what each session spent while it rose. An estimate: claude.ai
// and the desktop app spend the same window and report nothing here.

const MAX_SESSIONS = 200;
const round1 = (n) => Math.round(n * 10) / 10;

/** A reading of one session's cumulative cost, folded into the week's tally. */
export function updateBlame(blame, { session, cost, pct, resetsAt, now, dir = null }) {
  let b = blame && Math.abs(blame.resetsAt - resetsAt) < 3600
    ? { ...blame, sessions: { ...blame.sessions } }
    : { resetsAt, startPct: pct, sessions: {} };
  const s = b.sessions[session];
  if (!s) b.sessions[session] = { base: cost, cost, spent: 0, dir, seen: now };
  else {
    const next = { ...s, seen: now, dir: s.dir ?? dir };
    // Cost going down is a new process (a --resume): its count restarts.
    if (cost < s.cost) Object.assign(next, { spent: s.spent + s.cost - s.base, base: cost, cost });
    else next.cost = cost;
    b.sessions[session] = next;
  }
  const ids = Object.keys(b.sessions);
  if (ids.length > MAX_SESSIONS) {
    const keep = ids.sort((x, y) => b.sessions[y].seen - b.sessions[x].seen).slice(0, MAX_SESSIONS);
    b.sessions = Object.fromEntries(keep.map((id) => [id, b.sessions[id]]));
  }
  return b;
}

export const spendOf = (s) => s.spent + s.cost - s.base;

/** Each session's share of the window's rise since the tally began, largest first. */
export function blameShares(blame, pct) {
  if (!blame) return [];
  const rise = Math.max(0, pct - blame.startPct);
  const rows = Object.entries(blame.sessions)
    .map(([session, s]) => ({ session, dir: s.dir ?? null, spend: spendOf(s) }))
    .filter((r) => r.spend > 0);
  const total = rows.reduce((sum, r) => sum + r.spend, 0);
  if (!rise || !total) return [];
  return rows.map((r) => ({ ...r, pct: round1((rise * r.spend) / total) })).sort((a, b) => b.spend - a.spend);
}
