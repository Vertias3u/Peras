// Headless recovery checks only; never launches an app or reads the owner's state.
import fs from 'node:fs'; import path from 'node:path'; import crypto from 'node:crypto'; import {spawnSync} from 'node:child_process'; import {fileURLToPath} from 'node:url';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..'), root=process.argv[2];
if(!root?.startsWith('/private/tmp/') || fs.existsSync(root)) throw Error('Supply a new /private/tmp recovery root');
const run=(exe,args,env=process.env,timeout=180000)=>{const p=spawnSync(exe,args,{cwd:repo,env,encoding:'utf8',timeout,maxBuffer:1024*1024});if(p.status!==0)throw Error(p.stderr||p.stdout||String(p.error));return p.stdout;};
run(process.execPath,['native/scripts/scratch-runtime.mjs',root]);
const cfg=JSON.parse(fs.readFileSync(root+'/bridge-config.json'));
const env={...cfg.environment};
if(!env.PATH.startsWith(root+'/fake-bin:')||!fs.statSync(cfg.fakeCodex).isFile())throw Error('Missing fake Codex guard');
run(process.execPath,['native/scripts/export-atlas.mjs',root+'/resources'],env);
const walk=d=>fs.readdirSync(d,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(d,e.name)):[path.join(d,e.name)]);
const sources=[...walk(repo+'/native/Models'),repo+'/native/Stores/FixtureStore.swift',repo+'/native/Resources/SpriteResources.swift',repo+'/native/Animation/Actor.swift',repo+'/native/Platform/InstanceLock.swift',...['BridgeClient','BridgeSession','ProductionLaunch','LineFramer'].map(n=>repo+'/native/Services/'+n+'.swift'),repo+'/native/RecoveryChecks/RecoveryChecks.swift'].filter(f=>f.endsWith('.swift'));
const manifest={};for(const f of sources){const relative=path.relative(repo,f),target=root+'/source-snapshot/'+relative;fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(f,target);manifest[relative]=crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');}
fs.mkdirSync(root+'/fixtures');for(const f of fs.readdirSync(repo+'/test/fixtures/native-v1').filter(f=>f.endsWith('.json')))fs.copyFileSync(repo+'/test/fixtures/native-v1/'+f,root+'/fixtures/'+f);
const entry='import Foundation\ndo { try RecoveryChecks.run(root: URL(fileURLWithPath: CommandLine.arguments[1])) } catch { fputs("Recovery checks failed: \\(error)\\n",stderr); exit(1) }\n';
fs.mkdirSync(root+'/source-snapshot/entrypoint');fs.writeFileSync(root+'/source-snapshot/entrypoint/main.swift',entry);manifest['entrypoint/main.swift']=crypto.createHash('sha256').update(entry).digest('hex');
fs.writeFileSync(root+'/recovery-source.json',JSON.stringify(manifest,null,2)+'\n');
run('/usr/bin/swiftc',['-O','-target',process.arch==='arm64'?'arm64-apple-macos13.0':'x86_64-apple-macos13.0','-module-cache-path',root+'/module-cache',...Object.keys(manifest).map(f=>root+'/source-snapshot/'+f),'-o',root+'/recovery-checks'],env);
console.log(run(root+'/recovery-checks',[root],env,90000));
