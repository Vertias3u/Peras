import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { sandbox, NOW, inHours, VERSION } from "./helpers.mjs";
import { install } from "../src/settings.mjs";
import { snapshot } from "../src/providers.mjs";
import { discoveryPayload, parseCommand, providerPayload, snapshotMessage, snapshotProblems, tokenSigner } from "../src/native-protocol.mjs";
import { runOperation } from "../src/native-operations.mjs";
import { LINK_IDS, linkURL } from "../src/discovery.mjs";
import { runProtectionTest } from "../src/protection-test.mjs";
import { pauseNow, recordReading, writeRules } from "../src/store.mjs";
import { DEFAULT_RULES } from "../src/rules.mjs";
import { APP_DOWNLOAD_URL, APP_RELEASE, appPath } from "../src/native-app.mjs";

const HOOK = `"${process.execPath}" "${new URL("../bin/peras.mjs", import.meta.url).pathname}"`;
const home = () => { const box = sandbox(); install({ env: box.env, command: HOOK, version: VERSION }); return box; };
const discovery = async (env, signer, now = NOW) => {
  const providers = [providerPayload(await snapshot(env, now, { cwd: null }), { now, sign: signer.sign })];
  return discoveryPayload(env, providers, { now, sign: signer.sign });
};
const command = (fields) => JSON.stringify({ type: "command", protocol: 1, id: "c1", ...fields });
const dismissWith = (env, signer, d) => runOperation(env, { id: "c", ...d.suggestion.dismiss }, { now: NOW, signer });

test("link.open opens the listed page for its id, tagged with the id and nothing local", async () => {
  const { env, root } = home();
  const opened = [];
  for (const id of LINK_IDS) {
    assert.deepEqual(await runOperation(env, parseCommand(command({ op: "link.open", params: { id } })), { now: NOW, signer: tokenSigner(), openURL: async (url) => { opened.push(url); } }), { ok: true });
  }
  assert.deepEqual(opened, LINK_IDS.map(linkURL));
  for (const url of opened) {
    assert.match(url, /^https:\/\/passcontrol\.vertias\.eu\/[\w/-]*\?ref=peras&ctx=[a-z_]+$/);
    assert.ok(!url.includes(root) && !url.includes(path.basename(root)), "no home path in the address");
  }
});

test("link.open takes a listed id only: no URL, no unknown id, no extra parameter", () => {
  for (const params of [{ id: "https://example.com" }, { id: "nope" }, { url: "https://passcontrol.vertias.eu" }, { id: "passcontrol", ctx: "x" }, {}]) {
    assert.throws(() => parseCommand(command({ op: "link.open", params })), (e) => e.code === "bad_params", JSON.stringify(params));
  }
  assert.throws(() => parseCommand(command({ op: "discovery.dismiss", params: { id: "intro" } })), (e) => e.code === "bad_params", "a dismissal needs its token");
  assert.throws(() => parseCommand(command({ op: "discovery.dismiss", params: { id: "credentials" }, actionToken: "t" })), (e) => e.code === "bad_params", "only suggestions can be dismissed");
});

test("no suggestion until a protection test passes; then the introduction, once", async () => {
  const { env } = home();
  const signer = tokenSigner();
  let d = await discovery(env, signer);
  assert.equal(d.suggestion, null, "untested: nothing suggested");
  assert.equal(d.links.length, LINK_IDS.length, "the permanent list is always there");
  assert.ok(runProtectionTest(env, NOW).passed);
  d = await discovery(env, signer);
  assert.equal(d.suggestion.id, "intro");
  assert.equal(d.suggestion.link, "passcontrol");
  assert.deepEqual(snapshotProblems(snapshotMessage({ bridgeInstance: "b", revision: 1, now: NOW, providers: [], discovery: d })), []);
  assert.deepEqual(await dismissWith(env, signer, d), { ok: true });
  assert.equal((await discovery(env, signer)).suggestion, null, "dismissed, and nothing else fits");
  assert.equal((await discovery(env, tokenSigner(), NOW + 86400_000)).suggestion, null, "still gone tomorrow, from a new bridge");
});

test("a hand pause suggests stopping one agent; an ask line suggests approvals; each goes when dismissed", async () => {
  const { env } = home();
  const signer = tokenSigner();
  assert.ok(runProtectionTest(env, NOW).passed);
  await dismissWith(env, signer, await discovery(env, signer));
  writeRules(env, [...DEFAULT_RULES, { kind: "window", window: "seven_day", at: 80, action: "ask" }]);
  recordReading(env, { seven_day: { usedPct: 20, resetsAt: inHours(48), seenAt: NOW }, five_hour: { usedPct: 10, resetsAt: inHours(2), seenAt: NOW } });
  pauseNow(env, { now: NOW });
  let d = await discovery(env, signer);
  assert.equal(d.suggestion.id, "session_control", "the pause is the more pressing one");
  await dismissWith(env, signer, d);
  d = await discovery(env, signer);
  assert.equal(d.suggestion.id, "approvals");
  await dismissWith(env, signer, d);
  assert.equal((await discovery(env, signer)).suggestion, null);
});

test("a dismissal under another bridge's token is refused and writes nothing", async () => {
  const { env, root } = home();
  assert.ok(runProtectionTest(env, NOW).passed);
  const d = await discovery(env, tokenSigner());
  assert.deepEqual((await dismissWith(env, tokenSigner(), d)).code, "state_changed");
  assert.ok(!fs.existsSync(path.join(env.PERAS_HOME, "discovery.json")));
  assert.equal((await discovery(env, tokenSigner())).suggestion.id, "intro");
});

test("an unreadable dismissal file shows the suggestion again and is replaced on the next dismissal", async () => {
  const { env } = home();
  const signer = tokenSigner();
  assert.ok(runProtectionTest(env, NOW).passed);
  const file = path.join(env.PERAS_HOME, "discovery.json");
  fs.writeFileSync(file, "{not json");
  const d = await discovery(env, signer);
  assert.equal(d.suggestion.id, "intro");
  assert.deepEqual(await dismissWith(env, signer, d), { ok: true });
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, "utf8")).dismissed), ["intro"]);
});

test("an older Peras app is offered the newer one in the suggestion's place, opening the purchase download", async () => {
  const { env } = home(), signer = tokenSigner();
  const app = (version) => {
    fs.mkdirSync(path.join(appPath(env), "Contents"), { recursive: true });
    fs.writeFileSync(path.join(appPath(env), "Contents", "Info.plist"), `<plist><dict><key>PerasRuntimeVersion</key><string>${version}</string></dict></plist>`);
  };
  const message = (d) => snapshotMessage({ bridgeInstance: "b", revision: 1, now: NOW, providers: [], discovery: d });
  app(APP_RELEASE);
  assert.notEqual((await discovery(env, signer)).suggestion?.id, "app_update", "the current app sees no notice");
  app(`${APP_RELEASE}-preview.1`);
  const d = await discovery(env, signer);
  assert.deepEqual(d.suggestion, { id: "app_update", link: "app_update", dismiss: null });
  assert.ok(d.links.some((l) => l.id === "app_update" && l.title === "Newer Peras App Available" && l.detail.includes(APP_RELEASE)));
  assert.deepEqual(snapshotProblems(message(d)), []);
  assert.deepEqual(snapshotProblems(message({ ...d, links: d.links.filter((l) => l.id !== "app_update") })), ["discovery"], "the suggestion needs its link");
  const opened = [];
  assert.deepEqual(await runOperation(env, parseCommand(command({ op: "link.open", params: { id: "app_update" } })), { now: NOW, signer, openURL: async (url) => { opened.push(url); } }), { ok: true });
  assert.deepEqual(opened, [APP_DOWNLOAD_URL]);
});
