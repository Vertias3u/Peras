import fs from "node:fs";
import {test} from "node:test";
import assert from "node:assert/strict";
import {startSettingsServer} from "../src/settings-server.mjs";
import {sandbox,NOW} from "./helpers.mjs";
import {readRules} from "../src/store.mjs";
import {readBudgetRules} from "../src/allowances.mjs";
import {codexEnv} from "../src/codex.mjs";

test("local editor saves rules, budgets and preferences, preserving independent provider settings",async t=>{
 const {env,root}=sandbox();const app=await startSettingsServer({env,now:()=>NOW,getSnapshots:async()=>[]});t.after(()=>app.close());
 const headers={Authorization:`Bearer ${app.token}`,Origin:app.origin,"Content-Type":"application/json"};
 const state=()=>fetch(app.origin+"/api/state",{headers}).then(r=>r.json());
 const save=async body=>{const current=await state();return fetch(app.origin+"/api/save",{method:"POST",headers,body:JSON.stringify({revision:current.revision,...body})})};
 assert.equal((await fetch(app.origin+"/")).status,200);
 assert.equal((await fetch(app.origin+"/api/state")).status,401);
 assert.equal((await save({provider:"claude",op:"rule",rule:{kind:"prompt",window:"seven_day",at:3,action:"pause",during:"01:00-08:00",project:root}})).status,200);
 assert.ok(readRules(env).some(r=>r.kind==="prompt"&&r.project===fs.realpathSync(root)));
 assert.ok(!readRules(codexEnv(env)).some(r=>r.kind==="prompt"));
 assert.equal((await save({provider:"codex",op:"budget",rule:{period:"daily",at:10,action:"pause"}})).status,200);
 assert.equal(readBudgetRules(codexEnv(env))[0].at,10);assert.equal(readBudgetRules(env).length,0);
 assert.equal((await save({op:"preference",name:"unused",value:"on"})).status,200);
 assert.equal((await state()).preferences.unused,true);
 const rule=readRules(env).find(r=>r.kind==="prompt");
 assert.equal((await save({provider:"claude",op:"delete-rule",rule})).status,200);
 assert.ok(!readRules(env).some(r=>r.kind==="prompt"));
});
test("editor rejects external origins, stale revisions, invalid rules and unknown providers",async t=>{
 const {env}=sandbox();const app=await startSettingsServer({env,now:()=>NOW,getSnapshots:async()=>[]});t.after(()=>app.close());
 const headers={Authorization:`Bearer ${app.token}`,Origin:app.origin,"Content-Type":"application/json"};
 const current=await fetch(app.origin+"/api/state",{headers}).then(r=>r.json());
 const post=(body,extra={})=>fetch(app.origin+"/api/save",{method:"POST",headers:{...headers,...extra},body:JSON.stringify({revision:current.revision,...body})});
 const change={provider:"claude",op:"budget",rule:{period:"daily",at:10,action:"pause"}};
 assert.equal((await post(change,{Origin:"https://example.com"})).status,403);
 assert.equal((await post(change,{Origin:"null"})).status,403);
 assert.equal((await post({...change,provider:"other"})).status,400);
 assert.equal((await post({...change,rule:{period:"daily",at:0,action:"pause"}})).status,400);
 assert.equal((await post({provider:"claude",op:"rule",rule:{kind:"window",window:"seven_day",at:101,action:"pause"}})).status,400);
 assert.equal((await post({provider:"claude",op:"rule",rule:{kind:"window",window:"seven_day",at:80,action:"pause",project:"relative-folder"}})).status,400);
 const http=await import('node:http');
 const wrongHost=await new Promise((resolve,reject)=>{const request=http.request(app.origin+"/api/state",{headers:{...headers,Host:"example.com"}},response=>{response.resume();resolve(response.statusCode)});request.on('error',reject);request.end()});
 assert.equal(wrongHost,403);
 assert.equal((await fetch(app.origin+"/api/state",{headers:{Authorization:"Bearer "+"é".repeat(64)}})).status,401);
 assert.equal((await fetch(app.origin+"/api/save",{method:"POST",headers,body:"x".repeat(32769)})).status,413);
 assert.equal((await post(change)).status,200);
 assert.equal((await post(change)).status,409);
});

test("settings CLI starts and reuses its private editor process without opening a real browser",async t=>{
 const {main}=await import('../src/cli.mjs');
 const path=await import('node:path');
 const {env,home}=sandbox();const opened=[];const lines=[];
 let pid;
 t.after(()=>{if(pid){try{process.kill(pid,'SIGTERM')}catch{}}});
 const options={env,now:NOW,out:s=>lines.push(s),openSettingsURL:async url=>opened.push(url)};
 assert.equal(await main(['settings'],options),0);
 const session=JSON.parse(fs.readFileSync(path.join(home,'settings-session.json'),'utf8'));pid=session.pid;
 assert.match(opened[0],/^http:\/\/127\.0\.0\.1:\d+\/#/);
 assert.equal(await main(['settings'],options),0);
 assert.equal(opened[0],opened[1]);
 assert.equal(JSON.parse(fs.readFileSync(path.join(home,'settings-session.json'),'utf8')).pid,pid);
});

test("private editor expires after inactivity",{timeout:5000},async()=>{
 const {env}=sandbox();const app=await startSettingsServer({env,idleMs:25,getSnapshots:async()=>[]});
 await new Promise(resolve=>app.server.once('close',resolve));
 assert.equal(app.server.listening,false);
});

test('editor configures pacing, switches profiles and grants/revokes scoped extras',async t=>{
 const {recordReading}=await import('../src/store.mjs');const {readPlanning}=await import('../src/planning.mjs');
 const {env}=sandbox();recordReading(env,{seven_day:{usedPct:40,seenAt:NOW,resetsAt:(NOW+72*3600000)/1000}});
 const app=await startSettingsServer({env,now:()=>NOW,getSnapshots:async()=>[]});t.after(()=>app.close());
 const headers={Authorization:`Bearer ${app.token}`,Origin:app.origin,'Content-Type':'application/json'};
 const state=()=>fetch(app.origin+'/api/state',{headers}).then(r=>r.json());
 const save=async body=>{const s=await state();const res=await fetch(app.origin+'/api/save',{method:'POST',headers,body:JSON.stringify({revision:s.revision,provider:'claude',...body})});assert.equal(res.status,200,await res.text())};
 await save({op:'pacing',pacing:{reserve:20,days:[1,2,3,4,5],action:'pause'}});
 await save({op:'profile-save',name:'Normal day'});await save({op:'pacing',pacing:null});await save({op:'profile-save',name:'Heavy work'});
 await save({op:'profile-use',name:'Normal day'});assert.equal(readPlanning(env).pacing.reserve,20);
 await save({op:'extra',grant:{period:'daily',points:3,duration:'1h'}});const grant=readPlanning(env).extras[0];assert.equal(grant.points,3);
 await save({op:'extra-revoke',id:grant.id});assert.equal(readPlanning(env).extras.length,0);
 const s=await state();assert.deepEqual(s.claude.profiles.names,['Heavy work','Normal day']);
});
