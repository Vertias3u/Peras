import { test } from "node:test";
import assert from "node:assert/strict";
import { streamMenubar } from "../src/menubar-stream.mjs";
import { snapshot } from "../src/providers.mjs";
import { recordReading, pauseNow } from "../src/store.mjs";
import { sandbox, NOW, inHours } from "./helpers.mjs";

test("stream sends complete animated menus without refetching usage per frame", async () => {
  const { env } = sandbox();
  recordReading(env, { five_hour: { usedPct: 37, resetsAt: inHours(3), seenAt: NOW } });
  let reads = 0, time = NOW;
  const menus = [];
  await streamMenubar({ env, frames: 3, intervalMs: 0, clock: () => time,
    getSnapshots: async () => { reads++; return [await snapshot(env, NOW)]; },
    write: (text) => { menus.push(text); time += 125; return true; } });
  assert.equal(reads, 1);
  assert.equal(menus.length, 3);
  assert.ok(menus.every((m) => m.endsWith("\n~~~\n") && m.includes("Pause 1h")));
  const images = menus.map((m) => m.split("\n").find((l) => l.startsWith("5h")));
  assert.notEqual(images[0], images[2]);
  assert.equal(menus[0].split("\n")[0], menus[2].split("\n")[0], "only the track animates");
});

test("stream observes a pause while running and exits on cancellation", async () => {
  const { env } = sandbox();
  recordReading(env, { five_hour: { usedPct: 37, resetsAt: inHours(3), seenAt: NOW } });
  const controller = new AbortController();
  let time = NOW, reads = 0;
  const menus = [];
  // Time passes per tick, not per write: a paused menu is not sent again.
  await streamMenubar({ env, signal: controller.signal, intervalMs: 1, clock: () => (time += 250),
    getSnapshots: async () => { if (++reads === 6) controller.abort(); return [await snapshot(env, time)]; },
    write: (text) => {
      menus.push(text);
      if (menus.length === 1) pauseNow(env, { now: time });
      return true;
    } });
  assert.ok(reads > 1);
  assert.ok(menus.some((m) => m.includes("Resume 1h") && m.includes("· paused | image=")));
  const paused = menus.filter((m) => m.includes("Resume 1h")).map((m) => m.split("\n").find((l) => l.startsWith("5h"))?.split(" tooltip=")[0]);
  assert.deepEqual(paused.at(-1), paused[0]);
});

test("an unchanged menu is not sent again; a walking mascot is sent every frame", async () => {
  const { env } = sandbox();
  recordReading(env, { five_hour: { usedPct: 37, resetsAt: inHours(3), seenAt: NOW } });
  const run = async () => {
    let time = NOW, writes = 0;
    await streamMenubar({ env, frames: 8, intervalMs: 0, clock: () => (time += 125), getSnapshots: async () => [await snapshot(env, NOW)], write: () => { writes++; return true; } });
    return writes;
  };
  assert.equal(await run(), 8);
  pauseNow(env, { now: NOW });
  assert.equal(await run(), 1, "a paused mascot stands still: one frame, then nothing new");
});
