import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {spawnSync} from 'node:child_process';import {sandbox} from './helpers.mjs';import {updateBackup} from '../src/update-backup.mjs';
test('R1 local app rollback retains quarantine and extended attributes',{skip:process.platform!=='darwin'},()=>{
 const {root}=sandbox(),app=path.join(root,'Peras.app');fs.mkdirSync(app+'/Contents',{recursive:true});fs.writeFileSync(app+'/Contents/Info.plist','fixture');
 const attr=['com.apple.quarantine','0081;00000000;;'];const set=spawnSync('/usr/bin/xattr',['-w',...attr,app],{encoding:'utf8'});assert.equal(set.status,0,set.stderr);
 const extra=spawnSync('/usr/bin/xattr',['-w','eu.vertias.peras-test','keep-me',app],{encoding:'utf8'});assert.equal(extra.status,0,extra.stderr);
 const b=updateBackup([app],root);fs.rmSync(app,{recursive:true});b.restore();
 const read=spawnSync('/usr/bin/xattr',['-p',attr[0],app],{encoding:'utf8'});assert.equal(read.status,0,read.stderr);assert.equal(read.stdout.trim(),attr[1]);assert.equal(spawnSync('/usr/bin/xattr',['-p','eu.vertias.peras-test',app],{encoding:'utf8'}).stdout.trim(),'keep-me');b.discard();
});
