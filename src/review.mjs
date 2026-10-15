import { readUsage } from "./usage.mjs";
import { recentEvents } from "./events.mjs";
const WEEK = 7 * 86400_000;
export function weeklyReview(usage, events = [], provider = "claude", now = Date.now()) {
  const windows = [...(usage.weeks || []), usage.windows?.seven_day].filter(Boolean);
  return windows.filter(w => Number.isFinite(w.resetsAt)).map(w => {
    const end = w.resetsAt * 1000, start = end - WEEK;
    const pts = (Array.isArray(w.pts) ? w.pts : []).filter(p => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]) && p[0] >= start && p[0] <= Math.min(end, now) && p[1] >= 0 && p[1] <= 100).sort((a,b) => a[0]-b[0]);
    if (!pts.length) return null;
    const first = pts[0], last = pts.at(-1), current = end > now;
    const gaps = pts.slice(1).filter((p,i) => p[0] - pts[i][0] > 6 * 3600_000).length;
    const nearReset = !current && end - last[0] <= 300_000;
    const interventions = events.filter(e => e.provider === provider && e.at >= start && e.at < end && ["warning", "pause", "approval"].includes(e.kind));
    return { resetsAt: w.resetsAt, pts, firstAt: first[0], lastAt: last[0], peak: Math.max(...pts.map(p => p[1])), remaining: Math.floor(100-last[1]), current, nearReset, gaps, lateStart: first[0] - start > 6 * 3600_000, interventions: Object.fromEntries(["warning", "pause", "approval"].map(kind => [kind, interventions.filter(e => e.kind === kind).length])) };
  }).filter(Boolean).sort((a,b)=>b.resetsAt-a.resetsAt);
}
export function reviewFor(env, now) { return weeklyReview(readUsage(env), recentEvents(env, 5000), env.PERAS_PROVIDER === "codex" ? "codex" : "claude", now); }
const date = ms => new Date(ms).toLocaleString("en-GB", { day:"numeric", month:"short", hour:"2-digit", minute:"2-digit", hourCycle:"h23" });
export function reviewText(rows) {
  if (!rows.length) return "No weekly readings yet. The review will fill as Peras observes usage.";
  return rows.map(r => `${r.current ? "This week" : "Week"} · reset ${date(r.resetsAt*1000)}\n  Peak ${r.peak}% · ${r.remaining}% remaining ${r.nearReset ? "≈at reset" : "at last reading"}\n  Observed ${date(r.firstAt)} → ${date(r.lastAt)} · ${r.gaps} gaps over 6h${r.lateStart ? " · tracking began after the week started" : ""}\n  Retained events: ${r.interventions.warning} warnings · ${r.interventions.pause} pauses · ${r.interventions.approval} approval requests`).join("\n\n") + "\n\nUnobserved time is a gap, not zero usage. Remaining allowance at the last reading may have been used before reset. Event history is bounded; counts cover retained events only.";
}
const escape = value => String(value).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]);
export function reviewHTML(rows, label) {
  if (!rows.length) return `<h3>${escape(label)}</h3><p>No weekly readings yet.</p>`;
  return `<h3>${escape(label)}</h3>` + rows.map(r => {
    const start = r.resetsAt*1000-WEEK;
    const groups = [[]];
    r.pts.forEach((p,i) => { if (i && p[0] - r.pts[i-1][0] > 6*3600_000) groups.push([]); groups.at(-1).push(p); });
    const coords = p => `${(40+(p[0]-start)/WEEK*320).toFixed(2)},${(130-p[1]*1.1).toFixed(2)}`;
    const chart = groups.map(g => g.length === 1 ? `<circle cx="${coords(g[0]).split(',')[0]}" cy="${coords(g[0]).split(',')[1]}" r="3" fill="var(--signal)"/>` : `<polyline points="${g.map(coords).join(' ')}" fill="none" stroke="var(--signal)" stroke-width="2.5"/>`).join('');
    return `<article class="review-week"><h4>${r.current ? "This week" : "Week"} · resets ${escape(date(r.resetsAt*1000))}</h4><svg viewBox="0 0 400 155" role="img" aria-label="${escape(label)} weekly usage; ${r.gaps} recording gaps"><path d="M40 20H360M40 75H360M40 130H360" stroke="var(--line)"/><g fill="var(--muted)" font-size="11"><text x="0" y="24">100%</text><text x="6" y="79">50%</text><text x="12" y="134">0%</text><text x="40" y="150">Week starts</text><text x="330" y="150">Reset</text></g>${chart}</svg><p><strong>Peak ${r.peak}% · ${r.remaining}% remaining ${r.nearReset ? "≈at reset" : "at last reading"}</strong><br>Observed ${escape(date(r.firstAt))} → ${escape(date(r.lastAt))}; ${r.gaps} gaps over 6h${r.lateStart ? "; tracking began after the week started" : ""}.<br>Retained events: ${r.interventions.warning} warnings · ${r.interventions.pause} pauses · ${r.interventions.approval} approval requests.</p></article>`;
  }).join('');
}

export function compareWeeks(rows){
 const completed=rows.filter(r=>!r.current).sort((a,b)=>b.resetsAt-a.resetsAt);
 if(completed.length<2)return null;
 const [latest,previous]=completed;
 const total=r=>Object.values(r.interventions).reduce((a,b)=>a+b,0);
 return {latest,previous,peakDelta:Math.round((latest.peak-previous.peak)*10)/10,remainingDelta:latest.remaining-previous.remaining,interventionDelta:total(latest)-total(previous),partial:latest.gaps>0||previous.gaps>0||latest.lateStart||previous.lateStart||!latest.nearReset||!previous.nearReset};
}
export function comparisonText(rows){const c=compareWeeks(rows);if(!c)return 'Weekly comparison needs two completed weeks of observed usage.';const delta=n=>`${n>0?'+':''}${n}`;return `Completed weeks ending ${date(c.previous.resetsAt*1000)} → ${date(c.latest.resetsAt*1000)}\n  Peak: ${c.previous.peak}% → ${c.latest.peak}% (${delta(c.peakDelta)} points)\n  Last-observed remaining: ${c.previous.remaining}% → ${c.latest.remaining}% (${delta(c.remainingDelta)} points)\n  Retained interventions: ${delta(c.interventionDelta)} versus the prior week\n  ${c.partial?'Partial tracking or missing end-of-week readings limit this comparison.':'Both final readings were within five minutes of reset; usage is still sampled.'}\n  Different workloads and missing observations can explain changes. This comparison does not prove that limits caused a reduction.`}
export function comparisonHTML(rows,label){const c=compareWeeks(rows);if(!c)return `<h3>${escape(label)}</h3><p>${escape(comparisonText(rows))}</p>`;return `<h3>${escape(label)}</h3><div class="table-wrap"><table><thead><tr><th>Completed week ending</th><th>Peak usage</th><th>Last-known remaining</th><th>Retained interventions</th></tr></thead><tbody>${[c.previous,c.latest].map(r=>`<tr><td>${escape(date(r.resetsAt*1000))}</td><td>${r.peak}%</td><td>${r.remaining}%</td><td>${Object.values(r.interventions).reduce((a,b)=>a+b,0)}</td></tr>`).join('')}</tbody></table></div><p>Peak changed ${c.peakDelta>0?'+':''}${c.peakDelta} points; last-known remaining changed ${c.remainingDelta>0?'+':''}${c.remainingDelta} points. ${c.partial?'Tracking is partial; compare with care.':'Both final readings were near reset.'} Different workloads and missing observations can explain changes; this does not prove limits caused a reduction.</p>`}
