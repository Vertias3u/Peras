import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { sandbox, NOW, inHours } from "./helpers.mjs";
import { recordReading, context, resume, readState, writeRules } from "../src/store.mjs";
import { setBudget, readBudgetRules, allowanceMeters, localDay, touchAllowanceSession, parseBudget, observeAllowances } from "../src/allowances.mjs";
import { evaluate } from "../src/rules.mjs";
import { runHook } from "../src/hook.mjs";
import { runCodexHook, codexEnv } from "../src/codex.mjs";
import { main } from "../src/cli.mjs";
const reading = (pct, now = NOW, resetsAt = inHours(72)) => ({ seven_day: { usedPct:pct, seenAt:now, resetsAt } });

test("daily budget counts once, enforces through hooks, resumes, and resets at local midnight", () => {
  const { env } = sandbox(); writeRules(env, []);
  setBudget(env,{period:"daily",at:10,action:"pause"},NOW);
  recordReading(env,reading(30));
  recordReading(env,reading(40,NOW+60_000));
  observeAllowances(env,reading(30),reading(40,NOW+60_000),{now:NOW+60_000});
  assert.equal(allowanceMeters(env,NOW+60_000)[0].spent,10);
  const input = {hook_event_name:"PreToolUse",session_id:"daily",cwd:process.cwd()};
  assert.equal(runHook({env,now:NOW+60_000,input}).continue,false);
  resume(env,{now:NOW+60_000});
  assert.equal(evaluate(context(env,{now:NOW+60_000})).action,"none");
  const next = localDay(NOW).end;
  assert.equal(evaluate(context(env,{now:next})).action,"none");
  recordReading(env,reading(41,next));
  recordReading(env,reading(51,next+60_000));
  assert.equal(evaluate(context(env,{now:next+60_000})).action,"pause");
  assert.ok(readState(env,next).resumed.length===0);
});

test("daily allowance preserves today's total across a weekly reset", () => {
  const {env}=sandbox(); setBudget(env,{period:"daily",at:10,action:"pause"},NOW);
  const reset=NOW+2*3600_000;
  recordReading(env,reading(90,NOW,reset/1000));
  recordReading(env,reading(95,NOW+60_000,reset/1000));
  recordReading(env,reading(3,reset+60_000,(reset+7*86400_000)/1000));
  assert.equal(allowanceMeters(env,reset+60_000)[0].spent,8);
});

test("project allowance is conservative, folder-scoped, skips idle gaps, and does not double-count warning/pause", () => {
  const {env,root}=sandbox(); const project=path.join(root,"project");fs.mkdirSync(project);fs.mkdirSync(path.join(project,"child"));
  for(const action of ["warn","pause"])setBudget(env,{period:"weekly",project,at:5,action},NOW);
  writeRules(env,[]);
  recordReading(env,reading(20));touchAllowanceSession(env,"s",project,NOW);
  recordReading(env,reading(25,NOW+60_000));
  const meters=allowanceMeters(env,NOW+60_000,reading(25,NOW+60_000));
  assert.ok(meters.every(m=>m.spent===5&&m.estimated));
  assert.equal(evaluate(context(env,{now:NOW+60_000,cwd:path.join(project,"child")})).action,"pause");
  assert.equal(evaluate(context(env,{now:NOW+60_000,cwd:project+"-other"})).action,"none");
  touchAllowanceSession(env,"s",project,NOW+600_000);
  recordReading(env,reading(40,NOW+600_000));
  assert.equal(allowanceMeters(env,NOW+600_000,reading(40))[0].spent,5,"a long gap is not charged to the project");
  const next=NOW+4*86400_000;
  recordReading(env,reading(1,next,inHours(240)));
  assert.equal(allowanceMeters(env,next,reading(1,next,inHours(240)))[0].spent,0);
});

test("project attribution follows real folders and independent provider/account state", () => {
  const {env,root}=sandbox(); const project=path.join(root,"project"), link=path.join(root,"link");fs.mkdirSync(project);fs.symlinkSync(project,link);
  setBudget(env,{period:"weekly",project:link,at:5,action:"pause"},NOW);
  assert.equal(readBudgetRules(env)[0].project,fs.realpathSync(project));
  assert.equal(readBudgetRules(codexEnv(env)).length,0);
  assert.equal(readBudgetRules({...env,CLAUDE_CONFIG_DIR:path.join(root,"another-account")}).length,0);
});

test("Codex daily allowance fetches a fresh prompt baseline and denies tools after the daily rise", async () => {
  const {env}=sandbox(), scoped=codexEnv(env);writeRules(scoped,[]);
  setBudget(scoped,{period:"daily",at:5,action:"pause"},NOW);
  const limits=pct=>({rateLimits:{secondary:{usedPercent:pct,windowDurationMins:10080,resetsAt:inHours(72)}}});
  await runCodexHook({env,now:NOW,input:{hook_event_name:"UserPromptSubmit",session_id:"x",cwd:process.cwd()},reader:async()=>limits(20)});
  const result=await runCodexHook({env,now:NOW+60_000,input:{hook_event_name:"PreToolUse",session_id:"x",cwd:process.cwd()},reader:async()=>limits(25)});
  assert.equal(result.hookSpecificOutput.permissionDecision,"deny");
  assert.match(result.hookSpecificOutput.permissionDecisionReason,/today's observed usage/);
});

test("budget CLI validates settings and removes only the selected allowance", async () => {
  const {env}=sandbox(); const lines=[];const options={env,now:NOW,out:s=>lines.push(s)};
  assert.equal(await main(["budget","daily","10","pause"],options),0);
  assert.equal(await main(["codex","budget","daily","5","warn"],options),0);
  assert.equal(await main(["budget","daily","off","pause"],options),0);
  assert.equal(readBudgetRules(env).length,0);
  assert.equal(readBudgetRules(codexEnv(env)).length,1);
  for(const words of [["weekly","5"],["daily","0"],["daily","101"],["daily","10","--here"]])assert.throws(()=>parseBudget(words));
});

test("out-of-order and duplicate account readings cannot charge an allowance twice",()=>{
 const {env}=sandbox();setBudget(env,{period:"daily",at:10,action:"pause"},NOW);
 recordReading(env,reading(10));
 recordReading(env,reading(15,NOW+1000));
 recordReading(env,reading(12,NOW+1000));
 recordReading(env,reading(20,NOW+2000));
 assert.equal(allowanceMeters(env,NOW+2000)[0].spent,10);
});

test("local midnight follows 23-hour and 25-hour daylight-saving days",async()=>{
 const {execFileSync}=await import('node:child_process');
 const code="import {localDay} from './src/allowances.mjs';console.log(JSON.stringify(['2026-03-08T12:00:00-04:00','2026-11-01T12:00:00-05:00'].map(t=>{const d=localDay(Date.parse(t));return (d.end-d.start)/3600000})))";
 const result=execFileSync(process.execPath,['--input-type=module','-e',code],{cwd:process.cwd(),env:{...process.env,TZ:'America/New_York'},encoding:'utf8'});
 assert.deepEqual(JSON.parse(result),[23,25]);
});

test("Codex-only allowance setup refreshes older installed hooks before enabling a new budget",async()=>{
 const {readInstall,writeInstall}=await import('../src/store.mjs');
 const {VERSION}=await import('../src/cli.mjs');
 const {env}=sandbox();const lines=[];const options={env,now:NOW,out:s=>lines.push(s)};
 assert.equal(await main(['codex','setup'],options),0);
 const scoped=codexEnv(env);writeInstall(scoped,{...readInstall(scoped),version:'0.2.2'});
 assert.equal(await main(['codex','budget','daily','5','pause'],options),0);
 assert.equal(readInstall(scoped).version,VERSION);
 assert.equal(readInstall(env),null,'do not install Claude for a Codex-only user');
 assert.equal(readBudgetRules(scoped)[0].at,5);
 assert.match(lines.join('\n'),/Updated the hooks from Peras 0\.2\.2/);
});
