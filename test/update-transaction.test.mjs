import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox } from './helpers.mjs';
import { updateCLI } from '../src/update.mjs';
import { main } from '../src/cli.mjs';
import { appPath, bundleVersion, installApp } from '../src/native-app.mjs';
import { writeInstall, installFile, pauseNow, readState } from '../src/store.mjs';
import { settingsPath } from '../src/settings.mjs';

function fixture({ version = '0.4.0', caller = 'global', fail = 'app' } = {}) {
 const {env,root:home}=sandbox();
 const modules=path.join(home,'prefix','lib','node_modules'), globalRoot=path.join(modules,'peras-cli');
 const put=(dir,v)=>{fs.mkdirSync(path.join(dir,'bin'),{recursive:true});fs.writeFileSync(path.join(dir,'package.json'),JSON.stringify({name:'peras-cli',version:v,type:'module'}));fs.writeFileSync(path.join(dir,'bin','peras.mjs'),'// '+v);};
 put(globalRoot,version);
 const root=caller==='global'?globalRoot:path.join(home,caller,'peras-cli');if(root!==globalRoot)put(root,version);
 const bin=path.join(home,'prefix','bin','peras');fs.mkdirSync(path.dirname(bin),{recursive:true});fs.symlinkSync('../lib/node_modules/peras-cli/bin/peras.mjs',bin);
 const source=path.join(home,'Downloads','Peras.app');fs.mkdirSync(path.join(source,'Contents'),{recursive:true});fs.writeFileSync(path.join(source,'Contents','Info.plist'),'<key>PerasRuntimeVersion</key><string>0.5.0</string>');
 const app=appPath(env);fs.mkdirSync(path.join(app,'Contents'),{recursive:true});fs.writeFileSync(path.join(app,'Contents','Info.plist'),'<key>PerasRuntimeVersion</key><string>0.4.0</string>');
 writeInstall(env,{version,command:'old-hook'});fs.mkdirSync(path.dirname(settingsPath(env)),{recursive:true});fs.writeFileSync(settingsPath(env),'OLD SETTINGS');
 fs.mkdirSync(path.join(env.PERAS_HOME,'app','bin'),{recursive:true});fs.writeFileSync(path.join(env.PERAS_HOME,'app','bin','peras.mjs'),'OLD RUNTIME');
 const calls=[];
 const run=async(command,args)=>{calls.push(args);
  if(args[0]==='view')return {stdout:'"0.5.0"'};
  if(args[0]==='root')return {stdout:modules};
  if(args[0]==='install'){assert.equal(args[2],'peras-cli@0.5.0','rollback must not depend on fetching an unpublished version');put(globalRoot,'0.5.0');fs.unlinkSync(bin);fs.writeFileSync(bin,'NEW BIN');return {stdout:''};}
  if(args[1]==='setup'){
   fs.writeFileSync(settingsPath(env),'NEW SETTINGS');fs.writeFileSync(path.join(env.PERAS_HOME,'app','bin','peras.mjs'),'NEW RUNTIME');writeInstall(env,{version:'0.5.0',command:'new-hook'});
   pauseNow(env,{now:123456}); // A concurrent explicit pause must not be rolled back with integration files.
   if(fail==='refresh')throw Error('refresh failed after changing files');return {stdout:''};
  }
  if(args.includes('--native'))throw Error('app did not answer');
  throw Error('unexpected '+args.join(' '));
 };
 return {env,root,version,globalRoot,bin,source,calls,run};
}
for(const caller of ['global','npx-cache','other-prefix'])for(const fail of ['app','refresh'])test(`R1 restores local package/runtime/integrations after ${fail} failure from ${caller}`,async()=>{
 const f=fixture({caller,fail});await assert.rejects(updateCLI({...f,app:f.source,out:()=>{}}),/back|restored/);
 assert.equal(JSON.parse(fs.readFileSync(path.join(f.globalRoot,'package.json'))).version,'0.4.0');
 assert.equal(fs.readlinkSync(f.bin),'../lib/node_modules/peras-cli/bin/peras.mjs');
 assert.equal(fs.readFileSync(settingsPath(f.env),'utf8'),'OLD SETTINGS');
 assert.equal(fs.readFileSync(path.join(f.env.PERAS_HOME,'app','bin','peras.mjs'),'utf8'),'OLD RUNTIME');
 assert.equal(JSON.parse(fs.readFileSync(installFile(f.env))).command,'old-hook');
 assert.equal(readState(f.env,123457).manualPause?.since,123456,'current pause survives rollback');
});
test('R1 restores an unpublished preview locally, without another npm install',async()=>{
 const f=fixture({version:'0.4.0-preview.1'});await assert.rejects(updateCLI({...f,app:f.source,out:()=>{}}),/back|restored/);
 assert.equal(JSON.parse(fs.readFileSync(path.join(f.globalRoot,'package.json'))).version,f.version);
 assert.equal(f.calls.filter(a=>a[0]==='install').length,1);
});

test('R4 coordinated update restores both versions after a quarantined app fails to launch',async()=>{
 const f=fixture();
 const run=async(command,args,options)=>{
  if(!args.includes('--native'))return f.run(command,args,options);
  // This injected installer uses this checkout's CLI, rather than a separate 0.5 test binary.
  writeInstall(f.env,{version:'0.4.0',command:'old-hook'});
  fs.writeFileSync(settingsPath(f.env),'{}');
  const lines=[];
  const code=await main(args.slice(1),{env:f.env,out:l=>lines.push(l),nativeApp:{
   verify:()=>({ok:true,adhoc:false}),quarantined:()=>true,running:()=>false,quit:()=>{},
   launch:()=>{throw Error('macOS approval pending');},clock:Date.now,firstOpenTimeoutMs:180000,
  }});
  if(code!==0)throw Error(lines.join('\n'));
  return {stdout:''};
 };
 await assert.rejects(updateCLI({...f,run,app:f.source,out:()=>{}}),/previous CLI and integrations are restored/);
 assert.equal(JSON.parse(fs.readFileSync(f.globalRoot+'/package.json')).version,'0.4.0');
 assert.equal(bundleVersion(appPath(f.env)),'0.4.0');
 assert.equal(fs.readdirSync(path.dirname(appPath(f.env))).filter(n=>/^Peras-pending-.*\.app$/.test(n)).length,1);
});

test('R4 an interrupted native installer retains its unconfirmed app while restoring the old pair',async()=>{
 const f=fixture();let timeout;
 const run=async(command,args,options)=>{
  if(!args.includes('--native'))return f.run(command,args,options);
  timeout=options.timeout;
  installApp(f.env,f.source,{verify:()=>({ok:true}),downloaded:()=>true});
  // Model the outer runner killing its child before the child's own recovery handler runs.
  throw Error('native installer timed out');
 };
 await assert.rejects(updateCLI({...f,run,app:f.source,out:()=>{}}),/previous CLI and integrations are restored/);
 assert.equal(bundleVersion(appPath(f.env)),'0.4.0');
 const pending=fs.readdirSync(path.dirname(appPath(f.env))).filter(n=>/^Peras-pending-.*\.app$/.test(n));
 assert.equal(pending.length,1,'the unconfirmed copy must survive the outer rollback');
 assert.equal(bundleVersion(path.join(path.dirname(appPath(f.env)),pending[0])),'0.5.0');
 assert.ok(timeout>180000,'outer deadline must include verification/copy as well as the first-open wait');
});


test('F2 a failed rollback leaves a discoverable backup under a custom Peras home', async () => {
 const f = fixture();
 assert.notEqual(f.env.PERAS_HOME, f.env.HOME);
 const run = async (command, args, options) => {
  if (args[1] === 'setup') {
   const parent = path.dirname(settingsPath(f.env));
   fs.rmSync(parent, { recursive: true, force: true });
   fs.writeFileSync(parent, 'prevent restoration');
   throw Error('refresh failed');
  }
  return f.run(command, args, options);
 };
 let message;
 try { await updateCLI({ ...f, run, app: f.source, out: () => {} }); }
 catch (error) { message = error.message; }
 assert.match(message, /restoring the local backup failed/);
 const dirs = fs.readdirSync(f.env.PERAS_HOME).filter(n => n.startsWith('.peras-update-'));
 assert.equal(dirs.length, 1);
 const backup = path.join(f.env.PERAS_HOME, dirs[0]);
 assert.ok(message.includes(backup), message);
 assert.ok(fs.existsSync(path.join(backup, 'manifest.json')));
 assert.equal(fs.statSync(backup).dev, fs.statSync(f.env.PERAS_HOME).dev);
 assert.equal(fs.readdirSync(f.env.HOME).filter(n => n.startsWith('.peras-update-')).length, 0);
});
