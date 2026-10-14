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
  await streamMenubar({ env, signal: controller.signal, intervalMs: 1, clock: () => time,
    getSnapshots: async () => { reads++; return [await snapshot(env, time)]; },
    write: (text) => {
      menus.push(text);
      if (menus.length === 1) pauseNow(env, { now: time });
      time += 1000;
      if (menus.length === 4) controller.abort();
      return true;
    } });
  assert.ok(reads > 1);
  assert.ok(menus.some((m) => m.includes("Resume 1h") && m.includes("· paused | image=")));
  const paused = menus.filter((m) => m.includes("Resume 1h")).map((m) => m.split("\n").find((l) => l.startsWith("5h"))?.split(" tooltip=")[0]);
  assert.deepEqual(paused.at(-1), paused[0]);
});
