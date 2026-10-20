// Development/test bootstrap. It NEVER starts the real Codex executable.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const [input, scenario = 'normal'] = process.argv.slice(2);
if (!input || !path.isAbsolute(input) || !['normal', 'daily-exhausted', 'missing-setup'].includes(scenario)) throw new Error('Pass an absolute scratch root and known scenario');
if (input.split('/').some(component => component === '.' || component === '..')) throw new Error('Dot path components are forbidden');
if (!input.startsWith('/private/tmp/') && !input.startsWith('/tmp/')) throw new Error('A dedicated tmp subdirectory is required');
let ancestor = input; const missing = [];
while (!fs.existsSync(ancestor)) { missing.unshift(path.basename(ancestor)); const parent=path.dirname(ancestor); if(parent===ancestor) throw new Error('No existing scratch ancestor'); ancestor=parent; }
const root = path.join(fs.realpathSync(ancestor), ...missing);
if (!root.startsWith('/private/tmp/') || root === '/private/tmp/') throw new Error('Native development runtime must be a dedicated directory under /private/tmp');
// Validate existing state/home paths before any mutation, including nested symlink escapes.
function inspect(candidate) {
  const stat=fs.lstatSync(candidate);
  if(stat.isSymbolicLink()) { const resolved=fs.realpathSync(candidate); if(resolved!==root && !resolved.startsWith(root+'/')) throw new Error('Scratch symlink escapes its dedicated root'); }
  else if(stat.isDirectory()) for(const name of fs.readdirSync(candidate)) inspect(path.join(candidate,name));
}
if (fs.existsSync(root)) inspect(root);
fs.mkdirSync(root, {recursive: true});
for (const dir of ['home', 'state', 'claude', 'codex-home', 'swiftbar', 'fake-bin', 'module-cache']) fs.mkdirSync(path.join(root, dir), {recursive: true});
const node = fs.realpathSync(process.execPath), cli = path.join(repository, 'bin/peras.mjs');
const fakeCodex = path.join(root, 'fake-bin/codex'), log = path.join(root, 'fake-codex-executed.jsonl');
if (node.includes('\n') || node.includes(' ')) throw new Error('Node shebang needs a whitespace-free absolute executable');
fs.writeFileSync(fakeCodex, `#!${node}\n` + String.raw`
// CLEARLY FAKE CODEX. Illustrative local account meters only. No credentials/network/models.
const fs = require('node:fs');
const readline = require('node:readline');
const log = process.env.PERAS_NATIVE_FAKE_CODEX_LOG;
const record = event => fs.appendFileSync(log, JSON.stringify({executable: fs.realpathSync(process.argv[1]), argv: process.argv.slice(2), ...event}) + '\n');
record({event: 'exec'});
if (process.argv[2] !== 'app-server') process.exit(64);
readline.createInterface({input: process.stdin}).on('line', line => {
  let request; try { request = JSON.parse(line); } catch { process.exit(65); }
  record({event: 'method', method: request.method});
  if (request.method === 'initialized' && request.id === undefined) return;
  let result;
  if (request.method === 'initialize') result = {userAgent: 'Peras Native SYNTHETIC fixture'};
  else if (request.method === 'account/rateLimits/read') result = {rateLimits: {primary: {usedPercent: 12, windowDurationMins: 300, resetsAt: Math.floor(Date.now()/1000)+7200}, secondary: {usedPercent: 34, windowDurationMins: 10080, resetsAt: Math.floor(Date.now()/1000)+259200}}};
  else { process.stdout.write(JSON.stringify({id: request.id, error: {code: -32601, message: 'Fake Codex only serves fixture meter methods'}})+'\n'); process.exitCode=64; return; }
  process.stdout.write(JSON.stringify({id: request.id, result})+'\n');
});
`, {mode: 0o700});
const environment = {HOME: path.join(root, 'home'), PERAS_HOME: path.join(root, 'state'), CLAUDE_CONFIG_DIR: path.join(root, 'claude'), CODEX_HOME: path.join(root, 'codex-home'), PERAS_SWIFTBAR_DIR: path.join(root, 'swiftbar'), PATH: [path.dirname(fakeCodex), path.dirname(node), '/usr/bin', '/bin'].join(':'), PERAS_NO_NOTIFY: '1', LANG: 'en_US.UTF-8', TZ: 'UTC', PERAS_NATIVE_FAKE_CODEX_LOG: log};
const config = {node, cli, environment, fakeCodex};
fs.writeFileSync(path.join(root, 'bridge-config.json'), JSON.stringify(config, null, 2)+'\n', {mode: 0o600});
// Seed only a fresh isolated runtime; re-opening must preserve the user's scratch changes.
const marker = path.join(root, 'seeded-runtime.json');
if (!fs.existsSync(marker) && scenario !== 'missing-setup') {
  const {install} = await import(path.join(repository, 'src/settings.mjs'));
  const {installCodex, codexEnv} = await import(path.join(repository, 'src/codex.mjs'));
  const {recordReading} = await import(path.join(repository, 'src/store.mjs'));
  const {writeBudgetRules} = await import(path.join(repository, 'src/allowances.mjs'));
  const version = JSON.parse(fs.readFileSync(path.join(repository, 'package.json'))).version;
  const hook = JSON.stringify(node)+' '+JSON.stringify(cli);
  install({env: environment, command: hook, version});
  installCodex(environment, hook);
  const now = Date.now(), reading = (five, seven, time) => ({five_hour: {usedPct: five, resetsAt: Math.floor(now/1000)+7200, seenAt: time}, seven_day: {usedPct: seven, resetsAt: Math.floor(now/1000)+259200, seenAt: time}});
  if (scenario === 'daily-exhausted') {
    writeBudgetRules(environment, [{period: 'daily', at: 10, action: 'pause', createdAt: now-3*3600000}]);
    // Synthetic sequential readings belong to the same day, including just after midnight.
    recordReading(environment, reading(20, 36, now));
  }
  recordReading(environment, reading(32, 48, now));
  recordReading(codexEnv(environment), reading(12, 34, now));
  fs.writeFileSync(marker, JSON.stringify({scenario, version, synthetic: true, fakeCodex}, null, 2)+'\n');
}
console.log(JSON.stringify({root, config: path.join(root, 'bridge-config.json'), fakeCodex, scenario}));
