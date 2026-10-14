import { test } from "node:test";
import assert from "node:assert/strict";
import { mascotFrame } from "../src/mascots.mjs";
import { progressImage } from "../src/menubar-image.mjs";

test("both original mascots travel in each direction within the track", () => {
  for (const provider of ["claude", "codex"]) {
    assert.equal(mascotFrame(provider, 0).x, 0);
    assert.equal(mascotFrame(provider, 5000).x, 152);
    assert.equal(mascotFrame(provider, 10000).x, 0);
    assert.ok(mascotFrame(provider, 6000).x < mascotFrame(provider, 5500).x);
    const poses = new Set(Array.from({ length: 22 }, (_, i) => mascotFrame(provider, i * 80).pixels.toString("base64")));
    assert.ok(poses.size > 1, "the original animation has multiple distinct poses at menu size");
    assert.notDeepEqual(progressImage(37, { mascot: { provider, timeMs: 0 } }).png,
      progressImage(37, { mascot: { provider, timeMs: 2000 } }).png);
  }
  assert.equal(mascotFrame("claude", 6000).flip, true);
  assert.equal(mascotFrame("codex", 6000).flip, false, "Codex has its own left-running frames");
});

test("paused mascots hold an idle frame and a fixed position", () => {
  for (const provider of ["claude", "codex"]) {
    const first = progressImage(37, { mascot: { provider, timeMs: 0, paused: true } });
    const later = progressImage(37, { mascot: { provider, timeMs: 6500, paused: true } });
    assert.deepEqual(first.png, later.png);
    assert.equal(mascotFrame(provider, 6500, { paused: true }).x, 76);
  }
});
