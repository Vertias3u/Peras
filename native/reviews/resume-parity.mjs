import os from "node:os";
import {fileURLToPath} from "node:url";
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
const base=process.env.PERAS_REVIEW_SOURCE_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const current=await import(`file://${base}/src/store.mjs`);
const {sandbox,NOW,inHours}=await import(`file://${base}/test/helpers.mjs`);
let source=execFileSync('git',['show','HEAD:src/store.mjs'],{cwd:path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'),encoding:'utf8'});
source=source.replace(/from "(\.[^"]+)"/g,(_,s)=>`from ${JSON.stringify(new URL(s,`file://${base}/src/store.mjs`).href)}`);
const previous=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const results=[];
for(const scenario of ['manual','weekly_and_grant','observed_projects_and_prompt','corrupt_window_with_manual','invalid_duration']) {
 const b=sandbox();b.env.PATH='/usr/bin:/bin';
 const left={...b.env,PERAS_HOME:path.join(b.root,'previous')},right={...b.env,PERAS_HOME:path.join(b.root,'current')};
 const project=path.join(b.root,'project');fs.mkdirSync(project);
 for(const env of [left,right]) {
  current.writeRules(env,[{kind:'window',window:'seven_day',at:90,action:'pause'},{kind:'prompt',window:'seven_day',at:3,action:'ask'},...(scenario==='observed_projects_and_prompt'?[{kind:'window',window:'seven_day',at:80,action:'pause',project}]:[])]);
  current.recordReading(env,{seven_day:{usedPct:96,resetsAt:inHours(72),seenAt:NOW}});
  const state=current.readState(env,NOW);
  if(['manual','corrupt_window_with_manual'].includes(scenario))state.manualPause={since:NOW-1000,until:null};
  if(scenario==='observed_projects_and_prompt') {
   state.sessions={a:{cwd:project,t:NOW,startedAt:NOW-1000},b:{cwd:b.root,t:NOW,startedAt:NOW-1000}};
   state.prompts={a:{id:'p1',t:NOW-1000,seven_day:90},b:{id:'p2',t:NOW-1000,seven_day:88}};
  }
  current.writeState(env,state);
  if(scenario==='weekly_and_grant')current.resume(env,{now:NOW-1000,forMs:1800000});
  if(scenario==='corrupt_window_with_manual')fs.writeFileSync(current.windowFile(env),'{bad');
 }
 const opts={now:NOW,cwd:null,forMs:scenario==='invalid_duration'?-1000:3600000};
 const run=(store,env)=>{try{return{result:store.resume(env,opts),state:store.readState(env,NOW)}}catch(e){return{error:e.message,state:store.readState(env,NOW)}}};
 const normalize=v=>JSON.parse(JSON.stringify(v).replaceAll(left.PERAS_HOME,'STATE').replaceAll(right.PERAS_HOME,'STATE'));
 const old=normalize(run(previous,left)),next=normalize(run(current,right));
 assert.deepEqual(next,old,scenario);results.push({scenario,equal:true});
}
fs.writeFileSync(path.join(process.env.PERAS_REVIEW_OUTPUT || fs.mkdtempSync(path.join(os.tmpdir(),'peras-backend-review-')), 'resume-parity-results.json'),JSON.stringify({baseline:'HEAD:src/store.mjs',results},null,2)+'\n');
console.log(JSON.stringify({cases:results.length,results},null,2));
