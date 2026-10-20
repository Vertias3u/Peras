// Launch an already built development app without recompiling or changing its bundle.
// Probe sub-flags pass through as app flags, e.g. `--keyboard-probe OUT --ax-export --fixture normal-usage`,
// `--keyboard-probe OUT --race-only`, `--desktop-probe OUT --spaces`, `--desktop-probe OUT --fullscreen` (needs another
// app already full screen and in front; it never creates one); add `--direct` for --ax-export.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const [runRoot, mode = 'run', output = path.join(runRoot ?? '', 'gui-evidence'), ...flags] = process.argv.slice(2);
// --direct execs the app binary as a child of this shell instead of LaunchServices `open`. Only the
// --ax-export probe needs it: a direct child inherits the shell's existing accessibility trust, which
// the probe uses to read its own pid. It never requests trust.
const direct = flags.includes('--direct'), extra = flags.filter(flag => flag !== '--direct');
if (!runRoot || !path.isAbsolute(runRoot)) throw new Error('usage: launch-built.mjs ABSOLUTE_RUN_ROOT [run|--probe|--benchmark|--keyboard-probe|--desktop-probe|--menu-probe] [OUTPUT] [app flags]');
const configuration = JSON.parse(fs.readFileSync(path.join(runRoot, 'bridge-config.json')));
// Probes run in UTC; PERAS_LAUNCH_TZ draws a probe in another zone (the site's picture uses the demo week's).
if (process.env.PERAS_LAUNCH_TZ) configuration.environment.TZ = process.env.PERAS_LAUNCH_TZ;
if (!fs.realpathSync(runRoot).startsWith('/private/tmp/')) throw new Error('A dedicated scratch runtime is required');
const args = ['-n', ...(mode === 'run' ? [] : ['-W'])];
for (const [key, value] of Object.entries(configuration.environment)) args.push('--env', key + '=' + value);
const app = path.join(runRoot, 'PerasNativePreview.app');
args.push(app, '--args', '--root', configuration.environment.PERAS_HOME, '--bridge-config', path.join(runRoot, 'bridge-config.json'), '--output', output);
if (mode !== 'run') args.push(mode);
args.push(...extra);
// A probe that never terminates must not outlive its launch: after PERAS_LAUNCH_TIMEOUT_MS (default
// 180 s) the same-root preview is asked to stop through its own --stop path, never by process name.
const timeout = mode === 'run' ? undefined : Number(process.env.PERAS_LAUNCH_TIMEOUT_MS ?? 180000);
const binary = path.join(app, 'Contents/MacOS/PerasNativePreview');
const result = direct
  ? spawnSync(binary, args.slice(args.indexOf('--args') + 1), {stdio: 'inherit', timeout, env: configuration.environment})
  : spawnSync('/usr/bin/open', args, {stdio: 'inherit', timeout});
if (result.error?.code === 'ETIMEDOUT') {
  spawnSync(binary, ['--stop', '--root', configuration.environment.PERAS_HOME],
    {stdio: 'inherit', env: {...process.env, ...configuration.environment}, timeout: 10000});
  console.error('launch-built: probe timed out after ' + timeout + ' ms; asked the preview to stop');
  process.exitCode = 124;
} else {
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
