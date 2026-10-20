// Convert the reviewed existing pixel pear into .icns; no new artwork or network tools.
import fs from 'node:fs'; import path from 'node:path'; import crypto from 'node:crypto'; import assert from 'node:assert/strict';
import {inflateSync,deflateSync} from 'node:zlib'; import {fileURLToPath} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url)), resources=path.resolve(here,'../Resources'), out=process.argv[2];
if(!out?.startsWith('/private/tmp/') || fs.existsSync(out))throw Error('Supply a new /private/tmp icon build directory');
const source=fs.readFileSync(resources+'/AppIcon-source.png'), provenance=JSON.parse(fs.readFileSync(resources+'/AppIcon-source.json'));
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');assert.equal(hash(source),provenance.sha256);
function decode(b){
 const w=b.readUInt32BE(16),h=b.readUInt32BE(20),channels=b[25]===2?3:b[25]===6?4:0;
 assert.equal(b[24],8);assert.ok(channels);assert.equal(b[28],0);
 const chunks=[];for(let i=8;i<b.length;){const n=b.readUInt32BE(i),name=b.toString('ascii',i+4,i+8);if(name==='IDAT')chunks.push(b.subarray(i+8,i+8+n));i+=n+12;}
 const raw=inflateSync(Buffer.concat(chunks)),row=w*channels,pixels=Buffer.alloc(w*h*channels);
 assert.equal(raw.length,(row+1)*h);
 const paeth=(a,b,c)=>{const p=a+b-c,x=Math.abs(p-a),y=Math.abs(p-b),z=Math.abs(p-c);return x<=y&&x<=z?a:y<=z?b:c;};
 for(let y=0;y<h;y++){const filter=raw[y*(row+1)];assert.ok(filter<=4);for(let x=0;x<row;x++){const i=y*row+x,a=x>=channels?pixels[i-channels]:0,b=y?pixels[i-row]:0,c=y&&x>=channels?pixels[i-row-channels]:0;pixels[i]=(raw[y*(row+1)+1+x]+(filter===0?0:filter===1?a:filter===2?b:filter===3?Math.floor((a+b)/2):paeth(a,b,c)))&255;}}
 return{w,h,channels,pixels};
}
const table=Array.from({length:256},(_,n)=>{for(let j=0;j<8;j++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0});
function chunk(name,data){const b=Buffer.concat([Buffer.from(name),data]);let c=0xffffffff;for(const v of b)c=table[(c^v)&255]^(c>>>8);const a=Buffer.alloc(4),z=Buffer.alloc(4);a.writeUInt32BE(data.length);z.writeUInt32BE((c^0xffffffff)>>>0);return Buffer.concat([a,b,z]);}
function encode(p,size,channels){const head=Buffer.alloc(13);head.writeUInt32BE(size);head.writeUInt32BE(size,4);head[8]=8;head[9]=channels===3?2:6;const row=size*channels,raw=Buffer.alloc((row+1)*size);for(let y=0;y<size;y++)p.copy(raw,y*(row+1)+1,y*row,(y+1)*row);return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',head),chunk('IDAT',deflateSync(raw,{level:9})),chunk('IEND',Buffer.alloc(0))]);}
const decoded=decode(source);assert.equal(decoded.w,provenance.width);assert.equal(decoded.h,provenance.height);
// Normalize implicit source alpha without changing any RGB byte. Every frame is RGBA8.
const original={...decoded,channels:4,pixels:Buffer.alloc(decoded.w*decoded.h*4)};
for(let i=0;i<decoded.w*decoded.h;i++){
 decoded.pixels.copy(original.pixels,i*4,i*decoded.channels,i*decoded.channels+3);
 original.pixels[i*4+3]=decoded.channels===4?decoded.pixels[i*4+3]:255;
}
fs.mkdirSync(out);const iconset=out+'/AppIcon.iconset';fs.mkdirSync(iconset);
const rows=[];
for(const base of [16,32,128,256,512])for(const scale of [1,2]){
 const size=base*scale,pixels=Buffer.alloc(size*size*original.channels);
 for(let y=0;y<size;y++)for(let x=0;x<size;x++){
  const sx=Math.min(original.w-1,Math.floor((x+0.5)*original.w/size)),sy=Math.min(original.h-1,Math.floor((y+0.5)*original.h/size));
  const from=(sy*original.w+sx)*original.channels;original.pixels.copy(pixels,(y*size+x)*original.channels,from,from+original.channels);
 }
 const file=`icon_${base}x${base}${scale===2?'@2x':''}.png`,png=encode(pixels,size,original.channels);
 fs.writeFileSync(iconset+'/'+file,png);assert.deepEqual(decode(png).pixels,pixels);
 rows.push({file,width:size,height:size,sha256:hash(png),sampling:'nearest source texel at destination pixel center; exact source RGB(A)'});
}
// Keep exact PNG payloads wherever Icon Services supports them. Its16/32 slots
// require ARGB; encode literal-only channel runs ourselves to avoid iconutil's
// truncating compressed-blue tail. No quantization or color conversion occurs.
const types=['ic04','ic11','ic05','ic12','ic07','ic13','ic08','ic14','ic09','ic10'];
function literalARGB(png){
 const image=decode(png),parts=[Buffer.from('ARGB')],count=image.w*image.h;
 for(const channel of [3,0,1,2])for(let start=0;start<count;start+=128){
  const n=Math.min(128,count-start),part=Buffer.alloc(n+1);part[0]=n-1;
  for(let i=0;i<n;i++)part[i+1]=image.pixels[(start+i)*4+channel];parts.push(part);
 }
 // Apple's16/32 extractor reads ahead at the end of the final channel. Termination
 // padding is not pixel data; all expected channel samples precede it.
 parts.push(Buffer.alloc(4));
 return Buffer.concat(parts);
}
const records=rows.map((row,i)=>{const png=fs.readFileSync(iconset+'/'+row.file),bytes=(i===0||i===2)?literalARGB(png):png,head=Buffer.alloc(8);head.write(types[i],0,4,'ascii');head.writeUInt32BE(bytes.length+8,4);return Buffer.concat([head,bytes]);});
const head=Buffer.alloc(8);head.write('icns',0,4,'ascii');head.writeUInt32BE(8+records.reduce((n,b)=>n+b.length,0),4);
fs.writeFileSync(out+'/AppIcon.icns',Buffer.concat([head,...records]));
fs.writeFileSync(out+'/icon-provenance.json',JSON.stringify({source:provenance,container:'ICNS:8 exact PNG payloads plus2 literal-only ARGB representations, preserving every source RGBA byte',icons:rows,icnsSha256:hash(fs.readFileSync(out+'/AppIcon.icns'))},null,2)+'\n');console.log(out+'/AppIcon.icns');
