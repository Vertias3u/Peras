import {test} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {sandbox,NOW,inHours} from './helpers.mjs';
import {createActionTicket,handleNotificationAction,reminderSnooze} from '../src/notification-actions.mjs';
import {recordReading,pauseNow,context,readState,sessionVerdict} from '../src/store.mjs';
import {codexEnv} from '../src/codex.mjs';
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
