// Notarizes a Developer ID-signed Peras.app from package-local.mjs, staples it and zips it for the GitHub release.
// Uploads to Apple's notary service with the owner's keychain profile; never signs, installs or publishes.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
if (process.platform !== 'darwin') throw Error('Notarizing requires macOS');
const args = process.argv.slice(2), value = flag => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
const app = value('--app'), output = value('--output'), profile = value('--profile') ?? 'peras';
if (!app || !output || !path.isAbsolute(app) || !path.isAbsolute(output) || path.basename(app) !== 'Peras.app') throw Error('Use --app ABSOLUTE/Peras.app --output NEW_DIRECTORY [--profile KEYCHAIN_PROFILE]');
if (fs.existsSync(output)) throw Error('Output must not exist');
const run = (cmd, argv, {allow = false} = {}) => {
  const result = spawnSync(cmd, argv, {encoding: 'utf8'});
  if (result.status !== 0 && !allow) throw Error(`${path.basename(cmd)} failed:\n${result.stdout}${result.stderr}`);
  return result;
};
// Apple refuses an upload without hardened runtime and a secure timestamp, so check before sending anything.
const described = run('/usr/bin/codesign', ['-dvv', app]).stderr;
if (!/^Authority=Developer ID Application:/m.test(described)) throw Error('Peras.app is not signed with a Developer ID Application identity: package it with --identity first');
if (!/flags=0x[0-9a-f]*\(runtime\)/.test(described)) throw Error('Peras.app was signed without the hardened runtime');
if (!/^Timestamp=/m.test(described)) throw Error('Peras.app was signed without a secure timestamp');
run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
fs.mkdirSync(output, {recursive: true});
const upload = path.join(output, 'upload.zip');
run('/usr/bin/ditto', ['-c', '-k', '--keepParent', app, upload]);
console.log('Uploading to Apple’s notary service; this usually takes a few minutes…');
const submitted = run('/usr/bin/xcrun', ['notarytool', 'submit', upload, '--keychain-profile', profile, '--wait', '--output-format', 'json'], {allow: true});
const verdict = JSON.parse(submitted.stdout || '{}');
fs.writeFileSync(path.join(output, 'notary-submit.json'), JSON.stringify(verdict, null, 2) + '\n');
if (verdict.status !== 'Accepted') {
  if (verdict.id) fs.writeFileSync(path.join(output, 'notary-log.json'), run('/usr/bin/xcrun', ['notarytool', 'log', verdict.id, '--keychain-profile', profile], {allow: true}).stdout);
  throw Error(`Notarization ${verdict.status ?? 'failed'}${verdict.id ? ` (${verdict.id}); Apple's log is in ${path.join(output, 'notary-log.json')}` : `:\n${submitted.stdout}${submitted.stderr}`}`);
}
fs.rmSync(upload);
run('/usr/bin/xcrun', ['stapler', 'staple', app]);
run('/usr/bin/xcrun', ['stapler', 'validate', app]);
const assessed = run('/usr/sbin/spctl', ['--assess', '--type', 'execute', '-vv', app], {allow: true});
if (assessed.status !== 0 || !/source=Notarized Developer ID/.test(assessed.stderr)) throw Error(`Gatekeeper does not accept the stapled app:\n${assessed.stderr}`);
const zip = path.join(output, 'Peras.zip');
run('/usr/bin/ditto', ['-c', '-k', '--keepParent', app, zip]);
const digest = crypto.createHash('sha256').update(fs.readFileSync(zip)).digest('hex');
fs.writeFileSync(path.join(output, 'Peras.zip.sha256'), `${digest}  Peras.zip\n`);
console.log(`${zip}\nsha256 ${digest}\nNotarized (${verdict.id}), stapled and accepted by Gatekeeper. Attach Peras.zip to the GitHub release.`);
