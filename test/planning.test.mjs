import {test} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import {sandbox,NOW,inHours} from './helpers.mjs';
import {recordReading,context,pauseNow,readState,writeRules} from '../src/store.mjs';
import {setBudget,allowanceMeters,localDay,touchAllowanceSession} from '../src/allowances.mjs';
import {setPacing,workdaysLeft,readPlanning,saveProfile,useProfile,profileSummary,deleteProfile,grantExtra,activeExtras,revokeExtra} from '../src/planning.mjs';
import {evaluate} from '../src/rules.mjs';
import {runHook} from '../src/hook.mjs';
import {snapshot} from '../src/providers.mjs';
import {sessionOverview,sessionsText} from '../src/sessions.mjs';
import {compareWeeks,comparisonText} from '../src/review.mjs';
const read=(env,pct,now=NOW,reset=inHours(72))=>recordReading(env,{seven_day:{usedPct:pct,seenAt:now,resetsAt:reset}});

test('workday pacing fixes today’s share, preserves reserve and restarts at local midnight',()=>{
 const {env}=sandbox();writeRules(env,[]);read(env,40);setPacing(env,{days:[0,1,2,3,4,5,6],reserve:20,action:'pause'});
 const days=workdaysLeft(NOW,inHours(72),[0,1,2,3,4,5,6]);
 const first=allowanceMeters(env,NOW,context(env,{now:NOW}).window).find(m=>m.kind==='pacing');
 assert.equal(first.at,Math.floor(40/days*100)/100);
 read(env,45,NOW+60_000);const second=allowanceMeters(env,NOW+60_000,context(env,{now:NOW+60_000}).window).find(m=>m.kind==='pacing');
 assert.equal(second.at,first.at,'spending does not move today’s ceiling');assert.equal(second.spent,5);
 read(env,60,NOW+120_000);assert.equal(evaluate(context(env,{now:NOW+120_000})).action,'pause');
 const next=localDay(NOW).end;read(env,60,next);const tomorrow=allowanceMeters(env,next,context(env,{now:next}).window).find(m=>m.kind==='pacing');
 assert.equal(tomorrow.spent,0);assert.equal(tomorrow.since,next);
});
test('pacing skips stale initial readings, respects non-working days and validates inputs',()=>{
 const {env}=sandbox();read(env,40);const today=new Date(NOW).getDay();setPacing(env,{days:[(today+1)%7],reserve:20,action:'pause'});
 assert.equal(allowanceMeters(env,NOW+300001,context(env,{now:NOW+300001}).window).length,0);
 assert.equal(evaluate(context(env,{now:NOW})).action,'pause');
 for(const value of [{days:[],reserve:20,action:'pause'},{days:[1],reserve:100,action:'pause'},{days:[9],reserve:20,action:'pause'}])assert.throws(()=>setPacing(env,value));
 setPacing(env,null);assert.equal(readPlanning(env).pacing,null);
});
test('profiles preserve usage, manual pauses and project totals while switching',()=>{
 const {env,root}=sandbox();const project=path.join(root,'project');fs.mkdirSync(project);writeRules(env,[]);
 setBudget(env,{period:'daily',at:10,action:'pause'},NOW);setBudget(env,{period:'weekly',project,at:5,action:'pause'},NOW);
 read(env,20);touchAllowanceSession(env,'s',project,NOW);read(env,24,NOW+1000);saveProfile(env,'Normal day');
 setBudget(env,{period:'daily',at:20,action:'pause'},NOW);saveProfile(env,'Heavy work');pauseNow(env,{now:NOW+1000});
 useProfile(env,'Normal day',NOW+2000);assert.equal(allowanceMeters(env,NOW+2000,context(env,{now:NOW+2000}).window).find(m=>m.period==='daily').spent,4);
 assert.equal(readState(env,NOW+2000).manualPause.since,NOW+1000);assert.equal(profileSummary(env).active,'Normal day');assert.equal(profileSummary(env).modified,false);
 setBudget(env,{period:'daily',at:11,action:'pause'},NOW);assert.equal(profileSummary(env).modified,true);
 useProfile(env,'Heavy work',NOW+2000);useProfile(env,'Normal day',NOW+2000);
 assert.equal(allowanceMeters(env,NOW+2000,context(env,{now:NOW+2000}).window).find(m=>m.project).spent,4);
 deleteProfile(env,'Heavy work');assert.deepEqual(profileSummary(env).names,['Normal day']);assert.throws(()=>saveProfile(env,'__proto__'));
});
test('extra points expire precisely, preserve base allowance and cannot bypass unrelated stops',()=>{
 const {env}=sandbox();writeRules(env,[]);setBudget(env,{period:'daily',at:5,action:'pause'},NOW);read(env,20);read(env,25,NOW+1000);
 assert.equal(evaluate(context(env,{now:NOW+1000})).action,'pause');
 const weekly=context(env,{now:NOW+1000}).window.seven_day;
 const grant=grantExtra(env,{period:'daily',points:3,until:NOW+3600_000},NOW+1000,weekly);
 assert.equal(evaluate(context(env,{now:NOW+1000})).action,'none');assert.equal(allowanceMeters(env,NOW+1000,{seven_day:weekly})[0].baseAt,5);
 pauseNow(env,{now:NOW+2000});assert.equal(evaluate(context(env,{now:NOW+2000})).action,'pause');
 assert.equal(allowanceMeters(env,NOW+3600_000,{seven_day:weekly})[0].at,5);assert.equal(activeExtras(env,NOW+3600_000,weekly).length,0);
 revokeExtra(env,grant.id,NOW+2000);assert.throws(()=>grantExtra(env,{period:'daily',points:-1,until:NOW+3600_000},NOW+2000,weekly));
 assert.throws(()=>grantExtra(env,{period:'daily',points:2,until:localDay(NOW).end+1},NOW+2000,weekly));
});
test('session overview shows observed activity and effective folder limits without claiming running processes',async()=>{
 const {env,root}=sandbox();writeRules(env,[{kind:'window',window:'seven_day',at:70,action:'pause',project:fs.realpathSync(root)}]);read(env,75);
 runHook({env,now:NOW,input:{hook_event_name:'PreToolUse',session_id:'session-abc',cwd:root}});
 const rows=sessionOverview([await snapshot(env,NOW)],NOW);assert.equal(rows[0].action,'pause');assert.equal(rows[0].event,'PreToolUse');assert.equal(rows[0].lastToolAt,NOW);assert.match(rows[0].rules.join(' '),/70%/);assert.match(sessionsText(rows,NOW),/not a list of running processes/);
});
test('week comparison uses completed weeks and states observation limits',()=>{
 const row=(at,peak,remaining)=>({resetsAt:at,current:false,peak,remaining,gaps:1,lateStart:true,nearReset:false,interventions:{warning:1,pause:2,approval:0}});
 const rows=[row(inHours(-1),60,40),row(inHours(-169),80,20),{...row(inHours(72),90,10),current:true}];
 const comparison=compareWeeks(rows);assert.equal(comparison.peakDelta,-20);assert.equal(comparison.remainingDelta,20);assert.equal(comparison.partial,true);assert.match(comparisonText(rows),/does not prove/);assert.equal(compareWeeks(rows.slice(0,1)),null);
});

test('re-saving pacing or switching a profile back cannot renew today’s original share',()=>{
 const {env}=sandbox();read(env,40);const pacing={days:[0,1,2,3,4,5,6],reserve:20,action:'pause'};setPacing(env,pacing);saveProfile(env,'Paced');
 const first=allowanceMeters(env,NOW,context(env,{now:NOW}).window).find(m=>m.kind==='pacing').at;
 read(env,45,NOW+1000);setPacing(env,pacing);assert.equal(allowanceMeters(env,NOW+1000,context(env,{now:NOW+1000}).window).find(m=>m.kind==='pacing').at,first);
 setPacing(env,null);saveProfile(env,'Free');useProfile(env,'Paced',NOW+1000);
 assert.equal(allowanceMeters(env,NOW+1000,context(env,{now:NOW+1000}).window).find(m=>m.kind==='pacing').at,first);
 assert.throws(()=>saveProfile(env,' __proto__ '));
});

test('changing pacing action preserves today’s ceiling and CLI extras clamp at midnight',async()=>{
 const {main}=await import('../src/cli.mjs');const {env}=sandbox();read(env,40);
 setPacing(env,{days:[0,1,2,3,4,5,6],reserve:20,action:'warn'});const cap=allowanceMeters(env,NOW,context(env,{now:NOW}).window)[0].at;
 read(env,45,NOW+1000);setPacing(env,{days:[0,1,2,3,4,5,6],reserve:20,action:'pause'});assert.equal(allowanceMeters(env,NOW+1000,context(env,{now:NOW+1000}).window)[0].at,cap);
 const late=localDay(NOW).end-900000;read(env,46,late);const lines=[];
 assert.equal(await main(['extra','daily','3','1h'],{env,now:late,out:s=>lines.push(s)}),0);assert.equal(activeExtras(env,late,context(env,{now:late}).window.seven_day)[0].until,localDay(late).end);
 assert.equal(await main(['extra','weekly','3','1h'],{env,now:late,out:s=>lines.push(s)}),1);
});
