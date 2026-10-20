import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sandbox, VERSION } from './helpers.mjs';
import { installRuntime } from '../src/runtime-install.mjs';
import { main } from '../src/cli.mjs';
import { writeInstall } from '../src/store.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
for (const platform of [process.platform, 'win32']) test(`F3 doctor follows the ${platform} entry and ignores retained legacy metadata`, async () => {
 const { env } = sandbox(), app = path.join(env.PERAS_HOME, 'app');
 fs.mkdirSync(path.join(app, 'src'), { recursive: true });
 fs.writeFileSync(path.join(app, 'src', 'legacy.mjs'), '// old lazy import');
 fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: 'peras-cli', version: '0.3.2' }));
 const bin = installRuntime(env, ROOT, { platform });
 // A stale installation record is not evidence of which runtime the entry now loads.
 writeInstall(env, { version: '0.3.2', command: `"${process.execPath}" "${bin}" hook` });
 const lines = [];
 await main(['doctor'], { env, out: line => lines.push(line) });
 const output = lines.join('\n');
 assert.ok(output.includes(`runtime Peras ${VERSION} at `), output);
 assert.match(output, /runtimes[/\\]runtime-/);
 assert.doesNotMatch(output, /hooks run Peras 0\.3\.2/);
 if (platform !== 'win32') assert.equal(JSON.parse(fs.readFileSync(path.join(app, 'package.json'))).version, '0.3.2');
 assert.equal(fs.readFileSync(path.join(app, 'src', 'legacy.mjs'), 'utf8'), '// old lazy import');
});

test('F3 doctor reports unreadable resolved runtime metadata as a diagnostic', async () => {
 const { env } = sandbox(), bin = installRuntime(env, ROOT);
 const resolved = fs.realpathSync(bin);
 fs.writeFileSync(path.join(path.dirname(path.dirname(resolved)), 'package.json'), '{');
 const lines = [];
 assert.equal(await main(['doctor'], { env, out: line => lines.push(line) }), 1);
 assert.match(lines.join('\n'), /runtime version is unreadable.*peras setup/);
});
