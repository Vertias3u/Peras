// Build-time export of the original compressed atlas; source is never modified.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {inflateSync,deflateSync} from 'node:zlib';
const dir=path.dirname(fileURLToPath(import.meta.url));
const out=process.argv[2];
if (!out || !path.isAbsolute(out)) throw new Error('Pass an absolute build resources directory');
fs.mkdirSync(out,{recursive:true});
const source=fs.readFileSync(path.resolve(dir,'../../src/mascot-atlas.json'));
const atlas=JSON.parse(source);
const table=Array.from({length:256},(_,n)=>{for(let j=0;j<8;j++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0});
function chunk(t,d){const b=Buffer.concat([Buffer.from(t),d]);let c=0xffffffff;for(const x of b)c=table[(c^x)&255]^(c>>>8);const a=Buffer.alloc(4),z=Buffer.alloc(4);a.writeUInt32BE(d.length);z.writeUInt32BE((c^0xffffffff)>>>0);return Buffer.concat([a,b,z]);}
function png(p,w=atlas.width,h=atlas.height){const head=Buffer.alloc(13);head.writeUInt32BE(w);head.writeUInt32BE(h,4);head[8]=8;head[9]=6;const rows=Buffer.alloc((w*4+1)*h);for(let y=0;y<h;y++)p.copy(rows,y*(w*4+1)+1,y*w*4,(y+1)*w*4);return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',head),chunk('IDAT',deflateSync(rows)),chunk('IEND',Buffer.alloc(0))]);}
const manifest={width:atlas.width,height:atlas.height,sourceSha256:crypto.createHash('sha256').update(source).digest('hex'),providers:{}};
for(const name of ['claude','codex']){
 const pet=atlas[name];
 const frame=(f,key)=>{const pixels=inflateSync(Buffer.from(f.data,'base64'));const file=`${name}-${key}.png`;fs.writeFileSync(path.join(out,file),png(pixels));return{file,ms:f.ms,sha256:crypto.createHash('sha256').update(pixels).digest('hex')};};
 const cup=Buffer.alloc(8*7*4),pattern=['00000000','01111100','01222110','01222010','01222110','01111100','00111000'];
 // Black outline on both cups, so Codex's blue coffee doesn't merge into its blue body.
 const colors=name==='claude'?[[0,0,0],[217,119,87]]:[[0,0,0],[109,154,250]];
 pattern.forEach((row,y)=>[...row].forEach((v,x)=>{if(v==='0')return;const offset=(y*8+x)*4;cup.set([...colors[Number(v)-1],255],offset);}));
 fs.writeFileSync(path.join(out,`${name}-cup.png`),png(cup,8,7));
 manifest.providers[name]={mirrorLeft:Boolean(pet.mirrorLeft),right:pet.right.map((f,i)=>frame(f,`right-${i}`)),left:pet.left?.map((f,i)=>frame(f,`left-${i}`))??null,idle:frame(pet.idle,'idle'),cup:`${name}-cup.png`};
}
// The menu bar's agent marks, the same 2x glyphs 0.3's SwiftBar title uses, cropped to 32×32.
const glyphs=JSON.parse(fs.readFileSync(path.resolve(dir,'../../src/menubar-atlas.json')));
for(const name of ['claude','codex']){
 const s=glyphs.sprites[name],pixels=inflateSync(Buffer.from(s.data,'base64')),crop=Buffer.alloc(32*32*4);
 for(let y=0;y<32;y++)pixels.copy(crop,y*32*4,((y+4)*glyphs.width)*4,((y+4)*glyphs.width+32)*4);
 fs.writeFileSync(path.join(out,`${name}-logo.png`),png(crop,32,32));
}
fs.writeFileSync(path.join(out,'atlas.json'),JSON.stringify(manifest,null,2));
console.log(`Exported original atlas ${manifest.sourceSha256.slice(0,12)} into the native bundle.`);
