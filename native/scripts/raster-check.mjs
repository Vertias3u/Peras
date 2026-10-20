// Dependency-free PNG unfilter + exact opaque-pixel comparison for the own-layer proof.
import fs from 'node:fs';
import {inflateSync} from 'node:zlib';
import assert from 'node:assert/strict';
import {nearestTexels} from './nearest-texel.mjs';
function png(file){
 const b=fs.readFileSync(file),w=b.readUInt32BE(16),h=b.readUInt32BE(20),depth=b[24],type=b[25],channels=type===6?4:type===2?3:0;
 assert.equal(depth,8);assert.ok(channels);assert.equal(b[28],0,'noninterlaced proof');
 const chunks=[];for(let offset=8;offset<b.length;){const n=b.readUInt32BE(offset),name=b.toString('ascii',offset+4,offset+8);if(name==='IDAT')chunks.push(b.subarray(offset+8,offset+8+n));offset+=n+12;}
 const raw=inflateSync(Buffer.concat(chunks)),pixels=Buffer.alloc(w*h*channels),rowBytes=w*channels;
 const paeth=(a,b,c)=>{const p=a+b-c,da=Math.abs(p-a),db=Math.abs(p-b),dc=Math.abs(p-c);return da<=db&&da<=dc?a:db<=dc?b:c;};
 for(let y=0;y<h;y++){const filter=raw[y*(rowBytes+1)];assert.ok(filter<=4);for(let x=0;x<rowBytes;x++){const i=y*rowBytes+x,a=x>=channels?pixels[i-channels]:0,b=y?pixels[i-rowBytes]:0,c=y&&x>=channels?pixels[i-rowBytes-channels]:0;pixels[i]=(raw[y*(rowBytes+1)+1+x]+(filter===0?0:filter===1?a:filter===2?b:filter===3?Math.floor((a+b)/2):paeth(a,b,c)))&255;}}
 return{w,h,channels,pixels};
}
const output=process.argv[2], resources=process.argv[3];
assert.ok(output && resources, 'usage: raster-check.mjs EVIDENCE_DIR RESOURCES_DIR');
const info=JSON.parse(fs.readFileSync(output+'/layer-render-info.json','utf8'));
const image = png(output + '/layer-render-2x.png');
const rows = [];
let checked = 0;
function compare(rendered, kind, covered = new Set()) {
  const source = png(resources + '/' + rendered.file);
  const width = rendered.pixel_width, height = rendered.pixel_height;
  const originX = rendered.pixel_x, originY = rendered.pixel_y;
  for (const value of [width, height, originX, originY]) assert.ok(Number.isInteger(value), 'pixel-aligned proof geometry');
  assert.ok(width > 0 && height > 0);
  assert.ok(originX >= 0 && originY >= 0 && originX + width <= image.w && originY + height <= image.h, 'visible frame stays inside the proof');
  let count = 0, mismatches = 0, exactBoundaryPixels = 0, alternateBoundaryMatches = 0, coveredByCup = 0;
  const rgba = (png, x, y) => {
    const index = (y * png.w + x) * png.channels;
    return [png.pixels[index], png.pixels[index + 1], png.pixels[index + 2], png.channels === 4 ? png.pixels[index + 3] : 255];
  };
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const candidates = nearestTexels(x, y, source.w, source.h, width, height, rendered.flip);
    const expected = candidates.map(([sx, sy]) => rgba(source, sx, sy));
    // Preserve existing opaque-source coverage. Every non-tie has ONE permitted
    // exact RGBA. At a rational tie only equally-near texels' exact RGBA may match.
    if (expected[0][3] !== 255) continue;
    if (covered.has((originX + x) + ',' + (originY + y))) { coveredByCup++; continue; }
    const actual = rgba(image, originX + x, originY + y);
    const exact = expected.map(pixel => pixel.every((channel, index) => channel === actual[index]));
    if (candidates.length > 1) exactBoundaryPixels++;
    if (!exact.some(Boolean)) mismatches++;
    else if (!exact[0]) alternateBoundaryMatches++;
    count++;
  }
  rows.push({kind, provider: rendered.provider, rail_points: rendered.rail_points,
    source_width: source.w, source_height: source.h, rendered_width: width,
    rendered_height: height, opaque_pixels: count, mismatches, exact_boundary_pixels: exactBoundaryPixels, alternate_boundary_matches: alternateBoundaryMatches, covered_by_cup: coveredByCup});
  checked += count;
}
const cups = info.cups ?? [];
const visibleCups = cups.filter(cup => cup.opacity === 1);
// A held cup is drawn above its mascot, its handle over the paw. Mascot pixels under a cup pixel
// that is opaque for every equally-near texel are the cup's to prove, not the mascot's.
const covered = new Set();
for (const cup of visibleCups) {
  const source = png(resources + '/' + cup.file);
  for (let y = 0; y < cup.pixel_height; y++) for (let x = 0; x < cup.pixel_width; x++) {
    const texels = nearestTexels(x, y, source.w, source.h, cup.pixel_width, cup.pixel_height, cup.flip);
    if (texels.every(([sx, sy]) => source.pixels[(sy * source.w + sx) * source.channels + 3] === 255)) covered.add((cup.pixel_x + x) + ',' + (cup.pixel_y + y));
  }
}
for (const sprite of info.sprites) compare(sprite, 'mascot', covered);
for (const cup of visibleCups) compare(cup, 'cup');
const result = {ok: rows.every(row => row.mismatches === 0), scale: 2,
  opaque_pixels_checked: checked, skipped_translucent_or_hidden_cups: cups.length - visibleCups.length,
  rows, method: 'Own Core Animation layer-tree PNG compared to exact nearest original opaque-frame RGBA, allowing only mathematically equal-distance boundary texels; no desktop capture, optical observation or external-display claim'};
fs.writeFileSync(output + '/raster-verification.json', JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
assert.ok(result.ok);
