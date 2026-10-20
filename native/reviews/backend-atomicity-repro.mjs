import os from "node:os";
import {fileURLToPath} from "node:url";
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const base=process.env.PERAS_REVIEW_SOURCE_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const {sandbox,NOW}=await import(`file://${base}/test/helpers.mjs`);
const {install}=await import(`file://${base}/src/settings.mjs`);
const {readState,writeState,stateFile}=await import(`file://${base}/src/store.mjs`);
const {snapshot}=await import(`file://${base}/src/providers.mjs`);
const {providerPayload,tokenSigner}=await import(`file://${base}/src/native-protocol.mjs`);
const {runOperation}=await import(`file://${base}/src/native-operations.mjs`);
const {env,root}=sandbox();env.PATH='/usr/bin:/bin';env.CODEX_HOME=path.join(root,'codex');
install({env,command:`"${process.execPath}" "${base}/bin/peras.mjs"`,version:'0.3.2'});
writeState(env,readState(env,NOW));
const signer=tokenSigner();
const offer=providerPayload(await snapshot(env,NOW,{cwd:null}),{now:NOW,sign:signer.sign}).actions.find(a=>a.op==='pause'&&a.params.duration==='1h');
const originalRead=fs.readFileSync;
let reads=0,inserted=false,childResult;
fs.readFileSync=function(file,...rest){
 if(file===stateFile(env)&&++reads===2){
  const code=`const {pauseNow}=await import(${JSON.stringify(`file://${base}/src/store.mjs`)});console.log(JSON.stringify(pauseNow(JSON.parse(process.env.REPRO_ENV),{now:${NOW+1},until:null})));`;
  const child=spawnSync(process.execPath,['--input-type=module','-e',code],{env:{...env,REPRO_ENV:JSON.stringify(env)},encoding:'utf8',timeout:5000});
  if(child.status!==0)throw new Error(child.stderr);
  childResult=JSON.parse(child.stdout);inserted=true;
 }
 return originalRead.call(this,file,...rest);
};
let operation;
try {operation=await runOperation(env,{id:'click',op:offer.op,provider:'claude',params:offer.params,actionToken:offer.actionToken},{now:NOW,signer});}
finally {fs.readFileSync=originalRead;}
const result={insertedBySeparateProcess:inserted,stateReads:reads,operation,newerIndefinitePause:childResult,savedPause:readState(env,NOW+2).manualPause};
fs.writeFileSync(path.join(process.env.PERAS_REVIEW_OUTPUT || fs.mkdtempSync(path.join(os.tmpdir(),'peras-backend-review-')), 'backend-atomicity-results.json'),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result,null,2));
