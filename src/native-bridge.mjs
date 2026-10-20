// `peras menubar bridge --protocol 1`: the native app's one child process.
// stdout carries JSON lines only (hello, snapshots, results); stdin carries commands.
import crypto from "node:crypto";
import readline from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { codexEnv } from "./codex.mjs";
import { releaseMonitor, runMonitor } from "./monitor.mjs";
import { announceBridge, retireBridge } from "./native-app.mjs";
import { runOperation } from "./native-operations.mjs";
import { LIMITS, NOT_READY, ProtocolError, digest, discoveryPayload, helloMessage, parseCommand, providerPayload, resultMessage, settingsPayload, snapshotMessage, tokenSigner } from "./native-protocol.mjs";
import { snapshot } from "./providers.mjs";
import { perasHome, readInstall, readWindow } from "./store.mjs";

const CACHE = 64;

/** Both providers as the app sees them: judged with no folder, like the hooks' global rules. */
export async function nativePayloads(env, now, { reader, signer, notReady = NOT_READY, monitor = () => {} }) {
  const scoped = codexEnv(env);
  let hasReading = false;
  try { hasReading = Boolean(readWindow(scoped)); } catch { /* the payload reports it */ }
  const claude = await snapshot(env, now, { cwd: null });
  const codex = await snapshot(env, now, { provider: "codex", cwd: null, refresh: Boolean(readInstall(scoped) || hasReading), reader, adaptive: true });
  // Reminders ride on the same reading; they never cost the app its snapshot.
  try { monitor([claude, codex], now); } catch { /* next refresh */ }
  return [claude, codex].map((s) => providerPayload(s, { now, sign: signer.sign, notReady }));
}

export async function runBridge({
  env, input, output, runtimeVersion, signal, reader,
  clock = Date.now, intervalMs = 1000,
  bridgeInstance = crypto.randomUUID(),
  signer = tokenSigner(), notReady = NOT_READY,
  // Reset and unused-allowance reminders, when this bridge holds the monitor lease.
  monitor = (snapshots, now) => runMonitor(env, snapshots, now, { id: bridgeInstance, owner: "app" }),
  getPayloads = (now) => nativePayloads(env, now, { reader, signer, notReady, monitor }),
  getSettings = (now) => settingsPayload(env, { now, sign: signer.sign }),
  getDiscovery = (now, providers) => discoveryPayload(env, providers, { now, sign: signer.sign }),
  diagnose = (text) => process.stderr.write(`${text}\n`),
  // Tests hand in what a click would otherwise start: the browser, `claude --version`.
  operations = {},
}) {
  let revision = 0, lastProviders = null, congested = false, queued = null, wake = null, changed = false, problem = null;
  const answered = new Map();
  // `peras setup` or `peras update` replaces the code this bridge was started from. A bridge that kept
  // running would mark Pause outdated against the new install, so it exits and the app starts the new one.
  const installed = () => readInstall(env)?.version ?? null;
  const startedFor = installed();
  const replaced = () => { const now = installed(); return typeof now === "string" && now !== startedFor; };

  const send = (message) => {
    const line = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(line) > LIMITS.frameBytes) { diagnose(`peras bridge: ${message.type} frame over 1 MiB was not sent`); return; }
    if (!output.write(line)) congested = true;
  };
  // A slow reader gets the newest snapshot once it catches up, never a queue of old ones.
  output.on("drain", () => { congested = false; if (queued) { const next = queued; queued = null; send(next); } });

  async function refresh() {
    const now = clock();
    let providers;
    let settings, discovery;
    try { providers = await getPayloads(now); settings = getSettings(now); discovery = getDiscovery(now, providers); } catch (error) {
      // Once per distinct problem: the app ends a bridge whose stderr keeps growing.
      const text = `peras bridge: could not read provider state (${error?.message ?? error})`;
      if (text !== problem) diagnose(text);
      problem = text;
      return;
    }
    problem = null;
    const key = JSON.stringify([providers, settings, discovery]);
    if (key === lastProviders) return;
    lastProviders = key;
    const message = snapshotMessage({ bridgeInstance, revision: ++revision, now, providers, settings, discovery });
    if (congested) queued = message;
    else send(message);
  }

  async function handle(line) {
    let command;
    try { command = parseCommand(line); } catch (error) {
      if (!(error instanceof ProtocolError)) throw error;
      send(resultMessage({ id: error.id, ok: false, code: error.code, message: error.message }));
      return;
    }
    // Retried ids get the first answer; an id reused for something else is refused.
    const key = JSON.stringify(command);
    const seen = answered.get(command.id);
    if (seen) { send(seen.key === key ? seen.result : resultMessage({ id: command.id, ok: false, code: "id_reused", message: "That id was already used for another command." })); return; }
    // Commands run one at a time (see `chain`), so a change never overlaps another.
    const result = resultMessage({ id: command.id, ...(await runOperation(env, command, { now: clock(), signer, notReady, ...operations })) });
    answered.set(command.id, { key, result });
    if (answered.size > CACHE) answered.delete(answered.keys().next().value);
    send(result);
    // Show a saved change now rather than on the next tick.
    if (result.ok) { changed = true; wake?.(); }
  }

  send(helloMessage({ bridgeInstance, runtimeVersion, environmentId: `env_${digest(perasHome(env))}` }));
  // `menubar install --native` waits for this before it retires SwiftBar's plugin.
  try { announceBridge(env, { bridgeInstance, runtimeVersion, now: clock() }); } catch { diagnose("peras bridge: could not record its start"); }
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let closed = false;
  // One command at a time, in the order the app sent them.
  let chain = Promise.resolve();
  const contained = async (line) => {
    try { await handle(line); } catch {
      diagnose("peras bridge: a command failed unexpectedly");
      // Answer the click it belongs to, so the app is not left waiting.
      let id = null;
      try { const c = JSON.parse(line); if (typeof c?.id === "string" && /^[\w-]{1,64}$/.test(c.id)) id = c.id; } catch { /* unreadable: no id */ }
      send(resultMessage({ id, ok: false, code: "failed", message: "Peras could not handle that command." }));
    }
  };
  lines.on("line", (line) => { if (line.trim()) chain = chain.then(() => contained(line)); });
  lines.on("close", () => { closed = true; wake?.(); });
  try {
    while (!signal?.aborted && !closed) {
      changed = false;
      await refresh();
      if (replaced()) { diagnose("peras bridge: Peras was updated; the app restarts the bridge"); break; }
      if (changed) continue;
      // Sleep until the next tick, a saved change or the app closing stdin.
      const waker = new AbortController();
      const stop = () => waker.abort();
      wake = stop;
      signal?.addEventListener("abort", stop, { once: true });
      try { await delay(intervalMs, undefined, { signal: waker.signal }); } catch (error) { if (error.name !== "AbortError") throw error; }
      finally { signal?.removeEventListener("abort", stop); wake = null; }
    }
  } finally {
    lines.close();
    await chain;
    releaseMonitor(env, bridgeInstance);
    retireBridge(env, bridgeInstance);
  }
}
