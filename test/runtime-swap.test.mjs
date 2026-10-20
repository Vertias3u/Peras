import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {spawnSync} from 'node:child_process';
import {sandbox,tempDir} from './helpers.mjs';import {pauseNow} from '../src/store.mjs';
const ROOT=new URL('../',import.meta.url).pathname;
function legacy(){const f=sandbox();const app=path.join(f.env.PERAS_HOME,'app');fs.mkdirSync(app,{recursive:true});for(const n of ['bin','src','package.json'])fs.cpSync(path.join(ROOT,n),path.join(app,n),{recursive:true});pauseNow(f.env);return {...f,app};}
function hook(env,bin){const r=spawnSync(process.execPath,[bin,'hook'],{env,input:'{"hook_event_name":"PreToolUse","session_id":"crash-test"}',encoding:'utf8'});assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).hookSpecificOutput?.permissionDecision,'deny',r.stdout);}
test('R5 a hook starting on each side of every setup rename still sees the pause',()=>{
 const f=legacy(),driver=path.join(tempDir('runtime-driver-'),'driver.mjs');
 fs.writeFileSync(driver,`import fs from 'node:fs';import {spawnSync} from 'node:child_process';import {main} from ${JSON.stringify(new URL('../src/cli.mjs',import.meta.url).href)};
 const app=process.env.PERAS_HOME+'/app';const rename=fs.renameSync;
 const check=()=>{const r=spawnSync(process.execPath,[app+'/bin/peras.mjs','hook'],{env:process.env,input:'{"hook_event_name":"PreToolUse"}',encoding:'utf8'});if(r.status!==0||JSON.parse(r.stdout).hookSpecificOutput?.permissionDecision!=='deny'){console.error('runtime hole',r.stderr);process.exit(73);}};
 fs.renameSync=function(...a){check();const r=rename.apply(this,a);check();return r;};
 process.exitCode=await main(['setup'],{env:process.env,out:()=>{}});`);
 const r=spawnSync(process.execPath,[driver],{env:f.env,encoding:'utf8'});assert.equal(r.status,0,r.stderr);hook(f.env,f.app+'/bin/peras.mjs');
});


test('R5 SIGKILL before and after every runtime-install step keeps a working hook, and retry succeeds',async()=>{
 const {installRuntime}=await import('../src/runtime-install.mjs');
 const driver=path.join(tempDir('runtime-crash-driver-'),'driver.mjs');
 fs.writeFileSync(driver,`import {installRuntime} from ${JSON.stringify(new URL('../src/runtime-install.mjs',import.meta.url).href)};
 const [root,killAt]=JSON.parse(process.argv[2]);let n=0;
 installRuntime(process.env,root,{checkpoint:()=>{if(n++===killAt)process.kill(process.pid,'SIGKILL');}});
 console.log(n);`);
 for(const migrated of [false,true]){
  const probe=legacy();if(migrated)installRuntime(probe.env,ROOT);
  const measured=spawnSync(process.execPath,[driver,JSON.stringify([ROOT,-1])],{env:probe.env,encoding:'utf8'});
  assert.equal(measured.status,0,measured.stderr);const steps=Number(measured.stdout.trim());assert.ok(steps>=16);
  for(let at=0;at<steps;at++){
   const f=legacy();if(migrated)installRuntime(f.env,ROOT);
   const before=fs.realpathSync(f.app+'/bin/peras.mjs');
   const r=spawnSync(process.execPath,[driver,JSON.stringify([ROOT,at])],{env:f.env,encoding:'utf8'});
   assert.equal(r.signal,'SIGKILL',`migrated=${migrated}, step=${at}: ${r.stderr}`);
   hook(f.env,f.app+'/bin/peras.mjs');
   assert.ok(fs.existsSync(before),'the previously resolved entrypoint remains available');
   installRuntime(f.env,ROOT);hook(f.env,f.app+'/bin/peras.mjs');
  }
 }
});

test('R5 a hook already loaded from a legacy directory can finish importing after publication',async()=>{
 const {installRuntime}=await import('../src/runtime-install.mjs');
 const f=legacy(),driver=path.join(tempDir('runtime-loaded-hook-'),'driver.mjs');
 // Capture the source URL as a process already inside the old main module would.
 fs.writeFileSync(driver,`import fs from 'node:fs';import {pathToFileURL} from 'node:url';
 const hookURL=pathToFileURL(process.env.PERAS_HOME+'/app/src/hook.mjs').href;
 console.log('ready');await new Promise(resolve=>process.stdin.once('data',resolve));
 const {runHook}=await import(hookURL);console.log(JSON.stringify(runHook({input:{hook_event_name:'PreToolUse'}})));`);
 const {spawn}=await import('node:child_process');const child=spawn(process.execPath,[driver],{env:f.env,stdio:['pipe','pipe','pipe']});
 let text='';const ready=new Promise(resolve=>child.stdout.on('data',chunk=>{text+=chunk;if(text.includes('ready'))resolve();}));
 const ended=new Promise(resolve=>child.once('exit',resolve));
 try{await ready;installRuntime(f.env,ROOT);child.stdin.end('continue');assert.equal(await ended,0);assert.equal(JSON.parse(text.trim().split('\n').at(-1)).hookSpecificOutput.permissionDecision,'deny');}
 finally{child.kill();}
});

test('R5 setup refreshes an existing native launch record to match the published runtime',async()=>{
 const {main,VERSION}=await import('../src/cli.mjs');const {launchFile}=await import('../src/node-runtime.mjs');
 const f=legacy();fs.mkdirSync(path.dirname(launchFile(f.env)),{recursive:true});fs.writeFileSync(launchFile(f.env),JSON.stringify({runtimeVersion:'0.3.2',cli:f.app+'/bin/peras.mjs'}));
 assert.equal(await main(['setup'],{env:f.env,out:()=>{}}),0);
 const record=JSON.parse(fs.readFileSync(launchFile(f.env)));
 assert.equal(record.runtimeVersion,VERSION);
 assert.equal(JSON.parse(fs.readFileSync(path.join(path.dirname(path.dirname(fs.realpathSync(record.cli))),'package.json'))).version,record.runtimeVersion);
});

test('R5 the Windows launcher path uses no privileged file symlinks and imports a complete runtime',async()=>{
 const {installRuntime}=await import('../src/runtime-install.mjs');const f=legacy();
 const bin=installRuntime(f.env,ROOT,{platform:'win32'});assert.equal(fs.lstatSync(bin).isSymbolicLink(),false);hook(f.env,bin);
 installRuntime(f.env,ROOT,{platform:'win32'});hook(f.env,bin);
});
