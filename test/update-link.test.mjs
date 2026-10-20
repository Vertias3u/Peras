import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';
import {sandbox} from './helpers.mjs';import {updateCLI} from '../src/update.mjs';
for(const fail of ['npm','verification',null])test(`R3 keeps the checkout linked while npm stages (${fail??'success'})`,async()=>{
 const {env,root}=sandbox(),modules=root+'/prefix/lib/node_modules',globalRoot=modules+'/peras-cli',checkout=root+'/checkout';
 const put=(p,v,complete=true)=>{fs.mkdirSync(p+'/bin',{recursive:true});fs.writeFileSync(p+'/package.json',JSON.stringify({name:'peras-cli',version:v}));if(complete)fs.writeFileSync(p+'/bin/peras.mjs','release');};
 put(checkout,'0.4.0');fs.mkdirSync(modules,{recursive:true});fs.symlinkSync(checkout,globalRoot);
 const bin=root+'/prefix/bin/peras';fs.mkdirSync(path.dirname(bin),{recursive:true});fs.symlinkSync(checkout+'/bin/peras.mjs',bin);
 let linkedDuringNpm=false;
 const run=async(cmd,args)=>{if(args[0]==='view')return {stdout:'"0.4.1"'};if(args[0]==='root')return {stdout:modules};
  if(args[0]==='install'){
   linkedDuringNpm=fs.lstatSync(globalRoot,{throwIfNoEntry:false})?.isSymbolicLink()===true;
   const prefix=args.indexOf('--prefix');const dest=prefix<0?globalRoot:path.join(args[prefix+1],process.platform==='win32'?'node_modules':'lib/node_modules','peras-cli');
   // Do not write through the checkout in the old implementation: still model npm's partial output after unlink.
   if(!linkedDuringNpm||prefix>=0)put(dest,'0.4.1',fail!=='verification');
   if(fail==='npm')throw Error('ENOSPC midway');return {stdout:''};
  }return {stdout:''};};
 const call=()=>updateCLI({env,root:checkout,version:'0.4.0',run,out:()=>{}});
 if(fail)await assert.rejects(call());else await call();
 assert.equal(linkedDuringNpm,true,'npm must run without removing the active checkout link');
 assert.equal(JSON.parse(fs.readFileSync(checkout+'/package.json')).version,'0.4.0');
 if(fail){assert.equal(fs.readlinkSync(globalRoot),checkout);assert.equal(fs.readFileSync(globalRoot+'/bin/peras.mjs','utf8'),'release');}
 else {assert.equal(fs.lstatSync(globalRoot).isSymbolicLink(),false);assert.equal(JSON.parse(fs.readFileSync(globalRoot+'/package.json')).version,'0.4.1');assert.equal(fs.realpathSync(bin),fs.realpathSync(globalRoot+'/bin/peras.mjs'),'the global launcher must follow the promoted package, not the checkout');}
});

test('R3 a real offline npm install promotes the package and launcher without writing through the checkout', async () => {
 const {runUpdateCommand}=await import('../src/update.mjs');
 const {env,root}=sandbox(),prefix=path.join(root,'prefix'),modules=path.join(prefix,'lib','node_modules'),globalRoot=path.join(modules,'peras-cli'),checkout=path.join(root,'checkout');
 if(process.platform==='win32')return; // The Unix npm launcher is the integration target here.
 fs.mkdirSync(checkout+'/bin',{recursive:true});fs.writeFileSync(checkout+'/package.json',JSON.stringify({name:'peras-cli',version:'0.3.2'}));fs.writeFileSync(checkout+'/bin/peras.mjs','// checkout remains unchanged');
 fs.mkdirSync(modules,{recursive:true});fs.symlinkSync(checkout,globalRoot);fs.mkdirSync(prefix+'/bin');fs.symlinkSync(checkout+'/bin/peras.mjs',prefix+'/bin/peras');
 const repo=new URL('../',import.meta.url).pathname,version=JSON.parse(fs.readFileSync(path.join(repo,'package.json'))).version;
 const npm=process.platform==='win32'?'npm.cmd':'npm';
 const isolated={...env,npm_config_prefix:prefix,npm_config_registry:'http://127.0.0.1:9',npm_config_update_notifier:'false'};
 const packed=JSON.parse((await runUpdateCommand(npm,['pack','--json','--ignore-scripts','--pack-destination',root],{env:isolated,cwd:repo,timeout:30000})).stdout)[0];
 const run=async(command,args,options)=>{
  if(args[0]==='view')return {stdout:JSON.stringify(version)};
  if(args[0]==='root')return {stdout:modules};
  assert.equal(fs.readlinkSync(globalRoot),checkout,'checkout link still exists as real npm starts');
  assert.ok(args.includes('--prefix'),'npm is isolated in a staging prefix');
  return runUpdateCommand(command,[...args.slice(0,2),path.join(root,packed.filename),...args.slice(3)],{...options,env:isolated});
 };
 await updateCLI({env:isolated,root:checkout,version:'0.3.2',run,out:()=>{}});
 assert.equal(fs.readFileSync(checkout+'/bin/peras.mjs','utf8'),'// checkout remains unchanged');
 assert.equal(fs.realpathSync(prefix+'/bin/peras'),fs.realpathSync(globalRoot+'/bin/peras.mjs'));
 assert.equal((await runUpdateCommand(process.execPath,[prefix+'/bin/peras','--version'],{env:isolated,cwd:root,timeout:30000})).stdout.trim(),version);
});
