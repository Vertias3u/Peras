import {test} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import {sandbox,NOW,inHours,statusInput} from './helpers.mjs';
import * as actions from '../src/notification-actions.mjs';
import {createActionTicket,handleNotificationAction,reminderSnooze} from '../src/notification-actions.mjs';
import {recordReading,pauseNow,context,readState,sessionVerdict} from '../src/store.mjs';
import {codexEnv,runCodexHook,readingFromRateLimits} from '../src/codex.mjs';
import {runHook} from '../src/hook.mjs';
import {readingFrom} from '../src/window.mjs';
import {snapshot} from '../src/providers.mjs';
import {setPreference} from '../src/preferences.mjs';
import {checkUnusedReminders} from '../src/unused-reminders.mjs';

test('pause notification action resumes only its original provider and refuses stale changed pauses',async()=>{
 const {env,root}=sandbox(),scoped=codexEnv(env);pauseNow(env,{now:NOW});pauseNow(scoped,{now:NOW});
 const keys=sessionVerdict(context(scoped,{now:NOW}),readState(scoped,NOW)).hits.map(h=>h.key);
 const id=createActionTicket(root,env,{provider:'codex',category:'pause',pauseKeys:keys},NOW),file=path.join(root,'actions',id+'.json');
 const result=await handleNotificationAction(file,'PERAS_RESUME',{now:NOW+1000});assert.equal(result.provider,'codex');assert.equal(readState(scoped,NOW+1000).manualPause,null);assert.ok(readState(env,NOW+1000).manualPause);
 const stale=createActionTicket(root,env,{provider:'claude',category:'pause',pauseKeys:sessionVerdict(context(env,{now:NOW}),readState(env,NOW)).hits.map(h=>h.key)},NOW);
 pauseNow(env,{now:NOW+2000});await assert.rejects(handleNotificationAction(path.join(root,'actions',stale+'.json'),'PERAS_RESUME',{now:NOW+3000}),/pause changed/);
});
test('status action opens only a generated local page and cannot resume from an ordinary alert',async()=>{
 const {env,root}=sandbox();const id=createActionTicket(root,env,{category:'status'},NOW),file=path.join(root,'actions',id+'.json');let opened;
 await handleNotificationAction(file,'PERAS_STATUS',{now:NOW,openURL:async url=>{opened=url}});assert.match(opened,/^file:/);assert.match(opened,/status.html$/);
 await assert.rejects(handleNotificationAction(file,'PERAS_RESUME',{now:NOW}),/cannot resume/);
 await assert.rejects(handleNotificationAction(file,'PERAS_STATUS',{now:NOW+8*86400_000}),/expired/);
});
test('reminder snooze defers and repeats once after one hour while retaining fresh-reading gates',async()=>{
 const {env,root}=sandbox();setPreference(env,'unused','on');const resetsAt=inHours(48);
 const row=at=>({provider:'claude',env,ctx:{window:{seven_day:{usedPct:70,seenAt:at,resetsAt}}}});
 let sent=0;const notify=()=>sent++;checkUnusedReminders(env,[row(NOW)],NOW,notify);assert.equal(sent,1);
 const id=createActionTicket(root,env,{provider:'claude',category:'reminder',resetsAt},NOW);
 await handleNotificationAction(path.join(root,'actions',id+'.json'),'PERAS_SNOOZE',{now:NOW});
 assert.equal(reminderSnooze(env).until,NOW+3600_000);
 checkUnusedReminders(env,[row(NOW+1800_000)],NOW+1800_000,notify);assert.equal(sent,1);
 checkUnusedReminders(env,[row(NOW+3600_000)],NOW+3600_000,notify);assert.equal(sent,2);
 checkUnusedReminders(env,[row(NOW+3601_000)],NOW+3601_000,notify);assert.equal(sent,2);
});

// v0.4 notification migration: the 0.3 helper stays the poster (same bundle ID, same
// permission, same tickets); only where a click lands moves to the menu app.

test('a notification click brings the running native menu forward instead of the status page',async()=>{
 const {env,root}=sandbox();
 for(const action of ['PERAS_STATUS','com.apple.UNNotificationDefaultActionIdentifier']){
  const id=createActionTicket(root,env,{category:'pause'},NOW),seen=[];let opened=null;
  const result=await handleNotificationAction(path.join(root,'actions',id+'.json'),action,{now:NOW,openURL:async url=>{opened=url},openMenu:async e=>{seen.push(e);return true}});
  assert.deepEqual(result,{opened:true,target:'menu'});
  assert.equal(opened,null,'no browser page when the menu came forward');
  assert.equal(seen[0].PERAS_HOME,env.PERAS_HOME,'the menu of the PERAS_HOME that posted');
 }
 // Not the live menu, or it failed: the status page, as in 0.3.
 for(const openMenu of [async()=>false,async()=>{throw new Error('reopen failed')}]){
  const id=createActionTicket(root,env,{category:'status'},NOW);let opened=null;
  const result=await handleNotificationAction(path.join(root,'actions',id+'.json'),'PERAS_STATUS',{now:NOW,openURL:async url=>{opened=url},openMenu});
  assert.equal(result.target,'status');assert.match(opened,/status\.html$/);
 }
});

test('only a live, running menu app of this PERAS_HOME is brought forward; a quit one is never relaunched',async()=>{
 assert.equal(typeof actions.openNativeMenu,'function');
 const {env,home,root}=sandbox(),launched=[];const launch=app=>launched.push(app);
 assert.equal(await actions.openNativeMenu(env,{platform:'darwin',running:()=>true,launch}),false,'no menu app installed');
 const app=path.join(home,'native','Peras.app');fs.mkdirSync(path.join(app,'Contents'),{recursive:true});fs.writeFileSync(path.join(app,'Contents','Info.plist'),'<plist/>');
 assert.equal(await actions.openNativeMenu(env,{platform:'darwin',running:()=>false,launch}),false,'installed but quit');
 assert.equal(await actions.openNativeMenu(env,{platform:'linux',running:()=>true,launch}),false);
 assert.deepEqual(launched,[]);
 let asked=null;
 assert.equal(await actions.openNativeMenu(env,{platform:'darwin',running:a=>{asked=a;return true},launch}),true);
 assert.deepEqual([asked,launched],[app,[app]],'exactly this PERAS_HOME\'s bundle');
 // SwiftBar is the live menu again (a rollback reinstalled its plugin): status page.
 const plugin=path.join(root,'swiftbar','peras.1m.sh');fs.mkdirSync(path.dirname(plugin),{recursive:true});fs.writeFileSync(plugin,'#!/bin/sh\n');
 fs.writeFileSync(path.join(home,'menubar.json'),JSON.stringify({file:plugin}));
 assert.equal(await actions.openNativeMenu(env,{platform:'darwin',running:()=>true,launch}),false);
 assert.equal(launched.length,1);
});

test('notification Resume lifts what the v0.4 Claude and Codex hooks paused, from their own notify options',async()=>{
 const {env,root}=sandbox();env.CODEX_HOME=path.join(root,'codex');
 recordReading(env,readingFrom(statusInput({sevenDay:91}),NOW));
 const input={hook_event_name:'PreToolUse',session_id:'s-1',cwd:root,tool_name:'Bash',tool_input:{command:'ls'}};
 const codexLimits={rateLimits:{limitId:'codex',primary:{usedPercent:20,windowDurationMins:300,resetsAt:(NOW+3600_000)/1000},secondary:{usedPercent:93,windowDurationMins:10080,resetsAt:(NOW+72*3600_000)/1000}}};
 const posted=[];const notify=(title,body,options)=>posted.push(options);
 assert.equal(runHook({input,env,now:NOW,notify}).continue,false);
 assert.equal((await runCodexHook({input:{...input,turn_id:'t'},env,now:NOW,reader:async()=>codexLimits,notify})).hookSpecificOutput.permissionDecision,'deny');
 assert.deepEqual(posted.map(o=>[o.provider,o.category]),[['claude','pause'],['codex','pause']]);
 for(const options of posted){
  const id=createActionTicket(path.join(root,'helper'),options.env,options,NOW);
  assert.deepEqual(await handleNotificationAction(path.join(root,'helper','actions',id+'.json'),'PERAS_RESUME',{now:NOW+1000}),{resumed:true,provider:options.provider});
 }
 assert.equal(runHook({input,env,now:NOW+2000,notify:()=>{}}),null);
 assert.notEqual((await runCodexHook({input:{...input,turn_id:'t'},env,now:NOW+2000,reader:async()=>codexLimits,notify:()=>{}}))?.hookSpecificOutput?.permissionDecision,'deny');
});

test('a reminder snoozed from a ticket is the one the native bridge monitor reads, for both providers',async()=>{
 for(const provider of ['claude','codex']){
  const {env,root}=sandbox();env.CODEX_HOME=path.join(root,'codex');setPreference(env,'unused','on');
  const record=at=>provider==='codex'
   ?recordReading(codexEnv(env),readingFromRateLimits({rateLimits:{limitId:'codex',primary:{usedPercent:20,windowDurationMins:300,resetsAt:(NOW+3600_000)/1000},secondary:{usedPercent:30,windowDurationMins:10080,resetsAt:inHours(24)}}},at))
   :recordReading(env,readingFrom(statusInput({fiveHour:10,sevenDay:30,fiveResets:inHours(3),sevenResets:inHours(24)}),at));
  // Shaped like nativePayloads: judged with no folder.
  const rows=async at=>[await snapshot(env,at,{cwd:null}),await snapshot(env,at,{provider:'codex',cwd:null})];
  const sent=[];const notify=(title,body,options)=>sent.push(options);
  record(NOW);checkUnusedReminders(env,await rows(NOW),NOW,notify);
  assert.deepEqual(sent.map(o=>o.provider),[provider]);
  const id=createActionTicket(path.join(root,'helper'),sent[0].env,sent[0],NOW);
  await handleNotificationAction(path.join(root,'helper','actions',id+'.json'),'PERAS_SNOOZE',{now:NOW});
  checkUnusedReminders(env,await rows(NOW+60_000),NOW+60_000,notify);assert.equal(sent.length,1,'snoozed');
  record(NOW+3601_000);checkUnusedReminders(env,await rows(NOW+3601_000),NOW+3601_000,notify);assert.equal(sent.length,2,'back after the hour, once');
 }
});
