// Reproducible local component packaging; never installs, uploads or invokes notarization.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';
if (process.platform !== 'darwin') throw Error('Local native packaging requires macOS');
const args = process.argv.slice(2), value = flag => args[args.indexOf(flag) + 1];
const build = value('--from-build'), output = value('--output');
if (!args.includes('--from-build') || !args.includes('--output') || !path.isAbsolute(build) || !path.isAbsolute(output) || !output.startsWith('/private/tmp/')) throw Error('Use --from-build ABSOLUTE_SAFE_BUILD --output NEW_/private/tmp/DIRECTORY');
if (fs.existsSync(output)) throw Error('Output must not exist');
const identity = args.includes('--identity') ? value('--identity') : '-';
if (identity !== '-' && !identity.startsWith('Developer ID Application:')) throw Error('Only an explicit Developer ID Application identity is accepted for distribution signing');
const manifest = JSON.parse(fs.readFileSync(path.join(build, 'provenance.json')));
const snapshot = path.join(build, 'source-snapshot');
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
for (const [name, digest] of Object.entries(manifest.source)) if (hash(fs.readFileSync(path.join(snapshot, name))) !== digest) throw Error('Source snapshot mismatch');
for (const [name, digest] of Object.entries(manifest.bundle ?? {})) if (hash(fs.readFileSync(path.join(build, name))) !== digest) throw Error('Input bundle mismatch');
if (manifest.source['native/scripts/package-local.mjs'] !== hash(fs.readFileSync(fileURLToPath(import.meta.url)))) throw Error('Run the package entry matching the immutable source snapshot');
const {productionSwift, productionResources, excludedSymbols, excludedStrings} = await import(pathToFileURL(path.join(snapshot,'native/scripts/production-inputs.mjs')));
const packageFile = path.join(snapshot, 'package.json');
const version = JSON.parse(fs.readFileSync(packageFile)).version;
const numeric = version.match(/^\d+\.\d+\.\d+/)?.[0];
if (!numeric || !/^[0-9A-Za-z.+-]+$/.test(version)) throw Error('Invalid package version');
fs.mkdirSync(output, {recursive: true});
const app = path.join(output, 'Peras.app'), contents = path.join(app, 'Contents');
fs.mkdirSync(path.join(contents, 'MacOS'), {recursive: true});
const resources = path.join(contents,'Resources');
fs.mkdirSync(resources);
const previewResources = path.join(build,'PerasNativePreview.app/Contents/Resources');
const selectedResources = productionResources(JSON.parse(fs.readFileSync(path.join(previewResources,'atlas.json'))));
for (const name of selectedResources) {
 const relative = 'PerasNativePreview.app/Contents/Resources/' + name;
 if (!manifest.bundle[relative]) throw Error('Unrecorded production resource');
 fs.copyFileSync(path.join(previewResources,name), path.join(resources,name));
}
const env = Object.fromEntries(['HOME','PERAS_HOME','CLAUDE_CONFIG_DIR','CODEX_HOME','PERAS_SWIFTBAR_DIR','PATH'].map(k => [k, process.env[k]]));
for (const k of ['HOME','PERAS_HOME','CLAUDE_CONFIG_DIR','CODEX_HOME','PERAS_SWIFTBAR_DIR']) if (!env[k]?.startsWith(build + '/')) throw Error('Use the safe build root isolated environment');
function run(exe, argv) {
 const result = spawnSync(exe, argv, {env, cwd:snapshot, encoding:'utf8', timeout:180_000, maxBuffer:1024*1024});
 if (result.status !== 0) throw Error(`${path.basename(exe)} failed: ${result.stderr || result.error?.message || result.status}`);
}
for (const file of productionSwift) if (!manifest.source[file]) throw Error('Missing production source');
const sources = productionSwift.map(n=>path.join(snapshot,n));
run(process.execPath,[path.join(snapshot,'native/scripts/build-icon.mjs'),path.join(output,'icon-build')]);
fs.copyFileSync(path.join(output,'icon-build/AppIcon.icns'),path.join(resources,'AppIcon.icns'));
for (const arch of ['arm64','x86_64']) run('/usr/bin/swiftc', ['-O','-D','PERAS_PRODUCTION','-module-name','Peras','-target',`${arch}-apple-macos13.0`,'-module-cache-path',path.join(output,'module-cache'),...sources,'-o',path.join(output,`Peras-${arch}`)]);
run('/usr/bin/lipo', ['-create',path.join(output,'Peras-arm64'),path.join(output,'Peras-x86_64'),'-output',path.join(contents,'MacOS/Peras')]);
fs.writeFileSync(path.join(contents,'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>CFBundleExecutable</key><string>Peras</string><key>CFBundleIdentifier</key><string>eu.vertias.peras.native</string><key>CFBundleName</key><string>Peras</string><key>CFBundleDisplayName</key><string>Peras</string><key>CFBundleIconFile</key><string>AppIcon</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>${numeric}</string><key>CFBundleShortVersionString</key><string>${numeric}</string><key>PerasRuntimeVersion</key><string>${version}</string><key>LSMinimumSystemVersion</key><string>13.0</string><key>NSPrincipalClass</key><string>NSApplication</string><key>LSUIElement</key><true/></dict></plist>\n`);
const binary=path.join(contents,'MacOS/Peras');
const symbols=spawnSync('/usr/bin/nm',['-j',binary],{encoding:'utf8',timeout:10000,maxBuffer:16*1024*1024});
const strings=spawnSync('/usr/bin/strings',['-a',binary],{encoding:'utf8',timeout:10000,maxBuffer:16*1024*1024});
if(symbols.status!==0 || strings.status!==0) throw Error('Production binary audit unavailable');
for(const name of excludedSymbols) if(symbols.stdout.includes(name)) throw Error('Excluded diagnostic symbol in production: '+name);
if(/5Probe[CV]/.test(symbols.stdout)) throw Error('Diagnostic Probe type remains in production');
for(const value of excludedStrings) if(strings.stdout.includes(value)) throw Error('Excluded diagnostic string in production: '+value);
if(fs.existsSync(path.join(resources,'fixtures'))) throw Error('Fixture resources remain in production');
// HOME is the build's throwaway home here, so a Developer ID is looked up in the account's own login keychain.
const keychain = path.join(os.userInfo().homedir, 'Library/Keychains/login.keychain-db');
run('/usr/bin/codesign', ['--force','--sign',identity,...(identity==='-'?[]:['--options','runtime','--timestamp','--keychain',keychain]),app]);
run('/usr/bin/codesign', ['--verify','--deep','--strict',app]);
const walk = d => fs.readdirSync(d,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(d,e.name)):[path.join(d,e.name)]);
fs.writeFileSync(path.join(output,'package-provenance.json'),JSON.stringify({version, bundleID:'eu.vertias.peras.native', signing:identity==='-'?'adhoc-local-only':'Developer ID; notarization not performed', architectures:['arm64','x86_64'],minimumOS:'13.0',compiledSources:productionSwift,resourceNames:[...selectedResources,'AppIcon.icns'],icon:JSON.parse(fs.readFileSync(path.join(output,'icon-build/icon-provenance.json'))),productionAudit:{excludedSymbols,excludedStrings,passed:true},secureTimestamp:identity!=='-',notarized:false,source:manifest.source,packageJsonSha256:hash(fs.readFileSync(packageFile)),bundle:Object.fromEntries(walk(app).map(f=>[path.relative(output,f),hash(fs.readFileSync(f))]))},null,2)+'\n');
console.log(app);
