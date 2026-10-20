import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const [runRoot, mode = 'snapshot'] = process.argv.slice(2);
if (!runRoot || !path.isAbsolute(runRoot)) throw new Error('An absolute scratch run root is required');
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
const walk = dir => fs.readdirSync(dir, {withFileTypes: true}).flatMap(e => e.isDirectory() ? (e.name === 'reviews' ? [] : walk(path.join(dir, e.name))) : [path.join(dir, e.name)]);
if (mode === 'snapshot') {
  const files = [...walk(path.join(root, 'native')).filter(f => f.endsWith('.swift') || f.endsWith('.mjs') || path.basename(f).startsWith('AppIcon-')), path.join(root, 'package.json'), path.join(root, 'script/build_and_run.sh'), path.join(root, 'src/mascot-atlas.json'), path.join(root, 'src/menubar-atlas.json'), ...walk(path.join(root, 'test/fixtures/native-v1'))];
  const backend = Object.fromEntries(walk(path.join(root,'src')).filter(f=>!f.endsWith('.sh')).map(f=>[path.relative(root,f),hash(fs.readFileSync(f))]));
  const manifest = {createdAt: new Date().toISOString(), backend, source: {}};
  for (const file of files) {
    const relative = path.relative(root, file), data = fs.readFileSync(file), target = path.join(runRoot, 'source-snapshot', relative);
    fs.mkdirSync(path.dirname(target), {recursive: true}); fs.writeFileSync(target, data);
    manifest.source[relative] = hash(data);
  }
  fs.writeFileSync(path.join(runRoot, 'provenance.json'), JSON.stringify(manifest, null, 2) + '\n');
} else {
  const file = path.join(runRoot, 'provenance.json'), manifest = JSON.parse(fs.readFileSync(file));
  manifest.bundle = Object.fromEntries(walk(path.join(runRoot, 'PerasNativePreview.app')).map(f => [path.relative(runRoot, f), hash(fs.readFileSync(f))]));
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n');
}
