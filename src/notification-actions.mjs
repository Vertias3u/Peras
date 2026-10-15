import { recordEvent } from "./events.mjs";
import { readUsage } from "./usage.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { perasHome, dirKey, readJson, writeJsonAtomic, resume, readState, context, resumableKeys } from "./store.mjs";
import { codexEnv } from "./codex.mjs";
import { snapshot } from "./providers.mjs";
import { writeStatusPage } from "./status-page.mjs";
const snoozeFile=env=>path.join(perasHome(env),"reminder-snoozes",`${dirKey(env)}.json`);
export const reminderSnooze=env=>readJson(snoozeFile(env));
export function snoozeReminder(env,resetsAt,now=Date.now(),forMs=3600_000){if(!Number.isFinite(resetsAt)||resetsAt*1000<=now)throw new Error("This reminder's weekly window has ended.");const value={resetsAt,until:Math.min(now+forMs,resetsAt*1000),consumed:false};writeJsonAtomic(snoozeFile(env),value);return value;}
export function consumeSnooze(env,value){writeJsonAtomic(snoozeFile(env),{...value,consumed:true})}
export function createActionTicket(root,env,{provider=env.PERAS_PROVIDER==='codex'?'codex':'claude',category='status',resetsAt,pauseKeys=[]}={},now=Date.now()){
 const id=randomUUID(),directory=path.join(root,"actions");fs.mkdirSync(directory,{recursive:true,mode:0o700});
 for(const file of fs.readdirSync(directory)){if(!/^[\da-f-]{36}\.json(?:\.resumed)?$/.test(file))continue;try{if(fs.statSync(path.join(directory,file)).mtimeMs<now-7*86400_000)fs.unlinkSync(path.join(directory,file))}catch{}}
 const selected=Object.fromEntries(["HOME","PERAS_HOME","CLAUDE_CONFIG_DIR","CODEX_HOME"].filter(k=>typeof env[k]==='string').map(k=>[k,env[k]]));
 writeJsonAtomic(path.join(directory,`${id}.json`),{id,env:selected,provider,category:['pause','reminder'].includes(category)?category:'status',resetsAt:resetsAt||null,createdAt:now,pauseKeys:pauseKeys.filter(k=>typeof k==='string').slice(0,100),expiresAt:now+7*86400_000});return id;
}
export async function handleNotificationAction(file,action,{now=Date.now(),openURL=async url=>promisify(execFile)(process.platform==='darwin'?'/usr/bin/open':'xdg-open',[url]),resumeAgent=resume}={}){
 if(!/^[\da-f-]{36}\.json$/.test(path.basename(file)))throw new Error("Invalid notification action ticket.");
 const ticket=readJson(file);if(!ticket||ticket.id!==path.basename(file,'.json')||ticket.expiresAt<=now||!['claude','codex'].includes(ticket.provider))throw new Error("This notification action has expired.");
 const env=ticket.env,scoped=ticket.provider==='codex'?codexEnv(env):env;
 if(action==='PERAS_RESUME'){
  if(ticket.category!=='pause')throw new Error("This notification cannot resume an agent.");
  if(fs.existsSync(`${file}.resumed`))return {alreadyHandled:true};
  const state=readState(scoped,now),ctx=context(scoped,{now,state,usage:readUsage(scoped)});
  const current=resumableKeys(ctx,state);
  const captured=[...(ticket.pauseKeys||[])].sort();
  if(now-ticket.createdAt>3600_000||!current.length||JSON.stringify(current)!==JSON.stringify(captured))throw new Error("The pause changed or this action expired. Open Status before resuming.");
  const consumed=`${file}.resumed`;try{fs.writeFileSync(consumed,'1',{flag:'wx',mode:0o600})}catch(error){if(error.code==='EEXIST')return {alreadyHandled:true};throw error}
  try{resumeAgent(scoped,{now,forMs:3600_000})}catch(error){fs.unlinkSync(consumed);throw error}
  return {resumed:true,provider:ticket.provider};
 }
 if(action==='PERAS_SNOOZE'){
  if(ticket.category!=='reminder')throw new Error("Only unused-allowance reminders can be snoozed.");
  return {snoozed:snoozeReminder(scoped,ticket.resetsAt,now)};
 }
 if(!['PERAS_STATUS','com.apple.UNNotificationDefaultActionIdentifier'].includes(action))throw new Error("Unknown notification action.");
 const snapshots=await Promise.all([snapshot(env,now),snapshot(env,now,{provider:'codex'})]);const target=writeStatusPage(env,snapshots,now);await openURL(pathToFileURL(target).href);return {opened:true};
}
if(process.argv[1]===fileURLToPath(import.meta.url)) {
 const file=process.argv[2]||'',action=process.argv[3]||'';
 handleNotificationAction(file,action).catch(async error=>{
  if(['PERAS_RESUME','PERAS_SNOOZE'].includes(action)) {
   try {const ticket=readJson(file);recordEvent(ticket.env,{kind:'notification-action',provider:ticket.provider,message:`Action was not applied: ${error.message}`});await handleNotificationAction(file,'PERAS_STATUS')}catch{}
  }
  process.exitCode=1;
 });
}
