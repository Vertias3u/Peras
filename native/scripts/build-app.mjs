// Builds Peras.app from this checkout, for anyone who would rather compile it than buy it.
//   npm run build:app
// Runs the native build and its checks in a throwaway /private/tmp folder, then packages the
// universal app with a local signature. A locally built app was never downloaded, so macOS opens it
// on this Mac; `peras menubar install --native --app <path>` installs it like the bought one.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
if (process.platform !== 'darwin') throw Error('The Peras app builds on macOS only.');
if (spawnSync('/usr/bin/xcrun', ['--find', 'swiftc'], {encoding: 'utf8'}).status !== 0) throw Error('Swift is missing: run `xcode-select --install`, then try again.');
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const work = fs.mkdtempSync('/private/tmp/peras-app-build-'), build = path.join(work, 'build'), output = path.join(work, 'package');
const step = (label, command, args, env = process.env) => {
  console.log(label);
  const result = spawnSync(command, args, {cwd: repo, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024});
  fs.appendFileSync(path.join(work, 'build.log'), `$ ${command} ${args.join(' ')}\n${result.stdout ?? ''}${result.stderr ?? ''}\n`);
  if (result.status !== 0) throw Error(`${label.replace(/…$/, '')} failed; the log is in ${path.join(work, 'build.log')}`);
};
step('Building and checking the app (a few minutes)…', path.join(repo, 'script/build_and_run.sh'), ['--headless'], {...process.env, PERAS_NATIVE_RUN_ROOT: build});
// The packager only reads a build made in an isolated home, the one build_and_run.sh just used.
const isolated = {...process.env, HOME: path.join(build, 'home'), PERAS_HOME: path.join(build, 'state'), CLAUDE_CONFIG_DIR: path.join(build, 'claude'),
  CODEX_HOME: path.join(build, 'codex-home'), PERAS_SWIFTBAR_DIR: path.join(build, 'swiftbar')};
step('Packaging Peras.app…', process.execPath, ['native/scripts/package-local.mjs', '--from-build', build, '--output', output], isolated);
const app = path.join(output, 'Peras.app');
console.log(`\nBuilt ${app}\nSigned for this Mac only. Install it with:\n\n  peras menubar install --native --app ${app}\n`);
