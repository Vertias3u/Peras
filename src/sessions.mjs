import path from "node:path";
import { evaluate, duringActive, realDir } from "./rules.mjs";
import { budgetText } from "./allowances.mjs";
const inside=(dir,root)=>dir===root||dir.startsWith(root.endsWith(path.sep)?root:root+path.sep);
export function sessionOverview(snapshots,now){
 return snapshots.flatMap(s=>Object.entries(s.state?.sessions||{}).filter(([,v])=>typeof v.cwd==="string"&&Number.isFinite(v.t)&&v.t<=now&&now-v.t<7*86400_000).map(([id,v])=>{
  const cwd=realDir(v.cwd),verdict=evaluate({...s.ctx,cwd,prompt:s.state.prompts?.[id]||null});
  const rules=verdict.rules.filter(r=>!r.during||duringActive(r.during,now)).map(r=>`${r.kind==="window"?"Usage":r.kind==="pace"?"Pace":"Prompt"} ${r.window==="seven_day"?"weekly":"5-hour"} ${r.at}${r.kind==="prompt"?" points":"%"} → ${r.action}${r.during?` (${r.during})`:""}`);
  const budgets=(s.ctx.allowances||[]).filter(m=>!m.project||inside(cwd,m.project)).map(budgetText);
  return {provider:s.provider,id,cwd,lastSeen:v.t,event:v.event||"hook",lastToolAt:v.lastToolAt||null,recent:now-v.t<=15*60_000,action:verdict.action,rules:[...rules,...budgets]};
 })).sort((a,b)=>b.lastSeen-a.lastSeen);
}
const escape=value=>String(value).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]);
export function sessionsText(rows,now){return rows.length?rows.map(r=>`${r.provider==='codex'?'Codex':'Claude'} · ${r.id.slice(0,12)} · ${r.cwd}\n  ${Math.floor((now-r.lastSeen)/60000)}m since ${r.event} · ${r.action}${r.recent?' · recently observed':''}\n  ${r.rules.join('\n  ')||'No active rules.'}`).join('\n\n')+'\n\nObserved hook activity, not a list of running processes. Older sessions may have ended.':'No sessions observed yet. Start a new agent turn so its hooks can register the folder.'}
export function sessionsHTML(rows){return `<p>Hook activity observed by Peras, not proof a process is still running. Older sessions may have ended. No prompts or tool commands are stored here.</p>`+(rows.length?`<div class="table-wrap"><table><thead><tr><th>Agent / session</th><th>Folder / last seen</th><th>Applicable rules</th></tr></thead><tbody>${rows.map(r=>`<tr><td>${r.provider==='codex'?'Codex':'Claude'} · ${escape(r.id.slice(0,12))}<br>${escape(r.action)}${r.recent?' · recently observed':''}</td><td>${escape(r.cwd)}<br>${escape(new Date(r.lastSeen).toLocaleString('en-GB',{hourCycle:'h23'}))} · ${escape(r.event)}</td><td>${r.rules.map(escape).join('<br>')||'No active rules.'}</td></tr>`).join('')}</tbody></table></div>`:'<p>No observed sessions yet.</p>')}
