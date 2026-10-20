import fs from 'node:fs';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {mascotFrame} from '../../src/mascots.mjs';
const [evidence, resources] = process.argv.slice(2);
assert.ok(evidence && resources, 'usage: verify-patrol.mjs EVIDENCE_DIR RESOURCES_DIR');
const atlas = JSON.parse(fs.readFileSync(resources + '/atlas.json'));
const hashes = new Map(Object.values(atlas.providers).flatMap(p => [...p.right, ...(p.left ?? []), p.idle]).map(f => [f.file, f.sha256]));
const {samples} = JSON.parse(fs.readFileSync(evidence + '/patrol-samples.json'));
for (const row of samples) {
  const frame = mascotFrame(row.provider, row.time, {trackWidth: 640});
  assert.equal(row.x, frame.x);
  assert.equal(row.flip, Boolean(frame.flip));
  assert.equal(hashes.get(row.file), crypto.createHash('sha256').update(frame.pixels).digest('hex'));
}
console.log(`${samples.length} native patrol samples match original timing, pixels, orientation and position`);
