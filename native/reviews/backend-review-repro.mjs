import os from "node:os";
import {fileURLToPath} from "node:url";
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
const root = process.env.PERAS_REVIEW_SOURCE_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const imp = name => import(`file://${root}/src/${name}.mjs`);
const {sandbox,NOW,inHours} = await import(`file://${root}/test/helpers.mjs`);
const {install} = await imp('settings');
const {snapshot} = await imp('providers');
const {nativePayloads} = await imp('native-bridge');
const {providerPayload,tokenSigner,parseCommand} = await imp('native-protocol');
const {runOperation} = await imp('native-operations');
const {readState,pauseNow,recordReading,writeRules} = await imp('store');
const {setPacing,saveProfile,readPlanning} = await imp('planning');
const {preferences} = await imp('preferences');
const {codexEnv} = await imp('codex');
const {writeBudgetRules} = await imp('allowances');
const HOOK=`"${process.execPath}" "${root}/bin/peras.mjs"`;
function box() {
 const b=sandbox();
 b.env.CODEX_HOME=path.join(b.root,'codex');
 const bin=path.join(b.root,'bin');fs.mkdirSync(bin);
 const guard=path.join(bin,'codex');
 fs.writeFileSync(guard,'#!/bin/sh\necho "FAKE CODEX GUARD CALLED" >&2\nexit 73\n',{mode:0o755});
 b.env.PATH=bin+path.delimiter+path.dirname(process.execPath)+':/usr/bin:/bin';
 return b;
}
const tree = dir => {
 const out={};
 if(!fs.existsSync(dir))return out;
 for(const e of fs.readdirSync(dir,{withFileTypes:true})) {
  const p=path.join(dir,e.name);
  if(e.isDirectory())for(const [k,v] of Object.entries(tree(p)))out[e.name+'/'+k]=v;
  else out[e.name]=crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
 }
 return out;
};
const changes=(a,b)=>[...new Set([...Object.keys(a),...Object.keys(b)])].filter(k=>a[k]!==b[k]);
const result={reviewedRoot:root,now:NOW,cases:{}};
// A newer indefinite pause lands at the verification/commit cut-point.
{
 const {env}=box();install({env,command:HOOK,version:'0.3.2'});
 const real=tokenSigner();
 const p=providerPayload(await snapshot(env,NOW,{cwd:null}),{now:NOW,sign:real.sign});
 const offer=p.actions.find(a=>a.op==='pause'&&a.params.duration==='1h');
 const c=parseCommand(JSON.stringify({type:'command',protocol:1,id:'timed-click',op:offer.op,provider:'claude',params:offer.params,actionToken:offer.actionToken}));
 let inserted;
 const injected={...real,verify(token,body,now){const ok=real.verify(token,body,now);if(ok)inserted=pauseNow(env,{now:now+1,until:null});return ok;}};
 const operation=await runOperation(env,c,{now:NOW,signer:injected});
 result.cases.pauseRace={offerEligible:offer.eligible,operation,newerPause:inserted,savedPause:readState(env,NOW+2).manualPause};
}
// A purely read-only snapshot initializes the pacing anchor that hooks enforce.
{
 const {env}=box();install({env,command:HOOK,version:'0.3.2'});
 recordReading(env,{seven_day:{usedPct:40,resetsAt:inHours(72),seenAt:NOW}});
 setPacing(env,{days:[0,1,2,3,4,5,6],reserve:20,action:'pause'});
 const before=tree(env.PERAS_HOME);
 await nativePayloads(env,NOW,{signer:tokenSigner(),reader:async()=>{throw new Error('fake reader')}});
 result.cases.snapshotPacingWrite={changedFiles:changes(before,tree(env.PERAS_HOME)),createdAnchor:readPlanning(env).anchor};
}
// A successful fake Codex response writes windows/accounting/cache during a snapshot build.
{
 const {env}=box();const scoped=codexEnv(env);
 recordReading(scoped,{seven_day:{usedPct:20,resetsAt:inHours(72),seenAt:NOW-60000}});
 const before=tree(env.PERAS_HOME);
 await nativePayloads(env,NOW,{signer:tokenSigner(),reader:async()=>({rateLimits:{limitId:'codex',primary:{usedPercent:30,windowDurationMins:300,resetsAt:inHours(2)},secondary:{usedPercent:34,windowDurationMins:10080,resetsAt:inHours(72)}}})});
 result.cases.snapshotCodexWrite={changedFiles:changes(before,tree(env.PERAS_HOME))};
}
// Public settings mutation succeeds without any corresponding offer or token.
{
 const {env}=box();const signer=tokenSigner();
 const offers=await nativePayloads(env,NOW,{signer,reader:async()=>{throw new Error('fake reader')}});
 const c=parseCommand(JSON.stringify({type:'command',protocol:1,id:'setting',op:'preference.set',params:{name:'mascots',value:false},actionToken:'definitely-not-an-offered-token'}));
 result.cases.unofferedSettings={offers:offers.flatMap(p=>p.actions.map(a=>a.op)),operation:await runOperation(env,c,{now:NOW,signer}),mascots:preferences(env).mascots};
}
// Names accepted by the ordinary profile API can carry complete private paths onto stdout.
{
 const {env}=box();const privateName='/Users/review-alice/private-notes';
 saveProfile(env,privateName);
 const payloads=await nativePayloads(env,NOW,{signer:tokenSigner(),reader:async()=>{throw new Error('fake reader')}});
 result.cases.profilePrivacy={privateName,profiles:payloads[0].profiles,containsFullPrivatePath:JSON.stringify(payloads).includes(privateName)};
}
// An inherited operation property is not a declared operation and must fail as ProtocolError.
{
 const {env}=box();
 const command={type:'command',protocol:1,id:'inherited',op:'constructor',params:{},actionToken:'t'};
 let direct;try{parseCommand(JSON.stringify(command));direct='accepted';}catch(e){direct={name:e.name,code:e.code??null,message:e.message};}
 const p=spawnSync(process.execPath,[path.join(root,'bin/peras.mjs'),'menubar','bridge','--protocol','1'],{env,input:JSON.stringify(command)+'\n',encoding:'utf8',timeout:5000});
 result.cases.inheritedOperation={direct,exit:p.status,signal:p.signal,stderrHasSourcePath:p.stderr.includes(root),stderr:p.stderr.slice(0,1800),stdout:p.stdout.slice(0,1000)};
}
// Starting a bridge on a stale installation may auto-update hooks and print ahead of hello.
{
 const {env}=box();install({env,command:HOOK,version:'0.3.1'});
 const before=tree(env.PERAS_HOME);
 const p=spawnSync(process.execPath,[path.join(root,'bin/peras.mjs'),'menubar','bridge','--protocol','1'],{env,input:'',encoding:'utf8',timeout:5000});
 const lines=p.stdout.trim().split('\n');let firstJson=true;try{JSON.parse(lines[0]);}catch{firstJson=false;}
 result.cases.staleHookStartup={exit:p.status,firstLine:lines[0],firstLineIsJson:firstJson,changedFiles:changes(before,tree(env.PERAS_HOME)),stderr:p.stderr.slice(0,300)};
}
fs.writeFileSync(path.join(process.env.PERAS_REVIEW_OUTPUT || fs.mkdtempSync(path.join(os.tmpdir(),'peras-backend-review-')), 'backend-review-results.json'),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result,null,2));
