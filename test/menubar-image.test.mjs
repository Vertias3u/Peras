import { test } from "node:test";
import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";
import { progressImage, titleImage } from "../src/menubar-image.mjs";

// Reads back the RGBA of one pixel from the PNG titleImage writes (filter 0 rows).
function pixel({ png }, x, y) {
  const width = png.readUInt32BE(16);
  const idat = [];
  for (let at = 8; at < png.length;) {
    const length = png.readUInt32BE(at), type = png.toString("latin1", at + 4, at + 8);
    if (type === "IDAT") idat.push(png.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  const rows = inflateSync(Buffer.concat(idat));
  const from = y * (width * 4 + 1) + 1 + x * 4;
  return [...rows.subarray(from, from + 4)];
}

test("the menu bar title starts with the pixel pear, lime on dark and deeper green on light", () => {
  const readings = [{ provider: "claude", pct: 24 }, { provider: "codex", pct: 12 }];
  const dark = titleImage(readings), light = titleImage(readings, { dark: false });
  assert.equal(dark.height, 20);
  assert.equal(dark.width, light.width);
  // Pear pixel (8, 10) is body; (5, 8) is the shine; (8, 1) the stem. Each is 2×2, 6px down.
  assert.deepEqual(pixel(dark, 10, 26), [183, 243, 74, 255]);
  assert.deepEqual(pixel(dark, 4, 22), [228, 251, 184, 255]);
  assert.deepEqual(pixel(dark, 10, 8), [237, 241, 233, 255]);
  assert.deepEqual(pixel(light, 10, 26), [127, 169, 51, 255]);
  assert.deepEqual(pixel(light, 10, 8), [29, 35, 30, 255]);
  // Sharp edges: nothing half-drawn just outside the body.
  assert.equal(pixel(dark, 0, 14)[3], 0);
});

test("usage tracks show the used fraction and leave a transparent lane for mascots", () => {
  const empty = progressImage(0), half = progressImage(50), full = progressImage(100);
  assert.deepEqual(pixel(empty, 48, 32), [65, 68, 65, 255]);
  assert.deepEqual(pixel(half, 48, 32), [183, 243, 74, 255]);
  assert.deepEqual(pixel(half, 144, 32), [65, 68, 65, 255]);
  assert.deepEqual(pixel(full, 144, 32), [183, 243, 74, 255]);
  assert.equal(pixel(half, 96, 12)[3], 0);
  assert.deepEqual(pixel(progressImage(100, { tone: "red" }), 96, 32), [229, 72, 77, 255]);
});
