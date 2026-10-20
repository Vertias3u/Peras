import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';
import {sandbox} from './helpers.mjs';import {updateCLI} from '../src/update.mjs';import {appPath} from '../src/native-app.mjs';import {writeInstall} from '../src/store.mjs';
for(const check of [false,true])test(`R2 refuses an incompatible resolved global prefix (check=${check}) before refreshing hooks`,async()=>{
 const {env,root}=sandbox();const globalRoot=path.join(root,'other-prefix','lib','node_modules','peras-cli');fs.mkdirSync(globalRoot,{recursive:true});fs.writeFileSync(globalRoot+'/package.json',JSON.stringify({name:'peras-cli',version:'0.5.0'}));
 fs.mkdirSync(appPath(env)+'/Contents',{recursive:true});fs.writeFileSync(appPath(env)+'/Contents/Info.plist','<key>PerasRuntimeVersion</key><string>0.4.0</string>');writeInstall(env,{version:'0.3.2'});
 const calls=[];const run=async(cmd,args)=>{calls.push(args);if(args[0]==='view')return {stdout:JSON.stringify(args[1].includes('~')?'0.4.2':'0.5.0')};if(args[0]==='root')return {stdout:path.dirname(globalRoot)};return {stdout:''};};
 await assert.rejects(updateCLI({env,root,version:'0.4.0',check,run,out:()=>{}}),/prefix.*0\.5\.0.*app.*0\.4\.0/i);
 assert.deepEqual(calls.map(a=>a[0]),['view','view','root']);
 assert.equal(JSON.parse(fs.readFileSync(globalRoot+'/package.json')).version,'0.5.0');
});
